import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { CFG, PATHS } from "../gw/config.mjs";
import { RUNS } from "../gw/runs.mjs";
import { listSessions, routeSessions } from "../gw/sessions.mjs";
import { acpSessionFile, persistAcpUserTurn, persistAcpTurn, translateAcpUpdate } from "../gw/acp.mjs";

test("persistAcpUserTurn + persistAcpTurn(existingUserUuid)：首轮提前落盘用户行，回合结束不重复写用户行", () => {
  const sid = "acp-live-turn-" + Date.now();
  const cwd = CFG.workspace;
  const file = acpSessionFile(cwd, sid);
  fs.rmSync(file, { force: true });
  try {
    const startedAt = Date.now() - 500;
    const uId = persistAcpUserTurn({
      cwd,
      sessionId: sid,
      userText: "接管全部工作文件",
      timestamp: new Date(startedAt + 10).toISOString(),
    });
    assert.ok(uId, "应返回 userUuid");
    assert.ok(fs.existsSync(file), "session/prompt 发出前 jsonl 已存在");

    persistAcpTurn({
      cwd,
      sessionId: sid,
      userText: "接管全部工作文件",
      assistantText: "已完成解压与接管。",
      thinking: "先核对 sha256",
      tools: [{ id: "t1", name: "Bash", input: { command: "tar -xf a.tar.zst" }, output: "ok", isError: false }],
      model: "gemini-4-carbon",
      existingUserUuid: uId,
    });

    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const userMsgLines = lines.filter((l) => l.type === "user" && typeof l.message?.content === "string");
    assert.equal(userMsgLines.length, 1, "只写一条用户提问行，不重复");
    assert.equal(userMsgLines[0].uuid, uId);
    const toolAsst = lines.find((l) => l.type === "assistant" && Array.isArray(l.message?.content) && l.message.content.some((b) => b.type === "tool_use"));
    assert.ok(toolAsst, "应写出工具调用行");
    assert.equal(toolAsst.parentUuid, uId, "工具行应挂在预写入的 userUuid 下");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("listSessions 与 GET /api/session/:id：首轮 jsonl 尚未落盘的在跑会话也能列出并打开（不 404）", async () => {
  const sid = "live-no-file-" + Date.now();
  const runId = "r-live-no-file-" + Date.now();
  const startedAt = Date.now();
  RUNS.set(runId, {
    id: runId,
    sessionId: sid,
    cwd: CFG.workspace,
    text: "解压 3.17 GB 备份并接管",
    startedAt,
    ended: false,
  });

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    await routeSessions(req, res, u, u.pathname);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const list = listSessions(50);
    const entry = list.find((s) => s.id === sid);
    assert.ok(entry, "listSessions 应包含尚未落盘的在跑会话");
    assert.match(entry.title, /解压 3\.17 GB/);

    const r1 = await fetch(`${base}/api/session/${sid}`);
    assert.equal(r1.status, 200, "打开尚未落盘的在跑会话应返回 200 而非 404");
    const j1 = await r1.json();
    assert.equal(j1.id, sid);
    assert.equal(j1.liveRunId, runId);
    assert.deepEqual(j1.items, []);

    const r2 = await fetch(`${base}/api/session/${sid}/agents`);
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.deepEqual(j2.records, []);
  } finally {
    RUNS.delete(runId);
    await new Promise((r) => srv.close(r));
  }
});

test("前端 sessionsWithLive：srv.runs 已带 sessionId 但 state.sessions 未刷新时立即补齐侧栏/会话页入口", () => {
  const src07 = fs.readFileSync(new URL("../web/app/07-sessions.js", import.meta.url), "utf8");
  const start = src07.indexOf("function sessionsWithLive()");
  const end = src07.indexOf("function renderSessions()", start);
  assert.ok(start > 0 && end > start, "应存在 sessionsWithLive()");
  const ctx = {
    state: { sessions: [{ id: "old-1", title: "旧对话", mtime: 1000 }] },
    srv: {
      runs: [
        { id: "r1", sessionId: "new-live-1", text: "接管全部工作文件", cwd: "/w", startedAt: 2000 },
        { id: "r2", sessionId: "old-1", text: "已在列表里", cwd: "/w", startedAt: 3000 },
        { id: "r3", sessionId: null, text: "还没拿到会话号的草稿", cwd: "/w", startedAt: 4000 },
      ],
    },
    t: (s) => s,
  };
  const merged = vm.runInNewContext(src07.slice(start, end) + "\nsessionsWithLive();", ctx);
  assert.equal(merged.length, 2, "只补齐缺失的已建号在跑会话，不重复也不混入无 sessionId 草稿");
  assert.equal(merged[0].id, "new-live-1");
  assert.equal(merged[0].title, "接管全部工作文件");
  assert.equal(merged[0].cwd, "/w");
});

test("上下文条防串台：前端 usage 事件必须经 belongs(ev) 校验，ACP 丢弃异会话 session/update", () => {
  const src04 = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
  assert.match(src04, /case "usage":\s+if \(belongs\(ev\) && \(ev\.contextTokens \|\| ev\.contextWindow\)\)/);

  const belongsStart = src04.indexOf("function belongs(ev)");
  const belongsEnd = src04.indexOf("function onBus(ev)", belongsStart);
  assert.ok(belongsStart > 0 && belongsEnd > belongsStart);

  const calls = [];
  const ctx = {
    view: { sessionId: "sess-B", runIds: new Set(["run-B"]), cids: new Set() },
    state: { ctxUsed: 63000, ctxTotal: 1048576 },
    liveCtx: (u, t) => { calls.push([u, t]); ctx.state.ctxUsed = u; ctx.state.ctxTotal = t; },
  };
  const runCase = vm.runInNewContext(
    src04.slice(belongsStart, belongsEnd) + `
    (ev) => {
      if (belongs(ev) && (ev.contextTokens || ev.contextWindow)) liveCtx(ev.contextTokens ?? state.ctxUsed, ev.contextWindow || state.ctxTotal);
    }`,
    ctx,
  );

  // 别的会话（A：380k/400k 接近爆满）的活跃/空闲 usage 不得污染当前会话 B
  runCase({ type: "usage", runId: "run-A", sessionId: "sess-A", contextTokens: 390000, contextWindow: 1048576 });
  runCase({ type: "usage", sessionId: "sess-A", contextTokens: 420000, contextWindow: 1048576 });
  assert.equal(calls.length, 0, "其他会话的 usage 不得改写当前视图上下文条");

  // 当前会话的空闲 usage（无 runId，匹配 sessionId）与轮内 usage（匹配 runId）正常更新
  runCase({ type: "usage", sessionId: "sess-B", contextTokens: 64000, contextWindow: 1048576 });
  runCase({ type: "usage", runId: "run-B", contextTokens: 68000 });
  assert.deepEqual(calls, [[64000, 1048576], [68000, 1048576]]);

  // ACP 层：不同 sessionId 的 session/update（如子代理或串线通知）直接丢弃
  const emitted = [];
  const st = { sessionId: "sess-B", promptSent: true, usage: { context_tokens: 68000, context_window: 1048576 } };
  translateAcpUpdate({ sessionId: "sess-subagent", update: { sessionUpdate: "usage_update", used: 999999, size: 1048576 } }, st, (e) => emitted.push(e));
  assert.equal(emitted.length, 0);
  assert.equal(st.usage.context_tokens, 68000);
});
