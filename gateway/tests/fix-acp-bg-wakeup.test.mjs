import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PATHS } from "../gw/config.mjs";
import {
  ACP_BG_GRACE_MS,
  acpBgShellActive,
  closeAcpSession,
  closeAllAcpClients,
  getAcpPoolBg,
  listAcpChildren,
  runAcpTurn,
  stopAcpBgTask,
} from "../gw/acp.mjs";
import { QUEUE, enqueue } from "../gw/queue.mjs";
import { RUNS } from "../gw/runs.mjs";
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

test("acpBgShellActive / listAcpChildren 真实内核 /proc 探测与默认 15s 宽限窗", async () => {
  if (!process.env.CCAPP_ACP_BG_GRACE_MS) {
    assert.equal(ACP_BG_GRACE_MS, 15000, "默认宽限窗应为 15000ms (C13a)");
  }
  assert.equal(acpBgShellActive(0).active, true);
  assert.equal(acpBgShellActive(process.pid, { procDir: "/proc-does-not-exist" }).active, true);
  assert.deepEqual(
    acpBgShellActive(process.pid, { tasks: [{ id: "s/task-0", type: "shell", childKey: null }], brainDir: "" }),
    { active: true, reason: "unattributed" }
  );

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

    // 明确归属到 shell 的子进程仍在存活时返回 task-child
    const byTaskKey = acpBgShellActive(process.pid, {
      daemonChildKeys: new Set([mine.key]),
      tasks: [{ id: "s/task-1", type: "shell", childKey: mine.key }],
      brainDir: "",
    });
    assert.equal(byTaskKey.active, true);
    assert.equal(byTaskKey.reason, "task-child");

    // 若该子进程已在 daemonChildKeys 中且不属于待监视 shell，则不阻塞判定
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

test("listAcpChildren 支持 /proc/<pid>/task/*/children 与 hidepid=2 隐藏存活子进程，以及无 uid 过滤的回退路径", () => {
  // 1) task/*/children 优先路径（含正常子进程、僵尸子进程、hidepid=2 无 stat 的存活子进程）
  const p1 = path.join(tmpDir, "synth-proc-children");
  fs.mkdirSync(path.join(p1, "100", "task", "100"), { recursive: true });
  fs.mkdirSync(path.join(p1, "100", "task", "101"), { recursive: true });
  fs.writeFileSync(path.join(p1, "100", "task", "100", "children"), "201 202");
  fs.writeFileSync(path.join(p1, "100", "task", "101", "children"), "203\n");
  // 201: 正常存活子进程
  fs.mkdirSync(path.join(p1, "201"), { recursive: true });
  const statLine = (pid, state, ppid, ticks) => {
    const rest = new Array(22).fill("0");
    rest[0] = state;
    rest[1] = String(ppid);
    rest[19] = String(ticks);
    return `${pid} (sh) ${rest.join(" ")}`;
  };
  fs.writeFileSync(path.join(p1, "201", "stat"), statLine(201, "S", 100, 9991));
  // 202: 僵尸子进程应忽略
  fs.mkdirSync(path.join(p1, "202"), { recursive: true });
  fs.writeFileSync(path.join(p1, "202", "stat"), statLine(202, "Z", 100, 9992));
  // 203: 无 /proc/203/stat（模拟 Android hidepid=2 下 PR_SET_DUMPABLE=0 存活子进程）

  const kids1 = listAcpChildren(100, p1);
  assert.ok(Array.isArray(kids1));
  assert.deepEqual(
    kids1.map((c) => ({ pid: c.pid, key: c.key, hidden: !!c.hidden })),
    [
      { pid: 201, key: "201:9991", hidden: false },
      { pid: 203, key: "203:hidden", hidden: true },
    ]
  );

  // 2) 无 task/*/children 时的回退扫描路径（不依赖 uid 过滤）
  const p2 = path.join(tmpDir, "synth-proc-fallback");
  fs.mkdirSync(path.join(p2, "301"), { recursive: true });
  fs.mkdirSync(path.join(p2, "302"), { recursive: true });
  fs.writeFileSync(path.join(p2, "301", "stat"), statLine(301, "S", 100, 5555));
  fs.writeFileSync(path.join(p2, "302", "stat"), statLine(302, "S", 999, 5556));
  const kids2 = listAcpChildren(100, p2);
  assert.deepEqual(kids2, [{ pid: 301, startTicks: "5555", key: "301:5555" }]);
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
  assert.ok(typeof getAcpPoolBg("sess-bg-wake-1")[0].childKey === "string", "shell 任务应获得精确 childKey 归属");

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

test("宽限窗内 agy 正常推送 idleBurst 回报（含多任务未点名场景 C13b）时立即让路，绝不重复补唤醒", async () => {
  const mockBin = makeMockAgy("mock-bg-native-wake.mjs", `
import readline from "node:readline";
import { spawn } from "node:child_process";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: process.env.MOCK_SID || "sess-native-wake" } });
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    if (process.env.MOCK_MULTI === "1") {
      // 顺序派生两个短命 shell 任务，待两子进程真实退出后 agy 自主回报但不点名 task id，验证 C13b 防重复补唤醒
      const c1 = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { stdio: "ignore" });
      const p1 = new Promise((r) => c1.once("close", r));
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-m1", title: "cmd1", rawInput: { CommandLine: "echo 1" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-m1", status: "completed",
        rawOutput: "Tool is running as a background task with task id: " + sid + "/task-881",
      } } });
      setTimeout(() => {
        const c2 = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { stdio: "ignore" });
        const p2 = new Promise((r) => c2.once("close", r));
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "tool_call", toolCallId: "tc-m2", title: "cmd2", rawInput: { CommandLine: "echo 2" }, status: "in_progress",
        } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "tool_call_update", toolCallId: "tc-m2", status: "completed",
          rawOutput: "Tool is running as a background task with task id: " + sid + "/task-882",
        } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        Promise.all([p1, p2]).then(() => setTimeout(() => {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
            sessionUpdate: "agent_message_chunk", content: { type: "text", text: "两项后台构建均已完成。" },
          } } });
        }, 40));
      }, 40);
      return;
    }
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 60)"], { stdio: "ignore" });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "tool_call", toolCallId: "tc-nat", title: "cmd", rawInput: { CommandLine: "echo ok" }, status: "in_progress",
    } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "tool_call_update", toolCallId: "tc-nat", status: "completed",
      rawOutput: "Tool is running as a background task with task id: " + sid + "/task-88",
    } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    // 120ms 后（宽限窗 350ms 内）agy 自己发来原生空闲唤醒
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "task-88 已由 agy 原生回报完成" },
      } } });
    }, 120);
  }
});
`);

  const wakes1 = [];
  const r1 = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env, MOCK_SID: "sess-native-wake" },
    prompt: "go",
    run: { id: "r-nat", bgList: [], bgTasks: 0 },
    emit: () => {},
    keepAlive: true,
    bgPollMs: 40,
    bgGraceMs: 350,
    onBgWake: (ev) => wakes1.push(ev),
  });
  assert.equal(r1.ok, true);
  await new Promise((r) => setTimeout(r, 1950));
  assert.equal(wakes1.length, 0, "agy 已自行原生回报时不得重复触发补唤醒");
  assert.equal(getAcpPoolBg("sess-native-wake").length, 0);
  closeAcpSession("sess-native-wake");

  // C13b：多任务未点名 task-id 时，idleBurst 开始即已探测 gone 并记入 nudgedBgTasks，flushIdle 后不重复补唤醒
  const wakes2 = [];
  const r2 = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env, MOCK_SID: "sess-native-multi", MOCK_MULTI: "1" },
    prompt: "go multi",
    run: { id: "r-nat-multi", bgList: [], bgTasks: 0 },
    emit: () => {},
    keepAlive: true,
    bgPollMs: 40,
    bgGraceMs: 250,
    onBgWake: (ev) => wakes2.push(ev),
  });
  assert.equal(r2.ok, true);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(wakes2.length, 0, "多任务场景 agy 原生回报未点名 task-id 时不得在 flushIdle 后重复补唤醒 (C13b)");
  assert.equal(getAcpPoolBg("sess-native-multi").length, 0, "C13b 确认已退出的多任务后台 shell 必须从 bgTasks 同步摘除 (R2-01 P1-N1)");
  closeAcpSession("sess-native-multi");
});

