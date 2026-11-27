import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PATHS, PREFIX, glibcEnv, log, tz } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { PROVIDER, keyOf } from "./providers.mjs";
import { cachedModels } from "./models.mjs";
import { sealEnv, sealed } from "./edition.mjs";
import { claudeSeal } from "./claudeseal.mjs";
import { gwRuntimeBlocked } from "./gwpin.mjs";
import { ucAppBegin, ucAppWrote } from "./userconf.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";

// ── 给 claude 造一个它认得的 shell ────────────────────────────────────
// 安卓既没有 /bin/sh 也没有 bash：claude 扫 /bin、/usr/bin 找 bash/zsh，
// 找不到就抛 "No suitable shell found"。它认 CLAUDE_CODE_SHELL 覆盖，
// 但会校验路径形态必须是 bash/zsh —— 于是造个名叫 bash 的包装转发给 mksh。
let SHELL_PATH = null;
// 非安卓环境（CI 的 Linux）没有 /system/bin/sh：包装脚本的 shebang 和最终 exec 都要回落到 /bin/sh
const SYS_SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
export function ensureShell() {
  if (SHELL_PATH) return SHELL_PATH;
  // 开发端（旧布局）没有 CCAPP_SHELL：有 files/cbash/bash（glibc 版真 bash）就用它。
  // /system/bin/sh 是 mksh —— claude 的 shell 快照开头 unalias -a，会把 mksh 靠别名实现的 local 一起删掉，
  // 快照里的 grep/find/pkill 函数于是每次都报 "local: inaccessible or not found"。
  const cbash = path.join(CFG.runtime, "..", "cbash", "bash");
  const want = process.env.CCAPP_SHELL || (!PREFIX && fs.existsSync(cbash) ? cbash : "");
  const real = want && fs.existsSync(want) ? want : SYS_SH;

  // 包一层再交给 claude，顺手卸掉 CLAUDE_CODE_EXECPATH：
  // claude 的 shell 快照把 grep/find 换成内置 ugrep/bfs，调法是 exec -a ugrep "$CLAUDE_CODE_EXECPATH" -G …，
  // 而这个变量 claude 填的是 process.execPath —— 我们经 glibc 加载器启动它，那就是 ld-linux-aarch64.so.1。
  // 加载器把 -G 当成程序名，于是 grep/find 全挂（"-G: cannot open shared object file"），
  // 模型就会退而用 env 之类的命令乱试。变量没了，快照里的函数自己会回落到 command grep / command find。
  const dir = PREFIX ? path.join(CFG.home, ".cache", "ccapp-shell") : path.join(CFG.runtime, "bin");
  const sh = path.join(dir, "bash");
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 前缀布局再加一层：termux-exec。安卓没有 /usr/bin/env、/bin/bash，
    // 凡是 #!/usr/bin/env node|python3、#!/bin/bash 的脚本（npm 装的命令行、./configure、用户自己写的）
    // 直接执行都是 bad interpreter。termux-exec 在 execve 时把这些解释器改指到 $PREFIX/bin。
    // 必须在 bash 启动前就设上 —— 已经在跑的 bash 后来再 export 也救不了它自己的 exec（实测）。
    // 代价：glibc 程序继承到它会起不来（claude 本体就是），所以 app/bin/claude 包装里会先清掉。
    // 经加载器时用 termux-exec 的 linker 版（Env.java 给的 CCAPP_BIONIC_PRELOAD）：数据目录里的程序都改成经 linker64 起
    const tx = process.env.CCAPP_BIONIC_PRELOAD || (PREFIX ? path.join(PREFIX, "lib", "libtermux-exec-ld-preload.so") : "");
    const pre = tx && fs.existsSync(tx) ? 'export LD_PRELOAD="' + tx + '"\n' : "";
    const body = '#!' + SYS_SH + '\nunset CLAUDE_CODE_EXECPATH\n' + pre + 'exec "' + real + '" "$@"\n';
    let need = true;
    try { need = fs.readFileSync(sh, "utf8") !== body; } catch {}
    if (need) fs.writeFileSync(sh, body, { mode: 0o755 });
    fs.chmodSync(sh, 0o755);
    SHELL_PATH = sh;
  } catch (e) {
    log(`造 shell 包装失败: ${e.message}`);
    SHELL_PATH = SYS_SH;
  }
  return SHELL_PATH;
}

// ── 运行时工具环境与模型参数查询 ──────────────────────────────────────
/** 某个模型（缺省 = 全局设置里的）在某家（缺省 = 当前生效的）那边的真实参数（窗口 / 输出上限 / effort 档位）。
 *  那家的清单没拉过就用目录里写的 fallbackModels（原生厂商交给 Antigravity 自己决定默认模型；压缩线未设时让 Antigravity 自己按窗口比例决定） */
export function currentModelInfo(id = SETTINGS.model, p = PROVIDER) {
  const list = cachedModels(p);
  if (!Array.isArray(list) || !list.length) return {};
  const want = id || p.defaultModel;
  if (!want) return list[0] || {};
  // 只认同名的：清单里没有这个型号就当不知道，别借第一项的窗口（128k 的型号借来 1M 会越窗，#57 #82）
  return list.find((m) => m.id === want) || {};
}

