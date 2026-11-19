import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CFG, PATHS } from "../gw/config.mjs";
import { runAcpTurn } from "../gw/acp.mjs";
import { agyEnv, syncAgySettings } from "../gw/claude.mjs";
import { normalizeModels } from "../gw/models.mjs";

// 构造一个模拟官方 `agy acp` 行为的 stdio JSON-RPC 2.0 桩脚本
function makeMockAgy(dir) {
  const script = path.join(dir, "mock-agy");
  fs.writeFileSync(script, `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingPerm = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");

rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  const msg = JSON.parse(t);
  if (msg.id && msg.result && pendingPerm) {
    const fn = pendingPerm; pendingPerm = null; fn(msg.result); return;
  }
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
      },
    });
  }
  if (msg.method === "authenticate") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true, methodId: msg.params.methodId } });
  }
  if (msg.method === "session/new") {
    return send({
      jsonrpc: "2.0", id: msg.id,
      result: { sessionId: "agy-sess-001", models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }] } },
    });
  }
  if (msg.method === "session/set_config_option") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考中..." } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run_shell", rawInput: { command: "echo hi" } } } });
    // 反向请求权限
    pendingPerm = (permRes) => {
      const allowed = permRes?.outcome?.optionId === "allow_once";
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: allowed ? "completed" : "failed", content: [{ type: "text", text: allowed ? "hi\\n" : "denied" }] } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "已完成执行！" : "用户拒绝了操作。" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "usage", inputTokens: 1200, outputTokens: 42 } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    };
    send({
      jsonrpc: "2.0", id: 9001, method: "session/request_permission",
      params: {
        sessionId: sid,
        toolCall: { toolCallId: "tc-1", title: "run_shell", rawInput: { command: "echo hi" } },
        options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject_once", kind: "reject_once" }],
      },
    });
  }
});
`, { mode: 0o755 });
  return script;
}

test("hachimia ACP 端到端流程：握手、认证、流式输出、权限回调与本地 jsonl 落盘", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "hachimia-acp-"));
  const mockBin = makeMockAgy(tmp);
  const events = [];
  const res = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: CFG.workspace,
    env: process.env,
    prompt: "帮我运行 echo hi",
    model: "gemini-4-neon",
    permMode: "default",
    authType: "gemini-api-key",
    apiKey: "test-key-123",
    emit: (ev) => events.push(ev),
    askPermission: async ({ tool }) => {
      assert.equal(tool, "run_shell");
      return { behavior: "allow" };
    },
  });

  assert.equal(res.ok, true, res.error || JSON.stringify(events));
  assert.equal(res.sessionId, "agy-sess-001");
  assert.equal(res.resultText, "已完成执行！");
  assert.ok(events.some((e) => e.type === "init" && e.protocol === "acp"));
  assert.ok(events.some((e) => e.type === "thinking_delta" && e.text === "思考中..."));
  assert.ok(events.some((e) => e.type === "tool_use" && e.name === "run_shell"));
  assert.ok(events.some((e) => e.type === "tool_result" && e.content.includes("hi")));
  assert.ok(events.some((e) => e.type === "text_delta" && e.text === "已完成执行！"));
  assert.ok(events.some((e) => e.type === "usage" && e.contextTokens === 1200 && e.outputTokens === 42));
  assert.ok(events.some((e) => e.type === "result" && e.stopReason === "end_turn"));

  // 验证本地 jsonl 持久化文件已写入且可解析
  const projDir = path.join(PATHS.projects, String(CFG.workspace).replace(/[^A-Za-z0-9]/g, "-"));
  const jsonlPath = path.join(projDir, "agy-sess-001.jsonl");
  assert.ok(fs.existsSync(jsonlPath), "ACP transcript jsonl should be persisted");
  const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "user");
  assert.equal(lines[1].type, "assistant");
});

test("syncAgySettings & agyEnv：在 Gemini API Key 与 Google 订阅模式间切换", () => {
  const settingsFile = path.join(CFG.home, ".gemini", "antigravity-cli", "settings.json");

  // 1. 切到自定义 Gemini API Key 模式
  const apiProv = { id: "gemini-custom", group: "antigravity", login: false, authStyle: "gemini-api-key", baseUrl: "https://proxy.example.com", apiKey: "AIzaTestKey123456" };
  const env1 = agyEnv({ provider: apiProv });
  assert.equal(env1.GEMINI_API_KEY, "AIzaTestKey123456");
  assert.equal(env1.GOOGLE_GEMINI_BASE_URL, "https://proxy.example.com");
  const st1 = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(st1.modelProvider, "gemini");

  // 2. 切回 Google 订阅登录模式：必须清除 modelProvider 与 GEMINI_API_KEY
  const oauthProv = { id: "antigravity", group: "antigravity", login: true, authStyle: "oauth" };
  const env2 = agyEnv({ provider: oauthProv });
  assert.equal(env2.GEMINI_API_KEY, undefined);
  assert.equal(env2.GOOGLE_GEMINI_BASE_URL, undefined);
  const st2 = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal("modelProvider" in st2, false);
});

test("normalizeModels：兼容 Google Gemini /v1beta/models 响应格式", () => {
  const list = normalizeModels({
    models: [
      { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: 1048576, outputTokenLimit: 65536 },
      { name: "models/gemini-4-neon", displayName: "Gemini 4 Neon", inputTokenLimit: 1048576, outputTokenLimit: 65536 },
    ],
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "gemini-3.8-flash");
  assert.equal(list[0].name, "Gemini 3.8 Flash");
  assert.equal(list[0].context_window, 1048576);
  assert.equal(list[0].max_output_tokens, 65536);
});
