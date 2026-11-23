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
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      if (process.env.HANG_SUB_PID_FILE) fs.writeFileSync(process.env.HANG_SUB_PID_FILE, String(sub.pid));
      return; // 完全死寂且挂着未退出的孙进程（复现首轮后台脚本未退导致的孤儿残留）
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

  // 3. 完全死寂无消息、无权限等待、无 CPU 活动时，仍在 idleTimeoutMs 到期后准时报错，且未入池销毁时必须连同进程组孙进程一并回收
  const hangSubPidFile = path.join(tmpDir, "hang-sub.pid");
  const rHang = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env, HANG_SUB_PID_FILE: hangSubPidFile },
    prompt: "dead-hang",
    run: { id: "r-slide-hang", bgList: [], bgTasks: 0 },
    emit: () => {},
    idleTimeoutMs: 200,
    keepAlive: false,
  });
  assert.equal(rHang.ok, false);
  assert.match(String(rHang.error || ""), /ACP request timeout: session\/prompt/);
  const hangSubPid = Number(fs.readFileSync(hangSubPidFile, "utf8").trim());
  assert.ok(hangSubPid > 0, "应记录假死轮次派生的孙进程 PID");
  let subAlive = true;
  for (let i = 0; i < 20; i++) {
    try { process.kill(hangSubPid, 0); await new Promise((r) => setTimeout(r, 30)); }
    catch { subAlive = false; break; }
  }
  assert.equal(subAlive, false, "非入池轮次超时销毁时 destroyClient 必须整组回收派生的孤儿孙进程");
});

