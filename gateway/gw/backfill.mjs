// 补档（脉络规划书 §12 / G5）：改版前的旧会话没有「在场的 AI」给章起题名，由用户在脉络页点一下，网关替它补。
// 素材：每章结束时那份压缩摘要（现成的浓缩，不重读全文），取开头「主要诉求」和末尾「当前工作」两段；
//      还没压缩过的最后一章没有摘要，拿这一章里用户的提问。
// 调用：claude -p，走全局默认的接口和模型（用户 10-26 定的，不另挑便宜型号）；不留会话记录、不给工具、不起 MCP，
//      在空的私有目录里跑。一个会话的章一次问完（太多就分批），题名过 validateTitle，不合格的带着原因再问一次。
// 记 by:"backfill"——最弱的来源，AI 建档、用户改名都能盖过它；跑的时候有人刚给某章起了名就跳过那章。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, LAST_LANG, PATHS, log, tz } from "./config.mjs";
import { UC_SEALED, ucPending } from "./userconf.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { agyCmd, agyEnv, claudeBlocked, currentModelInfo, isGeminiApiKey, killTree, stripAgyGlog } from "./claude.mjs";
import { ACP_PROTOCOL_VERSION, createAcpClient } from "./acp.mjs";
import { sealed } from "./edition.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { PROVIDER, hasAcpKeyChannel, hasAdcCredentials, keyOf } from "./providers.mjs";
import { lineageCached, lineageGraph } from "./lineage.mjs";
import { findSessionFile } from "./sessions.mjs";
import { archiveDb } from "./archive-store.mjs";
import { fileChapter } from "./archive.mjs";
import { validateTitle } from "./archive-core.mjs";
import { isInjected } from "./integrity.mjs";

const SUM_HEAD = 1000, SUM_TAIL = 1400, OPEN_MAX = 1600, BATCH_CHARS = 48000, BATCH_N = 24;
// Linux/Android 单个 argv[i] 硬上限 MAX_ARG_STRLEN = 128 KiB（131072 字节）：纯 agy 经 -p=<prompt> 传参，
// 中文 3 字节/字，分批按 90 KiB 封顶（给第 2 轮重试修正说明留余量），ask() 再做 120 KiB 兜底截断防止 E2BIG
const AGY_BATCH_BYTES = 90 * 1024;
const AGY_ARG_HARD_CAP = 120 * 1024;

export function trimUtf8Bytes(s, maxBytes) {
  const str = String(s || "");
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export function planBackfillBatches(sessTitle, items) {
  const sysBytes = Buffer.byteLength(`-p=${systemPrompt()}\n\n`, "utf8");
  const maxPromptBytes = Math.max(8192, AGY_BATCH_BYTES - sysBytes);
  const batches = [];
  let cur = [], chars = 0;
  for (const it of items) {
    const overCount = cur.length >= BATCH_N || chars + it.src.length > BATCH_CHARS;
    const overBytes = cur.length > 0
      && Buffer.byteLength(userPrompt(sessTitle, [...cur, it]), "utf8") > maxPromptBytes;
    if (cur.length && (overCount || overBytes)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(it); chars += it.src.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
const zh = () => /^zh/i.test(LAST_LANG);
// 给模型看的语言名：以前非英文界面只写「the interface language (es)」，西语 / 日语界面容易被写成英文
const LANG_NAME = { en: "English", es: "Spanish", fr: "French", ru: "Russian", ar: "Arabic", ja: "Japanese", ko: "Korean", id: "Indonesian" };
const langName = (l) => (/^zh-(Hant|TW|HK)/i.test(l) ? "Traditional Chinese" : LANG_NAME[String(l).slice(0, 2)] || "English");

// ── 素材 ──

/** 压缩摘要 → 喂给模型的一段：「主要诉求」开头一截 + 「当前工作」一截（摘要按 Claude Code 的固定小节写） */
export function digestSummary(text) {
  let s = String(text || "").replace(/\r/g, "");
  const k = s.search(/\bSummary:\s*\n/);
  if (k >= 0) s = s.slice(k).replace(/^Summary:\s*/, "");
  if (s.length <= SUM_HEAD + SUM_TAIL) return s.trim();
  // 空白只能在同一行内：\s* 跨行时，一长串换行会让正则平方级回溯，补档点一下就把网关冻住（审查 11-05）
  const cw = s.search(/\n[ \t\u3000]{0,8}\d+\.[ \t\u3000]*(Current Work|当前工作)/i);
  const tail = cw >= 0 ? s.slice(cw, cw + SUM_TAIL) : s.slice(-SUM_TAIL);
  return (s.slice(0, SUM_HEAD) + "\n…\n" + tail).trim();
}

/** 读文件 [a, b) 一段，按行切（首尾半截行丢掉） */
async function readLines(file, a, b) {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, b - a));
    const { bytesRead } = await fh.read(buf, 0, buf.length, a);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (a > 0) lines.shift();
    lines.pop();
    return lines;
  } finally { await fh.close(); }
}
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "");

