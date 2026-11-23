import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { SESSIONS } from "../gw/runs.mjs";
import { sessModel, effectiveModel, flushSessModel } from "../gw/sessmodel.mjs";
import { looksBackground } from "../gw/sessmanaged.mjs";
import { noteAcpInit, execIntent } from "../gw/run.mjs";
import {
  classifyAcpTool,
  closeAllAcpClients,
  getAcpPoolBg,
  runAcpTurn,
  stopAcpBgTask,
  translateAcpUpdate,
} from "../gw/acp.mjs";

const tmpDir = fs.mkdtempSync(path.join(CFG.workspace, "acp-pin-bg-"));
after(() => {
  closeAllAcpClients();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("noteAcpInit：ACP 新会话拿到会话号时落盘 pin 模型/思考强度、登记受管与 SESSIONS，次轮不掉回全局默认", () => {
  const sid = "acp-pin-" + Date.now();
  const item = {
    id: "r-pin-1",
    message: "你好文酱",
    sessionId: null,
    pin: { model: "claude-opus-5-5", effort: "high", provider: "antigravity" },
    projectId: null,
  };
  const run = {
    id: item.id,
    text: item.message,
    sessionId: null,
    log: [{ type: "run_start", text: item.message, sessionId: null }],
  };

  noteAcpInit(run, sid, item);
  flushSessModel();

  const pinned = sessModel(sid);
  assert.ok(pinned, "新会话首条带来的 pin 应写入 sessModel");
  assert.equal(pinned.model, "claude-opus-5-5");
  assert.equal(pinned.effort, "high");
  assert.equal(pinned.provider, "antigravity");

  // 模拟第 2 轮普通续聊（无 pin），应继续沿用已钉住的 claude-opus-5-5 + high
  const nextIntent = execIntent({ id: "r-pin-2", message: "请审这段 diff", sessionId: sid });
  assert.equal(nextIntent.model, "claude-opus-5-5");
  assert.equal(nextIntent.effort, "high");
  assert.equal(effectiveModel(sid).model, "claude-opus-5-5");

  assert.equal(SESSIONS.has(sid), true, "应登记到 SESSIONS 防首轮未落盘时被队列误丢");
  assert.equal(looksBackground(sid, Date.now(), ""), false, "noteManaged 后不应被误归入外部后台杂项");
});

test("run_command 后台任务识别：已同步退出的 rg/cat 输出含 background task / TaskId 不误挂；真实带斜杠 task id 完整保留且可被 manage_task 清理", () => {
  const bg = new Map();
  const state = {
    sessionId: "sess-bg-filter",
    cwd: tmpDir,
    text: "",
    thinking: "",
    tools: new Map(),
    knownToolIds: new Set(),
    usage: null,
    promptSent: true,
    permMode: "bypassPermissions",
    onBgAdd: (t) => bg.set(t.id, t),
    onBgRemove: (id) => bg.delete(id),
    onBgClearTasks: () => {
      for (const [k, v] of bg) if (v.type !== "agent" && v.type !== "workflow") bg.delete(k);
    },
    onCommands: () => {},
  };
  const emit = () => {};

  // 1. 普通同步退出的 rg 命令（甚至带超长截断头），正文里含 background task / running in the background / TaskId
  translateAcpUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-sync-rg",
      title: "rg -n background gateway/",
      rawInput: { CommandLine: "rg -n background gateway/", toolSummary: "Search gateway API usage" },
      status: "completed",
      rawOutput: [
        "The tool's output was truncated due to being too long.",
        "Created At: 2026-11-23T15:58:57+08:00",
        "Completed At: 2026-11-23T15:58:59+08:00",
        "Command exited with code 0.",
        "",
        "Command output:",
        "acp.mjs:640: running in the background | background task | TaskId=fake-123",
      ].join("\n"),
    },
  }, state, emit);
  assert.equal(bg.size, 0, "已同步退出的前台命令绝不能误挂进 bgTasks");

  // 2. 真实 agy 异步转后台命令：task id 带会话前缀与斜杠，且 rawInput 无 toolSummary 时回退 title
  const realTaskId = "0c688e24-b1b2-443a-8bc8-89a32fc66955/task-281";
  translateAcpUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-real-bg",
      title: "Run node scripts/long-job.mjs",
      rawInput: {},
      status: "completed",
      rawOutput: [
        `Tool is running as a background task with task id: ${realTaskId}`,
        "Task logs are available at: file:///tmp/task-281.log",
        "Log output:",
        "starting...",
      ].join("\n"),
    },
  }, state, emit);
  assert.equal(bg.size, 1);
  assert.ok(bg.has(realTaskId), "带斜杠的完整 task id 不可被截断");
  assert.equal(bg.get(realTaskId).desc, "node scripts/long-job.mjs", "缺 toolSummary 时应用命令行标题兜底而非笼统写后台命令");

  // 3. 同时挂一个子代理，验证 manage_task(list) 空列表只清 shell/monitor，不误清子代理
  bg.set("sub-keep", { id: "sub-keep", type: "agent", desc: "Code Reviewer" });
  translateAcpUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-mt-list",
      title: "Run manage_task",
      rawInput: { Action: "list" },
      status: "completed",
      rawOutput: "No background tasks are currently running.",
    },
  }, state, emit);
  assert.equal(classifyAcpTool("CustomTitle", { Action: "list" }, "No background tasks are currently running."), "manage_task");
  assert.equal(bg.has(realTaskId), false, "manage_task list 报告无后台任务时应清掉残留 shell 任务");
  assert.equal(bg.has("sub-keep"), true, "子代理不应被 manage_task list 误清");
});

