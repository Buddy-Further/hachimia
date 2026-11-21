// P0-4 I-1：环境变量覆盖——CCAPP_AGY_MIN_VERSION / CCAPP_AGY_ALLOW_UNVERIFIED
// 环境变量必须在动态 import 之前设（每个测试文件跑在自己的进程里，
// 所以本文件设 CCAPP_AGY_MIN_VERSION="1.5.14" 不会污染其它文件；
// 其余取值——非法值、v 前缀、调低的下限——用子进程探针逐个验证，
// 子进程里 env 显式覆盖/删除，不继承本文件的设定）。
process.env.CCAPP_AGY_MIN_VERSION = "1.5.14";
process.env.CCAPP_AGY_ALLOW_UNVERIFIED = "1";
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
import { spawnSync } from "node:child_process";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fix-p04-env-"));

const {
  AGY_MIN_VERSION, AGY_VERIFIED_VERSION, AGY_ALLOW_UNVERIFIED,
  checkAgyVersion,
} = await import("../gw/agy-version.mjs");
const { runAcpTurn, closeAllAcpClients } = await import("../gw/acp.mjs");
const { buildCapabilities } = await import("../gw/caps.mjs");

// ── 子进程探针：换一个 CCAPP_AGY_MIN_VERSION 取值重读模块 ─────────────
// 探针只打印一行 JSON：{ min, verified, allow, check1510 }，其中
// check1510 = checkAgyVersion("1.5.10")（默认下限下的判定）。
const agyVersionPath = new URL("../gw/agy-version.mjs", import.meta.url).pathname;
const probePath = path.join(tmpRoot, "probe-env.mjs");
fs.writeFileSync(probePath, `import { AGY_MIN_VERSION, AGY_VERIFIED_VERSION, AGY_ALLOW_UNVERIFIED, checkAgyVersion } from ${JSON.stringify(agyVersionPath)};
console.log(JSON.stringify({ min: AGY_MIN_VERSION, verified: AGY_VERIFIED_VERSION, allow: AGY_ALLOW_UNVERIFIED, check1510: checkAgyVersion("1.5.10") }));
`, "utf8");

