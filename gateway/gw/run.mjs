import fs from "node:fs";
import crypto from "node:crypto";
import { CFG, LAST_LANG, PATHS, log, tr, tz, permModeAction } from "./config.mjs";
import { SETTINGS, capList, settingsDiskCheck } from "./settings-store.mjs";
import { PERM_MODES, PROVIDER, acpAuthType, billAfterRun, hasAcpKeyChannel, hasAdcCredentials, keyOf, noteTokenDelta, providerById, providersDiskCheck } from "./providers.mjs";
import { defaultAcpCompactLine, effortLevelsOf, fetchModels, learnWindow, modelsCached, normEffort } from "./models.mjs";
import { agyEnv, currentModelInfo, safeModePerm, syncAgySettings } from "./claude.mjs";
import { abortAcpIdleBurst, acpActiveOriginRuns, acpPoolSessionForPid, isAcpToolAllowed, isAcpToolDisallowed, runAcpTurn, stopAcpBgTask } from "./acp.mjs";
import { refreshAgyQuotaSoon } from "./login.mjs";
import { expandCustomCommand } from "./commands.mjs";
import { RUNS, SESSIONS, rememberSession, runFlag, runList, runOfSession } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { clearIncomplete, markIncomplete } from "./incomplete.mjs";
import { END_HOOKS, INTERRUPTED, QUEUE, RUN_LANE, RUN_SESSIONS, abortRun, clearInterrupted, endRun, enqueue, holdLane, idleArm, idleDisarm, laneOfItem, permView, publishState, runEmit, runTag, saveRunMark, setInterrupted, setPermMode, sidForItem } from "./queue.mjs";
import { LOCAL_CMD_RE, handleLocalCommand } from "./modelcmd.mjs";
import { latestContextTokens } from "./transcript.mjs";
import { deviceMcpAcpServer, privCall, usageAdd, usageIsPrompt } from "./usage.mjs";
import { effectiveAutoCompact } from "./stream.mjs";
import { archiveHint } from "./archive.mjs";
import { autoTitle } from "./autotitle.mjs";
import { takeAgentNote, putAgentNote, onShared, privateAgentsBase } from "./agents.mjs";
import { findSessionFile, isSessionRewinding, peekSession } from "./sessions.mjs";
import { projectById, projectDefaults, projectOfDir } from "./projects.mjs";
import { sessLostProvider, sessModel, sessProvider, setSessModel } from "./sessmodel.mjs";
import { noteManaged } from "./sessmanaged.mjs";
import { inlineImages, wantsInline } from "./inlineimg.mjs";
import { pathWatch, putPathNote, settlePathNote, takePathNote } from "./pathnote.mjs";
import { claudeSeal, sealStillValid } from "./claudeseal.mjs";
import { gwRuntimeBlocked } from "./gwpin.mjs";
import { tamperNote, tamperRecord, tamperRetell } from "./tamper.mjs";
import { SPOOF_NOTE, checkSessionAsync, integrityNote, neutralizeMarkers, sealSessionAsync, sessionAnchorAsync } from "./integrity.mjs";
import { recordExtra } from "./lineage-store.mjs";
import { refNote } from "./merge.mjs";
import { ensureManagedBridge } from "./managed-bridge.mjs";
import { projectRisks, projectTrusted, trustProject } from "./projtrust.mjs";
import { checkAppFiles } from "./appfiles.mjs";
import { pathBlocked } from "./files.mjs";
import { holdsPrivate } from "./pathguard.mjs";
// 权限确认等多久没人答就按拒绝收掉（0.6.9 审计 P1-4）。测试可用 CCAPP_PERM_WAIT_MS 改短
const PERM_WAIT_MS = Number(process.env.CCAPP_PERM_WAIT_MS) > 0 ? Number(process.env.CCAPP_PERM_WAIT_MS) : 30 * 60e3;
import { UC_SEALED, ucAfterRun, ucBeforeRun, ucKeep, ucPending, ucPutNote, ucRevert, ucSetRevertNote, ucTakeNote } from "./userconf.mjs";
import { keepProcs, killProcs, leftoverProcs, nowTicks } from "./leftover.mjs";
import { localAddr, witnessMac } from "./access.mjs";
import { sealed } from "./edition.mjs";
import { sealBlockMessage, sealCleanup, sealPrepare, sealRecheck } from "./seal.mjs";

// 必须由人回答的工具：全部放行也照问（问题、计划审批）
// 敏感操作「这一轮已允许」的范围：读屏、点按、剪贴板这类设备操作一连串连着做，按类别记；
// 密钥、会自动执行的文件，批准一次只放行同一个工具对同一个目标，不能一把解锁同类所有文件（0.6.9 审计 199 11-07）
const guardKey = (p) => (/^device:/.test(p.guard.cat) ? p.guard.cat : `${p.tool}\0${p.guard.cat}\0${p.guard.what}`);
const HUMAN_TOOLS = new Set(["AskUserQuestion", "ask_question", "ExitPlanMode", "exit_plan_mode"]);
// ACP 网关级自动压缩防抖记录：sessionId -> { at, post }，避免连续死循环压缩
const ACP_AUTOCOMPACT = new Map();

/** 这一轮在哪个目录跑：显式指定 → 接着的会话当初的 cwd（--resume 只在同一 cwd 下找得到）→ 项目目录 → 工作区 */
const isDirSync = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
// 指定了目录（请求带的、会话记着的、项目的）却不在了（被删、改名、存储卡拔了）：返回 lost，这一轮不跑。
// 以前悄悄换到工作区去跑，项目的权限 / 型号照套，读的却是工作区的 CLAUDE.md（0.6.9 审计 195-K.1）
function cwdOf(item, sessionId) {
  if (item.cwd) return isDirSync(item.cwd) ? item.cwd : { lost: item.cwd };
  if (sessionId) { const f = findSessionFile(String(sessionId)); const c = f && peekSession(f.file).cwd; if (c) return isDirSync(c) ? c : { lost: c }; }
  if (item.projectId) { const p = projectById(item.projectId); if (p) return isDirSync(p.path) ? p.path : { lost: p.path }; }
  return fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home;
}
const cwdPath = (c) => (typeof c === "string" ? c : null);

// ── 跑一轮 ────────────────────────────────────────────────────────────
// 和 HTTP 请求完全脱钩：前端断了也接着跑，结果照样落进 transcript、照样广播。
// 这一轮用哪家：定时任务指定的 → 新会话首条带来的选择（pin）→ 这个会话钉的 → 项目默认 → 全局生效的。
// 整轮都按它（地址、密钥、模型名规则）。/api/chat 入口查 Key 也用它，两边才不会各认一家（审查 #49 P2-4）
// 特权命令「这个会话都允许」：每个会话一个随机口令，经环境变量 CCAPP_PRIV_SESS 跟着这个会话的每一轮 claude 走，
// 应用在确认框里勾了「本会话都允许」就记下它（只在内存里，应用或网关重启即失效）。无人值守（定时任务）的轮次不带，
// 用户点头时没看着的任务不该沾光
const PRIV_TOK = new Map();
function privToken(run) {
  if (run.unattended) return "";
  const tok = (run.sessionId && PRIV_TOK.get(run.sessionId)) || crypto.randomBytes(16).toString("hex");
  if (run.sessionId) PRIV_TOK.set(run.sessionId, tok);
  if (PRIV_TOK.size > 500) PRIV_TOK.delete(PRIV_TOK.keys().next().value);
  return tok;
}

/**
 * 给应用作证（Priv.java chainToken）：发起特权请求的进程往上数，碰到一个看不见的祖先 anc（不可转储的 claude 或网关自己，
 * 见 android/native/nodump.c），它下面那个看得见的是 top。应用读不了它们的环境，来问网关：这是不是我起的哪一轮 claude、口令是什么。
 *   anc 是网关自己：top 得是某一轮的直接子进程（claude 本身，或套在外面的 seccomp 监督器）
 *   anc 是别的：得是某一轮的 claude（直接子进程，或监督器下面那个）
 */
