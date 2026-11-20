// F-2：/goal 在 ACP 下应在本轮被网关拦截处理、写 goal_status 落盘，
// 不发给 agy；F-3/F-4：goalStateOf 缓存与 tasksOf 会话号。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { goalStateOf, tasksOf, applyGoalCommand, parseGoalPrompt } from "../gw/goal.mjs";
import { acpSessionFile, runAcpTurn, closeAcpSession } from "../gw/acp.mjs";

const dir = fs.mkdtempSync(path.join(CFG.workspace, "fix-f234-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const J = (o) => JSON.stringify(o) + "\n";

// ── F-2：applyGoalCommand 单元级 ──
test("F-2 /goal <条件> 写 goal_status，goalStateOf 读到 active；/goal clear 后读到 null", () => {
  const f = path.join(dir, "s-goal.jsonl");
  fs.writeFileSync(f, "");
  const r1 = applyGoalCommand(f, "测试全过");
  assert.equal(r1.goal?.active, true);
  assert.equal(r1.goal?.condition, "测试全过");
  assert.equal(goalStateOf(f)?.active, true);
  const r2 = applyGoalCommand(f, "clear");
  assert.equal(r2.goal, null);
  assert.equal(goalStateOf(f), null);
});

test("F-2 parseGoalPrompt：只认行首 /goal，普通文本不认", () => {
  assert.equal(parseGoalPrompt("/goal 测试全过"), "测试全过");
  assert.equal(parseGoalPrompt("/goal"), "");
  assert.equal(parseGoalPrompt("  /goal clear  "), "clear");
  assert.equal(parseGoalPrompt("帮我实现 /goal 功能"), null);
  assert.equal(parseGoalPrompt("/goals xxx"), null);
});

// ── F-2：runAcpTurn 级（mock agy，断言 session/prompt 没被调到）──
function makeMockAgy(d) {
  const script = path.join(d, "mock-agy-goal");
  fs.writeFileSync(script, `#!${process.execPath}\nconst fs = require("node:fs");\nconst readline = require("node:readline");\nconst rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });\nconst send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");\nrl.on("line", (line) => {\n  const t = line.trim(); if (!t) return;\n  const msg = JSON.parse(t);\n  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });\n  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "goal-sess-1" } });\n  if (msg.method === "session/prompt") { fs.appendFileSync(${JSON.stringify(path.join(d, "prompt-called"))}, "1"); return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }); }\n  if (msg.id) return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });\n});\n`, { mode: 0o755 });
  return script;
}

test("F-2 runAcpTurn('/goal …') 不调 session/prompt，目标落盘且可读", async () => {
  const mockBin = makeMockAgy(dir);
  const events = [];
  try {
    const res = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: CFG.workspace, env: process.env,
      prompt: "/goal 测试全过", keepAlive: false, emit: (ev) => events.push(ev),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.sessionId, "goal-sess-1");
    assert.match(res.resultText || "", /目标/);
    assert.ok(events.some((e) => e.type === "result"), "应发 result 事件");
    assert.ok(!fs.existsSync(path.join(dir, "prompt-called")), "不应调 session/prompt");
    const g = goalStateOf(acpSessionFile(CFG.workspace, "goal-sess-1"));
    assert.equal(g?.active, true, "会话文件里应能读到 active 目标");
    assert.equal(g?.condition, "测试全过");
  } finally {
    closeAcpSession("goal-sess-1");
  }
});

// ── F-3：tasksOf 放行非 UUID 会话号 ──
test("F-3 tasksOf('agy-sess-001') 读到清单；'../' 被拒", () => {
  const base = path.join(CFG.home, ".claude", "tasks", "agy-sess-001");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "1.json"), JSON.stringify({ id: "1", subject: "做 A", status: "pending" }));
  fs.writeFileSync(path.join(base, "2.json"), JSON.stringify({ id: "2", subject: "做 B", status: "in_progress" }));
  const list = tasksOf("agy-sess-001");
  assert.ok(Array.isArray(list) && list.length === 2, "应读到 2 条，实际：" + JSON.stringify(list));
  assert.equal(list[0].subject, "做 A");
  assert.equal(tasksOf("../x"), null);
  assert.equal(tasksOf(""), null);
});

// ── F-4：同尺寸原地改写后缓存失效 ──
test("F-4 同字节数原地改写 goal_status（未达成→已达成）后读到新结论", () => {
  const f = path.join(dir, "s-cache.jsonl");
  const setRec = { type: "attachment", timestamp: "2026-11-20T10:00:00.000Z", attachment: { type: "goal_status", met: false, sentinel: true, condition: "AAA", note: "p".repeat(120) } };
  const metBase = { type: "attachment", timestamp: "2026-11-20T10:05:00.000Z", attachment: { type: "goal_status", met: true, condition: "AAA", iterations: 3, durationMs: 1000, tokens: 10, reason: "" } };
  const s1 = J(setRec);
  fs.writeFileSync(f, s1);
  assert.equal(goalStateOf(f)?.active, true);
  const pad = s1.length - J(metBase).length;
  assert.ok(pad >= 0, "测试前置：met 行不能比 set 行长");
  const metRec = { ...metBase, attachment: { ...metBase.attachment, reason: "x".repeat(pad) } };
  const s3 = J(metRec);
  assert.equal(s3.length, s1.length, "两版必须同字节数");
  fs.writeFileSync(f, s3);
  const g2 = goalStateOf(f);
  assert.equal(g2?.done, true, "改写后应读到已达成，实际：" + JSON.stringify(g2));
  assert.equal(g2?.met, true);
});
