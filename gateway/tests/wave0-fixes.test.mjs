import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import {
  closeAllAcpClients,
  isAcpToolDisallowed,
  resolveAcpToolName,
  runAcpTurn,
  translateAcpUpdate,
} from "../gw/acp.mjs";
import { routeRun } from "../gw/run.mjs";
import { RUNS } from "../gw/runs.mjs";
import { NEXT } from "../gw/http.mjs";
import { chapterProfile } from "../gw/profile.mjs";
import { registryFlockFixture } from "./fixtures/registry-flock.mjs";

const readWeb = (rel) => fs.readFileSync(new URL("../web/" + rel, import.meta.url), "utf8");
const cut = (text, start, end) => {
  const a = text.indexOf(start);
  assert.ok(a >= 0, "missing start marker: " + start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(b > a, "missing end marker: " + end);
  return text.slice(a, b);
};

test("2.3: resolveAcpToolName 不允许带参数的 run_command title 绕过 acpToolGroups / disallowedTools", () => {
  assert.equal(resolveAcpToolName({ title: "run_command echo hi", kind: "execute" }, { CommandLine: "echo hi" }), "run_command");
  assert.equal(resolveAcpToolName({ title: "run_command echo hi" }, {}), "run_command");
  assert.equal(resolveAcpToolName({ title: "run_command (build)" }, { CommandLine: "make" }), "run_command (build)");
  assert.equal(resolveAcpToolName({ title: "RUN_COMMAND" }, {}), "RUN_COMMAND");

  assert.equal(isAcpToolDisallowed(resolveAcpToolName({ title: "run_command echo hi" }, {}), "", ["Bash"]), true);
  assert.equal(isAcpToolDisallowed(resolveAcpToolName({ title: "run_command echo hi" }, {}), "", ["run_command"]), true);
  assert.equal(isAcpToolDisallowed(resolveAcpToolName({ title: "run_command (build)" }, {}), "", ["Bash"]), true);
});

test("6.2: 03-perm-status.js PermCard / permDone / renderPermBar 一致使用 permToolLabel", () => {
  const chatSrc = readWeb("app/02-chat-view.js");
  const permSrc = readWeb("app/03-perm-status.js");
  const toolsBlock = cut(chatSrc, "  function summarizeTool(", "  /** 收着的子代理");
  const permBlock = cut(permSrc, "  const permToolLabel =", "  // 卡片里已经勾的")
    + "\n"
    + cut(permSrc, "  function renderPermBar(", "  permBar.addEventListener");

  const makeEl = (tag = "div") => {
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      dataset: {},
      className: "",
      innerHTML: "",
      textContent: "",
      removed: false,
      isConnected: true,
      disabled: false,
      classList: {
        add: (...xs) => xs.forEach((x) => classes.add(x)),
        remove: (...xs) => xs.forEach((x) => classes.delete(x)),
        toggle: (x, force) => (force === undefined ? (classes.has(x) ? classes.delete(x) : classes.add(x)) : force ? classes.add(x) : classes.delete(x)),
        contains: (x) => classes.has(x),
      },
      querySelector(sel) {
        if (sel === ".perm-acts") return actsEl;
        if (sel === ".perm-body") return bodyEl;
        if (sel === ".perm-head") return headEl;
        if (sel === ".perm-deny") return denyEl;
        if (sel === ".perm-deny textarea") return textareaEl;
        return null;
      },
      querySelectorAll: () => [],
      addEventListener() {},
      after() {},
      remove() { el.removed = true; },
    };
    const actsEl = { dataset: {}, innerHTML: "" };
    const bodyEl = { removed: false, remove() { bodyEl.removed = true; } };
    const headEl = { innerHTML: "" };
    const denyEl = { classList: { toggle() {}, contains: () => true }, querySelector: () => textareaEl };
    const textareaEl = { value: "", focus() {} };
    return { el, actsEl, bodyEl, headEl };
  };

  const perms = new Map();
  const bubbleChildren = [];
  const permBar = { classList: { toggle() {} }, innerHTML: "" };
  const box = {
    PERMS: perms,
    PERM_ANSWERED: new Set(),
    TOOL_CARDS: new Map(),
    Map,
    Set,
    JSON,
    srv: { runs: [{ id: "r1", permMode: "default" }], run: { id: "r1" } },
    state: { permissionMode: "default", settings: { permNotice: false } },
    runViews: new Map([["r1", { av: { bubble: { appendChild: (x) => bubbleChildren.push(x) } } }]]),
    liveEl: { appendChild() {} },
    permBar,
    permWaiting: false,
    document: { createElement: (t) => makeEl(t).el },
    t: (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "") : s),
    esc: (s) => String(s ?? ""),
    uiI: (k) => `[${k}]`,
    renderMd: (s) => s,
    setStatus() {},
    isBusy: () => false,
    WIDE_MODES: ["bypassPermissions", "auto", "dontAsk"],
    modeLabel: (m) => m,
    runMode: () => "default",
    permRules: () => [],
    permSuggestsEdits: () => false,
    permDiffHtml: (a, b) => `<diff>${a}=>${b}</diff>`,
    permGuardWhat: () => "guard",
    pendingPerms: () => [...perms.values()].filter((it) => !it.done),
  };
  vm.runInNewContext(
    toolsBlock + "\n" + permBlock + "\nglobalThis.exports = { permToolLabel, permActions, PermCard, permDone, renderPermBar };",
    box,
  );
  const { permToolLabel, PermCard, permDone, renderPermBar } = box.exports;

  // 1) 未归一 ask_question 标题，靠 questions 入参归一
  const askP = { id: "p-ask", tool: "Ask me a quick question", input: { questions: [{ question: "Pick one?", options: ["A"] }] } };
  assert.equal(permToolLabel(askP), "ask_question");
  const askWrap = makeEl("div");
  box.document.createElement = () => askWrap.el;
  const cardAsk = PermCard(askP, "r1");
  perms.set(askP.id, { p: askP, runId: "r1", el: cardAsk, done: false });
  assert.ok(cardAsk.innerHTML.includes("pa-answer"), "PermCard 应按归一后的 ask_question 渲染提交回答按钮");
  assert.ok(cardAsk.innerHTML.includes("Antigravity 想问你"));
  renderPermBar();
  assert.ok(permBar.innerHTML.includes("Antigravity 想问你"));
  assert.ok(!permBar.innerHTML.includes("pb-allow"), "ask_question 不应渲染简单允许按钮");
  permDone(askP.id, "allow");
  assert.equal(askWrap.bodyEl.removed, false, "ask_question 收起时保留正文");
  assert.ok(askWrap.headEl.innerHTML.includes("✓ 已回答"));

  // 2) 未归一 Edit 长标题 -> edit_file + UserConfig 保持完整
  const editP = { id: "p-edit", tool: "Edit /data/user/0/ha.chi.mia/files/home/workspace/app.js", input: { AbsolutePath: "/data/a.js", TargetContent: "1", ReplacementContent: "2" } };
  assert.equal(permToolLabel(editP), "edit_file");
  const editWrap = makeEl("div");
  box.document.createElement = () => editWrap.el;
  const cardEdit = PermCard(editP, "r1");
  assert.ok(cardEdit.innerHTML.includes("/data/a.js"), "permPreview 应支持 AbsolutePath");

  const ucP = { id: "p-uc", tool: "UserConfig", input: { changes: [{ kind: "changed", rel: ".bashrc" }] } };
  assert.equal(permToolLabel(ucP), "UserConfig");
  const ucWrap = makeEl("div");
  box.document.createElement = () => ucWrap.el;
  const cardUc = PermCard(ucP, "r1");
  perms.set(ucP.id, { p: ucP, runId: "r1", el: cardUc, done: false });
  assert.ok(cardUc.innerHTML.includes("撤销改动"));
  permDone(ucP.id, "allow");
  assert.ok(ucWrap.headEl.innerHTML.includes("✓ 已保留"));
});