export function privWitness(anc, top) {
  for (const run of RUNS.values()) {
    const c = run.child;
    if (!c || !c.pid || !run.privTok || c.exitCode !== null || c.signalCode !== null) continue;
    if (anc === process.pid ? top === c.pid : anc === c.pid || (run.claudePid > 0 && anc === run.claudePid)) return run.privTok;
  }
  // C-01：ACP 常驻池（如 idleBurst 后台推送期间）通过池内子进程查回该会话的特权口令
  const poolSid = acpPoolSessionForPid(anc, top);
  if (poolSid && PRIV_TOK.has(poolSid)) return PRIV_TOK.get(poolSid);
  return "";
}

/** 构造通过安全过滤与总长上限控制后的附加目录列表（ACP 与 Claude 分支共用，C-01） */
export function collectAddDirs(cwd, item, P) {
  const dirs = new Set();
  if (fs.existsSync(CFG.workspace) && cwd !== CFG.workspace) dirs.add(CFG.workspace);
  if (process.env.CCAPP_SHARED && fs.existsSync(process.env.CCAPP_SHARED)) dirs.add(process.env.CCAPP_SHARED);
  // 附加目录同样不许是应用私有目录、或装着它的上级（按目录身份判，别名也认得；0.6.9 审计 P0-1）
  const addOk = (d) => { try { const r = fs.realpathSync(d); return !pathBlocked(r) && !holdsPrivate(r, { workspace: false }); } catch { return false; } };
  for (const d of SETTINGS.addDirs || []) if (addOk(d)) dirs.add(d); else if (d) log(`附加目录 ${d} 不存在或在应用私有目录里，没加`);
  for (const d of item?.addDirs || []) if (typeof d === "string" && addOk(d)) dirs.add(d);
  if (onShared(cwd)) { const b = privateAgentsBase(cwd); try { fs.mkdirSync(b, { recursive: true }); dirs.add(b); } catch {} }
  const out = [];
  let dirLen = 0;
  for (const d of dirs) {
    if ((dirLen += d.length) > 24576) { log(`--add-dir 太多，从 ${d} 起没加`); break; }
    out.push(d);
  }
  return out;
}

const isLegacyHiddenProvider = (id) => typeof id === "string" && !!id && (id === "local" || providerById(id)?.group === "claude");

export function pickProvider(item) {
  // 跟的那条被撤销了也照样接上车道上首条跑出来的会话（#120-1），不然会另起一个会话
  const sid0 = sidForItem(item);
  const pdef0 = projectDefaults(item.projectId ? projectById(item.projectId) : projectOfDir(cwdPath(cwdOf(item, sid0))));
  const rec0 = sessModel(sid0);
  const resolveItemProv = (id) => (isLegacyHiddenProvider(id) ? providerById("antigravity") : (id && providerById(id)));
  return { sid0, pdef0, P: resolveItemProv(item.provider)
    || resolveItemProv(item.pin && item.pin.provider)
    || (rec0 && rec0.model != null ? sessProvider(sid0) : null)
    || resolveItemProv(pdef0.provider)
    || sessProvider(sid0) };
}

/** 这条消息按现在的设置新起一轮会用哪家、哪个模型、哪个思考强度（startRun 里取值那段的同步副本）。
 *  空闲的后台进程要被自动复用时，队列拿它和那一轮起跑时的取值比对（#120-2）：用户刚在面板里换了接口/模型，
 *  下一条普通消息就不能再悄悄交给旧进程。清单还没拉过时档位可能算得比真跑时保守，不一致只会让它照常排队，不会错塞。 */
export function execIntent(item, ctx) {
  const { sid0, pdef0, P } = ctx || pickProvider(item);
  // 模型 / 思考强度的取值顺序：本次请求指定（定时任务）→ 新会话首条带来的选择（pin）→ 这个会话单独选过的
  // → 项目默认 → 全局默认（设置页）→ 该厂商自己的默认。选过的 "" 表示「接口默认」，也算选过
  // ⚠️ 不能回落到 CFG.model：那是全局兜底（deepseek-flash），只有内置厂商能碰。
  // 首条带来的接口和会话现在的不是同一家时，会话记下的模型名不作数
  const own0 = sessModel(sid0), pin = item.pin || {};
  const own = own0 && (own0.model == null || own0.provider === P.id) ? own0 : null;
  const ownM = pin.model != null ? pin.model : own && own.model != null ? own.model : null;
  const ownE = pin.effort != null ? pin.effort : own && own.effort != null ? own.effort : null;
  let effort = item.effort || (ownE != null ? ownE : pdef0.effort || SETTINGS.effort) || "";
  // 项目默认的模型名是给项目那家的（没指定家就是全局那家），全局默认的是给全局那家的；对不上的不作数，走这家自己的默认
  const fallM = (P.id === (pdef0.provider || PROVIDER.id) ? pdef0.model : "") || (P.id === PROVIDER.id ? SETTINGS.model : "");
  let model = (item.model || (ownM != null ? ownM : fallM) || P.defaultModel || (P.explicit ? "" : CFG.model) || "").trim();
  // 原生厂商只认自家模型名；别家的名字（切厂商前留下的）宁可不传，交给 CLI 自己选
  if (P.nativeModels && model && !/^(gemini-|claude-|gpt-|opus|sonnet|haiku|fable|auto|default|best)/i.test(model)) model = "";
  model = model.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) effort = "";
  if (effort) {
    const mi = currentModelInfo(model, P);
    if (!effortLevelsOf(mi, P).includes(effort)) effort = normEffort(mi, effort, P) || "";
  }
  return { sid0, pdef0, P, model, effort };
}

/** 起进程前的确认卡多久没人答就停下（#171）：没人答时这一轮一直占着 RUNS，挡住「重启网关」，切走的新对话还找不回来。
 *  测试里改小 */
export const CARD = { timeout: 10 * 60e3 };
/** 起进程前要用户点头的卡片（项目配置、用户级配置）：借用敏感操作卡（guard），答复走同一个 /api/perm/answer。
 *  允许 → true；拒绝 → false（「拒绝并停止」同时停掉这一轮）；这期间点了停止、或超时 → null。
 *  超时：按停止收尾，记一条中断记录（why: card），界面在那个会话（没建会话的在新对话页）给「重发」 */
export function askCard(run, emit, { key, tool, input, guard, what, yes, no }) {
  return new Promise((resolve) => {
    const id = `ccapp-${key}-` + run.id;
    const p = { id, tool, input, suggestions: [], at: Date.now(), runId: run.id, sessionId: run.sessionId || null, guard };
    const timer = setTimeout(() => {
      if (!run.perms?.has(id)) return;
      log(`${runTag(run)} ⏹ ${what}：${Math.round(CARD.timeout / 60e3)} 分钟没人确认，这一轮停下`);
      holdLane(run); run.aborted = true;
      setInterrupted([...INTERRUPTED.filter((e) => e.id !== run.id),
        { id: run.id, sessionId: run.sessionId || null, text: String(run.text || "").slice(0, 64 << 10), ...(String(run.text || "").length > 64 << 10 ? { textCut: true } : {}),
          ...(run.req && Object.keys(run.req).length ? { req: run.req } : {}), startedAt: run.startedAt, at: Date.now(), why: "card" }]);   // 同运行标记（195-AA.5）
      emit({ type: "perm_resolved", id, behavior: "cancel" });
      done(null);
    }, CARD.timeout);
    timer.unref?.();
    const done = (v) => {
      if (!run.perms?.delete(id)) return;
      clearTimeout(timer);
      run.readyAbort = null; run.answerPerm = null;
      publishState();
      resolve(v);
    };
    run.perms = new Map([[id, p]]);
    run.readyAbort = new AbortController();
    run.readyAbort.signal.addEventListener("abort", () => { emit({ type: "perm_resolved", id, behavior: "cancel" }); done(null); });
    run.answerPerm = (pid, a) => {
      if (pid !== id || !run.perms?.has(id)) return false;
      const allow = a.behavior === "allow";
      log(`${allow ? yes : no} ${what}${a.interrupt ? "（并停止）" : ""}`);
      emit({ type: "perm_resolved", id, behavior: allow ? "allow" : "deny", interrupt: !!a.interrupt });
      if (a.interrupt) { holdLane(run); run.aborted = true; }
      done(allow);
      return true;
    };
    log(`⏸ 等确认 ${what}`);
    emit({ type: "perm_request", ...p });
    publishState();
  });
}
// 一轮结束：比一比运行期间改了哪些用户级配置（见 userconf.mjs）。头一轮开跑时才挂：queue.mjs 和这里互相引用，模块加载时它还没初始化
let ucHooked = false;

