import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { uptimeMs } from "../gw/components.mjs";
import { loginBrowserEnv } from "../gw/login.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bridgeScript = path.join(root, "android/assets/bin/cli-bridge.mjs");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bug-hunt-"));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("uptimeMs 返回开机单调毫秒（不大于当前开机时间 + 2s，安卓读不到 /proc/uptime 时走 os.uptime()）", () => {
  const got = uptimeMs();
  const osMs = Math.floor(os.uptime()) * 1000;
  assert.ok(got > 0, "uptimeMs 应为正数");
  assert.ok(got < 1_000_000_000_000, `uptimeMs 不应退回墙钟时间戳，实际=${got}`);
  assert.ok(Math.abs(got - osMs) <= 2500, `uptimeMs(${got}) 应与 os.uptime()*1000(${osMs}) 同基准`);
});

test("loginBrowserEnv 剥离 app/pre 并在 PATH 最前挂接 xdg-open / termux-open-url 垫片", () => {
  const loginDir = path.join(tmpDir, "login");
  const browser = path.join(loginDir, "browser.sh");
  fs.mkdirSync(loginDir, { recursive: true });
  fs.writeFileSync(browser, "#!/bin/sh\necho \"$1\"\n", { mode: 0o700 });

  const env = loginBrowserEnv({
    CCAPP_BIN: "/data/data/ha.chi.mia/files/app/bin",
    CCAPP_RUNTIME: "/data/data/ha.chi.mia/files",
    PATH: "/data/data/ha.chi.mia/files/app/pre:/data/data/ha.chi.mia/files/usr/bin:/system/bin",
  }, loginDir, browser);

  const dirs = env.PATH.split(":");
  assert.equal(env.BROWSER, browser);
  assert.equal(dirs[0], path.join(loginDir, "bin"), "垫片目录应在 PATH 最前");
  assert.ok(!dirs.some((d) => d.endsWith("/app/pre")), `PATH 中不应残留 app/pre: ${env.PATH}`);
  assert.ok(fs.existsSync(path.join(loginDir, "bin", "xdg-open")), "应生成 xdg-open 垫片");
  assert.ok(fs.existsSync(path.join(loginDir, "bin", "termux-open-url")), "应生成 termux-open-url 垫片");
});

function runBridge(args, { env = {}, stdinData = null, closeStdin = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bridgeScript, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    if (stdinData != null) child.stdin.write(stdinData);
    if (closeStdin) child.stdin.end();
  });
}

test("cli-bridge.mjs 具备 socket 超时保护、stdin 超大早停与 stdin 挂起超时保护", async () => {
  // 1. socket 无应答时按超时退出，不永久挂起
  const sockPath = path.join(tmpDir, "hang.sock");
  const srv = net.createServer((conn) => { conn.resume(); /* 故意不回包不关闭 */ });
  await new Promise((r) => srv.listen(sockPath, r));
  try {
    const r1 = await runBridge(["open-url", "--", "https://example.com"], {
      env: { CCAPP_PRIV_SOCK: sockPath, CCAPP_CLI_BRIDGE_TIMEOUT_MS: "250" },
    });
    assert.notEqual(r1.code, 0);
    assert.match(r1.err, /timed out/i);
  } finally {
    srv.close();
  }

  // 2. stdin 超过 200000 字符立刻报错，不无限吃内存
  const r2 = await runBridge(["clip-set"], {
    env: { CCAPP_PRIV_SOCK: path.join(tmpDir, "missing.sock") },
    stdinData: "a".repeat(200050),
  });
  assert.notEqual(r2.code, 0);
  assert.match(r2.err, /too large/i);

  // 3. stdin 永不关闭时在超时后退出
  const r3 = await runBridge(["clip-set"], {
    env: { CCAPP_PRIV_SOCK: path.join(tmpDir, "missing.sock"), CCAPP_CLI_BRIDGE_STDIN_TIMEOUT_MS: "250" },
    closeStdin: false,
  });
  assert.notEqual(r3.code, 0);
  assert.match(r3.err, /timed out reading stdin/i);
});
