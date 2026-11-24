import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PATHS } from "../gw/config.mjs";
import {
  acpBgShellActive,
  closeAcpSession,
  closeAllAcpClients,
  getAcpPoolBg,
  listAcpChildren,
  runAcpTurn,
  stopAcpBgTask,
} from "../gw/acp.mjs";
import { usageIsPrompt } from "../gw/usage.mjs";
import { transcriptItems } from "../gw/transcript.mjs";

const tmpDir = fs.mkdtempSync(path.join(CFG.workspace, "acp-bg-wake-"));
after(() => {
  closeAllAcpClients();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeMockAgy(name, body) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

const jsonlOf = (sid) => path.join(PATHS.projects, String(tmpDir).replace(/[^A-Za-z0-9]/g, "-"), `${sid}.jsonl`);

test("acpBgShellActive / listAcpChildren 真实内核 /proc 探测：存活子进程、daemon 豁免、退出后落稳与非法入参保守策略", async () => {
  assert.equal(acpBgShellActive(0).active, true);
  assert.equal(acpBgShellActive(process.pid, { procDir: "/proc-does-not-exist" }).active, true);

  // 真实派生一个短生命周期子进程，验证 /proc 实时识别
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 60));
    const kids = listAcpChildren(process.pid);
    assert.ok(Array.isArray(kids));
    const mine = kids.find((c) => c.pid === child.pid);
    assert.ok(mine, "存活子进程必须出现在 listAcpChildren 中");

    const alive = acpBgShellActive(process.pid, { brainDir: "" });
    assert.equal(alive.active, true);
    assert.equal(alive.reason, "child");

    // 若该子进程已在 daemonChildKeys 中，则不阻塞非常驻 shell 判定
    const otherKids = kids.filter((c) => c.pid !== child.pid).map((c) => c.key);
    const masked = acpBgShellActive(process.pid, {
      daemonChildKeys: new Set([mine.key, ...otherKids]),
      brainDir: "",
    });
    assert.equal(masked.active, false);
    assert.equal(masked.reason, "gone");

    await new Promise((r) => child.once("close", r));
    await new Promise((r) => setTimeout(r, 40));

    const kidsAfter = listAcpChildren(process.pid) || [];
    assert.ok(!kidsAfter.some((c) => c.pid === child.pid), "子进程退出后不应仍在存活列表中");

    // 验证 task-<N>.log 刚写入时保守判定 active，过 1.5s 后判定 gone
    const brain = path.join(tmpDir, "brain-probe");
    const taskDir = path.join(brain, "sess-probe", ".system_generated", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const logPath = path.join(taskDir, "task-42.log");
    fs.writeFileSync(logPath, "done\n");
    const now = Date.now();
    const otherKeys = new Set(kidsAfter.map((c) => c.key));
    const freshLog = acpBgShellActive(process.pid, {
      daemonChildKeys: otherKeys,
      sessionId: "sess-probe",
      tasks: [{ id: "sess-probe/task-42", type: "shell" }],
      now,
      brainDir: brain,
      logSettleMs: 1500,
    });
    assert.equal(freshLog.active, true);
    assert.equal(freshLog.reason, "task-log");

    const old = new Date(now - 3000);
    fs.utimesSync(logPath, old, old);
    const settledLog = acpBgShellActive(process.pid, {
      daemonChildKeys: otherKeys,
      sessionId: "sess-probe",
      tasks: [{ id: "sess-probe/task-42", type: "shell" }],
      now,
      brainDir: brain,
      logSettleMs: 1500,
    });
    assert.equal(settledLog.active, false);
    assert.equal(settledLog.reason, "gone");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
  }
});

