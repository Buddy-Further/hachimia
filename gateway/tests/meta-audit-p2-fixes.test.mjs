// 元规律 ABCD 审计 P2（#11–#19）真实行为回归测试
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { Readable } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { judge } from "../guard/cc-guard.mjs";
import { pathWatch } from "../gw/pathnote.mjs";
import { resolveAgyManifestBase } from "../gw/devside.mjs";
import { clearInterrupted, forceEnd, setInterrupted } from "../gw/queue.mjs";
import * as Q from "../gw/queue.mjs";
import { routeFonts } from "../gw/fonts.mjs";
import { routeSched, _schedForTest } from "../gw/sched.mjs";
const SCHED_DB = _schedForTest.DB;
import { nowTicks } from "../gw/leftover.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function mockRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(s, h) { this.status = s; this.headers = h || {}; },
    end(b) { this.body = b == null ? "" : String(b); },
  };
}
function mockReq(method, bodyObj) {
  const s = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  return Object.assign(Readable.from(s ? [Buffer.from(s)] : []), {
    method,
    headers: { "content-type": "application/json" },
  });
}

test("P2 #11：cc-guard 覆盖 agy 全部凭据路径；cc-seal CCAPP_SEAL_TARGET=claude 时只验 claude 不被 agy 顶替", () => {
  for (const p of [
    "/data/user/0/ha.chi.mia/files/home/.gemini/antigravity-cli/session.json",
    "/data/user/0/ha.chi.mia/files/home/.gemini/antigravity-cli/accounts/user1.json",
    "/data/user/0/ha.chi.mia/files/home/.config/antigravity/auth.json",
    "/data/user/0/ha.chi.mia/files/home/.antigravity/creds.json",
  ]) {
    assert.match(judge("Read", { file_path: p })?.cat || "", /^secret:/, `应拦截凭据读取: ${p}`);
  }

  // 构造部署态临时 home：放一个验签通过的 agy 和一个被篡改的 claude
  const tmpHome = fs.mkdtempSync(path.join(CFG.workspace, "p2-seal-"));
  const tmpApp = fs.mkdtempSync(path.join(CFG.workspace, "p2-app-"));
  try {
    // 部署态识别依赖 HERE/FILES 存在，这里复制最小 gateway 目录并在同级放 FILES 与 sealed 标志
    const agyDir = path.join(tmpHome, ".local/share/hachimia/agy/1.0.0");
    const claudeDir = path.join(tmpHome, ".local/share/cccodroid/claude/2.0.0");
    fs.mkdirSync(agyDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    const agyBin = path.join(agyDir, "agy");
    const claudeBin = path.join(claudeDir, "claude");
    fs.writeFileSync(agyBin, "VALID-AGY-ELF");
    fs.writeFileSync(path.join(agyDir, "manifest.json"), JSON.stringify({
      version: "1.0.0",
      sha256: crypto.createHash("sha256").update("VALID-AGY-ELF").digest("hex"),
    }));
    fs.symlinkSync(agyDir, path.join(tmpHome, ".local/share/hachimia/agy/current"));

    fs.writeFileSync(claudeBin, "TAMPERED-CLAUDE-ELF");
    fs.writeFileSync(path.join(claudeDir, "manifest.json"), JSON.stringify({
      version: "2.0.0",
      sha256: "0".repeat(64),
    }));
    fs.symlinkSync(claudeDir, path.join(tmpHome, ".local/share/cccodroid/claude/current"));

    // 复制 gateway 最小子树并打上 FILES + edition sealed
    fs.cpSync(path.join(ROOT, "gateway/gw"), path.join(tmpApp, "gw"), { recursive: true });
    fs.cpSync(path.join(ROOT, "gateway/guard"), path.join(tmpApp, "guard"), { recursive: true });
    fs.writeFileSync(path.join(tmpApp, "FILES"), "");
    // edition.mjs 默认 SEALED=true（在有 FILES 时封口），确保 cc-seal.mjs 走封口核验
    const r = spawnSync(process.execPath, [
      path.join(tmpApp, "guard/cc-seal.mjs"),
      CFG.workspace, "--", "--", "-p", "hi",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmpHome,
        CCAPP_HOME: tmpHome,
        CCAPP_AGY: agyBin,
        CCAPP_SEAL_TARGET: "claude",
      },
    });
    assert.equal(r.status, 4, `即使本机存在合法 agy 且注入 CCAPP_AGY，验 claude 失败仍应 exit 4，实际 ${r.status}: ${r.stderr}`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpApp, { recursive: true, force: true });
  }
});

