// ─────────────────────────────────────────────────────────────────────
//  install-agy.mjs —— 安装 / 更新 / 校验官方 Antigravity CLI (agy)
//
//  用法:
//    node install-agy.mjs [stable|latest|<版本号>]   安装或更新 agy
//    node install-agy.mjs --check                    查询本机已装版本与在线可用性（输出 JSON）
//    node install-agy.mjs --recheck                  核对已装版本目录内 agy 的 sha256 清单
//  退出码：0 成功；1 一般失败；3 --recheck 发现不符；4 下载的安装包 sha512 与官方清单不符（拒绝安装，见下）
//
//  信任链（PR #1 复核后）：不再下载、执行远端 install.sh。
//  官方 install.sh 是不带版本号的可变脚本，钉它的 sha256 会让上游一改脚本就砖掉所有旧版 App 的
//  安装，直到新 APK 发下来——2026-11-22 线上那份已从 242 行变成 351 行，钉住的哈希当场失效，
//  这正是本次复核要修的。现在安装器直接按官方 manifest（{MANIFEST_BASE}/<平台>.json，含 tarball
//  url + sha512）装：下载 tarball → 自己算 sha512、对不上就拒绝安装（fail-closed，退出码 4）→
//  只解出单个成员 antigravity → chmod +x → --version 门 → 写进版本目录。平台检测与 install.sh
//  同款（uname -s/-o/-m + musl 判断），装出来的包和以前走 install.sh 装的是同一个。
//  残留风险（已接受）：manifest 与安装包同主机、同 TLS——主机本身被攻破时清单与包会一起是坏的，
//  sha512 只防传输损坏与中间人，不防上游主机被攻破；这和以前 install.sh 在内部验 sha512 的强度一样。
//  官方 install.sh 末尾那步 `agy install`（|| true 吸收失败）不跑：它只往暂存 HOME 写东西，随暂存
//  清理一起丢掉，对装好的二进制没有持久影响；装好的二进制由 --version 门与 verify-agy.mjs 的 ACP
//  握手确认能跑。macOS 那步 xattr 去隔离属性是 install.sh 的 macOS 专属步骤，本安装器只在
//  Android/Linux 上跑，不复现。
//
//  官方 Android (bionic) 原生构建，直接运行在安卓内核上，无需 glibc 加载器或 proot。
//  安装目录：$HOME/.local/share/hachimia/agy/<version>/agy + current 软链。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// 官方 manifest  base：install.sh 从同一份清单取版本 / 下载地址 / sha512（它用的 base 是
// https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests，和这里一样）
const MANIFEST_BASE = process.env.HACHIMIA_AGY_MANIFEST_BASE || "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const PREFIX = process.env.PREFIX || "";
const CURL = PREFIX ? path.join(PREFIX, "bin", "curl") : "curl";
const TAR = fs.existsSync(path.join(PREFIX, "bin", "tar")) ? path.join(PREFIX, "bin", "tar") : "tar";
const HOME = process.env.HOME || process.env.CCAPP_HOME || "";
const DEST = path.join(HOME, ".local", "share", "hachimia", "agy");
const ARG = process.argv[2] || "stable";

const say = (s) => console.log(s);
const die = (s) => { console.error("✗ " + s); process.exit(1); };
// try 块里抛出的带退出码的失败：finally 清掉 stage 之后再按这个码退出（die() 的 process.exit 会跳过 finally）
class ExitError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const hashFile = (f, algo) => {
  const h = crypto.createHash(algo);
  const fd = fs.openSync(f, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
};
const sha256 = (f) => hashFile(f, "sha256");
const sha512 = (f) => hashFile(f, "sha512");

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

// 安装包直接落盘，不进内存（tarball 几十 MB，curlSmall 的 16 MB maxBuffer 装不下）
function curlDownload(url, dest, timeoutSec = 600) {
  const r = spawnSync(CURL, [
    "-fsSL", "--proto", "=https", "--proto-redir", "=https",
    "--connect-timeout", "10", "--max-time", String(timeoutSec), "-o", dest, url,
  ], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 20 });
  if (r.status === 0) return { ok: true };
  return { ok: false, status: r.status, err: String(r.stderr || r.error?.message || "").trim().slice(0, 200) };
}

