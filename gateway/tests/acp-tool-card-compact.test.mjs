import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { resolveAcpToolName, translateAcpUpdate } from "../gw/acp.mjs";
import { createWorkIsland } from "../gw/work-island-core.mjs";
import { permView } from "../gw/queue.mjs";
import { pathWatch } from "../gw/pathnote.mjs";
import { chapterProfile, turnDetail } from "../gw/profile.mjs";

const readWeb = (rel) => fs.readFileSync(new URL("../web/" + rel, import.meta.url), "utf8");

test("resolveAcpToolName 将 agy acp 命令行、Run 前缀与 TargetFile 标题归一为简短工具名", () => {
  assert.equal(
    resolveAcpToolName(
      { title: "ls -la\n/data/user/0/ha.chi.mia/files/home/workspace", kind: "execute" },
      { CommandLine: "ls -la /data/user/0/ha.chi.mia/files/home/workspace", toolSummary: "List workspace directories" },
    ),
    "run_command",
  );
  assert.equal(
    resolveAcpToolName(
      { title: "Run invoke_subagent", kind: "other" },
      { TypeName: "research", Prompt: "audit" },
    ),
    "invoke_subagent",
  );
  assert.equal(
    resolveAcpToolName({ title: "Run grep_search", kind: "search" }, { Query: "foo", SearchPath: "/a" }),
    "grep_search",
  );
  assert.equal(
    resolveAcpToolName(
      { title: "Read /data/user/0/ha.chi.mia/files/home/workspace/very/long/path/file.js", kind: "read" },
      { Path: "/data/user/0/ha.chi.mia/files/home/workspace/very/long/path/file.js", StartLine: 1, EndLine: 50 },
    ),
    "read_file",
  );
  assert.equal(
    resolveAcpToolName(
      { title: "Edit /data/user/0/ha.chi.mia/files/home/workspace/app.js", kind: "edit" },
      { TargetFile: "/data/user/0/ha.chi.mia/files/home/workspace/app.js", TargetContent: "a", ReplacementContent: "b" },
    ),
    "edit_file",
  );
  assert.equal(
    resolveAcpToolName(
      { title: "Write /data/user/0/ha.chi.mia/files/home/workspace/new.js", kind: "edit" },
      { TargetFile: "/data/user/0/ha.chi.mia/files/home/workspace/new.js", CodeContent: "hi", Overwrite: true },
    ),
    "write_file",
  );
  assert.equal(resolveAcpToolName({ title: "run_shell" }, { command: "echo hi" }), "run_shell");
  assert.equal(resolveAcpToolName({ title: "run_command (step 2)" }, { CommandLine: "echo 1" }), "run_command (step 2)");
});

test("translateAcpUpdate 对命令行 title 发射简短 tool_use.name 并在补齐 rawInput 后收口，后台任务保留 rawTitle 描述", () => {
  const bg = new Map();
  const st = {
    text: "", thinking: "", tools: new Map(), usage: null, sessionId: "s-compact",
    onBgAdd: (t) => bg.set(t.id, t),
    onBgRemove: (id) => bg.delete(id),
  };
  const evs = [];
  const emit = (e) => evs.push(e);

  translateAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-ls",
    kind: "execute",
    title: "ls -la\n/data/user/0/ha.chi.mia/files/home/workspace /sdcard/hachimia 2>/dev/null",
    rawInput: {},
    status: "pending",
  }, st, emit);

  const use = evs.find((e) => e.type === "tool_use" && e.id === "tc-ls");
  assert.equal(use.name, "run_command");

  translateAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-ls",
    rawInput: { CommandLine: "ls -la /data/user/0/ha.chi.mia/files/home/workspace /sdcard/hachimia 2>/dev/null", toolSummary: "List workspace directories" },
    status: "in_progress",
  }, st, emit);

  const upd = evs.find((e) => e.type === "tool_update" && e.id === "tc-ls");
  assert.equal(upd.name, "run_command");
  assert.equal(upd.input.toolSummary, "List workspace directories");

  translateAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-bg-title",
    kind: "execute",
    title: "python3 -m http.server 8080\n--bind 127.0.0.1",
    rawInput: {},
    status: "in_progress",
  }, st, emit);
  translateAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-bg-title",
    status: "completed",
    rawOutput: "Tool is running in the background\nTaskId: bg-1",
  }, st, emit);
  assert.equal(bg.get("bg-1")?.desc, "python3 -m http.server 8080");
});

