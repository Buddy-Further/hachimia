// D-03：开发端更新项标 Antigravity CLI (agy)，就不能从 downloads.claude.ai 下 Claude Code。
// 源码断言（立即可跑）+ 子进程行为断言：不带 CCAPP_PREFIX 起网关，GET /api/app/upd_status
// 必须返回 id "agy" 的更新项（devside 走开发端分支）。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("D-03 devside 不再从 downloads.claude.ai 拉 Claude Code，改走官方 agy 安装脚本", () => {
  const src = fs.readFileSync(path.join(ROOT, "gateway", "gw", "devside.mjs"), "utf8");
  assert.doesNotMatch(src, /downloads\.claude\.ai/);
  assert.doesNotMatch(src, /CC_BASE/);
  assert.match(src, /install-agy\.mjs/);
  // PR #1 复核：安装器不再下 install.sh，改按官方 manifest 直装 tarball——这里钉新说法，
  // 而不是旧的 install.sh 地址（旧地址已从 devside 的注释里删掉，见 install-agy.mjs 文件头）
  assert.match(src, /官方 manifest.*tarball|按清单直装 tarball/);
  assert.doesNotMatch(src, /antigravity\.google\/cli\/install\.sh/);
  assert.doesNotMatch(src, /name:\s*"Claude Code"/);
  assert.match(src, /id:\s*"agy"/);
});

test("D-03 开发端 /api/app/upd_status 返回 agy 更新项", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fix-d-devside-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fix-d-devside-ws-"));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CCAPP_|CLAUDE_CODE_|ANTHROPIC_)/.test(k)));
  Object.assign(env, { CCAPP_TEST: "1", CCAPP_HOME: home, HOME: home, CCAPP_WORKSPACE: ws });
  const probe = `
    const http = await import("node:http");
    const { routeDevside } = await import(${JSON.stringify(path.join(ROOT, "gateway", "gw", "devside.mjs"))});
    const { NEXT } = await import(${JSON.stringify(path.join(ROOT, "gateway", "gw", "http.mjs"))});
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, "http://x");
      if ((await routeDevside(req, res, u, u.pathname)) !== NEXT) return;
      res.writeHead(404).end();
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const r = await fetch("http://127.0.0.1:" + srv.address().port + "/api/app/upd_status");
    console.log("STATUS:" + r.status);
    console.log("BODY:" + JSON.stringify(await r.json()));
    process.exit(0);
  `;
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", probe], { env, timeout: 60000 });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.stderr.on("data", (d) => { buf += d; });
    child.on("error", reject);
    child.on("close", () => resolve(buf));
  });
  const bodyLine = out.split("\n").find((l) => l.startsWith("BODY:"));
  assert.ok(bodyLine, "子进程没返回 upd_status：\n" + out);
  const body = JSON.parse(bodyLine.slice(5));
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.ok(Array.isArray(body.items) && body.items.length, JSON.stringify(body));
  const item = body.items[0];
  assert.equal(item.id, "agy", "更新项 id 应为 agy，实际: " + JSON.stringify(item));
  assert.match(item.name || "", /Antigravity/, "更新项名字应含 Antigravity，实际: " + JSON.stringify(item));
});