/** 网关本机辅助工具（终端、cc-mem、curl、magick、batterystats）的干净运行环境，不注入任何大模型 API 变量 */
export function toolEnv() {
  const basePath = PREFIX ? [process.env.CCAPP_BIN && path.join(process.env.CCAPP_BIN, "..", "pre"), path.join(PREFIX, "bin"), path.join(CFG.home, ".hachimia", "bin"), path.join(CFG.home, ".cccodroid", "bin"), process.env.CCAPP_BIN, "/system/bin", "/system/xbin"].filter(Boolean).join(":") : [
    path.join(PATHS.toolchain, "payload", "bin"),
    path.join(CFG.runtime, "..", "devbin"),
    path.join(CFG.runtime, "node"),
    "/system/bin", "/system/xbin",
  ].join(":");
  const loaderBin = ensureLoaderBin(process.env);
  const realShell = ensureShell();
  const env = {
    ...process.env,
    HOME: CFG.home,
    // hachimia：用 $PREFIX/tmp —— 等长改写后，二进制里写死的默认临时目录正好就是它
    TMPDIR: PREFIX ? (fs.mkdirSync(path.join(PREFIX, "tmp"), { recursive: true }), path.join(PREFIX, "tmp")) : CFG.home,
    TERMINFO_DIRS: PREFIX ? path.join(PREFIX, "share", "terminfo") : path.join(PATHS.toolchain, "dshtc", "prefix", "share", "terminfo"),
    PATH: loaderBin ? (basePath ? `${loaderBin}:${basePath}` : loaderBin) : basePath,
    ...(loaderBin ? { CCAPP_LOADER_BIN: loaderBin, CCAPP_SHELL: process.env.CCAPP_SHELL || (PREFIX ? path.join(PREFIX, "bin", "bash") : realShell) } : {}),
    CCAPP_TOOLCHAIN: PATHS.toolchain,
    LD_LIBRARY_PATH: PREFIX ? "" : PATHS.nodeLib,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    SHELL: loaderBin ? path.join(loaderBin, "bash") : realShell,
  };
  if (!env.LD_LIBRARY_PATH) delete env.LD_LIBRARY_PATH;
  sealEnv(env);
  delete env.CCAPP_TOKEN_FILE;
  return glibcEnv(env);
}

const EXTRA_ENV_DENY = /^(ANTHROPIC_(BASE_URL|API_KEY|AUTH_TOKEN|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+_MODEL\w*)|CLAUDE_CODE_(SUBAGENT_MODEL|MAX_CONTEXT_TOKENS|AUTO_COMPACT_WINDOW|DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT)|LD_\w*|DYLD_\w*|NODE_\w*|BUN_\w*|PYTHON\w*|PERL5?\w*|RUBY\w*|GIT_\w*|SSL_\w*|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_SHELL\w*|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_MANAGED_SETTINGS_PATH|CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD|CLAUDE_COWORK_MEMORY_PATH_OVERRIDE|CLAUDE_CODE_USE_COWORK_PLUGINS|CLAUDE_CODE_PLUGIN_SEED_DIR|CLAUDE_CODE_DISABLE_AUTO_MEMORY|CLAUDE_CODE_GIT_BASH_PATH|CLAUDE_CONFIG_DIR|PATH|HOME|SHELL|BASH_ENV|ENV|PREFIX|TMPDIR|GCONV_PATH|LOCPATH|XDG_\w*|RUST\w*|CARGO_\w*|GO(FLAGS|PROXY|PATH|ROOT|TOOLCHAIN|ENV|BIN|CACHE|MODCACHE|EXPERIMENT|DEBUG|NOSUMDB|PRIVATE|INSECURE)|MAKE\w*|CC|CXX|CPP|AR|LD|EDITOR|VISUAL|PAGER|MANPAGER|LESS\w*|SUDO_ASKPASS|SSH_\w*|GNUPG\w*|NPM_CONFIG_\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|LUA_\w*|TERMUX_\w*|CCAPP_\w*|ENOSYS_\w*|PROMPT_COMMAND|PS4|IFS|CDPATH|SHELLOPTS|BASHOPTS|GCC_\w*|COMPILER_PATH|LIBRARY_PATH|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|OBJC_INCLUDE_PATH|PKG_CONFIG\w*|MAVEN_\w*|GRADLE_\w*|ANT_\w*|SBT_\w*|DENO_\w*|ELECTRON_\w*|NPM_\w*|YARN_\w*|PNPM_\w*|PIP_\w*|UV_\w*|CONDA_\w*|MAMBA_\w*|R_LIBS\w*|RSTUDIO_\w*|JULIA_\w*|DOTNET_\w*|COREHOST_\w*|TCL\w*|TK_LIBRARY|GEM_\w*|BUNDLE_\w*|HOSTALIASES|GLIBC_TUNABLES|RES_OPTIONS|LOCALDOMAIN|MALLOC_\w*|CLASSPATH|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|TEXINPUTS|TEXMF\w*|BIBINPUTS|BSTINPUTS|LUAINPUTS|KPATHSEA\w*|GUILE_\w*|EMACS\w*|PHP_INI_\w*|PHPRC|OCAML\w*|CAML_LD_LIBRARY_PATH|ERL_\w*|VIMINIT|EXINIT|MYVIMRC|VIMRUNTIME|TERMINFO|TERMINFO_DIRS|FONTCONFIG_\w*|GTK_\w*|GIO_\w*|GDK_\w*|QT_\w*|MAGICK_\w*|SQLITE_\w*|WGETRC|CURL_HOME|NETRC|INPUTRC|ZDOTDIR|HISTFILE|TAR_OPTIONS|GZIP|BZIP2?|XZ_\w*|ZSTD_\w*)$/;
// 模型、各档映射、上下文窗口、压缩线由网关按界面所选设好，配置里的不能盖掉：界面显示一个、实际跑另一个，计费和超窗都对不上（0.6.9 审计 195-U.2）
// 上面第二行起是审查 10-29 第六份 低1 补的：iconv 模块路径、git 全局配置目录、构建工具钩子、编辑器/分页器、exec 垫片与本应用自己的变量；
// GCC_ 起是 v0.5.7 独立审查 L1 补的：编译器搜索路径、各家构建工具与包管理器的选项变量（都能让后续子进程加载别处的代码）
// HOSTALIASES 起是 v0.5.9 独立审查 A5 补的：glibc 按文件改域名解析、调运行时参数
// CLASSPATH 起是 v0.5.12 独立审查 低3 补的：Java 类路径与选项、TeX 系的输入路径、Guile / Emacs / PHP / OCaml / Erlang 的加载路径
// VIMINIT 起是 v0.5.14 独立审查 低-7 补的：vim 启动命令、终端能力库、字体与图形库模块、各工具的配置文件位置

