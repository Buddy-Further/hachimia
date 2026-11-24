// 六项检查机制全链路回归测试（hachimia）：
// ① upd_status 纯只读 + checkedOnce + updOnOpen（含 checking 续挂轮询、!checkedOnce 突破 20s lastCheck、resumed 对齐）
// ② acctMenu 更新角标（改走 readUpdateStatus，淘汰旧 loadUpd()）与 !checkedOnce 后台静默补查
// ③ notices.mjs 直读 CCAPP_APP_VERSION + WhatsNew 关闭衔接 loadNotices
// ④ 仓库内 claude-code/verified.json(.sig) 公钥验签门禁
// ⑤ resumePageReads("ext") 调用 loadComponents(60) + 08-extensions.js 2s 补拉竞态守卫
// ⑥ Updater.loop() 冷启动 +20s 静默首查与自适应定时
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import vm from "node:vm";

delete process.env.CCAPP_PREFIX;
await import("../gw/config.mjs");
const { NEXT } = await import("../gw/http.mjs");
const { PUBKEY } = await import("../gw/notices.mjs");
const { routeDevside } = await import("../gw/devside.mjs");

const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("链路④：仓库内 claude-code/verified.json 与 .sig 必须通过 notices.mjs 正式公钥验签", () => {
  const body = fs.readFileSync(path.join(REPO_ROOT, "claude-code", "verified.json"));
  const sig = fs.readFileSync(path.join(REPO_ROOT, "claude-code", "verified.json.sig"), "utf8").trim();
  assert.equal(crypto.verify(null, body, PUBKEY, Buffer.from(sig, "base64")), true, "verified.json.sig 公钥验签必须通过");
  const doc = JSON.parse(body.toString("utf8"));
  assert.equal(typeof doc.versions, "object");
});

