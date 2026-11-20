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
// 每次调用生成唯一会话 id：acp.mjs 落盘是 appendFileSync 永不截断，
// 同池的 fix-b-acp-turn mock 用固定 "agy-sess-001" 先写 6 行；
// 若本用例也用固定 id，断言 lines.length === 4 会读到 6+4=10 行而挂。
// 唯一 id 让本用例的 jsonl 文件天然私有，断言一字不动。
function makeMockAgy(dir) {
  const sid = "agy-sess-e2e-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
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
      result: { sessionId: "${sid}", models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }] } },
    });
    // 官方 1.5.13 恢复会话时会先重放历史消息：这些不算本轮正文
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "${sid}", update: { sessionUpdate: "agent_message", messageId: "msg-old-1", content: { type: "text", text: "【历史】之前聊过的东西" } } } });
    return;
  }
  if (msg.method === "session/set_config_option" || msg.method === "session/set_mode") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") {
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
  return { script, sessionId: sid };
}

test("hachimia ACP 端到端流程：握手、认证、工具 ok/text 契约、权限回调与含 tool_result 的 jsonl 落盘", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "hachimia-acp-"));
  const { script: mockBin, sessionId: e2eSid } = makeMockAgy(tmp);
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
  assert.equal(res.sessionId, e2eSid);
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
  const jsonlPath = path.join(projDir, e2eSid + ".jsonl");
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
  const mockBin = makeMockAgy(tmp).script;
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
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") {
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
  // C16：全程无 usage_update 时，promptRes.usage 的整轮累计值（2000+8000）不得冒充单步
  // context_tokens——留空，只保留累计的 input/output 统计。
  assert.equal(res.usage?.context_tokens, undefined, "整轮累计值不得冒充单步上下文");
  assert.equal(res.usage?.input_tokens, 2000);
  assert.equal(res.usage?.cache_read_input_tokens, 8000);
  assert.equal(res.usage?.output_tokens, 55);
  assert.ok(!events.some((e) => e.type === "usage" && e.contextTokens === 10000), "不得把整轮累计和推送到上下文条");
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

