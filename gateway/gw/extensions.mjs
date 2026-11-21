import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { CFG, PATHS, PREFIX, log, tz } from "./config.mjs";
import { agyEnv, claudeBlocked, claudeCmd, claudeEnv, ensureShell, killTree } from "./claude.mjs";
import { SID_RE, skillDirOk, zipReadAsync } from "./sessionops.mjs";
import { NEXT, readBody, readBodyBuf, sendJson } from "./http.mjs";
import { termEnv } from "./terminal.mjs";
import { COMP_DIR, compIndex, compIndexCache, compRecord } from "./components.mjs";
import { retrustProject } from "./projtrust.mjs";
import { ucAppBegin, ucAppWrote } from "./userconf.mjs";
import { sealed } from "./edition.mjs";
import { readHeadFile, readSmallFile } from "./saferead.mjs";
import { extIdOk, extOff, saveExtOff } from "./extoff.mjs";
import { AGY_MCP_REL, readAgyMcp, setAgyMcpServer } from "./agy-mcp.mjs";
import { scanText } from "./breach.mjs";
import { modulesInfo } from "./modules.mjs";
import { RETENTION_DAYS } from "./retention.mjs";

// ── 扩展：插件 / 技能 / MCP ───────────────────────────────────────────
// 插件、钩子、技能仍转给 claude 自己的命令行或直接改 ~/.claude 下的配置——
// 格式随 claude 版本变，自己写迟早写坏。技能目录（~/.claude/skills）例外：它就是一堆文件夹，没有命令。
// MCP 例外（P0-2b，agy-only）：只读、只写 agy 的 ~/.gemini/config/mcp_config.json
// （已验证版本实测，见 agy-mcp.mjs），直接改 JSON，不调 `claude mcp add/remove`，
// 也不再读 ~/.claude.json——那是另一个独立应用（cccodroid）的配置，本项目不从
// 那里迁移。钩子 / 插件 / 输出风格没有可验证的 agy 写目标，本节不动它们，仍走 Claude 侧。
// 同一时刻只跑一个改配置的命令，免得两个安装同时写 settings.json。
let EXT_LOCK = Promise.resolve();
function extRun(args, timeoutMs = 180000) {
  const job = EXT_LOCK.then(() => claudeBlocked()).then((blocked) => blocked ? { code: -1, out: "", err: blocked } : new Promise((resolve) => {
    const [cmd0, args0] = claudeCmd(args);
    const ucb = writes ? ucAppBegin() : null;
    const child = spawn(cmd0, args0, {
      cwd: fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home,
      env: claudeEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let out = "", err = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => killTree(child), timeoutMs);
    child.on("close", (code) => { clearTimeout(t); appWrote(code === 0 ? ucb : null); resolve({ code, out, err }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
  }));
  // 装卸插件是应用替用户做的：这次命令改到的当场认下，别下一轮反过来问他（见 userconf.mjs）。命令失败的不认，下一轮照问。
  // MCP 不走这里：P0-2 起直接改 ~/.gemini/config/mcp_config.json 的 JSON（见 agy-mcp.mjs），
  // extRun 只剩插件 / 市场 shell-out；MCP 列表状态走 `agy mcp list`（见 listMcp），
  // MCP 写走 mcpWriteJob，写完自己向 userconf 认下。
  // 只认对应的地方：插件只动 plugins/ 和设置里的 enabledPlugins / extraKnownMarketplaces
  const writes = args[0] === "plugin" && !args.includes("list") && !args.includes("get");
  const appWrote = (ucb) => {
    if (!writes) return;
    ucAppWrote([".claude/settings.json", ".claude/plugins/"], ucb, { ".claude/settings.json": ["enabledPlugins", "extraKnownMarketplaces"] });
  };
  EXT_LOCK = job.catch(() => {});
  return job;
}
const lastJson = (s) => {
  const lines = String(s).trim().split("\n").reverse();
  for (const l of lines) { try { return JSON.parse(l); } catch {} }
  try { return JSON.parse(String(s).slice(String(s).indexOf("{"))); } catch {}
  try { return JSON.parse(String(s).slice(String(s).indexOf("["))); } catch {}
  return null;
};
const cliMsg = (r) => (r.err || r.out || "").replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-600);

let PLUGIN_CATALOG = null;   // 可安装清单有三千多条，缓存 10 分钟，搜索在网关这边做
async function pluginState(withAvailable) {
  const fresh = PLUGIN_CATALOG && Date.now() - PLUGIN_CATALOG.at < 600000;
  const r = await extRun(["plugin", "list", "--json", ...(withAvailable && !fresh ? ["--available"] : [])], 120000);
  const j = lastJson(r.out);
  if (!j) throw new Error(cliMsg(r) || "claude plugin list 没有输出");
  const installed = Array.isArray(j) ? j : j.installed || [];
  if (!Array.isArray(j) && j.available) PLUGIN_CATALOG = { at: Date.now(), list: j.available };
  return installed;
}

async function listPlugins(q, offset, withAvailable) {
  const installed = await pluginState(withAvailable);
  const ids = new Set(installed.map((p) => p.id));
  const res = {
    installed: installed.map((p) => ({ id: p.id, version: p.version, scope: p.scope, enabled: p.enabled !== false, installedAt: p.installedAt })),
  };
  if (withAvailable && PLUGIN_CATALOG) {
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const hit = PLUGIN_CATALOG.list.filter((p) => {
      if (ids.has(p.pluginId)) return false;
      const hay = (p.name + " " + (p.description || "") + " " + p.marketplaceName).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    res.total = hit.length;
    res.available = hit.slice(offset, offset + 40).map((p) => ({
      id: p.pluginId, name: p.name, description: String(p.description || "").slice(0, 300),
      marketplace: p.marketplaceName, version: p.version || null,
    }));
  }
  return res;
}

/** 安装：有的插件要靠执行一条命令装（或拉包时要跑 headersHelper）。claude 会先把这条命令亮出来，
 *  不经人点头不装 —— 这里也一样：先不带确认跑一次，拿到命令和它的 sha256 交给界面，用户同意后再带 --accept-command 装。 */
// 界面传来的名字、地址原样进 claude 的命令行：横线开头会被当成 claude 自己的选项（11-01 独立审查低-2）
function badArg(...xs) {
  return xs.some((x) => x != null && (!x || x.length > 1024 || x.startsWith("-") || /[\x00-\x1f\x7f]/.test(x)));
}

async function installPlugin(id, accept) {
  if (badArg(id, accept)) return { ok: false, message: tz("名字格式不对") };
  const r = await extRun(["plugin", "install", id, "--json", ...(accept ? ["--accept-command", accept] : [])], 600000);
  const j = lastJson(r.out) || {};
  const shown = j.shownCommand || j.command;
  if (r.code !== 0 && shown && shown.sha256 && !accept) {
    return { ok: false, needConfirm: true, command: shown.command || shown.display || JSON.stringify(shown), sha256: shown.sha256 };
  }
  return r.code === 0 ? { ok: true } : { ok: false, message: j.error || j.message || cliMsg(r) };
}

async function pluginOp(op, id) {
  if (badArg(id)) return { ok: false, message: tz("名字格式不对") };
  const args = op === "uninstall" ? ["plugin", "uninstall", id, "--json"] : ["plugin", op, id];
  const r = await extRun(args, 120000);
  const j = lastJson(r.out) || {};
  return r.code === 0 ? { ok: true } : { ok: false, message: j.error || j.message || cliMsg(r) };
}

async function listMarketplaces() {
  const r = await extRun(["plugin", "marketplace", "list", "--json"], 60000);
  const j = lastJson(r.out);
  return Array.isArray(j) ? j.map((m) => ({ name: m.name, source: m.source?.repo || m.source?.url || m.source?.path || m.url || "" })) : [];
}

async function marketplaceOp(op, arg) {
  if (badArg(String(arg ?? ""))) return { ok: false, message: tz("名字格式不对") };
  const r = await extRun(["plugin", "marketplace", op, arg], 300000);
  if (r.code === 0) PLUGIN_CATALOG = null;
  return r.code === 0 ? { ok: true } : { ok: false, message: cliMsg(r) };
}

/** `agy mcp list` 的输出（已验证版本实测，见 VERIFY-REPORT 与 P0-2b 探针）：
 *  表格，首行 `NAME TYPE STATUS COMMAND/URL`，每行「名字 类型 enabled|disabled 命令/地址」，
 *  列之间是空格对齐；空时一行 `No MCP servers configured.`；没有 --json。注意它只报
 *  enabled/disabled，不做连通检查——这里的 ok 意思是「已启用」，不是「已连通」。
 *  解析不上来（格式变了、二进制不在、超时）就返回 null：调用方只按文件列，
 *  列表照常工作，不拿猜出来的状态骗人。 */
function parseAgyMcpList(out) {
  const rows = [];
  for (const line of String(out || "").split("\n")) {
    const t = line.trim();
    if (!t || t === "No MCP servers configured." || /^NAME\s+TYPE\s+STATUS\s+COMMAND\/URL/i.test(t)) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 3) continue;
    const [name, type, status, ...rest] = parts;
    if (!/^(stdio|http|sse)$/i.test(type) || !/^(enabled|disabled)$/i.test(status)) continue;
    rows.push({ name, type: type.toLowerCase(), enabled: status.toLowerCase() === "enabled", target: rest.join(" ") });
  }
  return rows;
}
/** 只读跑 `agy mcp list`：sync:false——只读操作不得触发 agyEnv 的 settings 同步写。
 *  失败（没装、二进制坏了、超时）返回 null，不抛。 */
function agyMcpList() {
  const bin = PATHS.agy;
  if (!bin || !fs.existsSync(bin)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ["mcp", "list"], {
      cwd: fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home,
      env: agyEnv({ sync: false }), encoding: "utf8", timeout: 15000, maxBuffer: 1 << 20,
    }, (err, stdout) => resolve(err ? null : String(stdout || "")));
  });
}
/** MCP 列表：文件（agy 的 mcp_config.json）为准，`agy mcp list` 只补启用状态。
 *  文件里没有的（agy 外部配的、或 `agy mcp disable` 停掉的）按 live 输出原样列，
 *  来源标 external；停用名单里的照旧单独列成 disabled。 */
async function listMcp() {
  const live = new Map();
  const out = await agyMcpList().catch(() => null);
  if (typeof out === "string") for (const r of parseAgyMcpList(out)) live.set(r.name, r);
  const byName = new Map();
  for (const [name, lv] of live) {
    byName.set(name, { name, target: lv.target, ok: lv.enabled, status: lv.enabled ? "enabled" : "disabled",
      user: false, hdr: "" });
  }
  for (const [name, { def, source }] of listMcpDefs()) {
    const cur = byName.get(name);
    if (cur) { cur.user = true; cur.hdr = headerNames(def); cur.source = source; }
    else byName.set(name, { name, target: mcpTarget(def), ok: false, status: "", user: true, hdr: headerNames(def), source });
  }
  // 停用名单里的照旧单独列成 disabled——而且它赢过 live / 文件里的同名条目：
  // 同名被外部用 `agy mcp add` 加回来时，getMcp() 照样报 disabled:true/off-list、
  // enableMcp 也拒绝（文件里已有同名），列表再显示 enabled 就是列表与详情各说各话。
  // 停用名单赢，列表与详情一致；用户点「启用」会先被拦下、去删掉外部加回的那一份。
  for (const [name, d] of Object.entries(extOff().mcp)) byName.set(name, { name, target: mcpTarget(d), ok: false, status: "", disabled: true, source: "off-list" });
  // 文件里没有定义的（agy 外部配的）：既不是 agy 文件也不是停用名单，标 external，别冒充来源
  for (const e of byName.values()) if (!e.source) e.source = "external";
  return [...byName.values()];
}

// ── MCP 写目标（P0-2）：~/.gemini/config/mcp_config.json，直接改 JSON ──
// 全部 MCP 写（add/remove/edit/disable/enable）都串在这把锁上，和以前调 claude mcp
// 时的 EXT_LOCK 同一把；写完向 userconf 认下这次改动（只认 mcpServers 一个键）。
function mcpWriteJob(fn) {
  const job = EXT_LOCK.then(() => fn());
  EXT_LOCK = job.catch(() => {});
  return job;
}
/** 写前过破甲扫描（和 seal.mjs 发 --mcp-config 之前扫同一份内容一个口径）：命中就拒绝写。值里可能有令牌，命中细节不记日志、不回显。 */
function mcpBreachOk(def) {
  if (scanText(JSON.stringify(def)).blocked) return { ok: false, message: tz("这条 MCP 配置没通过安全检查，拒绝写入") };
  return null;
}
/** 新装 MCP：直接写 agy 的 mcp_config.json（P0-2），不再调 `claude mcp add`。
 *  同名已存在（agy / 停用名单任一处）就拒绝，不静默盖掉或留影子。
 *  stdio 存 agy 原生形态（无 type 键，disabled:false）；http/sse 带 type + url。 */
export async function addMcp(b) {
  const name = String(b.name || "").trim();
  // 横线开头的名字会被 badArg 挡下（名字只许字母、数字、点、下划线、横线，且不能以横线开头）
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || badArg(name)) return { ok: false, message: tz("名字只能用字母、数字、点、下划线、横线") };
  const transport = ["stdio", "http", "sse"].includes(b.transport) ? b.transport : "stdio";
  const target = String(b.target || "").trim();
  if (!target) return { ok: false, message: tz("缺少命令或地址") };
  // http / sse 的地址是位置参数：只收 http(s) 网址，别的（横线开头、控制字符）不进命令行
  if (transport !== "stdio" && (badArg(target) || !/^https?:\/\/[^\s]+$/i.test(target))) return { ok: false, message: tz("地址要以 http:// 或 https:// 开头") };
  const envs = [].concat(b.env || []);
  // http / sse 没有子进程，-e 无处注入。前端已拦，这里再挡一次（API 直调 / 旧版页面），
  // 免得把 Authorization=Bearer … 当成环境变量，生成一条不带令牌、注定 401 的配置。
  if (transport !== "stdio" && envs.length) return { ok: false, message: tz("远程 MCP 不支持环境变量：请求头要写成 Header: 值，例如 Authorization: Bearer 你的令牌") };
  const headers = {};
  for (const h of [].concat(b.headers || [])) {
    if (!String(h).includes(":")) continue;
    const i = String(h).indexOf(":");
    headers[String(h).slice(0, i).trim()] = String(h).slice(i + 1).trim();
  }
  let def;
  if (transport !== "stdio") {
    def = { type: transport, url: target, ...(Object.keys(headers).length ? { headers } : {}), disabled: false };
  } else {
    const parts = target.match(/"[^"]*"|'[^']*'|\S+/g).map((x) => x.replace(/^(["'])(.*)\1$/, "$2"));
    if (!parts.length) return { ok: false, message: tz("缺少命令或地址") };
    const env = {};
    for (const kv of envs) if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(kv)) { const i = kv.indexOf("="); env[kv.slice(0, i)] = kv.slice(i + 1); }
    def = { command: parts[0], ...(parts.length > 1 ? { args: parts.slice(1) } : {}),
      ...(Object.keys(env).length ? { env } : {}), disabled: false };
  }
  const breach = mcpBreachOk(def);
  if (breach) return breach;
  return mcpWriteJob(async () => {
    const ucb = ucAppBegin();
    if (userMcpSource(name) || extOff().mcp[name]) return { ok: false, message: tz("已经有叫这个名字的 MCP 服务器了") };
    const r = setAgyMcpServer(name, def);
    if (!r.ok) return { ok: false, message: tz("写不进 agy 的 MCP 配置：{msg}", { msg: r.error }) };
    ucAppWrote([AGY_MCP_REL], ucb, { [AGY_MCP_REL]: ["mcpServers"] });
    return { ok: true };
  });
}

