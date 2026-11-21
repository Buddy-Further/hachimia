import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { CFG, PATHS, PREFIX } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { API_KEY, PROVIDER, providerBrief } from "./providers.mjs";
import { agyEnv, bridgeAlive, runClaude, safeMode } from "./claude.mjs";
import { AUTH_CACHE } from "./login.mjs";
import { LAST_SESSION, RUNS } from "./runs.mjs";
import { NEXT, sendJson, uiTag } from "./http.mjs";
import { QUEUE } from "./queue.mjs";
import { cmdDescs } from "./commands.mjs";

// ── 能力清单 ──────────────────────────────────────────────────────────
let LAST_INIT = null;          // 最近一次 init / ACP available_commands_update
export const setLastInit = (v) => {
  if (!v || typeof v !== "object") { LAST_INIT = null; return; }
  LAST_INIT = { ...(LAST_INIT || {}), ...v };
};

/** 各斜杠命令的分类与说明（hachimia 本地命令 + Antigravity CLI 原生命令） */
const COMMAND_META = {
  // hachimia 本地 / 界面命令
  clear:       { cat: "会话",   desc: "清空当前会话上下文，开启新对话", local: true },
  new:         { cat: "会话",   desc: "开始一个新对话", local: true },
  rename:      { cat: "会话",   desc: "重命名当前会话（用法：/rename 新标题）", local: true },
  model:       { cat: "配置",   desc: "查看或切换模型", local: true },
  effort:      { cat: "配置",   desc: "调整思考强度（low / medium / high / xhigh）", local: true },
  autocompact: { cat: "上下文", desc: "查看或设置自动压缩提醒线", local: true },
  login:       { cat: "配置",   desc: "登录 Google Antigravity 账户", local: true },
  // Antigravity CLI (`agy`) 原生斜杠命令
  compact:     { cat: "上下文", desc: "压缩对话历史，释放上下文空间", local: false },
  plan:        { cat: "工作流", desc: "先仔细规划再动手执行", local: false },
  goal:        { cat: "工作流", desc: "设定长期目标并持续推进直到达成", local: false },
  schedule:    { cat: "工作流", desc: "设定定时任务或一次性提醒", local: false },
  "grill-me":  { cat: "工作流", desc: "通过交互访谈对齐方案与设计细节", local: false },
  teamwork:    { cat: "工作流", desc: "派出多代理团队协作完成大型任务", local: false },
  learn:       { cat: "工作流", desc: "总结经验并沉淀为可复用技能或规则", local: false },
  boost:       { cat: "工作流", desc: "启用 Boost 多代理编排深度思考与验证", local: false },
};

const LOCAL_UI_COMMANDS = ["clear", "new", "rename", "model", "effort", "autocompact", "login"];

/** /api/cli 子命令 → agy argv（P0-1 修正）。
 *  官方 CLI 用单数 `agy plugin list`（见 antigravity.google/docs/plugins?tab=cli）
 *  与 `agy agents`（官方文档）；旧映射 `plugins list` / `agent` 未经官方文档证实。
 *  `auth status` → ["models"] 与 `auto-mode` → ["--version"] 仍是占位映射，
 *  不在本 slice 范围内，未动。 */
export const AGY_CLI_SUBCOMMANDS = {
  "mcp list": ["mcp", "list"],
  agents: ["agents"],
  "plugin list": ["plugin", "list"],
  plugins: ["plugin", "list"],
  "auth status": ["models"],
  "auto-mode": ["--version"],
};
const FALLBACK_COMMANDS = Object.keys(COMMAND_META);
const AGY_BUILTIN_TOOLS = [
  "read_file", "edit_file", "write_file", "run_command", "manage_task",
  "search_web", "ask_question", "schedule",
  "define_subagent", "invoke_subagent", "manage_subagents", "send_message", "run_workflow",
];

/** 自带命令的名字（常用指令不许和它们重名） */
export const builtinCommands = () => Object.keys(COMMAND_META);

/** 扫描 ~/.gemini/antigravity-cli 的本地技能、插件（冷启动即可见，无需等首轮对话）；
 *  MCP 配置则读 ~/.gemini/config/mcp_config.json（P0-2b：settings.json 在 agy 1.5.13
 *  下根本不存在，MCP 从来不在那里，见 VERIFY-REPORT）。 */
function scanAgyLocal() {
  const base = path.join(process.env.HOME || CFG.home, ".gemini", "antigravity-cli");
  const skills = new Set(), plugins = new Set(), mcp = [];
  const readDirs = (d, dst) => {
    try {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith(".")) dst.add(ent.name);
      }
    } catch {}
  };
  readDirs(path.join(base, "builtin", "skills"), skills);
  readDirs(path.join(base, "skills"), skills);
  readDirs(path.join(base, "builtin", "plugins"), plugins);
  readDirs(path.join(base, "plugins"), plugins);
  try {
    const j = JSON.parse(fs.readFileSync(PATHS.agyMcpConfig, "utf8"));
    if (j && j.mcpServers && typeof j.mcpServers === "object") {
      for (const name of Object.keys(j.mcpServers)) mcp.push({ name, status: "configured" });
    }
  } catch {}
  return { skills: [...skills].sort(), plugins: [...plugins].sort(), mcp };
}