test("非常驻后台 shell 子进程退出后若 agy 静默超过宽限窗，自动补唤醒一次且续跑复用进程、不循环、不写假用户气泡", async () => {
  const mockBin = makeMockAgy("mock-bg-silent.mjs", `
import readline from "node:readline";
import { spawn } from "node:child_process";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let initCount = 0;
let turn = 0;
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    initCount++;
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (msg.method === "session/new") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-bg-wake-1" } });
  }
  if (msg.method === "session/prompt") {
    turn++;
    const sid = msg.params.sessionId;
    if (turn === 1) {
      // 真正派生一个约 320ms 后退出的子进程，模拟后台 run_command
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 320)"], { stdio: "ignore" });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-bg-1", title: "long build",
        rawInput: { CommandLine: "node build.mjs" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-bg-1", status: "completed",
        rawOutput: "Tool is running as a background task with task id: sess-bg-wake-1/task-77\\nLog output:\\nbuilding...",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "命令已转入后台，等待完成。" },
      } } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    // 第 2 轮：收到补唤醒，返回继续结果（initCount 仍应为 1）
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已读取 task-77 结果并继续完成（init=" + initCount + "）" },
    } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`);

  const wakes = [];
  const run1 = { id: "r-wake-1", bgList: [], bgTasks: 0 };
  const r1 = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "跑一下构建",
    run: run1,
    emit: () => {},
    keepAlive: true,
    bgPollMs: 40,
    bgGraceMs: 220,
    onBgWake: (ev) => wakes.push(ev),
  });
  assert.equal(r1.ok, true);
  assert.equal(getAcpPoolBg("sess-bg-wake-1").length, 1);

  // 子进程还在跑（前 180ms）绝不误触发
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(wakes.length, 0, "后台命令尚未退出前不得触发补唤醒");

  // 等待子进程退出 + 220ms 宽限窗
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(wakes.length, 1, "退出且静默超宽限窗后应恰好触发一次补唤醒");
  assert.equal(wakes[0].sessionId, "sess-bg-wake-1");
  assert.equal(wakes[0].tasks[0].id, "sess-bg-wake-1/task-77");
  assert.equal(getAcpPoolBg("sess-bg-wake-1").length, 0, "补唤醒时应同步摘除已结束的后台任务");

  // 模拟网关用 auto:"bg" 续跑一轮：复用常驻进程、只落盘助手行、不二次唤醒
  const wakePrompt = "<task-notification>Background shell task completed (task-77). Please inspect the task result and continue.</task-notification>";
  assert.equal(usageIsPrompt(wakePrompt), false, "补唤醒提示词不得计入 usageIsPrompt");
  assert.deepEqual(transcriptItems({ type: "user", message: { role: "user", content: wakePrompt } }), []);

  const run2 = { id: "r-wake-2", auto: "bg", bgList: [], bgTasks: 0 };
  const r2 = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: wakePrompt,
    sessionId: "sess-bg-wake-1",
    run: run2,
    emit: () => {},
    keepAlive: true,
    bgPollMs: 40,
    bgGraceMs: 220,
    onBgWake: (ev) => wakes.push(ev),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.reused, true, "补唤醒轮次必须复用同一常驻 agy acp 进程");
  assert.ok(r2.resultText.includes("init=1"));

  // 再等两个宽限窗，确认绝不会循环补唤醒
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(wakes.length, 1, "同一任务绝不得循环补唤醒");

  const rawJsonl = fs.readFileSync(jsonlOf("sess-bg-wake-1"), "utf8");
  assert.ok(!rawJsonl.includes("<task-notification>"), "auto=bg 续跑不得向会话 jsonl 写入合成用户气泡");
  assert.ok(rawJsonl.includes("已读取 task-77 结果并继续完成"));
  closeAcpSession("sess-bg-wake-1");
});

test("宽限窗内 agy 正常推送 idleBurst 回报时立即让路，绝不重复补唤醒", async () => {
  const mockBin = makeMockAgy("mock-bg-native-wake.mjs", `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-native-wake" } });
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "tool_call", toolCallId: "tc-nat", title: "cmd", rawInput: { CommandLine: "echo ok" }, status: "in_progress",
    } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "tool_call_update", toolCallId: "tc-nat", status: "completed",
      rawOutput: "Tool is running as a background task with task id: sess-native-wake/task-88",
    } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    // 100ms 后（宽限窗 350ms 内）agy 自己发来原生空闲唤醒
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "task-88 已由 agy 原生回报完成" },
      } } });
    }, 100);
  }
});
`);

  const wakes = [];
  const r = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "go",
    run: { id: "r-nat", bgList: [], bgTasks: 0 },
    emit: () => {},
    keepAlive: true,
    bgPollMs: 40,
    bgGraceMs: 350,
    onBgWake: (ev) => wakes.push(ev),
  });
  assert.equal(r.ok, true);
  // 等过原生推送 + 1500ms flushIdle + 额外 300ms
  await new Promise((r) => setTimeout(r, 1950));
  assert.equal(wakes.length, 0, "agy 已自行原生回报时不得重复触发补唤醒");
  assert.equal(getAcpPoolBg("sess-native-wake").length, 0);
  closeAcpSession("sess-native-wake");
});

