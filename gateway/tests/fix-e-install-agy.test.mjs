// E-04 / E-11 / A5 / A10 / A11：install-agy.mjs 安装与校验（PR #1 复核后：manifest 直装）。
// 用本地 HTTPS 服务冒充官方 manifest 与 tarball、假 agy 二进制（--version 行为由环境变量控制），
// 全程只动临时 HOME 下的 .local/share/hachimia/agy，不碰真机、不联网。
// PR #1 复核：不再下载、执行远端 install.sh（可变脚本，钉哈希会砖掉旧版安装），安装器直接按
// manifest（tarball url + sha512）下载安装包、自己验 sha512（对不上退出码 4）、只解出单个成员
// antigravity。agy-install-pins.json 已删，HACHIMIA_AGY_PINS / HACHIMIA_AGY_INSTALL_URL 覆盖
// 已不存在；本地冒充服务里 /install.sh 只剩一个陷阱：安装器敢取它，测试就失败。
// 运行：node scripts/test.mjs fix-e-install-agy
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PREFIX } from "../gw/config.mjs";

const HOME = process.env.HOME || "";
const DEST = path.join(HOME, ".local", "share", "hachimia", "agy");
const SCRIPT = new URL("../../android/assets/scripts/install-agy.mjs", import.meta.url).pathname;

// install-agy.mjs 的 curl 只认 https（--proto =https），本地冒充服务必须走 https：
// 现签一个只信 127.0.0.1 的 CA + 服务端证书，curl 经 CURL_CA_BUNDLE 认它（本机 curl 不认 SSL_CERT_FILE）。
const TLSDIR = fs.mkdtempSync(path.join(os.tmpdir(), "fix-e-agy-tls-"));
const OPENSSL = spawnSync("sh", ["-c", "command -v openssl"], { encoding: "utf8" }).stdout.trim();
const TAR_BIN = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
const SKIP = !OPENSSL ? "环境里没有 openssl，造不出本地 https 服务"
  : !TAR_BIN ? "环境里没有 tar，造不出假安装包" : false;
if (!SKIP) {
  const run = (args) => spawnSync(OPENSSL, args, { cwd: TLSDIR, encoding: "utf8" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-nodes", "-subj", "/CN=fix-e-test-ca"]);
  run(["req", "-newkey", "rsa:2048", "-keyout", "srv.key", "-out", "srv.csr", "-nodes", "-subj", "/CN=127.0.0.1"]);
  fs.writeFileSync(path.join(TLSDIR, "ext.cnf"), "subjectAltName=IP:127.0.0.1\n");
  run(["x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.crt", "-days", "2", "-extfile", "ext.cnf"]);
}
const CA_CRT = path.join(TLSDIR, "ca.crt");

// 假 agy 二进制（--version 行为由环境变量控制）：它是 tarball 里唯一的成员 antigravity
const FAKE_AGY = `#!/bin/sh
if [ "$1" = "--version" ]; then
  case "$FAKE_AGY_MODE" in
    good) echo "agy version 1.5.13"; exit 0;;
    fail) echo "fake agy broken" >&2; exit 1;;
    garbage) echo "nothing to see here"; exit 0;;
    *) echo "agy version 1.5.13"; exit 0;;
  esac
fi
exit 0
`;
const sha512buf = (b) => crypto.createHash("sha512").update(b).digest("hex");
let TARBALL = Buffer.alloc(0), TARBALL_SHA512 = "", NO_MEMBER_TARBALL = Buffer.alloc(0);
if (!SKIP) {
  const pkg = path.join(TLSDIR, "pkg");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "antigravity"), FAKE_AGY, { mode: 0o755 });
  const t1 = spawnSync(TAR_BIN, ["-czf", path.join(TLSDIR, "agy.tar.gz"), "-C", pkg, "antigravity"], { encoding: "utf8" });
  assert.equal(t1.status, 0, "造假安装包失败：" + t1.stderr);
  TARBALL = fs.readFileSync(path.join(TLSDIR, "agy.tar.gz"));
  TARBALL_SHA512 = sha512buf(TARBALL);
  const pkg2 = path.join(TLSDIR, "pkg2");
  fs.mkdirSync(pkg2, { recursive: true });
  fs.writeFileSync(path.join(pkg2, "other"), "not the binary\n");
  const t2 = spawnSync(TAR_BIN, ["-czf", path.join(TLSDIR, "no-member.tar.gz"), "-C", pkg2, "other"], { encoding: "utf8" });
  assert.equal(t2.status, 0, "造无成员安装包失败：" + t2.stderr);
  NO_MEMBER_TARBALL = fs.readFileSync(path.join(TLSDIR, "no-member.tar.gz"));
}
const GARBAGE = Buffer.from("this is not a tarball at all\n");
const FAKE_SHA512 = "cd".repeat(64);

