// ─────────────────────────────────────────────────────────────────────
//  mcp-acp.mjs —— 用户 MCP 配置 → ACP session/new|load|resume 的 mcpServers
//
//  背景（P0-1）：Claude 路径经 seal.mjs mcpConfig() 把 ~/.claude.json 的
//  MCP 以 --mcp-config 交给 claude；ACP 路径却在 run.mjs 硬编码
//  mcpServers: []，用户 MCP 全丢。本模块做两件事：
//    1. 形态转换：Claude 对象式 { mcpServers: { name: { type, command,
//       args, env: { K: V }, url, headers } } } → ACP 数组式
//       （见 agentclientprotocol.com/protocol/session-setup）：
//       stdio { name, command, args, env: [{ name, value }] }（无 type 字段），
//       http { type: "http", name, url, headers: [{ name, value }] }，
//       sse  { type: "sse",  name, url, headers: [{ name, value }] }。
//    2. 汇总：从各处只读收集 MCP 定义并合并（见 buildAcpMcpServers）。
//
//  传输限制：仓库从不检查 agent initialize 回的 mcpCapabilities，
//  无法确认 agent 支不支持 http/sse；全 agent 必须支持 stdio，
//  所以本模块只透传 stdio，http/sse 与未知传输一律跳过（记入 skipped，
//  不发送、不崩溃）。以后若补了 mcpCapabilities 门控，再放开。
//
//  未决问题（无真机 agy 可验证，见 buildAcpMcpServers 注释）：
//  仓库读 ~/.gemini/antigravity-cli/settings.json 的 mcpServers，
//  外部文档却说 agy MCP 在 ~/.gemini/config/mcp_config.json（全局）
//  与 <workspace>/.agents/mcp_config.json；前两处都读，以有完整
//  command/args 的定义为准，只知道名字的一律不编造。
//  安全（P0-1 修复）：工作区 <cwd>/.agents/mcp_config.json 绝不自动加载——
//  它是克隆仓库带来的不可信内容，ACP 分支在 projectRisks()/sealPrepare()
//  之前就返回，网关来不及对它做任何确认；任意 command/args 会直达 agent。
//  需要工作区 MCP 的用户请把它配进家目录文件（见上）。
//
//  安全：env/headers 的值是凭据，绝不记日志、不回显、不进报错；
//  本模块只返回名字与跳过原因，调用方记日志时同样只许记名字。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "./config.mjs";
import { scanText } from "./breach.mjs";
import { mcpConfig as claudeMcpConfig } from "./seal.mjs";

const MAX_CFG_BYTES = 1 << 20;

/** ACP mcpServers 里一个 stdio 服务的 env 是 [{ name, value }]；Claude 侧是 { K: V } 对象。 */
function envObjectToAcp(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof k === "string" && k && typeof v === "string") out.push({ name: k, value: v });
  }
  return out;
}

function headersObjectToAcp(headers) {
  return envObjectToAcp(headers);
}

/**
 * Claude 对象式 MCP 配置 → ACP 数组式。
 * @param {object} input { mcpServers: { name: def } } 或裸 { name: def } 映射。
 * @returns {{ servers: Array, skipped: Array<{name, reason}> }}
 *   servers 只含 stdio；http/sse/未知传输与缺 command 的 stdio 进 skipped。
 */
export function claudeMcpToAcp(input) {
  const map = input && typeof input === "object"
    ? (input.mcpServers && typeof input.mcpServers === "object" ? input.mcpServers : input)
    : {};
  const servers = [];
  const skipped = [];
  for (const [name, def] of Object.entries(map)) {
    if (!name || !def || typeof def !== "object" || Array.isArray(def)) {
      skipped.push({ name: String(name), reason: "not-an-object" });
      continue;
    }
    const type = String(def.type || "stdio").toLowerCase();
    if (type === "stdio") {
      if (typeof def.command !== "string" || !def.command.trim()) {
        skipped.push({ name, reason: "stdio server has no command" });
        continue;
      }
      const env = envObjectToAcp(def.env);
      const server = { name, command: def.command };
      if (Array.isArray(def.args)) server.args = def.args.map(String);
      if (env.length) server.env = env;
      servers.push(server);
    } else if (type === "http" || type === "sse") {
      // stdio-only：仓库不检查 mcpCapabilities.http/.sse，无法确认 agent 支持与否。
      skipped.push({ name, reason: `${type} transport not sent (stdio-only: mcpCapabilities not checked)` });
    } else {
      skipped.push({ name, reason: `unknown transport ${type}` });
    }
  }
  return { servers, skipped };
}

/**
 * 按名字合并多个 ACP mcpServers 列表；同名时后出现的列表胜出。
 * 调用方按优先级从低到高传：低优先级在前，高优先级在后。
 */
