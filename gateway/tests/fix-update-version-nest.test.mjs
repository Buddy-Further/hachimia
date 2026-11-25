// 更新页版本显示与实际版本脱节（第 3 窝）全链路回归测试：
// 1. agyEnv 与 bin/agy 锁定 AGY_CLI_DISABLE_AUTO_UPDATE=1，防止后台原地覆写旧版本目录
// 2. install-agy.mjs --check 读真实二进制 --version（而非软链目录名），悬空软链不谎报已装
// 3. install-agy.mjs <version> 支持离线秒切已校验本地版本；--recheck 自动归位历史自更新漂移目录并继续拦截真篡改
// 4. devside.mjs /api/claude/versions 剔除 sha256 已漂移的假版本目录
// 5. acp.mjs poolKey 纳入真实二进制指纹，切换 current 软链后下一轮立即换新进程并同步 buildCapabilities().version
// 6. Updater.java / caps.mjs / 19-boot.js / 15-pages.js 版本口径一致性契约
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG, PATHS } from "../gw/config.mjs";
import { agyEnv } from "../gw/claude.mjs";
import { closeAllAcpClients, poolKey, runAcpTurn } from "../gw/acp.mjs";
import { buildCapabilities, setLastInit } from "../gw/caps.mjs";
import { routeDevside } from "../gw/devside.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const INSTALL_SCRIPT = path.join(REPO, "android/assets/scripts/install-agy.mjs");
const SH_BIN = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";

const sha256Buf = (b) => crypto.createHash("sha256").update(b).digest("hex");

function writeFakeAgyDir(dest, dirVer, reportVer = dirVer, { writeManifest = true, manifestSha = null } = {}) {
  const dir = path.join(dest, dirVer);
  fs.mkdirSync(dir, { recursive: true });
  const body = Buffer.from(`#!${SH_BIN}\nif [ "$1" = "--version" ]; then echo "agy ${reportVer}"; exit 0; fi\nexit 0\n`);
  const bin = path.join(dir, "agy");
  fs.writeFileSync(bin, body, { mode: 0o755 });
  const realSha = sha256Buf(body);
  if (writeManifest) {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      name: "agy",
      version: dirVer,
      sha256: manifestSha || realSha,
      installedAt: new Date().toISOString(),
    }, null, 2) + "\n");
  }
  return { dir, bin, sha256: realSha };
}

test("1. agyEnv 强制注入 AGY_CLI_DISABLE_AUTO_UPDATE=1 且禁止 extraEnv 覆盖；bin/agy 同步拦截自更新", () => {
  const env = agyEnv({
    sync: false,
    provider: {
      id: "antigravity",
      group: "antigravity",
      extraEnv: {
        AGY_CLI_DISABLE_AUTO_UPDATE: "0",
        CUSTOM_SAFE_VAR: "ok",
      },
    },
  });
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "1", "必须锁定 AGY_CLI_DISABLE_AUTO_UPDATE=1");
  assert.equal(env.CUSTOM_SAFE_VAR, "ok");

  const wrapper = fs.readFileSync(path.join(REPO, "android/assets/bin/agy"), "utf8");
  assert.match(wrapper, /export AGY_CLI_DISABLE_AUTO_UPDATE="\$\{AGY_CLI_DISABLE_AUTO_UPDATE:-1\}"/);
  assert.match(wrapper, /if \[ "\$1" = "update" \] && \[ "\$#" -eq 1 \]/);
  assert.match(wrapper, /scripts\/install-agy\.mjs/);
  assert.match(wrapper, /exec "\$NODE_BIN" "\$AGY_INSTALLER" stable/);
});