// 本机平台（与安装器的 detectPlatform 独立算一遍：uname，不读安装器的代码）
const expectedPlatform = (() => {
  const u = (a) => { try { return spawnSync("uname", [a], { encoding: "utf8" }).stdout?.trim() || ""; } catch { return ""; } };
  const sys = u("-s");
  const osName = sys === "Darwin" ? "darwin" : sys === "Linux" ? (u("-o") === "Android" ? "android" : "linux") : "linux";
  const m = u("-m");
  const arch = m === "x86_64" || m === "amd64" ? "amd64" : "arm64";
  if (osName !== "linux") return `${osName}_${arch}`;
  const musl = fs.existsSync("/lib/libc.musl-x86_64.so.1") || fs.existsSync("/lib/libc.musl-aarch64.so.1")
    || /musl/i.test(spawnSync("ldd", ["/bin/ls"], { encoding: "utf8" }).stdout || "");
  return musl ? `linux_${arch}_musl` : `linux_${arch}`;
})();

const S = { manifest: "", tarball: TARBALL, manifestRequested: "", installShHits: 0, payloadHits: 0 };
const server = https.createServer({
  key: fs.readFileSync(path.join(TLSDIR, "srv.key")),
  cert: fs.readFileSync(path.join(TLSDIR, "srv.crt")),
}, (req, res) => {
  // 陷阱：PR #1 复核后安装器绝不能再取 install.sh，取了就记下来、测试判失败
  if (req.url === "/install.sh") { S.installShHits++; res.writeHead(404); return res.end(); }
  if (req.url === "/payload/agy.tar.gz") { S.payloadHits++; res.writeHead(200, { "content-type": "application/gzip" }); return res.end(S.tarball); }
  if (req.url === "/payload/no-member.tar.gz") { S.payloadHits++; res.writeHead(200, { "content-type": "application/gzip" }); return res.end(NO_MEMBER_TARBALL); }
  if (req.url.startsWith("/manifests/") && req.url.endsWith(".json")) {
    S.manifestRequested = req.url;
    res.writeHead(200, { "content-type": "application/json" }); return res.end(S.manifest);
  }
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const B = `https://127.0.0.1:${server.address().port}`;
const defaultManifest = () => JSON.stringify({ version: "1.5.99", url: B + "/payload/agy.tar.gz", sha512: TARBALL_SHA512 });
S.manifest = defaultManifest();
after(() => { server.close(); fs.rmSync(DEST, { recursive: true, force: true }); fs.rmSync(TLSDIR, { recursive: true, force: true }); });

const resetAll = () => {
  fs.rmSync(DEST, { recursive: true, force: true });
  S.manifest = defaultManifest();
  S.tarball = TARBALL;
  S.manifestRequested = "";
  S.installShHits = 0;
  S.payloadHits = 0;
};
// 注意：必须用异步 spawn——同步 spawnSync 会堵住本进程的事件循环，同进程的 https 冒充服务就没法完成握手
const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
  const env = { ...process.env, HOME, PREFIX, CURL_CA_BUNDLE: CA_CRT,
    HACHIMIA_AGY_MANIFEST_BASE: B + "/manifests", ...extraEnv };
  // extraEnv 里传 undefined 表示把这个变量从子进程环境里删掉
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(process.execPath, [SCRIPT, ...args], { env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", reject);
  const to = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("install-agy.mjs 超时")); }, 30000);
  child.on("close", (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
});
const stageLeftovers = () => fs.existsSync(DEST) ? fs.readdirSync(DEST).filter((d) => d.startsWith(".stage-")) : [];
const goodInstall = async () => {
  resetAll();
  const r = await run(["stable"], { FAKE_AGY_MODE: "good" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ Antigravity CLI 1\.5\.13 安装完成/);
  return r;
};

test("E-04：安装包根本不是 tarball 时（sha512 对得上也解不开），安装失败且不留 .stage-* 暂存目录", { skip: SKIP }, async () => {
  resetAll();
  S.tarball = GARBAGE;
  S.manifest = JSON.stringify({ version: "1.5.99", url: B + "/payload/agy.tar.gz", sha512: sha512buf(GARBAGE) });
  const r = await run(["stable"], { FAKE_AGY_MODE: "good" });
  assert.notEqual(r.status, 0, "应返回非零退出码");
  assert.match(r.stderr, /解压安装包失败/, "要说明是解压失败");
  assert.deepEqual(stageLeftovers(), [], "失败后暂存目录应被清理");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "失败时不应切换 current");
});

test("E-04：安装包里没有 antigravity 成员时，安装失败且不留 .stage-* 暂存目录", { skip: SKIP }, async () => {
  resetAll();
  S.manifest = JSON.stringify({ version: "1.5.99", url: B + "/payload/no-member.tar.gz", sha512: sha512buf(NO_MEMBER_TARBALL) });
  const r = await run(["stable"], { FAKE_AGY_MODE: "good" });
  assert.notEqual(r.status, 0, "应返回非零退出码");
  assert.match(r.stderr, /解压安装包失败/, "包里没有要解的成员时 tar 退出非零，要说明是解压失败");
  assert.deepEqual(stageLeftovers(), [], "失败后暂存目录应被清理");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "失败时不应切换 current");
});