/** seccomp 监督器：hachimia 在 APK 原生库目录（libccenosysrun.so，Env.java 经 CCAPP_ENOSYS_RUN 交来），开发端在 files/devbin */
let ENOSYS_RUN;
export function enosysRun() {
  if (ENOSYS_RUN !== undefined) return ENOSYS_RUN;
  const cands = [process.env.CCAPP_ENOSYS_RUN,
    PATHS.preload && path.join(path.dirname(PATHS.preload), "seccomp-enosys-run"),
    path.join(CFG.home, "..", "devbin", "seccomp-enosys-run")].filter(Boolean);
  ENOSYS_RUN = cands.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || "";
  return ENOSYS_RUN;
}

export function killTree(child) {
  if (!child || !child.pid) return;
  // 光杀组不够：claude 的 Bash 工具会给子 shell 另开进程组（setsid），实测中断后
  // `sh -c … sleep 60` 留下来被 init 收养。所以先顺着 /proc 的父子关系把整棵树
  // 摘出来（得在杀之前摘，杀完父子关系就断了），再逐个连组带进程一起杀。
  const tree = descendants(child.pid);
  // 套着监督器、claude 又不可转储时，/proc 里从监督器顺不下去：监督器报上来的 claude pid（run.mjs）单独往下摘
  if (child.claudePid > 0 && child.claudePid !== child.pid) for (const p of [child.claudePid, ...descendants(child.claudePid)]) if (!tree.includes(p)) tree.push(p);
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  for (const p of tree) {
    try { process.kill(-p, "SIGKILL"); } catch {}
    try { process.kill(p, "SIGKILL"); } catch {}
  }
}

/** 进程启动时刻（开机后的滴答，/proc/<pid>/stat 第 22 项）；读不到 null */
function startTicks(pid, st) {
  try { st ??= fs.readFileSync("/proc/" + pid + "/stat", "utf8"); return +st.slice(st.lastIndexOf(")") + 2).split(" ")[19]; } catch { return null; }
}

/** 显式取消一轮时，清掉这一轮用 setsid / nohup 双 fork 脱出去、已经不在进程树里的后代（FIND-044）。
 *  killTree 顺着 /proc 的父子关系和进程组走，脱出去的被 init 收养、又另开了进程组，两头都够不着。
 *  认法：本 uid、环境里带 CCAPP_RUN_ID=<这一轮>、启动时刻不早于这一轮的 claude（编号同 uid 谁读得到 /proc 都能抄）。
 *  自己和祖先链不碰：开发端从某个 claude 会话里另起的网关，环境里也带着那轮的编号。
 *  环境里已经没有 CCAPP_RUN=1 的不碰：去掉它是「这不是 claude 运行，是要常驻的服务」的约定（终端、openai-bridge 的
 *  start-bridge.sh 都这么做，reapOrphans 也按它认）。只认编号的话，用户让 Claude 起的桥 / 服务器一停这一轮就被杀。
 *  只在显式取消这条路上调；网关重启时那一套仍是 reapOrphans（用户还没定，别动）。返回清掉的进程数。 */
