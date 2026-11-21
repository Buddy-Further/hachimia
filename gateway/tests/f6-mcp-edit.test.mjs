// F6（11-15，P0-2 改写）：MCP 编辑 = 直接改 agy 的 mcp_config.json（不再 remove + add-json）。
// 合并语义：留空 = 保留原值（值只存配置文件里，不回前端）、提交的同名键覆盖、点掉的键删除；
// 写回用 JSON：定义整体一个对象，值里的逗号/等号/引号/换行不会被切坏；
// 改名失败回滚（删新名、旧定义写回）。停用中的条目只改停用名单，不碰配置文件。不调 claude 二进制。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";

const { editMcp, getMcp, _extForTest } = await import("../gw/extensions.mjs");
const { mcpAddArgs } = _extForTest;
const { extOff, saveExtOff, EXT_OFF_FILE } = await import("../gw/extoff.mjs");
const { _agyMcpTest } = await import("../gw/agy-mcp.mjs");
const H = (r) => path.join(CFG.home, r);
const AGY_FILE = PATHS.agyMcpConfig;
const CLAUDE_FILE = H(".claude.json");
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const agyServers = () => (fs.existsSync(AGY_FILE) ? readJson(AGY_FILE).mcpServers || {} : {});
const claudeServers = () => (fs.existsSync(CLAUDE_FILE) ? (readJson(CLAUDE_FILE).mcpServers || {}) : {});
const putAgy = (name, d) => { const cur = agyServers(); cur[name] = d; put(AGY_FILE, JSON.stringify({ mcpServers: cur })); };
const putClaude = (name, d) => { const cur = claudeServers(); cur[name] = d; put(CLAUDE_FILE, JSON.stringify({ mcpServers: cur })); };
const clean = () => {
  for (const f of [AGY_FILE, CLAUDE_FILE]) fs.rmSync(f, { force: true });
  saveExtOff({ mcp: {}, comp: [], mod: [] });
  fs.rmSync(EXT_OFF_FILE, { force: true });
};
after(() => {
  clean();
  fs.rmSync(H(".gemini"), { recursive: true, force: true });
});

test("mcpAddArgs：stdio 选项顺序与 -- 收尾，parts 直传不重切", () => {
  assert.deepEqual(mcpAddArgs("stdio", "a", "npx -y pkg x", ["FOO=1", "bad"], ["X-Test: v"]),
    ["mcp", "add", "-s", "user", "--transport", "stdio", "a", "-e", "FOO=1", "--header", "X-Test: v", "--", "npx", "-y", "pkg", "x"]);
  // 带空格的参数：走 parts 时原样保留，重切会把 "a b" 拆成两个
  assert.deepEqual(mcpAddArgs("stdio", "a", "npx pkg", [], [], ["npx", "pkg", "a b"]),
    ["mcp", "add", "-s", "user", "--transport", "stdio", "a", "--", "npx", "pkg", "a b"]);
});

test("mcpAddArgs：远程 transport 地址是位置参数，-e 不进命令行", () => {
  assert.deepEqual(mcpAddArgs("http", "b", "http://x/mcp", [], ["Authorization: Bearer <redacted>"]),
    ["mcp", "add", "-s", "user", "--transport", "http", "b", "http://x/mcp", "--header", "Authorization: Bearer <redacted>"]);
});

