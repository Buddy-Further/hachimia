import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { closeAllAcpClients, runAcpTurn, translateAcpUpdate, acpTextOf } from "../gw/acp.mjs";
import { transcriptItems } from "../gw/transcript.mjs";
import { agyEnv, syncAgySettings } from "../gw/claude.mjs";
import { normalizeModels } from "../gw/models.mjs";

// 构造一个模拟官方 `agy acp` 行为的 stdio JSON-RPC 2.0 桩脚本
function makeMockAgy(dir) {
  const script = path.join(dir, "mock-agy");
  fs.writeFileSync(script, `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingPerm = null;
let promptCount = 0;
let initCount = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");

rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  const msg = JSON.parse(t);
  if (msg.id && msg.result && pendingPerm) {
    const fn = pendingPerm; pendingPerm = null; fn(msg.result); return;
  }
  if (msg.method === "initialize") {
    initCount++;
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
    send({
      jsonrpc: "2.0", id: msg.id,
      result: { sessionId: "agy-sess-001", models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }] } },
    });
    // 官方 1.5.13 恢复会话时会先重放历史消息：这些不算本轮正文
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-sess-001", update: { sessionUpdate: "agent_message", messageId: "msg-old-1", content: { type: "text", text: "【历史】之前聊过的东西" } } } });
    return;
  }
  if (msg.method === "session/set_config_option" || msg.method === "session/set_mode") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/prompt") {
    promptCount++;
    const sid = msg.params.sessionId;
    if (promptCount > 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第二轮复用成功 init=" + initCount } } } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考中..." } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run_shell", rawInput: { command: "echo hi" } } } });
    // 进行中的流式输出不应提前发 tool_result
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "running..." } }] } } });
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
        options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "allow_always", kind: "allow_always" }, { optionId: "reject_once", kind: "reject_once" }],
      },
    });
  }
});
`, { mode: 0o755 });
  return script;
}

test("hachimia ACP 端到端流程：握手、认证、工具 ok/text 契约、权限回调与含 tool_result 的 jsonl 落盘", async () => {
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
    keepAlive: false,
    emit: (ev) => events.push(ev),
    askPermission: async ({ tool, toolCallId, hasAlways }) => {
      assert.equal(tool, "run_shell");
      assert.equal(toolCallId, "tc-1");
      assert.equal(hasAlways, true);
      return { behavior: "allow" };
    },
  });

  assert.equal(res.ok, true, res.error || JSON.stringify(events));
  assert.equal(res.sessionId, "agy-sess-001");
  assert.equal(res.resultText, "已完成执行！");
  assert.ok(!events.some((e) => e.type === "text_delta" && String(e.text).includes("历史")), "重放的历史不能进本轮正文");
  assert.ok(events.some((e) => e.type === "init" && e.protocol === "acp"));
  assert.ok(events.some((e) => e.type === "thinking_delta" && e.text === "思考中..."));
  assert.ok(events.some((e) => e.type === "tool_use" && e.name === "run_shell"));

  // 验证 tool_result 只在终态发出，且符合前端 { ok, text } 契约
  const toolResults = events.filter((e) => e.type === "tool_result");
  assert.equal(toolResults.length, 1, "in_progress 不应提前发 tool_result");
  assert.equal(toolResults[0].ok, true);
  assert.equal(toolResults[0].is_error, false);
  assert.ok(toolResults[0].text.includes("hi"));
  assert.ok(toolResults[0].content.includes("hi"));

  assert.ok(events.some((e) => e.type === "text_delta" && e.text === "已完成执行！"));
  assert.ok(events.some((e) => e.type === "usage" && e.contextTokens === 1200 && e.outputTokens === 42));
  assert.ok(events.some((e) => e.type === "run_tokens" && e.out === 42));
  assert.ok(events.some((e) => e.type === "result" && e.stopReason === "end_turn"));

  // 验证本地 jsonl 持久化文件包含 tool_use + tool_result + assistant，且 transcriptItems 可完整还原
  const projDir = path.join(PATHS.projects, String(CFG.workspace).replace(/[^A-Za-z0-9]/g, "-"));
  const jsonlPath = path.join(projDir, "agy-sess-001.jsonl");
  assert.ok(fs.existsSync(jsonlPath), "ACP transcript jsonl should be persisted");
  const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  const restored = lines.flatMap((l) => transcriptItems(l));
  assert.ok(restored.some((x) => x.role === "tool_use" && x.id === "tc-1"));
  assert.ok(restored.some((x) => x.role === "tool_result" && x.id === "tc-1" && x.ok === true && x.text.includes("hi")));
  assert.ok(restored.some((x) => x.role === "assistant" && x.text === "已完成执行！"));
});

