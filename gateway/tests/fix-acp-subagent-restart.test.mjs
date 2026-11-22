import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import {
  acpChildActive,
  classifyAcpTool,
  closeAllAcpClients,
  getAcpPoolBg,
  runAcpTurn,
  translateAcpUpdate,
} from "../gw/acp.mjs";

const tmpDir = fs.mkdtempSync(path.join(CFG.workspace, "acp-restart-"));
after(() => {
  closeAllAcpClients();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("classifyAcpTool 识别真实 agy acp 的 Run 前缀标题与命令行标题", () => {
  assert.equal(classifyAcpTool("Run invoke_subagent", { TypeName: "research", Prompt: "audit" }), "invoke_subagent");
  assert.equal(classifyAcpTool("Run send_message", { Recipient: "c1", Message: "hi" }), "send_message");
  assert.equal(classifyAcpTool("Run manage_subagents", { Action: "kill_all" }), "manage_subagents");
  assert.equal(classifyAcpTool("Run schedule", { DurationSeconds: 60, Prompt: "ping" }), "schedule");
  assert.equal(classifyAcpTool("Run manage_task", { Action: "kill", TaskId: "t1" }), "manage_task");
  assert.equal(classifyAcpTool("echo hello && ls -la", { CommandLine: "echo hello && ls -la", IsDaemon: true }), "run_command");
  assert.equal(classifyAcpTool("CustomTitle", { TypeName: "research", Prompt: "audit" }), "invoke_subagent");
});

test("Run invoke_subagent 空输出或 JSON 输出必须留在 bgTasks 中，不被误判为前台完成", () => {
  const bg = new Map();
  const evs = [];
  const state = {
    sessionId: "sess-run-sub-1",
    cwd: tmpDir,
    text: "",
    thinking: "",
    tools: new Map(),
    knownToolIds: new Set(),
    usage: null,
    promptSent: true,
    permMode: "default",
    onBgAdd: (t) => bg.set(t.id, t),
    onBgRemove: (id) => bg.delete(id),
    onCommands: () => {},
  };
  const emit = (e) => evs.push(e);

  // Case 1: 真实 agy acp 场景 —— title="Run invoke_subagent", rawOutput=""
  translateAcpUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-empty",
      title: "Run invoke_subagent",
      rawInput: { Role: "Android Bug Hunter", TypeName: "research", Prompt: "scan" },
      status: "in_progress",
    },
  }, state, emit);
  translateAcpUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-empty",
      status: "completed",
      rawOutput: "",
    },
  }, state, emit);

  assert.ok(bg.has("tc-empty"), "空输出的 Run invoke_subagent 应继续留在 bgTasks");
  assert.equal(evs.filter((e) => e.type === "ag" && e.k === "spawn").length, 1, "应发射 ag spawn");
  assert.equal(evs.filter((e) => e.type === "ag" && e.k === "done").length, 0, "后台启动不应误发 ag done");

  // Case 2: 返回 JSON {conversationId, logAbsoluteUri}（不含 background/running 字样）
  translateAcpUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-json",
      title: "Run invoke_subagent",
      rawInput: { Role: "Gateway Bug Hunter", TypeName: "research", Prompt: "scan gw" },
      status: "in_progress",
    },
  }, state, emit);
  translateAcpUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-json",
      status: "completed",
      rawOutput: JSON.stringify({ result: { conversationId: "28f7e671-b188-459a-b115-4fb15f8369c3", logAbsoluteUri: "file:///tmp/t.jsonl" } }),
    },
  }, state, emit);

  assert.equal(bg.size, 2, "两个并行子代理都应留在 bgTasks");
  assert.equal(state.acpAgentsByConv.get("28f7e671-b188-459a-b115-4fb15f8369c3"), "tc-json");
});

test("acpChildActive 通过 acp-server-*-<pid>.log 近期写入识别常驻进程仍在干活", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-log-"));
  try {
    const pid = 998877;
    const logFile = path.join(logDir, `acp-server-20261123_010732-${pid}.log`);
    fs.writeFileSync(logFile, "streaming...\n");
    const now = Date.now();
    const fresh = acpChildActive(pid, -1, now, logDir);
    assert.equal(fresh.active, true);
    assert.equal(fresh.reason, "log");

    // 5 分钟前的旧日志不算活跃
    const oldTime = new Date(now - 5 * 60e3);
    fs.utimesSync(logFile, oldTime, oldTime);
    const stale = acpChildActive(pid, -1, now, logDir);
    assert.equal(stale.active, false);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("多子代理并发时，第一个子代理空闲回报不清空仍在运行的第二个子代理", async () => {
  const mockBin = path.join(tmpDir, "mock-acp-multi-sub.mjs");
  fs.writeFileSync(mockBin, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (msg.method === "session/new") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-multi-sub" } });
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "sub-a", title: "Run invoke_subagent", rawInput: { Role: "AlphaHunter", TypeName: "research", Prompt: "a" }, status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "sub-a", status: "completed", rawOutput: "" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "sub-b", title: "Run invoke_subagent", rawInput: { Role: "BetaHunter", TypeName: "research", Prompt: "b" }, status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "sub-b", status: "completed", rawOutput: "" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已启动两个子代理" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    // 100ms 后只有 AlphaHunter 先回报
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "AlphaHunter 已完成汇报" } } } });
    }, 100);
  }
});
`, { mode: 0o755 });

  const run = { id: "r-multi", bgList: [], bgTasks: 0 };
  const res = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "launch two",
    run,
    emit: () => {},
    keepAlive: true,
  });
  assert.equal(res.ok, true);
  assert.equal(getAcpPoolBg("sess-multi-sub").length, 2, "回合结束时两个子代理都应在池内 bgTasks 中");

  // 等待 100ms 唤醒 + 1500ms flushIdle 防抖
  await new Promise((r) => setTimeout(r, 1900));
  const rem = getAcpPoolBg("sess-multi-sub");
  assert.equal(rem.length, 1, "只应结算先回报的 AlphaHunter，保留 BetaHunter；实际：" + JSON.stringify(rem));
  assert.equal(rem[0].id, "sub-b");
});