test("轮次进行中停掉 ACP 后台任务：首轮与复用轮收尾后均不复活，且不误杀在跑常驻进程", async () => {
  const mockBin = path.join(tmpDir, "mock-acp-bgstop.mjs");
  fs.writeFileSync(mockBin, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let turn = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-bgstop-live" } });
  if (msg.method === "session/prompt") {
    turn++;
    const sid = msg.params.sessionId;
    if (turn === 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "c1", title: "run_command",
        rawInput: { CommandLine: "sleep 30", toolSummary: "Slow task" },
        status: "completed",
        rawOutput: "Tool is running as a background task with task id: sess-bgstop-live/task-1",
      } } });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "turn1" } } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 200);
    } else {
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "turn2" } } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 250);
    }
  }
});
`, { mode: 0o755 });

  // 第 1 轮建成常驻池并留下 1 个后台任务
  const run1 = { id: "r-bg-1", bgList: [], bgTasks: 0 };
  const r1 = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "go 1",
    run: run1,
    emit: () => {},
    keepAlive: true,
  });
  assert.equal(r1.ok, true);
  assert.equal(getAcpPoolBg("sess-bgstop-live").length, 1);
  assert.equal(getAcpPoolBg("sess-bgstop-live")[0].id, "sess-bgstop-live/task-1");

  // 第 2 轮复用常驻进程进行中，用户点「停止」移除该后台任务
  const run2 = { id: "r-bg-2", sessionId: "sess-bgstop-live", bgList: [], bgTasks: 0 };
  const p2 = runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    sessionId: "sess-bgstop-live",
    prompt: "go 2",
    run: run2,
    emit: () => {},
    keepAlive: true,
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(stopAcpBgTask("sess-bgstop-live", "sess-bgstop-live/task-1"), true);
  const r2 = await p2;
  assert.equal(r2.ok, true, "进行中停单个后台任务不应杀掉正在跑的常驻 ACP 进程");
  assert.equal(getAcpPoolBg("sess-bgstop-live").length, 0, "第 2 轮收尾后已停掉的后台任务不得被局部 bgTasks 盖回复活");
});

test("session/prompt 默认无活动超时按流式活跃度与权限等待滑窗续期，不误杀长任务，真假死照常超时", { timeout: 15000 }, async () => {
  const mockBin = path.join(tmpDir, "mock-agy-sliding");
  fs.writeFileSync(mockBin, `#!${process.execPath}
const readline = require("node:readline");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let lastPromptId = null;
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-sliding-1", models: { currentModelId: "gemini-4-neon" } } });
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    const text = msg.params?.prompt?.[0]?.text || "";
    if (text === "stream-long") {
      // 总耗时 ~480ms > idleTimeoutMs (200ms) 的 2.4 倍，但每 80ms 有 session/update 续期
      let n = 0;
      const iv = setInterval(() => {
        n++;
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-sliding-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m-slide", content: { type: "text", text: "step" + n + " " } } } });
        if (n >= 5) {
          clearInterval(iv);
          setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }), 80);
        }
      }, 80);
      return;
    }
    if (text === "perm-wait") {
      // 发起权限请求后等待用户 350ms > idleTimeoutMs (180ms)，因 askPermission 等待中豁免超时
      send({ jsonrpc: "2.0", id: "perm-req-1", method: "session/request_permission", params: { sessionId: "sess-sliding-1", toolCall: { title: "run_command", toolCallId: "tc-p1" }, options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow" }] } });
      return;
    }
    if (text === "dead-hang") {
      return; // 完全死寂
    }
  }
  if (msg.id === "perm-req-1" && lastPromptId != null) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-sliding-1", update: { sessionUpdate: "agent_message", messageId: "m-perm", content: { type: "text", text: "approved" } } } });
    send({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
  }
});
`, { mode: 0o755 });

  // 1. 持续输出 session/update 的长任务（总时长 > 2.4x idleTimeoutMs）不应被一刀切误杀
  const rStream = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "stream-long",
    run: { id: "r-slide-1", bgList: [], bgTasks: 0 },
    emit: () => {},
    idleTimeoutMs: 200,
    keepAlive: false,
  });
  assert.equal(rStream.ok, true, `持续活跃流式轮次不应被超时误杀: ${rStream.error || ""}`);
  assert.match(rStream.resultText, /step5/);

  // 2. 等待用户审批权限（run.perms 非空）超过 idleTimeoutMs 时不应误判为 Agent 假死
  const runPerm = { id: "r-slide-perm", perms: new Map(), bgList: [], bgTasks: 0 };
  const rPerm = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "perm-wait",
    permMode: "default",
    run: runPerm,
    emit: () => {},
    idleTimeoutMs: 180,
    keepAlive: false,
    askPermission: async () => {
      runPerm.perms.set("p1", { id: "p1" });
      await new Promise((r) => setTimeout(r, 340));
      runPerm.perms.delete("p1");
      return { behavior: "allow" };
    },
  });
  assert.equal(rPerm.ok, true, `等待权限确认期间不应误触发假死超时: ${rPerm.error || ""}`);
  assert.equal(rPerm.resultText, "approved");

  // 3. 完全死寂无消息、无权限等待、无 CPU 活动时，仍在 idleTimeoutMs 到期后准时报错
  const rHang = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "dead-hang",
    run: { id: "r-slide-hang", bgList: [], bgTasks: 0 },
    emit: () => {},
    idleTimeoutMs: 200,
    keepAlive: false,
  });
  assert.equal(rHang.ok, false);
  assert.match(String(rHang.error || ""), /ACP request timeout: session\/prompt/);
});
