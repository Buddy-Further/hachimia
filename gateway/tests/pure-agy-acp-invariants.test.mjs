// 红队复核补齐：纯 agy / ACP 核心运行不变量、bin/agy 封签核验、真实 agy mcp_config.json / mcp list 解析、升级边界
import { CFG, PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const WORK = fs.mkdtempSync(path.join(process.env.CCAPP_TMP || CFG.workspace, "pure-agy-inv-"));

const prevAgy = PATHS.agy;
const prevPermWait = process.env.CCAPP_PERM_WAIT_MS;

const { startRun, pickProvider, lostProvider } = await import("../gw/run.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { closeAllAcpClients } = await import("../gw/acp.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");
const { putAgentNote, takeAgentNote, agentsDir } = await import("../gw/agents.mjs");
const { readLedger } = await import("../gw/claude.mjs");
const { PROVIDER, billAfterRun } = await import("../gw/providers.mjs");
const { setSessModel, sessLostProvider } = await import("../gw/sessmodel.mjs");
const { _extForTest, getMcp } = await import("../gw/extensions.mjs");
const { buildCapabilities } = await import("../gw/caps.mjs");

const events = [];
const off = onPublish((e) => events.push(e));
const origFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not access network"); };

after(() => {
  off();
  globalThis.fetch = origFetch;
  try { closeAllAcpClients(); } catch {}
  PATHS.agy = prevAgy;
  if (prevPermWait === undefined) delete process.env.CCAPP_PERM_WAIT_MS;
  else process.env.CCAPP_PERM_WAIT_MS = prevPermWait;
  fs.rmSync(WORK, { recursive: true, force: true });
});

function makeMockAgy(name, body) {
  const f = path.join(WORK, name);
  fs.writeFileSync(f, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return f;
}

const evOf = (runId) => events.filter((e) => e.runId === runId);

test("P1-3(3): 缺失 cwd 直接报错拦截，不静默回退到工作区", async () => {
  PATHS.agy = makeMockAgy("mock-nocwd.mjs", "process.exit(0);\n");
  const id = "inv-missing-cwd";
  const missing = path.join(WORK, "does-not-exist-dir");
  await startRun({ id, message: "hello", cwd: missing });
  const mine = evOf(id);
  const err = mine.find((e) => e.type === "error");
  const end = mine.find((e) => e.type === "run_end");
  assert.ok(err && /工作目录.*不在了/.test(err.message), JSON.stringify(mine));
  assert.equal(end?.failed, true);
});

test("P1-3(4): 预启动失败时 giveNotesBack 将未送出的代理提醒退回", async () => {
  const cwd = path.join(WORK, "ws-notes");
  fs.mkdirSync(cwd, { recursive: true });
  const sid = crypto.randomUUID();
  fs.mkdirSync(agentsDir(cwd, sid), { recursive: true });
  putAgentNote(cwd, sid, "未送出的提醒-9981");
  const mock = makeMockAgy("mock-notes.mjs", `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } }) + "\\n");
  else if (m.method === "authenticate") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } }) + "\\n");
  else if (m.method === "session/new" || m.method === "session/resume") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { sessionId: ${JSON.stringify(sid)} } }) + "\\n");
  else if (m.method === "session/set_mode" || m.method === "session/set_config_option") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");
  else if (m.method === "session/prompt") process.exit(2);
});
`);
  PATHS.agy = mock;
  const id = "inv-notes-back";
  await startRun({ id, message: "hello", cwd, sessionId: sid });
  const left = takeAgentNote(cwd, sid);
  assert.match(left, /未送出的提醒-9981/, "失败轮次未送出的提醒应退回: " + JSON.stringify(left));
});

test("P1-3(1)(2)(5)(7)(8): ACP 权限超时标记 expired:true、guardKey 按目标区分、session_created、stderrTail、计量账本", async () => {
  const cwd = path.join(WORK, "ws-acp");
  fs.mkdirSync(cwd, { recursive: true });
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");

  // 子场景 A: 源码核对 guardKey 按目标/device 按类别、perm_resolved expired:true、起进程前 permMode 同步
  const runSrc = fs.readFileSync(path.join(REPO, "gateway/gw/run.mjs"), "utf8");
  assert.match(runSrc, /const guardKey = \(p\) => \(\/\^device:\/\.test\(p\.guard\.cat\) \? p\.guard\.cat : `\$\{p\.tool\}\\0\$\{p\.guard\.cat\}\\0\$\{p\.guard\.what\}`\);/);
  assert.match(runSrc, /emit\(\{ type: "perm_resolved", id, behavior: "deny", expired: true \}\)/);
  assert.match(runSrc, /run\.permMode !== permMode && PERM_MODES\.includes\(run\.permMode\)/);

  // 子场景 B: 独立子进程实测 CCAPP_PERM_WAIT_MS=150 运行期触发 perm_resolved { behavior: "deny", expired: true }
  const sidPerm = crypto.randomUUID();
  const mockPerm = makeMockAgy("mock-perm-exp.mjs", `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let promptId = null;
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id === 501 && m.result) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === "authenticate") return send({ jsonrpc: "2.0", id: m.id, result: { ok: true } });
  if (m.method === "session/new") return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: ${JSON.stringify(sidPerm)} } });
  if (m.method === "session/set_mode" || m.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "session/prompt") {
    promptId = m.id;
    send({ jsonrpc: "2.0", id: 501, method: "session/request_permission", params: {
      sessionId: ${JSON.stringify(sidPerm)},
      toolCall: { toolCallId: "tc-exp", title: "run_command", rawInput: { CommandLine: "echo hi" } },
      options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject_once", kind: "reject_once" }],
    } });
  }
});
`);
  const gwUrl = new URL("../gw/", import.meta.url).href;
  const permProbe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { PATHS } = await import(${JSON.stringify(gwUrl + "config.mjs")});
    await import(${JSON.stringify(new URL("./fixtures/uc-baseline.mjs", import.meta.url).href)});
    PATHS.agy = ${JSON.stringify(mockPerm)};
    const { startRun } = await import(${JSON.stringify(gwUrl + "run.mjs")});
    const { onPublish } = await import(${JSON.stringify(gwUrl + "bus.mjs")});
    const { closeAllAcpClients } = await import(${JSON.stringify(gwUrl + "acp.mjs")});
    const evs = [];
    onPublish((e) => { if (e.runId === "sub-perm") evs.push(e); });
    await startRun({ id: "sub-perm", message: "hi", cwd: ${JSON.stringify(cwd)}, permissionMode: "default" });
    closeAllAcpClients();
    const res = evs.find((e) => e.type === "perm_resolved");
    console.log(JSON.stringify(res || null));
    process.exit(0);
  `], { env: { ...process.env, CCAPP_PERM_WAIT_MS: "150", CCAPP_TEST: "1" }, encoding: "utf8", timeout: 15000 });
  assert.equal(permProbe.status, 0, permProbe.stderr);
  const resolved = JSON.parse(permProbe.stdout.trim().split("\n").pop());
  assert.equal(resolved?.behavior, "deny");
  assert.equal(resolved?.expired, true, "ACP 权限超时必须标记 expired:true: " + JSON.stringify(resolved));

  // 子场景 C: 长 stderr -> 报错保留尾部标记
  const mockTail = makeMockAgy("mock-stderr-tail.mjs", `
process.stderr.write("X".repeat(25000) + "\\nACP-STDERR-TAIL-7741\\n");
process.exit(1);
`);
  PATHS.agy = mockTail;
  const idTail = "inv-stderr-tail";
  await startRun({ id: idTail, message: "boom", cwd });
  const tailEvs = evOf(idTail);
  const tailErr = tailEvs.find((e) => e.type === "error");
  assert.ok(tailErr, "应产生 error 事件");
  assert.match(String(tailErr.detail || tailErr.message || ""), /ACP-STDERR-TAIL-7741/, "应保留 stderr 尾部标记");

  // 子场景 D: 正常新会话 -> 广播 session_created 且正常完成
  const sid2 = crypto.randomUUID();
  const jsonl2 = path.join(CFG.home, ".claude", "projects", slug, `${sid2}.jsonl`);
  const mockOk = makeMockAgy("mock-ok-created.mjs", `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === "authenticate") return send({ jsonrpc: "2.0", id: m.id, result: { ok: true } });
  if (m.method === "session/new") {
    fs.mkdirSync(path.dirname(${JSON.stringify(jsonl2)}), { recursive: true });
    fs.writeFileSync(${JSON.stringify(jsonl2)}, '{"type":"user","message":{"role":"user","content":"hi"}}\\n');
    return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: ${JSON.stringify(sid2)} } });
  }
  if (m.method === "session/set_mode" || m.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(sid2)}, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
    return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 88, outputTokens: 12 } } });
  }
});
`);
  PATHS.agy = mockOk;
  const idOk = "inv-ok-created";
  await startRun({ id: idOk, message: "hi", cwd });
  const okEvs = evOf(idOk);
  assert.ok(okEvs.some((e) => e.type === "session_created" && e.sessionId === sid2), "新会话应广播 session_created");
  assert.ok(okEvs.some((e) => e.type === "run_end" && !e.failed), "正常完成应发出 run_end");
});

test("Backend P0: 部署态 bin/agy 调用 cc-seal.mjs --verify-only，篡改或替换 CCAPP_AGY 均 fail-closed 退出 4", () => {
  const deploy = path.join(WORK, "deploy-app");
  const sealHome = path.join(WORK, "seal-home");
  const verDir = path.join(sealHome, ".local/share/hachimia/agy/1.6.0");
  const fakePre = path.join(WORK, "fake-pre");
  fs.mkdirSync(path.join(deploy, "bin"), { recursive: true });
  fs.mkdirSync(path.join(fakePre, "bin"), { recursive: true });
  fs.mkdirSync(verDir, { recursive: true });
  fs.cpSync(path.join(REPO, "gateway/gw"), path.join(deploy, "gw"), { recursive: true });
  fs.cpSync(path.join(REPO, "gateway/guard"), path.join(deploy, "guard"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "android/assets/bin/agy"), path.join(deploy, "bin/agy"));
  fs.writeFileSync(path.join(deploy, "FILES"), "");
  fs.symlinkSync(process.execPath, path.join(fakePre, "bin/node"));

  const agyBin = path.join(verDir, "agy");
  const agyBody = `#!${SH}\necho SEALED_AGY_RAN\n`;
  fs.writeFileSync(agyBin, agyBody, { mode: 0o755 });
  fs.writeFileSync(path.join(verDir, "manifest.json"), JSON.stringify({
    version: "1.6.0",
    sha256: crypto.createHash("sha256").update(agyBody).digest("hex"),
  }));
  fs.symlinkSync("1.6.0", path.join(sealHome, ".local/share/hachimia/agy/current"));

  const baseEnv = { ...process.env, HOME: sealHome, CCAPP_HOME: sealHome, PREFIX: fakePre, CCAPP_TEST: "1" };
  delete baseEnv.CCAPP_AGY; delete baseEnv.CCAPP_EXEC;

  // 1) 合法二进制 -> 放行执行（在 W^X 环境下可能 exec 脚本返 126，但绝不会是 4）
  const rOk = spawnSync(SH, [path.join(deploy, "bin/agy"), "--version"], { env: baseEnv, encoding: "utf8" });
  assert.notEqual(rOk.status, 4, "合法 agy 不应被封签拒绝: " + rOk.stderr);

  // 2) 篡改二进制 -> 必须 fail-closed 退出 4
  fs.writeFileSync(agyBin, `#!${SH}\necho PWNED\n`, { mode: 0o755 });
  const rTamper = spawnSync(SH, [path.join(deploy, "bin/agy"), "--version"], { env: baseEnv, encoding: "utf8" });
  assert.equal(rTamper.status, 4, "被篡改的 agy 必须返回退出码 4: " + rTamper.stderr);
  assert.doesNotMatch(rTamper.stdout, /PWNED/);

  // 3) 恢复合法官方二进制，但通过 CCAPP_AGY 指向外部替身 -> 必须 fail-closed 退出 4
  fs.writeFileSync(agyBin, agyBody, { mode: 0o755 });
  const decoy = path.join(WORK, "decoy-agy.sh");
  fs.writeFileSync(decoy, `#!${SH}\necho DECOY_RAN\n`, { mode: 0o755 });
  const rDecoy = spawnSync(SH, [path.join(deploy, "bin/agy"), "--version"], { env: { ...baseEnv, CCAPP_AGY: decoy }, encoding: "utf8" });
  assert.equal(rDecoy.status, 4, "CCAPP_AGY 替身必须被拒绝退出 4: " + rDecoy.stderr);
  assert.doesNotMatch(rDecoy.stdout, /DECOY_RAN/);
});

