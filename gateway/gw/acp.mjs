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
import { setLastInit } from "./caps.mjs";

export const ACP_PROTOCOL_VERSION = 1;
const ACP_IDLE_TTL_MS = Number(process.env.CCAPP_ACP_IDLE_MS) > 0 ? Number(process.env.CCAPP_ACP_IDLE_MS) : 10 * 60e3;
const TOOL_OUT_MAX = 20000;

// 按 sessionId 保活的常驻 ACP 客户端池：同一会话同配置直接复用进程，避免每轮重启 agy
const ACP_POOL = new Map();

/** 销毁池中某个会话的常驻 ACP 进程 */
export function closeAcpSession(sessionId) {
  const entry = sessionId && ACP_POOL.get(sessionId);
  if (!entry) return;
  ACP_POOL.delete(sessionId);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  try { entry.client.close(); } catch {}
  try { entry.client.child?.kill?.("SIGTERM"); } catch {}
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

/** 合并工具输出：兼容增量追加与全量覆盖两种更新方式 */
function mergeToolOutput(prev, next) {
  if (!next) return prev || "";
  if (!prev) return next;
  if (next === prev || prev.endsWith(next)) return prev;
  if (next.startsWith(prev)) return next;
  return prev + (prev.endsWith("\n") ? "" : "\n") + next;
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

/** 解析 ACP 用量对象（兼容 usage_update 通知与 session/prompt 终态 usage） */
function extractAcpUsage(u, prev = null) {
  if (!u || typeof u !== "object") return prev;
  const inp = Number(u.inputTokens ?? u.promptTokens ?? u.input_tokens ?? 0) || 0;
  const cached = Number(u.cachedReadTokens ?? u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0) || 0;
  const out = Number(u.outputTokens ?? u.completionTokens ?? u.output_tokens ?? 0) || 0;
  const total = Number(u.totalTokens ?? u.total_tokens ?? 0) || 0;
  const used = Number(u.used ?? u.contextTokens ?? u.context_tokens ?? 0) || 0;
  const ctx = used || (inp + cached > 0 ? inp + cached : (total > out ? total - out : 0));
  if (ctx <= 0 && out <= 0 && inp <= 0) return prev;
  return {
    input_tokens: inp || prev?.input_tokens || 0,
    ...(cached > 0 ? { cache_read_input_tokens: cached } : (prev?.cache_read_input_tokens ? { cache_read_input_tokens: prev.cache_read_input_tokens } : {})),
    output_tokens: out || prev?.output_tokens || 0,
    context_tokens: ctx || prev?.context_tokens || 0,
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
export function createAcpClient({ bin, args = ["acp"], cwd, env, onNotification, onRequest, onStderr }) {
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const handlers = { onNotification, onRequest, onStderr };
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

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch {
      log(`[acp] 非 JSON stdout 行: ${t.slice(0, 160)}`);
      return;
    }
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
      Promise.resolve()
        .then(() => (handlers.onRequest ? handlers.onRequest(msg.method, msg.params || {}) : Promise.reject(new Error(`Unsupported client method: ${msg.method}`))))
        .then((result) => writeMsg({ jsonrpc: "2.0", id: msg.id, result }))
        .catch((err) => writeMsg({ jsonrpc: "2.0", id: msg.id, error: { code: err?.code || -32603, message: String(err?.message || err) } }));
      return;
    }
    // 3. Agent 通知（如 session/update）
    if (typeof msg.method === "string") {
      try { handlers.onNotification?.(msg.method, msg.params || {}); } catch (e) { log(`[acp] 通知处理异常: ${e.message}`); }
    }
  });

  child.on("error", (err) => {
    closed = true;
    rejectAll(err);
  });
  child.on("close", (code, signal) => {
    closed = true;
    rl.close();
    rejectAll(new Error(signal ? `agy acp terminated by ${signal}` : `agy acp exited with code ${code}`));
  });

  function writeMsg(obj) {
    if (closed || !child.stdin.writable) return false;
    try {
      child.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch { return false; }
  }

  function request(method, params = {}, timeoutMs = 120000) {
    if (closed) return Promise.reject(new Error("ACP process already closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP request timeout: ${method}`));
      }, timeoutMs) : null;
      if (timer) timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      if (!writeMsg({ jsonrpc: "2.0", id, method, params })) {
        if (timer) clearTimeout(timer);
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

/** 构造发往前端的 tool_result 事件（遵循前端 ok/text 契约，并保留 content/is_error 兼容字段） */
function emitToolResult(tool, emit) {
  const full = String(tool.output || "");
  const clipped = full.length > TOOL_OUT_MAX ? full.slice(0, TOOL_OUT_MAX) + "\n\n…（已截断）" : full;
  const isErr = !!tool.isError;
  tool.done = true;
  emit({
    type: "tool_result",
    id: tool.id,
    ok: !isErr,
    text: clipped,
    content: clipped,
    is_error: isErr,
  });
}

/**
 * 将 ACP `session/update` 通知翻译为 hachimia 前端 SSE 事件并累积本轮状态。
 */
export function translateAcpUpdate(params, state, emit) {
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
  // 同时把重放期间见过的 toolCallId 记入 knownToolIds，防止异步拖尾更新串进下一轮
  if (state.promptSent === false) {
    state.replaySeenAt = Date.now();
    if (kind === "tool_call" || kind === "tool_call_update") {
      const tid = String(upd.toolCallId || upd.id || "");
      if (tid) state.knownToolIds?.add(tid);
    }
    return;
  }

  if (kind === "agent_message_chunk" || kind === "text_delta") {
    const text = acpTextOf(upd.content ?? upd.summary ?? upd.text);
    if (text) {
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
    if (text && !state.text) {
      state.text = text;
      emit({ type: "text_delta", text });
    }
    return;
  }

  if (kind === "agent_thought_chunk" || kind === "thinking_delta") {
    const text = acpTextOf(upd.content ?? upd.summary ?? upd.text);
    if (text) {
      state.thinking += text;
      emit({ type: "thinking_delta", text });
    }
    return;
  }
  if (kind === "agent_thought") {
    const text = acpTextOf(upd.content ?? upd.summary ?? upd.text);
    if (text && !state.thinking) {
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
      if (upd.title || upd.name) existing.name = name;
      if (Object.keys(input).length) existing.input = { ...existing.input, ...input };
      if (upd.status) existing.status = upd.status;
      return;
    }
    const rec = { id, name, input, status: upd.status || "pending", output: "", isError: false, done: false };
    state.tools.set(id, rec);
    emit({ type: "tool_use", id, name, input });
    // 部分实现会在 tool_call 上直接带终态
    const st0 = String(upd.status || "").toLowerCase();
    if (st0 === "completed" || st0 === "failed" || st0 === "error" || st0 === "cancelled" || st0 === "canceled") {
      const out0 = acpTextOf(upd.content ?? upd.rawOutput ?? upd.output);
      if (out0) rec.output = mergeToolOutput(rec.output, out0);
      rec.isError = st0 !== "completed";
      emitToolResult(rec, emit);
    }
    return;
  }

  if (kind === "tool_call_update") {
    const id = String(upd.toolCallId || upd.id || "");
    if (!id) return;
    if (state.knownToolIds?.has(id) && !state.tools.has(id)) return;
    let prev = state.tools.get(id);
    if (!prev) {
      const name = String(upd.title || upd.name || upd.kind || "Tool");
      const input = upd.rawInput && typeof upd.rawInput === "object"
        ? upd.rawInput
        : (upd.input && typeof upd.input === "object" ? upd.input : {});
      prev = { id, name, input, status: upd.status || "in_progress", output: "", isError: false, done: false };
      state.tools.set(id, prev);
      emit({ type: "tool_use", id, name, input });
    } else {
      if (upd.title || upd.name) prev.name = String(upd.title || upd.name);
      if (upd.rawInput && typeof upd.rawInput === "object" && Object.keys(upd.rawInput).length) {
        prev.input = { ...prev.input, ...upd.rawInput };
      }
    }
    if (upd.status) prev.status = upd.status;
    const out = acpTextOf(upd.content ?? upd.rawOutput ?? upd.output);
    if (out) prev.output = mergeToolOutput(prev.output, out);
    const st = String(upd.status || "").toLowerCase();
    const terminal = st === "completed" || st === "failed" || st === "error" || st === "cancelled" || st === "canceled";
    if (terminal) {
      prev.isError = st !== "completed";
      emitToolResult(prev, emit);
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
    const nextUsage = extractAcpUsage(upd.usage || upd, state.usage);
    if (nextUsage && (nextUsage.context_tokens > 0 || nextUsage.output_tokens > 0)) {
      state.usage = nextUsage;
      emit({ type: "usage", contextTokens: state.usage.context_tokens, outputTokens: state.usage.output_tokens });
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

  // 已知但有意忽略的种类（不回显、不影响本轮正文），之外的记进日志：
  // 真机上 agy 发来新种类时，日志里能直接看到名字，不用再猜
  const IGNORED = new Set(["user_message", "user_message_chunk", "config_option_update", "session_info_update", "notice", "compaction_update", "compaction_summary_chunk", "permission_confirmation"]);
  if (!IGNORED.has(kind)) log(`[agy-acp] 未识别的 update 种类：${kind}`);
}

/**
 * 将一次 ACP 对话回合持久化到本地 jsonl，兼容 sessions.mjs / transcript.mjs。
 * 有工具调用时按标准 transcript 结构把 tool_use 与 tool_result 分行落盘，
 * 使历史重载能完整还原每个工具的完成/失败状态与输出正文。
 */
export function persistAcpTurn({ cwd, sessionId, userText, assistantText, thinking, tools, model, usage }) {
  if (!sessionId) return;
  const file = acpSessionFile(cwd, sessionId);
  const now = new Date().toISOString();
  const userUuid = crypto.randomUUID();
  const list = Array.isArray(tools) ? tools : [];

  appendJsonl(file, {
    type: "user",
    uuid: userUuid,
    parentUuid: null,
    sessionId,
    cwd,
    timestamp: now,
    message: { role: "user", content: userText },
  });

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
  bin, args = ["acp"], cwd, env, prompt, images = [], sessionId = null,
  model = "", effort = "", permMode = "default", authType = "", apiKey = "",
  mcpServers = [], run, emit, askPermission, timeoutMs = 0,
  keepAlive = LIVE && process.env.CCAPP_ACP_KEEPALIVE !== "0",
}) {
  const t0 = Date.now();
  const state = {
    text: "",
    thinking: "",
    tools: new Map(),
    knownToolIds: sessionId ? readKnownToolIds(cwd, sessionId) : new Set(),
    usage: null,
    promptSent: false,
    replaySeenAt: 0,
    permMode,
    sessionId: sessionId || null,
    onCommands: (cmds) => {
      const names = cmds.map((c) => String(c?.name || "").replace(/^\//, "")).filter(Boolean);
      if (names.length) {
        setLastInit({
          slash_commands: names,
          tools: [],
          skills: [],
          agents: [],
          plugins: [],
          mcp_servers: [],
        });
      }
    },
  };
  let activeSessionId = sessionId || null;
  const pKey = poolKey({ bin, args, cwd, authType, apiKey });

  const makeHandlers = () => ({
    onStderr: (s) => {
      const line = s.trim();
      if (line) log(`[agy-acp!] ${line.slice(0, 300)}`);
    },
    onNotification: (method, params) => {
      if (method === "session/update") {
        translateAcpUpdate(params, state, emit);
      }
    },
    onRequest: async (method, params) => {
      if (method === "session/request_permission") {
        const options = Array.isArray(params.options) ? params.options : [];
        const allowOpt = options.find((o) => /allow_once|allow/i.test(o.kind || o.optionId || "")) || options[0];
        const allowAlwaysOpt = options.find((o) => /allow_always/i.test(o.kind || o.optionId || "")) || null;
        const rejectOpt = options.find((o) => /reject_once|reject|deny/i.test(o.kind || o.optionId || ""));

        if (permMode === "bypassPermissions" && allowOpt) {
          return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
        }
        if (!askPermission) {
          return rejectOpt
            ? { outcome: { outcome: "selected", optionId: rejectOpt.optionId } }
            : { outcome: { outcome: "cancelled" } };
        }
        const decision = await askPermission({
          tool: params.toolCall?.title || params.toolCall?.name || params.toolCall?.kind || "Antigravity Tool",
          toolCallId: params.toolCall?.toolCallId || params.toolCall?.id || "",
          input: params.toolCall?.rawInput || params.toolCall?.input || params.toolCall || {},
          options,
          hasAlways: !!allowAlwaysOpt,
        });
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
      poolEntry = hit;
      reused = true;
      if (poolEntry.idleTimer) { clearTimeout(poolEntry.idleTimer); poolEntry.idleTimer = null; }
      poolEntry.busy = true;
      if (poolEntry.knownToolIds) for (const tid of poolEntry.knownToolIds) state.knownToolIds.add(tid);
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

  const destroyClient = () => {
    if (activeSessionId && ACP_POOL.get(activeSessionId)?.client === client) {
      closeAcpSession(activeSessionId);
    } else {
      try { client.close(); } catch {}
    }
  };

  let canKeep = false;
  let sessModels = poolEntry?.models || null;
  let sessModes = poolEntry?.modes || null;
  let sessConfig = poolEntry?.configOptions || null;

  if (run) {
    run.child = client.child;
    run.preSpawn = false;
    run.cancelAcp = () => {
      if (activeSessionId) client.notify("session/cancel", { sessionId: activeSessionId });
      destroyClient();
    };
    run.setMode = (mode) => {
      permMode = mode;
      state.permMode = mode;
      run.permMode = mode;
      if (activeSessionId && !client.closed) {
        const modeId = mapUiModeToAcp(mode, sessModes?.availableModes);
        if (modeId) client.request("session/set_mode", { sessionId: activeSessionId, modeId }, 5000).catch(() => {});
      }
      return true;
    };
  }

  let usedLoad = false;

  try {
    if (!reused) {
      // 1. initialize
      const initRes = await client.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "hachimia", version: "0.1.0" },
      }, 30000);

      // 2. authenticate（若 agent 声明了 authMethods 且我们指定了认证方式）
      const authMethods = Array.isArray(initRes?.authMethods) ? initRes.authMethods : [];
      if (authType && authMethods.some((m) => m.id === authType)) {
        const authParams = { methodId: authType };
        if (authType === "gemini-api-key" && apiKey) {
          authParams._meta = { "api-key": apiKey };
        }
        try {
          await client.request("authenticate", authParams, 20000);
        } catch (e) {
          // 已通过 keyring 或环境变量认证时部分版本可能返回无需重复认证，记录日志后继续
          log(`[agy-acp] authenticate(${authType}): ${e.message}`);
        }
      }

      // 3. 优先 session/resume（无历史重放），其次回落 session/load，最后 session/new
      //    hachimia 自己从本地 jsonl 渲染历史，调 session/load 会在长会话上引发异步重放与提前返回（无限月读）
      const caps = initRes?.agentCapabilities || {};
      const canResume = !!(caps.sessionCapabilities?.resume || caps.session_capabilities?.resume);
      const canLoad = !!(caps.loadSession || caps.load_session || caps.sessionCapabilities?.load || caps.session_capabilities?.load);
      let sessRes = null;
      if (activeSessionId && canResume) {
        try {
          sessRes = await client.request("session/resume", {
            sessionId: activeSessionId,
            cwd,
            mcpServers,
          }, 30000);
        } catch (e) {
          log(`[agy-acp] session/resume 失败，尝试 session/load: ${e.message}`);
        }
      }
      if (!sessRes && activeSessionId && canLoad) {
        try {
          sessRes = await client.request("session/load", {
            sessionId: activeSessionId,
            cwd,
            mcpServers,
          }, 30000);
          usedLoad = true;
        } catch (e) {
          log(`[agy-acp] session/load 失败，改为新建会话: ${e.message}`);
          activeSessionId = null;
        }
      }
      if (!sessRes) {
        sessRes = await client.request("session/new", { cwd, mcpServers }, 30000);
        activeSessionId = sessRes?.sessionId || activeSessionId || crypto.randomUUID();
      }
      sessModels = sessRes?.models || null;
      sessModes = sessRes?.modes || null;
      sessConfig = Array.isArray(sessRes?.configOptions) ? sessRes.configOptions : null;
    }

    state.sessionId = activeSessionId;
    if (run) run.sessionId = activeSessionId;
    const activeModel = model || sessModels?.currentModelId || "antigravity";
    emit({
      type: "init",
      sessionId: activeSessionId,
      model: activeModel,
      permissionMode: permMode,
      tools: [],
      protocol: "acp",
    });

    // 4. 可选：应用模型、思考强度与权限模式（兼容 models.availableModels 与 configOptions）
    if (model && (!reused || poolEntry?.model !== model)) {
      const cfgModelOpts = sessConfig?.find((c) => c.id === "model")?.options;
      const avail = sessModels?.availableModels;
      const okModel = (!Array.isArray(cfgModelOpts) && !Array.isArray(avail))
        || (Array.isArray(cfgModelOpts) && cfgModelOpts.some((o) => o.value === model || o.id === model))
        || (Array.isArray(avail) && avail.some((m) => m.modelId === model || m.id === model));
      if (okModel) {
        await client.request("session/set_config_option", {
          sessionId: activeSessionId,
          configId: "model",
          value: model,
        }, 10000).catch(() => {});
      }
    }
    if (effort && (!reused || poolEntry?.effort !== effort)) {
      const effOpts = sessConfig?.find((c) => c.id === "thought_level")?.options;
      if (Array.isArray(effOpts) && effOpts.some((o) => o.value === effort)) {
        await client.request("session/set_config_option", {
          sessionId: activeSessionId,
          configId: "thought_level",
          value: effort,
        }, 10000).catch(() => {});
      }
    }
    if (permMode && (!reused || poolEntry?.permMode !== permMode)) {
      const modeId = mapUiModeToAcp(permMode, sessModes?.availableModes);
      if (modeId) {
        await client.request("session/set_mode", {
          sessionId: activeSessionId,
          modeId,
        }, 5000).catch(() => {});
      }
    }

    // 若走的是 session/load 回落路径且收到了重放通知，短暂等待尾部异步重放排空再开闸
    if (usedLoad && state.replaySeenAt > 0) {
      const waitEnd = Date.now() + 1200;
      while (Date.now() < waitEnd && Date.now() - state.replaySeenAt < 180) {
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

    emit({ type: "phase", phase: "wait" });
    // 从这里起的事件才算这一轮：之前的都是 agy 重放的历史（见 translateAcpUpdate 的守卫）
    state.promptSent = true;
    state.text = ""; state.thinking = ""; state.tools.clear();
    const promptRes = await client.request("session/prompt", {
      sessionId: activeSessionId,
      prompt: contentBlocks,
    }, timeoutMs > 0 ? timeoutMs : 0);

    // 补采 promptRes.usage（agy 1.5.13 会在终态返回含 cachedReadTokens 的完整用量）
    if (promptRes?.usage) {
      const mergedUsage = extractAcpUsage(promptRes.usage, state.usage);
      if (mergedUsage) {
        state.usage = mergedUsage;
        if (state.usage.context_tokens > 0) {
          emit({ type: "usage", contextTokens: state.usage.context_tokens, outputTokens: state.usage.output_tokens });
        }
        if (state.usage.output_tokens > 0) emit({ type: "run_tokens", out: state.usage.output_tokens });
      }
    }

    // 若有工具在回合结束时还没收到终态 update，补发一次完成结果，避免前端卡片永远卡在「运行中」
    for (const tool of state.tools.values()) {
      if (!tool.done) {
        const st = String(tool.status || "").toLowerCase();
        tool.isError = st === "failed" || st === "error" || st === "cancelled" || st === "canceled";
        emitToolResult(tool, emit);
      }
    }

    const stopReason = promptRes?.stopReason || "end_turn";
    const durationMs = Date.now() - t0;

    // 把本轮新工具 ID 记入已见集合，供池内下一轮去重
    for (const tid of state.tools.keys()) state.knownToolIds.add(tid);

    // 持久化到本地 jsonl，供会话列表 / 历史查看 / 搜索 / 导出复用
    persistAcpTurn({
      cwd,
      sessionId: activeSessionId,
      userText: prompt,
      assistantText: state.text,
      thinking: state.thinking,
      tools: [...state.tools.values()],
      model: activeModel,
      usage: state.usage,
    });

    emit({
      type: "result",
      sessionId: activeSessionId,
      resultText: state.text,
      stopReason,
      durationMs,
      costUsd: 0,
      ...(state.usage ? { usage: state.usage } : {}),
    });

    canKeep = keepAlive && !client.closed && !run?.aborted && !!activeSessionId;

    return {
      ok: true,
      sessionId: activeSessionId,
      resultText: state.text,
      stopReason,
      durationMs,
      usage: state.usage,
      reused,
    };
  } catch (err) {
    const msg = String(err?.message || err);
    const detail = client.stderr ? `\n${client.stderr.slice(-800)}` : "";
    if (!run?.aborted) {
      emit({ type: "error", message: tz("Antigravity CLI 执行出错：{msg}", { msg }) + detail });
    }
    return {
      ok: false,
      failed: !run?.aborted,
      sessionId: activeSessionId,
      error: msg,
      durationMs: Date.now() - t0,
    };
  } finally {
    if (run) {
      run.child = null;
      run.cancelAcp = null;
    }
    if (canKeep) {
      const entry = poolEntry || { client, sessionId: activeSessionId, key: pKey, knownToolIds: new Set() };
      entry.models = sessModels;
      entry.modes = sessModes;
      entry.configOptions = sessConfig;
      entry.model = model;
      entry.effort = effort;
      entry.permMode = permMode;
      entry.knownToolIds = state.knownToolIds;
      entry.busy = false;
      entry.lastUsed = Date.now();
      client.setHandlers({
        onStderr: (s) => { const line = s.trim(); if (line) log(`[agy-acp! idle] ${line.slice(0, 200)}`); },
        // 空闲期间若有后台任务/子代理发起权限请求：bypassPermissions 下自动放行，否则优雅取消，不再抛 -32603
        onRequest: async (method, params) => {
          if (method === "session/request_permission") {
            const options = Array.isArray(params?.options) ? params.options : [];
            const allowOpt = options.find((o) => /allow_once|allow/i.test(o.kind || o.optionId || "")) || options[0];
            if (entry.permMode === "bypassPermissions" && allowOpt) {
              return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
            }
            return { outcome: { outcome: "cancelled" } };
          }
          throw new Error(`Unsupported idle ACP callback: ${method}`);
        },
      });
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        if (ACP_POOL.get(activeSessionId) === entry && !entry.busy) {
          log(`[agy-acp] 会话 ${activeSessionId.slice(0, 8)} 空闲超时，回收常驻进程`);
          closeAcpSession(activeSessionId);
        }
      }, ACP_IDLE_TTL_MS);
      entry.idleTimer.unref?.();
      ACP_POOL.set(activeSessionId, entry);
      // 最多保留 6 个空闲常驻会话，超出先清最久未用的
      if (ACP_POOL.size > 6) {
        const oldest = [...ACP_POOL.entries()].filter(([, v]) => !v.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (oldest) closeAcpSession(oldest[0]);
      }
    } else {
      destroyClient();
    }
  }
}
