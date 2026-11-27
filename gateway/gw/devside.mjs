import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { CFG, HERE, PATHS, PREFIX, log, tz } from "./config.mjs";
import { verifiedInfo } from "./ccverified.mjs";
import { ledger } from "./claude.mjs";
import { onSealUnknown } from "./claudeseal.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { SETTINGS, saveSettings } from "./settings-store.mjs";
import { writeAtomic } from "./statefile.mjs";
import { termEnv } from "./terminal.mjs";
import { ccMem, privCall } from "./usage.mjs";

// ── 开发端（非 hachimia 布局）：没有 Java 那一层，更新和 Shizuku 状态由网关自己做 ──────────
// hachimia 里这些在 App 进程（Updater / ShizukuSetup）；开发端只有一个 agy 二进制，priv 走 rish。
// 更新项就是设置页里标的 Antigravity CLI (agy)：查官方 agy 版本清单、装官方 install.sh，
// 绝不能从旧的 Claude Code 下载站拉程序（D-03：以前这里装的和标的不是同一种程序）。

const DEV_UPD_FILE = path.join(CFG.home, "ccapp-update.json");
// 官方 agy 安装脚本（android/assets/scripts/install-agy.mjs）：拉官方 install.sh，装进
// ~/.local/share/hachimia/agy/<版本>/ 并更新 current 软链，正好是 PATHS.agy 指的地方
const INSTALL_AGY_SCRIPT = path.join(HERE, "..", "android", "assets", "scripts", "install-agy.mjs");
const devUpd = {
  auto: true, channel: "stable", lastCheck: 0, lastAutoCheck: 0, checking: false, checkedOnce: false, error: "",
  agy: { id: "agy", name: "Antigravity CLI (agy)", current: "", latest: "", state: "unknown", message: "", done: 0, total: 0 },
};
try {
  Object.assign(devUpd, JSON.parse(fs.readFileSync(DEV_UPD_FILE, "utf8")), { checking: false, checkedOnce: false, error: "" });
  // 旧版持久化是 { claude: {...} }：id/name 换成 agy，版本号下次检查时按 agy 重读
  if (!devUpd.agy && devUpd.claude) { devUpd.agy = { ...devUpd.claude, id: "agy", name: "Antigravity CLI (agy)" }; delete devUpd.claude; }
  devUpd.agy.state = devUpd.agy.state === "installing" ? "unknown" : devUpd.agy.state;
} catch {}
const devUpdSave = () => {
  try {
    const { checkedOnce: _co, ...disk } = devUpd;
    return writeAtomic(DEV_UPD_FILE, JSON.stringify(disk), { mode: 0o600 });
  } catch { return false; }
};
const cmpVer = (a, b) => {
  const x = String(a).split(/[^0-9]+/).map(Number), y = String(b).split(/[^0-9]+/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
};

/** 已装 agy 的版本：直接跑 agy --version（禁掉内置自更新）；二进制不在时返回空串，绝不凭悬空软链谎报已装 */
function agyVersionOf() {
  return new Promise((ok) => {
    const bin = PATHS.agy;
    if (!bin || !fs.existsSync(bin)) return ok("");
    execFile(bin, ["--version"], {
      timeout: 15000,
      env: {
        ...process.env,
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || "unix:path=/nonexistent",
      },
    }, (e, out, err) => {
      const m = String(out || err || "").match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.+-]+)?)\b/);
      if (m) return ok(m[1]);
      try { ok(path.basename(fs.realpathSync(path.join(path.dirname(bin), "..", "current")))); }
      catch { ok(""); }
    });
  });
}

