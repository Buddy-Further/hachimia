// ─────────────────────────────────────────────────────────────────────
//  acp-errors.mjs —— ACP 错误分类 + 重试退避（P0-3）
//
//  叶模块：只引 config.mjs 的 tz，不引 stream.mjs（login↔stream 有循环风险，
//  ACP 也不得依赖 Claude 路径的翻译层），不引 login.mjs。
//  其中 429 / 上下文超长两句中文文案复用 stream.mjs apiErrorHint 的原句
//  （来源：gateway/gw/stream.mjs:83-95）；401 那句是 API Key 口径，
//  ACP 走 OAuth，登录过期另写“重新登录”文案，不复用。
//
//  分类只看 code + message 模式，绝不只看 code：已登录态的真实 429 /
//  额度耗尽 / 模型不存在 / 5xx 在本机无登录账号时观测不到，模式是唯一的
//  区分手段；认不出的统一 unknown，原文原样保留在 detail 里。
// ─────────────────────────────────────────────────────────────────────
import { tz } from "./config.mjs";

/** 重试常量：环境变量可覆盖（测试用，命名仿 CCAPP_ACP_PROMPT_TIMEOUT_MS）。
 *  maxAttempts 是总尝试次数（含首次）：默认 3 = 首次 + 2 次重试。 */
const numEnv = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
export const ACP_RETRY = {
  maxAttempts: numEnv("CCAPP_ACP_RETRY_MAX_ATTEMPTS", 3),
  baseMs: numEnv("CCAPP_ACP_RETRY_BASE_MS", 1000),
  factor: 2,
  capMs: numEnv("CCAPP_ACP_RETRY_CAP_MS", 5000),
  jitter: 0.25,
  rateLimitBaseMs: numEnv("CCAPP_ACP_RETRY_RL_BASE_MS", 2000),
  rateLimitCapMs: numEnv("CCAPP_ACP_RETRY_RL_CAP_MS", 30000),
  /** 429 携带的 retryAfter / resetsAt 最多等这么久，超过按 60s 计。 */
  rateLimitResetCapMs: numEnv("CCAPP_ACP_RETRY_RL_RESET_CAP_MS", 60000),
};

/** 从 Error / 原始 {code,message,data} / 字符串里抠出统一的三件套 */
function normalizeErr(err) {
  if (typeof err === "string") return { message: err, code: undefined, data: undefined };
  if (err && typeof err === "object") {
    const message = String(err.message ?? err.error?.message ?? err.msg ?? err);
    const code = err.code ?? err.error?.code;
    const data = err.data ?? err.error?.data;
    return { message, code, data };
  }
  return { message: String(err ?? ""), code: undefined, data: undefined };
}

/** 文案里夹带的 HTTP 状态码（仿 stream.mjs apiErrorHint 的取法） */
function httpCodeOf(message) {
  const m = /\bAPI Error:?\s*(\d{3})\b/i.exec(message)
    || /\b(?:status|HTTP)\s*(\d{3})\b/i.exec(message);
  return m ? Number(m[1]) : 0;
}

/** error.data 里可能出现的重试等待：秒数或重置时刻，统一折成毫秒数 */
function resetDelayMs(data) {
  if (!data || typeof data !== "object") return 0;
  const secs = data.retryAfter ?? data.retry_after ?? data.retryAfterSeconds ?? data.retry_after_seconds;
  if (Number.isFinite(Number(secs)) && Number(secs) > 0) return Number(secs) * 1000;
  const ms = data.retryAfterMs ?? data.retry_after_ms;
  if (Number.isFinite(Number(ms)) && Number(ms) > 0) return Number(ms);
  const at = data.resetsAt ?? data.reset_time ?? data.resetTime ?? data.retryAt ?? data.reset_at;
  if (at != null) {
    const t = typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : Date.parse(String(at));
    if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  }
  return 0;
}

function resetHintSuffix(data) {
  const ms = resetDelayMs(data);
  if (ms <= 0) return "";
  if (ms < 60000) return tz("（约 {n} 秒后可重试）", { n: Math.max(1, Math.round(ms / 1000)) });
  return tz("（约 {n} 分钟后可重试）", { n: Math.max(1, Math.round(ms / 60000)) });
}

/**
 * ACP 错误分类。返回：
 *   { class, retryable, hint, action, code, raw, data }
 * - class：auth-expired | rate-limit | model-not-found | context-too-long |
 *          timeout | network-process | login-env | unknown
 * - retryable：建会阶段能不能自动重试。prompt 阶段一律不自动重试，
 *   由调用方按阶段再收紧（见 acp.mjs runAcpTurn 的 catch）。
 * - hint：给用户看的一句中文处理建议；unknown 时含原文。
 * - action：re-login | retry | check-model | compact | login-in-terminal | none
 * - code：归一化后的数字码（JSON-RPC 负码或 HTTP 码），没有为 null。
 * - raw：原始错误文本原文，绝不改写、绝不丢。
 */