test("A5/E-11：装好的 agy 跑不起来（--version 退出码非零）时，不报“安装完成”、不钉 0.0.0-local", { skip: SKIP }, async () => {
  resetAll();
  const r = await run(["stable"], { FAKE_AGY_MODE: "fail" });
  assert.notEqual(r.status, 0, "应返回非零退出码");
  assert.doesNotMatch(r.stdout, /安装完成/, "跑不起来的二进制不能报安装完成");
  assert.equal(fs.existsSync(path.join(DEST, "0.0.0-local")), false, "不应建 0.0.0-local 版本目录");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "不应切换 current");
});

test("E-11：--version 输出解析不出版本号时，同样不报成功、不钉 0.0.0-local", { skip: SKIP }, async () => {
  resetAll();
  const r = await run(["stable"], { FAKE_AGY_MODE: "garbage" });
  assert.notEqual(r.status, 0, "应返回非零退出码");
  assert.doesNotMatch(r.stdout, /安装完成/);
  assert.equal(fs.existsSync(path.join(DEST, "0.0.0-local")), false, "不应回退到 0.0.0-local");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "不应切换 current");
});

test("A5 对照：--version 正常的二进制，安装成功、current 指到该版本、最终文件也通过校验", { skip: SKIP }, async () => {
  await goodInstall();
  assert.equal(fs.realpathSync(path.join(DEST, "current")), path.join(DEST, "1.5.13"));
  const m = JSON.parse(fs.readFileSync(path.join(DEST, "1.5.13", "manifest.json"), "utf8"));
  assert.equal(m.version, "1.5.13");
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  const vr = spawnSync(path.join(DEST, "1.5.13", "agy"), ["--version"], { encoding: "utf8", env: { ...process.env, FAKE_AGY_MODE: "good" } });
  assert.equal(vr.status, 0);
  assert.match(vr.stdout, /1\.5\.13/);
});

test("A11：--check 在上游 manifest 没有版本号时，不拿已装版本冒充 latest", { skip: SKIP }, async () => {
  await goodInstall();
  S.manifest = JSON.stringify({});
  const r = await run(["--check"], { FAKE_AGY_MODE: "good" });
  const j = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf("{")));
  assert.equal(j.installed, "1.5.13");
  assert.equal(j.latest, "", "manifest 里没有版本号时 latest 应为空，不能填已装版本");
  assert.notEqual(r.status, 0, "查不到可用版本号时 --check 应返回非零，让调用方报检查失败而不是“已是最新”");
});

