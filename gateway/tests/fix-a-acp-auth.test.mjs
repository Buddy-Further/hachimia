// A16：ACP authenticate 静默跳过、失败静默吞掉。
// ① agent 声明了 authMethods、但不含网关传的 authType 时，不得静默跳过跑下去；
// ② agent 声明了该方式、authenticate 报错时，不得只记日志继续跑（“已认证过”类报错除外）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { closeAllAcpClients, runAcpTurn } from "../gw/acp.mjs";

// mock agy acp：行为由 ACP_MOCK_AUTH 环境变量切换；收到的每个 method 记进调用日志文件
function makeMockAgy(dir, logFile) {
  const script = path.join(dir, "mock-agy-auth");
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.ACP_MOCK_AUTH || "ok";
const seen = (m) => fs.appendFileSync(${JSON.stringify(logFile)}, m + "\\n");
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  const msg = JSON.parse(t);
  seen(msg.method || "");
  if (msg.method === "initialize") {
    const methods = mode === "undeclared" ? [{ id: "oauth-personal" }] : [{ id: "oauth-personal" }, { id: "gemini-api-key" }];
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: methods } });
  }
  if (msg.method === "authenticate") {
    if (mode === "auth-fail") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "invalid api key" } });
    if (mode === "auth-already") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "already authenticated" } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true, methodId: msg.params.methodId } });
  }
  if (msg.method === "session/new") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-auth-1", models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }] } } });
  }
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`, { mode: 0o755 });
  return script;
}

async function runTurn(mockBin, logFile, mode) {
  fs.writeFileSync(logFile, "");
  const res = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: CFG.workspace,
    env: { ...process.env, ACP_MOCK_AUTH: mode },
    prompt: "hi",
    model: "gemini-4-neon",
    permMode: "default",
    authType: "gemini-api-key",
    apiKey: "test-key-123",
    keepAlive: false,
    emit: () => {},
  });
  const seen = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  return { res, seen };
}

test("A16：agent 未声明 gemini-api-key 时不得静默跳过认证跑下去", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-a-acp-auth-"));
  const logFile = path.join(tmp, "seen.log");
  const mockBin = makeMockAgy(tmp, logFile);
  try {
    const { res, seen } = await runTurn(mockBin, logFile, "undeclared");
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(String(res.error || ""), /gemini-api-key/, JSON.stringify(res));
    assert.match(String(res.error || ""), /oauth-personal/, JSON.stringify(res));
    assert.ok(!seen.includes("session/new"), "认证方式对不上时不得新建会话：" + seen.join(","));
    assert.ok(!seen.includes("session/prompt"), "认证方式对不上时不得发 prompt：" + seen.join(","));
  } finally { closeAllAcpClients(); }
});

test("A16：authenticate 报错（invalid api key）时不得吞掉继续跑", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-a-acp-auth-2-"));
  const logFile = path.join(tmp, "seen.log");
  const mockBin = makeMockAgy(tmp, logFile);
  try {
    const { res, seen } = await runTurn(mockBin, logFile, "auth-fail");
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(String(res.error || ""), /authenticate/i, JSON.stringify(res));
    assert.ok(!seen.includes("session/new"), "认证失败时不得新建会话：" + seen.join(","));
  } finally { closeAllAcpClients(); }
});

test("A16 对照：authenticate 报 already authenticated 时应视为已认证、继续跑", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-a-acp-auth-3-"));
  const logFile = path.join(tmp, "seen.log");
  const mockBin = makeMockAgy(tmp, logFile);
  try {
    const { res, seen } = await runTurn(mockBin, logFile, "auth-already");
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(seen.includes("session/prompt"), "已认证过应继续跑 prompt：" + seen.join(","));
  } finally { closeAllAcpClients(); }
});
