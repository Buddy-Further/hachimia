#!/usr/bin/env node
// 网关测试：node scripts/test.mjs [文件名片段 …]
//
// 每次在一个新建的临时目录里跑：CCAPP_HOME / HOME / CCAPP_WORKSPACE 指过去，假 $PREFIX 里放系统 curl 链接与受控 toybox兼容 flock fixture，
// CCAPP_TEST=1 让网关模块导入时不做任何启动动作（见 gw/config.mjs 的 LIVE）。所以在开发机上跑也碰不到真数据。
// 临时目录要能建软链：安卓上别放 /sdcard（没设 TMPDIR 时自动用 ~/.cache）。
//
// 分池并行（test-value 清理后的默认）：按下方实测墙钟贪心把文件分进 N 个池（N = min(4, 核数)，CCAPP_TEST_POOLS 覆盖，=1 即原串行）。
// 每池独立临时 home / PREFIX / workspace / 端口（9793+i），池内串行（--test-concurrency=1）、文件按字母序，与单进程串行的相对顺序一致。
// 池输出各自写日志，任一池失败则整体失败，结束后印结构化失败汇总与各池计数。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installRegistryFlock } from "../gateway/tests/fixtures/registry-flock.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "gateway", "tests");
const want = process.argv.slice(2);
const files = fs.readdirSync(TESTS).filter((f) => f.endsWith(".test.mjs") && (!want.length || want.some((w) => f.includes(w)))).sort();
if (!files.length) { console.error("没有匹配的测试文件"); process.exit(1); }

// 分池权重：慢文件的实测墙钟（毫秒，开发机 2026-11-19 全量串行测得；慢在真实产品路径——bridge 子进程冷起、
// bgseal 的产品计时器等——不能删只能并行）。没列到的按 1s 计。权重只影响池子平衡，不影响执行顺序和结果；
// 重测方式：用 --test-reporter 统计文件 dequeue→complete 墙钟后回填这张表。
const MS = {
  "bgseal.test.mjs": 130404,
  "run0520.test.mjs": 121831,
  "bridge-config.test.mjs": 57078,
  "bridge-models.test.mjs": 33765,
  "managed-bridge.test.mjs": 16885,
  "office-worker-model.test.mjs": 16259,
  "ccmem0520.test.mjs": 14743,
  "a0610-main-run.test.mjs": 13430,
  "a0610-main-providers.test.mjs": 12797,
  "archive.test.mjs": 12283,
  "stab-e-perm.test.mjs": 7681,
  "audit1101.test.mjs": 6714,
  "a0610-f2-ext.test.mjs": 6706,
  "stab2-h-run-pad.test.mjs": 6691,
  "session-created-070.test.mjs": 6386,
  "ccmem.test.mjs": 6244,
};

const cores = os.availableParallelism ? os.availableParallelism() : (os.cpus().length || 1);
const POOLS = Math.max(1, Math.min(8, +(process.env.CCAPP_TEST_POOLS || Math.min(4, cores)) || 1));
// 覆盖率报告要汇总看，分池会散进各池日志 → 体检模式强制串行
const poolCount = process.env.CCAPP_TEST_COVERAGE ? 1 : Math.min(POOLS, files.length);
const buckets = Array.from({ length: poolCount }, () => ({ sum: 0, files: [] }));
for (const f of [...files].sort((a, b) => (MS[b] || 1000) - (MS[a] || 1000))) {
  buckets.sort((a, b) => a.sum - b.sum);
  buckets[0].files.push(f);
  buckets[0].sum += MS[f] || 1000;
}
const pools = buckets.map((b) => b.files.sort()); // 池内字母序 = 与串行相对顺序一致
if (poolCount > 1) console.error(`分 ${poolCount} 池并行（CCAPP_TEST_POOLS 可覆盖，=1 串行）`);