function probeEnv(overrides) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync(process.execPath, [probePath], { encoding: "utf8", env });
  assert.equal(r.status, 0, `探针子进程失败: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

// ── 本进程：下限被抬到 1.5.14，逃生口打开 ─────────────────────────────
test("P0-4 env：CCAPP_AGY_MIN_VERSION=1.5.14 抬高下限，已验证版本不变", () => {
  assert.equal(AGY_MIN_VERSION, "1.5.14");
  assert.equal(AGY_VERIFIED_VERSION, "1.5.13", "下限只影响 too-old 判定，不改已验证版本");
  assert.equal(AGY_ALLOW_UNVERIFIED, true);
  // 抬高后：1.5.13（原已验证版本）也变 too-old；1.5.14 高于已验证版本 → newer-unverified
  assert.equal(checkAgyVersion("1.5.13").status, "too-old");
  assert.equal(checkAgyVersion("1.5.14").status, "newer-unverified");
  assert.equal(checkAgyVersion("1.5.10").status, "too-old", "抬高下限后 1.5.10 仍是 too-old，不是 unknown");
});

// ── 子进程：非法值 / v 前缀 / 调低 / 缺省 ────────────────────────────
test("P0-4 env：非法值 CCAPP_AGY_MIN_VERSION=1.5 被忽略，回落默认 1.5.13", () => {
  const p = probeEnv({ CCAPP_AGY_MIN_VERSION: "1.5" });
  assert.equal(p.min, "1.5.13");
  assert.equal(p.verified, "1.5.13");
  assert.equal(p.check1510.status, "too-old");
});

test("P0-4 env：v 前缀 CCAPP_AGY_MIN_VERSION=v1.5.14 被剥掉 v 采用", () => {
  const p = probeEnv({ CCAPP_AGY_MIN_VERSION: "v1.5.14" });
  assert.equal(p.min, "1.5.14");
  assert.equal(p.check1510.status, "too-old");
});

test("P0-4 env：下限调低到 1.5.9 时，1.5.10 → unknown（≥下限但 < 已验证）", () => {
  const p = probeEnv({ CCAPP_AGY_MIN_VERSION: "1.5.9" });
  assert.equal(p.min, "1.5.9");
  assert.equal(p.check1510.status, "unknown");
  assert.equal(p.check1510.version, "1.5.10");
  // v 前缀 + 调低组合也一样
  const pv = probeEnv({ CCAPP_AGY_MIN_VERSION: "v1.5.9" });
  assert.equal(pv.min, "1.5.9");
  assert.equal(pv.check1510.status, "unknown");
});

test("P0-4 env：不设 CCAPP_AGY_MIN_VERSION 时默认 1.5.13，逃生口默认关", () => {
  const p = probeEnv({ CCAPP_AGY_MIN_VERSION: null, CCAPP_AGY_ALLOW_UNVERIFIED: null });
  assert.equal(p.min, "1.5.13");
  assert.equal(p.verified, "1.5.13");
  assert.equal(p.allow, false);
});

// ── 可配 mock agy（仿 fix-p04-agy-version.test.mjs）───────────────────
function makeMock(dir, cfg) {
  const cfgFile = path.join(dir, "mock-cfg.json");
  const countsFile = path.join(dir, "mock-counts.txt");
  fs.writeFileSync(cfgFile, JSON.stringify(cfg), "utf8");
  fs.writeFileSync(countsFile, "", "utf8");
  const script = path.join(dir, "mock-agy");
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgFile)}, "utf8"));
const countsFile = ${JSON.stringify(countsFile)};
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const count = (m) => fs.appendFileSync(countsFile, m + "\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => process.exit(0));
const sessResult = () => ({
  sessionId: cfg.sessionId || "agy-sess-p04-env",
  models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }, { modelId: "gemini-2-flash" }] },
});
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (!msg.method) return;
  count(msg.method);
  if (msg.method === "initialize") {
    const agentInfo = cfg.initAgentInfo === null ? undefined
      : (cfg.initAgentInfo !== undefined ? cfg.initAgentInfo
      : (cfg.initVersion === undefined ? undefined
      : { name: "Antigravity ACP Server", version: cfg.initVersion }));
    return send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: cfg.initProtocolVersion !== undefined ? cfg.initProtocolVersion : 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {}, additionalDirectories: {} } },
      agentInfo,
      authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
    } });
  }
  if (msg.method === "authenticate") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/new") {
    return send({ jsonrpc: "2.0", id: msg.id, result: sessResult() });
  }
  if (msg.method === "session/resume" || msg.method === "session/load") {
    return send({ jsonrpc: "2.0", id: msg.id, result: sessResult() });
  }
  if (msg.method === "session/set_config_option") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/set_mode") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`, { mode: 0o755 });
  const counts = () => fs.readFileSync(countsFile, "utf8").split("\n").filter(Boolean);
  const countOf = (m) => counts().filter((x) => x === m).length;
  return { script, counts, countOf };
}

function freshDir(tag) {
  return fs.mkdtempSync(path.join(tmpRoot, tag + "-"));
}

async function drive(mock, { model, prompt = "hi", cwd, ...extra } = {}) {
  const events = [];
  const dir = cwd || freshDir("cwd");
  const res = await runAcpTurn({
    bin: process.execPath,
    args: [mock.script],
    cwd: dir,
    env: process.env,
    prompt,
    model: model || "gemini-4-neon",
    authType: "oauth-personal",
    keepAlive: false,
    emit: (ev) => events.push(ev),
    ...extra,
  });
  return { res, events, dir };
}

// ── 端到端：逃生口只压警告，不压拦截 ──────────────────────────────────
test("P0-4 env 端到端：CCAPP_AGY_ALLOW_UNVERIFIED=1 压住新版本 note，回合照常", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { initVersion: "1.5.14" });
  try {
    const { res, events } = await drive(mock);
    assert.equal(res.ok, true, res.error || JSON.stringify(events));
    const notes = events.filter((e) => e.type === "note" && e.key === "acp-agy-version-unverified");
    assert.equal(notes.length, 0, "逃生口打开时新版本不应再发 note: " + JSON.stringify(events));
    assert.equal(buildCapabilities().versionStatus, "newer-unverified", "caps 仍记录真实状态，只是不发 note");
    assert.equal(buildCapabilities().versionChecked, "1.5.14");
  } finally { closeAllAcpClients(); }
});

test("P0-4 env 端到端：CCAPP_AGY_ALLOW_UNVERIFIED=1 也压不住 too-old 拦截", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { initVersion: "1.5.12" });
  try {
    const { res, events } = await drive(mock, { keepAlive: true });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.errorClass, "version-mismatch", JSON.stringify(res));
    assert.equal(res.retryable, false);
    assert.equal(mock.countOf("initialize"), 1, "太旧只握手一次，不重试");
    assert.equal(mock.countOf("authenticate"), 0, "拦截在 authenticate 之前");
    assert.equal(mock.countOf("session/new"), 0);
  } finally { closeAllAcpClients(); }
});
