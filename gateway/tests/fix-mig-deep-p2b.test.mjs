// hachimia 迁移收尾深修 p2b：MIG-16/18/19/20/21/22/23/24/27/29/30/31/33/35
//   先写出能复现的失败测试再修（任务单 test-first）。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CFG, PATHS } from "../gw/config.mjs";
import {
  runAcpTurn, closeAllAcpClients, translateAcpUpdate,
  mergeToolOutput, pickAcpAllowOption, killAcpChild,
} from "../gw/acp.mjs";
import { onPublish } from "../gw/bus.mjs";
import { RECOVER_HOOKS } from "../gw/queue.mjs";
import { _schedForTest as S } from "../gw/sched.mjs";
import { projectRisks } from "../gw/projtrust.mjs";
import { routeFiles, safeFilePath } from "../gw/files.mjs";
import { NEXT } from "../gw/http.mjs";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── mock agy：模式由 MOCK_MODE 选；同一进程第 2 次 prompt 起慢 1500ms ──
function makeMockAgy(dir) {
  const script = path.join(dir, "mock-agy-p2b");
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.env.MOCK_MODE || "fast";
const logFile = process.env.MOCK_LOG || "/tmp/mig-p2b-mock.log";
const pidFile = process.env.MOCK_PID_FILE || "";
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const sid = "mig-p2b-sess";
let promptCount = 0;
let pendingPerm = null;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  fs.appendFileSync(logFile, t + "\\n");
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (msg.id && msg.result && pendingPerm) { const fn = pendingPerm; pendingPerm = null; fn(msg.result); return; }
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (msg.method === "authenticate") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/new") {
    if (mode === "noid") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid, models: { currentModelId: "gemini-4-neon" } } });
  }
  if (msg.method === "session/load") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId, models: { currentModelId: "gemini-4-neon" } } });
  if (msg.method === "session/resume") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId } });
  if (msg.method === "session/set_config_option" || msg.method === "session/set_mode") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/cancel") return;
  if (msg.method === "session/prompt") {
    promptCount++;
    const s = msg.params.sessionId || sid;
    const finish = () => send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    if (mode === "pretty") {
      const marker = "GARBAGE-" + "X".repeat(300);
      process.stdout.write(marker + "\\n");
      const pretty = { jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "多行正文" } } } };
      process.stdout.write(JSON.stringify(pretty, null, 2) + "\\n");
      return finish();
    }
    if (mode === "disallow") {
      pendingPerm = (res) => {
        fs.appendFileSync(logFile, "PERM-OUTCOME:" + JSON.stringify(res?.outcome || res) + "\\n");
        const allowed = res?.outcome?.optionId === "allow_once";
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: allowed ? "completed" : "failed", content: [{ type: "text", text: allowed ? "hi" : "denied" }] } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "已完成执行！" : "用户拒绝了操作。" } } } });
        finish();
      };
      return send({ jsonrpc: "2.0", id: 9001, method: "session/request_permission", params: { sessionId: s, toolCall: { toolCallId: "tc-1", title: "run_shell", rawInput: { command: "echo hi" } }, options: [{ optionId: "disallow", kind: "disallow" }] } });
    }
    if (mode === "idleusage") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "idle-ok" } } } });
      finish();
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "usage_update", usage: { inputTokens: 5000, outputTokens: 10, contextWindow: 200000 } } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "current_mode_update", currentModeId: "accept-edits" } } });
      }, 300);
      return;
    }
    const delay = promptCount >= 2 ? 1500 : 0;
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      finish();
    }, delay);
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
    run: { id: "r-p2b-" + Math.random().toString(36).slice(2, 8), bgList: [], bgTasks: 0 },
    emit: () => {},
    keepAlive: false,
    ...extra,
  };
}
const countMethod = (logFile, method) => {
  try { return (fs.readFileSync(logFile, "utf8").match(new RegExp(method.replace("/", "\\/"), "g")) || []).length; } catch { return 0; }
};
const jsonlOf = (sid) => path.join(PATHS.projects, String(CFG.workspace).replace(/[^A-Za-z0-9]/g, "-"), `${sid}.jsonl`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(step); }
  return cond();
}