// 在 hachimia 里跑时环境里有二十几个 CCAPP_* 指着真数据：一个不留全删，再只设测试要的（审查 L18）。
// 网关给 claude 注入的 CLAUDE_CODE_* / ANTHROPIC_*（上下文窗口、接口地址…）也会漏进被测的 claudeEnv，一并去掉（11-01 独立审查）
// 沙箱 egress 代理变量（HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 及小写）也会透进测试子进程：claudeEnv 判 viaProxy 为真就跳过
// streamfix，U.6 因此挂（D 报告 §B：清掉这 6 个变量后 2/2 通过）。只在测试子进程环境里过滤，不动生产代码
// gateway/gw/ 的 viaProxy 判定本身；NO_PROXY/no_proxy 是放行名单，不影响判定，保留。
const PROXY_VARS = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]);
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CCAPP_|CLAUDE_CODE_|ANTHROPIC_)/.test(k) && !PROXY_VARS.has(k)));
const loaderBin = process.env.CCAPP_LOADER_BIN ? path.resolve(process.env.CCAPP_LOADER_BIN) : "";
if (clean.PATH) {
  clean.PATH = clean.PATH.split(":").filter((d) => {
    if (!d) return false;
    const norm = path.resolve(d);
    if (loaderBin && norm === loaderBin) return false;
    if (path.basename(norm) === "loader-bin") return false;
    return true;
  }).join(":");
}
if (clean.SHELL && ((loaderBin && path.resolve(clean.SHELL).startsWith(loaderBin + path.sep)) || clean.SHELL.includes("/loader-bin/") || clean.SHELL.endsWith("/libccrun.so"))) {
  const realSh = process.env.CCAPP_SHELL || (process.env.PREFIX && fs.existsSync(path.join(process.env.PREFIX, "bin", "bash")) ? path.join(process.env.PREFIX, "bin", "bash") : "");
  if (realSh) clean.SHELL = realSh;
  else delete clean.SHELL;
}

const curl = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8", env: clean }).stdout.trim();
if (!curl) { console.error("找不到 curl"); process.exit(1); }

// 安卓上 /tmp 应用写不进：没设 TMPDIR 又写不进系统临时目录时，用 ~/.cache
const writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
const rawBase = process.env.TMPDIR || (writable(os.tmpdir()) ? os.tmpdir() : path.join(os.homedir(), ".cache"));
fs.mkdirSync(rawBase, { recursive: true });
const base = fs.realpathSync(rawBase);
const tmpRoot = fs.mkdtempSync(path.join(base, "hachimia-test-")); // 只放各池日志
const poolTmps = []; // 每池一个平级 hachimia-test-*（registry-flock fixture 要求 basename 以此开头）

// 网关给子进程的 PATH 只有假 $PREFIX/bin、$CCAPP_BIN、/system/bin（见 gw/claude.mjs 的 claudeEnv）。
// 真机上 sleep / mkdir / cat / gzip 这些由 /system/bin 的 toybox 兜底；CI 的 Ubuntu 没有 /system/bin，
// 测试里的假脚本（soffice、假 CLI、自检…）就会报「命令找不到」，失败信息还看着像被测代码坏了。
// 在假前缀里补一份基础命令，造出与真机前缀相近的环境。tar / sh / git / curl / flock 由各测试自己链接，不放这里。
const BASIC = ["awk","basename","cat","chmod","cp","cut","date","df","dirname","du","env","find","grep","gzip","head","id","ln","ls","mkdir","mktemp","mv","readlink","realpath","rm","sed","seq","sleep","sort","stat","tail","tee","touch","tr","uname","uniq","wc","xargs","zcat"];

