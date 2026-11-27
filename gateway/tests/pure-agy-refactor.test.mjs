// 纯 agy 减法重构回归守卫：端侧小模型下线后的老配置平滑升级、toFront 与 /api/freeze 迁出不丢失
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

test("Stage 1 升级兜底：老配置选了 provider=local / active=local / localMode=custom 时平滑迁回默认不崩溃", () => {
  const home = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "pure-agy-s1-"));
  const fakePre = path.join(home, "pre");
  fs.mkdirSync(fakePre, { recursive: true });
  fs.writeFileSync(path.join(home, "ccapp-providers.json"), JSON.stringify({
    active: "local",
    providers: { local: { defaultModel: "qwen-4b.gguf" } },
  }));
  fs.writeFileSync(path.join(home, "ccapp-settings.json"), JSON.stringify({
    provider: "local",
    model: "qwen-4b.gguf",
    localMode: "custom",
    permissionMode: "default",
    guard: true,
    permMigrated: 1,
  }));
  const gw = new URL("../gw/", import.meta.url).href;
  const src = `
    const s = await import(${JSON.stringify(gw + "settings-store.mjs")});
    const p = await import(${JSON.stringify(gw + "providers.mjs")});
    p.applyProvider();
    console.log(JSON.stringify({
      active: p.PROVIDERS_CFG.active,
      providerId: p.PROVIDER.id,
      hasLocalPreset: "local" in p.PROVIDERS_CFG.providers,
      settingsProvider: s.SETTINGS.provider,
      settingsModel: s.SETTINGS.model,
      hasLocalMode: "localMode" in s.SETTINGS,
      migratedFrom: p.PROVIDER_MIGRATED_FROM,
    }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", src], {
    env: { ...process.env, CCAPP_HOME: home, HOME: home, CCAPP_PREFIX: fakePre, CCAPP_TEST: "1" },
    encoding: "utf8",
  });
  const j = JSON.parse(out.trim().split("\n").pop());
  assert.equal(j.hasLocalPreset, false, "PRESETS.local 已下线，不应再出现");
  assert.equal(j.active, "antigravity", "active=local 应回退到 antigravity");
  assert.equal(j.providerId, "antigravity", "生效厂商应切回 antigravity");
  assert.equal(j.settingsProvider, null, "老设置 provider=local 应清空");
  assert.equal(j.settingsModel, null, "老设置 .gguf 模型名应一并清空");
  assert.equal(j.hasLocalMode, false, "老设置 localMode 字段应清除");
  assert.equal(j.migratedFrom, "local");
  const savedProv = JSON.parse(fs.readFileSync(path.join(home, "ccapp-providers.json"), "utf8"));
  assert.equal(savedProv.active, "antigravity");
  assert.equal(savedProv.providers.local, undefined);
});

test("Stage 1 迁出保活：toFront 由 devside.mjs 导出，POST /api/freeze 由 uistore.mjs 路由接管", async () => {
  const { toFront } = await import("../gw/devside.mjs");
  assert.equal(typeof toFront, "function");
  const { routeUi } = await import("../gw/uistore.mjs");
  const req = Readable.from([Buffer.from(JSON.stringify({ why: "auto", touch: ["a\nb", "c"] }))]);
  req.method = "POST";
  let status = 0, body = "";
  const res = {
    writeHead(s) { status = s; },
    end(b) { body = String(b || ""); },
  };
  await routeUi(req, res, new URL("http://127.0.0.1/api/freeze"), "/api/freeze");
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), { ok: true });
  assert.equal(fs.existsSync(path.join(ROOT, "gateway/gw/local.mjs")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "gateway/web/skills/local-model-mode/SKILL.md")), false);
});

test("Stage 2 死脚本清理：install-claude.mjs、bin/claude 与旧版 claude-code-versions 文档已移除", () => {
  for (const rel of [
    "android/assets/scripts/install-claude.mjs",
    "android/assets/bin/claude",
    "docs/claude-code-versions.md",
    "docs/claude-code-versions.zh-CN.md",
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `${rel} 应已移除`);
  }
  const vc = fs.readFileSync(path.join(ROOT, "scripts/verify-claude.mjs"), "utf8");
  assert.doesNotMatch(vc, /install-claude\.mjs|downloads\.claude\.ai/);
});

test("Stage 3 纯 ACP 瘦身：streamfix.mjs 已删、run.mjs 无旧版 stream-json 分支、toolEnv 与纯 agy 模式生效", async () => {
  assert.equal(fs.existsSync(path.join(ROOT, "gateway/gw/streamfix.mjs")), false, "streamfix.mjs 应已移除");
  const claudeMod = await import("../gw/claude.mjs");
  const provMod = await import("../gw/providers.mjs");
  assert.equal(typeof claudeMod.toolEnv, "function");
  assert.equal(claudeMod.claudeEnv, undefined, "旧 claudeEnv 应已移除");
  assert.equal(claudeMod.settingsArgs, undefined, "旧 settingsArgs 应已移除");
  assert.equal(claudeMod.guardHooks, undefined, "旧 guardHooks 应已移除");
  assert.equal(provMod.isAgyOnlyMode(), true);
  assert.equal(provMod.usesAcp({ id: "antigravity" }), true);
  assert.equal(provMod.usesAcp(null), false);
  const env = claudeMod.toolEnv();
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.equal(env.CCAPP_TOKEN_FILE, undefined);
  const runSrc = fs.readFileSync(path.join(ROOT, "gateway/gw/run.mjs"), "utf8");
  assert.doesNotMatch(runSrc, /--output-format.*stream-json|streamfix\.mjs|bridgeSwitching/);
});

test("Stage 4 纯 agy 收口：项目/任务/会话钉选 local 自动迁回 antigravity，死路径与 UI 旧标签已清", async () => {
  const cfg = await import("../gw/config.mjs");
  assert.equal("NO_BRIDGE" in cfg, false, "NO_BRIDGE 应已移除");
  assert.equal("bridge" in cfg.PATHS, false, "PATHS.bridge 应已移除");
  assert.equal(typeof cfg.PATHS.projects, "string", "Redline 3: PATHS.projects 历史会话目录须保留");

  const { setSessModel, sessModel, migrateHiddenSessionPins } = await import("../gw/sessmodel.mjs");
  setSessModel("pure-agy-local-pin", { provider: "local", model: "qwen.gguf" });
  const moved = migrateHiddenSessionPins();
  assert.ok(moved.includes("pure-agy-local-pin"));
  assert.equal(sessModel("pure-agy-local-pin").provider, "antigravity");
  assert.equal(sessModel("pure-agy-local-pin").model, "");

  const s09 = fs.readFileSync(path.join(ROOT, "gateway/web/app/09-settings.js"), "utf8");
  assert.doesNotMatch(s09, /Claude（兼容）|Claude \(legacy\)/);
  assert.match(s09, /r\.migratedFrom/, "Redline 1: 迁移提示 toast 须保留");
  const s12 = fs.readFileSync(path.join(ROOT, "gateway/web/app/12-model-caps.js"), "utf8");
  assert.doesNotMatch(s12, /未填（按 200k 算）|c\.engine === "claude"/);
});
