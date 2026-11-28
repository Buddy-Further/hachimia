// Wave 1 P0/P1 安全与崩溃修复回归测试：
//   5.1: archiver.mjs run7z() 下游早退 EPIPE 不崩溃
//   10.1: cc-mem.mjs CORE 保护 ha.chi.mia 与 cc.codroid
//   1.1: fnsafe.mjs 拒绝引号/模板混淆 RCE 载荷并放行全部现有 i18n/lang-*.txt @ 行
//   1.2: install-agy.mjs --recheck 绝不执行/洗白篡改二进制；全链路锁定 AGY_CLI_DISABLE_AUTO_UPDATE="true"
//   1.3: install-agy.mjs 锁定 HACHIMIA_AGY_INSTALL_URL / MANIFEST_BASE 并使用 probeBinVersion
//   1.4: claudeseal.mjs 对缺清单 / 坏清单 / 无效 sha256 fail-closed，同时保留 missing / dev 的 ok: null
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { run7z } from "../gw/archiver.mjs";
import { claudeSeal } from "../gw/claudeseal.mjs";
import { agyEnv, toolEnv } from "../gw/claude.mjs";
import { createAcpClient } from "../gw/acp.mjs";
import { tamperAck, tamperNote } from "../gw/tamper.mjs";
import { i18nFnProblem } from "../../i18n/fnsafe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SH_BIN = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const WORK = fs.mkdtempSync(path.join(process.env.CCAPP_TMP || CFG.workspace, "wave1-"));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

test("5.1: run7z() 在下游 7zz 立即退出时安全吞掉 c.stdin EPIPE，不触发未捕获异常", async () => {
  const fake7z = path.join(WORK, "early-exit-7zz");
  fs.writeFileSync(fake7z, `#!${SH_BIN}\nexit 0\n`, { mode: 0o755 });
  const prev7zz = process.env.CCAPP_7ZZ;
  process.env.CCAPP_7ZZ = fake7z;

  const uncaught = [];
  const onErr = (e) => uncaught.push(e);
  process.on("uncaughtException", onErr);
  try {
    // 持续灌入较大数据流，确保写端在子进程关闭读端后触发 EPIPE / ERR_STREAM_DESTROYED
    let sent = 0;
    const bigStdin = new Readable({
      read() {
        if (sent >= 8) { this.push(null); return; }
        sent++;
        this.push(Buffer.alloc(65536, 0x41));
      },
    });
    const res = await run7z(["l", "-si"], { stdin: bigStdin });
    assert.equal(res.code, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(uncaught.length, 0, "不应产生未捕获异常：" + uncaught.map((e) => e.message).join("; "));
  } finally {
    process.off("uncaughtException", onErr);
    if (prev7zz === undefined) delete process.env.CCAPP_7ZZ;
    else process.env.CCAPP_7ZZ = prev7zz;
  }
});

test("10.1: cc-mem.mjs CORE 保护 ha.chi.mia 与 cc.codroid，绝不停掉自身进程", () => {
  const dir = path.join(WORK, "ccmem-core");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(REPO, "android/assets/bin/cc-mem.mjs"), path.join(dir, "cc-mem.mjs"));
  const logFile = path.join(dir, "priv.log");
  const lru = [
    "  #0: cch+75 CEM  ---- 101:ha.chi.mia/u0a101",
    "  #1: cch+75 CEM  ---- 102:cc.codroid/u0a102",
    "  #2: cch+75 CEM  ---- 103:com.example.killme/u0a103",
  ].join("\n");
  const procs = [
    "  *APP* UID 10101 ProcessRecord{a 101:ha.chi.mia/u0a101}\n    packageList={ha.chi.mia}",
    "  *APP* UID 10102 ProcessRecord{b 102:cc.codroid/u0a102}\n    packageList={cc.codroid}",
    "  *APP* UID 10103 ProcessRecord{c 103:com.example.killme/u0a103}\n    packageList={com.example.killme}",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "priv.mjs"), `
import fs from "node:fs";
const cmd = process.argv[process.argv.length - 1];
fs.appendFileSync(${JSON.stringify(logFile)}, cmd.replace(/\\n/g, " ") + "\\n");
if (cmd.includes("dumpsys activity lru")) {
  process.stdout.write("@LRU\\n" + ${JSON.stringify(lru)} + "\\n@PROC\\n" + ${JSON.stringify(procs)} + "\\n");
} else if (cmd.includes("dumpsys meminfo")) {
  process.stdout.write("");
} else {
  for (const m of cmd.matchAll(/am (?:force-stop|stop-app) '([^']+)'/g)) {
    process.stdout.write("@ok " + m[1] + "\\n");
  }
}
`);
  fs.writeFileSync(path.join(dir, "ccapp-settings.json"), JSON.stringify({ memGuard: { enabled: true, whitelist: [] } }));
  const r = spawnSync(process.execPath, [path.join(dir, "cc-mem.mjs"), "clear", "--hard", "--json"], {
    env: { ...process.env, CCAPP_HOME: dir, HOME: dir },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.stopped, ["com.example.killme"]);
  const logged = fs.readFileSync(logFile, "utf8");
  assert.doesNotMatch(logged, /ha\.chi\.mia/);
  assert.doesNotMatch(logged, /cc\.codroid/);
});