test("一次性 schedule(DurationSeconds) 与 manage_task(status)：Wait cancelled 不入表、TimerCondition 随目标任务联动消退、墙钟到期自动清扫、Cron 持久保留", async () => {
  const mockBin = path.join(tmpDir, "mock-acp-sched-oneshot.mjs");
  fs.writeFileSync(mockBin, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-sched-oneshot" } });
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const text = msg.params.prompt?.[0]?.text || "";
    if (text === "turn-arm") {
      // 1) 已取消的 schedule 不入表
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "sc-cancelled", title: "Run schedule",
        rawInput: { DurationSeconds: 60, Prompt: "Cancelled timer" },
        status: "completed", rawOutput: "Wait cancelled (task already finished).",
      } } });
      // 2) 后台命令 task-966 + 绑定它的 TimerCondition 一次性定时器（真实 agy rawOutput 为空串）
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "cmd-966", title: "Run test suite",
        rawInput: { CommandLine: "node test.mjs", toolSummary: "Run test suite" },
        status: "completed", rawOutput: "Tool is running as a background task with task id: sess-sched-oneshot/task-966",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "sc-cond-966", title: "Run schedule",
        rawInput: { DurationSeconds: 90, Prompt: "Check task-966", TimerCondition: "sess-sched-oneshot/task-966" },
        status: "completed", rawOutput: "",
      } } });
      // 3) 短时长 0.08s 一次性定时器（测试墙钟自动过期，不挂死前端条）
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "sc-short", title: "Run schedule",
        rawInput: { DurationSeconds: 0, Prompt: "Quick 0s timer" },
        status: "completed", rawOutput: "",
      } } });
      // 4) 周期性 CronExpression 定时任务（应持久保留）
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "sc-cron", title: "Run schedule",
        rawInput: { CronExpression: "*/5 * * * *", Prompt: "Periodic check" },
        status: "completed", rawOutput: "",
      } } });
      // 5) 另一会话同尾号的 TimerCondition（验证 P2-2 不被本会话 task-966 误联动删除）与一个未到期的长时 oneShot（验证 P1-2 不被无关唤醒误摘）
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "sc-other-sess-966", title: "Run schedule",
        rawInput: { DurationSeconds: 180, Prompt: "Other session timer", TimerCondition: "other-sess/task-966" },
        status: "completed", rawOutput: "",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "sc-long-never", title: "Run schedule",
        rawInput: { DurationSeconds: 180, Prompt: "Long 3m reminder" },
        status: "completed", rawOutput: "",
      } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else if (text === "turn-status-running-notfound-in-log") {
      // P1-4：任务仍在 RUNNING，但日志正文里含 "command not found" / "404 Not Found" —— 绝不能误删在跑任务
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "mt-st-running", title: "Run manage_task",
        rawInput: { Action: "status", TaskId: "sess-sched-oneshot/task-966" },
        status: "completed",
        rawOutput: "Task: sess-sched-oneshot/task-966\\nStatus: RUNNING\\n\\nLog output:\\nsh: foo: command not found\\nHTTP 404 Not Found\\nis not running yet\\n",
      } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else if (text === "turn-status-done") {
      // manage_task(status) 报告 task-966 已 DONE：应把 task-966 及其 TimerCondition 绑定的 sc-cond-966 一并摘除，但不碰 sc-other-sess-966
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "mt-st-966", title: "Run manage_task",
        rawInput: { Action: "status", TaskId: "sess-sched-oneshot/task-966" },
        status: "completed", rawOutput: "Task: sess-sched-oneshot/task-966\\nStatus: DONE\\n",
      } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      // 空闲期模拟收到一条与长定时器无关的唤醒消息（如跨会话问候），长定时器 sc-long-never 不得被提前误摘（P1-2）
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "agent_message_chunk", messageId: "idle-msg-1",
          content: { type: "text", text: "Unrelated peer greeting while timer is still pending." },
        } } });
      }, 60);
    }
  }
});
`, { mode: 0o755 });

  let lastBgSnapshots = [];
  const r1 = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "turn-arm",
    run: { id: "r-sc-1", bgList: [], bgTasks: 0 },
    emit: () => {},
    onBgChange: (list) => { lastBgSnapshots = list; },
    keepAlive: true,
  });
  assert.equal(r1.ok, true);
  const bgAfterArm = getAcpPoolBg("sess-sched-oneshot").map((x) => x.id);
  assert.ok(!bgAfterArm.includes("sc-cancelled"), "Wait cancelled 的一次性定时器不应挂入后台任务条");
  assert.ok(bgAfterArm.includes("sess-sched-oneshot/task-966"));
  assert.ok(bgAfterArm.includes("sc-cond-966"));
  assert.ok(bgAfterArm.includes("sc-short"));
  assert.ok(bgAfterArm.includes("sc-cron"));
  assert.ok(bgAfterArm.includes("sc-other-sess-966"));
  assert.ok(bgAfterArm.includes("sc-long-never"));
  assert.doesNotThrow(() => JSON.stringify(getAcpPoolBg()), "getAcpPoolBg 返回结构必须可安全 JSON 序列化");

  // 第 1.5 轮：RUNNING 任务的日志正文含 "not found" 时不得误摘
  const rRunLog = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    sessionId: "sess-sched-oneshot",
    prompt: "turn-status-running-notfound-in-log",
    run: { id: "r-sc-runlog", sessionId: "sess-sched-oneshot", bgList: [], bgTasks: 0 },
    emit: () => {},
    onBgChange: (list) => { lastBgSnapshots = list; },
    keepAlive: true,
  });
  assert.equal(rRunLog.ok, true);
  assert.ok(getAcpPoolBg("sess-sched-oneshot").some((x) => x.id === "sess-sched-oneshot/task-966"), "日志正文含 not found 不得误删 RUNNING 任务");

  // 第 2 轮：manage_task(status) 发现 task-966 已 DONE，联动清掉 sc-cond-966，但保留异会话同号 sc-other-sess-966
  const r2 = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    sessionId: "sess-sched-oneshot",
    prompt: "turn-status-done",
    run: { id: "r-sc-2", sessionId: "sess-sched-oneshot", bgList: [], bgTasks: 0 },
    emit: () => {},
    onBgChange: (list) => { lastBgSnapshots = list; },
    keepAlive: true,
  });
  assert.equal(r2.ok, true);
  const bgAfterStatus = getAcpPoolBg("sess-sched-oneshot").map((x) => x.id);
  assert.ok(!bgAfterStatus.includes("sess-sched-oneshot/task-966"), "status=DONE 的后台命令应被清掉");
  assert.ok(!bgAfterStatus.includes("sc-cond-966"), "绑定已结束任务的 TimerCondition 一次性定时器应联动清掉");
  assert.ok(bgAfterStatus.includes("sc-other-sess-966"), "不同会话前缀的 task-966 定时器不得被误删");
  assert.ok(bgAfterStatus.includes("sc-cron"), "周期性 CronExpression 定时任务应保留");

  // 等待 sc-short (DurationSeconds=0, +1.5s 宽限) 墙钟自动到期清理，同时经历了上面 60ms 的无关 idleBurst (1.5s 防抖 flushIdle)
  await new Promise((r) => setTimeout(r, 1750));
  const bgAfterExpire = getAcpPoolBg("sess-sched-oneshot").map((x) => x.id);
  assert.ok(!bgAfterExpire.includes("sc-short"), "一次性 DurationSeconds 定时器到期后应自动从池中清扫");
  assert.ok(!lastBgSnapshots.some((x) => x.id === "sc-short"), "到期清理应主动回调 onBgChange 刷新前端状态");
  assert.ok(bgAfterExpire.includes("sc-long-never"), "无关空闲唤醒不得把尚未到期的长时一次性定时器提前误摘");
  assert.ok(bgAfterExpire.includes("sc-cron"), "周期性 CronExpression 持久保留");
});
