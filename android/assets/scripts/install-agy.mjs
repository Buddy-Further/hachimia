// ─────────────────────────────────────────────────────────────────────
//  install-agy.mjs —— 安装 / 更新 / 校验官方 Antigravity CLI (agy)
//
//  用法:
//    node install-agy.mjs [stable|latest|<版本号>]   安装或更新 agy
//    node install-agy.mjs --check                    查询本机已装版本与在线可用性（输出 JSON）
//    node install-agy.mjs --recheck                  核对已装版本目录内 agy 的 sha256 清单
//  退出码：0 成功；1 一般失败；3 --recheck 发现不符；4 下载的 install.sh 与钉住的校验值不符（拒绝执行，见下）
//
//  官方 Android (bionic) 原生构建，直接运行在安卓内核上，无需 glibc 加载器或 proot。
//  安装目录：$HOME/.local/share/hachimia/agy/<version>/agy + current 软链。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INSTALL_URL = process.env.HACHIMIA_AGY_INSTALL_URL || "https://antigravity.google/cli/install.sh";
// 官方 install.sh 从这份 manifest 取版本号与下载地址（install.sh 本身不含版本变量，--check 直接问这里）
const MANIFEST_BASE = process.env.HACHIMIA_AGY_MANIFEST_BASE || "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
// P0-6/7：下载的 install.sh 执行前先对哈希（见下面安装流程里的校验；Google 不发布 install.sh 的签名或
// 官方哈希，唯一能钉住的就是这份随 APK 发的文件，改一处就够；测试可用 HACHIMIA_AGY_PINS 指到别处）
const PINS_PATH = process.env.HACHIMIA_AGY_PINS || path.join(path.dirname(fileURLToPath(import.meta.url)), "agy-install-pins.json");
const PREFIX = process.env.PREFIX || "";
const CURL = PREFIX ? path.join(PREFIX, "bin", "curl") : "curl";
const SH = fs.existsSync(path.join(PREFIX, "bin", "bash"))
  ? path.join(PREFIX, "bin", "bash")
  : (fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh");
const HOME = process.env.HOME || process.env.CCAPP_HOME || "";
const DEST = path.join(HOME, ".local", "share", "hachimia", "agy");
const ARG = process.argv[2] || "stable";

const say = (s) => console.log(s);
const die = (s) => { console.error("✗ " + s); process.exit(1); };

const sha256 = (f) => {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(f, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
};

const isVer = (v) => /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.+-]{1,40})?$/.test(v || "");

function parseVersion(text) {
  const m = String(text || "").match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.+-]+)?)\b/);
  return m ? m[1] : "";
}

function installedVersion() {
  try {
    const cur = fs.realpathSync(path.join(DEST, "current"));
    const dirName = path.basename(cur);
    // 0.0.0-local 是旧版装坏了的占位版本（E-11），不是真版本号：以二进制实际报的为准，报不出就是没装好
    if (isVer(dirName) && dirName !== "0.0.0-local") return dirName;
    const bin = path.join(cur, "agy");
    if (fs.existsSync(bin)) {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10000 });
      const v = parseVersion(r.stdout || r.stderr);
      return v || (dirName === "0.0.0-local" ? "" : dirName);
    }
  } catch {}
  return "";
}

function curlSmall(url, timeoutSec = 20) {
  const r = spawnSync(CURL, [
    "-fsSL", "--proto", "=https", "--proto-redir", "=https",
    "--connect-timeout", "10", "--max-time", String(timeoutSec), url,
  ], { maxBuffer: 16 << 20 });
  if (r.status === 0) return { ok: true, data: r.stdout };
  return { ok: false, status: r.status, err: String(r.stderr || r.error?.message || "").trim().slice(0, 200) };
}

// 官方 install.sh 的平台检测（hachimia 跑在安卓 bionic 上，通常就是 android_arm64）
function manifestUrl() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `${MANIFEST_BASE}/android_${arch}.json`;
}