/** off 处那一行（压缩摘要）的正文 */
async function summaryAt(file, off) {
  const fh = await fs.promises.open(file, "r");
  try {
    let line = Buffer.alloc(0), pos = off;
    while (line.length < 8 << 20) {
      const b = Buffer.alloc(256 << 10); const { bytesRead } = await fh.read(b, 0, b.length, pos);
      if (!bytesRead) break;
      const nl = b.subarray(0, bytesRead).indexOf(10);
      line = Buffer.concat([line, b.subarray(0, nl >= 0 ? nl : bytesRead)]);
      if (nl >= 0) break;
      pos += bytesRead;
    }
    const e = JSON.parse(line.toString("utf8"));
    return textOf(e.message && e.message.content);
  } catch { return ""; } finally { await fh.close(); }
}

/** 从 off 往后这一章里用户的提问：开头几句 + 末尾几句（大章只读头尾各 3 MB） */
async function promptsFrom(file, off) {
  const size = fs.statSync(file).size, W = 3 << 20;
  const parts = size - off > 2 * W ? [[off, off + W], [size - W, size]] : [[off, size]];
  const qs = [];
  for (const [a, b] of parts) {
    for (const s of await readLines(file, a, b)) {
      if (!s.includes('"type":"user"') || s.includes('"tool_result"') || s.includes('"isCompactSummary":true') || s.includes('"isMeta":true')) continue;
      let e; try { e = JSON.parse(s); } catch { continue; }
      if (e.type !== "user" || e.isSidechain) continue;
      const t = textOf(e.message && e.message.content).trim();
      if (!t || isInjected(t) || t.startsWith("Caveat:")) continue;
      qs.push(t.replace(/\s+/g, " ").slice(0, 160));
    }
  }
  const pick = qs.length > 10 ? [...qs.slice(0, 5), "…", ...qs.slice(-5)] : qs;
  let out = pick.map((q) => "- " + q).join("\n");
  if (out.length > OPEN_MAX) out = out.slice(0, OPEN_MAX) + "…";
  return out;
}

// ── 要补的 ──

/** 哪些章要补：不在回收站、不是一问一答、不是杂项 / 定时任务；没题名的章。正在跑的会话不补最后一章（在场的 AI 会起） */
export async function backfillTargets() {
  const g = await lineageGraph();
  const out = [];
  for (const n of [...g.nodes].sort((a, b) => b.lastTs - a.lastTs)) {
    if (n.trashed || n.brief || n.misc || n.sched) continue;
    const last = n.chapters.length;
    const chs = n.chapters.filter((c) => !c.title && !(c.n === last && n.running)).map((c) => c.n);
    if (chs.length) out.push({ id: n.id, title: n.title, chapters: chs, total: last });
  }
  return out;
}

