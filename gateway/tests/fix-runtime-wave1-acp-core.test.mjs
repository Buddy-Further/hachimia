import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "../gw/config.mjs";
import {
  acpBgShellActive,
  acpSessionFile,
  closeAcpSession,
  closeAllAcpClients,
  getAcpPoolBg,
  hasAcpIdleBurst,
  isPidAliveFallback,
  isSubagentTranscriptIdle,
  pickAcpAllowOption,
  runAcpTurn,
  stopAcpBgTask,
  translateAcpUpdate,
} from "../gw/acp.mjs";
import { onPublish } from "../gw/bus.mjs";
import { readAgentIndex } from "../gw/agents.mjs";
import { QUEUE, abortRun, enqueue, forceEnd, holdLane, setPermMode } from "../gw/queue.mjs";
import { RUNS } from "../gw/runs.mjs";
import { deleteMessage, purgeTrash, trashSession, undoDelete } from "../gw/sessionops.mjs";
import { PROJECTS, moveSession } from "../gw/projects.mjs";

const tmpDir = fs.mkdtempSync(path.join(CFG.workspace, "wave1-acp-core-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000, step = 40) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
};
function makeMockAgy(name, body) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

after(() => {
  closeAllAcpClients();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────
// 1. R2-01：C13b 一死一活不误摘活壳 + hidepid=2 kill(pid, 0) 存活复核
// ─────────────────────────────────────────────────────────────────────
test("R2-01：hidepid=2 下 /proc 缺失时经 kill(pid, 0) 复核存活，仅 ESRCH 判退出", () => {
  assert.equal(isPidAliveFallback(process.pid), true, "当前进程 kill(pid,0) 必返回 true");
  assert.equal(isPidAliveFallback(99999999), false, "不存在的 PID 返回 false (ESRCH)");
  assert.equal(isPidAliveFallback(0), false);

  // 空的合成 procDir（模拟 hidepid=2 下 PR_SET_DUMPABLE=0 导致 /proc/<pid> 不可见）
  const emptyProc = path.join(tmpDir, "empty-proc");
  fs.mkdirSync(emptyProc, { recursive: true });

  const aliveRes = acpBgShellActive(process.pid, {
    procDir: emptyProc,
    brainDir: "",
    tasks: [{ id: "s/task-1", type: "shell", childKey: "43210:999" }],
    isPidAlive: (pid) => pid === 43210,
  });
  assert.equal(aliveRes.active, true);
  assert.equal(aliveRes.reason, "hidden-kill0-alive");

  const deadRes = acpBgShellActive(process.pid, {
    procDir: emptyProc,
    brainDir: "",
    tasks: [{ id: "s/task-1", type: "shell", childKey: "43210:999" }],
    isPidAlive: () => false,
  });
  assert.equal(deadRes.active, false);
  assert.equal(deadRes.reason, "gone");
});

test("R2-01：C13b 一死一活场景仅摘除已死壳，活壳继续留在 bgTasks 且不进 nudgedBgTasks", async () => {
  const mockBin = makeMockAgy("mock-r2-01-mixed.mjs", `
import readline from "node:readline";
import { spawn } from "node:child_process";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const kids = [];
rl.on("close", () => { for (const c of kids) try { c.kill("SIGKILL"); } catch {} process.exit(0); });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-r201-half" } });
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const cDead = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60)"], { stdio: "ignore" });
    kids.push(cDead);
    const pDead = new Promise((r) => cDead.once("close", r));
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "tool_call", toolCallId: "tc-d", title: "short job", rawInput: { CommandLine: "echo short" }, status: "in_progress",
    } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "tool_call_update", toolCallId: "tc-d", status: "completed",
      rawOutput: "Tool is running as a background task with task id: " + sid + "/task-dead",
    } } });
    setTimeout(() => {
      const cAlive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
      kids.push(cAlive);
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "tc-a", title: "long job", rawInput: { CommandLine: "sleep 5" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "tc-a", status: "completed",
        rawOutput: "Tool is running as a background task with task id: " + sid + "/task-alive",
      } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      pDead.then(() => setTimeout(() => {
        // 死壳退出后 agy 自主汇报但不点名任何 task id
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一项编译已经完成。" },
        } } });
      }, 60));
    }, 60);
  }
});
`);

  const wakes = [];
  try {
    const r = await runAcpTurn({
      bin: process.execPath,
      args: [mockBin],
      cwd: tmpDir,
      env: { ...process.env },
      prompt: "run two",
      run: { id: "r-r201-half", bgList: [], bgTasks: 0 },
      emit: () => {},
      keepAlive: true,
      bgPollMs: 40,
      bgGraceMs: 200,
      onBgWake: (ev) => wakes.push(ev),
    });
    assert.equal(r.ok, true);
    assert.equal(getAcpPoolBg("sess-r201-half").length, 2);

    // 等待死壳退出且 idleBurst 入口执行 C13b 探测
    assert.ok(await waitFor(() => getAcpPoolBg("sess-r201-half").length === 1, 2500), "已死壳应从 bgTasks 同步摘除");
    const remain = getAcpPoolBg("sess-r201-half");
    assert.equal(remain.length, 1);
    assert.equal(remain[0].id, "sess-r201-half/task-alive", "活壳必须继续保留在 bgTasks 中");
    assert.equal(wakes.length, 0, "死壳已被原生回报吸收，活壳仍在跑，不应误触发补唤醒");
  } finally {
    closeAcpSession("sess-r201-half");
  }
});

// ─────────────────────────────────────────────────────────────────────
// 2. C-09：幽灵子代理五重断链全链路根治
// ─────────────────────────────────────────────────────────────────────
test("C-09：isSubagentTranscriptIdle 尾帧 32KB 确定性对账（DONE+send_message / 静默 / 未决 tool_calls）", () => {
  const dir = path.join(tmpDir, "c09-transcript");
  fs.mkdirSync(dir, { recursive: true });
  const parentSid = "aaaaaaaa-1111-2222-3333-444444444444";
  const subConv = "bbbbbbbb-1111-2222-3333-444444444444";

  // 1) 大文件（>40KB 头部填充）+ 尾部 send_message + PLANNER_RESPONSE DONE 无 tool_calls
  const f1 = path.join(dir, "done-msg.jsonl");
  const bigPad = JSON.stringify({ source: "MODEL", type: "LOG", pad: "X".repeat(45000) }) + "\n";
  const sendLine = JSON.stringify({
    source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE",
    tool_calls: [{ name: "send_message", args: { Recipient: parentSid, Message: "done" } }],
  }) + "\n";
  const finalLine = JSON.stringify({
    source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE",
    timestamp: new Date().toISOString(), tool_calls: [],
  }) + "\n";
  fs.writeFileSync(f1, bigPad + sendLine + finalLine);
  assert.equal(isSubagentTranscriptIdle(f1, parentSid, null), true, "尾部含发往父会话的 send_message 且末帧 DONE 无 tool_calls 应判闲置");

  // 2) 末帧仍有未决 tool_calls → false
  const f2 = path.join(dir, "pending-tool.jsonl");
  fs.writeFileSync(f2, JSON.stringify({
    source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE",
    timestamp: new Date(Date.now() - 60000).toISOString(),
    tool_calls: [{ name: "read_file" }],
  }) + "\n");
  assert.equal(isSubagentTranscriptIdle(f2, parentSid, new Set([subConv]), { convId: subConv }), false, "末帧存在未决 tool_calls 不得判闲置");

  // 3) 末帧无 send_message、未进 reportedConvs，刚写入 (<3s) → false，超过 3s → true
  const f3 = path.join(dir, "quiet-check.jsonl");
  const now = Date.now();
  fs.writeFileSync(f3, JSON.stringify({
    source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE",
    timestamp: new Date(now - 500).toISOString(),
  }) + "\n");
  assert.equal(isSubagentTranscriptIdle(f3, parentSid, null, { now, quietMs: 3000 }), false, "静默不足 3s 且无报告证据时不误判");
  assert.equal(isSubagentTranscriptIdle(f3, parentSid, null, { now: now + 4000, quietMs: 3000 }), true, "静默超 3s 且无未决 tool_calls 应判闲置");
  assert.equal(isSubagentTranscriptIdle(f3, parentSid, new Set([subConv]), { convId: subConv, now, quietMs: 3000 }), true, "命中 reportedConvs 应立即判闲置");
});

test("C-09：manage_subagents(list) 权威对账 + send_message 对称唤醒 + user_message sender 提取", () => {
  const conv1 = "11111111-aaaa-bbbb-cccc-000000000001";
  const conv2 = "22222222-aaaa-bbbb-cccc-000000000002";
  const bg = new Map();
  const evs = [];
  const state = {
    text: "", thinking: "", tools: new Map(), knownToolIds: new Set(),
    usage: null, promptSent: true, permMode: "default", cwd: tmpDir, sessionId: "sess-c09-list",
    onBgAdd: (t) => bg.set(t.id, t),
    onBgRemove: (id) => bg.delete(id),
  };
  const emit = (e) => evs.push(e);

  // 启动两个子代理
  translateAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "sub-a", title: "Run invoke_subagent", rawInput: { Role: "Worker A", TypeName: "research", Prompt: "A" }, status: "in_progress" }, state, emit);
  translateAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "sub-a", status: "completed", rawOutput: JSON.stringify({ conversationId: conv1, logAbsoluteUri: "file:///tmp/a.jsonl" }) }, state, emit);
  translateAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "sub-b", title: "Run invoke_subagent", rawInput: { Role: "Worker B", TypeName: "research", Prompt: "B" }, status: "in_progress" }, state, emit);
  translateAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "sub-b", status: "completed", rawOutput: JSON.stringify({ conversationId: conv2, logAbsoluteUri: "file:///tmp/b.jsonl" }) }, state, emit);
  assert.equal(bg.size, 2);
  assert.equal(state.acpAgents.get("sub-a").logPath, "/tmp/a.jsonl");

  // user_message_chunk 分片携带 sender=conv2，正文不回显但记入 reportedAgentConvs
  translateAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "<SYSTEM_MESSAGE>\n[Message] timestamp=1 sender=" + conv2.slice(0, 12) } }, state, emit);
  translateAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: conv2.slice(12) + " body=hi\n</SYSTEM_MESSAGE>" } }, state, emit);
  assert.equal(state.text, "", "user_message 正文不得回显到助手正文");
  assert.ok(state.reportedAgentConvs?.has(conv2), "跨 chunk 的 sender=<uuid> 必须提取入 reportedAgentConvs");

  // manage_subagents(Action: "list")：conv1=idle，conv2=running
  translateAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "list-1", title: "Run manage_subagents", rawInput: { Action: "list" }, status: "in_progress" }, state, emit);
  translateAcpUpdate({
    sessionUpdate: "tool_call_update", toolCallId: "list-1", status: "completed",
    rawOutput: `You have 2 active subagent(s):\n${JSON.stringify([
      { conversationId: conv1, transcript: "file:///tmp/a.jsonl", state: "idle" },
      { conversationId: conv2, transcript: "file:///tmp/b.jsonl", state: "running" },
    ])}`,
  }, state, emit);
  assert.equal(state.acpAgents.get("sub-a").status, "done");
  assert.equal(state.acpAgents.get("sub-b").status, "running");
  assert.equal(bg.has("sub-a"), false, "idle 子代理必须从 bgTasks 摘除");
  assert.equal(bg.has("sub-b"), true, "running 子代理必须保留");
  assert.ok(evs.some((e) => e.type === "ag" && e.k === "done" && e.id === "sub-a" && e.status === "done"));

  // send_message 给已 idle 的 sub-a 继续派活 → 对称唤醒为 running 并挂回 bgTasks
  translateAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "sm-1", title: "Run send_message", rawInput: { Recipient: conv1, Message: "再查一下" }, status: "in_progress" }, state, emit);
  translateAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "sm-1", status: "completed", rawOutput: "Message sent" }, state, emit);
  assert.equal(state.acpAgents.get("sub-a").status, "running");
  assert.equal(bg.has("sub-a"), true, "send_message 唤醒已结束子代理后应挂回 bgTasks");
  assert.ok(evs.some((e) => e.type === "ag" && e.k === "resume" && e.id === "sub-a"));
});

