// A2 / A3 / A13：authStatus 登录态判定。
// 注意顺序：authStatus 的 AUTH_GOOD 会记住上一次问出的已登录态，
// 所以“应判未登录”的用例必须排在任何“应判已登录”的用例之前。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { authStatus } from "../gw/login.mjs";

const CRED_DIRS = [
  path.join(CFG.home, ".gemini", "antigravity-cli"),
  path.join(CFG.home, ".config", "antigravity"),
  path.join(CFG.home, ".antigravity"),
];
function cleanCredDirs() {
  for (const d of CRED_DIRS) fs.rmSync(d, { recursive: true, force: true });
}

// 假 agy：按 AGY_MODELS_MODE 决定 `models` 的输出/退出码
function makeFakeAgy(dir) {
  const script = path.join(dir, "fake-agy-models");
  fs.writeFileSync(script, `#!/bin/sh
if [ "$1" = "models" ]; then
  case "$AGY_MODELS_MODE" in
    help)
      printf 'Usage: agy models [options]\\nSee https://antigravity.google/docs for help\\nContact support@example.com\\n'
      exit 0 ;;
    list)
      printf 'gemini-3.8-flash\\tGemini 3.8 Flash\\ngemini-4-neon-high\\tGemini 4 Neon (High)\\n'
      exit 0 ;;
    keylist)
      if [ -n "$GEMINI_API_KEY" ]; then printf 'gemini-3.8-flash\\tGemini 3.8 Flash\\n'; exit 0;
      else printf 'please sign in to view models\\n'; exit 1; fi ;;
    fail)
      exit 1 ;;
  esac
fi
exit 1
`, { mode: 0o755 });
  return script;
}

const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-a-authstatus-"));
const fake = makeFakeAgy(tmp);
const prevAgy = PATHS.agy;
PATHS.agy = fake;
after(() => { PATHS.agy = prevAgy; cleanCredDirs(); });

test("A2：`agy models` 只印帮助文本（exit 0）时不得判已登录、不得认领 support@example.com", async () => {
  cleanCredDirs();
  process.env.AGY_MODELS_MODE = "help";
  try {
    const v = await authStatus(true);
    assert.equal(v.loggedIn, false, JSON.stringify(v));
    assert.equal(v.email, null, JSON.stringify(v));
  } finally { delete process.env.AGY_MODELS_MODE; }
});

test("A3：0 字节空 session.json 不得算已登录", async () => {
  cleanCredDirs();
  const d = CRED_DIRS[2];
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "session.json"), "");
  process.env.AGY_MODELS_MODE = "fail";
  try {
    const v = await authStatus(true);
    assert.equal(v.loggedIn, false, JSON.stringify(v));
  } finally { delete process.env.AGY_MODELS_MODE; cleanCredDirs(); }
});

test("A3：名为 oauth/session 的空目录不得算已登录（只认文件）", async () => {
  cleanCredDirs();
  fs.mkdirSync(path.join(CRED_DIRS[0], "oauth"), { recursive: true });
  process.env.AGY_MODELS_MODE = "fail";
  try {
    const v = await authStatus(true);
    assert.equal(v.loggedIn, false, JSON.stringify(v));
  } finally { delete process.env.AGY_MODELS_MODE; cleanCredDirs(); }
});

test("A3：内容为 {} 的 session.json 不得算已登录", async () => {
  cleanCredDirs();
  const d = CRED_DIRS[2];
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "session.json"), "{}");
  process.env.AGY_MODELS_MODE = "fail";
  try {
    const v = await authStatus(true);
    assert.equal(v.loggedIn, false, JSON.stringify(v));
  } finally { delete process.env.AGY_MODELS_MODE; cleanCredDirs(); }
});

test("A3 对照：有内容的合法 session.json 在探测失败时仍可回落判已登录", async () => {
  cleanCredDirs();
  const d = CRED_DIRS[2];
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "session.json"), JSON.stringify({ access_token: "x" }));
  process.env.AGY_MODELS_MODE = "fail";
  try {
    const v = await authStatus(true);
    assert.equal(v.loggedIn, true, JSON.stringify(v));
  } finally { delete process.env.AGY_MODELS_MODE; cleanCredDirs(); }
});

test("A2 对照：`agy models` 列出真模型清单时判已登录、邮箱不瞎认", async () => {
  cleanCredDirs();
  process.env.AGY_MODELS_MODE = "list";
  try {
    const v = await authStatus(true);
    assert.equal(v.loggedIn, true, JSON.stringify(v));
    assert.equal(v.email, null, JSON.stringify(v));
  } finally { delete process.env.AGY_MODELS_MODE; }
});

test("A13：API Key 模式用户带 key 探 `agy models` 能列模型时应判已登录（authMethod=gemini-api-key）", async (t) => {
  cleanCredDirs();
  const { upsertProvider, applyProvider, keyOf, providerById } = await import("../gw/providers.mjs");
  const { SETTINGS } = await import("../gw/settings-store.mjs");
  const r = upsertProvider(null, {
    label: "fix-a13", baseUrl: "https://generativelanguage.googleapis.com",
    authStyle: "gemini-api-key", defaultModel: "gemini-3.8-flash", apiKey: "test-key-123",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const was = SETTINGS.provider;
  SETTINGS.provider = r.id;
  applyProvider();
  t.after(() => { SETTINGS.provider = was; applyProvider(); cleanCredDirs(); });
  assert.equal(keyOf(providerById(r.id)), "test-key-123", "测试前置：生效厂商应带 key");
  process.env.AGY_MODELS_MODE = "keylist";
  try {
    const v = await authStatus(true);
    assert.equal(v.loggedIn, true, JSON.stringify(v));
    assert.equal(v.authMethod, "gemini-api-key", JSON.stringify(v));
  } finally { delete process.env.AGY_MODELS_MODE; }
});