// 检查途中换了渠道：这次的结果是旧渠道的，不能记到新渠道名下；结束后按新渠道再查一次（#136）
let devUpdAgain = false;
let devUpdAgainAuto = false;
async function devUpdCheck(manual = true) {
  if (devUpd.checking) { devUpdAgain = true; if (!manual) devUpdAgainAuto = true; return; }
  devUpd.checking = true; devUpd.error = "";
  const c = devUpd.agy, ch = devUpd.channel;
  try {
    if (!c.current || c.state !== "installing") c.current = await agyVersionOf();
    // agy 官方清单只有一个最新版（stable / latest 渠道在这里是同一份清单，见 claudeVersions）
    const vs = await claudeVersions();
    if (devUpd.channel !== ch) { devUpdAgain = true; return; }
    if (!vs.ok || !vs.latest) throw new Error(vs.message || tz("取不到 Antigravity CLI 版本列表"));
    const v = vs.latest;
    c.latest = v; c.latestCh = ch;
    if (c.state !== "installing") {
      const d = cmpVer(v, c.current);
      c.state = d === 0 ? "uptodate" : "available";
      c.message = devUpd.channel === "latest" ? "latest 渠道" : "";
    }
    devUpd.lastCheck = Date.now();
    if (!manual) devUpd.lastAutoCheck = devUpd.lastCheck;
  } catch (e) { devUpd.error = e.message; }
  finally {
    devUpd.checking = false;
    if (!devUpdAgain) devUpd.checkedOnce = true;
    devUpdSave();
    if (devUpdAgain) {
      const nextManual = !devUpdAgainAuto;
      devUpdAgain = false; devUpdAgainAuto = false;
      setImmediate(() => devUpdCheck(nextManual));
    }
  }
}

/**
 * 换新版：跑仓库里的 install-agy.mjs（官方 https://antigravity.google/cli/install.sh），
 * 装进 ~/.local/share/hachimia/agy/<版本>/ 并更新 current 软链（PATHS.agy 指的地方）。
 * 装完按 agy --version 核对版本；对不上就报 error，不留一个半吊子版本。
 * version 不给就装清单里的最新版；给了（版本选单点的）就装指定版。
 */
async function devUpdInstall(version) {
  const c = devUpd.agy;
  if (c.state === "installing" || (!version && !c.latest)) return;
  if (!version && c.latestCh && c.latestCh !== devUpd.channel) return;   // 查到的是换渠道之前那个渠道的版本
  const want = version || c.latest;
  if (!/^(stable|latest|\d+\.\d+\.\d+(-[0-9A-Za-z.+-]{1,40})?)$/.test(want)) {
    c.state = "error"; c.message = tz("版本号不对：{v}", { v: String(want).slice(0, 40) }); devUpdSave(); return;
  }
  c.state = "installing"; c.message = ""; c.done = 0; c.total = 0;
  devUpdSave();
  try {
    if (!fs.existsSync(INSTALL_AGY_SCRIPT)) throw new Error(tz("找不到 agy 安装脚本（{p}）", { p: INSTALL_AGY_SCRIPT }));
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, [INSTALL_AGY_SCRIPT, want], {
        timeout: 10 * 60_000, maxBuffer: 4 << 20,
        env: { ...process.env, HOME: CFG.home, TMPDIR: process.env.TMPDIR || path.join(CFG.home, ".cache"), AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      }, (e, stdout, stderr) => {
        const tail = String((stdout || "") + "\n" + (stderr || "")).trim().split("\n").slice(-5).join("；");
        if (e) reject(new Error(tail || e.message));
        else resolve(String(stdout || ""));
      });
    });
    const v = await agyVersionOf();
    if (want !== "stable" && want !== "latest" && v !== want) {
      throw new Error(tz("新版试跑失败（--version 得到「{v}」）", { v: v || "?" }));
    }
    log(`Antigravity CLI 已更新 ${c.current} → ${v || want}`);
    if (out) log("[agy 安装] " + String(out).trim().split("\n").slice(-3).join("；"));
    c.current = v || want; c.state = "uptodate"; c.message = `已更新到 ${c.current}（下一轮对话起生效）`;
    ccVersions = { at: 0, data: null };
  } catch (e) {
    c.state = "error"; c.message = e.message;
  } finally { devUpdSave(); }
}

function devUpdStatus() {
  const { agy, ...rest } = devUpd;
  return { ok: true, ...rest, ghProxy: !!SETTINGS.ghProxy, items: [agy] };
}