test("C-09 端到端：4 并行子代理 + 中文简短汇报 + /compact 跨轮收口 + stopAcpBgTask 单停不杀进程且写联络簿", async () => {
  const c1 = "c0900001-1111-2222-3333-444444444441";
  const c2 = "c0900002-1111-2222-3333-444444444442";
  const c3 = "c0900003-1111-2222-3333-444444444443";
  const c4 = "c0900004-1111-2222-3333-444444444444";
  const subLogsDir = path.join(tmpDir, "c09-sub-logs");
  fs.mkdirSync(subLogsDir, { recursive: true });
  const lp4 = path.join(subLogsDir, "sub4.jsonl");
  // 初始子代理 4 还在运行（未 DONE）
  fs.writeFileSync(lp4, JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", status: "IN_PROGRESS" }) + "\n");

  const mockBin = makeMockAgy("mock-c09-4agents.mjs", `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let initCount = 0;
let turn = 0;
const convs = [${JSON.stringify(c1)}, ${JSON.stringify(c2)}, ${JSON.stringify(c3)}, ${JSON.stringify(c4)}];
const lp4 = ${JSON.stringify(lp4)};
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    initCount++;
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-c09-e2e" } });
  if (msg.method === "session/prompt") {
    turn++;
    const sid = msg.params.sessionId;
    if (turn === 1) {
      for (let i = 0; i < 4; i++) {
        const tid = "sub-" + (i + 1);
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "tool_call", toolCallId: tid, title: "Run invoke_subagent",
          rawInput: { Role: "English Role " + (i + 1), TypeName: "research", Prompt: "task " + (i + 1) }, status: "in_progress",
        } } });
        const payload = i === 3
          ? { conversationId: convs[i], logAbsoluteUri: "file://" + lp4 }
          : { conversationId: convs[i] };
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "tool_call_update", toolCallId: tid, status: "completed", rawOutput: JSON.stringify(payload),
        } } });
      }
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已派出 4 个子代理并行处理。" },
      } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      // 空闲后 120ms：前 3 个子代理经 user_message 唤醒，主代理仅回简短中文（不提 UUID 也不提英文 Role）
      setTimeout(() => {
        for (let i = 0; i < 3; i++) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
            sessionUpdate: "user_message", content: { type: "text", text: "<SYSTEM_MESSAGE>\\n[Message] timestamp=1 sender=" + convs[i] + " done\\n</SYSTEM_MESSAGE>" },
          } } });
        }
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "前三路排查已经全部交卷啦！" },
        } } });
      }, 120);
      return;
    }
    if (turn === 2) {
      // /compact 同步轮次（不吐正文，只回 usage_update + end_turn）
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "usage_update", usage: { inputTokens: 1000, outputTokens: 200, used: 1200, size: 200000 },
      } } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    if (turn === 3) {
      // 再派一个子代理供 stopAcpBgTask 单停验证
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call", toolCallId: "sub-5", title: "Run invoke_subagent",
        rawInput: { Role: "Stop Me", TypeName: "research", Prompt: "wait" }, status: "in_progress",
      } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "tool_call_update", toolCallId: "sub-5", status: "completed", rawOutput: "",
      } } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "init=" + initCount },
    } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`);

  const busEvents = [];
  const off = onPublish((ev) => busEvents.push(ev));
  try {
    const r1 = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir, env: { ...process.env },
      prompt: "派出 4 个子代理", run: { id: "r-c09-1", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
    });
    assert.equal(r1.ok, true);
    assert.equal(getAcpPoolBg("sess-c09-e2e").length, 4);

    // 等 idleBurst flush（120ms + 1500ms）后，前 3 个子代理已结算，仅剩 sub-4
    assert.ok(await waitFor(() => getAcpPoolBg("sess-c09-e2e").length === 1, 2800), "前 3 个子代理应经 user_message sender 结算消失");
    assert.equal(getAcpPoolBg("sess-c09-e2e")[0].id, "sub-4");

    // 第 4 个子代理 transcript.jsonl 落盘 DONE + send_message，紧接着撞上同步 /compact
    fs.appendFileSync(lp4, JSON.stringify({
      source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE",
      tool_calls: [{ name: "send_message", args: { Recipient: "sess-c09-e2e" } }],
    }) + "\n" + JSON.stringify({
      source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE",
      timestamp: new Date().toISOString(), tool_calls: [],
    }) + "\n");

    const r2 = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir, env: { ...process.env },
      sessionId: "sess-c09-e2e", prompt: "/compact", run: { id: "r-c09-2", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.reused, true);
    assert.equal(getAcpPoolBg("sess-c09-e2e").length, 0, "/compact 同步轮次结束入池前必须把第 4 个已完工子代理收口清零");

    // 校验联络簿已写入 4 条 done 记录
    const recs = readAgentIndex(tmpDir, "sess-c09-e2e");
    for (const id of ["sub-1", "sub-2", "sub-3", "sub-4"]) {
      assert.ok(recs.some((x) => x.k === "done" && x.id === id && x.status === "done"), `联络簿应记入 ${id} done`);
    }

    // 第 3 轮派生 sub-5，调用 stopAcpBgTask(sid, "sub-5")：广播 ag stopped、写联络簿、但不杀常驻进程
    const r3 = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir, env: { ...process.env },
      sessionId: "sess-c09-e2e", prompt: "spawn 5", run: { id: "r-c09-3", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
    });
    assert.equal(r3.ok, true);
    assert.equal(getAcpPoolBg("sess-c09-e2e").length, 1);

    busEvents.length = 0;
    assert.equal(stopAcpBgTask("sess-c09-e2e", "sub-5"), true);
    assert.equal(getAcpPoolBg("sess-c09-e2e").length, 0);
    assert.ok(busEvents.some((e) => e.type === "ag" && e.k === "done" && e.id === "sub-5" && e.status === "stopped"), "单停子代理应广播 ag stopped 事件");
    const recsAfterStop = readAgentIndex(tmpDir, "sess-c09-e2e");
    assert.ok(recsAfterStop.some((x) => x.k === "done" && x.id === "sub-5" && x.status === "stopped"), "单停子代理应同步写入联络簿");

    // 第 4 轮验证常驻进程没有被 stopAcpBgTask(sid, "sub-5") 误杀
    const r4 = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir, env: { ...process.env },
      sessionId: "sess-c09-e2e", prompt: "still alive?", run: { id: "r-c09-4", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
    });
    assert.equal(r4.ok, true);
    assert.equal(r4.reused, true, "传入具体 taskId 单停后不得误杀空闲常驻进程");
    assert.equal(r4.resultText, "init=1");
  } finally {
    off();
    closeAcpSession("sess-c09-e2e");
  }
});