test("1.1: fnsafe.mjs 拦截引号/模板混淆 RCE 载荷并放行全仓现有 i18n/lang-*.txt @ 行", () => {
  const i18nDir = path.join(REPO, "i18n");
  let checked = 0;
  for (const f of fs.readdirSync(i18nDir).filter((n) => /^lang-.*\.txt$/.test(n))) {
    const lines = fs.readFileSync(path.join(i18nDir, f), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].indexOf("\t");
      if (t < 0) continue;
      const val = lines[i].slice(t + 1);
      if (val.startsWith("@") && !val.startsWith("@@")) {
        checked++;
        assert.equal(i18nFnProblem(val.slice(1)), "", `${f}:${i + 1} 现有合法 @ 行应放行: ${val}`);
      }
    }
  }
  assert.ok(checked >= 20, `应至少核验 20 条 @ 行，实际 ${checked}`);

  const exploits = [
    '(v) => `a"${alert(1)}"b`',
    '(v) => `a"${process.exit(1)}"b`',
    '(v) => `a"${constructor}"b`',
    '(v) => `a"${v.constructor}"b`',
    '(v) => `a"${"}" + alert(1)}"b`',
    '(v) => `a"${`nested ${alert(1)}`}"b`',
    '(v) => `a"${{ x: alert(1) }}"b`',
    '(v) => "${alert(1)}"',
    '(v) => `a\\`${alert(1)}`',
    '(v) => v["constructor"]',
    '(v) => `a` + "unclosed',
    '(v) => "unclosed',
    '(v) => `a${v.n`',
    '(v) => `a${}`',
    '(v) => v.n // trailing comment',
    '(v) => `$${alert(1)}`',
  ];
  for (const payload of exploits) {
    assert.notEqual(i18nFnProblem(payload), "", `必须拦截恶意 @ 行: ${payload}`);
  }
});

test("1.2: install-agy.mjs --recheck 拒绝执行或洗白篡改二进制；全链路锁定 AGY_CLI_DISABLE_AUTO_UPDATE=true", async () => {
  const home = path.join(WORK, "agy-recheck-home");
  const dest = path.join(home, ".local/share/hachimia/agy");
  const dir = path.join(dest, "1.5.14");
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "agy");
  const ranMarker = path.join(WORK, "tampered-agy-ran");
  fs.rmSync(ranMarker, { force: true });

  // 先写合法清单，再把二进制替换成“自称 9.9.9 且会在被执行时落盘”的篡改版
  const orig = Buffer.from(`#!${SH_BIN}\necho "agy 1.5.14"\n`);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    name: "agy",
    version: "1.5.14",
    sha256: crypto.createHash("sha256").update(orig).digest("hex"),
  }));
  fs.writeFileSync(bin, `#!${SH_BIN}\ntouch ${JSON.stringify(ranMarker)}\necho "agy 9.9.9"\nexit 0\n`, { mode: 0o755 });
  fs.symlinkSync("1.5.14", path.join(dest, "current"));

  const r = spawnSync(process.execPath, [path.join(REPO, "android/assets/scripts/install-agy.mjs"), "--recheck"], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(r.status, 3, `应返回退出码 3 拦截篡改：${r.stdout}\n${r.stderr}`);
  assert.equal(fs.existsSync(ranMarker), false, "--recheck 绝不允许执行 sha256 不符的二进制");
  assert.equal(fs.existsSync(path.join(dir, ".mismatch")), true, "必须写入 .mismatch 标记");
  assert.equal(fs.existsSync(path.join(dest, "9.9.9")), false, "绝不能新建 9.9.9 目录");
  assert.equal(fs.readlinkSync(path.join(dest, "current")), "1.5.14", "不得改写 current 软链");

  // 校准：toolEnv、agyEnv 与 createAcpClient 强制锁定 AGY_CLI_DISABLE_AUTO_UPDATE="true"
  const prevAuto = process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
  process.env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  try {
    assert.equal(toolEnv().AGY_CLI_DISABLE_AUTO_UPDATE, "true");
    assert.equal(agyEnv({ sync: false }).AGY_CLI_DISABLE_AUTO_UPDATE, "true");
    const spy = path.join(WORK, "spy-acp-env");
    const outFile = path.join(WORK, "spy-acp-env.out");
    fs.writeFileSync(spy, `#!${SH_BIN}\nprintf '%s' "$AGY_CLI_DISABLE_AUTO_UPDATE" > ${JSON.stringify(outFile)}\nexit 0\n`, { mode: 0o755 });
    const c = createAcpClient({ bin: spy, args: [], cwd: WORK, env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "0" } });
    await new Promise((resolve) => c.child.on("close", resolve));
    assert.equal(fs.readFileSync(outFile, "utf8"), "true");
  } finally {
    if (prevAuto === undefined) delete process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
    else process.env.AGY_CLI_DISABLE_AUTO_UPDATE = prevAuto;
  }
});