// 自动：启动 1 分钟后、之后每 30 分钟看一眼，距上次自动检查超过 6 小时就查并按自动设置安装；本进程未查过则静默首查
if (!PREFIX) {
  const tick = async () => {
    if (devUpd.auto && Date.now() - (devUpd.lastAutoCheck || 0) >= 6 * 3600_000) {
      await devUpdCheck(false);
      if (devUpd.auto && devUpd.agy.state === "available") devUpdInstall();
    } else if (!devUpd.checkedOnce) {
      await devUpdCheck(true);
    }
  };
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, 30 * 60_000).unref?.();
}

// hachimia：已装的 agy 版本目录里若有 .mismatch 或需要复核，定期跑 install-agy.mjs --recheck 核对 sha256
if (PREFIX && process.env.CCAPP_BIN) {
  const dest = path.join(CFG.home, ".local", "share", "hachimia", "agy");
  const script = path.join(process.env.CCAPP_BIN, "..", "scripts", "install-agy.mjs");
  let rechecking = false;
  const recheck = () => {
    if (rechecking) return;
    let pending = false;
    try { pending = fs.readdirSync(dest).some((d) => /^\d/.test(d) && fs.existsSync(path.join(dest, d, "agy")) && (fs.existsSync(path.join(dest, d, ".mismatch")) || !fs.existsSync(path.join(dest, d, "manifest.json")))); } catch {}
    if (!pending || !fs.existsSync(script)) return;
    rechecking = true;
    execFile(path.join(PREFIX, "bin", "node"), [script, "--recheck"], { env: termEnv(), timeout: 600000 }, (e, out) => {
      rechecking = false;
      const msg = String(out || "").trim();
      if (msg) log("[agy 补核] " + msg.replace(/\n/g, "；"));
      if (e && e.code === 3) ledger("verify", false, "Antigravity CLI 与本地清单 sha256 不符", msg);
      else if (/^✓/m.test(msg)) ledger("verify", true, "Antigravity CLI 已完成 sha256 校验", msg);
    });
  };
  setTimeout(recheck, 120_000);
  setInterval(recheck, 6 * 3600_000);
  let lastAsk = 0;
  onSealUnknown(() => { if (Date.now() - lastAsk < 60_000) return; lastAsk = Date.now(); setTimeout(recheck, 1000); });
}

/** 开发端的 priv 状态：真跑一次 priv 'id -u'（rish → Shizuku），拿到 2000/0 才算就绪 */
export function devPrivStatus() {
  return new Promise((ok) => {
    execFile("priv", ["id -u"], { timeout: 8000, env: process.env }, (e, out, err) => {
      const uid = String(out || "").trim();
      if (uid === "2000" || uid === "0") return ok({ state: "ok", installed: true, running: true, granted: true, uid: +uid, wireless: false, paired: true, dev: true });
      const msg = String(err || out || (e && e.message) || "").trim();
      ok({ state: /not running|binder|没在运行|isn't running/i.test(msg) ? "not_running" : "no_permission", installed: true, running: false, granted: false,
        wireless: false, paired: true, dev: true, message: msg.slice(0, 200) });
    });
  });
}