export function killRunProcs(runId, sinceTicks = null, { excludePids = null } = {}) {
  if (runId == null || runId === "") return 0;
  const uid = process.getuid?.();
  if (uid == null) return 0;
  const ppidOf = (pid) => {
    try { const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return +s.slice(s.lastIndexOf(")") + 2).split(" ")[1]; } catch { return 0; }
  };
  const self = new Set();
  for (let p = process.pid, i = 0; p > 1 && i < 64; i++) { self.add(p); p = ppidOf(p); }
  if (excludePids) for (const ep of excludePids) if (Number.isInteger(ep) && ep > 0) self.add(ep);
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return 0; }
  const victims = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = +n;
    if (self.has(pid)) continue;
    try {
      if (fs.statSync("/proc/" + n).uid !== uid) continue;
      const env = "\0" + fs.readFileSync(`/proc/${n}/environ`, "latin1");
      if (!env.includes("\0CCAPP_RUN_ID=" + runId + "\0") || !env.includes("\0CCAPP_RUN=1\0")) continue;
      const st = fs.readFileSync(`/proc/${n}/stat`, "utf8");
      const t = startTicks(pid, st);
      if (sinceTicks != null && t != null && t < +sinceTicks) continue;
      victims.push(pid);
    } catch {}
  }
  for (const pid of victims) {
    // 脱出去的可能又起了自己的子孙（都带着编号，多半已在名单里；这里按父子关系再摘一遍防漏）
    const tree = descendants(pid);
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (const p of tree) { try { process.kill(p, "SIGKILL"); } catch {} }
  }
  return victims.length;
}

/** 网关启动时清掉上一任留下的孤儿（v0.2.0 设计 A3）。
 *  上一任网关被杀 / 崩溃时，它拉起的 claude 和 claude 另开进程组的子 shell 会被 init 收养（PPID=1），
 *  没人读它们的输出却还在干活：推提交、跑构建、占内存。新网关接不回它们，只能清掉。
 *  认法：本 uid、PPID=1，且环境里带 CCAPP_RUN=1（claudeEnv 打的标记，子孙都继承），
 *  或命令行就是我们的 claude（打标记之前的版本留下的）。连子孙一起、按进程组杀（同 killTree）。
 *  环境里的 CCAPP_GW_PID（run.mjs）指向的网关还活着、且比它起得早的不收：那是活网关名下用 setsid 脱出去的，不是上一任留下的。
 *  只在 hachimia 做：开发端换网关（gw-swap.sh）时上一任的运行还要接着用。 */
export function reapOrphans() {
  if (!PREFIX) return;
  const uid = process.getuid(), victims = [];
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return; }
  for (const n of names) {
    if (!/^\d+$/.test(n) || +n === process.pid) continue;
    try {
      if (fs.statSync("/proc/" + n).uid !== uid) continue;
      const st = fs.readFileSync("/proc/" + n + "/stat", "utf8");
      if (+st.slice(st.lastIndexOf(")") + 2).split(" ")[1] !== 1) continue;
      const env = "\0" + fs.readFileSync("/proc/" + n + "/environ", "latin1");
      const cmd = fs.readFileSync("/proc/" + n + "/cmdline", "utf8");
      if (!(env.includes("\0CCAPP_RUN=1\0") || (PATHS.agy && cmd.includes(PATHS.agy)))) continue;
      // 起它的网关还活着（setsid 脱出去的后台任务，或者测试里另起的网关碰上了真网关的运行）：不是孤儿，不收。
      // 那个 pid 若被别的进程复用，启动时刻会晚于它，照收
      const gw = +(/\0CCAPP_GW_PID=(\d+)\0/.exec(env) || [])[1], t0 = gw && gw !== process.pid ? startTicks(gw) : null;
      if (t0 != null && t0 <= startTicks(+n, st)) continue;
      victims.push([+n, cmd.replace(/\0/g, " ").trim().slice(0, 80)]);
    } catch {}
  }
  for (const [pid, cmd] of victims) {
    const tree = descendants(pid);
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (const p of tree) {
      try { process.kill(-p, "SIGKILL"); } catch {}
      try { process.kill(p, "SIGKILL"); } catch {}
    }
    log(`  清掉上一任留下的孤儿 pid=${pid}（连子孙 ${tree.length} 个）：${cmd}`);
  }
}

/** pid 的直接子进程，按 /proc/<pid>/task/<tid>/children 列（看得见 pid 才读得到；列出来的子进程本身看不见也照样列） */
export function childrenOf(pid) {
  const out = [];
  let tids = [];
  try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch { return out; }
  for (const t of tids) {
    try { for (const x of fs.readFileSync(`/proc/${pid}/task/${t}/children`, "utf8").split(/\s+/)) if (/^\d+$/.test(x)) out.push(+x); } catch {}
  }
  return out;
}

/** root 的全部子孙 pid（读 /proc/<pid>/stat 的第 4 列 ppid）。
 *  发行版里 claude 不可转储（libccnodump.so），/proc 里看不见它：经 children 文件补上这一环，它下面的子孙照样找得到 */
export function descendants(root) {
  const kids = new Map();
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return []; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let st;
    try { st = fs.readFileSync(`/proc/${n}/stat`, "utf8"); } catch { continue; }
    // comm 可能含空格和括号，从最后一个 ")" 往后数
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    const ppid = +f[1];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(+n);
  }
  const out = [], stack = [root], seen = new Set([root]);
  while (stack.length) {
    const p = stack.pop();
    for (const k of [...(kids.get(p) || []), ...childrenOf(p)]) if (!seen.has(k)) { seen.add(k); out.push(k); stack.push(k); }
  }
  return out;
}

/** 每次起 claude 都带的 --settings：输出风格 + 密钥读取器 + 会话保留期。
 *  apiKeyHelper 的输出 claude 会同时放进 x-api-key 与 Authorization: Bearer，两种认证风格都覆盖。 */