test("6.3: 占位 tool_call 经后续 tool_call_update 晋升为 invoke_subagent 时仅发射一次 start", () => {
  const bg = [];
  const st = {
    text: "",
    thinking: "",
    tools: new Map(),
    usage: null,
    sessionId: "s-63",
    onBgAdd: (t) => bg.push(t),
    onBgRemove() {},
  };
  const evs = [];
  const emit = (e) => evs.push(e);

  // 初始占位 tool_call 没有有效工具名和 rawInput
  translateAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-promote",
    title: "Tool",
    rawInput: {},
    status: "pending",
  }, st, emit);
  assert.equal(evs.filter((e) => e.type === "ag" && e.k === "spawn").length, 0);
  assert.equal(bg.length, 0);

  // 后续 tool_call_update 补齐 rawInput 与 title，晋升为 invoke_subagent
  translateAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-promote",
    title: "Run invoke_subagent",
    rawInput: { TypeName: "research", Prompt: "audit codebase" },
    status: "in_progress",
  }, st, emit);
  assert.equal(evs.filter((e) => e.type === "ag" && e.k === "spawn").length, 1);
  assert.equal(bg.length, 1);

  // 再次收到 in_progress 更新不得重复发射 start
  translateAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-promote",
    rawInput: { Role: "Researcher" },
    status: "in_progress",
  }, st, emit);
  assert.equal(evs.filter((e) => e.type === "ag" && e.k === "spawn").length, 1);
  assert.equal(bg.length, 1);

  // 另一种路径：占位直接跳到终态 completed 并带 rawInput，也应先发 start 再发 done
  translateAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-promote-term",
    title: "Tool",
    rawInput: {},
    status: "pending",
  }, st, emit);
  translateAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-promote-term",
    title: "Run send_message",
    rawInput: { Recipient: "sub-1", Message: "hello" },
    status: "completed",
    rawOutput: "sent",
  }, st, emit);
  const msgTypes = evs.filter((e) => e.type === "ag" && e.mid === "tc-promote-term").map((e) => e.k);
  assert.deepEqual(msgTypes, ["msg", "msg_ok"]);
});

