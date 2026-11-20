// F-1：ACP 前台子代理完成应发 ag done 且落盘到 agents 联络簿；
// 后台启动（输出含 background/running）不应发 done（回归 guard）。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { translateAcpUpdate } from "../gw/acp.mjs";
import { readAgentIndex, agentsDir } from "../gw/agents.mjs";

const cwd = fs.mkdtempSync(path.join(CFG.workspace, "fix-f1-"));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));

const mkState = (sid) => ({
  sessionId: sid, cwd, text: "", thinking: "", tools: new Map(), knownToolIds: new Set(),
  usage: null, promptSent: true, permMode: "default",
  onBgAdd: () => {}, onBgRemove: () => {}, onCommands: () => {},
});
const runCase = (sid, title, input, doneOut) => {
  const evs = [];
  const st = mkState(sid);
  const emit = (e) => evs.push(e);
  translateAcpUpdate({ update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title, rawInput: input, status: "in_progress" } }, st, emit);
  translateAcpUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: doneOut } }, st, emit);
  return evs.filter((e) => e.type === "ag");
};

test("F-1 前台 invoke_subagent 完成 → ag done(status=done)，且联络簿落盘 spawn+done", () => {
  const sid = "sess-f1-fg";
  const ags = runCase(sid, "invoke_subagent", { Role: "Reviewer", Prompt: "review" }, "结论：全部通过，没有问题。");
  assert.ok(ags.some((e) => e.k === "spawn"), "应有 spawn");
  assert.ok(ags.some((e) => e.k === "done" && e.status === "done"), "前台完成应有 ag done，实际：" + JSON.stringify(ags));
  const recs = readAgentIndex(cwd, sid);
  assert.ok(recs.some((r) => r.k === "spawn"), "联络簿应有 spawn 记录，实际：" + JSON.stringify(recs));
  assert.ok(recs.some((r) => r.k === "done" && r.status === "done"), "联络簿应有 done 记录");
  const dir = agentsDir(cwd, sid);
  assert.ok(fs.existsSync(path.join(dir, "index.jsonl")), "应写 index.jsonl");
  const sub = fs.readdirSync(dir).filter((n) => /^\d+-/.test(n));
  assert.equal(sub.length, 1, "应有一个子代理目录");
  assert.ok(fs.existsSync(path.join(dir, sub[0], "brief.md")), "应写 brief.md");
  assert.ok(fs.existsSync(path.join(dir, sub[0], "report.md")), "应写 report.md");
});

test("F-1 后台启动 invoke_subagent（输出含 running in background）→ 不发 done", () => {
  const ags = runCase("sess-f1-bg", "invoke_subagent", { Role: "Reviewer", Prompt: "review" },
    "Launched subagent conversationId=11111111-2222-3333-4444-555555555555 running in background");
  assert.ok(ags.some((e) => e.k === "spawn"), "应有 spawn");
  assert.ok(!ags.some((e) => e.k === "done"), "后台启动不应发 done，实际：" + JSON.stringify(ags));
});

test("F-1 前台 invoke_subagent 出错 → ag done(status=failed)", () => {
  const evs = [];
  const st = mkState("sess-f1-err");
  const emit = (e) => evs.push(e);
  translateAcpUpdate({ update: { sessionUpdate: "tool_call", toolCallId: "tc-9", title: "invoke_subagent", rawInput: { Role: "Reviewer", Prompt: "review" }, status: "in_progress" } }, st, emit);
  translateAcpUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "tc-9", status: "failed", rawOutput: "boom" } }, st, emit);
  const ags = evs.filter((e) => e.type === "ag");
  assert.ok(ags.some((e) => e.k === "done" && e.status === "failed"), "出错应有 failed done，实际：" + JSON.stringify(ags));
});