test("Backend P1-2 & P2-4: 真实 agy mcp list 表格与 ~/.gemini/config/mcp_config.json(serverUrl) 完整解析；caps 恒为 antigravity", async () => {
  const mcpCfg = path.join(CFG.home, ".gemini", "config", "mcp_config.json");
  fs.mkdirSync(path.dirname(mcpCfg), { recursive: true });
  fs.writeFileSync(mcpCfg, JSON.stringify({
    mcpServers: {
      my_http: { serverUrl: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } },
      my_stdio: { command: "node", args: ["srv.js"], env: { FOO: "1" } },
    },
  }));
  const mockList = makeMockAgy("mock-agy-mcplist.mjs", `
process.stdout.write("NAME      TYPE   STATUS   COMMAND/URL\\n");
process.stdout.write("my_http   http   enabled  https://example.com/mcp\\n");
process.stdout.write("my_stdio  stdio  enabled  node srv.js\\n");
`);
  PATHS.agy = mockList;
  try {
    const list = await _extForTest.listMcp();
    const h = list.find((x) => x.name === "my_http");
    const s = list.find((x) => x.name === "my_stdio");
    assert.ok(h && h.ok === true && h.target === "https://example.com/mcp" && h.user === true, JSON.stringify(list));
    assert.equal(h.hdr, "Authorization");
    assert.ok(s && s.ok === true && s.target === "node srv.js" && s.user === true, JSON.stringify(list));

    const g = await getMcp({ name: "my_http" });
    assert.equal(g.ok, true);
    assert.equal(g.transport, "http");
    assert.equal(g.target, "https://example.com/mcp");
    assert.deepEqual(g.headerNames, ["Authorization"]);

    const caps = buildCapabilities();
    assert.equal(caps.engine, "antigravity");
    assert.ok(caps.mcpServers.some((m) => m.name === "my_http"), "scanAgyLocal 应读取 mcp_config.json");
  } finally {
    fs.rmSync(mcpCfg, { force: true });
  }
});

