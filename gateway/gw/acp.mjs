// ─────────────────────────────────────────────────────────────────────
//  acp.mjs —— Antigravity CLI (`agy acp`) Agent Client Protocol (JSON-RPC 2.0) 引擎
//
//  通过 stdio 双向 newline-delimited JSON-RPC 2.0 驱动官方原生 Android (bionic) `agy acp`：
//    Client → Agent: initialize, authenticate, session/new, session/load, session/prompt,
//                    session/set_mode, session/set_config_option, session/cancel
//    Agent → Client: session/update (流式文本/思考/工具调用/计划/用量/可用命令),
//                    session/request_permission (映射到 hachimia 权限确认卡片)
//
//  支持按 sessionId 保活常驻 `agy acp` 进程池：连续多轮对话复用同一进程，避免每轮冷启动、
//  历史重放与 server restart（保留 agy 子代理与后台任务生命周期）。
//  同时将每轮完整交互（含 tool_use 与 tool_result）以兼容格式落盘到会话 jsonl，
//  使会话列表、历史查看、搜索、导出、分叉与脉络功能无缝工作。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { CFG, LIVE, PATHS, log, tz } from "./config.mjs";
import { onShutdown } from "./crashguard.mjs";
import { buildCapabilities, setLastInit } from "./caps.mjs";
import { publish } from "./bus.mjs";
import { noteAuthTier } from "./login.mjs";
import { acpAgentSpawn, acpAgentDone, acpAgentMsg, acpAgentMsgOk } from "./agents.mjs";
import { parseGoalPrompt, applyGoalCommand } from "./goal.mjs";

export const ACP_PROTOCOL_VERSION = 1;
const ACP_IDLE_TTL_MS = Number(process.env.CCAPP_ACP_IDLE_MS) > 0 ? Number(process.env.CCAPP_ACP_IDLE_MS) : 30 * 60e3;
/** 存在后台子代理/命令但长时间静默时的保活上限（2 小时，进程仍有 CPU/日志活动时自动续期，不硬杀） */
const ACP_BG_IDLE_TTL_MS = Number(process.env.CCAPP_ACP_BG_IDLE_MS) > 0 ? Number(process.env.CCAPP_ACP_BG_IDLE_MS) : 2 * 3600e3;
/** 判定常驻 agy acp 进程仍在干活的日志活跃窗口（2 分钟内有 acp-server-*-<pid>.log 写入即视为活跃） */
const ACP_ACTIVE_LOG_WINDOW_MS = 2 * 60e3;
/** 空闲池探测非常驻后台 shell 任务结束的轮询周期与宽限窗（默认每 1s 探测，确认结束后静默 4.5s 补唤醒一次） */
export const ACP_BG_POLL_MS = Number(process.env.CCAPP_ACP_BG_POLL_MS) > 0 ? Number(process.env.CCAPP_ACP_BG_POLL_MS) : 1000;
export const ACP_BG_GRACE_MS = Number(process.env.CCAPP_ACP_BG_GRACE_MS) > 0 ? Number(process.env.CCAPP_ACP_BG_GRACE_MS) : 4500;
const ACP_BG_TASKLOG_SETTLE_MS = 1500;
const MY_UID = typeof process.getuid === "function" ? process.getuid() : -1;

/** 列出常驻 agy acp 进程当前存活（非僵尸）的直接子进程：{ pid, startTicks, key }；
 *  仅读 /proc/<pid>/stat（不受 PR_SET_DUMPABLE=0 影响），/proc 不可读时返回 null（保守不误判结束）。 */
export function listAcpChildren(parentPid, procDir = "/proc") {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  let entries;
  try { entries = fs.readdirSync(procDir); } catch { return null; }
  const checkUid = procDir === "/proc" && MY_UID >= 0;
  const kids = [];
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const pdir = path.join(procDir, d);
      if (checkUid && fs.statSync(pdir).uid !== MY_UID) continue;
      const s = fs.readFileSync(path.join(pdir, "stat"), "utf8");
      const r = s.lastIndexOf(")");
      if (r < 0) continue;
      const f = s.slice(r + 2).split(" ");
      const st = f[0];
      const ppid = Number(f[1]);
      if (ppid !== parentPid || st === "Z" || st === "X") continue;
      const pid = Number(d);
      const startTicks = String(f[19] || "0");
      kids.push({ pid, startTicks, key: `${pid}:${startTicks}` });
    } catch {}
  }
  return kids;
}

/** 探测 agy acp 非常驻后台 shell 任务是否仍在运行：
 *  1) 实测 agy 1.5.13 将每条 run_command 以直接子进程（ppid === agyPid，挂 PTY /dev/ptmx）运行；
 *     只要存在非 daemon 的存活子进程即视为仍在执行，绝不误触发；
 *  2) 全部非 daemon 子进程退出后，再核对对应 task-<N>.log 是否仍在 1.5s 内刷盘，确认落稳后才进入宽限窗。 */
export function acpBgShellActive(parentPid, {
  daemonChildKeys = null,
  sessionId = "",
  tasks = [],
  now = Date.now(),
  procDir = "/proc",
  brainDir = path.join(CFG.home, ".gemini", "antigravity-cli", "brain"),
  logSettleMs = ACP_BG_TASKLOG_SETTLE_MS,
} = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return { active: true, reason: "no-pid" };
  const kids = listAcpChildren(parentPid, procDir);
  if (kids === null) return { active: true, reason: "no-proc" };
  const nonDaemon = daemonChildKeys?.size ? kids.filter((c) => !daemonChildKeys.has(c.key)) : kids;
  if (nonDaemon.length > 0) return { active: true, reason: "child", children: nonDaemon };
  if (sessionId && brainDir && logSettleMs > 0 && Array.isArray(tasks) && tasks.length) {
    const taskDir = path.join(brainDir, String(sessionId), ".system_generated", "tasks");
    for (const t of tasks) {
      const shortId = String(t?.id || "").split("/").pop();
      if (!/^task-\d+$/.test(shortId)) continue;
      try {
        const st = fs.statSync(path.join(taskDir, `${shortId}.log`));
        if (now - st.mtimeMs < logSettleMs) return { active: true, reason: "task-log" };
      } catch {}
    }
  }
  return { active: false, reason: "gone" };
}
/** 读取 /proc/<pid>/stat 的用户态+内核态 CPU 滴答总和；读不到返回 -1 */
export function readProcCpuTicks(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return -1;
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const r = s.lastIndexOf(")");
    if (r < 0) return -1;
    const f = s.slice(r + 2).split(" ");
    const utime = Number(f[11]), stime = Number(f[12]);
    return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : -1;
  } catch { return -1; }
}
/** 探测常驻 agy acp 进程在“看似空闲”期间是否仍在执行后台子代理/工作流/工具：
 *  子代理运行期间不会给父 ACP 流发 session/update，entry.lastUsed 纹丝不动；
 *  但 agy 进程本身会持续消耗 CPU 并刷新 ~/.gemini/antigravity-cli/log/acp-server-*-<pid>.log。
 *  两者任一活跃就说明绝不能空闲回收，防止误杀运行中的子代理导致 Server restart。 */
export function acpChildActive(pid, prevCpuTicks = -1, now = Date.now(), logDir = path.join(CFG.home, ".gemini", "antigravity-cli", "log")) {
  const cpuTicks = readProcCpuTicks(pid);
  if (prevCpuTicks >= 0 && cpuTicks >= 0 && cpuTicks - prevCpuTicks >= 5) {
    return { active: true, cpuTicks, reason: "cpu" };
  }
  if (Number.isInteger(pid) && pid > 0 && logDir) {
    try {
      const suffix = `-${pid}.log`;
      for (const f of fs.readdirSync(logDir)) {
        if (!f.startsWith("acp-server-") || !f.endsWith(suffix)) continue;
        const st = fs.statSync(path.join(logDir, f));
        if (now - st.mtimeMs < ACP_ACTIVE_LOG_WINDOW_MS) {
          return { active: true, cpuTicks, reason: "log" };
        }
      }
    } catch {}
  }
  return { active: false, cpuTicks, reason: "" };
}
/** session/prompt 的默认无活动假死超时：不传硬 timeoutMs 时不再无限等待（B12），也不一刀切误杀超 30 分钟的活跃长任务。
 *  仅当流式收到 JSON-RPC 消息（session/update、反向权限请求）或处于用户权限审批等待期时自动滑窗续期
 *  （不把后台 Go runtime GC/心跳 CPU 计入续期，避免真假死被架空），并设总墙钟兜底上限 ACP_MAX_PROMPT_TIMEOUT_MS。 */
export const ACP_DEFAULT_PROMPT_TIMEOUT_MS = Number(process.env.CCAPP_ACP_PROMPT_TIMEOUT_MS) > 0
  ? Number(process.env.CCAPP_ACP_PROMPT_TIMEOUT_MS)
  : 30 * 60 * 1000;
export const ACP_MAX_PROMPT_TIMEOUT_MS = Number(process.env.CCAPP_ACP_MAX_PROMPT_TIMEOUT_MS) > 0
  ? Number(process.env.CCAPP_ACP_MAX_PROMPT_TIMEOUT_MS)
  : 6 * 3600 * 1000;
const TOOL_OUT_MAX = 20000;

// 按 sessionId 保活的常驻 ACP 客户端池：同一会话同配置直接复用进程，避免每轮重启 agy
const ACP_POOL = new Map();

// 一次性 schedule(DurationSeconds) 的墙钟到期清理定时器（独立存于模块级 Map，避免挂进 bgTasks 引发 JSON 序列化循环引用）
const BG_EXPIRY_TIMERS = new Map(); // `${scopeKey}\0${taskId}` -> Timeout

function clearBgExpiryTimer(scopeKey, taskId) {
  const k = `${scopeKey}\0${taskId}`;
  const t = BG_EXPIRY_TIMERS.get(k);
  if (t) { clearTimeout(t); BG_EXPIRY_TIMERS.delete(k); }
}

function clearAllBgExpiryTimers(scopeKey) {
  const prefix = `${scopeKey}\0`;
  for (const [k, t] of BG_EXPIRY_TIMERS) {
    if (k.startsWith(prefix)) { clearTimeout(t); BG_EXPIRY_TIMERS.delete(k); }
  }
}

function armBgExpiryTimer(scopeKey, map, item, onChange) {
  if (!item?.oneShot || !(item.expiresAt > 0)) return;
  clearBgExpiryTimer(scopeKey, item.id);
  const MAX_TIMEOUT_MS = 0x7fffffff;
  const rem = item.expiresAt - Date.now();
  const delay = Math.min(Math.max(10, rem), MAX_TIMEOUT_MS);
  const k = `${scopeKey}\0${item.id}`;
  const timer = setTimeout(() => {
    BG_EXPIRY_TIMERS.delete(k);
    if (map.get(item.id) !== item) return;
    if (item.expiresAt > Date.now()) {
      armBgExpiryTimer(scopeKey, map, item, onChange);
      return;
    }
    map.delete(item.id);
    onChange?.();
  }, delay);
  timer.unref?.();
  BG_EXPIRY_TIMERS.set(k, timer);
}

function pruneExpiredBgTasks(scopeKey, map, now = Date.now()) {
  if (!map || !map.size) return false;
  let changed = false;
  for (const [k, v] of map) {
    if (v?.oneShot && v.expiresAt > 0 && v.expiresAt <= now) {
      clearBgExpiryTimer(scopeKey, k);
      map.delete(k);
      changed = true;
    }
  }
  return changed;
}

/** 移除某个后台任务时，同步移除以它为 TimerCondition 的一次性 schedule 定时器（防不同会话同号短 ID 误删） */
function removeBgTaskAndDependents(scopeKey, map, id) {
  if (!map || !id) return false;
  const sid = String(id);
  const shortId = sid.includes("/") ? sid.split("/").pop() : sid;
  let changed = false;
  if (map.delete(sid)) {
    clearBgExpiryTimer(scopeKey, sid);
    changed = true;
  }
  for (const [k, v] of map) {
    const cond = v?.oneShot && typeof v.timerCondition === "string" ? v.timerCondition : "";
    if (!cond || cond === "never") continue;
    const matchCond = cond === sid
      || (!cond.includes("/") && cond === shortId)
      || (!sid.includes("/") && cond.endsWith("/" + sid));
    if (matchCond) {
      clearBgExpiryTimer(scopeKey, k);
      map.delete(k);
      changed = true;
    }
  }
  return changed;
}

function reconcileBgTasksFromList(scopeKey, map, outText) {
  if (!map || !map.size) return false;
  if (/\btruncated\b|已截断|(?:\r?\n|^)\.{3}\s*$/i.test(outText)) return false;
  const liveIds = new Set();
  const re = /\b(?:TaskId|task[_\s-]?id)["':=\s]+([A-Za-z0-9._/-]*[A-Za-z0-9_/-])|\b([0-9a-f-]{8,}\/task-\d+|task-\d+)\b/gi;
  let m;
  while ((m = re.exec(outText)) !== null) {
    const tok = m[1] || m[2];
    if (tok) {
      liveIds.add(tok);
      if (tok.includes("/")) liveIds.add(tok.split("/").pop());
    }
  }
  if (!liveIds.size) return false;
  let changed = false;
  for (const [k, v] of map) {
    if (v.type !== "shell") continue;
    const shortK = k.includes("/") ? k.split("/").pop() : k;
    if (!liveIds.has(k) && !liveIds.has(shortK)) {
      if (removeBgTaskAndDependents(scopeKey, map, k)) changed = true;
    }
  }
  return changed;
}

/** 常驻 ACP 进程的收尾（MIG-19）：先 SIGTERM 整组（agy 派生的孙进程一起带走），
 *  宽限期后仍活着再 SIGKILL 整组；组杀失败回落单进程。子进程以 detached:true 起，
 *  是进程组长，负 pid 即整组。定时器 unref，不拖住网关退出。 */
export const ACP_KILL_GRACE_MS = 3000;
export function killAcpChild(child, graceMs = ACP_KILL_GRACE_MS) {
  if (!child || !child.pid) return;
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); return true; }
    catch { try { child.kill(sig); } catch {} return false; }
  };
  killGroup("SIGTERM");
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode == null) killGroup("SIGKILL");
  }, graceMs);
  t.unref?.();
}

/** 销毁池中某个会话的常驻 ACP 进程 */
export function closeAcpSession(sessionId) {
  const entry = sessionId && ACP_POOL.get(sessionId);
  if (!entry) return;
  clearAllBgExpiryTimers(`pool:${sessionId}`);
  try { entry.clearBgWatch?.(); } catch {}
  try { entry.flushIdle?.(); } catch {}
  ACP_POOL.delete(sessionId);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  try { entry.client.close(); } catch {}
  killAcpChild(entry.client.child);
}

/** 查询常驻 ACP 进程池中正在后台运行的任务列表（供前端顶部后台任务条展示） */
export function getAcpPoolBg(sessionId) {
  if (sessionId) {
    const e = ACP_POOL.get(sessionId);
    if (e?.bgTasks?.size) pruneExpiredBgTasks(`pool:${sessionId}`, e.bgTasks);
    return e && e.bgTasks?.size ? [...e.bgTasks.values()] : [];
  }
  const out = {};
  for (const [sid, e] of ACP_POOL) {
    if (e.bgTasks?.size) {
      pruneExpiredBgTasks(`pool:${sid}`, e.bgTasks);
      if (e.bgTasks.size) out[sid] = [...e.bgTasks.values()];
    }
  }
  return out;
}