async function devApp(op, b) {
  if (op === "upd_status") {
    if (!devUpd.agy.current) devUpd.agy.current = await agyVersionOf();
    return devUpdStatus();
  }
  if (op === "upd_check") { devUpdCheck(); await new Promise((r) => setTimeout(r, 200)); return devUpdStatus(); }
  if (op === "upd_set") {
    if (b.channel === "pinned") return { ok: false, message: tz("开发端不支持固定版本（只跟随 stable / latest）") };
    if (typeof b.auto === "boolean") {
      const prevAuto = devUpd.auto;
      if (CFG.runtime) {
        try {
          fs.mkdirSync(CFG.runtime, { recursive: true });
          const uf = path.join(CFG.runtime, ".upd-auto-off");
          if (!b.auto) {
            if (!writeAtomic(uf, "1\n", { mode: 0o600 })) throw new Error("write .upd-auto-off failed");
          } else {
            fs.rmSync(uf, { force: true });
          }
        } catch (e) {
          devUpd.auto = prevAuto;
          return { ok: false, message: e.message };
        }
      }
      devUpd.auto = b.auto;
    }
    if (typeof b.ghProxy === "boolean") {
      if (CFG.runtime) {
        try {
          fs.mkdirSync(CFG.runtime, { recursive: true });
          const gf = path.join(CFG.runtime, ".gh-proxy");
          if (b.ghProxy) {
            if (!writeAtomic(gf, "1\n", { mode: 0o600 })) throw new Error("write .gh-proxy failed");
          } else {
            fs.rmSync(gf, { force: true });
          }
        } catch (e) { return { ok: false, message: e.message }; }
      }
      SETTINGS.ghProxy = b.ghProxy;
      saveSettings();
    }
    // 换渠道 = 明说要那个渠道的版本：查完对不上就直接换（自动更新关着也换）
    if ((b.channel === "stable" || b.channel === "latest") && b.channel !== devUpd.channel) {
      const want = devUpd.channel = b.channel, c = devUpd.agy;
      // 等到按新渠道查完再换：旧渠道的检查可能还在途，它的结果不算（#136）
      (async () => {
        for (let i = 0; i < 30 && c.latestCh !== want && devUpd.channel === want; i++) {
          await devUpdCheck();
          if (c.latestCh !== want) await new Promise((r) => setTimeout(r, 1000));
        }
        if (devUpd.channel === want && c.latestCh === want && c.state === "available") devUpdInstall();
      })().catch(() => {});
    }
    devUpdSave();
    return devUpdStatus();
  }
  if (op === "upd_apply") {
    if (b.item !== "agy" && b.item !== "claude") return { ok: false, message: tz("开发端只管 Antigravity CLI (agy)（应用本体由你在本机构建安装）") };
    if (devUpd.agy.state !== "available" && devUpd.agy.state !== "error") return { ok: false, message: tz("没有可装的新版，先检查更新") };
    devUpdInstall(b.version);
    return { ok: true, message: tz("开始更新 Antigravity CLI (agy)") };
  }
  return { ok: false, message: tz("开发端不支持：{op}", { op }) };
}

// ── Antigravity CLI (agy) 版本清单：查官方 android manifest + 本机已装且校验通过的版本目录 ──
let ccVersions = { at: 0, data: null };
let ccVersionsInFlight = null;
const LOCAL_AGY_VER_CACHE = new Map();