test("前端 displayToolName 与 summarizeTool 兼容历史长命令、TargetFile、PascalCase 与单行化摘要", () => {
  const src = readWeb("app/02-chat-view.js");
  const a = src.indexOf("  function summarizeTool(");
  const b = src.indexOf("  /** 收着的子代理", a);
  assert.ok(a >= 0 && b > a);
  const box = {};
  vm.runInNewContext(src.slice(a, b) + "\nglobalThis.summarizeTool = summarizeTool; globalThis.displayToolName = displayToolName;", box);

  const longCmd = "ls -la\n/data/user/0/ha.chi.mia/files/home/workspace /sdcard/hachimia\n2>/dev/null";
  assert.equal(box.displayToolName(longCmd, { CommandLine: longCmd, toolSummary: "List workspace directories" }), "run_command");
  assert.equal(box.summarizeTool(longCmd, { CommandLine: longCmd, toolSummary: "List\n  workspace directories" }), "List workspace directories");
  assert.equal(box.displayToolName("Run invoke_subagent", { TypeName: "research", Prompt: "scan" }), "invoke_subagent");
  assert.equal(box.displayToolName("Run grep_search", { Query: "foo" }), "grep_search");
  assert.equal(box.summarizeTool("Run grep_search", { Query: "foo" }), "foo");
  assert.equal(box.summarizeTool("Run invoke_subagent", { TypeName: "research", Prompt: "scan\ncode" }), "research · scan code");
  assert.equal(box.displayToolName("Edit /very/long/path/foo.js", { TargetFile: "/very/long/path/foo.js", ReplacementContent: "x" }), "edit_file");
  assert.equal(box.displayToolName("Write /very/long/path/bar.js", { file_path: "/very/long/path/bar.js", content: "y" }), "write_file");
  assert.equal(box.summarizeTool("Read /very/long/path/baz.js", { TargetFile: "/very/long/path/baz.js", StartLine: 10, EndLine: 20 }), "/very/long/path/baz.js:10-20");
});

