// ─────────────────────────────────────────────────────────────────────
//  install-agy.mjs —— 安装 / 更新 / 校验官方 Antigravity CLI (agy)
//
//  用法:
//    node install-agy.mjs [stable|latest|<版本号>]   安装或更新 agy
//    node install-agy.mjs --check                    查询本机已装版本与在线可用性（输出 JSON）
//    node install-agy.mjs --recheck                  核对已装版本目录内 agy 的 sha256 清单
//
//  官方 Android (bionic) 原生构建，直接运行在安卓内核上，无需 glibc 加载器或 proot。
//  安装目录：$HOME/.local/share/hachimia/agy/<version>/agy + current 软链。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const INSTALL_URL = process.env.HACHIMIA_AGY_INSTALL_URL || "https://antigravity.google/cli/install.sh";
// 官方 install.sh 从这份 manifest 取版本号与下载地址（install.sh 本身不含版本变量，--check 直接问这里）
const MANIFEST_BASE = process.env.HACHIMIA_AGY_MANIFEST_BASE || "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
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

const cmpVer = (a, b) => {
  const [ab, ...ap] = String(a).split("-"), [bb, ...bp] = String(b).split("-");
  const x = ab.split(".").map(Number), y = bb.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  const pa = ap.join("-"), pb = bp.join("-");
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
  return pa < pb ? -1 : pa > pb ? 1 : 0;
};

function probeBinVersion(bin, timeoutMs = 10000) {
  const env = {
    ...process.env,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || "unix:path=/nonexistent",
  };
  let r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: timeoutMs, env });
  if ((r.status !== 0 || r.error?.code === "EACCES") && process.env.CCAPP_EXEC === "loader" && fs.existsSync("/system/bin/linker64")) {
    r = spawnSync("/system/bin/linker64", [bin, "--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...env, TERMUX_EXEC__PROC_SELF_EXE: bin },
    });
  }
  if (r.status !== 0) return "";
  return parseVersion(r.stdout || r.stderr);
}

function switchCurrentLink(ver) {
  const tmpLink = path.join(DEST, `.current.tmp.${process.pid}`);
  try { fs.unlinkSync(tmpLink); } catch {}
  fs.symlinkSync(ver, tmpLink);
  fs.renameSync(tmpLink, path.join(DEST, "current"));
}