test("1.3: install-agy.mjs 在非 CCAPP_TEST=1 下拒绝不可信 HACHIMIA_AGY_INSTALL_URL / MANIFEST_BASE 且绝不发请求", async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    res.writeHead(200);
    res.end("#!/bin/sh\necho pwned\n");
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = srv.address().port;
  const home = path.join(WORK, "agy-url-lock");
  fs.mkdirSync(home, { recursive: true });
  const script = path.join(REPO, "android/assets/scripts/install-agy.mjs");

  try {
    const baseEnv = { ...process.env, HOME: home };
    delete baseEnv.CCAPP_TEST;
    for (const [key, badUrl] of [
      ["HACHIMIA_AGY_INSTALL_URL", `http://127.0.0.1:${port}/install.sh`],
      ["HACHIMIA_AGY_INSTALL_URL", "https://antigravity.google.evil.com/cli/install.sh"],
      ["HACHIMIA_AGY_INSTALL_URL", "https://user@antigravity.google/cli/install.sh"],
      ["HACHIMIA_AGY_MANIFEST_BASE", `http://127.0.0.1:${port}/manifests`],
      ["HACHIMIA_AGY_MANIFEST_BASE", "https://evil.example/manifests"],
    ]) {
      const r = spawnSync(process.execPath, [script, key === "HACHIMIA_AGY_MANIFEST_BASE" ? "--check" : "stable"], {
        env: { ...baseEnv, CCAPP_TEST: "0", [key]: badUrl },
        encoding: "utf8",
      });
      assert.notEqual(r.status, 0, `非测试环境必须拒绝 ${key}=${badUrl}`);
      assert.match(r.stderr, /拒绝(?:不受信任|含凭据)/);
    }
    assert.equal(hits, 0, "被拦截的不可信 URL 绝不能实际发起请求");
  } finally {
    srv.close();
  }
});

test("1.4: claudeseal.mjs 对缺清单 / 坏清单 / 缺 sha256 一律 fail-closed，同时保留 missing / dev 的 ok: null", async () => {
  const root = path.join(CFG.home, ".local/share/hachimia/agy-wave1-seal");
  const dir = path.join(root, "1.5.14");
  const bin = path.join(dir, "agy");
  fs.mkdirSync(dir, { recursive: true });
  tamperAck(); tamperNote();

  try {
    // 1. 开发模式且未传 force -> ok: null, why: "dev"
    const devRes = await claudeSeal(bin);
    assert.equal(devRes.ok, null);
    assert.equal(devRes.why, "dev");

    // 2. 二进制本身不存在（force: true）-> ok: null, why: "missing"
    const missRes = await claudeSeal(bin, { force: true });
    assert.equal(missRes.ok, null);
    assert.equal(missRes.why, "missing");

    // 3. 二进制存在但缺少 manifest.json -> ok: false (fail-closed)
    fs.writeFileSync(bin, "ELF binary");
    const noMf = await claudeSeal(bin, { force: true });
    assert.equal(noMf.ok, false);
    assert.equal(noMf.why, "no local manifest");
    tamperAck(); tamperNote();

    // 4. manifest.json 损坏（非法 JSON）-> ok: false (fail-closed)
    fs.writeFileSync(path.join(dir, "manifest.json"), "{not-valid-json");
    const badJson = await claudeSeal(bin, { force: true });
    assert.equal(badJson.ok, false);
    assert.match(badJson.why, /^manifest read error:/);
    tamperAck(); tamperNote();

    // 5. manifest.json 缺 sha256 / 空 sha256 -> ok: false (fail-closed)
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: "1.5.14", sha256: "" }));
    const emptySha = await claudeSeal(bin, { force: true });
    assert.equal(emptySha.ok, false);
    assert.equal(emptySha.why, "manifest has no sha256");
    tamperAck(); tamperNote();

    // 6. 合法 manifest.json -> ok: true
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      version: "1.5.14",
      sha256: crypto.createHash("sha256").update("ELF binary").digest("hex"),
    }));
    const good = await claudeSeal(bin, { force: true });
    assert.equal(good.ok, true);
    assert.equal(good.version, "1.5.14");
  } finally {
    tamperAck(); tamperNote();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