test("权限卡、底部权限条、子代理步骤与 style.css 同步单行省略及 ACP 兼容", () => {
  const css = readWeb("style.css");
  assert.match(css, /\.tool-name\{[^}]*white-space:nowrap/);
  assert.match(css, /\.tool-name\{[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.tool-head:has\(\.tool-arg:not\(:empty\)\)\s*\.tool-name\{max-width:45%\}/);
  assert.match(css, /\.perm-tool\{[^}]*white-space:nowrap/);
  assert.match(css, /\.perm-tool\{[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.perm-head:has\(\.tool-arg:not\(:empty\)\)\s*\.perm-tool\{max-width:45%\}/);
  assert.match(css, /\.ts-label\{[^}]*white-space:nowrap/);

  const permSrc = readWeb("app/03-perm-status.js");
  assert.match(permSrc, /const permToolLabel =/);
  assert.match(permSrc, /case "replace_file_content":/);
  assert.match(permSrc, /"edit_file", "write_file", "replace_file_content"/);
  assert.match(permSrc, /i\.TargetFile/);
  assert.match(permSrc, /fTool = permToolLabel\(f\)/);
  assert.match(permSrc, /displayToolName\(phEv\.name\)/);

  const agSrc = readWeb("app/03b-agents.js");
  assert.match(agSrc, /displayToolName\(name, input\)/);

  const chatSrc = readWeb("app/02-chat-view.js");
  assert.match(chatSrc, /card\.querySelector\("\.tool-open"\)/);
  assert.match(chatSrc, /typeof noteWrote === "function"/);

  // 真执行 02-chat-view.js + 03-perm-status.js：验证 PermCard / permPreview / permWhat / renderPermBar 实际渲染输出
  const a02 = chatSrc.indexOf("  function summarizeTool(");
  const b02 = chatSrc.indexOf("  /** 收着的子代理", a02);
  assert.ok(a02 >= 0 && b02 > a02);
  const pEnd1 = permSrc.indexOf("  // ── 输入框上方的状态带");
  const pStart2 = permSrc.indexOf("  function renderPermBar()");
  const pEnd2 = permSrc.indexOf("  permBar.addEventListener(", pStart2);
  assert.ok(pEnd1 > 0 && pStart2 > pEnd1 && pEnd2 > pStart2);
  const elems = new Map();
  const mkEl = (tag = "div") => {
    const cls = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      className: "",
      innerHTML: "",
      textContent: "",
      dataset: {},
      style: {},
      children: [],
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)),
        remove: (...c) => c.forEach((x) => cls.delete(x)),
        toggle: (c, v) => (v === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : (v ? cls.add(c) : cls.delete(c))),
        contains: (c) => cls.has(c),
      },
      appendChild(ch) { this.children.push(ch); return ch; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      remove() {},
    };
    return el;
  };
  const permBar = mkEl("div");
  const liveEl = mkEl("div");
  elems.set("perm-bar", permBar);
  const ctx = {
    state: { settings: { permNotice: false }, permissionMode: "default" },
    srv: { run: { id: "r1" }, runs: [] },
    runViews: new Map(),
    TOOL_CARDS: new Map(),
    liveEl,
    permEl: mkEl("button"),
    t: (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "")) : s),
    esc: (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    $: (id) => elems.get(id) || (elems.set(id, mkEl("div")), elems.get(id)),
    document: { createElement: (tag) => mkEl(tag), querySelector: () => null, querySelectorAll: () => [] },
    uiI: () => "",
    renderMd: (s) => `<p>${s}</p>`,
    runMode: () => "default",
    setStatus() {},
    isBusy: () => false,
    permGuardWhat: () => "guard",
    scrollDown() {},
    api: async () => ({ ok: true }),
    toast() {},
    toastAct() {},
    curPage: null,
    view: { sessionId: "s1" },
    window: {},
  };
  vm.runInNewContext(
    chatSrc.slice(a02, b02) + "\n" + permSrc.slice(0, pEnd1) + "\n" + permSrc.slice(pStart2, pEnd2)
      + "\nglobalThis.__p = { PERMS, permToolLabel, permToolBase, permPreview, permWhat, permActions, PermCard, renderPermBar };",
    ctx,
  );
  const P = ctx.__p;

  // 1) multi_replace_file_content + ReplacementChunks (Target/Replacement 及 TargetContent/ReplacementContent) 不得渲染空白 diff
  const multiCard = P.PermCard({
    id: "pm1",
    tool: "Edit /a/b/c/file.js",
    input: {
      TargetFile: "/a/b/c/file.js",
      ReplacementChunks: [
        { TargetContent: "oldOne", ReplacementContent: "newOne" },
        { Target: "oldTwo", Replacement: "newTwo" },
      ],
    },
  }, "r1");
  assert.match(multiCard.innerHTML, /- oldOne[\s\S]*\+ newOne/, "ReplacementChunks (TargetContent/ReplacementContent) 必须画出非空 diff");
  assert.match(multiCard.innerHTML, /- oldTwo[\s\S]*\+ newTwo/, "ReplacementChunks (Target/Replacement) 必须画出非空 diff");
  assert.match(multiCard.innerHTML, /multi_replace_file_content/);

  // 2) 带括号后缀 edit_file (foo.js) 必须按 baseToolName 分派，渲染真实 diff 与路径摘要
  const parenCard = P.PermCard({
    id: "pm2",
    tool: "edit_file (foo.js)",
    input: { TargetFile: "/w/foo.js", TargetContent: "before", ReplacementContent: "after" },
  }, "r1");
  assert.match(parenCard.innerHTML, /- before[\s\S]*\+ after/, "edit_file (foo.js) 必须渲染 diff 而非退化原始 JSON");
  assert.equal(P.permWhat("edit_file (foo.js)", { TargetFile: "/w/foo.js" }), "/w/foo.js");

  // 3) exit_plan_mode 必须识别为计划审批并渲染计划正文而非原始 JSON
  const planHtml = P.permPreview({ id: "pm3", tool: "exit_plan_mode", input: { plan: "Step 1: ship" } });
  assert.match(planHtml, /Step 1: ship/);
  assert.doesNotMatch(planHtml, /"plan":/);
  assert.match(P.permActions({ id: "pm3", tool: "exit_plan_mode", input: { plan: "x" } }, "r1"), /data-mode="acceptEdits"/);

  // 4) web_fetch / read_url_content 预览 URL
  assert.match(P.permPreview({ id: "pm3b", tool: "read_url_content", input: { Url: "https://example.com/doc" } }), /https:\/\/example\.com\/doc/);
  assert.match(P.permPreview({ id: "pm3c", tool: "web_fetch", input: { url: "https://example.com/api" } }), /https:\/\/example\.com\/api/);

  // 5) renderPermBar 展示归一短名
  P.PERMS.set("pm4", {
    p: {
      id: "pm4",
      tool: "ls -la\n/very/long/command/line",
      input: { CommandLine: "ls -la /very/long/command/line", toolSummary: "List files" },
    },
    runId: "r1",
    done: false,
  });
  P.renderPermBar();
  assert.match(permBar.innerHTML, /<b>run_command<\/b>/);
});