const askProjectTrust = (run, cwd, proj, emit) => askCard(run, emit, { key: "proj", tool: "ProjectConfig", input: { dir: cwd, risks: proj.risks },
  guard: { cat: "project", what: cwd }, what: `项目配置 ${proj.risks.length} 项`, yes: "✓ 允许", no: "✗ 不加载" });

function activeRunStarts(excludeRunId) {
  const active = new Map([...RUNS].filter(([k]) => k !== excludeRunId).map(([k, r]) => [String(k), r.childStart ?? null]));
  for (const [rid, t0] of acpActiveOriginRuns()) {
    if (!active.has(rid) || (t0 != null && active.get(rid) == null)) active.set(rid, t0);
  }
  return active;
}

async function checkUcAndLeftovers(run, emit) {
  const ucp = ucPending(sealed() ? UC_SEALED : null);
  const procs = leftoverProcs(activeRunStarts(run.id));
  if (!ucp && !procs.length) return null;
  if (run.unattended || run.auto) {
    const msg = tz("Antigravity CLI 的用户级配置有改动还没确认，或者之前的对话留下了后台进程，这次没有运行。打开 hachimia 发一条消息，在弹出的卡片里确认后再试。");
    log(`⏭ 用户级配置 / 留下的进程没确认，${run.auto ? "空闲压缩" : "无人值守的这一轮"}不跑`);
    if (!run.auto) emit({ type: "error", message: tr(LAST_LANG, msg) });
    return endRun(run, run.auto ? { durationMs: 0 } : { failed: true, finalText: msg });
  }
  const ok = await askCard(run, emit, { key: "uc", tool: "UserConfig", input: { first: !!ucp?.first, changes: ucp?.changes || [], procs },
    guard: { cat: "userconf", what: "~/.claude" }, what: `用户级配置 ${ucp?.rels.length || 0} 项、留下的进程 ${procs.length} 个`, yes: "✓ 保留", no: "✗ 撤销" });
  if (ok) {
    const stale = ucp ? ucKeep(ucp.rels, ucp.ticket) : [];
    keepProcs(procs);
    if (stale.length) {
      emit({ type: "error", message: tr(LAST_LANG, tz("用户级配置在确认之后又被改了，这一轮没有启动：{list}。再发一条消息，在弹出的卡片里确认。", { list: stale.slice(0, 6).join(", ") })) });
      return endRun(run, { failed: true });
    }
  } else if (ok === false) {
    const r = ucp ? ucRevert(ucp.rels) : { failed: [] };
    if (procs.length) killProcs(procs);
    ucSetRevertNote(ucp?.rels, procs.length);
    if (r.failed.length && !run.aborted) {
      emit({ type: "error", message: tr(LAST_LANG, tz("有 {n} 项没法还原（确认时没留副本，或者副本也被改了），这一轮没有运行：{list}", { n: r.failed.length, list: r.failed.slice(0, 6).join(", ") })) });
      return endRun(run, { failed: true });
    }
  }
  if (run.aborted) { log("⏹ 等用户级配置确认时停止"); return endRun(run, { durationMs: 0 }); }
  return null;
}

function prepareSealAndUc(run, cwd, P, emit) {
  if (!ucHooked) { ucHooked = true; END_HOOKS.push((r) => ucAfterRun(r)); END_HOOKS.push((r) => sealCleanup(r.id)); }
  let prep = null;
  if (sealed()) {
    try { prep = sealPrepare({ cwd, runId: run.id, outputStyle: SETTINGS.outputStyle || "" }); }
    catch (e) { log(`[封口] 准备回填失败：${e.message}`); prep = { block: { found: [{ name: "(hachimia)", hits: [{ line: 0, excerpt: e.message }] }] } }; }
    if (prep.block) {
      log(`${runTag(run)} ⛔ [封口] 配置校验未通过，不跑：${prep.block.found.slice(0, 4).map((f) => f.name).join(", ")}`);
      const msg = tr(LAST_LANG, sealBlockMessage(prep.block));
      emit({ type: "error", message: msg });
      return { blocked: endRun(run, { failed: true, finalText: msg }), prep: null };
    }
    for (const n of prep.notes || []) log(`[封口] ${n}`);
  }
  const drift = ucBeforeRun(run, sealed() ? UC_SEALED : null);
  if (drift.length) {
    emit({ type: "error", message: tr(LAST_LANG, tz("用户级配置在确认之后又被改了，这一轮没有启动：{list}。再发一条消息，在弹出的卡片里确认。", { list: drift.slice(0, 6).join(", ") })) });
    return { blocked: endRun(run, { failed: true }), prep };
  }
  const late = prep ? sealRecheck(prep) : null;
  if (late) {
    log(`${runTag(run)} ⛔ [封口] 起进程前记忆目录校验未通过：${late.found.slice(0, 4).map((f) => f.name).join(", ")}`);
    const msg = tr(LAST_LANG, sealBlockMessage(late));
    emit({ type: "error", message: msg });
    return { blocked: endRun(run, { failed: true, finalText: msg }), prep };
  }
  return { blocked: null, prep };
}

/** 日志里怎么称呼一条用户消息：诊断包承诺不含消息内容，提问只记字数，斜杠命令只记命令名（FIND-046）。
 *  以前记前 60 字，原生打包虽然会抹掉整行，但日志文件本身已经把正文写进去了。 */
export function promptLogLine(message, isCmd) {
  const s = String(message || "").trim();
  return isCmd ? `命令 ${s.split(/\s+/)[0].slice(0, 24)}` : `提问（${s.length} 字）`;
}

/** 这一轮本该用的那家已经不在了：返回说明（不在就不跑），否则 ""。
 *  pickProvider 找不到指定的那家会一路退到全局默认——全局可能是订阅账户，会话内容、交给它的材料就换了一家发出去。
 *  顺序同 pickProvider：定时任务指定的 → 新会话首条带来的 → 会话钉的 → 项目默认 */
export function lostProvider(item, sid0, pdef0) {
  const gone = (id) => typeof id === "string" && id && !isLegacyHiddenProvider(id) && !providerById(id);
  if (item.provider) return gone(item.provider) ? tz("指定的接口「{id}」不存在，这一轮没有发出去。", { id: item.provider }) : "";
  if (item.pin && item.pin.provider) return gone(item.pin.provider) ? tz("指定的接口「{id}」不存在，这一轮没有发出去。", { id: item.pin.provider }) : "";
  const s = sessLostProvider(sid0);
  if (s) return tz("这个会话原来用的接口「{id}」已经删掉了，这一轮没有发出去。在模型面板里换一家再发。", { id: s });
  if (sessModel(sid0)) return "";
  if (pdef0 && gone(pdef0.provider)) return tz("项目默认的接口「{id}」已经删掉了，这一轮没有发出去。到项目设置里重新选个接口。", { id: pdef0.provider });
  return "";
}

/** ACP 新会话拿到会话号时记账（B6）：
 *  记 RUN_SESSIONS、受管会话（防归入杂项）、首轮模型钉选 pin（防次轮掉回全局默认）、
 *  汇合来源 mergeFrom 与 SESSIONS 内存集（防首轮落盘前排队消息被 pump 误判已删）。 */
