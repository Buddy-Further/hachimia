// rem-C2（评分条件 1）：第三方 bearer 厂商在 agy-only ACP 下没有认证通道。
// 方案 (a)：仅当厂商明确声明 protocol:"gemini" 时，恢复受控的 Gemini 注入通道
// （agyEnv 注入 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL；syncAgySettings 写
// modelProvider=gemini + customModelsConfig；acpAuthType 返回 gemini-api-key；
// run.mjs 的 ACP 路由认 protocol:"gemini"）。不用 authStyle:bearer 猜协议。
// 查证依据见 ~/workspace/hachimia-bugfix/rem-C2.md：agy 官方文档只认 Gemini 协议
// 的 API Key 模式（modelProvider=gemini + GEMINI_API_KEY，自定义端点走
// GOOGLE_GEMINI_BASE_URL），没有通用第三方 bearer 通道；C1 之前自定义厂商
// （group/custom）走的正是这条 Gemini 通道，C1 把它一并关掉了。
// 密钥、模型名、端点全是 fixture。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";

const agySettingsFile = () => path.join(CFG.home, ".gemini", "antigravity-cli", "settings.json");
function writeAgySettings(obj) {
  fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
  fs.writeFileSync(agySettingsFile(), JSON.stringify(obj, null, 2));
}
function readAgySettings() {
  try { return JSON.parse(fs.readFileSync(agySettingsFile(), "utf8")); } catch { return null; }
}
const settingsBefore = (() => { try { return fs.readFileSync(agySettingsFile(), "utf8"); } catch { return null; } })();
after(() => {
  try {
    if (settingsBefore === null) fs.unlinkSync(agySettingsFile());
    else fs.writeFileSync(agySettingsFile(), settingsBefore);
  } catch {}
});

// Gemini 兼容代理：HTTP 层用 Bearer 认证，但讲 Gemini 协议（C2 回归子集：
// C1 之前这类自定义端点靠 GEMINI_API_KEY 注入能跑，C1 之后无 key 可跑）。
const geminiProxy = {
  id: "custom-9", custom: true, login: false, authStyle: "bearer",
  baseUrl: "https://gemini-proxy.example.com", apiKey: "sk-test-fixture-gemini-proxy",
  defaultModel: "gemini-3.8-flash", protocol: "gemini",
};
const bearerNoProtocol = { ...geminiProxy, protocol: undefined };
delete bearerNoProtocol.protocol;

// ── 注入：无 protocol 时仍不注入（C1 的 guard 不得退化）──
test("C2-rem：无 protocol 声明的自定义 bearer 端点仍不注入 GEMINI_API_KEY", async () => {
  const { agyEnv } = await import("../gw/claude.mjs");
  writeAgySettings({ theme: "dark" });
  const env = agyEnv({ provider: bearerNoProtocol });
  assert.equal(env.GEMINI_API_KEY, undefined, "没声明 Gemini 协议就不得冒充 Gemini key");
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, undefined, "没声明 Gemini 协议就不得冒充 Gemini 端点");
  assert.equal(readAgySettings().modelProvider, undefined, "没声明 Gemini 协议就不得写 modelProvider=gemini");
});

// ── 注入：protocol:"gemini" 时恢复 ──
test("C2-rem：protocol:'gemini' 的自定义 bearer 端点恢复 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL 注入", async () => {
  const { agyEnv } = await import("../gw/claude.mjs");
  writeAgySettings({ theme: "dark" });
  const env = agyEnv({ provider: geminiProxy });
  assert.equal(env.GEMINI_API_KEY, "sk-test-fixture-gemini-proxy", "声明 Gemini 协议的端点应恢复注入 key");
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, "https://gemini-proxy.example.com", "声明 Gemini 协议的端点应恢复注入 baseUrl");
});

// ── settings 同步：protocol:"gemini" 时写 Gemini 配置 ──
test("C2-rem：protocol:'gemini' 的自定义 bearer 端点写 modelProvider=gemini + customModelsConfig", async () => {
  const { syncAgySettings } = await import("../gw/claude.mjs");
  writeAgySettings({ theme: "dark" });
  const r = syncAgySettings(geminiProxy, "sk-test-fixture-gemini-proxy");
  assert.equal(r.isApiKey, true, "声明 Gemini 协议应算 API Key 模式：" + JSON.stringify(r));
  const st = readAgySettings();
  assert.equal(st.modelProvider, "gemini");
  assert.equal(st.customModelsConfig.customModels[0].modelName, "gemini-api://gemini-proxy.example.com/models/gemini-3.8-flash");
  assert.equal(st.theme, "dark", "无关配置必须保留");
});

// ── 不猜协议：别的 protocol 值不得触发 Gemini 通道 ──
test("C2-rem：protocol 不是 gemini 时不注入、不写 Gemini 配置", async () => {
  const { agyEnv, syncAgySettings } = await import("../gw/claude.mjs");
  const anthropicLike = { ...geminiProxy, protocol: "anthropic" };
  writeAgySettings({ theme: "dark" });
  const env = agyEnv({ provider: anthropicLike });
  assert.equal(env.GEMINI_API_KEY, undefined, "protocol:'anthropic' 不是 Gemini 协议");
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, undefined);
  const r = syncAgySettings(anthropicLike, "sk-test-fixture-gemini-proxy");
  assert.equal(r.isApiKey, false, "protocol:'anthropic' 不算 API Key 模式");
  assert.equal(readAgySettings().modelProvider, undefined);
});