test("A11 对照：manifest 有版本号时 --check 正常返回 latest", { skip: SKIP }, async () => {
  await goodInstall();
  S.manifest = JSON.stringify({ version: "1.5.99" });
  const r = await run(["--check"], { FAKE_AGY_MODE: "good" });
  const j = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf("{")));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(j.ok, true);
  assert.equal(j.installed, "1.5.13");
  assert.equal(j.latest, "1.5.99");
});

test("P0-6/7 PR1fix：安装包 sha512 与 manifest 不符时，拒绝安装、退出码 4、不装任何东西", { skip: SKIP }, async () => {
  resetAll();
  S.manifest = JSON.stringify({ version: "1.5.99", url: B + "/payload/agy.tar.gz", sha512: FAKE_SHA512 });
  const r = await run(["stable"], { FAKE_AGY_MODE: "good" });
  assert.equal(r.status, 4, "校验值不符应用 distinct 的退出码 4 拒绝安装：\n" + r.stdout + r.stderr);
  assert.match(r.stderr, /安装包 sha512 与官方清单不符/, " mismatch 要有一句用户看得懂的话");
  assert.match(r.stderr, /期望 cdcdcdcdcdcd…，实得 [0-9a-f]{12}…/, "期望/实得哈希前缀要写出来");
  assert.doesNotMatch(r.stdout, /安装完成/, "拒绝安装就不能报安装完成");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "不应切换 current");
  assert.equal(fs.existsSync(path.join(DEST, "1.5.13")), false, "包根本不该解开");
  assert.deepEqual(stageLeftovers(), [], "拒绝安装后暂存目录应被清理");
});

test("P0-6/7 PR1fix：安装全程不取远端 install.sh，且仓库里不再有 pins 文件与 install.sh 下载路径", { skip: SKIP }, async () => {
  await goodInstall();
  assert.equal(S.installShHits, 0, "安装器一次也不该取 /install.sh");
  const pinsPath = new URL("../../android/assets/scripts/agy-install-pins.json", import.meta.url);
  assert.equal(fs.existsSync(pinsPath), false, "agy-install-pins.json 应该已经删掉");
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /antigravity\.google\/cli\/install\.sh/, "脚本里不应再有 install.sh 的下载地址");
  assert.doesNotMatch(src, /agy-install-pins\.json/, "脚本里不应再读 pins 文件");
  assert.doesNotMatch(src, /HACHIMIA_AGY_PINS/, "pins 覆盖环境变量应该已经删掉");
  assert.doesNotMatch(src, /HACHIMIA_AGY_INSTALL_URL/, "install.sh 地址覆盖环境变量应该已经删掉");
  assert.doesNotMatch(src, /[0-9a-f]{64}/, "脚本里不应有写死的 64 位哈希");
  assert.match(src, /manifestSha512Verified/, "本地清单应记下安装包 sha512 已由安装器自己核对过");
});

test("P0-6/7 PR1fix：本地清单同时记已装二进制 sha256 与已核对的 manifest sha512 / 地址 / 版本（来源，不混为一谈）", { skip: SKIP }, async () => {
  await goodInstall();
  assert.equal(S.manifestRequested, "/manifests/" + expectedPlatform + ".json",
    "安装器应按本机平台问 manifest（与 install.sh 同款检测）");
  assert.equal(S.installShHits, 0, "安装器一次也不该取 /install.sh");
  const m = JSON.parse(fs.readFileSync(path.join(DEST, "1.5.13", "manifest.json"), "utf8"));
  assert.equal(m.version, "1.5.13", "version 是装好的二进制自己报的");
  assert.match(m.sha256, /^[0-9a-f]{64}$/, "sha256 是已装二进制的");
  assert.equal(m.manifestSha512, TARBALL_SHA512, "manifestSha512 是上游 manifest 里写的安装包 sha512");
  assert.equal(m.manifestSha512Verified, true, "安装包 sha512 是安装器自己现算核对过的，不再是只记来源");
  assert.equal(m.manifestUrl, B + "/manifests/" + expectedPlatform + ".json");
  assert.equal(m.manifestVersion, "1.5.99", "manifestVersion 是清单里写的版本，和装好的可能不一样");
  assert.equal(m.source, B + "/payload/agy.tar.gz", "source 是实际下载的安装包地址");
  assert.equal("installShSha256" in m, false, "本地清单里不应再有 install.sh 的哈希");
  assert.notEqual(m.sha256, m.manifestSha512, "两套哈希不能混为一谈");
});

