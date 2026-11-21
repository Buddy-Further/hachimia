// 启动性能回归测试（startup-perf-swr）：
//   1. execAgyModelsShared 单飞合并：并发调 `agy models` 只拉起 1 个子进程
//   2. models.mjs 冷启动 SWR 落盘缓存：有本地凭据与落盘清单时毫秒级返回，不阻塞在慢速 agy 上；
//      dropModelCache() 与 force=true 仍按契约清缓存 / 强刷
//   3. login.mjs 冷启动 SWR：有本地凭据时非强刷秒回，不堵住前端连接池；force=true 仍走实探
//   4. 前端与 server.mjs 关键路径守卫：setOpen 守卫、fetchLoginStatus 单飞、loadSettings 不阻塞在 loadModels、错峰巡检
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { dropModelCache, execAgyModelsShared, fetchModels } from "../gw/models.mjs";
import { authStatus } from "../gw/login.mjs";
import { providerById } from "../gw/providers.mjs";

const CRED_DIR = path.join(CFG.home, ".gemini", "antigravity-cli");
const CRED_FILE = path.join(CRED_DIR, "session.json");
const tmpRoot = fs.mkdtempSync(path.join(CFG.home, "startup-perf-swr-"));
const countFile = path.join(tmpRoot, "count.txt");
const fakeAgy = path.join(tmpRoot, "fake-agy");

fs.writeFileSync(fakeAgy, `#!/bin/sh
printf '1\\n' >> "${countFile}"
sleep 0.35
printf 'gemini-4-neon-high\\tGemini 4 Neon (High)\\n'
printf 'gemini-3.8-flash\\tGemini 3.8 Flash\\n'
exit 0
`, { mode: 0o755 });

const prevAgy = PATHS.agy;
PATHS.agy = fakeAgy;

function resetCount() {
  try { fs.unlinkSync(countFile); } catch {}
}
function callCount() {
  try { return fs.readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean).length; }
  catch { return 0; }
}
function ensureCred() {
  fs.mkdirSync(CRED_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify({ access_token: "test-tok" }));
}
function cleanCred() {
  fs.rmSync(CRED_DIR, { recursive: true, force: true });
}

after(() => {
  PATHS.agy = prevAgy;
  dropModelCache();
  cleanCred();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("1. execAgyModelsShared 并发单飞：同时 3 次调用只起 1 个 agy 子进程", async () => {
  resetCount();
  const [a, b, c] = await Promise.all([
    execAgyModelsShared(fakeAgy),
    execAgyModelsShared(fakeAgy),
    execAgyModelsShared(fakeAgy),
  ]);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(c.status, 0);
  assert.equal(callCount(), 1, "并发调用应合并为 1 个 agy 子进程，实测=" + callCount());
});

test("2. models.mjs 冷启动 SWR 落盘缓存：内存清空后毫秒级返回，dropModelCache 后重新实拉", async () => {
  dropModelCache();
  ensureCred();
  resetCount();
  const p = providerById("antigravity");
  // 先强刷一次，把清单写进磁盘缓存
  const live = await fetchModels(true, p);
  assert.equal(live.length, 2);
  assert.equal(callCount(), 1);

  // 模拟网关进程刚重启（内存未过期字段失效，仅留磁盘缓存）：expireModelCache 清掉内存 TTL 后再 fetchModels(false)
  const { expireModelCache } = await import("../gw/models.mjs");
  expireModelCache();
  resetCount();
  const t0 = Date.now();
  const fast = await fetchModels(false, p);
  const dt = Date.now() - t0;
  assert.equal(fast.length, 2, "SWR 应返回落盘的 2 个模型");
  assert.ok(dt < 200, `SWR 命中落盘缓存应 <200ms 返回（不等待 350ms 的 agy 子进程），实测=${dt}ms`);
  assert.equal(callCount(), 0, "SWR 秒回时不得同步等待子进程");

  // dropModelCache 应同时清掉磁盘缓存，后续 fetchModels(false) 走实拉
  dropModelCache();
  resetCount();
  const afterDrop = await fetchModels(false, p);
  assert.equal(afterDrop.length, 2);
  assert.equal(callCount(), 1, "dropModelCache 后应清掉磁盘缓存并重新实拉");
});

test("3. login.mjs 冷启动 SWR：存在本地凭据且非强刷时毫秒级返回；强刷仍走实探", async () => {
  ensureCred();
  resetCount();
  // 先跑一次 force=true 写盘
  const vLive = await authStatus(true);
  assert.equal(vLive.loggedIn, true);
  assert.equal(callCount(), 1);
  // 非强刷命中内存缓存应极快
  resetCount();
  const t0 = Date.now();
  const vFast = await authStatus(false);
  const dt = Date.now() - t0;
  assert.equal(vFast.loggedIn, true);
  assert.ok(dt < 100, `非强刷应毫秒级返回，实测=${dt}ms`);
  assert.equal(callCount(), 0);
});

test("4. 前端与 server.mjs 首屏防阻塞静态守卫", () => {
  const s01 = fs.readFileSync(new URL("../web/app/01-core.js", import.meta.url), "utf8");
  const s09 = fs.readFileSync(new URL("../web/app/09-settings.js", import.meta.url), "utf8");
  const s12 = fs.readFileSync(new URL("../web/app/12-model-caps.js", import.meta.url), "utf8");
  const s19 = fs.readFileSync(new URL("../web/app/19-boot.js", import.meta.url), "utf8");
  const srv = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

  assert.match(s01, /API_INFLIGHT/, "01-core.js 应对首屏高并发只读接口做前端单飞复用");
  assert.match(s09, /if \(setOpen\) renderProvCard\(\);/, "09-settings.js 未打开设置时不得拉接口卡");
  const loadSettingsBody = s12.slice(s12.indexOf("async function loadSettings()"), s12.indexOf("// 附加目录的增删串行化"));
  assert.ok(loadSettingsBody.length > 50, "应找到 loadSettings 函数体");
  assert.doesNotMatch(loadSettingsBody, /await loadModels\(\)/, "12-model-caps.js loadSettings 不得 await 阻塞在 loadModels");
  assert.doesNotMatch(s19, /loadProviders\(\);\s*loadPriv\(\)/, "19-boot.js 后台预拉不得重复拉 loadProviders");
  assert.doesNotMatch(srv, /\}, 150\)\.unref\(\)/, "server.mjs 启动巡检不得在 150ms 一把梭撞上首屏");
});
