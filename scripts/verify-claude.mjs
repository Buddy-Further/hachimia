#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  verify-claude.mjs —— 在真机上验一版 Antigravity CLI (agy) / Claude Code 能不能在 hachimia 里正常用（在 hachimia 的终端里跑）
//
//  node verify-claude.mjs [版本号|stable|latest] [--model <型号>] [--out <目录>] [--keep] [--bin <二进制>]
//  （要验的正好是当前装的那一版就直接用它，不再下载；--bin 直接验给定的二进制，版本号以它 --version 报的为准）
//
//  做什么（不动你当前装的那一版）：
//   1. 用 App 自带的 install-agy.mjs（旧布局回落 install-claude.mjs）把这一版装进临时目录（同样按官方清单 sha256 核）
//   2. 套上 seccomp 监督器（enosys-run -v -f）跑三步，记下所有被安卓 seccomp 拦下的系统调用：
//        version  --version 报的是这一版
//        tools    -p 一轮：让它用工具写一个文件再读出来
//        resume   -p --resume 接着上一轮问一句
//   3. 结果写成 agy-verify-<版本>.json（或 claude-verify-<版本>.json）
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const MODEL = opt("--model"), OUTDIR = opt("--out") || process.cwd(), KEEP = flag("--keep"), GIVEN = opt("--bin");
const WANT = argv[0] || "stable";
const say = (s) => console.log(s);
const die = (s) => { console.log("✗ " + s); process.exit(1); };

const { PREFIX, HOME, CCAPP_BIN } = process.env;
if (!PREFIX || !CCAPP_BIN) die("要在 hachimia 的终端里跑（没有 PREFIX / CCAPP_BIN）");
const APP = path.dirname(CCAPP_BIN);
const NL = process.env.CCAPP_NATIVE_LIB || "/nonexistent";
const ENOSYS = process.env.CCAPP_ENOSYS_RUN || path.join(NL, "libccenosysrun.so");
const LD = process.env.CCAPP_LD || path.join(PREFIX, "glibc/lib/ld-linux-aarch64.so.1");
const PRELOAD = process.env.CCAPP_GLIBC_PRELOAD || process.env.CCAPP_CLAUDE_PRELOAD || path.join(NL, "libccenosys.so");
const INST_AGY = path.join(APP, "scripts/install-agy.mjs");
const INST_CLAUDE = path.join(APP, "scripts/install-claude.mjs");
const INST = fs.existsSync(INST_AGY) ? INST_AGY : INST_CLAUDE;
const isAgy = INST === INST_AGY && !(GIVEN && path.basename(GIVEN) === "claude");
for (const f of [ENOSYS, INST]) if (!fs.existsSync(f)) die("找不到 " + f + "（App 太旧？）");

// aarch64 上较新的系统调用号 → 名字。KNOWN 是已知会被拦、但 claude（Bun）遇到 ENOSYS 会自己退回老调用的
const NAMES = { 424: "pidfd_send_signal", 425: "io_uring_setup", 426: "io_uring_enter", 427: "io_uring_register", 434: "pidfd_open", 435: "clone3",
  436: "close_range", 437: "openat2", 438: "pidfd_getfd", 439: "faccessat2", 440: "process_madvise", 441: "epoll_pwait2", 442: "mount_setattr",
  444: "landlock_create_ruleset", 445: "landlock_add_rule", 446: "landlock_restrict_self", 447: "memfd_secret", 448: "process_mrelease",
  449: "futex_waitv", 451: "cachestat", 452: "fchmodat2", 453: "map_shadow_stack", 454: "futex_wake", 455: "futex_wait", 456: "futex_requeue",
  457: "statmount", 458: "listmount", 462: "mseal" };
const KNOWN = new Set([439, 441]);

const tmpBase = fs.mkdtempSync(path.join(process.env.TMPDIR || path.join(PREFIX, "tmp"), "claude-verify-"));
const cleanup = () => { if (!KEEP) fs.rmSync(tmpBase, { recursive: true, force: true }); };
process.on("exit", cleanup);

