import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG } from "../gw/config.mjs";
import {
  closeAllAcpClients,
  killAcpChild,
  killBgChildTree,
  listDescendantPids,
  readTaskLogTail,
  runAcpTurn,
  scanAcpTaskLogs,
  shouldOpenIdleBurst,
  translateAcpUpdate,
} from "../gw/acp.mjs";

const tmpDir = fs.mkdtempSync(path.join(CFG.workspace, "bg-obs-"));
after(() => {
  closeAllAcpClients();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

async function waitDead(pid, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return !isAlive(pid);
}

test("readTaskLogTail：大日志只读尾部并折叠 \\r 进度条覆盖行", () => {
  const f = path.join(tmpDir, "task-1.log");
  const lines = [
    "line-0",
    "Receiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\rReceiving objects: 100% (10/10), done.",
    "Resolving deltas: 0%\rResolving deltas: 100%, done.",
  ];
  fs.writeFileSync(f, lines.join("\n"));
  const tail = readTaskLogTail(f, 4096);
  assert.match(tail, /Receiving objects: 100% \(10\/10\), done\./);
  assert.doesNotMatch(tail, /10% \(1\/10\)/);
  assert.match(tail, /Resolving deltas: 100%, done\./);
});

test("translateAcpUpdate：非终态 tool_call_update 含后台任务信封时立即登记 bgTasks 并透出 status=background", () => {
  const bg = new Map();
  const evs = [];
  const state = {
    sessionId: "sess-nonterm",
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
    onBgClearTasks: () => {},
    onCommands: () => {},
  };
  translateAcpUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-bg-1",
      title: "git log -S foo",
      rawInput: { CommandLine: "git log -S foo", toolSummary: "Scan history" },
      status: "in_progress",
    },
  }, state, (e) => evs.push(e));
  translateAcpUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-bg-1",
      status: "in_progress",
      rawOutput: "Tool is running as a background task with task id: sess-nonterm/task-2911\nTask logs are available at: file:///tmp/task-2911.log\nLog output:\nfetching...",
    },
  }, state, (e) => evs.push(e));
  assert.equal(bg.size, 1);
  assert.equal(bg.get("sess-nonterm/task-2911")?.logPath, "/tmp/task-2911.log");
  assert.equal(bg.get("sess-nonterm/task-2911")?.toolId, "tc-bg-1");
  const upd = evs.find((e) => e.type === "tool_update" && e.id === "tc-bg-1");
  assert.ok(upd);
  assert.equal(upd.status, "background");
  assert.equal(upd.bgTaskId, "sess-nonterm/task-2911");
});

test("复现 20:16 案发现场：静默后台化 run_command（不发 completed/content）自动探测 task-2911.log、推尾部输出与 phase=bg、并靠活跃进展续期不误杀", { timeout: 15000 }, async () => {
  const brainDir = path.join(tmpDir, "brain-live");
  const sid = "sess-scene-2911";
  const taskDir = path.join(brainDir, sid, ".system_generated", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const taskLog = path.join(taskDir, "task-2911.log");

  const mockBin = path.join(tmpDir, "mock-agy-scene.mjs");
  fs.writeFileSync(mockBin, `
import fs from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const logPath = ${JSON.stringify(taskLog)};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: ${JSON.stringify(sid)} } });
  if (msg.method === "session/prompt") {
    // 发起一个 run_command（永不发 completed，直到后面才收尾），模拟 agy 1.5.13 静默转后台
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(sid)}, update: {
      sessionUpdate: "tool_call",
      toolCallId: "call_slow_2911",
      title: "git log -S AGENTS.local.md",
      rawInput: { CommandLine: "git log -S AGENTS.local.md", WaitMsBeforeAsync: 10000, toolSummary: "Scan AGENTS history" },
      status: "in_progress",
    } } });
    // 同时发过渡文字（之后全程无 JSON-RPC 帧超过 idleTimeoutMs=280ms，全靠 task-2911.log 持续增长续期）
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(sid)}, update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "等待扫描收尾。" },
    } } });
    let step = 0;
    const iv = setInterval(() => {
      step++;
      fs.appendFileSync(logPath, "Receiving objects: " + (step * 10) + "%\\rReceiving objects: " + (step * 10 + 5) + "%\\n");
      if (step >= 6) {
        clearInterval(iv);
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(sid)}, update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_slow_2911",
          status: "completed",
          rawOutput: "Command exited with code 0.\\n\\nCommand output:\\ndone",
        } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }
    }, 90);
  }
});
`, { mode: 0o755 });

  const evs = [];
  const bgSnapshots = [];
  const run = { id: "r-scene", bgList: [], bgTasks: 0 };
  const res = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "inspect repo",
    run,
    emit: (e) => evs.push(e),
    onBgChange: (list) => bgSnapshots.push(list.map((x) => ({ ...x }))),
    brainDir,
    activeBgPollMs: 60,
    idleTimeoutMs: 280,
    keepAlive: false,
  });

  assert.equal(res.ok, true, `活跃写入 task-2911.log 的长任务不应被 idleTimeoutMs 误杀: ${res.error || ""}`);
  assert.ok(bgSnapshots.some((l) => l.some((x) => x.id === `${sid}/task-2911` && x.bytes > 0)), "进行中应自动把 task-2911 登记进 bgList 并带实时字节数");
  const bgUpd = evs.find((e) => e.type === "tool_update" && e.id === "call_slow_2911" && e.status === "background");
  assert.ok(bgUpd, "应向前端卡片推 status=background 与日志尾部");
  assert.match(String(bgUpd.output || ""), /Receiving objects:/);
  assert.equal(run.bgList.length, 0, "后台命令正常退出后应自动从 bgList 摘除，不留幽灵条");
});

