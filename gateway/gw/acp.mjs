// ─────────────────────────────────────────────────────────────────────
//  acp.mjs —— Antigravity CLI (`agy acp`) Agent Client Protocol (JSON-RPC 2.0) 引擎
//
//  通过 stdio 双向 newline-delimited JSON-RPC 2.0 驱动官方原生 Android (bionic) `agy acp`：
//    Client → Agent: initialize, authenticate, session/new, session/load, session/prompt,
//                    session/set_mode, session/set_config_option, session/cancel
//    Agent → Client: session/update (流式文本/思考/工具调用/计划/用量),
//                    session/request_permission (映射到 hachimia 权限确认卡片)
//
//  同时将每轮完整交互以兼容格式落盘到会话 jsonl，使会话列表、搜索、导出、分叉与脉络功能无缝工作。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { CFG, PATHS, log, tz } from "./config.mjs";

export const ACP_PROTOCOL_VERSION = 1;

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

/** 从 ACP content 块提取纯文本 */
export function acpTextOf(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(acpTextOf).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content) return acpTextOf(content.content);
  }
  return "";
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
    onStderr?.(s);
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
        .then(() => (onRequest ? onRequest(msg.method, msg.params || {}) : Promise.reject(new Error(`Unsupported client method: ${msg.method}`))))
        .then((result) => writeMsg({ jsonrpc: "2.0", id: msg.id, result }))
        .catch((err) => writeMsg({ jsonrpc: "2.0", id: msg.id, error: { code: err?.code || -32603, message: String(err?.message || err) } }));
      return;
    }
    // 3. Agent 通知（如 session/update）
    if (typeof msg.method === "string") {
      try { onNotification?.(msg.method, msg.params || {}); } catch (e) { log(`[acp] 通知处理异常: ${e.message}`); }
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

  function close() {
    closed = true;
    try { child.stdin.end(); } catch {}
    try { rl.close(); } catch {}
  }

  return {
    child,
    request,
    notify,
    close,
    get stderr() { return stderrTail; },
    get closed() { return closed; },
  };
}

/**
 * 将 ACP `session/update` 通知翻译为 hachimia 前端 SSE 事件并累积本轮状态。
 */
export function translateAcpUpdate(params, state, emit) {
  const upd = params?.update || params || {};
  const kind = upd.sessionUpdate || upd.type || "";

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
    const name = String(upd.title || upd.name || upd.kind || "Tool");
    const input = upd.rawInput && typeof upd.rawInput === "object" ? upd.rawInput : (upd.input || {});
    state.tools.set(id, { id, name, input, status: upd.status || "pending" });
    emit({ type: "tool_use", id, name, input });
    return;
  }

  if (kind === "tool_call_update") {
    const id = String(upd.toolCallId || upd.id || "");
    const prev = state.tools.get(id) || { id, name: upd.title || "Tool", input: {} };
    if (upd.status) prev.status = upd.status;
    const out = acpTextOf(upd.content ?? upd.rawOutput ?? upd.output);
    if (out) prev.output = (prev.output || "") + out;
    state.tools.set(id, prev);
    if (upd.status === "completed" || upd.status === "failed" || upd.status === "error" || out) {
      emit({
        type: "tool_result",
        id,
        content: prev.output || "",
        is_error: upd.status === "failed" || upd.status === "error",
      });
    }
    return;
  }

  if (kind === "plan" && Array.isArray(upd.entries)) {
    emit({
      type: "tasks",
      tasks: upd.entries.map((e, idx) => ({
        id: String(idx + 1),
        subject: String(e.content || e.title || ""),
        status: e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending",
      })),
    });
    return;
  }

  if (kind === "usage" || kind === "usage_update" || upd.usage) {
    const u = upd.usage || upd;
    const ctx = Number(u.inputTokens ?? u.promptTokens ?? u.input_tokens ?? 0);
    const out = Number(u.outputTokens ?? u.completionTokens ?? u.output_tokens ?? 0);
    if (ctx > 0 || out > 0) {
      state.usage = { input_tokens: ctx, output_tokens: out };
      emit({ type: "usage", contextTokens: ctx, outputTokens: out });
    }
    return;
  }

  if (kind === "current_mode_update" && upd.currentModeId) {
    emit({ type: "mode_changed", mode: upd.currentModeId });
    return;
  }

  // 已知但有意忽略的种类（不回显、不影响本轮正文），之外的记进日志：
  // 真机上 agy 发来新种类时，日志里能直接看到名字，不用再猜
  const IGNORED = new Set(["user_message", "user_message_chunk", "available_commands_update", "config_option_update", "session_info_update", "notice", "compaction_update", "compaction_summary_chunk", "permission_confirmation"]);
  if (!IGNORED.has(kind)) log(`[agy-acp] 未识别的 update 种类：${kind}`);
}

