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
// 起裸交互式 agy（官方文档原话：「Headless mode uses your cached credentials. Authenticate
// once with an interactive agy session first.」）：它驻留运行、自带 OAuth 回调监听，
// 浏览器里登录完成后回调落回 agy 自己，凭据落盘，后续 acp 会话直接复用缓存凭据。
// 以前走 `agy acp --login`：拿完授权地址就退出，没有回调接收方，浏览器登录成功
// 登录态也带不回来。设了 BROWSER 捕获脚本：agy 打开 Google OAuth 链接时交给界面、
// 由系统浏览器完成登录；agy 不认 $BROWSER 时从 stdout 里扫授权地址（pickAuthUrl）。
//   兜底：浏览器无法回跳 localhost 时，界面可打开终端运行 `SSH_CONNECTION=1 agy`（Remote SSH OAuth），
//         用户直接把授权码贴给 agy 自己的终端提示，网关不经手凭据。
let LOGIN = null;
const LOGIN_DIR = path.join(CFG.home, ".cache", "hachimia-login");
const SYS_SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";

function agyBin() {
  return PATHS.agy || PATHS.claude;
}

/** 授权地址：优先认 Google 授权的特征（accounts.google.com / oauth），别抓第一个 https 链接
 *  就当授权地址；末尾的标点（) ] . , 等）不是地址的一部分，去掉 */
function pickAuthUrl(text) {
  const urls = (String(text || "").match(/https:\/\/[^\s"'<>]+/g) || [])
    .map((u) => u.replace(/[)\]}.,;:!?'"]+$/, ""));
  return urls.find((u) => /accounts\.google\.com|oauth/i.test(u)) || urls[0] || "";
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
  // 裸交互式 agy（不带 acp --login）：驻留跑 TUI、自带 OAuth 回调监听，登录态才能落回来
  const child = spawn(bin, [], { cwd: CFG.home, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
    log("登录：" + (L.ok ? "结束（退出码 0）" : "结束（退出码 " + code + "）"));
    // 不在这里断言登录成功：以前 acp --login 拿完地址就以 0 退出，被当成登录成功是假绿。
    // 是否真登上，以下一次 /api/login/status 的探测为准（close 后 need=true 会强制重探）。
    if (L.ok) toFront("登录完成").then((r) => log("登录：回到前台 → " + (r.via || r.message || "?")));
  });
  log("登录：已启动交互式 agy（Google OAuth，" + method + "）");

  return new Promise((resolve) => {
    const tick = setInterval(() => {
      let auto = "";
      try { auto = fs.readFileSync(urlFile, "utf8").trim(); } catch {}
      const manual = pickAuthUrl(L.out);
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
let AUTH_GOOD = null;   // 最后一次问出结果的状态

/** 从 agy auth status 的 stdout 里找状态对象：优先「带 boolean loggedIn」的那一段，
 *  并从后往前找 —— 前面夹的 JSON 警告不能被当成 status（审查 11-05，cccodroid 同款）。 */
function statusJson(text) {
  const s = String(text || ""), cands = [];
  const push = (v) => { if (v && typeof v === "object" && !Array.isArray(v)) cands.push(v); };
  try { push(JSON.parse(s.trim())); } catch {}
  for (const line of s.split("\n").reverse()) {
    const t = line.trim();
    if (!t.includes("{")) continue;
    try { push(JSON.parse(t)); } catch {}
  }
  // 兜底：整段里从第一个 { 到后面某个 } 逐个试（状态 JSON 被别的话包住时）
  const at = s.indexOf("{");
  for (let e = s.lastIndexOf("}"), n = 0; at >= 0 && e > at && n < 50; e = s.lastIndexOf("}", e - 1), n++) {
    try { push(JSON.parse(s.slice(at, e + 1))); } catch {}
  }
  return cands.find((x) => typeof x.loggedIn === "boolean") || cands[0] || null;
}

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
  // 状态 JSON 优先从 stdout 找：整段 → 逐行倒序 → 滑动窗口（JSON 前后夹警告也认，审查 11-05）
  const j = statusJson(r.stdout);
  if (typeof j?.loggedIn === "boolean") {
    const v = {
      loggedIn: j.loggedIn,
      authMethod: j.authMethod || (j.loggedIn ? "oauth-personal" : "none"),
      email: j.email || j.account?.email || null,
      org: null,
      plan: j.plan || j.subscriptionType || null,
    };
    AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
    noteLoggedIn(v.loggedIn);
    return v;
  }
  // 文本启发式（agy 输出非 JSON 时）与凭据文件回落：都算登录
  const textOk = r.status === 0 && /signed in|logged in|authenticated|@/i.test(out) && !/not (logged|signed) in|not authenticated/i.test(out);
  if (textOk || hasAgySessionFiles()) {
    const v = { loggedIn: true, authMethod: "oauth-personal", email: null, org: null, plan: null };
    if (textOk) {
      const em = out.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (em) v.email = em[0];
    }
    AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
    noteLoggedIn(true);
    return v;
  }
  // 问不出结果（起不来、超时、输出解析不了）：不能当成「未登录」—— 有上次问出的就沿用并标旧，
  // 没有就标「不知道」，把原因带给界面（#102 04-010）。退出码 0 也一样（DeepSeek 复核 #2）；
  // 只有输出明说没登录才给确定的 false
  if (!/not logged in|not authenticated/i.test(out)) {
    const error = String(out).split("\n").pop().slice(0, 300) || "exit " + r.status;
    const v = AUTH_GOOD ? { ...AUTH_GOOD, stale: true, error } : { loggedIn: false, authMethod: "none", email: null, org: null, plan: null, unknown: true, error };
    AUTH_CACHE = { at: Date.now(), v };
    return v;
  }
  const v = { loggedIn: false, authMethod: "none", email: null, org: null, plan: null };
  AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
  noteLoggedIn(false);
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
      if (!url) url = pickAuthUrl(LOGIN.out);
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
    AUTH_CACHE = null; AUTH_GOOD = null;   // 取消登录后别在 30 秒缓存里继续显旧的登录态
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