const KEY_FILE = path.join(CFG.home, ".cache", "ccapp-key");

/** 安全模式：配置弄坏了（钩子、插件、MCP、CLAUDE.md…）跑不起来时，用 claude 自带的 --safe-mode 起：
 *  所有自定义项一概不加载，登录、密钥、会话、模型照旧。不挪、不改任何文件，关掉就恢复原样。
 *  开关是一个标记文件 —— 界面打不开时，安卓壳的启动页也能直接写它。 */
const SAFE_FILE = path.join(CFG.home, ".ccapp-safe-mode");
export const safeMode = () => fs.existsSync(SAFE_FILE);
/** --safe-mode 下所有钩子都不跑，敏感操作再确认也跟着没了：这时不让用不问人的权限模式，退回「每次都问」 */
export const safeModePerm = (mode) => safeMode() && ["bypassPermissions", "auto", "acceptEdits"].includes(mode) ? "default" : mode;
function setSafeMode(on) {
  if (on) fs.writeFileSync(SAFE_FILE, String(Date.now()));
  else try { fs.unlinkSync(SAFE_FILE); } catch {}
  ledger("safe-mode", true, on ? "进入安全模式（界面开启）" : "退出安全模式");
  log(on ? "进入安全模式" : "退出安全模式");
}

/** 修复账本（安卓壳记安装 / 校验 / 修复，网关记安全模式），一行一条 JSON。没给路径就不记 */
export function ledger(kind, ok, msg, detail) {
  const f = process.env.CCAPP_LEDGER;
  if (!f) return;
  try { fs.appendFileSync(f, JSON.stringify({ at: Date.now(), kind, ok, msg, ...(detail ? { detail } : {}) }) + "\n"); } catch {}
}
export function readLedger(n = 100) {
  const f = process.env.CCAPP_LEDGER;
  if (!f) return null;
  try {
    return fs.readFileSync(f, "utf8").trim().split("\n").reverse().slice(0, n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) { if (e.code === "ENOENT") return []; throw e; }   // 还没记过账才是空；读不了要报错，别装成「没有记录」（审查 #52 D-07）
}

/** 应用内终端里自己敲的 agy 用哪把钥匙：和网关起的一样不进环境变量，单放一个 0600 文件，
 *  终端环境里只给路径（CCAPP_KEY_FILE），bin/agy 包装见到它就读进 GEMINI_API_KEY。 */
const termKeyPath = (p) => KEY_FILE + "-term-" + String(p.id).replace(/[^\w.-]/g, "_");
export function termKeyFile(p = PROVIDER) {
  const file = termKeyPath(p), key = keyOf(p);
  if (!key) { try { fs.unlinkSync(file); } catch {} return ""; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  } catch (e) { log("写终端密钥文件失败: " + e.message); return ""; }
}

/** 接口删掉后清掉它留在 .cache 里的密钥文件（FIND-052）：按 id 一份、终端一份；
 *  正在用的那家文件名不带 id，删的是当前接口时也要清（否则已删接口的 Key 一直留在盘上）。 */
export function clearKeyCache(id, active) {
  const safe = String(id).replace(/[^\w.-]/g, "_");
  const files = [KEY_FILE + "-" + safe, KEY_FILE + "-term-" + safe];
  if (active) files.push(KEY_FILE);
  for (const f of files) { try { fs.unlinkSync(f); } catch {} }
}

/** 构造拉起原生 agy 的 [程序, 参数] */
export function agyCmd(extra = []) {
  return [PATHS.agy, Array.isArray(extra) ? [...extra] : []];
}

/** 剥除 agy 启动时 Go glog 吐出的 Android 时区提示行，避免污染 JSON 解析与错误摘要 */
export function stripAgyGlog(s) {
  return String(s || "")
    .split("\n")
    .filter((l) => !/logging before google\.Init:/i.test(l))
    .join("\n")
    .trim();
}

/** 起 agy 之前核程序本身（claudeseal.mjs）：对不上返回给人看的原因，能起返回 ""。
 *  开会话以外的路也要核：mcp list、doctor、登录、补档、扩展命令都会执行它（审查 11-05 第 16 组 1） */
export async function claudeBlocked() {
  const gw = gwRuntimeBlocked();
  if (gw) return gw;
  const s = await claudeSeal().catch((e) => ({ ok: false, why: e.message }));
  if (s.ok !== false) return "";
  return tz("Antigravity CLI 程序核验没过，这次没有运行：{why}", { why: String(s.why || "") });
}

export async function runClaude(args, { cwd, timeoutMs = 60000 } = {}) {
  const blocked = await claudeBlocked();
  if (blocked) return { out: "", err: blocked, error: true };
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const [cmd0, args0] = agyCmd(args);
    const child = spawn(cmd0, args0, {
      cwd: cwd || (fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home),
      env: agyEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,          // 当进程组长，中断时好整组带走（见 killTree）
    });
    const timer = setTimeout(() => {
      if (!done) {
        done = true; killTree(child);
        resolve({ out: stripAgyGlog(out), err: stripAgyGlog(err), timeout: true });
      }
    }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ out: stripAgyGlog(out), err: stripAgyGlog(err) + e.message, error: true });
    });
    child.on("close", (code, signal) => {
      if (done) return;
      // 被信号杀掉时 code 是 null：把信号名带出去，不然调用方只看到一片空白
      done = true; clearTimeout(timer);
      resolve({ out: stripAgyGlog(out), err: stripAgyGlog(err) + (signal ? `（agy 被信号 ${signal} 终止）` : ""), code, signal });
    });
  });
}

