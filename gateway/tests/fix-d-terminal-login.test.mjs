// D-02：企业账号「在终端里登录」不能丢掉 enterprise
// 终端里没有 TTY 可供断言实际敲键：测可导出的纯函数 loginTermCommand（命令 + 给用户的提示），
// 再加源码断言（前端透传 method、网关不再敲 claude auth login）。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loginTermCommand } from "../gw/terminal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("D-02 企业终端登录：命令不变（交互式 agy），但提示必须指明选企业登录入口", () => {
  const e = loginTermCommand("enterprise", true);
  assert.equal(e.cmd, "SSH_CONNECTION=1 agy\r");
  assert.match(e.hint, /Google Cloud/, "企业提示应指明选 Google Cloud 入口，实际: " + e.hint);
  const p = loginTermCommand("personal", true);
  assert.equal(p.cmd, "SSH_CONNECTION=1 agy\r");
  assert.match(p.hint, /Google OAuth/, "个人提示应指明选 Google OAuth，实际: " + p.hint);
  assert.notEqual(e.hint, p.hint, "企业与个人的提示不能相同，否则 enterprise 标识仍是丢的");
});

test("D-02 console/business 同样按企业处理", () => {
  for (const m of ["console", "business"]) {
    const r = loginTermCommand(m, true);
    assert.match(r.hint, /Google Cloud/, m + " 应按企业处理，实际: " + r.hint);
  }
});

test("D-02 没装 agy 时不再退化成 claude auth login", () => {
  const r = loginTermCommand("enterprise", false);
  assert.equal(r.cmd, null, "没装 agy 就别敲任何登录命令");
  assert.match(r.hint, /Antigravity CLI.*未安装/, "应告诉用户先去安装 agy，实际: " + r.hint);
  assert.doesNotMatch(JSON.stringify(r), /claude auth login/);
});

test("D-02 源码：网关不再含 claude auth login，前端透传 method", () => {
  const gw = fs.readFileSync(path.join(ROOT, "gateway", "gw", "terminal.mjs"), "utf8");
  assert.doesNotMatch(gw, /claude auth login/);
  const fe = fs.readFileSync(path.join(ROOT, "gateway", "web", "app", "18-terminal.js"), "utf8");
  assert.doesNotMatch(fe, /method === "console" \? "console" : true/);
  assert.match(fe, /newTerm\(\{[^}]*\blogin:\s*method\b[^}]*\}\)/);
});