// ── MIG-20：mergeToolOutput 最长重叠后缀去重 ──
test("MIG-20 mergeToolOutput：重叠增量只补新尾巴，不拼重复", () => {
  assert.equal(mergeToolOutput("abc", "bcd"), "abcd");
  assert.equal(mergeToolOutput("abcdef", "defghi"), "abcdefghi");
  assert.equal(mergeToolOutput("ababa", "baba"), "ababa");
  assert.equal(mergeToolOutput("abc", "abc"), "abc");
  assert.equal(mergeToolOutput("abc", "abcd"), "abcd");
  assert.equal(mergeToolOutput("abc", "xyz"), "abc\nxyz");
  assert.equal(mergeToolOutput("", "bcd"), "bcd");
  assert.equal(mergeToolOutput("abc", ""), "abc");
});

test("MIG-20 经 translateAcpUpdate：两段重叠 tool_call_update 不翻倍", () => {
  const st = { text: "", thinking: "", tools: new Map(), knownToolIds: new Set(), usage: null, promptSent: true, permMode: "default" };
  const ev = [];
  translateAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "text", text: "abc" }] }, st, (e) => ev.push(e));
  translateAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "text", text: "bcd" }] }, st, (e) => ev.push(e));
  assert.equal(st.tools.get("t1").output, "abcd");
});

// ── MIG-21：权限自动放行锚定匹配 ──
test("MIG-21 pickAcpAllowOption：disallow 不当允许项，allow_once 优先", () => {
  assert.equal(pickAcpAllowOption([{ optionId: "disallow", kind: "disallow" }]), undefined);
  assert.equal(pickAcpAllowOption([{ optionId: "disallow_once", kind: "disallow_once" }]), undefined);
  assert.equal(pickAcpAllowOption([{ optionId: "disallow" }, { optionId: "allow_once", kind: "allow_once" }]).optionId, "allow_once");
  assert.equal(pickAcpAllowOption([{ optionId: "allow_always", kind: "allow_always" }]), undefined, "allow_always 不是 allow_once，不能由 allow 档位代取");
  assert.equal(pickAcpAllowOption([]), undefined);
  assert.equal(pickAcpAllowOption([{ optionId: "weird" }]).optionId, "weird", "未知 kind 的首选项保留旧兜底");
});

test("MIG-21 端到端：bypass 下只发 disallow 选项，不被当允许点掉", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-disallow-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  try {
    const r = await runAcpTurn(runOpts(mockBin, logFile, {
      prompt: "hi", permMode: "bypassPermissions", env: { ...process.env, MOCK_LOG: logFile, MOCK_MODE: "disallow" },
    }));
    assert.equal(r.ok, true, r.error || "");
    const m = fs.readFileSync(logFile, "utf8").match(/PERM-OUTCOME:(.*)/);
    assert.ok(m, "mock 应记下权限决定");
    const outcome = JSON.parse(m[1]);
    assert.notEqual(outcome.outcome, "selected", "disallow 不能被当允许项选中：" + JSON.stringify(outcome));
    assert.equal(outcome.optionId, undefined, "不应选中任何允许项");
    assert.match(r.resultText || "", /拒绝/);
  } finally { closeAllAcpClients(); }
});

// ── MIG-22：session/new 不回会话号当场报错 ──
test("MIG-22 session/new 回 {}：当场失败，不自造 UUID 继续跑", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-noid-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  try {
    const r = await runAcpTurn(runOpts(mockBin, logFile, {
      prompt: "hi", env: { ...process.env, MOCK_LOG: logFile, MOCK_MODE: "noid" },
    }));
    assert.equal(r.ok, false, "无会话号应失败，实际 ok 且 sessionId=" + r.sessionId);
    assert.match(String(r.error || ""), /会话号/);
    assert.equal(countMethod(logFile, "session/prompt"), 0, "失败前不应发 prompt");
  } finally { closeAllAcpClients(); }
});