// ── 路由：/api/safe-mode ──
export async function routeClaude(req, res, u, p) {
  if (req.method === "POST" && p === "/api/safe-mode") {
    const b = JSON.parse((await readBody(req)) || "{}");
    setSafeMode(!!b.on);
    return sendJson(res, 200, { ok: true, safeMode: safeMode() });
  }
  return NEXT;
}


// ── Antigravity CLI (agy) 环境与 ~/.gemini/antigravity-cli/settings.json 同步 ──
// 按官方 Authenticate & Settings 文档（antigravity.google/docs/cli/install）：
//   · API Key 模式：在 ~/.gemini/antigravity-cli/settings.json 写 {"modelProvider":"gemini"}，
//     并注入 GEMINI_API_KEY（以及可选 GOOGLE_GEMINI_BASE_URL）。
//   · 自定义 Gemini 端点：同步写入 customModelsConfig.customModels（gemini-api://<base>/models/<id>）。
//   · 订阅登录 / ADC 模式：移除 modelProvider 与 customModelsConfig 并清掉 GEMINI_API_KEY。
// agy 只认 Gemini 协议的 API Key 模式（modelProvider 只接受 "gemini"）：没有通用
// 第三方 bearer 通道，Anthropic 协议的第三方厂商（DeepSeek/GLM 等）没有任何 key
// 通道能进 agy 进程。唯一的例外是厂商明确声明 protocol:"gemini"——即端点讲
// Gemini 协议（rem-C2 方案 a）：此时按 Gemini 方式受控注入，绝不用
// authStyle:bearer 猜协议。C1 之前自定义厂商（group/custom）默认走这条 Gemini
// 通道，C1 关掉后讲 Gemini 协议的自定义端点由“能用”变“无 key”，本函数恢复它。
/** 厂商是否按 Gemini API Key 模式驱动 agy：authStyle/authType 已声明
 *  gemini-api-key，或明确声明 protocol:"gemini"；登录类厂商永远不算。 */
export function isGeminiApiKey(p, key) {
  return !!(p && !p.login && (p.authStyle === "gemini-api-key" || p.authType === "gemini-api-key" || p.protocol === "gemini") && key);
}
export function syncAgySettings(p = PROVIDER, key = keyOf(p)) {
  const dir = path.join(CFG.home, ".gemini", "antigravity-cli");
  const file = path.join(dir, "settings.json");
  // 只有 Gemini 协议才算 API Key 模式：group/custom 不能当依据，否则自定义 Bearer 端点
  // 也会被写成 modelProvider=gemini（C3）。protocol:"gemini" 是厂商的明确声明，算数（rem-C2）。
  const isApiKey = isGeminiApiKey(p, key);
  // A14：解析失败时不得静默重置成 {} 再写回——那会丢掉用户原有配置。
  // 原文件保留不动，只记日志并返回 error；调用方（agyEnv）按旧配置继续跑。
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") obj = {};
    else {
      log(`[agy] settings.json 解析失败，保留原文件不动：${e.message}`);
      return { file, isApiKey, error: `settings.json 解析失败：${e.message}` };
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    log("[agy] settings.json 不是 JSON 对象，保留原文件不动");
    return { file, isApiKey, error: "settings.json 不是 JSON 对象" };
  }
  let changed = false;
  if (isApiKey) {
    if (obj.modelProvider !== "gemini") { obj.modelProvider = "gemini"; changed = true; }
    // 自定义端点声明的模型写入官方 customModelsConfig，供 agy 识别非默认模型名
    const baseClean = String(p.baseUrl || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    // 只比 hostname：官方地址带路径（如 /v1beta）时整串比较会误判为自定义端点（C4）
    let baseHost = "";
    try { baseHost = new URL(String(p.baseUrl || "").trim()).hostname; } catch { baseHost = baseClean.split("/")[0] || ""; }
    const isCustomEp = !!baseClean && !/^generativelanguage\.googleapis\.com$/i.test(baseHost);
    const modelIds = [...new Set([
      p.defaultModel,
      p.fastModel,
      ...((Array.isArray(p.extraModels) ? p.extraModels : []).map((m) => (typeof m === "string" ? m : m?.id))),
    ].filter((x) => typeof x === "string" && x.trim()))];
    if (isCustomEp && modelIds.length) {
      // MIG-13：modelName 格式已按官方文档核对一半——官方文档（antigravity.google/docs/settings，
      // CLI 设置页“customModelsConfig and gcp”一节）写明 modelName 形如
      // `gemini-api://<base_url>/models/<model>`，与下面 host-only 端点的写法一致。
      // 但文档没写 <base_url> 带路径段（如 https://proxy.example.com/v1beta）时怎么写，
      // 本机无 agy、无真机，带路径的写法未验证——核对前不要改格式。真机验证方法：
      // 配一个带路径的自定义 Gemini 端点，跑 `agy models` 看自定义模型是否出现。
      const nextCustom = {
        customModels: modelIds.map((id) => ({
          modelName: `gemini-api://${baseClean}/models/${id}`,
          label: id,
        })),
      };
      if (JSON.stringify(obj.customModelsConfig) !== JSON.stringify(nextCustom)) {
        obj.customModelsConfig = nextCustom;
        changed = true;
      }
    } else if ("customModelsConfig" in obj) {
      delete obj.customModelsConfig;
      changed = true;
    }
  } else {
    if ("modelProvider" in obj) { delete obj.modelProvider; changed = true; }
    if ("customModelsConfig" in obj) { delete obj.customModelsConfig; changed = true; }
  }
  if (changed) {
    const ucb = ucAppBegin();
    try {
      fs.mkdirSync(dir, { recursive: true });
      // A14：原子写——先写同目录临时文件（随机名、0600、独占创建），fsync 后 rename。
      // 同步函数内无 await，读-改-写本身不会被同进程交错；rename 保证读者永远看到
      // 完整的新旧其一，不会读到写一半的文件。失败时临时文件尽力清掉，原文件不动。
      const tmp = file + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + "\n");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
      ucAppWrote([".gemini/antigravity-cli/settings.json"], ucb, {
        ".gemini/antigravity-cli/settings.json": ["modelProvider", "customModelsConfig"],
      });
    } catch (e) {
      log(`[agy] 写入 settings.json 失败: ${e.message}`);
      return { file, isApiKey, error: `写入 settings.json 失败：${e.message}` };
    }
  }
  return { file, isApiKey };
}