test("hachimia ACP：usage_update 单步上下文不被 promptRes 累计用量覆盖，且历史重载读真实单步值", async () => {
  const { readSessionPage, latestContextTokens } = await import("../gw/transcript.mjs");
  const { acpSessionFile } = await import("../gw/acp.mjs");
  const tmp = fs.mkdtempSync(path.join(CFG.home, "hachimia-acp-ctx-"));
  const mockBin = path.join(tmp, "mock-agy-ctx");
  fs.writeFileSync(mockBin, `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  const msg = JSON.parse(t);
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (msg.method === "session/new") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-ctx-step-1" } });
  }
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "usage_update", used: 0, size: 1048576 } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "usage_update", used: 7810, size: 1048576 } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "usage_update", used: 8199, size: 1048576 } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    // promptRes.usage 为整轮 3 次 LLM 调用的累计和（23757），远大于真实单步上下文（8199）
    return send({
      jsonrpc: "2.0", id: msg.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 12283, cachedReadTokens: 11474, outputTokens: 209, totalTokens: 23966 } },
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
    prompt: "跑两个命令",
    keepAlive: false,
    emit: (ev) => events.push(ev),
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.usage?.context_tokens, 8199, "终态累计 usage 不应覆盖单步真实上下文");
  assert.equal(res.usage?.context_window, 1048576);
  assert.equal(res.usage?.output_tokens, 209);
  assert.ok(events.some((e) => e.type === "usage" && e.contextTokens === 8199 && e.contextWindow === 1048576));
  assert.ok(!events.some((e) => e.type === "usage" && e.contextTokens === 23757), "不应把整轮累计和推送到上下文条");

  const file = acpSessionFile(CFG.workspace, "sess-ctx-step-1");
  const page = await readSessionPage(file);
  assert.equal(page.contextTokens, 8199, "重开会话分页读到的上下文应为单步真实值而非累计和");
  assert.equal(await latestContextTokens(file), 8199, "latestContextTokens 应返回单步真实值");
  assert.equal(res.toolCount, 0);
  // 持久化记录应带 message.id，且旧版无 message.id 的脏累计行（>1M 且等于 sum）不应捅穿上下文条
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === "assistant" && typeof l.message?.id === "string" && l.message.id.startsWith("acp-")));
  fs.appendFileSync(file, JSON.stringify({
    type: "assistant", uuid: "dirty-legacy-1", sessionId: "sess-ctx-step-1", cwd: CFG.workspace, timestamp: new Date().toISOString(),
    message: { role: "assistant", model: "gemini-4-neon", content: [{ type: "text", text: "old" }], usage: { input_tokens: 403631, cache_read_input_tokens: 1947960, output_tokens: 1362, context_tokens: 2351591 } },
  }) + "\n");
  assert.equal(await latestContextTokens(file), 8199, "旧版多步累计脏行应被跳过，回落到上一条真实单步值");
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

test("hachimia ACP：斜杠命令同步、压缩事件、子代理联络卡、后台任务与空闲唤醒推送", async () => {
  const { buildCapabilities } = await import("../gw/caps.mjs");
  const { expandCustomCommand } = await import("../gw/commands.mjs");
  const { acpSessionFile, closeAcpSession, getAcpPoolBg, stopAcpBgTask } = await import("../gw/acp.mjs");
  const { onPublish } = await import("../gw/bus.mjs");
  const published = [];
  const offBus = onPublish((ev) => published.push(ev));

  // 1. 测试常用指令在 ACP 下的 $ARGUMENTS / $1 展开
  const cmdDir = path.join(CFG.home, ".claude", "commands");
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.writeFileSync(path.join(cmdDir, "shipcheck.md"), "---\ndescription: 发布前检查\n---\n检查 $1 分支：$ARGUMENTS\n");
  const exp = expandCustomCommand("/shipcheck main 所有测试", CFG.workspace);
  assert.equal(exp.expanded, true);
  assert.equal(exp.name, "shipcheck");
  assert.equal(exp.text, "检查 main 分支：main 所有测试");

  // 2. 启动带斜杠命令、tier、子代理、后台命令、压缩与空闲异步回报的 mock agy acp
  const tmp = fs.mkdtempSync(path.join(CFG.home, "hachimia-acp-full-"));
  const mockBin = path.join(tmp, "mock-agy-full");
  fs.writeFileSync(mockBin, `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  const msg = JSON.parse(t);
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, additionalDirectories: {} } } } });
  }
  if (msg.method === "session/new") {
    const sid = "sess-full-wiring-1";
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid, _meta: { antigravity: { tier: { name: "Google AI Ultra", id: "g1-ultra-tier" } } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "available_commands_update", availableCommands: [
      { name: "compact", description: "Compact history" },
      { name: "grill-me", description: "Interview to align on a plan" },
      { name: "run-workflow", description: "Run Python workflow" },
    ] } } });
    return;
  }
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    // 压缩事件
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "compaction_update", status: "started" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "compaction_update", status: "completed", preTokens: 50000, postTokens: 12000 } } });
    // 子代理派生 + 联络
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "sub-1", title: "invoke_subagent", rawInput: { Role: "Code Reviewer", TypeName: "research", Prompt: "check" }, status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "sub-1", status: "completed", rawOutput: "Launched subagent conversationId=11111111-2222-3333-4444-555555555555 running in background" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "msg-1", title: "send_message", rawInput: { Recipient: "11111111-2222-3333-4444-555555555555", Message: "focus on tests" }, status: "completed", rawOutput: "sent" } } });
    // 后台命令
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "cmd-1", title: "run_command", rawInput: { CommandLine: "npm run dev", toolSummary: "Dev server", IsDaemon: true }, status: "completed", rawOutput: "Command running in the background TaskId=bg-srv-1" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已启动子代理和后台服务" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    // 120ms 后（主回合已结束、进程在 ACP_POOL 空闲）主动推一条后台子代理回报
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "后台子代理审查完毕：全部通过" } } } });
    }, 120);
  }
});
`, { mode: 0o755 });

  const events = [];
  try {
    const res = await runAcpTurn({
      bin: process.execPath,
      args: [mockBin],
      cwd: CFG.workspace,
      env: process.env,
      prompt: "帮我审查并起服务",
      keepAlive: true,
      emit: (ev) => events.push(ev),
    });
    assert.equal(res.ok, true, res.error);
    // 校验压缩事件
    assert.ok(events.some((e) => e.type === "compacting"), "应发射 compacting");
    assert.ok(events.some((e) => e.type === "compacted" && e.pre === 50000 && e.post === 12000), "应发射 compacted");
    // 校验子代理联络卡事件
    assert.ok(events.some((e) => e.type === "ag" && e.k === "spawn" && e.id === "sub-1" && e.name === "Code Reviewer"), "应派生子代理卡");
    assert.ok(events.some((e) => e.type === "ag" && e.k === "msg" && e.to === "sub-1"), "send_message 应按 conversationId 映射回子代理 ID");
    assert.ok(events.some((e) => e.type === "ag" && e.k === "msg_ok" && e.ok === true));
    // 校验能力清单同步（带版本、tier、真 agy 命令）
    const caps = buildCapabilities();
    assert.equal(caps.version, "1.5.13");
    assert.equal(caps.tier, "Google AI Ultra");
    assert.ok(caps.slashCommands.some((c) => c.name === "grill-me"), "应包含 agy 原生 /grill-me");
    assert.ok(caps.slashCommands.some((c) => c.name === "run-workflow" && c.desc), "应保留命令 description");
    // 校验后台任务已登记进常驻池
    const bg = getAcpPoolBg("sess-full-wiring-1");
    assert.ok(bg.some((x) => x.id === "bg-srv-1" && x.type === "daemon"), "后台 daemon 应登记在池中");

    // 等待空闲唤醒回报推送 + 防抖落盘（120ms + 1500ms 缓冲）
    await new Promise((r) => setTimeout(r, 1950));
    const busBgStart = published.some((e) => e.type === "run_start" && e.sessionId === "sess-full-wiring-1" && e.auto === "bg");
    const busBgDelta = published.some((e) => e.type === "text_delta" && e.sessionId === "sess-full-wiring-1" && e.text.includes("审查完毕"));
    const busBgEnd = published.some((e) => e.type === "run_end" && e.sessionId === "sess-full-wiring-1" && e.resultText?.includes("审查完毕"));
    assert.ok(busBgStart, "空闲后台回报应广播 run_start(auto=bg)");
    assert.ok(busBgDelta, "空闲后台回报应流式广播 text_delta");
    assert.ok(busBgEnd, "空闲后台回报应防抖收尾广播 run_end");
    const jsonl = fs.readFileSync(acpSessionFile(CFG.workspace, "sess-full-wiring-1"), "utf8");
    assert.ok(jsonl.includes("后台子代理审查完毕：全部通过"), "空闲后台回报应持久化到 jsonl");

    // 停止常驻后台任务并回收池中进程
    assert.equal(stopAcpBgTask("sess-full-wiring-1", "bg-srv-1"), true);
    assert.equal(getAcpPoolBg("sess-full-wiring-1").length, 0);
  } finally {
    offBus();
    closeAcpSession("sess-full-wiring-1");
  }
});

test("providers：自定义 gemini-api-key 认证与纯 Antigravity 模式过滤 Claude 预设", async () => {
  const { PATHS } = await import("../gw/config.mjs");
  const { upsertProvider, providerById, isProviderVisible } = await import("../gw/providers.mjs");
  const r = upsertProvider(null, {
    label: "自建 Gemini",
    baseUrl: "https://proxy.example.com",
    authStyle: "gemini-api-key",
    defaultModel: "gemini-3.8-flash",
    apiKey: "AIzaFakeKey1234567890",
  });
  assert.equal(r.ok, true);
  const saved = providerById(r.id);
  assert.equal(saved.authStyle, "gemini-api-key");
  assert.equal(saved.modelsAuth, "x-goog-api-key");

  // 模拟纯 Antigravity 模式（有 agy、无 claude）：应隐藏 anthropic / deepseek 等无 Key 旧预设，保留 antigravity 与自定义接口
  const fakeAgy = path.join(CFG.home, "fake-agy-bin");
  fs.writeFileSync(fakeAgy, "#!/bin/sh\n", { mode: 0o755 });
  const prevAgy = PATHS.agy, prevClaude = PATHS.claude;
  PATHS.agy = fakeAgy;
  PATHS.claude = path.join(CFG.home, "nonexistent-claude");
  try {
    assert.equal(isProviderVisible("antigravity", providerById("antigravity")), true);
    assert.equal(isProviderVisible("gemini-key", providerById("gemini-key")), true);
    assert.equal(isProviderVisible(r.id, saved), true);
    assert.equal(isProviderVisible("anthropic", providerById("anthropic")), false);
    assert.equal(isProviderVisible("anthropic-key", providerById("anthropic-key")), false);
    assert.equal(isProviderVisible("deepseek", providerById("deepseek")), false);
  } finally {
    PATHS.agy = prevAgy;
    PATHS.claude = prevClaude;
  }
});

test("agy 接口协议：parseAgyModelsOutput 家族归并、customModelsConfig 同步、ADC 环境与 Gemini 清单猜测", async () => {
  const { parseAgyModelsOutput, guessModelsUrls, effortLevelsOf } = await import("../gw/models.mjs");
  const parsed = parseAgyModelsOutput(`