/** 预估：章数、调用次数、大约多少 token（按素材上限算，宁多勿少） */
export function estimate(targets) {
  let chapters = 0, chars = 0, calls = 0;
  for (const t of targets) {
    let open = t.chapters.includes(t.total) ? 1 : 0, sum = t.chapters.length - open;
    chapters += t.chapters.length;
    const c = sum * (SUM_HEAD + SUM_TAIL + 60) + open * (OPEN_MAX + 60);
    chars += c;
    calls += Math.max(Math.ceil(t.chapters.length / BATCH_N), Math.ceil(c / BATCH_CHARS));
  }
  // 中文约 1 字 0.8 token、英文约 4 字符 1 token，摘要多是英文夹中文：按 0.45 折算；每次调用另有约 1500 的固定开销
  const tokensIn = Math.round(chars * 0.45 + calls * 1500), tokensOut = chapters * 250;   // 含思考：DeepSeek Flash 实测 5 章约 1200
  return { sessions: targets.length, chapters, calls, tokensIn, tokensOut };
}

// ── 问模型 ──

export function systemPrompt() {
  return zh()
    ? `你给编程助手 App 里的会话章节起题名。会话每压缩一次就结束一章；每章给你的是那一章结束时的压缩摘要（概括到那时为止的工作，重点看「当前工作」那段，那是这一章最后在干的事），或者（还没结束的章）这一章里用户的提问。
题名规则：说清这一章干了什么事，用动宾结构（如「补齐 9 家厂商官方接口」「排查终端密钥 401」）；不超过 20 个字；用中文，专有名词、版本号、命令名照原样；不写问候语、日期、「对话」「会话」「讨论」这类空泛词、emoji，结尾不加标点。相邻两章干的是同一件事也各起各的，体现进展。
只输出一个 JSON 对象，键是章号，值是题名，例如 {"3":"定稿脉络建档规范","4":"实现脉络页地图"}。不要别的文字。`
    : `You title chapters of sessions in a coding-assistant app. A session ends a chapter each time it is compacted. For each chapter you get the compaction summary written when it ended (it covers all work so far; the "Current Work" part is what this chapter ended on), or, for a chapter still open, the user's prompts in it.
Title rules: say what was done in this chapter as a verb phrase ("Add official endpoints for 9 vendors", "Debug terminal key 401"); at most 60 characters; write in ${langName(LAST_LANG)}; keep product names, versions and commands as-is; no greetings, dates, vague words like "chat"/"session"/"discussion", emoji, or trailing punctuation. Adjacent chapters on the same thing still get distinct titles that show progress.
Output only one JSON object mapping chapter number to title, e.g. {"3":"Finalize the archive spec","4":"Build the lineage map"}. No other text.`;
}

export function userPrompt(sessTitle, items, fix) {
  const head = zh() ? `会话：${sessTitle || "（无题）"}\n下面是要起题名的章。` : `Session: ${sessTitle || "(untitled)"}\nChapters to title:`;
  const body = items.map((it) => {
    const label = zh() ? `【第 ${it.n} 章】` : `[Chapter ${it.n}]`;
    const prev = it.prev ? (zh() ? `上一章题名：${it.prev}\n` : `Previous chapter title: ${it.prev}\n`) : "";
    const kind = it.open ? (zh() ? "这一章用户的提问：" : "User prompts in this chapter:") : (zh() ? "结束时的压缩摘要：" : "Summary at the end:");
    const bad = fix && fix[it.n] ? (zh() ? `\n上次起的「${fix[it.n].title}」不合格：${fix[it.n].errors.join("；")}` : `\nLast attempt "${fix[it.n].title}" was rejected: ${fix[it.n].errors.join("; ")}`) : "";
    const reply = it.reply ? (zh() ? "\n助手的回答（节选）：\n" : "\nAssistant's reply (excerpt):\n") + it.reply : "";
    return `${label}\n${prev}${kind}\n${it.src}${reply}${bad}`;
  }).join("\n\n");
  return head + "\n\n" + body;
}

