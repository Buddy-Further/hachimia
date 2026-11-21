// hachimia 模型拉取回归（reg-models）：
//   R9——登录后无强制刷新 + 10 分钟清单缓存（旧缺陷）：登录前缓存的 9 条 fallback
//       在登录后继续服务（缓存指纹 sigOf 不含登录态）；登录完成时应清缓存（F-1）。
//   MIG-14——login.mjs（递归）与 models.mjs（顶层）两处凭据探测口径不一致（F-3）。
// test-first：先写出能复现的失败测试再修。INV-3 的 M2/M3 探针改写为正式回归测试。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG, PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { dropModelCache, fetchModels, noteLoggedIn, providerList } from "../gw/models.mjs";
import { authStatus, hasAgySessionFiles, routeLogin } from "../gw/login.mjs";
import { providerById } from "../gw/providers.mjs";

const FALLBACK_9 = [
  "gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen",
  "gemini-pro-orchestrator-neon", "gemini-3.8-flash", "claude-opus-5-5",
  "claude-sonnet-5-5", "gpt-oss-120b-medium",
];
const ids = (list) => list.map((m) => m.id).sort();
const FALLBACK_9_SORTED = [...FALLBACK_9].sort();

const CRED_DIRS = [
  path.join(CFG.home, ".gemini", "antigravity-cli"),
  path.join(CFG.home, ".config", "antigravity"),
  path.join(CFG.home, ".antigravity"),
];
function cleanCredDirs() {
  for (const d of CRED_DIRS) fs.rmSync(d, { recursive: true, force: true });
}

// 假 agy：按 AGY_MODELS_MODE 决定 `agy models` 的输出/退出码
//   signin：未登录文案（exit 1）——authStatus 判未登录，noteLoggedIn(false)
//   empty：空输出（exit 1）——live 拉取为空，走 9 条 fallback
//   full：完整 12 家族清单（15 行模型行 + 噪声行）——live 拉取应原样服务
function makeFakeAgy(dir) {
  const script = path.join(dir, "fake-agy-models");
  fs.writeFileSync(script, `#!/bin/sh
if [ "$1" = "models" ]; then
  case "$AGY_MODELS_MODE" in
    signin)
      printf 'please sign in to view models\\n'
      exit 1 ;;
    empty)
      exit 1 ;;
    full)
      printf 'Available models:\\n'
      printf 'WARNING: using cached credentials\\n'
      printf 'Fetching available models...\\n'
      printf 'gemini-4-neon-low\\tGemini 4 Neon (Low)\\n'
      printf 'gemini-4-neon-medium\\tGemini 4 Neon (Medium)\\n'
      printf 'gemini-4-neon-high\\tGemini 4 Neon (High)\\n'
      printf 'gemini-4-neon-xhigh\\tGemini 4 Neon (XHigh)\\n'
      printf 'gemini-4-carbon-medium\\tGemini 4 Carbon (Medium)\\n'
      printf 'gemini-4-argon-high\\tGemini 4 Argon (High)\\n'
      printf 'gemini-4-hydrogen-low\\tGemini 4 Hydrogen (Low)\\n'
      printf 'gemini-pro-orchestrator-neon\\tGemini Pro Orchestrator Neon\\n'
      printf 'gemini-3.8-flash\\tGemini 3.8 Flash\\n'
      printf 'claude-opus-5-5\\tClaude Opus 5.5\\n'
      printf 'claude-sonnet-5-5\\tClaude Sonnet 5.5\\n'
      printf 'gpt-oss-120b-medium\\tGPT OSS 120B Medium\\n'
      printf 'gemini-2.5-pro\\tGemini 2.5 Pro\\n'
      printf 'gemini-3-pro-preview\\tGemini 3 Pro Preview\\n'
      printf 'gemini-2.5-flash\\tGemini 2.5 Flash\\n'
      exit 0 ;;
  esac
fi
exit 1
`, { mode: 0o755 });
  return script;
}