test("shouldOpenIdleBurst 与取消后迟到旧工具帧：不触发 0 字幻影 idleBurst", { timeout: 15000 }, async () => {
  const wakeKinds = new Set(["tool_call", "tool_call_update", "agent_message_chunk", "text_delta", "agent_message"]);
  const fakeEntry = { knownToolIds: new Set(["call-old-1"]), replayMessageIds: new Set(["msg-old"]) };
  assert.equal(shouldOpenIdleBurst("tool_call_update", { toolCallId: "call-old-1", status: "cancelled" }, fakeEntry, wakeKinds), false);
  assert.equal(shouldOpenIdleBurst("agent_message_chunk", { content: { type: "text", text: "" } }, fakeEntry, wakeKinds), false);
  assert.equal(shouldOpenIdleBurst("agent_message_chunk", { messageId: "msg-old", content: { type: "text", text: "hi" } }, fakeEntry, wakeKinds), false);
  assert.equal(shouldOpenIdleBurst("agent_message_chunk", { content: { type: "text", text: "real wake" } }, fakeEntry, wakeKinds), true);
  assert.equal(shouldOpenIdleBurst("tool_call", { toolCallId: "call-new-2" }, fakeEntry, wakeKinds), true);
});

test("在途后台 shell 子进程全部退出但 session/prompt 静默超 inflightStallWarnMs：发出停滞告警 note", { timeout: 15000 }, async () => {
  const brainDir = path.join(tmpDir, "brain-stall");
  const sid = "sess-stall-warn";
  const taskDir = path.join(brainDir, sid, ".system_generated", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const mockBin = path.join(tmpDir, "mock-agy-stall.mjs");
  fs.writeFileSync(mockBin, `
import readline from "node:readline";
import { spawn } from "node:child_process";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: ${JSON.stringify(sid)} } });
  if (msg.method === "session/prompt") {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 80)"], { stdio: "ignore" });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(sid)}, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-st", title: "run_command",
        rawInput: { CommandLine: "echo hi" }, status: "completed",
        rawOutput: "Tool is running as a background task with task id: ${sid}/task-55",
      } } });
    }, 20);
    setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }), 450);
    void child;
  }
});
`, { mode: 0o755 });

  const evs = [];
  const res = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "stall check",
    run: { id: "r-stall", bgList: [], bgTasks: 0 },
    emit: (e) => evs.push(e),
    brainDir,
    activeBgPollMs: 50,
    inflightStallWarnMs: 120,
    probeBgShell: () => ({ active: false, reason: "gone" }),
    keepAlive: false,
  });
  assert.equal(res.ok, true);
  assert.ok(evs.some((e) => e.type === "note" && e.key === "acp-bg-stalled"), "子进程已退且静默超阈值应发 acp-bg-stalled 提示");
});

test("killBgChildTree 安全边界与 killAcpChild 回收独立进程组（detached）孙进程", { timeout: 15000 }, async () => {
  const grandPidFile = path.join(tmpDir, "grand.pid");
  const parent = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    // 故意用 detached:true 让孙进程另开独立进程组（模拟 setsid 的后台命令）
    const g = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { detached: true, stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid));
    setInterval(()=>{}, 1000);
  `], { detached: true, stdio: "ignore" });
  const t0 = Date.now();
  while (!fs.existsSync(grandPidFile) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 30));
  const grandPid = Number(fs.readFileSync(grandPidFile, "utf8").trim());
  assert.ok(grandPid > 0 && isAlive(grandPid), "独立进程组孙进程应已启动");
  assert.ok(listDescendantPids(parent.pid).includes(grandPid), "listDescendantPids 应顺着 /proc 找到独立进程组孙进程");

  // 1. 拒绝杀父进程自身或错误的 startTicks
  assert.equal(killBgChildTree(parent.pid, `${parent.pid}:0`), false);
  assert.equal(killBgChildTree(parent.pid, `${grandPid}:999999999999`), false);
  assert.equal(isAlive(grandPid), true, "错误 startTicks 不得误杀孙进程");

  // 2. killAcpChild 必须连同独立进程组的孙进程一起回收
  killAcpChild(parent, 200);
  assert.equal(await waitDead(parent.pid), true, "父进程应被终止");
  assert.equal(await waitDead(grandPid), true, "另开进程组的孙进程也必须被整树回收，不留孤儿");
});

test("scanAcpTaskLogs 过滤陈旧日志并按任务号排序", () => {
  const bd = path.join(tmpDir, "brain-scan");
  const sid = "sess-scan";
  const dir = path.join(bd, sid, ".system_generated", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task-12.log"), "b");
  fs.writeFileSync(path.join(dir, "task-3.log"), "a");
  fs.writeFileSync(path.join(dir, "other.txt"), "x");
  const found = scanAcpTaskLogs(sid, bd, Date.now() - 5000);
  assert.deepEqual(found.map((x) => x.shortId), ["task-3", "task-12"]);
});

test("前端 02-chat-view.js 与 03-perm-status.js 后台任务可观测性契约完备", () => {
  const cv = fs.readFileSync(path.join(process.cwd(), "gateway/web/app/02-chat-view.js"), "utf8");
  const ps = fs.readFileSync(path.join(process.cwd(), "gateway/web/app/03-perm-status.js"), "utf8");
  assert.match(cv, /isBgShellResult/);
  assert.match(cv, /u\.status === "background" \|\| u\.bgTaskId/);
  assert.match(cv, /t\("静默 \{d\}"/);
  assert.match(ps, /case "bg":/);
  assert.match(ps, /t\("等待后台任务"\)/);
  assert.match(ps, /querySelectorAll\("\.rs-el"\)/);
});