test("6.4: /api/task/stop 在存在 run 且 run.stopTask 返回 false 时仍回退 stopAcpBgTask", async () => {
  const tmp = fs.mkdtempSync(path.join(process.env.CCAPP_HOME, "w0-taskstop-"));
  const mockBin = path.join(tmp, "mock-agy-bg");
  const sid = "acp-bg-stop-" + Date.now().toString(36);
  fs.writeFileSync(mockBin, `#!${process.execPath}
const rl = require("node:readline").createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (l) => {
  const t = l.trim(); if (!t) return;
  const m = JSON.parse(t);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "oauth-personal" }] } });
  if (m.method === "authenticate") return send({ jsonrpc: "2.0", id: m.id, result: { ok: true } });
  if (m.method === "session/set_mode" || m.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: m.id, result: { ok: true } });
  if (m.method === "session/new") return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "${sid}" } });
  if (m.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "${sid}", update: { sessionUpdate: "tool_call", toolCallId: "tc-bg-9", title: "sleep 30", kind: "execute", rawInput: { CommandLine: "sleep 30" }, status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "${sid}", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-bg-9", status: "completed", rawOutput: "Tool is running in the background\\nTaskId: task-bg-9" } } });
    return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
});
`, { mode: 0o755 });

  const srv = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      if ((await routeRun(req, res, u, u.pathname)) !== NEXT) return;
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: err.message }));
    }
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));

  const fakeRunId = "run-dummy-" + Date.now().toString(36);
  let stopTaskCalls = 0;
  try {
    const r = await runAcpTurn({
      bin: process.execPath,
      args: [mockBin],
      cwd: process.env.CCAPP_WORKSPACE,
      env: process.env,
      prompt: "run bg",
      permMode: "bypassPermissions",
      authType: "oauth-personal",
      keepAlive: true,
      emit: () => {},
    });
    assert.equal(r.ok, true, r.error);

    RUNS.set(fakeRunId, {
      id: fakeRunId,
      cid: "cid-dummy",
      text: "dummy",
      sessionId: sid,
      startedAt: Date.now(),
      idle: false,
      inputOpen: true,
      ended: false,
      bgList: [],
      stopTask: () => { stopTaskCalls++; return false; },
    });

    const resp = await fetch(`http://127.0.0.1:${srv.address().port}/api/task/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: fakeRunId, sessionId: sid, taskId: "task-bg-9" }),
    });
    const body = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(body.ok, true);
    assert.equal(stopTaskCalls, 1);
  } finally {
    RUNS.delete(fakeRunId);
    closeAllAcpClients();
    srv.closeAllConnections?.();
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("6.5 / 6.6 / 6.7: 归一化工具名、noteWrote 路径字段、ToolBlock.subLazy 与 12-model-caps 集合", () => {
  const coreSrc = readWeb("app/01-core.js");
  const chatSrc = readWeb("app/02-chat-view.js");
  const capsSrc = readWeb("app/12-model-caps.js");

  // 6.6: noteWrote 支持 AbsolutePath / path 与 ACP 原始工具名（独立沙箱和联动沙箱都测）
  const toolsBlock = cut(chatSrc, "  function summarizeTool(", "  /** 收着的子代理");
  const mdBlock = cut(coreSrc, "  const PATH_RE =", "\n  }\n") + "\n  }";
  const mdEndIdx = coreSrc.indexOf("\n  }\n", coreSrc.indexOf("  function inlineMd(s)")) + 4;
  const coreRenderer = coreSrc.slice(coreSrc.indexOf("  const PATH_RE ="), mdEndIdx);
  const boxCore = { esc: (s) => String(s ?? ""), t: (s) => s, mdImg: null, Map, RegExp, String };
  vm.runInNewContext(
    toolsBlock + "\n" + coreRenderer + "\nglobalThis.exports = { noteWrote, inlineMd, displayToolName, summarizeTool };",
    boxCore,
  );
  const { noteWrote, inlineMd, displayToolName, summarizeTool } = boxCore.exports;

  noteWrote("Edit /data/user/0/ha.chi.mia/files/home/workspace/alpha.js", {
    AbsolutePath: "/data/user/0/ha.chi.mia/files/home/workspace/alpha.js",
    TargetContent: "a",
    ReplacementContent: "b",
  });
  noteWrote("write_file", { path: "/data/user/0/ha.chi.mia/files/home/workspace/beta.js", CodeContent: "x" });
  noteWrote("replace_file_content", { TargetFile: "/data/user/0/ha.chi.mia/files/home/workspace/gamma.js" });
  assert.match(inlineMd("已改 alpha.js、beta.js 和 gamma.js"), /data-path="\/data\/user\/0\/ha\.chi\.mia\/files\/home\/workspace\/alpha\.js"/);
  assert.match(inlineMd("已改 beta.js"), /data-path="\/data\/user\/0\/ha\.chi\.mia\/files\/home\/workspace\/beta\.js"/);
  assert.match(inlineMd("已改 gamma.js"), /data-path="\/data\/user\/0\/ha\.chi\.mia\/files\/home\/workspace\/gamma\.js"/);

  // 6.7: displayToolName / summarizeTool 新字段
  assert.equal(displayToolName("Edit /very/long/path/that/exceeds/forty/chars/foo.js", { AbsolutePath: "/data/foo.js", ReplacementContent: "x" }), "edit_file");
  assert.equal(displayToolName("Search /very/long/path/exceeding/forty/characters/in/repo", { Query: "needle", SearchPath: "/repo" }), "grep_search");
  assert.equal(displayToolName("Find /very/long/path/exceeding/forty/characters/in/repo", { Pattern: "*.mjs", DirectoryPath: "/repo" }), "find_by_name");
  assert.equal(displayToolName("List /very/long/path/exceeding/forty/characters/in/repo", { DirectoryPath: "/repo" }), "list_dir");
  assert.equal(displayToolName("Steps /very/long/title/that/should/normalize/to/update_steps", { steps: [{ title: "a", status: "done" }] }), "update_steps");
  assert.equal(summarizeTool("read_file", { AbsolutePath: "/data/x.js", StartLine: 5, EndLine: 9 }), "/data/x.js:5-9");
  assert.equal(summarizeTool("update_steps", { steps: [{ title: "a", status: "done" }, { title: "b", status: "in_progress" }] }), "1/2");

  // 6.5: ToolBlock.subLazy 使用 k.isAgent
  assert.match(chatSrc, /k\.isAgent\s*\|\|\s*isAgentToolName\(m\.name\)/);

  // 6.7: 12-model-caps READ_TOOLS / EDIT_TOOLS
  const capsSlice = cut(capsSrc, "  const READ_TOOLS =", "  const permPill =");
  const boxCaps = { Set };
  vm.runInNewContext(capsSlice + "\nglobalThis.toolPerm = toolPerm;", boxCaps);
  const emptyRules = { allow: [], ask: [], deny: [] };
  assert.equal(boxCaps.toolPerm("update_steps", "default", emptyRules), "allow");
  assert.equal(boxCaps.toolPerm("update_steps", "plan", emptyRules), "allow");
  assert.equal(boxCaps.toolPerm("replace_file_content", "acceptEdits", emptyRules), "allow");
  assert.equal(boxCaps.toolPerm("multi_replace_file_content", "acceptEdits", emptyRules), "allow");
  assert.equal(boxCaps.toolPerm("replace_file_content", "plan", emptyRules), "deny");
  assert.equal(boxCaps.toolPerm("multi_replace_file_content", "plan", emptyRules), "deny");
});

test("6.8: profile.mjs chapterProfile 对 >2MiB assistant 行也归一化 toolNameOf 并统计 agents", async () => {
  const sid = crypto.randomUUID();
  const pdir = path.join(process.env.CCAPP_HOME, ".claude", "projects", "-prof-bigline");
  fs.mkdirSync(pdir, { recursive: true });
  const t0 = Date.parse("2026-11-27T01:00:00Z");
  const iso = (s) => new Date(t0 + s * 1000).toISOString();
  const bigPad = "x".repeat(2200000);
  const f = path.join(pdir, `${sid}.jsonl`);
  fs.writeFileSync(f, [
    JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, timestamp: iso(0), message: { role: "user", content: "跑个大工具" } }),
    JSON.stringify({
      type: "assistant",
      uuid: crypto.randomUUID(),
      sessionId: sid,
      timestamp: iso(1),
      message: { role: "assistant", content: [{ type: "tool_use", id: "big-ag-1", name: "Run invoke_subagent", input: { TypeName: "research", Prompt: bigPad } }] },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: crypto.randomUUID(),
      sessionId: sid,
      timestamp: iso(2),
      message: { role: "assistant", content: [{ type: "tool_use", id: "big-cmd-1", name: "run_command echo hello", input: { CommandLine: bigPad } }] },
    }),
  ].join("\n") + "\n");

  const ch = await chapterProfile(sid, 1);
  assert.equal(ch.turns.length, 1);
  assert.equal(ch.turns[0].agents, 1);
  assert.deepEqual(ch.turns[0].top, [["invoke_subagent", 1], ["run_command", 1]]);
});

test("8.4: registry-flock fixture 兼容父级软链目录（如 Android /data/user/0 -> /data/data）且仍拒绝越界软链", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "w0-flock-"));
  try {
    const realBase = path.join(root, "real");
    const linkBase = path.join(root, "link");
    fs.mkdirSync(realBase, { recursive: true });
    fs.symlinkSync(realBase, linkBase);

    const tmp = path.join(linkBase, "hachimia-test-abc");
    const usr = path.join(tmp, "usr");
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(usr, "bin"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });

    const fx = registryFlockFixture(usr, home, tmp);
    assert.equal(fx.tool, path.join(usr, "bin/flock"));

    // 若 usr 本身是指向外部的软链，必须拒绝
    const badTmp = path.join(linkBase, "hachimia-test-bad");
    const badHome = path.join(badTmp, "home");
    const evil = path.join(root, "evil");
    fs.mkdirSync(badTmp, { recursive: true });
    fs.mkdirSync(badHome, { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    fs.symlinkSync(evil, path.join(badTmp, "usr"));
    assert.throws(() => registryFlockFixture(path.join(badTmp, "usr"), badHome, badTmp));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