// ── --check：供 Updater.java 查询版本状态 ──
if (ARG === "--check") {
  const cur = installedVersion();
  const res = curlSmall(manifestUrl(), 15);
  let latest = "";
  if (res.ok) {
    try { latest = parseVersion(JSON.parse(res.data.toString("utf8")).version || ""); } catch {}
  }
  // 上游 manifest 里没有可用的版本号时，latest 必须为空（A11）：拿已装版本冒充 latest，
  // Updater 会判“已是最新”，用户永远收不到新版；ok 也为 false，让调用方报检查失败而不是“已是最新”
  const latestOk = res.ok && latest !== "";
  console.log(JSON.stringify({
    ok: latestOk,
    installed: cur,
    latest: latestOk ? latest : "",
    source: manifestUrl(),
    error: latestOk ? "" : (res.ok ? "上游 manifest 里没有可用的版本号" : (res.err || `curl exit ${res.status}`)),
  }));
  process.exit(latestOk ? 0 : 1);
}

// ── --recheck：校验已装二进制与本地清单 sha256 ──
if (ARG === "--recheck") {
  let bad = 0;
  for (const d of (() => { try { return fs.readdirSync(DEST); } catch { return []; } })()) {
    const dir = path.join(DEST, d);
    const bin = path.join(dir, "agy");
    const mf = path.join(dir, "manifest.json");
    if (!isVer(d)) continue;
    // 版本目录缺二进制或缺清单就是安装不完整（A10）：以前直接跳过、报“通过”，损坏的版本就一直留着。
    // 缺失也写 .mismatch 标记：Updater 只看 current 目录下的这个标记来提示重装
    if (!fs.existsSync(bin) || !fs.existsSync(mf)) {
      bad++;
      try { fs.writeFileSync(path.join(dir, ".mismatch"), "incomplete\n"); } catch {}
      say(`✗ ${d}：安装不完整（缺 ${[!fs.existsSync(bin) && "agy 二进制", !fs.existsSync(mf) && "manifest.json"].filter(Boolean).join("、")}）`);
      continue;
    }
    try {
      const m = JSON.parse(fs.readFileSync(mf, "utf8"));
      const got = sha256(bin);
      if (m.sha256 && got === m.sha256) {
        fs.rmSync(path.join(dir, ".mismatch"), { force: true });
        say(`✓ ${d}：sha256 一致`);
      } else {
        bad++;
        fs.writeFileSync(path.join(dir, ".mismatch"), got + "\n");
        // 说清是哪两个值在比：已装二进制现算的 sha256 vs 本地清单里安装时记的那份（不是官方签名清单，Google 不发布）
        say(`✗ ${d}：已装二进制 sha256 与本地清单不符（期望 ${String(m.sha256 || "").slice(0, 12)}…，实得 ${got.slice(0, 12)}…），已写 .mismatch。到 设置 → 更新 里重新安装。`);
      }
    } catch (e) {
      bad++;
      say(`✗ ${d}：清单读取失败（${e.message}）`);
    }
  }
  process.exit(bad ? 3 : 0);
}

// ── 安装 / 更新流程 ──
if (!HOME) die("未设置 HOME 目录");
fs.mkdirSync(DEST, { recursive: true });

say(`正在获取官方 Antigravity CLI 安装脚本：${INSTALL_URL}`);
const fetched = curlSmall(INSTALL_URL, 30);
if (!fetched.ok) {
  die(`无法下载 Antigravity CLI 安装脚本（${fetched.err || "HTTP/网络错误"}）。请检查网络连接或代理设置后重试。`);
}

// P0-6/7：执行前先对哈希——只凭 TLS 下载并执行脚本是谁都能冒充的（上游主机被攻破就能发一个“配套”的坏
// manifest，install.sh 内部的 sha512 校验拦不住它）。Google 不发布 install.sh 的签名或官方哈希，所以唯一能
// 钉住的就是随 APK 发的 agy-install-pins.json 里的 sha256（2026-11-21 从 Google 下载、实测装出可用 1.5.13
// 的那份 install.sh 的哈希）。对不上就拒绝执行（fail-closed，退出码 4），绝不回落到只凭 TLS。
// 轮换风险（已接受）：上游一改脚本，旧版 App 在新校验值发下来之前都会拒绝安装，直到用户更新 App。
let pins;
try {
  pins = JSON.parse(fs.readFileSync(PINS_PATH, "utf8"));
} catch (e) {
  die(`读不到 agy 安装脚本校验值文件（${PINS_PATH}）：${e.message}。拒绝执行未校验的安装脚本。`);
}
const wantPin = pins?.installSh?.sha256 || "";
if (!/^[0-9a-f]{64}$/.test(wantPin)) {
  die(`agy 安装脚本校验值文件（${PINS_PATH}）里没有合法的 installSh.sha256，拒绝执行未校验的安装脚本。`);
}
const installShSha256 = crypto.createHash("sha256").update(fetched.data).digest("hex");
if (installShSha256 !== wantPin) {
  console.error(`✗ 安装脚本校验值已变化，请等待新版本更新校验值（期望 ${wantPin.slice(0, 12)}…，实得 ${installShSha256.slice(0, 12)}…）。已拒绝执行下载的安装脚本，未安装任何东西。`);
  process.exit(4);
}
say(`✓ 安装脚本 sha256 与钉住的校验值一致（${installShSha256.slice(0, 12)}…）`);