function stripAgyGlog(s) {
  return String(s || "")
    .split("\n")
    .filter((l) => !/logging before google\.Init:.*Initialized Android local timezone/i.test(l))
    .join("\n")
    .trim();
}

function runAgySub(args, timeoutMs = 20000) {
  const bin = PATHS.agy;
  return new Promise((resolve) => {
    if (!bin || !fs.existsSync(bin)) return resolve({ out: "", err: "agy not installed", code: 127 });
    execFile(bin, args, { cwd: CFG.workspace || CFG.home, env: agyEnv(), encoding: "utf8", timeout: timeoutMs, maxBuffer: 2 << 20 }, (err, stdout, stderr) => {
      resolve({
        out: stripAgyGlog(stdout),
        err: stripAgyGlog(stderr || (err && !stdout ? err.message : "")),
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        signal: err?.signal || null,
        timeout: !!err?.killed,
      });
    });
  });
}

/** 权限规则（能力页「工具」一节标允许 / 询问 / 拒绝用）：用户级 settings.json 的 permissions + 本应用设置里的允许 / 禁用工具 */
function permRules() {
  const r = { allow: [], ask: [], deny: [] };
  const h = process.env.HOME || CFG.home;
  for (const fp of [path.join(h, ".gemini", "antigravity-cli", "settings.json"), path.join(h, ".claude", "settings.json")]) {
    try {
      const j = JSON.parse(fs.readFileSync(fp, "utf8")).permissions || {};
      for (const k of ["allow", "ask", "deny"]) if (Array.isArray(j[k])) r[k].push(...j[k].map(String));
    } catch {}
  }
  if (Array.isArray(SETTINGS.allowedTools)) r.allow.push(...SETTINGS.allowedTools);
  if (Array.isArray(SETTINGS.disallowedTools)) r.deny.push(...SETTINGS.disallowedTools);
  return r;
}

export function buildCapabilities() {
  const init = LAST_INIT || {};
  const hasAgy = !!(PATHS.agy && fs.existsSync(PATHS.agy));
  const localAgy = hasAgy ? scanAgyLocal() : { skills: [], plugins: [], mcp: [] };
  const dynMeta = init.slash_command_meta && typeof init.slash_command_meta === "object" ? init.slash_command_meta : {};
  const rawCmds = Array.isArray(init.slash_commands) && init.slash_commands.length
    ? [...new Set([...LOCAL_UI_COMMANDS, ...init.slash_commands])]
    : [...FALLBACK_COMMANDS];
  const cmds = rawCmds.filter((c) => c && !c.startsWith("__"));
  // 常用指令（commands/*.md）：说明从文件头读；刚建好还没重新报 init 的也先列上
  const mine = cmdDescs();
  for (const n of Object.keys(mine)) if (!cmds.includes(n)) cmds.push(n);
  const tools = Array.isArray(init.tools) && init.tools.length ? init.tools : (hasAgy ? AGY_BUILTIN_TOOLS : []);
  const skills = Array.isArray(init.skills) && init.skills.length ? init.skills : localAgy.skills;
  const agents = Array.isArray(init.agents) && init.agents.length ? init.agents : (hasAgy ? ["self", "research", "image-generator"] : []);
  const plugins = Array.isArray(init.plugins) && init.plugins.length
    ? init.plugins.map((p) => (typeof p === "string" ? p : p.name || String(p)))
    : localAgy.plugins;
  const mcpServers = Array.isArray(init.mcp_servers) && init.mcp_servers.length ? init.mcp_servers : localAgy.mcp;
  return {
    ready: !!LAST_INIT || hasAgy,
    engine: hasAgy ? "antigravity" : "claude",
    model: SETTINGS.model,
    permissionMode: SETTINGS.permissionMode,
    tools,
    slashCommands: cmds.map((c) => {
      if (COMMAND_META[c]) {
        const dynDesc = dynMeta[c]?.description;
        return { name: c, ...COMMAND_META[c], ...(dynDesc && !COMMAND_META[c].desc ? { desc: dynDesc } : {}) };
      }
      if (mine[c]) return { name: c, cat: "常用指令", desc: mine[c].desc, hint: mine[c].hint, custom: mine[c].scope, local: false };
      if (dynMeta[c]) return { name: c, cat: skills.includes(c) ? "技能" : "Antigravity", desc: String(dynMeta[c].description || "").slice(0, 140), local: false };
      return { name: c, cat: "其他", desc: "", local: false };
    }),
    skills,
    agents,
    plugins,
    mcpServers,
    outputStyle: init.output_style || "default",
    version: init.version || init.claude_code_version || "",
    versionStatus: init.versionStatus || "",
    tier: init.tier || AUTH_CACHE?.v?.plan || "",
    rules: permRules(),
    settings: SETTINGS,
  };
}