export function classifyAcpError(err) {
  const { message, code, data } = normalizeErr(err);
  const raw = message;
  const s = message || "";
  const numCode = Number.isFinite(Number(code)) ? Number(code) : null;
  const http = httpCodeOf(s);
  const effCode = numCode ?? (http || null);

  // 1. login-env：无浏览器弹不出登录页（环境问题，不是登录过期）。
  //    只认 -32603 + 原文，绝不能把 -32603 通用错都算成它。
  if (numCode === -32603 && /no browser is available/i.test(s)) {
    return {
      class: "login-env", retryable: false,
      hint: tz("当前环境没有浏览器，无法弹出登录页：请在终端里跑 `agy acp --login` 完成登录，再回来重试。"),
      action: "login-in-terminal", code: effCode, raw, data,
    };
  }

  // 2. auth-expired：登录过期 / 未登录。-32000 必须配认证文案才认；
  //    `-p /usage` 未登录时的 ERROR 信封（"authentication failed or timed out"）
  //    与 `agy models` 的 "Please sign in…" 没有 code，凭文案认。
  if ((numCode === -32000 && /authentication required|not authenticated|please sign in|sign in|authentication failed/i.test(s))
    || /authentication failed or timed out/i.test(s)
    || /please sign in to view available models/i.test(s)) {
    return {
      class: "auth-expired", retryable: false,
      hint: tz("登录已过期或未登录：请重新登录 Google 账号后再试。"),
      action: "re-login", code: effCode, raw, data,
    };
  }

  // 3. rate-limit：429 / 限流 / 额度耗尽。可重试（建会阶段）。
  //    文案复用 stream.mjs apiErrorHint 的 429 原句，reset 时间有就补上。
  if (effCode === 429 || http === 429
    || /rate[_ ]limit|too many requests|quota (exceeded|exhausted)|usage limit/i.test(s)) {
    return {
      class: "rate-limit", retryable: true,
      hint: tz("请求太频繁，或者用量到了上限：稍等一会儿再试。") + resetHintSuffix(data),
      action: "retry", code: effCode, raw, data,
    };
  }

  // 4. model-not-found：404 / 模型不存在。agent 明确不提供模型时
  //    网关在 init 前抛的中文错（C6）也算这一类。
  if (effCode === 404 || http === 404
    || /not_found_error|model[^\n]{0,40}(?:not (?:found|exist)|does not exist)/i.test(s)
    || /agent 不提供模型|不提供模型/.test(s)) {
    return {
      class: "model-not-found", retryable: false,
      hint: tz("接口找不到这个模型：检查模型名是否正确，或换个模型再试。"),
      action: "check-model", code: effCode, raw, data,
    };
  }

  // 5. context-too-long：上下文超长。文案复用 stream.mjs apiErrorHint 原句。
  if (/prompt is too long|context(?:_| )length|maximum context|too many tokens/i.test(s)) {
    return {
      class: "context-too-long", retryable: false,
      hint: tz("对话太长，超过了模型的上下文上限。打 /compact 压缩一下再继续，或者开个新对话。"),
      action: "compact", code: effCode, raw, data,
    };
  }

  // 6. timeout：ACP 请求超时（acp.mjs 在 request() 里挂 ACP_TIMEOUT 码）。
  //    建会阶段可重试，prompt 阶段由调用方禁掉。
  if (code === "ACP_TIMEOUT" || /^ACP request timeout: /.test(s)) {
    return {
      class: "timeout", retryable: true,
      hint: tz("Antigravity CLI 请求超时了：网络或服务端可能正忙，稍后再试。"),
      action: "retry", code: effCode, raw, data,
    };
  }

  // 7. network-process：agy 进程死了 / stdin 断了 / 起不来。建会阶段可重试。
  if (/agy acp (exited with code|terminated by)|ACP stdin write failed|ACP process already closed|ECONNRESET|EPIPE|spawn .* ENOENT/i.test(s)) {
    return {
      class: "network-process", retryable: true,
      hint: tz("Antigravity CLI 进程异常退出了：请重试；一直这样就重启网关或重装 agy。"),
      action: "retry", code: effCode, raw, data,
    };
  }

  // 8. unknown：其余一切（含 -32601 / -32602 / -32603 通用错）。不重试，
  //    原文原样进 hint（截 500 字防刷屏）与 detail（全量，见 acp.mjs）。
  return {
    class: "unknown", retryable: false,
    hint: tz("Antigravity CLI 执行出错：{msg}", { msg: s.slice(0, 500) }),
    action: "none", code: effCode, raw, data,
  };
}

/**
 * 第 attempt 次重试（1-based，第 1 次重试）前要等的毫秒数。
 * 基础 1000ms ×2 递增，封顶 5000ms，±25% 均匀抖动；
 * rate-limit 例外：基础 2000ms ×2，封顶 30000ms，且 data 里的
 * retryAfter / resetsAt 有值时按它等（最多 60s）。
 */
export function retryDelayMs(attempt, err) {
  const c = classifyAcpError(err);
  const n = Math.max(1, Number(attempt) || 1);
  const jitter = (ms) => Math.max(0, Math.round(ms * (1 + (Math.random() * 2 - 1) * ACP_RETRY.jitter)));
  if (c.class === "rate-limit") {
    const backoff = Math.min(ACP_RETRY.rateLimitBaseMs * Math.pow(ACP_RETRY.factor, n - 1), ACP_RETRY.rateLimitCapMs);
    const hinted = resetDelayMs(c.data);
    if (hinted > 0) return Math.min(Math.max(jitter(backoff), hinted), ACP_RETRY.rateLimitResetCapMs);
    return jitter(backoff);
  }
  const backoff = Math.min(ACP_RETRY.baseMs * Math.pow(ACP_RETRY.factor, n - 1), ACP_RETRY.capMs);
  return jitter(backoff);
}
