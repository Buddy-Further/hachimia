// 元规律 ABCD 审计 P0/P1 修复与 ruleblock 移除的真实行为回归测试
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { judge } from "../guard/cc-guard.mjs";
import { acpToGuardInput, persistAcpAssistantOnly, resolveAcpToolName } from "../gw/acp.mjs";
import { planBackfillBatches, systemPrompt, trimUtf8Bytes, userPrompt } from "../gw/backfill.mjs";
import { syncAgySettings } from "../gw/claude.mjs";
import { checkSession, checkSessionAsync, sealSession, sessionAnchor } from "../gw/integrity.mjs";
import { UC_SEALED, _ucReset, ucKeep, ucPending, ucRevert } from "../gw/userconf.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("已删除 ruleblock.mjs 且 run.mjs 不再引用 ruleblockHint", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "gateway/gw/ruleblock.mjs")), false);
  const runSrc = read("gateway/gw/run.mjs");
  assert.doesNotMatch(runSrc, /ruleblockHint|ruleblock\.mjs/);
});

test("P0 #1：resolveAcpToolName 与 acpToGuardInput 不丢 ReplacementChunks，也不把长标题写入降级为 Read", () => {
  const chunks = [{ TargetContent: "old", ReplacementContent: "new" }];
  assert.equal(
    resolveAcpToolName({ title: "Edit target", kind: "edit" }, { TargetFile: "/proj/a.md", ReplacementChunks: chunks }),
    "multi_replace_file_content",
  );
  assert.equal(
    resolveAcpToolName(
      { title: "A very long descriptive title exceeding forty characters for writing settings", kind: "edit" },
      { TargetFile: "/home/u/.gemini/antigravity-cli/settings.json", content: '{"hooks":{}}' },
    ),
    "write_file",
  );
  assert.equal(
    resolveAcpToolName(
      { title: "A very long descriptive title exceeding forty characters for editing settings", kind: "edit" },
      { TargetFile: "/home/u/.gemini/antigravity-cli/settings.json" },
    ),
    "edit_file",
  );

  // 即使上游把展示名传成 edit_file，acpToGuardInput 也必须保留 ReplacementChunks 并命中敏感提示词拦截
  const gMulti = acpToGuardInput(
    "edit_file",
    { TargetFile: "/data/user/0/ha.chi.mia/files/home/.claude/CLAUDE.md", ReplacementChunks: chunks },
    { toolKind: "edit" },
  );
  assert.equal(gMulti.tool, "MultiEdit");
  assert.deepEqual(gMulti.input.edits, [{ old_string: "old", new_string: "new" }]);
  assert.ok(judge(gMulti.tool, gMulti.input), "MultiEdit 写入用户级 CLAUDE.md 必须命中 judge()");

  // 即使上游把展示名传成 read_file，带 lowercase content 或 kind=edit 也绝不能被降级成 Read
  const gWrite = acpToGuardInput(
    "read_file",
    { TargetFile: "/data/user/0/ha.chi.mia/files/home/.gemini/antigravity-cli/settings.json", content: '{"mcpServers":{}}' },
    { toolKind: "edit" },
  );
  assert.equal(gWrite.tool, "Write");
  assert.ok(judge(gWrite.tool, gWrite.input), "带 content 写入 agy settings.json 必须命中 judge()");

  const gEditKind = acpToGuardInput(
    "read_file",
    { TargetFile: "/data/user/0/ha.chi.mia/files/home/.gemini/antigravity-cli/GEMINI.md" },
    { toolKind: "edit" },
  );
  assert.equal(gEditKind.tool, "Edit");
  assert.ok(judge(gEditKind.tool, gEditKind.input), "kind=edit 写用户级 GEMINI.md 必须命中 judge()");
});