// ── MIG-23：非 JSON stdout 行缓冲拼接 / 完整记日志 ──
test("MIG-23 多行 pretty-JSON 通知不丢失；丢弃行记完整内容", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-pretty-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  try {
    const r = await runAcpTurn(runOpts(mockBin, logFile, {
      prompt: "hi", env: { ...process.env, MOCK_LOG: logFile, MOCK_MODE: "pretty" },
    }));
    assert.equal(r.ok, true, r.error || "");
    assert.ok(String(r.resultText || "").includes("多行正文"), "pretty-JSON 里的 chunk 应进正文，实际：" + r.resultText);
  } finally { closeAllAcpClients(); }
  // 丢弃行记完整内容：log() 在测试模式（!LIVE）是不写文件的 no-op，文件断言跑不出来，
  // 用源码锚点锁住——旧的 160 字截断已删，丢弃日志用完整 candidate。
  const acpSrc = readSrc("gateway/gw/acp.mjs");
  assert.ok(!acpSrc.includes("slice(0, 160)"), "丢弃行不应再截断 160 字");
  assert.ok(acpSrc.includes("log(`[acp] 非 JSON stdout 行: ${candidate}`)"), "丢弃行应记完整内容");
});

// ── MIG-16：空闲期 usage / current_mode_update 只更新 entry，不开 burst ──
test("MIG-16 空闲期用量/模式更新进账但不开 burst", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-idle-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  const seen = [];
  const off = onPublish((ev) => seen.push(ev));
  try {
    const r = await runAcpTurn(runOpts(mockBin, logFile, {
      prompt: "hi", keepAlive: true,
      env: { ...process.env, MOCK_LOG: logFile, MOCK_MODE: "idleusage" },
    }));
    assert.equal(r.ok, true, r.error || "");
    const before = fs.existsSync(jsonlOf(r.sessionId)) ? fs.readFileSync(jsonlOf(r.sessionId), "utf8").trim().split("\n").length : 0;
    seen.length = 0;
    await sleep(1000);
    const usage = seen.find((e) => e.type === "usage" && e.contextTokens === 5000);
    assert.ok(usage, "空闲 usage_update 应推用量事件，实际推了：" + JSON.stringify(seen.map((e) => e.type)));
    assert.equal(usage.contextWindow, 200000);
    assert.ok(seen.some((e) => e.type === "perm_mode" && e.mode === "acceptEdits"), "空闲 current_mode_update 应推 perm_mode");
    assert.ok(!seen.some((e) => e.type === "run_start"), "只更新用量/模式，不应开 run_start burst");
    assert.ok(!seen.some((e) => e.type === "run_end"), "不应有 burst 的 run_end");
    const after = fs.existsSync(jsonlOf(r.sessionId)) ? fs.readFileSync(jsonlOf(r.sessionId), "utf8").trim().split("\n").length : 0;
    assert.equal(after, before, "不开 burst 就不应多落盘一行");
  } finally { off(); closeAllAcpClients(); }
});

// ── MIG-18：池忙 entry 不被覆盖泄漏 ──
test("MIG-18 忙命中新建的第二进程不进池：旧轮结束前不被覆盖，忙轮进程轮后即毁", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-busy-"));
  const mockBin = makeMockAgy(tmp);
  const logFile = path.join(tmp, "mock.log");
  fs.writeFileSync(logFile, "");
  const pidA = path.join(tmp, "pidA"), pidB = path.join(tmp, "pidB");
  const baseEnv = { ...process.env, MOCK_LOG: logFile };
  let runA2;
  try {
    const r1 = await runAcpTurn(runOpts(mockBin, logFile, {
      prompt: "hi", keepAlive: true, env: { ...baseEnv, MOCK_PID_FILE: pidA },
    }));
    assert.equal(r1.ok, true, r1.error || "");
    const sid = r1.sessionId;
    const pA = runAcpTurn(runOpts(mockBin, logFile, {
      prompt: "slow round", sessionId: sid, keepAlive: true,
      run: runA2 = { id: "r-p2b-a2", bgList: [], bgTasks: 0 }, env: { ...baseEnv, MOCK_PID_FILE: pidA },
    }));
    await sleep(300); // A2 已复用池进程、prompt 在慢等
    const rB = await runAcpTurn(runOpts(mockBin, logFile, {
      prompt: "hi", sessionId: sid, keepAlive: true, env: { ...baseEnv, MOCK_PID_FILE: pidB },
    }));
    assert.equal(rB.ok, true, rB.error || "");
    const pidBv = Number(fs.readFileSync(pidB, "utf8").trim());
    const pidAv = Number(fs.readFileSync(pidA, "utf8").trim());
    assert.ok(await waitFor(() => !alive(pidBv), 2000), "后来者 B 的进程应在轮后被销毁，不留孤儿");
    assert.ok(alive(pidAv), "旧轮 A2 的进程应还在跑");
    const rA2 = await pA;
    assert.equal(rA2.ok, true, rA2.error || "");
    assert.equal(countMethod(logFile, "initialize"), 2, "A1 建 1 次 + B 建 1 次，A2 复用不应再 initialize");
    assert.ok(alive(pidAv), "旧轮结束后池里仍应是 A 的进程");
  } finally {
    try { runA2?.child?.kill("SIGKILL"); } catch {}
    closeAllAcpClients();
  }
});