/**
 * 将一次 ACP 对话回合持久化到本地 jsonl，兼容 sessions.mjs / transcript.mjs。
 */
export function persistAcpTurn({ cwd, sessionId, userText, assistantText, thinking, tools, model, usage }) {
  if (!sessionId) return;
  const file = acpSessionFile(cwd, sessionId);
  const now = new Date().toISOString();
  const userUuid = crypto.randomUUID();
  const asstUuid = crypto.randomUUID();

  appendJsonl(file, {
    type: "user",
    uuid: userUuid,
    parentUuid: null,
    sessionId,
    cwd,
    timestamp: now,
    message: { role: "user", content: userText },
  });

  const blocks = [];
  if (thinking) blocks.push({ type: "thinking", thinking });
  for (const t of tools || []) {
    blocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.input || {} });
  }
  if (assistantText) blocks.push({ type: "text", text: assistantText });

  appendJsonl(file, {
    type: "assistant",
    uuid: asstUuid,
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
}

/**
 * 执行一轮完整的 `agy acp` 对话回合（initialize → authenticate → session/new|load → session/prompt）。
 */
export async function runAcpTurn({
  bin, args = ["acp"], cwd, env, prompt, images = [], sessionId = null,
  model = "", permMode = "default", authType = "", apiKey = "",
  mcpServers = [], run, emit, askPermission, timeoutMs = 0,
}) {
  const t0 = Date.now();
  const state = { text: "", thinking: "", tools: new Map(), usage: null };
  let activeSessionId = sessionId || null;

  const client = createAcpClient({
    bin,
    args,
    cwd,
    env,
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
        const allowAlwaysOpt = options.find((o) => /allow_always/i.test(o.kind || o.optionId || "")) || allowOpt;
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
          tool: params.toolCall?.title || params.toolCall?.kind || "Antigravity Tool",
          input: params.toolCall?.rawInput || params.toolCall || {},
          options,
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

  if (run) {
    run.child = client.child;
    run.preSpawn = false;
    run.cancelAcp = () => {
      if (activeSessionId) client.notify("session/cancel", { sessionId: activeSessionId });
      client.close();
    };
  }

  try {
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

    // 3. session/load 或 session/new
    const canLoad = !!initRes?.agentCapabilities?.loadSession;
    let sessRes = null;
    if (activeSessionId && canLoad) {
      try {
        sessRes = await client.request("session/load", {
          sessionId: activeSessionId,
          cwd,
          mcpServers,
        }, 30000);
      } catch (e) {
        log(`[agy-acp] session/load 失败，改为新建会话: ${e.message}`);
        activeSessionId = null;
      }
    }
    if (!sessRes) {
      sessRes = await client.request("session/new", { cwd, mcpServers }, 30000);
      activeSessionId = sessRes?.sessionId || activeSessionId || crypto.randomUUID();
    }

    if (run) run.sessionId = activeSessionId;
    emit({
      type: "init",
      sessionId: activeSessionId,
      model: model || sessRes?.models?.currentModelId || "antigravity",
      tools: [],
      protocol: "acp",
    });

    // 4. 可选：应用模型或权限模式
    if (model && sessRes?.models?.availableModels?.some((m) => m.modelId === model || m.id === model)) {
      await client.request("session/set_config_option", {
        sessionId: activeSessionId,
        configId: "model",
        value: model,
      }, 10000).catch(() => {});
    }

    // 5. session/prompt
    const contentBlocks = [{ type: "text", text: prompt }];
    for (const img of images) {
      if (img?.source?.data && img?.source?.media_type) {
        contentBlocks.push({ type: "image", data: img.source.data, mimeType: img.source.media_type });
      }
    }

    emit({ type: "phase", phase: "wait" });
    const promptRes = await client.request("session/prompt", {
      sessionId: activeSessionId,
      prompt: contentBlocks,
    }, timeoutMs > 0 ? timeoutMs : 0);

    const stopReason = promptRes?.stopReason || "end_turn";
    const durationMs = Date.now() - t0;

    // 持久化到本地 jsonl，供会话列表 / 历史查看 / 搜索 / 导出复用
    persistAcpTurn({
      cwd,
      sessionId: activeSessionId,
      userText: prompt,
      assistantText: state.text,
      thinking: state.thinking,
      tools: [...state.tools.values()],
      model: model || sessRes?.models?.currentModelId || "antigravity",
      usage: state.usage,
    });

    emit({
      type: "result",
      sessionId: activeSessionId,
      resultText: state.text,
      stopReason,
      durationMs,
      costUsd: 0,
    });

    return {
      ok: true,
      sessionId: activeSessionId,
      resultText: state.text,
      stopReason,
      durationMs,
      usage: state.usage,
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
    client.close();
  }
}
