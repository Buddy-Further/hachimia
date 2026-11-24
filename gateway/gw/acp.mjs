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
/** 空闲池探测非常驻后台 shell 任务结束的轮询周期与宽限窗（默认每 1s 探测，确认结束后静默 15s 补唤醒一次） */
export const ACP_BG_POLL_MS = Number(process.env.CCAPP_ACP_BG_POLL_MS) > 0 ? Number(process.env.CCAPP_ACP_BG_POLL_MS) : 1000;
export const ACP_BG_GRACE_MS = Number(process.env.CCAPP_ACP_BG_GRACE_MS) > 0 ? Number(process.env.CCAPP_ACP_BG_GRACE_MS) : 15000;
const ACP_BG_TASKLOG_SETTLE_MS = 1500;

/** 从 /proc/<parentPid>/task/<tid>/children 收集所有线程的直接子 PID；目录或 children 文件不存在时返回 null */
function readTaskChildrenPids(procDir, parentPid) {
  const taskDir = path.join(procDir, String(parentPid), "task");
  let tids;
  try { tids = fs.readdirSync(taskDir); } catch { return null; }
  const pids = new Set();
  let foundAny = false;
  for (const tid of tids) {
    if (!/^\d+$/.test(tid)) continue;
    try {
      const txt = fs.readFileSync(path.join(taskDir, tid, "children"), "utf8");
      foundAny = true;
      for (const tok of txt.trim().split(/\s+/)) {
        if (/^\d+$/.test(tok)) {
          const n = Number(tok);
          if (Number.isInteger(n) && n > 0) pids.add(n);
        }
      }
    } catch {}
  }
  return foundAny ? pids : null;
}

/** 列出常驻 agy acp 进程当前存活（非僵尸）的直接子进程：{ pid, startTicks, key, hidden? }；
 *  1) 优先读 /proc/<parentPid>/task/<tid>/children：Android hidepid=2 下不可 dump 子进程仍会出现在父进程的 children 列表中，
 *     若 /proc/<pid>/stat 不可读但重查 children 仍在，按 hidden 存活子进程保守保留，避免误判已退出；
 *  2) 不存在 task/<tid>/children 时回退扫描 /proc/<pid>/stat（不按 uid 过滤，防止 0711 / PR_SET_DUMPABLE=0 的 root 属主子进程被漏扫）；
 *  3) /proc 不可读时返回 null（保守不误判结束）。 */
export function listAcpChildren(parentPid, procDir = "/proc") {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  const parseStat = (pid) => {
    const s = fs.readFileSync(path.join(procDir, String(pid), "stat"), "utf8");
    const r = s.lastIndexOf(")");
    if (r < 0) return null;
    const f = s.slice(r + 2).split(" ");
    const st = f[0];
    const ppid = Number(f[1]);
    if (ppid !== parentPid || st === "Z" || st === "X") return null;
    const startTicks = String(f[19] || "0");
    return { pid, startTicks, key: `${pid}:${startTicks}` };
  };
  const childPids = readTaskChildrenPids(procDir, parentPid);
  if (childPids !== null) {
    const kids = [];
    let recheckedPids = null;
    for (const pid of childPids) {
      try {
        const info = parseStat(pid);
        if (info) kids.push(info);
      } catch {
        // 可能是刚退出竞态，也可能是 Android hidepid=2 下不可 dump 的存活子进程：重读一次 task/*/children 确认
        if (recheckedPids === null) recheckedPids = readTaskChildrenPids(procDir, parentPid) || new Set();
        if (recheckedPids.has(pid)) {
          kids.push({ pid, startTicks: "hidden", key: `${pid}:hidden`, hidden: true });
        }
      }
    }
    return kids;
  }
  let entries;
  try { entries = fs.readdirSync(procDir); } catch { return null; }
  const kids = [];
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const info = parseStat(Number(d));
      if (info) kids.push(info);
    } catch {}
  }
  return kids;
}

/** 当已归属 childKey 的子进程在 /proc 枚举中缺失时（例如 Android hidepid=2 下 PR_SET_DUMPABLE=0 导致 /proc/<pid> 不可见），
 *  通过 kill(pid, 0) 复核进程是否仍在运行：成功或 EPERM 视为仍存活，仅 ESRCH 才判已退出（R2-01 P2-1）。 */
export function isPidAliveFallback(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** S-1（P2-1）：kill(pid, 0) 兜底前先核对 /proc/<pid>/stat 的状态与第 22 字段 starttime，防止原进程已退出、PID 被新进程复用时误判仍存活。
 *  仅当 /proc/<pid>/stat 不可读（如 hidepid=2 抛 ENOENT/EACCES/EPERM）时才回退调用 isPidAlive(pid)。 */
export function isChildKeyAliveFallback(childKey, procDir = "/proc", isPidAlive = isPidAliveFallback) {
  if (typeof childKey !== "string" || !childKey.length) return false;
  const colon = childKey.indexOf(":");
  const pid = Number(colon >= 0 ? childKey.slice(0, colon) : childKey);
  const wantTicks = colon >= 0 ? childKey.slice(colon + 1) : "";
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const statStr = fs.readFileSync(path.join(procDir, String(pid), "stat"), "utf8");
    const rp = statStr.lastIndexOf(")");
    if (rp >= 0) {
      const f = statStr.slice(rp + 2).trim().split(/\s+/);
      const st = f[0];
      const gotTicks = String(f[19] || "0");
      if (st === "Z" || st === "X") return false;
      if (wantTicks && wantTicks !== "hidden" && gotTicks !== wantTicks) return false;
      return true;
    }
  } catch {
    return typeof isPidAlive === "function" ? !!isPidAlive(pid) : false;
  }
  return false;
}

/** 读取 /proc/<pid>/stat 的第 22 字段 starttime；读不到返回 "" */
function readProcStartTicks(pid, procDir = "/proc") {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    const s = fs.readFileSync(path.join(procDir, String(pid), "stat"), "utf8");
    const rp = s.lastIndexOf(")");
    if (rp < 0) return "";
    const f = s.slice(rp + 2).trim().split(/\s+/);
    if (f[0] === "Z" || f[0] === "X") return "";
    return String(f[19] || "");
  } catch {
    return "";
  }
}

// 收集 rootPid 的全部存活子孙 PID（结合 /proc/<pid>/stat 的 ppid 与 /proc/<pid>/task/<tid>/children，覆盖 hidepid=2 不可 dump 子进程）
export function listDescendantPids(rootPid, procDir = "/proc") {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const byParent = new Map();
  let entries = [];
  try { entries = fs.readdirSync(procDir); } catch {}
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = fs.readFileSync(path.join(procDir, d, "stat"), "utf8");
      const rp = s.lastIndexOf(")");
      if (rp < 0) continue;
      const f = s.slice(rp + 2).trim().split(/\s+/);
      if (f[0] === "Z" || f[0] === "X") continue;
      const ppid = Number(f[1]);
      if (Number.isInteger(ppid) && ppid > 0) {
        let arr = byParent.get(ppid);
        if (!arr) { arr = []; byParent.set(ppid, arr); }
        arr.push(Number(d));
      }
    } catch {}
  }
  const out = [];
  const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    const direct = byParent.get(p) || [];
    const taskKids = readTaskChildrenPids(procDir, p);
    const merged = taskKids ? [...direct, ...taskKids] : direct;
    for (const k of merged) {
      if (!Number.isInteger(k) || k <= 0 || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

/** 安全精准终止单个已归属 childKey（pid:startTicks）的后台 shell/daemon 子进程及其子孙树：
 *  1) 先经 isChildKeyAliveFallback 核对 starttime 防 PID 复用；
 *  2) 核验目标 pid 确实是 parentPid 的存活后代且绝非 parentPid / 网关自身；
 *  3) 先 SIGTERM 整棵子树与进程组，宽限 graceMs 后再对经 startTicks 复核仍存活的节点补 SIGKILL。 */
export function killBgChildTree(parentPid, childKey, {
  procDir = "/proc",
  graceMs = 1500,
  isPidAlive = isPidAliveFallback,
  signalFn = (p, sig) => process.kill(p, sig),
} = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return false;
  if (typeof childKey !== "string" || !childKey.length) return false;
  const colon = childKey.indexOf(":");
  const pid = Number(colon >= 0 ? childKey.slice(0, colon) : childKey);
  if (!Number.isInteger(pid) || pid <= 0 || pid === parentPid || pid === process.pid) return false;
  if (!isChildKeyAliveFallback(childKey, procDir, isPidAlive)) return false;
  const ancTree = listDescendantPids(parentPid, procDir);
  if (!ancTree.includes(pid)) {
    const directKids = listAcpChildren(parentPid, procDir);
    if (!directKids || !directKids.some((c) => c.pid === pid)) return false;
  }
  const subPids = listDescendantPids(pid, procDir);
  const targets = [
    { pid, key: childKey },
    ...subPids.filter((p) => p !== parentPid && p !== process.pid).map((p) => {
      const ticks = readProcStartTicks(p, procDir);
      return { pid: p, key: ticks ? `${p}:${ticks}` : `${p}:hidden` };
    }),
  ];
  const hit = (p, sig) => {
    try { signalFn(-p, sig); } catch {}
    try { signalFn(p, sig); } catch {}
  };
  for (const t of targets) hit(t.pid, "SIGTERM");
  if (graceMs > 0) {
    const timer = setTimeout(() => {
      for (const t of targets) {
        if (isChildKeyAliveFallback(t.key, procDir, isPidAlive)) hit(t.pid, "SIGKILL");
      }
    }, graceMs);
    timer.unref?.();
  }
  return true;
}

/** 扫描 agy 会话的 .system_generated/tasks/task-<N>.log（轻量仅 stat，不读内容） */
export function scanAcpTaskLogs(sessionId, brainDir = path.join(CFG.home, ".gemini", "antigravity-cli", "brain"), sinceMs = 0) {
  if (!sessionId || !brainDir) return [];
  const taskDir = path.join(brainDir, String(sessionId), ".system_generated", "tasks");
  let names;
  try { names = fs.readdirSync(taskDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = /^task-(\d+)\.log$/.exec(name);
    if (!m) continue;
    const logPath = path.join(taskDir, name);
    try {
      const st = fs.statSync(logPath);
      if (!st.isFile()) continue;
      if (sinceMs > 0 && st.mtimeMs < sinceMs - 2000) continue;
      const shortId = `task-${m[1]}`;
      out.push({
        num: Number(m[1]),
        shortId,
        fullId: `${sessionId}/${shortId}`,
        logPath,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {}
  }
  out.sort((a, b) => a.num - b.num);
  return out;
}

/** 轻量读取后台任务日志文件末尾最多 maxBytes 字节，并折叠 \r 进度覆盖行，避免大日志 OOM 与界面乱码 */
export function readTaskLogTail(logPath, maxBytes = 4096) {
  if (!logPath || typeof logPath !== "string") return "";
  let st;
  try { st = fs.statSync(logPath); } catch { return ""; }
  if (!st.isFile() || st.size <= 0) return "";
  const cap = Math.max(256, Math.min(Number(maxBytes) || 4096, 32768));
  const offset = st.size > cap ? st.size - cap : 0;
  const len = st.size - offset;
  let fd = null;
  let raw = "";
  try {
    fd = fs.openSync(logPath, "r");
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, offset);
    raw = buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
  const norm = raw.replace(/\r\n/g, "\n");
  let lines = norm.split("\n");
  if (offset > 0 && lines.length > 1) lines = lines.slice(1);
  // 折叠同一行内由 \r 覆盖刷新的进度条（如 git Receiving objects），只保留最后一段非空内容
  const clean = lines.map((line) => {
    if (!line.includes("\r")) return line;
    const segs = line.split("\r").map((s) => s.trimEnd()).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : "";
  });
  const text = clean.join("\n").trim();
  return offset > 0 && text ? `…\n${text}` : text;
}

/** 预判空闲期到来的 session/update 是否会产生实质内容（防取消后的迟到旧工具帧或空文本触发 0 字幻影 idleBurst） */
export function shouldOpenIdleBurst(kind, upd, entry, idleWakeKinds) {
  if (!idleWakeKinds?.has(kind)) return false;
  if (kind === "tool_call" || kind === "tool_call_update") {
    const tid = String(upd?.toolCallId || upd?.id || "");
    if (!tid) return false;
    if (entry?.knownToolIds?.has(tid)) return false;
    return true;
  }
  if (kind === "agent_message" || kind === "agent_message_chunk" || kind === "text_delta"
    || kind === "agent_thought" || kind === "agent_thought_chunk" || kind === "thinking_delta") {
    const mid = upd?.messageId ? String(upd.messageId) : "";
    if (mid && entry?.replayMessageIds?.has(mid)) return false;
    const txt = acpTextOf(upd?.content ?? upd?.summary ?? upd?.text);
    return txt.length > 0;
  }
  return true;
}

/** 探测 agy acp 非常驻后台 shell 任务是否仍在运行：
 *  1) 存在无归属 shell（childKey === null）时严格 fail-closed 返回 active；
 *  2) 只要有任一任务归属的子进程仍在存活集合（或经 isChildKeyAliveFallback 核验仍存活），或存在非 daemon 的存活子进程，即视为仍在执行，绝不误触发；
 *  3) 全部非 daemon 子进程退出后，再核对对应 task-<N>.log 是否仍在 1.5s 内刷盘，确认落稳后才进入宽限窗。 */
export function acpBgShellActive(parentPid, {
  daemonChildKeys = null,
  sessionId = "",
  tasks = [],
  now = Date.now(),
  procDir = "/proc",
  brainDir = path.join(CFG.home, ".gemini", "antigravity-cli", "brain"),
  logSettleMs = ACP_BG_TASKLOG_SETTLE_MS,
  isPidAlive = isPidAliveFallback,
} = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return { active: true, reason: "no-pid" };
  if (Array.isArray(tasks) && tasks.some((t) => t && t.childKey === null)) {
    return { active: true, reason: "unattributed" };
  }
  const kids = listAcpChildren(parentPid, procDir);
  if (kids === null) return { active: true, reason: "no-proc" };
  const liveKeys = new Set(kids.map((c) => c.key));
  if (Array.isArray(tasks) && tasks.some((t) => typeof t?.childKey === "string" && t.childKey.length > 0 && liveKeys.has(t.childKey))) {
    return { active: true, reason: "task-child", children: kids.filter((c) => tasks.some((t) => t?.childKey === c.key)) };
  }
  if (Array.isArray(tasks) && typeof isPidAlive === "function") {
    for (const t of tasks) {
      if (typeof t?.childKey !== "string" || !t.childKey.length) continue;
      if (isChildKeyAliveFallback(t.childKey, procDir, isPidAlive)) {
        const pid = Number(t.childKey.split(":")[0]);
        return { active: true, reason: "hidden-kill0-alive", pid };
      }
    }
  }
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
    const isTaskWorkflow = v.type === "workflow" && /(?:^|\/)task-\d+$/.test(String(k));
    if (v.type !== "shell" && !isTaskWorkflow) continue;
    const shortK = k.includes("/") ? k.split("/").pop() : k;
    if (!liveIds.has(k) && !liveIds.has(shortK)) {
      if (removeBgTaskAndDependents(scopeKey, map, k)) changed = true;
    }
  }
  return changed;
}

/** 常驻 ACP 进程的收尾（MIG-19）：先摘下 /proc 整棵子孙树（覆盖 setsid / 独立进程组的后台 shell 命令），
 *  再 SIGTERM 整组与全部子孙；宽限期后经 startTicks 复核仍存活的节点补 SIGKILL，防止孤儿残留且杜绝 PID 复用误杀。 */
export const ACP_KILL_GRACE_MS = 3000;
export function killAcpChild(child, graceMs = ACP_KILL_GRACE_MS) {
  if (!child || !child.pid) return;
  const descPids = listDescendantPids(child.pid);
  const descSnap = descPids.map((p) => {
    const ticks = readProcStartTicks(p);
    return { pid: p, key: ticks ? `${p}:${ticks}` : `${p}:hidden` };
  });
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); return true; }
    catch { try { child.kill(sig); } catch {} return false; }
  };
  const killPidAndGroup = (p, sig) => {
    try { process.kill(-p, sig); } catch {}
    try { process.kill(p, sig); } catch {}
  };
  killGroup("SIGTERM");
  for (const d of descSnap) killPidAndGroup(d.pid, "SIGTERM");
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode == null) killGroup("SIGKILL");
    for (const d of descSnap) {
      if (isChildKeyAliveFallback(d.key)) killPidAndGroup(d.pid, "SIGKILL");
    }
  }, graceMs);
  t.unref?.();
}