export function noteAcpInit(run, sessionId, item = null) {
  if (!run || !sessionId) return;
  run.sessionId = sessionId;
  noteManaged(sessionId);
  RUN_SESSIONS.set(run.id, sessionId);
  if (RUN_SESSIONS.size > 500) RUN_SESSIONS.delete(RUN_SESSIONS.keys().next().value);
  if (run.privTok && !PRIV_TOK.has(sessionId)) PRIV_TOK.set(sessionId, run.privTok);
  markIncomplete(sessionId, run.id);
  for (const e of run.log || []) if (e.type === "run_start" && !e.sessionId) e.sessionId = sessionId;
  rememberSession(sessionId);
  if (item?.pin && !run.pinSaved) {
    run.pinSaved = true;
    setSessModel(sessionId, item.pin, item.projectId);
  }
  if (item?.mergeFrom && !item.sessionId) {
    recordExtra(sessionId, item.mergeFrom);
    item.mergeFrom = null;
  }
  if (!SESSIONS.has(sessionId)) {
    SESSIONS.set(sessionId, { id: sessionId, title: String(run.text || "").slice(0, 60), createdAt: Date.now() });
    if (SESSIONS.size > 5000) SESSIONS.delete(SESSIONS.keys().next().value);
  }
  saveRunMark();
  publishState();
}

/** ACP 回合走到结果时清「未完成」标记（B7）：claude 路径在 onResult 里清，ACP 分支以前全程不清，
 *  成功后历史页还永久挂「上一轮没有正常结束」。用户主动停止（aborted）的不清，留着给「继续」卡。 */
export function clearAcpTurnMarkers(run, acpRes) {
  const sid = run?.sessionId || acpRes?.sessionId;
  if (!sid || run?.aborted) return;
  clearIncomplete(sid);
  if (acpRes?.ok && run?.intrPending) {
    run.intrPending = false;
    clearInterrupted(sid);
  }
}

/** ACP 轮后自动压缩线（C9-2）：用户显式设的线优先，否则按 ACP 默认线
 * defaultAcpCompactLine（窗口八成、给总结留 40k，原生厂商也适用）。
 * agy 不读 CLAUDE_CODE_AUTO_COMPACT_WINDOW，只认 effectiveAutoCompact() 时，
 * 默认配置下 ACP 模式就没有任何阈值压缩保护。 */
export function acpAutoCompactLine(ctxWin, p) {
  return effectiveAutoCompact() ?? defaultAcpCompactLine(ctxWin, p);
}

/** /autocompact 设线后“立即触发”适用的厂商：纯 agy 模式下全部适用 */
export function autocompactImmediateApplies(P) {
  return !!P;
}

/** ADC 厂商发 ACP 轮次前的前置检查（MIG-11）：缺凭据时直接报错并给出
 *  gcloud 指引，不等首轮 agy 报原文错。返回 "" 表示放行。 */
export function adcMissingError(P) {
  if (!P || !(P.authType === "agent-platform" || P.authStyle === "adc")) return "";
  return hasAdcCredentials() ? "" : tz("没有找到 Google Cloud ADC 凭据（Application Default Credentials）。请先在终端运行 gcloud auth application-default login 登录，再回来选 ADC。");
}

/** C5-2：把 ACP 轮的 usage_update.size（即 acpRes.usage.context_window）喂给 learnWindow。
 * 纯 agy 模式下这是唯一的窗口学习来源——不喂，解析时记 0 的窗口永远纠正不了，
 * 上下文条与自动压缩线就一直按未知窗口算。 */
export function feedAcpWindow({ model: modelId, contextWindow, provider }) {
  const win = Number(contextWindow) || 0;
  const id = String(modelId || "").trim();
  if (!win || !id) return false;
  // MIG-2：返回 learnWindow 是否真的写入——守卫拒掉时不得谎报 true。
  return learnWindow({ modelUsage: { [id]: { contextWindow: win, maxOutputTokens: 0 } } }, provider);
}

