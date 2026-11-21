// P0-2b（agy-only）：MCP 的 add/edit/remove/disable/enable 只碰
// ~/.gemini/config/mcp_config.json；只在 ~/.claude.json 里的服务器不再列出、
// 不再生效（ACP 侧名字只进 skipped，见 A2）；`agy mcp list` 的表格按
// 2026-11-21 的真机探针解析（agy 1.5.13，见下 CAPTURED）。
// 断言都看文件内容与假 agy 二进制，不调真 agy、不登录。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { addMcp, removeMcp, editMcp, getMcp, _extForTest } from "../gw/extensions.mjs";
import { buildAcpMcpServers } from "../gw/mcp-acp.mjs";
import { extOff, saveExtOff, EXT_OFF_FILE } from "../gw/extoff.mjs";

const H = (r) => path.join(CFG.home, r);
const AGY_FILE = PATHS.agyMcpConfig;
const CLAUDE_FILE = H(".claude.json");
const SETTINGS_FILE = H(".gemini/antigravity-cli/settings.json");
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const agyServers = () => (fs.existsSync(AGY_FILE) ? readJson(AGY_FILE).mcpServers || {} : {});
const putAgy = (servers, extra = {}) => put(AGY_FILE, JSON.stringify({ ...extra, mcpServers: servers }));
const putClaude = (servers, extra = {}) => put(CLAUDE_FILE, JSON.stringify({ ...extra, mcpServers: servers }));
const clean = () => {
  for (const f of [AGY_FILE, CLAUDE_FILE, EXT_OFF_FILE]) fs.rmSync(f, { force: true });
  saveExtOff({ mcp: {}, comp: [], mod: [] });
  fs.rmSync(EXT_OFF_FILE, { force: true });
};
const origAgyBin = PATHS.agy;
after(() => {
  clean();
  PATHS.agy = origAgyBin;
  fs.rmSync(H(".gemini"), { recursive: true, force: true });
  fs.rmSync(H(".claude.json"), { force: true });
});

// ── 真机探针原文（2026-11-21，agy 1.5.13，未登录，HOME=/tmp/agy-mcp-probe）：
//    $ agy mcp list        （mcp_config.json 里配了 probe-echo / probe-http / probe-disabled）
//    exit 0，stderr 为空：
//    NAME            TYPE   STATUS    COMMAND/URL
//    probe-disabled  stdio  disabled  node -e 1
//    probe-echo      stdio  enabled   node /tmp/agy-mcp-probe/echo.mjs
//    probe-http      http   enabled   https://example.invalid/mcp
//    空配置时 exit 0，只有一行 "No MCP servers configured."；没有 --json（exit 1）。
const CAPTURED = "NAME            TYPE   STATUS    COMMAND/URL\n"
  + "probe-disabled  stdio  disabled  node -e 1\n"
  + "probe-echo      stdio  enabled   node /tmp/agy-mcp-probe/echo.mjs\n"
  + "probe-http      http   enabled   https://example.invalid/mcp\n";