/** 模型回的文字 → { 章号: 题名 } */
export function parseTitles(text) {
  const s = String(text || ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return {};
  try {
    const o = JSON.parse(s.slice(a, b + 1)), out = {};
    for (const [k, v] of Object.entries(o)) if (/^\d+$/.test(k) && typeof v === "string") out[Number(k)] = v;
    return out;
  } catch { return {}; }
}

const WORK = path.join(CFG.home, ".cache", "ccapp-backfill");
let AGY_PRINT_INELIGIBLE = false;
const isEligibilityErr = (msg) => /Eligibility check failed|not currently available in your location|Account ineligible/i.test(String(msg || ""));

/** 轻量一次性 agy acp 问答（无工具权限、不入常驻池）：当 agy -p 受 OAuth 地区资格检查拦住时自动回退 */
async function askViaAcpOneShot(agyPrompt, { env, provider: P, model, own }) {
  const bin = PATHS.agy;
  if (!bin || !fs.existsSync(bin)) return { error: tz("Antigravity CLI (agy) 未安装。到 设置 → 更新 里点「安装」即可。") };
  let chunks = "", fullMsg = "", tin = 0, tout = 0, client = null;
  let timer = null;
  try {
    client = createAcpClient({
      bin,
      args: ["acp"],
      cwd: WORK,
      env,
      onNotification: (method, params) => {
        if (method !== "session/update") return;
        const u = params?.update;
        if (!u || typeof u !== "object") return;
        if (u.sessionUpdate === "agent_message_chunk") {
          const t = typeof u.content === "string" ? u.content : (u.content?.type === "text" ? String(u.content.text || "") : "");
          if (t) chunks += t;
        } else if (u.sessionUpdate === "agent_message") {
          const t = typeof u.content === "string" ? u.content : (u.content?.type === "text" ? String(u.content.text || "") : "");
          if (t) fullMsg = t;
        } else if (u.sessionUpdate === "usage_update") {
          const raw = u.usage || u;
          const inp = Number(raw.inputTokens ?? raw.input_tokens ?? 0) || 0;
          const cached = Number(raw.cachedReadTokens ?? raw.cache_read_input_tokens ?? 0) || 0;
          const outT = Number(raw.outputTokens ?? raw.output_tokens ?? 0) || 0;
          if (inp + cached > tin) tin = inp + cached;
          if (outT > tout) tout = outT;
        }
      },
      onRequest: async (method, params) => {
        if (method === "session/request_permission") {
          const opts = Array.isArray(params?.options) ? params.options : [];
          const rej = opts.find((x) => /reject|deny|cancel/i.test(String(x?.kind || x?.optionId || "")));
          return rej ? { outcome: { outcome: "selected", optionId: rej.optionId } } : { outcome: { outcome: "cancelled" } };
        }
        return {};
      },
    });
    if (own) JOB.child = client.child;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { killTree(client.child); } catch {}
        try { client.close(); } catch {}
        reject(new Error("timeout"));
      }, 180000);
      timer.unref?.();
    });
    const run = async () => {
      const initRes = await client.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "hachimia", version: process.env.CCAPP_APP_VERSION || "0.1.0" },
      }, 30000);
      if (!own && false) return;
      if (own && JOB.stop) return { error: "stopped" };
      const key = keyOf(P);
      const authType = P?.authType || (isGeminiApiKey(P, key) ? "gemini-api-key" : (P?.login ? "oauth-personal" : ""));
      const authMethods = Array.isArray(initRes?.authMethods) ? initRes.authMethods : [];
      if (authType && authMethods.some((m) => m.id === authType)) {
        const authParams = { methodId: authType };
        if (authType === "gemini-api-key" && key) authParams._meta = { "api-key": key };
        try { await client.request("authenticate", authParams, 20000); }
        catch (e) {
          if (!/already (authenticated|authorized|logged in|signed in)|authentication (not required|not needed)/i.test(e.message || "")) throw e;
        }
      }
      if (own && JOB.stop) return { error: "stopped" };
      const sessRes = await client.request("session/new", { cwd: WORK, mcpServers: [] }, 30000);
      const sid = sessRes?.sessionId;
      if (!sid) throw new Error("ACP session/new returned no sessionId");
      if (model) {
        const cfgOpts = Array.isArray(sessRes?.configOptions) ? sessRes.configOptions : [];
        const mOpt = cfgOpts.find((c) => c && (c.id === "model" || c.category === "model"));
        const configId = mOpt?.id || "model";
        try { await client.request("session/set_config_option", { sessionId: sid, configId, value: model }, 10000); } catch {}
      }
      if (own && JOB.stop) return { error: "stopped" };
      const pr = await client.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: agyPrompt }] }, 150000);
      const pu = pr?.usage || {};
      if (!tin) tin = (Number(pu.inputTokens ?? pu.input_tokens ?? 0) || 0) + (Number(pu.cachedReadTokens ?? pu.cache_read_input_tokens ?? 0) || 0);
      if (!tout) tout = Number(pu.outputTokens ?? pu.output_tokens ?? 0) || 0;
      const text = (fullMsg || chunks).trim();
      return text ? { text, tin, tout } : { error: stripAgyGlog(client.stderr).slice(-300) || "no output" };
    };
    return await Promise.race([run(), timeoutPromise]);
  } catch (e) {
    if (own && JOB.stop) return { error: "stopped" };
    return { error: String(e?.message || e || "acp error").slice(0, 300) };
  } finally {
    if (timer) clearTimeout(timer);
    if (client) {
      try { client.close(); } catch {}
      try { killTree(client.child); } catch {}
    }
    if (own) JOB.child = null;
  }
}