test("hachimia ACP 会话常驻保活池：同会话第二轮直接复用进程不重走 initialize", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "hachimia-acp-pool-"));
  const mockBin = makeMockAgy(tmp);
  try {
    const r1 = await runAcpTurn({
      bin: process.execPath,
      args: [mockBin],
      cwd: CFG.workspace,
      env: process.env,
      prompt: "第一轮",
      model: "gemini-4-neon",
      permMode: "bypassPermissions",
      authType: "gemini-api-key",
      apiKey: "pool-key",
      keepAlive: true,
      emit: () => {},
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.reused, false);

    const r2 = await runAcpTurn({
      bin: process.execPath,
      args: [mockBin],
      cwd: CFG.workspace,
      env: process.env,
      prompt: "第二轮",
      sessionId: r1.sessionId,
      model: "gemini-4-neon",
      permMode: "bypassPermissions",
      authType: "gemini-api-key",
      apiKey: "pool-key",
      keepAlive: true,
      emit: () => {},
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.reused, true);
    assert.equal(r2.resultText, "第二轮复用成功 init=1");
  } finally {
    closeAllAcpClients();
  }
});

test("translateAcpUpdate：整条消息、diff 提取、plan 带 sessionId、mode 映射与历史重放守卫", () => {
  const st = { text: "", thinking: "", tools: new Map(), usage: null, sessionId: "s-42" };
  const ev = [];
  const emit = (e) => ev.push(e);
  translateAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想一下" } }, st, emit);
  translateAcpUpdate({ sessionUpdate: "agent_message", content: [{ type: "text", text: "正文来了" }] }, st, emit);
  assert.equal(st.thinking, "想一下");
  assert.equal(st.text, "正文来了");
  assert.deepEqual(ev.map((e) => e.type), ["thinking_delta", "text_delta"]);
  // 已流式收到正文时，同一条整条消息不重复叠加
  translateAcpUpdate({ sessionUpdate: "agent_message", content: { type: "text", text: "正文来了" } }, st, emit);
  assert.equal(st.text, "正文来了");
  // 旧草稿的 summary 字段也认
  translateAcpUpdate({ sessionUpdate: "agent_message_chunk", summary: { type: "text", text: "，续" } }, st, emit);
  assert.equal(st.text, "正文来了，续");
  // 整条思考同理
  translateAcpUpdate({ sessionUpdate: "agent_thought", summary: { type: "text", text: "补想" } }, st, emit);
  assert.equal(st.thinking, "想一下");
  // usage_update 种类照算用量
  translateAcpUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 9, outputTokens: 4 } }, st, emit);
  assert.deepEqual(st.usage, { input_tokens: 9, output_tokens: 4, context_tokens: 9 });
  // plan 必须带 sessionId，前端才会认领渲染
  translateAcpUpdate({ sessionUpdate: "plan", entries: [{ content: "步骤1", status: "in_progress" }] }, st, emit);
  assert.ok(ev.some((e) => e.type === "tasks" && e.sessionId === "s-42" && e.tasks[0].subject === "步骤1"));
  // current_mode_update 映射为前端认识的 perm_mode
  translateAcpUpdate({ sessionUpdate: "current_mode_update", currentModeId: "auto_approve" }, st, emit);
  assert.ok(ev.some((e) => e.type === "perm_mode" && e.mode === "bypassPermissions"));
  // diff 块可读提取
  const diffTxt = acpTextOf({ type: "diff", path: "/a.js", oldText: "a", newText: "b" });
  assert.ok(diffTxt.includes("/a.js") && diffTxt.includes("- a") && diffTxt.includes("+ b"));
  // 已知可忽略的种类不产生事件、不炸
  const before = ev.length;
  translateAcpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "回声" } }, st, emit);
  assert.equal(ev.length, before);
  // prompt 未发出前的事件（agy 重放的历史）一律不进本轮，且记录 toolCallId 供后续去重
  const st2 = { text: "", thinking: "", tools: new Map(), knownToolIds: new Set(["old-tc-from-jsonl"]), usage: null, promptSent: false, permMode: "bypassPermissions" };
  const ev2 = [];
  translateAcpUpdate({ sessionUpdate: "agent_message", content: { type: "text", text: "【历史】" } }, st2, (e) => ev2.push(e));
  translateAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "旧思考" } }, st2, (e) => ev2.push(e));
  translateAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "old-tc-replayed", title: "run_shell" }, st2, (e) => ev2.push(e));
  assert.equal(st2.text, "");
  assert.equal(st2.thinking, "");
  assert.equal(ev2.length, 0);
  assert.ok(st2.knownToolIds.has("old-tc-replayed"));

  // prompt 发出后若仍有历史 toolCallId 泄漏进来，应直接去重丢弃；新工具正常放行
  st2.promptSent = true;
  translateAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "old-tc-from-jsonl", title: "old" }, st2, (e) => ev2.push(e));
  translateAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "old-tc-replayed", status: "completed", content: [{ type: "text", text: "old" }] }, st2, (e) => ev2.push(e));
  assert.equal(ev2.length, 0, "已持久化和重放过的旧工具 ID 不应重复弹窗");
  // bypassPermissions 状态下服务端回传 accept-edits 不应降级前端显示模式
  translateAcpUpdate({ sessionUpdate: "current_mode_update", currentModeId: "accept-edits" }, st2, (e) => ev2.push(e));
  assert.equal(ev2.length, 0, "bypassPermissions 不应被 accept-edits 降级");
  translateAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "fresh-tc-1", title: "read_file" }, st2, (e) => ev2.push(e));
  assert.equal(ev2.length, 1);
  assert.equal(ev2[0].type, "tool_use");
  assert.equal(ev2[0].id, "fresh-tc-1");
});