/** 假 agy：只认 `mcp list`，按给定的输出原样打印（argv 记一份备查）。 */
function fakeAgy(out, dir) {
  const script = path.join(dir, "fake-agy-p02b");
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_AGY_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "mcp" && process.argv[3] === "list") { process.stdout.write(${JSON.stringify(out)}); process.exit(0); }
process.stderr.write("unexpected argv: " + process.argv.slice(2).join(" ") + "\\n"); process.exit(1);
`, { mode: 0o755 });
  return script;
}

test("add/edit/remove/disable/enable 只碰 mcp_config.json：~/.claude.json 一个字节都不动", async () => {
  clean();
  putClaude({ sentinel: { type: "stdio", command: "node", args: ["keep-me.mjs"] } });
  const claudeBefore = fs.readFileSync(CLAUDE_FILE, "utf8");
  putAgy({});
  const { disableMcp, enableMcp } = _extForTest;
  assert.ok((await addMcp({ name: "only1", transport: "stdio", target: "node a.mjs" })).ok);
  assert.equal(fs.readFileSync(CLAUDE_FILE, "utf8"), claudeBefore, "add 之后");
  assert.ok((await editMcp({ name: "only1", transport: "stdio", target: "node b.mjs", env: [], headers: [] })).ok);
  assert.equal(fs.readFileSync(CLAUDE_FILE, "utf8"), claudeBefore, "edit 之后");
  assert.ok((await disableMcp("only1")).ok);
  assert.equal(fs.readFileSync(CLAUDE_FILE, "utf8"), claudeBefore, "disable 之后");
  assert.ok((await enableMcp("only1")).ok);
  assert.equal(fs.readFileSync(CLAUDE_FILE, "utf8"), claudeBefore, "enable 之后");
  assert.ok((await removeMcp("only1")).ok);
  assert.equal(fs.readFileSync(CLAUDE_FILE, "utf8"), claudeBefore, "remove 之后");
  assert.equal(fs.existsSync(SETTINGS_FILE), false, "全程不建 settings.json");
  assert.deepEqual(Object.keys(agyServers()), [], "agy 里也干净了");
});

test("只在 ~/.claude.json 里的服务器：列表里没有、getMcp 找不到、ACP 不发，但名字进 skipped（A2）", async () => {
  clean();
  putClaude(
    { ghost: { type: "stdio", command: "node", args: ["ghost.mjs"] } },
    { projects: { [CFG.workspace]: { mcpServers: { "proj-ghost": { command: "node", args: ["p.mjs"] } } } } },
  );
  const { listMcp, listMcpDefs, userMcpSource } = _extForTest;
  assert.equal(listMcpDefs().has("ghost"), false, "定义里没有它");
  assert.equal(listMcpDefs().has("proj-ghost"), false, "项目级定义也不读");
  assert.equal(userMcpSource("ghost"), null);
  assert.equal((await getMcp({ name: "ghost" })).ok, false);
  const li = await listMcp();
  assert.equal(li.some((m) => m.name === "ghost" || m.name === "proj-ghost"), false, "列表里不出现");
  const { servers, skipped } = buildAcpMcpServers({ cwd: CFG.workspace });
  assert.equal(servers.some((s) => s.name === "ghost" || s.name === "proj-ghost"), false, "ACP 不发");
  // A2：只露名字（绝不露定义/凭据），让用户看得见、自己搬去 mcp_config.json
  assert.ok(skipped.some((s) => s.name === "ghost"), "顶层旧服务器名字进 skipped");
  assert.ok(skipped.some((s) => s.name === "proj-ghost"), "项目级旧服务器名字进 skipped");
  assert.ok(skipped.filter((s) => s.name === "ghost" || s.name === "proj-ghost").every((s) => /claude\.json/.test(s.reason || "") && !/ghost\.mjs|p\.mjs/.test(s.reason || "")),
    "skipped 只含名字与原因，不含命令/路径");
});

test("同名既在顶层又在 projects[cwd]：skipped 里只出现一次（M2）", () => {
  clean();
  putClaude(
    { dup: { type: "stdio", command: "node", args: ["top.mjs"] } },
    { projects: { [CFG.workspace]: { mcpServers: { dup: { command: "node", args: ["proj.mjs"] } } } } },
  );
  const { servers, skipped } = buildAcpMcpServers({ cwd: CFG.workspace });
  assert.equal(servers.some((s) => s.name === "dup"), false, "ACP 还是不发");
  assert.equal(skipped.filter((s) => s.name === "dup").length, 1, "顶层与 projects 循环共用一个 seen，不重复进 skipped（也不重复进 run.mjs 的日志行）");
});

test("同名既在停用名单又被外部加回：列表与详情都报已停用（M4）", async () => {
  clean();
  putAgy({ conflict: { command: "node", args: ["live.mjs"], disabled: false } });
  saveExtOff({ mcp: { conflict: { command: "node", args: ["off.mjs"] } }, comp: [], mod: [] });
  const dir = fs.mkdtempSync(path.join(CFG.home, "p02b-m4-"));
  const argvLog = path.join(dir, "argv.log");
  fs.writeFileSync(argvLog, "");
  process.env.FAKE_AGY_ARGV_LOG = argvLog;
  PATHS.agy = fakeAgy("NAME            TYPE   STATUS    COMMAND/URL\nconflict  stdio  enabled  node live.mjs\n", dir);
  try {
    const { listMcp, enableMcp } = _extForTest;
    const li = await listMcp();
    const e = li.find((m) => m.name === "conflict");
    assert.ok(e, "列表里有它");
    assert.equal(e.disabled, true, "停用名单赢过 live：列表显示已停用，不再和详情各说各话");
    assert.equal(e.source, "off-list");
    assert.equal(e.ok, false);
    const g = await getMcp({ name: "conflict" });
    assert.equal(g.ok, true);
    assert.equal(g.disabled, true, "详情也报已停用");
    assert.equal(g.source, "off-list");
    assert.equal((await enableMcp("conflict")).ok, false, "文件里已有同名，启用拒绝");
  } finally {
    delete process.env.FAKE_AGY_ARGV_LOG;
    PATHS.agy = origAgyBin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agy mcp list 解析：按真机探针表格，enabled/disabled 与命令/地址都对上", async () => {
  clean();
  putAgy({ "probe-echo": { command: "node", args: ["/tmp/agy-mcp-probe/echo.mjs"], disabled: false } });
  const dir = fs.mkdtempSync(path.join(CFG.home, "p02b-agy-"));
  const argvLog = path.join(dir, "argv.log");
  fs.writeFileSync(argvLog, "");
  process.env.FAKE_AGY_ARGV_LOG = argvLog;
  PATHS.agy = fakeAgy(CAPTURED, dir);
  try {
    const { listMcp, parseAgyMcpList } = _extForTest;
    // 解析器本身先对着探针原文验一遍
    assert.deepEqual(parseAgyMcpList(CAPTURED), [
      { name: "probe-disabled", type: "stdio", enabled: false, target: "node -e 1" },
      { name: "probe-echo", type: "stdio", enabled: true, target: "node /tmp/agy-mcp-probe/echo.mjs" },
      { name: "probe-http", type: "http", enabled: true, target: "https://example.invalid/mcp" },
    ]);
    assert.deepEqual(parseAgyMcpList("No MCP servers configured.\n"), [], "空配置");
    assert.deepEqual(parseAgyMcpList("garbage\nmore garbage\n"), [], "看不懂就整段丢掉，不猜");
    const li = await listMcp();
    const byName = new Map(li.map((m) => [m.name, m]));
    assert.equal(byName.get("probe-echo").ok, true, "enabled → ok");
    assert.equal(byName.get("probe-echo").status, "enabled");
    assert.equal(byName.get("probe-echo").target, "node /tmp/agy-mcp-probe/echo.mjs");
    assert.equal(byName.get("probe-echo").user, true, "文件里有的标 user");
    assert.equal(byName.get("probe-echo").source, "agy");
    assert.equal(byName.get("probe-disabled").ok, false, "disabled → 不 ok");
    assert.equal(byName.get("probe-disabled").status, "disabled");
    assert.equal(byName.get("probe-http").ok, true);
    assert.equal(byName.get("probe-http").source, "external", "文件里没有的标 external");
    assert.equal(byName.get("probe-http").target, "https://example.invalid/mcp");
    const argv = fs.readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(argv.at(-1), ["mcp", "list"], "调的是 agy mcp list，不是 claude");
  } finally {
    delete process.env.FAKE_AGY_ARGV_LOG;
    PATHS.agy = origAgyBin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agy 不在 / 输出坏了：列表照常按文件列，不崩", async () => {
  clean();
  putAgy({ fileonly: { command: "node", args: ["f.mjs"], disabled: false } });
  const { listMcp } = _extForTest;
  PATHS.agy = path.join(CFG.home, "no-such-agy");
  const li1 = await listMcp();
  assert.equal(li1.find((m) => m.name === "fileonly").user, true);
  assert.equal(li1.find((m) => m.name === "fileonly").ok, false, "没 live 状态就不说已启用");
  const dir = fs.mkdtempSync(path.join(CFG.home, "p02b-bad-"));
  PATHS.agy = fakeAgy("totally unexpected output\n", dir);
  try {
    const li2 = await listMcp();
    assert.equal(li2.length, 1, "坏输出整段丢掉，只剩文件里的");
    assert.equal(li2[0].name, "fileonly");
  } finally {
    PATHS.agy = origAgyBin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
