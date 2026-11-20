// MIG-10：agy-only 下 Claude 预置一律隐藏，active 是 anthropic 时自动迁回 antigravity 并提示。
// 必须在 import config 之前先把环境变量摆好（PATHS 在 import 时快照），见 fix-a-agyonly。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test, after } from "node:test";
import assert from "node:assert/strict";
// 注意：这里不能静态 import 任何 gw 模块（http.mjs 会连带拉起 config.mjs，
// PATHS 会在环境变量摆好之前快照，见 fix-a-agyonly 的教训）。NEXT 也动态 import。

const fakeAgy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fix-mig10-")), "agy");
fs.writeFileSync(fakeAgy, "#!/bin/sh\n", { mode: 0o755 });
process.env.CCAPP_AGY = fakeAgy;
delete process.env.CCAPP_CLAUDE;

const { CFG, PATHS } = await import("../gw/config.mjs");
const { NEXT } = await import("../gw/http.mjs");
assert.equal(fs.existsSync(PATHS.claude), false, "本用例要求测试环境里没有独立的 claude 二进制");

// 导入 providers 之前先把一份指着 Claude 预置的旧配置写好：loadProviders 应在导入时就迁移。
const PROVIDERS_FILE = path.join(CFG.home, "ccapp-providers.json");
const SETTINGS_FILE = path.join(CFG.home, "ccapp-settings.json");
const prevProviders = fs.existsSync(PROVIDERS_FILE) ? fs.readFileSync(PROVIDERS_FILE, "utf8") : null;
const prevSettings = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, "utf8") : null;
fs.mkdirSync(path.dirname(PROVIDERS_FILE), { recursive: true });
fs.writeFileSync(PROVIDERS_FILE, JSON.stringify({ active: "anthropic-key", providers: { "anthropic-key": { apiKey: "sk-fake-test" } } }, null, 2));

const prov = await import("../gw/providers.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");

after(async () => {
  try {
    if (prevProviders === null) fs.rmSync(PROVIDERS_FILE, { force: true }); else fs.writeFileSync(PROVIDERS_FILE, prevProviders);
    if (prevSettings === null) fs.rmSync(SETTINGS_FILE, { force: true }); else fs.writeFileSync(SETTINGS_FILE, prevSettings);
  } catch {}
  SETTINGS.provider = null;
  try { prov.applyProvider(); } catch {}
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

test("MIG-10：导入时旧配置的 active（anthropic-key）已迁回 antigravity 并落盘", async () => {
  assert.equal(prov.isAgyOnlyMode(), true, "本用例应在 agy-only 模式下跑");
  assert.equal(prov.PROVIDERS_CFG.active, "antigravity", "loadProviders 应把 Claude 预置的 active 迁回 antigravity");
  assert.equal(prov.PROVIDER_MIGRATED_FROM, "anthropic-key", "应记下迁出的旧厂商");
  const disk = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
  assert.equal(disk.active, "antigravity", "迁移应落盘，下次启动不再指着 Claude 预置");
  assert.equal(disk.providers["anthropic-key"].apiKey, "sk-fake-test", "迁移只改 active，不得动旧厂商的密钥");
});

test("MIG-10：agy-only 下 isProviderVisible 对 group=claude 的预置一律隐藏", async () => {
  assert.equal(prov.isProviderVisible("anthropic", { group: "claude", login: true }), false,
    "Claude 账户登录预置应隐藏");
  assert.equal(prov.isProviderVisible("anthropic-key", { group: "claude", apiKey: "sk-fake-test" }), false,
    "存过 key 的 anthropic-key 也应隐藏（以前有 key 就放行是本项的 bug）");
  assert.equal(prov.isProviderVisible("antigravity", { group: "antigravity", login: true }), true);
  assert.equal(prov.isProviderVisible("deepseek", { group: "third", apiKey: "sk-x" }), true,
    "有 key 的第三方厂商仍可见");
  assert.equal(prov.isProviderVisible("deepseek", { group: "third" }), false, "无 key 的第三方仍隐藏（旧行为不变）");
});

test("MIG-10：/api/providers 不列 Claude 预置，并带 migratedFrom 供界面提示", async () => {
  const { srv, call } = await serve(prov.routeProviders);
  try {
    const r = await call("/api/providers");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = (r.body.providers || []).map((p) => p.id);
    assert.ok(!ids.includes("anthropic") && !ids.includes("anthropic-key"),
      "列表里不得再有 Claude 预置：" + ids.join(","));
    assert.equal(r.body.migratedFrom, "anthropic-key", "回执应带 migratedFrom，界面据此提示用户");
  } finally { srv.close(); }
});

test("MIG-10：设置接口拒绝切到 Claude 预置；applyProvider 把 SETTINGS.provider 指着的 Claude 也迁回", async () => {
  const { routeSettings } = await import("../gw/settings.mjs");
  const { srv, call } = await serve(routeSettings);
  try {
    const r1 = await call("/api/settings", { provider: "anthropic" });
    assert.equal(r1.status, 400, "切到 anthropic 应被拒绝：" + JSON.stringify(r1.body));
    assert.ok(String(r1.body.message || "").includes("纯 Antigravity"), "拒绝文案应说明是纯 Antigravity 模式：" + JSON.stringify(r1.body));
    const r2 = await call("/api/settings", { provider: "anthropic-key" });
    assert.equal(r2.status, 400, "切到 anthropic-key 也应被拒绝");
    const r3 = await call("/api/settings", { provider: "deepseek" });
    assert.equal(r3.status, 200, "切到第三方厂商不应被这项拦住：" + JSON.stringify(r3.body));
  } finally { srv.close(); }
  // SETTINGS.provider 被上面切到 deepseek；改指 anthropic 再 applyProvider，应迁回 antigravity 并落盘
  SETTINGS.provider = "anthropic";
  prov.applyProvider();
  assert.equal(prov.PROVIDER.id, "antigravity", "applyProvider 应把 Claude 预置迁回 antigravity");
  assert.equal(prov.PROVIDER_MIGRATED_FROM, "anthropic");
  assert.equal(SETTINGS.provider, null, "SETTINGS.provider 里的 Claude 选择应被清掉");
  const disk = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  assert.ok(!disk.provider || disk.provider !== "anthropic", "迁移应落盘到设置文件");
  SETTINGS.provider = null;
  prov.applyProvider();
});