// ─────────────────────────────────────────────────────────────────────
// 3. C-02：idleBurst 泳道互斥、forceEnd 销毁卡死客户端、abortRun 解挂权限卡、pickAcpAllowOption 与 setPermMode 同步
// ─────────────────────────────────────────────────────────────────────
test("C-02：pickAcpAllowOption 仅 allow_always/allow_session 兜底，disallow 永不被选", () => {
  assert.equal(pickAcpAllowOption([{ optionId: "allow_always", kind: "allow_always" }], false)?.optionId, "allow_always");
  assert.equal(pickAcpAllowOption([{ optionId: "allow_session", kind: "allow_session" }], false)?.optionId, "allow_session");
  assert.equal(pickAcpAllowOption([{ optionId: "allow_once", kind: "allow_once" }, { optionId: "allow_always", kind: "allow_always" }], false)?.optionId, "allow_once");
  assert.equal(pickAcpAllowOption([{ optionId: "allow_once", kind: "allow_once" }, { optionId: "allow_always", kind: "allow_always" }], true)?.optionId, "allow_always");
  assert.equal(pickAcpAllowOption([{ optionId: "disallow_once", kind: "disallow_once" }], false), undefined);
  assert.equal(pickAcpAllowOption([{ optionId: "disallow_always", kind: "disallow_always" }], true), undefined);
});