const tmpRoot = fs.mkdtempSync(path.join(CFG.home, "fix-reg-models-"));
const fake = makeFakeAgy(tmpRoot);
const prevAgy = PATHS.agy;
PATHS.agy = fake;
after(() => {
  PATHS.agy = prevAgy;
  cleanCredDirs();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AGY_MODELS_MODE;
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

function reset() {
  cleanCredDirs();
  dropModelCache();
  noteLoggedIn(null);
  delete process.env.AGY_MODELS_MODE;
}

// ── F-1（R9）：登录完成时清模型缓存 ──────────────────────────────────────
test("F-1（R9）：登录态 false→true 跃变后，登录前缓存的 9 条 fallback 不得再服务", async () => {
  reset();
  const p = providerById("antigravity");
  assert.ok(p && p.login, "前置：antigravity 应是订阅登录厂商");
  // 1. 登录前：探针判未登录（LOGGED_IN=false），live 为空 → 9 条 fallback 被缓存 10 分钟
  process.env.AGY_MODELS_MODE = "signin";
  assert.equal((await authStatus(true)).loggedIn, false, "前置：mock 未登录时探针应判未登录");
  process.env.AGY_MODELS_MODE = "empty";
  assert.deepEqual(ids(await fetchModels(true, p)), FALLBACK_9_SORTED, "前置：live 为空时应回落并缓存 9 条 fallback");
  // 2. 换成完整清单的 mock agy，但还没发生登录事件：无 refresh 仍命中旧缓存（机制对照）
  process.env.AGY_MODELS_MODE = "full";
  assert.deepEqual(ids(await fetchModels(false, p)), FALLBACK_9_SORTED, "未登录前，无 refresh 应仍命中登录前缓存的 fallback");
  // 3. 只模拟登录完成：轮询 /api/login/status（refresh=1 强制重探）→ 跃变 false→true
  const { srv, call } = await serve(routeLogin);
  try {
    const r = await call("/api/login/status?refresh=1");
    assert.equal(r.body.loggedIn, true, "轮询应探到已登录：" + JSON.stringify(r.body));
    // 4. 登录后无 refresh 也应走 live：12 家族，且含 CLI 独有模型
    const after = await fetchModels(false, p);
    assert.equal(after.length, 12, "登录后无 refresh 应返回 live 的 12 家族，而不是缓存的 9 条 fallback：" + JSON.stringify(ids(after)));
    for (const cliOnly of ["gemini-2.5-pro", "gemini-3-pro-preview", "gemini-2.5-flash"]) {
      assert.ok(after.some((m) => m.id === cliOnly), "live 清单应含 CLI 独有模型 " + cliOnly);
    }
  } finally { srv.close(); }
});

test("F-1 对照：缓存本身仍按 10 分钟工作——未登录时 refresh=1 与 dropModelCache() 才能拿到 live", async () => {
  reset();
  const p = providerById("antigravity");
  process.env.AGY_MODELS_MODE = "empty";
  assert.deepEqual(ids(await fetchModels(true, p)), FALLBACK_9_SORTED, "前置：live 为空时应回落并缓存 9 条 fallback");
  process.env.AGY_MODELS_MODE = "full";
  // 没发生登录事件：无 refresh 仍命中旧缓存（修的应是登录跃变，不是把缓存关掉）
  assert.deepEqual(ids(await fetchModels(false, p)), FALLBACK_9_SORTED, "无登录事件时，无 refresh 不得绕过缓存");
  // refresh=1：绕过缓存，live 12 条
  assert.equal((await fetchModels(true, p)).length, 12, "refresh=1 应绕过缓存拿到 live 清单");
  // dropModelCache() 后无 refresh 也走 live
  dropModelCache();
  assert.equal((await fetchModels(false, p)).length, 12, "dropModelCache() 后无 refresh 应拿到 live 清单");
});

test("F-1：登录态不变时轮询 /api/login/status 不清缓存（10 分钟缓存仍有效）", async () => {
  reset();
  const p = providerById("antigravity");
  process.env.AGY_MODELS_MODE = "signin";
  assert.equal((await authStatus(true)).loggedIn, false, "前置：mock 未登录时探针应判未登录");
  process.env.AGY_MODELS_MODE = "empty";
  assert.deepEqual(ids(await fetchModels(true, p)), FALLBACK_9_SORTED, "前置：live 为空时应回落并缓存 9 条 fallback");
  process.env.AGY_MODELS_MODE = "full";
  const { srv, call } = await serve(routeLogin);
  try {
    const r1 = await call("/api/login/status?refresh=1");
    assert.equal(r1.body.loggedIn, true, "跃变轮询应探到已登录");
    assert.equal((await fetchModels(false, p)).length, 12, "跃变后首次拉取应是 live 的 12 条");
    // live 清单已缓存；再把 mock 切回空输出、轮询一次（不带 refresh，走 30 秒 AUTH_CACHE）
    process.env.AGY_MODELS_MODE = "empty";
    const r2 = await call("/api/login/status");
    assert.equal(r2.body.loggedIn, true, "缓存的探测结果仍应是已登录：" + JSON.stringify(r2.body));
    // 若轮询误清了缓存，这次会重拉 live（mock 已空）→ 回落 9 条；不清则仍是缓存的 12 条
    assert.equal((await fetchModels(false, p)).length, 12, "登录态不变的轮询不得清缓存");
  } finally { srv.close(); }
});

test("F-1：logout 成功后模型缓存被清掉，旧账户的 live 清单不得再服务", async () => {
  reset();
  const p = providerById("antigravity");
  process.env.AGY_MODELS_MODE = "full";
  assert.equal((await authStatus(true)).loggedIn, true, "前置：mock 有完整清单时探针应判已登录");
  assert.equal((await fetchModels(true, p)).length, 12, "前置：登录态下应拉到 live 的 12 条并缓存");
  // 退出：mock 切回未登录
  process.env.AGY_MODELS_MODE = "signin";
  const { srv, call } = await serve(routeLogin);
  try {
    const r = await call("/api/login/logout", {});
    assert.equal(r.body.ok, true, "logout 应成功：" + JSON.stringify(r.body));
    // 若 logout 没清缓存，这里仍会返回缓存的 12 条；清掉了则重拉（mock 已空）→ 9 条 fallback
    assert.deepEqual(ids(await fetchModels(false, p)), FALLBACK_9_SORTED, "logout 后不得再服务旧账户缓存的 live 清单");
  } finally { srv.close(); }
});

// ── F-3（MIG-14）：两处凭据探测同口径 ───────────────────────────────────
test("F-3（MIG-14）：凭据只在子目录时，登录探测与选单 usable 应一致为已登录", () => {
  reset();
  const nested = path.join(CFG.home, ".gemini", "antigravity-cli", "accounts", "default", "token.json");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, JSON.stringify({ token: "fix-reg-models-fake" }));
  try {
    assert.equal(hasAgySessionFiles(), true, "login.mjs（递归）应认出子目录凭据");
    const p = providerList().find((x) => x.id === "antigravity");
    assert.ok(p, "选单里应有 antigravity");
    assert.equal(p.usable, true, "models.mjs 的探测应与 login.mjs 同口径，也认子目录凭据");
  } finally { cleanCredDirs(); }
});