/** 问一次。o.provider / o.model：自动起名用对话那家（autotitle.mjs）；不给就是补档，走全局默认、子进程挂在 JOB 上好停 */
export async function ask(prompt, o = {}) {
  // 起 agy 就会加载用户级配置：有没确认的改动先别起（发行版亦核 UC_SEALED，与 run.mjs 对齐）
  if (ucPending(sealed() ? UC_SEALED : null)) return { error: tz("Antigravity CLI 的用户级配置有改动还没确认。先发一条消息，在弹出的卡片里确认后再试。") };
  const blocked = await claudeBlocked();
  if (blocked) return { error: blocked };
  if (!o.provider && JOB.stop) return { error: "stopped" };   // 核验那一下里用户点了停止：别再起（调用方先看 JOB.stop，这条不记错）
  const P = o.provider || PROVIDER, own = !o.provider;
  if (!hasAcpKeyChannel(P)) {
    return { error: tz("该接口在 Antigravity 下暂不支持：Antigravity CLI 没有通用第三方 API Key 通道。请声明 protocol:\"gemini\"（端点须讲 Gemini 协议），或换用 Gemini / 订阅登录厂商。") };
  }
  if ((P?.authType === "agent-platform" || P?.authStyle === "adc") && !hasAdcCredentials()) {
    return { error: tz("没有找到 Google Cloud ADC 凭据（Application Default Credentials）。请先在终端运行 gcloud auth application-default login 登录，再回来选 ADC。") };
  }
  fs.mkdirSync(WORK, { recursive: true });
  const rawAgyPrompt = `${systemPrompt()}\n\n${prompt}`;
  const agyPrompt = Buffer.byteLength(`-p=${rawAgyPrompt}`, "utf8") > AGY_ARG_HARD_CAP
    ? trimUtf8Bytes(rawAgyPrompt, AGY_ARG_HARD_CAP - 3)
    : rawAgyPrompt;
  const env = own ? agyEnv() : agyEnv({ model: o.model || "", provider: P });
  if (AGY_PRINT_INELIGIBLE && P?.login) {
    return askViaAcpOneShot(agyPrompt, { env, provider: P, model: o.model || "", own });
  }
  const printRes = await new Promise((resolve) => {
    const [cmd, args] = agyCmd(["--output-format", "json", "--disable-slash-commands", ...(o.model ? ["--model", o.model] : []), `-p=${agyPrompt}`]);
    const child = spawn(cmd, args, { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (own) JOB.child = child;
    let out = "", err = "", done = false;
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); if (own) JOB.child = null; resolve(r); };
    const timer = setTimeout(() => { killTree(child); fin({ error: "timeout" }); }, 240000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => fin({ error: e.message }));
    child.on("close", (code) => {
      const cleanOut = stripAgyGlog(out), cleanErr = stripAgyGlog(err);
      let j = null;
      try { j = JSON.parse(cleanOut); } catch {}
      if (!j) {
        for (const l of cleanOut.split("\n").reverse()) {
          if (!l.trim()) continue;
          try { j = JSON.parse(l); break; } catch {}
        }
      }
      const has = (k) => Object.prototype.hasOwnProperty.call(j, k);
      if (j && typeof j === "object" && !Array.isArray(j) && (j.is_error || j.error || j.status === "ERROR" || has("result") || has("response") || has("text") || has("content"))) {
        if (j.is_error || j.error || j.status === "ERROR") {
          return fin({ error: String(j.result || j.error?.message || j.error || j.subtype || "error").slice(0, 300) });
        }
        const txt = typeof j.result === "string" ? j.result
          : (typeof j.response === "string" ? j.response : (typeof j.text === "string" ? j.text : (typeof j.content === "string" ? j.content : "")));
        const u = j.usage || j.stats || {};
        return fin({
          text: txt,
          tin: (u.input_tokens || u.inputTokens || 0) + (u.cache_read_tokens || u.cache_read_input_tokens || u.cachedContentTokenCount || 0) + (u.cache_creation_input_tokens || 0),
          tout: u.output_tokens || u.outputTokens || 0,
        });
      }
      if (code === 0 && cleanOut) return fin({ text: cleanOut, tin: 0, tout: 0 });
      return fin({ error: (cleanErr || cleanOut).trim().slice(-300) || "no output" });
    });
  });
  if (printRes?.error && isEligibilityErr(printRes.error) && !(own && JOB.stop)) {
    if (P?.login) AGY_PRINT_INELIGIBLE = true;
    log("[backfill] agy -p 触发地区资格限制，自动改走一次性 agy acp 通道");
    return askViaAcpOneShot(agyPrompt, { env, provider: P, model: o.model || "", own });
  }
  return printRes;
}

