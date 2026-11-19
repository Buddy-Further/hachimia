import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CFG, PATHS, log, tz } from "./config.mjs";
import { isLoginMode, noteLoggedIn } from "./models.mjs";
import { agyEnv, claudeBlocked, killTree } from "./claude.mjs";
import { RUNS } from "./runs.mjs";
import { providerById } from "./providers.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { toFront } from "./local.mjs";
import { RATE_LIMITS, clearRateLimits } from "./stream.mjs";

// ── Google Antigravity 账户登录（OAuth 全程由官方 agy CLI 完成；网关只转递授权地址，不碰凭据）──
//
// 两条路，同一个进程：
//   自动：设了 BROWSER 捕获脚本，agy acp --login 把 Google OAuth 链接交给它，
//         由界面调起系统浏览器完成登录，回调回到 localhost 后 agy 自动落盘凭据。
//   手动：浏览器无法回跳 localhost 时，界面可打开终端运行 `SSH_CONNECTION=1 agy`（Remote SSH OAuth），
//         用户直接把授权码贴给 agy 自己的终端提示，网关不经手凭据。
let LOGIN = null;
const LOGIN_DIR = path.join(CFG.home, ".cache", "hachimia-login");
const SYS_SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";

function agyBin() {
  return PATHS.agy || PATHS.claude;
}

function authEnv(enterprise = false) {
  const env = agyEnv({ provider: { id: enterprise ? "antigravity-enterprise" : "antigravity", login: true, nativeModels: true } });
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_GEMINI_BASE_URL;
  return env;
}

async function loginStart(method = "personal") {
  const blocked = await claudeBlocked();
  if (blocked) return { ok: false, message: blocked };
  const bin = agyBin();
  if (!fs.existsSync(bin)) {
    return { ok: false, message: tz("Antigravity CLI (agy) 未安装。请先到 设置 → 更新 安装。") };
  }
  if (LOGIN && LOGIN.child.exitCode === null) try { killTree(LOGIN.child); } catch {}
  fs.mkdirSync(LOGIN_DIR, { recursive: true });
  const urlFile = path.join(LOGIN_DIR, "url");
  const browser = path.join(LOGIN_DIR, "browser.sh");
  try { fs.unlinkSync(urlFile); } catch {}
  fs.writeFileSync(browser, `#!${SYS_SH}\nprintf "%s\\n" "$1" > "${urlFile}"\n`, { mode: 0o700 });

  const enterprise = method === "enterprise" || method === "console" || method === "business";
  const env = { ...authEnv(enterprise), BROWSER: browser };
  const args = ["acp", "--login"];
  const child = spawn(bin, args, { cwd: CFG.home, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const L = LOGIN = { child, out: "", startedAt: Date.now(), done: false, ok: false, method, urlFile };

  const expire = setTimeout(() => {
    if (L.done) return;
    L.done = true; L.ok = false; L.out += "\n" + tz("登录超时（15 分钟）");
    try { killTree(child); } catch {}
    log("登录：超时");
  }, 15 * 60e3);
  expire.unref?.();

  const onData = (d) => { L.out += String(d); };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("error", (e) => {
    clearTimeout(expire);
    if (L.done) return;
    L.done = true; L.ok = false; L.out += "\n" + (e.code || e.message);
    log("登录：agy 没起来（" + (e.code || e.message) + "）");
  });
  child.on("close", (code) => {
    clearTimeout(expire);
    if (L.done) return;
    L.done = true;
    L.ok = code === 0;
    log("登录：" + (L.ok ? "成功" : "结束（退出码 " + code + "）"));
    if (L.ok) {
      AUTH_CACHE = null;
      noteLoggedIn(true);
      toFront("登录成功").then((r) => log("登录：回到前台 → " + (r.via || r.message || "?")));
    }
  });
  log("登录：已启动 agy acp --login (" + method + ")");

  return new Promise((resolve) => {
    const tick = setInterval(() => {
      let auto = "";
      try { auto = fs.readFileSync(urlFile, "utf8").trim(); } catch {}
      const manual = (L.out.match(/https:\/\/\S+/) || [""])[0];
      if ((auto || manual) || L.done || Date.now() - L.startedAt > 20000) {
        clearInterval(tick);
        if (auto || manual) return resolve({ ok: true, url: auto || manual, manualUrl: manual, auto: !!auto });
        if (!L.done) return resolve({ ok: true, pending: true, url: null, message: tz("登录还在进行，拿到授权地址后会打开") });
        if (L.ok) return resolve({ ok: true, url: null, alreadyLoggedIn: true });
        resolve({ ok: false, message: tz("没拿到登录地址"), output: L.out.slice(-1500) });
      }
    }, 200);
  });
}

/**
 * 检测本机 Antigravity CLI 是否有已缓存的 Google 登录态（不读取、不解析、不触碰 OAuth token 内容）。
 */
function hasAgySessionFiles() {
  const dirs = [
    path.join(CFG.home, ".gemini", "antigravity-cli"),
    path.join(CFG.home, ".config", "antigravity"),
    path.join(CFG.home, ".antigravity"),
  ];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (/cred|token|auth|oauth|session|profile/i.test(f) && !f.endsWith(".bak")) return true;
      }
    } catch {}
  }
  return false;
}

