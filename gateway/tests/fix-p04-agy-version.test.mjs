// P0-4：agy 版本门——最低版本拦截 + 未验证版本警告 + 协议版本警告
// 环境变量必须在动态 import 之前设（仿 P0-3：acp-errors.mjs / acp.mjs /
// login.mjs 都在模块加载时读一次）。
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fix-p04-"));

const {
  AGY_MIN_VERSION, AGY_VERIFIED_VERSION, AGY_BEHAVIOUR,
  parseAgyVersion, compareAgyVersions, agyAtLeast, checkAgyVersion, agyBehaviour,
} = await import("../gw/agy-version.mjs");
const { classifyAcpError } = await import("../gw/acp-errors.mjs");
const { runAcpTurn, closeAllAcpClients } = await import("../gw/acp.mjs");
const { buildCapabilities } = await import("../gw/caps.mjs");

// ── 可配 mock agy（仿 fix-p03）───────────────────────────────────────
// initialize 回包由 cfg 控制：initVersion（agentInfo.version）、
// initProtocolVersion、initAgentInfo（传 null 可彻底去掉 agentInfo）。
// 其余行为与 P0-3 mock 相同：错误队列落文件（建会重试换新进程）。
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
const shiftErr = (key) => {
  let cur;
  try { cur = JSON.parse(fs.readFileSync(${JSON.stringify(cfgFile)}, "utf8")); } catch { return null; }
  const q = cur[key];
  if (Array.isArray(q) && q.length) {
    const e = q.shift();
    try { fs.writeFileSync(${JSON.stringify(cfgFile)}, JSON.stringify(cur), "utf8"); } catch {}
    return e;
  }
  return null;
};
const sessResult = () => ({
  sessionId: cfg.sessionId || "agy-sess-p04",
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
    const e = shiftErr("authenticateErrors");
    if (e) return send({ jsonrpc: "2.0", id: msg.id, error: e });
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/new") {
    const e = shiftErr("sessionNewErrors");
    if (e) return send({ jsonrpc: "2.0", id: msg.id, error: e });
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
  // 池复用按 cwd 参与 poolKey：复用测试必须两轮传同一个 dir
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

// ── 版本解析 / 比较 ─────────────────────────────────────────────────
test("P0-4 parse：严格三段式，容忍前导 v，其余一律 null", () => {
  assert.deepEqual(parseAgyVersion("1.5.13"), { major: 1, minor: 5, patch: 13 });
  assert.deepEqual(parseAgyVersion("v1.5.13"), { major: 1, minor: 5, patch: 13 });
  assert.deepEqual(parseAgyVersion("  1.5.13  "), { major: 1, minor: 5, patch: 13 });
  assert.deepEqual(parseAgyVersion("10.20.30"), { major: 10, minor: 20, patch: 30 });
  for (const bad of ["1.5", "", null, undefined, 1513, "1.5.13-beta", "abc", "1.5.x", "1.5.13.1", "v 1.5.13"]) {
    assert.equal(parseAgyVersion(bad), null, JSON.stringify(bad));
  }
});

test("P0-4 compare / agyAtLeast：数值比较，坏输入给 null / false", () => {
  assert.equal(compareAgyVersions("1.5.14", "1.5.13"), 1);
  assert.equal(compareAgyVersions("1.5.12", "1.5.13"), -1);
  assert.equal(compareAgyVersions("1.5.13", "1.5.13"), 0);
  assert.equal(compareAgyVersions("1.6.0", "1.5.13"), 1);
  assert.equal(compareAgyVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareAgyVersions("1.10.0", "1.9.9"), 1, "按数值比，不是按字典序");
  assert.equal(compareAgyVersions(null, "1.5.13"), null);
  assert.equal(compareAgyVersions("x", "1.5.13"), null);
  assert.equal(agyAtLeast("1.5.14", "1.5.13"), true);
  assert.equal(agyAtLeast("1.5.12", "1.5.13"), false);
  assert.equal(agyAtLeast("1.6.0", "1.5.13"), true);
  assert.equal(agyAtLeast("1.5.13", "1.5.13"), true);
  assert.equal(agyAtLeast("x", "1.5.13"), false);
  assert.equal(agyAtLeast("1.5.13", "x"), false);
});

// ── checkAgyVersion ────────────────────────────────────────────────
test("P0-4 check：ok / too-old / newer-unverified / unknown 四态", () => {
  assert.equal(AGY_MIN_VERSION, "1.5.13");
  assert.equal(AGY_VERIFIED_VERSION, "1.5.13");
  assert.deepEqual(checkAgyVersion("1.5.13"), { status: "ok", version: "1.5.13", min: "1.5.13", verified: "1.5.13" });
  assert.deepEqual(checkAgyVersion("v1.5.13").status, "ok");
  for (const v of ["1.5.12", "1.4.0", "0.9.9"]) {
    const g = checkAgyVersion(v);
    assert.equal(g.status, "too-old", v);
    assert.equal(g.version, v);
    assert.equal(g.min, "1.5.13");
    assert.equal(g.verified, "1.5.13");
  }
  for (const v of ["1.5.14", "1.6.0", "2.0.0"]) {
    assert.equal(checkAgyVersion(v).status, "newer-unverified", v);
  }
  for (const v of [undefined, "", "x", "1.5", null]) {
    assert.equal(checkAgyVersion(v).status, "unknown", JSON.stringify(v));
  }
  // floor 参数：显式抬高下限时，已验证版本也会变 too-old（env 覆盖的管线）
  assert.equal(checkAgyVersion("1.5.13", "1.5.14").status, "too-old");
  // M-4：调低后的下限（显式 floor）下，介于下限与已验证版本之间 → unknown
  assert.equal(checkAgyVersion("1.5.10", "1.5.9").status, "unknown");
  // M-4：解析不出的超长输入截到 64 字，不原样进 note/hint
  const long = checkAgyVersion("x".repeat(200));
  assert.equal(long.status, "unknown");
  assert.equal(long.version.length, 64);
  assert.equal(long.version, "x".repeat(64));
});

// ── AGY_BEHAVIOUR 表 ───────────────────────────────────────────────
test("P0-4 AGY_BEHAVIOUR：只有已验证版本一行，字段与探针结论一致", () => {
  assert.deepEqual(Object.keys(AGY_BEHAVIOUR), ["1.5.13"]);
  const row = AGY_BEHAVIOUR["1.5.13"];
  assert.deepEqual(row.permModes, ["default", "accept-edits", "plan"]);
  assert.deepEqual(row.thoughtLevelValues, ["low", "medium", "high", "xhigh"]);
  assert.equal(row.compactEmitsCompactionUpdate, false);
  assert.deepEqual(row.authMethods, ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"]);
  assert.deepEqual(row.sessionCapabilities, ["resume", "close", "load", "list", "additionalDirectories"]);
  assert.equal(row.modelsFormat, "text-lines");
  assert.equal(row.usageEnvelope, "command.data.groups[].buckets[]");
  assert.equal(row.mcpConfigFile, "~/.gemini/config/mcp_config.json");
  assert.equal(row.protocolVersion, 1);
  // 查表：精确命中给本行，未验证的新版本回落到已验证行（警告由 checkAgyVersion 发）
  assert.equal(agyBehaviour("1.5.13"), row);
  assert.equal(agyBehaviour("1.5.14"), row);
  assert.equal(agyBehaviour("x"), row);
});

// ── 分类器：version-mismatch ───────────────────────────────────────
test("P0-4 分类：AGY_VERSION → version-mismatch，不重试、动作为升级，hint 含两个版本", () => {
  const e = new Error("Antigravity CLI 版本 1.5.12 低于 hachimia 要求的 1.5.13");
  e.code = "AGY_VERSION";
  e.data = { version: "1.5.12", min: "1.5.13", verified: "1.5.13" };
  const c = classifyAcpError(e);
  assert.equal(c.class, "version-mismatch");
  assert.equal(c.retryable, false);
  assert.equal(c.action, "update-agy");
  assert.match(c.hint, /1\.5\.12/);
  assert.match(c.hint, /1\.5\.13/);
  assert.match(c.hint, /升级/);
  // 只有 code、没有 data/message 时也认，不掉进 unknown
  const bare = classifyAcpError({ code: "AGY_VERSION" });
  assert.equal(bare.class, "version-mismatch");
  assert.equal(bare.retryable, false);
  assert.match(bare.hint, /1\.5\.13/);
  // M-3：英文文案里的 version 也能抠出版本号（无 data 时）
  const en = new Error("Antigravity CLI version 1.5.12 is below the required version");
  en.code = "AGY_VERSION";
  const enC = classifyAcpError(en);
  assert.equal(enC.class, "version-mismatch");
  assert.match(enC.hint, /1\.5\.12/);
});

// ── 门：太旧拦截 ───────────────────────────────────────────────────
test("P0-4 门拦截：initialize 回 1.5.12 → version-mismatch，不认证、不建会话、不重试、不进池", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { initVersion: "1.5.12" });
  try {
    const { res, events } = await drive(mock, { keepAlive: true });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.errorClass, "version-mismatch", JSON.stringify(res));
    assert.equal(res.retryable, false);
    assert.match(String(res.errorHint || ""), /1\.5\.12/);
    assert.match(String(res.errorHint || ""), /1\.5\.13/);
    assert.equal(mock.countOf("initialize"), 1, "太旧必须只握手一次，不重试");
    assert.equal(mock.countOf("authenticate"), 0, "拦截在 authenticate 之前");
    assert.equal(mock.countOf("session/new"), 0);
    assert.equal(mock.countOf("session/prompt"), 0);
    assert.ok(!events.some((e) => e.type === "phase" && e.phase === "retry"), "不可重试类不得发 retry 事件");
    const errEv = events.find((e) => e.type === "error");
    assert.ok(errEv, "应发 error 事件");
    assert.match(errEv.message, /升级/);
    // 没进池：下一轮重新走 initialize（而不是复用一个“已建会”的 client）
    const second = await drive(mock, { keepAlive: true });
    assert.equal(second.res.ok, false);
    assert.equal(mock.countOf("initialize"), 2, "失败的 client 不得进池，下一轮必须重新 initialize");
    assert.equal(mock.countOf("authenticate"), 0);
  } finally { closeAllAcpClients(); }
});