function installedVersion() {
  try {
    const cur = fs.realpathSync(path.join(DEST, "current"));
    const dirName = path.basename(cur);
    const bin = path.join(cur, "agy");
    if (!fs.existsSync(bin)) return "";
    // 始终以二进制实际报出的版本号为准：旧版未设 AGY_CLI_DISABLE_AUTO_UPDATE 时，
    // agy 后台自更新会原地覆写 <旧版本>/agy 而不改 current 软链，只读目录名会导致更新页显示旧版或假版本。
    const v = probeBinVersion(bin, 10000);
    if (isVer(v)) return v;
    if (isVer(dirName) && dirName !== "0.0.0-local") return dirName;
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
  let curDir = "";
  try { curDir = fs.realpathSync(path.join(DEST, "current")); } catch {}
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
        // 检查是否为历史版本里 agy 内置自更新原地覆写（例如 1.5.14/agy 被自更新成 1.5.15）：
        // 若二进制本身可正常报出更高版本号 actualVer，则归位到 actualVer 目录（或清理已被新目录取代的漂移旧目录），避免误报篡改与版本选单假条目。
        const actualVer = probeBinVersion(bin, 10000);
        if (isVer(actualVer) && actualVer !== d && cmpVer(actualVer, d) > 0) {
          const targetDir = path.join(DEST, actualVer);
          const targetBin = path.join(targetDir, "agy");
          const targetMf = path.join(targetDir, "manifest.json");
          let targetReady = false;
          if (fs.existsSync(targetBin) && fs.existsSync(targetMf)) {
            try {
              const tm = JSON.parse(fs.readFileSync(targetMf, "utf8"));
              targetReady = Boolean(tm.sha256 && sha256(targetBin) === tm.sha256);
            } catch {}
          }
          if (!targetReady) {
            fs.mkdirSync(targetDir, { recursive: true });
            fs.copyFileSync(bin, targetBin);
            fs.chmodSync(targetBin, 0o755);
            fs.writeFileSync(targetMf, JSON.stringify({
              name: "agy",
              version: actualVer,
              sha256: got,
              source: m.source || INSTALL_URL,
              installedAt: new Date().toISOString(),
            }, null, 2) + "\n");
            targetReady = true;
          }
          if (targetReady) {
            if (curDir === dir) {
              switchCurrentLink(actualVer);
              curDir = fs.realpathSync(path.join(DEST, "current"));
            }
            fs.rmSync(dir, { recursive: true, force: true });
            say(`✓ ${d}：检测到历史原地自更新（实为 ${actualVer}），已归位并清理漂移目录`);
            continue;
          }
        }
        bad++;
        fs.writeFileSync(path.join(dir, ".mismatch"), got + "\n");
        say(`✗ ${d}：sha256 不符（期望 ${String(m.sha256 || "").slice(0, 12)}…，实得 ${got.slice(0, 12)}…）`);
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

// 若请求固定/切换到某一具体版本，且本机该版本目录已完整存在并通过 sha256 与 --version 双重核验，
// 直接原子切换 current 软链（上游 install.sh 不支持拉取历史版本，联网必装最新版并在版本核验处报错）。
if (isVer(ARG)) {
  const localDir = path.join(DEST, ARG);
  const localBin = path.join(localDir, "agy");
  const localMf = path.join(localDir, "manifest.json");
  if (fs.existsSync(localBin) && fs.existsSync(localMf) && !fs.existsSync(path.join(localDir, ".mismatch"))) {
    try {
      const m = JSON.parse(fs.readFileSync(localMf, "utf8"));
      const got = sha256(localBin);
      if (m.sha256 && got === m.sha256 && probeBinVersion(localBin, 15000) === ARG) {
        switchCurrentLink(ARG);
        say(`✓ Antigravity CLI ${ARG} 安装完成（复用本机已校验版本，sha256 ${got.slice(0, 12)}…）`);
        process.exit(0);
      }
    } catch {}
  }
}

say(`正在获取官方 Antigravity CLI 安装脚本：${INSTALL_URL}`);
const fetched = curlSmall(INSTALL_URL, 30);
if (!fetched.ok) {
  die(`无法下载 Antigravity CLI 安装脚本（${fetched.err || "HTTP/网络错误"}）。请检查网络连接或代理设置后重试。`);
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
  // 官方 install.sh 默认认 -d/--dir（装到 <dir>/agy）；若调用方传入具体版本号 isVer(ARG)，
  // 透传 ANTIGRAVITY_VERSION / AGY_VERSION（若脚本支持 --version 一并传入），装完后严格校验版本匹配，
  // 杜绝静默装成别的版本谎报成功（C-07）。
  const binDir = path.join(stageHome, ".local", "bin");
  const wantVer = isVer(ARG) ? ARG : "";
  const scriptText = fetched.data.toString("utf8");
  const scriptArgs = [stageScript, "--dir", binDir];
  if (wantVer && /--version\b/.test(scriptText)) scriptArgs.push("--version", wantVer);
  say(`正在运行官方安装脚本（--dir ${binDir}${wantVer ? `，目标版本 ${wantVer}` : ""}）…`);
  const env = {
    ...process.env,
    HOME: stageHome,
    TMPDIR: process.env.TMPDIR || stage,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || "unix:path=/nonexistent",
    ...(wantVer ? { ANTIGRAVITY_VERSION: wantVer, AGY_VERSION: wantVer } : {}),
  };
  const run = spawnSync(SH, scriptArgs, {
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
  const probeEnv = {
    ...process.env,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || "unix:path=/nonexistent",
  };
  const vr = spawnSync(realFound, ["--version"], { encoding: "utf8", timeout: 15000, env: probeEnv });
  if (vr.status !== 0) {
    throw new Error(`刚装好的 agy 无法运行（--version 退出码 ${vr.status ?? "null"}${vr.signal ? `（信号 ${vr.signal}）` : ""}），未安装`);
  }
  const ver = parseVersion(vr.stdout || vr.stderr);
  if (!ver) {
    throw new Error(`刚装好的 agy --version 没有报出版本号（输出：${String(vr.stdout || vr.stderr || "").trim().slice(0, 200) || "（空）"}），未安装`);
  }
  if (wantVer && ver !== wantVer) {
    throw new Error(`目标版本 ${wantVer} 与上游安装脚本实际安装的版本 ${ver} 不一致（上游脚本暂不支持指定历史版本），未覆盖当前版本`);
  }
  const verDir = path.join(DEST, ver);
  const verDirExisted = fs.existsSync(verDir);
  fs.mkdirSync(verDir, { recursive: true });

  const finalBin = path.join(verDir, "agy");
  fs.copyFileSync(realFound, finalBin);
  fs.chmodSync(finalBin, 0o755);

  // 拷贝后的最终文件再校验一次 --version（A5）：截断/损坏的拷贝 sha256 是现算的，能自洽过关，但跑不起来
  const vr2 = spawnSync(finalBin, ["--version"], { encoding: "utf8", timeout: 15000, env: probeEnv });
  if (vr2.status !== 0 || parseVersion(vr2.stdout || vr2.stderr) !== ver) {
    try { fs.rmSync(finalBin, { force: true }); } catch {}
    try { fs.rmSync(path.join(verDir, "manifest.json"), { force: true }); } catch {}
    if (!verDirExisted) { try { fs.rmSync(verDir, { recursive: true, force: true }); } catch {} }
    throw new Error(`拷贝后的 agy 无法运行或版本号不对（期望 ${ver}），未安装`);
  }

  const sum = sha256(finalBin);
  fs.writeFileSync(path.join(verDir, "manifest.json"), JSON.stringify({
    name: "agy",
    version: ver,
    sha256: sum,
    source: INSTALL_URL,
    installedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  fs.rmSync(path.join(verDir, ".mismatch"), { force: true });

  switchCurrentLink(ver);

  say(`✓ Antigravity CLI ${ver} 安装完成（sha256 ${sum.slice(0, 12)}…）`);
} catch (e) {
  // try 块里不直接 die()：die() 的 process.exit(1) 会跳过 finally，暂存目录就泄漏了（E-04）。
  // 先记下失败，让 finally 清掉 stage，再统一报错退出。
  failed = e;
} finally {
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
}
if (failed) die(failed.message);
