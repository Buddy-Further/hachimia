// P0-3：ACP 错误分类 + 建会重试 + prompt 阶段不重试 + 探针超时
// 环境变量必须在动态 import 之前设：acp-errors.mjs / acp.mjs / login.mjs
// 都在模块加载时读一次（仿 CCAPP_ACP_PROMPT_TIMEOUT_MS 的先例）。
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fix-p03-"));
const probeBin = path.join(tmpRoot, "fake-agy-probe");
process.env.CCAPP_AGY = probeBin;

const { classifyAcpError, retryDelayMs, ACP_RETRY } = await import("../gw/acp-errors.mjs");
const { runAcpTurn, closeAllAcpClients, acpSessionFile } = await import("../gw/acp.mjs");
const login = await import("../gw/login.mjs");

// ── 可配 mock agy ─────────────────────────────────────────────────────
// 行为由 JSON 配置文件控制（runAcpTurn 把 process.env 透进子进程，
// mock 用 P03_MOCK_CFG 找到它）；每次请求往 P03_MOCK_COUNTS 追加一行方法名，
// 测试据此数“到底发了几次”，不靠 mock 进程内状态。
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
// 错误队列必须落文件：建会重试会换全新 client（新 mock 进程），
// 只放内存里每次重建都会从头再错、永远重试不完。
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
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (!msg.method) return;
  count(msg.method);
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
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
    return send({ jsonrpc: "2.0", id: msg.id, result: {
      sessionId: cfg.sessionId || "agy-sess-p03",
      models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }, { modelId: "gemini-2-flash" }] },
    } });
  }
  if (msg.method === "session/set_config_option") {
    const e = shiftErr("setConfigOptionErrors");
    if (e) return send({ jsonrpc: "2.0", id: msg.id, error: e });
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/set_mode") {
    const e = shiftErr("setModeErrors");
    if (e) return send({ jsonrpc: "2.0", id: msg.id, error: e });
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/prompt") {
    if (cfg.promptHang) return; // 假死：不回包也不退出
    const sid = msg.params.sessionId;
    if (cfg.promptPartialText) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: cfg.promptPartialText } } } });
    }
    const e = shiftErr("promptErrors");
    if (e) return send({ jsonrpc: "2.0", id: msg.id, error: e });
    if (!cfg.promptPartialText) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    }
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

