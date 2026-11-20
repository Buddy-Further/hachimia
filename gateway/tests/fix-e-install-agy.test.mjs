// E-04 / E-11 / A5 / A10 / A11：install-agy.mjs 安装与校验。
// 用本地 HTTP 服务冒充官方 install.sh 与 manifest、假 agy 二进制（--version 行为由环境变量控制），
// 全程只动临时 HOME 下的 .local/share/hachimia/agy，不碰真机、不联网。
// 运行：node scripts/test.mjs fix-e-install-agy
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
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

const S = { manifest: JSON.stringify({ version: "1.5.99" }) };
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
      HACHIMIA_AGY_MANIFEST_BASE: B + "/manifests", ...extraEnv },
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
