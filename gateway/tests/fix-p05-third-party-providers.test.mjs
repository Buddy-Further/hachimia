// P0-5 第三方 Anthropic 协议厂商路由：先写红、再修绿。密钥全是 fixture 假 key。
// agy 1.5.13 没有通用第三方通道：路由只能是显式的 —— agy 原生走 ACP，
// Anthropic 协议走密封 Claude，没有 claude 二进制的设备上直接不可用。
import "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "../gw/config.mjs";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

process.env.CCAPP_PERM_WAIT_MS = "400";      // 权限确认超时改短（run.mjs 加载时读）
process.env.CCAPP_IDLE_CLOSE_MS = "800";     // 空闲收尾改短（同上）
delete process.env.CCAPP_PROTOCOL;           // 路由判定不走开发端强制 ACP
const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "p05-"));
const providerFile = path.join(home, "ccapp-providers.json");
const hadProviders = fs.existsSync(providerFile) ? fs.readFileSync(providerFile) : null;
fs.writeFileSync(providerFile, JSON.stringify({ active: "deepseek", providers: {
  deepseek: { apiKey: "sk-test-fixture-deepseek-key", defaultModel: "deepseek-flash" },
} }));
// 假 CLI（同 a0610-main-run）：sh 脚本按 stream-json 吐事件，起没起看 marker 文件
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep");
function script(steps, code = 0) {
  const body = steps.map((s) => s.raw ? s.raw : s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
const fakeAgy = path.join(root, "fake-agy");
const fakeClaude = path.join(root, "fake-claude");
const origPaths = { agy: PATHS.agy, claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
const origFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
/** 用空文件冒充二进制存在（从不执行）；不存在 = 该路径没有这支程序 */
function setBinaries({ agy, claude }) {
  if (agy) fs.writeFileSync(fakeAgy, "", { mode: 0o755 }); else fs.rmSync(fakeAgy, { force: true });
  if (claude) fs.writeFileSync(fakeClaude, "", { mode: 0o755 }); else fs.rmSync(fakeClaude, { force: true });
  PATHS.agy = agy ? fakeAgy : path.join(root, "no-agy");
  PATHS.claude = claude ? fakeClaude : path.join(root, "no-claude");
  PATHS.loader = origPaths.loader; PATHS.claudeLoader = origPaths.claudeLoader;
}
const Prov = await import("../gw/providers.mjs");
const { startRun } = await import("../gw/run.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
const prevMode = SETTINGS.permissionMode;
after(() => {
  off();
  globalThis.fetch = origFetch;
  SETTINGS.permissionMode = prevMode;
  Object.assign(PATHS, origPaths);
  if (hadProviders) fs.writeFileSync(providerFile, hadProviders); else fs.rmSync(providerFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }
const init = (s) => ({ type: "system", subtype: "init", session_id: s, model: "deepseek-flash", tools: [], permissionMode: "default" });
const result = { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 };

const THIRD = ["deepseek", "glm", "qwen", "kimi", "minimax", "ark", "mimo", "stepfun", "qianfan", "hunyuan", "longcat", "xai", "meta"];
const CLAUDE = ["anthropic", "anthropic-key"];
const AGY = ["antigravity", "antigravity-enterprise", "antigravity-adc", "gemini-key", "gemini-custom"];
const ROUTES = new Set(["agy", "claude", "unavailable"]);

// ── providerRoute：单点路由判定 ──
test("P0-5 providerRoute：agy-only 下 antigravity 5 家走 agy，13 个第三方 + 2 个 claude 预置不可用", () => {
  setBinaries({ agy: true, claude: false });
  for (const id of AGY) assert.equal(Prov.providerRoute(Prov.providerById(id)), "agy", id + " 应走 agy");
  for (const id of [...THIRD, ...CLAUDE]) assert.equal(Prov.providerRoute(Prov.providerById(id)), "unavailable", id + " 在 agy-only 设备上应不可用");
  const local = Prov.providerById("local");
  if (local) assert.equal(Prov.providerRoute(local), "unavailable", "端侧小模型在 agy-only 设备上不可用（MIG-34）");
});

test("P0-5 providerRoute：有 claude 二进制时第三方与 claude 预置走 claude，antigravity 仍走 agy", () => {
  setBinaries({ agy: true, claude: true });
  for (const id of AGY) assert.equal(Prov.providerRoute(Prov.providerById(id)), "agy", id + " 应走 agy");
  for (const id of [...THIRD, ...CLAUDE]) assert.equal(Prov.providerRoute(Prov.providerById(id)), "claude", id + " 有 claude 二进制时应走密封 Claude");
  const local = Prov.providerById("local");
  if (local) assert.equal(Prov.providerRoute(local), "claude", "端侧小模型走 claude 二进制");
});

test("P0-5 providerRoute：自定义厂商按 protocol 分流，不猜协议", () => {
  const bearer = { id: "custom-p05", custom: true, authStyle: "bearer", baseUrl: "https://proxy.example.com", apiKey: "sk-test-fixture" };
  const gemini = { ...bearer, id: "custom-p05g", protocol: "gemini" };
  const geminiKey = { ...bearer, id: "custom-p05k", authStyle: "gemini-api-key" };
  const adc = { ...bearer, id: "custom-p05a", authStyle: "adc" };
  setBinaries({ agy: true, claude: false });
  assert.equal(Prov.providerRoute(gemini), "agy", "protocol:gemini 走 agy");
  assert.equal(Prov.providerRoute(geminiKey), "agy", "authStyle gemini-api-key 走 agy");
  assert.equal(Prov.providerRoute(adc), "agy", "ADC 走 agy");
  assert.equal(Prov.providerRoute(bearer), "unavailable", "没声明协议的自定义 bearer 在 agy-only 下不可用");
  assert.equal(Prov.providerRoute(null), "unavailable", "空厂商不可用");
  setBinaries({ agy: true, claude: true });
  assert.equal(Prov.providerRoute(bearer), "claude", "没声明协议的自定义 bearer 有 claude 时走密封 Claude");
  assert.equal(Prov.providerRoute(gemini), "agy", "protocol:gemini 有 claude 时仍走 agy");
});

// ── oracle 与 usesAcp 一致 ──
test("P0-5：usesAcp 与 providerRoute 一致 —— 有 claude 时严格相等，agy-only 时 agy 路由即 ACP", () => {
  const customs = [
    { id: "custom-p05b", custom: true, authStyle: "bearer", baseUrl: "https://proxy.example.com", apiKey: "sk-test-fixture" },
    { id: "custom-p05g", custom: true, authStyle: "bearer", protocol: "gemini", baseUrl: "https://proxy.example.com", apiKey: "sk-test-fixture" },
  ];
  const all = [...AGY, ...THIRD, ...CLAUDE].map((id) => Prov.providerById(id)).concat(customs);
  const local = Prov.providerById("local");
  if (local) all.push(local);
  setBinaries({ agy: true, claude: true });
  for (const p of all) {
    assert.equal(Prov.usesAcp(p), Prov.providerRoute(p) === "agy", `${p.id}：有 claude 时 usesAcp 应与 route==="agy" 严格相等，route=${Prov.providerRoute(p)}`);
  }
  setBinaries({ agy: true, claude: false });
  for (const p of all) {
    if (p.local) { assert.equal(Prov.usesAcp(p), false, "端侧小模型不走 ACP"); continue; }
    assert.equal(Prov.usesAcp(p), true, `${p.id}：agy-only 下都算走 ACP 口径（无通道的由 MIG-9 拦截）`);
    // 注意不是 hasAcpKeyChannel：anthropic 订阅登录有 login 通道，但那是 Claude 自己的 OAuth，
    // 不是 agy 的，路由仍是 unavailable（MIG-10 在 agy-only 下本来就隐藏这组预置）。
    assert.equal(Prov.providerRoute(p) === "agy", Prov.isAgyNativeProvider(p), `${p.id}：agy-only 下 route==="agy" 当且仅当 agy 原生`);
  }
});

test("P0-5 源码：run.mjs 不再自带 useAcp 判定，改调 usesAcp（与 oracle 同口径）", () => {
  const run = fs.readFileSync(path.join(REPO, "gateway", "gw", "run.mjs"), "utf8");
  assert.match(run, /const useAcp = usesAcp\(P\)/, "startRun 应直接调 usesAcp");
  assert.doesNotMatch(run, /const useAcp = !P\.local && \(agyOnly/, "不得再留内联的 useAcp 判定副本");
  assert.match(run, /usesAcp/, "run.mjs 应 import usesAcp");
  const prov = fs.readFileSync(path.join(REPO, "gateway", "gw", "providers.mjs"), "utf8");
  assert.match(prov, /export function providerRoute/, "providers.mjs 应导出 providerRoute");
});

// ── MIG-9：发消息前按 oracle 路由 ──
test("P0-5 MIG-9：agy-only 下第三方 + key → 报错含设备原因、run 记录记 route，绝不 spawn", async () => {
  setBinaries({ agy: true, claude: false });
  PATHS.loader = PATHS.claudeLoader = cli;   // 假 CLI 在，起了就会留 marker
  script([{ raw: `: > ${root}/ran-p05-mig9` }, init(crypto.randomUUID()), result], 0);
  const id = "p05-mig9";
  await startRun({ id, message: "fixture", cwd: root });
  await until(() => endOf(id));
  const err = events.find((e) => e.type === "error" && e.runId === id);
  assert.ok(err, "应发 error 事件");
  assert.match(err.message, /该厂商在 Antigravity 下暂不支持/, "仍是 MIG-9 文案，实际：" + err.message);
  assert.match(err.message, /没有 Claude Code/, "须说明设备原因：没有 Claude Code 二进制，实际：" + err.message);
  assert.equal(endOf(id).failed, true, "这一轮应记失败");
  assert.equal(endOf(id).route, "unavailable", "run 记录应记 route=unavailable，实际：" + JSON.stringify(endOf(id)));
  assert.equal(fs.existsSync(path.join(root, "ran-p05-mig9")), false, "拦截在 spawn 之前：假 CLI 绝不能被起");
  assert.equal(events.some((e) => e.runId === id && e.type === "phase"), false, "拦截前不应有任何 phase 事件");
  assert.equal(RUNS.has(id), false, "收尾后运行槽应释放");
});

test("P0-5：有 claude 二进制时第三方走密封分支（假 CLI 被起、argv 是 claude 的，不是 ACP）", async () => {
  setBinaries({ agy: true, claude: true });
  PATHS.claude = process.execPath;            // 同 a0610-main-run：claude 走 loader（假 CLI）
  PATHS.loader = PATHS.claudeLoader = cli;
  SETTINGS.permissionMode = "default";
  script([{ raw: `: > ${root}/ran-p05-sealed` }, { raw: `printf '%s\\n' "$@" > ${root}/argv-p05` }, init(crypto.randomUUID()), result], 0);
  const id = "p05-sealed";
  await startRun({ id, message: "fixture", cwd: root });
  await until(() => endOf(id));
  assert.equal(fs.existsSync(path.join(root, "ran-p05-sealed")), true, "密封分支应真的起进程");
  const argv = fs.readFileSync(path.join(root, "argv-p05"), "utf8");
  assert.match(argv, /-p/, "claude argv 应含 -p，实际：" + argv);
  assert.match(argv, /--model\ndeepseek-flash/, "claude argv 应带第三方模型，实际：" + argv);
  assert.equal(!!endOf(id).failed, false, "密封分支应跑完，实际：" + JSON.stringify(endOf(id)));
  assert.equal(endOf(id).subtype, "success");
});

// ── agyEnv：13 个第三方厂商的 key 永不进 agy ──
test("P0-5：13 个第三方厂商的 key 永不出现在 agyEnv 里；Gemini 协议对照仍注入", async () => {
  const { agyEnv } = await import("../gw/claude.mjs");
  for (const id of THIRD) {
    const key = `sk-test-fixture-${id}-key`;
    const env = agyEnv({ provider: { ...Prov.providerById(id), apiKey: key }, sync: false });
    assert.equal(env.GEMINI_API_KEY, undefined, `${id} 的 key 不得冒充 Gemini key`);
    assert.equal(env.GOOGLE_GEMINI_BASE_URL, undefined, `${id} 的 baseUrl 不得冒充 Gemini 端点`);
    assert.equal(Object.values(env).some((v) => typeof v === "string" && v.includes(key)), false, `${id} 的 key 不得出在 agyEnv 的任何变量里`);
  }
  const gem = { id: "gemini-key", group: "antigravity", login: false, authStyle: "gemini-api-key", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "AIzaTestFixtureKey123456" };
  assert.equal(agyEnv({ provider: gem, sync: false }).GEMINI_API_KEY, "AIzaTestFixtureKey123456", "正向对照：gemini-key 仍注入");
  const gemCustom = { id: "custom-p05g", custom: true, authStyle: "bearer", protocol: "gemini", baseUrl: "https://proxy.example.com", apiKey: "AIzaTestFixtureKey999" };
  assert.equal(agyEnv({ provider: gemCustom, sync: false }).GEMINI_API_KEY, "AIzaTestFixtureKey999", "正向对照：protocol:gemini 自定义仍注入");
});

// ── /api/providers 与 providerBrief 带 route ──
test("P0-5：/api/providers 与 providerBrief 都带 route", async () => {
  setBinaries({ agy: true, claude: true });
  let payload;
  const res = { writeHead() {}, end(b) { payload = JSON.parse(b.toString()); } };
  await Prov.routeProviders({ method: "GET", headers: {} }, res, new URL("http://x/api/providers"), "/api/providers");
  assert.ok(Array.isArray(payload.providers) && payload.providers.length > 0, "应返回厂商列表");
  for (const p of payload.providers) {
    assert.ok(ROUTES.has(p.route), `${p.id} 的 route 应为 agy/claude/unavailable，实际 ${p.route}`);
    assert.equal(p.route, Prov.providerRoute(Prov.providerById(p.id)), `${p.id} 的 payload route 应与 oracle 一致`);
  }
  assert.equal(payload.providers.find((p) => p.id === "deepseek").route, "claude", "有 claude 时 DeepSeek 应标 claude");
  assert.equal(payload.providers.find((p) => p.id === "antigravity").route, "agy");
  const brief = Prov.providerBrief();
  for (const p of brief) assert.ok(ROUTES.has(p.route), `${p.id} 的 providerBrief 也应带 route，实际 ${p.route}`);
});

// ── UI：按 route 标注 ──
test("P0-5 UI：设置卡与模型选单按 route 标注（经 Claude 运行 / 此设备不可用）", () => {
  const ROOT = REPO;
  const settings = fs.readFileSync(path.join(ROOT, "gateway", "web", "app", "09-settings.js"), "utf8");
  assert.match(settings, /p\.route/, "设置卡应读 provider 的 route");
  assert.match(settings, /经 Claude 运行/, "设置卡应标出走密封 Claude 的厂商");
  assert.match(settings, /此设备不可用/, "设置卡应标出此设备不可用的厂商");
  const caps = fs.readFileSync(path.join(ROOT, "gateway", "web", "app", "12-model-caps.js"), "utf8");
  assert.match(caps, /route === "claude"/, '模型选单应按 route==="claude" 标注');
  assert.match(caps, /经 Claude 运行/);
  assert.match(caps, /route === "unavailable"/, '模型选单应按 route==="unavailable" 标注');
  assert.match(caps, /此设备不可用/);
});
