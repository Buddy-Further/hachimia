// ─────────────────────────────────────────────────────────────────────
//  mcp-acp.mjs —— 用户 MCP 配置 → ACP session/new|load|resume 的 mcpServers
//
//  agy-only（P0-2b）：MCP 只有一个来源——~/.gemini/config/mcp_config.json
//  （实测 agy 1.5.13：`agy mcp add` 写这里，`agy mcp list` 读这里，`agy acp`
//  启动时自己加载这里的服务器；~/.gemini/antigravity-cli/settings.json
//  在首次运行后根本不存在，见 ~/workspace/agy-verify/VERIFY-REPORT.md）。
//  ~/.claude.json 不再读、不再发：它是另一个独立应用（cccodroid）的配置，
//  本项目不从那里迁移。工作区 <cwd>/.agents/mcp_config.json 也绝不自动加载——
//  它是克隆仓库带来的不可信内容，ACP 分支在 projectRisks()/sealPrepare()
//  之前就返回，网关来不及对它做任何确认；任意 command/args 会直达 agent。
//  需要工作区 MCP 的用户请把它配进家目录文件（见上）。
//
//  形态转换：对象式 { mcpServers: { name: { type, command,
//  args, env: { K: V }, url, headers } } } → ACP 数组式
//  （见 agentclientprotocol.com/protocol/session-setup）：
//  stdio { name, command, args, env: [{ name, value }] }（无 type 字段），
//  http { type: "http", name, url, headers: [{ name, value }] }，
//  sse  { type: "sse",  name, url, headers: [{ name, value }] }。
//
//  传输限制：仓库从不检查 agent initialize 回的 mcpCapabilities，
//  无法确认 agent 支不支持 http/sse；全 agent 必须支持 stdio，
//  所以本模块只透传 stdio，http/sse 与未知传输一律跳过（记入 skipped，
//  不发送、不崩溃）。以后若补了 mcpCapabilities 门控，再放开。
//
//  A2（P0-2b 决策）：~/.claude.json 里只剩名字会丢——顶层 mcpServers 与
//  projects[cwd].mcpServers 在 agy 侧都没有等价物。不静默丢：
//  droppedClaudeMcpNames() 只读名字（绝不读定义、绝不读 env/headers 的值），
//  把名字放进 buildAcpMcpServers 返回的 skipped，让用户看得见、自己搬去
//  mcp_config.json。sealed 版 Claude 启动路径（seal.mjs mcpConfig()）仍在
//  读 ~/.claude.json，那是另一条路，与 ACP 无关。
//
//  安全：env/headers 的值是凭据，绝不记日志、不回显、不进报错；
//  本模块只返回名字与跳过原因，调用方记日志时同样只许记名字。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "./config.mjs";
import { scanText } from "./breach.mjs";

const MAX_CFG_BYTES = 1 << 20;

/** ACP mcpServers 里一个 stdio 服务的 env 是 [{ name, value }]；对象式 MCP 配置（agy `mcp_config.json`；与 `~/.claude.json` 同形）里是 { K: V } 对象。 */
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
 * 对象式 MCP 配置（agy `mcp_config.json`；与 `~/.claude.json` 同形）→ ACP 数组式。
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
 * 唯一来源：~/.gemini/config/mcp_config.json（全局，P0-2 实测 agy 1.5.13
 * 真正读的就是它，`agy mcp add` 也写这里）。有完整定义的才采用，
 * 绝不只凭名字编造服务条目。
 * 工作区 <cwd>/.agents/mcp_config.json 故意不读：它是克隆仓库带来的
 * 不可信内容，ACP 分支在 projectRisks()/sealPrepare() 之前就返回，
 * 网关来不及对它做任何确认；用户须把 MCP 配进家目录文件。
 * @returns {{ servers: Array, skipped: Array<{name, reason}> }}
 */
export function readAgyMcpConfigs() {
  const servers = [];
  const skipped = [];
  const globalCfg = readJsonFile(PATHS.agyMcpConfig);
  if (globalCfg) {
    const { servers: conv, skipped: sk } = claudeMcpToAcp(globalCfg);
    servers.push(...conv);
    for (const s of sk) skipped.push({ ...s, source: "agy" });
  }
  return { servers, skipped };
}

/**
 * A2：~/.claude.json 里被 agy-only 丢掉的 MCP 服务器名字（只读名字，
 * 绝不读定义、绝不读 env/headers 的值）。顶层 mcpServers 与
 * projects[cwd].mcpServers 各算一份——前者是全局旧配置，后者在 agy 侧
 * 没有等价物。读失败 / 文件过大 / 解析失败都静默返回空（best-effort，
 * 看不见也比读坏强；这份名单只是为了不静默丢配置）。
 * @returns {Array<{name, reason, source}>}
 */
function droppedClaudeMcpNames(cwd) {
  try {
    const file = path.join(CFG.home, ".claude.json");
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 32 << 20) return [];
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return [];
    const out = [];
    // 两处循环共用一个 seen：同名既在顶层又在 projects[cwd] 里，只在 skipped 里出现一次
    const seen = new Set();
    const top = j.mcpServers;
    if (top && typeof top === "object" && !Array.isArray(top)) {
      for (const name of Object.keys(top)) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, reason: "in ~/.claude.json only (top-level) — agy-only: move it to ~/.gemini/config/mcp_config.json", source: "claude.json (not loaded)" });
      }
    }
    const projects = j.projects;
    if (projects && typeof projects === "object" && !Array.isArray(projects)) {
      for (const key of [cwd, path.resolve(cwd || CFG.workspace)]) {
        const proj = key ? projects[key] : null;
        const m = proj && proj.mcpServers;
        if (!m || typeof m !== "object" || Array.isArray(m)) continue;
        for (const name of Object.keys(m)) {
          if (seen.has(name)) continue;
          seen.add(name);
          out.push({ name, reason: "in ~/.claude.json projects[cwd] — no agy equivalent: move it to ~/.gemini/config/mcp_config.json", source: "claude.json (not loaded)" });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 组装本轮 ACP 会话要发给 agent 的 mcpServers（ACP 数组式）。
 * 优先级（同名冲突时后者胜出）：agy mcp_config.json < 设备 MCP。
 * ~/.claude.json 不再读：只在里面的服务器（见 droppedClaudeMcpNames）
 * 会进 skipped 露个名字，绝不进 servers。
 * 设备 MCP 由调用方按现有门控（PREFIX、脚本在、dev_status.on、非端侧）
 * 决定是否传入 deviceJson（deviceMcpConfig() 的 JSON 串），本函数只做转换。
 * 破甲扫描：先整份扫，通过直接用；命中则逐个服务扫，只剔除命中的服务，
 * 其余照常发送。blocked/skipped 只含服务名，绝不含 env/headers 值或扫描摘录。
 * @param {{ cwd?: string, deviceJson?: string|null }} opts
 * @returns {{ servers: Array, skipped: Array, blocked: Array<{name}> }}
 */
export function buildAcpMcpServers({ cwd = "", deviceJson = null } = {}) {
  const skipped = [];
  const agy = readAgyMcpConfigs();
  skipped.push(...agy.skipped);
  // A2：被丢掉的 Claude 旧配置只露名字，不进 servers。
  skipped.push(...droppedClaudeMcpNames(cwd));
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
  // 优先级：agy < device（device 同名冲突时胜出）。
  const merged = mergeAcpMcpServers(agy.servers, device);
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
