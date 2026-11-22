// PR #1 复核：版本门认验签 feed——子进程端到端探针
// 子进程里用一把测试钥匙签一份 feed 写进磁盘缓存（agyverified.mjs 在
// 启动时从已签名的磁盘缓存载入），再让 mock agy 报 1.5.14，看建会是否
// 不再警告。对照组用空 feed：同样 1.5.14 必须照常警告。
// 单元侧：checkAgyVersion 的 extraVerified 语义见 fix-p04-agy-version.test.mjs；
// agyVerifiedVersions() 的集合语义见 agyverified.test.mjs。
process.env.CCAPP_ACP_RETRY_BASE_MS = "50";
process.env.CCAPP_ACP_RETRY_CAP_MS = "200";
process.env.CCAPP_ACP_RETRY_RL_BASE_MS = "50";
process.env.CCAPP_ACP_RETRY_RL_CAP_MS = "200";
process.env.CCAPP_ACP_PROMPT_TIMEOUT_MS = "800";
process.env.CCAPP_AGY_JSON_TIMEOUT_MS = "400";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fix-p1fix-feed-"));
const repoGw = new URL("../gw/", import.meta.url).pathname;

// ── mock agy：initialize 报 1.5.14 ────────────────────────────────────
function makeMock(dir) {
  const script = path.join(dir, "mock-agy");
  fs.writeFileSync(script, `#!${process.execPath}
const readline = require("node:readline");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (!msg.method) return;
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {}, additionalDirectories: {} } },
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
      authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
    } });
  }
  if (msg.method === "authenticate") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: {
    sessionId: "agy-sess-feed",
    models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }] },
  } });
  if (msg.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/set_mode") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`, { mode: 0o755 });
  return script;
}

// ── 子进程探针：跑一轮，打印一行 FEEDGATE <json> ──────────────────────
const probePath = path.join(tmpRoot, "probe-feed.mjs");
fs.writeFileSync(probePath, `import { runAcpTurn, closeAllAcpClients } from ${JSON.stringify(path.join(repoGw, "acp.mjs"))};
import { buildCapabilities } from ${JSON.stringify(path.join(repoGw, "caps.mjs"))};
const [mockScript, cwd] = process.argv.slice(2);
const events = [];
try {
  const res = await runAcpTurn({
    bin: process.execPath, args: [mockScript], cwd, env: process.env,
    prompt: "hi", model: "gemini-4-neon", authType: "oauth-personal",
    keepAlive: false, emit: (ev) => events.push(ev),
  });
  console.log("FEEDGATE " + JSON.stringify({
    ok: res.ok,
    versionStatus: buildCapabilities().versionStatus,
    versionChecked: buildCapabilities().versionChecked,
    notes: events.filter((e) => e.type === "note" && e.key === "acp-agy-version-unverified").length,
  }));
} finally { closeAllAcpClients(); }
`, "utf8");

function runProbe({ home, pubkeyPem, mockScript }) {
  const cwd = fs.mkdtempSync(path.join(tmpRoot, "cwd-"));
  // 注意：config.mjs 取 home 是 CCAPP_HOME 优先于 HOME；测试 harness 会设
  // CCAPP_HOME，所以这里必须两个都指到探针的 home，否则签好的 feed 写不到
  // 探针读的那份缓存里。
  const env = { ...process.env, HOME: home, CCAPP_HOME: home, CCAPP_TEST: "1", CCAPP_TEST_PUBKEY: pubkeyPem,
    CCAPP_AGY_VERIFIED_URL: "http://127.0.0.1:1/verified.json" };
  delete env.CCAPP_AGY_MIN_VERSION;
  delete env.CCAPP_AGY_ALLOW_UNVERIFIED;
  const r = spawnSync(process.execPath, [probePath, mockScript, cwd], { encoding: "utf8", env, timeout: 60000 });
  assert.equal(r.status, 0, `探针子进程失败: ${r.stderr}\n${r.stdout}`);
  const line = r.stdout.split("\n").find((l) => l.startsWith("FEEDGATE "));
  assert.ok(line, "探针没有输出 FEEDGATE 行: " + r.stdout);
  return JSON.parse(line.slice("FEEDGATE ".length));
}

function writeSignedFeed(home, keypair, feed) {
  const cacheDir = path.join(home, ".cache", "cccodroid");
  fs.mkdirSync(cacheDir, { recursive: true });
  const body = Buffer.from(JSON.stringify(feed));
  fs.writeFileSync(path.join(cacheDir, "agy-verified.json"), body);
  fs.writeFileSync(path.join(cacheDir, "agy-verified.json.sig"),
    crypto.sign(null, body, keypair.privateKey).toString("base64"));
}

test("PR1fix 版本门认 feed：磁盘上有 1.5.14 签名记录时不警告，空 feed 时照常警告", { timeout: 120000 }, async () => {
  const keypair = crypto.generateKeyPairSync("ed25519");
  const pubkeyPem = keypair.publicKey.export({ type: "spki", format: "pem" });
  const mockScript = makeMock(fs.mkdtempSync(path.join(tmpRoot, "mock-")));
  const rec = { at: "2026-11-22", device: "Test", android: "15", sdk: 35, targetSdk: 36, app: "0.1.3" };

  const homeSigned = fs.mkdtempSync(path.join(tmpRoot, "home-signed-"));
  writeSignedFeed(homeSigned, keypair,
    { v: 1, updated: "2026-11-22T00:00:00Z", versions: { "1.5.14": [rec] }, bad: {} });
  const signed = runProbe({ home: homeSigned, pubkeyPem, mockScript });
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(signed.versionStatus, "ok", "feed 验过 1.5.14 时状态应为 ok: " + JSON.stringify(signed));
  assert.equal(signed.versionChecked, "1.5.14");
  assert.equal(signed.notes, 0, "feed 验过 1.5.14 时不应发版本警告");

  const homeEmpty = fs.mkdtempSync(path.join(tmpRoot, "home-empty-"));
  writeSignedFeed(homeEmpty, keypair,
    { v: 1, updated: "2026-11-22T00:00:00Z", versions: {}, bad: {} });
  const empty = runProbe({ home: homeEmpty, pubkeyPem, mockScript });
  assert.equal(empty.ok, true, JSON.stringify(empty));
  assert.equal(empty.versionStatus, "newer-unverified", "空 feed 时 1.5.14 仍是 newer-unverified: " + JSON.stringify(empty));
  assert.equal(empty.notes, 1, "空 feed 时应发一次版本警告");
});