// ── 任务 ──

const JOB = { running: false, stop: false, child: null, sessions: 0, total: 0, done: 0, ok: 0, skipped: 0, failed: 0, tin: 0, tout: 0, cur: "", error: "", startedAt: 0, endedAt: 0 };
const jobState = () => { const { child, stop, ...s } = JOB; return s; };
const tick = () => publish({ type: "backfill", ...jobState() });

async function runSession(t) {
  const found = findSessionFile(t.id), rec = lineageCached(t.id);
  if (!found || !rec) { JOB.skipped += t.chapters.length; JOB.done += t.chapters.length; return; }
  const entry = archiveDb().sessions[t.id] || {};
  const titleOf = (n) => entry.chapters?.[n]?.title || null;
  const items = [];
  for (const n of t.chapters) {
    const open = n === t.total;
    const src = open ? await promptsFrom(found.file, n >= 2 ? rec.compacts[n - 2].off : 0)
      : digestSummary(await summaryAt(found.file, rec.compacts[n - 1].off));
    items.push({ n, open, src: src || (zh() ? "（没有可用的内容）" : "(nothing usable)"), prev: titleOf(n - 1) });
  }
  // 分批：章数、字数、纯 agy 命令行参数字节数都封顶
  const batches = planBackfillBatches(t.title, items);
  for (const b of batches) {
    if (JOB.stop) return;
    let todo = b, fix = null;
    for (let round = 0; round < 2 && todo.length && !JOB.stop; round++) {
      const r = await ask(userPrompt(t.title, todo, fix));
      if (JOB.stop) return;   // 用户点了停止：掐断的这一批不算失败，也不记错误
      if (r.error) { JOB.error = r.error; log("补档调用失败：" + r.error); break; }
      JOB.tin += r.tin; JOB.tout += r.tout;
      const got = parseTitles(r.text), next = [];
      fix = {};
      for (const it of todo) {
        if (archiveDb().sessions[t.id]?.chapters?.[it.n]?.title) { JOB.skipped++; JOB.done++; continue; }   // 跑的时候有人起了名
        const v = validateTitle(got[it.n], LAST_LANG);
        if (!v.ok) { fix[it.n] = { title: got[it.n] || "", errors: v.errors }; next.push(it); continue; }
        const w = await fileChapter(t.id, { title: v.title, chapter: it.n, by: "backfill" });
        // 预检查之后、提交之前有人起了名（#124-2）：fileChapter 同步段会拒绝，这里按「跳过」算，不算失败
        if (w.ok) JOB.ok++;
        else if ((w.errors || []).includes("chapter already titled")) JOB.skipped++;
        else JOB.failed++;
        JOB.done++;
      }
      todo = next;
      tick();
    }
    if (JOB.stop) return;
    for (const it of todo) { JOB.failed++; JOB.done++; }
    tick();
  }
}

