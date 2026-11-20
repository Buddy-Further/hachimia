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

// ── Google Antigravity 账户登录（OAuth 全程由官方 agy CLI 完成；网关只转递地址与授权码，不碰凭据）──
//
// 用 `agy acp --login`（官方「ACP terminal auth」）：打印 Google OAuth 授权地址，
// 然后等在 stdin 上读授权码（redirect 到 antigravity.google，浏览器不会回跳本应用）。
// 网关从 stdout 扫出地址交给界面 → 系统浏览器登录 → 界面把页面上的授权码贴回
// → /api/login/code 写进 agy 的 stdin → agy 换 token、凭据落盘、退出 0。
// 实测（官方 android arm64 1.5.13）：acp --login 不需要 TTY，普通管道即可；
// 裸 agy 无 TTY 直接报 bubbletea 错误起不来；agy 没有 auth 子命令（auth status /
// auth logout 都会被当 prompt 参数忽略）。凭据是文件存储（安卓无 keyring）。
//   兜底：界面可打开终端运行 `SSH_CONNECTION=1 agy`（Remote SSH OAuth），
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
  // stdin 必须是 pipe：acp --login 打印授权地址后等在 stdin 上读授权码，
  // 以前设成 ignore，授权码无处可喂，登录永远完不成（登录态带不回来的根因）
  const child = spawn(bin, ["acp", "--login"], { cwd: CFG.home, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const L = LOGIN = { child, out: "", startedAt: Date.now(), done: false, ok: false, method, urlFile, codeSent: false };

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
    // 不在这里断言登录成功：是否真登上，以下一次 /api/login/status 的探测为准
    // （close 后 need=true 会强制重探）。退出码 0 只说明 agy 自己干净收尾。
    if (L.ok) toFront("登录完成").then((r) => log("登录：回到前台 → " + (r.via || r.message || "?")));
  });
  log("登录：已启动 agy acp --login（Google OAuth，" + method + "）");

  return new Promise((resolve) => {
    const tick = setInterval(() => {
      let auto = "";
      try { auto = fs.readFileSync(urlFile, "utf8").trim(); } catch {}
      const manual = pickAuthUrl(L.out);
      if ((auto || manual) || L.done || Date.now() - L.startedAt > 20000) {
        clearInterval(tick);
        if (auto || manual) return resolve({ ok: true, url: auto || manual, manualUrl: manual, auto: !!auto, waitingCode: true });
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

export async function authStatus(force) {
  if (!force && AUTH_CACHE && Date.now() - AUTH_CACHE.at < 30000) return AUTH_CACHE.v;
  const bin = agyBin();
  if (!fs.existsSync(bin)) {
    const v = { loggedIn: false, authMethod: "none", email: null, org: null, plan: null, unknown: true, error: "Antigravity CLI (agy) 未安装" };
    AUTH_CACHE = { at: Date.now(), v };
    return v;
  }

  // 零成本探测：`agy models`（官方 agy 没有 auth 子命令，agy auth status 会被当 prompt
  // 参数忽略报错）。实测 android arm64 1.5.13：未登录 → exit 1 + "Please sign in to
  // view available models"；登录后 → exit 0 + 模型列表。只打一个列表接口，不产生模型调用。
  const r = spawnSync(bin, ["models"], { cwd: CFG.home, env: authEnv(), encoding: "utf8", timeout: 10000 });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
  // 未登录的文案先认（不赌退出码：实测 1.5.13 是 exit 1，别的版本可能不同）
  if (/please sign in|sign in to view/i.test(out)) {
    const v = { loggedIn: false, authMethod: "none", email: null, org: null, plan: null };
    AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
    noteLoggedIn(false);
    return v;
  }
  if (r.status === 0 && out) {
    const em = out.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    const v = { loggedIn: true, authMethod: "oauth-personal", email: em ? em[0] : null, org: null, plan: null };
    AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
    noteLoggedIn(true);
    return v;
  }
  // 凭据文件回落：探测问不出结果时，有本地凭据文件就算登录
  if (hasAgySessionFiles()) {
    const v = { loggedIn: true, authMethod: "oauth-personal", email: null, org: null, plan: null };
    AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
    noteLoggedIn(true);
    return v;
  }
  // 问不出结果（起不来、超时、网络错）：不能当成「未登录」—— 有上次问出的就沿用并标旧，
  // 没有就标「不知道」，把原因带给界面（#102 04-010）
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

// ── 路由：/api/login/start /api/login/status /api/login/code /api/login/cancel /api/login/logout ──
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
      waitingCode: !!(LOGIN && !LOGIN.done && !LOGIN.codeSent && LOGIN.child.stdin && !LOGIN.child.stdin.destroyed),
      codeSent: !!(LOGIN && LOGIN.codeSent),
      url: url || null,
      limits: st.loggedIn && RATE_LIMITS && (!RATE_LIMITS.email || RATE_LIMITS.email === st.email) ? RATE_LIMITS : null,
      last: LOGIN && LOGIN.done ? { ok: LOGIN.ok, output: LOGIN.ok ? "" : LOGIN.out.slice(-800) } : null,
    });
  }
  if (req.method === "POST" && p === "/api/login/code") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const code = String(b.code || "").trim();
    if (!LOGIN || LOGIN.done || !LOGIN.child.stdin || LOGIN.child.stdin.destroyed) {
      return sendJson(res, 200, { ok: false, message: tz("登录进程已经结束，请重新发起登录。") });
    }
    if (!code) return sendJson(res, 200, { ok: false, message: tz("授权码是空的。") });
    LOGIN.codeSent = true;
    LOGIN.child.stdin.write(code + "\n");
    log("登录：收到授权码，已转交 agy");
    return sendJson(res, 200, { ok: true });
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
    // agy 没有 auth logout 子命令：直接删本地凭据文件（与 hasAgySessionFiles 同一口径，
    // 只删三个目录的顶层文件），然后重探一次验证是不是真的退出了
    let deleted = 0;
    for (const d of [path.join(CFG.home, ".gemini", "antigravity-cli"), path.join(CFG.home, ".config", "antigravity"), path.join(CFG.home, ".antigravity")]) {
      try {
        for (const f of fs.readdirSync(d)) {
          if (!/cred|token|auth|oauth|session|profile/i.test(f) || f.endsWith(".bak")) continue;
          const fp = path.join(d, f);
          if (!fs.statSync(fp).isFile()) continue;
          fs.rmSync(fp);
          deleted++;
        }
      } catch {}
    }
    AUTH_CACHE = null; AUTH_GOOD = null;
    noteLoggedIn(false);
    clearRateLimits();
    const v = await authStatus(true);   // 重探：真退了才算数
    if (v.loggedIn) {
      return sendJson(res, 200, { ok: false, message: tz("本地凭据已清但探测仍显示已登录（凭据可能存在别处）。请在应用内终端跑一次 agy，执行 /logout。") });
    }
    return sendJson(res, 200, { ok: true, message: deleted ? tz("已退出 Google 账户登录。") : tz("本来就没有本地登录凭据。") });
  }
  return NEXT;
}