// ── 登录类厂商优先：protocol 声明不得压过登录态 ──
test("C2-rem：登录类厂商即使带 protocol:'gemini' 也不注入", async () => {
  const { agyEnv } = await import("../gw/claude.mjs");
  writeAgySettings({ theme: "dark" });
  const loginLike = { ...geminiProxy, login: true, protocol: "gemini" };
  const env = agyEnv({ provider: loginLike });
  assert.equal(env.GEMINI_API_KEY, undefined, "登录类厂商走订阅登录，不注入 key");
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, undefined);
});

// ── ACP 认证映射：protocol:"gemini" 的自定义厂商按 Gemini 认证 ──
test("C2-rem：acpAuthType 对 protocol:'gemini' 的自定义厂商返回 gemini-api-key，无声明的仍是自己的 *-api-key", async () => {
  const { acpAuthType, providerById } = await import("../gw/providers.mjs");
  assert.equal(acpAuthType(geminiProxy), "gemini-api-key", "声明 Gemini 协议的自定义厂商应按 Gemini 认证");
  assert.equal(acpAuthType(bearerNoProtocol), "custom-9-api-key", "无声明的自定义厂商仍用自己的 api-key 类型");
  assert.equal(acpAuthType(providerById("deepseek")), "deepseek-api-key", "预置第三方厂商不受影响");
  assert.equal(acpAuthType(providerById("gemini-key")), "gemini-api-key", "真 Gemini 厂商不变");
});

// ── ACP 路由：纯 agy 下所有有效厂商均走 ACP，且 protocol:"gemini" 具备有效通道 ──
test("C2-rem：protocol:'gemini' 走 ACP 且具备有效通道", async () => {
  const { usesAcp, hasAcpKeyChannel } = await import("../gw/providers.mjs");
  assert.equal(usesAcp(geminiProxy), true);
  assert.equal(hasAcpKeyChannel(geminiProxy), true);
  assert.equal(hasAcpKeyChannel(bearerNoProtocol), false);
});

// ── 持久化：upsertProvider 须接受并存下 protocol:"gemini"，非 gemini 值不存 ──
// 配置是模块加载时读的：子进程里用自己的临时 home 跑（同 a0610-main-providers.test.mjs 的做法）。
const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw");
const ROOT = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "fix-rem-c2-"));
let seq = 0;
function scenario(files, code) {
  const home = path.join(ROOT, "h" + ++seq);
  fs.mkdirSync(home, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(home, f), typeof v === "string" ? v : JSON.stringify(v));
  const src = `import fs from "node:fs"; const P = await import(${JSON.stringify(path.join(GW, "providers.mjs"))}); ${code}; process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    env: { ...process.env, CCAPP_HOME: home, HOME: home, CCAPP_WORKSPACE: path.join(home, "ws"), CCAPP_PREFIX: "" }, encoding: "utf8", timeout: 30000 });
  return { rc: r.status, out: r.stdout.trim().split("\n").pop(), err: r.stderr, home };
}

test("C2-rem：upsertProvider 保存 protocol:'gemini' 后落盘、重载后仍生效且 ACP 映射为 gemini-api-key", () => {
  const r = scenario({}, `const s = P.upsertProvider("", { baseUrl: "https://gemini-proxy.example.com", apiKey: "sk-test-fixture-gemini-proxy", label: "my gemini proxy", protocol: "gemini", defaultModel: "gemini-3.8-flash" });
    const disk = JSON.parse(fs.readFileSync(process.env.CCAPP_HOME + "/ccapp-providers.json", "utf8"));
    const v = P.PROVIDERS_CFG.providers[s.id];
    console.log(JSON.stringify({ ok: s.ok, id: s.id, diskProtocol: disk.providers[s.id] && disk.providers[s.id].protocol, viewProtocol: s.provider && s.provider.protocol, acp: P.acpAuthType(v) }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, id: "custom-1", diskProtocol: "gemini", viewProtocol: "gemini", acp: "gemini-api-key" });
});

test("C2-rem：upsertProvider 不存 protocol 的非 gemini 值（'anthropic' / 空串都不落盘）", () => {
  for (const proto of ["anthropic", ""]) {
    const r = scenario({}, `const s = P.upsertProvider("", { baseUrl: "https://proxy.example.com", apiKey: "sk-test-fixture-k", label: "p", protocol: ${JSON.stringify(proto)} });
      const disk = JSON.parse(fs.readFileSync(process.env.CCAPP_HOME + "/ccapp-providers.json", "utf8"));
      console.log(JSON.stringify({ ok: s.ok, hasProtocol: disk.providers[s.id] && ("protocol" in disk.providers[s.id]) }));`);
    assert.equal(r.rc, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { ok: true, hasProtocol: false }, "protocol=" + JSON.stringify(proto) + " 不得落盘");
  }
});