test("C-02：idleBurst 期间新消息留在队列等待，不抢跑取消工具，收尾后自动唤醒出队", async () => {
  const mockBin = makeMockAgy("mock-c02-burst.mjs", `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-c02-burst" } });
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "空闲推送中" },
      } } });
    }, 80);
  }
});
`);

  const savedQ = QUEUE.splice(0, QUEUE.length);
  try {
    const r = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir, env: { ...process.env },
      prompt: "start", run: { id: "r-c02-b1", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
    });
    assert.equal(r.ok, true);
    assert.ok(await waitFor(() => hasAcpIdleBurst("sess-c02-burst"), 1000), "应进入 idleBurst 态");

    // 在 idleBurst 进行中入队一条同会话消息（不创建真实 agy，仅检查是否被拦截留在 QUEUE 中且不立刻占 RUNS）
    const item = enqueue({ message: "外部注入消息", sessionId: "sess-c02-burst" });
    assert.ok(QUEUE.some((q) => q.id === item.id), "idleBurst 期间新消息必须留在 QUEUE 等待，绝不抢跑启动并发 session/prompt");
    assert.equal(RUNS.has(item.id), false, "idleBurst 期间不得立即启动新 run");

    // 清理测试排队项后再等 idleBurst 自然收尾（防 pump 拉起真实外部 agy）
    const idx = QUEUE.findIndex((q) => q.id === item.id);
    if (idx >= 0) QUEUE.splice(idx, 1);
    assert.ok(await waitFor(() => !hasAcpIdleBurst("sess-c02-burst"), 2500), "idleBurst 应防抖正常收尾");
  } finally {
    QUEUE.splice(0, QUEUE.length, ...savedQ);
    closeAcpSession("sess-c02-burst");
  }
});