test("链路①：开发端 /api/app/upd_status 纯只读不隐式触发检查，且返回 checkedOnce=false 与 agy 项", async () => {
  const origFetch = globalThis.fetch;
  let remoteHits = 0;
  globalThis.fetch = async (u, opts) => {
    const s = String(u);
    if (!s.startsWith("http://127.0.0.1:")) remoteHits++;
    return origFetch(u, opts);
  };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if ((await routeDevside(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    const port = srv.address().port;
    const r = await origFetch(`http://127.0.0.1:${port}/api/app/upd_status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.checkedOnce, false, "冷启动未检查过时 checkedOnce 应为 false");
    assert.equal(body.lastAutoCheck, 0, "upd_status 应透出 lastAutoCheck");
    assert.equal(body.checking, false, "upd_status 不得隐式触发 devUpdCheck");
    assert.equal(body.items?.[0]?.id, "agy");
    assert.equal(remoteHits, 0, "upd_status 不得发起远端网络检查");
  } finally {
    srv.close();
    globalThis.fetch = origFetch;
  }
});

test("链路①：updOnOpen() 处理 checking 补挂轮询、!checkedOnce 突破 10 分钟节流、旧壳兼容与节流", async () => {
  const src = readRepo("gateway/web/app/10-settings-device.js");
  const start = src.indexOf("  async function updOnOpen()");
  const end = src.indexOf('\n  $("upd-check")', start);
  assert.ok(start >= 0 && end > start, "应能定位 updOnOpen()");
  const fnCode = `(${src.slice(start, end).trim()})`;

  async function runCase(st, { followUntil = 0 } = {}) {
    let followCalls = 0, postCalls = 0, laterCalls = [], updRev = 0;
    const ctx = {
      setVisit: 7,
      updFollowUntil: followUntil,
      updRev,
      Date,
      loadUpd: async () => st,
      setVisible: () => true,
      followUpd: () => { followCalls++; ctx.updFollowUntil = Date.now() + 15000; },
      updLater: (ms, v) => laterCalls.push([ms, v]),
      post: async (u) => { if (u === "/api/app/upd_check") postCalls++; return { ok: true }; },
    };
    const fn = vm.runInNewContext(fnCode, ctx);
    await fn();
    return { followCalls, postCalls, laterCalls, updRev: ctx.updRev };
  }

  const c1 = await runCase({ ok: true, checking: true, checkedOnce: false, lastCheck: 0, items: [{ state: "unknown" }] });
  assert.equal(c1.followCalls, 1);
  assert.equal(c1.postCalls, 0);
  assert.deepEqual(c1.laterCalls, [[1000, 7]]);

  const c2 = await runCase({ ok: true, checking: false, checkedOnce: true, lastCheck: Date.now(), items: [{ state: "verifying" }] });
  assert.equal(c2.followCalls, 1);
  assert.equal(c2.postCalls, 0);
  assert.deepEqual(c2.laterCalls, [[1000, 7]]);

  const c3 = await runCase({ ok: true, checking: false, checkedOnce: false, lastCheck: Date.now() - 5000, items: [{ state: "unknown" }] });
  assert.equal(c3.followCalls, 1);
  assert.equal(c3.postCalls, 1);
  assert.deepEqual(c3.laterCalls, [[300, 7]]);

  const c4 = await runCase({ ok: true, checking: false, checkedOnce: true, lastCheck: Date.now() - 5 * 60_000, items: [{ state: "uptodate" }] });
  assert.equal(c4.postCalls, 0);
  assert.equal(c4.followCalls, 0);

  const c5 = await runCase({ ok: true, checking: false, lastCheck: Date.now() - 5 * 60_000, items: [{ state: "uptodate" }] });
  assert.equal(c5.postCalls, 0);
  const c6 = await runCase({ ok: true, checking: false, lastCheck: Date.now() - 11 * 60_000, items: [{ state: "uptodate" }] });
  assert.equal(c6.postCalls, 1);
});

test("链路①②③⑤⑥：关键接线与 Java/前端源码契约核验", () => {
  const updater = readRepo("android/java/ha/chi/mia/Updater.java");
  assert.match(updater, /private volatile boolean checkedOnce;/);
  assert.doesNotMatch(updater, /if \(!checking && "unknown"\.equals\(app\.state\) && "unknown"\.equals\(claude\.state\)\) checkAsync\(true\);/);
  assert.match(updater, /\.put\("lastAutoCheck",\s*prefs\(\)\.getLong\("lastAutoCheck",\s*0\)\)/);
  assert.match(updater, /\.put\("checkedOnce", checkedOnce\)/);
  assert.match(updater, /finally\s*\{\s*checkedOnce = true;\s*\}/);
  assert.match(updater, /if \(!manual\) ed\.putLong\("lastAutoCheck", now\);/);
  assert.match(updater, /long autoAge = System\.currentTimeMillis\(\) - prefs\(\)\.getLong\("lastAutoCheck", 0\);/);
  assert.match(updater, /else if \(loopOn && env\.devkitReady\(\) && !checkedOnce\) checkAsync\(true\);/);
  assert.match(updater, /Math\.max\(60_000L,\s*Math\.min\(30 \* 60_000L,\s*AUTO_EVERY - autoAge\)\)/);

  const devside = readRepo("gateway/gw/devside.mjs");
  assert.match(devside, /lastAutoCheck:\s*0/);
  assert.match(devside, /if \(!manual\) devUpd\.lastAutoCheck = devUpd\.lastCheck;/);

  const envJava = readRepo("android/java/ha/chi/mia/Env.java");
  assert.match(envJava, /e\.put\("CCAPP_APP_VERSION",\s*appVersion\)/);

  const notices = readRepo("gateway/gw/notices.mjs");
  assert.match(notices, /process\.env\.CCAPP_APP_VERSION/);

  const ext = readRepo("gateway/web/app/08-extensions.js");
  assert.match(ext, /compTimer = setTimeout\(\(\) => \{ if \(request === compLoad && pageOn\("ext"\)\) loadComponents\(\); \}, 2000\);/);
  assert.doesNotMatch(ext, /setTimeout\(loadComponents,\s*2000\)/);

  const pages = readRepo("gateway/web/app/15-pages.js");
  assert.match(pages, /case "update":\s*updOnOpen\(\)\.then/);
  assert.doesNotMatch(pages, /resumed \? loadUpd\(\) : updOnOpen\(\)/);

  const nav = readRepo("gateway/web/app/13-nav-menus.js");
  const acctStart = nav.indexOf("function acctMenu()");
  const acctEnd = nav.indexOf("\n  // ══ 项目与定时任务", acctStart);
  const acctSrc = nav.slice(acctStart, acctEnd);
  assert.doesNotMatch(acctSrc, /\bloadUpd\(\)/, "acctMenu 不得再直接调用 loadUpd()");
  assert.match(acctSrc, /readUpdateStatus\(\)\.then\(paintUpdBadge\)/);
  assert.doesNotMatch(acctSrc, /\/api\/app\/upd_check/, "acctMenu 应保持纯只读，不得触发 upd_check");
  assert.doesNotMatch(nav, /acctUpdKickAt/);

  const proj = readRepo("gateway/web/app/14-projects-sched.js");
  assert.match(proj, /if \(name === "ext"\) \{ loadModules\(\); loadComponents\(60\); \}/);

  const boot = readRepo("gateway/web/app/19-boot.js");
  assert.match(boot, /OV\.open\(el,\s*\{\s*kind: "modal", keep: true, cover: true,\s*onClose: \(\) => \{ if \(noticeHold\) \{ noticeHold = false; setTimeout\(loadNotices, 400\); \} \},\s*\}\);/);
});