export let AUTH_CACHE = null;
let AUTH_GOOD = null;

export async function authStatus(force) {
  if (!force && AUTH_CACHE && Date.now() - AUTH_CACHE.at < 30000) return AUTH_CACHE.v;
  const bin = agyBin();
  if (!fs.existsSync(bin)) {
    const v = { loggedIn: false, authMethod: "none", email: null, org: null, plan: null, unknown: true, error: "Antigravity CLI (agy) 未安装" };
    AUTH_CACHE = { at: Date.now(), v };
    return v;
  }

  // 尝试快速调用 `agy auth status`（若当前 agy 版本支持）；不支持则回落到凭据文件存在性探测
  const r = spawnSync(bin, ["auth", "status"], { cwd: CFG.home, env: authEnv(), encoding: "utf8", timeout: 10000 });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
  let loggedIn = false;
  let email = null;
  let plan = null;
  let authMethod = "none";

  try {
    const j = JSON.parse(String(r.stdout || "").trim());
    if (typeof j.loggedIn === "boolean") {
      loggedIn = j.loggedIn;
      email = j.email || j.account?.email || null;
      plan = j.plan || j.subscriptionType || null;
      authMethod = j.authMethod || (loggedIn ? "oauth-personal" : "none");
    }
  } catch {
    if (r.status === 0 && /signed in|logged in|authenticated|@/i.test(out) && !/not (logged|signed) in|not authenticated/i.test(out)) {
      loggedIn = true;
      authMethod = "oauth-personal";
      const em = out.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (em) email = em[0];
    } else if (hasAgySessionFiles()) {
      loggedIn = true;
      authMethod = "oauth-personal";
    }
  }

  const v = { loggedIn, authMethod, email, org: null, plan };
  AUTH_CACHE = { at: Date.now(), v };
  AUTH_GOOD = v;
  noteLoggedIn(v.loggedIn);
  return v;
}

// ── 路由：/api/login/start /api/login/status /api/login/cancel /api/login/logout ──
export async function routeLogin(req, res, u, p) {
  if (req.method === "POST" && p === "/api/login/start") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await loginStart(b.method || "personal"));
  }
  if (req.method === "GET" && p === "/api/login/status") {
    const need = !!(LOGIN && LOGIN.done && !LOGIN.reported);
    if (LOGIN && LOGIN.done) LOGIN.reported = true;
    const st = await authStatus(need || u.searchParams.get("refresh") === "1");
    let url = "";
    if (LOGIN && !LOGIN.done) {
      try { url = fs.readFileSync(LOGIN.urlFile, "utf8").trim(); } catch {}
      if (!url) url = (LOGIN.out.match(/https:\/\/\S+/) || [""])[0];
    }
    return sendJson(res, 200, {
      ...st,
      pending: !!(LOGIN && !LOGIN.done),
      url: url || null,
      limits: st.loggedIn && RATE_LIMITS && (!RATE_LIMITS.email || RATE_LIMITS.email === st.email) ? RATE_LIMITS : null,
      last: LOGIN && LOGIN.done ? { ok: LOGIN.ok, output: LOGIN.ok ? "" : LOGIN.out.slice(-800) } : null,
    });
  }
  if (req.method === "POST" && p === "/api/login/cancel") {
    if (LOGIN && !LOGIN.done) try { killTree(LOGIN.child); } catch {}
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/login/logout") {
    if ([...RUNS.values()].some((r) => !r.ended && isLoginMode(providerById(r.provider) || undefined))) {
      return sendJson(res, 409, { error: "busy", message: tz("这一轮还在生成，等它跑完再退出登录。") });
    }
    const bin = agyBin();
    let ok = true, out = "";
    if (fs.existsSync(bin)) {
      const r = spawnSync(bin, ["auth", "logout"], { cwd: CFG.home, env: authEnv(), encoding: "utf8", timeout: 15000 });
      out = `${r.stdout || ""}${r.stderr || ""}`.trim();
      ok = r.status === 0;
    }
    AUTH_CACHE = null;
    if (ok) { noteLoggedIn(false); AUTH_GOOD = null; }
    clearRateLimits();
    return sendJson(res, 200, { ok, output: out.slice(-500) });
  }
  return NEXT;
}