test("C-02：forceEnd 销毁卡死客户端防双进程脑裂 + abortRun/holdLane 立即解挂权限卡 + setPermMode 同步空闲池", async () => {
  const modeLog = path.join(tmpDir, "c02-mode.log");
  fs.writeFileSync(modeLog, "");
  const mockBin = makeMockAgy("mock-c02-stuck-perm.mjs", `
import fs from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const modeLog = ${JSON.stringify(modeLog)};
let pendingPerm = null;
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && msg.result && pendingPerm) { const fn = pendingPerm; pendingPerm = null; fn(msg.result); return; }
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: {
    sessionId: process.env.MOCK_SID,
    modes: { availableModes: [{ id: "default" }, { id: "accept-edits" }] },
  } });
  if (msg.method === "session/set_mode") {
    fs.appendFileSync(modeLog, "SET_MODE:" + msg.params.modeId + "\\n");
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/cancel") {
    // 故意忽略 session/cancel 模拟卡死不退
    return;
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    if (process.env.MOCK_MODE === "stuck") {
      // 永不返回 session/prompt 响应
      return;
    }
    if (process.env.MOCK_MODE === "idle-perm") {
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      if (msg.params.prompt?.[0]?.text === "arm-idle-perm") {
        setTimeout(() => {
          pendingPerm = (res) => {
            fs.appendFileSync(modeLog, "IDLE_PERM:" + JSON.stringify(res?.outcome || res) + "\\n");
          };
          send({ jsonrpc: "2.0", id: 777, method: "session/request_permission", params: {
            sessionId: sid,
            toolCall: { toolCallId: "t-idle", title: "run_command" },
            options: [{ optionId: "allow_always", kind: "allow_always" }, { optionId: "disallow", kind: "disallow" }],
          } });
        }, 120);
      }
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`);

  // A) 卡死不响应 session/cancel 的 ACP 轮次：forceEnd(run) 调 run.forceFinish() 彻底杀掉旧进程并移除池项
  const stuckRun = { id: "r-c02-stuck", text: "", sessionId: "sess-c02-stuck", lane: "s:sess-c02-stuck", log: [], ended: false };
  RUNS.set(stuckRun.id, stuckRun);
  const pStuck = runAcpTurn({
    bin: process.execPath, args: [mockBin], cwd: tmpDir,
    env: { ...process.env, MOCK_SID: "sess-c02-stuck", MOCK_MODE: "stuck" },
    prompt: "hang forever", run: stuckRun, emit: () => {}, keepAlive: true,
  });
  assert.ok(await waitFor(() => Boolean(stuckRun.child?.pid && typeof stuckRun.forceFinish === "function"), 2000), "卡死轮次应已起进程并注册 forceFinish");
  const stuckPid = stuckRun.child.pid;
  forceEnd(stuckRun);
  assert.equal(stuckRun.ended, true, "forceEnd 应结束该 run");
  const stuckRes = await pStuck;
  assert.equal(stuckRes.ok, false);
  assert.ok(await waitFor(() => !pidAlive(stuckPid), 2500), "forceEnd 必须经 forceFinish 杀掉卡死的旧 agy 进程，防双进程脑裂");

  // B) abortRun / holdLane 立即解挂未决权限卡
  const permEvents = [];
  let permResolvedVal = null;
  const permRun = {
    id: "r-c02-perm", text: "", sessionId: "sess-c02-perm", lane: "s:sess-c02-perm",
    log: [], ended: false, preSpawn: true, perms: new Map(),
  };
  permRun.perms.set("p1", { id: "p1", tool: "run_command" });
  permRun.cancelPerms = () => {
    if (!permRun.perms.delete("p1")) return;
    permEvents.push({ type: "perm_resolved", id: "p1", behavior: "deny", interrupt: true });
    permResolvedVal = { behavior: "deny", interrupt: true };
  };
  holdLane(permRun);
  assert.equal(permRun.perms.size, 0, "holdLane 必须立即清空未决权限卡");
  assert.deepEqual(permResolvedVal, { behavior: "deny", interrupt: true });
  assert.equal(permEvents.length, 1);

  // C) setPermMode 同步更新空闲池 permMode，空闲权限回调立即放行，且下次复用自动补发 session/set_mode
  const prevMode = setPermMode("default", { persist: false });
  try {
    const r1 = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir,
      env: { ...process.env, MOCK_SID: "sess-c02-mode", MOCK_MODE: "idle-perm" },
      prompt: "arm-idle-perm", permMode: "default",
      run: { id: "r-c02-m1", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
    });
    assert.equal(r1.ok, true);
    // 入池后立即切换全局模式为 bypassPermissions
    setPermMode("bypassPermissions", { persist: false });
    assert.ok(await waitFor(() => fs.readFileSync(modeLog, "utf8").includes("IDLE_PERM:"), 1500), "空闲期权限回调应被触发");
    const logAfterIdle = fs.readFileSync(modeLog, "utf8");
    assert.match(logAfterIdle, /IDLE_PERM:\{"outcome":"selected","optionId":"allow_always"\}/, "setPermMode 同步空闲池后，仅含 allow_always 的空闲权限请求应立刻自动放行");

    // 下一轮复用并传 permMode=bypassPermissions：因 appliedPermMode 仍是 default，应自动向 agent 补发 session/set_mode
    const countBefore = (logAfterIdle.match(/SET_MODE:/g) || []).length;
    const r2 = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir,
      env: { ...process.env, MOCK_SID: "sess-c02-mode", MOCK_MODE: "idle-perm" },
      sessionId: "sess-c02-mode", prompt: "turn2", permMode: "bypassPermissions",
      run: { id: "r-c02-m2", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.reused, true);
    const countAfter = (fs.readFileSync(modeLog, "utf8").match(/SET_MODE:/g) || []).length;
    assert.ok(countAfter > countBefore, "空闲池被 setPermMode 改过但尚未同步服务端时，下次复用必须自动 applyMode");
  } finally {
    if (prevMode) setPermMode("default", { persist: false });
    closeAcpSession("sess-c02-mode");
  }
});

