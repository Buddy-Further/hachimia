// ─────────────────────────────────────────────────────────────────────
//  agy-mcp.mjs —— ~/.gemini/config/mcp_config.json 的读写（P0-2）
//
//  实测（agy 1.5.13，见 ~/workspace/agy-verify/VERIFY-REPORT.md）：
//    · 真正的 MCP 配置文件是 ~/.gemini/config/mcp_config.json（`agy mcp add`
//      写这里，`agy mcp list` 读这里）；~/.gemini/antigravity-cli/settings.json
//      在首次运行后根本不存在——不要把 MCP 写去那里，也不要把它当 MCP 读来源。
//    · agy 写的形态：{"mcpServers": {"echo-test": {"args": [...], "command": "node",
//      "disabled": false}}}——stdio 条目没有 type 键（缺 type 即 stdio，与
//      mcp-acp.mjs 的转换器一致）；http/sse 带 type + url。
//    · agy 在 `agy acp` 启动时自己加载并初始化这里的 MCP 服务器（实测 MCP
//      客户端直连），所以写进这个文件就应能到达 ACP 会话；session/new 再传
//      mcpServers 是否被接受仍未验证（未登录时 auth 门禁在前）。
//
//  迁移决策（P0-2）：READ-BOTH-WRITE-AGY（仅 MCP）——新装只写 mcp_config.json，
//  ~/.claude.json 的旧服务器靠读两边继续工作（agy 同名胜出，见 extensions.mjs）；
//  不做一次性迁移（会丢配置/孤立安装）、不双写（会漂移）。钩子 / 插件 / 输出风格
//  没有可验证的 agy 写目标，本节不动它们，仍走 Claude 侧。
//
//  写：直接改 JSON，不调 `agy mcp add` 子进程——无二进制也能测，EXT_LOCK、
//  回滚、破甲扫描都留在网关手里；edit 的合并 / dropEnv 语义本来就需要 JSON。
//
//  安全：沿用 syncAgySettings（claude.mjs）的 A14 写法——解析失败 / 非对象时
//  原文件原样保留并报错，绝不静默重置；只动 mcpServers 一个键，其余键原样保留；
//  没变不写文件；原子写：同目录随机临时文件 O_EXCL 0600 + fsync + rename。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { CFG, PATHS, log } from "./config.mjs";

/** userconf.mjs 盯的相对路径（和 PATHS.agyMcpConfig 同一个文件，别各写一份） */
export const AGY_MCP_REL = ".gemini/config/mcp_config.json";
/** agy MCP 配置文件（~/.claude.json 之外的另一处 MCP 写目标） */
export const CLAUDE_JSON = path.join(CFG.home, ".claude.json");

const MAX_CFG_BYTES = 1 << 20;

/** 仅测试用：让第 N 次原子写失败（模拟磁盘故障），测回滚用；生产代码不碰它。
 *  failAfterWrites = 0 → 下一次写就失败；= 1 → 下一次成功、再下一次失败；< 0 → 关掉。 */
export const _agyMcpTest = { failAfterWrites: -1 };

/**
 * 安全读一份 JSON 配置（只读，不修不建）。
 * @returns {{ ok: true, obj: object, exists: boolean } | { ok: false, error: string }}
 *   缺文件 → ok、空对象；解析失败 / 非对象 / 过大 → ok:false，原文件不动。
 */
export function readJsonFileSafe(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) {
    if (e && e.code === "ENOENT") return { ok: true, obj: {}, exists: false };
    return { ok: false, error: `读 ${file} 失败：${e.message}` };
  }
  if (!st.isFile() || st.size > MAX_CFG_BYTES) return { ok: false, error: `${file} 不是普通文件或超过 1 MB` };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { ok: false, error: `${file} 解析失败：${e.message}` }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: `${file} 不是 JSON 对象` };
  return { ok: true, obj, exists: true };
}

/** 原子写一份 JSON 配置（目录不存在就建；临时文件 O_EXCL 0600 + fsync + rename）。 */
export function writeJsonFileAtomic(file, obj) {
  if (_agyMcpTest.failAfterWrites >= 0) {
    if (_agyMcpTest.failAfterWrites === 0) { _agyMcpTest.failAfterWrites = -1; return { ok: false, error: "测试注入：写入失败" }; }
    _agyMcpTest.failAfterWrites--;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, file); }
    catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
    return { ok: true };
  } catch (e) {
    log(`[agy-mcp] 写入 ${file} 失败：${e.message}`);
    return { ok: false, error: `写入 ${file} 失败：${e.message}` };
  }
}

/**
 * 读-改-写一份 JSON 配置：edit(obj) 就地改，返回 false 表示不用写。
 * 没变不写文件；读失败直接返回 error，不动原文件。
 * @returns {{ ok: true, changed: boolean } | { ok: false, error: string }}
 */
export function updateJsonFile(file, edit) {
  const r = readJsonFileSafe(file);
  if (!r.ok) return { ok: false, error: r.error };
  const before = JSON.stringify(r.obj);
  let want = true;
  try { want = edit(r.obj); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  if (want === false || JSON.stringify(r.obj) === before) return { ok: true, changed: false };
  return writeJsonFileAtomic(file, r.obj);
}

/** 只读 agy 的 mcpServers（best-effort 的调用方用 agyMcpDefs；这里返回原始结果）。 */
export function readAgyMcp() {
  const r = readJsonFileSafe(PATHS.agyMcpConfig);
  if (!r.ok) return { ok: false, error: r.error };
  const servers = r.obj.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers)))
    return { ok: false, error: "mcpServers 不是对象" };
  return { ok: true, servers: servers || {}, exists: r.exists };
}

/**
 * agy 原生形态归一：stdio 条目不带 type（`agy mcp add` 的写法，缺 type 即 stdio），
 * http/sse 带 type；disabled 不是布尔就补 false（agy 自己写 disabled:false）。
 * 只动这三个点，其余字段（command/args/env/url/headers…）原样保留。
 */
export function normaliseAgyMcpDef(def) {
  if (!def || typeof def !== "object" || Array.isArray(def)) return def;
  const out = { ...def };
  if (out.type === "stdio" || (!out.type && !out.url)) delete out.type;
  if (typeof out.disabled !== "boolean") out.disabled = false;
  return out;
}

/**
 * 写 / 删 agy 里一条 MCP：def 为 null 时删 key，否则按 agy 原生形态写入。
 * mcpServers 键本身不是对象时拒绝（不静默覆盖别人的数据）。
 */
export function setAgyMcpServer(name, def) {
  return updateJsonFile(PATHS.agyMcpConfig, (obj) => {
    if (obj.mcpServers === undefined) obj.mcpServers = {};
    if (!obj.mcpServers || typeof obj.mcpServers !== "object" || Array.isArray(obj.mcpServers))
      throw new Error("mcpServers 不是对象，先修好它");
    if (def == null) {
      if (!(name in obj.mcpServers)) return false;
      delete obj.mcpServers[name];
    } else {
      obj.mcpServers[name] = normaliseAgyMcpDef(def);
    }
  });
}
