// Wave 4-A 迁移与跨引擎断层修复回归测试：
//   - Bug 10.2: 纯 agy 模式下 backfill.ask / sessionops.rewindFiles / extensions / runClaude / claudeBlocked
//   - Bug 10.3: components.mjs compHealSkills 双目录兼容 (usr/share/hachimia & usr/share/cccodroid)
//   - Bug 10.4: storage.mjs 统计 agy 目录与 /sdcard/hachimia + 10b-storage.js 展示标签
//   - Bug 10.5: cc-guard.mjs 保护 ~/.local/share/hachimia/agy 与 ~/.gemini/antigravity-cli；cc-seal.mjs 校验 agy
//   - Bug 10.6: reconcile.mjs 与 devside.mjs 的 "agy" / "claude" 别名互通
//   - Bug 3.2 & 3.3: android/assets/bin/rg 保留 LD_PRELOAD；android/assets/bin/agy 刷新悬空/旧目标软链
import { CFG, PATHS, PREFIX } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const WORK = fs.mkdtempSync(path.join(process.env.CCAPP_TMP || CFG.workspace, "wave4-mig-"));

const prevPaths = { agy: PATHS.agy, claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
const prevShared = process.env.CCAPP_SHARED;

const { agyCmd, claudeBlocked, isAgyOnlyCli, runClaude, stripAgyGlog } = await import("../gw/claude.mjs");
const { ask } = await import("../gw/backfill.mjs");
const { rewindFiles } = await import("../gw/sessionops.mjs");
const { addMcp, _extForTest, routeExtensions, SKILLS_DIR } = await import("../gw/extensions.mjs");
const { COMP_DIR, compHealSkills, compRecord } = await import("../gw/components.mjs");
const { scanStorage } = await import("../gw/storage.mjs");
const { judge } = await import("../guard/cc-guard.mjs");
const { fixPlan, reconcileNow } = await import("../gw/reconcile.mjs");
const { routeDevside } = await import("../gw/devside.mjs");
const { NEXT } = await import("../gw/http.mjs");

const madeComps = [];

after(() => {
  Object.assign(PATHS, prevPaths);
  if (prevShared === undefined) delete process.env.CCAPP_SHARED;
  else process.env.CCAPP_SHARED = prevShared;
  for (const id of madeComps) {
    fs.rmSync(path.join(COMP_DIR, id + ".json"), { force: true });
    fs.rmSync(path.join(PREFIX, "share/hachimia/components", id), { recursive: true, force: true });
    fs.rmSync(path.join(PREFIX, "share/cccodroid/components", id), { recursive: true, force: true });
  }
  fs.rmSync(path.join(SKILLS_DIR, "w4-skill-hachimia"), { recursive: true, force: true });
  fs.rmSync(path.join(SKILLS_DIR, "w4-skill-legacy"), { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

function withAgyOnly(mockAgyPath, fn) {
  PATHS.agy = mockAgyPath;
  PATHS.claude = path.join(WORK, "nonexistent-claude-" + process.pid);
  return Promise.resolve().then(fn).finally(() => {
    PATHS.agy = prevPaths.agy;
    PATHS.claude = prevPaths.claude;
  });
}

function makeMockAgy(name, jsBody) {
  const f = path.join(WORK, name);
  fs.writeFileSync(f, `#!${process.execPath}\n${jsBody}`, { mode: 0o755 });
  return f;
}

// ── Bug 10.2: 纯 agy 模式下 backfill.ask / sessionops.rewindFiles / extensions / runClaude ──

test("10.2: 纯 agy 模式下 isAgyOnlyCli / agyCmd / runClaude 正确走 PATHS.agy 并剥除 glog", async () => {
  const logFile = path.join(WORK, "runclaude-args.json");
  const mockAgy = makeMockAgy("mock-agy-run.mjs", `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), autoUpd: process.env.AGY_CLI_DISABLE_AUTO_UPDATE }));
process.stderr.write("ERROR: logging before google.Init: I1128 01:47:21.019277       1 server_zerog.go:46] Initialized Android local timezone to Asia/Shanghai\\n");
process.stdout.write("ERROR: logging before google.Init: I1128 01:47:21.019277       1 server_zerog.go:46] Initialized Android local timezone to Asia/Shanghai\\n");
process.stdout.write("agy-ok-output\\n");
`);
  await withAgyOnly(mockAgy, async () => {
    assert.equal(isAgyOnlyCli(), true);
    assert.deepEqual(agyCmd(["--version"]), [mockAgy, ["--version"]]);
    assert.equal(stripAgyGlog("ERROR: logging before google.Init: x\nhello"), "hello");
    const r = await runClaude(["mcp", "list"]);
    assert.equal(r.code, 0);
    assert.equal(r.out, "agy-ok-output");
    assert.equal(r.err, "");
    const rec = JSON.parse(fs.readFileSync(logFile, "utf8"));
    assert.deepEqual(rec.argv, ["mcp", "list"]);
    assert.equal(rec.autoUpd, "true");
    assert.ok(!rec.argv.includes("--settings"), "agy 模式不应传 Claude 专属 settingsArgs");
  });
});

test("10.2: 纯 agy 模式下 backfill.ask 使用 --output-format json --disable-slash-commands -p=<prompt> 并兼容多种 JSON/文本输出", async () => {
  const calls = [];
  const logFile = path.join(WORK, "ask-calls.jsonl");
  const mockAgy = makeMockAgy("mock-agy-ask.mjs", `
import fs from "node:fs";
const argv = process.argv.slice(2);
const mode = process.env.MOCK_ASK_MODE || "result";
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv, autoUpd: process.env.AGY_CLI_DISABLE_AUTO_UPDATE }) + "\\n");
process.stdout.write("ERROR: logging before google.Init: I1128 01:47:21.019277       1 server_zerog.go:46] Initialized Android local timezone to Asia/Shanghai\\n");
if (mode === "result") {
  process.stdout.write(JSON.stringify({ result: '{"1":"测试标题"}', usage: { input_tokens: 12, output_tokens: 5 } }) + "\\n");
} else if (mode === "response") {
  process.stdout.write(JSON.stringify({ response: '{"1":"兼容响应"}', usage: { input_tokens: 15, cache_read_tokens: 5, output_tokens: 8 } }) + "\\n");
} else if (mode === "text") {
  process.stdout.write(JSON.stringify({ text: '{"1":"文本字段"}' }) + "\\n");
} else if (mode === "plain") {
  process.stdout.write('{"1":"纯文本兜底"}\\n');
}
`);
  await withAgyOnly(mockAgy, async () => {
    for (const [mode, want] of [
      ["result", '{"1":"测试标题"}'],
      ["response", '{"1":"兼容响应"}'],
      ["text", '{"1":"文本字段"}'],
      ["plain", '{"1":"纯文本兜底"}'],
    ]) {
      process.env.MOCK_ASK_MODE = mode;
      const r = await ask("章内容", { model: "gemini-3.8-flash" });
      assert.equal(r.error, undefined, `mode=${mode} 不应出错: ${JSON.stringify(r)}`);
      assert.equal(r.text, want);
      calls.push(r);
    }
    delete process.env.MOCK_ASK_MODE;
    assert.equal(calls[0].tin, 12);
    assert.equal(calls[0].tout, 5);
    assert.equal(calls[1].tin, 20);
    assert.equal(calls[1].tout, 8);
    const logged = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const argv0 = logged[0].argv;
    assert.ok(argv0.includes("--output-format") && argv0.includes("json") && argv0.includes("--disable-slash-commands"));
    assert.ok(!argv0.includes("-p"), "agy 不应传裸 -p（会把下个旗标吞成 prompt）");
    const pFlag = argv0.find((a) => a.startsWith("-p="));
    assert.ok(pFlag && /章内容/.test(pFlag), "应通过 -p=<prompt> 传入系统提示与正文");
    assert.ok(!argv0.includes("--no-session-persistence") && !argv0.includes("--tools") && !argv0.includes("--strict-mcp-config") && !argv0.includes("--system-prompt"));
    assert.equal(logged[0].autoUpd, "true");
  });
});

test("10.2: 纯 agy 模式下 sessionops.rewindFiles 返回明确不支持提示而不拉不存在的 claude", async () => {
  const mockAgy = makeMockAgy("mock-agy-rewind.mjs", `process.exit(0);\n`);
  await withAgyOnly(mockAgy, async () => {
    const r = await rewindFiles("11111111-2222-3333-4444-555555555555", "u1", true);
    assert.equal(r.ok, false);
    assert.match(r.error, /Antigravity CLI.*回退/);
  });
});

test("10.2: 纯 agy 模式下 extensions.mjs 适配 plugin/mcp 子命令并处理不支持命令", async () => {
  const argLog = path.join(WORK, "ext-agy.jsonl");
  const mockAgy = makeMockAgy("mock-agy-ext.mjs", `
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify(argv) + "\\n");
process.stderr.write("ERROR: logging before google.Init: I1128 01:47:21.019277       1 server_zerog.go:46] Initialized Android local timezone to Asia/Shanghai\\n");
if (argv[0] === "plugin" && argv[1] === "list") {
  process.stdout.write("ERROR: logging before google.Init: I1128 01:47:21.019277       1 server_zerog.go:46] Initialized Android local timezone to Asia/Shanghai\\n");
  process.stdout.write("[]\\n");
} else if (argv[0] === "mcp" && argv[1] === "list") {
  process.stdout.write("demo: node srv.js - ✓ Connected\\n");
}
`);

  const srv = await (async () => {
    const http = await import("node:http");
    const s = http.createServer(async (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if ((await routeExtensions(req, res, u, u.pathname)) !== NEXT) return;
      res.writeHead(404).end();
    });
    await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
    return s;
  })();
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await withAgyOnly(mockAgy, async () => {
      // 1) plugin list --available -> 去掉 --available，空列表不崩溃
      const pl = await (await fetch(`${base}/api/ext/plugins?available=1`)).json();
      assert.deepEqual(pl.installed, []);

      // 2) marketplace add -> 返回清晰中文提示
      const mp = await (await fetch(`${base}/api/ext/marketplaces/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "example/mp" }),
      })).json();
      assert.equal(mp.ok, false);
      assert.match(mp.message, /Antigravity CLI.*插件市场/);

      // 3) mcp add stdio -> 旗标 (--type, -e) 必须在 <name> 之前，且不含 -s user / --transport
      const add = await addMcp({ name: "my_srv", transport: "stdio", target: "node srv.js --port 3", env: ["FOO=bar"] });
      assert.equal(add.ok, true, JSON.stringify(add));

      // 4) mcp list -> 兼容 ✓ Connected
      const ml = await _extForTest.listMcp();
      assert.ok(ml.some((x) => x.name === "demo" && x.ok === true), JSON.stringify(ml));

      // 5) mcp enable (add-json -> agy mcp add) & remove (去 -s user)
      const agySettings = path.join(CFG.home, ".gemini", "antigravity-cli", "settings.json");
      fs.mkdirSync(path.dirname(agySettings), { recursive: true });
      fs.writeFileSync(agySettings, JSON.stringify({ mcpServers: { agy_srv: { command: "node", args: ["a.js"], env: { K: "1" } } } }));
      const dis = await _extForTest.disableMcp("agy_srv");
      assert.equal(dis.ok, true, JSON.stringify(dis));
      const en = await _extForTest.enableMcp("agy_srv");
      assert.equal(en.ok, true, JSON.stringify(en));
      fs.rmSync(agySettings, { force: true });

      const calls = fs.readFileSync(argLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const plugListCall = calls.find((c) => c[0] === "plugin" && c[1] === "list");
      assert.ok(plugListCall && !plugListCall.includes("--available"), "plugin list 不得传 --available");
      const addCall = calls.find((c) => c[0] === "mcp" && c[1] === "add" && c.includes("my_srv"));
      assert.ok(addCall, "应调用 mcp add");
      assert.ok(!addCall.includes("-s") && !addCall.includes("--transport"));
      assert.ok(addCall.indexOf("--type") < addCall.indexOf("my_srv"), "--type 必须在 <name> 之前");
      assert.ok(addCall.indexOf("-e") < addCall.indexOf("my_srv"), "-e 必须在 <name> 之前");
      assert.ok(addCall.includes("node") && addCall.includes("srv.js"), "stdio 命令参数不得丢失");
      const rmCall = calls.find((c) => c[0] === "mcp" && c[1] === "remove");
      assert.deepEqual(rmCall, ["mcp", "remove", "agy_srv"]);
      const enCall = calls.find((c) => c[0] === "mcp" && c[1] === "add" && c.includes("agy_srv"));
      assert.ok(enCall && enCall.indexOf("--type") < enCall.indexOf("agy_srv") && enCall.indexOf("-e") < enCall.indexOf("agy_srv"));
    });
  } finally {
    srv.close();
  }
});

// ── Bug 10.3: compHealSkills 双目录兼容 ──

test("10.3: compHealSkills 兼容 usr/share/hachimia/components 与 usr/share/cccodroid/components", () => {
  const idNew = "w4-comp-hachimia", idOld = "w4-comp-legacy";
  madeComps.push(idNew, idOld);
  fs.mkdirSync(COMP_DIR, { recursive: true });

  // 1) hachimia 新目录优先
  const sNew = path.join(PREFIX, "share/hachimia/components", idNew, "skill");
  fs.mkdirSync(sNew, { recursive: true });
  fs.writeFileSync(path.join(sNew, "SKILL.md"), "---\nname: w4-skill-hachimia\ndescription: new\n---\nnew\n");
  fs.writeFileSync(path.join(COMP_DIR, idNew + ".json"), JSON.stringify({ id: idNew, state: "ok", skill: "", files: [], shared: [] }));

  // 2) cccodroid 旧目录回退
  const sOld = path.join(PREFIX, "share/cccodroid/components", idOld, "skill");
  fs.mkdirSync(sOld, { recursive: true });
  fs.writeFileSync(path.join(sOld, "SKILL.md"), "---\nname: w4-skill-legacy\ndescription: old\n---\nold\n");
  fs.writeFileSync(path.join(COMP_DIR, idOld + ".json"), JSON.stringify({ id: idOld, state: "ok", skill: "", files: [], shared: [] }));

  compHealSkills();
  assert.equal(compRecord(idNew).skill, "w4-skill-hachimia");
  assert.equal(compRecord(idOld).skill, "w4-skill-legacy");
  assert.ok(fs.existsSync(path.join(SKILLS_DIR, "w4-skill-hachimia", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(SKILLS_DIR, "w4-skill-legacy", "SKILL.md")));
});

// ── Bug 10.4: storage.mjs 与 10b-storage.js ──

test("10.4: storage.mjs 统计 agy 版本目录与 shared 目录，10b-storage.js 展示 Antigravity CLI (agy) 与 /sdcard/hachimia", async () => {
  const agyRoot = path.join(CFG.home, ".local", "share", "hachimia", "agy");
  fs.rmSync(agyRoot, { recursive: true, force: true });
  const verDir = path.join(agyRoot, "1.5.20");
  fs.mkdirSync(verDir, { recursive: true });
  fs.writeFileSync(path.join(verDir, "agy"), "x".repeat(4096));
  fs.symlinkSync("1.5.20", path.join(agyRoot, "current"));
  const sharedDir = path.join(WORK, "hachimia");
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(sharedDir, "demo.txt"), "hello");
  process.env.CCAPP_SHARED = sharedDir;
  try {
    const s = await scanStorage();
    const agyItem = (s.programs.claude || []).find((x) => x.version === "1.5.20");
    assert.ok(agyItem, "programs.claude 应计入已安装的 agy 版本：" + JSON.stringify(s.programs.claude));
    assert.equal(agyItem.engine, "agy");
    assert.equal(agyItem.current, true);
    assert.ok(agyItem.bytes > 0);
    assert.ok((s.programs.agy || []).some((x) => x.version === "1.5.20"));
    assert.ok(s.programs.shared != null && s.programs.shared > 0);
  } finally {
    fs.rmSync(agyRoot, { recursive: true, force: true });
  }
  const ui = fs.readFileSync(path.join(REPO, "gateway/web/app/10b-storage.js"), "utf8");
  assert.match(ui, /Antigravity CLI \(agy\)/);
  assert.match(ui, /共享目录 \/sdcard\/hachimia/);
});

// ── Bug 10.5: cc-guard.mjs & cc-seal.mjs ──

test("10.5: cc-guard.mjs 保护 agy 目录与 ~/.gemini/antigravity-cli，且不误伤只读良性命令", () => {
  for (const [tool, inp] of [
    ["Bash", { command: "rm -rf ~/.local/share/hachimia/agy/1.5.14/agy" }],
    ["Write", { file_path: "/data/user/0/ha.chi.mia/files/home/.local/share/hachimia/agy/current/agy", content: "x" }],
    ["Write", { file_path: "/data/user/0/ha.chi.mia/files/home/.gemini/antigravity-cli/settings.json", content: "{}" }],
    ["Read", { file_path: "/data/user/0/ha.chi.mia/files/home/.gemini/antigravity-cli/oauth_creds.json" }],
    ["Write", { file_path: "/data/user/0/ha.chi.mia/files/home/.gemini/antigravity-cli/skills/evil/SKILL.md", content: "x" }],
    ["Write", { file_path: "/data/user/0/ha.chi.mia/files/home/.hachimia/bin/git", content: "x" }],
    ["Bash", { command: "agy mcp add evil node /tmp/x.js" }],
    ["Bash", { command: "agy --dangerously-skip-permissions -p hi" }],
  ]) {
    assert.ok(judge(tool, inp), `应拦下 ${tool} ${JSON.stringify(inp)}`);
  }
  for (const cmd of ["agy --version", "agy mcp list", "agy plugin list --json", "agy models"]) {
    assert.equal(judge("Bash", { command: cmd }), null, `良性命令不应误拦: ${cmd}`);
  }
});

test("10.5: cc-seal.mjs 对齐 agy 路径、清理 install-claude.mjs 与 cs.pending 并 fail-closed 拒停", () => {
  const src = fs.readFileSync(path.join(REPO, "gateway/guard/cc-seal.mjs"), "utf8");
  assert.match(src, /\.local.*share.*hachimia.*agy/);
  assert.doesNotMatch(src, /install-claude\.mjs/);
  assert.doesNotMatch(src, /cs\.pending/);
  assert.doesNotMatch(src, /--recheck/);

  // 部署态下用假 HOME 验证：sha256 对得上放行（退出 0），被篡改拦下（退出 4）
  const sealHome = path.join(WORK, "seal-home");
  const verDir = path.join(sealHome, ".local/share/hachimia/agy/1.5.14");
  fs.mkdirSync(verDir, { recursive: true });
  const bin = path.join(verDir, "agy");
  fs.writeFileSync(bin, "real-agy");
  fs.writeFileSync(path.join(verDir, "manifest.json"), JSON.stringify({
    version: "1.5.14",
    sha256: crypto.createHash("sha256").update("real-agy").digest("hex"),
  }));
  fs.symlinkSync("1.5.14", path.join(sealHome, ".local/share/hachimia/agy/current"));

  const gwDeploy = path.join(WORK, "seal-app");
  fs.cpSync(path.join(REPO, "gateway/gw"), path.join(gwDeploy, "gw"), { recursive: true });
  fs.cpSync(path.join(REPO, "gateway/guard"), path.join(gwDeploy, "guard"), { recursive: true });
  fs.writeFileSync(path.join(gwDeploy, "FILES"), "");
  const cleanEnv = { ...process.env, HOME: sealHome, CCAPP_HOME: sealHome, CCAPP_TEST: "1" };
  delete cleanEnv.CCAPP_AGY; delete cleanEnv.CCAPP_CLAUDE;

  const okRun = spawnSync(process.execPath, [path.join(gwDeploy, "guard/cc-seal.mjs"), WORK, "--", "--", "--version"], { env: cleanEnv, encoding: "utf8" });
  assert.equal(okRun.status, 0, okRun.stderr);

  fs.writeFileSync(bin, "tampered-agy");
  const badRun = spawnSync(process.execPath, [path.join(gwDeploy, "guard/cc-seal.mjs"), WORK, "--", "--", "--version"], { env: cleanEnv, encoding: "utf8" });
  assert.equal(badRun.status, 4, badRun.stderr);
  assert.match(badRun.stderr, /Antigravity CLI/);
});

// ── Bug 10.6: reconcile.mjs 与 devside.mjs 别名互通 ──

test("10.6: reconcileNow 缺失 agy 发出 act:agy，fixPlan 正常排序，devside.mjs 同时接受 agy 与 claude", async () => {
  PATHS.agy = path.join(WORK, "missing-agy-bin");
  PATHS.claude = path.join(WORK, "missing-claude-bin");
  const rec = await reconcileNow();
  const f = rec.findings.find((x) => x.key === "agy");
  assert.ok(f, "缺失 PATHS.agy 时应报 agy 缺失：" + JSON.stringify(rec.findings));
  assert.deepEqual(f.act, { t: "agy" });
  const plan = fixPlan([f, { key: "devkit", level: "error", k: "devkit", v: null, fix: "", act: { t: "devkit" } }], "all");
  assert.deepEqual(plan.map((s) => s.act.t), ["agy", "devkit"]);
  PATHS.agy = prevPaths.agy;
  PATHS.claude = prevPaths.claude;

  // devside.mjs 在无 PREFIX（开发端）下对 item:"agy" 和 item:"claude" 均放行到状态检查（不会报“开发端只管...”）
  const http = await import("node:http");
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if ((await routeDevside(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    // 用 subprocess（不设 CCAPP_PREFIX）测 devApp("upd_apply")
    const probe = `
      const { routeDevside } = await import(${JSON.stringify(path.join(REPO, "gateway/gw/devside.mjs"))});
      const http = await import("node:http");
      const { NEXT } = await import(${JSON.stringify(path.join(REPO, "gateway/gw/http.mjs"))});
      const srv = http.createServer(async (req, res) => {
        const u = new URL(req.url, "http://x");
        if ((await routeDevside(req, res, u, u.pathname)) !== NEXT) return;
        res.writeHead(404).end();
      });
      await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
      const post = async (item) => (await fetch("http://127.0.0.1:" + srv.address().port + "/api/app/upd_apply", {
        method: "POST", body: JSON.stringify({ item })
      })).json();
      console.log(JSON.stringify({ agy: await post("agy"), claude: await post("claude"), bad: await post("other") }));
      process.exit(0);
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CCAPP_|CLAUDE_CODE_|ANTHROPIC_)/.test(k)));
    Object.assign(env, { CCAPP_TEST: "1", CCAPP_HOME: path.join(WORK, "dev-home"), HOME: path.join(WORK, "dev-home"), CCAPP_WORKSPACE: WORK });
    fs.mkdirSync(env.CCAPP_HOME, { recursive: true });
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.doesNotMatch(out.agy.message || "", /开发端只管/);
    assert.doesNotMatch(out.claude.message || "", /开发端只管/);
    assert.match(out.bad.message || "", /开发端只管/);
  } finally {
    srv.close();
  }
});

// ── Bug 3.2 & 3.3: android/assets/bin/rg & android/assets/bin/agy ──

test("3.2: bin/rg 对 $PREFIX/bin/rg 保留 LD_PRELOAD，仅在 CLAUDE_BIN 回退分支 unset LD_PRELOAD", () => {
  const rgScript = path.join(REPO, "android/assets/bin/rg");
  const pfx = path.join(WORK, "rg-pfx");
  const home = path.join(WORK, "rg-home");
  fs.mkdirSync(path.join(pfx, "bin"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const fakeRg = path.join(pfx, "bin", "rg");
  fs.writeFileSync(fakeRg, `#!${SH}\nprintf 'RG_PRE=%s\\n' "$LD_PRELOAD"\n`, { mode: 0o755 });
  const preloadVal = process.env.LD_PRELOAD || "/lib/keep.so";

  const r1 = spawnSync(SH, [rgScript, "pat"], {
    env: { ...process.env, PREFIX: pfx, HOME: home, LD_PRELOAD: preloadVal },
    encoding: "utf8",
  });
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.stdout.trim(), "RG_PRE=" + preloadVal);

  // 删除 $PREFIX/bin/rg，建 CLAUDE_BIN 与假 CCAPP_LD 验证 CLAUDE_BIN 分支确实清掉 LD_PRELOAD
  fs.rmSync(fakeRg);
  const claudeDir = path.join(home, ".local/share/cccodroid/claude/current");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "claude"), "fake", { mode: 0o755 });
  const fakeLd = path.join(WORK, "fake-ld.sh");
  fs.writeFileSync(fakeLd, `#!${SH}\nprintf 'LD_PRE=%s\\n' "$LD_PRELOAD"\n`, { mode: 0o755 });

  const r2 = spawnSync(SH, [rgScript, "pat"], {
    env: { ...process.env, PREFIX: pfx, HOME: home, CCAPP_LD: fakeLd, LD_PRELOAD: preloadVal },
    encoding: "utf8",
  });
  // targetSdk 36 W^X 下 unset LD_PRELOAD 后直接 exec app_data_file 脚本会报 126 Permission denied，
  // 同样证明 CLAUDE_BIN 分支已清掉 LD_PRELOAD（r1 同一目录下保留 LD_PRELOAD 则可正常 exec）。
  if (r2.status === 0) {
    assert.equal(r2.stdout.trim(), "LD_PRE=");
  } else {
    assert.equal(r2.status, 126, r2.stderr);
    assert.match(r2.stderr, /Permission denied/i);
  }
  const rgSrc = fs.readFileSync(rgScript, "utf8");
  assert.ok(rgSrc.indexOf('exec "$PREFIX/bin/rg"') < rgSrc.indexOf("unset LD_PRELOAD"));
});

test("3.3: bin/agy 在覆盖安装后自动将指向旧 target 的悬空 bash/sh 软链刷新为新 CCAPP_LOADER_RUN", () => {
  const agyScript = path.join(REPO, "android/assets/bin/agy");
  const loaderBin = path.join(WORK, "loader-bin");
  const newRun = path.join(WORK, "libccrun-new.so");
  const fakeAgy = path.join(WORK, "fake-agy.sh");
  fs.mkdirSync(loaderBin, { recursive: true });
  fs.writeFileSync(newRun, `#!${SH}\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(fakeAgy, `#!${SH}\nprintf 'AGY_OK\\n'\n`, { mode: 0o755 });
  // 预埋指向旧路径（不存在）的悬空软链
  fs.symlinkSync("/data/app/~~old==/lib/arm64/libccrun.so", path.join(loaderBin, "bash"));
  fs.symlinkSync("/data/app/~~old==/lib/arm64/libccrun.so", path.join(loaderBin, "sh"));

  const r = spawnSync(SH, [agyScript, "--version"], {
    env: {
      ...process.env,
      CCAPP_AGY: fakeAgy,
      CCAPP_EXEC: "loader",
      CCAPP_LOADER_BIN: loaderBin,
      CCAPP_LOADER_RUN: newRun,
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "AGY_OK");
  assert.equal(fs.readlinkSync(path.join(loaderBin, "bash")), newRun);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "sh")), newRun);
});