// ── 门：更新版本警告放行 ───────────────────────────────────────────
test("P0-4 门放行：initialize 回 1.5.14 → 回合照常，恰好一条版本 note，caps 记 newer-unverified", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { initVersion: "1.5.14" });
  try {
    const { res, events } = await drive(mock);
    assert.equal(res.ok, true, res.error || JSON.stringify(events));
    const notes = events.filter((e) => e.type === "note" && e.key === "acp-agy-version-unverified");
    assert.equal(notes.length, 1, "新版本警告每轮恰好一条: " + JSON.stringify(events));
    assert.match(notes[0].text, /1\.5\.14/);
    assert.match(notes[0].text, /1\.5\.13/);
    assert.equal(buildCapabilities().versionStatus, "newer-unverified");
    assert.equal(buildCapabilities().version, "1.5.14");
    assert.equal(buildCapabilities().versionChecked, "1.5.14", "M-2：versionChecked 应在 caps 里暴露");
  } finally { closeAllAcpClients(); }
});

// ── 门：版本缺失放行 ───────────────────────────────────────────────
test("P0-4 门放行：initialize 不带 agentInfo.version → 不拦截，versionStatus unknown", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { initAgentInfo: null });
  try {
    const { res, events } = await drive(mock);
    assert.equal(res.ok, true, res.error || JSON.stringify(events));
    assert.equal(buildCapabilities().versionStatus, "unknown");
    const notes = events.filter((e) => e.type === "note" && e.key === "acp-agy-version-unverified");
    assert.equal(notes.length, 1, "未知版本也应警告一次: " + JSON.stringify(events));
  } finally { closeAllAcpClients(); }
});

