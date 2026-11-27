// 前端契约：session_created 重读列表；续不上的重连也重读
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sessionSource = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const take = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));
const nodes = () => ({ classList: { add() {}, remove() {} }, querySelector() { return null; }, childElementCount: 0, innerHTML: "" });

test("前端：session_created 事件重读会话列表", () => {
  assert.match(sessionSource, /case "session_created": return loadSessions\(\);/);
});

function runHello(helloCount, resume, dropped) {
  const calls = { sessions: 0 };
  const view = { sessionId: "s-a", gen: 0, runIds: new Set(), cids: new Set(), next: null, anchor: "", cursor: null, title: "", pendingMerge: null };
  const box = {
    view, state: { pendingModel: null }, Set, Map, t: (s) => s, uiTag: "synthetic-ui", helloCount, stick: false, busDropped: dropped,
    WROTE: new Map(), TOOL_CARDS: new Map(), TOOL_RESULTS: new Map(), clearToolResults() {}, dropCards() {}, PERMS: new Map(), runViews: new Map(),
    histEl: nodes(), liveEl: nodes(), olderEl: nodes(), statEl: nodes(), statLast: {}, statStop() {},
    stripHidden: () => ({}), paintTitle() {}, renderRunStrip() {}, renderPermBar() {}, agReset() {}, syncWindow() {}, pickViewRun() {}, renderQueue() {}, paintProjChip() {}, syncInterject() {}, saveUiState() {},
    applyState() {}, beginReplay() {}, updateCtx() {}, renderSessions() {}, loadOlder() {}, showWelcome() {}, renderInterrupted() {}, calmStatus() {}, refreshSessModel() {},
    isBusy: () => false, setStatus() {}, intrList: () => [],
    draftSwap() {}, loadSessions: () => { calls.sessions++; },
  };
  vm.runInNewContext(
    take(sessionSource, "  function resetView(", "  /** 打开某个会话") +
    take(sessionSource, "  function onHello(", "  /** 「已连接」") +
    "\nglobalThis.handoff = { onHello };",
    box,
  );
  box.handoff.onHello({ uiTag: "synthetic-ui", resume, interrupted: [], run: null });
  return calls;
}

test("前端：首次连接不重复拉列表（boot 已经拉过）", () => {
  assert.equal(runHello(0, false, false).sessions, 0);
});
test("前端：换视图的主动重放（连接没断过）不重拉列表", () => {
  assert.equal(runHello(3, false, false).sessions, 0);
});
test("前端：断线后还续得上（resume=true）靠补发事件，不重拉列表", () => {
  assert.equal(runHello(1, true, true).sessions, 0);
});
test("前端：断线后续不上（resume=false）的重连按磁盘重读列表", () => {
  assert.equal(runHello(1, false, true).sessions, 1);
});