function capabilities() { return buildCapabilities(); }

// ── 路由：/api/status /api/capabilities /api/cli ──
export async function routeCaps(req, res, u, p) {
  if (req.method === "GET" && p === "/api/status") {
    return sendJson(res, 200, {
      app: "hachimia",
      product: PREFIX ? "hachimia" : "Antigravity CLI",   // 界面标题
      pid: process.pid,
      ready: fs.existsSync(PATHS.agy) || (fs.existsSync(PATHS.claude) && fs.existsSync(PATHS.loader)),
      // 登录态厂商也算"就绪"：它不用密钥，用的是 claude 自己的 OAuth 登录
      hasKey: !!API_KEY || !!PROVIDER.login,
      keyMode: API_KEY ? "key" : (PROVIDER.login ? "login" : "none"),
      // 真实的 OAuth 状态（问过才有；unknown 表示问不出，不等于未登录）。界面别只看 loader 在不在（0.6.9 审计 195-G.3）
      auth: AUTH_CACHE && AUTH_CACHE.v ? {
        loggedIn: !!AUTH_CACHE.v.loggedIn, unknown: !!AUTH_CACHE.v.unknown, stale: !!AUTH_CACHE.v.stale, at: AUTH_CACHE.at,
      } : null,
      // 别家填了 Key 也算接上了：会话可以单独选那家（0.3.16 起），首屏不该再叫人去接模型
      otherKey: providerBrief().some((p) => !p.active && p.keyMode === "key" && !(SETTINGS.hiddenProviders || []).includes(p.id)),
      model: SETTINGS.model || PROVIDER.defaultModel || null,
      provider: PROVIDER.id,
      providerLabel: PROVIDER.label || PROVIDER.id,
      providerLabelEn: PROVIDER.labelEn || "",   // 界面不是中文时用（和设置里选接口那张单子同一规则）
      upstream: CFG.upstream,
      nativeModels: !!PROVIDER.nativeModels,
      workspace: CFG.workspace,
      runtime: CFG.runtime,
      bridge: await bridgeAlive(),
      uptimeMs: Math.round(process.uptime() * 1000),
      version: "3.0.0",
      busy: RUNS.size > 0,
      running: RUNS.size,
      // 挂起的（点了停止、被系统中断的）不会自己发出去，不算「有活要干」：外壳据 queued 判断能不能换工具包
      queued: QUEUE.filter((q) => !q.held).length,
      held: QUEUE.filter((q) => q.held).length,
      safeMode: safeMode(),
      hasLedger: !!process.env.CCAPP_LEDGER,
      uiTag: uiTag(),
      lastSessionId: LAST_SESSION ? LAST_SESSION.id : null,
      lastSessionAt: LAST_SESSION ? LAST_SESSION.at : null,
    });
  }
  // ── 能力清单 ──
  if (req.method === "GET" && p === "/api/capabilities") {
    return sendJson(res, 200, capabilities());
  }
  // ── 运行 CLI 子命令取状态（优先走 agy 原生子命令）──
  if (req.method === "GET" && p === "/api/cli") {
    const sub = (u.searchParams.get("cmd") || "").trim();
    const ALLOW = new Set(["mcp list", "agents", "plugin list", "plugins", "doctor", "auth status", "auto-mode"]);
    if (!ALLOW.has(sub)) return sendJson(res, 400, { error: "command not allowed", cmd: sub });
    let r;
    if (PATHS.agy && fs.existsSync(PATHS.agy)) {
      if (sub === "doctor") {
        const [ver, mcp, plg] = await Promise.all([
          runAgySub(["--version"], 8000),
          runAgySub(["mcp", "list"], 12000),
          runAgySub(AGY_CLI_SUBCOMMANDS["plugin list"], 12000),
        ]);
        const loc = scanAgyLocal();
        const st = AUTH_CACHE?.v;
        const lines = [
          `Antigravity CLI (agy): ${ver.out || "(unknown)"}`,
          `登录状态: ${st?.loggedIn ? "已登录" + (st.plan ? ` (${st.plan})` : "") + (st.email ? ` · ${st.email}` : "") : "未登录 / 未探测"}`,
          `内置技能: ${loc.skills.length} 个`,
          `MCP: ${mcp.out || mcp.err || "无"}`,
          `插件: ${plg.out || plg.err || "无"}`,
        ];
        r = { out: lines.join("\n"), err: "", code: ver.code, signal: null, timeout: false };
      } else {
        r = await runAgySub(AGY_CLI_SUBCOMMANDS[sub] || sub.split(/\s+/), 25000);
      }
    } else {
      r = await runClaude(sub.split(/\s+/), { timeoutMs: 45000 });
    }
    return sendJson(res, 200, {
      cmd: sub,
      out: (r.out || "").slice(0, 30000),
      err: (r.err || "").slice(0, 4000),
      code: r.code ?? null,
      signal: r.signal || null,
      timeout: !!r.timeout,
    });
  }
  return NEXT;
}