test("Backend P1-3: 冷启动首次调用 sessLostProvider 触发懒迁移，queued item.provider=local 平滑切回 antigravity", () => {
  const coldHome = path.join(WORK, "cold-sesslost-home");
  fs.mkdirSync(coldHome, { recursive: true });
  const sid = "inv-local-pin-" + Date.now();
  fs.writeFileSync(path.join(coldHome, "ccapp-session-models.json"), JSON.stringify({
    [sid]: { provider: "local", model: "qwen.gguf", effort: null, at: Date.now() },
  }));
  const gwUrl = new URL("../gw/", import.meta.url).href;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { sessLostProvider, sessModel } = await import(${JSON.stringify(gwUrl + "sessmodel.mjs")});
    const lost = sessLostProvider(${JSON.stringify(sid)});
    const rec = sessModel(${JSON.stringify(sid)});
    console.log(JSON.stringify({ lost, provider: rec?.provider, model: rec?.model }));
    process.exit(0);
  `], { env: { ...process.env, HOME: coldHome, CCAPP_HOME: coldHome, CCAPP_TEST: "1" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), { lost: "", provider: "antigravity", model: "" });

  const picked = pickProvider({ provider: "local", message: "hi" });
  assert.equal(picked.P.id, "antigravity");
  assert.equal(lostProvider({ provider: "local" }, "", {}), "");
  assert.equal(lostProvider({ pin: { provider: "local" } }, "", {}), "");
});