/** 查询常驻 ACP 进程池中正在推送空闲后台回报的虚拟轮次（供 /api/state 对账识别，避免前端误掐） */
export function getAcpIdleRuns() {
  const out = [];
  for (const e of ACP_POOL.values()) {
    if (e.idleRun) out.push(e.idleRun);
  }
  return out;
}

/** 停止某个 ACP 会话的后台任务：只删本地登记，绝不发全会话 session/cancel。
 *  ACP 没有单任务取消协议，发 session/cancel 会把正在跑的主轮次一并取消（B9）；
 *  空闲且无后台任务时直接回收进程即可，agent 侧的任务随进程回收一起结束。 */
export function stopAcpBgTask(sessionId, taskId) {
  const entry = sessionId && ACP_POOL.get(sessionId);
  if (!entry) return false;
  const poolScope = `pool:${sessionId}`;
  entry.nudgedBgTasks ||= new Set();
  if (taskId) {
    entry.nudgedBgTasks.add(String(taskId));
    removeBgTaskAndDependents(poolScope, entry.bgTasks, taskId);
  } else {
    for (const k of entry.bgTasks?.keys() || []) entry.nudgedBgTasks.add(k);
    clearAllBgExpiryTimers(poolScope);
    entry.bgTasks?.clear();
  }
  entry.dropActiveBg?.(taskId);
  const hasWatchableShell = [...(entry.bgTasks?.values() || [])].some((t) => t.type === "shell" && !entry.nudgedBgTasks.has(t.id));
  if (!hasWatchableShell) {
    try { entry.clearBgWatch?.(); } catch {}
  }
  if (!entry.busy && (!entry.bgTasks || entry.bgTasks.size === 0)) {
    closeAcpSession(sessionId);
  }
  return true;
}

/** 网关关闭或测试收尾时清理所有常驻 ACP 进程 */
export function closeAllAcpClients() {
  for (const sid of [...ACP_POOL.keys()]) closeAcpSession(sid);
}

onShutdown("ACP 会话池", () => closeAllAcpClients());

/** 将工作目录编码为会话项目目录名（与 sessions.mjs / transcript.mjs 兼容） */
export function encodeProjectDir(cwd) {
  return String(cwd || CFG.workspace || CFG.home).replace(/[^A-Za-z0-9]/g, "-");
}

/** 构造本次会话的本地 jsonl 落盘路径 */
export function acpSessionFile(cwd, sessionId) {
  const dir = path.join(PATHS.projects, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

/** 追加一条与 transcript.mjs 兼容的会话记录行 */
function appendJsonl(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + "\n");
  } catch (e) {
    log(`[acp] 写入会话记录失败: ${e.message}`);
  }
}

/** 从 ACP content / rawOutput / diff 块提取可读文本 */
export function acpTextOf(content, depth = 0) {
  if (content == null || depth > 6) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) return content.map((x) => acpTextOf(x, depth + 1)).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (content.type === "diff") {
      const head = content.path ? `--- ${content.path}\n` : "";
      const oldS = typeof content.oldText === "string" ? content.oldText : "";
      const newS = typeof content.newText === "string" ? content.newText : "";
      const parts = [];
      if (oldS) parts.push(oldS.split("\n").slice(0, 40).map((l) => "- " + l).join("\n"));
      if (newS) parts.push(newS.split("\n").slice(0, 40).map((l) => "+ " + l).join("\n"));
      return head + parts.join("\n");
    }
    if (content.type === "terminal" && content.terminalId) {
      return `[terminal ${content.terminalId}]`;
    }
    if (typeof content.text === "string") return content.text;
    if (content.content !== undefined) return acpTextOf(content.content, depth + 1);
    if (typeof content.output === "string") return content.output;
    if (typeof content.stdout === "string" || typeof content.stderr === "string") {
      return [content.stdout, content.stderr].filter(Boolean).join("\n");
    }
    if (typeof content.message === "string") return content.message;
    if (typeof content.result === "string") return content.result;
    // 兜底结构化对象（如 rawOutput 是纯 JSON）
    try {
      const s = JSON.stringify(content, null, 2);
      if (s && s !== "{}") return s.length > 8000 ? s.slice(0, 8000) + "\n…" : s;
    } catch {}
  }
  return "";
}

/** 合并工具输出：兼容增量追加与全量覆盖两种更新方式。
 *  重叠增量（next 的前缀与 prev 的后缀重叠，如 abc + bcd）只补新尾巴，不拼重复（MIG-20）。 */
export function mergeToolOutput(prev, next) {
  if (!next) return prev || "";
  if (!prev) return next;
  if (next === prev || prev.endsWith(next)) return prev;
  if (next.startsWith(prev)) return next;
  const max = Math.min(prev.length, next.length);
  for (let n = max; n > 0; n--) {
    if (prev.endsWith(next.slice(0, n))) return prev + next.slice(n);
  }
  return prev + (prev.endsWith("\n") ? "" : "\n") + next;
}

/** 权限选项按 kind/optionId 精确匹配（MIG-21）：子串匹配会把假想的 disallow/disallow_once
 *  当成允许项自动放行。allow_always 与 reject 各自另有档位，不混进 allow_once 的候选。 */
const acpOptKind = (o) => String(o?.kind || o?.optionId || "").trim().toLowerCase();
const isAcpAllowOpt = (o) => /^(allow_once|allow)$/.test(acpOptKind(o));
const isAcpAllowAlwaysOpt = (o) => /^allow_always$/.test(acpOptKind(o));
const isAcpRejectOpt = (o) => /^(reject_once|reject_always|reject|deny|deny_once|deny_always)$/.test(acpOptKind(o));
const isAcpDenyishOpt = (o) => isAcpRejectOpt(o) || /^disallow(_once|_always)?$/.test(acpOptKind(o));
/** 挑自动放行用的允许项：精确匹配不到时，首选项不是已知档位（allow_always / reject / deny / disallow）
 *  才兜底——把 allow_always 当 allow_once 点掉会误授永久放行；agent 只发 disallow 时更不能把它当允许点掉。 */
export function pickAcpAllowOption(options) {
  const list = Array.isArray(options) ? options : [];
  const allow = list.find(isAcpAllowOpt);
  if (allow) return allow;
  const first = list[0];
  return first && !isAcpAllowAlwaysOpt(first) && !isAcpDenyishOpt(first) ? first : undefined;
}

/** 将 ACP 模式名映射为前端识别的权限模式 */
function mapAcpModeToUi(mode) {
  const m = String(mode || "").trim();
  if (!m) return "";
  if (/bypass|yolo|auto_approve|always/i.test(m)) return "bypassPermissions";
  if (/accept[-_ ]?edit|auto[-_ ]?edit/i.test(m)) return "acceptEdits";
  if (/plan/i.test(m)) return "plan";
  if (/auto/i.test(m)) return "auto";
  if (/default|ask|review/i.test(m)) return "default";
  return m;
}

/** 从已落盘的会话 jsonl 读取历史已见过的 tool_use id，防止 session/load 重放旧工具卡 */
export function readKnownToolIds(cwd, sessionId) {
  const ids = new Set();
  if (!sessionId) return ids;
  const file = path.join(PATHS.projects, encodeProjectDir(cwd), `${sessionId}.jsonl`);
  let raw = "";
  try {
    const st = fs.statSync(file);
    // 最多读尾部 4MB，足够覆盖任何重放窗口且不拖慢启动
    const maxBytes = 4 * 1024 * 1024;
    if (st.size <= maxBytes) {
      raw = fs.readFileSync(file, "utf8");
    } else {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
        raw = buf.subarray(0, n).toString("utf8");
      } finally { fs.closeSync(fd); }
    }
  } catch { return ids; }
  for (const line of raw.split("\n")) {
    if (!line || !line.includes('"tool_use"')) continue;
    try {
      const obj = JSON.parse(line);
      const blocks = obj?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b && b.type === "tool_use" && b.id) ids.add(String(b.id));
      }
    } catch {}
  }
  return ids;
}

/** 解析 ACP 用量对象（兼容 usage_update 单步快照与 session/prompt 整轮累计 usage） */
function extractAcpUsage(u, prev = null, { isTurnTotal = false } = {}) {
  if (!u || typeof u !== "object") return prev;
  const inp = Number(u.inputTokens ?? u.promptTokens ?? u.input_tokens ?? 0) || 0;
  const cached = Number(u.cachedReadTokens ?? u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0) || 0;
  const out = Number(u.outputTokens ?? u.completionTokens ?? u.output_tokens ?? 0) || 0;
  const total = Number(u.totalTokens ?? u.total_tokens ?? 0) || 0;
  const hasUsed = u.used !== undefined || u.contextTokens !== undefined || u.context_tokens !== undefined;
  const used = hasUsed ? (Number(u.used ?? u.contextTokens ?? u.context_tokens ?? 0) || 0) : -1;
  const win = Number(u.size ?? u.contextWindow ?? u.context_window ?? 0) || 0;
  const prevWin = Number(prev?.context_window || 0) || 0;
  const nextWin = win > 0 ? win : prevWin;

  // promptRes.usage 是整轮所有工具调用的累加和，绝不能覆盖 usage_update 报出的单步真实上下文占用
  let ctx = prev?.context_tokens || 0;
  if (used > 0) {
    ctx = used;
  } else if (!hasUsed && !isTurnTotal && inp + cached > 0) {
    ctx = inp + cached;
  } else if (!hasUsed && !isTurnTotal && total > out) {
    ctx = total - out;
  }
  // C16：全程无 usage_update 时，整轮累计值（inputTokens/totalTokens）只是“这一轮一共用了多少”，
  // 不是“当前上下文占了多少”——不得把它冒充成单步 context_tokens。没有单步依据时就留空，
  // 由调用方按“未知”处理，而不是拿累计值去画上下文条、比自动压缩线。

  if (ctx <= 0 && out <= 0 && inp <= 0 && nextWin <= 0) return prev;
  return {
    input_tokens: inp || prev?.input_tokens || 0,
    ...(cached > 0 ? { cache_read_input_tokens: cached } : (prev?.cache_read_input_tokens ? { cache_read_input_tokens: prev.cache_read_input_tokens } : {})),
    output_tokens: out || prev?.output_tokens || 0,
    ...(ctx > 0 ? { context_tokens: ctx } : {}),
    ...(nextWin > 0 ? { context_window: nextWin } : {}),
  };
}

/**
 * 创建并管理一个 `agy acp` JSON-RPC 2.0 客户端连接。
 * @param {object} opts
 * @param {string} opts.bin - agy 可执行文件路径
 * @param {string[]} [opts.args] - 额外参数（默认 ["acp"]）
 * @param {string} opts.cwd - 工作目录（绝对路径）
 * @param {object} opts.env - 子进程环境变量
 * @param {(method: string, params: any) => void} [opts.onNotification]
 * @param {(method: string, params: any) => Promise<any>} [opts.onRequest]
 * @param {(line: string) => void} [opts.onStderr]
 */
