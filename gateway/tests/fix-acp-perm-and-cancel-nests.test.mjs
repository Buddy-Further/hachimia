import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import {
  closeAcpSession,
  closeAllAcpClients,
  isAcpCanceledToolOutput,
  runAcpTurn,
  setAcpPoolPermMode,
} from "../gw/acp.mjs";
import { transcriptItems } from "../gw/transcript.mjs";

const tmpDir = fs.mkdtempSync(path.join(CFG.workspace, "acp-perm-cancel-nests-"));
after(() => {
  closeAllAcpClients();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeExecutableAgyMock(name, body) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return file;
}

const jsonlOf = (cwd, sid) => path.join(PATHS.projects, String(cwd).replace(/[^A-Za-z0-9]/g, "-"), `${sid}.jsonl`);

test("Nest #1：bypassPermissions 为 agy acp 注入 --dangerously-skip-permissions 与 --add-dir，且无视缺失的 additionalDirectories 能力声明透传附加目录", async () => {
  const mockBin = makeExecutableAgyMock("mock-agy-flags.js", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let lastNewParams = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    // 复刻真实 agy 1.5.13 BuildInitializeResult：不声明 sessionCapabilities.additionalDirectories
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "agy", version: "1.5.13" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, fork: {} } },
      },
    });
  }
  if (msg.method === "session/new" || msg.method === "session/resume") {
    lastNewParams = msg.params;
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: msg.params.sessionId || "sess-flags-1",
        modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "accept-edits" }, { id: "plan" }] },
      },
    });
  }
  if (msg.method === "session/set_mode") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const payload = JSON.stringify({ argv: process.argv.slice(2), addDirs: lastNewParams?.additionalDirectories || null });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "agent_message", messageId: "m-1", content: payload } },
    });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`);

  const extraDir = path.join(tmpDir, "shared-hachimia");
  fs.mkdirSync(extraDir, { recursive: true });

  // 1) 纯 bypassPermissions + 无 disallowedTools：注入 --dangerously-skip-permissions 与 --add-dir，且 session/new 带 additionalDirectories
  const r1 = await runAcpTurn({
    bin: mockBin,
    args: ["acp"],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "check flags",
    permMode: "bypassPermissions",
    addDirs: [extraDir],
    keepAlive: true,
    emit: () => {},
  });
  assert.equal(r1.ok, true);
  const parsed1 = JSON.parse(r1.resultText);
  assert.ok(parsed1.argv.includes("acp"));
  assert.ok(parsed1.argv.includes("--dangerously-skip-permissions"), "bypassPermissions 应为 agy acp 传 --dangerously-skip-permissions");
  assert.ok(parsed1.argv.includes(`--add-dir=${extraDir}`), "附加目录应同步传 --add-dir=<dir>");
  assert.deepEqual(parsed1.addDirs, [extraDir], "即使 initialize 未声明 additionalDirectories，session/new 也必须携带 additionalDirectories");

  // 2) 全局从 bypassPermissions 降权切回 default：setAcpPoolPermMode 必须立即清退带 skip-perms 的常驻 worker，下轮不带该旗标重连
  setAcpPoolPermMode("default");
  const r2 = await runAcpTurn({
    bin: mockBin,
    args: ["acp"],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "after downgrade",
    sessionId: "sess-flags-1",
    permMode: "default",
    addDirs: [extraDir],
    keepAlive: true,
    emit: () => {},
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.reused, false, "降权后不得复用带 --dangerously-skip-permissions 的旧 worker");
  const parsed2 = JSON.parse(r2.resultText);
  assert.ok(!parsed2.argv.includes("--dangerously-skip-permissions"), "default 模式绝不可携带 --dangerously-skip-permissions");
  assert.deepEqual(parsed2.addDirs, [extraDir], "session/resume 同样必须携带 additionalDirectories");

  // 3) 含 disallowedTools 时即使 permMode=bypassPermissions 也绝不注入 --dangerously-skip-permissions，保证 onRequest 仍能拦截禁用工具
  const r3 = await runAcpTurn({
    bin: mockBin,
    args: ["acp"],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "with disallowed",
    permMode: "bypassPermissions",
    disallowedTools: ["search_web"],
    keepAlive: false,
    emit: () => {},
  });
  assert.equal(r3.ok, true);
  const parsed3 = JSON.parse(r3.resultText);
  assert.ok(!parsed3.argv.includes("--dangerously-skip-permissions"), "存在 disallowedTools 时不得跳过权限回调");
  closeAcpSession("sess-flags-1");
});

test("Nest #1：轮中通过 run.setMode 从 bypassPermissions 降权后，回合结束不保留越权常驻进程", async () => {
  const mockBin = makeExecutableAgyMock("mock-agy-midturn-downgrade.js", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
  }
  if (msg.method === "session/new" || msg.method === "session/resume") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId: "sess-mid-downgrade", modes: { currentModeId: "accept-edits", availableModes: [{ id: "default" }, { id: "accept-edits" }] } },
    });
  }
  if (msg.method === "session/set_mode") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message", messageId: "m1", content: JSON.stringify(process.argv.slice(2)) } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }, 60);
  }
});
`);

  const runObj = { id: "r-mid-down", permMode: "bypassPermissions" };
  const p = runAcpTurn({
    bin: mockBin,
    args: ["acp"],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "first",
    permMode: "bypassPermissions",
    run: runObj,
    keepAlive: true,
    emit: () => {},
  });
  await new Promise((r) => setTimeout(r, 25));
  await runObj.setMode?.("default");
  const r1 = await p;
  assert.equal(r1.ok, true);
  assert.ok(JSON.parse(r1.resultText).includes("--dangerously-skip-permissions"));

  const r2 = await runAcpTurn({
    bin: mockBin,
    args: ["acp"],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "second",
    sessionId: "sess-mid-downgrade",
    permMode: "default",
    keepAlive: false,
    emit: () => {},
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.reused, false, "轮中降权后应销毁旧 skip-perms 进程并在下一轮冷启动");
  assert.ok(!JSON.parse(r2.resultText).includes("--dangerously-skip-permissions"));
});

