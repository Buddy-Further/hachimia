// C 分片修复测试（fix-C-models）：C1/C3/C4/A4（claude.mjs agyEnv/syncAgySettings）、
// C5/C8/C9/C11/C12/C17（models.mjs）。先写红、再修绿；密钥全是 fixture 假 key。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";

const agySettingsFile = () => path.join(CFG.home, ".gemini", "antigravity-cli", "settings.json");
function writeAgySettings(obj) {
  fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
  fs.writeFileSync(agySettingsFile(), JSON.stringify(obj, null, 2));
}
function readAgySettings() {
  try { return JSON.parse(fs.readFileSync(agySettingsFile(), "utf8")); } catch { return null; }
}
const origAgy = PATHS.agy;
// 本文件不改厂商配置文件（共用池 home，别的文件会读它）；settings.json 会被 agyEnv/syncAgySettings 写，
// 跑完恢复到来时的样子，免得污染同池别的测试文件。
const settingsBefore = (() => { try { return fs.readFileSync(agySettingsFile(), "utf8"); } catch { return null; } })();
after(() => {
  PATHS.agy = origAgy;
  try {
    if (settingsBefore === null) fs.unlinkSync(agySettingsFile());
    else fs.writeFileSync(agySettingsFile(), settingsBefore);
  } catch {}
});

// ── C1（P0）：agyEnv 不得把非登录第三方厂商的 key 注入为 GEMINI_API_KEY ──
test("C1：带 key 的 DeepSeek 不得被注入为 GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL", async () => {
  const { agyEnv } = await import("../gw/claude.mjs");
  const { providerById, keyOf } = await import("../gw/providers.mjs");
  // 用字面量对象带 key（GLM 不是生效厂商，keyOf 直接读对象上的 key；绝不在共用池 home 里给预置存真 key，
  // 那会改掉别的测试文件看到的 isProviderVisible）
  const glm = { ...providerById("glm"), apiKey: "sk-test-fixture-glm-key" };
  assert.equal(String(keyOf(glm) || "").length > 0, true);
  writeAgySettings({ theme: "dark" });
  const env = agyEnv({ provider: glm });
  assert.equal(env.GEMINI_API_KEY, undefined, "GLM 的 key 不得冒充 Gemini key");
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, undefined, "GLM 的 baseUrl 不得冒充 Gemini 端点");
  // DeepSeek 同款（字面量对象，不写配置）
  const ds = { ...providerById("deepseek"), apiKey: "sk-test-fixture-deepseek-key" };
  const envDs = agyEnv({ provider: ds });
  assert.equal(envDs.GEMINI_API_KEY, undefined, "DeepSeek 的 key 不得冒充 Gemini key");
  assert.equal(envDs.GOOGLE_GEMINI_BASE_URL, undefined, "DeepSeek 的 baseUrl 不得冒充 Gemini 端点");
  // 正向对照：真正的 Gemini 协议厂商仍正常注入
  const gem = { id: "gemini-key", group: "antigravity", login: false, authStyle: "gemini-api-key", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "AIzaTestFixtureKey123456" };
  const envG = agyEnv({ provider: gem });
  assert.equal(envG.GEMINI_API_KEY, "AIzaTestFixtureKey123456");
  assert.equal(envG.GOOGLE_GEMINI_BASE_URL, undefined);
});

// ── C3（P1）：syncAgySettings 不得把自定义 Bearer 端点当 Gemini ──
test("C3：自定义 Bearer 端点不得写出 modelProvider=gemini / gemini-api:// 自定义模型", async () => {
  const { syncAgySettings } = await import("../gw/claude.mjs");
  writeAgySettings({ theme: "dark" });
  const bearer = { id: "custom-1", custom: true, login: false, authStyle: "bearer", baseUrl: "https://proxy.example.com/anthropic", apiKey: "sk-test-fixture-bearer", defaultModel: "my-model" };
  syncAgySettings(bearer, "sk-test-fixture-bearer");
  const st = readAgySettings();
  assert.equal(st.modelProvider, undefined, "Bearer 端点不是 Gemini API Key 模式");
  assert.equal(st.customModelsConfig, undefined, "Bearer 端点不得写出 gemini-api:// 自定义模型");
  assert.equal(st.theme, "dark", "无关键要保留");
  // 正向对照：真正的 Gemini 协议自定义端点仍写
  const gemCustom = { id: "custom-2", custom: true, login: false, authStyle: "gemini-api-key", baseUrl: "https://my-gemini-proxy.example.com", apiKey: "AIzaTestFixtureKey999", defaultModel: "gemini-4-neon" };
  syncAgySettings(gemCustom, "AIzaTestFixtureKey999");
  const st2 = readAgySettings();
  assert.equal(st2.modelProvider, "gemini");
  assert.equal(st2.customModelsConfig.customModels[0].modelName, "gemini-api://my-gemini-proxy.example.com/models/gemini-4-neon");
});