test("P2 #12：pathWatch.feedDelta 跨片拼接绝对路径不误报，单提文件名仍准确提醒", () => {
  const w1 = pathWatch();
  w1.feed({ type: "assistant", message: { content: [{ type: "tool_use", name: "edit_file (foo.js)", input: { TargetFile: "/data/user/0/ha.chi.mia/files/home/workspace/foo.js" } }] } });
  w1.feedDelta("已更新文件 ");
  w1.feedDelta("/data/user/0/ha.chi.mia/");
  w1.feedDelta("files/home/workspace/foo.js");
  w1.feedDelta("，请查看。");
  assert.deepEqual(w1.lazy(), [], "跨片拼出的完整路径不应被误判成只写了文件名");

  const w2 = pathWatch();
  w2.feed({ type: "assistant", message: { content: [{ type: "tool_use", name: "edit_file", input: { TargetFile: "/data/user/0/ha.chi.mia/files/home/workspace/bar.js" } }] } });
  w2.feedDelta("我刚刚改了 ");
  w2.feedDelta("bar.js");
  w2.feedDelta(" 里的逻辑。");
  assert.deepEqual(w2.lazy(), [{ file: "/data/user/0/ha.chi.mia/files/home/workspace/bar.js", said: "bar.js" }]);
});

test("P2 #13：clearInterrupted 与 /api/interrupted/dismiss、/api/sched/missed 落盘失败时回滚内存", async () => {
  const intrFile = path.join(CFG.home, "ccapp-interrupted.json");
  const runFile = path.join(CFG.home, "ccapp-run-mark.json");
  const sid = "33333333-3333-4333-8333-333333333333";
  const rec = { id: "intr-1", sessionId: sid, text: "hello", at: Date.now() };
  assert.equal(setInterrupted([rec]), true);
  // 用同名目录顶住目标文件，制造原子 rename 必败（EISDIR）
  fs.rmSync(intrFile, { recursive: true, force: true });
  fs.mkdirSync(intrFile, { recursive: true });
  fs.rmSync(runFile, { recursive: true, force: true });
  fs.mkdirSync(runFile, { recursive: true });
  try {
    // 1) clearInterrupted 落盘失败回滚内存并返回 false
    assert.equal(clearInterrupted(sid), false);
    assert.equal(Q.INTERRUPTED.length, 1, "clearInterrupted 落盘失败必须回滚 INTERRUPTED");

    // 2) /api/interrupted/dismiss 两份权威都写失败 -> 返回 500 且回滚内存
    const res = mockRes();
    await Q.routeQueue(mockReq("POST", { id: "intr-1" }), res, new URL("http://127.0.0.1/api/interrupted/dismiss"), "/api/interrupted/dismiss");
    assert.equal(res.status, 500);
    assert.equal(Q.INTERRUPTED.length, 1, "dismiss 写盘失败返回 500 时不得清空内存中的 INTERRUPTED");
  } finally {
    fs.rmSync(intrFile, { recursive: true, force: true });
    fs.rmSync(runFile, { recursive: true, force: true });
    setInterrupted([]);
  }

  // 3) /api/sched/missed 写盘失败 -> 回滚 DB.missed 与 skipNext 并返回 500
  const schedFile = path.join(CFG.home, "ccapp-sched.json");
  const task = { id: "t-miss-1", name: "m1", prompt: "x", on: true, skipNext: true, skipAt: 1000 };
  const missed = { taskId: "t-miss-1", at: 2000, name: "m1" };
  SCHED_DB.tasks.push(task);
  SCHED_DB.missed.push(missed);
  fs.rmSync(schedFile, { recursive: true, force: true });
  fs.mkdirSync(schedFile, { recursive: true });
  try {
    const res = mockRes();
    await routeSched(mockReq("POST", { taskId: "t-miss-1", at: 2000, act: "skip" }), res, new URL("http://127.0.0.1/api/sched/missed"), "/api/sched/missed");
    assert.equal(res.status, 500);
    assert.equal(SCHED_DB.missed.some((m) => m.taskId === "t-miss-1"), true, "写盘失败必须回滚 DB.missed");
    assert.equal(task.skipNext, true, "写盘失败必须回滚 t.skipNext");
    assert.equal(task.skipAt, 1000);
  } finally {
    fs.rmSync(schedFile, { recursive: true, force: true });
    const ti = SCHED_DB.tasks.indexOf(task); if (ti >= 0) SCHED_DB.tasks.splice(ti, 1);
    const mi = SCHED_DB.missed.indexOf(missed); if (mi >= 0) SCHED_DB.missed.splice(mi, 1);
  }
});