// ── targetSdk ≥ 29「经加载器」模式下给 Go 二进制（agy）准备的可执行跳板目录 ──────────
// agy（Go）的 os/exec 直发裸 SYS_execve，完全绕过 LD_PRELOAD（libccexecshimb.so / termux-exec）；
// 在 targetSdk 36（W^X）下直接 exec 数据目录里的 bash/python3/git/npx 等会报 EACCES。
// 把 loader-bin/<命令> 软链到 APK 原生库目录的 libccrun.so（SELinux 允许 exec），并挂在 agy 的 SHELL 和 PATH 最前。
const LOADER_BIN_CORE = ["bash", "sh", "xdg-open", "termux-open-url"];
const loaderBinCache = new Map(); // loaderBin -> { target, mtimes: Map<dir, mtimeMs> }

export function ensureLoaderBin(envLike = process.env, { extraDirs = [] } = {}) {
  const execMode = envLike.CCAPP_EXEC || "";
  const loaderRun = envLike.CCAPP_LOADER_RUN || "";
  const loaderBin = envLike.CCAPP_LOADER_BIN || (CFG.runtime ? path.join(CFG.runtime, "loader-bin") : "");
  if (execMode !== "loader" || !loaderRun || !loaderBin || !fs.existsSync(loaderRun)) return "";

  const scanDirs = [
    envLike.CCAPP_BIN && path.join(envLike.CCAPP_BIN, "..", "pre"),
    PREFIX && path.join(PREFIX, "bin"),
    path.join(CFG.home, ".hachimia", "bin"),
    path.join(CFG.home, ".cccodroid", "bin"),
    path.join(CFG.home, ".gemini", "antigravity-cli", "bin"),
    envLike.CCAPP_BIN,
    ...extraDirs,
  ].filter(Boolean);

  const curMtimes = new Map();
  for (const d of scanDirs) {
    try { curMtimes.set(d, fs.statSync(d).mtimeMs); } catch { curMtimes.set(d, -1); }
  }
  const hit = loaderBinCache.get(loaderBin);
  if (hit && hit.target === loaderRun && fs.existsSync(path.join(loaderBin, "bash")) && hit.mtimes.size === curMtimes.size) {
    let same = true;
    for (const [d, mt] of curMtimes) {
      if (hit.mtimes.get(d) !== mt) { same = false; break; }
    }
    if (same) return loaderBin;
  }

  try {
    fs.mkdirSync(loaderBin, { recursive: true, mode: 0o700 });
    const want = new Set(LOADER_BIN_CORE);
    for (const d of scanDirs) {
      let ents;
      try { ents = fs.readdirSync(d); } catch { continue; }
      for (const name of ents) {
        if (!name || name === "." || name === ".." || name.includes("/") || name.startsWith(".")) continue;
        try {
          const st = fs.statSync(path.join(d, name));
          if (!st.isFile() || (st.mode & 0o111) === 0) continue;
        } catch { continue; }
        want.add(name);
      }
    }
    const existing = new Set();
    try {
      for (const name of fs.readdirSync(loaderBin)) existing.add(name);
    } catch {}
    for (const name of want) {
      const link = path.join(loaderBin, name);
      let ok = false;
      if (existing.has(name)) {
        try { ok = fs.readlinkSync(link) === loaderRun; } catch {}
      }
      if (!ok) {
        try { fs.unlinkSync(link); } catch {}
        try { fs.symlinkSync(loaderRun, link); } catch {}
      }
    }
    for (const name of existing) {
      if (want.has(name) || name.startsWith(".")) continue;
      try { fs.unlinkSync(path.join(loaderBin, name)); } catch {}
    }
    loaderBinCache.set(loaderBin, { target: loaderRun, mtimes: curMtimes });
    return loaderBin;
  } catch (e) {
    log(`[loader-bin] 准备跳板目录失败: ${e.message}`);
    return "";
  }
}

