// 跨片遗留 A15：loginReady 认 ~/.claude/.credentials.json（Claude Code 凭据），
// 应认 agy 的登录凭据位置，与 login.mjs 的 hasAgySessionFiles 同口径。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { noteLoggedIn, providerList } from "../gw/models.mjs";

const CLAUDE_CREDS = path.join(CFG.home, ".claude", ".credentials.json");
const AGY_SESSION = path.join(CFG.home, ".gemini", "antigravity-cli", "session.json");

function usable(id) {
  const p = providerList().find((x) => x.id === id);
  assert.ok(p, "选单里应有 " + id);
  return p.usable;
}
function cleanup() {
  for (const f of [CLAUDE_CREDS, AGY_SESSION]) { try { fs.rmSync(f, { force: true }); } catch {} }
}

test("A15：只有 Claude Code 凭据时 agy 登录态不得算已登录", () => {
  noteLoggedIn(null);
  cleanup();
  try {
    fs.mkdirSync(path.dirname(CLAUDE_CREDS), { recursive: true });
    fs.writeFileSync(CLAUDE_CREDS, JSON.stringify({ claudeAiOauth: { accessToken: "fix-x-fake" } }), "utf8");
    assert.equal(usable("antigravity"), false, "~/.claude/.credentials.json 是 Claude Code 的凭据，agy 从不读它");
  } finally { cleanup(); noteLoggedIn(null); }
});

test("A15：agy 自己的 session.json 在时判已登录（对照）", () => {
  noteLoggedIn(null);
  cleanup();
  try {
    fs.mkdirSync(path.dirname(AGY_SESSION), { recursive: true });
    fs.writeFileSync(AGY_SESSION, JSON.stringify({ token: "fix-x-fake" }), "utf8");
    assert.equal(usable("antigravity"), true);
  } finally { cleanup(); noteLoggedIn(null); }
});

test("A15：agy 目录下只有空 session.json / .bak 文件时不得判已登录", () => {
  noteLoggedIn(null);
  cleanup();
  try {
    fs.mkdirSync(path.dirname(AGY_SESSION), { recursive: true });
    fs.writeFileSync(AGY_SESSION, "", "utf8");
    fs.writeFileSync(path.join(path.dirname(AGY_SESSION), "session.json.bak"), JSON.stringify({ token: "fix-x-fake" }), "utf8");
    assert.equal(usable("antigravity"), false, "空文件与 .bak 不算登录凭据");
  } finally { cleanup(); noteLoggedIn(null); }
});
