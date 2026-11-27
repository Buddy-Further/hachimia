// Wave 5-A 回归测试：Bug 8.1 (原子落盘)、Bug 8.2/10.8 (device-mcp & priv)、
// Bug 8.3 (custom.mjs treeUsage)、孤立 Bug 2 (mkdict.mjs \\n)、孤立 Bug 3 (build.sh & apklib.mjs)
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readRepo = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── Bug 8.1：静态 .tmp 覆写 / 非原子写入 -> 统一原子安全落盘 ───────────────────────
test("8.1: 7 个目标文件均不再使用静态 .tmp 覆写，且运行时原子写入不残留 .tmp", async () => {
  const targets = [
    "gateway/gw/uistore.mjs",
    "gateway/gw/fonts.mjs",
    "gateway/gw/components.mjs",
    "gateway/gw/notices.mjs",
    "gateway/gw/userconf.mjs",
    "gateway/gw/reconcile.mjs",
    "android/assets/bin/pkg.mjs",
  ];
  for (const rel of targets) {
    const src = readRepo(rel);
    assert.doesNotMatch(src, /\+\s*["']\.tmp["']/, `${rel} 不得保留静态 .tmp 拼接`);
    assert.doesNotMatch(src, /\+\s*["']\.sig\.tmp["']/, `${rel} 不得保留静态 .sig.tmp 拼接`);
    assert.doesNotMatch(src, /\.tmp-"\s*\+\s*process\.pid\s*[;)\n]/, `${rel} 不得仅用 pid 当临时后缀`);
  }

  // 验证 uistore.patchUi 与 notices.saveSigned 落盘无 .tmp 残留
  const { patchUi, readUi } = await import("../gw/uistore.mjs");
  const ui = patchUi({ accent: "teal" });
  assert.equal(ui.accent, "teal");
  assert.equal(readUi().accent, "teal");
  assert.equal(fs.readdirSync(CFG.home).filter((n) => n.includes(".tmp")).length, 0);

  const { saveSigned, loadSigned, PUBKEY } = await import("../gw/notices.mjs");
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const body = Buffer.from(JSON.stringify({ notices: [] }));
  const sig = crypto.sign(null, body, privateKey).toString("base64");
  const signedFile = path.join(CFG.home, "w5-signed", "notices.json");
  saveSigned(signedFile, body, sig);
  assert.ok(fs.existsSync(signedFile));
  assert.ok(fs.existsSync(signedFile + ".sig"));
  assert.equal(fs.readdirSync(path.dirname(signedFile)).filter((n) => n.includes(".tmp")).length, 0);
  // 还原默认状态不影响其它验证：PUBKEY 验签不认测试钥匙，loadSigned 返回 null
  assert.equal(loadSigned(signedFile), null);
  assert.ok(PUBKEY);

  // 验证 pkg.mjs 的 writeJson 使用 O_EXCL + fsyncSync + renameSync，失败时清掉临时文件
  const pkgSrc = readRepo("android/assets/bin/pkg.mjs");
  const m = pkgSrc.match(/function writeJson\(f, v\) \{[\s\S]*?\n\}/);
  assert.ok(m, "应找到 pkg.mjs writeJson");
  assert.match(m[0], /randomBytes/);
  assert.match(m[0], /O_EXCL/);
  assert.match(m[0], /fsyncSync/);
  assert.match(m[0], /renameSync/);

  const pkgDir = fs.mkdtempSync(path.join(CFG.home, "w5-pkg-"));
  try {
    const target = path.join(pkgDir, "installed.json");
    let failNextRename = false;
    const fsProxy = {
      ...fs,
      renameSync(a, b) {
        if (failNextRename) throw new Error("EIO_INJECTED");
        return fs.renameSync(a, b);
      },
    };
    const writeJson = vm.runInNewContext(`(fs, path, crypto, process) => { ${m[0]}; return writeJson; }`)(fsProxy, path, crypto, process);
    writeJson(target, { pkgs: { a: { version: "1.0" } } });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { pkgs: { a: { version: "1.0" } } });
    assert.equal(fs.readdirSync(pkgDir).length, 1, "正常落盘不留临时文件");

    failNextRename = true;
    assert.throws(() => writeJson(target, { pkgs: { b: { version: "2.0" } } }), /EIO_INJECTED/);
    assert.equal(fs.readdirSync(pkgDir).length, 1, "rename 失败后必须清理临时文件");
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { pkgs: { a: { version: "1.0" } } }, "原文件不被破坏");
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true });
  }
});

// ── Bug 8.2 + 10.8：device-mcp.mjs 与 priv.mjs 流解码、判空、体积上限、超时、文案 ──────
test("8.2 & 10.8: device-mcp.mjs 容忍 stdin null/非对象、UTF-8 跨 chunk 不乱码、超体积拦截并更新文案", async () => {
  const mcpPath = path.join(ROOT, "android/assets/bin/device-mcp.mjs");
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "w5-mcp-"));
  const sock = path.join(dir, "p.sock");
  let mode = "split_utf8";
  const srv = net.createServer((c) => {
    c.on("error", () => {});
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf);
      if (req.op === "dev_status") {
        return c.end(JSON.stringify({ ok: true, on: true, tools: [{ name: "device_status", enabled: true }] }));
      }
      if (mode === "split_utf8") {
        // 把多字节 UTF-8 中文 + emoji 拆成两半跨 chunk 发
        const payload = Buffer.from(JSON.stringify({ ok: true, label: "中文边界🎉测试" }), "utf8");
        const mid = payload.indexOf(0xe4) + 1; // 切在三字节 UTF-8 字符中间
        c.write(payload.subarray(0, mid));
        setTimeout(() => { if (!c.destroyed) c.end(payload.subarray(mid)); }, 20);
      } else if (mode === "too_big") {
        const chunk = Buffer.alloc(1 << 20, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 18 && !c.destroyed && c.writable) {
            sent++;
            if (!c.write(chunk)) { c.once("drain", pump); return; }
          }
          if (!c.destroyed && c.writable) c.end();
        };
        pump();
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));

  const proc = spawn(process.execPath, [mcpPath], {
    env: { ...process.env, CCAPP_PRIV_SOCK: sock },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  const rl = readline.createInterface({ input: proc.stdout });
  const waiting = new Map();
  rl.on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let nextId = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++nextId;
    const tm = setTimeout(() => rej(new Error("rpc timeout: " + method)), 5000);
    waiting.set(id, (msg) => { clearTimeout(tm); res(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  try {
    // 1) stdin 收到 null / 数字 / 数组，不能抛 TypeError 崩掉
    proc.stdin.write("null\n123\n[1,2]\n");
    const pong = await rpc("ping");
    assert.deepEqual(pong.result, {});
    assert.equal(stderr, "", "不应有未捕获异常输出到 stderr");

    // 2) Bug 10.8：initialize 文案与 serverInfo
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.serverInfo.name, "hachimia-device");
    assert.doesNotMatch(init.result.instructions, /cccodroid/i);
    assert.match(init.result.instructions, /hachimia/);

    // 3) UTF-8 跨 chunk 不裂开
    mode = "split_utf8";
    const r1 = await rpc("tools/call", { name: "device_status", arguments: {} });
    assert.equal(r1.result.isError, undefined);
    const parsed = JSON.parse(r1.result.content[0].text);
    assert.equal(parsed.label, "中文边界🎉测试");
    assert.ok(!r1.result.content[0].text.includes("\ufffd"));

    // 4) 超 16MB 响应断开并返回明确错误
    mode = "too_big";
    const r2 = await rpc("tools/call", { name: "device_status", arguments: {} });
    assert.equal(r2.result.isError, true);
    assert.match(r2.result.content[0].text, /too large/i);
  } finally {
    proc.kill();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("8.2: priv.mjs oneShot UTF-8 跨 chunk 不乱码、超时不挂死、超体积断开", async () => {
  const privPath = path.join(ROOT, "android/assets/bin/priv.mjs");
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "w5-priv-"));
  const sock = path.join(dir, "p.sock");
  let mode = "split_utf8";
  const sockets = new Set();
  const srv = net.createServer((c) => {
    c.on("error", () => {});
    sockets.add(c);
    c.on("close", () => sockets.delete(c));
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      if (mode === "split_utf8") {
        const payload = Buffer.from(JSON.stringify({ ok: true, msg: "中文分片✅验证" }), "utf8");
        const mid = payload.indexOf(0xe4) + 1;
        c.write(payload.subarray(0, mid));
        setTimeout(() => { if (!c.destroyed) c.end(payload.subarray(mid)); }, 20);
      } else if (mode === "hang") {
        // 刻意不回包，测试超时
      } else if (mode === "too_big") {
        const chunk = Buffer.alloc(1 << 20, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 6 && !c.destroyed && c.writable) {
            sent++;
            if (!c.write(chunk)) { c.once("drain", pump); return; }
          }
          if (!c.destroyed && c.writable) c.end();
        };
        pump();
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));

  const runPriv = (extraEnv = {}) => new Promise((res) => {
    const ch = spawn(process.execPath, [privPath, "--status"], {
      env: { ...process.env, CCAPP_PRIV_SOCK: sock, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (err += d));
    ch.on("close", (code) => res({ code, out, err }));
  });

  try {
    mode = "split_utf8";
    const ok = await runPriv();
    assert.equal(ok.code, 0, ok.err);
    assert.equal(JSON.parse(ok.out).msg, "中文分片✅验证");
    assert.ok(!ok.out.includes("\ufffd"));

    mode = "hang";
    const t0 = Date.now();
    const tout = await runPriv({ CCAPP_PRIV_TIMEOUT_MS: "250" });
    assert.equal(tout.code, 125);
    assert.match(tout.err, /超时/);
    assert.ok(Date.now() - t0 < 3000, "挂死时应在超时后快速退出");

    mode = "too_big";
    const big = await runPriv();
    assert.equal(big.code, 125);
    assert.match(big.err, /回应过大/);
  } finally {
    for (const c of sockets) c.destroy();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Bug 8.3：custom.mjs runCapped 结合 treeUsage 对稀疏文件/目录占用封顶 ───────────────
test("8.3: custom.mjs runCapped 命中稀疏文件 treeUsage 限额时及时终止并返回 TOOBIG", async () => {
  const { _customForTest: C } = await import("../gw/custom.mjs");
  const dir = fs.mkdtempSync(path.join(CFG.home, "w5-capped-"));
  try {
    const sparseTarget = path.join(dir, "sparse.bin");
    const t0 = Date.now();
    // 用 truncateSync 制造 32 MiB 稀疏文件（blocks=0、statfsSync bavail 增量也为 0），限额设为 8 MiB
    const r = await C.runCapped(process.execPath, [
      "-e",
      "const fs=require('fs');fs.writeFileSync(process.argv[1],'');fs.truncateSync(process.argv[1],32<<20);setTimeout(()=>{},10000);",
      sparseTarget,
    ], dir, 8 << 20);
    assert.equal(r.code, "TOOBIG", `稀疏文件超过限额必须终止，got=${JSON.stringify(r)}`);
    assert.ok(r.used >= (32 << 20), `used=${r.used}`);
    assert.ok(Date.now() - t0 < 5000, "应在首轮/次轮采样及时终止");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 孤立 Bug 2：i18n/mkdict.mjs 单趟转义 \\n 与 \n ───────────────────────────────
test("孤立 Bug 2: mkdict.mjs 普通 \\n 转为换行、字面 \\\\n 保持为 \\n，且 lang-ja.txt 可正确编译", () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "w5-mkdict-"));
  try {
    const tpl = path.join(tmp, "tpl.js");
    const txt = path.join(tmp, "lang-x.txt");
    const out = path.join(tmp, "out.js");
    fs.writeFileSync(tpl, [
      "window.I18N_DICT = { en: {",
      '  "k1": "v1",',
      '  "k2": "v2",',
      '  "k3": "v3",',
      "} };",
    ].join("\n"));
    fs.writeFileSync(txt, [
      '1\t第一行\\n第二行',
      '2\tregex: [^\\\\n]+ and "quoted"',
      '3\tpath C:\\\\dir\\\\file',
    ].join("\n"));
    const r = spawnSync(process.execPath, [path.join(ROOT, "i18n/mkdict.mjs"), txt, tpl, out, "x"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const box = { window: {} };
    vm.runInNewContext(fs.readFileSync(out, "utf8"), box);
    const d = box.window.I18N_DICT.x;
    assert.equal(d.k1, "第一行\n第二行");
    assert.equal(d.k2, 'regex: [^\\n]+ and "quoted"');
    assert.equal(d.k3, "path C:\\dir\\file");

    // 用现存 lang-ja.txt 编出临时 JS 并验证 BIG_REF 正则含字面 \n 而非真实换行
    const jaOut = path.join(tmp, "lang-ja.js");
    const r2 = spawnSync(process.execPath, [
      path.join(ROOT, "i18n/mkdict.mjs"),
      path.join(ROOT, "i18n/lang-ja.txt"),
      path.join(ROOT, "gateway/web/lang-en.js"),
      jaOut,
      "ja",
    ], { encoding: "utf8" });
    assert.equal(r2.status, 0, r2.stderr);
    const jaBox = { window: {} };
    vm.runInNewContext(fs.readFileSync(jaOut, "utf8"), jaBox);
    const ja = jaBox.window.I18N_DICT.ja;
    assert.equal(Object.keys(ja).length, 3182);
    const bigRefKey = "\\[附件：(\\/[^\\n]+?) · [^\\n·，\\]]+，文件较大没有直接读入，需要时按路径读取\\]";
    assert.equal(ja[bigRefKey], "\\[Attachment: (\\/[^\\n]+?) · [^\\n·,\\]]+, file is large and was not read directly, read by path when needed\\]");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 孤立 Bug 3：scripts/build.sh 与 scripts/apklib.mjs ───────────────────────────
test("孤立 Bug 3: build.sh 语法正确且参数经 argv 传入；apklib.mjs 支持 v1 证书与缺 CN 证书", async () => {
  const sh = spawnSync("sh", ["-n", path.join(ROOT, "scripts/build.sh")], { encoding: "utf8" });
  assert.equal(sh.status, 0, sh.stderr);

  const buildSrc = readRepo("scripts/build.sh");
  assert.match(buildSrc, /LC_ALL=C/);
  assert.doesNotMatch(buildSrc, /signApk\('\$A\/build\/unsigned\.apk'/);
  assert.match(buildSrc, /process\.argv\.slice\(1\)/);

  const forgeMod = await import("../../third_party/node-forge/lib/index.js");
  const forge = forgeMod.default || forgeMod;
  const { spkiFromCert, signApk, writeZip } = await import("../../scripts/apklib.mjs");

  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 3600e3);
  cert.validity.notAfter = new Date(Date.now() + 86400e3);
  // 故意不设 CN，仅设 O
  cert.setSubject([{ name: "organizationName", value: "Wave5Org" }]);
  cert.setIssuer([{ name: "organizationName", value: "Wave5Org" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // 构造一个真正的 v1 证书（去掉 TBSCertificate 里的 [0] EXPLICIT version 字段）并测试 spkiFromCert
  const fullAsn1 = forge.pki.certificateToAsn1(cert);
  const tbs = fullAsn1.value[0];
  assert.equal(tbs.value[0].tagClass, forge.asn1.Class.CONTEXT_SPECIFIC);
  assert.equal(tbs.value[0].type, 0);
  const expectedSpki = Buffer.from(forge.asn1.toDer(forge.pki.publicKeyToAsn1(cert.publicKey)).getBytes(), "binary");
  // 移除 [0] version 变成 v1 TBS（SPKI 位于下标 5 而非 6）
  const v1Tbs = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, tbs.value.slice(1));
  const v1CertAsn1 = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [v1Tbs, fullAsn1.value[1], fullAsn1.value[2]]);
  const v1Pem = forge.pki.certificateToPem(forge.pki.certificateFromAsn1(v1CertAsn1));
  const v1Cert = forge.pki.certificateFromPem(v1Pem);

  assert.equal(spkiFromCert(v1Cert).equals(expectedSpki), true, "v1 证书（带 publicKey）SPKI 应匹配");
  // 再验证走 ASN.1 回落分支（不含 cert.publicKey 时跳过 [0] 版本号逻辑）
  const v1FakeNoPub = { ...v1Cert, publicKey: null };
  assert.equal(spkiFromCert(v1FakeNoPub).equals(expectedSpki), true, "v1 证书 ASN.1 回落路径也应正确定位下标 5");

  // 验证 signApk 对无 CN 的 v1 证书不抛 NPE
  const tmp = fs.mkdtempSync(path.join(CFG.home, "w5-apk-"));
  try {
    const inApk = path.join(tmp, "in.apk");
    const outApk = path.join(tmp, "out.apk");
    const keyJson = path.join(tmp, "key.json");
    fs.writeFileSync(inApk, writeZip([{ name: "AndroidManifest.xml", data: Buffer.from("<manifest/>"), method: 8 }]));
    fs.writeFileSync(keyJson, JSON.stringify({ key: forge.pki.privateKeyToPem(keys.privateKey), cert: v1Pem }));
    const res = signApk(inApk, outApk, [{ name: "classes.dex", data: Buffer.from("dex"), method: 8 }], keyJson);
    assert.ok(res.size > 0);
    assert.equal(res.signer, "Wave5Org");
    assert.deepEqual(res.schemes, ["v2", "v1"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
