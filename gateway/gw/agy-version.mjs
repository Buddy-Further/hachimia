// ─────────────────────────────────────────────────────────────────────
//  agy-version.mjs —— Antigravity CLI 版本门（P0-4）
//
//  叶模块：纯函数 + 常量，不引任何网关模块、不做 I/O。版本假设的唯一
//  登记处：AGY_BEHAVIOUR 里一行对应一个已验证的 agy 版本；散在各处的
//  “1.5.13 实测”注释都应改引 AGY_BEHAVIOUR[AGY_VERIFIED_VERSION]，
//  别再把版本号写死在注释里。
//
//  两级门：
//  - 版本 < AGY_MIN_VERSION → 太旧，建会直接拦（acp.mjs 抛 AGY_VERSION，
//    分类器给 version-mismatch，不可重试；agy 会自动升级，别写死成
//    “恰好等于某版本”，否则每次发版都把应用砖掉）。
//  - 版本 > AGY_VERIFIED_VERSION → 更新未验证，警告后继续跑；
//    版本缺失 / 解析不出 → 未知，警告后继续跑（将来 agy 改字段名时
//    别把会话拦死）。protocolVersion !== 1 同样只警告。
//
//  环境变量（仿 ACP_RETRY 的先例，模块加载时读一次，测试用）：
//  - CCAPP_AGY_MIN_VERSION：抬高 / 降低最低版本下限（须是严格三段式，
//    否则忽略）；只影响 too-old 的判定，不影响已验证版本。
//  - CCAPP_AGY_ALLOW_UNVERIFIED=1：逃生口——只压住“更新未验证”的警告，
//    永远压不住 too-old 的拦截。
// ─────────────────────────────────────────────────────────────────────

/** 最低版本下限：低于它一律拦截。1.5.13 是唯一实测过的版本，
//  没有任何证据表明更旧的版本能工作。 */
const envMin = String(process.env.CCAPP_AGY_MIN_VERSION || "").trim();
const envMinOk = /^v?\d+\.\d+\.\d+$/.test(envMin);
export const AGY_MIN_VERSION = envMinOk ? envMin.replace(/^v/, "") : "1.5.13";

/** 最后一次人工验证过的版本：高于它即“更新未验证”。 */
export const AGY_VERIFIED_VERSION = "1.5.13";

/** 只压住“更新未验证”警告的逃生口，永远压不住 too-old 拦截。 */
export const AGY_ALLOW_UNVERIFIED = process.env.CCAPP_AGY_ALLOW_UNVERIFIED === "1";

/**
 * 已验证版本的行为登记表：散在各处的版本假设（权限模式、思考强度档位、
 * `agy models` 文本格式、/usage 信封、/compact 行为、认证方式、会话
 * 能力、MCP 配置文件、协议版本）都以这一行为准。精确命中给本行；
 * 未验证的新版本回落到已验证行（警告由 checkAgyVersion 发）。
 */
export const AGY_BEHAVIOUR = {
  "1.5.13": {
    permModes: ["default", "accept-edits", "plan"],
    thoughtLevelValues: ["low", "medium", "high", "xhigh"],
    compactEmitsCompactionUpdate: false,
    authMethods: ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"],
    sessionCapabilities: ["resume", "close", "load", "list", "additionalDirectories"],
    modelsFormat: "text-lines",
    usageEnvelope: "command.data.groups[].buckets[]",
    mcpConfigFile: "~/.gemini/config/mcp_config.json",
    protocolVersion: 1,
  },
};

/** 严格三段式：trim 后容忍前导 v，其余（"1.5"、"1.5.13-beta"、空、非字符串）一律 null。 */
export function parseAgyVersion(s) {
  if (typeof s !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** 数值比较：-1 | 0 | 1；任一输入解析不出给 null。入参可以是字符串或 parseAgyVersion 的结果。 */
export function compareAgyVersions(a, b) {
  const pa = a && typeof a === "object" ? a : parseAgyVersion(a);
  const pb = b && typeof b === "object" ? b : parseAgyVersion(b);
  if (!pa || !pb) return null;
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  return 0;
}

/** versionString 不低于 floor（字符串三段式）：任一解析不出为 false。 */
export function agyAtLeast(versionString, floor) {
  const c = compareAgyVersions(versionString, floor);
  return c !== null && c >= 0;
}

/**
 * 版本门判定。返回 { status, version, min, verified }：
 * - "ok"：恰好是已验证版本；"too-old"：低于下限；
//  - "newer-unverified"：高于已验证版本；"unknown"：缺失 / 解析不出，
//    或满足下限但低于已验证版本（只在下限被环境变量调低时出现：
//    从未验证过，既不算通过也不算拦截）。
 * version 是归一化后的三段式；解析不出时原样返回裁剪后的输入（缺失为 ""）。
 */
export function checkAgyVersion(versionString, floor = AGY_MIN_VERSION) {
  const parsed = parseAgyVersion(versionString);
  const version = parsed
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}`
    // M-4：未解析出的输入原样进 note/hint 前截到 64 字，防无界字符串刷屏。
    : (typeof versionString === "string" ? versionString.trim().slice(0, 64) : "");
  if (!parsed) return { status: "unknown", version, min: floor, verified: AGY_VERIFIED_VERSION };
  if (compareAgyVersions(parsed, floor) < 0) return { status: "too-old", version, min: floor, verified: AGY_VERIFIED_VERSION };
  if (compareAgyVersions(parsed, AGY_VERIFIED_VERSION) === 0) return { status: "ok", version, min: floor, verified: AGY_VERIFIED_VERSION };
  if (compareAgyVersions(parsed, AGY_VERIFIED_VERSION) > 0) return { status: "newer-unverified", version, min: floor, verified: AGY_VERIFIED_VERSION };
  return { status: "unknown", version, min: floor, verified: AGY_VERIFIED_VERSION };
}

/** 查表：精确命中给本行，否则回落到已验证行（警告由 checkAgyVersion 发）。 */
export function agyBehaviour(versionString) {
  const parsed = parseAgyVersion(versionString);
  const key = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : "";
  return AGY_BEHAVIOUR[key] || AGY_BEHAVIOUR[AGY_VERIFIED_VERSION];
}