async function drive(mock, { model, prompt = "hi", ...extra } = {}) {
  const events = [];
  const dir = freshDir("cwd");
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

// ── 分类器单元测试 ───────────────────────────────────────────────────
test("P0-3 分类：auth-expired（-32000 + 认证文案），不重试、动作重登录", () => {
  const c = classifyAcpError({ code: -32000, message: "Authentication required" });
  assert.equal(c.class, "auth-expired");
  assert.equal(c.retryable, false);
  assert.equal(c.action, "re-login");
  assert.equal(c.code, -32000);
  assert.equal(c.raw, "Authentication required");
  assert.match(c.hint, /重新登录/);
});

test("P0-3 分类：-p /usage 信封 authentication failed or timed out 也算登录过期", () => {
  const c = classifyAcpError('{"error":"authentication failed or timed out"}');
  assert.equal(c.class, "auth-expired");
  assert.equal(c.retryable, false);
});

test("P0-3 分类：login-env 只认 -32603 + 无浏览器文案，通用 -32603 是 unknown", () => {
  const c = classifyAcpError({ code: -32603, message: "No browser is available here, cannot open login page" });
  assert.equal(c.class, "login-env");
  assert.equal(c.retryable, false);
  assert.match(c.hint, /agy acp --login/);
  const g = classifyAcpError({ code: -32603, message: "Internal error" });
  assert.equal(g.class, "unknown");
  assert.equal(g.retryable, false);
  assert.equal(g.raw, "Internal error");
});

test("P0-3 分类：rate-limit（429 码与文案），可重试，hint 是 stream.mjs 的 429 原句", () => {
  for (const err of [
    { code: 429, message: "Too many requests" },
    { message: "API Error: 429 rate limit exceeded" },
    { message: "quota exhausted, try later" },
  ]) {
    const c = classifyAcpError(err);
    assert.equal(c.class, "rate-limit", JSON.stringify(err));
    assert.equal(c.retryable, true);
    assert.equal(c.action, "retry");
    assert.match(c.hint, /请求太频繁，或者用量到了上限：稍等一会儿再试。/);
  }
});

test("P0-3 分类：model-not-found（404 / not found 文案 / C6 中文错），不重试", () => {
  for (const err of [
    { code: 404, message: "Not found" },
    { message: "model gemini-9 not found" },
    { message: "[agy-acp] agent 不提供模型 gemini-9（可用：gemini-4-neon），无法切换" },
  ]) {
    const c = classifyAcpError(err);
    assert.equal(c.class, "model-not-found", JSON.stringify(err));
    assert.equal(c.retryable, false);
    assert.match(c.hint, /检查模型名/);
  }
});

test("P0-3 分类：context-too-long，hint 是 stream.mjs 的超长原句", () => {
  const c = classifyAcpError({ message: "prompt is too long: 300000 tokens" });
  assert.equal(c.class, "context-too-long");
  assert.equal(c.retryable, false);
  assert.match(c.hint, /\/compact/);
});

test("P0-3 分类：timeout（ACP_TIMEOUT 码）与 network-process，可重试", () => {
  const t = new Error("ACP request timeout: session/prompt");
  t.code = "ACP_TIMEOUT";
  assert.equal(classifyAcpError(t).class, "timeout");
  assert.equal(classifyAcpError(t).retryable, true);
  for (const m of ["agy acp exited with code 1", "agy acp terminated by SIGTERM", "ACP stdin write failed: session/prompt", "ACP process already closed", "read ECONNRESET", "spawn agy ENOENT"]) {
    const c = classifyAcpError(new Error(m));
    assert.equal(c.class, "network-process", m);
    assert.equal(c.retryable, true, m);
    assert.match(c.hint, /进程异常退出/);
  }
});

test("P0-3 分类：unknown 保留原文，-32601/-32602 不重试", () => {
  for (const err of [{ code: -32601, message: "Method not found" }, { code: -32602, message: "Invalid params" }, "boom"]) {
    const c = classifyAcpError(err);
    assert.equal(c.class, "unknown", JSON.stringify(err));
    assert.equal(c.retryable, false);
    assert.ok(c.hint.includes(c.raw), "hint 里必须有原文");
  }
});

test("P0-3 退避：base 50ms ×2、cap 200ms、±25% 抖动；429 认 data.retryAfter（上限 60s）", () => {
  assert.equal(ACP_RETRY.maxAttempts, 3);
  const d1 = retryDelayMs(1, new Error("agy acp exited with code 1"));
  const d2 = retryDelayMs(2, new Error("agy acp exited with code 1"));
  const d3 = retryDelayMs(3, new Error("agy acp exited with code 1"));
  assert.ok(d1 >= 37 && d1 <= 63, `attempt1 应在 50±25% 内，实际 ${d1}`);
  assert.ok(d2 >= 75 && d2 <= 125, `attempt2 应在 100±25% 内，实际 ${d2}`);
  assert.ok(d3 >= 150 && d3 <= 250, `attempt3 应封顶 200±25%，实际 ${d3}`);
  const rl = retryDelayMs(1, { code: 429, message: "rate limit", data: { retryAfter: 5 } });
  assert.ok(rl >= 5000 && rl <= 60000, `429 有 retryAfter=5s 时至少等 5s，实际 ${rl}`);
  const rlFar = retryDelayMs(1, { code: 429, message: "rate limit", data: { retryAfter: 3600 } });
  assert.equal(rlFar, 60000, `retryAfter 再大也只等 60s，实际 ${rlFar}`);
});

// ── 建会重试 ─────────────────────────────────────────────────────────
test("P0-3 建会 429 重试：session/new 前两次 429、第三次成功，恰好 3 次、两次 retry 事件", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), {
    sessionNewErrors: [
      { code: 429, message: "Too many requests" },
      { code: 429, message: "API Error: 429 rate limit exceeded" },
    ],
  });
  try {
    const t0 = Date.now();
    const { res, events } = await drive(mock);
    const dt = Date.now() - t0;
    assert.equal(res.ok, true, res.error || JSON.stringify(events));
    assert.equal(mock.countOf("session/new"), 3, "session/new 必须恰好 3 次");
    assert.equal(mock.countOf("initialize"), 3, "每次重试都重走完整握手");
    assert.equal(mock.countOf("authenticate"), 3);
    const retries = events.filter((e) => e.type === "phase" && e.phase === "retry");
    assert.equal(retries.length, 2, JSON.stringify(events));
    assert.deepEqual(retries.map((r) => r.attempt), [1, 2]);
    assert.ok(retries.every((r) => r.max === 3 && r.delayMs > 0 && typeof r.error === "string" && r.error.length <= 200));
    assert.ok(dt < 5000, `退避基数 50ms 时整轮应很快，实际 ${dt}ms`);
  } finally { closeAllAcpClients(); }
});