test("P0-6/7：manifest 里没有可用的 sha512 时，安装在下载安装包之前就失败", { skip: SKIP }, async () => {
  resetAll();
  S.manifest = JSON.stringify({ version: "1.5.99", url: B + "/payload/agy.tar.gz" });
  const r = await run(["stable"], { FAKE_AGY_MODE: "good" });
  assert.notEqual(r.status, 0, "清单没有 sha512 就不该继续装：\n" + r.stdout + r.stderr);
  assert.match(r.stderr, /没有可用的下载地址 \/ sha512/, "要说明是清单缺 sha512");
  assert.equal(S.payloadHits, 0, "清单缺 sha512 时根本不该下载安装包");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "不应切换 current");
});

test("P0-6/7：取不到官方 manifest 时，安装失败且不下载安装包", { skip: SKIP }, async () => {
  resetAll();
  const r = await run(["stable"], { FAKE_AGY_MODE: "good", HACHIMIA_AGY_MANIFEST_BASE: B + "/nope" });
  assert.notEqual(r.status, 0, "问不到清单就不能装：\n" + r.stdout + r.stderr);
  assert.match(r.stderr, /取不到官方 agy 版本清单/, "要说明是清单问不到");
  assert.equal(S.payloadHits, 0, "问不到清单时根本不该下载安装包");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "不应切换 current");
});

test("P0-6/7：--recheck 发现已装二进制被改过时，退出码 3、消息里有期望/实得哈希前缀、写 .mismatch", { skip: SKIP }, async () => {
  await goodInstall();
  const bin = path.join(DEST, "1.5.13", "agy");
  const before = JSON.parse(fs.readFileSync(path.join(DEST, "1.5.13", "manifest.json"), "utf8"));
  fs.appendFileSync(bin, "\n# tampered\n");
  const r = await run(["--recheck"]);
  assert.equal(r.status, 3, "sha256 不符应用 distinct 的退出码 3：\n" + r.stdout + r.stderr);
  assert.match(r.stdout, /已装二进制 sha256 与本地清单不符/, "要说清是已装二进制和本地清单在比");
  assert.match(r.stdout, new RegExp(`期望 ${before.sha256.slice(0, 12)}…，实得 [0-9a-f]{12}…`), "期望/实得哈希前缀要写出来");
  assert.ok(fs.existsSync(path.join(DEST, "1.5.13", ".mismatch")), "要写 .mismatch 标记，Updater / seal 才拦得住");
});

test("P0-6/7 对照：没被改过的安装，--recheck 退出 0、不写 .mismatch", { skip: SKIP }, async () => {
  await goodInstall();
  const r = await run(["--recheck"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1\.5\.13：sha256 一致/);
  assert.equal(fs.existsSync(path.join(DEST, "1.5.13", ".mismatch")), false);
});

test("A10：--recheck 时版本目录缺 manifest 或缺二进制，要计入损坏而不是直接跳过", { skip: SKIP }, async () => {
  resetAll();
  fs.mkdirSync(path.join(DEST, "1.5.13"), { recursive: true });
  fs.writeFileSync(path.join(DEST, "1.5.13", "agy"), "#!/bin/sh\n");
  const r1 = await run(["--recheck"]);
  assert.notEqual(r1.status, 0, "缺 manifest 的版本目录应判坏（退出码非零）");
  assert.match(r1.stdout, /1\.5\.13/);

  resetAll();
  fs.mkdirSync(path.join(DEST, "1.5.13"), { recursive: true });
  fs.writeFileSync(path.join(DEST, "1.5.13", "manifest.json"), JSON.stringify({ sha256: "0".repeat(64) }));
  const r2 = await run(["--recheck"]);
  assert.notEqual(r2.status, 0, "缺二进制的版本目录应判坏（退出码非零）");
  assert.match(r2.stdout, /1\.5\.13/);
});