// ── MIG-19：closeAcpSession 按进程组杀，超时 SIGKILL ──
test("MIG-19 killAcpChild：SIGTERM 整组带走孙进程", async () => {
  const child = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true });
  try {
    assert.ok(child.pid > 0);
    killAcpChild(child);
    assert.ok(await waitFor(() => { try { process.kill(-child.pid, 0); return false; } catch { return true; } }, 2000),
      "进程组应在 SIGTERM 后消失");
    assert.ok(!alive(child.pid), "组长也应已死");
  } finally { try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} }
});

test("MIG-19 killAcpChild：忽略 SIGTERM 的组长在宽限期后被 SIGKILL", async () => {
  const child = spawn("sh", ["-c", "trap '' TERM; sleep 30 & wait"], { detached: true });
  try {
    killAcpChild(child, 300);
    assert.ok(await waitFor(() => !alive(child.pid), 3000), "宽限期后组长应被 SIGKILL");
  } finally { try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} }
});

test("MIG-19 closeAcpSession 走进程组杀（源码锚点）", () => {
  const src = readSrc("gateway/gw/acp.mjs");
  assert.ok(src.includes("killAcpChild(entry.client.child)"), "closeAcpSession 应调 killAcpChild");
  assert.ok(!src.includes('entry.client.child?.kill?.("SIGTERM")'), "不应再只 SIGTERM 组长单进程");
});

// ── MIG-24：RECOVER_HOOKS 补记失败后同样排重试 ──
test("MIG-24 启动恢复的失败轮次同样排 2 分钟重试并落盘", () => {
  const t1 = { id: "mig24-t1", name: "mig24-1", prompt: "x", on: true, freq: { kind: "daily", time: "09:00" }, nextAt: Date.now() + 3600e3, session: "new", projectId: null, busy: "run", retry: 1, limitCost: 0, limitMin: 15 };
  const t0 = { id: "mig24-t0", name: "mig24-0", prompt: "x", on: true, freq: { kind: "daily", time: "09:00" }, nextAt: Date.now() + 3600e3, session: "new", projectId: null, busy: "run", retry: 0, limitCost: 0, limitMin: 15 };
  S.DB.tasks.push(t1, t0);
  try {
    for (const h of RECOVER_HOOKS) h([
      { id: "mig24-run1", sched: { taskId: "mig24-t1" }, startedAt: Date.now(), sessionId: null },
      { id: "mig24-run0", sched: { taskId: "mig24-t0" }, startedAt: Date.now(), sessionId: null },
    ]);
    assert.equal(S.hasRetry("mig24-t1"), true, "retry=1 的任务恢复失败后应有重试");
    const onDisk = JSON.parse(fs.readFileSync(path.join(CFG.home, "ccapp-sched.json"), "utf8"));
    const row = (onDisk.retries || []).find((r) => r.taskId === "mig24-t1");
    assert.ok(row, "重试应落盘到 ccapp-sched.json，实际：" + JSON.stringify(onDisk.retries));
    assert.equal(row.attempt, 1);
    assert.ok(row.at - Date.now() > 60000 && row.at - Date.now() <= 2 * 60000 + 5000, "重试应在约 2 分钟后");
    assert.equal(S.hasRetry("mig24-t0"), false, "retry=0 的任务不应排重试");
    assert.ok(S.runlog().some((r) => r.taskId === "mig24-t1" && r.st === "err"), "失败运行记录照旧补记");
  } finally {
    S.cancelRetry("mig24-t1"); S.cancelRetry("mig24-t0");
    for (const t of [t1, t0]) { const i = S.DB.tasks.indexOf(t); if (i >= 0) S.DB.tasks.splice(i, 1); }
  }
});

