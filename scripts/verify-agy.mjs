#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  verify-agy.mjs —— 在真机上验一版 Antigravity CLI (agy) 能不能在 hachimia 里正常用（在 hachimia 的终端里跑）
//
//  node verify-agy.mjs [版本号|stable|latest] [--out <目录>] [--keep] [--bin <agy 二进制>]
//  （要验的正好是当前装的那一版就直接用它，不再下载；--bin 直接验给定的二进制，版本号以它 --version 报的为准）
//
//  做什么（不动你当前装的那一版）：
//   1. 用 App 自带的 install-agy.mjs 把这一版装进临时目录（同样先对 install.sh 的钉住哈希，见 install-agy.mjs）
//   2. 不登录、只跑两步零成本探测（agy 是 bionic 原生构建，不套 seccomp 监督器、不用 glibc 加载器）：
//        version  agy --version 报的是这一版
//        acp      agy acp 的 initialize 握手：agentInfo.version 是这一版、authMethods 非空
//      注意：绝不用 -p /usage 当登录探测——未登录时它会交互式等 60 秒（VERIFY-REPORT）。
//      tools / resume 两步要真的调模型（要登录），这里不做；登录后的会话能力由维护者在真机上另验。
//   3. 结果写成 agy-verify-<版本>.json（设备、Android 版本、App 与工具包版本、每步结果）
//  维护者拿结果文件在发布机上跑 scripts/agy-verified.mjs add，签名后经 GitHub raw 发给所有用户：
//  版本选单标「已验证」；标成有问题的版本，自动更新不会装。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const OUTDIR = opt("--out") || process.cwd(), KEEP = flag("--keep"), GIVEN = opt("--bin");
const WANT = argv[0] || "stable";
const say = (s) => console.log(s);
const die = (s) => { console.log("✗ " + s); process.exit(1); };

const { PREFIX, HOME, CCAPP_BIN } = process.env;
// --bin 直接验给定的二进制时，不要求在 hachimia 终端里（开发机上也能跑）；
// 要下载安装时才必须在终端里（要 App 自带的 install-agy.mjs 与工具包 node）
if (!GIVEN && (!PREFIX || !CCAPP_BIN)) die("要在 hachimia 的终端里跑（没有 PREFIX / CCAPP_BIN），或用 --bin 直接验一个 agy 二进制");
const APP = CCAPP_BIN ? path.dirname(CCAPP_BIN) : "";
const INSTALL_AGY = APP ? path.join(APP, "scripts", "install-agy.mjs") : "";
if (!GIVEN && !fs.existsSync(INSTALL_AGY)) die("找不到 " + INSTALL_AGY + "（App 太旧？）");

const tmpBase = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "agy-verify-"));
const cleanup = () => { if (!KEEP) fs.rmSync(tmpBase, { recursive: true, force: true }); };
process.on("exit", cleanup);

const getprop = (k) => spawnSync("/system/bin/getprop", [k], { encoding: "utf8" }).stdout?.trim() || "";
const device = { model: getprop("ro.product.model"), maker: getprop("ro.product.manufacturer"), android: getprop("ro.build.version.release"),
  sdk: +getprop("ro.build.version.sdk") || 0, kernel: os.release(), targetSdk: +process.env.CCAPP_TARGET_SDK || 0, exec: process.env.CCAPP_EXEC || "" };

// 端口只认数字（和 verify-claude.mjs 一样的理由）：带 @ 之类会把令牌头送到别的主机
const PORT = /^\d{1,5}$/.test(process.env.CCAPP_PORT || "") ? process.env.CCAPP_PORT : "9793";
// App / 工具包版本：问本机网关（终端里有它的令牌文件）
async function appInfo() {
  try {
    // claudeEnv() 为防泄漏会删掉 CCAPP_TOKEN_FILE，应用内终端里跑这个脚本时变量不存在；
    // 令牌就在 home 的固定位置（和 cc-archive.mjs 一样直接读），否则这里整段失败、结果里没有 App 版本
    const tf = process.env.CCAPP_TOKEN_FILE || path.join(HOME || os.homedir(), ".gateway-token");
    const tok = fs.readFileSync(tf, "utf8").trim(), mac = (s) => crypto.createHmac("sha256", tok).update(s).digest("hex");
    // 不发令牌原文：先核身份（端口上可能是网关没起来时抢占的应用），再按 sig2 一次一签
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
    return { app: it("app"), devkit: it("devkit"), current: it("claude") || it("agy"), channel };
  } catch { return { app: "", devkit: "", current: "", channel: "" }; }
}