test("2. install-agy.mjs --check 返回真实二进制版本（纠正原地自更新后的目录名错位）且悬空软链返回空串", () => {
  const root = path.join(CFG.workspace, "nest3-check-ver");
  const fakeHome = path.join(root, "home");
  const dest = path.join(fakeHome, ".local/share/hachimia/agy");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  try {
    // 模拟 1.5.15 目录里的二进制已被原地自更新为 1.5.16，而 current 仍指向 1.5.15
    writeFakeAgyDir(dest, "1.5.15", "1.5.16");
    fs.symlinkSync("1.5.15", path.join(dest, "current"));

    const r1 = spawnSync(process.execPath, [INSTALL_SCRIPT, "--check"], {
      env: { ...process.env, HOME: fakeHome, HACHIMIA_AGY_MANIFEST_BASE: "https://127.0.0.1:1/manifests" },
      encoding: "utf8",
    });
    const j1 = JSON.parse(r1.stdout.slice(r1.stdout.lastIndexOf("{")));
    assert.equal(j1.installed, "1.5.16", `应报真实二进制版本 1.5.16 而非旧目录名 1.5.15: ${r1.stdout}`);

    // 模拟悬空软链（current -> 1.5.99，目录/二进制不存在）
    fs.rmSync(path.join(dest, "current"), { force: true });
    fs.symlinkSync("1.5.99", path.join(dest, "current"));
    const r2 = spawnSync(process.execPath, [INSTALL_SCRIPT, "--check"], {
      env: { ...process.env, HOME: fakeHome, HACHIMIA_AGY_MANIFEST_BASE: "https://127.0.0.1:1/manifests" },
      encoding: "utf8",
    });
    const j2 = JSON.parse(r2.stdout.slice(r2.stdout.lastIndexOf("{")));
    assert.equal(j2.installed, "", "悬空 current 软链不得谎报已安装版本");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("3. install-agy.mjs 离线切换已校验本地版本，且 --recheck 自动归位历史自更新目录并拦截真篡改", () => {
  const root = path.join(CFG.workspace, "nest3-local-recheck");
  const fakeHome = path.join(root, "home");
  const dest = path.join(fakeHome, ".local/share/hachimia/agy");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  try {
    // 准备合法的 1.5.14 与 1.5.16，current -> 1.5.16；断网环境下固定回 1.5.14 应离线秒切成功
    const v14 = writeFakeAgyDir(dest, "1.5.14", "1.5.14");
    const v16 = writeFakeAgyDir(dest, "1.5.16", "1.5.16");
    fs.symlinkSync("1.5.16", path.join(dest, "current"));

    const sw = spawnSync(process.execPath, [INSTALL_SCRIPT, "1.5.14"], {
      env: { ...process.env, HOME: fakeHome, HACHIMIA_AGY_INSTALL_URL: "https://127.0.0.1:1/install.sh" },
      encoding: "utf8",
    });
    assert.equal(sw.status, 0, `本机已有且校验通过的历史版本应直接切换成功: ${sw.stderr}\n${sw.stdout}`);
    assert.equal(fs.readlinkSync(path.join(dest, "current")), "1.5.14");

    // 模拟 1.5.14 目录被旧版后台自更新覆写成 1.5.15（sha256 与 1.5.14/manifest.json 不符，但 --version 报 1.5.15）
    const upgradedBody = Buffer.from(`#!${SH_BIN}\nif [ "$1" = "--version" ]; then echo "agy 1.5.15"; exit 0; fi\nexit 0\n`);
    fs.writeFileSync(v14.bin, upgradedBody, { mode: 0o755 });
    const rcHeal = spawnSync(process.execPath, [INSTALL_SCRIPT, "--recheck"], {
      env: { ...process.env, HOME: fakeHome },
      encoding: "utf8",
    });
    assert.equal(rcHeal.status, 0, `历史原地自更新目录应自动归位而非报篡改: ${rcHeal.stdout}\n${rcHeal.stderr}`);
    assert.equal(fs.existsSync(path.join(dest, "1.5.14")), false, "漂移的 1.5.14 假目录应已清理");
    assert.equal(fs.existsSync(path.join(dest, "1.5.15", "agy")), true, "应归位到真实的 1.5.15 目录");
    assert.equal(fs.readlinkSync(path.join(dest, "current")), "1.5.15", "current 指向漂移目录时应一并切到真实版本目录");

    // 对照：同版本号真篡改（1.5.16/agy 内容被改但仍自称 1.5.16）必须返回退出码 3 并写 .mismatch
    fs.writeFileSync(v16.bin, Buffer.from(`#!${SH_BIN}\nif [ "$1" = "--version" ]; then echo "agy 1.5.16"; exit 0; fi\necho tampered\n`), { mode: 0o755 });
    const rcTamper = spawnSync(process.execPath, [INSTALL_SCRIPT, "--recheck"], {
      env: { ...process.env, HOME: fakeHome },
      encoding: "utf8",
    });
    assert.equal(rcTamper.status, 3, "真实篡改必须退出码 3 拦截");
    assert.equal(fs.existsSync(path.join(dest, "1.5.16", ".mismatch")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("4. /api/claude/versions 过滤掉 sha256 与清单不符的漂移目录，只列真实可用版本", async () => {
  const dest = path.join(CFG.home, ".local/share/hachimia/agy");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "1.5.16" }));
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const prevBase = process.env.HACHIMIA_AGY_MANIFEST_BASE;
  process.env.HACHIMIA_AGY_MANIFEST_BASE = `http://127.0.0.1:${srv.address().port}`;

  try {
    // 1.5.16 正常；1.5.14 的 manifest.json 记的是旧哈希，二进制已被自更新换掉
    writeFakeAgyDir(dest, "1.5.16", "1.5.16");
    writeFakeAgyDir(dest, "1.5.14", "1.5.15", { manifestSha: "a".repeat(64) });

    let code = 0, body = "";
    const req = { method: "GET", headers: {} };
    const res = {
      writeHead(c) { code = c; },
      end(b) { body = String(b || ""); },
    };
    const u = new URL("http://127.0.0.1/api/claude/versions?refresh=1");
    await routeDevside(req, res, u, u.pathname);
    assert.equal(code, 200);
    const j = JSON.parse(body);
    assert.equal(j.ok, true);
    assert.ok(j.versions.includes("1.5.16"), `应包含校验一致的 1.5.16: ${body}`);
    assert.equal(j.versions.includes("1.5.14"), false, `不得列出二进制已漂移的 1.5.14 假目录: ${body}`);
  } finally {
    if (prevBase === undefined) delete process.env.HACHIMIA_AGY_MANIFEST_BASE;
    else process.env.HACHIMIA_AGY_MANIFEST_BASE = prevBase;
    srv.close();
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("5. poolKey 感知 current 软链目标切换：升级 agy 后下一轮自动淘汰旧池进程并更新能力页版本", async () => {
  const root = path.join(CFG.workspace, "nest3-pool-upgrade");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const prevAgy = PATHS.agy;

  const makeMockWorker = (ver) => {
    const dir = path.join(root, ver);
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "agy");
    const script = `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: ${JSON.stringify(ver)} },
        authMethods: [{ id: "oauth-personal" }],
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      },
    });
  }
  if (msg.method === "authenticate" || msg.method === "session/set_mode") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  if (msg.method === "session/new" || msg.method === "session/resume") {
    return send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        sessionId: msg.params.sessionId || "sid-pool-upg-" + Date.now(),
        modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "accept-edits" }] },
      },
    });
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "VER=" + ${JSON.stringify(ver)} } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`;
    fs.writeFileSync(bin, script, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      name: "agy",
      version: ver,
      sha256: sha256Buf(Buffer.from(script)),
      installedAt: new Date().toISOString(),
    }) + "\n");
    return bin;
  };

  try {
    makeMockWorker("1.5.15");
    makeMockWorker("1.5.16");
    const curLink = path.join(root, "current");
    fs.symlinkSync("1.5.15", curLink);
    const linkBin = path.join(curLink, "agy");
    PATHS.agy = linkBin;
    setLastInit(null);

    // 首轮前能力页即从磁盘清单读到 1.5.15
    assert.equal(buildCapabilities().version, "1.5.15");

    const k15 = poolKey({ bin: linkBin, args: ["acp"], cwd: root, authType: "oauth-personal" });
    const r1 = await runAcpTurn({
      bin: linkBin,
      args: ["acp"],
      cwd: root,
      env: process.env,
      prompt: "turn 1",
      authType: "oauth-personal",
      keepAlive: true,
      emit: () => {},
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.resultText, "VER=1.5.15");

    // 模拟更新页切换 current -> 1.5.16
    const tmpLink = path.join(root, ".current.tmp");
    fs.symlinkSync("1.5.16", tmpLink);
    fs.renameSync(tmpLink, curLink);

    const k16 = poolKey({ bin: linkBin, args: ["acp"], cwd: root, authType: "oauth-personal" });
    assert.notEqual(k16, k15, "current 软链切到新版后 poolKey 必须改变");
    assert.equal(buildCapabilities().version, "1.5.16", "更新完尚未发下一轮消息时，能力页也应立即显示 1.5.16");

    // 第二轮续同一 sessionId：必须淘汰旧 1.5.15 进程，拉起 1.5.16
    const r2 = await runAcpTurn({
      bin: linkBin,
      args: ["acp"],
      cwd: root,
      env: process.env,
      prompt: "turn 2",
      sessionId: r1.sessionId,
      authType: "oauth-personal",
      keepAlive: true,
      emit: () => {},
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.resultText, "VER=1.5.16", "下一轮对话必须实际运行新版 1.5.16 二进制");
  } finally {
    closeAllAcpClients();
    PATHS.agy = prevAgy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("6. Updater.java / caps.mjs / 19-boot.js / 15-pages.js 版本显示同步契约", () => {
  const upd = fs.readFileSync(path.join(REPO, "android/java/ha/chi/mia/Updater.java"), "utf8");
  assert.match(upd, /j\.optString\("installed",\s*""\)/, "Updater.checkClaude 应读取 install-agy.mjs --check 返回的真实 installed 版本");
  assert.match(upd, /probedClaudeVer/, "Updater.refreshCurrent 应优先采用实测二进制版本");
  assert.match(upd, /putString\("channel",\s*prevCh\)\.putString\("pin",\s*prevPin\)\.commit\(\)/, "固定版本安装失败时必须回滚 channel/pin 偏好");

  const caps = fs.readFileSync(path.join(REPO, "gateway/gw/caps.mjs"), "utf8");
  assert.match(caps, /appVersion:\s*process\.env\.CCAPP_APP_VERSION\s*\|\|\s*""/);

  const boot = fs.readFileSync(path.join(REPO, "gateway/web/app/19-boot.js"), "utf8");
  assert.match(boot, /s\.appVersion/);

  const pages = fs.readFileSync(path.join(REPO, "gateway/web/app/15-pages.js"), "utf8");
  assert.match(pages, /state\.serverStatus\s*&&\s*state\.serverStatus\.appVersion/);
  assert.match(pages, /CL\.cur\s*===\s*curNow/);
});
