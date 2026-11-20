// 跨片跟进复现（C2/C6/C7/C16）：根因在 run.mjs / acp.mjs（B 片），本片不改。
// 以下 4 个测试在修复前已确认跑红（2026-11-20，fix-c- 全量 21 个测试 0 通过时），
// 现改为 test.skip 留给跟进方：修完对应文件后取消跳过即可变绿。密钥、模型名全是 fixture。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";

function mockAgy(tmp, body) {
  const mockBin = path.join(tmp, "mock-agy");
  fs.writeFileSync(mockBin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return mockBin;
}
const BASE_MOCK = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  const msg = JSON.parse(t);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-cross-1", models: { currentModelId: "gemini-3.8-flash", availableModels: [{ modelId: "gemini-3.8-flash" }] }, configOptions: [{ id: "model", options: [{ value: "gemini-3.8-flash" }] }] } });
  if (msg.method === "session/set_config_option" || msg.method === "session/set_mode") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-cross-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`;

// C2：run.mjs 的 authType 默认映射把非登录厂商都标成 gemini-api-key。
// 测真实接线：providers.mjs 导出的 acpAuthType（run.mjs 即用它），不再内联旧表达式复述。
test("C2（跨片：run.mjs）：DeepSeek 不得默认映射成 gemini-api-key", async () => {
  const { acpAuthType, providerById } = await import("../gw/providers.mjs");
  assert.equal(acpAuthType(providerById("deepseek")), "deepseek-api-key", "第三方厂商用自己的 api-key 类型");
  assert.equal(acpAuthType(providerById("gemini-key")), "gemini-api-key", "真 Gemini 厂商仍是 gemini-api-key");
  assert.equal(acpAuthType(providerById("antigravity")), "oauth-personal", "登录类厂商是 oauth-personal");
  assert.equal(acpAuthType(providerById("antigravity-enterprise")), "oauth-business", "企业登录保持 oauth-business");
  assert.equal(acpAuthType(providerById("anthropic-key")), "anthropic-key-api-key");
  assert.notEqual(acpAuthType(providerById("deepseek")), "gemini-api-key", "第三方厂商不得默认成 Gemini 认证方式");
  // run.mjs 必须走这个 helper，不得再留旧的默认表达式
  const runSrc = fs.readFileSync(new URL("../gw/run.mjs", import.meta.url), "utf8");
  assert.ok(runSrc.includes("acpAuthType(P)"), "run.mjs 应调用 acpAuthType(P)");
  assert.ok(!runSrc.includes('P.authType || (P.login ? "oauth-personal" : "gemini-api-key")'),
    "run.mjs 不得再有默认 gemini-api-key 的旧表达式");
});

// C6：ACP 模型切换静默失败——agy 没有该模型时 init 不得宣称已切
test("C6（跨片：acp.mjs）：agy 没有 gemini-4-neon 时，init 不得宣称已用它", async () => {
  const { runAcpTurn, closeAcpSession } = await import("../gw/acp.mjs");
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-c-c6-"));
  const mockBin = mockAgy(tmp, BASE_MOCK);
  const events = [];
  const res = await runAcpTurn({ bin: process.execPath, args: [mockBin], cwd: CFG.workspace, env: process.env,
    prompt: "hello", model: "gemini-4-neon", effort: "high", keepAlive: false, emit: (e) => events.push(e) });
  closeAcpSession("sess-cross-1");
  const initEv = events.find((e) => e.type === "init");
  assert.ok(res.ok === false || initEv?.model !== "gemini-4-neon",
    "agy 没接受该模型时，要么报错、要么 init 报真实模型，不能宣称已切：" + JSON.stringify({ ok: res.ok, initModel: initEv?.model }));
});

// C7：/compact 假成功——post > pre 时不得补发 compacted
test("C7（跨片：acp.mjs）：/compact 后上下文不降反升时不得发 compacted", async () => {
  const { runAcpTurn, closeAcpSession } = await import("../gw/acp.mjs");
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-c-c7-"));
  const mockBin = mockAgy(tmp, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let n = 0;
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  const msg = JSON.parse(t);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-cross-1" } });
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/prompt") {
    n++;
    if (n === 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-cross-1", update: { sessionUpdate: "usage_update", used: 180000, size: 1048576 } } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-cross-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "compacting is not supported" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-cross-1", update: { sessionUpdate: "usage_update", used: 190000, size: 1048576 } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 190000, outputTokens: 400 } } });
  }
});
`);
  await runAcpTurn({ bin: process.execPath, args: [mockBin], cwd: CFG.workspace, env: process.env,
    prompt: "hello", keepAlive: true, emit: () => {} });
  const evs = [];
  await runAcpTurn({ bin: process.execPath, args: [mockBin], cwd: CFG.workspace, env: process.env,
    prompt: "/compact", sessionId: "sess-cross-1", keepAlive: true, emit: (e) => evs.push(e) });
  closeAcpSession("sess-cross-1");
  const compacted = evs.find((e) => e.type === "compacted");
  assert.equal(compacted, undefined, "post(190000) > pre(180000) 时不得补发 compacted：" + JSON.stringify(compacted));
});

// C16：无 usage_update 时整轮累计用量不得冒充单步上下文
test("C16（跨片：acp.mjs）：全程无 usage_update 时，累计 900000 不得当成 context_tokens", async () => {
  const { runAcpTurn, closeAcpSession } = await import("../gw/acp.mjs");
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-c-c16-"));
  const mockBin = mockAgy(tmp, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  const msg = JSON.parse(t);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-cross-1" } });
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-cross-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 900000, outputTokens: 5000, totalTokens: 905000 } } });
  }
});
`);
  const res = await runAcpTurn({ bin: process.execPath, args: [mockBin], cwd: CFG.workspace, env: process.env,
    prompt: "hello", keepAlive: false, emit: () => {} });
  closeAcpSession("sess-cross-1");
  assert.notEqual(res.usage?.context_tokens, 900000, "整轮累计值不得冒充单步上下文，实际 context_tokens=" + res.usage?.context_tokens);
});