export async function startRun(item) {
  const { sid0, pdef0, P } = pickProvider(item);
  const KEY = keyOf(P);
  const run = {
    id: item.id,
    text: item.message,
    // 跟在一个还没拿到会话号的新会话后面排队的：等前一条 init 了再接上它的会话；
    // 跟的那条中途被撤销、从没启动时，按车道找回首条已经跑出来的会话（#120-1）
    sessionId: sidForItem(item),
    follow: item.follow,
    cid: item.cid,
    auto: item.auto || null,           // "idle" = 网关自己发起的空闲压缩（界面画成系统提示，不发通知）
    startedAt: Date.now(),
    child: null, aborted: false, ended: false, preSpawn: true,
    provider: P.id,                    // 这一轮用的那家：记 token、删接口前查占用都看它
    log: [], pend: null, pendTimer: null,
    sched: item.sched || null,         // 定时任务跑的：{ taskId, runKey }（结束时 sched.mjs 记运行记录）
    unattended: !!item.unattended,     // 没人看着：要确认的一律拒绝
    // 被系统结束后「重发」要按原样发：项目、钉的模型、权限模式、附加目录、汇合来源都记进运行标记（0.6.9 审计 195-AA.5）
    req: Object.fromEntries(Object.entries({ projectId: item.projectId, pin: item.pin, model: item.model, permissionMode: item.permissionMode,
      addDirs: item.addDirs && item.addDirs.length ? item.addDirs : null, mergeFrom: item.mergeFrom }).filter(([, v]) => v != null)),
  };
  // 进程起来之前（拉模型、问设备工具、读建档提示都要等）用户改权限模式：先记下来，起进程时按最新的那个启动；
  // 起来后由下面真的 setMode 接手（审查 v0.5.20 02-001：以前这段时间收紧会被开头读的旧模式盖掉，新进程照样全部放行）
  run.setMode = (mode) => { mode = safeModePerm(mode); run.permMode = mode; return true; };
  run.lane = laneOfItem(item);
  RUNS.set(run.id, run);                 // 同步占槽，中间不许有 await
  RUN_LANE.set(run.id, run.lane);
  if (RUN_LANE.size > 1000) for (const k of [...RUN_LANE.keys()].slice(0, 500)) if (!RUNS.has(k)) RUN_LANE.delete(k);
  runFlag(true);
  // 在被中断的那个会话里又跑起来了（点了「继续」或者直接接着聊）：等这一轮真答出来再撤中断提示。
  // 以前一开跑就撤，「继续」起不来、空完成时卡片已经没了，用户不知道没跑（0.6.9 审计 195-R.1）。跑着时界面本来就不显示这张卡
  run.intrPending = !!run.sessionId && INTERRUPTED.some((e) => e.sessionId === run.sessionId);
  if (run.sessionId) { RUN_SESSIONS.set(run.id, run.sessionId); idleDisarm(run.sessionId); }
  if (run.sessionId) markIncomplete(run.sessionId, run.id);   // 这一轮开跑：先记上，拿到结果再清（FIND-040）
  const emit = (ev) => runEmit(run, ev);
  emit({ type: "run_start", text: run.text, sessionId: run.sessionId, follow: run.follow, cid: run.cid, startedAt: run.startedAt, ...(run.auto ? { auto: run.auto } : {}) });
  publishState();

  const message = run.text;
  const local = message.trim().match(LOCAL_CMD_RE);
  if (local) {
    local[1] = local[1].toLowerCase();   // /MODEL 也是网关的（复核 v067b-4）
    log(`⌘ 本地命令 /${local[1]}`);   // 参数不记：诊断包说了不含消息内容（审查 v0.5.20 08-001）
    return handleLocalCommand(local[1], (local[2] || "").trim(),
      async (text, cmd) => {
        const resEnd = endRun(run, { localCommand: cmd || local[1], resultText: text, durationMs: 0, costUsd: 0 });
        // 用户通过 /autocompact <n> 设了压缩线且当前会话上下文已超线：ACP 模式下立即自动排一次 /compact
        const acLine = (cmd === "autocompact" || local[1] === "autocompact") && (local[2] || "").trim() ? effectiveAutoCompact() : null;
        if (acLine && run.sessionId && autocompactImmediateApplies(P)) {
          try {
            const sf = findSessionFile(run.sessionId);
            const curCtx = sf ? await latestContextTokens(sf.file) : 0;
            if (curCtx >= acLine) {
              log(`🗜 /autocompact 立即触发压缩：会话 ${run.sessionId.slice(0, 8)} 当前 ${curCtx} ≥ 压缩线 ${acLine}`);
              enqueue({ message: "/compact", sessionId: run.sessionId, auto: "autocompact", front: true });
            }
          } catch {}
        }
        return resEnd;
      }, run.sessionId, () => run.aborted);
  }

  const lost = lostProvider(item, sid0, pdef0);
  if (lost) {
    log(`${runTag(run)} ⛔ 这一轮要用的接口不在了，没有启动（不退回全局默认）`);
    emit({ type: "error", message: tr(LAST_LANG, lost) });
    return endRun(run, { failed: true });
  }
  if (P.endpointLost) {
    emit({ type: "error", message: tr(LAST_LANG, tz("{name} 原来选的线路「{ep}」已经不在了。请到设置里重选线路，并重新填这条线路的密钥。", { name: P.label || P.id, ep: P.endpointLost })) });
    return endRun(run, { failed: true });
  }
  if (!KEY && !P.login) {
    emit({ type: "error", message: tr(LAST_LANG, tz("未配置 API 密钥。请在设置里填入 {name} 的密钥。", { name: P.label || P.id })) });
    return endRun(run, { failed: true });
  }
  // MIG-9（rem-C2 方案 b）：无 key 通道的第三方厂商在发消息前就拦截，别等模型调用才报 agy 原文错。
  if (KEY && !hasAcpKeyChannel(P)) {
    emit({ type: "error", message: tr(LAST_LANG, tz("该接口在 Antigravity 下暂不支持：需配置 protocol:\"gemini\"（Gemini 协议端点），或改用 Google 登录。")) });
    return endRun(run, { failed: true });
  }
  const cliBin = PATHS.agy;
  if (!cliBin || !fs.existsSync(cliBin)) {
    emit({ type: "error", message: tr(LAST_LANG, tz("Antigravity CLI (agy) 未安装。到 设置 → 更新 里点「安装」即可。")) });
    return endRun(run, { failed: true });
  }
  if (run.aborted) return endRun(run, {});
  run.readyAbort = new AbortController();
  try {
    await ensureManagedBridge(P, { signal: run.readyAbort.signal });
  } catch (e) {
    if (!run.aborted) emit({ type: "error", message: tr(LAST_LANG, e.message) });
    return endRun(run, { failed: !run.aborted });
  } finally { run.readyAbort = null; }
  if (run.aborted) return endRun(run, {});

  const cwd0 = cwdOf(item, run.sessionId);
  if (typeof cwd0 !== "string") {
    const msg = tz("工作目录 {dir} 不在了（被删、改名或存储卡拔出了），这一轮没有运行。把目录放回去，或者到项目设置里改路径后再发。", { dir: cwd0.lost });
    log(`${runTag(run)} ⛔ 工作目录不在了：${cwd0.lost}`);
    emit({ type: "error", message: tr(LAST_LANG, msg) });
    return endRun(run, { failed: true, finalText: msg });
  }
  const cwd = cwd0;
  run.cwd = cwd;
  const pdef = projectDefaults(item.projectId ? projectById(item.projectId) : projectOfDir(cwd));
  if (!item.permissionMode && pdef.perm) item.permissionMode = pdef.perm;
  // 模型 / 思考强度的取值顺序见 execIntent（这里的取值和队列判断能否复用空闲进程时用的是同一份）
  let { model, effort } = execIntent(item, { sid0, pdef0: pdef, P });
  // 别家的清单拉一次（10 分钟缓存）：窗口、档位映射要用。思考强度是跟着全局 / 项目来的、这家模型不支持时，换成它支持的
  // 全局那家也一样：没打开过设置 / 型号清单时冷缓存里没有窗口，claude 只能按 200k 跑（#57）。拉过的就后台刷新，不让这一轮干等
  // 已经知道这个型号的窗口（拉过清单、或配置里的内嵌清单 / fallbackModels 写了）就不等：离线时首轮别干等 15 秒（v0514 复核）
  {
    const known = modelsCached(P) || Number(currentModelInfo(model, P).context_window) > 0;
    if (P.id !== PROVIDER.id || !known) await fetchModels(false, P).catch(() => {});
    else fetchModels(false, P).catch(() => {});
    // 清单可能刚拉到 / 刚刷新：档位按最新的表再校准一次（和以前一样，以取完清单为准）
    if (effort) {
      const mi = currentModelInfo(model, P);
      if (!effortLevelsOf(mi, P).includes(effort)) effort = normEffort(mi, effort, P) || "";
    }
  }
  // 这一轮起跑时的执行配置：后台轮次还留着进程时，队列据此判断下一条消息能不能自动塞进来（#120-2）
  run.exec = { provider: P.id, model: model || "", effort: effort || "" };
  let permMode = String(run.permMode || item.permissionMode || SETTINGS.permissionMode || "default").trim();
  if (!PERM_MODES.includes(permMode)) permMode = "default";
  // 安全模式下钩子全不跑（敏感操作再确认也没了），不问人的几档退回 default
  if (safeModePerm(permMode) !== permMode) { log(`安全模式：权限模式 ${permMode} → default`); permMode = safeModePerm(permMode); }
  run.permMode = permMode;

  // ── hachimia: Antigravity CLI (`agy acp`) JSON-RPC 2.0 通道 ──
  // MIG-11：ADC 厂商发轮次前先查凭据文件，缺失时前置报错（不等首轮 agy 原文报错）
  const adcErr = adcMissingError(P);
  if (adcErr) {
    emit({ type: "error", message: tr(LAST_LANG, adcErr) });
    return endRun(run, { failed: true, finalText: tr(LAST_LANG, adcErr) });
  }
  const isCmd = message.trim().startsWith("/");
  // C-01：与 Claude 分支对齐的起轮前安全门禁
  if (isSessionRewinding(run.sessionId)) {
    const msg = tr(LAST_LANG, tz("这个会话正在生成中。"));
    emit({ type: "error", message: msg });
    return endRun(run, { failed: true, finalText: msg });
  }
  checkAppFiles();
  for (const [f, chk] of [["ccapp-settings.json", settingsDiskCheck], ["ccapp-providers.json", providersDiskCheck]]) {
    if (chk()) tamperRecord("runtime", [f]);
  }
  {
    const gwBad = gwRuntimeBlocked();
    if (gwBad) {
      const msg = tr(LAST_LANG, gwBad);
      emit({ type: "error", message: msg });
      return endRun(run, { failed: true, finalText: msg });
    }
    const seal = await claudeSeal(cliBin);
    if (seal.ok === false) {
      const msg = tr(LAST_LANG, seal.pending
        ? tz("这个版本的 Antigravity CLI 还没有官方签名清单，这一轮没有启动。正在联网补核，过一两分钟再发送；一直不行就到 设置 → 更新 里重新安装。")
        : tz("Antigravity CLI 程序和官方签名清单对不上，可能被改过，这一轮没有启动。到 设置 → 更新 里重新安装后再试。"));
      emit({ type: "error", message: msg });
      return endRun(run, { failed: true, finalText: msg });
    }
    if (run.aborted) { log("⏹ 核验 Antigravity CLI 时停止"); return endRun(run, { durationMs: 0 }); }
  }
  const ucStopped = await checkUcAndLeftovers(run, emit);
  if (ucStopped) return ucStopped;
  const proj = sealed() ? null : projectRisks(cwd);
  if (proj && !projectTrusted(cwd, proj.fp)) {
    const ok = run.unattended || run.auto ? false : await askProjectTrust(run, cwd, proj, emit);
    if (run.aborted) { log("⏹ 等项目配置确认时停止"); return endRun(run, { durationMs: 0 }); }
    if (ok) {
      trustProject(cwd, proj.fp);
    } else {
      log(`⚠️ [ACP] 项目级自动配置未获信任（${run.unattended || run.auto ? "无人值守" : "用户未同意"}，${proj.risks.length} 项），拦截本轮`);
      const msg = tr(LAST_LANG, tz("这个项目带有会自动运行的配置，尚未信任，这一轮没有启动。"));
      emit({ type: "error", message: msg });
      return endRun(run, { failed: true, finalText: msg });
    }
  }
  const sfile = () => run.sessionId ? findSessionFile(String(run.sessionId), run.cwd)?.file : null;
  let integ = await checkSessionAsync(run.sessionId, sfile());
  let integNote = isCmd ? "" : integrityNote(integ);
  run.sealBase = run.sessionId ? { sid: run.sessionId, ...(await sessionAnchorAsync(sfile())) } : null;
  if (run.sealBase) saveRunMark();
  if (run.aborted) { log("⏹ 起进程前已停止"); return endRun(run, { durationMs: 0 }); }

  const allowed = capList([...(SETTINGS.allowedTools || []), ...(Array.isArray(item.allowedTools) ? item.allowedTools : [])], 400, 512, 8192);
  const disallowed = capList([...(SETTINGS.disallowedTools || []), ...(Array.isArray(item.disallowedTools) ? item.disallowedTools : [])], 400, 512, 8192);
  const addDirsList = collectAddDirs(cwd, item, P);

  // C-01：内置设备工具接入 ACP mcpServers（targetSdk 36 下经 linker64 + gwNode 拉起）
  const acpMcpServers = [];
  const devMcpEntry = deviceMcpAcpServer(process.env);
  if (devMcpEntry && (await privCall({ op: "dev_status" }, 3000)).on) acpMcpServers.push(devMcpEntry);
  if (run.aborted) { log("⏹ 查设备工具时停止"); return endRun(run, { durationMs: 0 }); }

  const sealGate = prepareSealAndUc(run, cwd, P, emit);
  if (sealGate.blocked) return sealGate.blocked;
  if (!integ) { integ = await checkSessionAsync(run.sessionId, sfile()); if (integ) integNote = isCmd ? "" : integrityNote(integ); }
  run.sealBase = run.sessionId ? { sid: run.sessionId, ...(await sessionAnchorAsync(sfile())) } : null;
  if (run.sealBase) saveRunMark();
  if (run.aborted || run.ended) { log("⏹ 起进程前已停止"); return endRun(run, { durationMs: 0 }); }

  const tBoot = Date.now();
  run.tBoot = tBoot;
  run.turnStartTicks = nowTicks();
  run.paths = pathWatch();
  run.bgList = [];
  run.bgTasks = 0;
  run.stopTask = (taskId) => {
    const dropped = run.dropAcpBg ? run.dropAcpBg(taskId) : false;
    const ok = dropped || stopAcpBgTask(run.sessionId, taskId);
    run.bgList = (run.bgList || []).filter((x) => x.id !== taskId);
    run.bgTasks = run.bgList.length;
    publishState();
    return ok;
  };
  emit({ type: "phase", phase: "boot" });
  // C-05 + C-01：仅组环境（sync:false），冷启动时在 ACP 串行锁内同步 settings.json，同时透传特权会话口令
  const acpEnv = {
    ...agyEnv({ model, provider: P, sync: false }),
    CCAPP_RUN_ID: String(run.id),
    CCAPP_GW_PORT: String(CFG.port),
    CCAPP_GW_PID: String(process.pid),
    ...((run.privTok = privToken(run)) ? { CCAPP_PRIV_SESS: run.privTok } : {}),
  };
  // C-01 + W3-F4：非内部唤醒的用户输入先经 neutralizeMarkers 脱敏；自定义常用指令（commands/*.md）展开后视为普通自然语言提示词，
  // 走完整 <system-reminder> 附注、多模态附图与首轮自动标题管线（原生 /compact、/goal、/plan 保持干净）
  let displayMsg = message;
  let acpPrompt = message;
  let isSlashCmd = isCmd;
  const back = { tamper: [], path: "", uc: "", agent: [] };
  run.giveNotesBack = () => {
    run.giveNotesBack = null;
    if (back.tamper.length) tamperRetell(back.tamper);
    putPathNote(run.sessionId, back.path);
    ucPutNote(back.uc);
    if (back.agent.length) putAgentNote(run.cwd, run.sessionId, back.agent.join("\n"));
    if (back.tamper.length || back.path || back.uc || back.agent.length) log("这一轮没送到模型：提醒放回去，下一轮再带");
  };
  if (!run.auto) {
    const cleanMsg = neutralizeMarkers(message);
    let isSpoofed = cleanMsg !== message;
    displayMsg = cleanMsg;
    const cmdExp = expandCustomCommand(cleanMsg, cwd);
    if (cmdExp.expanded) {
      log(`⌘ 展开常用指令 /${cmdExp.name}`);
      isSlashCmd = false;
      integNote = integrityNote(integ);
      if (!cmdExp.builtin) {
        const safeExp = neutralizeMarkers(cmdExp.text);
        if (safeExp !== cmdExp.text) isSpoofed = true;
        acpPrompt = safeExp;
      } else {
        acpPrompt = cmdExp.text;
      }
    } else {
      acpPrompt = cmdExp.text;
    }
    if (!isSlashCmd) {
      back.path = takePathNote(run.sessionId);
      const tamperN = run.unattended ? "" : tamperNote(back.tamper);
      const ucN = back.uc = run.unattended ? "" : ucTakeNote();
      const agentN = takeAgentNote(run.cwd, run.sessionId);
      if (agentN) back.agent.push(agentN);
      const arch = await archiveHint(run.sessionId).catch(() => null);
      const refN = await refNote(cleanMsg, run.sessionId).catch((e) => { log("档号引用失败: " + e.message); return ""; });
      const notes = [isSpoofed ? SPOOF_NOTE : "", tamperN, ucN, integNote, arch?.note, back.path, refN, agentN].filter(Boolean);
      if (notes.length) acpPrompt = `${acpPrompt}\n\n<system-reminder>\n${notes.join("\n\n")}\n</system-reminder>`;
    }
  }
  // 消息里提到的图片（@路径）在厂商启用 inlineImages 时转成 image block 交给 ACP（C-06 / W3-F4）
  let acpImages = [];
  if (!isSlashCmd && wantsInline(P)) {
    acpImages = await inlineImages(acpPrompt, P, { tmpDir: acpEnv.TMPDIR, env: acpEnv }).catch(() => []);
  }
  // 等待用户配置/项目信任/图片等异步步骤期间，用户可能已停止或收紧权限模式：启动前统一复核（对齐 Claude 分支）
  if (run.aborted || run.ended) {
    run.giveNotesBack?.();
    log("⏹ 起进程前已停止");
    return endRun(run, { durationMs: 0 });
  }
  if (run.permMode !== permMode && PERM_MODES.includes(run.permMode)) {
    run.permMode = safeModePerm(run.permMode);
    log(`权限模式在起进程前改了：${permMode} → ${run.permMode}`);
    permMode = run.permMode;
  }
  if (!sealStillValid(cliBin)) {
    run.giveNotesBack?.();
    log(`${runTag(run)} ⚠️ [Antigravity CLI 核验] 核过之后程序文件又变了，停掉这一轮`);
    tamperRecord("agy", ["agy: changed right after it was verified"]);
    const msg = tr(LAST_LANG, tz("Antigravity CLI 程序和官方签名清单对不上，可能被改过，这一轮没有启动。到 设置 → 更新 里重新安装后再试。"));
    emit({ type: "error", message: msg });
    return endRun(run, { failed: true, finalText: msg });
  }
  if (item.timeoutMs > 0) {
    run.limitTimer = setTimeout(() => {
      run.timedOut = true;
      log(`${runTag(run)} ⏱ 超过时长上限 ${Math.round(item.timeoutMs / 60000)} 分钟，停止`);
      abortRun(run);
    }, item.timeoutMs);
  }
  // ACP init 事件一到就记账（B6）：别等整轮跑完才有会话号，首轮进行中跟发的消息要靠它续进同一会话
  const hadAcpSid = !!run.sessionId;
  const acpEmit = (ev) => {
    if (ev?.type === "init" && ev.sessionId) noteAcpInit(run, ev.sessionId, item);
    if (ev?.type === "tool_use" || (ev?.type === "tool_update" && ev.input && Object.keys(ev.input).length)) {
      run.paths?.feed({ type: "assistant", message: { content: [{ type: "tool_use", name: ev.name, input: ev.input }] } });
    } else if (ev?.type === "text_delta" && ev.text) {
      run.paths?.feedDelta(ev.text);
    }
    emit(ev);
  };
  log(`▶ [ACP] ${runTag(run)} ${promptLogLine(displayMsg, isSlashCmd)}  ${run.sessionId ? `(续 ${String(run.sessionId).slice(0, 8)})` : "(新会话)"}  [model=${model || "默认"} effort=${effort || "默认"} perm=${permMode}${run.auto ? ` auto=${run.auto}` : ""}]`);
  const acpRes = await runAcpTurn({
    bin: cliBin,
    cwd,
    env: acpEnv,
    prompt: acpPrompt,
    displayPrompt: displayMsg,
    images: acpImages,
    sessionId: run.sessionId,
    model,
    effort,
    permMode,
    authType: acpAuthType(P),
    apiKey: KEY || "",
    mcpServers: acpMcpServers,
    addDirs: addDirsList,
    extraEnv: P.extraEnv || null,
    extraModels: P.extraModels || null,
    syncSettings: () => syncAgySettings(P, KEY),
    disallowedTools: disallowed,
    allowedTools: allowed,
    run,
    emit: acpEmit,
    onBgChange: () => publishState(),
    onBgWake: ({ sessionId: sid, tasks }) => {
      if (!sid || runOfSession(sid)) return;
      if (QUEUE.some((q) => !q.held && sidForItem(q) === sid)) return;
      const ids = (tasks || []).map((t) => String(t.id || "").split("/").pop()).filter(Boolean).join(", ");
      const wakeMsg = `<task-notification>Background shell task completed${ids ? ` (${ids})` : ""}. Please inspect the task result and continue.</task-notification>`;
      enqueue({
        message: wakeMsg,
        sessionId: sid,
        auto: "bg",
        internal: true,
        cwd,
        provider: P.id,
        model: model || null,
        effort: effort || null,
        permissionMode: permMode,
        projectId: item.projectId || null,
      });
    },
    onSessionFileReady: (sid) => {
      if (!hadAcpSid && !run.sched && !run.fileSeen && sid) {
        run.fileSeen = true;
        emit({ type: "session_created", sessionId: sid, runId: run.id, cwd: run.cwd });
      }
    },
    timeoutMs: item.timeoutMs || 0,
    askPermission: async ({ tool, rawName, kind, toolCallId, input, hasAlways, guard }) => {
      if (isAcpToolDisallowed(tool, kind, disallowed) || (rawName && isAcpToolDisallowed(rawName, kind, disallowed))) {
        (run.denied ||= []).push(tool);
        return { behavior: "deny" };
      }
      const isHuman = HUMAN_TOOLS.has(tool);
      if (run.unattended || run.auto) {
        if (!guard && !isHuman) {
          if (run.auto === "bg" && run.permMode === "bypassPermissions") return { behavior: "allow" };
          if (run.unattended && allowed.length && (isAcpToolAllowed(tool, kind, allowed) || (rawName && isAcpToolAllowed(rawName, kind, allowed)))) {
            return { behavior: "allow" };
          }
        }
        if (run.unattended) (run.denied ||= []).push(tool);
        return { behavior: "deny" };
      }
      if (guard && run.guardOk?.has(guardKey({ tool, guard }))) {
        log(`✓ 敏感操作本轮已允许过，放行 ACP ${tool} ${guard.cat || ""}`);
        return { behavior: "allow" };
      }
      return new Promise((resolve) => {
        const id = "acp-perm-" + crypto.randomBytes(6).toString("hex");
        const suggestions = hasAlways ? [{ type: "addRules", rules: [{ toolName: tool }] }] : [];
        const p = {
          id,
          tool,
          toolUseId: toolCallId || undefined,
          input: input || {},
          ...(guard ? { guard } : {}),
          suggestions,
          at: Date.now(),
          runId: run.id,
          sessionId: run.sessionId || null,
        };
        const timer = setTimeout(() => {
          if (!run.perms?.has(id)) return;
          log(`${runTag(run)} ⏹ ACP 权限确认超时：${tool}`);
          emit({ type: "perm_resolved", id, behavior: "deny", expired: true });
          done({ behavior: "deny" });
        }, PERM_WAIT_MS);
        timer.unref?.();
        const done = (v) => {
          if (!run.perms?.delete(id)) return;
          clearTimeout(timer);
          run._acpPermCancelers?.delete(cancelPerm);
          if (!run.perms.size) run.answerPerm = null;
          publishState();
          resolve(v);
        };
        const cancelPerm = () => {
          if (!run.perms?.has(id)) return;
          log(`${runTag(run)} ⏹ ACP 权限确认已中断：${tool}`);
          emit({ type: "perm_resolved", id, behavior: "deny", interrupt: true });
          done({ behavior: "deny", interrupt: true });
        };
        run.perms = run.perms || new Map();
        run.perms.set(id, p);
        (run._acpPermCancelers ||= new Set()).add(cancelPerm);
        run.cancelPerms = () => {
          for (const fn of [...(run._acpPermCancelers || [])]) {
            try { fn(); } catch {}
          }
        };
        const prevAnswer = run.answerPerm;
        run.answerPerm = (pid, a) => {
          if (pid !== id || !run.perms?.has(id)) return prevAnswer ? prevAnswer(pid, a) : false;
          const allow = a.behavior === "allow";
          log(`${allow ? "✓ 允许" : "✗ 拒绝"} ACP 工具 ${tool}${a.always ? "（始终）" : ""}${a.interrupt ? "（并停止）" : ""}`);
          run._acpPermCancelers?.delete(cancelPerm);
          emit({ type: "perm_resolved", id, behavior: allow ? "allow" : "deny", always: !!a.always, interrupt: !!a.interrupt });
          if (allow && p.guard) (run.guardOk ||= new Set()).add(guardKey(p));
          if (a.interrupt) { holdLane(run); run.aborted = true; }
          const act = permModeAction(allow ? "allow" : "deny", a.mode, run.permMode);
          if (act === "global") setPermMode(a.mode);
          else if (act === "run") run.setMode?.(a.mode);
          done({ behavior: allow ? "allow" : "deny", always: !!a.always, interrupt: !!a.interrupt, answers: a.answers });
          if (a.interrupt) { try { run.cancelAcp?.(); } catch {} }
          return true;
        };
        log(`⏸ 等确认 ACP 工具 ${tool}`);
        emit({ type: "perm_request", ...permView(p) });
        publishState();
      });
    },
  });
  if (acpRes.timedOut) run.timedOut = true;
  if (acpRes.sessionId) {
    noteAcpInit(run, acpRes.sessionId, item);
    if (!hadAcpSid && !run.sched && !run.fileSeen && findSessionFile(run.sessionId, run.cwd)) {
      run.fileSeen = true;
      emit({ type: "session_created", sessionId: run.sessionId, runId: run.id, cwd: run.cwd });
    }
  }
  if (!acpRes.ok && (!run.aborted || (!acpRes.toolCount && !acpRes.resultText))) {
    run.giveNotesBack?.();
  } else {
    run.giveNotesBack = null;
  }
  if (!isCmd && acpRes.ok && !run.aborted) {
    settlePathNote(run.sessionId, run.paths);
  }
  if (run.sessionId) {
    try {
      await sealSessionAsync(run.sessionId, sfile(), {
        clear: !!integNote && acpRes.ok && !run.aborted,
        base: run.sealBase?.sid === run.sessionId && run.sealBase.hash ? run.sealBase : null,
      });
    } catch (e) {
      log(`${runTag(run)} [封签] ${e.message}`);
    }
  }
  clearAcpTurnMarkers(run, acpRes);   // ACP 回合走到结果：清「未完成」标记与中断卡（B7）
  const ctxWin = Number(acpRes.usage?.context_window) || Number(currentModelInfo(model, P).context_window) || 0;
  // C5-2：把本轮 usage_update.size 学到的窗口喂给 learnWindow（纯 agy 模式唯一的学习来源）
  if (ctxWin > 0) feedAcpWindow({ model: acpRes.model || model, contextWindow: ctxWin, provider: P });
  const usageOut = acpRes.usage
    ? { ...acpRes.usage, ...(ctxWin > 0 ? { context_window: ctxWin } : {}) }
    : undefined;
  // 记入用量统计与厂商账本（供用量页、顶栏速览卡与额度明细显示）
  {
    const u = acpRes.usage || {};
    const cTok = Number(u.cache_read_input_tokens) || 0;
    const iTok = (Number(u.input_tokens) || 0) + cTok + (Number(u.cache_creation_input_tokens) || 0);
    const oTok = Number(u.output_tokens) || 0;
    const d = {};
    if (!run.auto && usageIsPrompt(message)) d.m = 1;
    if (acpRes.ok) d.t = 1;
    if (acpRes.toolCount > 0) d.tl = acpRes.toolCount;
    if (iTok > 0) d.i = iTok;
    if (oTok > 0) d.o = oTok;
    if (cTok > 0) d.c = cTok;
    if (Object.keys(d).length) {
      usageAdd(d, run.sessionId, acpRes.model || model || "antigravity");
      if (iTok > 0 || oTok > 0 || cTok > 0) noteTokenDelta(P.id, { i: iTok, o: oTok, c: cTok });
    }
    if (P.login) refreshAgyQuotaSoon();
    else billAfterRun(P.id);
  }
  // C-01 + W3-F4：首轮正常答完后在后台自动起标题（含展开后的自定义常用指令）
  if (!isSlashCmd && !run.auto && !run.sched && acpRes.ok && !run.aborted && run.sessionId) {
    autoTitle(run.sessionId, P, model);
  }
  const endRes = endRun(run, {
    failed: !acpRes.ok && !run.aborted,
    resultText: acpRes.resultText || "",
    durationMs: acpRes.durationMs || (Date.now() - tBoot),
    costUsd: 0,
    ...(usageOut ? { usage: usageOut } : {}),
    ...(run.sched ? { finalText: String(acpRes.resultText || "").slice(0, 4000), costRaw: 0 } : {}),
  });
  // ACP 网关级自动压缩（agy 不读取 CLAUDE_CODE_AUTO_COMPACT_WINDOW，由网关按用户设定的压缩线自动发 /compact）
  const usedCtx = Number(usageOut?.context_tokens) || 0;
  const isCompactMsg = /^\/compact(?:\s|$)/i.test(message.trim());
  if (acpRes.ok && !run.aborted && run.sessionId) {
    if (isCompactMsg || run.auto === "autocompact" || run.auto === "idle") {
      ACP_AUTOCOMPACT.set(run.sessionId, { at: Date.now(), post: usedCtx });
    } else if (!run.auto || run.auto === "bg") {
      // /plan、/boost、/grill-me 与自定义斜杠指令同样会消耗大量上下文，跑完超线后应照常触发自动压缩
      const acLine = acpAutoCompactLine(ctxWin, P);   // C9-2：未设线时按 ACP 默认线（窗口八成），不是没有线
      const prevAc = ACP_AUTOCOMPACT.get(run.sessionId);
      const cooled = !prevAc || (Date.now() - prevAc.at > 60000) || (usedCtx > (prevAc.post || 0) + 10000);
      if (acLine && usedCtx >= acLine && cooled) {
        log(`🗜 ACP 自动压缩触发：会话 ${run.sessionId.slice(0, 8)} 上下文 ${usedCtx} ≥ 压缩线 ${acLine}`);
        ACP_AUTOCOMPACT.set(run.sessionId, { at: Date.now(), post: usedCtx });
        // 沿用本轮执行上下文并插至队首，保证命中常驻 ACP_POOL 进程且排在同会话后续排队消息之前
        enqueue({
          message: "/compact",
          sessionId: run.sessionId,
          auto: "autocompact",
          front: true,
          internal: true,
          cwd,
          provider: P.id,
          model: model || null,
          effort: effort || null,
          permissionMode: permMode,
          projectId: item.projectId || null,
        });
      } else if (usedCtx > 0) {
        idleArm(run.sessionId, { mainCtx: usedCtx, cache1h: true });
      }
    }
  }
  return endRes;
}