// ── MIG-27：前端收到 acp-session-switched 后不对本轮 detachRun（源码锚点） ──
test("MIG-27 前端按 note 抑制一次摘走（源码锚点）", () => {
  const src = readSrc("gateway/web/app/04-session-flow.js");
  assert.ok(src.includes("switchedRuns"), "应有抑制集合 switchedRuns");
  assert.ok(src.includes('ev.key === "acp-session-switched"'), "note 里收到 acp-session-switched 应登记");
  assert.ok(src.includes("switchedRuns.add(ev.runId)"), "应按 runId 登记一次");
  assert.ok(src.includes("switchedRuns.delete(ev.runId)"), "init 里应按 runId 消费一次抑制");
  const initIdx = src.indexOf('case "init"');
  const guardIdx = src.indexOf("switchedRuns.delete(ev.runId)");
  const detachIdx = src.indexOf("detachRun(ev.runId)");
  assert.ok(initIdx >= 0 && guardIdx > initIdx && detachIdx > guardIdx, "抑制判断应在 init 分支里、detachRun 之前");
});

// ── MIG-29：终端 stderr 同样用 StringDecoder（源码锚点） ──
test("MIG-29 终端 stderr 用 StringDecoder 且收尾时冲干净（源码锚点）", () => {
  const src = readSrc("gateway/gw/terminal.mjs");
  assert.ok(src.includes("decErr"), "应有 stderr 专用的 StringDecoder");
  assert.ok(src.includes("decErr.write(d)"), "stderr 应经 decErr.write 解码");
  assert.ok(src.includes("decErr.end()"), "收尾时应冲出 decErr 残留字节");
  assert.ok(!src.includes('child.stderr.on("data", (d) => out(d.toString()))'), "不应再按块 toString 切坏多字节字符");
});

// ── MIG-30：安装子进程不继承 CCAPP_TOKEN_FILE（源码锚点） ──
test("MIG-30 Installer.run 起进程前删掉 CCAPP_TOKEN_FILE（源码锚点）", () => {
  const src = readSrc("android/java/ha/chi/mia/Installer.java");
  const applyIdx = src.indexOf("env.apply(pb.environment())");
  const removeIdx = src.indexOf('pb.environment().remove("CCAPP_TOKEN_FILE")');
  assert.ok(applyIdx >= 0, "Installer.run 应调 env.apply");
  assert.ok(removeIdx > applyIdx, "apply 之后、起进程之前应删掉 CCAPP_TOKEN_FILE");
});

// ── MIG-31：GatewaySquattedTest 接入 java-tests.sh ──
test("MIG-31 java-tests.sh 编译并运行 GatewaySquattedTest", () => {
  const src = readSrc("scripts/java-tests.sh");
  assert.ok(src.includes("GatewaySquattedTest.java"), "应编译 GatewaySquattedTest.java");
  assert.ok(src.includes("ha.chi.mia.GatewaySquattedTest"), "应运行 ha.chi.mia.GatewaySquattedTest");
});

// ── MIG-33：文件读取 O_NOFOLLOW 打开后 fstat 复核 ──
test("MIG-33a projtrust 读配置不跟软链：.claude/settings.json 是软链时当读不到", () => {
  const proj = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-proj-"));
  const target = path.join(CFG.home, "mig-p2b-target-settings.json");
  fs.writeFileSync(target, JSON.stringify({ permissions: { allow: ["Bash"] } }));
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  fs.symlinkSync(target, path.join(proj, ".claude", "settings.json"));
  try {
    assert.equal(projectRisks(proj), null, "软链指向的风险配置不应被读到");
  } finally { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(target, { force: true }); }
});