/** 删除 MCP：只删 agy 的 mcp_config.json 里那一份。~/.claude.json 里的同名
 *  旧配置（如果有）不再碰——那是另一个应用的配置，删就是替用户删别人的数据；
 *  它也不会再「复活」（ACP 与列表都不再读它）。停用名单不动（见 forgetMcp）。 */
export async function removeMcp(name) {
  if (badArg(String(name ?? ""))) return { ok: false, message: tz("名字格式不对") };
  return mcpWriteJob(async () => {
    const ucb = ucAppBegin();
    if (!userMcpDef(String(name))) return { ok: false, message: tz("找不到这条 MCP 配置") };
    const r = setAgyMcpServer(String(name), null);
    if (!r.ok) return { ok: false, message: tz("删不掉 agy 的 MCP 配置：{msg}", { msg: r.error }) };
    ucAppWrote([AGY_MCP_REL], ucb, { [AGY_MCP_REL]: ["mcpServers"] });
    return { ok: true };
  });
}

/** stdio MCP 参数拼回单行命令行时按需加引号，避免含空格 / 引号的参数在编辑保存时被切碎 */
export function quoteStdioArg(v) {
  const s = String(v);
  if (s === "") return '""';
  if (!/[\s"'\\]/.test(s)) return s;
  return '"' + s.replace(/([\\"])/g, "\\$1") + '"';
}
/** 拆单行 stdio MCP 命令行：支持双引号内转义（\"、\\）与单引号，与 quoteStdioArg 互逆 */
export function parseStdioTarget(target) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(String(target || ""))); ) {
    if (m[1] != null) out.push(m[1].replace(/\\([\\"])/g, "$1"));
    else if (m[2] != null) out.push(m[2]);
    else out.push(m[3]);
  }
  return out;
}

/** 编辑表单预填：命令/地址 + 现有环境变量、请求头的名字。值可能是令牌，不发到前端（留空 = 保留原值）。
 *  停用名单里的也能编辑（改名单里的定义，启用时按新定义加回）。 */
export async function getMcp(b) {
  const name = String(b.name || "").trim();
  const off = extOff();
  const disabled = !!(extIdOk(name) && off.mcp[name]);
  const def = disabled ? off.mcp[name] : userMcpDef(name);
  if (!def) return { ok: false, message: tz("找不到这条 MCP 配置（账户连接器不能编辑）") };
  const stdio = def.type !== "http" && def.type !== "sse";
  return { ok: true, name, transport: stdio ? "stdio" : def.type,
    target: stdio ? [def.command, ...(Array.isArray(def.args) ? def.args : [])].filter((x) => x != null).map(quoteStdioArg).join(" ") : String(def.url || ""),
    envNames: Object.keys(def.env || {}), headerNames: Object.keys(def.headers || {}),
    ...(disabled ? { disabled: true, source: "off-list" } : { source: userMcpSource(name) }) };
}

/** 编辑 = 直接改 agy 的 mcp_config.json（P0-2，不再 remove + add-json）。
 *  写回用 JSON：定义整体作为单个对象，值里的逗号、等号、引号、换行都不会被切坏。
 *  只写 agy：~/.claude.json 里的同名旧定义（如果有）留着不动，也不再生效——
 *  ACP 与列表都不再读它。
 *  改名是搬家：新名写进 agy，旧名从 agy 里删掉，不然旧名还活着；
 *  删旧名失败就回滚（删新名、把旧定义写回去）。 */
export async function editMcp(b) {
  const name = String(b.name || "").trim();
  const off = extOff();
  const disabled = !!(extIdOk(name) && off.mcp[name]);
  const def = disabled ? off.mcp[name] : userMcpDef(name);
  if (!def) return { ok: false, message: tz("找不到这条 MCP 配置（账户连接器不能编辑）") };
  const newName = String(b.newName || name).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(newName) || badArg(newName)) return { ok: false, message: tz("名字只能用字母、数字、点、下划线、横线") };
  // 两边名单都要查：停用条目改名成活跃条目（或反过来）会留下同名幽灵，列表只显示一条、另一条会「复活」
  if (newName !== name && (!!off.mcp[newName] || !!userMcpDef(newName))) return { ok: false, message: tz("已经有叫这个名字的 MCP 服务器了") };
  const transport = ["stdio", "http", "sse"].includes(b.transport) ? b.transport : (def.type === "http" || def.type === "sse" ? def.type : "stdio");
  const target = String(b.target || "").trim();
  if (!target) return { ok: false, message: tz("缺少命令或地址") };
  if (transport !== "stdio" && (badArg(target) || !/^https?:\/\/[^\s]+$/i.test(target))) return { ok: false, message: tz("地址要以 http:// 或 https:// 开头") };
  const envs = [].concat(b.env || []).filter((kv) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(kv));
  if (transport !== "stdio" && envs.length) return { ok: false, message: tz("远程 MCP 不支持环境变量：请求头要写成 Header: 值，例如 Authorization: Bearer 你的令牌") };
  const hdrs = [].concat(b.headers || []).filter((h) => String(h).includes(":") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(h));
  // 合并语义：留空 = 保留原值；同名的以这次提交的为准；点掉的（dropEnv / dropHeaders）从配置里删
  const merged = (oldObj, drops, news, splitAt) => {
    const out = {};
    for (const [k, v] of Object.entries(oldObj || {})) if (!drops.has(k)) out[k] = v;
    for (const s of news) { const i = s.indexOf(splitAt); if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim(); }
    return out;
  };
  const dropEnv = new Set([].concat(b.dropEnv || []).map(String).filter((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x)));
  const dropHdr = new Set([].concat(b.dropHeaders || []).map((x) => String(x).trim()).filter(Boolean));
  let nd;
  if (transport !== "stdio") {
    // 前端已拦 KEY=值，这里不再赘述；重建后 env 键不该存在（agy 的远程条目不写 env）
    nd = { ...def, type: transport, url: target, headers: merged(def.headers, dropHdr, hdrs, ":") };
    delete nd.command; delete nd.args; delete nd.env;
    if (!Object.keys(nd.headers).length) delete nd.headers;
  } else {
    const parts = parseStdioTarget(target);
    if (!parts.length) return { ok: false, message: tz("缺少命令或地址") };
    // agy 的 stdio 条目不存 headers（`agy mcp add` 的 stdio 形态没有 headers 键）：这里显式删，
    // 别让「保存成功」之后令牌悄悄没了（前端在切 transport 时会先弹确认）
    nd = { ...def, type: "stdio", command: parts[0], args: parts.slice(1), env: merged(def.env, dropEnv, envs, "=") };
    delete nd.url; delete nd.headers;
    if (!Object.keys(nd.env).length) delete nd.env;
  }
  const breach = mcpBreachOk(nd);
  if (breach) return breach;
  // 停用中的条目没连 agy：只改停用名单，启用时按新定义加回，不碰配置文件
  if (disabled) {
    if (newName !== name) delete off.mcp[name];
    off.mcp[newName] = nd;
    return saveExtOff(off) ? { ok: true } : { ok: false, message: tz("停用名单写不进去") };
  }
  return mcpWriteJob(() => execEdit(name, newName, nd, def));
}

/** 写新定义 → 删旧名；删旧名失败就回滚（删新名、把旧定义写回 agy）。
 *  同名编辑是单次原子写，失败时文件根本没动，不需要回滚。
 *  回滚的每一步都查返回值：回滚本身也可能写失败，那时不许再报「已原样恢复」，
 *  要如实说哪一步没恢复（调用方据此告诉用户手动检查）。 */
function execEdit(name, newName, nd, oldDef) {
  const ucb = ucAppBegin();
  // 锁内复核（TOCTOU）：editMcp 进锁前的重名检查和这里之间，另一个并发的
  // addMcp / editMcp 可能已经占了新名；mcpWriteJob 串行，进锁后再查一次，
  // 撞名就拒绝，不盖掉别人的定义。
  if (newName !== name) {
    const offNow = extOff();
    if (offNow.mcp[newName] || userMcpDef(newName)) return { ok: false, message: tz("已经有叫这个名字的 MCP 服务器了") };
  }
  // 回滚哪步失败就记哪步（删新名 / 恢复旧名），返回失败清单，空 = 回滚成功。
  const rollbackRename = () => {
    const failed = [];
    const r1 = setAgyMcpServer(newName, null);
    if (!r1.ok) failed.push(`删新名 ${newName} 失败：${r1.error}`);
    const r2 = setAgyMcpServer(name, oldDef);
    if (!r2.ok) failed.push(`恢复旧名 ${name} 失败：${r2.error}`);
    return failed;
  };
  if (newName === name) {
    const r = setAgyMcpServer(name, nd);
    if (!r.ok) return { ok: false, message: tz("保存失败：{msg}，旧配置没动", { msg: r.error }) };
    ucAppWrote([AGY_MCP_REL], ucb, { [AGY_MCP_REL]: ["mcpServers"] });
    return { ok: true };
  }
  // 删旧名失败时的统一出口：回滚（删新名、把旧定义写回 agy），成功才报「已原样恢复」。
  const failAfterRename = (err) => {
    const failed = rollbackRename();
    if (failed.length) return { ok: false, message: tz("保存失败：{msg}，回滚也没能恢复，请手动检查 agy 的 MCP 配置（{detail}）", { msg: err, detail: failed.join("；") }) };
    return { ok: false, message: tz("保存失败：{msg}，旧配置已原样恢复", { msg: err }) };
  };
  const w = setAgyMcpServer(newName, nd);
  if (!w.ok) return { ok: false, message: tz("保存失败：{msg}，旧配置没动", { msg: w.error }) };
  const d = setAgyMcpServer(name, null);
  if (!d.ok) return failAfterRename(d.error);
  ucAppWrote([AGY_MCP_REL], ucb, { [AGY_MCP_REL]: ["mcpServers"] });
  return { ok: true };
}

// 技能：~/.claude/skills/<名字>/SKILL.md（开头 YAML 里有 name / description）
// ── Hooks：到某个时刻自动跑的命令（claude 的 settings.json 里 "hooks" 一个键） ──
// claude 没有管 hooks 的命令行，只能直接改 settings.json：只动 hooks 一个键，其余原样保留；
// 「暂停全部」不写 disableAllHooks —— 它会连网关挂的敏感操作再确认一起关掉，网关因此每轮显式压成 false（见 claude.mjs settingsArgs），
// 改成把规则挪到旁边的 <settings>.ccapp-paused 里，恢复时挪回去；以前存的 disableAllHooks:true 头一次读写时照这个办法转过来。
// 写前留一份 .bak，和插件安装共用 EXT_LOCK，免得两边同时写。三处配置：用户级（所有项目）、项目级、项目本机级。
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "UserPromptSubmit", "Stop",
  "SubagentStart", "SubagentStop", "SessionStart", "SessionEnd", "Notification", "PreCompact", "PostCompact",
  "InstructionsLoaded", "ConfigChange", "TaskCompleted", "TeammateIdle", "WorktreeCreate", "Setup"];
const HOOK_SCRIPTS_DIR = path.join(CFG.home, ".claude", "hooks");
// 常用规则用到的小脚本（源码在 claude-apk/hooks/，用 hooks/embed.mjs 生成这一行）；添加规则时写进 ~/.claude/hooks/
const HOOK_SCRIPTS = {"cc-autosave.mjs":"// hachimia 内置 hook（Claude 答完一轮时）：项目是 git 仓库、且有改动，就自动提交一次存档。只提交，不推送。\n// 用法：node cc-autosave.mjs '自动存档'   （参数是提交说明的前缀，后面自动加时间）\nimport fs from \"node:fs\";\nimport { execFileSync } from \"node:child_process\";\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst cwd = j.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();\nconst git = (...a) => execFileSync(\"git\", a, { cwd, encoding: \"utf8\", stdio: [\"ignore\", \"pipe\", \"pipe\"] });\ntry { if (git(\"rev-parse\", \"--is-inside-work-tree\").trim() !== \"true\") process.exit(0); } catch { process.exit(0); }\ntry {\n  if (!git(\"status\", \"--porcelain\").trim()) process.exit(0);\n  git(\"add\", \"-A\");\n  const id = [];\n  try { git(\"config\", \"user.name\"); } catch { id.push(\"-c\", \"user.name=hachimia\"); }\n  try { git(\"config\", \"user.email\"); } catch { id.push(\"-c\", \"user.email=autosave@hachimia.local\"); }\n  const d = new Date(), p = (n) => String(n).padStart(2, \"0\");\n  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;\n  git(...id, \"commit\", \"-q\", \"-m\", `${process.argv[2] || \"自动存档\"} ${when}`);\n} catch (e) {\n  process.stderr.write(\"自动存档失败：\" + String(e.stderr || e.message).slice(0, 300) + \"\\n\");\n}\n","cc-bash-log.mjs":"// hachimia 内置 hook（用完工具之后，只管 Bash）：把 Claude 跑过的命令记进日志，方便事后翻看。\n// 用法：node cc-bash-log.mjs [日志文件]   默认 ~/.claude/bash-history.log\nimport fs from \"node:fs\";\nimport path from \"node:path\";\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst cmd = String((j.tool_input || {}).command || \"\");\nif (!cmd) process.exit(0);\nconst file = process.argv[2] || path.join(process.env.HOME || \".\", \".claude\", \"bash-history.log\");\nconst d = new Date(), p = (n) => String(n).padStart(2, \"0\");\nconst when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;\ntry {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  fs.appendFileSync(file, `${when}\\t${j.cwd || \"\"}\\n  ${cmd.replace(/\\n/g, \"\\n  \")}\\n`);\n} catch {}\n","cc-format.mjs":"// hachimia 内置 hook（用完工具之后，管改文件的工具）：Claude 改完代码文件，用本机已装的格式化工具整理一遍。\n// 按扩展名找：ruff / black、prettier、gofmt、rustfmt、clang-format、shfmt，没装就什么也不做。\n// Markdown 和纯文本不碰（写作的稿子不该被工具改排版）。\nimport fs from \"node:fs\";\nimport path from \"node:path\";\nimport { spawnSync } from \"node:child_process\";\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst f = String((j.tool_input || {}).file_path || \"\");\nif (!f || !fs.existsSync(f)) process.exit(0);\nconst ext = path.extname(f).toLowerCase();\nconst T = {\n  \".py\": [[\"ruff\", \"format\", \"-q\"], [\"black\", \"-q\"]],\n  \".js\": [[\"prettier\", \"--write\", \"--log-level\", \"warn\"]], \".mjs\": 0, \".cjs\": 0, \".jsx\": 0, \".ts\": 0, \".tsx\": 0,\n  \".json\": 0, \".css\": 0, \".scss\": 0, \".html\": 0, \".vue\": 0, \".yaml\": 0, \".yml\": 0,\n  \".go\": [[\"gofmt\", \"-w\"]], \".rs\": [[\"rustfmt\", \"-q\"]],\n  \".c\": [[\"clang-format\", \"-i\"]], \".h\": 0, \".cc\": 0, \".cpp\": 0, \".hpp\": 0,\n  \".sh\": [[\"shfmt\", \"-w\"]],\n};\nlet list = T[ext];\nif (list === 0) list = [\".c\", \".h\", \".cc\", \".cpp\", \".hpp\"].includes(ext) ? T[\".c\"] : T[\".js\"];\nif (!list) process.exit(0);\nconst has = (b) => (process.env.PATH || \"\").split(\":\").some((d) => { try { fs.accessSync(path.join(d, b), fs.constants.X_OK); return true; } catch { return false; } });\nconst tool = list.find(([b]) => has(b));\nif (tool) spawnSync(tool[0], [...tool.slice(1), f], { stdio: \"ignore\", timeout: 20000 });\n","cc-guard-bash.mjs":"// hachimia 内置 hook（用工具之前，只管 Bash）：命令里出现这些内容就拦下。\n// 用法：node cc-guard-bash.mjs 'git push --force' '/git\\s+reset\\s+--hard/'\n// 普通写法按字面查找（空白宽松匹配）；写成 /…/ 就当正则。命中退出码 2，并告诉 Claude 原因。\nimport fs from \"node:fs\";\nconst pats = process.argv.slice(2).filter(Boolean);\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst cmd = String((j.tool_input || {}).command || \"\");\nif (!cmd) process.exit(0);\nconst flat = cmd.replace(/\\s+/g, \" \");\nconst hit = pats.find((p) => {\n  const m = /^\\/(.+)\\/([a-z]*)$/.exec(p);\n  if (m) { try { return new RegExp(m[1], m[2]).test(cmd); } catch { return false; } }\n  return flat.includes(p.replace(/\\s+/g, \" \"));\n});\nif (hit) {\n  process.stderr.write(`这条命令触发了禁止规则「${hit}」，已拦下：\\n${cmd.slice(0, 300)}\\n换一种更安全的做法；如果确实需要，请让用户自己执行。\\n`);\n  process.exit(2);\n}\n","cc-guard-files.mjs":"// hachimia 内置 hook（用工具之前）：不许 Claude 改动匹配这些模式的文件。\n// 用法：node cc-guard-files.mjs '.env' '*.pem' 'secrets/**'\n// 模式不带 / 时比对文件名，带 / 时比对完整路径；* 不跨目录，** 跨目录。命中就退出码 2 拦下，并告诉 Claude 原因。\nimport fs from \"node:fs\";\nconst pats = process.argv.slice(2).filter(Boolean);\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst i = j.tool_input || {};\nconst f = String(i.file_path || i.notebook_path || \"\");\nif (!f) process.exit(0);\nconst rx = (p) => new RegExp(\"^\" + p.replace(/[.+^${}()|[\\]\\\\]/g, \"\\\\$&\").replace(/\\*\\*/g, \"\\0\").replace(/\\*/g, \"[^/]*\")\n  .replace(/\\?/g, \"[^/]\").replace(/\\0/g, \".*\") + \"$\");\nconst base = f.split(\"/\").pop();\nconst hit = pats.find((p) => rx(p).test(p.includes(\"/\") ? f : base) || (p.includes(\"/\") && rx(\"**/\" + p).test(f)));\nif (hit) {\n  process.stderr.write(`这个文件受保护（规则「${hit}」），不要修改：${f}\\n如果确实需要改，请告诉用户，让用户自己处理。\\n`);\n  process.exit(2);\n}\n"};

function hookSettingsFile(scope, dir) {
  if (scope === "user") return path.join(CFG.home, ".claude", "settings.json");
  const d = path.resolve(String(dir || CFG.workspace));
  // 界面只管工作区这一份；别的目录不给读写（里面的 hooks 命令可能带密钥）
  if (d !== path.resolve(CFG.workspace)) throw new Error("only the workspace project is managed here");
  let ok = false;
  try { ok = fs.statSync(d).isDirectory(); } catch {}
  if (!ok) throw new Error("project dir not found: " + d);
  return path.join(d, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
}
function readSettingsFile(file) {
  // FIFO/设备/软链不能裸读：会同步阻塞或无限读（审查 11-05）
  const txt = readSmallFile(file, 1 << 20);
  if (txt == null) { try { fs.lstatSync(file); return { error: "unreadable or not a regular file", exists: true }; } catch { return { j: {}, exists: false }; } }
  if (!txt.trim()) return { j: {}, exists: true };
  try {
    const j = JSON.parse(txt);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
    return { j, exists: true };
  } catch (e) { return { error: e.message, badJson: true, exists: true }; }
}
const pausedFile = (file) => file + ".ccapp-paused";
function readPaused(file) {
  try { const raw = readSmallFile(pausedFile(file), 1 << 20); if (raw == null) return null; const h = JSON.parse(raw); return h && typeof h === "object" && !Array.isArray(h) ? h : null; } catch { return null; }
}
/** 扩展页「打开配置文件」：只读地看这三份 settings.json 的内容。
 *  用户级文件在 home 里，按路径政策不能经 /api/file 读；这里只按 hookSettingsFile 解析出的固定路径读，不接受任意路径（195-J.1） */
function hooksFileView(scope, dir) {
  const s = ["user", "project", "local"].includes(scope) ? scope : "user";
  const file = hookSettingsFile(s, dir);
  const txt = readSmallFile(file, 1 << 20);
  let exists = true;
  if (txt == null) { try { fs.lstatSync(file); } catch { exists = false; } }
  return { ok: true, file, exists, text: txt == null ? "" : txt, unreadable: txt == null && exists };
}
export function listHooks(dir) {
  const scopes = [];
  for (const scope of ["user", "project", "local"]) {
    let file;
    try { file = hookSettingsFile(scope, dir); } catch (e) { scopes.push({ scope, error: e.message }); continue; }
    const r = readSettingsFile(file);
    const paused = readPaused(file);
    const h = paused || (r.j && r.j.hooks);
    // 事件名只放字母的（和保存时 cleanHooks 一个规矩）；配置文件可能来自克隆的仓库，怪名字不往界面送
    const hooks = {};
    if (h && typeof h === "object" && !Array.isArray(h)) for (const [ev, v] of Object.entries(h)) if (/^[A-Za-z]{1,40}$/.test(ev)) hooks[ev] = v;
    scopes.push({ scope, file, exists: r.exists, error: r.error, badJson: !!r.badJson,
      hooks, disableAll: !!paused || !!(r.j && r.j.disableAllHooks) });
  }
  return { scopes, events: HOOK_EVENTS, workspace: CFG.workspace, dir: path.resolve(String(dir || CFG.workspace)), scriptsDir: HOOK_SCRIPTS_DIR };
}
/** 界面送回来的整份 hooks：结构不对就拒绝；空组、空命令剔掉；不认识的字段（prompt / http 类 hook 等）原样留着 */
function cleanHooks(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error("hooks must be an object");
  const out = {};
  for (const [ev, groups] of Object.entries(h)) {
    if (!/^[A-Za-z]+$/.test(ev)) throw new Error("bad event name: " + ev);
    if (!Array.isArray(groups)) throw new Error(ev + " must be an array");
    const gs = [];
    for (const g of groups) {
      if (!g || typeof g !== "object" || !Array.isArray(g.hooks)) throw new Error(ev + ": every entry needs a hooks array");
      const hs = g.hooks.filter((x) => x && typeof x === "object" && x.type && !(x.type === "command" && !String(x.command || "").trim()));
      if (!hs.length) continue;
      const ng = { ...g, hooks: hs };
      if (ng.matcher === "" || ng.matcher == null) delete ng.matcher;
      gs.push(ng);
    }
    if (gs.length) out[ev] = gs;
  }
  return out;
}
export function saveHooks({ scope, dir, hooks, disableAll }) {
  if (!["user", "project", "local"].includes(scope)) throw new Error("bad scope");
  const file = hookSettingsFile(scope, dir);
  const clean = hooks === undefined ? undefined : cleanHooks(hooks);
  const job = EXT_LOCK.then(() => {
    const r = readSettingsFile(file);
    if (r.error) { const e = new Error(r.error); e.code = r.badJson ? "badjson" : "read"; throw e; }
    const j = r.j;
    let paused = readPaused(file);
    if (j.disableAllHooks === true) { paused = { ...(j.hooks || {}), ...(paused || {}) }; delete j.hooks; }   // 旧的暂停办法：转过来
    delete j.disableAllHooks;
    const pause = disableAll !== undefined ? !!disableAll : !!paused;
    const want = clean !== undefined ? clean : (paused || j.hooks || {});
    const ucb = scope === "user" ? ucAppBegin() : null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (r.exists) { try {
      const bakTmp = file + ".bak.tmp-" + process.pid;
      fs.copyFileSync(file, bakTmp);
      fs.renameSync(bakTmp, file + ".bak");   // rename 替换软链本身，不会跟着链接写到别处
    } catch {} }
    const put = (dst, obj) => { const tmp = dst + ".tmp-" + process.pid; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n"); fs.renameSync(tmp, dst); };
    if (pause) { put(pausedFile(file), want); delete j.hooks; }      // 先把规则存好，再从生效的配置里拿掉
    else if (Object.keys(want).length) j.hooks = want; else delete j.hooks;
    put(file, j);
    if (!pause) try { fs.unlinkSync(pausedFile(file)); } catch {}
    log(`hooks 已保存：${file}`);
    if (scope !== "user") retrustProject(path.dirname(path.dirname(file)));
    else ucAppWrote([".claude/settings.json"], ucb, { ".claude/settings.json": ["hooks"] });   // 用户在扩展页亲手改的钩子：只认 hooks 这一块（见 userconf.mjs）
    return { ok: true, file };
  });
  EXT_LOCK = job.catch(() => {});
  return job;
}
/** 网关启动时：以前用 disableAllHooks:true 暂停的，转成挪开的办法（不然网关压成 false 后它们会重新跑起来）。
 *  用户级 + 工作区的项目级、本机级（界面管的就这三份，DeepSeek 复核建议 8）；别的项目里的照旧按项目配置确认（projtrust.mjs）处理 */
export async function migrateHookPause() {
  for (const scope of ["user", "project", "local"]) {
    let file; try { file = hookSettingsFile(scope); } catch { continue; }
    const r = readSettingsFile(file);
    if (!(r.j && r.j.disableAllHooks === true)) continue;
    try { await saveHooks({ scope }); log(`hooks 的「暂停全部」已改成挪开保存：${file}`); }
    catch (e) { log(`转换 hooks 暂停失败（${file}）：${e.message}`); }
  }
}
function installHookScripts() {
  const ucb = ucAppBegin();
  fs.mkdirSync(HOOK_SCRIPTS_DIR, { recursive: true });
  for (const [name, src] of Object.entries(HOOK_SCRIPTS)) fs.writeFileSync(path.join(HOOK_SCRIPTS_DIR, name), src);
  ucAppWrote([".claude/hooks/"], ucb);
  return { ok: true, dir: HOOK_SCRIPTS_DIR };
}
/** 试运行用的 stdin：照 claude 真实传给 hook 的 JSON 造一份（工具类事件按匹配规则挑个像样的工具） */
function hookSample(ev, matcher, cwd) {
  const base = { session_id: "hachimia-test", transcript_path: "", cwd, permission_mode: "default", hook_event_name: ev };
  const m = String(matcher || "");
  const tool = !m || m === "*" || /Bash/.test(m) ? "Bash" : /Write/.test(m) ? "Write" : /Edit/.test(m) ? "Edit" : (m.match(/[A-Za-z_]+/) || ["Bash"])[0];
  const input = tool === "Bash" ? { command: "echo hello", description: "test" }
    : tool === "Write" ? { file_path: path.join(cwd, "hook-test.txt"), content: "hello\n" }
    : tool === "Edit" ? { file_path: path.join(cwd, "hook-test.txt"), old_string: "hello", new_string: "hi" } : {};
  switch (ev) {
    case "PreToolUse": case "PermissionRequest": return { ...base, tool_name: tool, tool_input: input };
    case "PostToolUse": return { ...base, tool_name: tool, tool_input: input, tool_response: tool === "Bash" ? { stdout: "hello", stderr: "", interrupted: false } : { success: true } };
    case "PostToolUseFailure": return { ...base, tool_name: tool, tool_input: input, error: "test error" };
    case "UserPromptSubmit": return { ...base, prompt: "这是一条测试消息" };
    case "Stop": case "SubagentStop": return { ...base, stop_hook_active: false };
    case "SessionStart": return { ...base, source: m && !/[|*]/.test(m) ? m : "startup" };
    case "SessionEnd": return { ...base, reason: "other" };
    case "Notification": return { ...base, message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" };
    case "PreCompact": case "PostCompact": return { ...base, trigger: "manual", custom_instructions: "" };
    default: return base;
  }
}
function testHook({ command, event, matcher, dir, input, timeout }) {
  command = String(command || "");
  if (!command.trim()) throw new Error("empty command");
  let cwd = path.resolve(String(dir || CFG.workspace));
  try { if (!fs.statSync(cwd).isDirectory()) cwd = CFG.home; } catch { cwd = CFG.home; }
  let stdin = input != null && String(input).trim() ? String(input) : JSON.stringify(hookSample(String(event || ""), matcher, cwd), null, 2);
  // 界面写的是「留空用默认 60、最大 600」：以前按 30/60 夹，试运行到 40 秒就被杀（195-J.7）
  const ms = Math.max(1, Math.min(600, Number(timeout) || 60)) * 1000;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(ensureShell(), ["-c", command], {
      cwd, env: { ...termEnv(), CLAUDE_PROJECT_DIR: cwd }, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    let out = "", err = "", timedOut = false;
    const cap = (s, d) => (s.length < 64 * 1024 ? s + d : s);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
    child.stdout.on("data", (d) => (out = cap(out, d)));
    child.stderr.on("data", (d) => (err = cap(err, d)));
    const tm = setTimeout(() => { timedOut = true; killTree(child); }, ms);
    child.on("close", (code) => { clearTimeout(tm); resolve({ ok: true, code, stdout: out, stderr: err, ms: Date.now() - t0, timedOut, input: stdin }); });
    child.on("error", (e) => { clearTimeout(tm); resolve({ ok: true, code: -1, stdout: out, stderr: err + e.message, ms: Date.now() - t0, timedOut, input: stdin }); });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

export const SKILLS_DIR = path.join(CFG.home, ".claude", "skills");
// SKILL.md 开头的 YAML：只取顶层的单个键；支持 description: > / | 这类多行块
function fmField(md, k) {
  const fm = String(md).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const lines = fm[1].split("\n"), i = lines.findIndex((l) => l.startsWith(k + ":"));
  if (i < 0) return "";
  const v = lines[i].slice(k.length + 1).trim();
  if (!/^[>|][+-]?$/.test(v)) {
    // 双引号标量按转义解开（自定义组件的说明用 JSON.stringify 写，里面的 \" 不该显示成反斜杠）；单引号里 '' 是一个 '
    if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) try { return String(JSON.parse(v)).trim(); } catch {}
    if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'").trim();
    return v.replace(/^["']|["']$/g, "").trim();
  }
  const body = [];
  for (const l of lines.slice(i + 1)) { if (l.trim() && !/^\s/.test(l)) break; body.push(l.trim()); }
  return (v[0] === ">" ? body.join(" ") : body.join("\n")).replace(/\s+$/, "").trim();
}
export function skillMeta(dir) {
  try {
    const s = readHeadFile(path.join(dir, "SKILL.md"), 4000); if (s == null) return null;
    return { name: fmField(s, "name"), description: fmField(s, "description").slice(0, 300) };
  } catch { return null; }
}
function listSkills() {
  let ents = [];
  try { ents = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  // 哪些是组件带来的：组件的安装记录里有 skill 名（分类索引条分「组件自带 / 自己装的」）
  const fromComp = new Map(), ov = skillOverrides();
  try { for (const f of fs.readdirSync(COMP_DIR)) if (f.endsWith(".json")) { const r = compRecord(f.slice(0, -5)); if (r && r.skill) fromComp.set(r.skill, f.slice(0, -5)); } } catch {}
  return ents.filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => {
    const m = skillMeta(path.join(SKILLS_DIR, d.name));
    // 组件技能的 SKILL.md 是中文写的（给 Claude 看的触发说明）：非中文界面显示组件索引里的英文简介
    const cid = fromComp.get(d.name) || "", ce = cid && compIndexCache.data && compIndexCache.data.components[cid];
    // 没有 SKILL.md 的目录也列出来（orphan）：官方目录里同名安装会提示「已有同名技能」，这里不列就删不掉，
    // 用户在「显示未安装 / 安装说同名」之间打转（195-J.10）
    const mode = SKILL_MODES.includes(ov[d.name]) ? ov[d.name] : "on";
    if (!m) return { dir: d.name, name: d.name, description: "", descEn: "", component: cid, official: false, orphan: true, mode };
    return { dir: d.name, name: m.name || d.name, description: m.description, descEn: (ce && ce.desc && ce.desc.en) || "", component: cid, official: (skillSource(d.name) || {}).repo === SKILL_REPO, mode };
  }).filter(Boolean);
}
// ── 停用 / 启用（F5）：技能走 claude 自己认的 skillOverrides（键是技能目录名）；
// 发行版的技能由网关打包成 user 插件交给 claude（seal.mjs），那条路只认开 / 关：关的打包时跳过 ──
const SKILL_MODES = ["on", "name-only", "user-invocable-only", "off"];
const USER_SETTINGS = () => hookSettingsFile("user");
export function skillOverrides() {
  const r = readSettingsFile(USER_SETTINGS());
  const o = r.j && r.j.skillOverrides;
  return o && typeof o === "object" && !Array.isArray(o) ? o : {};
}
/** 改用户级 settings.json 里的一个键（和存钩子同一把锁、同一套写法：先留 .bak，换名写入，userconf 只认这一个键）。
 *  edit(j) 就地改整份设置；返回 false 表示不用写 */
function writeUserSetting(key, edit) {
  const job = EXT_LOCK.then(() => {
    const file = USER_SETTINGS(), r = readSettingsFile(file);
    if (r.error) throw new Error(r.badJson ? tz("~/.claude/settings.json 不是合法的 JSON，先修好它") : r.error);
    const j = r.j;
    if (edit(j) === false) return { ok: true, changed: false };
    const ucb = ucAppBegin();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (r.exists) { try { const b = file + ".bak.tmp-" + process.pid; fs.copyFileSync(file, b); fs.renameSync(b, file + ".bak"); } catch {} }
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n"); fs.renameSync(tmp, file);
    ucAppWrote([".claude/settings.json"], ucb, { ".claude/settings.json": [key] });
    return { ok: true, changed: true };
  });
  EXT_LOCK = job.catch(() => {});
  return job;
}
function writeSkillOverrides(edit) {
  return writeUserSetting("skillOverrides", (j) => {
    const cur = j.skillOverrides && typeof j.skillOverrides === "object" && !Array.isArray(j.skillOverrides) ? { ...j.skillOverrides } : {};
    edit(cur);
    if (Object.keys(cur).length) j.skillOverrides = cur; else delete j.skillOverrides;
  });
}
/** 网关启动时：用户级设置没写会话保留期（cleanupPeriodDays）就补成永久，写过的不动（D10，见 retention.mjs）。
 *  文件坏了不修、不覆盖：每轮的 --settings 照样带着保留期 */
export async function ensureSessionRetention() {
  const r = await writeUserSetting("cleanupPeriodDays", (j) => {
    if (j.cleanupPeriodDays !== undefined) return false;
    j.cleanupPeriodDays = RETENTION_DAYS;
  });
  if (r.changed) log(`会话保留期：~/.claude/settings.json 没写 cleanupPeriodDays，已补成 ${RETENTION_DAYS} 天（claude 缺省 30 天就删会话）`);
  return r;
}
async function setSkillMode(dir, mode) {
  if (!skillDirOk(dir, listSkills().map((x) => x.dir))) return { ok: false, message: "bad name" };
  const allowed = sealed() ? ["on", "off"] : SKILL_MODES;
  if (!allowed.includes(mode)) return { ok: false, message: "bad mode" };
  await writeSkillOverrides((o) => { if (mode === "on") delete o[dir]; else o[dir] = mode; });
  log(`技能 ${dir} → ${mode}`);
  return { ok: true };
}

/** MCP 定义只读 agy 的 mcp_config.json（P0-2b，agy-only）：~/.claude.json
 *  不再是来源——那是另一个独立应用的配置。 */
function agyMcpDefs() {
  const r = readAgyMcp();
  return r.ok ? r.servers : {};
}
/** 生效定义：agy（mcp_config.json）里的那一份 */
function userMcpDef(name) {
  return agyMcpDefs()[name] || null;
}
/** 生效来源：'agy' | null */
function userMcpSource(name) {
  return agyMcpDefs()[name] ? "agy" : null;
}
/** 全部定义：name → { def, source }，来源只有 'agy' */
function listMcpDefs() {
  const out = new Map();
  for (const [n, d] of Object.entries(agyMcpDefs())) {
    if (!d || typeof d !== "object") continue;
    out.set(n, { def: d, source: "agy" });
  }
  return out;
}
/** 列表里只显示请求头的名字（值可能是令牌，不显示）：一眼能看出令牌到底配上没有，
 *  不用等 claude 报 "Dynamic Client Registration rejected (HTTP 404)" 再猜。 */
const headerNames = (d) => {
  const h = d && d.headers;
  return h && typeof h === "object" && !Array.isArray(h) ? Object.keys(h).slice(0, 12).join(", ") : "";
};
// 启用前的确认框要看得出加回去的是什么：命令 / 地址之外，环境变量和请求头的名字也带上（值可能是密钥，不显示）
const mcpTarget = (d) => {
  const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).slice(0, 12).join(", ") : "");
  const env = keys(d.env), hdr = keys(d.headers);
  return (String(d.url || [d.command, ...(Array.isArray(d.args) ? d.args : [])].filter((x) => x != null).join(" ")).slice(0, 300)
    + (env ? ` [env: ${env}]` : "") + (hdr ? ` [headers: ${hdr}]` : "")).slice(0, 500);
};
/** 停用 = 先把定义存进停用名单，再从 agy 的 mcp_config.json 里拿掉；拿掉失败就把名单退回去。
 *  P0-2 决策：拿掉不用 agy 的 disabled:true——该标志是否让 `agy acp` 启动时
 *  跳过该服务器未经验证（实测只见过 `agy mcp add` 写 disabled:false），拿掉是
 *  确定的；且沿用 F5 的 off-list 形态与 0600 名单，启用时原样写回。
 *  P0-2b：停用→启用往返修好了——以前两边都有的服务器停用只删 agy 那份，
 *  Claude 那份会按读两边再次生效，等于没停掉，启用还因同名撞上被拒；
 *  现在只有一个来源，删 agy 那份就是真停掉，启用写回即恢复。 */
async function disableMcp(name) {
  if (!extIdOk(name) || badArg(name)) return { ok: false, message: tz("名字格式不对") };
  return mcpWriteJob(async () => {
    const ucb = ucAppBegin();
    const def = userMcpDef(name);
    if (!def) return { ok: false, message: tz("只能停用你自己加的（用户级）MCP 服务器") };
    const off = extOff();
    off.mcp[name] = def;
    if (!saveExtOff(off)) return { ok: false, message: tz("停用名单写不进去") };
    const r = setAgyMcpServer(name, null);
    if (!r.ok) {
      const o2 = extOff(); delete o2.mcp[name]; saveExtOff(o2);
      return { ok: false, message: tz("停用失败：{msg}，停用名单已退回", { msg: r.error }) };
    }
    ucAppWrote([AGY_MCP_REL], ucb, { [AGY_MCP_REL]: ["mcpServers"] });
    log(`MCP ${name} 已停用`);
    return { ok: true };
  });
}
/** 启用 = 把存着的定义写回 agy 的 mcp_config.json，成功了才从名单里删。
 *  停用期间同名又被装了就不覆盖，等用户先处理。 */
async function enableMcp(name) {
  const off = extOff(), def = extIdOk(name) ? off.mcp[name] : null;
  if (!def) return { ok: false, message: tz("停用名单里没有它") };
  const breach = mcpBreachOk(def);
  if (breach) return breach;
  return mcpWriteJob(async () => {
    const ucb = ucAppBegin();
    if (userMcpSource(name)) return { ok: false, message: tz("已经有叫这个名字的 MCP 服务器了，先把它删掉再启用") };
    const r = setAgyMcpServer(name, def);
    if (!r.ok) return { ok: false, message: tz("启用失败：{msg}", { msg: r.error }) };
    const o2 = extOff(); delete o2.mcp[name]; saveExtOff(o2);
    ucAppWrote([AGY_MCP_REL], ucb, { [AGY_MCP_REL]: ["mcpServers"] });
    log(`MCP ${name} 已启用`);
    return { ok: true };
  });
}
/** 停用着的 MCP 直接删掉（不再加回） */
function forgetMcp(name) {
  const off = extOff();
  if (!extIdOk(name) || !off.mcp[name]) return { ok: false, message: tz("停用名单里没有它") };
  delete off.mcp[name];
  return saveExtOff(off) ? { ok: true } : { ok: false, message: tz("停用名单写不进去") };
}
/** 组件 / 工具包模块：只记名单（命令文件不动）；组件自带的技能跟着关 / 开 */
async function setOff(kind, id, on) {
  if (!extIdOk(id)) return { ok: false, message: "bad id" };
  let skill = "";
  if (kind === "comp") {
    const rec = compRecord(id);
    if (!rec) return { ok: false, message: tz("没装这个组件") };
    skill = typeof rec.skill === "string" && extIdOk(rec.skill) ? rec.skill : "";
  } else if (kind === "mod") {
    const mj = modulesInfo();
    const m = mj && (mj.modules || []).find((x) => x && x.id === id);
    if (!m || m.required || m.kind === "shared") return { ok: false, message: tz("这个模块不能停用") };
  } else return { ok: false, message: "bad kind" };
  const off = extOff(), set = new Set(off[kind]);
  if (on) set.delete(id); else set.add(id);
  off[kind] = [...set];
  if (!saveExtOff(off)) return { ok: false, message: tz("停用名单写不进去") };
  if (skill && fs.existsSync(path.join(SKILLS_DIR, skill))) await writeSkillOverrides((o) => { if (on) { if (o[skill] === "off") delete o[skill]; } else o[skill] = "off"; });
  log(`${kind === "comp" ? "组件" : "模块"} ${id} ${on ? "已启用" : "已停用"}`);
  return { ok: true };
}

function deleteSkill(dir) {
  // 只认列表里真有的目录名（中文 / 空格名字的技能也能删；195-J.5）
  if (!skillDirOk(dir, listSkills().map((x) => x.dir))) return { ok: false, message: "bad name" };
  const p = path.join(SKILLS_DIR, dir);
  let st; try { st = fs.lstatSync(p); } catch { return { ok: false, message: "not found" }; }
  // 没有 SKILL.md 的目录（导入到一半失败留下的）也要能删：列表里现在会把它列出来并说明（195-J.10）。
  // 只删 skills 目录下这一级的目录 / 软链本身，不跟链接
  if (!st.isDirectory() && !st.isSymbolicLink()) return { ok: false, message: "not found" };
  const ucb = ucAppBegin();
  fs.rmSync(p, { recursive: true, force: true });
  ucAppWrote([".claude/skills/" + dir], ucb);
  return { ok: true };
}
// ── 官方目录：技能（anthropics/skills）与 MCP 注册表（registry.modelcontextprotocol.io）──
// 只读公开目录；装卸都落在用户自己的配置里：技能拷进 skills/，MCP 走 addMcp（写 agy 的 mcp_config.json）。
const SKILL_REPO = "anthropics/skills";
let skillCat = null;                 // { at, sha, items }：一小时内复用，GitHub 未登录的 API 一小时只给 60 次
const ghGet = async (url, json) => {
  const r = await fetch(url, { headers: { "User-Agent": "hachimia", ...(json ? { Accept: "application/vnd.github+json" } : {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return json ? r.json() : Buffer.from(await r.arrayBuffer());
};
async function skillCatalog(force) {
  if (!force && skillCat && Date.now() - skillCat.at < 3600e3) return skillCat;
  const tree = await ghGet(`https://api.github.com/repos/${SKILL_REPO}/git/trees/HEAD?recursive=1`, true);
  const blobs = (tree.tree || []).filter((e) => e.type === "blob");
  const names = [...new Set(blobs.map((e) => /^skills\/([^/]+)\/SKILL\.md$/.exec(e.path)?.[1]).filter((n) => n && SID_RE.test(n)))].sort();
  const items = await Promise.all(names.map(async (n) => {
    const files = blobs.filter((e) => e.path.startsWith(`skills/${n}/`)).map((e) => ({ path: e.path.slice(`skills/${n}/`.length), size: e.size || 0 }));
    let meta = { name: n, description: "" };
    try {
      const md = String(await ghGet(`https://raw.githubusercontent.com/${SKILL_REPO}/${tree.sha}/skills/${n}/SKILL.md`)).slice(0, 4000);
      meta = { name: fmField(md, "name") || n, description: fmField(md, "description").slice(0, 300) };
    } catch {}
    return { dir: n, ...meta, files, bytes: files.reduce((a, x) => a + x.size, 0), license: files.some((x) => /^LICENSE/i.test(x.path)) };
  }));
  return (skillCat = { at: Date.now(), sha: tree.sha, items });
}
const skillSource = (dir) => { try { const raw = readSmallFile(path.join(SKILLS_DIR, dir, ".cc-source.json"), 64 << 10); return raw == null ? null : JSON.parse(raw); } catch { return null; } };
async function listSkillCatalog(force) {
  try {
    const c = await skillCatalog(force);
    return { ok: true, repo: SKILL_REPO, items: c.items.map(({ files, ...x }) => ({ ...x,
      installed: fs.existsSync(path.join(SKILLS_DIR, x.dir, "SKILL.md")), official: (skillSource(x.dir) || {}).repo === SKILL_REPO })) };
  } catch (e) { return { ok: false, message: tz("取不到官方技能目录：{err}", { err: e.message }) }; }
}
/** 装一个官方技能：按目录树逐个下载到临时目录，齐了再改名就位（不会留下半截）；超过 50 MB 不装 */
async function installCatalogSkill(dir) {
  if (!SID_RE.test(dir)) return { ok: false, message: "bad name" };
  const c = await skillCatalog().catch((e) => null);
  const it = c && c.items.find((x) => x.dir === dir);
  if (!it) return { ok: false, message: tz("官方目录里没有这个技能") };
  const dest = path.join(SKILLS_DIR, dir);
  if (fs.existsSync(dest)) return { ok: false, message: tz("已经有同名技能，先删掉再装") };
  if (it.bytes > 50 << 20) return { ok: false, message: tz("太大了（超过 50 MB）") };
  const tmp = path.join(SKILLS_DIR, `.tmp-${dir}-${process.pid}`);
  const ucb = ucAppBegin();
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const f of it.files) {
      const out = path.resolve(tmp, f.path);
      if (!out.startsWith(tmp + path.sep)) throw new Error("bad path " + f.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, await ghGet(`https://raw.githubusercontent.com/${SKILL_REPO}/${c.sha}/skills/${dir}/${f.path.split("/").map(encodeURIComponent).join("/")}`));
    }
    fs.writeFileSync(path.join(tmp, ".cc-source.json"), JSON.stringify({ repo: SKILL_REPO, sha: c.sha, path: "skills/" + dir, at: new Date().toISOString() }) + "\n");
    fs.renameSync(tmp, dest);
    ucAppWrote([dest, tmp], ucb);
    return { ok: true };
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, message: e.message }; }
}

// MCP 注册表：任何人都能发布，没人审 —— 界面写明，装 npm 包前把命令亮给人看。
// 本机能直接用的两种：远程（streamable-http / sse）和 npm 包（npx 起 stdio）。pypi / docker 的标成装不了
const onPath = (bin) => String(claudeEnv().PATH || "").split(":").some((d) => d && fs.existsSync(path.join(d, bin)));
async function listMcpCatalog(q, cursor) {
  const u = new URL("https://registry.modelcontextprotocol.io/v0/servers");
  u.searchParams.set("version", "latest"); u.searchParams.set("limit", "30");
  if (q) u.searchParams.set("search", String(q).slice(0, 100));
  if (cursor) u.searchParams.set("cursor", String(cursor).slice(0, 300));
  let j;
  try { j = await ghGet(u.href, true); } catch (e) { return { ok: false, message: tz("取不到 MCP 注册表：{err}", { err: e.message }) }; }
  // 注册表谁都能发：版本号和位置参数原样拼进 npx 命令，不许夹带 --call 之类的选项（审查 10-29 第六份 低4）
  const npmArgsOk = (p) => (!p.version || /^[\w.+-]{1,64}$/.test(String(p.version))) &&
    (p.packageArguments || []).filter((a) => a.type === "positional" && (a.value || a.default))
      .every((a) => /^[\w./:@=+,-]{1,200}$/.test(String(a.value || a.default)) && !String(a.value || a.default).startsWith("-"));
  const field = (x) => ({ name: String(x.name || ""), description: String(x.description || "").slice(0, 200), required: !!x.isRequired, secret: !!x.isSecret });
  const items = (j.servers || []).map(({ server: v }) => {
    const options = [
      ...(v.remotes || []).filter((r) => ["streamable-http", "sse"].includes(r.type) && /^https:\/\//.test(r.url || "")).map((r) => ({
        kind: "remote", transport: r.type === "sse" ? "sse" : "http", target: r.url, headers: (r.headers || []).map(field) })),
      ...(v.packages || []).filter((p) => p.registryType === "npm" && (p.transport?.type || "stdio") === "stdio" && /^[@a-z0-9][\w./@-]*$/i.test(p.identifier || "") && npmArgsOk(p)).map((p) => ({
        kind: "npm", transport: "stdio", package: p.identifier, version: p.version || "",
        target: ["npx", "-y", p.identifier + (p.version ? "@" + p.version : ""),
          ...(p.packageArguments || []).filter((a) => a.type === "positional" && (a.value || a.default)).map((a) => String(a.value || a.default))].join(" "),
        env: (p.environmentVariables || []).map(field) })),
    ];
    const other = [...new Set((v.packages || []).filter((p) => p.registryType !== "npm").map((p) => p.registryType))];
    return { name: v.name, title: v.title || "", description: String(v.description || "").slice(0, 300), version: v.version || "",
      homepage: (v.repository && v.repository.url) || v.websiteUrl || "", options, other };
  });
  return { ok: true, items, next: (j.metadata && j.metadata.nextCursor) || "", npx: onPath("npx") };
}

/** 从 zip 装技能：包里找 SKILL.md，它所在的目录就是技能根（兼容「包一层文件夹」和「直接打包」两种） */
function skillDirName(text, fallback) {
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const nm = fm && (/^name:\s*(.+?)\s*$/m.exec(fm[1]) || [])[1];
  return String(nm || fallback || "skill").trim().replace(/^["']|["']$/g, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
/** 压缩包目录尾记录（EOCD）里写的条目总数；不是 zip / 找不到目录尾返回 -1。
 *  目录尾只可能在最后 22+65535 字节里，扫法和 zipcore.mjs 的 zipReadCore 相同 */
function zipEntryCount(buf) {
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let e = buf.length - 22; e >= floor; e--) if (buf.readUInt32LE(e) === 0x06054b50) return buf.readUInt16LE(e + 10);
  return -1;
}
const SKILL_ZIP_MAX_ENTRIES = 4096;   // 技能包正常几十个文件；到几千个多半是整包，解压前就拒（196-供应链.5）
/** 导入技能：zip（含 .skill）里每个 SKILL.md 各算一个技能，一次全装；也接受单独一个 SKILL.md。
 *  同名已存在的跳过并说明，不覆盖。解出的文件逐条异步写，长包不整段卡住事件循环 */
async function importSkill(buf) {
  const isZip = buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (!isZip) {
    const text = buf.toString("utf8");
    if (!/^\uFEFF?---\r?\n[\s\S]*?\r?\n---/.test(text)) throw new Error(tz("不是 zip，也不是带 name 的 SKILL.md"));
    const dir = skillDirName(text, "");
    if (!dir || !SID_RE.test(dir)) throw new Error(tz("技能名不合法"));
    const dst = path.join(SKILLS_DIR, dir);
    if (fs.existsSync(dst)) throw new Error(tz("已有同名技能「{name}」，先删掉旧的", { name: dir }));
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, "SKILL.md"), buf);
    return { ok: true, dir, dirs: [dir], skipped: [] };
  }
  // 先按目录尾记录核对条目数再解压：几万个小条目的包光解出来就能占满内存/时间，别等解开才后悔
  const nEntries = zipEntryCount(buf);
  if (nEntries > SKILL_ZIP_MAX_ENTRIES)
    throw new Error(tz("压缩包里的文件太多（{n} 个，最多 {max} 个），没有导入", { n: nEntries, max: SKILL_ZIP_MAX_ENTRIES }));
  const files = (await zipReadAsync(buf, 200 * 1024 * 1024)).filter((f) => !/(^|\/)(__MACOSX|\.git)\//.test(f.name) && !/(^|\/)\._/.test(f.name));
  // 浅的先占：一个技能目录里面再出现的 SKILL.md（示例、模板）归它自己，不另算
  const mds = files.filter((f) => /(^|\/)skill\.md$/i.test(f.name)).sort((a, b) => a.name.split("/").length - b.name.split("/").length);
  if (!mds.length) throw new Error(tz("压缩包里没有 SKILL.md"));
  const roots = [];
  for (const md of mds) {
    const root = md.name.slice(0, md.name.length - "SKILL.md".length);
    if (roots.some((r) => root.startsWith(r.root))) continue;
    roots.push({ root, md });
  }
  const dirs = [], skipped = [];
  for (const { root, md } of roots) {
    const dir = skillDirName(md.data.toString("utf8"), root.replace(/\/$/, "").split("/").pop());
    if (!dir || !SID_RE.test(dir)) { skipped.push({ name: root || md.name, why: tz("技能名不合法") }); continue; }
    const dst = path.join(SKILLS_DIR, dir);
    if (fs.existsSync(dst) && !fs.existsSync(path.join(dst, "SKILL.md"))) { skipped.push({ name: dir, why: tz("已有同名目录，但里面没有 SKILL.md（多半是以前导入到一半失败留下的）。到文件里删掉 ~/.claude/skills/{d} 再导入", { d: dir }) }); continue; }
    if (fs.existsSync(dst) || dirs.includes(dir)) { skipped.push({ name: dir, why: tz("已有同名技能") }); continue; }
    // 先写进临时目录，整个写完再改名过去：写到一半失败（满盘）不留下没有 SKILL.md 的半截目录占着名字（#151-2）。
    // 临时目录在 .claude 下、不在用户配置的监控范围里，和技能目录同一个文件系统，改名是原子的
    const tmp = path.join(path.dirname(SKILLS_DIR), ".ccapp-skill-import-" + crypto.randomBytes(4).toString("hex"));
    try {
      for (const f of files) {
        if (!f.name.startsWith(root)) continue;
        let rel = f.name.slice(root.length);
        if (f === md) rel = "SKILL.md";       // 统一成 Claude 认的大写文件名
        if (!rel || rel.split("/").some((x) => !x || x === "." || x === "..")) continue;
        if (rel === ".cc-source.json") continue;   // 来源记录只由官方目录安装时写：导入的包自带一份就能冒充「官方」（11-03 审查 I-13）
        const out = path.join(tmp, rel);
        await fs.promises.mkdir(path.dirname(out), { recursive: true });
        await fs.promises.writeFile(out, f.data);
      }
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      fs.renameSync(tmp, dst);
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      throw e;
    }
    dirs.push(dir);
  }
  if (!dirs.length) throw new Error(skipped.map((x) => `${x.name}：${x.why}`).join("；"));
  return { ok: true, dir: dirs.join("、"), dirs, skipped };
}
export const _extForTest = { importSkill, zipEntryCount, setSkillMode, disableMcp, enableMcp, forgetMcp, setOff, listSkills, listMcp, listMcpDefs, userMcpSource, parseAgyMcpList };   // 只给测试用

// ── 路由：/api/ext/ ──
export async function routeExtensions(req, res, u, p) {
  // ── 扩展：插件 / 市场 / MCP / 技能 ──
  if (p.startsWith("/api/ext/")) {
    const body = req.method === "POST" && p !== "/api/ext/skills/import" ? JSON.parse((await readBody(req)) || "{}") : {};
    try {
      if (req.method === "GET" && p === "/api/ext/plugins") {
        return sendJson(res, 200, await listPlugins(u.searchParams.get("q"), Number(u.searchParams.get("offset")) || 0, u.searchParams.get("available") === "1"));
      }
      if (req.method === "POST" && p === "/api/ext/plugins/install") {
        const r = await installPlugin(String(body.id || ""), body.accept ? String(body.accept) : null);
        if (r.ok) log(`装了插件 ${body.id}`);
        return sendJson(res, 200, r);
      }
      const op = p.match(/^\/api\/ext\/plugins\/(uninstall|enable|disable)$/);
      if (req.method === "POST" && op) {
        const r = await pluginOp(op[1], String(body.id || ""));
        if (r.ok) log(`插件 ${op[1]} ${body.id}`);
        return sendJson(res, 200, r);
      }
      if (req.method === "GET" && p === "/api/ext/marketplaces") return sendJson(res, 200, { items: await listMarketplaces() });
      if (req.method === "POST" && p === "/api/ext/marketplaces/add") return sendJson(res, 200, await marketplaceOp("add", String(body.source || "").trim()));
      if (req.method === "POST" && p === "/api/ext/marketplaces/remove") return sendJson(res, 200, await marketplaceOp("remove", String(body.name || "")));
      if (req.method === "GET" && p === "/api/ext/mcp") return sendJson(res, 200, { items: await listMcp() });
      if (req.method === "GET" && p === "/api/ext/mcp/get") return sendJson(res, 200, await getMcp({ name: u.searchParams.get("name") }));
      if (req.method === "POST" && p === "/api/ext/mcp/edit") return sendJson(res, 200, await editMcp(body));
      if (req.method === "POST" && p === "/api/ext/mcp/add") return sendJson(res, 200, await addMcp(body));
      if (req.method === "POST" && p === "/api/ext/mcp/remove") return sendJson(res, 200, await removeMcp(body.name));
      if (req.method === "POST" && p === "/api/ext/mcp/disable") return sendJson(res, 200, await disableMcp(String(body.name || "")));
      if (req.method === "POST" && p === "/api/ext/mcp/enable") return sendJson(res, 200, await enableMcp(String(body.name || "")));
      if (req.method === "POST" && p === "/api/ext/mcp/forget") return sendJson(res, 200, forgetMcp(String(body.name || "")));
      if (req.method === "POST" && p === "/api/ext/skills/mode") return sendJson(res, 200, await setSkillMode(String(body.dir || ""), String(body.mode || "")));
      if (req.method === "GET" && p === "/api/ext/off") { const o = extOff(); return sendJson(res, 200, { comp: o.comp, mod: o.mod }); }
      if (req.method === "POST" && p === "/api/ext/off") return sendJson(res, 200, await setOff(String(body.kind || ""), String(body.id || ""), !!body.on));
      if (req.method === "GET" && p === "/api/ext/skills") {
        if (PREFIX) await compIndex(false).catch(() => {});   // 组件技能的英文简介来自索引（有缓存，一般不联网）
        return sendJson(res, 200, { items: listSkills(), dir: SKILLS_DIR, sealed: sealed() });
      }
      if (req.method === "GET" && p === "/api/ext/catalog/skills") return sendJson(res, 200, await listSkillCatalog(u.searchParams.get("refresh") === "1"));
      if (req.method === "POST" && p === "/api/ext/catalog/skills/install") return sendJson(res, 200, await installCatalogSkill(String(body.dir || "")));
      if (req.method === "GET" && p === "/api/ext/catalog/mcp") return sendJson(res, 200, await listMcpCatalog(u.searchParams.get("q"), u.searchParams.get("cursor")));
      if (req.method === "POST" && p === "/api/ext/skills/delete") return sendJson(res, 200, deleteSkill(String(body.dir || "")));
      if (req.method === "GET" && p === "/api/ext/hooks") return sendJson(res, 200, { ...listHooks(u.searchParams.get("dir")), sealed: sealed() });
      if (req.method === "GET" && p === "/api/ext/hooks/file") {
        try { return sendJson(res, 200, hooksFileView(u.searchParams.get("scope") || "user", u.searchParams.get("dir"))); }
        catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
      }
      if (req.method === "POST" && p === "/api/ext/hooks/save") {
        try { return sendJson(res, 200, await saveHooks(body)); }
        catch (e) { return sendJson(res, 200, { ok: false, code: e.code, message: e.message }); }
      }
      if (req.method === "POST" && p === "/api/ext/hooks/scripts") return sendJson(res, 200, installHookScripts());
      if (req.method === "POST" && p === "/api/ext/hooks/test") return sendJson(res, 200, await testHook(body));
      if (req.method === "POST" && p === "/api/ext/skills/import") return sendJson(res, 200, await importSkill(await readBodyBuf(req, 64 * 1024 * 1024)));
    } catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
    return sendJson(res, 404, { error: "not found" });
  }
  return NEXT;
}