test("排除 daemon / schedule(monitor) / subagent(agent) 且在复用/手动停止/关闭会话时清理定时器不误触发", async () => {
  const mockBin = makeMockAgy("mock-bg-exclude.mjs", `
import readline from "node:readline";
import { spawn } from "node:child_process";
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
      // 派生 50ms 短命子进程，使 task-202 获得真实 childKey 并真正挂起 bgWatchTimer
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { stdio: "ignore" });
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

test("增量快照归属（P1-2/P1-3）：daemon+shell 混合正常唤醒；无归属/并行歧义/二次fork秒退 daemon 严格 fail-closed", async () => {
  const mockBin = makeMockAgy("mock-bg-attr.mjs", `
import readline from "node:readline";
import { spawn } from "node:child_process";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const children = [];
rl.on("close", () => { for (const c of children) try { c.kill("SIGKILL"); } catch {} process.exit(0); });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: process.env.MOCK_SID } });
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const mode = process.env.MOCK_MODE;
    if (mode === "mixed-seq") {
      // 先启常驻 daemon（长命 5s），登记完再启非常驻 shell（200ms 退出）
      children.push(spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" }));
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-dm", title: "daemon", rawInput: { CommandLine: "node srv", IsDaemon: true }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-dm", status: "completed",
        rawOutput: "Tool is running as a background task with task id: " + sid + "/task-1",
      } } });
      setTimeout(() => {
        children.push(spawn(process.execPath, ["-e", "setTimeout(() => {}, 180)"], { stdio: "ignore" }));
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "tool_call", toolCallId: "tc-sh", title: "shell", rawInput: { CommandLine: "node build" }, status: "in_progress",
        } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "tool_call_update", toolCallId: "tc-sh", status: "completed",
          rawOutput: "Tool is running as a background task with task id: " + sid + "/task-2",
        } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 40);
      return;
    }
    if (mode === "unattributed-shell") {
      // 不派生子进程（模拟不可见/瞬间退出的无归属 shell）：fresh.length === 0 => childKey=null => fail-closed
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-u", title: "unattr", rawInput: { CommandLine: "echo ghost" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-u", status: "completed",
        rawOutput: "Tool is running as a background task with task id: " + sid + "/task-3",
      } } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    if (mode === "ambiguous-parallel") {
      // 同时派生 daemon 与 shell 子进程再依次回报，fresh.length === 2 => 均不猜归属 => fail-closed
      children.push(spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" }));
      children.push(spawn(process.execPath, ["-e", "setTimeout(() => {}, 120)"], { stdio: "ignore" }));
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-p1", title: "d", rawInput: { CommandLine: "srv", IsDaemon: true }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-p1", status: "completed",
        rawOutput: "Tool is running as a background task with task id: " + sid + "/task-4",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-p2", title: "s", rawInput: { CommandLine: "job" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-p2", status: "completed",
        rawOutput: "Tool is running as a background task with task id: " + sid + "/task-5",
      } } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    if (mode === "doublefork-daemon") {
      // 先启正在跑的 shell（800ms），再登记一个二次 fork 秒退的 daemon（无新子进程）：绝不可把运行中的 shell 误标进 daemonChildKeys
      children.push(spawn(process.execPath, ["-e", "setTimeout(() => {}, 800)"], { stdio: "ignore" }));
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-s1", title: "long-sh", rawInput: { CommandLine: "sleep 1" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-s1", status: "completed",
        rawOutput: "Tool is running as a background task with task id: " + sid + "/task-6",
      } } });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "tool_call", toolCallId: "tc-d2", title: "nohup-d", rawInput: { CommandLine: "nohup srv &", IsDaemon: true }, status: "in_progress",
        } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "tool_call_update", toolCallId: "tc-d2", status: "completed",
          rawOutput: "Tool is running as a background task with task id: " + sid + "/task-7",
        } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, 40);
      return;
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`);

  // A) daemon 存活 + shell 退出：仅 shell 触发一次补唤醒，daemon 留在 bgTasks 中
  const wakesA = [];
  try {
    await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir,
      env: { ...process.env, MOCK_SID: "sess-mixed-seq", MOCK_MODE: "mixed-seq" },
      prompt: "mixed", run: { id: "r-mix", bgList: [], bgTasks: 0 }, emit: () => {},
      keepAlive: true, bgPollMs: 40, bgGraceMs: 180, onBgWake: (ev) => wakesA.push(ev),
    });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(wakesA.length, 1, "daemon 存活时 shell 退出仍应准确触发一次补唤醒");
    assert.equal(wakesA[0].tasks[0].id, "sess-mixed-seq/task-2");
    const remain = getAcpPoolBg("sess-mixed-seq");
    assert.equal(remain.length, 1);
    assert.equal(remain[0].id, "sess-mixed-seq/task-1");
  } finally {
    closeAcpSession("sess-mixed-seq");
  }

  // B) 无归属 shell：fail-closed，留在 bgTasks 保活，绝不误唤醒、绝不误摘除
  const wakesB = [];
  try {
    await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir,
      env: { ...process.env, MOCK_SID: "sess-unattr", MOCK_MODE: "unattributed-shell" },
      prompt: "unattr", run: { id: "r-unattr", bgList: [], bgTasks: 0 }, emit: () => {},
      keepAlive: true, bgPollMs: 30, bgGraceMs: 100, onBgWake: (ev) => wakesB.push(ev),
    });
    await new Promise((r) => setTimeout(r, 320));
    assert.equal(wakesB.length, 0, "无归属 shell (childKey=null) 必须 fail-closed 不误唤醒");
    assert.equal(getAcpPoolBg("sess-unattr").length, 1, "无归属 shell 必须留在 bgTasks 保活不被误摘除");
    assert.equal(getAcpPoolBg("sess-unattr")[0].childKey, null);
  } finally {
    closeAcpSession("sess-unattr");
  }

  // C) 并行歧义派发：fresh.length > 1，均 childKey=null，fail-closed 不误唤醒
  const wakesC = [];
  try {
    await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir,
      env: { ...process.env, MOCK_SID: "sess-ambig", MOCK_MODE: "ambiguous-parallel" },
      prompt: "ambig", run: { id: "r-ambig", bgList: [], bgTasks: 0 }, emit: () => {},
      keepAlive: true, bgPollMs: 30, bgGraceMs: 100, onBgWake: (ev) => wakesC.push(ev),
    });
    await new Promise((r) => setTimeout(r, 380));
    assert.equal(wakesC.length, 0, "并行歧义派发必须 fail-closed 不猜归属、不误唤醒");
    assert.equal(getAcpPoolBg("sess-ambig").length, 2);
  } finally {
    closeAcpSession("sess-ambig");
  }

  // D) 二次 fork 秒退 daemon：不污染运行中的 shell，shell 仍在跑期间绝不提前误唤醒
  const wakesD = [];
  try {
    await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir,
      env: { ...process.env, MOCK_SID: "sess-dfork", MOCK_MODE: "doublefork-daemon" },
      prompt: "dfork", run: { id: "r-dfork", bgList: [], bgTasks: 0 }, emit: () => {},
      keepAlive: true, bgPollMs: 30, bgGraceMs: 120, onBgWake: (ev) => wakesD.push(ev),
    });
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(wakesD.length, 0, "运行中的 shell 绝不可被二次 fork 秒退 daemon 误豁免而提前唤醒");
  } finally {
    closeAcpSession("sess-dfork");
  }
});

test("C15 & C16：普通用户消息入队时撤掉同会话排队中的 auto=bg 项，且 run.mjs 对 auto=bg 不挂交互权限卡", () => {
  const sid = "sess-c16-queue-test";
  const fakeRunId = "r-fake-blocker";
  const savedQueue = QUEUE.splice(0, QUEUE.length);
  RUNS.set(fakeRunId, { id: fakeRunId, text: "", sessionId: sid, lane: "s:" + sid, idle: false, ended: false });
  try {
    const bgItem = enqueue({ message: "<task-notification>done</task-notification>", sessionId: sid, auto: "bg", internal: true });
    assert.ok(QUEUE.some((q) => q.id === bgItem.id && q.auto === "bg"), "车道忙时 auto=bg 应排队");

    const userItem = enqueue({ message: "我自己来继续", sessionId: sid });
    assert.ok(QUEUE.some((q) => q.id === userItem.id), "普通用户消息应入队");
    assert.equal(QUEUE.some((q) => q.auto === "bg" && q.sessionId === sid), false, "普通用户消息入队后应撤掉同会话尚未开跑的 auto=bg 项");
  } finally {
    RUNS.delete(fakeRunId);
    QUEUE.splice(0, QUEUE.length, ...savedQueue);
  }

  const runSrc = fs.readFileSync(path.resolve(new URL("../gw/run.mjs", import.meta.url).pathname), "utf8");
  assert.match(runSrc, /if \(run\.unattended \|\| run\.auto\)\s*\{\s*return run\.auto === "bg" && permMode === "bypassPermissions" \? \{ behavior: "allow" \} : \{ behavior: "deny" \};\s*\}/);
  assert.doesNotMatch(runSrc, /run\.auto && run\.auto !== "bg"/);
});
