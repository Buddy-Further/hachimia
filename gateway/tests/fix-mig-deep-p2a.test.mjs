// MIG-4 / MIG-5 / MIG-7 / MIG-8 / MIG-11 / MIG-12 / MIG-13 / MIG-14（迁移收尾·深修 p2a）。
// test-first：先写出能复现的失败测试再修。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { CFG, PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

const tmpRoot = fs.mkdtempSync(path.join(CFG.home, "fix-mig-deep-p2a-"));
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  try { fs.rmSync(path.join(CFG.home, ".config", "gcloud"), { recursive: true, force: true }); } catch {}
  for (const d of [".gemini", ".config/antigravity", ".antigravity"]) {
    try { fs.rmSync(path.join(CFG.home, d), { recursive: true, force: true }); } catch {}
  }
});

async function serve(route) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await route(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return {
    srv,
    call: async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
  };
}

// ── MIG-4：未知窗口不得显示成 0k ────────────────────────────────────────
test("MIG-4：/model 清单与切换回复里未知窗口写“未知”，不出现 0k", async () => {
  const { handleLocalCommand } = await import("../gw/modelcmd.mjs");
  const { upsertProvider } = await import("../gw/providers.mjs");
  const { setSessModel, sessModel } = await import("../gw/sessmodel.mjs");
  const inline = { data: [
    { id: "m-zero", name: "M Zero", context_window: 0 },
    { id: "m-big", name: "M Big", context_window: 200000 },
  ] };
  const created = upsertProvider(null, {
    label: "Fixture MIG-4", baseUrl: "https://fixture-mig4.example.invalid/anthropic",
    modelsUrl: "data:application/json," + encodeURIComponent(JSON.stringify(inline)),
    defaultModel: "m-big", fastModel: "m-big",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const sid = crypto.randomUUID();
  setSessModel(sid, { provider: created.id, model: "m-big" });
  let out = "";
  await handleLocalCommand("model", "", (t) => { out = t; }, sid);
  assert.ok(out.includes("未知"), "清单里未知窗口应写“未知”：" + out);
  assert.ok(!out.includes("0k"), "清单里不得出现 0k：" + out);
  let out2 = "";
  await handleLocalCommand("model", "m-zero", (t) => { out2 = t; }, sid);
  assert.equal(sessModel(sid).model, "m-zero");
  assert.ok(out2.includes("上下文窗口：未知"), "切换回复里未知窗口应写“未知”：" + out2);
  assert.ok(!out2.includes("0k"), "切换回复里不得出现 0k：" + out2);
});

// ── MIG-5：子串命中多个时不直接取第一个 ────────────────────────────────
test("MIG-5：/model 子串命中多个变体时回复候选清单、不切换；单个命中才切", async () => {
  const { handleLocalCommand } = await import("../gw/modelcmd.mjs");
  const { upsertProvider } = await import("../gw/providers.mjs");
  const { setSessModel, sessModel } = await import("../gw/sessmodel.mjs");
  const inline = { data: [
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4-6", context_window: 200000 },
    { id: "claude-sonnet-4-6-thinking", name: "Claude Sonnet 4-6 Thinking", context_window: 200000 },
    { id: "gemini-4-neon", name: "Gemini 4 Neon", context_window: 200000 },
  ] };
  const created = upsertProvider(null, {
    label: "Fixture MIG-5", baseUrl: "https://fixture-mig5.example.invalid/anthropic",
    modelsUrl: "data:application/json," + encodeURIComponent(JSON.stringify(inline)),
    defaultModel: "gemini-4-neon", fastModel: "gemini-4-neon",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const sid = crypto.randomUUID();
  setSessModel(sid, { provider: created.id, model: "gemini-4-neon" });
  let out = "";
  await handleLocalCommand("model", "sonnet", (t) => { out = t; }, sid);
  assert.ok(out.includes("claude-sonnet-4-6") && out.includes("claude-sonnet-4-6-thinking"),
    "多个命中时应列出全部候选：" + out);
  assert.ok(!out.includes("已切换到"), "多个命中时不得直接切换：" + out);
  assert.ok(!out.includes("没有模型"), "多个命中不是“没有模型”：" + out);
  assert.equal(sessModel(sid).model, "gemini-4-neon", "多个命中时模型不得被改掉");
  let out2 = "";
  await handleLocalCommand("model", "thinking", (t) => { out2 = t; }, sid);
  assert.ok(out2.includes("已切换到 **claude-sonnet-4-6-thinking**"), "单个子串命中应正常切换：" + out2);
  assert.equal(sessModel(sid).model, "claude-sonnet-4-6-thinking");
  let out3 = "";
  await handleLocalCommand("model", "claude-sonnet-4-6", (t) => { out3 = t; }, sid);
  assert.ok(out3.includes("已切换到 **claude-sonnet-4-6**"), "精确 id 应切到该变体、不是 thinking 变体：" + out3);
  assert.equal(sessModel(sid).model, "claude-sonnet-4-6");
});

// ── MIG-7：轮次内联 set_mode 被拒不得静默吞掉 ──────────────────────────
// mock agy：列出 default/accept-edits/plan 三种模式，但 set_mode 一律回 -32602。
function makeMockAgyRejectMode(dir) {
  const script = path.join(dir, "mock-agy-mig7");
  fs.writeFileSync(script, `#!${process.execPath}\nconst readline = require("node:readline");\nconst rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });\nconst send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");\nrl.on("line", (line) => {\n  const t = line.trim(); if (!t) return;\n  const msg = JSON.parse(t);\n  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });\n  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-mig7-1", models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }] }, modes: { availableModes: [{ id: "default" }, { id: "accept-edits" }, { id: "plan" }] } } });\n  if (msg.method === "session/set_mode") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "mode 'plan' is not available for this session" } });\n  if (msg.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });\n  if (msg.method === "session/prompt") {\n    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });\n    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });\n  }\n});\n`, { mode: 0o755 });
  return script;
}

test("MIG-7：内联 set_mode 被拒时发 error 事件并把 init 宣称的模式纠回 default", async () => {
  const { runAcpTurn, closeAllAcpClients } = await import("../gw/acp.mjs");
  const mockBin = makeMockAgyRejectMode(tmpRoot);
  const events = [];
  const run = { id: "mig7-run-" + crypto.randomUUID() };
  try {
    const res = await runAcpTurn({
      bin: process.execPath, args: [mockBin], cwd: CFG.workspace, env: process.env,
      prompt: "hello", model: "gemini-4-neon", permMode: "plan", authType: "", apiKey: "",
      keepAlive: false, run, emit: (ev) => events.push(ev),
    });
    assert.equal(res.ok, true, res.error || JSON.stringify(events));
    const init = events.find((e) => e.type === "init");
    assert.ok(init, "应先发 init 事件");
    assert.equal(init.permissionMode, "plan", "init 先宣称 plan");
    const err = events.find((e) => e.type === "error");
    assert.ok(err && /切换权限模式失败/.test(err.message || ""), "set_mode 被拒应发 error 事件：" + JSON.stringify(events.map((e) => e.type)));
    const fix = events.filter((e) => e.type === "perm_mode");
    assert.ok(fix.length > 0, "应发 perm_mode 事件把模式纠回");
    assert.equal(fix[fix.length - 1].mode, "default", "纠回的应是实际生效的 default，而不是被拒的 plan");
    assert.ok(events.indexOf(init) < events.indexOf(err), "init 应在 error 之前发出");
  } finally {
    try { closeAllAcpClients(); } catch {}
  }
});

// ── MIG-8：/autocompact 立即触发（纯 agy 模式下所有有效厂商均适用） ───────
test("MIG-8：protocol:gemini 与纯 agy 下厂商均适用 /autocompact 立即触发", async () => {
  const { autocompactImmediateApplies } = await import("../gw/run.mjs");
  assert.equal(autocompactImmediateApplies({ group: "custom", authStyle: "bearer", protocol: "gemini" }), true);
  assert.equal(autocompactImmediateApplies({ group: "custom", authStyle: "bearer" }), true);
  assert.equal(autocompactImmediateApplies({ group: "antigravity" }), true);
  assert.equal(autocompactImmediateApplies({ authStyle: "gemini-api-key" }), true);
  assert.equal(autocompactImmediateApplies(null), false);
});

// ── MIG-11：ADC 凭据前置检查 ────────────────────────────────────────────
const ADC_FILE = path.join(CFG.home, ".config", "gcloud", "application_default_credentials.json");
function cleanAdc() {
  try { fs.rmSync(ADC_FILE, { force: true }); } catch {}
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
}
test("MIG-11：无 ADC 凭据时前置报错并给出 gcloud 指引；有凭据时放行", async () => {
  cleanAdc();
  const { hasAdcCredentials, adcCredentialsPath } = await import("../gw/providers.mjs");
  const { adcMissingError } = await import("../gw/run.mjs");
  assert.equal(hasAdcCredentials(), false, "无 ADC 文件时应判无凭据");
  assert.equal(adcCredentialsPath(), "");
  const msg = adcMissingError({ authType: "agent-platform" });
  assert.ok(msg.includes("gcloud auth application-default login"), "缺凭据报错应给出 gcloud 指引：" + msg);
  assert.ok(adcMissingError({ authStyle: "adc" }).includes("gcloud auth application-default login"));
  assert.equal(adcMissingError({ authType: "oauth-personal" }), "", "非 ADC 厂商不应被 ADC 检查拦住");
  assert.equal(adcMissingError({ authStyle: "gemini-api-key" }), "");
  fs.mkdirSync(path.dirname(ADC_FILE), { recursive: true });
  fs.writeFileSync(ADC_FILE, JSON.stringify({ type: "authorized_user", client_id: "x", client_secret: "y", refresh_token: "z" }));
  assert.equal(hasAdcCredentials(), true, "写好 ADC 文件后应判有凭据");
  assert.equal(adcCredentialsPath(), ADC_FILE);
  assert.equal(adcMissingError({ authType: "agent-platform" }), "", "有凭据时不应报错");
  cleanAdc();
  const envFile = path.join(tmpRoot, "adc-env.json");
  fs.writeFileSync(envFile, JSON.stringify({ type: "service_account" }));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = envFile;
  assert.equal(hasAdcCredentials(), true, "GOOGLE_APPLICATION_CREDENTIALS 指到的文件也算凭据");
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(tmpRoot, "no-such-adc.json");
  assert.equal(hasAdcCredentials(), false, "环境变量指到不存在的文件应判无凭据");
  cleanAdc();
});

test("MIG-11：testProvider 对 ADC 预置先查凭据文件", async () => {
  cleanAdc();
  const { routeProviders } = await import("../gw/providers.mjs");
  const { srv, call } = await serve(routeProviders);
  try {
    const r1 = await call("/api/providers/test", { id: "antigravity-adc" });
    assert.equal(r1.body.ok, false, JSON.stringify(r1.body));
    assert.ok(String(r1.body.message || "").includes("gcloud auth application-default login"),
      "无 ADC 文件时测试应前置报错：" + JSON.stringify(r1.body));
    fs.mkdirSync(path.dirname(ADC_FILE), { recursive: true });
    fs.writeFileSync(ADC_FILE, JSON.stringify({ type: "authorized_user" }));
    const r2 = await call("/api/providers/test", { id: "antigravity-adc" });
    assert.equal(r2.body.ok, true, JSON.stringify(r2.body));
  } finally {
    srv.close();
    cleanAdc();
  }
});

// ── MIG-12：protocol:"gemini" 决定模型清单猜测与认证头 ─────────────────
test("MIG-12：protocol:gemini 的自定义厂商先猜 /v1beta/models 且带 x-goog-api-key", async () => {
  const { fetchModels, dropModelCache } = await import("../gw/models.mjs");
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push([req.url, req.headers["x-goog-api-key"] || "", req.headers.authorization || ""]);
    if (req.url === "/gem/v1beta/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "models/gemini-x", displayName: "Gemini X", inputTokenLimit: 1000000 }] }));
    } else if (req.url === "/ctl/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "relay-m1" }] }));
    } else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const port = srv.address().port;
    dropModelCache();
    const gem = { id: "custom-mig12-gem", custom: true, group: "custom", authStyle: "bearer", modelsAuth: "bearer",
      protocol: "gemini", apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}/gem`, modelsUrl: "", defaultModel: "gemini-x" };
    const list = await fetchModels(false, gem, { guess: true });
    assert.ok(list.some((m) => m.id === "gemini-x"), "应拉到 Gemini 清单：" + JSON.stringify(list));
    assert.equal(hits[0][0], "/gem/v1beta/models", "protocol:gemini 应先猜 /v1beta/models，实际先试：" + JSON.stringify(hits));
    assert.equal(hits[0][1], "sk-test", "Gemini 端点应带 x-goog-api-key，而不是 Bearer");
    assert.equal(hits[0][2], "", "Gemini 端点不应再带 Authorization: Bearer");
    dropModelCache();
    hits.length = 0;
    const ctl = { id: "custom-mig12-ctl", custom: true, group: "custom", authStyle: "bearer", modelsAuth: "bearer",
      apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}/ctl`, modelsUrl: "", defaultModel: "relay-m1" };
    const list2 = await fetchModels(false, ctl, { guess: true });
    assert.ok(list2.some((m) => m.id === "relay-m1"), "未声明 protocol 的仍按旧口径拉清单");
    assert.equal(hits[0][0], "/ctl/v1/models", "未声明 protocol 的应先猜 /v1/models，实际：" + JSON.stringify(hits));
    assert.equal(hits[0][2], "Bearer sk-test", "未声明 protocol 的仍带 Bearer");
  } finally {
    srv.close();
  }
});

test("MIG-12：protocol 字段经 upsertProvider 存取；设置页有 protocol 选择器", async () => {
  const { upsertProvider, providerById } = await import("../gw/providers.mjs");
  const created = upsertProvider(null, {
    label: "Fixture MIG-12", baseUrl: "https://fixture-mig12.example.invalid",
    authStyle: "bearer", protocol: "gemini", defaultModel: "gemini-3.8-flash",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.provider.protocol, "gemini", "protocol:gemini 应存下来并回显");
  assert.equal(providerById(created.id).protocol, "gemini");
  const cleared = upsertProvider(created.id, { protocol: "" });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(cleared.provider.protocol, "", "protocol 留空应清除声明");
  const bad = upsertProvider(created.id, { protocol: "anthropic" });
  assert.equal(bad.ok, true, JSON.stringify(bad));
  assert.equal(bad.provider.protocol, "", "非 gemini 的 protocol 值不应存下来");
  // 设置页（11-usage.js 自定义接口卡）应有 protocol 选择器（仅 Gemini/未声明两档），保存时带 protocol
  const card = fs.readFileSync(new URL("../web/app/11-usage.js", import.meta.url), "utf8");
  assert.ok(/id="cc-protocol"/.test(card), "自定义接口卡应有 cc-protocol 选择器");
  assert.ok(/value="gemini"/.test(card) && /protocol/.test(card), "选择器应有 gemini 档");
  assert.ok(/protocol: \$\("cc-protocol"\)\.value/.test(card), "保存时应把 protocol 发给后端");
});

// ── MIG-13：customModelsConfig 格式只按官方文档核对，不改格式 ───────────
test("MIG-13：customModelsConfig 带路径端点的写法标明未验证，不改格式", async () => {
  const src = fs.readFileSync(new URL("../gw/claude.mjs", import.meta.url), "utf8");
  assert.ok(/MIG-13/.test(src), "claude.mjs 里应有 MIG-13 核对注释");
  assert.ok(/未验证/.test(src), "注释应写明带路径端点的写法未验证");
  assert.ok(/antigravity\.google\/docs\/settings/.test(src), "注释应给出官方文档出处");
  // 已核对的一半：host-only 端点沿用文档形式 gemini-api://<host>/models/<id>（rem-C2 已有断言兜底）
  const { syncAgySettings } = await import("../gw/claude.mjs");
  const settingsFile = path.join(CFG.home, ".gemini", "antigravity-cli", "settings.json");
  const hadSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : null;
  const r = syncAgySettings({ id: "custom-mig13", group: "custom", authStyle: "gemini-api-key",
    authType: "gemini-api-key", baseUrl: "https://gemini-proxy.example.com",
    defaultModel: "gemini-3.8-flash", fastModel: "gemini-3.8-flash" }, "<redacted>");
  assert.equal(r.error || "", "");
  const st = JSON.parse(fs.readFileSync(r.file, "utf8"));
  assert.equal(st.customModelsConfig.customModels[0].modelName, "gemini-api://gemini-proxy.example.com/models/gemini-3.8-flash");
  if (hadSettings === null) fs.rmSync(settingsFile, { force: true }); else fs.writeFileSync(settingsFile, hadSettings);
});

// ── MIG-14：logout 与 hasAgySessionFiles 同口径递归删凭据 ───────────────
const CRED_DIRS = [
  path.join(CFG.home, ".gemini", "antigravity-cli"),
  path.join(CFG.home, ".config", "antigravity"),
  path.join(CFG.home, ".antigravity"),
];
function cleanCredDirs() {
  for (const d of CRED_DIRS) fs.rmSync(d, { recursive: true, force: true });
}
test("MIG-14：子目录里的凭据文件也能被探测到，logout 递归删净、非凭据文件不动", async () => {
  cleanCredDirs();
  const { hasAgySessionFiles, routeLogin } = await import("../gw/login.mjs");
  const nested = path.join(CRED_DIRS[0], "oauth", "token.json");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, JSON.stringify({ token: "x" }));
  const top = path.join(CRED_DIRS[1], "session.json");
  fs.mkdirSync(path.dirname(top), { recursive: true });
  fs.writeFileSync(top, JSON.stringify({ session: "y" }));
  const keepTxt = path.join(CRED_DIRS[2], "oauth", "notes.txt");
  fs.mkdirSync(path.dirname(keepTxt), { recursive: true });
  fs.writeFileSync(keepTxt, "not a credential");
  const keepBak = path.join(CRED_DIRS[0], "token.json.bak");
  fs.writeFileSync(keepBak, JSON.stringify({ token: "old" }));
  assert.equal(hasAgySessionFiles(), true, "子目录里的 token.json 应被探测到");
  const { srv, call } = await serve(routeLogin);
  try {
    const r = await call("/api/login/logout", {});
    assert.equal(r.body.ok, true, "删净后重探应判已退出：" + JSON.stringify(r.body));
    assert.equal(fs.existsSync(nested), false, "子目录里的凭据应被删掉");
    assert.equal(fs.existsSync(top), false, "顶层凭据应被删掉");
    assert.equal(fs.existsSync(keepTxt), true, "非凭据文件不得被删");
    assert.equal(fs.existsSync(keepBak), true, ".bak 不得被删");
    assert.equal(hasAgySessionFiles(), false, "删净后探测应为未登录");
  } finally {
    srv.close();
    cleanCredDirs();
  }
});