/** 销毁池中某个会话的常驻 ACP 进程 */
export function closeAcpSession(sessionId) {
  const entry = sessionId && ACP_POOL.get(sessionId);
  if (!entry) return;
  clearAllBgExpiryTimers(`pool:${sessionId}`);
  try { entry.clearBgWatch?.(); } catch {}
  try { entry.flushIdle?.(true); } catch {}
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

var IDLE_SETTLED_HOOKS;
/** 注册 ACP 空闲冲刷（idleBurst）结束后的唤醒钩子（供 queue.mjs 立即泵出等待中的同会话消息，C-02） */
export function onAcpIdleSettled(fn) {
  if (typeof fn !== "function") return;
  if (!IDLE_SETTLED_HOOKS) IDLE_SETTLED_HOOKS = [];
  if (!IDLE_SETTLED_HOOKS.includes(fn)) IDLE_SETTLED_HOOKS.push(fn);
}
function notifyIdleSettled(sessionId) {
  if (!IDLE_SETTLED_HOOKS) return;
  for (const fn of IDLE_SETTLED_HOOKS) {
    try { fn(sessionId); } catch {}
  }
}

/** 查询某会话当前是否正处于 ACP 空闲冲刷（idleBurst）期，用于队列泳道互斥，防并发 session/prompt 取消工具（C-02） */
export function hasAcpIdleBurst(sessionId) {
  if (!sessionId) return false;
  const e = ACP_POOL.get(sessionId);
  return Boolean(e && (e.idleBurstActive || e.idleRun));
}

/** 显式停止正在进行中的 ACP 空闲冲刷（按 idleRun.id 或 sessionId；不传参则停掉全部） */
export function abortAcpIdleBurst(idOrSid = null) {
  let stopped = false;
  for (const [sid, e] of ACP_POOL) {
    if (!e || (!e.idleBurstActive && !e.idleRun)) continue;
    if (idOrSid && e.idleRun?.id !== idOrSid && sid !== idOrSid) continue;
    try { e.client?.notify("session/cancel", { sessionId: sid }); } catch {}
    try { e.flushIdle?.(true); } catch {}
    stopped = true;
  }
  return stopped;
}

/** 全局切权限模式时同步更新 ACP 池中所有空闲项的 permMode（保证空闲期权限回调立即生效，
 *  不改 appliedPermMode，从而下次复用时若与服务端模式不符会自动 applyMode，C-02） */
export function setAcpPoolPermMode(mode) {
  if (!mode) return 0;
  let n = 0;
  for (const e of ACP_POOL.values()) {
    if (e && !e.busy) {
      e.permMode = mode;
      n++;
    }
  }
  return n;
}

/** 停止某个 ACP 会话的后台任务：只删本地登记，绝不发全会话 session/cancel。
 *  ACP 没有单任务取消协议，发 session/cancel 会把正在跑的主轮次一并取消（B9）；
 *  当停掉的是子代理/工作流时，同步更新 acpAgents 状态、广播 ag stopped 事件并写入联络簿（C-09）；
 *  传入具体 taskId（单条停用）时不误杀整个空闲常驻进程，仅 !taskId 整会话清场时才回收进程。 */
export function stopAcpBgTask(sessionId, taskId) {
  const entry = sessionId && ACP_POOL.get(sessionId);
  if (!entry) return false;
  const poolScope = `pool:${sessionId}`;
  entry.nudgedBgTasks ||= new Set();
  const stoppedAgents = [];
  if (taskId) {
    const tid = String(taskId);
    const item = entry.bgTasks?.get(tid);
    const rec = entry.acpAgents?.get(tid);
    if (item && (item.type === "shell" || item.type === "daemon") && typeof item.childKey === "string" && item.childKey.length > 0) {
      try { killBgChildTree(entry.client?.child?.pid, item.childKey); } catch {}
    }
    if (rec && rec.status === "running" && (!item || item.type === "agent" || item.type === "workflow")) {
      stoppedAgents.push(rec);
    }
    entry.nudgedBgTasks.add(tid);
    removeBgTaskAndDependents(poolScope, entry.bgTasks, tid);
  } else {
    for (const item of entry.bgTasks?.values() || []) {
      if (item && (item.type === "shell" || item.type === "daemon") && typeof item.childKey === "string" && item.childKey.length > 0) {
        try { killBgChildTree(entry.client?.child?.pid, item.childKey); } catch {}
      }
    }
    for (const rec of entry.acpAgents?.values() || []) {
      if (rec && rec.status === "running") stoppedAgents.push(rec);
    }
    for (const k of entry.bgTasks?.keys() || []) entry.nudgedBgTasks.add(k);
    clearAllBgExpiryTimers(poolScope);
    entry.bgTasks?.clear();
  }
  for (const rec of stoppedAgents) {
    rec.status = "stopped";
    if (rec.convId) entry.reportedAgentConvs?.delete(rec.convId.toLowerCase());
    publish({ type: "ag", sessionId, k: "done", id: rec.id, status: "stopped", why: "已停止", at: Date.now() });
    if (entry.cwd && sessionId) {
      try {
        acpAgentDone(entry.cwd, sessionId, {
          id: rec.id,
          dir: entry.acpAgentDirs?.get(rec.id) || null,
          name: rec.name || "agent",
          status: "stopped",
          why: "已停止",
          report: "",
        });
      } catch {}
    }
  }
  entry.dropActiveBg?.(taskId);
  const hasWatchableShell = [...(entry.bgTasks?.values() || [])].some(
    (t) => t && t.type === "shell" && typeof t.childKey === "string" && t.childKey.length > 0 && !entry.nudgedBgTasks.has(t.id)
  );
  if (!hasWatchableShell) {
    try { entry.clearBgWatch?.(); } catch {}
  }
  if (!taskId && !entry.busy && (!entry.bgTasks || entry.bgTasks.size === 0)) {
    closeAcpSession(sessionId);
  }
  return true;
}

/** 网关关闭或测试收尾时清理所有常驻 ACP 进程 */
export function closeAllAcpClients() {
  for (const sid of [...ACP_POOL.keys()]) closeAcpSession(sid);
}

onShutdown("ACP 会话池", () => closeAllAcpClients());

/** 将工作目录编码为会话项目目录名（对齐 sessions.mjs projEnc：超过 200 字符截断并拼 sha256 前 8 位防 ENAMETOOLONG，C-08.5） */
export function encodeProjectDir(cwd) {
  const p = String(cwd || CFG.workspace || CFG.home);
  const s = p.replace(/[^A-Za-z0-9]/g, "-");
  return s.length <= 200 ? s : s.slice(0, 200) + "-" + crypto.createHash("sha256").update(p).digest("hex").slice(0, 8);
}

/** 构造本次会话的本地 jsonl 落盘路径（平滑兼容旧版未截断长目录里的既有文件） */
export function acpSessionFile(cwd, sessionId) {
  const p = String(cwd || CFG.workspace || CFG.home);
  const rawEnc = p.replace(/[^A-Za-z0-9]/g, "-");
  const enc = encodeProjectDir(p);
  if (rawEnc !== enc && rawEnc.length <= 250) {
    const legacy = path.join(PATHS.projects, rawEnc, `${sessionId}.jsonl`);
    try { if (fs.existsSync(legacy)) return legacy; } catch {}
  }
  const dir = path.join(PATHS.projects, enc);
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

/** 权限选项按 kind/optionId 精确匹配（MIG-21 + C-02）：
 *  disallow/reject/deny 永不被当允许项；
 *  always=true 优先 allow_always/allow_session；always=false 优先 allow_once/allow，
 *  若选项中仅有 allow_always/allow_session（或明确 allow 类且非 reject/disallow）则兜底返回，避免权限卡失配。 */
const acpOptKind = (o) => String(o?.kind || o?.optionId || "").trim().toLowerCase();
const isAcpAllowOpt = (o) => /^(allow_once|allow)$/.test(acpOptKind(o));
const isAcpAllowAlwaysOpt = (o) => /^(allow_always|allow_session)$/.test(acpOptKind(o));
const isAcpRejectOpt = (o) => /^(reject_once|reject_always|reject|deny|deny_once|deny_always|disallow|disallow_once|disallow_always)$/.test(acpOptKind(o));
const isAcpDenyishOpt = (o) => isAcpRejectOpt(o) || /\b(?:reject|deny|disallow)\b/.test(acpOptKind(o));
const isAcpAllowishOpt = (o) => !isAcpDenyishOpt(o) && /(?:^|[_-])allow(?:$|[_-])/.test(acpOptKind(o));
export function pickAcpAllowOption(options, always = false, { allowAlwaysFallback = true } = {}) {
  const list = Array.isArray(options) ? options : [];
  if (always) {
    const hitAlways = list.find(isAcpAllowAlwaysOpt);
    if (hitAlways) return hitAlways;
  }
  const allow = list.find(isAcpAllowOpt);
  if (allow) return allow;
  if (always || allowAlwaysFallback) {
    const fallbackAlways = list.find(isAcpAllowAlwaysOpt);
    if (fallbackAlways) return fallbackAlways;
  }
  const allowish = list.find((o) => isAcpAllowishOpt(o) && (always || allowAlwaysFallback || !isAcpAllowAlwaysOpt(o)));
  if (allowish) return allowish;
  const first = list[0];
  if (!first || isAcpDenyishOpt(first)) return undefined;
  if (!always && !allowAlwaysFallback && isAcpAllowAlwaysOpt(first)) return undefined;
  return first;
}

const UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_STR_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

function fileUriToLocalPath(uri) {
  const s = String(uri || "").trim();
  if (!s) return null;
  if (/^file:\/\//i.test(s)) {
    const raw = s.replace(/^file:\/\//i, "");
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return path.isAbsolute(s) ? s : null;
}

/** 轻量读取子代理 transcript.jsonl 尾部最多 32KB，确定性判断该子代理是否已交卷闲置（C-09 + W1-F1）：
 *  绝不全量读大文件；仅当最后一条有效 JSON 帧满足 source=MODEL, type=PLANNER_RESPONSE, status=DONE 且无未决 tool_calls，
 *  且满足以下条件之一时返回 true：
 *  1) reportedConvs 命中当前子代理 convId；
 *  2) 最后一条入站消息（当前轮次）内的 PLANNER_RESPONSE.tool_calls 中存在发往 parentSessionId 的 send_message；
 *  3) 兼容只读子代理纯文本末帧交卷：当前轮次无 invoke_subagent/run_workflow/schedule 及后台 run_command、末帧 content 非空、且静默超 quietMs。 */
export function isSubagentTranscriptIdle(logPath, parentSessionId = "", reportedConvs = null, {
  convId = "",
  now = Date.now(),
  quietMs = 3000,
} = {}) {
  if (!logPath || typeof logPath !== "string") return false;
  let st;
  try { st = fs.statSync(logPath); } catch { return false; }
  if (!st.isFile() || st.size <= 0) return false;
  const maxBytes = 32 * 1024;
  const offset = st.size > maxBytes ? st.size - maxBytes : 0;
  const len = st.size - offset;
  let tail = "";
  let fd = null;
  try {
    fd = fs.openSync(logPath, "r");
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, offset);
    tail = buf.subarray(0, n).toString("utf8");
  } catch {
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
  const rawLines = tail.split(/\r?\n/);
  const lines = offset > 0 && rawLines.length > 1 ? rawLines.slice(1) : rawLines;
  const parsed = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object") parsed.push(obj);
    } catch {}
  }
  const last = parsed.length ? parsed[parsed.length - 1] : null;
  if (!last || last.source !== "MODEL" || last.type !== "PLANNER_RESPONSE" || last.status !== "DONE") return false;
  if (Array.isArray(last.tool_calls) && last.tool_calls.length > 0) return false;

  const effConv = String(convId || (UUID_IN_STR_RE.exec(logPath)?.[1] || "")).toLowerCase();
  if (effConv && reportedConvs && reportedConvs.size > 0) {
    if (reportedConvs.has(effConv)) return true;
    for (const c of reportedConvs) {
      if (String(c).toLowerCase() === effConv) return true;
    }
  }

  const isInboundMsg = (ev) => {
    if (!ev || typeof ev !== "object") return false;
    if (ev.source === "USER_EXPLICIT" || ev.type === "USER_INPUT") return true;
    const isSys = ev.source === "SYSTEM" || ev.type === "SYSTEM_MESSAGE" || ev.source === "SYSTEM_MESSAGE";
    if (isSys) {
      const txt = typeof ev.content === "string" ? ev.content : JSON.stringify(ev);
      if (txt.includes("[Message]")) return true;
    }
    return false;
  };
  let turnStart = 0;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (isInboundMsg(parsed[i])) {
      turnStart = i + 1;
      break;
    }
  }
  const turnSteps = parsed.slice(turnStart);
  const wantParent = String(parentSessionId || "").trim();
  const ASYNC_TOOLS = new Set(["invoke_subagent", "run_workflow", "schedule"]);
  let hasAsyncPending = false;
  let sentToParent = false;
  for (const step of turnSteps) {
    if (step?.type === "PLANNER_RESPONSE" && Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        const name = String(tc?.name || "").trim().toLowerCase();
        if (name === "send_message") {
          const recip = String(tc?.args?.Recipient ?? tc?.arguments?.Recipient ?? "").replace(/^"|"$/g, "").trim();
          if (wantParent ? recip === wantParent : recip.length > 0) sentToParent = true;
        }
        if (ASYNC_TOOLS.has(name)) hasAsyncPending = true;
      }
    }
    const stepStr = typeof step?.content === "string"
      ? step.content
      : (typeof step?.output === "string" ? step.output : JSON.stringify(step));
    if (/Tool is running (?:as a background task|in the background)|Command running in (?:the )?background/i.test(stepStr)) {
      hasAsyncPending = true;
    }
  }

  if (hasAsyncPending) return false;
  if (sentToParent) return true;
  if (typeof last.content !== "string" || last.content.trim().length === 0) return false;
  const tsRaw = last.timestamp || last.created_at || last.updated_at || "";
  const parsedTs = tsRaw ? Date.parse(tsRaw) : NaN;
  const refTs = Number.isFinite(parsedTs) ? parsedTs : st.mtimeMs;
  return now - refTs >= quietMs;
}