let starting = false;
export async function startBackfill(only) {
  if (JOB.running || starting) return { ok: false, message: "running" };
  starting = true;
  try { return await start(only); } finally { starting = false; }
}
async function start(only) {
  let targets = await backfillTargets();
  if (only) targets = targets.filter((t) => t.id === only);
  if (!targets.length) return { ok: false, message: "nothing" };
  Object.assign(JOB, { running: true, stop: false, sessions: targets.length, total: targets.reduce((n, t) => n + t.chapters.length, 0), done: 0, ok: 0, skipped: 0, failed: 0, tin: 0, tout: 0, error: "", startedAt: Date.now(), endedAt: 0 });
  log(`补档开始：${JOB.sessions} 个会话、${JOB.total} 章（模型 ${SETTINGS.model || "默认"}）`);
  tick();
  (async () => {
    try {
      for (const t of targets) {
        if (JOB.stop) break;
        JOB.cur = t.id;
        await runSession(t);
        if (JOB.error && JOB.ok === 0 && JOB.done > 0) break;   // 一开始就调不通（没额度、接口坏了）：别把整批都撞一遍
      }
    } catch (e) { JOB.error = e.message; log("补档出错：" + e.message); }
    JOB.running = false; JOB.cur = ""; JOB.endedAt = Date.now();
    log(`补档结束：成功 ${JOB.ok}、跳过 ${JOB.skipped}、失败 ${JOB.failed}，用了 ${JOB.tin} / ${JOB.tout} token`);
    tick();
  })();
  return { ok: true, ...jobState() };
}

export function stopBackfill() {
  JOB.stop = true;
  if (JOB.child) killTree(JOB.child);
  return { ok: true };
}

// ── 路由：GET /api/lineage/backfill（预估 + 进度）· POST {action:"start"|"stop", session?} ──
export async function routeBackfill(req, res, u, p) {
  if (p !== "/api/lineage/backfill") return NEXT;
  if (req.method === "GET") {
    const targets = JOB.running ? [] : await backfillTargets();
    const m = currentModelInfo();
    return sendJson(res, 200, { job: jobState(), estimate: estimate(targets), model: SETTINGS.model || m.id || "", modelName: m.name || m.display_name || SETTINGS.model || "", provider: PROVIDER.label || PROVIDER.id });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
  if (b.action === "stop") return sendJson(res, 200, stopBackfill());
  if (b.action === "start") return sendJson(res, 200, await startBackfill(b.session ? String(b.session) : null));
  return sendJson(res, 400, { error: "action" });
}
export { promptsFrom as _promptsFrom, summaryAt as _summaryAt };   // 测试用
