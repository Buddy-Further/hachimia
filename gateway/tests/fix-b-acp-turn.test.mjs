// B 分片修复测试（端到端 mock agy）：B1/B3/B5/B8/B9/B10/B11
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { runAcpTurn, stopAcpBgTask, closeAllAcpClients } from "../gw/acp.mjs";

// 模拟 agy acp：模式由 MOCK_MODE 选；收到的全部请求行记进 MOCK_LOG
function makeMockAgy(dir) {
  const script = path.join(dir, "mock-agy-b");
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.env.MOCK_MODE || "dup";
const logFile = process.env.MOCK_LOG || "/tmp/b-mock.log";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => process.exit(0)); // 网关关掉 stdin 即退出，不留孤儿进程拖住测试进程
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  fs.appendFileSync(logFile, t + "\\n");
  let msg; try { msg = JSON.parse(t); } catch { return; }
  const sid = msg.params?.sessionId || "agy-sess-001";
  if (msg.method === "initialize") {
    const caps = mode === "switch" ? {} : { loadSession: true };
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: caps, authMethods: [] } });
  }
  if (msg.method === "authenticate") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/new") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: mode === "switch" ? "agy-sess-NEW" : "agy-sess-001", models: { currentModelId: "gemini-4-neon" } } });
  }
  if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId, models: { currentModelId: "gemini-4-neon" } } });
    if (mode === "latereplay") {
      setTimeout(() => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message", messageId: "msg-old-9", content: { type: "text", text: "旧回复" } } } }), 300);
    }
    return;
  }
  if (msg.method === "session/resume") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } });
  if (msg.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/set_mode") {
    if (mode === "slow") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown mode" } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/cancel") return;
  if (msg.method === "session/prompt") {
    if (mode === "slow") {
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "慢回复" } } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 5000);
      return;
    }
    if (mode === "dup") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message", messageId: "m1", content: { type: "text", text: "你好世界" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "你好世界" } } } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    if (mode === "latereplay") {
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "本轮正文" } } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 700);
      return;
    }
    if (mode === "crash") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "半截正文" } } } });
      setTimeout(() => process.exit(1), 100);
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "新会话正文" } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`, { mode: 0o755 });
  return script;
}

function runOpts(mockBin, logFile, extra = {}) {
  return {
    bin: process.execPath,
    args: [mockBin],
    cwd: CFG.workspace,
    env: { ...process.env, MOCK_LOG: logFile },
    run: { id: "r-b-" + Math.random().toString(36).slice(2, 8), bgList: [], bgTasks: 0 },
    emit: () => {},
    keepAlive: false,
    ...extra,
  };
}
const jsonlOf = (sid) => path.join(PATHS.projects, String(CFG.workspace).replace(/[^A-Za-z0-9]/g, "-"), `${sid}.jsonl`);
const countMethod = (logFile, method) => {
  try {
    return (fs.readFileSync(logFile, "utf8").match(new RegExp(method.replace("/", "\\/"), "g")) || []).length;
  } catch { return 0; }
};

test("B1 端到端：agent_message 整条 + 同文 chunk 只落盘一份正文", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-b-dup-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  const evs = [];
  try {
    const r = await runAcpTurn(runOpts(mockBin, logFile, { prompt: "hi", emit: (e) => evs.push(e) }));
    assert.equal(r.ok, true, r.error || "");
    assert.equal(r.resultText, "你好世界");
    const lines = fs.readFileSync(jsonlOf(r.sessionId), "utf8");
    assert.ok(!lines.includes("你好世界你好世界"), "jsonl 不应含翻倍正文");
    assert.ok(lines.includes("你好世界"));
  } finally { closeAllAcpClients(); }
});

test("B3 端到端：load 返回后 300ms 才到的历史重放不混进本轮", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-b-replay-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  process.env.MOCK_MODE = "latereplay";
  try {
    const r = await runAcpTurn(runOpts(mockBin, logFile, { prompt: "请继续", sessionId: "old-sess-xyz" }));
    assert.equal(r.ok, true, r.error || "");
    assert.equal(r.resultText, "本轮正文");
    const lines = fs.readFileSync(jsonlOf(r.sessionId), "utf8");
    assert.ok(!lines.includes("旧回复"), "jsonl 不应含重放旧文");
  } finally { delete process.env.MOCK_MODE; closeAllAcpClients(); }
});

test("B5 端到端：回合中途崩溃，提问与半截正文仍落盘", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-b-crash-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  process.env.MOCK_MODE = "crash";
  try {
    const r = await runAcpTurn(runOpts(mockBin, logFile, { prompt: "请回答一个问题" }));
    assert.equal(r.ok, false);
    const file = jsonlOf(r.sessionId);
    assert.ok(fs.existsSync(file), "失败回合也应落盘 jsonl");
    const lines = fs.readFileSync(file, "utf8");
    assert.ok(lines.includes("请回答一个问题"), "提问应落盘");
    assert.ok(lines.includes("半截正文"), "已流出的正文应落盘");
  } finally { delete process.env.MOCK_MODE; closeAllAcpClients(); }
});

test("B8 端到端：agent 不支持 resume/load 时新建会话要明示切换，不再静默", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-b-switch-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  process.env.MOCK_MODE = "switch";
  const evs = [];
  try {
    const r = await runAcpTurn(runOpts(mockBin, logFile, { prompt: "hi", sessionId: "old-sess-xyz", emit: (e) => evs.push(e) }));
    assert.equal(r.ok, true, r.error || "");
    assert.equal(r.sessionId, "agy-sess-NEW");
    assert.equal(r.sessionSwitched, true);
    assert.ok(evs.some((e) => e.type === "note" && e.key === "acp-session-switched"), "应发出会话切换提示");
  } finally { delete process.env.MOCK_MODE; closeAllAcpClients(); }
});

test("B9 端到端：停单个后台任务不给整个会话发 session/cancel", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-b-bg-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  process.env.MOCK_MODE = "bgcancel";
  try {
    const r1 = await runAcpTurn(runOpts(mockBin, logFile, { prompt: "hi", keepAlive: true }));
    assert.equal(r1.ok, true, r1.error || "");
    const ok = stopAcpBgTask(r1.sessionId, "task-1");
    assert.equal(ok, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(countMethod(logFile, "session/cancel"), 0, "停单个后台任务不应发 session/cancel");
  } finally { delete process.env.MOCK_MODE; closeAllAcpClients(); }
});

test("B10+B11 端到端：set_mode 被拒返回 false 并报错；点停止不销毁保活进程，下轮复用", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-b-slow-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  process.env.MOCK_MODE = "slow";
  const evs = [];
  let run, run2;
  try {
    run = { id: "r-b-slow", bgList: [], bgTasks: 0 };
    const p = runAcpTurn(runOpts(mockBin, logFile, { prompt: "slow hi", sessionId: "sess-slow-1", keepAlive: true, run, emit: (e) => evs.push(e) }));
    const waitPromptDeadline = Date.now() + 4000;
    while (countMethod(logFile, "session/prompt") < 1 && Date.now() < waitPromptDeadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    const smRet = await run.setMode("plan");
    assert.equal(smRet, false, "set_mode 被拒应返回 false");
    assert.ok(evs.some((e) => e.type === "error"), "set_mode 被拒应发 error 事件");
    assert.equal(countMethod(logFile, "initialize"), 1);
    run.aborted = true;
    run.cancelAcp?.();
    const res = await p;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(countMethod(logFile, "session/cancel"), 1, "停止应只发一次 session/cancel");
    run2 = { id: "r-b-slow2", bgList: [], bgTasks: 0 };
    const r2 = await runAcpTurn(runOpts(mockBin, logFile, { prompt: "again", sessionId: "sess-slow-1", keepAlive: true, run: run2, emit: () => {} }));
    assert.equal(r2.ok, true, r2.error || "");
    assert.equal(countMethod(logFile, "initialize"), 1, "取消后下轮应复用保活进程，不应重新 initialize");
  } finally {
    delete process.env.MOCK_MODE;
    try { run.child?.kill("SIGKILL"); } catch {}
    try { run2?.child?.kill("SIGKILL"); } catch {}
    closeAllAcpClients();
  }
});