test("P0-3 建会不重试：authenticate -32000 只发 1 次，errorClass auth-expired、hint 是重登录", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), {
    authenticateErrors: [{ code: -32000, message: "Authentication required" }],
  });
  try {
    const { res, events } = await drive(mock);
    assert.equal(res.ok, false);
    assert.equal(res.errorClass, "auth-expired", JSON.stringify(res));
    assert.equal(res.retryable, false);
    assert.equal(mock.countOf("authenticate"), 1, "登录过期不得重试");
    assert.equal(mock.countOf("session/new"), 0, "认证失败不得建会话");
    const errEv = events.find((e) => e.type === "error");
    assert.ok(errEv, "应发 error 事件");
    assert.match(errEv.message, /重新登录/);
    assert.ok(String(errEv.detail || "").includes("Authentication required"), "detail 里必须保留原文");
  } finally { closeAllAcpClients(); }
});

test("P0-3 建会不重试：session/new 404 只发 1 次，errorClass model-not-found", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), {
    sessionNewErrors: [{ code: 404, message: "Not found" }],
  });
  try {
    const { res } = await drive(mock);
    assert.equal(res.ok, false);
    assert.equal(res.errorClass, "model-not-found", JSON.stringify(res));
    assert.equal(res.retryable, false);
    assert.equal(mock.countOf("session/new"), 1);
    assert.equal(mock.countOf("session/prompt"), 0);
  } finally { closeAllAcpClients(); }
});

test("P0-3 建会不重试：模型不在 agent 清单里（C6）→ model-not-found，不发 prompt", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), {});
  try {
    const { res } = await drive(mock, { model: "nope-model-9" });
    assert.equal(res.ok, false);
    assert.equal(res.errorClass, "model-not-found", JSON.stringify(res));
    assert.match(String(res.error || ""), /不提供模型/);
    assert.equal(mock.countOf("session/prompt"), 0);
  } finally { closeAllAcpClients(); }
});

// ── prompt 阶段不重试 ────────────────────────────────────────────────
test("P0-3 prompt 阶段 429 不重试：只发 1 次 prompt，部分正文落盘、error 说清部分执行", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), {
    promptPartialText: "partial text here",
    promptErrors: [{ code: 429, message: "Too many requests" }],
  });
  try {
    const { res, events, dir } = await drive(mock);
    assert.equal(res.ok, false);
    assert.equal(res.errorClass, "rate-limit", JSON.stringify(res));
    assert.equal(res.retryable, false, "prompt 阶段的 retryable 一律 false");
    assert.equal(mock.countOf("session/prompt"), 1, "prompt 阶段绝不自动重发");
    const errEv = events.find((e) => e.type === "error");
    assert.ok(errEv, "应发 error 事件");
    assert.match(errEv.message, /部分执行/, JSON.stringify(errEv));
    assert.match(errEv.message, /稍等一会儿再试/, JSON.stringify(errEv));
    assert.ok(String(errEv.detail || "").includes("Too many requests"), "detail 保留原文");
    const jsonl = acpSessionFile(dir, res.sessionId);
    assert.ok(fs.existsSync(jsonl), "部分回合必须落盘");
    assert.ok(fs.readFileSync(jsonl, "utf8").includes("partial text here"), "部分正文必须在落盘里");
  } finally { closeAllAcpClients(); }
});