// ── 门：协议版本不符警告放行 ───────────────────────────────────────
test("P0-4 门放行：protocolVersion 2 + 版本 1.5.13 → 警告、不拦截", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { initVersion: "1.5.13", initProtocolVersion: 2 });
  try {
    const { res, events } = await drive(mock);
    assert.equal(res.ok, true, res.error || JSON.stringify(events));
    assert.equal(buildCapabilities().versionStatus, "ok", "版本本身没问题时 versionStatus 仍是 ok");
    const notes = events.filter((e) => e.type === "note" && e.key === "acp-agy-version-unverified");
    assert.equal(notes.length, 1, "协议版本不符应警告一次: " + JSON.stringify(events));
    assert.match(notes[0].text, /2/);
  } finally { closeAllAcpClients(); }
});

// ── 门：只在新 client 上跑，复用轮次不再 initialize ───────────────
test("P0-4 池复用：1.5.13 建会后第二轮复用，不再发 initialize、不再警告", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { initVersion: "1.5.13" });
  const dir = freshDir("cwd");
  try {
    const first = await drive(mock, { keepAlive: true, cwd: dir });
    assert.equal(first.res.ok, true, first.res.error || JSON.stringify(first.events));
    assert.equal(first.res.sessionId, "agy-sess-p04");
    assert.equal(mock.countOf("initialize"), 1);
    assert.ok(!first.events.some((e) => e.type === "note" && e.key === "acp-agy-version-unverified"), "已验证版本不警告");
    const second = await drive(mock, { keepAlive: true, sessionId: first.res.sessionId, cwd: dir });
    assert.equal(second.res.ok, true, second.res.error || JSON.stringify(second.events));
    assert.equal(second.res.reused, true, "第二轮应复用池中 client");
    assert.equal(mock.countOf("initialize"), 1, "复用轮次不得重新 initialize（门只在新 client 上跑）");
    assert.ok(!second.events.some((e) => e.type === "note" && e.key === "acp-agy-version-unverified"));
  } finally { closeAllAcpClients(); }
});