// P0-6/7：先问官方 manifest 再执行 install.sh，把版本 / 下载地址 / sha512 记下来写进本地清单。
// 注意这份 sha512 校验的是下载的安装包（tar.gz），不是装好的二进制——两者字节不同、算法也不同，
// 而且 install.sh 把下载的包放在它自己的暂存目录、退出时就清掉（trap cleanup EXIT），hachimia 从头到尾
// 拿不到那个包，所以**没法独立核对**这份 sha512：唯一核它的是 install.sh 自己拿它刚取的 manifest 现算
// （同一条 TLS 通道，主机被攻破就一起是坏的）。这里只记下来当作来源（provenance）：
// 本地清单里的 sha256 才是 hachimia 自己算的、seal 和 --recheck 实际核对的东西；manifestSha512 只说明
// “装的时候上游 manifest 是这么说的”，不要把它和已装二进制的 sha256 混为一谈。
const mfUrl = manifestUrl();
const mfRes = curlSmall(mfUrl, 20);
let manifestSha512 = "", manifestVersion = "";
if (!mfRes.ok) {
  die(`取不到官方 agy 版本清单（${mfUrl}：${mfRes.err || "HTTP/网络错误"}），未安装。install.sh 自己也要问这份清单，问不到它一样装不了。`);
}
try {
  const mj = JSON.parse(mfRes.data.toString("utf8"));
  manifestVersion = parseVersion(mj.version || "");
  manifestSha512 = typeof mj.sha512 === "string" ? mj.sha512.trim().toLowerCase() : "";
  if (!mj.url || !/^[0-9a-f]{128}$/.test(manifestSha512)) {
    die(`官方 agy 版本清单（${mfUrl}）里没有可用的下载地址 / sha512，清单可能坏了，未安装。`);
  }
} catch (e) {
  die(`官方 agy 版本清单（${mfUrl}）解析失败（${e.message}），未安装。`);
}

const stage = fs.mkdtempSync(path.join(DEST, ".stage-"));
const stageHome = path.join(stage, "home");
const stageScript = path.join(stage, "install.sh");
fs.mkdirSync(path.join(stageHome, ".local", "bin"), { recursive: true });
fs.writeFileSync(stageScript, fetched.data, { mode: 0o700 });