ERROR: logging before google.Init: I1120 14:36:27.000 1 server_zerog.go:46] Initialized Android local timezone
gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
gemini-4-neon-low\tGemini 4 Neon (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`);
  assert.equal(parsed.length, 3);
  const neon = parsed.find((m) => m.id === "gemini-4-neon");
  assert.deepEqual(neon.effort.supported_levels, ["low", "high", "xhigh"]);
  assert.equal(neon.effort.default_level, "high");
  const opus = parsed.find((m) => m.id === "claude-opus-5-5");
  assert.deepEqual(opus.effort.supported_levels, ["medium", "high"]);
  assert.ok(parsed.some((m) => m.id === "gpt-oss-120b-medium"));
  assert.deepEqual(effortLevelsOf({}, { group: "antigravity", nativeModels: true }), ["low", "medium", "high", "xhigh"]);

  const urls = guessModelsUrls("https://proxy.example.com/v1beta", { gemini: true });
  assert.equal(urls[0], "https://proxy.example.com/v1beta/models");

  // 自定义 Gemini 代理应把模型列表同步到 customModelsConfig，并支持 ADC 模式注入 AGY_ADC_AUTH
  const settingsFile = path.join(CFG.home, ".gemini", "antigravity-cli", "settings.json");
  const customProv = {
    id: "custom-1", custom: true, login: false, authStyle: "gemini-api-key",
    baseUrl: "https://my-gemini-proxy.example.com", defaultModel: "gemini-4-neon",
    extraModels: [{ id: "gemini-3.8-flash" }], apiKey: "AIzaCustomKey999",
  };
  const envC = agyEnv({ provider: customProv });
  assert.equal(envC.GEMINI_API_KEY, "AIzaCustomKey999");
  assert.equal(envC.GOOGLE_GEMINI_BASE_URL, "https://my-gemini-proxy.example.com");
  const stC = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(stC.modelProvider, "gemini");
  assert.deepEqual(stC.customModelsConfig.customModels, [
    { modelName: "gemini-api://my-gemini-proxy.example.com/models/gemini-4-neon", label: "gemini-4-neon" },
    { modelName: "gemini-api://my-gemini-proxy.example.com/models/gemini-3.8-flash", label: "gemini-3.8-flash" },
  ]);

  const adcProv = { id: "antigravity-adc", group: "antigravity", login: true, authType: "agent-platform", authStyle: "adc" };
  const envAdc = agyEnv({ provider: adcProv });
  assert.equal(envAdc.AGY_ADC_AUTH, "true");
  assert.equal(envAdc.GEMINI_API_KEY, undefined);
  const stAdc = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal("modelProvider" in stAdc, false);
  assert.equal("customModelsConfig" in stAdc, false);
});

test("hachimia ACP：/compact 无正文无 compaction_update 时补发 compacting/compacted 并记录前后 token", async () => {
  const { closeAcpSession, acpSessionFile } = await import("../gw/acp.mjs");
  const tmp = fs.mkdtempSync(path.join(CFG.home, "hachimia-acp-cmp-"));
  const mockBin = path.join(tmp, "mock-agy-cmp");
  fs.writeFileSync(mockBin, `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let n = 0;
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  const msg = JSON.parse(t);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-cmp-1" } });
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/prompt") {
    n++;
    if (n === 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-cmp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-cmp-1", update: { sessionUpdate: "usage_update", used: 180000, size: 1048576 } } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
    // 真实 agy acp 1.5.13 行为：/compact 只发 usage_update + end_turn，无正文无 compaction_update
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-cmp-1", update: { sessionUpdate: "usage_update", used: 22000, size: 1048576 } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 20000, outputTokens: 400, totalTokens: 22000 } } });
  }
});
`, { mode: 0o755 });

  try {
    const r1 = await runAcpTurn({ bin: process.execPath, args: [mockBin], cwd: CFG.workspace, env: process.env, prompt: "hello", keepAlive: true, emit: () => {} });
    assert.equal(r1.ok, true);
    const evs = [];
    const r2 = await runAcpTurn({ bin: process.execPath, args: [mockBin], cwd: CFG.workspace, env: process.env, prompt: "/compact", sessionId: "sess-cmp-1", keepAlive: true, emit: (e) => evs.push(e) });
    assert.equal(r2.ok, true);
    assert.ok(evs.some((e) => e.type === "compacting"), "/compact 应发射 compacting");
    assert.ok(evs.some((e) => e.type === "compacted" && e.pre === 180000 && e.post === 22000), "/compact 应补发 compacted 并带压缩前后 token");
    const raw = fs.readFileSync(acpSessionFile(CFG.workspace, "sess-cmp-1"), "utf8");
    assert.ok(raw.includes("上下文已压缩：180,000 → 22,000 tokens"), "压缩摘要应持久化到 jsonl 避免空白气泡");
  } finally {
    closeAcpSession("sess-cmp-1");
  }
});