test("getMcp：预填命令/地址与键名，不带值；停用名单里的也能读；找不到报错", async () => {
  clean();
  putAgy("rmc", { type: "http", url: "http://h/mcp", headers: { Authorization: "x", "X-A": "1" }, disabled: false });
  const g = await getMcp({ name: "rmc" });
  assert.deepEqual({ name: g.name, transport: g.transport, target: g.target, envNames: g.envNames, headerNames: g.headerNames, source: g.source },
    { name: "rmc", transport: "http", target: "http://h/mcp", envNames: [], headerNames: ["Authorization", "X-A"], source: "agy" });
  assert.equal(g.ok, true);
  putAgy("smc", { command: "npx", args: ["-y", "x"], env: { A: "1" }, disabled: false });
  const s = await getMcp({ name: "smc" });
  assert.equal(s.transport, "stdio");
  assert.equal(s.target, "npx -y x");
  assert.deepEqual(s.envNames, ["A"]);
  saveExtOff({ mcp: { dx: { type: "http", url: "http://off/mcp", headers: { Authorization: "x" } } } });
  const d = await getMcp({ name: "dx" });
  assert.equal(d.ok, true);
  assert.equal(d.transport, "http");
  assert.deepEqual(d.headerNames, ["Authorization"]);
  assert.equal(d.source, "off-list");
  // 只在 Claude 里的也能读（来源标 claude）
  putClaude("cmc", { type: "stdio", command: "node", args: ["c.mjs"] });
  const c = await getMcp({ name: "cmc" });
  assert.equal(c.ok, true);
  assert.equal(c.source, "claude");
  assert.match((await getMcp({ name: "nope" })).message, /找不到这条/);
});

