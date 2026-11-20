// B 分片修复测试（单元层）：B1/B2 双发去重、B3/B4 重放隔离、B6 跟发会话号、B7 成功清 incomplete
import test from "node:test";
import assert from "node:assert/strict";
import { translateAcpUpdate } from "../gw/acp.mjs";
import { RUN_SESSIONS, sidForItem, setInterrupted, INTERRUPTED } from "../gw/queue.mjs";
import { noteAcpInit, clearAcpTurnMarkers } from "../gw/run.mjs";
import { markIncomplete, incompleteOf } from "../gw/incomplete.mjs";

function mkState(extra = {}) {
  const evs = [];
  return {
    state: {
      text: "", thinking: "", tools: new Map(), knownToolIds: new Set(),
      usage: null, promptSent: true, replaySeenAt: 0, permMode: "default", sessionId: "s1",
      ...extra,
    },
    evs,
    emit: (e) => evs.push(e),
  };
}
const upd = (kind, extra = {}) => ({ update: { sessionUpdate: kind, ...extra } });
const textOf = (t) => ({ type: "text", text: t });

test("B1 agent_message 整条先到、chunk 后到：同文只算一次", () => {
  const { state, evs, emit } = mkState();
  translateAcpUpdate(upd("agent_message", { messageId: "m1", content: textOf("你好世界") }), state, emit);
  translateAcpUpdate(upd("agent_message_chunk", { messageId: "m1", content: textOf("你好世界") }), state, emit);
  assert.equal(state.text, "你好世界");
  assert.equal(evs.filter((e) => e.type === "text_delta").length, 1);
});

test("B1 chunk 先到、agent_message 后到：同文只算一次；不同 id 的 chunk 仍正常追加", () => {
  const { state, evs, emit } = mkState();
  translateAcpUpdate(upd("agent_message_chunk", { messageId: "m2", content: textOf("你好世界") }), state, emit);
  translateAcpUpdate(upd("agent_message", { messageId: "m2", content: textOf("你好世界") }), state, emit);
  assert.equal(state.text, "你好世界");
  translateAcpUpdate(upd("agent_message_chunk", { messageId: "m3", content: textOf("，续") }), state, emit);
  assert.equal(state.text, "你好世界，续");
});

test("B1 整条消息到达两次（同一 messageId）：只采用一次", () => {
  const { state, evs, emit } = mkState();
  translateAcpUpdate(upd("agent_message", { messageId: "m9", content: textOf("正文") }), state, emit);
  translateAcpUpdate(upd("agent_message", { messageId: "m9", content: textOf("正文") }), state, emit);
  assert.equal(state.text, "正文");
  assert.equal(evs.filter((e) => e.type === "text_delta").length, 1);
});

test("B2 agent_thought 整条与 chunk 双发：思考只算一次", () => {
  const { state, evs, emit } = mkState();
  translateAcpUpdate(upd("agent_thought", { messageId: "th1", content: textOf("让我想想") }), state, emit);
  translateAcpUpdate(upd("agent_thought_chunk", { messageId: "th1", content: textOf("让我想想") }), state, emit);
  assert.equal(state.thinking, "让我想想");
  translateAcpUpdate(upd("agent_thought_chunk", { messageId: "th2", content: textOf("，再想想") }), state, emit);
  assert.equal(state.thinking, "让我想想，再想想");
});

test("B3 prompt 前见过的重放 messageId：prompt 后再到直接丢弃", () => {
  const { state, evs, emit } = mkState({ promptSent: false });
  translateAcpUpdate(upd("agent_message", { messageId: "msg-old-9", content: textOf("旧回复") }), state, emit);
  assert.equal(state.text, "");
  state.promptSent = true;
  translateAcpUpdate(upd("agent_message", { messageId: "msg-old-9", content: textOf("旧回复") }), state, emit);
  assert.equal(state.text, "");
  assert.equal(evs.filter((e) => e.type === "text_delta").length, 0);
  // 本轮真正的新消息不受影响
  translateAcpUpdate(upd("agent_message_chunk", { messageId: "m-new", content: textOf("本轮正文") }), state, emit);
  assert.equal(state.text, "本轮正文");
});

test("B4 prompt 前见过的重放 tool_call_update：prompt 后同 id 不建工具卡；jsonl 已见 id 同理", () => {
  const { state, evs, emit } = mkState({ promptSent: false });
  translateAcpUpdate(upd("tool_call_update", { toolCallId: "tc-old-7", title: "run_shell", status: "in_progress" }), state, emit);
  assert.equal(state.tools.size, 0);
  state.promptSent = true;
  translateAcpUpdate(upd("tool_call_update", { toolCallId: "tc-old-7", title: "run_shell", status: "in_progress" }), state, emit);
  assert.equal(state.tools.size, 0);
  assert.equal(evs.filter((e) => e.type === "tool_use").length, 0);
  // 本轮新工具仍正常建卡
  translateAcpUpdate(upd("tool_call_update", { toolCallId: "tc-new-1", title: "run_shell", status: "in_progress" }), state, emit);
  assert.equal(state.tools.size, 1);
  assert.equal(evs.filter((e) => e.type === "tool_use").length, 1);
});

test("B4 jsonl 里已见过的工具 id：prompt 后重放直接丢弃", () => {
  const { state, evs, emit } = mkState({ knownToolIds: new Set(["tc-hist-3"]) });
  translateAcpUpdate(upd("tool_call_update", { toolCallId: "tc-hist-3", title: "run_shell", status: "in_progress" }), state, emit);
  assert.equal(state.tools.size, 0);
  assert.equal(evs.filter((e) => e.type === "tool_use").length, 0);
});

test("B6 ACP 新会话 init 后：跟发消息能通过 RUN_SESSIONS 找到会话号", () => {
  RUN_SESSIONS.clear();
  const run = { id: "rAAA", log: [{ type: "run_start", sessionId: null }] };
  noteAcpInit(run, "agy-sess-001");
  assert.equal(run.sessionId, "agy-sess-001");
  assert.equal(run.log[0].sessionId, "agy-sess-001");
  assert.equal(sidForItem({ id: "q2", sessionId: null, follow: "rAAA" }), "agy-sess-001");
});

test("B7 ACP 回合成功后清 incomplete 与中断卡；用户主动停止的不清", () => {
  const sid = "sess-b7-" + Date.now();
  markIncomplete(sid, "r-b7");
  setInterrupted([{ id: "i-b7", sessionId: sid, text: "x" }]);
  assert.ok(incompleteOf(sid));
  const run = { id: "r-b7", sessionId: sid, intrPending: true, aborted: false };
  clearAcpTurnMarkers(run, { ok: true, sessionId: sid });
  assert.equal(incompleteOf(sid), null);
  assert.equal(run.intrPending, false);
  assert.ok(!INTERRUPTED.some((e) => e.sessionId === sid));

  // 用户点了停止：标记要留着，下次才有「继续」卡
  markIncomplete(sid, "r-b7b");
  const run2 = { id: "r-b7b", sessionId: sid, intrPending: true, aborted: true };
  clearAcpTurnMarkers(run2, { ok: false, sessionId: sid });
  assert.ok(incompleteOf(sid));
  assert.equal(run2.intrPending, true);
});
