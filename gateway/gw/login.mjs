import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { CFG, PATHS, log, tz } from "./config.mjs";
import { dropModelCache, execAgyModelsShared, isLoginMode, loggedInKnown, noteLoggedIn, parseAgyModelsOutput } from "./models.mjs";
import { hasAgySessionFiles, listAgyCredentialFiles } from "./agy-creds.mjs";
export { hasAgySessionFiles, listAgyCredentialFiles };
import { agyEnv, claudeBlocked, killTree } from "./claude.mjs";
import { RUNS } from "./runs.mjs";
import { PROVIDER, keyOf, providerById } from "./providers.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { toFront } from "./local.mjs";
import { RATE_LIMITS, clearRateLimits } from "./stream.mjs";
import { publish } from "./bus.mjs";

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

/** 授权地址：只认 Google 授权端点、oauth 路径、antigravity 的 auth/login 入口。
 *  找不到也不回退到第一个 https 链接——文档/官网链接不是授权地址（A8）；
 *  末尾的标点（) ] . , 等）不是地址的一部分，去掉 */
function pickAuthUrl(text) {
  const urls = (String(text || "").match(/https:\/\/[^\s"'<>]+/g) || [])
    .map((u) => u.replace(/[)\]}.,;:!?'"]+$/, ""));
  return urls.find((u) => /accounts\.google\.com|oauth|antigravity\.google\/(auth|login|signin|callback)/i.test(u)) || "";
}

function authEnv(enterprise = false) {
  // 探针/登录用的环境：只组装变量，不同步 settings.json —— 查登录态是只读操作，
  // 同步会删掉当前 API Key 模式的 modelProvider/customModelsConfig（A4）。
  // 真切到订阅模式时，由下一轮真跑（run.mjs 的 agyEnv，默认同步）再翻转配置。
  const env = agyEnv({ provider: { id: enterprise ? "antigravity-enterprise" : "antigravity", login: true, nativeModels: true }, sync: false });
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
  const normMethod = enterprise ? "enterprise" : "personal";
  noteLoginMethod(normMethod);
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
  // stdin 写失败（agy 已关读端）是异步错误：socket 上的 'error' 事件无人监听时，
  // 会以未捕获异常直接打死网关进程（A1）。这里只记下来、不改状态；
  // 真正的失败由 /api/login/code 里 write 回调确认后处理。
  child.stdin.on("error", (e) => {
    L.stdinError = e;
    log("登录：agy stdin 出错（" + (e.code || e.message) + "）");
  });
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
        // 企业登录没有单独的 agy 参数（官方文档：`agy acp --login` 只有一个布尔 --login，
        // 企业选择在 ACP authenticate 的 methodId oauth-business 里，run.mjs 已按厂商传）；
        // 但至少把 method 带回给界面，并提示在浏览器里用公司账号完成登录（A12）。
        const entHint = enterprise ? { hint: tz("企业登录：请在浏览器里用公司 Google 账号完成登录") } : {};
        if (auto || manual) return resolve({ ok: true, url: auto || manual, manualUrl: manual, auto: !!auto, waitingCode: true, method: normMethod, ...entHint });
        if (!L.done) return resolve({ ok: true, pending: true, url: null, message: tz("登录还在进行，拿到授权地址后会打开"), method: normMethod, ...entHint });
        if (L.ok) return resolve({ ok: true, url: null, alreadyLoggedIn: true, method: normMethod });
        resolve({ ok: false, message: tz("没拿到登录地址"), output: L.out.slice(-1500), method: normMethod });
      }
    }, 200);
  });
}

// 凭据文件探测已抽到 ./agy-creds.mjs（login.mjs 与 models.mjs 同口径，reg-models F-3）：
// listAgyCredentialFiles / hasAgySessionFiles 由该模块提供，本文件只 re-export（见文件头）。
export let AUTH_CACHE = null;
let AUTH_GOOD = null;   // 最后一次问出结果的状态
let AUTH_INFLIGHT = null;
const TIER_FILE = path.join(CFG.home, ".cache", "hachimia-tier.json");
const QUOTA_FILE = path.join(CFG.home, ".cache", "hachimia-quota.json");
const AUTH_FILE = path.join(CFG.home, ".cache", "hachimia-auth.json");
const AGY_QUOTA_TTL_MS = 60e3;
let AGY_QUOTA_BOOT_T = null;
let AUTH_BG_T = null;

function readAuthDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (j && j.v && typeof j.v === "object" && j.v.loggedIn === true) return j.v;
  } catch {}
  return null;
}

function writeAuthDisk(v) {
  try {
    if (!v || !v.loggedIn) { fs.unlinkSync(AUTH_FILE); return; }
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), v }));
    fs.renameSync(tmp, AUTH_FILE);
  } catch {}
}

function clearAuthDisk() {
  try { fs.unlinkSync(AUTH_FILE); } catch {}
}
let AUTH_TIER = (() => {
  try { const j = JSON.parse(fs.readFileSync(TIER_FILE, "utf8")); return typeof j?.name === "string" && j.name ? j.name : null; }
  catch { return null; }
})();
let AGY_QUOTA = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
    return j && typeof j === "object" && (j.fiveHour || j.sevenDay || (Array.isArray(j.groups) && j.groups.length)) ? j : null;
  } catch { return null; }
})();
let AGY_QUOTA_INFLIGHT = null;
let AGY_QUOTA_DEBOUNCE = null;

/** 从 agy `--output-format json -p ...` 输出里提取最后一条 JSON 对象（忽略前导日志行） */
function extractAgyJson(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const lines = s.split("\n").map((x) => x.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    if (line.startsWith("{") && line.endsWith("}")) {
      try { return JSON.parse(line); } catch {}
    }
  }
  const idx = s.lastIndexOf('{"');
  if (idx >= 0) {
    try { return JSON.parse(s.slice(idx)); } catch {}
  }
  return null;
}

function shortQuotaGroupName(name) {
  const s = String(name || "").trim();
  if (/^gemini\b/i.test(s)) return "Gemini";
  if (/claude/i.test(s) && /gpt/i.test(s)) return "Claude/GPT";
  if (/claude/i.test(s)) return "Claude";
  return s.replace(/\s+models?$/i, "").trim() || s;
}

/**
 * 解析官方 `agy --output-format json -p "/usage"`（及可选 `"/credits"`）输出，
 * 转换为与前端 `limits` 契约完全兼容的结构（含 5h / 周百分比、精确重置时间、多模型组与 AI Credits）。
 */
export function parseAgyQuotaJson(rawUsage, rawCredits = null, now = Date.now()) {
  const uObj = typeof rawUsage === "string" ? extractAgyJson(rawUsage) : rawUsage;
  const rawGroups = uObj?.command?.data?.groups;
  if (!Array.isArray(rawGroups) || !rawGroups.length) return null;

  const parseBucket = (b) => {
    if (!b || !Number.isFinite(Number(b.remaining_fraction))) return null;
    const rem = Math.max(0, Math.min(1, Number(b.remaining_fraction)));
    const used = Math.round((1 - rem) * 1000) / 10;
    const remaining = Math.round(rem * 1000) / 10;
    const ms = b.reset_time ? Date.parse(b.reset_time) : NaN;
    const resetsAt = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    return { used, remaining, resetsAt, ...(b.id ? { id: String(b.id) } : {}) };
  };

  const groups = [];
  for (const g of rawGroups) {
    const buckets = Array.isArray(g?.buckets) ? g.buckets : [];
    let fiveHour = null;
    let sevenDay = null;
    for (const b of buckets) {
      const w = String(b?.window || "").toLowerCase();
      const bid = String(b?.id || b?.name || "").toLowerCase();
      const parsed = parseBucket(b);
      if (!parsed) continue;
      if (w === "5h" || /\b5h\b|five[\s_-]?hour/.test(bid)) fiveHour = parsed;
      else if (w === "weekly" || w === "7d" || /week/.test(bid)) sevenDay = parsed;
    }
    if (!fiveHour && !sevenDay) continue;
    const name = String(g?.name || "").trim() || "Antigravity";
    const key = /claude|gpt|3p/i.test(name) ? "3p" : /gemini/i.test(name) ? "gemini" : name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    groups.push({ key, name, shortName: shortQuotaGroupName(name), fiveHour, sevenDay });
  }
  if (!groups.length) return null;

  const primary = groups.find((g) => g.key === "gemini") || groups[0];
  let credits = null;
  if (rawCredits != null) {
    const cObj = typeof rawCredits === "string" ? extractAgyJson(rawCredits) : rawCredits;
    const remC = cObj?.command?.data?.remaining_credits;
    if (Number.isFinite(Number(remC))) credits = Number(remC);
  }

  return {
    source: "agy",
    at: now,
    email: AUTH_CACHE?.v?.email || null,
    fiveHour: primary.fiveHour,
    sevenDay: primary.sevenDay,
    groups,
    ...(credits != null ? { credits } : {}),
  };
}

