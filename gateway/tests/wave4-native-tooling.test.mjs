// Wave 4-B 回归测试：
//   - Bug 3.4: android/native/exec-shim.c（CRLF shebang、posix_spawn(p)、execvpe EACCES 回退、溢出/ELOOP 报错、K_BIONIC -l、EXECL_ARGS NULL、对齐安全）
//   - Bug 3.2 & 10.3: devkit/devkit.mjs（first-run.sh 在 CCAPP_EXEC=loader 下不剥 LD_PRELOAD、组件 skill 路径统一 hachimia）
//   - Bug 1.6: scripts/pin-devkit.mjs、devkit/pgp.mjs、devkit/archive-sources.mjs
//   - Bug 1.7: scripts/publish-devkit.mjs（流式 pm install -r -S，不再落盘 /sdcard/Download 或 /data/local/tmp/ccp.apk）
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ANTHROPIC_KEYS, rsaKeys, verifyDetached } from "../../devkit/pgp.mjs";
import {
  buildSourcePlan,
  curlDownload,
  parseTermuxRecipeSources,
} from "../../devkit/archive-sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const TMP = fs.mkdtempSync(path.join(process.env.CCAPP_TMP || os.tmpdir(), "wave4-nt-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ── OpenPGP v4 RSA 测试夹具构造器 ─────────────────────────────────────────
function crc24(buf) {
  let crc = 0xb704ce;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 16;
    for (let j = 0; j < 8; j++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

function armor(type, bodyBuf, { badCrc = false } = {}) {
  const b64 = bodyBuf.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  const c = badCrc ? (crc24(bodyBuf) ^ 1) : crc24(bodyBuf);
  const crcB64 = Buffer.from([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]).toString("base64");
  return `-----BEGIN PGP ${type}-----\n\n${b64}\n=${crcB64}\n-----END PGP ${type}-----\n`;
}

function runNodeAsync(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function packet(tag, body) {
  let hdr;
  if (body.length < 192) {
    hdr = Buffer.from([0xc0 | tag, body.length]);
  } else if (body.length < 8384) {
    const l = body.length - 192;
    hdr = Buffer.from([0xc0 | tag, 192 + (l >> 8), l & 0xff]);
  } else {
    hdr = Buffer.alloc(6);
    hdr[0] = 0xc0 | tag;
    hdr[1] = 255;
    hdr.writeUInt32BE(body.length, 2);
  }
  return Buffer.concat([hdr, body]);
}

function mpiFromB64u(b64u) {
  let raw = Buffer.from(b64u, "base64url");
  let first = 0;
  while (first < raw.length - 1 && raw[first] === 0) first++;
  raw = raw.subarray(first);
  const top = raw[0];
  const bits = top === 0 ? 0 : (raw.length - 1) * 8 + (32 - Math.clz32(top));
  const hdr = Buffer.alloc(2);
  hdr.writeUInt16BE(bits, 0);
  return Buffer.concat([hdr, raw]);
}

function subpkt(typeByte, data) {
  const len = 1 + data.length;
  return Buffer.concat([Buffer.from([len, typeByte]), data]);
}

function makeTestRsaPgp() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const pubHeader = Buffer.alloc(6);
  pubHeader[0] = 4;
  pubHeader.writeUInt32BE(1700000000, 1);
  pubHeader[5] = 1; // RSA
  const pubBody = Buffer.concat([pubHeader, mpiFromB64u(jwk.n), mpiFromB64u(jwk.e)]);
  const fpr = crypto.createHash("sha1")
    .update(Buffer.from([0x99, pubBody.length >> 8, pubBody.length & 255]))
    .update(pubBody)
    .digest();
  const fprHex = fpr.toString("hex").toUpperCase();
  const pubArmored = armor("PUBLIC KEY BLOCK", packet(6, pubBody));

  function sign(data, { hashedSubs = [], unhashedSubs = [], badCrc = false } = {}) {
    const hashedBuf = Buffer.concat(hashedSubs);
    const unhashedBuf = Buffer.concat(unhashedSubs);
    const head = Buffer.alloc(6);
    head[0] = 4; // v4
    head[1] = 0; // binary
    head[2] = 1; // RSA
    head[3] = 8; // SHA-256
    head.writeUInt16BE(hashedBuf.length, 4);
    const hashedArea = Buffer.concat([head, hashedBuf]);
    const trailer = Buffer.alloc(6);
    trailer[0] = 4;
    trailer[1] = 0xff;
    trailer.writeUInt32BE(hashedArea.length, 2);
    const digestInput = Buffer.concat([Buffer.from(data), hashedArea, trailer]);
    const sigRaw = crypto.sign("sha256", digestInput, privateKey);
    const digest = crypto.createHash("sha256").update(digestInput).digest();
    const ulBuf = Buffer.alloc(2);
    ulBuf.writeUInt16BE(unhashedBuf.length, 0);
    const sigMpi = mpiFromB64u(sigRaw.toString("base64url"));
    const sigBody = Buffer.concat([hashedArea, ulBuf, unhashedBuf, digest.subarray(0, 2), sigMpi]);
    return armor("SIGNATURE", packet(2, sigBody), { badCrc });
  }

  return { fpr, fprHex, jwk, pubArmored, sign };
}

// ── 1. devkit/pgp.mjs 测试 ────────────────────────────────────────────────
test("Bug 1.6 (pgp.mjs): 真实夹具与生成签名验签通过，拒绝坏 CRC24/非法 armor/截断包/未知关键子包/过期签名", () => {
  // 真实 Anthropic 夹具验签通过
  const mData = fs.readFileSync(path.join(REPO, "gateway/tests/fixtures/claude-2.1.311/manifest.json"));
  const mSig = fs.readFileSync(path.join(REPO, "gateway/tests/fixtures/claude-2.1.311/manifest.json.sig"), "utf8");
  assert.equal(verifyDetached(mData, mSig, ANTHROPIC_KEYS), "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE");

  const pgp = makeTestRsaPgp();
  const extracted = rsaKeys(pgp.pubArmored);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].fpr, pgp.fprHex);
  const keys = { [pgp.fprHex]: extracted[0].jwk };
  const payload = Buffer.from("hello-wave4-pgp");

  const createdAt = 1700000000;
  const ctimeBytes = Buffer.alloc(4);
  ctimeBytes.writeUInt32BE(createdAt, 0);
  const fprSub = subpkt(33, Buffer.concat([Buffer.from([4]), pgp.fpr]));
  const ctimeSub = subpkt(2, ctimeBytes);

  // 正常签名通过
  const okSig = pgp.sign(payload, { hashedSubs: [fprSub, ctimeSub] });
  assert.equal(verifyDetached(payload, okSig, keys, { now: createdAt + 10 }), pgp.fprHex);

  // 非关键未知子包（type 99）放行
  const nonCritSig = pgp.sign(payload, { hashedSubs: [fprSub, ctimeSub, subpkt(99, Buffer.from([1, 2]))] });
  assert.equal(verifyDetached(payload, nonCritSig, keys, { now: createdAt + 10 }), pgp.fprHex);

  // 坏 CRC24 拒绝
  const badCrcSig = pgp.sign(payload, { hashedSubs: [fprSub, ctimeSub], badCrc: true });
  assert.throws(() => verifyDetached(payload, badCrcSig, keys), /crc24/i);

  // 非法 armor（前后拼接垃圾、缺 END、错误 armor 类型、拼接第二个块）拒绝
  assert.throws(() => verifyDetached(payload, "garbage\n" + okSig, keys), /bad armor/i);
  assert.throws(() => verifyDetached(payload, okSig + "\ngarbage", keys), /bad armor/i);
  assert.throws(() => verifyDetached(payload, okSig.replace("-----END PGP SIGNATURE-----", ""), keys), /bad armor/i);
  assert.throws(() => verifyDetached(payload, pgp.pubArmored, keys), /unexpected armor type/i);
  assert.throws(() => verifyDetached(payload, okSig + "\n" + okSig, keys), /bad armor/i);

  // 截断 packet / 越界保护
  const truncBody = Buffer.from([0xc2, 0x20, 0x04, 0x00]); // 声称长度 32 字节，实际只有 2 字节
  assert.throws(() => verifyDetached(payload, armor("SIGNATURE", truncBody), keys), /truncated packet/i);
  const emptyLenBody = Buffer.from([0xc2]); // 缺长度字节 (len === undefined)
  assert.throws(() => verifyDetached(payload, armor("SIGNATURE", emptyLenBody), keys), /truncated packet/i);

  // hashed / unhashed 中的未知 critical subpacket（type | 0x80）必须 fail-closed 拒绝
  const critHashedSig = pgp.sign(payload, { hashedSubs: [fprSub, ctimeSub, subpkt(0x80 | 99, Buffer.from([1]))] });
  assert.throws(() => verifyDetached(payload, critHashedSig, keys), /unsupported critical subpacket/i);

  const critUnhashedSig = pgp.sign(payload, {
    hashedSubs: [fprSub, ctimeSub],
    unhashedSubs: [subpkt(0x80 | 99, Buffer.from([1]))],
  });
  assert.throws(() => verifyDetached(payload, critUnhashedSig, keys), /unsupported critical subpacket/i);

  // Signature Expiration Time（type 3）：未过期放行，过期拒绝；expDelta=0 永不过期
  const exp60 = Buffer.alloc(4);
  exp60.writeUInt32BE(60, 0);
  const expSig = pgp.sign(payload, { hashedSubs: [fprSub, ctimeSub, subpkt(3, exp60)] });
  assert.equal(verifyDetached(payload, expSig, keys, { now: createdAt + 59 }), pgp.fprHex);
  assert.throws(() => verifyDetached(payload, expSig, keys, { now: createdAt + 60 }), /expired/i);
  assert.throws(() => verifyDetached(payload, expSig, keys), /expired/i); // 当前真实时间远大于 2023 年

  const expZero = Buffer.alloc(4);
  expZero.writeUInt32BE(0, 0);
  const neverExpSig = pgp.sign(payload, { hashedSubs: [fprSub, ctimeSub, subpkt(3, expZero)] });
  assert.equal(verifyDetached(payload, neverExpSig, keys, { now: createdAt + 99999999 }), pgp.fprHex);
});