// ── 1. 拿到要验的二进制 ─────────────────────────────────────────────
const info = await appInfo();
say(`设备 ${device.maker} ${device.model} · Android ${device.android}（SDK ${device.sdk}）· App ${info.app || "?"} · ${info.devkit || "工具包 ?"}`);
const installed = path.join(HOME || os.homedir(), ".local/share/hachimia/agy");
let VER = "", BIN = "", manifestSha512 = "";
if (GIVEN) {
  BIN = path.resolve(GIVEN);
  VER = /\d+\.\d+\.\d+/.exec(spawnSync(BIN, ["--version"], { encoding: "utf8", timeout: 15000 }).stdout || "")?.[0] || "";
  if (!VER) die(`${BIN} 报不出版本号`);
  say(`\n── 直接验 ${BIN}（${VER}）`);
  // --bin 验的是已装的那份时，本地清单里记着它那次安装的 manifest sha512（来源，不是复核）
  try { manifestSha512 = JSON.parse(fs.readFileSync(path.join(path.dirname(BIN), "manifest.json"), "utf8")).manifestSha512 || ""; } catch {}
}
// 当前装的：网关说的为准，取不到读 current 链接；渠道版本网关取不到就直接问官方清单
if (!info.current) try { info.current = path.basename(fs.readlinkSync(path.join(installed, "current"))); } catch {}
if (!GIVEN && !info.channel && /^(stable|latest)$/.test(WANT)) {
  const base = process.env.HACHIMIA_AGY_MANIFEST_BASE || "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  try {
    const j = await (await fetch(`${base}/android_${arch}.json`, { signal: AbortSignal.timeout(8000) })).json();
    if (/^\d+\.\d+\.\d+/.test(j?.version || "")) info.channel = j.version.trim();
  } catch {}
}
const target = /^(stable|latest)$/.test(WANT) ? info.channel : WANT;
if (!GIVEN && target && target === info.current && fs.existsSync(path.join(installed, info.current, "agy"))) {
  VER = info.current; BIN = path.join(installed, VER, "agy");
  try { manifestSha512 = JSON.parse(fs.readFileSync(path.join(installed, VER, "manifest.json"), "utf8")).manifestSha512 || ""; } catch {}
  say(`\n── ${VER} 就是当前装的，直接用`);
} else if (!GIVEN) {
  const scratchHome = path.join(tmpBase, "home");
  fs.mkdirSync(scratchHome, { recursive: true });
  say(`\n── 下载 ${WANT}${target ? `（${target}）` : ""}，装在临时目录，不动当前的 ${info.current || "版本"}${target && target !== info.current ? "" : info.current ? `（${info.current} 的程序文件不在，只好下载）` : ""}`);
  const inst = spawnSync(path.join(PREFIX, "bin/node"), [INSTALL_AGY, WANT], { env: { ...process.env, HOME: scratchHome }, stdio: ["ignore", "inherit", "inherit"] });
  const dest = path.join(scratchHome, ".local/share/hachimia/agy");
  try { VER = path.basename(fs.readlinkSync(path.join(dest, "current"))); } catch {}
  if (inst.status !== 0 || !VER) die("下载没成功");
  BIN = path.join(dest, VER, "agy");
  try { manifestSha512 = JSON.parse(fs.readFileSync(path.join(dest, VER, "manifest.json"), "utf8")).manifestSha512 || ""; } catch {}
}
const sha = crypto.createHash("sha256").update(fs.readFileSync(BIN)).digest("hex");

// ── 2. 两步实跑（不登录） ────────────────────────────────────────────
const steps = {};
const tail = (s) => String(s || "").trim().split("\n").slice(-6).join("\n").slice(0, 600);

say(`\n── version`);
{
  const r = spawnSync(BIN, ["--version"], { encoding: "utf8", timeout: 60000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = r.status === 0 && out.includes(VER);
  steps.version = { pass, ...(pass ? {} : { detail: tail(r.error?.message || out) || `退出码 ${r.status ?? "null"}` }) };
  say(pass ? `✓ ${out.trim().split("\n")[0]}` : `✗ ${steps.version.detail}`);
}

say(`\n── acp（initialize 握手，不登录）`);
if (steps.version.pass) {
  const r = await new Promise((ok) => {
    const t0 = Date.now();
    const child = spawn(BIN, ["acp"], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "", done = false;
    const finish = (res) => { if (done) return; done = true; try { child.kill("SIGKILL"); } catch {} ok({ ...res, ms: Date.now() - t0 }); };
    const timer = setTimeout(() => finish({ pass: false, detail: "initialize 30 秒没回" }), 30000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          clearTimeout(timer);
          const ai = m.result?.agentInfo || {};
          const auth = m.result?.authMethods;
          const why = m.error ? `initialize 报错：${JSON.stringify(m.error).slice(0, 300)}`
            : ai.version !== VER ? `agentInfo.version 是 ${ai.version || "（空）"}，不是 ${VER}`
            : !Array.isArray(auth) || !auth.length ? "initialize 没回 authMethods" : "";
          finish({ pass: !why, ...(why ? { detail: why } : { agentVersion: ai.version, authMethods: auth.map((a) => a.id || a.name || "?") }) });
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); finish({ pass: false, detail: `起不来：${e.message}` }); });
    child.on("close", (code) => { if (!done) finish({ pass: false, detail: `acp 没等到 initialize 回复就退了（码 ${code}）${err ? "：" + tail(err) : ""}` }); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "hachimia-verify", version: "0.1.0" } } }) + "\n");
  });
  steps.acp = r;
  say(r.pass ? `✓ agentInfo.version ${r.agentVersion}，authMethods：${r.authMethods.join("、")}（${(r.ms / 1000).toFixed(1)} 秒）` : `✗ ${r.detail}`);
} else steps.acp = { pass: false, detail: "version 没过，跳过" };

// ── 3. 结果 ──────────────────────────────────────────────────────────
const pass = steps.version.pass && steps.acp.pass;
const result = { v: 1, version: VER, sha256: sha, sha512: manifestSha512, at: new Date().toISOString(),
  device, app: info.app, devkit: info.devkit, steps, pass };
fs.mkdirSync(OUTDIR, { recursive: true });
const outFile = path.join(OUTDIR, `agy-verify-${VER}.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 1) + "\n");
say(`\n${pass ? "✓ 通过" : "✗ 没通过"}：${outFile}`);
if (KEEP) say(`临时目录留着：${tmpBase}`);
process.exitCode = pass ? 0 : 1;