// 平台检测：与官方 install.sh（2026-11-22 线上 351 行那份）同款逻辑，装出来的包和以前走 install.sh
// 装的是同一个。uname -o 认 userland：Termux 里是 Android（要 bionic 构建），proot 进去的发行版
// （uname -o 报 GNU/Linux）拿常规 Linux 构建。--recheck 不问 manifest，不调这里。
let _platform = null;
function detectPlatform() {
  const uname = (arg) => {
    for (const u of ["uname", "/system/bin/uname"]) {
      try {
        const r = spawnSync(u, [arg], { encoding: "utf8", timeout: 5000 });
        if (r.status === 0) return (r.stdout || "").trim();
      } catch {}
    }
    return "";
  };
  const sys = uname("-s");
  let os;
  if (sys === "Darwin") os = "darwin";
  else if (sys === "Linux") os = uname("-o") === "Android" ? "android" : "linux";
  else die(`不支持的操作系统：${sys || "（未知）"}。Antigravity CLI 目前只支持 64 位 Windows、macOS 与 Linux。`);
  const m = uname("-m");
  const arch = m === "x86_64" || m === "amd64" ? "amd64" : m === "arm64" || m === "aarch64" ? "arm64" : "";
  if (!arch) die(`不支持的架构：${m || "（未知）"}。Antigravity CLI 目前只支持 64 位 Windows、macOS 与 Linux。`);
  if (os === "linux") {
    // musl 判断与 install.sh 一致：两处 libc 文件或 ldd /bin/ls 的输出里有 musl
    let musl = fs.existsSync("/lib/libc.musl-x86_64.so.1") || fs.existsSync("/lib/libc.musl-aarch64.so.1");
    if (!musl) {
      try {
        const r = spawnSync("ldd", ["/bin/ls"], { encoding: "utf8", timeout: 5000 });
        musl = /musl/i.test((r.stdout || "") + (r.stderr || ""));
      } catch {}
    }
    return musl ? `linux_${arch}_musl` : `linux_${arch}`;
  }
  return `${os}_${arch}`;
}
function manifestUrl() {
  if (!_platform) _platform = detectPlatform();
  return `${MANIFEST_BASE}/${_platform}.json`;
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
// 先问官方 manifest：版本 / 下载地址 / sha512 都从这里来。以前 hachimia 只把它当“来源记录”，
// 现在直接按它装——不再下载、执行远端 install.sh（见文件头信任链）。
if (!HOME) die("未设置 HOME 目录");
fs.mkdirSync(DEST, { recursive: true });

const mfUrl = manifestUrl();
const mfRes = curlSmall(mfUrl, 20);
if (!mfRes.ok) {
  die(`取不到官方 agy 版本清单（${mfUrl}：${mfRes.err || "HTTP/网络错误"}），未安装。`);
}
let manifestSha512 = "", manifestVersion = "", payloadUrl = "";
try {
  const mj = JSON.parse(mfRes.data.toString("utf8"));
  manifestVersion = parseVersion(mj.version || "");
  manifestSha512 = typeof mj.sha512 === "string" ? mj.sha512.trim().toLowerCase() : "";
  payloadUrl = typeof mj.url === "string" ? mj.url.trim() : "";
  if (!payloadUrl || !/^[0-9a-f]{128}$/.test(manifestSha512)) {
    die(`官方 agy 版本清单（${mfUrl}）里没有可用的下载地址 / sha512，清单可能坏了，未安装。`);
  }
} catch (e) {
  die(`官方 agy 版本清单（${mfUrl}）解析失败（${e.message}），未安装。`);
}
// install.sh 对包的处理：.tar.gz 就只解出单个成员 antigravity，否则把下载的文件直接当二进制用
const isTarGz = payloadUrl.includes(".tar.gz");
say(`正在下载 Antigravity CLI 安装包：${payloadUrl}`);

const stage = fs.mkdtempSync(path.join(DEST, ".stage-"));
const payload = path.join(stage, isTarGz ? "agy.tar.gz" : "agy");

// 安装失败也要清掉暂存目录：die() 的 process.exit(1) 会跳过 finally（E-04），
// 所以 try 块里一律 throw，由外面的 catch 在 finally 清理完之后再退出。
let failed = null;
try {
  const dl = curlDownload(payloadUrl, payload, 600);
  if (!dl.ok) {
    throw new Error(`下载安装包失败（${payloadUrl}：${dl.err || `curl exit ${dl.status}`}），未安装`);
  }
  // 安装包自己验 sha512（以前是 install.sh 在它内部验，现在安装器自己验——同一份清单、同一个值）：
  // 对不上就拒绝安装（fail-closed，退出码 4），绝不装一个没验过的包。
  let got512 = "";
  try { got512 = sha512(payload); } catch (e) {
    throw new Error(`算安装包 sha512 失败（${e.message}），未安装`);
  }
  if (got512 !== manifestSha512) {
    throw new ExitError(`安装包 sha512 与官方清单不符，请稍后重试或等待新版本（期望 ${manifestSha512.slice(0, 12)}…，实得 ${got512.slice(0, 12)}…）。已拒绝安装，未安装任何东西。`, 4);
  }
  say(`✓ 安装包 sha512 与官方清单一致（${got512.slice(0, 12)}…）`);

  let stagedBin;
  if (isTarGz) {
    // --no-same-owner：包里记的 uid/gid（官方包常记 root）和安装者不一定一致，非 root 解压时
    // chown 会 EPERM；和仓库里 components.mjs / modules.mjs 解压组件包的做法一样，只取内容、
    // 不恢复属主。解出的文件归运行安装器的用户（设备上就是 App 自己），随后 chmod 0755。
    const ext = spawnSync(TAR, ["-xzf", payload, "-C", stage, "--no-same-owner", "antigravity"], { encoding: "utf8", timeout: 60000 });
    if (ext.status !== 0) {
      const detail = String(ext.stderr || "").trim().slice(0, 200);
      throw new Error(`解压安装包失败（tar 退出码 ${ext.status ?? "null"}${ext.signal ? `（信号 ${ext.signal}）` : ""}${detail ? `：${detail}` : ""}），未安装`);
    }
    stagedBin = path.join(stage, "antigravity");
  } else {
    stagedBin = payload;
  }
  if (!fs.existsSync(stagedBin)) throw new Error("安装包里没有找到 agy 可执行文件，未安装");
  fs.chmodSync(stagedBin, 0o755);

  // 刚装好的二进制必须自己能跑、且 --version 报得出版本号（A5/E-11）：
  // 报不出就说明装进来的东西是坏的或输出格式变了，不能把它钉成当前版，更不能回退到 0.0.0-local
  const vr = spawnSync(stagedBin, ["--version"], { encoding: "utf8", timeout: 15000 });
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
  fs.copyFileSync(stagedBin, finalBin);
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
  //  - manifestSha512：上游 manifest 里写着的安装包（tar.gz）sha512，安装时已由安装器自己现算核对过
  //    （manifestSha512Verified: true），verify-agy.mjs 的结果文件里报的就是它。
  fs.writeFileSync(path.join(verDir, "manifest.json"), JSON.stringify({
    name: "agy",
    version: ver,
    sha256: sum,
    manifestSha512,
    manifestSha512Verified: true,
    manifestUrl: mfUrl,
    manifestVersion,
    source: payloadUrl,
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
if (failed) {
  console.error("✗ " + failed.message);
  process.exit(failed instanceof ExitError ? failed.code : 1);
}