export function agyEnv(o = {}) {
  const p = o.provider || PROVIDER;
  const key = keyOf(p);
  // sync:false = 只组装环境，不碰 ~/.gemini/antigravity-cli/settings.json。
  // 登录探针（login.mjs 的 authEnv）必须用它：只读操作不得删掉 API Key 模式的配置（A4）。
  // 真跑（run.mjs / caps.mjs）默认同步，切换厂商时 settings.json 跟着走。
  if (o.sync !== false) syncAgySettings(p, key);
  const basePath = PREFIX
    ? [process.env.CCAPP_BIN && path.join(process.env.CCAPP_BIN, "..", "pre"), path.join(PREFIX, "bin"), path.join(CFG.home, ".hachimia", "bin"), path.join(CFG.home, ".cccodroid", "bin"), process.env.CCAPP_BIN, "/system/bin", "/system/xbin"].filter(Boolean).join(":")
    : process.env.PATH;
  const loaderBin = ensureLoaderBin(process.env);
  const env = {
    ...process.env,
    HOME: CFG.home,
    TMPDIR: PREFIX ? (fs.mkdirSync(path.join(PREFIX, "tmp"), { recursive: true }), path.join(PREFIX, "tmp")) : CFG.home,
    TERMINFO_DIRS: PREFIX ? path.join(PREFIX, "share", "terminfo") : (process.env.TERMINFO_DIRS || ""),
    // 自定义组件入口写在 ~/.cccodroid/bin（custom.mjs），ACP 轮次也要认：只留 ~/.hachimia/bin 的话
    // 那个目录是空的，模型按裸命令名调自定义组件会解析不到（R-10 方案 a：先加回 PATH，不做数据迁移）
    PATH: loaderBin ? (basePath ? `${loaderBin}:${basePath}` : loaderBin) : basePath,
    CCAPP_PROVIDER: p.id || "antigravity",
    CCAPP_RUN: "1",
    NO_COLOR: "1",
    // 禁用 agy 内置后台自更新（auto_updater.go 严格校验 == "true"，填 "1" 无效；且不认 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC）：
    // 否则 agy 会在对话期间原地覆写 realpath(current/agy)，导致版本目录名与真实二进制脱节、破坏 manifest.json sha256 封签，
    // 且无视用户的「关闭自动更新」与「固定版本」设置。
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    // Android 无桌面 org.freedesktop.secrets 服务：$PREFIX/bin 在 PATH 中时，若此变量为空，agy (go-keyring / auth_store.go)
    // 每次启动都会经 dbus-launch 派生孤儿 dbus-daemon --syslog --fork 进程后再回退 plugin-secrets.json。
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || "unix:path=/nonexistent",
  };
  if (loaderBin) {
    env.CCAPP_LOADER_BIN = loaderBin;
    env.CCAPP_SHELL = env.CCAPP_SHELL || (PREFIX ? path.join(PREFIX, "bin", "bash") : SYS_SH);
    env.SHELL = path.join(loaderBin, "bash");
  }
  if (PREFIX && fs.existsSync(path.join(PREFIX, "etc", "tls", "cert.pem"))) {
    env.SSL_CERT_FILE = env.SSL_CERT_FILE || path.join(PREFIX, "etc", "tls", "cert.pem");
  }
  delete env.CCAPP_TOKEN_FILE;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_GEMINI_BASE_URL;
  delete env.AGY_ADC_AUTH;
  if (p.authType === "agent-platform" || p.authStyle === "adc") {
    env.AGY_ADC_AUTH = "true";
  } else if (isGeminiApiKey(p, key)) {
    // 只有 Gemini 协议才注入 GEMINI_API_KEY：第三方厂商（DeepSeek/GLM 等）的 key
    // 绝不能冒充 Gemini key、baseUrl 也绝不能冒充 Gemini 端点（C1）；但厂商明确
    // 声明 protocol:"gemini" 时，端点讲的就是 Gemini 协议，恢复注入（rem-C2）。
    env.GEMINI_API_KEY = key;
    if (p.baseUrl && !/^https:\/\/generativelanguage\.googleapis\.com\/?$/i.test(p.baseUrl)) {
      env.GOOGLE_GEMINI_BASE_URL = p.baseUrl;
    }
  }
  // C-05：合入厂商配置的 extraEnv（与 claudeEnv 同口径过滤敏感内部变量，不许覆盖密钥/端点/加载器/自更新锁变量）
  for (const [k, v] of Object.entries(p.extraEnv || {})) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(k) && !EXTRA_ENV_DENY.test(k) && !/^(GEMINI_API_KEY|GOOGLE_GEMINI_BASE_URL|AGY_ADC_AUTH|AGY_CLI_DISABLE_AUTO_UPDATE)$/.test(k)) {
      env[k] = String(v);
    }
  }
  sealEnv(env);
  delete env.CCAPP_TOKEN_FILE;
  return env;
}