// ─────────────────────────────────────────────────────────────────────
// 4. C-03：会话生命周期操作关闭常驻 ACP 进程 + 彻底删除清理 brain/<uuid>
// ─────────────────────────────────────────────────────────────────────
test("C-03：deleteMessage / undoDelete / moveSession / trashSession 关闭常驻进程，purgeTrash 清理 brain/<uuid>", async () => {
  const sid = crypto.randomUUID();
  const mockBin = makeMockAgy("mock-c03-life.mjs", `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
  if (msg.method === "session/new" || msg.method === "session/resume") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: ${JSON.stringify(sid)} } });
  if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(sid)}, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply-1" },
    } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`);

  const spawnPooled = async (prompt) => {
    const r = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: tmpDir, env: { ...process.env },
      sessionId: fs.existsSync(acpSessionFile(tmpDir, sid)) ? sid : null,
      prompt, run: { id: "r-c03-" + Math.random().toString(36).slice(2, 6), bgList: [], bgTasks: 0 },
      emit: () => {}, keepAlive: true,
    });
    assert.equal(r.ok, true);
    return r;
  };

  // 先跑两轮把会话放进常驻池并确保 jsonl 有内容
  await spawnPooled("第一问");
  const rCheck = await spawnPooled("第二问");
  assert.equal(rCheck.reused, true, "前置校验：正常情况下应命中常驻池复用");

  // 1) deleteMessage 必须关闭常驻进程（下轮不再 reused）
  const del = deleteMessage(sid, "第二问", 0, "bot");
  assert.equal(del.ok, true, "deleteMessage 应成功：" + JSON.stringify(del));
  const afterDel = await spawnPooled("第三问");
  assert.equal(afterDel.reused, false, "deleteMessage 后必须已关闭旧 ACP 常驻进程");

  // 2) undoDelete 必须关闭常驻进程（先删一次再撤）
  const del2 = deleteMessage(sid, "第三问", 0, "bot");
  assert.equal(del2.ok, true);
  await spawnPooled("再进池"); // 重新进池前文件变了会导致 undo 409，所以换顺序：先删、不写文件、测试直接把进程放进池较麻烦；
  // 改为在删之前确认 del2 已关池；为测 undoDelete 自身关闭池，构造另一条新会话专门测 undoDelete！
  const sidUndo = crypto.randomUUID();
  const mockUndo = makeMockAgy("mock-c03-undo.mjs", `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
  if (msg.method === "session/new" || msg.method === "session/resume") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: ${JSON.stringify(sidUndo)} } });
  if (msg.method === "session/prompt") {
    const txt = msg.params.prompt?.[0]?.text || "";
    if (txt !== "/compact") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(sidUndo)}, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply-u" },
      } } });
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`);
  await runAcpTurn({
    bin: process.execPath, args: [mockUndo], cwd: tmpDir, env: { ...process.env },
    prompt: "撤回测试问", run: { id: "r-u1", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
  });
  const dUndo = deleteMessage(sidUndo, "撤回测试问", 0, "bot");
  assert.equal(dUndo.ok, true);
  // 用 /goal 本地命令让会话不修改 jsonl size/mtime 之外……/goal 会写 jsonl，直接用 compact 无正文重新进池不写 jsonl！
  const uRePool = await runAcpTurn({
    bin: process.execPath, args: [mockUndo], cwd: tmpDir, env: { ...process.env },
    sessionId: sidUndo, prompt: "/compact", run: { id: "r-u2", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
  });
  assert.equal(uRePool.ok, true);
  const uRes = undoDelete(sidUndo, dUndo.undo);
  assert.equal(uRes.ok, true, "undoDelete 应成功：" + JSON.stringify(uRes));
  const afterUndo = await runAcpTurn({
    bin: process.execPath, args: [mockUndo], cwd: tmpDir, env: { ...process.env },
    sessionId: sidUndo, prompt: "检查是否新建进程", run: { id: "r-u3", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
  });
  assert.equal(afterUndo.reused, false, "undoDelete 必须已关闭旧 ACP 常驻进程");
  closeAcpSession(sidUndo);

  // 3) moveSession 必须关闭常驻进程
  const projDir = path.join(tmpDir, "target-proj");
  fs.mkdirSync(projDir, { recursive: true });
  const fakeProj = { id: "proj-c03-test", name: "C03 Proj", path: projDir, color: "#2f6aa8", model: "", effort: "", perm: "", created: Date.now() };
  PROJECTS.push(fakeProj);
  try {
    const rBeforeMove = await spawnPooled("迁移前");
    assert.equal(rBeforeMove.ok, true);
    const mv = moveSession(sid, fakeProj.id);
    assert.equal(mv.ok, true);
    // 若 moveSession 没关旧池，用原 cwd=tmpDir 或通过检查 session 仍在池中会命中；再迁回工作区并验证
    const rAfterMove = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: projDir, env: { ...process.env },
      sessionId: sid, prompt: "迁移后", run: { id: "r-mv-after", bgList: [], bgTasks: 0 }, emit: () => {}, keepAlive: true,
    });
    assert.equal(rAfterMove.reused, false, "moveSession 必须已关闭原常驻进程");

    // 4) trashSession 必须关闭常驻进程，且 purgeTrash 清理 brain/<uuid>
    const brainPath = path.join(CFG.home, ".gemini", "antigravity-cli", "brain", sid);
    fs.mkdirSync(path.join(brainPath, ".system_generated"), { recursive: true });
    fs.writeFileSync(path.join(brainPath, "note.md"), "hello");
    assert.equal(fs.existsSync(brainPath), true);

    const tr = trashSession(sid);
    assert.equal(tr.ok, true, "trashSession 应成功：" + JSON.stringify(tr));
    assert.equal(getAcpPoolBg(sid).length, 0);
    // 验证确实已不在池中：sessions.mjs 里也接入了 closeAcpSession（含 rewind）
    const sessionsSrc = fs.readFileSync(path.resolve(new URL("../gw/sessions.mjs", import.meta.url).pathname), "utf8");
    assert.match(sessionsSrc, /closeAcpSession\(id\)/, "sessions.mjs rewind 必须调用 closeAcpSession(id)");

    const purged = await purgeTrash([sid]);
    assert.equal(purged, 1);
    assert.equal(fs.existsSync(brainPath), false, "purgeTrash 彻底删除合法 UUID 会话时必须清理 brain/<uuid> 目录");
  } finally {
    const idx = PROJECTS.indexOf(fakeProj);
    if (idx >= 0) PROJECTS.splice(idx, 1);
    closeAcpSession(sid);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 5. C-04：多步工具调用后新 messageId 完整 agent_message / agent_thought 不丢字
// ─────────────────────────────────────────────────────────────────────
test("C-04：Step 1 文本 → 工具调用 → Step 2 新 messageId 整段 agent_message 与 agent_thought 均不丢字", () => {
  const evs = [];
  const state = {
    text: "", thinking: "", tools: new Map(), knownToolIds: new Set(),
    usage: null, promptSent: true, permMode: "default",
  };
  const emit = (e) => evs.push(e);

  // Step 1：思考 + 正文（chunk 或整条）
  translateAcpUpdate({ sessionUpdate: "agent_thought", messageId: "th-step1", content: { type: "text", text: "第一步思考：" } }, state, emit);
  translateAcpUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg-step1", content: { type: "text", text: "先查一下文件。" } }, state, emit);

  // 中间工具调用
  translateAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "read_file", rawInput: { Path: "/a" }, status: "in_progress" }, state, emit);
  translateAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", content: [{ type: "text", text: "ok" }] }, state, emit);

  // Step 2：新的 messageId 整条 agent_thought 与整条 agent_message（此前无 chunk）
  translateAcpUpdate({ sessionUpdate: "agent_thought", messageId: "th-step2", content: { type: "text", text: "第二步总结思考。" } }, state, emit);
  translateAcpUpdate({ sessionUpdate: "agent_message", messageId: "msg-step2", content: { type: "text", text: "最终结论：全部正常。" } }, state, emit);

  assert.equal(state.thinking, "第一步思考：第二步总结思考。", "Step 2 新 messageId 的整段 agent_thought 不得被 Step 1 吞掉");
  assert.equal(state.text, "先查一下文件。最终结论：全部正常。", "Step 2 新 messageId 的整段 agent_message 不得被 Step 1 吞掉");

  // 同一 msg-step2 再发一次整条或 chunk，仍应去重
  translateAcpUpdate({ sessionUpdate: "agent_message", messageId: "msg-step2", content: { type: "text", text: "最终结论：全部正常。" } }, state, emit);
  translateAcpUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg-step2", content: { type: "text", text: "最终结论：全部正常。" } }, state, emit);
  assert.equal(state.text, "先查一下文件。最终结论：全部正常。", "同 messageId 重复投递仍应去重");

  // 无 messageId 的整条 agent_message / agent_thought 仍保持防重复（已有正文时不重复追加）
  translateAcpUpdate({ sessionUpdate: "agent_message", content: { type: "text", text: "无ID重放" } }, state, emit);
  translateAcpUpdate({ sessionUpdate: "agent_thought", content: { type: "text", text: "无ID思考" } }, state, emit);
  assert.equal(state.text, "先查一下文件。最终结论：全部正常。");
  assert.equal(state.thinking, "第一步思考：第二步总结思考。");
});