export function mergeAcpMcpServers(...lists) {
  const byName = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (s && typeof s.name === "string" && s.name) byName.set(s.name, s);
    }
  }
  return [...byName.values()];
}

/** ACP mcpServers 列表的稳定指纹（按名字排序后哈希）：供 ACP 进程池 key 用。 */
export function mcpServersHash(servers) {
  const sorted = [...(Array.isArray(servers) ? servers : [])]
    .filter((s) => s && typeof s.name === "string")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

function readJsonFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_CFG_BYTES) return null;
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/**
 * 只读收集 agy 侧 MCP 定义（best-effort，文件缺失/解析失败都静默跳过）。
 * 只读家目录两处来源——仓库既有的 ~/.gemini/antigravity-cli/settings.json，
 * 与外部文档所说的 ~/.gemini/config/mcp_config.json（全局）：
 * 未决：两处到底哪处是 agy 真正读的，本机无 agy 二进制无法验证；
 * 两处都读、有完整定义的才采用，绝不只凭名字编造服务条目。
 * P0-2 实测修正（agy 1.5.13，见 ~/workspace/agy-verify/VERIFY-REPORT.md）：
 * settings.json 在首次运行后根本不存在，那一路是死代码，全局一路才是真的；
 * 死代码留在这里不动，等以后一并清理（P0-2 不扩范围）。
 * 工作区 <cwd>/.agents/mcp_config.json 故意不读：它是克隆仓库带来的
 * 不可信内容，ACP 分支在 projectRisks()/sealPrepare() 之前就返回，
 * 网关来不及对它做任何确认；用户须把 MCP 配进家目录文件。
 * @returns {{ servers: Array, skipped: Array<{name, reason}> }}
 */
export function readAgyMcpConfigs() {
  const home = CFG.home;
  const servers = [];
  const skipped = [];
  const take = (obj, source) => {
    const { servers: conv, skipped: sk } = claudeMcpToAcp(obj);
    servers.push(...conv);
    for (const s of sk) skipped.push({ ...s, source });
    // 只有名字、没有完整定义的条目：claudeMcpToAcp 已按缺 command 跳过；
    // 这里不再补任何东西——名字本身启动不了服务。
  };
  const settings = readJsonFile(path.join(home, ".gemini", "antigravity-cli", "settings.json"));
  if (settings?.mcpServers && typeof settings.mcpServers === "object") {
    take(settings, "agy-settings.json");
  }
  const globalCfg = readJsonFile(PATHS.agyMcpConfig);
  if (globalCfg) take(globalCfg, "agy-mcp_config.json(global)");
  return { servers, skipped };
}

/**
 * 组装本轮 ACP 会话要发给 agent 的 mcpServers（ACP 数组式）。
 * 优先级（同名冲突时后者胜出）：Claude ~/.claude.json < agy 各来源 < 设备 MCP。
 * 设备 MCP 由调用方按现有门控（PREFIX、脚本在、dev_status.on、非端侧）
 * 决定是否传入 deviceJson（deviceMcpConfig() 的 JSON 串），本函数只做转换。
 * 破甲扫描：先整份扫，通过直接用；命中则逐个服务扫，只剔除命中的服务，
 * 其余照常发送。blocked/skipped 只含服务名，绝不含 env/headers 值或扫描摘录。
 * @param {{ cwd?: string, deviceJson?: string|null }} opts
 * @returns {{ servers: Array, skipped: Array, blocked: Array<{name}> }}
 */
export function buildAcpMcpServers({ cwd = "", deviceJson = null } = {}) {
  const skipped = [];
  const claude = claudeMcpConfig(cwd);
  const claudeConv = claudeMcpToAcp(claude || {});
  skipped.push(...claudeConv.skipped.map((s) => ({ ...s, source: "claude.json" })));
  const agy = readAgyMcpConfigs();
  skipped.push(...agy.skipped);
  let device = [];
  if (deviceJson) {
    try {
      const d = claudeMcpToAcp(JSON.parse(deviceJson));
      device = d.servers;
      skipped.push(...d.skipped.map((s) => ({ ...s, source: "device" })));
    } catch {
      skipped.push({ name: "device", reason: "device config unparseable", source: "device" });
    }
  }
  // 优先级：Claude < agy < device（device 同名冲突时胜出）。
  const merged = mergeAcpMcpServers(claudeConv.servers, agy.servers, device);
  const blocked = [];
  let servers = merged;
  if (merged.length && scanText(JSON.stringify({ mcpServers: merged })).blocked) {
    servers = merged.filter((s) => {
      const hit = scanText(JSON.stringify(s)).blocked;
      if (hit) blocked.push({ name: s.name });
      return !hit;
    });
  }
  return { servers, skipped, blocked };
}