// ── C4（P2）：Gemini 官方地址带路径时不得误判为自定义端点 ──
test("C4：gemini-key 的 baseUrl 带 /v1beta 路径时不得写出 customModelsConfig", async () => {
  const { syncAgySettings } = await import("../gw/claude.mjs");
  writeAgySettings({ theme: "dark" });
  const p = { id: "gemini-key", group: "antigravity", login: false, authStyle: "gemini-api-key", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "AIzaTestFixtureKey123", defaultModel: "gemini-3.8-flash" };
  syncAgySettings(p, "AIzaTestFixtureKey123");
  const st = readAgySettings();
  assert.equal(st.modelProvider, "gemini", "官方 host 仍是 Gemini 模式");
  assert.equal(st.customModelsConfig, undefined, "官方 host 即使带路径也不是自定义端点");
});

// ── A4（P1，与 C3 同根）：查登录态（authStatus 探针）不得删 API Key 模式的 modelProvider ──
test("A4：authStatus 探针不得删掉 API Key 模式的 settings.json（modelProvider/customModelsConfig）", async () => {
  const { authStatus } = await import("../gw/login.mjs");
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-c-a4-"));
  const mockAgy = path.join(tmp, "agy");
  fs.writeFileSync(mockAgy, "#!/bin/sh\nprintf 'gemini-4-neon-high\\tGemini 4 Neon (High)\\n'\n", { mode: 0o755 });
  PATHS.agy = mockAgy;
  try {
    writeAgySettings({ modelProvider: "gemini", customModelsConfig: { customModels: [{ modelName: "gemini-api://proxy.example.com/models/my-model", label: "my-model" }] }, theme: "dark" });
    const v = await authStatus(true);
    assert.equal(v.loggedIn, true, JSON.stringify(v));
    const st = readAgySettings();
    assert.equal(st.modelProvider, "gemini", "只读探针不得删 API Key 模式的配置");
    assert.ok(st.customModelsConfig, "只读探针不得删 customModelsConfig");
    assert.equal(st.theme, "dark");
  } finally { PATHS.agy = origAgy; }
});

test("A4：agyEnv 默认仍同步（切回订阅登录时清掉 modelProvider），只在 sync:false 时跳过", async () => {
  const { agyEnv } = await import("../gw/claude.mjs");
  writeAgySettings({ modelProvider: "gemini", theme: "dark" });
  const loginProv = { id: "antigravity", group: "antigravity", login: true, nativeModels: true };
  const env = agyEnv({ provider: loginProv, sync: false });
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(readAgySettings().modelProvider, "gemini", "sync:false 时不碰 settings.json");
  agyEnv({ provider: loginProv });
  assert.equal("modelProvider" in readAgySettings(), false, "默认同步：真切到订阅模式时清掉");
});

// ── C5（P1）：agy models 清单不得硬编码 1M 窗口，learnWindow 学到的真实窗口要能生效 ──
test("C5：parseAgyModelsOutput 不写死窗口；learnWindow 的真实窗口能覆盖", async () => {
  const { parseAgyModelsOutput, learnWindow, withWindows } = await import("../gw/models.mjs");
  const parsed = parseAgyModelsOutput(`
gemini-4-neon-high\tGemini 4 Neon (High)
claude-sonnet-4-6\tClaude Sonnet 4.6
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`);
  assert.equal(parsed.find((m) => m.id === "claude-sonnet-4-6").context_window, 0, "agy 输出里没有窗口信息时应为未知（0），不瞎编 1M");
  assert.equal(parsed.find((m) => m.id === "gpt-oss-120b-medium").context_window, 0);
  assert.equal(parsed.find((m) => m.id === "gemini-4-neon").context_window, 0);
  learnWindow({ modelUsage: {
    "claude-sonnet-4-6": { contextWindow: 200000, maxOutputTokens: 32000 },
    "gpt-oss-120b-medium": { contextWindow: 128000, maxOutputTokens: 32000 },
  } }, { nativeModels: true });
  const after = withWindows(parsed);
  assert.equal(after.find((m) => m.id === "claude-sonnet-4-6").context_window, 200000, "学到的 200k 窗口要能生效");
  assert.equal(after.find((m) => m.id === "gpt-oss-120b-medium").context_window, 128000, "学到的 128k 窗口要能生效");
  assert.equal(after.find((m) => m.id === "gemini-4-neon").context_window, 0, "没学到的仍是未知，不瞎编");
});

// ── C11（P2）：标题/警告/旧格式行不得被解析成模型 ──
test("C11：parseAgyModelsOutput 只收模型行，标题/警告/旧格式显示名行都丢掉", async () => {
  const { parseAgyModelsOutput } = await import("../gw/models.mjs");
  const out = parseAgyModelsOutput(`
Available models:
Fetching available models...
gemini-4-neon-high\tGemini 4 Neon (High)
WARNING: deprecated flag used, ignoring
ERROR: failed to load cache, continuing
Gemini 3.5 Flash (Medium)
Claude Sonnet 4.6 (Thinking)
`);
  assert.deepEqual(out.map((m) => m.id), ["gemini-4-neon"]);
  assert.deepEqual(out[0].effort.supported_levels, ["high"]);
});