// ── 路由：/api/perm/answer /api/perm/mode /api/task/stop /api/abort ──
export async function routeRun(req, res, u, p) {
  // ── 给应用作证：特权请求来自哪一轮 claude（见 privWitness）。应答带签名，应用按启动随机数派生的钥匙核 ──
  if (req.method === "GET" && p === "/api/priv/witness") {
    const n = String(u.searchParams.get("n") || ""), anc = +u.searchParams.get("anc"), top = +u.searchParams.get("top");
    if (!/^[0-9a-f]{32}$/.test(n) || !(anc > 1) || !(top > 1)) return sendJson(res, 400, { error: "bad request" });
    const tok = privWitness(anc, top);
    return sendJson(res, 200, { tok, mac: witnessMac(n, anc, top, tok, localAddr(req)) });
  }
  // ── 权限确认：回答 claude 的 can_use_tool ──
  if (req.method === "POST" && p === "/api/perm/answer") {
    const b = JSON.parse((await readBody(req)) || "{}");
    // 不带 runId（通知里的「拒绝」）就按请求号找它属于哪一轮
    const run = b.runId ? RUNS.get(String(b.runId)) || null : runList().find((r) => r.perms && r.perms.has(String(b.id || ""))) || null;
    if (!run || !run.answerPerm) return sendJson(res, 409, { error: "gone", message: tz("这一轮已经结束了") });
    if (!run.answerPerm(String(b.id || ""), {
      behavior: b.behavior === "allow" ? "allow" : "deny",
      message: b.message, interrupt: !!b.interrupt, always: !!b.always,
      answers: b.answers, mode: b.mode ? String(b.mode) : null,
    })) return sendJson(res, 409, { error: "gone", message: tz("这项已经回答过了") });
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/perm/mode") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const r = setPermMode(String(b.mode || ""));
    if (!r) return sendJson(res, 400, { error: "bad mode" });
    // mode 是实际生效的（安全模式下可能被退回 default），wanted 是用户选的；saved=false 时这次切换重启后会丢（195-A.6）
    return sendJson(res, 200, { ok: true, mode: r.mode, wanted: SETTINGS.permissionMode, saved: r.saved, live: RUNS.size > 0 });
  }
  if (req.method === "POST" && p === "/api/task/stop") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const run = RUNS.get(String(b.runId || ""));
    if (run && run.stopTask && run.stopTask(String(b.taskId || ""))) {
      log(`■ 停后台任务 ${String(b.taskId).slice(0, 12)}`);
      return sendJson(res, 200, { ok: true });
    }
    // ACP 常驻池里空闲挂着的后台任务：直接按 sessionId 取消并刷新状态
    if (b.sessionId && stopAcpBgTask(String(b.sessionId), String(b.taskId || ""))) {
      publishState();
      log(`■ 停 ACP 后台任务 ${String(b.taskId || "").slice(0, 12)}`);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 409, { error: "gone", message: tz("这个后台任务已经结束了") });
  }
  if (req.method === "POST" && p === "/api/abort") {
    const b = JSON.parse((await readBody(req)) || "{}");
    if (b.clearQueue) QUEUE.length = 0;
    // 带 id 只停那一轮；不带 id（旧前端）停掉全部（含正在进行中的 ACP idleBurst）
    const stop = (run) => abortRun(run, { userStopped: true });
    const killed = b.id
      ? (stop(RUNS.get(String(b.id))) || abortAcpIdleBurst(String(b.id)))
      : (runList().map(stop).some(Boolean) || abortAcpIdleBurst());
    if (b.clearQueue) publishState();
    return sendJson(res, 200, { ok: true, killed });
  }
  return NEXT;
}

