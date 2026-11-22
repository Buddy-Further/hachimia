// P0-6 消费侧：坏版本拦自动更新（devside 的开发端 + Updater.java 的 Android 端）。
// 子进程行为断言：本地假 manifest（最新 1.5.14）+ 本地假 agy 验证 feed（1.5.14 标坏，测试钥匙签名），
// 不带 CCAPP_PREFIX 起网关，upd_check 之后 upd_status 必须看到 held，/api/claude/versions 必须带上 agy 的验证/坏版本。
// Java 侧本机没有 javac/android.jar，编不过也跑不了 java-tests.sh（见修复报告），这里只做源码断言：
// knownBad 两个 feed 都读、都验签。
// 运行：node scripts/test.mjs fix-p06-devside-gate
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("P0-6 Updater.java knownBad：agy feed 和 Claude feed 都读、都验签", () => {
  const s = read("android/java/ha/chi/mia/Updater.java");
  assert.match(s, /\.cache\/cccodroid\/agy-verified\.json/, "要读 agy 那份验证记录");
  assert.match(s, /\.cache\/cccodroid\/claude-verified\.json/, "Claude 那份还留着当后备，不能断");
  assert.match(s, /badReasonFrom\(new File\(env\.home, "\.cache\/cccodroid\/agy-verified\.json"\), v\)/, "先查 agy feed");
  assert.match(s, /Ed25519\.verifyIndex\(body,/, "读回来的记录要再验一遍签名（同 uid 写进来的假记录不认）");
});

test("P0-6 devside：/api/claude/versions 用 agy feed，自动更新认 held", () => {
  const s = read("gateway/gw/devside.mjs");
  assert.match(s, /agyVerifiedInfo\(/, "版本选单的内容源应是 agy feed");
  assert.doesNotMatch(s, /verifiedInfo\(\(u\.searchParams/, "选单不再用 Claude 那份 verifiedInfo");
  assert.match(s, /c\.held = /, "devUpdCheck 要置 held");
  assert.match(s, /devUpd\.agy\.state === "available" && !devUpd\.agy\.held/, "定时自动更新不装 held 的版本");
  assert.match(s, /async function devUpdInstall\(version, manual = false\)/, "手动安装要能绕过 held");
  assert.match(s, /devUpdInstall\(b\.version, true\)/, "upd_apply 是用户点的，算手动");
});

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" });
const FEED = { v: 1, updated: "2026-11-21T01:00:00Z",
  versions: { "1.5.13": [{ at: "2026-11-21", device: "Pixel 9", android: "15", sdk: 35, targetSdk: 36, app: "0.1.3", devkit: "devkit-2026.11.21.1", sha256: "cd" }] },
  bad: { "1.5.14": { zh: "启动就闪退", en: "Crashes on launch", fixed: "1.5.15" } } };
const FEED_BODY = Buffer.from(JSON.stringify(FEED)).toString("base64");
const FEED_SIG = crypto.sign(null, Buffer.from(JSON.stringify(FEED)), privateKey).toString("base64");

const probe = `
  const http = await import("node:http");
  const feed = Buffer.from(process.env.FEED_BODY, "base64"), sig = process.env.FEED_SIG;   // .sig 是 base64 文本，原样发（别先解成原始字节再发，utf8 一转就坏）
  const feedSrv = http.createServer((req, res) => {
    if (req.url.startsWith("/manifests/") && req.url.endsWith(".json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ version: "1.5.14", url: "https://example.invalid/agy.tar.gz", sha512: "ab".repeat(64) }));
    }
    if (req.url === "/verified.json") return res.end(feed);
    if (req.url === "/verified.json.sig") return res.end(sig);
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => feedSrv.listen(0, "127.0.0.1", ok));
  const fb = "http://127.0.0.1:" + feedSrv.address().port;
  process.env.HACHIMIA_AGY_MANIFEST_BASE = fb + "/manifests";
  process.env.CCAPP_AGY_VERIFIED_URL = fb + "/verified.json";
  // 上面两个地址必须在 import 之前定好：agyverified.mjs 在加载时就读 CCAPP_AGY_VERIFIED_URL 定发布源
  const { routeDevside } = await import(${JSON.stringify(path.join(ROOT, "gateway", "gw", "devside.mjs"))});
  const { NEXT } = await import(${JSON.stringify(path.join(ROOT, "gateway", "gw", "http.mjs"))});
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await routeDevside(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = "http://127.0.0.1:" + srv.address().port;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p) => (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  await post("/api/app/upd_check");
  let st;
  for (let i = 0; i < 50; i++) { st = await get("/api/app/upd_status"); if (st.lastCheck || st.error) break; await new Promise((r) => setTimeout(r, 200)); }
  console.log("STATUS:" + JSON.stringify(st));
  console.log("VERSIONS:" + JSON.stringify(await get("/api/claude/versions?lang=zh")));
  process.exit(0);
`;

async function runProbe(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fix-p06-gate-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fix-p06-gate-ws-"));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CCAPP_|CLAUDE_CODE_|ANTHROPIC_)/.test(k) && k !== "PREFIX"));
  Object.assign(env, { CCAPP_TEST: "1", CCAPP_HOME: home, HOME: home, CCAPP_WORKSPACE: ws,
    CCAPP_TEST_PUBKEY: PUB_PEM, FEED_BODY, FEED_SIG });
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", probe], { env, timeout: 60000 });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.stderr.on("data", (d) => { buf += d; });
    child.on("error", reject);
    child.on("close", () => resolve(buf));
  });
  const line = (p) => { const l = out.split("\n").find((x) => x.startsWith(p)); assert.ok(l, "子进程没返回 " + p + "：\n" + out); return JSON.parse(l.slice(p.length)); };
  return { status: line("STATUS:"), versions: line("VERSIONS:") };
}

test("P0-6 开发端：渠道最新版标坏时，upd_check 置 held、状态仍是 available（等用户自己点）", async (t) => {
  const { status } = await runProbe(t);
  assert.equal(status.error || "", "", "检查本身不应失败：" + JSON.stringify(status));
  assert.ok(status.lastCheck, "检查应完成：" + JSON.stringify(status));
  const item = (status.items || [])[0];
  assert.equal(item.id, "agy");
  assert.equal(item.latest, "1.5.14", "渠道最新版是假 manifest 里的 1.5.14");
  assert.equal(item.state, "available", "有新版就是 available，held 不改状态、只拦自动装");
  assert.equal(item.held, true, "标坏的版本要置 held");
  assert.match(item.message || "", /启动就闪退/, "held 的原因要写进更新项的消息里");
});

test("P0-6 开发端：/api/claude/versions 带上 agy feed 的验证记录与坏版本（路由名不变）", async (t) => {
  const { versions } = await runProbe(t);
  assert.equal(versions.latest, "1.5.14");
  assert.ok(versions.versions.includes("1.5.14"), "版本列表里有渠道最新版");
  assert.equal(versions.verified["1.5.13"][0].device, "Pixel 9", "验过的版本要标出来");
  assert.deepEqual(versions.bad["1.5.14"], { text: "启动就闪退", fixed: "1.5.15" }, "坏版本的原因要按语言给出来");
});