test("Nest #2：复刻 v0.8.1-dev.1 发版后台任务取消竞态——保留 69 行 task 日志、纠回 cancelled 不报红、jsonl 与 transcriptItems 全链路还原已取消", async () => {
  assert.equal(isAcpCanceledToolOutput("Command was terminated by signal or canceled."), true);
  assert.equal(isAcpCanceledToolOutput("Tool execution was canceled"), true);
  assert.equal(isAcpCanceledToolOutput("Error: exit code 1"), false);

  const brainDir = path.join(tmpDir, "brain");
  const sid = "sess-ship-cancel-race";
  const taskDir = path.join(brainDir, sid, ".system_generated", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const taskLogPath = path.join(taskDir, "task-5160.log");
  const publishLines = Array.from({ length: 68 }, (_, i) => `[step ${i + 1}/68] uploading asset chunk...`)
    .concat(["✓ v0.8.1-dev.1 已发布"])
    .join("\n");
  fs.writeFileSync(taskLogPath, publishLines + "\n");

  const mockBin = makeExecutableAgyMock("mock-agy-cancel-race.js", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const logPath = process.env.MOCK_TASK_LOG;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (msg.method === "session/new") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "${sid}" } });
  }
  if (msg.method === "session/set_mode") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method === "session/prompt") {
    const s = msg.params.sessionId;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: s,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_ship_5160",
          title: "run_command",
          name: "run_command",
          kind: "execute",
          status: "in_progress",
          rawInput: { CommandLine: "node scripts/ship-dev.mjs 1 --publish" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: s,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_ship_5160",
          status: "in_progress",
          content: [{
            type: "text",
            text: "Tool is running as a background task with task id: " + s + "/task-5160\\nTask logs are available at: " + logPath,
          }],
        },
      },
    });
    // 复刻真实 agy updates.go:62 竞态：先发 status="failed" + "Command was terminated by signal or canceled."，再回 stopReason="cancelled"
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: s,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_ship_5160",
            status: "failed",
            content: [{ type: "text", text: "Command was terminated by signal or canceled." }],
          },
        },
      });
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } });
      }, 25);
    }, 90);
  }
});
`);

  const events = [];
  const res = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env, MOCK_TASK_LOG: taskLogPath },
    prompt: "发一下开发版",
    brainDir,
    activeBgPollMs: 30,
    keepAlive: false,
    emit: (ev) => events.push(ev),
  });

  assert.equal(res.ok, true);
  assert.equal(res.stopReason, "cancelled");

  const toolResults = events.filter((e) => e.type === "tool_result" && e.id === "call_ship_5160");
  assert.ok(toolResults.length >= 1);
  const finalToolRes = toolResults[toolResults.length - 1];
  assert.equal(finalToolRes.cancelled, true, "终态 tool_result 必须纠回 cancelled: true");
  assert.equal(finalToolRes.is_error, false, "终态 tool_result 不得标 is_error: true");
  assert.equal(finalToolRes.ok, true, "前端契约 ok 必须为 true（配合 cancelled: true 显示已取消而非失败）");
  assert.ok(finalToolRes.text.includes("✓ v0.8.1-dev.1 已发布"), "后台任务已输出的 69 行发布日志必须完整保留，不得被覆盖清空");

  // 验证 .jsonl 落盘与 transcriptItems 历史重载均保留 cancelled: true 且包含发布日志
  const jFile = jsonlOf(tmpDir, sid);
  assert.ok(fs.existsSync(jFile));
  const lines = fs.readFileSync(jFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const items = lines.flatMap((l) => transcriptItems(l));
  const restoredRes = items.find((x) => x.role === "tool_result" && x.id === "call_ship_5160");
  assert.ok(restoredRes, "transcriptItems 必须还原 tool_result");
  assert.equal(restoredRes.ok, true);
  assert.equal(restoredRes.cancelled, true, "历史重载必须透传 cancelled: true，防已取消卡片变成绿勾完成或红叉失败");
  assert.ok(restoredRes.text.includes("✓ v0.8.1-dev.1 已发布"));

  // 静态核验前端两处历史渲染入口均向 toolResult 透传第 4 参数 !!m.cancelled
  const chatViewSrc = fs.readFileSync(new URL("../web/app/02-chat-view.js", import.meta.url), "utf8");
  const permStatusSrc = fs.readFileSync(new URL("../web/app/03-perm-status.js", import.meta.url), "utf8");
  assert.match(chatViewSrc, /toolResult\(m\.id,\s*m\.ok,\s*m\.text,\s*!!m\.cancelled\)/);
  assert.match(permStatusSrc, /toolResult\(m\.id,\s*m\.ok,\s*m\.text,\s*!!m\.cancelled\)/);
});

test("Nest #2：轮中主动停止单条后台任务（dropAcpBg）后，其被信号终止的 tool_call_update 标为 cancelled 而非红框失败，且真实中段错误仍照常报红", async () => {
  const mockBin = makeExecutableAgyMock("mock-agy-stop-single-bg.js", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (msg.method === "session/new") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-stop-single-bg" } });
  }
  if (msg.method === "session/set_mode") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method === "session/prompt") {
    const s = msg.params.sessionId;
    // 1) 启动后台任务 tc-bg-1
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: s,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-bg-1",
          title: "run_command",
          name: "run_command",
          kind: "execute",
          status: "in_progress",
          rawInput: { CommandLine: "sleep 30" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: s,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-bg-1",
          status: "in_progress",
          content: [{ type: "text", text: "Tool is running as a background task with task id: " + s + "/task-99" }],
        },
      },
    });
    // 2) 等主进程调 dropAcpBg("task-99") 后（180ms），agy 发来被终止的 failed 更新；同时另一个未被主动停止的工具 tc-err-2 发生意外取消，随后整轮正常 end_turn
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: s,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-bg-1",
            status: "failed",
            content: [{ type: "text", text: "Command was terminated by signal or canceled." }],
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: s,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-err-2",
            title: "run_command",
            name: "run_command",
            kind: "execute",
            status: "failed",
            rawInput: { CommandLine: "bad cmd" },
            content: [{ type: "text", text: "Tool execution was canceled" }],
          },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }, 180);
  }
});
`);

  const runObj = { id: "r-stop-bg", bgList: [] };
  const events = [];
  const p = runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: tmpDir,
    env: { ...process.env },
    prompt: "bg test",
    run: runObj,
    keepAlive: false,
    emit: (ev) => events.push(ev),
  });
  const waitEnd = Date.now() + 2000;
  while (Date.now() < waitEnd && !(runObj.bgList || []).some((x) => String(x.id).endsWith("task-99"))) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(runObj.dropAcpBg?.("task-99"), true);
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.stopReason, "end_turn");

  const bgRes = events.find((e) => e.type === "tool_result" && e.id === "tc-bg-1");
  assert.ok(bgRes);
  assert.equal(bgRes.cancelled, true, "主动停止的后台任务收到信号终止时应标 cancelled: true");
  assert.equal(bgRes.is_error, false);
  assert.equal(bgRes.ok, true);

  const errRes = events.find((e) => e.type === "tool_result" && e.id === "tc-err-2");
  assert.ok(errRes);
  assert.equal(errRes.is_error, true, "非主动停止且整轮未取消的中段错误不得被误吞，仍须报红");
  assert.equal(errRes.ok, false);
});
