// E-04 / E-11 / A5 / A10 / A11：install-agy.mjs 安装与校验。
// 用本地 HTTP 服务冒充官方 install.sh 与 manifest、假 agy 二进制（--version 行为由环境变量控制），
// 全程只动临时 HOME 下的 .local/share/hachimia/agy，不碰真机、不联网。
// P0-6/7：install-agy.mjs 执行下载的 install.sh 之前先对 agy-install-pins.json 里钉住的 sha256；
// 假脚本的哈希当然和仓库里那份不一样，所以 run() 默认给一个按假脚本现算的 pins 文件（HACHIMIA_AGY_PINS），
// 钉住校验的测试再另外传错的 / 缺失的 pins 文件。
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

// install-agy.mjs 的 curlSmall 只认 https（--proto =https），本地冒充服务必须走 https：
// 现签一个只信 127.0.0.1 的 CA + 服务端证书，curl 经 CURL_CA_BUNDLE 认它（本机 curl 不认 SSL_CERT_FILE）。
const TLSDIR = fs.mkdtempSync(path.join(os.tmpdir(), "fix-e-agy-tls-"));
const OPENSSL = spawnSync("sh", ["-c", "command -v openssl"], { encoding: "utf8" }).stdout.trim();
const SKIP_TLS = !OPENSSL ? "环境里没有 openssl，造不出本地 https 服务" : false;
if (!SKIP_TLS) {
  const run = (args) => spawnSync(OPENSSL, args, { cwd: TLSDIR, encoding: "utf8" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-nodes", "-subj", "/CN=fix-e-test-ca"]);
  run(["req", "-newkey", "rsa:2048", "-keyout", "srv.key", "-out", "srv.csr", "-nodes", "-subj", "/CN=127.0.0.1"]);
  fs.writeFileSync(path.join(TLSDIR, "ext.cnf"), "subjectAltName=IP:127.0.0.1\n");
  run(["x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.crt", "-days", "2", "-extfile", "ext.cnf"]);
}
const CA_CRT = path.join(TLSDIR, "ca.crt");

// 假官方 install.sh：按环境变量决定行为；装入的假 agy 在 --version 时同样按环境变量行事
const INSTALL_SH = `#!/bin/sh
if [ "$FAKE_INSTALL_FAIL" = "1" ]; then echo "fake installer boom" >&2; exit 1; fi
dir=""
while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift 2;; *) shift;; esac; done
mkdir -p "$dir"
if [ "$FAKE_INSTALL_NOAGY" = "1" ]; then exit 0; fi
cat > "$dir/agy" <<'AGYEOF'
#!/bin/sh
if [ "$1" = "--version" ]; then
  case "$FAKE_AGY_MODE" in
    good) echo "agy version 1.5.13"; exit 0;;
    fail) echo "fake agy broken" >&2; exit 1;;
    garbage) echo "nothing to see here"; exit 0;;
    *) echo "agy version 1.5.13"; exit 0;;
  esac
fi
exit 0
AGYEOF
chmod +x "$dir/agy"
`;

const S = { manifest: JSON.stringify({ version: "1.5.99", url: "https://example.invalid/agy-1.5.99.tar.gz", sha512: "ab".repeat(64) }) };
const FAKE_SHA512 = "cd".repeat(64);
const PINS_GOOD = path.join(TLSDIR, "pins-good.json");
fs.writeFileSync(PINS_GOOD, JSON.stringify({ installSh: { sha256: crypto.createHash("sha256").update(INSTALL_SH).digest("hex"),
  source: "https://antigravity.google/cli/install.sh", updated: "2026-11-21" } }));
const PINS_WRONG = path.join(TLSDIR, "pins-wrong.json");
fs.writeFileSync(PINS_WRONG, JSON.stringify({ installSh: { sha256: "0".repeat(64),
  source: "https://antigravity.google/cli/install.sh", updated: "2026-11-21" } }));
const server = https.createServer({
  key: fs.readFileSync(path.join(TLSDIR, "srv.key")),
  cert: fs.readFileSync(path.join(TLSDIR, "srv.crt")),
}, (req, res) => {
  if (req.url === "/install.sh") { res.writeHead(200); return res.end(INSTALL_SH); }
  if (req.url === "/manifests/android_amd64.json" || req.url === "/manifests/android_arm64.json") {
    res.writeHead(200, { "content-type": "application/json" }); return res.end(S.manifest);
  }
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const B = `https://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(DEST, { recursive: true, force: true }); fs.rmSync(TLSDIR, { recursive: true, force: true }); });

const resetDest = () => fs.rmSync(DEST, { recursive: true, force: true });
// 注意：必须用异步 spawn——同步 spawnSync 会堵住本进程的事件循环，同进程的 https 冒充服务就没法完成握手
const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, HOME, PREFIX, CURL_CA_BUNDLE: CA_CRT, HACHIMIA_AGY_INSTALL_URL: B + "/install.sh",
      HACHIMIA_AGY_MANIFEST_BASE: B + "/manifests", HACHIMIA_AGY_PINS: PINS_GOOD, ...extraEnv },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", reject);
  const to = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("install-agy.mjs 超时")); }, 30000);
  child.on("close", (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
});
const stageLeftovers = () => fs.existsSync(DEST) ? fs.readdirSync(DEST).filter((d) => d.startsWith(".stage-")) : [];
const goodInstall = async () => {
  resetDest();
  const r = await run(["stable"], { FAKE_AGY_MODE: "good" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ Antigravity CLI 1\.5\.13 安装完成/);
  return r;
};

test("E-04：官方安装脚本退出码非零时，安装失败且不留 .stage-* 暂存目录", { skip: SKIP_TLS }, async () => {
  resetDest();
  const r = await run(["stable"], { FAKE_INSTALL_FAIL: "1" });
  assert.notEqual(r.status, 0, "应返回非零退出码");
  assert.deepEqual(stageLeftovers(), [], "失败后暂存目录应被清理");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "失败时不应切换 current");
});

test("E-04：装完找不到 agy 二进制时，安装失败且不留 .stage-* 暂存目录", { skip: SKIP_TLS }, async () => {
  resetDest();
  const r = await run(["stable"], { FAKE_INSTALL_NOAGY: "1" });
  assert.notEqual(r.status, 0, "应返回非零退出码");
  assert.deepEqual(stageLeftovers(), [], "失败后暂存目录应被清理");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "失败时不应切换 current");
});

test("A5/E-11：装好的 agy 跑不起来（--version 退出码非零）时，不报“安装完成”、不钉 0.0.0-local", { skip: SKIP_TLS }, async () => {
  resetDest();
  const r = await run(["stable"], { FAKE_AGY_MODE: "fail" });
  assert.notEqual(r.status, 0, "应返回非零退出码");
  assert.doesNotMatch(r.stdout, /安装完成/, "跑不起来的二进制不能报安装完成");
  assert.equal(fs.existsSync(path.join(DEST, "0.0.0-local")), false, "不应建 0.0.0-local 版本目录");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "不应切换 current");
});

test("E-11：--version 输出解析不出版本号时，同样不报成功、不钉 0.0.0-local", { skip: SKIP_TLS }, async () => {
  resetDest();
  const r = await run(["stable"], { FAKE_AGY_MODE: "garbage" });
  assert.notEqual(r.status, 0, "应返回非零退出码");
  assert.doesNotMatch(r.stdout, /安装完成/);
  assert.equal(fs.existsSync(path.join(DEST, "0.0.0-local")), false, "不应回退到 0.0.0-local");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "不应切换 current");
});

test("A5 对照：--version 正常的二进制，安装成功、current 指到该版本、最终文件也通过校验", { skip: SKIP_TLS }, async () => {
  await goodInstall();
  assert.equal(fs.realpathSync(path.join(DEST, "current")), path.join(DEST, "1.5.13"));
  const m = JSON.parse(fs.readFileSync(path.join(DEST, "1.5.13", "manifest.json"), "utf8"));
  assert.equal(m.version, "1.5.13");
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  const vr = spawnSync(path.join(DEST, "1.5.13", "agy"), ["--version"], { encoding: "utf8", env: { ...process.env, FAKE_AGY_MODE: "good" } });
  assert.equal(vr.status, 0);
  assert.match(vr.stdout, /1\.5\.13/);
});

test("A11：--check 在上游 manifest 没有版本号时，不拿已装版本冒充 latest", { skip: SKIP_TLS }, async () => {
  await goodInstall();
  S.manifest = JSON.stringify({});
  const r = await run(["--check"], { FAKE_AGY_MODE: "good" });
  const j = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf("{")));
  assert.equal(j.installed, "1.5.13");
  assert.equal(j.latest, "", "manifest 里没有版本号时 latest 应为空，不能填已装版本");
  assert.notEqual(r.status, 0, "查不到可用版本号时 --check 应返回非零，让调用方报检查失败而不是“已是最新”");
  S.manifest = JSON.stringify({ version: "1.5.99", url: "https://example.invalid/agy-1.5.99.tar.gz", sha512: "ab".repeat(64) });
});

test("A11 对照：manifest 有版本号时 --check 正常返回 latest", { skip: SKIP_TLS }, async () => {
  await goodInstall();
  S.manifest = JSON.stringify({ version: "1.5.99" });
  const r = await run(["--check"], { FAKE_AGY_MODE: "good" });
  const j = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf("{")));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(j.ok, true);
  assert.equal(j.installed, "1.5.13");
  assert.equal(j.latest, "1.5.99");
  S.manifest = JSON.stringify({ version: "1.5.99", url: "https://example.invalid/agy-1.5.99.tar.gz", sha512: "ab".repeat(64) });
});

test("P0-6/7：下载的 install.sh 与钉住的校验值不符时，拒绝执行、退出码 4、不装任何东西", { skip: SKIP_TLS }, async () => {
  resetDest();
  const r = await run(["stable"], { FAKE_AGY_MODE: "good", HACHIMIA_AGY_PINS: PINS_WRONG });
  assert.equal(r.status, 4, "校验值不符应用 distinct 的退出码 4 拒绝执行：\n" + r.stdout + r.stderr);
  assert.match(r.stderr, /安装脚本校验值已变化，请等待新版本更新校验值/, " mismatch 要有一句用户看得懂的话");
  assert.match(r.stderr, /期望 000000000000…，实得 [0-9a-f]{12}…/, "期望/实得哈希前缀要写出来");
  assert.doesNotMatch(r.stdout, /安装完成/, "拒绝执行就不能报安装完成");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "不应切换 current");
  assert.equal(fs.existsSync(path.join(DEST, "1.5.13")), false, "假安装脚本根本不该跑起来");
  assert.deepEqual(stageLeftovers(), [], "拒绝执行发生在建暂存目录之前");
});

test("P0-6/7：校验值文件读不到时，同样拒绝执行未校验的脚本", { skip: SKIP_TLS }, async () => {
  resetDest();
  const r = await run(["stable"], { FAKE_AGY_MODE: "good", HACHIMIA_AGY_PINS: path.join(TLSDIR, "pins-missing.json") });
  assert.notEqual(r.status, 0, "读不到校验值文件就不能执行脚本：\n" + r.stdout + r.stderr);
  assert.match(r.stderr, /读不到 agy 安装脚本校验值文件/, "要说明是校验值文件的问题");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "不应切换 current");
});

test("P0-6/7：钉住的校验值只存在于 agy-install-pins.json 一个地方，脚本里没有写死的哈希", () => {
  const pins = JSON.parse(fs.readFileSync(new URL("../../android/assets/scripts/agy-install-pins.json", import.meta.url), "utf8"));
  assert.match(pins.installSh.sha256, /^[0-9a-f]{64}$/, "钉住的值应是 sha256");
  assert.equal(pins.installSh.sha256, "62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042",
    "初始钉住值应是 2026-11-21 从 Google 下载、实测装出可用 1.5.13 的那份 install.sh 的哈希");
  assert.equal(pins.installSh.source, "https://antigravity.google/cli/install.sh");
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /[0-9a-f]{64}/, "脚本里不应有写死的 64 位哈希：轮换只改 pins 文件");
  assert.match(src, /HACHIMIA_AGY_PINS/, "测试要能用环境变量指到别的 pins 文件");
  assert.match(src, /agy-install-pins\.json/, "默认从脚本旁边的 pins 文件读");
});

test("P0-6/7 对照：校验值对上时正常安装（HACHIMIA_AGY_PINS 覆盖生效）", { skip: SKIP_TLS }, async () => {
  await goodInstall();
  const m = JSON.parse(fs.readFileSync(path.join(DEST, "1.5.13", "manifest.json"), "utf8"));
  assert.equal(m.installShSha256, crypto.createHash("sha256").update(INSTALL_SH).digest("hex"),
    "本地清单应记下实际执行的 install.sh 的哈希（来源可查）");
});

test("P0-6/7：本地清单同时记已装二进制 sha256 与 manifest sha512 / 地址 / 版本（来源，不混为一谈）", { skip: SKIP_TLS }, async () => {
  resetDest();
  S.manifest = JSON.stringify({ version: "1.5.99", url: B + "/payload/agy.tar.gz", sha512: FAKE_SHA512 });
  const r = await run(["stable"], { FAKE_AGY_MODE: "good" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(DEST, "1.5.13", "manifest.json"), "utf8"));
  assert.equal(m.version, "1.5.13", "version 是装好的二进制自己报的");
  assert.match(m.sha256, /^[0-9a-f]{64}$/, "sha256 是已装二进制的");
  assert.equal(m.manifestSha512, FAKE_SHA512, "manifestSha512 是上游 manifest 里写的安装包 sha512");
  assert.equal(m.manifestUrl, B + "/manifests/" + (process.arch === "arm64" ? "android_arm64.json" : "android_amd64.json"));
  assert.equal(m.manifestVersion, "1.5.99", "manifestVersion 是清单里写的版本，和装好的可能不一样");
  assert.notEqual(m.sha256, m.manifestSha512, "两套哈希不能混为一谈");
  S.manifest = JSON.stringify({ version: "1.5.99", url: "https://example.invalid/agy-1.5.99.tar.gz", sha512: "ab".repeat(64) });
});

test("P0-6/7：manifest 里没有可用的 sha512 时，安装在执行 install.sh 之前就失败", { skip: SKIP_TLS }, async () => {
  resetDest();
  S.manifest = JSON.stringify({ version: "1.5.99", url: B + "/payload/agy.tar.gz" });
  const r = await run(["stable"], { FAKE_AGY_MODE: "good" });
  assert.notEqual(r.status, 0, "清单没有 sha512 就不该继续装：\n" + r.stdout + r.stderr);
  assert.match(r.stderr, /没有可用的下载地址 \/ sha512/, "要说明是清单缺 sha512");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "install.sh 根本不该跑起来");
  S.manifest = JSON.stringify({ version: "1.5.99", url: "https://example.invalid/agy-1.5.99.tar.gz", sha512: "ab".repeat(64) });
});

test("P0-6/7：取不到官方 manifest 时，安装失败且不执行 install.sh", { skip: SKIP_TLS }, async () => {
  resetDest();
  const r = await run(["stable"], { FAKE_AGY_MODE: "good", HACHIMIA_AGY_MANIFEST_BASE: B + "/nope" });
  assert.notEqual(r.status, 0, "问不到清单就不能装：\n" + r.stdout + r.stderr);
  assert.match(r.stderr, /取不到官方 agy 版本清单/, "要说明是清单问不到");
  assert.equal(fs.existsSync(path.join(DEST, "current")), false, "install.sh 根本不该跑起来");
});

test("P0-6/7：--recheck 发现已装二进制被改过时，退出码 3、消息里有期望/实得哈希前缀、写 .mismatch", { skip: SKIP_TLS }, async () => {
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

test("P0-6/7 对照：没被改过的安装，--recheck 退出 0、不写 .mismatch", { skip: SKIP_TLS }, async () => {
  await goodInstall();
  const r = await run(["--recheck"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1\.5\.13：sha256 一致/);
  assert.equal(fs.existsSync(path.join(DEST, "1.5.13", ".mismatch")), false);
});

test("A10：--recheck 时版本目录缺 manifest 或缺二进制，要计入损坏而不是直接跳过", { skip: SKIP_TLS }, async () => {
  resetDest();
  fs.mkdirSync(path.join(DEST, "1.5.13"), { recursive: true });
  fs.writeFileSync(path.join(DEST, "1.5.13", "agy"), "#!/bin/sh\n");
  const r1 = await run(["--recheck"]);
  assert.notEqual(r1.status, 0, "缺 manifest 的版本目录应判坏（退出码非零）");
  assert.match(r1.stdout, /1\.5\.13/);

  resetDest();
  fs.mkdirSync(path.join(DEST, "1.5.13"), { recursive: true });
  fs.writeFileSync(path.join(DEST, "1.5.13", "manifest.json"), JSON.stringify({ sha256: "0".repeat(64) }));
  const r2 = await run(["--recheck"]);
  assert.notEqual(r2.status, 0, "缺二进制的版本目录应判坏（退出码非零）");
  assert.match(r2.stdout, /1\.5\.13/);
});