const getprop = (k) => spawnSync("/system/bin/getprop", [k], { encoding: "utf8" }).stdout?.trim() || "";
const device = { model: getprop("ro.product.model"), maker: getprop("ro.product.manufacturer"), android: getprop("ro.build.version.release"),
  sdk: +getprop("ro.build.version.sdk") || 0, kernel: os.release(), targetSdk: +process.env.CCAPP_TARGET_SDK || 0, exec: process.env.CCAPP_EXEC || "" };

// 端口只认数字（审查 10-29 第六份 低2）：带 @ 之类会把令牌头送到别的主机
const PORT = /^\d{1,5}$/.test(process.env.CCAPP_PORT || "") ? process.env.CCAPP_PORT : "9793";
// App / 工具包版本：问本机网关（终端里有它的令牌文件）
async function appInfo() {
  try {
    // claudeEnv() 为防泄漏会删掉 CCAPP_TOKEN_FILE，应用内终端里跑这个脚本时变量不存在；
    // 令牌就在 home 的固定位置（和 cc-archive.mjs 一样直接读），否则这里整段失败、结果里没有 App 版本
    const tf = process.env.CCAPP_TOKEN_FILE || path.join(HOME || os.homedir(), ".gateway-token");
    const tok = fs.readFileSync(tf, "utf8").trim(), mac = (s) => crypto.createHmac("sha256", tok).update(s).digest("hex");
    // 不发令牌原文（审查 10-30 第九份 高2）：先核身份（端口上可能是网关没起来时抢占的应用），再按 sig2 一次一签
    const n = crypto.randomBytes(16).toString("hex");
    const [boot, pm] = (await (await fetch(`http://127.0.0.1:${PORT}/__proof?for=tool&n=${n}`, { signal: AbortSignal.timeout(8000) })).text()).trim().split(" ");
    if (!/^[0-9a-f]{32}$/.test(boot || "") || pm !== mac(`tproof:${n}:${boot}:127.0.0.1`)) throw new Error("not the gateway");
    const sig = (p) => { const ts = Date.now(), r = crypto.randomBytes(16).toString("hex"); return { "X-CC-Sig": `${ts}.${r}.${mac(`sig2:${boot}:127.0.0.1:GET:${ts}:${r}:${crypto.createHash("sha256").update("").digest("hex")}:${p}`)}` }; };
    const r = await fetch(`http://127.0.0.1:${PORT}/api/app/upd_status`, { headers: sig("/api/app/upd_status"), signal: AbortSignal.timeout(8000) });
    const j = await r.json(), it = (id) => (j.items || []).find((x) => x.id === id)?.current || "";
    // stable / latest 现在是哪一版
    let channel = "";
    if (/^(stable|latest)$/.test(WANT)) try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/api/claude/versions`, { headers: sig("/api/claude/versions"), signal: AbortSignal.timeout(30000) })).json();
      channel = v[WANT] || "";
    } catch {}
    return { app: it("app"), devkit: it("devkit"), current: it("agy") || it("claude"), channel };
  } catch { return { app: "", devkit: "", current: "", channel: "" }; }
}

// ── 1. 装进临时目录 ───────────────────────────────────────────
const info = await appInfo();
say(`设备 ${device.maker} ${device.model} · Android ${device.android}（SDK ${device.sdk}）· App ${info.app || "?"} · ${info.devkit || "工具包 ?"}`);
const binName = isAgy ? "agy" : "claude";
const installed = path.join(HOME, isAgy ? ".local/share/hachimia/agy" : ".local/share/cccodroid/claude");
let VER = "", BIN = "", npmOnly = false;
if (GIVEN) {
  BIN = path.resolve(GIVEN);
  // claude 需经 glibc 加载器套 seccomp 垫片；agy 是 Android bionic 原生二进制，直接探测并在 EACCES 时走 linker64
  const probeOut = isAgy
    ? (() => {
      let r = spawnSync(ENOSYS, ["-v", "-f", BIN, "--version"], { encoding: "utf8", env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" } });
      if (r.status !== 0 && process.env.CCAPP_EXEC === "loader" && fs.existsSync("/system/bin/linker64")) {
        r = spawnSync(ENOSYS, ["-v", "-f", "/system/bin/linker64", BIN, "--version"], { encoding: "utf8", env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true", TERMUX_EXEC__PROC_SELF_EXE: BIN } });
      }
      return (r.stdout || "") + "\n" + (r.stderr || "");
    })()
    : (spawnSync(ENOSYS, ["-v", "-f", LD, "--library-path", path.join(PREFIX, "glibc/lib"), "--preload", PRELOAD, BIN, "--version"], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: "" } }).stdout || "");
  VER = /\d+\.\d+\.\d+/.exec(probeOut)?.[0] || "";
  if (!VER) die(`${BIN} 报不出版本号`);
  say(`\n── 直接验 ${BIN}（${VER}）`);
}
// 当前装的：网关说的为准，取不到读 current 链接；渠道版本网关取不到就直接问官方 / 镜像
if (!info.current) try { info.current = path.basename(fs.readlinkSync(path.join(installed, "current"))); } catch {}
if (!GIVEN && !info.channel && /^(stable|latest)$/.test(WANT)) {
  if (isAgy) {
    const DEFAULT_MB = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
    const ALLOWED_MB = new Set(["https://antigravity.google", "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app"]);
    const rawMb = String(process.env.HACHIMIA_AGY_MANIFEST_BASE || "").trim();
    let manifestBase = DEFAULT_MB;
    if (rawMb) {
      let u = null; try { u = new URL(rawMb); } catch {}
      const loopback = u && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname.toLowerCase());
      if (u && !u.username && !u.password && ((u.protocol === "https:" && ALLOWED_MB.has(u.origin)) || (process.env.CCAPP_TEST === "1" && (u.protocol === "http:" || u.protocol === "https:") && loopback))) {
        manifestBase = rawMb.replace(/\/+$/, "");
      } else {
        die(`拒绝不受信任的 HACHIMIA_AGY_MANIFEST_BASE：${rawMb}`);
      }
    }
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    try {
      const j = await (await fetch(`${manifestBase}/android_${arch}.json`, { signal: AbortSignal.timeout(8000) })).json();
      if (/^\d+\.\d+\.\d+$/.test(j?.version || "")) info.channel = j.version.trim();
    } catch {}
  } else {
    for (const b of ["https://downloads.claude.ai/claude-code-releases", "https://cccodroid.net/claude-code", "https://dl.cccodroid.net/claude-code"]) {
      try { const v = (await (await fetch(`${b}/${WANT}`, { signal: AbortSignal.timeout(8000) })).text()).trim(); if (/^\d+\.\d+\.\d+$/.test(v)) { info.channel = v; break; } } catch {}
    }
  }
}
const target = /^(stable|latest)$/.test(WANT) ? info.channel : WANT;
if (!GIVEN && target && target === info.current && fs.existsSync(path.join(installed, info.current, binName))) {
  VER = info.current; BIN = path.join(installed, VER, binName); npmOnly = !isAgy && fs.existsSync(path.join(installed, VER, ".npm-only"));
  say(`\n── ${VER} 就是当前装的，直接用`);
} else if (!GIVEN) {
  const scratchHome = path.join(tmpBase, "home");
  fs.mkdirSync(scratchHome, { recursive: true });
  say(`\n── 下载 ${WANT}${target ? `（${target}）` : ""}，装在临时目录，不动当前的 ${info.current || "版本"}${target && target !== info.current ? "" : info.current ? `（${info.current} 的程序文件不在，只好下载）` : ""}`);
  const inst = spawnSync(path.join(PREFIX, "bin/node"), [INST, WANT], { env: { ...process.env, HOME: scratchHome }, stdio: ["ignore", "inherit", "inherit"] });
  const dest = path.join(scratchHome, isAgy ? ".local/share/hachimia/agy" : ".local/share/cccodroid/claude");
  try { VER = path.basename(fs.readlinkSync(path.join(dest, "current"))); } catch {}
  if (inst.status !== 0 || !VER) die("下载没成功");
  BIN = path.join(dest, VER, binName);
  npmOnly = !isAgy && fs.existsSync(path.join(dest, VER, ".npm-only"));
}
const sha = crypto.createHash("sha256").update(fs.readFileSync(BIN)).digest("hex");

// ── 2. 三步实跑 ──────────────────────────────────────────────
const intercepted = new Map();   // 调用号 → 次数
const work = path.join(tmpBase, "work");
fs.mkdirSync(work, { recursive: true });
const env = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
if (!isAgy) delete env.LD_PRELOAD;           // bionic 的 termux-exec 不能进 glibc 进程
const useLinker64 = isAgy && process.env.CCAPP_EXEC === "loader" && fs.existsSync("/system/bin/linker64");
if (useLinker64) env.TERMUX_EXEC__PROC_SELF_EXE = BIN;
function run(args, ms = 180000) {
  return new Promise((ok) => {
    const t0 = Date.now();
    const spawnArgs = isAgy
      ? (useLinker64 ? ["-v", "-f", "/system/bin/linker64", BIN, ...args] : ["-v", "-f", BIN, ...args])
      : ["-v", "-f", LD, "--library-path", path.join(PREFIX, "glibc/lib"), "--preload", PRELOAD, BIN, ...args];
    const p = spawn(ENOSYS, spawnArgs, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), ms);
    p.on("close", (code, sig) => {
      clearTimeout(timer);
      const rest = [];
      for (const l of err.split("\n")) {
        const m = /^\[enosys\] pid \d+: 拦下 syscall (\d+)/.exec(l);
        if (m) intercepted.set(+m[1], (intercepted.get(+m[1]) || 0) + 1);
        else if (l.trim() && !l.startsWith("[enosys]") && !/logging before google\.Init:/i.test(l)) rest.push(l);
      }
      ok({ code, sig, out, err: rest.join("\n"), ms: Date.now() - t0 });
    });
  });
}
const events = (out) => out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const steps = {};
const tail = (s) => String(s || "").trim().split("\n").slice(-6).join("\n").slice(0, 600);

say(`\n── version`);
{
  const r = await run(["--version"], 60000);
  const pass = r.code === 0 && r.out.includes(VER);
  steps.version = { pass, ms: r.ms, ...(pass ? {} : { detail: tail(r.err || r.out) || `退出码 ${r.code} ${r.sig || ""}` }) };
  say(pass ? `✓ ${r.out.trim()}` : `✗ ${steps.version.detail}`);
}

const token = "cc-verify-" + crypto.randomBytes(4).toString("hex");
const common = isAgy
  ? ["--output-format", "stream-json", ...(MODEL ? ["--model", MODEL] : [])]
  : ["--output-format", "stream-json", "--verbose", "--max-turns", "4", ...(MODEL ? ["--model", MODEL] : [])];
let sid = "";
say(`\n── tools（调一次模型，让它用命令写读一个文件）`);
if (steps.version.pass) {
  const prompt = isAgy
    ? `Use run_command to execute exactly: printf %s ${token} > probe.txt && cat probe.txt\nThen reply with only the command's output, nothing else.`
    : `Use the Bash tool to run exactly this command: printf %s ${token} > probe.txt && cat probe.txt\nThen reply with only the command's output, nothing else.`;
  const r = await run(["-p", prompt, ...(isAgy ? ["--dangerously-skip-permissions"] : ["--allowedTools", "Bash"]), ...common]);
  const evs = events(r.out), res = evs.find((e) => e.type === "result");
  const sidEv = evs.find((e) => e.session_id || e.conversation_id);
  sid = res?.session_id || res?.conversation_id || sidEv?.session_id || sidEv?.conversation_id || "";
  const file = (() => { try { return fs.readFileSync(path.join(work, "probe.txt"), "utf8"); } catch { return ""; } })();
  if (isAgy) {
    const why = r.code !== 0 ? (tail(r.err || r.out) || `退出码 ${r.code}`) : file !== token ? "probe.txt 内容不对" : !(r.out || "").includes(token) ? "最后的回复里没有标记串" : "";
    steps.tools = { pass: !why, ms: r.ms, ...(why ? { detail: why } : {}) };
  } else {
    const usedBash = evs.some((e) => e.type === "assistant" && (e.message?.content || []).some((c) => c.type === "tool_use" && c.name === "Bash"));
    const toolOut = evs.some((e) => e.type === "user" && JSON.stringify(e.message?.content || "").includes(token));
    const why = !res ? "没有 result 事件" : res.is_error ? "result 报错：" + String(res.result || res.subtype).slice(0, 300)
      : !usedBash ? "没有调用 Bash 工具" : !toolOut ? "工具结果里没有标记串" : file !== token ? "probe.txt 内容不对" : !String(res.result || "").includes(token) ? "最后的回复里没有标记串" : "";
    steps.tools = { pass: !why, ms: r.ms, ...(why ? { detail: why + (r.err ? "\n" + tail(r.err) : "") } : {}) };
  }
  say(steps.tools.pass ? `✓ 工具调用、文件读写、流式输出都正常（${(r.ms / 1000).toFixed(1)} 秒）` : `✗ ${steps.tools.detail}`);
} else steps.tools = { pass: false, detail: "version 没过，跳过" };

say(`\n── resume（接着上一轮问一句）`);
if (steps.tools.pass && (sid || isAgy)) {
  const resumeFlag = isAgy ? (sid ? ["--resume", sid] : ["--continue"]) : ["--resume", sid];
  const r = await run(["-p", "What exact string did the command print in your previous turn? Reply with only that string.", ...resumeFlag, ...common]);
  if (isAgy) {
    const why = r.code !== 0 ? (tail(r.err || r.out) || `退出码 ${r.code}`) : !(r.out || "").includes(token) ? "没接上上一轮（回复里没有标记串）" : "";
    steps.resume = { pass: !why, ms: r.ms, ...(why ? { detail: why } : {}) };
  } else {
    const res = events(r.out).find((e) => e.type === "result");
    const why = !res ? "没有 result 事件" : res.is_error ? "result 报错：" + String(res.result || res.subtype).slice(0, 300) : !String(res.result || "").includes(token) ? "没接上上一轮（回复里没有标记串）" : "";
    steps.resume = { pass: !why, ms: r.ms, ...(why ? { detail: why + (r.err ? "\n" + tail(r.err) : "") } : {}) };
  }
  say(steps.resume.pass ? `✓ 会话接得上` : `✗ ${steps.resume.detail}`);
} else steps.resume = { pass: false, detail: "tools 没过，跳过" };

// ── 3. 结果 ──────────────────────────────────────────────────
const syscalls = [...intercepted].sort((a, b) => a[0] - b[0]).map(([nr, n]) => ({ nr, name: NAMES[nr] || "", count: n, known: KNOWN.has(nr) }));
const fresh = syscalls.filter((s) => !s.known);
say(`\n── 被 seccomp 拦下的系统调用`);
say(syscalls.length ? syscalls.map((s) => `  ${s.nr} ${s.name || "?"} ×${s.count}${s.known ? "（已知，会自己退回老调用）" : "  ← 以前没见过"}`).join("\n") : "  没有");

const pass = steps.version.pass && steps.tools.pass && steps.resume.pass;
const result = { v: 1, engine: binName, version: VER, sha256: sha, npmOnly, at: new Date().toISOString(), device, app: info.app, devkit: info.devkit, model: MODEL || "", steps, syscalls, pass, newSyscalls: fresh.length > 0 };
fs.mkdirSync(OUTDIR, { recursive: true });
const outFile = path.join(OUTDIR, `${binName}-verify-${VER}.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 1) + "\n");
say(`\n${pass ? (fresh.length ? "⚠ 三步都过了，但出现了以前没见过的被拦调用，留意功能是否缺失" : "✓ 通过") : "✗ 没通过"}：${outFile}`);
if (KEEP) say(`临时目录留着：${tmpBase}`);
process.exitCode = pass ? 0 : 1;