test("P0-3 prompt 超时不重试：假死 mock + 800ms 超时，1 次 prompt、error 含 timeout", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), { promptHang: true });
  try {
    const t0 = Date.now();
    const { res, events } = await drive(mock);
    const dt = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.match(String(res.error || ""), /timeout/i);
    assert.equal(res.errorClass, "timeout", JSON.stringify(res));
    assert.equal(res.retryable, false);
    assert.equal(mock.countOf("session/prompt"), 1);
    assert.ok(dt < 10000, `应在默认超时内返回，实际 ${dt}ms`);
    assert.ok(!events.some((e) => e.type === "phase" && e.phase === "retry"), "prompt 超时不得发 retry 事件");
  } finally { closeAllAcpClients(); }
});

// ── set_config_option ────────────────────────────────────────────────
test("P0-3 set_config_option 模型被拒：发 note、回合照常完成", { timeout: 15000 }, async () => {
  const mock = makeMock(freshDir("mock"), {
    setConfigOptionErrors: [{ code: 404, message: "model gemini-4-neon not found" }],
  });
  try {
    const { res, events } = await drive(mock);
    assert.equal(res.ok, true, res.error || JSON.stringify(events));
    const note = events.find((e) => e.type === "note" && e.key === "acp-model-rejected");
    assert.ok(note, "模型被拒必须发 note（不能再 .catch(()=>{}) 吞掉）: " + JSON.stringify(events));
    assert.match(note.text, /gemini-4-neon/);
    assert.match(note.text, /已按原模型继续/);
  } finally { closeAllAcpClients(); }
});

// ── login 探针超时 ───────────────────────────────────────────────────
// 假 agy：mode 文件控制行为。sleep 模式写 pid 进列表文件后睡 30s；
// quota 模式回合法的 /usage 与 /credits JSON。PATHS.agy（CCAPP_AGY）
// 指向它，login.mjs 的探针直接调它。
function writeProbeBin() {
  const modeFile = probeBin + ".mode";
  const pidFile = probeBin + ".pids";
  fs.writeFileSync(probeBin, `#!${process.execPath}
const fs = require("node:fs");
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
if (mode === "sleep") { setTimeout(() => process.exit(0), 30000); return; }
if (mode === "quota") {
  const arg = process.argv[process.argv.length - 1];
  if (arg === "/usage") {
    process.stdout.write(JSON.stringify({ command: { data: { groups: [{ name: "Gemini", buckets: [
      { window: "5h", remaining_fraction: 0.5, reset_time: "2026-11-22T00:00:00Z" },
      { window: "weekly", remaining_fraction: 0.8, reset_time: "2026-11-23T00:00:00Z" },
    ] }] } } }));
    return;
  }
  if (arg === "/credits") {
    process.stdout.write(JSON.stringify({ command: { data: { remaining_credits: 123 } } }));
    return;
  }
}
process.exit(1);
`, { mode: 0o755 });
  const setMode = (m) => fs.writeFileSync(modeFile, m, "utf8");
  const pids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const alivePids = () => pids().filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  return { setMode, alivePids };
}

test("P0-3 探针超时：假 bin 睡 30s 时 fetchAgyQuota 与 authStatus 都提前返回、无残留子进程", { timeout: 60000 }, async () => {
  const probe = writeProbeBin();
  // 先用 quota 模式跑一次：缓存一份真额度，后面 sleep 时应原样返回它
  probe.setMode("quota");
  const first = await login.fetchAgyQuota(true);
  assert.ok(first && Array.isArray(first.groups) && first.groups.length, "quota 模式应解析出额度组: " + JSON.stringify(first));
  assert.equal(first.groups[0].fiveHour.remaining, 50);

  probe.setMode("sleep");
  const t0 = Date.now();
  const second = await login.fetchAgyQuota(true);
  const dtQuota = Date.now() - t0;
  assert.ok(dtQuota < 5000, `fetchAgyQuota 应在覆盖超时（400ms）附近返回，实际 ${dtQuota}ms`);
  assert.deepEqual(second, first, "探针超时应返回上一次缓存的额度，而不是挂起或清空");

  const t1 = Date.now();
  const st = await login.authStatus(true);
  const dtAuth = Date.now() - t1;
  assert.ok(dtAuth < 20000, `authStatus 应在 execFile 10s 超时内返回（远早于 30s 睡眠），实际 ${dtAuth}ms`);
  assert.ok(st && typeof st.loggedIn === "boolean", JSON.stringify(st));

  const alive = probe.alivePids();
  assert.deepEqual(alive, [], "探针超时的子进程必须被杀干净，不得残留: " + alive.join(","));
});