// ── M-5：protocolVersion 是字符串 "1" 时不警告 ───────────────────────
test("P0-4 M-5：protocolVersion 为字符串 \"1\" → 与数字 1 等价，不警告", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { initVersion: "1.5.13", initProtocolVersion: "1" });
  try {
    const { res, events } = await drive(mock);
    assert.equal(res.ok, true, res.error || JSON.stringify(events));
    assert.equal(buildCapabilities().versionStatus, "ok");
    assert.ok(!events.some((e) => e.type === "note" && e.key === "acp-agy-version-unverified"),
      "字符串 \"1\" 不应触发协议版本警告: " + JSON.stringify(events));
  } finally { closeAllAcpClients(); }
});

// ── M-1 / F-3：跨会话去重——第二台新 client、同版本不再警告 ──────────
test("P0-4 M-1/F-3：第二轮新 client、同版本 1.5.15 → 不再发版本 note", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { initVersion: "1.5.15" });
  try {
    const first = await drive(mock);
    assert.equal(first.res.ok, true, first.res.error || JSON.stringify(first.events));
    const firstNotes = first.events.filter((e) => e.type === "note" && e.key === "acp-agy-version-unverified");
    assert.equal(firstNotes.length, 1, "首轮新版本应警告一次: " + JSON.stringify(first.events));
    // 第二轮：全新 cwd → 全新 client（非池复用），同版本同协议版本
    const second = await drive(mock);
    assert.equal(second.res.ok, true, second.res.error || JSON.stringify(second.events));
    assert.equal(mock.countOf("initialize"), 2, "第二轮必须是新 client（重新 initialize）");
    const secondNotes = second.events.filter((e) => e.type === "note" && e.key === "acp-agy-version-unverified");
    assert.equal(secondNotes.length, 0, "同版本第二台新 client 不应再警告: " + JSON.stringify(second.events));
  } finally { closeAllAcpClients(); }
});