// ── 2. scripts/pin-devkit.mjs 测试 ────────────────────────────────────────
test("Bug 1.6 (pin-devkit.mjs): 强制校对 lock.release === tag 与 modules.release === tag 防回放降级", async () => {
  const srvState = {
    lock: { release: "devkit-2026.11.19", target: "ha.chi.mia", gz: { file: "a.tar.gz", sha256: "a".repeat(64), bytes: 10 }, tar: { file: "a.tar", sha256: "b".repeat(64), bytes: 20 } },
    modules: { release: "devkit-2026.11.19", modules: [] },
    badSig: false,
  };
  const srv = http.createServer((req, res) => {
    if (req.url === "/download/devkit-2026.11.19/devkit.lock.json") {
      res.writeHead(200);
      res.end(JSON.stringify(srvState.lock));
      return;
    }
    if (req.url === "/download/devkit-2026.11.19/modules.json") {
      res.writeHead(200);
      res.end(JSON.stringify(srvState.modules));
      return;
    }
    if (req.url.endsWith(".sig") && srvState.badSig) {
      res.writeHead(200);
      res.end(Buffer.alloc(64, 1).toString("base64"));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${srv.address().port}/download/devkit-2026.11.19/`;
  const script = path.join(REPO, "scripts/pin-devkit.mjs");
  const out = path.join(TMP, "pin-out.json");
  try {
    // 1) 坏签名必须拒绝（不设 PIN_ALLOW_UNSIGNED）
    srvState.badSig = true;
    const rBadSig = await runNodeAsync([script, base, out]);
    assert.notEqual(rBadSig.status, 0);
    assert.match(rBadSig.stderr, /验签失败/);
    srvState.badSig = false;

    // 2) lock.release !== tag 必须拒绝
    srvState.lock.release = "devkit-2026.10.01";
    const rBadLock = await runNodeAsync([script, base, out], {
      env: { ...process.env, PIN_ALLOW_UNSIGNED: "1" },
    });
    assert.notEqual(rBadLock.status, 0);
    assert.match(rBadLock.stderr, /release/);

    // 3) lock.release === tag 但 modules.release !== tag 必须拒绝
    srvState.lock.release = "devkit-2026.11.19";
    srvState.modules.release = "devkit-2026.10.01";
    const rBadMod = await runNodeAsync([script, base, out], {
      env: { ...process.env, PIN_ALLOW_UNSIGNED: "1" },
    });
    assert.notEqual(rBadMod.status, 0);
    assert.match(rBadMod.stderr, /modules\.json.*release/);

    // 4) 两者均与 tag 一致时成功写入
    srvState.modules.release = "devkit-2026.11.19";
    const rOk = await runNodeAsync([script, base, out], {
      env: { ...process.env, PIN_ALLOW_UNSIGNED: "1" },
    });
    assert.equal(rOk.status, 0, rOk.stderr);
    const pinned = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(pinned.tag, "devkit-2026.11.19");
    assert.ok(pinned.modules?.sha256);
  } finally {
    srv.close();
  }
});

// ── 3. devkit/archive-sources.mjs 测试 ───────────────────────────────────
test("Bug 1.6 (archive-sources.mjs): --proto =https、缺 termuxRef 拒绝、缺 SHA-256 拒绝", () => {
  // 1) 缺 termuxRef 或为可变分支名时 fail-closed 拒绝
  const lockNoRef = { release: "devkit-2026.11.19", packages: [{ name: "bash", license: "GPL-3.0" }] };
  assert.throws(() => buildSourcePlan(lockNoRef), /termuxRef/i);
  assert.throws(() => buildSourcePlan({ ...lockNoRef, termuxRef: "master" }), /termuxRef/i);
  assert.throws(() => buildSourcePlan({ ...lockNoRef, termuxRef: "main" }), /termuxRef/i);
  // apkOnly 时不需要 termuxRef
  assert.equal(buildSourcePlan({ release: "apk-only", packages: [] }, { apkOnly: true }).devkitPackages.length, 0);

  // 2) 未能提取出有效 SHA-256 时 fail-closed 拒绝
  assert.throws(() => parseTermuxRecipeSources('TERMUX_PKG_SRCURL="https://example.com/a.tar.gz"\n', "1.0"), /SHA256/);
  assert.throws(() => parseTermuxRecipeSources('TERMUX_PKG_SRCURL="https://example.com/a.tar.gz"\nTERMUX_PKG_SHA256=bad\n', "1.0"), /SHA256/);
  assert.throws(() => parseTermuxRecipeSources('TERMUX_PKG_SHA256=' + "a".repeat(64) + "\n", "1.0"), /SRCURL/);

  // 3) curlDownload 禁止非 https:// 并向 curl 传 --proto =https
  assert.throws(() => curlDownload("http://example.com/a.tgz", path.join(TMP, "a.tgz"), "a".repeat(64)), /https:\/\//);
  assert.throws(() => curlDownload("file:///etc/passwd", path.join(TMP, "p"), "a".repeat(64)), /https:\/\//);
  assert.throws(() => curlDownload("https://example.com/a.tgz", path.join(TMP, "a.tgz"), "", { requireSha: true }), /SHA-256/);

  const stubBin = path.join(TMP, "stub-curl-bin");
  fs.mkdirSync(stubBin, { recursive: true });
  const argsLog = path.join(TMP, "curl-args.txt");
  const shPath = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  const payload = Buffer.from("archived-tarball-content");
  const sha = crypto.createHash("sha256").update(payload).digest("hex");
  fs.writeFileSync(
    path.join(stubBin, "curl"),
    `#!${shPath}\nprintf '%s\\n' "$@" > "${argsLog}"\nout=""\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi\n  shift\ndone\nprintf 'archived-tarball-content' > "$out"\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${stubBin}:${oldPath}`;
  try {
    const dest = path.join(TMP, "dl-ok.tgz");
    const got = curlDownload("https://example.com/pkg.tgz", dest, sha, { requireSha: true });
    assert.equal(got, sha);
    const recorded = fs.readFileSync(argsLog, "utf8").trim().split("\n");
    const protoIdx = recorded.indexOf("--proto");
    assert.ok(protoIdx >= 0 && recorded[protoIdx + 1] === "=https", `curl 参数必须包含 --proto =https: ${recorded.join(" ")}`);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ── 4. devkit/devkit.mjs 与 scripts/publish-devkit.mjs 测试 ────────────────
test("Bug 3.2 & 10.3 (devkit.mjs) + Bug 1.7 (publish-devkit.mjs)", () => {
  const dkSrc = fs.readFileSync(path.join(REPO, "devkit/devkit.mjs"), "utf8");
  assert.match(dkSrc, /r\.skill\s*=\s*`usr\/share\/hachimia\/components\/\$\{r\.id\}\/skill`/);
  assert.doesNotMatch(dkSrc, /usr\/share\/cccodroid\/components/);
  assert.match(dkSrc, /if \[ "\$CCAPP_EXEC" = "loader" \]; then/);

  // 实际验证 first-run.sh 的分支逻辑：loader 模式保留 LD_PRELOAD，direct 模式才清空 LD_PRELOAD=
  const shPath = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  const snippet = [
    `if [ -x "${shPath}" ]; then`,
    `  if [ "$CCAPP_EXEC" = "loader" ]; then`,
    `    "${shPath}" -c 'echo "PY_PRELOAD:\${LD_PRELOAD:-EMPTY}"'`,
    `  else`,
    `    LD_PRELOAD= "${shPath}" -c 'echo "PY_PRELOAD:\${LD_PRELOAD:-EMPTY}"'`,
    `  fi`,
    `fi`,
  ].join("\n");
  const dummyC = path.join(TMP, "dummy-preload.c");
  const dummySo = path.join(TMP, "libdummy-preload.so");
  fs.writeFileSync(dummyC, "int w4_dummy_preload(void) { return 0; }\n");
  const compDummy = spawnSync("clang", ["-shared", "-fPIC", "-o", dummySo, dummyC], { encoding: "utf8" });
  const preloadVal = compDummy.status === 0 ? dummySo : (process.env.LD_PRELOAD || "");
  const snippetEnv = { ...process.env };
  delete snippetEnv.CCAPP_LD;
  delete snippetEnv.CCAPP_BIONIC_PRELOAD;
  if (preloadVal) {
    const rLoader = spawnSync(shPath, ["-c", snippet], {
      env: { ...snippetEnv, CCAPP_EXEC: "loader", LD_PRELOAD: preloadVal },
      encoding: "utf8",
    });
    assert.equal(rLoader.status, 0, rLoader.stderr);
    assert.equal(rLoader.stdout.trim(), `PY_PRELOAD:${preloadVal}`);
  }

  const rDirect = spawnSync(shPath, ["-c", snippet], {
    env: { ...snippetEnv, CCAPP_EXEC: "direct", LD_PRELOAD: preloadVal },
    encoding: "utf8",
  });
  assert.equal(rDirect.status, 0, rDirect.stderr);
  assert.equal(rDirect.stdout.trim(), "PY_PRELOAD:EMPTY");

  // Bug 1.7: publish-devkit.mjs 不再落盘 /sdcard/Download 或 /data/local/tmp/ccp.apk
  const pubSrc = fs.readFileSync(path.join(REPO, "scripts/publish-devkit.mjs"), "utf8");
  assert.doesNotMatch(pubSrc, /\/sdcard\/Download/);
  assert.doesNotMatch(pubSrc, /\/data\/local\/tmp\/ccp\.apk/);
  assert.match(pubSrc, /pm install -r -S \$\{size\}/);
  assert.match(pubSrc, /stdio:\s*\[\s*fd\s*,\s*"inherit"\s*,\s*"inherit"\s*\]/);
});

// ── 5. android/native/exec-shim.c 编译与 C 行为实测 ───────────────────────
test("Bug 3.4 (exec-shim.c): clang 零警告编译 + CRLF shebang / ELOOP / 溢出报错 / K_BIONIC / EXECL_ARGS NULL / posix_spawn(p) / execvpe 实测", (t) => {
  const probe = spawnSync("clang", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("无 clang");
    return;
  }

  const shimSrc = path.join(REPO, "android/native/exec-shim.c");
  const soGlibc = path.join(TMP, "libccexecshim.so");
  const soBionic = path.join(TMP, "libccexecshimb.so");
  const c1 = spawnSync("clang", [
    "-O2", "-shared", "-fPIC", "-nostdlib", "-fno-stack-protector",
    "-Wall", "-Wextra", "-Werror", "-Wl,-z,noexecstack", "-Wl,--hash-style=both",
    "-o", soGlibc, shimSrc,
  ], { encoding: "utf8" });
  assert.equal(c1.status, 0, `glibc exec-shim 编译失败:\n${c1.stderr}`);

  const c2 = spawnSync("clang", [
    "-DBIONIC", "-O2", "-shared", "-fPIC", "-fno-stack-protector",
    "-Wall", "-Wextra", "-Werror", "-Wl,-z,noexecstack", "-Wl,--hash-style=both",
    "-o", soBionic, shimSrc, "-ldl",
  ], { encoding: "utf8" });
  assert.equal(c2.status, 0, `bionic exec-shim 编译失败:\n${c2.stderr}`);

  // C 单元测试 harness：通过拦截 dlsym/next_spawn 与直接测试 mkplan/kind/is_plain_script/EXECL_ARGS/execvpe/posix_spawnp
  const harnessC = path.join(TMP, "shim_harness.c");
  const harnessBin = path.join(TMP, "shim_harness");
  const sysSh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  const prefixBin = process.env.PREFIX ? path.join(process.env.PREFIX, "bin") : path.dirname(sysSh);

  // 构造夹具目录
  const fdir = path.join(TMP, "shim-fx");
  fs.mkdirSync(path.join(fdir, "p1"), { recursive: true });
  fs.mkdirSync(path.join(fdir, "p2"), { recursive: true });

  // CRLF 无参数 shebang 脚本
  const crlfScript = path.join(fdir, "crlf-noarg.sh");
  fs.writeFileSync(crlfScript, `#!${sysSh}\r\necho CRLF_OK\r\n`, { mode: 0o755 });

  // CRLF 带参数 shebang 脚本
  const crlfArgScript = path.join(fdir, "crlf-arg.sh");
  fs.writeFileSync(crlfArgScript, `#!${sysSh} -e\r\necho CRLF_ARG_OK\r\n`, { mode: 0o755 });

  // 6 层环状 #! 脚本（耗尽 depth == 5 必须返 -ELOOP）
  const loopA = path.join(fdir, "loopA");
  const loopB = path.join(fdir, "loopB");
  fs.writeFileSync(loopA, `#!${loopB}\n`, { mode: 0o755 });
  fs.writeFileSync(loopB, `#!${loopA}\n`, { mode: 0o755 });

  // 无 #! 可执行纯文本脚本（放在 p2，且 p1 放一个不可运行的坏 ELF 或不可读文件测多候选回退）
  const plainScript = path.join(fdir, "p2", "plain-cmd");
  fs.writeFileSync(plainScript, `echo "PLAIN_SCRIPT:$0:$1"\n`, { mode: 0o755 });

  // 非可读 0111 文件、普通 0644 文件、目录、伪 ELF 文件
  const execOnly = path.join(fdir, "exec-only");
  fs.writeFileSync(execOnly, "echo NO\n", { mode: 0o111 });
  const nonExec = path.join(fdir, "non-exec");
  fs.writeFileSync(nonExec, "echo NO\n", { mode: 0o644 });
  const subDir = path.join(fdir, "subdir");
  fs.mkdirSync(subDir, { recursive: true });
  const fakeElf = path.join(fdir, "fake-elf");
  fs.writeFileSync(fakeElf, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]));
  fs.chmodSync(fakeElf, 0o755);

  // p1/plain-cmd 放一个假 ELF（PT_INTERP 不存在，execve 失败），验证 posix_spawnp / execvpe 跳过坏候选试 p2/plain-cmd
  const badCand = path.join(fdir, "p1", "plain-cmd");
  // 构造最小 64 位 ELF（PT_INTERP="/nonexistent/interp"）
  const elfBuf = Buffer.alloc(64 + 56 + 32);
  elfBuf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  elfBuf.writeBigUInt64LE(64n, 32); // e_phoff
  elfBuf.writeUInt16LE(56, 54); // e_phentsize
  elfBuf.writeUInt16LE(1, 56);  // e_phnum
  elfBuf.writeUInt32LE(3, 64);  // p_type = PT_INTERP
  elfBuf.writeBigUInt64LE(120n, 64 + 8); // p_offset
  elfBuf.writeBigUInt64LE(20n, 64 + 32); // p_filesz
  elfBuf.write("/nonexistent/interp\0", 120);
  fs.writeFileSync(badCand, elfBuf, { mode: 0o755 });

  // 真实 bionic ELF 夹具（如果有 bash）与构造的 bionic ELF 头（PT_INTERP = /system/bin/linker64）
  const bionicElf = path.join(fdir, "bash");
  const bionicBuf = Buffer.alloc(64 + 56 + 32);
  bionicBuf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  bionicBuf.writeBigUInt64LE(64n, 32);
  bionicBuf.writeUInt16LE(56, 54);
  bionicBuf.writeUInt16LE(1, 56);
  bionicBuf.writeUInt32LE(3, 64);
  bionicBuf.writeBigUInt64LE(120n, 64 + 8);
  bionicBuf.writeBigUInt64LE(21n, 64 + 32);
  bionicBuf.write("/system/bin/linker64\0", 120);
  fs.writeFileSync(bionicElf, bionicBuf, { mode: 0o755 });

  const cCode = `
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
int *__errno_location(void) { return &errno; }

/* 截获 exec-shim.c 里的 dlsym 以把 posix_spawn / posix_spawnp 导向可观测的 stub */
static int spawn_calls = 0;
static char last_spawn_path[512];
static char last_spawn_arg0[512];
static char last_spawn_arg1[512];
static int mock_spawn_mode = 0;

static int mock_real_spawn(int *pid, const char *path, const void *fa, const void *at, char *const argv[], char *const envp[]) {
    (void)pid; (void)fa; (void)at; (void)envp;
    spawn_calls++;
    snprintf(last_spawn_path, sizeof last_spawn_path, "%s", path ? path : "");
    snprintf(last_spawn_arg0, sizeof last_spawn_arg0, "%s", (argv && argv[0]) ? argv[0] : "");
    snprintf(last_spawn_arg1, sizeof last_spawn_arg1, "%s", (argv && argv[1]) ? argv[1] : "");
    if (mock_spawn_mode == 1) {
        if (strcmp(path, "${badCand}") == 0) return ENOEXEC;
        if (strcmp(path, "${plainScript}") == 0) return EACCES;
        if (strcmp(path, "${sysSh}") == 0 && argv && argv[1] && strcmp(argv[1], "${plainScript}") == 0) return 0;
        return ENOENT;
    }
    return 0;
}

static void *shim_dlsym(void *h, const char *sym) {
    (void)h;
    if (strcmp(sym, "posix_spawn") == 0) return (void *)mock_real_spawn;
    if (strcmp(sym, "posix_spawnp") == 0) return (void *)mock_real_spawn;
    return NULL;
}

/* 将 exec-shim.c 里的 libc 函数符号重命名，避免与主机 libc 冲突同时测试真实逻辑 */
#define dlsym shim_dlsym
#define execve shim_execve
#define execv shim_execv
#define execvpe shim_execvpe
#define execvp shim_execvp
#define execl shim_execl
#define execlp shim_execlp
#define execle shim_execle
#define fexecve shim_fexecve
#define execveat shim_execveat
#define readlink shim_readlink
#define readlinkat shim_readlinkat
#define posix_spawn shim_posix_spawn
#define posix_spawnp shim_posix_spawnp
#include "${shimSrc.replace(/\\/g, "\\\\")}"
#undef dlsym
#undef execve
#undef execv
#undef execvpe
#undef execvp
#undef execl
#undef execlp
#undef execle
#undef fexecve
#undef execveat
#undef readlink
#undef readlinkat
#undef posix_spawn
#undef posix_spawnp

static void test_mkplan_and_kind(void) {
    setenv("CCAPP_LD", "/fake/libldlinux.so", 1);
    setenv("CCAPP_BIONIC_PRELOAD", "/fake/bionic.so", 1);

    /* 1. CRLF 无参数 shebang：ip 不允许残留 \\r */
    {
        char *av_in[] = { "crlf", NULL };
        char *env_in[] = { "PATH=/usr/bin", NULL };
        PLAN_SPACE(av_in, env_in);
        int mr = mkplan("${crlfScript}", av_in, env_in, av_, ev_, &ar_, &pl_);
        assert(mr == 1);
        assert(strcmp(pl_.path, "${sysSh}") == 0);
        assert(strcmp(pl_.argv[0], "${sysSh}") == 0);
        assert(strcmp(pl_.argv[1], "${crlfScript}") == 0);
        assert(strchr(pl_.path, '\\r') == NULL);
    }

    /* 2. CRLF 带参数 shebang：arg 不允许残留 \\r */
    {
        char *av_in[] = { "crlf-arg", NULL };
        char *env_in[] = { "PATH=/usr/bin", NULL };
        PLAN_SPACE(av_in, env_in);
        int mr = mkplan("${crlfArgScript}", av_in, env_in, av_, ev_, &ar_, &pl_);
        assert(mr == 1);
        assert(strcmp(pl_.argv[1], "-e") == 0);
        assert(strcmp(pl_.argv[2], "${crlfArgScript}") == 0);
    }

    /* 3. depth == 5 耗尽返回 -ELOOP_ (不返回 0 踩 EACCES) */
    {
        char *av_in[] = { "loopA", NULL };
        char *env_in[] = { NULL };
        PLAN_SPACE(av_in, env_in);
        int mr = mkplan("${loopA}", av_in, env_in, av_, ev_, &ar_, &pl_);
        assert(mr == -ELOOP_);
        errno = 0;
        assert(shim_execve("${loopA}", av_in, env_in) == -1);
        assert(errno == ELOOP);
    }

    /* 4. arena 溢出时 fixenv2 / mkplan 显式报 -E2BIG_，绝不静默丢弃 LD_PRELOAD/SELF 并返回 1 */
    {
        char *av_in[] = { "bash", NULL };
        char *env_in[] = { "A=1", NULL };
        char *av_s[32], *ev_s[8], tiny[16];
        arena tiny_ar = { tiny, 0, sizeof tiny };
        plan p_out;
        int mr = mkplan("${bionicElf}", av_in, env_in, av_s, ev_s, &tiny_ar, &p_out);
        assert(mr == -E2BIG_);
    }

    /* 5. K_BIONIC: /system/bin/linker64 必须把 abs 留在 argv[1] 并对 -bash 登录 shell 补入 -l */
    {
        char *av_in[] = { "-bash", "-i", NULL };
        char *env_in[] = { "HOME=/tmp", NULL };
        PLAN_SPACE(av_in, env_in);
        int mr = mkplan("${bionicElf}", av_in, env_in, av_, ev_, &ar_, &pl_);
        assert(mr == 1);
        assert(strcmp(pl_.path, "/system/bin/linker64") == 0);
        assert(strcmp(pl_.argv[0], "/system/bin/linker64") == 0);
        assert(strcmp(pl_.argv[1], "${bionicElf}") == 0);
        assert(strcmp(pl_.argv[2], "-l") == 0);
        assert(strcmp(pl_.argv[3], "-i") == 0);
        assert(pl_.argv[4] == NULL);
        int saw_self = 0, saw_preload = 0;
        for (int i = 0; pl_.envp[i]; i++) {
            if (strcmp(pl_.envp[i], "TERMUX_EXEC__PROC_SELF_EXE=${bionicElf}") == 0) saw_self = 1;
            if (strcmp(pl_.envp[i], "LD_PRELOAD=/fake/bionic.so") == 0) saw_preload = 1;
        }
        assert(saw_self && saw_preload);
    }

    /* 6. is_plain_script 只放行非系统目录、普通、可执行且可读的非 ELF 非 #! 文件 */
    assert(is_plain_script("${plainScript}") == 1);
    assert(is_plain_script("${crlfScript}") == 0);
    assert(is_plain_script("${fakeElf}") == 0);
    assert(is_plain_script("${execOnly}") == 0);
    assert(is_plain_script("${nonExec}") == 0);
    assert(is_plain_script("${subDir}") == 0);
    assert(is_plain_script("${sysSh}") == 0);
}

static void test_posix_spawn_and_execl_null(void) {
    unsetenv("CCAPP_BIONIC_PRELOAD");
    /* 1. posix_spawn 对 /proc/self/exe 与出错处理 */
    setenv("CCAPP_LD", "/fake/libldlinux.so", 1);
    {
        char *av[] = { "loopA", NULL };
        char *ev[] = { NULL };
        int pid = 0;
        int rc = shim_posix_spawn(&pid, "${loopA}", NULL, NULL, av, ev);
        assert(rc == ELOOP);
    }

    /* 2. posix_spawnp：候选 0 (p1/plain-cmd) 返回 ENOEXEC 后跳过，候选 1 (p2/plain-cmd) 返回 EACCES 后经 sh 回退成功 */
    setenv("PATH", "${path.join(fdir, "p1")}:${path.join(fdir, "p2")}", 1);
    mock_spawn_mode = 1;
    spawn_calls = 0;
    {
        int pid = 0;
        char *av[] = { "plain-cmd", "arg1", NULL };
        char *ev[] = { NULL };
        int rc = shim_posix_spawnp(&pid, "plain-cmd", NULL, NULL, av, ev);
        assert(rc == 0);
        assert(spawn_calls == 4); /* p1/plain-cmd(ENOEXEC) -> sh(p1)(ENOENT) -> p2/plain-cmd(EACCES) -> sh(p2)(0) */
        assert(strcmp(last_spawn_path, "${sysSh}") == 0);
        assert(strcmp(last_spawn_arg0, "sh") == 0);
        assert(strcmp(last_spawn_arg1, "${plainScript}") == 0);
    }
    mock_spawn_mode = 0;
    {
        int pid = fork();
        assert(pid >= 0);
        if (pid == 0) {
            char *const envp[] = { "MY_EXECLE_ENV=HIT_OK", NULL };
            /* arg0 == NULL：不得越界多读 va_arg，execle 仍能正确拿到 envp */
            shim_execle("${sysSh}", (const char *)NULL, envp);
            _exit(127);
        }
        int st = 0;
        assert(waitpid(pid, &st, 0) == pid);
        /* sh 以 argc=1, argv[0]=NULL 启动会立即正常退出 */
        assert(WIFEXITED(st));
    }

    /* 3. execl(..., NULL) 搭配真实可执行检查 */
    {
        int pfd[2];
        assert(pipe(pfd) == 0);
        int pid = fork();
        assert(pid >= 0);
        if (pid == 0) {
            close(pfd[0]);
            dup2(pfd[1], 1);
            close(pfd[1]);
            shim_execl("${crlfScript}", "crlf-test", (const char *)NULL);
            _exit(127);
        }
        close(pfd[1]);
        char buf[128] = {0};
        ssize_t n = read(pfd[0], buf, sizeof buf - 1);
        close(pfd[0]);
        int st = 0;
        assert(waitpid(pid, &st, 0) == pid);
        assert(WIFEXITED(st) && WEXITSTATUS(st) == 0);
        assert(n > 0 && strstr(buf, "CRLF_OK") != NULL);
    }

    /* 4. execvpe：p1/plain-cmd（假 ELF 缺 PT_INTERP 失败）跳过后，p2/plain-cmd（无 #! 纯脚本）走 /system/bin/sh 成功执行 */
    {
        int pfd[2];
        assert(pipe(pfd) == 0);
        int pid = fork();
        assert(pid >= 0);
        if (pid == 0) {
            close(pfd[0]);
            dup2(pfd[1], 1);
            close(pfd[1]);
            unsetenv("CCAPP_BIONIC_PRELOAD");
            setenv("CCAPP_LD", "/fake/libldlinux.so", 1);
            setenv("PATH", "${path.join(fdir, "p1")}:${path.join(fdir, "p2")}:${prefixBin}:/system/bin", 1);
            char *av[] = { "plain-cmd", "arg-one", NULL };
            shim_execvpe("plain-cmd", av, environ);
            _exit(127);
        }
        close(pfd[1]);
        char buf[256] = {0};
        ssize_t n = read(pfd[0], buf, sizeof buf - 1);
        close(pfd[0]);
        int st = 0;
        assert(waitpid(pid, &st, 0) == pid);
        assert(WIFEXITED(st) && WEXITSTATUS(st) == 0);
        assert(n > 0 && strstr(buf, "PLAIN_SCRIPT:") != NULL && strstr(buf, "arg-one") != NULL);
    }
}

int main(void) {
    test_mkplan_and_kind();
    test_posix_spawn_and_execl_null();
    printf("SHIM_HARNESS_OK\\n");
    return 0;
}
`;
  fs.writeFileSync(harnessC, cCode);
  const compH = spawnSync("clang", ["-O2", "-Wall", "-Wextra", "-o", harnessBin, harnessC], { encoding: "utf8" });
  assert.equal(compH.status, 0, `编译 C harness 失败:\n${compH.stderr}`);

  const runH = spawnSync(harnessBin, [], { encoding: "utf8", timeout: 10000 });
  assert.equal(runH.status, 0, `运行 C harness 失败 (rc=${runH.status}):\nstdout=${runH.stdout}\nstderr=${runH.stderr}`);
  assert.match(runH.stdout, /SHIM_HARNESS_OK/);

  // ── -DBIONIC 行为 harness：实测 K_BIONIC 交回 next_execve、K_GLIBC/K_LDSO/sysdir 改写、__errno() 传播 ──
  const glibcElf = path.join(fdir, "glibc-tool");
  const glibcBuf = Buffer.alloc(64 + 56 + 64);
  glibcBuf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  glibcBuf.writeBigUInt64LE(64n, 32);
  glibcBuf.writeUInt16LE(56, 54);
  glibcBuf.writeUInt16LE(1, 56);
  glibcBuf.writeUInt32LE(3, 64);
  glibcBuf.writeBigUInt64LE(120n, 64 + 8);
  const glibcInterp = "/data/data/ha.chi.mia/files/usr/glibc/lib/ld-linux-aarch64.so.1\0";
  glibcBuf.writeBigUInt64LE(BigInt(glibcInterp.length), 64 + 32);
  glibcBuf.write(glibcInterp, 120);
  fs.writeFileSync(glibcElf, glibcBuf, { mode: 0o755 });

  const ldsoElf = path.join(fdir, "ld-linux-aarch64.so.1");
  const ldsoBuf = Buffer.alloc(64);
  ldsoBuf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  fs.writeFileSync(ldsoElf, ldsoBuf, { mode: 0o755 });

  const bionicHarnessC = path.join(TMP, "shim_bionic_harness.c");
  const bionicHarnessBin = path.join(TMP, "shim_bionic_harness");
  fs.writeFileSync(bionicHarnessC, `
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;
#ifndef __BIONIC__
int *__errno(void) { return &errno; }
#endif

static int next_calls = 0;
static char last_next_path[512];
static int mock_next_execve(const char *path, char *const argv[], char *const envp[]) {
    (void)argv; (void)envp;
    next_calls++;
    snprintf(last_next_path, sizeof last_next_path, "%s", path ? path : "");
    errno = ETXTBSY;
    return -1;
}
static void *bionic_dlsym(void *h, const char *sym) {
    (void)h;
    if (strcmp(sym, "execve") == 0) return (void *)mock_next_execve;
    return NULL;
}

#define dlsym bionic_dlsym
#define execve bshim_execve
#define execv bshim_execv
#define execvpe bshim_execvpe
#define execvp bshim_execvp
#define execl bshim_execl
#define execlp bshim_execlp
#define execle bshim_execle
#define fexecve bshim_fexecve
#define execveat bshim_execveat
#define readlink bshim_readlink
#define readlinkat bshim_readlinkat
#include "${shimSrc.replace(/\\/g, "\\\\")}"
#undef dlsym
#undef execve
#undef execv
#undef execvpe
#undef execvp
#undef execl
#undef execlp
#undef execle
#undef fexecve
#undef execveat
#undef readlink
#undef readlinkat

int main(void) {
    setenv("CCAPP_LD", "/fake/libldlinux.so", 1);
    setenv("CCAPP_GLIBC_LIB", "/fake/glibc/lib", 1);
    setenv("CCAPP_GLIBC_PRELOAD", "/fake/enosys.so", 1);
    setenv("CCAPP_BIONIC_PRELOAD", "/fake/bionic-pre.so", 1);

    /* 1. -DBIONIC: K_BIONIC 必须返回 0 并经 bshim_execve 移交 next_execve (termux-exec) */
    {
        char *av_in[] = { "bash", "-c", "echo hi", NULL };
        char *env_in[] = { "HOME=/tmp", NULL };
        PLAN_SPACE(av_in, env_in);
        int mr = mkplan("${bionicElf}", av_in, env_in, av_, ev_, &ar_, &pl_);
        assert(mr == 0);
        next_calls = 0;
        errno = 0;
        assert(bshim_execve("${bionicElf}", av_in, env_in) == -1);
        assert(next_calls == 1);
        assert(strcmp(last_next_path, "${bionicElf}") == 0);
        assert(errno == ETXTBSY);
    }

    /* 2. -DBIONIC: K_GLIBC 必须改走 CCAPP_LD 并设置 CCAPP_SELF_EXE、剥离 bionic LD_PRELOAD */
    {
        char *av_in[] = { "glibc-tool", "--v", NULL };
        char *env_in[] = { "LD_PRELOAD=/old/bionic.so", "HOME=/tmp", NULL };
        PLAN_SPACE(av_in, env_in);
        int mr = mkplan("${glibcElf}", av_in, env_in, av_, ev_, &ar_, &pl_);
        assert(mr == 1);
        assert(strcmp(pl_.path, "/fake/libldlinux.so") == 0);
        int saw_self = 0, saw_preload = 0;
        for (int i = 0; pl_.envp[i]; i++) {
            if (strcmp(pl_.envp[i], "CCAPP_SELF_EXE=${glibcElf}") == 0) saw_self = 1;
            if (strncmp(pl_.envp[i], "LD_PRELOAD=", 11) == 0) saw_preload = 1;
        }
        assert(saw_self && !saw_preload);
    }

    /* 3. -DBIONIC: 直接 exec ld-linux-aarch64.so.1 必须替换成 CCAPP_LD */
    {
        char *av_in[] = { "ld-linux-aarch64.so.1", "/app/bin", NULL };
        char *env_in[] = { "LD_PRELOAD=/old/bionic.so", NULL };
        PLAN_SPACE(av_in, env_in);
        int mr = mkplan("${ldsoElf}", av_in, env_in, av_, ev_, &ar_, &pl_);
        assert(mr == 1);
        assert(strcmp(pl_.path, "/fake/libldlinux.so") == 0);
    }

    /* 4. -DBIONIC: 系统目录程序必须保留 CCAPP_BIONIC_PRELOAD */
    {
        char *av_in[] = { "/system/bin/pm", "list", NULL };
        char *env_in[] = { "HOME=/tmp", NULL };
        PLAN_SPACE(av_in, env_in);
        int mr = mkplan("/system/bin/pm", av_in, env_in, av_, ev_, &ar_, &pl_);
        assert(mr == 1);
        assert(strcmp(pl_.path, "/system/bin/pm") == 0);
        int saw_pre = 0;
        for (int i = 0; pl_.envp[i]; i++) {
            if (strcmp(pl_.envp[i], "LD_PRELOAD=/fake/bionic-pre.so") == 0) saw_pre = 1;
        }
        assert(saw_pre);
    }

    /* 5. -DBIONIC: 环状 #! 脚本通过 __errno() 返回 ELOOP */
    {
        char *av_in[] = { "loopA", NULL };
        char *env_in[] = { NULL };
        errno = 0;
        assert(bshim_execve("${loopA}", av_in, env_in) == -1);
        assert(errno == ELOOP);
    }

    printf("SHIM_BIONIC_HARNESS_OK\\n");
    return 0;
}
`);
  const compB = spawnSync("clang", ["-DBIONIC", "-O2", "-Wall", "-Wextra", "-o", bionicHarnessBin, bionicHarnessC], { encoding: "utf8" });
  assert.equal(compB.status, 0, `编译 -DBIONIC harness 失败:\n${compB.stderr}`);

  const runB = spawnSync(bionicHarnessBin, [], { encoding: "utf8", timeout: 10000 });
  assert.equal(runB.status, 0, `运行 -DBIONIC harness 失败 (rc=${runB.status}):\nstdout=${runB.stdout}\nstderr=${runB.stderr}`);
  assert.match(runB.stdout, /SHIM_BIONIC_HARNESS_OK/);
});