export function createAcpClient({ bin, args = ["acp"], cwd, env, onNotification, onRequest, onStderr, onClose }) {
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const handlers = { onNotification, onRequest, onStderr, onClose };
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, timer }
  let closed = false;
  let stderrTail = "";

  const rejectAll = (err) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
      pending.delete(id);
    }
  };

  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const s = String(chunk);
    stderrTail = (stderrTail + s).slice(-4096);
    handlers.onStderr?.(s);
  });

  // ACP 要求 NDJSON，但 agent 可能吐多行 pretty-JSON：解析失败的行先缓冲，
  // 括号平衡后再拼起来解析；拼不出的才丢弃，并把完整内容记进诊断日志（MIG-23）。
  let jsonBuf = "";
  const JSON_BUF_MAX = 1 << 20;
  // 括号深度（跳过字符串内与转义字符）：>0 说明这段 JSON 还没收完
  const jsonDepth = (s) => {
    let depth = 0, inStr = false, esc = false;
    for (const ch of s) {
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
    }
    return depth;
  };
  const tryParseJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const handleJsonLine = (line) => {
    const t = line.trim();
    if (!t) return undefined;
    let msg = tryParseJson(t);
    if (msg !== undefined) { jsonBuf = ""; return msg; }
    if (jsonBuf) {
      // 上一段没拼完、新行自己却是完整 JSON：旧缓冲已是死内容，记下来再处理新行
      const staled = jsonBuf;
      jsonBuf = "";
      const alone = tryParseJson(t);
      if (alone !== undefined) {
        log(`[acp] 丢弃的非 JSON stdout 内容: ${staled}`);
        return alone;
      }
      jsonBuf = staled;
    }
    const candidate = jsonBuf ? jsonBuf + "\n" + t : t;
    if (jsonDepth(candidate) > 0) {
      if (candidate.length > JSON_BUF_MAX) {
        log(`[acp] 非 JSON stdout 内容超长（${candidate.length} 字节），丢弃: ${candidate}`);
        jsonBuf = "";
        return undefined;
      }
      jsonBuf = candidate;
      return undefined;
    }
    msg = tryParseJson(candidate);
    if (msg !== undefined) { jsonBuf = ""; return msg; }
    log(`[acp] 非 JSON stdout 行: ${candidate}`);
    jsonBuf = "";
    return undefined;
  };

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const msg = handleJsonLine(line);
    if (msg === undefined || msg === null) return;
    // 1. 对我们请求的响应
    if (msg.id !== undefined && (Object.prototype.hasOwnProperty.call(msg, "result") || Object.prototype.hasOwnProperty.call(msg, "error"))) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = new Error(msg.error.message || `ACP error ${msg.error.code}`);
        e.code = msg.error.code;
        e.data = msg.error.data;
        p.reject(e);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // 2. Agent 反向请求（如 session/request_permission）
    if (msg.id !== undefined && typeof msg.method === "string") {
      for (const p of pending.values()) p.touch?.();
      Promise.resolve()
        .then(() => (handlers.onRequest ? handlers.onRequest(msg.method, msg.params || {}) : Promise.reject(new Error(`Unsupported client method: ${msg.method}`))))
        .then((result) => writeMsg({ jsonrpc: "2.0", id: msg.id, result }))
        .catch((err) => writeMsg({ jsonrpc: "2.0", id: msg.id, error: { code: err?.code || -32603, message: String(err?.message || err) } }));
      return;
    }
    // 3. Agent 通知（如 session/update）
    if (typeof msg.method === "string") {
      for (const p of pending.values()) p.touch?.();
      try { handlers.onNotification?.(msg.method, msg.params || {}); } catch (e) { log(`[acp] 通知处理异常: ${e.message}`); }
    }
  });

  child.on("error", (err) => {
    closed = true;
    rejectAll(err);
  });
  child.on("close", (code, signal) => {
    closed = true;
    if (jsonBuf) { log(`[acp] 进程退出时仍有未拼完的 stdout 内容: ${jsonBuf}`); jsonBuf = ""; }
    rl.close();
    rejectAll(new Error(signal ? `agy acp terminated by ${signal}` : `agy acp exited with code ${code}`));
    try { handlers.onClose?.(code, signal); } catch {}
  });

  function writeMsg(obj) {
    if (closed || !child.stdin.writable) return false;
    try {
      child.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch { return false; }
  }

  function request(method, params = {}, timeoutOrOpts = 120000) {
    if (closed) return Promise.reject(new Error("ACP process already closed"));
    const id = nextId++;
    const isObj = timeoutOrOpts && typeof timeoutOrOpts === "object";
    const hardMs = isObj ? Number(timeoutOrOpts.timeoutMs) || 0 : Number(timeoutOrOpts) || 0;
    const idleMs = isObj ? Number(timeoutOrOpts.idleTimeoutMs) || 0 : 0;
    const maxTotalMs = isObj ? Number(timeoutOrOpts.maxTotalMs) || 0 : 0;
    const shouldExtend = isObj && typeof timeoutOrOpts.shouldExtend === "function" ? timeoutOrOpts.shouldExtend : null;
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const entry = { resolve, reject, timer: null, lastActivityAt: startedAt, touch: null };
      if (idleMs > 0) {
        entry.touch = () => { entry.lastActivityAt = Date.now(); };
        const arm = (delayMs) => {
          const t = setTimeout(() => {
            if (!pending.has(id)) return;
            const now = Date.now();
            if (maxTotalMs > 0 && now - startedAt >= maxTotalMs) {
              pending.delete(id);
              reject(new Error(`ACP request timeout: ${method}`));
              return;
            }
            const elapsed = now - entry.lastActivityAt;
            if (elapsed < idleMs) {
              const remCap = maxTotalMs > 0 ? Math.max(10, maxTotalMs - (now - startedAt)) : idleMs;
              arm(Math.min(remCap, Math.max(10, idleMs - elapsed)));
              return;
            }
            let extend = false;
            try { extend = !!shouldExtend?.(); } catch {}
            if (extend) {
              entry.lastActivityAt = now;
              const remCap = maxTotalMs > 0 ? Math.max(10, maxTotalMs - (now - startedAt)) : idleMs;
              arm(Math.min(remCap, idleMs));
              return;
            }
            pending.delete(id);
            reject(new Error(`ACP request timeout: ${method}`));
          }, delayMs);
          t.unref?.();
          entry.timer = t;
        };
        arm(maxTotalMs > 0 ? Math.min(idleMs, maxTotalMs) : idleMs);
      } else if (hardMs > 0) {
        const t = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP request timeout: ${method}`));
        }, hardMs);
        t.unref?.();
        entry.timer = t;
      }
      pending.set(id, entry);
      if (!writeMsg({ jsonrpc: "2.0", id, method, params })) {
        if (entry.timer) clearTimeout(entry.timer);
        pending.delete(id);
        reject(new Error(`ACP stdin write failed: ${method}`));
      }
    });
  }

  function notify(method, params = {}) {
    return writeMsg({ jsonrpc: "2.0", method, params });
  }

  function setHandlers(next) {
    handlers.onNotification = next?.onNotification;
    handlers.onRequest = next?.onRequest;
    handlers.onStderr = next?.onStderr;
    handlers.onClose = next?.onClose;
  }

  function close() {
    closed = true;
    try { child.stdin.end(); } catch {}
    try { rl.close(); } catch {}
  }

  return {
    child,
    request,
    notify,
    setHandlers,
    close,
    get stderr() { return stderrTail; },
    get closed() { return closed; },
  };
}

/** 从工具输出中提取首行摘要 */
function firstLineOf(s, max = 80) {
  const line = String(s || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** 识别 agy 原生工具规范名：真实 agy acp 的 tool_call.title 常带 "Run " 前缀（如 "Run invoke_subagent"），
 *  且 run_command 的 title 直接是命令行原文；先剥 "run " 前缀，再按 rawInput 字段兜底识别。 */
export function classifyAcpTool(rawName, input, output = "") {
  const norm = String(rawName || "").trim().toLowerCase().replace(/^run\s+/, "");
  if (norm === "invoke_subagent" || norm === "run_workflow" || norm === "send_message"
    || norm === "manage_subagents" || norm === "run_command" || norm === "manage_task" || norm === "schedule") {
    return norm;
  }
  const inp = input && typeof input === "object" ? input : {};
  if (typeof inp.TypeName === "string" && typeof inp.Prompt === "string") return "invoke_subagent";
  if (typeof inp.Script === "string" || typeof inp.ScriptPath === "string") return "run_workflow";
  if (typeof inp.Recipient === "string" && typeof inp.Message === "string") return "send_message";
  if (typeof inp.Action === "string" && Array.isArray(inp.ConversationIds)) return "manage_subagents";
  if (typeof inp.TaskId === "string" && typeof inp.Action === "string") return "manage_task";
  if (typeof inp.Action === "string" && /^(status|send_input)$/i.test(inp.Action)) return "manage_task";
  const out = String(output || "");
  if (/^No background tasks are currently running\./m.test(out)) return "manage_task";
  if (typeof inp.Action === "string" && /^(list|kill|kill_all)$/i.test(inp.Action)) return "manage_subagents";
  if (typeof inp.CommandLine === "string") return "run_command";
  if (typeof inp.CronExpression === "string" || typeof inp.DurationSeconds === "number") return "schedule";
  if (/^Tool is running (?:as a background task|in the background)\b/m.test(out)) return "run_command";
  return "";
}

/** 识别 agy 原生子代理 / 后台任务工具调用并同步发射 `ag` 联络卡与后台任务事件 */
function trackAcpToolSideEffects(phase, tool, state, emit) {
  if (!tool || !state) return;
  const rawName = String(tool.name || "");
  const inp = tool.input && typeof tool.input === "object" ? tool.input : {};
  const kind = classifyAcpTool(rawName, inp, tool.output);
  if (!kind) return;
  const agents = (state.acpAgents ||= new Map());        // toolId -> { id, convId, name }
  const byConv = (state.acpAgentsByConv ||= new Map());  // convId -> toolId
  // F-1：子代理结束记入联络簿（agents.mjs，与 CLI 的 agentBook 同格式），无 cwd/会话号时跳过
  const bookDone = (toolId, status, why, report) => {
    if (!state.cwd || !state.sessionId) return;
    try { acpAgentDone(state.cwd, state.sessionId, { id: toolId, dir: state.acpAgentDirs?.get(toolId) || null, name: agents.get(toolId)?.name || "agent", status, why, report }); } catch {}
  };

  const isSubagentCall = kind === "invoke_subagent" || kind === "run_workflow";
  if (isSubagentCall) {
    if (phase === "start") {
      const label = String(inp.Role || inp.TypeName || inp.Description || rawName).trim().slice(0, 60) || "subagent";
      agents.set(tool.id, { id: tool.id, convId: null, name: label, status: "running" });
      emit({ type: "ag", k: "spawn", id: tool.id, tool: tool.id, name: label, parent: null, depth: 1, bg: true, by: "main", at: Date.now() });
      state.onBgAdd?.({ id: tool.id, type: kind === "run_workflow" ? "workflow" : "agent", desc: label });
      if (state.cwd && state.sessionId && !state.acpAgentDirs?.has(tool.id)) {
        const d = acpAgentSpawn(state.cwd, state.sessionId, { id: tool.id, name: label, prompt: String(inp.Prompt || inp.Description || "") });
        if (d) (state.acpAgentDirs ||= new Map()).set(tool.id, d);
      }
    } else if (phase === "done") {
      const rec = agents.get(tool.id);
      const out = String(tool.output || "");
      const mConv = /conversationId["':=\s]+([a-f0-9-]{8,})/i.exec(out) || /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(out);
      if (rec && mConv) {
        rec.convId = mConv[1];
        byConv.set(rec.convId, rec.id);
      }
      // 真实 agy acp 的 invoke_subagent 始终后台启动，且 tool_result.content 常为空串 "" 或仅含 conversationId/logAbsoluteUri 的 JSON；
      // 只有明确返回了非空正文结论（不含 background/running/async/conversationId/logAbsoluteUri）才按前台完成结算（兼容 F-1）。
      const trimmedOut = out.trim();
      const isBgLaunch = !trimmedOut || /background|running|async|conversationId|logAbsoluteUri/i.test(trimmedOut);
      if (tool.isError) {
        if (rec) rec.status = "failed";
        emit({ type: "ag", k: "done", id: tool.id, status: "failed", why: firstLineOf(out), at: Date.now() });
        state.onBgRemove?.(tool.id);
        bookDone(tool.id, "failed", firstLineOf(out), out);
      } else if (!isBgLaunch) {
        if (rec) rec.status = "done";
        emit({ type: "ag", k: "done", id: tool.id, status: "done", why: firstLineOf(out), at: Date.now() });
        state.onBgRemove?.(tool.id);
        bookDone(tool.id, "done", firstLineOf(out), out);
      }
    }
    return;
  }

  if (kind === "send_message") {
    const rawTo = String(inp.Recipient || "").trim();
    const to = byConv.get(rawTo) || rawTo || "subagent";
    const body = String(inp.Message || "");
    if (phase === "start") {
      emit({ type: "ag", k: "msg", mid: tool.id, from: "main", to, why: firstLineOf(body, 80), at: Date.now() });
      // MIG-25：msg 只走瞬时事件、断线重连后查不到——同时写联络簿落盘（F-1 补齐）。
      if (state.cwd && state.sessionId) {
        try { acpAgentMsg(state.cwd, state.sessionId, { mid: tool.id, from: "main", to, why: firstLineOf(body, 80), body }); } catch {}
      }
    } else if (phase === "done") {
      emit({ type: "ag", k: "msg_ok", mid: tool.id, ok: !tool.isError, err: tool.isError ? firstLineOf(tool.output) : null, at: Date.now() });
      if (state.cwd && state.sessionId) {
        try { acpAgentMsgOk(state.cwd, state.sessionId, { mid: tool.id, ok: !tool.isError, err: tool.isError ? firstLineOf(tool.output) : "" }); } catch {}
      }
    }
    return;
  }

  if (kind === "manage_subagents" && phase === "done" && !tool.isError) {
    const act = String(inp.Action || "").toLowerCase();
    if (act === "kill_all") {
      for (const rec of agents.values()) {
        if (rec.status === "running") {
          rec.status = "stopped";
          emit({ type: "ag", k: "done", id: rec.id, status: "stopped", why: "已终止", at: Date.now() });
          state.onBgRemove?.(rec.id);
          bookDone(rec.id, "stopped", "已终止", "");
        }
      }
    } else if (act === "kill" && Array.isArray(inp.ConversationIds)) {
      for (const cid of inp.ConversationIds) {
        const aid = byConv.get(String(cid)) || String(cid);
        const rec = agents.get(aid);
        if (rec && rec.status === "running") {
          rec.status = "stopped";
          emit({ type: "ag", k: "done", id: rec.id, status: "stopped", why: "已终止", at: Date.now() });
          bookDone(rec.id, "stopped", "已终止", "");
        }
        state.onBgRemove?.(aid);
      }
    }
    return;
  }

  if (kind === "run_command" && phase === "done" && !tool.isError) {
    const out = String(tool.output || "");
    // 只检视工具信封头（有 Command/Log output: 分隔符时取其前；无分隔符时仅取前 6 行信封头），
    // 防止同步退出或前台超时的命令输出正文里含 "background task" / "TaskId" 被误挂为幽灵后台任务。
    const sepRe = /\r?\n(?:Command|Log) output:\r?\n/;
    const header = sepRe.test(out) ? out.split(sepRe)[0] : out.split(/\r?\n/, 6).join("\n");
    const syncExited = /^Command (?:exited with code \d+|was terminated by signal)/m.test(header);
    const bgMatch = !!inp.IsDaemon || (!syncExited && (
      /^Tool is running (?:as a background task|in the background)\b/m.test(header)
      || /\bCommand running in (?:the )?background\b/i.test(header)
      || /\b(?:TaskId|task[_\s-]?id)["':=\s]+[A-Za-z0-9._/-]*[A-Za-z0-9_/-]/i.test(header)
    ));
    if (bgMatch) {
      const mId = /(?:TaskId|task[_\s-]?id)["':=\s]+([A-Za-z0-9._/-]*[A-Za-z0-9_/-])/i.exec(header);
      const tid = mId ? mId[1] : tool.id;
      const titleCmd = rawName.replace(/^run\s+/i, "").trim();
      const desc = String(
        inp.toolSummary || inp.description || inp.CommandLine
        || (titleCmd && titleCmd.toLowerCase() !== "run_command" ? titleCmd : "")
        || "后台命令"
      ).trim().slice(0, 80);
      state.onBgAdd?.({ id: tid, type: inp.IsDaemon ? "daemon" : "shell", desc });
    }
    return;
  }

  if (kind === "manage_task" && phase === "done" && !tool.isError) {
    const act = String(inp.Action || "").toLowerCase();
    const out = String(tool.output || "");
    if (act === "kill" && inp.TaskId) {
      state.onBgRemove?.(String(inp.TaskId));
    } else if (act === "status" && inp.TaskId) {
      const sepRe = /\r?\n(?:Command|Log) output:\r?\n/;
      const header = sepRe.test(out) ? out.split(sepRe)[0] : out.split(/\r?\n/, 8).join("\n");
      if (/\bStatus:\s*(?:DONE|COMPLETED|FAILED|ERROR|CANCELL?ED|KILLED|STOPPED)\b|\bTask\b[^\r\n]*\b(?:is not running|not found)\b/i.test(header)) {
        state.onBgRemove?.(String(inp.TaskId));
      }
    } else if (act === "list") {
      if (/No background tasks are currently running/i.test(out)) state.onBgClearTasks?.();
      else if (/\bTaskId\b|\btask-\d+\b/i.test(out)) state.onBgReconcileTasks?.(out);
    }
    return;
  }

  if (kind === "schedule" && phase === "done" && !tool.isError) {
    const out = String(tool.output || "");
    if (/\bWait cancell?ed\b|\balready finished\b/i.test(out)) return;
    const mId = /(?:TaskId|id)["':=\s]+([A-Za-z0-9._/-]*[A-Za-z0-9_/-])/i.exec(out);
    const tid = mId ? mId[1] : tool.id;
    const desc = String(inp.Prompt || inp.CronExpression || (inp.DurationSeconds ? `${inp.DurationSeconds}s 定时提醒` : "定时任务")).trim().slice(0, 80);
    const isCron = typeof inp.CronExpression === "string" && inp.CronExpression.trim().length > 0;
    if (isCron) {
      state.onBgAdd?.({ id: tid, type: "monitor", desc });
    } else {
      const durSec = Number(inp.DurationSeconds);
      const durMs = Number.isFinite(durSec) && durSec >= 0 ? durSec * 1000 : 60000;
      const timerCondition = typeof inp.TimerCondition === "string" && inp.TimerCondition.trim() ? inp.TimerCondition.trim() : "never";
      state.onBgAdd?.({
        id: tid,
        type: "monitor",
        desc,
        oneShot: true,
        expiresAt: Date.now() + durMs + 1500,
        timerCondition,
      });
    }
  }
}

/** 构造发往前端的 tool_result 事件（遵循前端 ok/text 契约，并保留 content/is_error/cancelled 字段） */
function emitToolResult(tool, emit, state = null) {
  const full = String(tool.output || "");
  const clipped = full.length > TOOL_OUT_MAX ? full.slice(0, TOOL_OUT_MAX) + "\n\n…（已截断）" : full;
  const isCancelled = !!tool.cancelled;
  const isErr = !isCancelled && !!tool.isError;
  tool.done = true;
  if (state) trackAcpToolSideEffects("done", tool, state, emit);
  emit({
    type: "tool_result",
    id: tool.id,
    ok: !isErr,
    text: clipped,
    content: clipped,
    is_error: isErr,
    ...(isCancelled ? { cancelled: true } : {}),
  });
}

/**
 * 将 ACP `session/update` 通知翻译为 hachimia 前端 SSE 事件并累积本轮状态。
 */
export function translateAcpUpdate(params, state, emit) {
  if (params?.sessionId && state?.sessionId && String(params.sessionId) !== String(state.sessionId)) return;
  const upd = params?.update || params || {};
  const kind = upd.sessionUpdate || upd.type || "";

  // 可用斜杠命令列表在会话初始化阶段就会发来，不受 promptSent 限制
  if (kind === "available_commands_update") {
    const cmds = Array.isArray(upd.availableCommands) ? upd.availableCommands : [];
    if (cmds.length) state.onCommands?.(cmds);
    return;
  }

  // 恢复会话时 agy 会把历史消息重放成 update（整条 agent_message 和各类 chunk）：
  // prompt 还没发出去之前到的事件都是历史，不算这一轮，不累积也不转给界面，
  // 同时把重放期间见过的 toolCallId 记入 knownToolIds，防止异步拖尾更新串进下一轮；
  // 重放消息的 messageId 也记下来，prompt 发出后迟到的同 id 重放照样丢弃（B3）
  if (state.promptSent === false) {
    state.replaySeenAt = Date.now();
    if ((kind === "agent_message" || kind === "agent_thought") && upd.messageId) {
      (state.replayMessageIds ||= new Set()).add(String(upd.messageId));
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const tid = String(upd.toolCallId || upd.id || "");
      if (tid) state.knownToolIds?.add(tid);
    }
    return;
  }

  // prompt 发出后才到的、prompt 前已见过的重放：按 messageId 丢弃（B3）
  const replayIds = state.replayMessageIds;
  const updMsgId = upd.messageId ? String(upd.messageId) : "";
  if (updMsgId && replayIds?.has(updMsgId) && (kind === "agent_message" || kind === "agent_message_chunk" || kind === "agent_thought" || kind === "agent_thought_chunk")) {
    return;
  }

  // 同一条消息整条与 chunk 双发时的去重账本（B1/B2）：按 messageId 记
  // 「整条已采用 → 后到的同文 chunk 跳过」「chunk 已累积 → 后到的同文整条跳过/只补差额」
  const fullTextIds = (state.fullTextIds ||= new Set());
  const chunkTextById = (state.chunkTextById ||= new Map());
  const fullThinkingIds = (state.fullThinkingIds ||= new Set());
  const chunkThinkingById = (state.chunkThinkingById ||= new Map());

  if (kind === "agent_message_chunk" || kind === "text_delta") {
    const text = acpTextOf(upd.content ?? upd.summary ?? upd.text);
    if (text) {
      if (updMsgId && fullTextIds.has(updMsgId)) return; // 整条已采用，这条 chunk 是重复投递
      if (updMsgId) chunkTextById.set(updMsgId, (chunkTextById.get(updMsgId) || "") + text);
      state.text += text;
      emit({ type: "text_delta", text });
    }
    return;
  }
  // 整条消息（v2 风格 upsert，不走 chunk；旧草稿的字段名叫 summary）：只在还没
  // 流式收到正文时整段采用，已经收到过的以 chunk 累积为准，避免重复渲染
  if (kind === "agent_message") {
    const text = acpTextOf(upd.content ?? upd.summary ?? upd.text);
    log(`[agy-acp] agent_message messageId=${upd.messageId || "-"} text=${(text || "").slice(0, 60).replace(/\n/g, " ")}`);
    if (!text) return;
    if (updMsgId) {
      if (fullTextIds.has(updMsgId)) return;
      const chunkAcc = chunkTextById.get(updMsgId) || "";
      if (chunkAcc === text) { fullTextIds.add(updMsgId); return; } // chunk 已把整条送完了
      if (chunkAcc && text.startsWith(chunkAcc)) { // 整条比已收 chunk 多：只补没收到的差额
        const rest = text.slice(chunkAcc.length);
        if (rest) { state.text += rest; emit({ type: "text_delta", text: rest }); }
        fullTextIds.add(updMsgId);
        return;
      }
      if (chunkAcc && chunkAcc.startsWith(text)) { fullTextIds.add(updMsgId); return; } // 整条是已收 chunk 的前缀
      fullTextIds.add(updMsgId);
    }
    if (!state.text) {
      state.text = text;
      emit({ type: "text_delta", text });
    }
    return;
  }

  if (kind === "agent_thought_chunk" || kind === "thinking_delta") {
    const text = acpTextOf(upd.content ?? upd.summary ?? upd.text);
    if (text) {
      if (updMsgId && fullThinkingIds.has(updMsgId)) return;
      if (updMsgId) chunkThinkingById.set(updMsgId, (chunkThinkingById.get(updMsgId) || "") + text);
      state.thinking += text;
      emit({ type: "thinking_delta", text });
    }
    return;
  }
  if (kind === "agent_thought") {
    const text = acpTextOf(upd.content ?? upd.summary ?? upd.text);
    if (!text) return;
    if (updMsgId) {
      if (fullThinkingIds.has(updMsgId)) return;
      const chunkAcc = chunkThinkingById.get(updMsgId) || "";
      if (chunkAcc === text) { fullThinkingIds.add(updMsgId); return; }
      if (chunkAcc && text.startsWith(chunkAcc)) {
        const rest = text.slice(chunkAcc.length);
        if (rest) { state.thinking += rest; emit({ type: "thinking_delta", text: rest }); }
        fullThinkingIds.add(updMsgId);
        return;
      }
      if (chunkAcc && chunkAcc.startsWith(text)) { fullThinkingIds.add(updMsgId); return; }
      fullThinkingIds.add(updMsgId);
    }
    if (!state.thinking) {
      state.thinking = text;
      emit({ type: "thinking_delta", text });
    }
    return;
  }

  if (kind === "tool_call") {
    const id = String(upd.toolCallId || upd.id || crypto.randomBytes(6).toString("hex"));
    // 已在历史 jsonl 或前置重放中见过的旧工具 ID：直接丢弃，杜绝历史工具卡重复弹出
    if (state.knownToolIds?.has(id) && !state.tools.has(id)) return;
    const name = String(upd.title || upd.name || upd.kind || "Tool");
    const input = upd.rawInput && typeof upd.rawInput === "object"
      ? upd.rawInput
      : (upd.input && typeof upd.input === "object" ? upd.input : {});
    const existing = state.tools.get(id);
    if (existing) {
      let changed = false;
      if ((upd.title || upd.name) && existing.name !== name) { existing.name = name; changed = true; }
      if (Object.keys(input).length) { existing.input = { ...existing.input, ...input }; changed = true; }
      if (upd.status && existing.status !== upd.status) { existing.status = upd.status; changed = true; }
      if (changed && !existing.done) {
        emit({ type: "tool_update", id, name: existing.name, input: existing.input, status: existing.status });
      }
      return;
    }
    const rec = { id, name, input, status: upd.status || "pending", output: "", isError: false, cancelled: false, done: false };
    state.tools.set(id, rec);
    emit({ type: "tool_use", id, name, input });
    trackAcpToolSideEffects("start", rec, state, emit);
    // 部分实现会在 tool_call 上直接带终态
    const st0 = String(upd.status || "").toLowerCase();
    if (st0 === "completed" || st0 === "failed" || st0 === "error" || st0 === "cancelled" || st0 === "canceled") {
      const out0 = acpTextOf(upd.content ?? upd.rawOutput ?? upd.output);
      if (out0) rec.output = mergeToolOutput(rec.output, out0);
      rec.cancelled = st0 === "cancelled" || st0 === "canceled";
      rec.isError = st0 === "failed" || st0 === "error";
      emitToolResult(rec, emit, state);
    }
    return;
  }

  if (kind === "tool_call_update") {
    const id = String(upd.toolCallId || upd.id || "");
    if (!id) return;
    if (state.knownToolIds?.has(id) && !state.tools.has(id)) return;
    let prev = state.tools.get(id);
    let changed = false;
    if (!prev) {
      const name = String(upd.title || upd.name || upd.kind || "Tool");
      const input = upd.rawInput && typeof upd.rawInput === "object"
        ? upd.rawInput
        : (upd.input && typeof upd.input === "object" ? upd.input : {});
      prev = { id, name, input, status: upd.status || "in_progress", output: "", isError: false, cancelled: false, done: false };
      state.tools.set(id, prev);
      emit({ type: "tool_use", id, name, input });
      trackAcpToolSideEffects("start", prev, state, emit);
    } else {
      if (upd.title || upd.name) {
        const nextName = String(upd.title || upd.name);
        if (nextName !== prev.name) { prev.name = nextName; changed = true; }
      }
      if (upd.rawInput && typeof upd.rawInput === "object" && Object.keys(upd.rawInput).length) {
        prev.input = { ...prev.input, ...upd.rawInput };
        changed = true;
      } else if (upd.input && typeof upd.input === "object" && Object.keys(upd.input).length) {
        prev.input = { ...prev.input, ...upd.input };
        changed = true;
      }
    }
    if (upd.status && upd.status !== prev.status) { prev.status = upd.status; changed = true; }
    const out = acpTextOf(upd.content ?? upd.rawOutput ?? upd.output);
    if (out) {
      const merged = mergeToolOutput(prev.output, out);
      if (merged !== prev.output) { prev.output = merged; changed = true; }
    }
    const st = String(upd.status || "").toLowerCase();
    const terminal = st === "completed" || st === "failed" || st === "error" || st === "cancelled" || st === "canceled";
    if (terminal) {
      prev.cancelled = st === "cancelled" || st === "canceled";
      prev.isError = st === "failed" || st === "error";
      emitToolResult(prev, emit, state);
    } else if (changed && !prev.done) {
      const fullOut = String(prev.output || "");
      const clippedOut = fullOut.length > TOOL_OUT_MAX ? fullOut.slice(-TOOL_OUT_MAX) : fullOut;
      emit({
        type: "tool_update",
        id: prev.id,
        name: prev.name,
        input: prev.input,
        status: prev.status,
        ...(clippedOut ? { output: clippedOut } : {}),
      });
    }
    return;
  }

  if (kind === "plan" && Array.isArray(upd.entries)) {
    emit({
      type: "tasks",
      sessionId: state.sessionId || null,
      tasks: upd.entries.map((e, idx) => ({
        id: String(idx + 1),
        subject: String(e.content || e.title || ""),
        status: e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending",
      })),
    });
    return;
  }

  if (kind === "usage" || kind === "usage_update" || upd.usage) {
    const nextUsage = extractAcpUsage(upd.usage || upd, state.usage, { isTurnTotal: false });
    if (nextUsage && (nextUsage.context_tokens > 0 || nextUsage.output_tokens > 0 || nextUsage.context_window > 0)) {
      state.usage = nextUsage;
      // /compact 轮次里 agy 发的 usage_update 往往是「生成压缩摘要那次 LLM 调用」的输入+缓存+输出总量（反而略高于压缩前）；
      // 先暂存到 state.usage，等回合结束后校验/修正再发给前端，避免压缩进行中上下文条瞬间爆红。
      if (!state.isCompact || state.sawCompacted) {
        if (state.usage.context_tokens > 0 || state.usage.context_window > 0) {
          emit({
            type: "usage",
            ...(state.usage.context_tokens > 0 ? { contextTokens: state.usage.context_tokens } : {}),
            ...(state.usage.context_window > 0 ? { contextWindow: state.usage.context_window } : {}),
            outputTokens: state.usage.output_tokens,
          });
        }
      }
      if (state.usage.output_tokens > 0) emit({ type: "run_tokens", out: state.usage.output_tokens });
    }
    return;
  }

  if (kind === "current_mode_update" && upd.currentModeId) {
    const mapped = mapAcpModeToUi(upd.currentModeId);
    // 客户端处于「全部放行」时（由 onRequest 自动批准实现），不要被服务端回传的 default / accept-edits 覆盖掉界面状态
    if (mapped && !(state.permMode === "bypassPermissions" && mapped !== "bypassPermissions")) {
      emit({ type: "perm_mode", mode: mapped });
    }
    return;
  }

  if (kind === "compaction_update") {
    const st = String(upd.status || upd.phase || "").toLowerCase();
    const pre = Number(upd.preTokens ?? upd.pre_tokens ?? upd.beforeTokens ?? 0) || null;
    const post = Number(upd.postTokens ?? upd.post_tokens ?? upd.afterTokens ?? 0) || null;
    if (st === "completed" || st === "done" || st === "finished" || post != null) {
      if (post && post > 0) {
        state.usage = { ...(state.usage || {}), context_tokens: post };
      }
      state.sawCompacted = true;
      emit({ type: "compacted", trigger: upd.trigger || "", pre, post });
    } else {
      emit({ type: "compacting" });
    }
    return;
  }

  if (kind === "notice") {
    const text = acpTextOf(upd.message ?? upd.text ?? upd.content).trim();
    if (text) emit({ type: "note", key: "acp-notice-" + String(upd.id || "0"), text: text.slice(0, 1200) });
    return;
  }

  // 已知但有意忽略的种类（不回显、不影响本轮正文），之外的记进日志：
  // 真机上 agy 发来新种类时，日志里能直接看到名字，不用再猜
  const IGNORED = new Set(["user_message", "user_message_chunk", "config_option_update", "session_info_update", "compaction_summary_chunk", "permission_confirmation"]);
  if (!IGNORED.has(kind)) log(`[agy-acp] 未识别的 update 种类：${kind}`);
}

/**
 * 仅追加助手回复与工具记录（无 user 行）：用于 ACP 空闲期间后台任务 / 子代理主动唤醒回报落盘。
 */
export function persistAcpAssistantOnly({ cwd, sessionId, assistantText, thinking, tools, model, usage }) {
  if (!sessionId) return;
  const list = Array.isArray(tools) ? tools : [];
  if (!assistantText && !thinking && !list.length) return;
  const file = acpSessionFile(cwd, sessionId);
  if (!list.length) {
    const blocks = [];
    if (thinking) blocks.push({ type: "thinking", thinking });
    if (assistantText) blocks.push({ type: "text", text: assistantText });
    appendJsonl(file, {
      type: "assistant",
      uuid: crypto.randomUUID(),
      parentUuid: null,
      sessionId,
      cwd,
      timestamp: new Date().toISOString(),
      message: {
        id: "acp-" + crypto.randomUUID(),
        role: "assistant",
        model: model || "antigravity",
        content: blocks,
        ...(usage ? { usage } : {}),
      },
    });
    return;
  }
  const toolAsstUuid = crypto.randomUUID();
  const toolBlocks = [];
  if (thinking) toolBlocks.push({ type: "thinking", thinking });
  for (const t of list) toolBlocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.input || {} });
  appendJsonl(file, {
    type: "assistant",
    uuid: toolAsstUuid,
    parentUuid: null,
    sessionId,
    cwd,
    timestamp: new Date().toISOString(),
    message: {
      id: "acp-" + crypto.randomUUID(),
      role: "assistant",
      model: model || "antigravity",
      content: toolBlocks,
      ...(!assistantText && usage ? { usage } : {}),
    },
  });
  const resUuid = crypto.randomUUID();
  appendJsonl(file, {
    type: "user",
    uuid: resUuid,
    parentUuid: toolAsstUuid,
    sessionId,
    cwd,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: list.map((t) => ({
        type: "tool_result",
        tool_use_id: t.id,
        content: String(t.output || "").slice(0, TOOL_OUT_MAX),
        is_error: !!t.isError,
      })),
    },
  });
  if (assistantText) {
    appendJsonl(file, {
      type: "assistant",
      uuid: crypto.randomUUID(),
      parentUuid: resUuid,
      sessionId,
      cwd,
      timestamp: new Date().toISOString(),
      message: {
        id: "acp-" + crypto.randomUUID(),
        role: "assistant",
        model: model || "antigravity",
        content: [{ type: "text", text: assistantText }],
        ...(usage ? { usage } : {}),
      },
    });
  }
}

/**
 * 在 ACP 回合发出 session/prompt 之前先把用户提问写入本地 jsonl：
 * 让新会话首轮进行中就能出现在侧栏/会话页，切走也能随时点回来（不依赖整轮结束才落盘）。
 * 返回写入的 userUuid，回合结束时交回 persistAcpTurn 续写助手/工具行、避免重复写用户行。
 */
export function persistAcpUserTurn({ cwd, sessionId, userText, timestamp = null }) {
  if (!sessionId) return null;
  const file = acpSessionFile(cwd, sessionId);
  const userUuid = crypto.randomUUID();
  appendJsonl(file, {
    type: "user",
    uuid: userUuid,
    parentUuid: null,
    sessionId,
    cwd,
    timestamp: timestamp || new Date().toISOString(),
    message: { role: "user", content: userText },
  });
  return userUuid;
}

/**
 * 将一次 ACP 对话回合持久化到本地 jsonl，兼容 sessions.mjs / transcript.mjs。
 * 有工具调用时按标准 transcript 结构把 tool_use 与 tool_result 分行落盘，
 * 使历史重载能完整还原每个工具的完成/失败状态与输出正文。
 */
export function persistAcpTurn({ cwd, sessionId, userText, assistantText, thinking, tools, model, usage, existingUserUuid = null }) {
  if (!sessionId) return;
  const file = acpSessionFile(cwd, sessionId);
  const now = new Date().toISOString();
  const userUuid = existingUserUuid || crypto.randomUUID();
  const list = Array.isArray(tools) ? tools : [];

  if (!existingUserUuid) {
    appendJsonl(file, {
      type: "user",
      uuid: userUuid,
      parentUuid: null,
      sessionId,
      cwd,
      timestamp: now,
      message: { role: "user", content: userText },
    });
  }

  if (!list.length) {
    const blocks = [];
    if (thinking) blocks.push({ type: "thinking", thinking });
    if (assistantText) blocks.push({ type: "text", text: assistantText });
    appendJsonl(file, {
      type: "assistant",
      uuid: crypto.randomUUID(),
      parentUuid: userUuid,
      sessionId,
      cwd,
      timestamp: new Date().toISOString(),
      message: {
        id: "acp-" + crypto.randomUUID(),
        role: "assistant",
        model: model || "antigravity",
        content: blocks.length ? blocks : [{ type: "text", text: "" }],
        ...(usage ? { usage } : {}),
      },
    });
    return;
  }

  const toolAsstUuid = crypto.randomUUID();
  const toolBlocks = [];
  if (thinking) toolBlocks.push({ type: "thinking", thinking });
  for (const t of list) {
    toolBlocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.input || {} });
  }
  appendJsonl(file, {
    type: "assistant",
    uuid: toolAsstUuid,
    parentUuid: userUuid,
    sessionId,
    cwd,
    timestamp: new Date().toISOString(),
    message: {
      id: "acp-" + crypto.randomUUID(),
      role: "assistant",
      model: model || "antigravity",
      content: toolBlocks,
      ...(!assistantText && usage ? { usage } : {}),
    },
  });

  const resUuid = crypto.randomUUID();
  const resBlocks = list.map((t) => ({
    type: "tool_result",
    tool_use_id: t.id,
    content: String(t.output || "").slice(0, TOOL_OUT_MAX),
    is_error: !!t.isError,
  }));
  appendJsonl(file, {
    type: "user",
    uuid: resUuid,
    parentUuid: toolAsstUuid,
    sessionId,
    cwd,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: resBlocks },
  });

  if (assistantText) {
    appendJsonl(file, {
      type: "assistant",
      uuid: crypto.randomUUID(),
      parentUuid: resUuid,
      sessionId,
      cwd,
      timestamp: new Date().toISOString(),
      message: {
        id: "acp-" + crypto.randomUUID(),
        role: "assistant",
        model: model || "antigravity",
        content: [{ type: "text", text: assistantText }],
        ...(usage ? { usage } : {}),
      },
    });
  }
}

function poolKey({ bin, args, cwd, authType, apiKey }) {
  const keyHash = apiKey ? crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 12) : "";
  return JSON.stringify([bin, args, cwd, authType || "", keyHash]);
}

function mapUiModeToAcp(permMode, availableModes) {
  const ids = Array.isArray(availableModes) ? availableModes.map((m) => String(m?.id || m?.value || "")).filter(Boolean) : [];
  const pick = (...candidates) => {
    if (!ids.length) return candidates[0];
    for (const c of candidates) if (ids.includes(c)) return c;
    return "";
  };
  switch (permMode) {
    case "bypassPermissions":
      // agy acp 1.5.13 声明的模式是 default / accept-edits / plan：没有服务端 bypassPermissions 时
      // 优先切到 accept-edits 减少写文件往返，其余命令权限由 onRequest 自动放行
      return pick("bypassPermissions", "yolo", "auto_approve", "accept-edits", "acceptEdits", "default");
    case "acceptEdits":
      return pick("accept-edits", "acceptEdits", "default");
    case "plan":
      return pick("plan", "default");
    case "auto":
      return pick("auto", "accept-edits", "acceptEdits", "default");
    default:
      return pick("default");
  }
}

/**
 * 执行一轮完整的 `agy acp` 对话回合（initialize → authenticate → session/new|resume|load → session/prompt）。
 * 在 LIVE 模式下（或显式 keepAlive: true），按 sessionId 复用常驻 `agy acp` 进程，避免每轮重启。
 */
export async function runAcpTurn({
  bin, args = ["acp"], cwd, env, prompt, displayPrompt = null, images = [], sessionId = null,
  model = "", effort = "", permMode = "default", authType = "", apiKey = "",
  mcpServers = [], addDirs = [], run, emit, askPermission, onBgChange, onBgWake = null,
  bgPollMs = ACP_BG_POLL_MS, bgGraceMs = ACP_BG_GRACE_MS, probeBgShell = acpBgShellActive,
  onSessionFileReady = null, timeoutMs = 0, idleTimeoutMs = 0,
  keepAlive = LIVE && process.env.CCAPP_ACP_KEEPALIVE !== "0",
}) {
  const t0 = Date.now();
  const turnScope = `turn:${run?.id || crypto.randomBytes(4).toString("hex")}`;
  const bgTasks = new Map();
  let clientRef = null;
  let daemonChildKeys = new Set();
  const noteDaemonChild = () => {
    const pid = clientRef?.child?.pid;
    const kids = listAcpChildren(pid);
    if (!kids?.length) return;
    const fresh = kids.filter((c) => !daemonChildKeys.has(c.key));
    if (!fresh.length) return;
    fresh.sort((a, b) => (Number(b.startTicks) - Number(a.startTicks)) || (b.pid - a.pid));
    daemonChildKeys.add(fresh[0].key);
  };
  const syncBg = () => {
    pruneExpiredBgTasks(turnScope, bgTasks);
    const list = [...bgTasks.values()];
    if (run) {
      run.bgList = list;
      run.bgTasks = list.length;
    }
    onBgChange?.(list);
  };
  const state = {
    text: "",
    thinking: "",
    tools: new Map(),
    knownToolIds: sessionId ? readKnownToolIds(cwd, sessionId) : new Set(),
    usage: null,
    promptSent: false,
    replaySeenAt: 0,
    permMode,
    cwd,
    sessionId: sessionId || null,
    onBgAdd: (t) => {
      if (!t || !t.id) return;
      const item = {
        id: String(t.id),
        type: t.type || "shell",
        desc: String(t.desc || t.id),
        ...(t.oneShot ? { oneShot: true, expiresAt: Number(t.expiresAt) || 0, timerCondition: String(t.timerCondition || "never") } : {}),
      };
      bgTasks.set(item.id, item);
      if (item.type === "daemon") noteDaemonChild();
      armBgExpiryTimer(turnScope, bgTasks, item, syncBg);
      syncBg();
    },
    onBgRemove: (id) => {
      if (!id) return;
      if (removeBgTaskAndDependents(turnScope, bgTasks, id)) syncBg();
    },
    onBgClearTasks: () => {
      let changed = false;
      for (const [k, v] of bgTasks) {
        if (v.type !== "agent" && v.type !== "workflow") {
          clearBgExpiryTimer(turnScope, k);
          bgTasks.delete(k);
          changed = true;
        }
      }
      if (changed) syncBg();
    },
    onBgReconcileTasks: (outText) => {
      if (reconcileBgTasksFromList(turnScope, bgTasks, outText)) syncBg();
    },
    onCommands: (cmds) => {
      const names = [];
      const meta = {};
      for (const c of cmds) {
        const n = String(c?.name || "").replace(/^\//, "").trim();
        if (!n) continue;
        names.push(n);
        meta[n] = { description: String(c?.description || "").trim(), input: c?.input || null };
      }
      if (names.length) {
        setLastInit({
          slash_commands: names,
          slash_command_meta: meta,
        });
        const caps = buildCapabilities();
        publish({ type: "caps_updated", slashCommands: caps.slashCommands, version: caps.version, tier: caps.tier });
      }
    },
  };
  let activeSessionId = sessionId || null;
  let pendingPermCount = 0;
  const pKey = poolKey({ bin, args, cwd, authType, apiKey });

  const isBenignStderr = (line) => /logging before google\.Init:.*Initialized Android local timezone/i.test(line);
  const makeHandlers = () => ({
    onStderr: (s) => {
      const line = s.trim();
      if (line && !isBenignStderr(line)) log(`[agy-acp!] ${line.slice(0, 300)}`);
    },
    onNotification: (method, params) => {
      if (method === "session/update") {
        translateAcpUpdate(params, state, emit);
      }
    },
    onRequest: async (method, params) => {
      if (method === "session/request_permission") {
        const options = Array.isArray(params.options) ? params.options : [];
        const allowOpt = pickAcpAllowOption(options);
        const allowAlwaysOpt = options.find(isAcpAllowAlwaysOpt) || null;
        const rejectOpt = options.find(isAcpRejectOpt);

        if (permMode === "bypassPermissions" && allowOpt) {
          return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
        }
        if (!askPermission) {
          return rejectOpt
            ? { outcome: { outcome: "selected", optionId: rejectOpt.optionId } }
            : { outcome: { outcome: "cancelled" } };
        }
        pendingPermCount++;
        let decision;
        try {
          decision = await askPermission({
            tool: params.toolCall?.title || params.toolCall?.name || params.toolCall?.kind || "Antigravity Tool",
            toolCallId: params.toolCall?.toolCallId || params.toolCall?.id || "",
            input: params.toolCall?.rawInput || params.toolCall?.input || params.toolCall || {},
            options,
            hasAlways: !!allowAlwaysOpt,
          });
        } finally {
          pendingPermCount = Math.max(0, pendingPermCount - 1);
        }
        if (decision && decision.behavior === "allow") {
          const chosen = decision.always && allowAlwaysOpt ? allowAlwaysOpt : allowOpt;
          return chosen
            ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
            : { outcome: { outcome: "cancelled" } };
        }
        return rejectOpt
          ? { outcome: { outcome: "selected", optionId: rejectOpt.optionId } }
          : { outcome: { outcome: "cancelled" } };
      }
      throw new Error(`Unsupported ACP client callback: ${method}`);
    },
  });

  // 尝试复用池中同会话同配置的常驻进程
  let poolEntry = null;
  let reused = false;
  if (keepAlive && activeSessionId) {
    const hit = ACP_POOL.get(activeSessionId);
    if (hit && !hit.busy && !hit.client.closed && hit.key === pKey) {
      // 复用前先停掉空闲期后台命令补唤醒监听器并冲刷已收到的后台唤醒回报，确保顺序不交叉
      try { hit.clearBgWatch?.(); } catch {}
      try { hit.flushIdle?.(); } catch {}
      poolEntry = hit;
      reused = true;
      if (poolEntry.idleTimer) { clearTimeout(poolEntry.idleTimer); poolEntry.idleTimer = null; }
      poolEntry.busy = true;
      if (poolEntry.daemonChildKeys?.size) daemonChildKeys = new Set(poolEntry.daemonChildKeys);
      if (poolEntry.knownToolIds) for (const tid of poolEntry.knownToolIds) state.knownToolIds.add(tid);
      if (poolEntry.bgTasks) {
        pruneExpiredBgTasks(`pool:${activeSessionId}`, poolEntry.bgTasks);
        clearAllBgExpiryTimers(`pool:${activeSessionId}`);
        for (const [k, v] of poolEntry.bgTasks) {
          bgTasks.set(k, v);
          armBgExpiryTimer(turnScope, bgTasks, v, syncBg);
        }
      }
      if (poolEntry.acpAgents) state.acpAgents = poolEntry.acpAgents;
      if (poolEntry.acpAgentsByConv) state.acpAgentsByConv = poolEntry.acpAgentsByConv;
      if (poolEntry.acpAgentDirs) state.acpAgentDirs = poolEntry.acpAgentDirs;
      syncBg();
      poolEntry.client.setHandlers(makeHandlers());
    } else if (hit && !hit.busy) {
      closeAcpSession(activeSessionId);
    }
  }

  const client = reused ? poolEntry.client : createAcpClient({
    bin,
    args,
    cwd,
    env,
    ...makeHandlers(),
  });
  clientRef = client;

  const destroyClient = () => {
    if (activeSessionId && ACP_POOL.get(activeSessionId)?.client === client) {
      closeAcpSession(activeSessionId);
    } else {
      try { client.close(); } catch {}
      killAcpChild(client.child);
    }
  };

  let canKeep = false;
  let sessModels = poolEntry?.models || null;
  let sessModes = poolEntry?.modes || null;
  let sessConfig = poolEntry?.configOptions || null;

  // MIG-7：agent 实际在跑的权限模式。init 宣称的是用户要的模式（permMode），但 agent
  // 只有在 set_mode 成功后才真切过去；新会话默认 default，复用会话沿用池里记的。
  // set_mode 被拒时按这个值纠回（发 perm_mode 事件），不能按 state.permMode 纠——
  // state.permMode 在轮次开始时就被置成了宣称的模式，纠它等于没纠。
  // 只有 agent 确认成功时才更新；还没建会话就调 setMode 时只记请求、不更新（内联步骤会真正去申请）。
  let effectivePermMode = poolEntry?.permMode || "default";
  // 向 agent 申请切模式；被拒时发 error 事件并把三处模式纠回被拒前的实际值（再发 perm_mode 事件）。
  const applyMode = async (mode) => {
    const prev = effectivePermMode;
    const modeId = mapUiModeToAcp(mode, sessModes?.availableModes);
    if (!modeId) return false;
    try {
      await client.request("session/set_mode", { sessionId: activeSessionId, modeId }, 5000);
      effectivePermMode = mode;
      return true;
    } catch (e) {
      permMode = prev;
      state.permMode = prev;
      if (run) run.permMode = prev;
      emit({ type: "error", message: tz("切换权限模式失败（agent 拒绝了 {mode}）：{msg}", { mode, msg: String(e?.message || e) }) });
      emit({ type: "perm_mode", mode: prev });
      return false;
    }
  };

  const dropActiveBg = (tid) => {
    let removed = false;
    const poolScope = activeSessionId ? `pool:${activeSessionId}` : "";
    if (tid) {
      if (removeBgTaskAndDependents(turnScope, bgTasks, tid)) removed = true;
      if (poolEntry?.bgTasks && removeBgTaskAndDependents(poolScope, poolEntry.bgTasks, tid)) removed = true;
    } else {
      if (bgTasks.size > 0 || poolEntry?.bgTasks?.size > 0) removed = true;
      clearAllBgExpiryTimers(turnScope);
      if (poolScope) clearAllBgExpiryTimers(poolScope);
      bgTasks.clear();
      poolEntry?.bgTasks?.clear();
    }
    if (removed) syncBg();
    return removed;
  };
  if (poolEntry) poolEntry.dropActiveBg = dropActiveBg;

  if (run) {
    run.child = client.child;
    run.preSpawn = false;
    run.dropAcpBg = dropActiveBg;
    // 停止只停当前 prompt，不销毁保活进程：进程留在池里供下轮复用（B10）。
    // 进程回收只由空闲超时 / 显式 closeAcpSession / 网关关闭负责。
    run.cancelAcp = () => {
      if (activeSessionId) client.notify("session/cancel", { sessionId: activeSessionId });
    };
    // set_mode 被 agent 拒绝时返回 false 并发 error 事件，不再静默返回 true（B11）。
    // 被拒时 applyMode 会把模式纠回被拒前的实际值并再发 perm_mode 事件（MIG-7）。
    // 返回 Promise<boolean>：调用方 await 它才能知道是否真切过去了。
    run.setMode = (mode) => {
      permMode = mode;
      state.permMode = mode;
      run.permMode = mode;
      if (activeSessionId && !client.closed) return applyMode(mode);
      return Promise.resolve(true);
    };
  }

  let usedLoad = false;
  // 本轮进来时用户指着的旧会话号；agent 不支持 resume/load 时会被静默换成新会话（B8），要明示
  const requestedSessionId = activeSessionId;
  let sessionSwitched = false;
  // MIG-6：agent 确认生效的 effort（池里只记这个；不记请求值，否则下轮以为已生效不再重发）
  let effortApplied = null;

  try {
    if (!reused) {
      // 1. initialize
      const initRes = await client.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "hachimia", version: "0.1.0" },
      }, 30000);
      if (initRes?.agentInfo?.version) {
        setLastInit({ version: String(initRes.agentInfo.version) });
      }

      // 2. authenticate（若 agent 声明了 authMethods 且我们指定了认证方式）
      const authMethods = Array.isArray(initRes?.authMethods) ? initRes.authMethods : [];
      // 厂商自己的 api-key 类型（deepseek-api-key 等，见 providers.mjs 的 acpAuthType）不是
      // ACP 官方认证方法，agy 永远不会声明它：不得按 A16 抛错，也不得把别家 key 塞进
      // authenticate 的 _meta（C2）。注意：这种 key 没有带外通道——agy 只认 Gemini 协议
      // 的 API Key 模式，Anthropic 协议的第三方厂商在 agy-only ACP 下无 key 可跑（rem-C2；
      // 旧注释称“key 由 agyEnv/settings 等带外通道交给 agy”是错的）。只有厂商明确声明
      // protocol:"gemini" 时，key 才经 agyEnv（GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL）
      // 与 settings.json（modelProvider=gemini）交给 agy，且 acpAuthType 会把它映射成
      // gemini-api-key，不走这条豁免。这里跳过 authenticate，只是别让没通道的厂商
      // 在认证这一步先报一个误导性的错；模型调用时 agy 仍会因无 key 而失败。
      const isVendorApiKey = typeof authType === "string" && authType !== "gemini-api-key" && /-api-key$/.test(authType);
      if (isVendorApiKey) log(`[agy-acp] ${authType}：非 ACP 官方认证方法，跳过 authenticate（agy 无通用第三方 bearer 通道，见 rem-C2；仅 protocol:"gemini" 的厂商经 agyEnv/settings 交 key）`);
      // agent 声明了认证方式、却不含网关要用的那一种时，不得静默跳过、用默认/错误的
      // 认证跑下去——当场失败并报出双方的 id（A16）。agent 什么都没声明时保持旧行为
      // （跳过），那种 agent 不靠 ACP authenticate 认证。
      if (authType && !isVendorApiKey && authMethods.length && !authMethods.some((m) => m.id === authType)) {
        const declared = authMethods.map((m) => m.id).filter(Boolean).join(", ") || "(无)";
        throw new Error(`[agy-acp] agent 未声明认证方式 ${authType}（已声明：${declared}），无法按该方式认证`);
      }
      if (authType && !isVendorApiKey && authMethods.some((m) => m.id === authType)) {
        const authParams = { methodId: authType };
        if (authType === "gemini-api-key" && apiKey) {
          authParams._meta = { "api-key": apiKey };
        }
        try {
          await client.request("authenticate", authParams, 20000);
        } catch (e) {
          // 已通过 keyring 或环境变量认证时，部分版本会报“已认证过”——这种情况才继续；
          // 其他报错（key 错、过期、被拒）必须当场失败，不能只记一行日志继续跑（A16）。
          if (/already (authenticated|authorized|logged in|signed in)|authentication (not required|not needed)/i.test(e.message || "")) {
            log(`[agy-acp] authenticate(${authType})：已认证过，继续`);
          } else {
            throw new Error(`[agy-acp] authenticate(${authType}) 失败：${e.message}`);
          }
        }
      }

      // 3. 优先 session/resume（无历史重放），其次回落 session/load，最后 session/new
      //    hachimia 自己从本地 jsonl 渲染历史，调 session/load 会在长会话上引发异步重放与提前返回（无限月读）
      const caps = initRes?.agentCapabilities || {};
      const canResume = !!(caps.sessionCapabilities?.resume || caps.session_capabilities?.resume);
      const canLoad = !!(caps.loadSession || caps.load_session || caps.sessionCapabilities?.load || caps.session_capabilities?.load);
      const requestedSessionId = activeSessionId;
      let sessRes = null;
      let resumeErr = null;
      let loadErr = null;
      if (requestedSessionId && canResume) {
        try {
          sessRes = await client.request("session/resume", {
            sessionId: requestedSessionId,
            cwd,
            mcpServers,
          }, 45000);
        } catch (e) {
          resumeErr = e;
          log(`[agy-acp] session/resume 失败，尝试 session/load: ${e.message}`);
        }
      }
      if (!sessRes && requestedSessionId && canLoad) {
        try {
          sessRes = await client.request("session/load", {
            sessionId: requestedSessionId,
            cwd,
            mcpServers,
          }, 90000);
          usedLoad = true;
        } catch (e) {
          loadErr = e;
          log(`[agy-acp] session/load 失败（保留原会话号不静默新建）: ${e.message}`);
        }
      }
      // 续聊已有会话且 Agent 支持 resume/load 时，若两者均失败/超时，绝不静默清空 activeSessionId 建新会话；
      // 仅当 Agent 明确不支持 resume/load（!canResume && !canLoad）时，才按 B8 建新会话并发切换提示。
      if (!sessRes && requestedSessionId && (canResume || canLoad)) {
        const why = loadErr?.message || resumeErr?.message || "恢复会话失败";
        throw new Error(tz("无法恢复原会话（{why}），已保留当前会话未新建，请重试或手动开启新对话", { why }));
      }
      if (!sessRes) {
        const extraDirs = Array.isArray(addDirs) ? addDirs.filter((d) => typeof d === "string" && d.trim()) : [];
        const canAddDirs = !!(caps.sessionCapabilities?.additionalDirectories || caps.session_capabilities?.additionalDirectories);
        sessRes = await client.request("session/new", {
          cwd,
          mcpServers,
          ...(canAddDirs && extraDirs.length ? { additionalDirectories: extraDirs } : {}),
        }, 30000);
        // MIG-22：agent 不回会话号时当场报错——自造一个 agent 不认识的 UUID 只会让
        // 下一轮 resume/load 必然失败、循环产生孤儿会话，不如停在这里明示。
        if (!sessRes?.sessionId) throw new Error(tz("新建会话失败：Agent 没有返回会话号，请重试"));
        activeSessionId = sessRes.sessionId;
      }
      // 旧会话没续上、悄悄换了新会话号：明示给用户，别静默抛弃旧会话（B8）
      if (requestedSessionId && activeSessionId && activeSessionId !== requestedSessionId) {
        sessionSwitched = true;
        emit({ type: "note", key: "acp-session-switched", text: tz("旧会话无法恢复（Agent 不支持恢复或恢复失败），已新建会话继续。本轮写进了新会话，旧会话的历史仍保留在本地记录中。") });
      }
      sessModels = sessRes?.models || null;
      sessModes = sessRes?.modes || null;
      sessConfig = Array.isArray(sessRes?.configOptions) ? sessRes.configOptions : null;
      const tier = sessRes?._meta?.antigravity?.tier;
      if (tier?.name) {
        setLastInit({ tier: String(tier.name) });
        noteAuthTier(tier);
      }
    }

    state.sessionId = activeSessionId;
    if (run) run.sessionId = activeSessionId;
    // C6：agent 明确列出可用模型、所选模型不在其中时，不得静默跳过 set_config_option、
    // 又在下面的 init 里宣称已切到新模型——在 init 发出前就失败，让调用方知道没切过去。
    // agent 没列清单（两处都不是数组）时沿用旧行为：直接发 set_config_option，由 agent 决定。
    const cfgModelOpts = sessConfig?.find((c) => c.id === "model")?.options;
    const availModels = sessModels?.availableModels;
    const modelListsDeclared = (Array.isArray(cfgModelOpts) && cfgModelOpts.length > 0)
      || (Array.isArray(availModels) && availModels.length > 0);
    const modelOffered = !modelListsDeclared
      || (Array.isArray(cfgModelOpts) && cfgModelOpts.some((o) => o.value === model || o.id === model))
      || (Array.isArray(availModels) && availModels.some((m) => m.modelId === model || m.id === model));
    const modelSwitchNeeded = !!(model && (!reused || poolEntry?.model !== model));
    if (modelSwitchNeeded && !modelOffered) {
      const offered = [
        ...(Array.isArray(availModels) ? availModels.map((m) => m.modelId || m.id).filter(Boolean) : []),
        ...(Array.isArray(cfgModelOpts) ? cfgModelOpts.map((o) => o.value || o.id).filter(Boolean) : []),
      ];
      throw new Error(`[agy-acp] agent 不提供模型 ${model}（可用：${[...new Set(offered)].join(", ") || "(无)"}），无法切换`);
    }
    const activeModel = model || sessModels?.currentModelId || "antigravity";
    const capsNow = buildCapabilities();
    emit({
      type: "init",
      sessionId: activeSessionId,
      model: activeModel,
      permissionMode: permMode,
      tools: capsNow.tools,
      slashCommands: capsNow.slashCommands,
      skills: capsNow.skills,
      agents: capsNow.agents,
      plugins: capsNow.plugins,
      mcpServers: capsNow.mcpServers,
      version: capsNow.version,
      tier: capsNow.tier,
      protocol: "acp",
    });

    // F-2：/goal 在 ACP 下没有原生等价物，发给 agy 只会被当未知命令。会话建立后在网关本地处理：
    // 设定/清除写 goal_status 落盘，goalStateOf 与 4 秒轮询照常读到；不发 session/prompt。
    const goalArgs = parseGoalPrompt(prompt);
    if (goalArgs !== null) {
      const goalRes = applyGoalCommand(acpSessionFile(cwd, activeSessionId), goalArgs);
      const goalText = goalRes.text;
      emit({ type: "result", sessionId: activeSessionId, resultText: goalText, stopReason: "end_turn", durationMs: Date.now() - t0, costUsd: 0 });
      canKeep = keepAlive && !client.closed && !run?.aborted && !!activeSessionId;
      return { ok: true, sessionId: activeSessionId, model: activeModel, toolCount: 0, resultText: goalText, stopReason: "end_turn", durationMs: Date.now() - t0, usage: null, reused };
    }

    // 4. 可选：应用模型、思考强度与权限模式（兼容 models.availableModels 与 configOptions）
    //    模型不在清单里时上面已在 init 前抛错，这里只剩“清单没列 / 在清单里”两种情况，直接发。
    if (modelSwitchNeeded) {
      await client.request("session/set_config_option", {
        sessionId: activeSessionId,
        configId: "model",
        value: model,
      }, 10000).catch(() => {});
    }
    // MIG-6：thought_level 不在 agent 的 options 里时不得静默跳过——发 note 明示
    // “该模型不支持此档位，已按默认跑”，不发 set_config_option；被 agent 拒绝时同样发 note，
    // 绝不 .catch(()=>{}) 吞掉。两种情况 effortApplied 都留 null，池里不记为已生效，下轮重发。
    if (effort && (!reused || poolEntry?.effort !== effort)) {
      const effOpts = sessConfig?.find((c) => c.id === "thought_level")?.options;
      if (Array.isArray(effOpts) && !effOpts.some((o) => o.value === effort)) {
        emit({ type: "note", key: "acp-effort-unsupported", text: tz("该模型不支持思考强度「{effort}」，已按默认跑。", { effort }) });
      } else {
        try {
          await client.request("session/set_config_option", {
            sessionId: activeSessionId,
            configId: "thought_level",
            value: effort,
          }, 10000);
          effortApplied = effort;
        } catch (e) {
          emit({ type: "note", key: "acp-effort-rejected", text: tz("思考强度「{effort}」设置被 agent 拒绝（{msg}），已按默认跑。", { effort, msg: String(e?.message || e) }) });
        }
      }
    } else if (effort && reused && poolEntry?.effort === effort) {
      effortApplied = effort;   // 复用且池里记着已生效：本轮没重发，但仍是已生效的状态
    }
    if (permMode && (!reused || poolEntry?.permMode !== permMode)) {
      // MIG-7：复用 run.setMode 的报错路径（被拒时发 error 事件并把 init 已宣称的模式纠回），
      // 不得静默吞掉。run 不存在时（直调）走同一份 applyMode。
      await applyMode(permMode);
    }

    // 若走的是 session/load 回落路径，排空异步重放再开闸（B3）：
    // 以前只在「load 返回时已经见过重放」才等，重放在 load 返回后才开始到时不等直接发 prompt，
    // 重放随后到达即混进本轮。现在 load 后必等：至少等 600ms 让迟到重放落地，
    // 期间有重放就按 200ms 静默期顺延，最多等 1500ms，避免长会话每次续跑都拖太久。
    if (usedLoad) {
      const drainStart = Date.now();
      const waitEnd = drainStart + 1500;
      while (Date.now() < waitEnd) {
        const quietMs = Date.now() - state.replaySeenAt;
        if (Date.now() - drainStart >= 600 && quietMs >= 200) break;
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    // 5. session/prompt
    const contentBlocks = [{ type: "text", text: prompt }];
    for (const img of images) {
      if (img?.source?.data && img?.source?.media_type) {
        contentBlocks.push({ type: "image", data: img.source.data, mimeType: img.source.media_type });
      }
    }

    const isCompactCmd = /^\/compact(?:\s|$)/i.test(String(prompt || "").trim());
    const isBgWake = run?.auto === "bg";
    const preCompactCtx = Number(poolEntry?.lastContextTokens) || 0;
    if (isCompactCmd) emit({ type: "compacting" });
    else emit({ type: "phase", phase: "wait" });
    // 从这里起的事件才算这一轮：之前的都是 agy 重放的历史（见 translateAcpUpdate 的守卫）
    state.isCompact = isCompactCmd;
    state.promptSent = true;
    state.sawCompacted = false;
    state.text = ""; state.thinking = ""; state.tools.clear();
    // 首轮 / 普通回合在发出 session/prompt 前就先把用户行落盘，让新会话立刻出现在侧栏与 /api/sessions；
    // timestamp 确保 >= run.startedAt，使进行中重开该会话时 excludeFrom 过滤掉此行、与 live SSE 不重画。
    if (activeSessionId && !isCompactCmd && !isBgWake) {
      const userTs = new Date(Math.max(Date.now(), (run?.startedAt || 0) + 1)).toISOString();
      state.persistedUserUuid = persistAcpUserTurn({
        cwd,
        sessionId: activeSessionId,
        userText: displayPrompt != null ? displayPrompt : prompt,
        timestamp: userTs,
      });
      try { onSessionFileReady?.(activeSessionId); } catch {}
    }
    const promptTimeoutCfg = timeoutMs > 0
      ? { timeoutMs }
      : {
          idleTimeoutMs: idleTimeoutMs > 0 ? idleTimeoutMs : ACP_DEFAULT_PROMPT_TIMEOUT_MS,
          maxTotalMs: ACP_MAX_PROMPT_TIMEOUT_MS,
          shouldExtend: () => pendingPermCount > 0 || run?.perms?.size > 0,
        };
    const promptRes = await client.request("session/prompt", {
      sessionId: activeSessionId,
      prompt: contentBlocks,
    }, promptTimeoutCfg);

    // 补采 promptRes.usage（整轮累计统计：保留单步 usage_update 的真实 context_tokens，不拿多步累加值冲爆上下文条）
    if (promptRes?.usage) {
      const hadCtx = Number(state.usage?.context_tokens) > 0;
      const mergedUsage = extractAcpUsage(promptRes.usage, state.usage, { isTurnTotal: true });
      if (mergedUsage) {
        state.usage = mergedUsage;
        if (!hadCtx && (!isCompactCmd || state.sawCompacted) && state.usage.context_tokens > 0) {
          emit({
            type: "usage",
            contextTokens: state.usage.context_tokens,
            ...(state.usage.context_window > 0 ? { contextWindow: state.usage.context_window } : {}),
            outputTokens: state.usage.output_tokens,
          });
        }
        if (state.usage.output_tokens > 0) emit({ type: "run_tokens", out: state.usage.output_tokens });
      }
    }

    const stopReason = promptRes?.stopReason || "end_turn";

    // agy acp 1.5.13 执行 /compact 时不发 compaction_update 也不吐正文，只回 usage_update + end_turn：
    // 1. 若 agent 直接报出更低的 context_tokens（post < pre），按精确值补发 compacted；
    // 2. 真实 agy 1.5.13 做 CHECKPOINT 摘要时，usage_update.used 报的是「做摘要那次 LLM 调用的输入+缓存+输出总量」
    //    （反而比压缩前多几千 token，如 450,543 → 455,052），而真正生成的新摘要量是 output_tokens（如 3,599）。
    //    在无正文无工具且 end_turn 且产出了摘要（output_tokens > 0）时，说明静默压缩已真实完成：
    //    用 output_tokens 作为压缩后上下文下界修正 state.usage.context_tokens 并发射 compacted(estimated:true)，
    //    避免误报「压缩未确认」诱导用户二次压缩，也避免把 455k 脏值写进 lastContextTokens / .jsonl；
    // 3. C7：若 agent 吐出正文/调工具（把 /compact 当普通消息回复“不支持”），或未产出任何摘要（output_tokens=0）
    //    且上下文未下降，仍不得发 compacted，发 acp-compact-unverified 提示。
    let compactConfirmed = state.sawCompacted;
    let compactEstimated = false;
    if (isCompactCmd && !state.sawCompacted) {
      const hasBody = !!(state.text || state.tools.size);
      const postCtx = Number(state.usage?.context_tokens) || null;
      const outTok = Number(state.usage?.output_tokens) || 0;
      const emitCtxUsage = (ctxVal) => {
        if (!(ctxVal > 0)) return;
        emit({
          type: "usage",
          contextTokens: ctxVal,
          ...(state.usage?.context_window > 0 ? { contextWindow: state.usage.context_window } : {}),
          outputTokens: outTok,
        });
      };
      if (preCompactCtx > 0 && postCtx != null && postCtx < preCompactCtx) {
        compactConfirmed = true;
        emitCtxUsage(postCtx);
        emit({
          type: "compacted",
          trigger: run?.auto ? "auto" : "manual",
          pre: preCompactCtx,
          post: postCtx,
        });
      } else if (!hasBody && stopReason === "end_turn" && outTok > 0 && !(preCompactCtx > 0 && outTok >= preCompactCtx)) {
        compactConfirmed = true;
        compactEstimated = true;
        state.usage = { ...(state.usage || {}), context_tokens: outTok };
        emitCtxUsage(outTok);
        emit({
          type: "compacted",
          trigger: run?.auto ? "auto" : "manual",
          pre: preCompactCtx > 0 ? preCompactCtx : null,
          post: outTok,
          estimated: true,
        });
      } else {
        if (postCtx != null && postCtx > 0) emitCtxUsage(postCtx);
        emit({
          type: "note",
          key: "acp-compact-unverified",
          text: tz("压缩未确认：上下文没有下降（压缩前 {pre}，压缩后 {post}），请重试 /compact 或换新会话。", {
            pre: preCompactCtx > 0 ? String(preCompactCtx) : "未知",
            post: postCtx != null ? String(postCtx) : "未知",
          }),
        });
      }
    }

    // 若有工具在回合结束时还没收到终态 update，补发一次完成结果，避免前端卡片永远卡在「运行中」
    for (const tool of state.tools.values()) {
      if (!tool.done) {
        const st = String(tool.status || "").toLowerCase();
        tool.cancelled = st === "cancelled" || st === "canceled";
        tool.isError = st === "failed" || st === "error";
        emitToolResult(tool, emit, state);
      }
    }

    const durationMs = Date.now() - t0;

    // 把本轮新工具 ID 记入已见集合，供池内下一轮去重
    for (const tid of state.tools.keys()) state.knownToolIds.add(tid);

    // 持久化到本地 jsonl，供会话列表 / 历史查看 / 搜索 / 导出复用
    // /compact 无正文和工具时不写入空白对话行，仅保留最新上下文用量供重开会话读取；
    // 后台命令补唤醒（auto="bg"）与空闲推送对齐，只落盘助手回复与工具记录、不写合成用户气泡
    if (isBgWake) {
      persistAcpAssistantOnly({
        cwd,
        sessionId: activeSessionId,
        assistantText: state.text,
        thinking: state.thinking,
        tools: [...state.tools.values()],
        model: activeModel,
        usage: state.usage,
      });
    } else if (!isCompactCmd || state.text || state.tools.size) {
      persistAcpTurn({
        cwd,
        sessionId: activeSessionId,
        userText: displayPrompt != null ? displayPrompt : prompt,
        assistantText: state.text,
        thinking: state.thinking,
        tools: [...state.tools.values()],
        model: activeModel,
        usage: state.usage,
        existingUserUuid: state.persistedUserUuid || null,
      });
    } else if (compactConfirmed && state.usage?.context_tokens > 0) {
      // C7：只有确认压缩已生效时才记“已压缩”摘要；未确认时不写这条，免得会话历史里留假记录。
      const postStr = (compactEstimated ? "~" : "") + state.usage.context_tokens.toLocaleString();
      persistAcpAssistantOnly({
        cwd,
        sessionId: activeSessionId,
        assistantText: preCompactCtx > 0
          ? `上下文已压缩：${preCompactCtx.toLocaleString()} → ${postStr} tokens`
          : `上下文已压缩（摘要约 ${state.usage.context_tokens.toLocaleString()} tokens）`,
        thinking: "",
        tools: [],
        model: activeModel,
        usage: state.usage,
      });
    }

    emit({
      type: "result",
      sessionId: activeSessionId,
      resultText: state.text,
      stopReason,
      durationMs,
      costUsd: 0,
      ...(state.usage ? { usage: state.usage } : {}),
    });

    canKeep = keepAlive && !client.closed && !!activeSessionId;

    return {
      ok: true,
      sessionId: activeSessionId,
      sessionSwitched,
      model: activeModel,
      toolCount: state.tools.size,
      resultText: state.text,
      stopReason,
      durationMs,
      usage: state.usage,
      reused,
    };
  } catch (err) {
    const msg = String(err?.message || err);
    const detail = client.stderr ? `\n${client.stderr.slice(-800)}` : "";
    if (activeSessionId && state.promptSent && !client.closed && !run?.aborted) {
      try { client.notify("session/cancel", { sessionId: activeSessionId }); } catch {}
    }
    // 回合中途失败/被取消：提问、已完成工具、思考与已流出的正文都要落盘，别让整轮凭空消失（B5）。
    // 只有 prompt 已发出去才落盘：prompt 没发出去说明问题没递到 agent，用户重发时不应多出一份。
    if (activeSessionId && state.promptSent) {
      for (const tool of state.tools.values()) {
        if (!tool.done) {
          if (run?.aborted) {
            tool.cancelled = true;
            tool.isError = false;
          } else {
            tool.isError = true;
          }
          if (!tool.output) tool.output = run?.aborted ? "（已中断）" : `（回合异常中断：${msg}）`;
          emitToolResult(tool, emit, state);
        }
        state.knownToolIds.add(tool.id);
      }
      const isCompactCmd = /^\/compact(?:\s|$)/i.test(String(prompt || "").trim());
      if (run?.auto === "bg") {
        persistAcpAssistantOnly({
          cwd,
          sessionId: activeSessionId,
          assistantText: state.text,
          thinking: state.thinking,
          tools: [...state.tools.values()],
          model: model || sessModels?.currentModelId || "antigravity",
          usage: state.usage,
        });
      } else if (!isCompactCmd || state.text || state.tools.size) {
        persistAcpTurn({
          cwd,
          sessionId: activeSessionId,
          userText: displayPrompt != null ? displayPrompt : prompt,
          assistantText: state.text,
          thinking: state.thinking,
          tools: [...state.tools.values()],
          model: model || sessModels?.currentModelId || "antigravity",
          usage: state.usage,
          existingUserUuid: state.persistedUserUuid || null,
        });
      }
    }
    if (!run?.aborted) {
      log(`[agy-acp] 回合异常中断 (${(activeSessionId || "-").slice(0, 8)}, ${Math.round((Date.now() - t0) / 1000)}s): ${msg}`);
      emit({ type: "error", message: tz("Antigravity CLI 执行出错：{msg}", { msg }) + detail });
    }
    return {
      ok: false,
      failed: !run?.aborted,
      sessionId: activeSessionId,
      sessionSwitched,
      toolCount: state.tools.size,
      resultText: state.text,
      usage: state.usage,
      error: msg,
      durationMs: Date.now() - t0,
    };
  } finally {
    clearAllBgExpiryTimers(turnScope);
    if (poolEntry && poolEntry.dropActiveBg === dropActiveBg) poolEntry.dropActiveBg = null;
    if (run) {
      run.child = null;
      run.cancelAcp = null;
      run.dropAcpBg = null;
    }
    if (canKeep) {
      const entry = poolEntry || { client, sessionId: activeSessionId, key: pKey, knownToolIds: new Set() };
      const poolScope = `pool:${activeSessionId}`;
      pruneExpiredBgTasks(poolScope, bgTasks);
      entry.cwd = cwd;
      entry.models = sessModels;
      entry.modes = sessModes;
      entry.configOptions = sessConfig;
      entry.model = model || sessModels?.currentModelId || entry.model || "antigravity";
      // MIG-6：池里只记 agent 确认生效的 effort。没要 effort 的轮次不碰旧值；
      // 要了但没生效（不支持/被拒）的记 null，下轮重发而不是永久静默失效。
      entry.effort = effort ? effortApplied : entry.effort;
      entry.permMode = permMode;
      entry.knownToolIds = state.knownToolIds;
      entry.lastUsage = state.usage || entry.lastUsage || null;
      entry.lastContextTokens = Number(state.usage?.context_tokens) || entry.lastContextTokens || 0;
      entry.bgTasks = bgTasks;
      const emitPoolBg = () => {
        pruneExpiredBgTasks(poolScope, entry.bgTasks);
        onBgChange?.([...entry.bgTasks.values()]);
      };
      clearAllBgExpiryTimers(poolScope);
      for (const item of entry.bgTasks.values()) {
        armBgExpiryTimer(poolScope, entry.bgTasks, item, emitPoolBg);
      }
      entry.acpAgents = state.acpAgents || entry.acpAgents || new Map();
      entry.acpAgentsByConv = state.acpAgentsByConv || entry.acpAgentsByConv || new Map();
      entry.acpAgentDirs = state.acpAgentDirs || entry.acpAgentDirs || new Map();
      entry.nudgedBgTasks = entry.nudgedBgTasks || new Set();
      {
        const liveKids = listAcpChildren(entry.client.child?.pid);
        if (liveKids) {
          const liveKeys = new Set(liveKids.map((c) => c.key));
          for (const k of [...daemonChildKeys]) if (!liveKeys.has(k)) daemonChildKeys.delete(k);
        }
      }
      entry.daemonChildKeys = daemonChildKeys;
      entry.idleRun = null;
      entry.busy = false;
      entry.lastUsed = Date.now();

      // 空闲期间非常驻后台 shell 任务（type==="shell"）的补唤醒监听：
      // 仅针对 agy acp 1.5.13 偶尔丢失 run_command 后台任务完成唤醒的缺陷；
      // 严格排除 daemon / monitor / agent / workflow，内核确认子进程退出后再经宽限窗静默校验，
      // 同一 taskId 至多补唤醒一次，且在 idleBurst / 复用 / 关闭 / 手动停止时立即让路清理。
      let bgWatchTimer = null;
      let shellGoneSince = 0;
      const clearBgWatch = () => {
        if (bgWatchTimer) { clearInterval(bgWatchTimer); bgWatchTimer = null; }
        shellGoneSince = 0;
      };
      entry.clearBgWatch = clearBgWatch;
      const pendingWatchShells = () => [...(entry.bgTasks?.values() || [])].filter(
        (t) => t && t.type === "shell" && !entry.nudgedBgTasks.has(t.id)
      );
      const armBgShellWatch = () => {
        if (run?.aborted || run?.userStopped || typeof onBgWake !== "function") return;
        if (!pendingWatchShells().length) { clearBgWatch(); return; }
        if (bgWatchTimer) return;
        const pollMs = Math.max(20, Number(bgPollMs) || ACP_BG_POLL_MS);
        const graceMs = Math.max(0, Number(bgGraceMs) >= 0 ? Number(bgGraceMs) : ACP_BG_GRACE_MS);
        bgWatchTimer = setInterval(() => {
          if (ACP_POOL.get(activeSessionId) !== entry || entry.busy || entry.client.closed) {
            clearBgWatch();
            return;
          }
          if (idleBurst) { shellGoneSince = 0; return; }
          const shells = pendingWatchShells();
          if (!shells.length) { clearBgWatch(); return; }
          let probe;
          try {
            probe = probeBgShell(entry.client.child?.pid, {
              daemonChildKeys: entry.daemonChildKeys,
              sessionId: activeSessionId,
              tasks: shells,
            });
          } catch {
            probe = { active: true, reason: "probe-err" };
          }
          if (probe?.active) { shellGoneSince = 0; return; }
          const now = Date.now();
          if (!shellGoneSince) { shellGoneSince = now; return; }
          if (now - shellGoneSince < graceMs) return;
          if (ACP_POOL.get(activeSessionId) !== entry || entry.busy || entry.client.closed || idleBurst) return;
          clearBgWatch();
          for (const t of shells) {
            entry.nudgedBgTasks.add(t.id);
            removeBgTaskAndDependents(poolScope, entry.bgTasks, t.id);
          }
          while (entry.nudgedBgTasks.size > 500) entry.nudgedBgTasks.delete(entry.nudgedBgTasks.values().next().value);
          emitPoolBg();
          const ids = shells.map((t) => String(t.id || "").split("/").pop()).filter(Boolean).join(", ");
          log(`[agy-acp idle] 后台 shell 任务已结束且静默超过 ${Math.round(graceMs / 100) / 10}s，自动补唤醒一次（${activeSessionId.slice(0, 8)}，${ids}）`);
          try { onBgWake({ sessionId: activeSessionId, tasks: shells }); } catch (e) { log(`[agy-acp idle] 补唤醒回调异常: ${e.message}`); }
        }, pollMs);
        bgWatchTimer.unref?.();
      };

      // 空闲期间后台任务 / 定时提醒 / 子代理完成时，agy 会主动通过 session/update 推送回复：
      // 实时转推给前端并防抖落盘到 .jsonl，避免必须问「好了吗」才能看到结果
      const IDLE_TOOL_MAX_WAIT_MS = 60000;
      let idleBurst = null;
      let idleFlushTimer = null;
      const flushIdle = () => {
        if (idleFlushTimer) { clearTimeout(idleFlushTimer); idleFlushTimer = null; }
        const b = idleBurst;
        if (!b) return;
        idleBurst = null;
        entry.idleRun = null;
        for (const tool of b.state.tools.values()) {
          if (!tool.done) {
            const st = String(tool.status || "").toLowerCase();
            tool.cancelled = st === "cancelled" || st === "canceled";
            tool.isError = st === "failed" || st === "error";
            emitToolResult(tool, b.emit, b.state);
          }
          entry.knownToolIds.add(tool.id);
        }
        persistAcpAssistantOnly({
          cwd: entry.cwd,
          sessionId: activeSessionId,
          assistantText: b.state.text,
          thinking: b.state.thinking,
          tools: [...b.state.tools.values()],
          model: entry.model,
          usage: b.state.usage,
        });
        if (b.state.usage) {
          entry.lastUsage = b.state.usage;
          if (Number(b.state.usage.context_tokens) > 0) entry.lastContextTokens = Number(b.state.usage.context_tokens);
        }
        // 如果空闲期间收到了正文回报，结算对应的非常驻后台任务 / 一次性定时器 / 子代理：
        // 1) 一次性 schedule 只在临近到期、TimerCondition="any"、或回报正文点名了自身/目标条件时摘除（防无关唤醒提前摘掉未触发的长定时器）；
        // 2) nonDaemon 仅含后台 shell / 子代理 / workflow（排除 monitor），仅 1 个时直接结算，多个时按 token 匹配结算（并通过 removeBgTaskAndDependents 联动摘除绑定它的定时器）。
        if (entry.bgTasks?.size) {
          const now = Date.now();
          let bgChanged = pruneExpiredBgTasks(poolScope, entry.bgTasks, now);
          if (b.state.text) {
            for (const [k, v] of [...entry.bgTasks]) {
              if (!v?.oneShot) continue;
              const cond = typeof v.timerCondition === "string" ? v.timerCondition : "never";
              const shortK = String(k).includes("/") ? String(k).split("/").pop() : null;
              const shortCond = cond && cond !== "never" && cond !== "any" && cond.includes("/") ? cond.split("/").pop() : null;
              const tokens = [
                k, shortK, v.desc,
                cond !== "never" && cond !== "any" ? cond : null,
                shortCond,
              ].filter((x) => x && String(x).length >= 4);
              const dueSoon = v.expiresAt > 0 && v.expiresAt <= now + 2000;
              if (dueSoon || cond === "any" || tokens.some((tok) => b.state.text.includes(String(tok)))) {
                clearBgExpiryTimer(poolScope, k);
                entry.bgTasks.delete(k);
                bgChanged = true;
              }
            }
            const nonDaemon = [...entry.bgTasks].filter(([, v]) => v.type !== "daemon" && v.type !== "monitor");
            const finishOne = (k, v) => {
              removeBgTaskAndDependents(poolScope, entry.bgTasks, k);
              if (v.type === "agent") {
                const rec = entry.acpAgents?.get(k);
                if (rec && rec.status === "running") {
                  rec.status = "done";
                  publish({ type: "ag", runId: b.runId, sessionId: activeSessionId, k: "done", id: k, status: "done", why: firstLineOf(b.state.text), at: Date.now() });
                }
              }
            };
            if (nonDaemon.length === 1) {
              finishOne(nonDaemon[0][0], nonDaemon[0][1]);
              bgChanged = true;
            } else if (nonDaemon.length > 1) {
              for (const [k, v] of nonDaemon) {
                const rec = entry.acpAgents?.get(k);
                const shortK = String(k).includes("/") ? String(k).split("/").pop() : null;
                const tokens = [k, shortK, rec?.convId, rec?.name, v.desc].filter((x) => x && String(x).length >= 4);
                if (tokens.some((tok) => b.state.text.includes(String(tok)))) {
                  finishOne(k, v);
                  bgChanged = true;
                }
              }
            }
          }
          if (bgChanged) onBgChange?.([...entry.bgTasks.values()]);
        }
        publish({
          type: "run_end",
          runId: b.runId,
          sessionId: activeSessionId,
          ok: true,
          resultText: b.state.text,
          durationMs: Date.now() - b.startedAt,
          costUsd: 0,
          ...(b.state.usage ? { usage: b.state.usage } : {}),
        });
        log(`[agy-acp idle] 后台唤醒回报已推送并落盘（${activeSessionId.slice(0, 8)}，${b.state.text.length} 字）`);
        if (ACP_POOL.get(activeSessionId) === entry && !entry.busy && !entry.client.closed) {
          armBgShellWatch();
        }
      };
      entry.flushIdle = flushIdle;

      const scheduleIdleFlush = () => {
        if (idleFlushTimer) clearTimeout(idleFlushTimer);
        const hasPendingTool = idleBurst && [...idleBurst.state.tools.values()].some((t) => !t.done);
        idleFlushTimer = setTimeout(() => {
          if (!idleBurst) return;
          const stillPending = [...idleBurst.state.tools.values()].some((t) => !t.done);
          if (stillPending && Date.now() - (idleBurst.lastUpdateAt || idleBurst.startedAt) < IDLE_TOOL_MAX_WAIT_MS) {
            scheduleIdleFlush();
            return;
          }
          flushIdle();
        }, hasPendingTool ? 5000 : 1500);
        idleFlushTimer.unref?.();
      };

      const IDLE_WAKE_KINDS = new Set([
        "agent_message_chunk", "text_delta", "agent_message",
        "agent_thought_chunk", "thinking_delta", "agent_thought",
        "tool_call", "tool_call_update", "plan", "compaction_update", "notice",
      ]);
      // 空闲期只更新状态、不开 burst 的种类（MIG-16）：后台子代理/任务单独推来的
      // 用量或模式更新，不值得开一次 run_start/run_end，也不落盘空正文回合。
      const IDLE_STATE_KINDS = new Set(["usage", "usage_update", "current_mode_update"]);

      client.setHandlers({
        onStderr: (s) => { const line = s.trim(); if (line && !isBenignStderr(line)) log(`[agy-acp! idle] ${line.slice(0, 200)}`); },
        onClose: () => { try { clearBgWatch(); } catch {} try { flushIdle(); } catch {} },
        onNotification: (method, params) => {
          if (method !== "session/update") return;
          if (params?.sessionId && activeSessionId && String(params.sessionId) !== String(activeSessionId)) return;
          const upd = params?.update || params || {};
          const kind = upd.sessionUpdate || upd.type || "";
          if (kind === "available_commands_update") {
            const cmds = Array.isArray(upd.availableCommands) ? upd.availableCommands : [];
            if (cmds.length) state.onCommands(cmds);
            return;
          }
          // MIG-16：空闲期用量/模式更新只更新 entry 与界面，不开 burst——
          // run_tokens 没有对应的轮次视图，不往外推；模式变化要记回 entry，下一轮复用才认。
          if (IDLE_STATE_KINDS.has(kind)) {
            entry.lastUsed = Date.now();
            const st = {
              usage: entry.lastUsage || null,
              permMode: entry.permMode,
              promptSent: true,
              sessionId: activeSessionId,
              cwd: entry.cwd,
              knownToolIds: entry.knownToolIds,
              tools: new Map(),
            };
            translateAcpUpdate(params, st, (ev) => {
              if (ev.type === "run_tokens") return;
              if (ev.type === "perm_mode") entry.permMode = ev.mode;
              publish({ ...ev, sessionId: activeSessionId });
            });
            if (st.usage) {
              entry.lastUsage = st.usage;
              entry.lastContextTokens = Number(st.usage.context_tokens) || entry.lastContextTokens || 0;
            }
            return;
          }
          if (!idleBurst && !IDLE_WAKE_KINDS.has(kind)) return;
          shellGoneSince = 0;
          entry.lastUsed = Date.now();
          if (!idleBurst) {
            const runId = "acp-bg-" + crypto.randomBytes(4).toString("hex");
            const startedAt = Date.now();
            const bgEmit = (ev) => publish({ ...ev, runId, sessionId: activeSessionId });
            const bgState = {
              text: "",
              thinking: "",
              tools: new Map(),
              knownToolIds: entry.knownToolIds,
              usage: null,
              promptSent: true,
              permMode: entry.permMode,
              cwd: entry.cwd,
              sessionId: activeSessionId,
              acpAgents: entry.acpAgents,
              acpAgentsByConv: entry.acpAgentsByConv,
              acpAgentDirs: entry.acpAgentDirs,
              onBgAdd: (t) => {
                if (!t || !t.id) return;
                const item = {
                  id: String(t.id),
                  type: t.type || "shell",
                  desc: String(t.desc || t.id),
                  ...(t.oneShot ? { oneShot: true, expiresAt: Number(t.expiresAt) || 0, timerCondition: String(t.timerCondition || "never") } : {}),
                };
                entry.bgTasks.set(item.id, item);
                armBgExpiryTimer(poolScope, entry.bgTasks, item, emitPoolBg);
                emitPoolBg();
              },
              onBgRemove: (id) => {
                if (id && removeBgTaskAndDependents(poolScope, entry.bgTasks, id)) emitPoolBg();
              },
              onBgClearTasks: () => {
                let changed = false;
                for (const [k, v] of entry.bgTasks) {
                  if (v.type !== "agent" && v.type !== "workflow") {
                    clearBgExpiryTimer(poolScope, k);
                    entry.bgTasks.delete(k);
                    changed = true;
                  }
                }
                if (changed) emitPoolBg();
              },
              onBgReconcileTasks: (outText) => {
                if (reconcileBgTasksFromList(poolScope, entry.bgTasks, outText)) emitPoolBg();
              },
              onCommands: state.onCommands,
            };
            idleBurst = { runId, startedAt, lastUpdateAt: startedAt, state: bgState, emit: bgEmit };
            entry.idleRun = {
              id: runId, cid: null, text: "", sessionId: activeSessionId, follow: null, startedAt,
              perms: [], idle: false, sealed: false, bg: 0, bgList: [], auto: "bg", permMode: entry.permMode || null,
            };
            publish({ type: "run_start", runId, sessionId: activeSessionId, text: "", auto: "bg", startedAt });
          } else {
            idleBurst.lastUpdateAt = Date.now();
          }
          translateAcpUpdate(params, idleBurst.state, idleBurst.emit);
          scheduleIdleFlush();
        },
        // 空闲期间若有后台任务/子代理发起权限请求：bypassPermissions 下自动放行，否则优雅取消，不再抛 -32603
        onRequest: async (method, params) => {
          if (method === "session/request_permission") {
            const options = Array.isArray(params?.options) ? params.options : [];
            const allowOpt = pickAcpAllowOption(options);
            if (entry.permMode === "bypassPermissions" && allowOpt) {
              return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
            }
            return { outcome: { outcome: "cancelled" } };
          }
          throw new Error(`Unsupported idle ACP callback: ${method}`);
        },
      });
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.lastCpuTicks = readProcCpuTicks(entry.client.child?.pid);
      const armIdleGc = () => {
        entry.idleTimer = setTimeout(() => {
          if (ACP_POOL.get(activeSessionId) === entry && !entry.busy) {
            // 先查常驻 agy acp 进程的真实活跃度（CPU 滴答或 acp-server-*-<pid>.log 近期写入）：
            // 子代理在 agy 内部跑时不会向父会话发 session/update，只要进程还在干活就顺延不杀，杜绝误发 SIGTERM 引发 Server restart
            const act = acpChildActive(entry.client.child?.pid, entry.lastCpuTicks, Date.now());
            if (act.cpuTicks >= 0) entry.lastCpuTicks = act.cpuTicks;
            if (act.active) {
              entry.lastUsed = Date.now();
              armIdleGc();
              return;
            }
            if (entry.bgTasks?.size > 0) {
              if (pruneExpiredBgTasks(poolScope, entry.bgTasks)) {
                onBgChange?.([...entry.bgTasks.values()]);
              }
              if (entry.bgTasks.size > 0) {
                const now = Date.now();
                const hasPersistent = [...entry.bgTasks.values()].some(
                  (t) => t.type === "daemon" || (t.type === "monitor" && (!t.oneShot || (t.expiresAt > now)))
                );
                const bgCap = Math.max(ACP_IDLE_TTL_MS * 3, ACP_BG_IDLE_TTL_MS);
                if (hasPersistent || Date.now() - entry.lastUsed < bgCap) {
                  armIdleGc();
                  return;
                }
              }
            }
            log(`[agy-acp] 会话 ${activeSessionId.slice(0, 8)} 空闲超时，回收常驻进程`);
            closeAcpSession(activeSessionId);
          }
        }, ACP_IDLE_TTL_MS);
        entry.idleTimer.unref?.();
      };
      // MIG-18：池里已有不同 client 的忙 entry（同会话另一轮还在跑）时，不覆盖——
      // 覆盖会把旧 entry 的 idleTimer 回收守卫顶掉，旧进程成孤儿。本轮进程不进池，直接销毁；
      // 闲置的旧 entry 则先关再登记，池里永远只留一个进程。
      const prev = ACP_POOL.get(activeSessionId);
      if (prev && prev !== entry && prev.busy) {
        log(`[agy-acp] 会话 ${activeSessionId.slice(0, 8)} 旧轮仍在跑，本轮进程不进池、直接销毁`);
        destroyClient();
      } else {
        if (prev && prev !== entry) closeAcpSession(activeSessionId);
        armIdleGc();
        ACP_POOL.set(activeSessionId, entry);
        armBgShellWatch();
        // 最多保留 6 个空闲常驻会话，超出先清最久未用且无后台任务的，尽量不误杀后台子代理
        if (ACP_POOL.size > 6) {
          const idleEntries = [...ACP_POOL.entries()].filter(([, v]) => !v.busy);
          const quietEntries = idleEntries.filter(([, v]) => !(v.bgTasks?.size > 0));
          const pool = quietEntries.length ? quietEntries : idleEntries;
          const oldest = pool.sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
          if (oldest) closeAcpSession(oldest[0]);
        }
      }
    } else {
      destroyClient();
    }
  }
}