/** 统一结算已完工的子代理（C-09）：
 *  结合 user_message 唤醒信封（reportedConvs）与子代理 transcript.jsonl 尾帧确定性对账，
 *  结算后同步更新 rec.status、从 bgTasks 摘除、发 ag done 事件并调用 acpAgentDone 写联络簿。 */
function reconcileFinishedSubagents({
  agents,
  bgTasks,
  poolScope,
  sessionId,
  cwd,
  agentDirs,
  reportedConvs,
  runId = null,
  onBgChanged = null,
  emitAg = null,
  brainDir = path.join(CFG.home, ".gemini", "antigravity-cli", "brain"),
  now = Date.now(),
  quietMs = 3000,
}) {
  if (!agents || !agents.size) return false;
  let changed = false;
  for (const rec of agents.values()) {
    if (!rec || rec.status !== "running") continue;
    const convLower = rec.convId ? String(rec.convId).toLowerCase() : "";
    const hasReported = !!(convLower && reportedConvs && (reportedConvs.has(convLower) || [...reportedConvs].some((x) => String(x).toLowerCase() === convLower)));
    const lp = rec.logPath || (rec.convId && UUID_EXACT_RE.test(rec.convId) && brainDir
      ? path.join(brainDir, rec.convId, ".system_generated", "logs", "transcript.jsonl")
      : null);
    let lpExists = false;
    if (lp) {
      try { lpExists = fs.statSync(lp).isFile(); } catch {}
    }
    const doneByTranscript = lpExists && isSubagentTranscriptIdle(lp, sessionId || "", reportedConvs, { convId: convLower, now, quietMs });
    // 有 transcript 文件时以尾帧状态为准（防止子代理发中间消息仍在跑时被误结）；无 transcript 文件时可由 reportedConvs 确认交卷
    const finished = doneByTranscript || (!lpExists && hasReported);
    if (!finished) continue;
    rec.status = "done";
    if (convLower && reportedConvs) {
      for (const c of [...reportedConvs]) if (String(c).toLowerCase() === convLower) reportedConvs.delete(c);
    }
    if (bgTasks && removeBgTaskAndDependents(poolScope, bgTasks, rec.id)) changed = true;
    const agEv = { type: "ag", ...(runId ? { runId } : {}), sessionId, k: "done", id: rec.id, status: "done", why: "已完成", at: now };
    if (emitAg) emitAg(agEv);
    else publish(agEv);
    if (cwd && sessionId) {
      try {
        acpAgentDone(cwd, sessionId, {
          id: rec.id,
          dir: agentDirs?.get(rec.id) || null,
          name: rec.name || "agent",
          status: "done",
          why: "已完成",
          report: "",
        });
      } catch {}
    }
  }
  if (changed) onBgChanged?.();
  return changed;
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
      const bgType = kind === "run_workflow" ? "workflow" : "agent";
      const nowAt = Date.now();
      agents.set(tool.id, { id: tool.id, convId: null, logPath: null, kind: bgType, name: label, status: "running", startedAt: nowAt });
      emit({ type: "ag", k: "spawn", id: tool.id, tool: tool.id, name: label, parent: null, depth: 1, bg: true, by: "main", at: nowAt });
      state.onBgAdd?.({ id: tool.id, type: bgType, desc: label, toolId: tool.id, startedAt: nowAt, lastActiveAt: nowAt });
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
      const mLog = /"(?:logAbsoluteUri|transcript)"\s*:\s*"([^"]+)"|(?:logAbsoluteUri|transcript)[=:\s]+(file:\/\/[^\s"',}\]]+|\/[^\s"',}\]]+)/i.exec(out);
      if (rec && mLog) {
        const lp = fileUriToLocalPath(mLog[1] || mLog[2]);
        if (lp) rec.logPath = lp;
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
      // 对称唤醒（C-09 + S-3/P2-5）：主代理给子代理继续派活成功时，清掉该子代理上一轮残留的 reportedAgentConvs 与 _userMsgTail，
      // 防止刚被重新派活的子代理被上一轮残留回报提前误结算，并重新标回 running 挂回后台任务条
      if (!tool.isError) {
        const rec = agents.get(to) || [...agents.values()].find((r) => r?.convId && r.convId.toLowerCase() === rawTo.toLowerCase());
        const dropTargets = new Set([rawTo.toLowerCase(), rec?.convId ? String(rec.convId).toLowerCase() : ""].filter(Boolean));
        if (dropTargets.size) {
          if (state.reportedAgentConvs) {
            for (const c of [...state.reportedAgentConvs]) if (dropTargets.has(String(c).toLowerCase())) state.reportedAgentConvs.delete(c);
          }
          state._userMsgTail = "";
        }
        if (rec && rec.status !== "running") {
          rec.status = "running";
          emit({ type: "ag", k: "resume", id: rec.id, at: Date.now() });
          state.onBgAdd?.({ id: rec.id, type: rec.kind === "workflow" ? "workflow" : "agent", desc: rec.name });
        }
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
    } else if (act === "list") {
      // manage_subagents(Action: "list") 权威对账（C-09）
      const out = String(tool.output || "");
      if (!/\btruncated\b|已截断/i.test(out)) {
        let listed = null;
        if (/no active (?:direct )?subagents?/i.test(out)) {
          listed = [];
        } else {
          const lb = out.indexOf("["), rb = out.lastIndexOf("]");
          if (lb >= 0 && rb > lb) {
            try {
              const arr = JSON.parse(out.slice(lb, rb + 1));
              if (Array.isArray(arr)) listed = arr;
            } catch {}
          }
        }
        if (listed !== null) {
          const listedByConv = new Map();
          const listedItems = [];
          for (const x of listed) {
            if (!x || typeof x !== "object") continue;
            const cid = String(x.conversationId || x.id || "").trim();
            const lp = fileUriToLocalPath(x.transcript || x.logAbsoluteUri || x.logPath);
            const st = String(x.state || x.status || "").trim().toLowerCase();
            const role = String(x.role || x.name || "").trim();
            const entryObj = { convId: cid, logPath: lp, state: st, role };
            listedItems.push(entryObj);
            if (cid) listedByConv.set(cid.toLowerCase(), entryObj);
          }
          const boundConvs = new Set([...agents.values()].map((r) => r?.convId?.toLowerCase()).filter(Boolean));
          for (const rec of agents.values()) {
            if (!rec) continue;
            if (rec.convId) {
              const hit = listedByConv.get(rec.convId.toLowerCase());
              if (hit?.logPath && !rec.logPath) rec.logPath = hit.logPath;
            } else if (rec.name) {
              const cands = listedItems.filter((it) => it.role === rec.name && it.convId && !boundConvs.has(it.convId.toLowerCase()));
              if (cands.length === 1) {
                rec.convId = cands[0].convId;
                byConv.set(rec.convId, rec.id);
                boundConvs.add(rec.convId.toLowerCase());
                if (cands[0].logPath && !rec.logPath) rec.logPath = cands[0].logPath;
              }
            }
          }
          for (const rec of agents.values()) {
            if (!rec || rec.status !== "running") continue;
            const hit = rec.convId ? listedByConv.get(rec.convId.toLowerCase()) : null;
            const absentFromList = !hit && (Boolean(rec.convId) || listedItems.length === 0);
            const notRunning = !!(hit && hit.state && hit.state !== "running");
            if (!absentFromList && !notRunning) continue;
            let status = "done";
            if (hit?.state === "failed" || hit?.state === "error") status = "failed";
            else if (hit?.state === "stopped" || hit?.state === "killed" || hit?.state === "cancelled" || hit?.state === "canceled") status = "stopped";
            rec.status = status;
            if (rec.convId && state.reportedAgentConvs) {
              const cl = rec.convId.toLowerCase();
              for (const c of [...state.reportedAgentConvs]) if (String(c).toLowerCase() === cl) state.reportedAgentConvs.delete(c);
            }
            const why = status === "stopped" ? "已停止" : status === "failed" ? "执行失败" : "已完成";
            emit({ type: "ag", k: "done", id: rec.id, status, why, at: Date.now() });
            state.onBgRemove?.(rec.id);
            bookDone(rec.id, status, why, "");
          }
        }
      }
    }
    return;
  }

    if (kind === "run_command" && phase === "done") {
      const outDone = String(tool.output || "");
      const sepDone = /\r?\n(?:Command|Log) output:\r?\n/;
      const hdrDone = sepDone.test(outDone) ? outDone.split(sepDone)[0] : outDone.split(/\r?\n/, 6).join("\n");
      const exitedDone = /^Command (?:exited with code \d+|was terminated by signal)/m.test(hdrDone);
      if (tool.bgTaskId && (tool.isError || tool.cancelled || exitedDone)) {
        state.onBgRemove?.(tool.bgTaskId);
      }
    }
    if (kind === "run_command" && (phase === "done" || phase === "update") && !tool.isError) {
    const out = String(tool.output || "");
    // 只检视工具信封头（有 Command/Log output: 分隔符时取其前；无分隔符时仅取前 6 行信封头），
    // 防止同步退出或前台超时的命令输出正文里含 "background task" / "TaskId" 被误挂为幽灵后台任务。
    const sepRe = /\r?\n(?:Command|Log) output:\r?\n/;
    const header = sepRe.test(out) ? out.split(sepRe)[0] : out.split(/\r?\n/, 6).join("\n");
    const syncExited = /^Command (?:exited with code \d+|was terminated by signal)/m.test(header);
    const bgMatch = (phase === "done" && !!inp.IsDaemon) || (!syncExited && (
      /^Tool is running (?:as a background task|in the background)\b/m.test(header)
      || /\bCommand running in (?:the )?background\b/i.test(header)
      || /\b(?:TaskId|task[_\s-]?id)["':=\s]+[A-Za-z0-9._/-]*[A-Za-z0-9_/-]/i.test(header)
    ));
    if (bgMatch) {
      const mId = /(?:TaskId|task[_\s-]?id)["':=\s]+([A-Za-z0-9._/-]*[A-Za-z0-9_/-])/i.exec(header);
      const tid = mId ? mId[1] : tool.id;
      const mLog = /Task logs are available at:\s*(file:\/\/\S+|\/\S+)/i.exec(header);
      const logPath = mLog ? fileUriToLocalPath(mLog[1]) : (tool.logPath || null);
      const titleCmd = rawName.replace(/^run\s+/i, "").trim();
      const desc = String(
        inp.toolSummary || inp.description || inp.CommandLine
        || (titleCmd && titleCmd.toLowerCase() !== "run_command" ? titleCmd : "")
        || "后台命令"
      ).trim().slice(0, 80);
      const nowAt = Date.now();
      tool.bgTaskId = tid;
      if (logPath) tool.logPath = logPath;
      if (!tool.done) tool.status = "background";
      state.onBgAdd?.({
        id: tid,
        type: inp.IsDaemon ? "daemon" : "shell",
        desc,
        toolId: tool.id,
        ...(logPath ? { logPath } : {}),
        startedAt: tool.startedAt || nowAt,
        lastActiveAt: nowAt,
      });
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
      state.segText = (state.segText || "") + text;
      state.lastOutputAt = Date.now();
      emit({ type: "text_delta", text });
    }
    return;
  }
  // 整条消息（v2 风格 upsert，不走 chunk；旧草稿的字段名叫 summary）：
  // 有独立 messageId 且该 id 此前无流式分片（chunkAcc === ""）时，先核对本段 segText 防「无 id chunk + 有 id 整条」重复（S-3/P2-4），
  // 确认未发过则代表新一轮/工具调用后的新一段回复，直接追加（C-04）；仅当无 messageId 时才保留 if (!state.text) 防重复。
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
        if (rest) { state.text += rest; state.segText = (state.segText || "") + rest; emit({ type: "text_delta", text: rest }); }
        fullTextIds.add(updMsgId);
        return;
      }
      if (chunkAcc && chunkAcc.startsWith(text)) { fullTextIds.add(updMsgId); return; } // 整条是已收 chunk 的前缀
      fullTextIds.add(updMsgId);
      if (!chunkAcc) {
        const seg = state.segText || "";
        if (seg && (seg === text || seg.endsWith(text))) return;
        state.text += text;
        state.segText = seg + text;
        emit({ type: "text_delta", text });
        return;
      }
    }
    if (!state.text) {
      state.text = text;
      state.segText = text;
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
      state.segThinking = (state.segThinking || "") + text;
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
        if (rest) { state.thinking += rest; state.segThinking = (state.segThinking || "") + rest; emit({ type: "thinking_delta", text: rest }); }
        fullThinkingIds.add(updMsgId);
        return;
      }
      if (chunkAcc && chunkAcc.startsWith(text)) { fullThinkingIds.add(updMsgId); return; }
      fullThinkingIds.add(updMsgId);
      if (!chunkAcc) {
        const seg = state.segThinking || "";
        if (seg && (seg === text || seg.endsWith(text))) return;
        state.thinking += text;
        state.segThinking = seg + text;
        emit({ type: "thinking_delta", text });
        return;
      }
    }
    if (!state.thinking) {
      state.thinking = text;
      state.segThinking = text;
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
    state.segText = "";
    state.segThinking = "";
    const rec = { id, name, rawName: upd.name ? String(upd.name) : "", kind: upd.kind ? String(upd.kind) : "", input, status: upd.status || "pending", output: "", isError: false, cancelled: false, done: false, startedAt: Date.now() };
    state.tools.set(id, rec);
    emit({ type: "tool_use", id, name, ...(rec.rawName ? { rawName: rec.rawName } : {}), ...(rec.kind ? { kind: rec.kind } : {}), input });
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
      state.segText = "";
      state.segThinking = "";
      const name = String(upd.title || upd.name || upd.kind || "Tool");
      const input = upd.rawInput && typeof upd.rawInput === "object"
        ? upd.rawInput
        : (upd.input && typeof upd.input === "object" ? upd.input : {});
      prev = { id, name, rawName: upd.name ? String(upd.name) : "", kind: upd.kind ? String(upd.kind) : "", input, status: upd.status || "in_progress", output: "", isError: false, cancelled: false, done: false, startedAt: Date.now() };
      state.tools.set(id, prev);
      emit({ type: "tool_use", id, name, ...(prev.rawName ? { rawName: prev.rawName } : {}), ...(prev.kind ? { kind: prev.kind } : {}), input });
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
      if (!prev.bgTaskId && prev.output) trackAcpToolSideEffects("update", prev, state, emit);
      const fullOut = String(prev.output || "");
      const clippedOut = fullOut.length > TOOL_OUT_MAX ? fullOut.slice(-TOOL_OUT_MAX) : fullOut;
      emit({
        type: "tool_update",
        id: prev.id,
        name: prev.name,
        input: prev.input,
        status: prev.bgTaskId ? "background" : prev.status,
        ...(prev.bgTaskId ? { bgTaskId: prev.bgTaskId } : {}),
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

  if (kind === "user_message" || kind === "user_message_chunk") {
    captureSubagentSenders(acpTextOf(upd.content ?? upd.summary ?? upd.text), state, {
      resetAfter: kind === "user_message",
      msgId: updMsgId,
    });
    return;
  }

  // 已知但有意忽略的种类（不回显、不影响本轮正文），之外的记进日志：
  // 真机上 agy 发来新种类时，日志里能直接看到名字，不用再猜
  const IGNORED = new Set(["config_option_update", "session_info_update", "compaction_summary_chunk", "permission_confirmation"]);
  if (!IGNORED.has(kind)) log(`[agy-acp] 未识别的 update 种类：${kind}`);
}

/** 从 user_message / user_message_chunk 文本中提取子代理唤醒信封 [Message] ... sender=<uuid>（S-3 / P2-5 防误匹配与旧尾串味） */
function captureSubagentSenders(uText, holder, { resetAfter = false, msgId = "" } = {}) {
  if (!holder) return;
  if (msgId && holder._userMsgId && holder._userMsgId !== msgId) holder._userMsgTail = "";
  if (msgId) holder._userMsgId = msgId;
  if (!uText) {
    if (resetAfter) { holder._userMsgTail = ""; holder._userMsgId = ""; }
    return;
  }
  const scan = ((holder._userMsgTail || "") + String(uText)).slice(-512);
  holder._userMsgTail = resetAfter ? "" : scan;
  if (resetAfter) holder._userMsgId = "";
  const reSender = /\[Message\][^\r\n]*?\bsender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
  let ms;
  while ((ms = reSender.exec(scan)) !== null) {
    (holder.reportedAgentConvs ||= new Set()).add(ms[1].toLowerCase());
  }
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

const ACP_ENV_KEY_VARS = [
  "GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  "CCAPP_PRIV_SESS",
];

// 全局 ~/.gemini/antigravity-cli/settings.json 串行握手锁（C-05）：
// 仅包裹冷启动时的 syncSettings → spawn → initialize → authenticate → session/new|resume|load，
// 避免多会话异构厂商并发冷启互相覆盖 modelProvider / customModelsConfig。
let AGY_SETTINGS_LOCK = Promise.resolve();
export function withAgySettingsLock(fn) {
  const prev = AGY_SETTINGS_LOCK;
  let release;
  AGY_SETTINGS_LOCK = new Promise((r) => { release = r; });
  return prev.then(fn, fn).finally(() => release());
}

/** 查询常驻 ACP_POOL 存活子进程对应的 sessionId（供 run.mjs privWitness 池化兜底，C-01） */
export function acpPoolSessionForPid(anc, top) {
  for (const entry of ACP_POOL.values()) {
    const c = entry?.client?.child;
    if (!c || !c.pid || c.exitCode !== null || c.signalCode !== null) continue;
    if (anc === process.pid ? top === c.pid : anc === c.pid) return entry.sessionId || "";
  }
  return "";
}

const ACP_TOOL_WRITE_EDIT = new Set(["edit", "write", "multiedit", "notebookedit", "write_file", "edit_file", "replace_file_content", "multi_replace_file_content", "write file", "edit file", "replace file"]);
const ACP_TOOL_EXEC = new Set(["bash", "powershell", "run_command", "run_shell", "run command", "run shell"]);
const ACP_TOOL_WEB_FETCH = new Set(["webfetch", "web_fetch", "read_url_content", "fetch_url", "web fetch", "read url content"]);
const ACP_TOOL_WEB_SEARCH = new Set(["websearch", "web_search", "search_web", "web search", "search web"]);

function acpToolGroups(name, kind) {
  const g = new Set();
  const n = String(name || "").trim().toLowerCase();
  const k = String(kind || "").trim().toLowerCase();
  const base = n.replace(/\(.*\)$/, "").trim();
  if (base) g.add(base);
  if (n) g.add(n);
  if (k) g.add(k);
  if (ACP_TOOL_WRITE_EDIT.has(base) || /^(?:write|edit|replace)\s+file/i.test(base) || k === "edit" || k === "write") g.add("__write_edit__");
  if (ACP_TOOL_EXEC.has(base) || /^run\s+(?:command|shell)/i.test(base) || k === "execute") g.add("__exec__");
  if (ACP_TOOL_WEB_FETCH.has(base) || k === "fetch") g.add("__web_fetch__");
  // 注意：不把 kind==="search" 归入 __web_search__，避免禁用 WebSearch 时误伤本地 grep_search/find_by_name（S-2）
  if (ACP_TOOL_WEB_SEARCH.has(base)) g.add("__web_search__");
  return g;
}

export function isAcpToolDisallowed(toolName, toolKind, disallowedTools) {
  if (!Array.isArray(disallowedTools) || !disallowedTools.length) return false;
  const target = acpToolGroups(toolName, toolKind);
  for (const raw of disallowedTools) {
    const rule = acpToolGroups(raw, "");
    for (const tok of rule) {
      if (target.has(tok)) return true;
    }
  }
  return false;
}

export function isAcpToolAllowed(toolName, toolKind, allowedTools) {
  if (!Array.isArray(allowedTools) || !allowedTools.length) return false;
  const target = acpToolGroups(toolName, toolKind);
  for (const raw of allowedTools) {
    const s = String(raw || "").trim();
    // P1-A：带括号作用域规则（如 Bash(git status:*)、Edit(docs/**)）在 ACP 下无法按参数安全匹配，一律跳过不放宽为整类放行
    if (!s || s.includes("(")) continue;
    const rule = acpToolGroups(s, "");
    for (const tok of rule) {
      if (target.has(tok)) return true;
    }
  }
  return false;
}

export function poolKey({ bin, args, cwd, authType, apiKey, env = null, extraEnv = null, extraModels = null, addDirs = [], mcpServers = [] }) {
  const keyHash = apiKey ? crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 12) : "";
  const envSlice = {};
  if (env && typeof env === "object") {
    for (const k of ACP_ENV_KEY_VARS) if (env[k] != null && env[k] !== "") envSlice[k] = String(env[k]);
  }
  const extraEnvPairs = extraEnv && typeof extraEnv === "object"
    ? Object.keys(extraEnv).sort().map((k) => [k, String(extraEnv[k])])
    : [];
  const modelIds = Array.isArray(extraModels)
    ? extraModels.map((m) => (typeof m === "string" ? m : m?.id || "")).filter(Boolean).sort()
    : [];
  const normDirs = Array.isArray(addDirs) ? addDirs.filter((d) => typeof d === "string" && d.trim()) : [];
  const normMcp = Array.isArray(mcpServers) ? mcpServers : [];
  const cfgHash = crypto.createHash("sha256")
    .update(JSON.stringify({ envSlice, extraEnvPairs, modelIds, normDirs, normMcp }))
    .digest("hex")
    .slice(0, 16);
  return JSON.stringify([bin, args, cwd, authType || "", keyHash, cfgHash]);
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
  mcpServers = [], addDirs = [], extraEnv = null, extraModels = null, syncSettings = null,
  disallowedTools = [], allowedTools = [],
  run, emit, askPermission, onBgChange, onBgWake = null,
  bgPollMs = ACP_BG_POLL_MS, bgGraceMs = ACP_BG_GRACE_MS, probeBgShell = acpBgShellActive,
  activeBgPollMs = 2000, inflightStallWarnMs = 60000,
  isPidAlive = isPidAliveFallback,
  brainDir = path.join(CFG.home, ".gemini", "antigravity-cli", "brain"),
  onSessionFileReady = null, timeoutMs = 0, idleTimeoutMs = 0,
  keepAlive = LIVE && process.env.CCAPP_ACP_KEEPALIVE !== "0",
}) {
  const t0 = Date.now();
  const turnScope = `turn:${run?.id || crypto.randomBytes(4).toString("hex")}`;
  const bgTasks = new Map();
  let clientRef = null;
  let knownChildKeys = new Set();
  let daemonChildKeys = new Set();
  // 按增量快照归属后台任务对应的直接子进程（P1-2 / P1-3）：
  // 仅当自上次快照以来恰好新增 1 个子进程时建立唯一归属；新增 0 个（二次 fork 秒退 / 不可见）或 >1 个（并行歧义）一律 fail-closed（childKey = null），
  // 绝不猜测并污染 daemonChildKeys，避免误豁免正在跑的 shell 或误摘后台任务。
  const attributeBgTaskChild = (item) => {
    if (!item || (item.type !== "shell" && item.type !== "daemon")) return;
    const pid = clientRef?.child?.pid;
    const kids = listAcpChildren(pid);
    if (!kids) { item.childKey = null; return; }
    const fresh = kids.filter((c) => !knownChildKeys.has(c.key));
    for (const c of kids) knownChildKeys.add(c.key);
    if (fresh.length === 1) {
      item.childKey = fresh[0].key;
      if (item.type === "daemon") daemonChildKeys.add(fresh[0].key);
    } else {
      item.childKey = null;
    }
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
      const nowAt = Date.now();
      const prev = bgTasks.get(String(t.id));
      const item = {
        id: String(t.id),
        type: t.type || prev?.type || "shell",
        desc: String(t.desc || prev?.desc || t.id),
        startedAt: Number(t.startedAt) || prev?.startedAt || nowAt,
        lastActiveAt: Number(t.lastActiveAt) || prev?.lastActiveAt || nowAt,
        ...(Number.isFinite(Number(t.bytes)) && Number(t.bytes) >= 0 ? { bytes: Number(t.bytes) } : (prev?.bytes != null ? { bytes: prev.bytes } : {})),
        ...(t.logPath ? { logPath: String(t.logPath) } : (prev?.logPath ? { logPath: prev.logPath } : {})),
        ...(t.toolId ? { toolId: String(t.toolId) } : (prev?.toolId ? { toolId: prev.toolId } : {})),
        ...(t.progress ? { progress: String(t.progress) } : (prev?.progress ? { progress: prev.progress } : {})),
        ...(t.oneShot ? { oneShot: true, expiresAt: Number(t.expiresAt) || 0, timerCondition: String(t.timerCondition || "never") } : {}),
      };
      if (prev && prev.type === item.type && prev.childKey !== undefined) {
        item.childKey = prev.childKey;
      } else if (item.type === "shell" || item.type === "daemon") {
        attributeBgTaskChild(item);
      }
      bgTasks.set(item.id, item);
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
        const isTaskWorkflow = v.type === "workflow" && /(?:^|\/)task-\d+$/.test(String(k));
        if ((v.type !== "agent" && v.type !== "workflow") || isTaskWorkflow) {
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
  // W3-F1：若 disallowedTools 禁止了写文件或命令执行（如只读定时任务），只钳制发往服务端的权限模式，
  // 绝不篡改本地 permMode / state.permMode / run.permMode，确保未禁用工具仍按原模式放行且界面徽标不变。
  const restrictMode = Array.isArray(disallowedTools) && disallowedTools.some((t) => {
    const g = acpToolGroups(t, "");
    return g.has("__write_edit__") || g.has("__exec__");
  });
  const serverModeOf = (m) => (restrictMode && (m === "bypassPermissions" || m === "acceptEdits")) ? "default" : m;
  const pKey = poolKey({ bin, args, cwd, authType, apiKey, env, extraEnv, extraModels, addDirs, mcpServers });

  const isBenignStderr = (line) => /logging before google\.Init:.*Initialized Android local timezone/i.test(line);
  const makeHandlers = () => ({
    onStderr: (s) => {
      const line = s.trim();
      if (line && !isBenignStderr(line)) log(`[agy-acp!] ${line.slice(0, 300)}`);
    },
    onNotification: (method, params) => {
      state.lastRpcAt = Date.now();
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
        const toolTitle = params.toolCall?.title || params.toolCall?.name || params.toolCall?.kind || "Antigravity Tool";
        const toolRaw = params.toolCall?.name || "";
        const toolKind = params.toolCall?.kind || "";

        // C-06：命中 disallowedTools 一律拒绝（即使 permMode 为 bypassPermissions 也不得自动放行）
        if (isAcpToolDisallowed(toolTitle, toolKind, disallowedTools) || (toolRaw && isAcpToolDisallowed(toolRaw, toolKind, disallowedTools))) {
          if (run) (run.denied ||= []).push(toolTitle);
          return rejectOpt
            ? { outcome: { outcome: "selected", optionId: rejectOpt.optionId } }
            : { outcome: { outcome: "cancelled" } };
        }

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
            tool: toolTitle,
            rawName: toolRaw,
            kind: toolKind,
            toolCallId: params.toolCall?.toolCallId || params.toolCall?.id || "",
            input: params.toolCall?.rawInput || params.toolCall?.input || params.toolCall || {},
            options,
            hasAlways: !!allowAlwaysOpt,
          });
        } finally {
          pendingPermCount = Math.max(0, pendingPermCount - 1);
        }
        if (decision && decision.behavior === "allow") {
          const chosen = pickAcpAllowOption(options, !!decision.always, { allowAlwaysFallback: !run?.unattended });
          return chosen
            ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
            : { outcome: { outcome: "cancelled" } };
        }
        if (run && run.unattended) (run.denied ||= []).push(toolTitle);
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
      // 复用前先停掉空闲期后台命令补唤醒监听器并冲刷已收到的后台唤醒回报（不重挂监听器），确保顺序不交叉
      try { hit.clearBgWatch?.(); } catch {}
      try { hit.flushIdle?.(true); } catch {}
      poolEntry = hit;
      reused = true;
      if (poolEntry.idleTimer) { clearTimeout(poolEntry.idleTimer); poolEntry.idleTimer = null; }
      poolEntry.busy = true;
      if (poolEntry.knownChildKeys?.size) knownChildKeys = new Set(poolEntry.knownChildKeys);
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
      if (poolEntry.reportedAgentConvs) state.reportedAgentConvs = poolEntry.reportedAgentConvs;
      syncBg();
      poolEntry.client.setHandlers(makeHandlers());
    } else if (hit && !hit.busy) {
      closeAcpSession(activeSessionId);
    }
  }

  let client = reused ? poolEntry.client : null;
  clientRef = client;

  const destroyClient = () => {
    if (!client) return;
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

  // MIG-7 + C-02：agent 实际在跑的权限模式（appliedPermMode）。setPermMode 同步更新空闲池 permMode 时
  // 不改 appliedPermMode，从而下次复用若两者不符会自动 applyMode。
  let effectivePermMode = poolEntry?.appliedPermMode || poolEntry?.permMode || "default";
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
    const parentPid = clientRef?.child?.pid;
    const killShellItem = (item) => {
      if (item && (item.type === "shell" || item.type === "daemon") && typeof item.childKey === "string" && item.childKey.length > 0) {
        try { killBgChildTree(parentPid, item.childKey); } catch {}
      }
    };
    if (tid) {
      const sid = String(tid);
      const item = bgTasks.get(sid) || poolEntry?.bgTasks?.get(sid);
      killShellItem(item);
      const rec = state.acpAgents?.get(sid);
      if (rec && rec.status === "running" && (!item || item.type === "agent" || item.type === "workflow")) {
        rec.status = "stopped";
        if (rec.convId) state.reportedAgentConvs?.delete(rec.convId.toLowerCase());
        emit({ type: "ag", k: "done", id: rec.id, status: "stopped", why: "已停止", at: Date.now() });
      }
      if (removeBgTaskAndDependents(turnScope, bgTasks, sid)) removed = true;
      if (poolEntry?.bgTasks && removeBgTaskAndDependents(poolScope, poolEntry.bgTasks, sid)) removed = true;
    } else {
      for (const item of bgTasks.values()) killShellItem(item);
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

  let turnPersisted = false;
  let activeBgTimer = null;
  const clearActiveBgWatch = () => {
    if (activeBgTimer) { clearInterval(activeBgTimer); activeBgTimer = null; }
  };
  const persistInterruptedTurn = (reasonMsg) => {
    if (turnPersisted || !activeSessionId || !state.promptSent) return;
    turnPersisted = true;
    for (const tool of state.tools.values()) {
      if (!tool.done) {
        if (run?.aborted) {
          tool.cancelled = true;
          tool.isError = false;
        } else {
          tool.isError = true;
        }
        if (!tool.output) tool.output = run?.aborted ? "（已中断）" : `（回合异常中断：${reasonMsg}）`;
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
  };

  if (run) {
    run.child = client ? client.child : null;
    run.preSpawn = !client;
    run.dropAcpBg = dropActiveBg;
    // 停止只停当前 prompt，不销毁保活进程：进程留在池里供下轮复用（B10）。
    // W3-F2：冷启动握手期间（!state.promptSent && !reused）尚无可用 prompt 可 cancel，立刻 destroyClient 让在途握手 RPC 立即失败收尾。
    // 若 prompt 已发但 agent 10s 内不响应 session/cancel，queue.forceEnd 会调用 forceFinish 同步落盘并彻底销毁卡死客户端，防双进程脑裂与落盘交错（C-02 + S-3/P2-6）。
    run.cancelAcp = () => {
      if (!state.promptSent && !reused) {
        canKeep = false;
        destroyClient();
        return;
      }
      if (activeSessionId && client) client.notify("session/cancel", { sessionId: activeSessionId });
    };
    run.forceFinish = () => {
      try { persistInterruptedTurn("forced stop"); } catch {}
      canKeep = false;
      destroyClient();
    };
    // set_mode 被 agent 拒绝时返回 false 并发 error 事件，不再静默返回 true（B11）。
    // 被拒时 applyMode 会把模式纠回被拒前的实际值并再发 perm_mode 事件（MIG-7）。
    // W3-F1：本地保留用户所选模式，发往服务端时经 serverModeOf 钳制，防止绕过 disallowedTools。
    run.setMode = (mode) => {
      permMode = mode;
      state.permMode = mode;
      run.permMode = mode;
      if (activeSessionId && client && !client.closed) return applyMode(serverModeOf(mode));
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
      const coldInit = async () => {
        if (typeof syncSettings === "function") await syncSettings();
        if (run?.aborted) throw new Error("aborted before spawn");
        client = createAcpClient({
          bin,
          args,
          cwd,
          env,
          ...makeHandlers(),
        });
        clientRef = client;
        if (run) {
          run.child = client.child;
          run.preSpawn = false;
        }
        // 1. initialize
        const initRes = await client.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "hachimia", version: "0.1.0" },
        }, 30000);
        if (initRes?.agentInfo?.version) {
          setLastInit({ version: String(initRes.agentInfo.version) });
        }
        if (run?.aborted) throw new Error("aborted");

        // 2. authenticate（若 agent 声明了 authMethods 且我们指定了认证方式）
        const authMethods = Array.isArray(initRes?.authMethods) ? initRes.authMethods : [];
        const isVendorApiKey = typeof authType === "string" && authType !== "gemini-api-key" && /-api-key$/.test(authType);
        if (isVendorApiKey) log(`[agy-acp] ${authType}：非 ACP 官方认证方法，跳过 authenticate（agy 无通用第三方 bearer 通道，见 rem-C2；仅 protocol:"gemini" 的厂商经 agyEnv/settings 交 key）`);
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
            if (/already (authenticated|authorized|logged in|signed in)|authentication (not required|not needed)/i.test(e.message || "")) {
              log(`[agy-acp] authenticate(${authType})：已认证过，继续`);
            } else {
              throw new Error(`[agy-acp] authenticate(${authType}) 失败：${e.message}`);
            }
          }
        }

        if (run?.aborted) throw new Error("aborted");
        // 3. 优先 session/resume（无历史重放），其次回落 session/load，最后 session/new
        const caps = initRes?.agentCapabilities || {};
        const canResume = !!(caps.sessionCapabilities?.resume || caps.session_capabilities?.resume);
        const canLoad = !!(caps.loadSession || caps.load_session || caps.sessionCapabilities?.load || caps.session_capabilities?.load);
        const extraDirs = Array.isArray(addDirs) ? addDirs.filter((d) => typeof d === "string" && d.trim()) : [];
        const canAddDirs = !!(caps.sessionCapabilities?.additionalDirectories || caps.session_capabilities?.additionalDirectories);
        const extraDirParam = canAddDirs && extraDirs.length ? { additionalDirectories: extraDirs } : {};
        let sessRes = null;
        let resumeErr = null;
        let loadErr = null;
        if (requestedSessionId && canResume) {
          try {
            sessRes = await client.request("session/resume", {
              sessionId: requestedSessionId,
              cwd,
              mcpServers,
              ...extraDirParam,
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
              ...extraDirParam,
            }, 90000);
            usedLoad = true;
          } catch (e) {
            loadErr = e;
            log(`[agy-acp] session/load 失败（保留原会话号不静默新建）: ${e.message}`);
          }
        }
        if (!sessRes && requestedSessionId && (canResume || canLoad)) {
          const why = loadErr?.message || resumeErr?.message || "恢复会话失败";
          throw new Error(tz("无法恢复原会话（{why}），已保留当前会话未新建，请重试或手动开启新对话", { why }));
        }
        if (!sessRes) {
          sessRes = await client.request("session/new", {
            cwd,
            mcpServers,
            ...extraDirParam,
          }, 30000);
          if (!sessRes?.sessionId) throw new Error(tz("新建会话失败：Agent 没有返回会话号，请重试"));
          activeSessionId = sessRes.sessionId;
        }
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
      };
      if (typeof syncSettings === "function") await withAgySettingsLock(coldInit);
      else await coldInit();
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
    const wantServerMode = serverModeOf(permMode);
    if (wantServerMode && (!reused || effectivePermMode !== wantServerMode)) {
      // MIG-7 + C-02 + W3-F1 + S-2：服务端模式经 serverModeOf 钳制；restrictMode 下收紧失败必须 fail-closed 中止本轮
      const modeOk = await applyMode(wantServerMode);
      if (restrictMode && !modeOk) {
        canKeep = false;
        destroyClient();
        throw new Error("failed to restrict server permission mode for disallowedTools");
      }
    }

    // 若走的是 session/load 回落路径，排空异步重放再开闸（B3）：
    // 以前只在「load 返回时已经见过重放」才等，重放在 load 返回后才开始到时不等直接发 prompt，
    // 重放随后到达即混进本轮。现在 load 后必等：至少等 600ms 让迟到重放落地，
    // 期间有重放就按 200ms 静默期顺延，最多等 1500ms，避免长会话每次续跑都拖太久。
    if (usedLoad) {
      const drainStart = Date.now();
      const waitEnd = drainStart + 1500;
      while (Date.now() < waitEnd) {
        if (run?.aborted) throw new Error("aborted");
        const quietMs = Date.now() - state.replaySeenAt;
        if (Date.now() - drainStart >= 600 && quietMs >= 200) break;
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    if (run?.aborted) throw new Error("aborted");
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
    let lastBgProgressAt = 0;
    const effIdleMs = idleTimeoutMs > 0 ? idleTimeoutMs : ACP_DEFAULT_PROMPT_TIMEOUT_MS;
    const bgExtendWindowMs = Math.min(5 * 60e3, Math.max(effIdleMs * 2, 1000));
    const promptTimeoutCfg = timeoutMs > 0
      ? { timeoutMs }
      : {
          idleTimeoutMs: effIdleMs,
          maxTotalMs: ACP_MAX_PROMPT_TIMEOUT_MS,
          shouldExtend: () => {
            if (pendingPermCount > 0 || run?.perms?.size > 0) return true;
            const now = Date.now();
            if (bgTasks.size > 0) {
              for (const t of bgTasks.values()) {
                if (t?.oneShot && t.expiresAt > now) return true;
              }
              if (lastBgProgressAt > 0 && now - lastBgProgressAt < bgExtendWindowMs) return true;
            }
            return false;
          },
        };
    // 新建常驻 agy 进程在发首轮 session/prompt 前拍一次基线快照：
    // 将此时已存在的内部/stdio MCP 直接子进程全部记入 knownChildKeys 与 daemonChildKeys，避免后续误归属给后台 shell 任务
    if (!reused) {
      const baseKids = listAcpChildren(client.child?.pid);
      if (baseKids) {
        for (const c of baseKids) {
          knownChildKeys.add(c.key);
          daemonChildKeys.add(c.key);
        }
      }
    }
    // 在途后台任务实时观测器（解决 agy acp 1.5.13 后台化 run_command 不发 completed/content、外层 session/prompt 挂起期间前端无反馈与 30 分钟误杀）：
    // 1) 对比本轮开始前的 tasks/ 快照，发现新落盘的 task-<N>.log 并绑定到未决 run_command/run_workflow 工具卡，立刻挂入 bgTasks；
    // 2) 轻量 stat 跟踪任务日志与子代理 transcript.jsonl 体积/活跃度，仅在字节增长时按尾部 4KB 推给 tool_update 与 phase: "bg"；
    // 3) 有真实日志/子代理进展时刷新 lastBgProgressAt 供 shouldExtend 续期，纯假死不续期；
    // 4) 若已归属的在途非 daemon shell 子进程全部退出且静默超 inflightStallWarnMs，提示用户避免干等 30 分钟。
    const turnStartMs = Date.now();
    const preTurnLogs = new Map();
    for (const l of scanAcpTaskLogs(activeSessionId, brainDir, 0)) {
      preTurnLogs.set(l.shortId, { size: l.size, mtimeMs: l.mtimeMs });
    }
    let lastBgSyncAt = 0;
    let lastBgPhaseKey = "";
    let inflightGoneSince = 0;
    let stallWarned = false;
    state.lastRpcAt = turnStartMs;
    const pollActiveBg = () => {
      if (!state.promptSent || !activeSessionId || !client || client.closed) { clearActiveBgWatch(); return; }
      const pendingTools = [...state.tools.values()].filter((t) => !t.done);
      if (!pendingTools.length && !bgTasks.size && !(state.acpAgents?.size > 0)) return;
      const now = Date.now();
      let bgMetaChanged = false;
      let forceSync = false;

      // 1) 探测静默后台化的 run_command / run_workflow（agy 写了 task-<N>.log 却未发 tool_call_update）
      const unboundTools = pendingTools.filter((t) => {
        if (t.bgTaskId) return false;
        const k = classifyAcpTool(t.name, t.input, t.output);
        return k === "run_command" || k === "run_workflow";
      });
      if (unboundTools.length) {
        const logs = scanAcpTaskLogs(activeSessionId, brainDir, turnStartMs);
        const boundIds = new Set([...bgTasks.keys(), ...[...state.tools.values()].map((t) => t.bgTaskId).filter(Boolean)]);
        const freshLogs = logs.filter((l) => {
          if (boundIds.has(l.fullId) || boundIds.has(l.shortId)) return false;
          const pre = preTurnLogs.get(l.shortId);
          return !pre || pre.size !== l.size || pre.mtimeMs !== l.mtimeMs;
        });
        const totalToolsCount = state.tools.size;
        for (const l of freshLogs) {
          const cand = unboundTools.find((t) => {
            if (t.bgTaskId) return false;
            const age = now - (t.startedAt || turnStartMs);
            const hasLaterActivity = (state.lastOutputAt && state.lastOutputAt >= (t.startedAt || 0))
              || totalToolsCount > 1;
            const waitMs = Number(t.input?.WaitMsBeforeAsync);
            const threshold = Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, 10000) : 10000;
            return age >= Math.min(threshold, 1000) || hasLaterActivity;
          }) || unboundTools.find((t) => !t.bgTaskId);
          if (!cand) break;
          const k = classifyAcpTool(cand.name, cand.input, cand.output);
          const inp = cand.input && typeof cand.input === "object" ? cand.input : {};
          const titleCmd = String(cand.name || "").replace(/^run\s+/i, "").trim();
          const desc = String(
            inp.toolSummary || inp.description || inp.CommandLine
            || (titleCmd && titleCmd.toLowerCase() !== "run_command" ? titleCmd : "")
            || l.shortId
          ).trim().slice(0, 80);
          cand.bgTaskId = l.fullId;
          cand.logPath = l.logPath;
          cand.status = "background";
          state.onBgAdd({
            id: l.fullId,
            type: inp.IsDaemon ? "daemon" : (k === "run_workflow" ? "workflow" : "shell"),
            desc,
            toolId: cand.id,
            logPath: l.logPath,
            startedAt: cand.startedAt || now,
            lastActiveAt: l.mtimeMs || now,
            bytes: l.size,
          });
          lastBgProgressAt = now;
          forceSync = true;
        }
      }

      // 2) 刷新已登记后台任务的日志体积 / 活跃度与关联工具卡尾部输出
      for (const item of bgTasks.values()) {
        if (!item) continue;
        let lp = item.logPath || null;
        if (!lp && (item.type === "shell" || item.type === "daemon" || item.type === "workflow")) {
          const shortId = String(item.id || "").split("/").pop();
          if (/^task-\d+$/.test(shortId) && brainDir) {
            lp = path.join(brainDir, String(activeSessionId), ".system_generated", "tasks", `${shortId}.log`);
          }
        }
        if (!lp && item.type === "agent") {
          const rec = state.acpAgents?.get(item.id);
          if (rec?.status === "running") {
            lp = rec.logPath || (rec.convId && UUID_EXACT_RE.test(rec.convId) && brainDir
              ? path.join(brainDir, rec.convId, ".system_generated", "logs", "transcript.jsonl")
              : null);
          }
        }
        if (!lp) continue;
        let st = null;
        try { st = fs.statSync(lp); } catch {}
        if (!st || !st.isFile()) continue;
        item.logPath = lp;
        const grew = st.size > (Number(item.bytes) || 0) || st.mtimeMs > (Number(item.lastActiveAt) || 0) + 500;
        if (grew) {
          if (Math.abs(st.size - (Number(item.bytes) || 0)) >= 4096 || item.bytes == null) forceSync = true;
          item.bytes = st.size;
          item.lastActiveAt = Math.max(Number(item.lastActiveAt) || 0, st.mtimeMs);
          lastBgProgressAt = now;
          bgMetaChanged = true;
        }
        if (item.toolId) {
          const tool = state.tools.get(item.toolId);
          if (tool && !tool.done && (grew || tool._lastTailBytes == null)) {
            const tail = readTaskLogTail(lp, 4096);
            tool._lastTailBytes = st.size;
            tool.status = "background";
            emit({
              type: "tool_update",
              id: tool.id,
              name: tool.name,
              input: tool.input,
              status: "background",
              bgTaskId: item.id,
              bytes: st.size,
              lastActiveAt: item.lastActiveAt,
              ...(tail ? { output: tail } : {}),
            });
          }
        }
      }

      if (bgMetaChanged && (forceSync || now - lastBgSyncAt >= 4000)) {
        lastBgSyncAt = now;
        syncBg();
      }

      // 3) 推送前端 phase: "bg"（模型已暂停吐字但后台任务仍在运行）
      if (bgTasks.size > 0 && (!state.lastOutputAt || now - state.lastOutputAt >= 1500)) {
        const list = [...bgTasks.values()];
        const totalBytes = list.reduce((acc, x) => acc + (Number(x.bytes) || 0), 0);
        const newestActive = list.reduce((acc, x) => Math.max(acc, Number(x.lastActiveAt) || Number(x.startedAt) || 0), 0);
        const silentBucket = newestActive > 0 && now - newestActive >= 60000 ? Math.floor((now - newestActive) / 60000) : 0;
        const pKeyNow = `${list.length}|${Math.floor(totalBytes / 4096)}|${silentBucket}|${list[0]?.desc || ""}`;
        if (pKeyNow !== lastBgPhaseKey) {
          lastBgPhaseKey = pKeyNow;
          emit({
            type: "phase",
            phase: "bg",
            count: list.length,
            bytes: totalBytes,
            lastActiveAt: newestActive || turnStartMs,
            desc: String(list[0]?.desc || "").slice(0, 80),
          });
        }
      }

      // 4) 在途后台 shell 子进程全退却丢唤醒的早告警（绝不误伤运行中子代理/workflow/未到期定时任务）
      const trackedShells = [...bgTasks.values()].filter((t) => t && t.type === "shell" && typeof t.childKey === "string" && t.childKey.length > 0);
      const hasOtherActiveBg = [...bgTasks.values()].some((t) => t && (t.type === "agent" || t.type === "workflow" || (t.oneShot && t.expiresAt > now)));
      if (trackedShells.length > 0 && !hasOtherActiveBg && inflightStallWarnMs > 0) {
        let probe = null;
        try {
          probe = probeBgShell(client.child?.pid, {
            daemonChildKeys,
            sessionId: activeSessionId,
            tasks: trackedShells,
            brainDir,
            isPidAlive,
          });
        } catch {
          probe = { active: true, reason: "probe-err" };
        }
        if (probe && !probe.active) {
          if (!inflightGoneSince) inflightGoneSince = now;
          const goneMs = now - inflightGoneSince;
          const quietRpc = now - Math.max(state.lastRpcAt || turnStartMs, state.lastOutputAt || 0);
          if (!stallWarned && goneMs >= inflightStallWarnMs && quietRpc >= inflightStallWarnMs) {
            stallWarned = true;
            const dur = goneMs >= 60000 ? `${Math.round(goneMs / 60000)}m` : `${Math.round(goneMs / 1000)}s`;
            log(`[agy-acp] 在途后台 shell 子进程已全部退出但 session/prompt 静默 ${dur}（${activeSessionId.slice(0, 8)}）`);
            emit({
              type: "note",
              key: "acp-bg-stalled",
              text: tz("后台命令子进程已退出，但引擎尚未回报（已静默 {d}）；可点击停止或直接发新消息。", { d: dur }),
            });
          }
        } else {
          inflightGoneSince = 0;
          stallWarned = false;
        }
      } else {
        inflightGoneSince = 0;
      }
    };
    const effActivePollMs = Math.max(50, Number(activeBgPollMs) || 2000);
    activeBgTimer = setInterval(pollActiveBg, effActivePollMs);
    activeBgTimer.unref?.();

    const promptRes = await client.request("session/prompt", {
      sessionId: activeSessionId,
      prompt: contentBlocks,
    }, promptTimeoutCfg);
    clearActiveBgWatch();

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

    // 若有工具在回合结束时还没收到终态 update，补发一次完成结果，避免前端卡片永远卡在「运行中」；
    // 回合因取消结束（stopReason === "cancelled" 或 run.aborted）时标 cancelled 而非红框失败（C-06）。
    const turnCancelled = stopReason === "cancelled" || stopReason === "canceled" || !!run?.aborted;
    for (const tool of state.tools.values()) {
      if (!tool.done) {
        const st = String(tool.status || "").toLowerCase();
        tool.cancelled = turnCancelled || st === "cancelled" || st === "canceled";
        tool.isError = !tool.cancelled && (st === "failed" || st === "error");
        if (tool.cancelled && !tool.output) tool.output = "（已中断）";
        emitToolResult(tool, emit, state);
      }
    }

    const durationMs = Date.now() - t0;

    // 把本轮新工具 ID 记入已见集合，供池内下一轮去重
    for (const tid of state.tools.keys()) state.knownToolIds.add(tid);

    // 持久化到本地 jsonl，供会话列表 / 历史查看 / 搜索 / 导出复用
    // /compact 无正文和工具时不写入空白对话行，仅保留最新上下文用量供重开会话读取；
    // 后台命令补唤醒（auto="bg"）与空闲推送对齐，只落盘助手回复与工具记录、不写合成用户气泡
    if (!turnPersisted) {
      turnPersisted = true;
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
    const detail = client?.stderr ? `\n${client.stderr.slice(-800)}` : "";
    const timedOut = !!(run?.timedOut || err?.code === "ETIMEDOUT" || (timeoutMs > 0 && /timeout|timed out/i.test(msg)));
    if (timedOut && run) run.timedOut = true;
    if (activeSessionId && state.promptSent && client && !client.closed && !run?.aborted) {
      try { client.notify("session/cancel", { sessionId: activeSessionId }); } catch {}
    }
    // 回合中途失败/被取消：提问、已完成工具、思考与已流出的正文都要落盘，别让整轮凭空消失（B5）。
    // 只有 prompt 已发出去才落盘，且与 forceFinish 共享 turnPersisted 互斥防二次写盘（S-3/P2-6）。
    persistInterruptedTurn(msg);
    if (!run?.aborted) {
      log(`[agy-acp] 回合异常中断 (${(activeSessionId || "-").slice(0, 8)}, ${Math.round((Date.now() - t0) / 1000)}s): ${msg}`);
      emit({ type: "error", message: tz("Antigravity CLI 执行出错：{msg}", { msg }) + detail });
    }
    return {
      ok: false,
      failed: !run?.aborted,
      timedOut,
      sessionId: activeSessionId,
      sessionSwitched,
      toolCount: state.tools.size,
      resultText: state.text,
      usage: state.usage,
      error: msg,
      durationMs: Date.now() - t0,
    };
  } finally {
    clearActiveBgWatch();
    clearAllBgExpiryTimers(turnScope);
    if (poolEntry && poolEntry.dropActiveBg === dropActiveBg) poolEntry.dropActiveBg = null;
    if (run) {
      run.child = null;
      run.cancelAcp = null;
      run.dropAcpBg = null;
      run.forceFinish = null;
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
      entry.appliedPermMode = effectivePermMode;
      entry.disallowedTools = Array.isArray(disallowedTools) ? [...disallowedTools] : [];
      entry.knownToolIds = state.knownToolIds;
      entry.lastUsage = state.usage || entry.lastUsage || null;
      entry.lastContextTokens = Number(state.usage?.context_tokens) || entry.lastContextTokens || 0;
      entry.bgTasks = bgTasks;
      const emitPoolBg = () => {
        pruneExpiredBgTasks(poolScope, entry.bgTasks);
        const list = [...entry.bgTasks.values()];
        if (run && !run.ended) {
          run.bgList = list;
          run.bgTasks = list.length;
        }
        onBgChange?.(list);
      };
      clearAllBgExpiryTimers(poolScope);
      for (const item of entry.bgTasks.values()) {
        armBgExpiryTimer(poolScope, entry.bgTasks, item, emitPoolBg);
      }
      entry.acpAgents = state.acpAgents || entry.acpAgents || new Map();
      entry.acpAgentsByConv = state.acpAgentsByConv || entry.acpAgentsByConv || new Map();
      entry.acpAgentDirs = state.acpAgentDirs || entry.acpAgentDirs || new Map();
      entry.reportedAgentConvs = state.reportedAgentConvs || entry.reportedAgentConvs || new Set();
      entry.nudgedBgTasks = entry.nudgedBgTasks || new Set();
      // 同步轮次（含 /compact）结束入池前统一对账已完工的子代理，杜绝幽灵后台条残留（C-09）
      reconcileFinishedSubagents({
        agents: entry.acpAgents,
        bgTasks: entry.bgTasks,
        poolScope,
        sessionId: activeSessionId,
        cwd: entry.cwd,
        agentDirs: entry.acpAgentDirs,
        reportedConvs: entry.reportedAgentConvs,
        runId: run?.id || null,
        onBgChanged: emitPoolBg,
        brainDir,
      });
      {
        const liveKids = listAcpChildren(entry.client.child?.pid);
        if (liveKids) {
          const liveKeys = new Set(liveKids.map((c) => c.key));
          for (const k of [...knownChildKeys]) if (!liveKeys.has(k)) knownChildKeys.delete(k);
          for (const k of [...daemonChildKeys]) if (!liveKeys.has(k)) daemonChildKeys.delete(k);
        }
      }
      entry.knownChildKeys = knownChildKeys;
      entry.daemonChildKeys = daemonChildKeys;
      entry.idleRun = null;
      entry.idleBurstActive = false;
      entry.busy = false;
      entry.lastUsed = Date.now();

      // 空闲期间非常驻后台 shell 任务（type==="shell"）的补唤醒监听：
      // 仅针对 agy acp 1.5.13 偶尔丢失 run_command 后台任务完成唤醒的缺陷；
      // 严格排除 daemon / monitor / agent / workflow 及无归属 shell（childKey === null，fail-closed），
      // 内核确认子进程退出后再经宽限窗静默校验，同一 taskId 至多补唤醒一次，且在 idleBurst / 复用 / 关闭 / 手动停止时立即让路清理。
      let bgWatchTimer = null;
      let shellGoneSince = 0;
      const clearBgWatch = () => {
        if (bgWatchTimer) { clearInterval(bgWatchTimer); bgWatchTimer = null; }
        shellGoneSince = 0;
      };
      entry.clearBgWatch = clearBgWatch;
      const pendingWatchShells = () => [...(entry.bgTasks?.values() || [])].filter(
        (t) => t && t.type === "shell" && typeof t.childKey === "string" && t.childKey.length > 0 && !entry.nudgedBgTasks.has(t.id)
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
              brainDir,
              isPidAlive,
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
      const flushIdle = (noRearm = false) => {
        if (idleFlushTimer) { clearTimeout(idleFlushTimer); idleFlushTimer = null; }
        const b = idleBurst;
        if (!b) return;
        idleBurst = null;
        entry.idleRun = null;
        entry.idleBurstActive = false;
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
        // 如果空闲期间收到了正文回报或确定性完结信号，结算对应的非常驻后台任务 / 一次性定时器 / 子代理：
        // 1) 先经 reconcileFinishedSubagents 按 user_message sender + transcript.jsonl 尾帧确定性对账子代理（C-09）；
        // 2) 一次性 schedule 只在临近到期、TimerCondition="any"、或回报正文点名了自身/目标条件时摘除；
        // 3) nonDaemon 仅含后台 shell / 子代理 / workflow（排除 monitor），仅 1 个时直接结算，多个时按 token（含唯一 8 位短 ID）匹配结算。
        if (entry.bgTasks?.size || entry.acpAgents?.size) {
          const now = Date.now();
          let bgChanged = pruneExpiredBgTasks(poolScope, entry.bgTasks, now);
          const reconciledSubagents = reconcileFinishedSubagents({
            agents: entry.acpAgents,
            bgTasks: entry.bgTasks,
            poolScope,
            sessionId: activeSessionId,
            cwd: entry.cwd,
            agentDirs: entry.acpAgentDirs,
            reportedConvs: entry.reportedAgentConvs,
            runId: b.runId,
            brainDir,
            now,
          });
          if (reconciledSubagents) bgChanged = true;
          if (b.state.text && entry.bgTasks?.size) {
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
              if (v.type === "agent" || v.type === "workflow") {
                const rec = entry.acpAgents?.get(k);
                if (rec && rec.status === "running") {
                  rec.status = "done";
                  if (rec.convId && entry.reportedAgentConvs) {
                    const cl = rec.convId.toLowerCase();
                    for (const c of [...entry.reportedAgentConvs]) if (String(c).toLowerCase() === cl) entry.reportedAgentConvs.delete(c);
                  }
                  const why = firstLineOf(b.state.text);
                  publish({ type: "ag", runId: b.runId, sessionId: activeSessionId, k: "done", id: k, status: "done", why, at: Date.now() });
                  if (entry.cwd && activeSessionId) {
                    try {
                      acpAgentDone(entry.cwd, activeSessionId, {
                        id: k,
                        dir: entry.acpAgentDirs?.get(k) || null,
                        name: rec.name || "agent",
                        status: "done",
                        why,
                        report: b.state.text || "",
                      });
                    } catch {}
                  }
                }
              }
            };
            // 若本次 idleBurst 已通过确定性证据（user_message / transcript.jsonl）结算了子代理，
            // 则不得再用 nonDaemon.length === 1 盲目兜底摘掉剩余仍在运行的唯一子代理（C-09）
            if (!reconciledSubagents && nonDaemon.length === 1) {
              finishOne(nonDaemon[0][0], nonDaemon[0][1]);
              bgChanged = true;
            } else if (nonDaemon.length > 1) {
              const shortConvCounts = new Map();
              for (const [k] of nonDaemon) {
                const cid = entry.acpAgents?.get(k)?.convId;
                if (cid && cid.length >= 8) {
                  const sc = cid.slice(0, 8).toLowerCase();
                  shortConvCounts.set(sc, (shortConvCounts.get(sc) || 0) + 1);
                }
              }
              const textLower = b.state.text.toLowerCase();
              for (const [k, v] of nonDaemon) {
                const rec = entry.acpAgents?.get(k);
                const shortK = String(k).includes("/") ? String(k).split("/").pop() : null;
                const shortConv = rec?.convId && rec.convId.length >= 8 && shortConvCounts.get(rec.convId.slice(0, 8).toLowerCase()) === 1
                  ? rec.convId.slice(0, 8)
                  : null;
                const tokens = [k, shortK, rec?.convId, shortConv, rec?.name, v.desc].filter((x) => x && String(x).length >= 4);
                if (tokens.some((tok) => b.state.text.includes(String(tok)) || (tok === shortConv && textLower.includes(shortConv.toLowerCase())))) {
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
        if (!noRearm && ACP_POOL.get(activeSessionId) === entry && !entry.busy && !entry.client.closed) {
          armBgShellWatch();
        }
        // 通知队列泵出因 idleBurst 互斥而等待的新消息（C-02）
        setImmediate(() => notifyIdleSettled(activeSessionId));
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
        onClose: () => { try { clearBgWatch(); } catch {} try { flushIdle(true); } catch {} },
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
          // 空闲期捕获子代理唤醒信封（user_message* 中的 [Message] sender=<uuid>），不回显也不开 burst（C-09 + S-3/P2-5）
          if (kind === "user_message" || kind === "user_message_chunk") {
            entry.lastUsed = Date.now();
            const uText = acpTextOf(upd.content ?? upd.summary ?? upd.text);
            const uOpt = { resetAfter: kind === "user_message", msgId: upd.messageId ? String(upd.messageId) : "" };
            captureSubagentSenders(uText, entry, uOpt);
            if (idleBurst?.state) captureSubagentSenders(uText, idleBurst.state, uOpt);
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
              if (ev.type === "perm_mode") { entry.permMode = ev.mode; entry.appliedPermMode = ev.mode; }
              publish({ ...ev, sessionId: activeSessionId });
            });
            if (st.usage) {
              entry.lastUsage = st.usage;
              entry.lastContextTokens = Number(st.usage.context_tokens) || entry.lastContextTokens || 0;
            }
            return;
          }
          if (!idleBurst && !shouldOpenIdleBurst(kind, upd, entry, IDLE_WAKE_KINDS)) return;
          shellGoneSince = 0;
          entry.lastUsed = Date.now();
          if (!idleBurst) {
            // C13b + R2-01 (P1-N1 / P2-1)：agy 自主推来 idleBurst 时，若待监视的后台 shell 子进程已退出，
            // 同步记入 nudgedBgTasks 并摘除 bgTasks（一死一活仅摘已死的那个，保留活壳；/proc 缺失时经 isPidAlive 复核）
            const watchShells = pendingWatchShells();
            if (watchShells.length) {
              let probe = null;
              try {
                probe = probeBgShell(entry.client.child?.pid, {
                  daemonChildKeys: entry.daemonChildKeys,
                  sessionId: activeSessionId,
                  tasks: watchShells,
                  logSettleMs: 0,
                  brainDir,
                  isPidAlive,
                });
              } catch {
                probe = { active: true, reason: "probe-err" };
              }
              let bgPruned = false;
              if (probe && !probe.active) {
                for (const t of watchShells) {
                  entry.nudgedBgTasks.add(t.id);
                  if (removeBgTaskAndDependents(poolScope, entry.bgTasks, t.id)) bgPruned = true;
                }
              } else {
                const liveNow = listAcpChildren(entry.client.child?.pid);
                if (liveNow) {
                  const liveKeys = new Set(liveNow.map((c) => c.key));
                  for (const t of watchShells) {
                    if (!t.childKey || liveKeys.has(t.childKey)) continue;
                    if (isChildKeyAliveFallback(t.childKey, "/proc", isPidAlive)) continue;
                    entry.nudgedBgTasks.add(t.id);
                    if (removeBgTaskAndDependents(poolScope, entry.bgTasks, t.id)) bgPruned = true;
                  }
                }
              }
              if (bgPruned) emitPoolBg();
              while (entry.nudgedBgTasks.size > 500) entry.nudgedBgTasks.delete(entry.nudgedBgTasks.values().next().value);
            }
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
              reportedAgentConvs: entry.reportedAgentConvs,
              onBgAdd: (t) => {
                if (!t || !t.id) return;
                const nowAt = Date.now();
                const prev = entry.bgTasks.get(String(t.id));
                const item = {
                  id: String(t.id),
                  type: t.type || prev?.type || "shell",
                  desc: String(t.desc || prev?.desc || t.id),
                  startedAt: Number(t.startedAt) || prev?.startedAt || nowAt,
                  lastActiveAt: Number(t.lastActiveAt) || prev?.lastActiveAt || nowAt,
                  ...(Number.isFinite(Number(t.bytes)) && Number(t.bytes) >= 0 ? { bytes: Number(t.bytes) } : (prev?.bytes != null ? { bytes: prev.bytes } : {})),
                  ...(t.logPath ? { logPath: String(t.logPath) } : (prev?.logPath ? { logPath: prev.logPath } : {})),
                  ...(t.toolId ? { toolId: String(t.toolId) } : (prev?.toolId ? { toolId: prev.toolId } : {})),
                  ...(t.oneShot ? { oneShot: true, expiresAt: Number(t.expiresAt) || 0, timerCondition: String(t.timerCondition || "never") } : {}),
                };
                if (prev && prev.type === item.type && prev.childKey !== undefined) {
                  item.childKey = prev.childKey;
                } else if (item.type === "shell" || item.type === "daemon") {
                  attributeBgTaskChild(item);
                }
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
                  const isTaskWorkflow = v.type === "workflow" && /(?:^|\/)task-\d+$/.test(String(k));
                  if ((v.type !== "agent" && v.type !== "workflow") || isTaskWorkflow) {
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
            entry.idleBurstActive = true;
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
        // 空闲期间若有后台任务/子代理发起权限请求：先查 disallowedTools（W3-F1），再在 bypassPermissions 下自动放行，否则优雅取消，不再抛 -32603
        onRequest: async (method, params) => {
          if (method === "session/request_permission") {
            const options = Array.isArray(params?.options) ? params.options : [];
            const allowOpt = pickAcpAllowOption(options);
            const rejectOpt = options.find(isAcpRejectOpt);
            const toolTitle = params?.toolCall?.title || params?.toolCall?.name || params?.toolCall?.kind || "Antigravity Tool";
            const toolRaw = params?.toolCall?.name || "";
            const toolKind = params?.toolCall?.kind || "";
            if (isAcpToolDisallowed(toolTitle, toolKind, entry.disallowedTools) || (toolRaw && isAcpToolDisallowed(toolRaw, toolKind, entry.disallowedTools))) {
              return rejectOpt
                ? { outcome: { outcome: "selected", optionId: rejectOpt.optionId } }
                : { outcome: { outcome: "cancelled" } };
            }
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
            // 先对账已完工的子代理，避免幽灵子代理永久拖住空闲回收（C-09）
            let gcBgChanged = false;
            if (entry.bgTasks?.size > 0 && pruneExpiredBgTasks(poolScope, entry.bgTasks)) gcBgChanged = true;
            if (reconcileFinishedSubagents({
              agents: entry.acpAgents,
              bgTasks: entry.bgTasks,
              poolScope,
              sessionId: activeSessionId,
              cwd: entry.cwd,
              agentDirs: entry.acpAgentDirs,
              reportedConvs: entry.reportedAgentConvs,
              brainDir,
            })) gcBgChanged = true;
            if (gcBgChanged) onBgChange?.([...entry.bgTasks.values()]);
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