function execAgyJsonCmd(bin, slashCmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(bin, ["--output-format", "json", "-p", slashCmd], { cwd: CFG.home, env: authEnv(), encoding: "utf8", timeout: timeoutMs, maxBuffer: 2 << 20 }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}
/** 通过官方 `agy --output-format json -p "/usage"`（及 `/credits`）零消耗查询订阅 5h / 周额度 */
export async function fetchAgyQuota(force = false) {
  if (!force && AGY_QUOTA && Date.now() - AGY_QUOTA.at < AGY_QUOTA_TTL_MS) return AGY_QUOTA;
  if (AGY_QUOTA_INFLIGHT) return AGY_QUOTA_INFLIGHT;
  const bin = agyBin();
  if (!bin || !fs.existsSync(bin)) return AGY_QUOTA;

  const task = (async () => {
    const [uRes, cRes] = await Promise.all([
      execAgyJsonCmd(bin, "/usage", 15000),
      execAgyJsonCmd(bin, "/credits", 12000),
    ]);
    const parsed = parseAgyQuotaJson(uRes.stdout, cRes.status === 0 ? cRes.stdout : null);
    if (!parsed) return AGY_QUOTA;
    AGY_QUOTA = parsed;
    try {
      fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
      fs.writeFileSync(QUOTA_FILE, JSON.stringify(AGY_QUOTA));
    } catch {}
    publish({ type: "quota" });
    return AGY_QUOTA;
  })().finally(() => {
    if (AGY_QUOTA_INFLIGHT === task) AGY_QUOTA_INFLIGHT = null;
  });

  AGY_QUOTA_INFLIGHT = task;
  return task;
}

/** 每轮 ACP 对话结束后异步防抖刷新官方额度（不阻塞回合收尾） */
export function refreshAgyQuotaSoon() {
  if (AGY_QUOTA_DEBOUNCE) clearTimeout(AGY_QUOTA_DEBOUNCE);
  AGY_QUOTA_DEBOUNCE = setTimeout(() => {
    AGY_QUOTA_DEBOUNCE = null;
    fetchAgyQuota(true).catch(() => {});
  }, 1500);
  AGY_QUOTA_DEBOUNCE.unref?.();
}

// 上一次经网关登录用的方式（personal / enterprise），落盘保存、退出登录时清除。
// authStatus 不再一律报 oauth-personal：企业登录后报 oauth-business（A12）。
// 没经网关登过时默认 personal，与旧行为一致。
const LOGIN_METHOD_FILE = path.join(CFG.home, ".cache", "hachimia-login-method.json");
let LAST_LOGIN_METHOD = (() => {
  try { const j = JSON.parse(fs.readFileSync(LOGIN_METHOD_FILE, "utf8")); return j?.method === "enterprise" ? "enterprise" : "personal"; }
  catch { return "personal"; }
})();
function noteLoginMethod(method) {
  LAST_LOGIN_METHOD = method === "enterprise" ? "enterprise" : "personal";
  try {
    fs.mkdirSync(path.dirname(LOGIN_METHOD_FILE), { recursive: true });
    fs.writeFileSync(LOGIN_METHOD_FILE, JSON.stringify({ method: LAST_LOGIN_METHOD, at: Date.now() }));
  } catch {}
}
function loginAuthMethod() { return LAST_LOGIN_METHOD === "enterprise" ? "oauth-business" : "oauth-personal"; }

/** 记录从 agy acp 会话响应 `_meta.antigravity.tier` 拿到的订阅档位（如 Google AI Ultra） */
export function noteAuthTier(tier) {
  const name = typeof tier === "string" ? tier.trim() : String(tier?.name || "").trim();
  if (!name || name === AUTH_TIER) return;
  AUTH_TIER = name;
  try {
    fs.mkdirSync(path.dirname(TIER_FILE), { recursive: true });
    fs.writeFileSync(TIER_FILE, JSON.stringify({ name, at: Date.now() }));
  } catch {}
  if (AUTH_CACHE?.v?.loggedIn) AUTH_CACHE.v.plan = name;
  if (AUTH_GOOD?.loggedIn) AUTH_GOOD.plan = name;
  publish({ type: "quota" });
}

/** `agy models` 的输出必须真像一份模型清单才算登录：至少一行是“模型 id + 显示名”，
 *  且 id 像模型 id（含数字与 -/.，不含冒号）。帮助文本/警告行即使 exit 0 也不算（A2）。 */
function looksLikeModelList(out) {
  let list = [];
  try { list = parseAgyModelsOutput(out); } catch { return false; }
  return list.some((m) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m?.id || "") && /[0-9]/.test(m.id) && /[-.]/.test(m.id));
}

