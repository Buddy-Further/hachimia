#!/usr/bin/env node
// cc-seal.mjs —— 应用内终端里敲的 claude（bin/claude 包装）在发行版下的封口与回填，和网关起的一样（见 gw/edition.mjs、gw/seal.mjs）。
// 用法：node cc-seal.mjs <工作目录> -- <包装给的参数…> -- <用户的参数…>
// 成功：stdout 一行，按 sh 单引号转义好的完整参数，包装 eval "set -- …" 后 exec；退出码 0。
// 拒绝：stderr 说明，退出码 3（配置结构检查未通过）、2（用了发行版不认的旗标）或 4（claude 程序没核过）。
// 包装给的参数（guard 钩子、密钥读取器的 --settings）可以带 --settings；用户自己带的那些能往上下文里塞东西的旗标一律不认。
import fs from "node:fs";
import path from "node:path";
// stdout 只放结果：网关模块的日志改走 stderr（先改再加载模块）
console.log = (...a) => process.stderr.write(a.join(" ") + "\n");
const { sealArgv, sealed } = await import("../gw/edition.mjs");
const { sealBlockMessage, sealPrepare } = await import("../gw/seal.mjs");
const { tr, tz, HERE } = await import("../gw/config.mjs");
const { readSmallFile } = await import("../gw/saferead.mjs");

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const argv = process.argv.slice(2);
const cwd = argv[0] || process.cwd();
const i1 = argv.indexOf("--", 1), i2 = argv.indexOf("--", i1 + 1);
if (i1 < 0 || i2 < 0) { process.stderr.write("cc-seal: bad arguments\n"); process.exit(2); }
const ours = argv.slice(i1 + 1, i2), user = argv.slice(i2 + 1);

// 开发版：原样交回
if (!sealed()) { process.stdout.write([...ours, ...user].map(q).join(" ") + "\n"); process.exit(0); }

// agy / claude 程序本身：和网关起的一样（gw/claudeseal.mjs），没有本地清单或和清单对不上就不起；管理子命令也一样，跑的是同一个程序。
{
  const { claudeSeal } = await import("../gw/claudeseal.mjs");
  const { PATHS } = await import("../gw/config.mjs");
  // 和 bin/agy / bin/claude 最后 exec 的是同一条路径：优先按 $HOME 算（CCAPP_HOME 终端里能随便改，不能让核的和跑的是两份）
  // bin/claude 传入 CCAPP_SEAL_TARGET=claude 时必须核验 claude 二进制本身，不能因本机装有 agy 或注入 CCAPP_AGY 而跳过 claude 核验
  const home = process.env.HOME || "/nonexistent";
  const agyDef = path.join(home, ".local", "share", "hachimia", "agy", "current", "agy");
  const claudeDef = path.join(home, ".local", "share", "cccodroid", "claude", "current", "claude");
  const target = process.env.CCAPP_SEAL_TARGET || "";
  const agyBin = process.env.CCAPP_AGY || agyDef;
  const claudeBin = process.env.CCAPP_CLAUDE || claudeDef;
  const BIN = target === "claude"
    ? claudeDef
    : (target === "agy"
      ? agyDef
      : (fs.existsSync(agyBin) ? agyBin
        : (fs.existsSync(claudeBin) ? claudeBin
          : (PATHS.agy && fs.existsSync(PATHS.agy) ? PATHS.agy
            : (PATHS.claude && fs.existsSync(PATHS.claude) ? PATHS.claude : agyBin)))));
  const check = () => claudeSeal(BIN, { home }).catch((e) => ({ ok: false, why: e.message }));
  const cs = await check();
  // 核验未过时直接 fail-closed 拒停（不再联网补核或执行外部脚本，0.6.9 审计 195-M.4 / Wave 4）
  if (cs.ok === false) {
    const m = tz("Antigravity CLI 程序核验没过，这次没有运行：{why}", { why: String(cs.why || "") });
    process.stderr.write("hachimia: " + m + "\nhachimia: " + tr("en", m) + "\n");
    process.exit(4);
  }
}

// 能往上下文 / 配置里塞东西的旗标：发行版终端不认（用户的 --settings 能挂 SessionStart 钩子注入，--system-prompt 能整个换掉系统提示）
const DENY = ["--settings", "--setting-sources", "--plugin-dir", "--plugin-url", "--append-system-prompt", "--append-system-prompt-file",
  "--system-prompt", "--system-prompt-file", "--agents", "--mcp-config", "--bare", "--safe-mode", "--append-subagent-system-prompt",
  "--append-subagent-system-prompt-file"];
// 管理子命令（mcp / plugin / config…）不开会话，照常
const probe = sealArgv(user);
const isSession = probe !== user;
if (isSession) {
  for (const a of user) {
    if (a === "--") break;
    const flag = a.split("=")[0];
    if (DENY.includes(flag)) {
      process.stderr.write(`hachimia: ${flag} 在发行版里不能用（Claude Code 的配置由 hachimia 检查后代为加载）。\n` +
        `hachimia: ${flag} is not available in the release build (hachimia loads your Claude Code config after checking it).\n`);
      process.exit(2);
    }
  }
}
let out = [...ours, ...user];
if (isSession) {
  let prep;
  let style = "";
  try { style = JSON.parse(readSmallFile(path.join(process.env.HOME || "", "ccapp-settings.json"), 1 << 20) || "{}").outputStyle || ""; } catch {}
  try { prep = sealPrepare({ cwd, runId: "term-" + process.ppid + "-" + Date.now(), outputStyle: style }); }
  catch (e) { process.stderr.write("hachimia: " + e.message + "\n"); process.exit(3); }
  if (prep.block) { const m = sealBlockMessage(prep.block); process.stderr.write(m + "\n\n" + tr("en", m) + "\n"); process.exit(3); }
  out = [...ours, ...prep.args, ...(prep.settings && Object.keys(prep.settings).length ? ["--settings", JSON.stringify(prep.settings)] : []), ...user];
}
try { out = sealArgv(out); } catch (e) { process.stderr.write("hachimia: " + e.message + "\n"); process.exit(2); }
process.stdout.write(out.map(q).join(" ") + "\n");