test("editMcp：改 URL 留空 = 保留原请求头值，点掉的键删掉", async () => {
  clean();
  putAgy("e1", { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer <redacted>", "X-A": "1" }, disabled: false });
  const r = await editMcp({ name: "e1", transport: "http", target: "http://new/mcp", env: [], headers: [], dropHeaders: ["X-A"] });
  assert.ok(r.ok, r.message);
  assert.deepEqual(agyServers().e1, { type: "http", url: "http://new/mcp", headers: { Authorization: "Bearer <redacted>" }, disabled: false },
    "留空的请求头带着原值，点掉的键不在");
});

test("editMcp：同名键覆盖、改名、删环境变量；空 env 不写进定义", async () => {
  clean();
  putAgy("e2", { command: "npx", args: ["-y", "x"], env: { A: "1", B: "2" }, disabled: false });
  const r = await editMcp({ name: "e2", newName: "e2x", transport: "stdio", target: "npx -y y", env: ["A=9"], headers: [], dropEnv: ["B"] });
  assert.ok(r.ok, r.message);
  assert.equal(agyServers().e2, undefined, "旧名删掉");
  assert.deepEqual(agyServers().e2x, { command: "npx", args: ["-y", "y"], env: { A: "9" }, disabled: false },
    "同名覆盖、点掉的删掉、旧值不残留；stdio 不写 type");
});

test("editMcp：远程改本地清掉远程字段，本地改远程清掉本地字段", async () => {
  clean();
  putAgy("e7", { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer <redacted>" }, disabled: false });
  const r = await editMcp({ name: "e7", transport: "stdio", target: "npx -y x", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.ok(r.ok, r.message);
  const j = agyServers().e7;
  assert.equal(j.command, "npx");
  assert.deepEqual(j.args, ["-y", "x"]);
  assert.ok(!("url" in j), "url 清掉");
  assert.ok(!("headers" in j), "stdio 不存请求头：这里显式删掉，别静默丢令牌");
  assert.ok(!("type" in j), "agy 原生形态：stdio 不写 type");
  putAgy("e8", { command: "npx", args: ["-y", "x"], env: { A: "1" }, disabled: false });
  const r2 = await editMcp({ name: "e8", transport: "http", target: "http://h2/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.ok(r2.ok, r2.message);
  const j2 = agyServers().e8;
  assert.equal(j2.url, "http://h2/mcp");
  assert.ok(!("command" in j2) && !("env" in j2), "本地字段清掉");
});

test("editMcp：改名写失败回滚（新名删掉、旧定义写回）；同名写失败旧配置没动", async () => {
  clean();
  putAgy("e3", { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer <redacted>" }, disabled: false });
  _agyMcpTest.failAfterWrites = 1;   // 写新名成功、删旧名失败 → 回滚
  try {
    const r = await editMcp({ name: "e3", newName: "e3x", transport: "http", target: "http://new/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
    assert.equal(r.ok, false);
    assert.match(r.message, /旧配置已原样恢复/);
  } finally { _agyMcpTest.failAfterWrites = -1; }
  assert.deepEqual(Object.keys(agyServers()), ["e3"]);
  assert.deepEqual(agyServers().e3, { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer <redacted>" }, disabled: false }, "回滚的是旧名 + 旧定义");
  _agyMcpTest.failAfterWrites = 0;   // 下一次写就失败：同名编辑
  try {
    const r2 = await editMcp({ name: "e3", transport: "http", target: "http://new2/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
    assert.equal(r2.ok, false);
    assert.match(r2.message, /旧配置没动/);
  } finally { _agyMcpTest.failAfterWrites = -1; }
  assert.deepEqual(agyServers().e3.url, "http://old/mcp");
});

test("editMcp：停用中的条目只改停用名单，不碰配置文件，可改名", async () => {
  clean();
  saveExtOff({ mcp: { dx: { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer <redacted>" } } } });
  const before = fs.existsSync(AGY_FILE) ? fs.readFileSync(AGY_FILE, "utf8") : null;
  const r = await editMcp({ name: "dx", newName: "dx2", transport: "http", target: "http://new/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.ok(r.ok, r.message);
  assert.equal(fs.existsSync(AGY_FILE) ? fs.readFileSync(AGY_FILE, "utf8") : null, before, "停用条目不碰配置文件");
  const off = extOff();
  assert.deepEqual(off.mcp.dx2, { type: "http", url: "http://new/mcp", headers: { Authorization: "Bearer <redacted>" } });
  assert.equal(off.mcp.dx, undefined);
});

test("editMcp：改名撞已有名字直接拒（两边名单都查）；远程传环境变量照拒", async () => {
  clean();
  putAgy("e5", { type: "http", url: "http://a/mcp", disabled: false });
  putAgy("e6", { type: "http", url: "http://b/mcp", disabled: false });
  assert.match((await editMcp({ name: "e5", newName: "e6", transport: "http", target: "http://a2/mcp" })).message, /已经有叫这个名字/);
  assert.match((await editMcp({ name: "e5", transport: "http", target: "http://a2/mcp", env: ["A=1"] })).message, /远程 MCP 不支持环境变量/);
});

test("editMcp：跨名单改名互撞也拒（停用→活跃、活跃→停用）", async () => {
  clean();
  putAgy("act1", { type: "http", url: "http://a/mcp", disabled: false });
  saveExtOff({ mcp: { off1: { type: "http", url: "http://o/mcp" } } });
  // 停用条目改名成活跃条目名字：以前会放行，留下同名幽灵
  assert.match((await editMcp({ name: "off1", newName: "act1", transport: "http", target: "http://o2/mcp" })).message, /已经有叫这个名字/);
  // 活跃条目改名成停用名单里的名字
  assert.match((await editMcp({ name: "act1", newName: "off1", transport: "http", target: "http://a2/mcp" })).message, /已经有叫这个名字/);
});

test("editMcp：校验（找不到、坏名字、坏地址）", async () => {
  clean();
  assert.match((await editMcp({ name: "ghost", transport: "http", target: "http://x/mcp" })).message, /找不到这条/);
  putAgy("e4", { type: "http", url: "http://x/mcp", headers: {}, disabled: false });
  assert.match((await editMcp({ name: "e4", newName: "-bad", transport: "http", target: "http://x/mcp" })).message, /名字只能/);
  assert.match((await editMcp({ name: "e4", transport: "http", target: "notaurl" })).message, /http/);
});

test("editMcp：只在 Claude 里的服务器，同名编辑写进 agy，Claude 里旧定义留着被盖住", async () => {
  clean();
  putClaude("legacy", { type: "stdio", command: "npx", args: ["-y", "old"], env: { A: "1" } });
  const r = await editMcp({ name: "legacy", transport: "stdio", target: "npx -y new", env: [], headers: [] });
  assert.ok(r.ok, r.message);
  assert.deepEqual(agyServers().legacy, { command: "npx", args: ["-y", "new"], env: { A: "1" }, disabled: false });
  assert.deepEqual(claudeServers().legacy, { type: "stdio", command: "npx", args: ["-y", "old"], env: { A: "1" } });
  assert.equal((await getMcp({ name: "legacy" })).source, "both-shadowed");
});