// ── C17（P2）：(Thinking) 固定档位模型不得报成支持全部 effort 档位 ──
test("C17：(Thinking) 固定档位模型不报全部 effort；gpt-oss-120b-medium 只报 medium", async () => {
  const { parseAgyModelsOutput, effortLevelsOf } = await import("../gw/models.mjs");
  const p = { group: "antigravity", nativeModels: true };
  const parsed = parseAgyModelsOutput(`
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`);
  assert.deepEqual(effortLevelsOf(parsed.find((m) => m.id === "claude-opus-4-6-thinking"), p), [], "(Thinking) 不可调 effort");
  assert.deepEqual(effortLevelsOf(parsed.find((m) => m.id === "claude-sonnet-4-6"), p), [], "名字带 (Thinking) 也是固定档位");
  assert.deepEqual(effortLevelsOf(parsed.find((m) => m.id === "gpt-oss-120b-medium"), p), ["medium"], "单档固定名只报自己的档位");
  // 后备：effort 信息缺失时也按名字认，不回落到全量档位
  assert.deepEqual(effortLevelsOf({ id: "claude-opus-4-6-thinking", effort: null }, p), []);
  assert.deepEqual(effortLevelsOf({ id: "x", name: "X (Thinking)", effort: null }, p), []);
  // 不影响正常模型与空模型
  assert.deepEqual(effortLevelsOf({}, p), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(effortLevelsOf({ id: "gemini-4-neon", effort: { supported_levels: ["low", "high"], default_level: "high" } }, p), ["low", "high"]);
});

// ── C12（P2）：agy models 非零退出时已打印的清单不得丢弃 ──
test("C12：agy models exit 1 但已打印清单时，仍用打印出的清单，不回落写死 fallback", async () => {
  const { fetchModels, dropModelCache } = await import("../gw/models.mjs");
  const { providerById } = await import("../gw/providers.mjs");
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-c-c12-"));
  const mockAgy = path.join(tmp, "agy");
  fs.writeFileSync(mockAgy, "#!/bin/sh\nprintf 'gemini-9-testmodel-high\\tGemini 9 Testmodel (High)\\n'\nexit 1\n", { mode: 0o755 });
  PATHS.agy = mockAgy;
  try {
    dropModelCache();
    const list = await fetchModels(true, providerById("antigravity"));
    assert.ok(list.some((m) => m.id === "gemini-9-testmodel"), "exit 1 也要保留 stdout 里已打印的模型：" + list.map((m) => m.id).join(","));
  } finally { PATHS.agy = origAgy; }
});

// ── C8（P1）：Gemini /v1beta/models 分页不得丢失 ──
test("C8：Gemini models 列表跟进 nextPageToken，50 条之后也要拿到", async () => {
  const { fetchModels, dropModelCache } = await import("../gw/models.mjs");
  const { providerById } = await import("../gw/providers.mjs");
  const page1 = { models: Array.from({ length: 50 }, (_, i) => ({
    name: `models/gemini-test-${String(i).padStart(2, "0")}`, displayName: `Test ${i}`,
    inputTokenLimit: 1000000, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent"],
  })), nextPageToken: "page2token" };
  const page2 = { models: [{ name: "models/gemini-test-50", displayName: "Test 50",
    inputTokenLimit: 1000000, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent"] }] };
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = calls.length === 1 ? page1 : page2;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    dropModelCache();
    const p = { ...providerById("gemini-key"), apiKey: "AIzaTestFixtureKey123" };
    const list = await fetchModels(true, p, { guess: false });
    assert.equal(calls.length, 2, "第 2 页必须去拉：" + JSON.stringify(calls));
    assert.ok(calls[1].includes("pageToken=page2token"), "第 2 页用 pageToken 跟进");
    assert.equal(list.length, 51);
    assert.ok(list.some((m) => m.id === "gemini-test-50"), "第 51 个模型要能拿到");
  } finally { globalThis.fetch = origFetch; }
});

// ── C9（P1，部分）：ACP 默认压缩线 helper——原生厂商也适用 ──
test("C9：defaultAcpCompactLine 对原生厂商也给默认线（200k→160k，128k→88k）", async () => {
  const { defaultAcpCompactLine, defaultCompactLine } = await import("../gw/models.mjs");
  const native = { nativeModels: true, group: "antigravity" };
  assert.equal(defaultCompactLine(200000, native), null, "旧的 defaultCompactLine 对原生仍返回 null（claude 路径不动）");
  assert.equal(defaultAcpCompactLine(200000, native), 160000);
  assert.equal(defaultAcpCompactLine(128000, native), 88000);
  assert.equal(defaultAcpCompactLine(1048576, native), 838000);
  assert.equal(defaultAcpCompactLine(0, native), null, "窗口未知不瞎编");
  assert.equal(defaultAcpCompactLine(200000, { local: true }), null, "端侧小模型不给");
  assert.equal(defaultAcpCompactLine(50000, native), null, "扣掉 40k 总结余量后不够就不给");
});