test("work-island、permView、pathnote、profile 对 ACP 工具名与字段全适配", async () => {
  // 1. work-island-core
  const sent = [];
  const island = createWorkIsland({
    send: (action, title, text, since, state, extra) => sent.push({ action, title, text, since, state, extra }),
    lang: () => "zh",
    graceMs: 10,
    idleMs: 20,
    throttleMs: 0,
  });
  island.handleEvent({ type: "run_start", startedAt: Date.now() });
  island.handleEvent({ type: "tool_use", name: "run_command" });
  assert.equal(sent.at(-1).title, "执行命令");
  assert.equal(sent.at(-1).state, "running");
  island.handleEvent({ type: "tool_use", name: "edit_file" });
  assert.equal(sent.at(-1).title, "改文件");
  assert.equal(sent.at(-1).state, "writing");
  island.handleEvent({
    type: "tool_use",
    name: "update_steps",
    input: { steps: [{ title: "a", status: "done" }, { title: "b", status: "in_progress" }] },
  });
  assert.equal(sent.at(-1).text, "清单 1/2");
  assert.deepEqual(sent.at(-1).extra, { todoDone: 1, todoTotal: 2 });

  // 2. permView 截断大字段 Content / CodeContent / ReplacementChunks
  const big = "x\n".repeat(40000);
  const pv = permView({
    id: "p1",
    tool: "write_file",
    input: { TargetFile: "/a.txt", CodeContent: big },
  });
  assert.ok(pv.input.CodeContent.length <= 65536);
  assert.ok(pv.inputCut?.CodeContent?.lines > 1000);

  const pv2 = permView({
    id: "p2",
    tool: "multi_replace_file_content",
    input: { TargetFile: "/b.txt", ReplacementChunks: [{ TargetContent: big, ReplacementContent: big }] },
  });
  assert.ok(pv2.input.ReplacementChunks[0].TargetContent.length <= 65536);

  // 3. pathWatch 识别 write_file / edit_file / TargetFile
  const pw = pathWatch();
  pw.feed({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "w1", name: "edit_file", input: { TargetFile: "/data/user/0/ha.chi.mia/files/home/workspace/foo.js" } },
        { type: "text", text: "已修改 foo.js" },
      ],
    },
  });
  assert.deepEqual(pw.lazy().map((x) => x.said), ["foo.js"]);

  // 4. profile.mjs 归并历史原始命令 tool_use.name
  const sid = crypto.randomUUID();
  const pdir = path.join(process.env.CCAPP_HOME, ".claude", "projects", "-prof-acp");
  fs.mkdirSync(pdir, { recursive: true });
  const t0 = Date.parse("2026-11-27T00:00:00Z");
  const iso = (s) => new Date(t0 + s * 1000).toISOString();
  const f = path.join(pdir, `${sid}.jsonl`);
  fs.writeFileSync(f, [
    { type: "user", uuid: crypto.randomUUID(), sessionId: sid, timestamp: iso(0), message: { role: "user", content: "检查代码" } },
    {
      type: "assistant",
      uuid: crypto.randomUUID(),
      sessionId: sid,
      timestamp: iso(2),
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "ls -la /data/user/0/ha.chi.mia/files/home/workspace", input: { CommandLine: "ls -la /data/user/0/ha.chi.mia/files/home/workspace", toolSummary: "List workspace" } },
          { type: "tool_use", id: "c2", name: "Edit /data/foo.js", input: { TargetFile: "/data/foo.js", TargetContent: "a", ReplacementContent: "b" } },
        ],
      },
    },
    { type: "user", uuid: crypto.randomUUID(), sessionId: sid, timestamp: iso(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }, { type: "tool_result", tool_use_id: "c2", content: "ok" }] } },
    { type: "assistant", uuid: crypto.randomUUID(), sessionId: sid, timestamp: iso(5), message: { role: "assistant", content: [{ type: "text", text: "完成" }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const ch = await chapterProfile(sid, 1);
  assert.deepEqual(ch.turns[0].top, [["run_command", 1], ["edit_file", 1]]);
  const det = await turnDetail(sid, ch.turns[0].off, ch.turns[0].end);
  assert.deepEqual(det.main.map((s) => [s.name, s.label]), [["run_command", "List workspace"], ["edit_file", "/data/foo.js"]]);
});