function setupEnv(i) {
  const tmp = fs.mkdtempSync(path.join(base, "hachimia-test-"));
  poolTmps.push(tmp);
  const home = path.join(tmp, "home"), prefix = path.join(tmp, "usr"), workspace = path.join(tmp, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.symlinkSync(curl, path.join(prefix, "bin", "curl"));
  installRegistryFlock(prefix, home, tmp); // 只写本轮假 PREFIX；锁协议测试不依赖开发机 util-linux / toybox。
  for (const name of BASIC) {
    const dst = path.join(prefix, "bin", name);
    if (fs.existsSync(dst)) continue;
    const real = spawnSync("sh", ["-c", "command -v " + name], { encoding: "utf8", env: clean }).stdout.trim();
    // dash 对 printf / true 这类内建返回的是名字而不是路径，别拿它建软链
    if (path.isAbsolute(real)) fs.symlinkSync(real, dst);
  }
  return { tmp, env: { ...clean, CCAPP_TEST: "1", CCAPP_HOME: home, HOME: home, CCAPP_WORKSPACE: workspace, CCAPP_PREFIX: prefix, CCAPP_PORT: String(9793 + i), CCAPP_LOG: path.join(tmp, "gateway.log"), CCAPP_TMP: tmp } };
}

// 异步起：被 timeout / Ctrl-C / 关终端打断时也要删掉临时目录（以前用 spawnSync，信号一来整个进程直接没了，4 天攒下 29 个，D10）。
// 收到信号先转给测试进程，等它退出再删；SIGKILL 接不住，留给存储的自动清理（$TMPDIR 里 7 天没动的）
// CCAPP_TEST_COVERAGE=1 时给子进程加覆盖率旗标：体检测试套件用（哪些行/分支从没被断言摸过）
// --test-reporter=spec：强制输出格式确定。Node 22 管道默认 TAP、Node 24 管道默认 spec，不指定时 summary() 的
// spec 正则在 CI（Node 22）上一次也匹配不上（三次 CI 运行 12 条“池结束”行全部“无摘要”）；指定后两边都是 spec。
// reporter 只改呈现格式，不改用例执行、顺序、并发、退出码；与 --experimental-test-coverage 正交。
const args = ["--test", "--test-concurrency=1", "--test-reporter=spec"];
if (process.env.CCAPP_TEST_COVERAGE) args.push("--experimental-test-coverage");

// 池日志的计数：spec（ℹ tests …）与 TAP（# tests …）都认。正常走 spec 分支；TAP 分支是 reporter 万一被改动时的第二道防线。
const parseSummary = (log) => {
  try {
    const text = fs.readFileSync(log, "utf8");
    const m = text.match(/ℹ tests (\d+)\s*\nℹ suites \d+\s*\nℹ pass (\d+)\s*\nℹ fail (\d+)/)
      || text.match(/# tests (\d+)\s*\n# suites \d+\s*\n# pass (\d+)\s*\n# fail (\d+)/);
    return m ? { tests: +m[1], pass: +m[2], fail: +m[3] } : null;
  } catch { return null; }
};
const summary = (log) => {
  const s = parseSummary(log);
  return s ? `tests ${s.tests} pass ${s.pass} fail ${s.fail}` : "";
};

// 从池日志解析失败项 [{file, line, name}]。先试 spec 的 ✖ failing tests: 节（test at 文件:行:列 + 紧随的 ✖ 测试名），
// 再试 TAP（not ok N - 测试名 + 随后 YAML 的 location: 文件:行:列；文件级 not ok 跳过，只认测试级）。
// spec 节里没解析出任何项时返回 []，调用方再用 tail() 作 fallback；TAP 里没有 location 的项 line 为 null。
const parseFailures = (log) => {
  let text;
  try { text = fs.readFileSync(log, "utf8"); } catch { return []; }
  const lines = text.split("\n");
  const rel = (p) => {
    const i = p.indexOf("gateway/tests/");
    return i >= 0 ? p.slice(i) : path.basename(p);
  };
  const specStart = lines.findIndex((l) => l.includes("✖ failing tests:"));
  if (specStart >= 0) {
    const out = [];
    let at = null;
    for (const line of lines.slice(specStart + 1)) {
      const mAt = line.match(/^\s*test at (\S+):(\d+):(\d+)\s*$/);
      if (mAt) { at = { file: rel(mAt[1]), line: +mAt[2] }; continue; }
      const mName = line.match(/^\s*✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?\s*$/);
      if (mName && at) {
        const name = mName[1];
        out.push(name.endsWith(".test.mjs") ? { file: at.file, line: at.line, name: rel(name) } : { file: at.file, line: at.line, name });
        at = null;
      }
    }
    if (out.length) return out;
  }
  const out = [];
  let currentFile = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mSub = line.match(/^# Subtest: (.+\.test\.mjs)\s*$/);
    if (mSub) { currentFile = rel(mSub[1]); continue; }
    const mNotOk = line.match(/^( *)not ok \d+ - (.+?)\s*$/);
    if (!mNotOk) continue;
    const name = mNotOk[2];
    if (/\.test\.mjs$/.test(name)) { currentFile = rel(name); continue; }
    let file = currentFile, lineNo = null;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const mLoc = lines[j].match(/^\s*location: '?(.+?):(\d+):(\d+)'?/);
      if (mLoc) { file = rel(mLoc[1]); lineNo = +mLoc[2]; break; }
      if (/^( *)?(not ok|ok) \d+ - /.test(lines[j]) || lines[j].startsWith("# Subtest:")) break;
    }
    out.push({ file: file || "?", line: lineNo, name });
  }
  return out;
};
const tail = (log) => {
  try { return fs.readFileSync(log, "utf8").split("\n").slice(-70).join("\n"); } catch { return "(日志读不到)"; }
};

const children = [];
const startAt = Date.now();
for (let i = 0; i < poolCount; i++) {
  const { env } = setupEnv(i);
  const fileList = pools[i].map((f) => path.join(TESTS, f));
  const log = path.join(tmpRoot, `pool-${i}.log`);
  const fd = poolCount > 1 ? fs.openSync(log, "w") : "inherit";
  const child = spawn(process.execPath, [...args, ...fileList], { env, stdio: poolCount > 1 ? ["ignore", fd, fd] : "inherit", cwd: ROOT });
  if (poolCount > 1) fs.closeSync(fd);
  child.on("error", (e) => { console.error(`池 ${i} 起不来：${e.message}`); });
  children.push({ child, i, log, code: null });
}

let stopped = null;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { stopped = sig; for (const { child } of children) try { child.kill(sig); } catch {} });
}
const done = [];
const finishOne = (c, code) => {
  if (done.includes(c)) return; // spawn error 之后可能还会触发一次 exit
  c.code = code;
  done.push(c);
  if (poolCount > 1) {
    const wall = ((Date.now() - startAt) / 1000).toFixed(1);
    console.error(`池 ${c.i} 结束（${wall}s，exit ${c.code}，${summary(c.log) || "无摘要"}）`);
  }
  if (done.length === children.length) {
    const failed = done.filter((x) => x.code !== 0);
    if (poolCount > 1) {
      // 结构化失败汇总（替代以前只印各失败池尾部）：失败项按 [池 i] 文件:行 测试名列出；每池计数与总计都印，
      // 通过池的计数也印（以前通过池的计数从不打印，CI 前两次运行的总项数无从得知）。tail() 只在某失败池
      // 解析不到任何失败名时作 fallback，并标注。
      const ordered = [...done].sort((a, b) => a.i - b.i);
      const counts = ordered.map((c) => ({ i: c.i, s: parseSummary(c.log), code: c.code }));
      const total = counts.reduce((t, c) => { if (c.s) { t.tests += c.s.tests; t.pass += c.s.pass; t.fail += c.s.fail; } return t; }, { tests: 0, pass: 0, fail: 0 });
      const failures = [];
      const noNamePools = [];
      for (const c of ordered) {
        if (c.code === 0) continue;
        const items = parseFailures(c.log);
        if (items.length) for (const it of items) failures.push({ pool: c.i, ...it });
        else noNamePools.push(c);
      }
      if (failures.length) {
        console.error(`\n失败汇总（${failures.length} 项）：`);
        for (const f of failures) console.error(`✖ [池 ${f.pool}] ${f.file}${f.line != null ? ":" + f.line : ""} ${f.name}`);
      }
      console.error("各池计数：");
      for (const c of counts) console.error(c.s ? `池 ${c.i}：tests ${c.s.tests} pass ${c.s.pass} fail ${c.s.fail}` : `池 ${c.i}：无摘要（exit ${c.code}）`);
      if (counts.some((c) => c.s)) console.error(`总计：tests ${total.tests} pass ${total.pass} fail ${total.fail}`);
      for (const f of noNamePools) console.error(`\n—— 池 ${f.i} 日志尾部（未解析到失败名，见尾部）（${f.log}）——\n` + tail(f.log));
    }
    if (!process.env.KEEP_TEST_TMP) { fs.rmSync(tmpRoot, { recursive: true, force: true }); for (const t of poolTmps) fs.rmSync(t, { recursive: true, force: true }); }
    else console.error("临时目录留着：" + [tmpRoot, ...poolTmps].join(" "));
    if (stopped) console.error(`测试被 ${stopped} 打断，临时目录已${process.env.KEEP_TEST_TMP ? "留着" : "删掉"}`);
    process.exit(failed.length ? (stopped ? 130 : 1) : 0);
  }
};
for (const c of children) {
  c.child.on("error", () => finishOne(c, 1));
  c.child.on("exit", (code, signal) => finishOne(c, code ?? (signal || stopped ? 130 : 1)));
}