function execAgyModels(bin, env) {
  return execAgyModelsShared(bin, env || authEnv(), { timeoutMs: 10000, shared: !env });
}

export async function authStatus(force) {
  if (!force && AUTH_CACHE && Date.now() - AUTH_CACHE.at < 30000) return AUTH_CACHE.v;
  if (!force && AUTH_INFLIGHT) return AUTH_INFLIGHT;
  const bin = agyBin();
  if (!fs.existsSync(bin)) {
    const v = { loggedIn: false, authMethod: "none", email: null, org: null, plan: null, unknown: true, error: "Antigravity CLI (agy) 未安装" };
    AUTH_CACHE = { at: Date.now(), v };
    return v;
  }

  // API Key 模式：探针必须带 key 才能问出模型（A13）。authEnv() 会删 GEMINI_API_KEY，
  // 只适合 OAuth 探针；生效厂商是 API Key 模式、且它自己配了 key（apiKey / apiKeyEnv）
  // 时，用该厂商的 agyEnv 探。只认厂商自己的 key 来源，不拿别的厂商回落的 key 来探。
  const keyProv = PROVIDER;
  const isKeyMode = !!(keyProv && !keyProv.login && (keyProv.authType === "gemini-api-key" || keyProv.authStyle === "gemini-api-key"));
  const apiKey = isKeyMode && (keyProv.apiKey || keyProv.apiKeyEnv) ? (keyOf(keyProv) || null) : null;

  // 冷启动 SWR：非强刷、内存尚无缓存且本地存在 OAuth 凭据文件时，秒回上次落盘结果或凭据推断，
  // 后台异步复核 `agy models`，避免首屏请求被 6s+ 的子进程冷启动堵住连接池。
  if (!force && !AUTH_CACHE && !apiKey && hasAgySessionFiles()) {
    const cached = readAuthDisk();
    const v = cached
      ? { ...cached, plan: cached.plan || AUTH_TIER }
      : { loggedIn: true, authMethod: loginAuthMethod(), email: null, org: null, plan: AUTH_TIER };
    AUTH_CACHE = { at: Date.now(), v };
    AUTH_GOOD = v;
    noteLoggedIn(true);
    if (!AUTH_BG_T) {
      AUTH_BG_T = setTimeout(() => {
        AUTH_BG_T = null;
        authStatus(true).catch(() => {});
      }, 1500);
      AUTH_BG_T.unref?.();
    }
    return v;
  }

  // 零成本异步探测：`agy models`（官方 agy 没有 auth 子命令，agy auth status 会被当 prompt
  // 参数忽略报错）。必须用异步 execFile：以前用 spawnSync 会把整个网关事件循环冻住数秒，
  // 导致冷启动并发 /__proof 超时、WebView 收到 502 并闪「网关离线」再重连。
  const run = (async () => {
    const r = await execAgyModels(bin, apiKey ? agyEnv({ provider: keyProv }) : undefined);
    const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
    // 未登录的文案先认（不赌退出码：实测 1.5.13 是 exit 1，别的版本可能不同）
    if (/please sign in|sign in to view/i.test(out)) {
      const v = { loggedIn: false, authMethod: "none", email: null, org: null, plan: null };
      AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
      if (!apiKey) clearAuthDisk();
      noteLoggedIn(false);
      return v;
    }
    if (r.status === 0 && out && looksLikeModelList(out)) {
      // 邮箱只从“账号信息”行认，别从帮助文本/文档链接里捡（A2）
      const acctLine = out.split("\n").find((l) => /account|signed.?in|email|user|profile/i.test(l));
      const em = acctLine ? acctLine.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) : null;
      const v = { loggedIn: true, authMethod: apiKey ? "gemini-api-key" : loginAuthMethod(), email: em ? em[0] : null, org: null, plan: AUTH_TIER };
      AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
      if (!apiKey) writeAuthDisk(v);
      noteLoggedIn(true);
      return v;
    }
    // 凭据文件回落：探测问不出结果时，有本地凭据文件就算登录
    if (hasAgySessionFiles()) {
      const v = { loggedIn: true, authMethod: loginAuthMethod(), email: null, org: null, plan: AUTH_TIER };
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
  })().finally(() => { if (AUTH_INFLIGHT === run) AUTH_INFLIGHT = null; });
  AUTH_INFLIGHT = run;
  return run;
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
    // reg-models F-1（R9）：登录前缓存的 9 条 fallback 指纹里不含登录态，登录后 10 分钟内
    // 仍会命中。只在登录态由假变真时清一次模型缓存——登录态不变的轮询不清，
    // 否则 10 分钟缓存名存实亡；首探（was=null）时网关刚起、缓存是空的，也不用清。
    const wasLoggedIn = loggedInKnown();
    const refresh = u.searchParams.get("refresh") === "1";
    const st = await authStatus(need || refresh);
    if (st.loggedIn && wasLoggedIn === false) dropModelCache();
    let agyLimits = null;
    if (st.loggedIn) {
      if (refresh || need) {
        agyLimits = await fetchAgyQuota(true).catch(() => AGY_QUOTA);
      } else {
        agyLimits = AGY_QUOTA;
        if (!AGY_QUOTA || Date.now() - AGY_QUOTA.at >= AGY_QUOTA_TTL_MS) {
          // 网关刚起前 8 秒错峰延后后台额度拉取：先让 WebView 完成首屏渲染和历史会话加载，
          // 避免立刻并发拉起 agy /usage + /credits（各 7s）与首屏抢 CPU
          if (process.uptime() < 8) {
            if (!AGY_QUOTA_BOOT_T) {
              AGY_QUOTA_BOOT_T = setTimeout(() => {
                AGY_QUOTA_BOOT_T = null;
                fetchAgyQuota(false).catch(() => {});
              }, 4000);
              AGY_QUOTA_BOOT_T.unref?.();
            }
          } else {
            fetchAgyQuota(false).catch(() => {});
          }
        }
      }
    }
    let url = "";
    if (LOGIN && !LOGIN.done) {
      try { url = fs.readFileSync(LOGIN.urlFile, "utf8").trim(); } catch {}
      if (!url) url = pickAuthUrl(LOGIN.out);
    }
    const fallbackLimits = RATE_LIMITS && (!RATE_LIMITS.email || RATE_LIMITS.email === st.email) ? RATE_LIMITS : null;
    return sendJson(res, 200, {
      ...st,
      pending: !!(LOGIN && !LOGIN.done),
      waitingCode: !!(LOGIN && !LOGIN.done && !LOGIN.codeSent && LOGIN.child.stdin && !LOGIN.child.stdin.destroyed),
      codeSent: !!(LOGIN && LOGIN.codeSent),
      url: url || null,
      limits: st.loggedIn ? (agyLimits || fallbackLimits) : null,
      last: LOGIN && LOGIN.done ? { ok: LOGIN.ok, output: LOGIN.ok ? "" : LOGIN.out.slice(-800) } : null,
    });
  }
  if (req.method === "POST" && p === "/api/login/code") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const code = String(b.code || "").trim();
    const L = LOGIN;
    if (!L || L.done || !L.child.stdin || L.child.stdin.destroyed) {
      return sendJson(res, 200, { ok: false, message: tz("登录进程已经结束，请重新发起登录。") });
    }
    if (!code) return sendJson(res, 200, { ok: false, message: tz("授权码是空的。") });
    // 写 stdin 是异步操作：等 write 回调确认真的送达再报 ok。EPIPE 等失败要当场
    // 返回 ok:false、把 codeSent 复位并结束这轮登录（A1：以前无回调、无监听，EPIPE
    // 以未捕获异常打死网关，界面却还显示“已提交”）。
    const sent = await new Promise((resolve) => {
      L.child.stdin.write(code + "\n", (err) => resolve(!err));
    });
    if (!sent) {
      L.codeSent = false;
      if (!L.done) {
        L.done = true; L.ok = false;
        L.out += "\n" + tz("授权码没能写进 agy（stdin 已关闭），请重新发起登录。");
        try { killTree(L.child); } catch {}
      }
      log("登录：授权码写不进 agy stdin，请重新发起登录");
      return sendJson(res, 200, { ok: false, message: tz("授权码没能写进 agy（登录进程的 stdin 已关闭），请重新发起登录。") });
    }
    L.codeSent = true;
    log("登录：收到授权码，已转交 agy");
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/login/cancel") {
    if (LOGIN && !LOGIN.done) try { killTree(LOGIN.child); } catch {}
    AUTH_CACHE = null; AUTH_GOOD = null; clearAuthDisk();   // 取消登录后别在 30 秒缓存里继续显旧的登录态
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/login/logout") {
    if ([...RUNS.values()].some((r) => !r.ended && isLoginMode(providerById(r.provider) || undefined))) {
      return sendJson(res, 409, { error: "busy", message: tz("这一轮还在生成，等它跑完再退出登录。") });
    }
    // agy 没有 auth logout 子命令：直接删本地凭据文件（与 hasAgySessionFiles 同一口径，
    // 三个目录递归删凭据特征文件，MIG-14），然后重探一次验证是不是真的退出了
    let deleted = 0;
    for (const fp of listAgyCredentialFiles()) {
      try {
        if (!fs.statSync(fp).isFile()) continue;
        fs.rmSync(fp);
        deleted++;
      } catch {}
    }
    AUTH_CACHE = null; AUTH_GOOD = null; AUTH_TIER = null; AGY_QUOTA = null;
    clearAuthDisk();
    try { fs.unlinkSync(TIER_FILE); } catch {}
    try { fs.unlinkSync(LOGIN_METHOD_FILE); } catch {}
    LAST_LOGIN_METHOD = "personal";
    try { fs.unlinkSync(QUOTA_FILE); } catch {}
    noteLoggedIn(false);
    clearRateLimits();
    const v = await authStatus(true);   // 重探：真退了才算数
    if (v.loggedIn) {
      return sendJson(res, 200, { ok: false, message: tz("本地凭据已清但探测仍显示已登录（凭据可能存在别处）。请在应用内终端跑一次 agy，执行 /logout。") });
    }
    // reg-models F-1：退出成功也清一次模型缓存，否则旧账户的 live 清单再粘 10 分钟。
    dropModelCache();
    return sendJson(res, 200, { ok: true, message: deleted ? tz("已退出 Google 账户登录。") : tz("本来就没有本地登录凭据。") });
  }
  return NEXT;
}