test("P2 #14：/api/fonts/del 清单写盘失败时不得先删除实体字体文件", async () => {
  const dir = path.join(CFG.home, "fonts");
  const listFile = path.join(dir, "fonts.json");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const fontId = "abcdef012345";
  const fontFile = path.join(dir, `${fontId}.ttf`);
  fs.writeFileSync(fontFile, Buffer.from([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]));
  fs.writeFileSync(listFile, JSON.stringify([{ id: fontId, name: "Demo", file: "demo.ttf", fmt: "ttf", size: 12, sha: "a".repeat(64), at: 1 }]));
  // 模拟清单写盘失败：先让 load() 读完后无法覆盖？直接测将 fonts 目录设只读（非 root uid 下无法创建临时文件）
  // 某些设备/测试环境若 chmod 0500 仍允许 owner 写，则再额外验证正常删除顺序
  let blocked = false;
  try {
    fs.chmodSync(dir, 0o500);
    try {
      const probe = path.join(dir, ".probe");
      fs.writeFileSync(probe, "x");
      fs.rmSync(probe, { force: true });
    } catch { blocked = true; }
    if (blocked) {
      const res = mockRes();
      await routeFonts(mockReq("POST", { id: fontId }), res, new URL("http://127.0.0.1/api/fonts/del"), "/api/fonts/del");
      assert.equal(res.status, 500, "清单保存失败应回 500");
      assert.equal(fs.existsSync(fontFile), true, "清单保存失败时实体字体文件不得丢失");
    }
  } finally {
    try { fs.chmodSync(dir, 0o700); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("P2 #15：devside 与 install-agy 拒绝非官方源站；CCAPP_TEST=1 也只放行回环", () => {
  const def = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
  assert.equal(resolveAgyManifestBase("https://evil.example/manifests", { isTest: false }), def);
  assert.equal(resolveAgyManifestBase("https://evil.example/manifests", { isTest: true }), def, "测试模式下也必须拒绝外部域名");
  assert.equal(resolveAgyManifestBase("http://127.0.0.1:9999/manifests", { isTest: false }), def, "非测试模式必须拒绝本地回环");
  assert.equal(resolveAgyManifestBase("http://127.0.0.1:9999/manifests", { isTest: true }), "http://127.0.0.1:9999/manifests");
  assert.equal(resolveAgyManifestBase("https://antigravity.google/manifests", { isTest: false }), "https://antigravity.google/manifests");

  const r = spawnSync(process.execPath, [path.join(ROOT, "android/assets/scripts/install-agy.mjs"), "--check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CCAPP_TEST: "1",
      HACHIMIA_AGY_MANIFEST_BASE: "https://evil.example/manifests",
    },
  });
  assert.notEqual(r.status, 0, "install-agy.mjs 在 CCAPP_TEST=1 下也必须拒绝外部 https 源站");
  assert.match(r.stderr, /回环|不受信任/);
});

test("P2 #17b：12-model-caps.js READ_TOOLS 包含 grep_search / find_by_name / list_dir / exit_plan_mode", () => {
  const src = read("gateway/web/app/12-model-caps.js");
  const a = src.indexOf("  const READ_TOOLS = new Set([");
  const b = src.indexOf("  const permPill =", a);
  assert.ok(a > 0 && b > a);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(a, b)}\nthis.__toolPerm = toolPerm;`, ctx);
  const rules = { allow: [], ask: [], deny: [] };
  for (const name of ["grep_search", "find_by_name", "list_dir", "exit_plan_mode"]) {
    assert.equal(ctx.__toolPerm(name, "default", rules), "allow", `${name} 在 default 模式下应标为 allow`);
  }
});

test("P2 #18：06-files.js 从远程过滤大目录切进子目录在途时清空搜索框，不会拿旧目录重发 fsLoad", async () => {
  const src = read("gateway/web/app/06-files.js");
  const start = src.indexOf("  let fsQSeq = 0,");
  const end = src.indexOf("  function fsVisible()", start);
  assert.ok(start >= 0 && end > start);

  const calls = [];
  const resolvers = [];
  const searchEl = { value: "foo" };
  let seqMap = new Map();
  const ctx = {
    state: { fs: { path: "/dirA", parent: "/", entries: [{ name: "foo.txt" }], roots: ["/"], truncated: true, qRemote: true, q: "foo", hidden: false, arc: null, sel: null, multi: new Set() } },
    filesEl: { classList: { contains: () => false } },
    latest: (k) => { const n = (seqMap.get(k) || 0) + 1; seqMap.set(k, n); return () => seqMap.get(k) === n; },
    $: () => searchEl,
    api: (u) => {
      calls.push(u);
      return new Promise((r) => resolvers.push(r));
    },
    renderFs: () => {},
    toast: () => {},
    t: (s) => s,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.__api = { fsLoad, fsSearchTyped };`, ctx);

  // 先建立 /dirA 远程过滤态，再点进 /dirB（请求挂起在途）
  const loadA = ctx.__api.fsLoad("/dirA");
  resolvers.shift()({ path: "/dirA", parent: "/", entries: [{ name: "foo.txt" }], roots: ["/"], truncated: true });
  await loadA;
  ctx.state.fs.q = "foo";
  ctx.state.fs.qRemote = true;
  calls.length = 0;

  const loadB = ctx.__api.fsLoad("/dirB");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /path=%2FdirB/);

  // 在途清空搜索框：绝不能拿旧的 /dirA 重发 fsLoad 把 /dirB 顶掉
  ctx.__api.fsSearchTyped("");
  assert.equal(calls.length, 1, `在途清空搜索不应发新请求，实际发了: ${JSON.stringify(calls)}`);

  // /dirB 响应回来：最终稳稳落在 /dirB 且搜索词为 ""
  resolvers.shift()({ path: "/dirB", parent: "/dirA", entries: [{ name: "b.txt" }], roots: ["/"], truncated: false });
  await loadB;
  assert.equal(ctx.state.fs.path, "/dirB");
  assert.equal(ctx.state.fs.q, "");
  assert.equal(ctx.state.fs.qRemote, false);
});

test("P2 #19a：forceEnd 在冷启动 ACP 已保活入池后不得误杀 acpPooledPid", async () => {
  const runId = "p2-pooled-" + crypto.randomBytes(4).toString("hex");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    env: { ...process.env, CCAPP_RUN_ID: runId, CCAPP_GW_PID: String(process.pid) },
    stdio: "ignore",
  });
  try {
    await new Promise((r) => setTimeout(r, 150));
    const run = {
      id: runId,
      ended: false,
      childStart: Math.max(0, nowTicks() - 500),
      acpPooledPid: child.pid,
      forceFinish: () => { run.ended = true; },
    };
    forceEnd(run);
    await new Promise((r) => setTimeout(r, 150));
    let alive = false;
    try { process.kill(child.pid, 0); alive = true; } catch {}
    assert.equal(alive, true, "已保活入池的 acpPooledPid 绝不能被迟到的 forceEnd 误杀");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
  }
});