test("排除 daemon / schedule(monitor) / subagent(agent) 且在复用/手动停止/关闭会话时清理定时器不误触发", async () => {
  const mockBin = makeMockAgy("mock-bg-exclude.mjs", `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: process.env.MOCK_SID || "sess-excl" } });
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    if (process.env.MOCK_KIND === "non-shell") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-d", title: "dev server", rawInput: { CommandLine: "node srv.mjs", IsDaemon: true }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-d", status: "completed",
        rawOutput: "Tool is running as a background task with task id: sess-excl/task-101",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-s", title: "Run schedule", rawInput: { CronExpression: "*/5 * * * *", Prompt: "ping" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-s", status: "completed", rawOutput: "TaskId: cron-1",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-a", title: "Run invoke_subagent", rawInput: { Role: "Auditor", TypeName: "research", Prompt: "audit" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-a", status: "completed", rawOutput: "",
      } } });
    } else if (process.env.MOCK_KIND === "shell") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-sh", title: "shell", rawInput: { CommandLine: "echo hi" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-sh", status: "completed",
        rawOutput: "Tool is running as a background task with task id: " + sid + "/task-202",
      } } });
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`);

  // 1) daemon / monitor / agent 全部排除
  const wakes1 = [];
  await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env, MOCK_SID: "sess-excl", MOCK_KIND: "non-shell" },
    prompt: "start non-shell",
    run: { id: "r-excl", bgList: [], bgTasks: 0 },
    emit: () => {},
    keepAlive: true,
    bgPollMs: 30,
    bgGraceMs: 120,
    onBgWake: (ev) => wakes1.push(ev),
  });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(wakes1.length, 0, "daemon / monitor / agent 类型任务不得触发 shell 补唤醒");
  assert.equal(getAcpPoolBg("sess-excl").length, 3);
  closeAcpSession("sess-excl");

  // 2) 宽限窗内手动 stopAcpBgTask 停掉任务，绝不补唤醒
  const wakes2 = [];
  await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env, MOCK_SID: "sess-stop", MOCK_KIND: "shell" },
    prompt: "start shell",
    run: { id: "r-stop", bgList: [], bgTasks: 0 },
    emit: () => {},
    keepAlive: true,
    bgPollMs: 30,
    bgGraceMs: 250,
    onBgWake: (ev) => wakes2.push(ev),
  });
  await new Promise((r) => setTimeout(r, 80));
  stopAcpBgTask("sess-stop", "sess-stop/task-202");
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(wakes2.length, 0, "手动停止的后台任务不得再补唤醒");

  // 3) 宽限窗内新消息复用会话（entry.busy=true），立即清掉旧监听器，绝不补唤醒
  const wakes3 = [];
  await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env, MOCK_SID: "sess-reuse", MOCK_KIND: "shell" },
    prompt: "turn1",
    run: { id: "r-reuse-1", bgList: [], bgTasks: 0 },
    emit: () => {},
    keepAlive: true,
    bgPollMs: 30,
    bgGraceMs: 300,
    onBgWake: (ev) => wakes3.push(ev),
  });
  await new Promise((r) => setTimeout(r, 80));
  await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env, MOCK_SID: "sess-reuse", MOCK_KIND: "none" },
    sessionId: "sess-reuse",
    prompt: "turn2",
    run: { id: "r-reuse-2", bgList: [], bgTasks: 0 },
    emit: () => {},
    keepAlive: true,
    bgPollMs: 30,
    bgGraceMs: 300,
    onBgWake: null,
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(wakes3.length, 0, "会话被复用后旧监听器必须已清理，不得再触发");
  closeAcpSession("sess-reuse");
});