test("hachimia ACP 优先走 session/resume（无历史重放）、适配 accept-edits/thought_level 与 promptRes.usage", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "hachimia-acp-resume-"));
  const mockBin = path.join(tmp, "mock-agy-resume");
  fs.writeFileSync(mockBin, `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const seen = [];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  const msg = JSON.parse(t);
  seen.push({ method: msg.method, params: msg.params });
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {} } },
        authMethods: [{ id: "oauth-personal" }],
      },
    });
  }
  if (msg.method === "session/resume") {
    return send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        sessionId: msg.params.sessionId,
        models: { currentModelId: "gemini-4-neon-high", availableModels: [{ modelId: "gemini-4-neon-high" }] },
        modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "accept-edits" }, { id: "plan" }] },
        configOptions: [
          { id: "model", options: [{ value: "gemini-4-neon" }, { value: "gemini-3.8-flash" }] },
          { id: "thought_level", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
        ],
      },
    });
  }
  if (msg.method === "session/load") {
    return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "should not call session/load when resume is supported" } });
  }
  if (msg.method === "session/set_config_option" || msg.method === "session/set_mode") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/prompt") {
    const modeCall = seen.find((x) => x.method === "session/set_mode");
    const cfgCalls = seen.filter((x) => x.method === "session/set_config_option");
    const summary = [
      "mode=" + (modeCall?.params?.modeId || "none"),
      "model=" + (cfgCalls.find((x) => x.params?.configId === "model")?.params?.value || "none"),
      "effort=" + (cfgCalls.find((x) => x.params?.configId === "thought_level")?.params?.value || "none"),
    ].join(",");
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: summary } } } });
    return send({
      jsonrpc: "2.0", id: msg.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 2000, cachedReadTokens: 8000, outputTokens: 55, totalTokens: 10055 } },
    });
  }
});
`, { mode: 0o755 });

  const events = [];
  const res = await runAcpTurn({
    bin: process.execPath,
    args: [mockBin],
    cwd: CFG.workspace,
    env: process.env,
    prompt: "继续",
    sessionId: "sess-existing-999",
    model: "gemini-4-neon",
    effort: "xhigh",
    permMode: "bypassPermissions",
    keepAlive: false,
    emit: (ev) => events.push(ev),
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.resultText, "mode=accept-edits,model=gemini-4-neon,effort=xhigh");
  assert.equal(res.usage?.context_tokens, 10000);
  assert.equal(res.usage?.output_tokens, 55);
  assert.ok(events.some((e) => e.type === "usage" && e.contextTokens === 10000 && e.outputTokens === 55));
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