// 安装失败也要清掉暂存目录：die() 的 process.exit(1) 会跳过 finally（E-04），
// 所以 try 块里一律 throw，由外面的 catch 在 finally 清理完之后再退出。
let failed = null;
try {
  // 官方 install.sh 只认 -d/--dir（装到 <dir>/agy）；装进暂存 HOME 的 .local/bin，下面从那里搬到版本目录
  const binDir = path.join(stageHome, ".local", "bin");
  say(`正在运行官方安装脚本（--dir ${binDir}）…`);
  const env = {
    ...process.env,
    HOME: stageHome,
    TMPDIR: process.env.TMPDIR || stage,
  };
  const run = spawnSync(SH, [stageScript, "--dir", binDir], {
    cwd: stage,
    env,
    stdio: "inherit",
    timeout: 10 * 60e3,
  });
  if (run.status !== 0) {
    throw new Error(`官方安装脚本退出码 ${run.status ?? "null"}${run.signal ? `（信号 ${run.signal}）` : ""}`);
  }

  // 在暂存目录中查找安装好的 agy 二进制
  const candidates = [
    path.join(stageHome, ".local", "bin", "agy"),
    path.join(stageHome, ".antigravity", "bin", "agy"),
    path.join(stageHome, ".gemini", "bin", "agy"),
  ];
  let found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    // 递归兜底查找名为 agy 的可执行文件
    const walk = (d, depth = 0) => {
      if (depth > 5) return null;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isFile() && e.name === "agy") return p;
        if (e.isDirectory()) { const r = walk(p, depth + 1); if (r) return r; }
      }
      return null;
    };
    found = walk(stageHome);
  }
  if (!found) throw new Error("安装脚本运行完成，但未在目标目录找到 agy 可执行文件");

  const realFound = fs.realpathSync(found);
  fs.chmodSync(realFound, 0o755);
  // 刚装好的二进制必须自己能跑、且 --version 报得出版本号（A5/E-11）：
  // 报不出就说明装进来的东西是坏的或输出格式变了，不能把它钉成当前版，更不能回退到 0.0.0-local
  const vr = spawnSync(realFound, ["--version"], { encoding: "utf8", timeout: 15000 });
  if (vr.status !== 0) {
    throw new Error(`刚装好的 agy 无法运行（--version 退出码 ${vr.status ?? "null"}${vr.signal ? `（信号 ${vr.signal}）` : ""}），未安装`);
  }
  const ver = parseVersion(vr.stdout || vr.stderr);
  if (!ver) {
    throw new Error(`刚装好的 agy --version 没有报出版本号（输出：${String(vr.stdout || vr.stderr || "").trim().slice(0, 200) || "（空）"}），未安装`);
  }
  const verDir = path.join(DEST, ver);
  const verDirExisted = fs.existsSync(verDir);
  fs.mkdirSync(verDir, { recursive: true });

  const finalBin = path.join(verDir, "agy");
  fs.copyFileSync(realFound, finalBin);
  fs.chmodSync(finalBin, 0o755);

  // 拷贝后的最终文件再校验一次 --version（A5）：截断/损坏的拷贝 sha256 是现算的，能自洽过关，但跑不起来
  const vr2 = spawnSync(finalBin, ["--version"], { encoding: "utf8", timeout: 15000 });
  if (vr2.status !== 0 || parseVersion(vr2.stdout || vr2.stderr) !== ver) {
    try { fs.rmSync(finalBin, { force: true }); } catch {}
    try { fs.rmSync(path.join(verDir, "manifest.json"), { force: true }); } catch {}
    if (!verDirExisted) { try { fs.rmSync(verDir, { recursive: true, force: true }); } catch {} }
    throw new Error(`拷贝后的 agy 无法运行或版本号不对（期望 ${ver}），未安装`);
  }

  const sum = sha256(finalBin);
  // 本地清单同时记两套哈希，别混为一谈（D6）：
  //  - sha256：hachimia 自己对装好的二进制算的，seal 和 --recheck 核的就是它；
  //  - manifestSha512：上游 manifest 里写着的安装包（tar.gz）sha512，hachimia 没法独立核对（见上面），只记来源；
  //    installShSha256：实际执行的 install.sh 的 sha256（已对过 pins 文件）。
  fs.writeFileSync(path.join(verDir, "manifest.json"), JSON.stringify({
    name: "agy",
    version: ver,
    sha256: sum,
    installShSha256,
    manifestSha512,
    manifestUrl: mfUrl,
    manifestVersion,
    source: INSTALL_URL,
    installedAt: new Date().toISOString(),
  }, null, 2) + "\n");

  const tmpLink = path.join(DEST, `.current.tmp.${process.pid}`);
  try { fs.unlinkSync(tmpLink); } catch {}
  fs.symlinkSync(ver, tmpLink);
  fs.renameSync(tmpLink, path.join(DEST, "current"));

  say(`✓ Antigravity CLI ${ver} 安装完成（sha256 ${sum.slice(0, 12)}…）`);
} catch (e) {
  // try 块里不直接 die()：die() 的 process.exit(1) 会跳过 finally，暂存目录就泄漏了（E-04）。
  // 先记下失败，让 finally 清掉 stage，再统一报错退出。
  failed = e;
} finally {
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
}
if (failed) die(failed.message);