test("MIG-33b /api/file：核完到打开之间文件被换成另一个 inode，拒绝服务旧核查结果", async (t) => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const file = path.join(CFG.workspace, "mig33-real.txt");
  const decoy = path.join(CFG.workspace, "mig33-decoy.txt");
  fs.writeFileSync(file, "REAL");
  fs.writeFileSync(decoy, "DECOY");
  const r = safeFilePath(file);
  assert.ok(Number.isInteger(r.dev) && Number.isInteger(r.ino), "safeFilePath 应带回 dev/ino 供复核");
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await routeFiles(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const okRes = await fetch(base + "/api/file?path=" + encodeURIComponent(file));
    assert.equal(okRes.status, 200);
    assert.equal(await okRes.text(), "REAL");
    // 模拟核完后换文件：openSync 被换成打开另一个 inode
    const realOpen = fs.openSync;
    const m = t.mock.method(fs, "openSync", (p, ...rest) => (p === r.file ? realOpen(decoy, ...rest) : realOpen(p, ...rest)));
    try {
      const badRes = await fetch(base + "/api/file?path=" + encodeURIComponent(file));
      assert.equal(badRes.status, 404, "打开的已不是核过的那个文件，应拒绝");
      assert.notEqual(await badRes.text(), "DECOY");
    } finally { m.mock.restore(); }
  } finally { fs.rmSync(file, { force: true }); fs.rmSync(decoy, { force: true }); }
});

// ── MIG-35：rg 包装先查 devkit 的 rg，目标不存在时明确报错 ──
test("MIG-35 rg 包装：devkit 有 rg 就用它；都没有就明确报错而非 exec 不存在的路径", () => {
  const rg = path.join(ROOT, "android", "assets", "bin", "rg");
  const run = (env) => spawnSync("sh", [rg, "arg1"], { encoding: "utf8", env });
  const baseEnv = { ...process.env, PATH: "/usr/bin:/bin" };
  for (const k of Object.keys(baseEnv)) if (/^CCAPP_(LD|GLIBC_PRELOAD|CLAUDE_PRELOAD|NATIVE_LIB)/.test(k)) delete baseEnv[k];

  const pre1 = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-rg1-"));
  const home1 = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-rg1h-"));
  fs.mkdirSync(path.join(pre1, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pre1, "bin", "rg"), "#!/bin/sh\necho \"DEVKIT-RG:$@\"\n", { mode: 0o755 });
  const a = run({ ...baseEnv, PREFIX: pre1, HOME: home1 });
  assert.equal(a.status, 0, "devkit rg 应直接跑：" + JSON.stringify(a));
  assert.match(a.stdout, /DEVKIT-RG:arg1/);

  const pre2 = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-rg2-"));
  const home2 = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-rg2h-"));
  const b = run({ ...baseEnv, PREFIX: pre2, HOME: home2 });
  assert.equal(b.status, 127, "两个目标都不存在时应以 127 明确失败，实际：" + JSON.stringify(b));
  assert.match(b.stderr, /命令行增强/, "报错应指明去装「命令行增强」，而不是加载器找不到文件");
  assert.doesNotMatch(b.stderr, /No such file|ld-linux/, "不应是 exec 不存在路径的加载器报错");

  const pre3 = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-rg3-"));
  const home3 = fs.mkdtempSync(path.join(CFG.home, "mig-p2b-rg3h-"));
  const claudeBin = path.join(home3, ".local", "share", "cccodroid", "claude", "current", "claude");
  fs.mkdirSync(path.dirname(claudeBin), { recursive: true });
  fs.writeFileSync(claudeBin, "#!/bin/sh\necho claude-rg\n", { mode: 0o755 });
  const fakeLd = path.join(pre3, "fake-ld");
  fs.writeFileSync(fakeLd, "#!/bin/sh\necho \"LD:$@\"\n", { mode: 0o755 });
  const c = run({ ...baseEnv, PREFIX: pre3, HOME: home3, CCAPP_LD: fakeLd });
  assert.equal(c.status, 0, "旧 Claude 路径真实存在时仍可走回退：" + JSON.stringify(c));
  assert.match(c.stdout, /--argv0 rg/);
  assert.ok(c.stdout.includes(claudeBin), "回退应指向真实存在的 claude 二进制");
});