test("P0 #1 + P1 #8：前端真实执行 displayToolName / baseToolName / summarizeTool / permPreview / permActions / noteWrote", () => {
  const core = read("gateway/web/app/01-core.js");
  const chat = read("gateway/web/app/02-chat-view.js");
  const perm = read("gateway/web/app/03-perm-status.js");

  const sliceBetween = (src, startMarker, endMarker) => {
    const a = src.indexOf(startMarker);
    const b = src.indexOf(endMarker, a);
    assert.ok(a >= 0 && b > a, `找不到片段: ${startMarker} .. ${endMarker}`);
    return src.slice(a, b);
  };

  const noteWroteSrc = sliceBetween(core, "  const WROTE = new Map();", "  // 取出来就是转义过的");
  const chatHelpersSrc = sliceBetween(chat, "  function summarizeTool(name, input) {", "  /** 收着的子代理过程里的一步");
  const permHelpersSrc = sliceBetween(perm, "  function permDiffHtml(oldS, newS) {", "  function PermCard(p, runId) {");

  const ctx = {
    esc: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    t: (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? "")),
    renderMd: (s) => `<md>${s}</md>`,
    modeLabel: (m) => m,
    permRules: () => [],
    permSuggestsEdits: () => false,
    srv: { runs: [] },
    state: { permissionMode: "default" },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${chatHelpersSrc}\n${noteWroteSrc}\n${permHelpersSrc}\n` +
    `this.__api = { displayToolName, baseToolName, summarizeTool, isAgentToolName, isShellToolName, permWhat, permPreview, permActions, noteWrote, WROTE };`,
    ctx,
  );
  const api = ctx.__api;

  // ReplacementChunks & edits 归一为 multi_replace_file_content，且 permPreview 画出真实 diff（含 Target/Replacement 键）
  assert.equal(
    api.displayToolName("A long editing title over forty chars for multi chunk replace", {
      TargetFile: "/data/a.js",
      ReplacementChunks: [{ Target: "foo", Replacement: "bar" }],
    }),
    "multi_replace_file_content",
  );
  const diffHtml = api.permPreview({
    tool: "edit_file (a.js)",
    input: { Path: "/data/a.js", ReplacementChunks: [{ Target: "oldLine", Replacement: "newLine" }] },
  });
  assert.match(diffHtml, /perm-diff/);
  assert.match(diffHtml, /- oldLine/);
  assert.match(diffHtml, /\+ newLine/);

  // P1 #8：带 (label) 括号后缀时各消费方全部正常命中
  assert.equal(api.baseToolName("invoke_subagent (research)"), "invoke_subagent");
  assert.equal(api.isAgentToolName("invoke_subagent (research)"), true);
  assert.equal(api.isShellToolName("run_command (step 2)", {}), true);
  assert.match(api.summarizeTool("invoke_subagent (research)", { Role: "Auditor", Prompt: "check code" }), /Auditor · check code/);
  assert.equal(api.summarizeTool("read_file (01-core.js)", { Path: "/data/01-core.js", StartLine: 10, EndLine: 20 }), "/data/01-core.js:10-20");
  assert.equal(api.permWhat("run_command (step 2)", { toolSummary: "Run tests", CommandLine: "npm test" }), "Run tests");
  const cmdHtml = api.permPreview({ tool: "run_command (step 2)", input: { CommandLine: "echo hi", toolSummary: "Say hi" } });
  assert.match(cmdHtml, /<pre class="perm-cmd">echo hi<\/pre>/);
  assert.doesNotMatch(cmdHtml, /"CommandLine"/, "不得退化成原始 JSON");

  // exit_plan_mode 与带括号的 ExitPlanMode 均渲染计划审批卡
  assert.match(api.permPreview({ tool: "exit_plan_mode", input: { plan: "Step 1" } }), /perm-plan/);
  assert.match(api.permActions({ tool: "exit_plan_mode", input: {} }, "r1"), /批准，逐项确认执行/);
  assert.match(api.permActions({ tool: "ExitPlanMode (v1)", input: {} }, "r1"), /批准，逐项确认执行/);

  // noteWrote 识别带括号后缀的写/改工具名
  api.noteWrote("edit_file (foo.js)", { TargetFile: "/data/workspace/foo.js" });
  assert.equal(api.WROTE.get("foo.js"), "/data/workspace/foo.js");
});

test("P1 #3：backfill 纯 agy 中文长批按 UTF-8 字节拆批且远低于 128 KiB MAX_ARG_STRLEN", () => {
  const cnChunk = "排查并修复网关补档长参数超限问题。".repeat(150); // ~2550 字 ≈ 7.65 KiB UTF-8
  const items = Array.from({ length: 24 }, (_, i) => ({ n: i + 1, open: false, src: cnChunk, prev: null }));
  // 总量 ~183 KiB UTF-8，若不按字节拆批会在 Linux 撞 128 KiB E2BIG
  const batches = planBackfillBatches("中文长会话补档测试", items, { agyOnly: true });
  assert.ok(batches.length >= 2, `应拆成至少 2 批，实际 ${batches.length}`);
  assert.equal(batches.reduce((s, b) => s + b.length, 0), 24, "所有章节不能丢失");
  const sys = systemPrompt();
  for (const b of batches) {
    const arg = `-p=${sys}\n\n${userPrompt("中文长会话补档测试", b)}`;
    const bytes = Buffer.byteLength(arg, "utf8");
    assert.ok(bytes < 100 * 1024, `单批参数应远低于 128 KiB，实际 ${bytes} 字节`);
  }
  const cut = trimUtf8Bytes("你好世界🚀".repeat(20000), 120 * 1024 - 3);
  assert.ok(Buffer.byteLength(cut, "utf8") <= 120 * 1024 - 3);
  assert.equal(cut.includes("\uFFFD"), false, "按字节截断不得破坏多字节 UTF-8 字符");
});

test("P1 #5：userconf 监控 ~/.gemini/antigravity-cli/，放行 syncAgySettings 合法写入并拦截外部篡改", () => {
  const cleanHome = () => {
    _ucReset();
    fs.rmSync(path.join(CFG.home, ".gemini"), { recursive: true, force: true });
    fs.rmSync(path.join(CFG.home, "ccapp-userconf.json"), { force: true });
    fs.rmSync(path.join(CFG.home, ".ccapp-userconf"), { recursive: true, force: true });
  };
  cleanHome();
  try {
    // 建立干净基线
    const initP = ucPending();
    if (initP) ucKeep(initP.rels, initP.ticket);
    assert.equal(ucPending(), null);

    // 1) hachimia 自己的 syncAgySettings 写入 modelProvider / customModelsConfig 应自动认下，不误报卡片
    const syncRes = syncAgySettings(
      { id: "gemini-key", protocol: "gemini", authStyle: "gemini-api-key", baseUrl: "https://proxy.example.com", defaultModel: "gemini-2.5-pro" },
      "AIzaFakeKey1234567890",
    );
    assert.equal(syncRes.error, undefined);
    assert.equal(ucPending(), null, "syncAgySettings 合法写入不应触发 UserConfig 误报");

    // 2) 运行态目录（log/、brain/）变化不应误报
    const logFile = path.join(CFG.home, ".gemini/antigravity-cli/log/acp-server.log");
    const brainFile = path.join(CFG.home, ".gemini/antigravity-cli/brain/s1/note.md");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.mkdirSync(path.dirname(brainFile), { recursive: true });
    fs.writeFileSync(logFile, "runtime log\n");
    fs.writeFileSync(brainFile, "scratch\n");
    assert.equal(ucPending(), null, "log/ 与 brain/ 运行态文件不应触发误报");

    // 3) 外部修改 GEMINI.md、hooks/evil.sh 与 settings.json.mcpServers 必须全部检出
    const agyDir = path.join(CFG.home, ".gemini/antigravity-cli");
    fs.writeFileSync(path.join(agyDir, "GEMINI.md"), "injected global rule\n");
    fs.mkdirSync(path.join(agyDir, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(agyDir, "hooks/evil.sh"), "#!/bin/sh\nid\n");
    const stFile = path.join(agyDir, "settings.json");
    const stObj = JSON.parse(fs.readFileSync(stFile, "utf8"));
    stObj.mcpServers = { evil: { command: "/bin/sh" } };
    fs.writeFileSync(stFile, JSON.stringify(stObj, null, 2));

    const p = ucPending();
    assert.ok(p, "外部改写 ~/.gemini/antigravity-cli/ 配置应触发确认");
    assert.ok(p.rels.includes(".gemini/antigravity-cli/GEMINI.md"));
    assert.ok(p.rels.includes(".gemini/antigravity-cli/hooks/evil.sh"));
    assert.ok(p.rels.includes(".gemini/antigravity-cli/settings.json"));

    // 发行版 UC_SEALED 也应检出 .gemini/antigravity-cli/settings.json
    const ps = ucPending(UC_SEALED);
    assert.ok(ps && ps.rels.includes(".gemini/antigravity-cli/settings.json"), "UC_SEALED 应纳管 agy settings.json");

    // 4) 撤销后：新文件移入隔离目录，settings.json 去掉 mcpServers 并保留合法 modelProvider
    ucRevert(p.rels);
    assert.equal(fs.existsSync(path.join(agyDir, "GEMINI.md")), false);
    assert.equal(fs.existsSync(path.join(agyDir, "hooks/evil.sh")), false);
    const restored = JSON.parse(fs.readFileSync(stFile, "utf8"));
    assert.equal(restored.mcpServers, undefined, "外部注入的 mcpServers 应被还原清除");
    assert.equal(restored.modelProvider, "gemini", "此前认下的 modelProvider 应保留");
    assert.equal(ucPending(), null);
  } finally {
    cleanHome();
  }
});

test("P1 #6：空闲 persistAcpAssistantOnly 前核后封——干净会话不误报，真实外部篡改不被洗白", async () => {
  const cwd = path.join(CFG.workspace, "idle-seal-proj");
  fs.mkdirSync(cwd, { recursive: true });
  const sidClean = "11111111-1111-4111-8111-111111111111";
  const sidTampered = "22222222-2222-4222-8222-222222222222";
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const dir = path.join(CFG.home, ".claude", "projects", slug);
  fs.mkdirSync(dir, { recursive: true });

  // 场景 A：干净会话 -> 封签 -> 模拟 flushIdle 追加落盘并重封 -> 下轮 checkSessionAsync 为 null
  const f1 = path.join(dir, `${sidClean}.jsonl`);
  fs.writeFileSync(f1, JSON.stringify({ type: "user", sessionId: sidClean, message: { role: "user", content: "hi" } }) + "\n");
  sealSession(sidClean, f1);
  assert.equal(await checkSessionAsync(sidClean, f1), null);

  checkSession(sidClean, f1);
  const a1 = sessionAnchor(f1);
  persistAcpAssistantOnly({ cwd, sessionId: sidClean, assistantText: "后台任务已完成", thinking: "", tools: [], model: "agy" });
  sealSession(sidClean, f1, { base: a1 });
  assert.equal(await checkSessionAsync(sidClean, f1), null, "空闲合法落盘重封后不得误报 edited");

  // 场景 B：空闲期间被外部进程篡改 -> flushIdle 先 checkSession 再追加重封 -> 必须保留 edited 标记
  const f2 = path.join(dir, `${sidTampered}.jsonl`);
  fs.writeFileSync(f2, JSON.stringify({ type: "user", sessionId: sidTampered, message: { role: "user", content: "hi" } }) + "\n");
  sealSession(sidTampered, f2);
  fs.appendFileSync(f2, JSON.stringify({ type: "assistant", sessionId: sidTampered, message: { role: "assistant", content: "forged" } }) + "\n");

  checkSession(sidTampered, f2);
  const a2 = sessionAnchor(f2);
  persistAcpAssistantOnly({ cwd, sessionId: sidTampered, assistantText: "合法回报", thinking: "", tools: [], model: "agy" });
  sealSession(sidTampered, f2, { base: a2 });
  assert.equal(await checkSessionAsync(sidTampered, f2), "edited", "空闲重封绝不能洗白此前的外部篡改");
});

test("P1 #9：09-settings.js logout 在途切卡时不抹掉新厂商卡", async () => {
  const src = read("gateway/web/app/09-settings.js");
  const logoutStart = src.indexOf("  async function logout(p) {");
  const logoutEnd = src.indexOf("  // ── 密钥卡");
  assert.ok(logoutStart > 0 && logoutEnd > logoutStart);

  const resolvers = [];
  const defer = () => new Promise((r) => resolvers.push(r));
  let renderProvCalls = 0;

  const ctx = {
    state: { provView: "antigravity" },
    esc: (s) => String(s ?? ""),
    t: (s) => String(s),
    toast: () => {},
    confirm: () => true,
    renderProvCard: () => { renderProvCalls++; },
    refreshStatus: () => {},
    qbLoad: () => {},
    loadQuota: () => Promise.resolve(),
    post: () => defer(),
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(logoutStart, logoutEnd)}\nthis.__api = { logout };`, ctx);

  // 验证 logout 在途切卡不重画当前已切换的新卡
  ctx.state.provView = "antigravity";
  const outPromise = ctx.__api.logout({ id: "antigravity" });
  ctx.state.provView = "gemini-key";
  resolvers.shift()({ ok: true });
  await outPromise;
  assert.equal(renderProvCalls, 0, "logout 在途切卡后不得强制重画新卡");
});