function sha256FileSync(f) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(f, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

function isLocalAgyDirValid(dest, d) {
  const dir = path.join(dest, d);
  const bin = path.join(dir, "agy");
  const mf = path.join(dir, "manifest.json");
  if (fs.existsSync(path.join(dir, ".mismatch"))) return false;
  let bst, mst;
  try {
    bst = fs.statSync(bin);
    mst = fs.statSync(mf);
    if (!bst.isFile() || !mst.isFile()) return false;
  } catch { return false; }
  const fp = `${bst.ino}:${bst.size}:${Math.trunc(bst.mtimeMs)}:${Math.trunc(mst.mtimeMs)}`;
  const hit = LOCAL_AGY_VER_CACHE.get(dir);
  if (hit && hit.fp === fp) return hit.ok;
  let ok = false;
  try {
    const j = JSON.parse(fs.readFileSync(mf, "utf8"));
    if ((!j.version || j.version === d) && typeof j.sha256 === "string" && /^[0-9a-f]{64}$/.test(j.sha256)) {
      ok = sha256FileSync(bin) === j.sha256;
    }
  } catch { ok = false; }
  if (LOCAL_AGY_VER_CACHE.size > 64) LOCAL_AGY_VER_CACHE.clear();
  LOCAL_AGY_VER_CACHE.set(dir, { fp, ok });
  return ok;
}

const DEFAULT_AGY_MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const TRUSTED_AGY_MANIFEST_ORIGINS = new Set([
  "https://antigravity.google",
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function resolveAgyManifestBase(raw = process.env.HACHIMIA_AGY_MANIFEST_BASE, { isTest = process.env.CCAPP_TEST === "1" } = {}) {
  const s = String(raw || "").trim();
  if (!s) return DEFAULT_AGY_MANIFEST_BASE;
  let u;
  try { u = new URL(s); } catch { return DEFAULT_AGY_MANIFEST_BASE; }
  if (u.username || u.password) return DEFAULT_AGY_MANIFEST_BASE;
  if (u.protocol === "https:" && TRUSTED_AGY_MANIFEST_ORIGINS.has(u.origin)) return s.replace(/\/+$/, "");
  if (isTest && (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) {
    return s.replace(/\/+$/, "");
  }
  log(`[devside] 拒绝不受信任的 HACHIMIA_AGY_MANIFEST_BASE：${s}`);
  return DEFAULT_AGY_MANIFEST_BASE;
}

async function claudeVersions(force) {
  if (!force && ccVersions.data && Date.now() - ccVersions.at < 600e3) return ccVersions.data;
  if (ccVersionsInFlight) return ccVersionsInFlight;
  const run = (async () => {
    const manifestBase = resolveAgyManifestBase();
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const url = `${manifestBase}/android_${arch}.json`;
    let latest = "", err = "";
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (typeof j?.version === "string" && /^\d+\.\d+\.\d+/.test(j.version)) latest = j.version.trim();
    } catch (e) { err = e.message; }
    const set = new Set();
    if (latest) set.add(latest);
    const dest = path.join(CFG.home, ".local", "share", "hachimia", "agy");
    try {
      for (const d of fs.readdirSync(dest)) {
        if (/^\d+\.\d+\.\d+/.test(d) && isLocalAgyDirValid(dest, d)) set.add(d);
      }
    } catch {}
    const versions = [...set].sort((a, b) => cmpVer(b, a));
    const data = { ok: versions.length > 0, versions, stable: latest, latest, message: versions.length ? "" : tz("取不到 Antigravity CLI 版本列表：{err}", { err }) };
    if (data.ok) ccVersions = { at: Date.now(), data };
    return data;
  })().finally(() => { if (ccVersionsInFlight === run) ccVersionsInFlight = null; });
  ccVersionsInFlight = run;
  return run;
}

// /api/app/* 各操作收哪些字段（对照 Priv.java、Updater.set、Notify.set、DeviceTools.set）
const APP_FIELDS = {
  upd_apply: { item: "string", version: "string" },
  upd_set: { auto: "boolean", ghProxy: "boolean", channel: "string", version: "string", flavor: "string" },
  upd_verify: { full: "boolean" }, upd_repair: { full: "boolean" },
  share_file: { path: "string", mime: "string" },
  apk_install: { path: "string" },
  shz_pair: { code: "string" }, shz_autostart: { enable: "boolean" },
  notify_set: { done: "boolean", ask: "boolean" },
  dev_set: { on: "boolean", tool: "string", enabled: "boolean", a11y: "string", idle: "number" },
};

// ── 路由：/api/mem/status /api/mem/clear /api/priv/status /api/priv/request /api/priv/open /api/priv/audit /api/priv/keepalive /api/app/ ──
export async function routeDevside(req, res, u, p) {
  if (req.method === "GET" && p === "/api/claude/versions") {
    const [vs, vi] = await Promise.all([claudeVersions(u.searchParams.get("refresh") === "1"), verifiedInfo((u.searchParams.get("lang") || "zh").startsWith("zh") ? "zh" : "en")]);
    return sendJson(res, 200, { ...vs, ...vi });
  }
  if (req.method === "GET" && p === "/api/mem/status") return sendJson(res, 200, await ccMem(["status", "--json"]));
  if (req.method === "POST" && p === "/api/mem/clear") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await ccMem(["clear", "--json", ...(b.hard ? ["--hard"] : []), ...(b.dryRun ? ["--dry-run"] : [])]));
  }
  if (req.method === "GET" && p === "/api/priv/status") return sendJson(res, 200, await privCall({ op: "status" }));
  if (req.method === "POST" && p === "/api/priv/request") return sendJson(res, 200, await privCall({ op: "request" }));
  if (req.method === "POST" && p === "/api/priv/open") return sendJson(res, 200, await privCall({ op: "open_manager" }));
  // 特权命令记录：hachimia 的 Priv.java 每执行一条就往 home/priv-audit.jsonl 记一行。最新的在前
  if (req.method === "GET" && p === "/api/priv/audit") {
    const f = path.join(CFG.home, "priv-audit.jsonl"), items = [];
    for (const ff of [f, f + ".1"]) {
      let txt = ""; try { txt = fs.readFileSync(ff, "utf8"); } catch {}
      for (const l of txt.split("\n").reverse()) { if (items.length >= 300) break; try { if (l) items.push(JSON.parse(l)); } catch {} }
      if (items.length >= 300) break;
    }
    return sendJson(res, 200, { ok: true, supported: !!PREFIX, items });
  }
  if (req.method === "POST" && p === "/api/priv/noask") {
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    // 时长只认固定几档（应用侧同样只认这几档，别的按 24 小时），最长一周（11-08 用户定）
    const hours = [1, 4, 24, 72, 168].includes(+b.hours) ? +b.hours : 24;
    return sendJson(res, 200, await privCall({ op: "noask", enable: b.enable === true, hours }, 90000));
  }
  if (req.method === "POST" && p === "/api/priv/keepalive") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await privCall({ op: "keepalive", enable: b.enable !== false }, 60000));
  }
  // 更新（APK / 工具包 / Antigravity CLI）与 Shizuku 一键安装激活：都在应用进程里做，这里只转话
  if (p.startsWith("/api/app/")) {
    const op = p.slice(9);
    const OPS = ["upd_status", "upd_check", "upd_apply", "upd_set", "upd_verify", "upd_repair", "share_logs", "factory_reset", "share_file", "apk_install", "shz_install", "shz_activate", "shz_pair", "shz_autostart", "shz_repair", "open_app_settings", "freeze_ack", "notify_status", "notify_set", "notify_settings", "dev_status", "dev_set", "a11y_settings"];
    if (!OPS.includes(op)) return sendJson(res, 404, { ok: false, message: tz("未知操作") });
    const raw = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    // 只转各操作认的字段、认的类型：应用那头也逐项校验，这里再挡一道（11-01 独立审查低-3）
    const b = {};
    for (const [k, ty] of Object.entries(APP_FIELDS[op] || {})) {
      const v = raw && raw[k];
      if (v === undefined) continue;
      if (typeof v !== ty || (ty === "string" && v.length > 4096) || (ty === "number" && !Number.isFinite(v))) return sendJson(res, 400, { ok: false, message: tz("请求参数不对") });
      b[k] = v;
    }
    if (!PREFIX) return sendJson(res, 200, await devApp(op, b));
    // 激活 / 打开自动激活要等用户在原生对话框里点（最多 60 秒），和 keepalive 一样放长；装 APK 还要先把包拷进暂存再等确认
    const out = await privCall({ ...b, op }, op === "shz_activate" || op === "shz_autostart" ? 65000 : op === "apk_install" ? 120000 : undefined);
    if (op === "upd_set" && typeof b.ghProxy === "boolean" && (!out || out.ok !== false)) {
      SETTINGS.ghProxy = b.ghProxy;
      saveSettings();
    }
    return sendJson(res, 200, out);
  }
  return NEXT;
}

/** 把应用界面叫回前台。hachimia 由 App 进程做（Shizuku 或通知）；开发端直接 priv am start */
export function toFront(text) {
  if (PREFIX) return privCall({ op: "to_front", text }, 8000);
  const pkg = process.env.CCAPP_PKG || "ha.chi.mia";
  return new Promise((ok) => execFile("priv", [`am start --activity-reorder-to-front -n ${pkg}/.MainActivity`],
    { timeout: 8000, env: process.env }, (e) => ok(e ? { message: e.message.slice(0, 120) } : { via: "priv" })));
}
