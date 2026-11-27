// 迁移收尾深修 P1（MIG-1/2/3/6/9/25/28/34）：先写红、再修绿。密钥、模型名全是 fixture。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG, PATHS } from "../gw/config.mjs";
import { providerById, providerBrief, hasAcpKeyChannel, isProviderUsable, isAgyOnlyMode } from "../gw/providers.mjs";
import { learnWindow, withWindows, defaultAcpCompactLine, compactLineOf, effectiveCompactLines } from "../gw/models.mjs";
import { feedAcpWindow, acpAutoCompactLine } from "../gw/run.mjs";
import { runAcpTurn, closeAllAcpClients, translateAcpUpdate } from "../gw/acp.mjs";
import { readAgentIndex } from "../gw/agents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const agySettingsFile = () => path.join(CFG.home, ".gemini", "antigravity-cli", "settings.json");
const settingsBefore = (() => { try { return fs.readFileSync(agySettingsFile(), "utf8"); } catch { return null; } })();
const origAgyPath = PATHS.agy, origClaudePath = PATHS.claude;
after(async () => {
  try { await closeAllAcpClients(); } catch {}
  PATHS.agy = origAgyPath; PATHS.claude = origClaudePath;
  try {
    if (settingsBefore === null) fs.unlinkSync(agySettingsFile());
    else fs.writeFileSync(agySettingsFile(), settingsBefore);
  } catch {}
});

// ── MIG-1：预置 fallback 的 1M 窗口改为未知（0） ──
test("MIG-1：antigravity 系预置 fallback 窗口全为 0（未知），不再写死 1M", () => {
  for (const id of ["antigravity", "antigravity-enterprise", "antigravity-adc", "gemini-key", "gemini-custom"]) {
    const p = providerById(id);
    assert.ok(p && Array.isArray(p.fallbackModels) && p.fallbackModels.length > 0, id + " 应有 fallbackModels");
    for (const m of p.fallbackModels) {
      assert.equal(m.context_window, 0, `${id}/${m.id} 的窗口应为未知 0，实际 ${m.context_window}`);
    }
  }
});

test("MIG-1：离线回落时上下文条不再按 1M 的八成算压缩线（窗口未知 → 无默认线）", () => {
  assert.equal(defaultAcpCompactLine(0, providerById("antigravity")), null);
  assert.equal(acpAutoCompactLine(0, providerById("antigravity")), null);
  // 学到的 200k 能纠正回落清单（withWindows 只在窗口为 0 时补）
  const modelId = "mig1-claude-opus-5-5";
  learnWindow({ modelUsage: { [modelId]: { contextWindow: 200000, maxOutputTokens: 0 } } }, providerById("antigravity"));
  const got = withWindows([{ id: modelId, context_window: 0 }]);
  assert.equal(got[0].context_window, 200000);
  assert.equal(defaultAcpCompactLine(200000, providerById("antigravity")), 160000, "学到 200k 后默认线应为 160k 而非 838k");
});

// ── MIG-2：learnWindow 对 ACP 路径可学；feedAcpWindow 返回是否真写入 ──
test("MIG-2：gemini-custom 与 protocol:\"gemini\" 厂商也能学窗口", () => {
  const gc = "mig2-gemini-custom-model";
  assert.equal(feedAcpWindow({ model: gc, contextWindow: 128000, provider: providerById("gemini-custom") }), true);
  assert.equal(withWindows([{ id: gc, context_window: 0 }])[0].context_window, 128000);
  const pg = "mig2-protocol-gemini-model";
  const protoGemini = { id: "custom-mig2", custom: true, login: false, authStyle: "bearer", protocol: "gemini", baseUrl: "https://proxy.example.com", apiKey: "<redacted>" };
  assert.equal(feedAcpWindow({ model: pg, contextWindow: 262144, provider: protoGemini }), true);
  assert.equal(withWindows([{ id: pg, context_window: 0 }])[0].context_window, 262144);
});

test("MIG-2：原生厂商仍可学；无 ACP 通道的纯 bearer 厂商学不到且 feed 返回 false", () => {
  const nat = "mig2-native-model";
  assert.equal(feedAcpWindow({ model: nat, contextWindow: 200000, provider: providerById("antigravity") }), true);
  const bearer = { id: "custom-mig2-b", custom: true, login: false, authStyle: "bearer", baseUrl: "https://proxy.example.com", apiKey: "<redacted>" };
  assert.equal(feedAcpWindow({ model: "mig2-bearer-model", contextWindow: 200000, provider: bearer }), false);
  assert.equal(withWindows([{ id: "mig2-bearer-model", context_window: 0 }])[0].context_window, 0);
  assert.equal(learnWindow({ modelUsage: { "mig2-bearer-model": { contextWindow: 200000, maxOutputTokens: 0 } } }, bearer), false);
});

// ── MIG-3：/api/models 与 /autocompact 显示侧用 ACP 默认线 ──
test("MIG-3：ACP 下原生厂商也有默认压缩线（200k→160k）；Claude 口径不变", () => {
  const native = providerById("antigravity");
  const lines = effectiveCompactLines(200000, native);
  assert.equal(lines.compactLine, 160000, "ACP 原生 200k 应显示 160k 默认线，实际 " + lines.compactLine);
  assert.equal(lines.compactDefault, 160000);
  assert.equal(lines.acpMode, true);
  const third = { id: "custom-mig3", custom: true, login: false, authStyle: "bearer", protocol: "gemini", baseUrl: "https://proxy.example.com" };
  assert.equal(effectiveCompactLines(200000, third).compactLine, 160000);
  assert.equal(effectiveCompactLines(0, third).compactLine, null, "ACP 窗口未知时无默认线");
});

test("MIG-3：ACP 下用户显式设的线不按 Claude 的 200k 兜底截断", () => {
  const third = { id: "custom-mig3b", custom: true, login: false, authStyle: "bearer", protocol: "gemini", baseUrl: "https://proxy.example.com" };
  assert.equal(compactLineOf(500000, 0, third, true), 500000, "ACP 未知窗口 + 设 500k 应显示 500k");
  assert.equal(compactLineOf(500000, 0, third), 200000, "Claude 口径仍按 200k 兜底");
});

test("MIG-3 源码：/api/models 回 ACP 模式，前端滑块按 acpMode 画未知窗口", () => {
  const gw = fs.readFileSync(path.join(ROOT, "gateway", "gw", "models.mjs"), "utf8");
  assert.match(gw, /acpMode/);
  assert.match(gw, /effectiveCompactLines/);
  const fe = fs.readFileSync(path.join(ROOT, "gateway", "web", "app", "12-model-caps.js"), "utf8");
  assert.match(fe, /acPaint\(Number\(r\.contextWindow\) \|\| 0, r\.autoCompactWindow, r\.compactDefault, r\.acpMode\)/);
  assert.match(fe, /ACP 下无默认压缩线/);
});

// ── MIG-6：thought_level 不得静默跳过 ──
function makeMockAgyEffort(dir, mode) {
  const sid = "agy-sess-mig6-" + mode + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const countsFile = path.join(dir, "counts-" + mode + ".txt");
  fs.writeFileSync(countsFile, "");
  const script = path.join(dir, "mock-agy-" + mode);
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  const msg = JSON.parse(t);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "gemini-api-key" }] } });
  if (msg.method === "authenticate") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "${sid}", models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }] }, configOptions: [{ id: "model", options: [{ value: "gemini-4-neon" }] }, { id: "thought_level", options: [{ value: "low" }, { value: "high" }] }] } });
  if (msg.method === "session/set_config_option") {
    if (msg.params.configId === "thought_level") {
      fs.appendFileSync("${countsFile}", msg.params.value + "\\n");
      if ("${mode}" === "reject") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unsupported thought_level" } });
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
  if (msg.method === "session/set_mode") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "${sid}", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`, { mode: 0o755 });
  const thoughtCalls = () => fs.readFileSync(countsFile, "utf8").trim().split("\n").filter(Boolean);
  return { script, sessionId: sid, thoughtCalls };
}
const runEffortTurn = async (mock, effort, sessionId, keepAlive) => {
  const events = [];
  const res = await runAcpTurn({
    bin: process.execPath, args: [mock.script], cwd: CFG.workspace, env: process.env,
    prompt: "hi", model: "gemini-4-neon", effort, permMode: "default",
    authType: "gemini-api-key", apiKey: "mig6-key", sessionId: sessionId || null,
    keepAlive, emit: (e) => events.push(e),
  });
  return { res, events };
};

test("MIG-6：thought_level 不在 options 里 → 不发 set_config_option 且发 note 明示按默认跑", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "mig6-unsup-"));
  const mock = makeMockAgyEffort(tmp, "unsupported");
  const { res, events } = await runEffortTurn(mock, "max", null, false);
  assert.equal(res.ok, true, "档位不支持也不应把整轮打断：按默认跑完");
  assert.deepEqual(mock.thoughtCalls(), [], "不支持的档位不得发 set_config_option");
  const note = events.find((e) => e.type === "note" && /不支持思考强度/.test(e.text || ""));
  assert.ok(note, "应发 note 明示不支持此档位、已按默认跑，实际事件：" + JSON.stringify(events.map((e) => [e.type, e.text || e.key || ""])));
  assert.match(note.text, /max/);
});

test("MIG-6：set_config_option 被拒 → 发 note 且池里不记为已生效（下轮重发）", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "mig6-reject-"));
  const mock = makeMockAgyEffort(tmp, "reject");
  const first = await runEffortTurn(mock, "high", null, true);
  assert.equal(first.res.ok, true);
  assert.deepEqual(mock.thoughtCalls(), ["high"]);
  assert.ok(first.events.some((e) => e.type === "note" && /被 agent 拒绝/.test(e.text || "")), "被拒应发 note，实际：" + JSON.stringify(first.events.map((e) => [e.type, e.text || ""])));
  const second = await runEffortTurn(mock, "high", first.res.sessionId, true);
  assert.equal(second.res.ok, true);
  assert.deepEqual(mock.thoughtCalls(), ["high", "high"], "被拒的档位不得记成已生效：下轮应重发");
  assert.ok(second.events.some((e) => e.type === "note" && /被 agent 拒绝/.test(e.text || "")));
});

test("MIG-6：档位生效时只记一次（下轮复用不再重发）", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "mig6-ok-"));
  const mock = makeMockAgyEffort(tmp, "ok");
  const first = await runEffortTurn(mock, "high", null, true);
  assert.equal(first.res.ok, true);
  assert.deepEqual(mock.thoughtCalls(), ["high"]);
  assert.ok(!first.events.some((e) => e.type === "note" && /思考强度/.test(e.text || "")), "生效时不应发不支持/被拒的 note");
  const second = await runEffortTurn(mock, "high", first.res.sessionId, true);
  assert.equal(second.res.ok, true);
  assert.deepEqual(mock.thoughtCalls(), ["high"], "已生效的档位下轮复用时不应重发");
});

// ── MIG-9：无 key 通道的第三方厂商在选单/发消息前标注并拦截 ──
test("MIG-9：hasAcpKeyChannel 只认 agy 真正有的通道", () => {
  assert.equal(hasAcpKeyChannel({ id: "deepseek", group: "third", authStyle: "bearer", apiKey: "<redacted>" }), false, "DeepSeek bearer 在 agy 下无通道");
  assert.equal(hasAcpKeyChannel({ id: "custom-9", custom: true, authStyle: "bearer", apiKey: "<redacted>" }), false, "无声明的自定义 bearer 无通道");
  assert.equal(hasAcpKeyChannel({ id: "custom-9g", custom: true, authStyle: "bearer", protocol: "gemini", apiKey: "<redacted>" }), true, "protocol:gemini 走 Gemini 通道");
  assert.equal(hasAcpKeyChannel({ id: "gemini-key", group: "antigravity", authStyle: "gemini-api-key", apiKey: "<redacted>" }), true);
  assert.equal(hasAcpKeyChannel({ id: "antigravity", group: "antigravity", login: true, authType: "oauth-personal" }), true, "订阅登录走 OAuth");
  assert.equal(hasAcpKeyChannel({ id: "antigravity-adc", group: "antigravity", login: true, authStyle: "adc" }), true, "ADC 走 AGY_ADC_AUTH");
  assert.equal(hasAcpKeyChannel({ id: "anthropic-key", group: "claude", authStyle: "x-api-key", apiKey: "<redacted>" }), false, "Claude API Key 在 agy 下无通道");
});

test("MIG-9：providerBrief 给无通道厂商打 noAcpKeyChannel 标记；前端选单据此标注", async () => {
  const { PROVIDERS_CFG } = await import("../gw/providers.mjs");
  const prevKey = PROVIDERS_CFG.providers.deepseek.apiKey;
  PROVIDERS_CFG.providers.deepseek.apiKey = "sk-fixture-mig9";
  try {
    const brief = providerBrief();
    const ds = brief.find((p) => p.id === "deepseek");
    assert.ok(ds, "配置了 Key 的选单应仍列出 DeepSeek");
    assert.equal(ds.noAcpKeyChannel, true, "DeepSeek 应标无通道");
    const ag = brief.find((p) => p.id === "antigravity");
    assert.equal(ag.noAcpKeyChannel, false);
  } finally {
    PROVIDERS_CFG.providers.deepseek.apiKey = prevKey;
  }
  const fe = fs.readFileSync(path.join(ROOT, "gateway", "web", "app", "12-model-caps.js"), "utf8");
  assert.match(fe, /noAcpKeyChannel/, "前端选单应读 noAcpKeyChannel 标注");
  assert.match(fe, /在 Antigravity 下暂不支持/);
});

test("MIG-9 源码：startRun 在 ACP 分支发消息前拦截无通道厂商，给出 protocol:gemini 指引", () => {
  const run = fs.readFileSync(path.join(ROOT, "gateway", "gw", "run.mjs"), "utf8");
  assert.match(run, /hasAcpKeyChannel/);
  assert.match(run, /protocol:\\"gemini\\"/, "拦截文案应给出声明 protocol:\"gemini\" 的指引");
  assert.match(run, /暂不支持/);
});

// ── MIG-25/F-1：ACP send_message 的 msg/msg_ok 落盘 ──
test("MIG-25：ACP 子代理 send_message 的 msg 与 msg_ok 写进联络簿（断线重连后可查）", () => {
  const cwd = fs.mkdtempSync(path.join(CFG.workspace, "mig25-"));
  const sid = "sess-mig25-1";
  const evs = [];
  const st = { sessionId: sid, cwd, text: "", thinking: "", tools: new Map(), knownToolIds: new Set(), usage: null, promptSent: true, permMode: "default", onBgAdd: () => {}, onBgRemove: () => {}, onCommands: () => {} };
  const emit = (e) => evs.push(e);
  translateAcpUpdate({ update: { sessionUpdate: "tool_call", toolCallId: "tc-msg-1", title: "send_message", rawInput: { Recipient: "sub-1", Message: "请先查一下库存" }, status: "in_progress" } }, st, emit);
  translateAcpUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "tc-msg-1", status: "completed", rawOutput: "ok" } }, st, emit);
  assert.ok(evs.some((e) => e.type === "ag" && e.k === "msg"), "仍应发瞬时 ag msg 事件");
  assert.ok(evs.some((e) => e.type === "ag" && e.k === "msg_ok"), "仍应发瞬时 ag msg_ok 事件");
  const recs = readAgentIndex(cwd, sid);
  assert.ok(recs.some((r) => r.k === "msg" && r.mid === "tc-msg-1"), "联络簿应有 msg 记录，实际：" + JSON.stringify(recs));
  assert.ok(recs.some((r) => r.k === "msg_ok" && r.mid === "tc-msg-1" && r.ok === true), "联络簿应有 msg_ok 记录");
});

test("MIG-25：长消息全文存 msgs/*.md，联络簿只记 why 与文件路径", () => {
  const cwd = fs.mkdtempSync(path.join(CFG.workspace, "mig25-long-"));
  const sid = "sess-mig25-long";
  const evs = [];
  const st = { sessionId: sid, cwd, text: "", thinking: "", tools: new Map(), knownToolIds: new Set(), usage: null, promptSent: true, permMode: "default", onBgAdd: () => {}, onBgRemove: () => {}, onCommands: () => {} };
  const longBody = "长消息正文：".repeat(60);
  translateAcpUpdate({ update: { sessionUpdate: "tool_call", toolCallId: "tc-msg-long", title: "send_message", rawInput: { Recipient: "sub-1", Message: longBody }, status: "in_progress" } }, st, () => evs.push(1));
  const recs = readAgentIndex(cwd, sid);
  const msg = recs.find((r) => r.k === "msg" && r.mid === "tc-msg-long");
  assert.ok(msg, "长消息也应落盘 msg");
  assert.ok(msg.file && fs.existsSync(msg.file), "长消息全文应存文件，实际 file=" + msg.file);
  assert.ok(fs.readFileSync(msg.file, "utf8").includes("长消息正文"), "文件里应是完整正文");
});

// ── MIG-28：终端开启按当前厂商同步 agy settings；不注 GEMINI_API_KEY ──
test("MIG-28：终端同步按厂商写 settings.json（gemini-key 写 modelProvider，切回订阅则清掉）", async () => {
  const { syncTermAgySettings } = await import("../gw/terminal.mjs");
  fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
  fs.writeFileSync(agySettingsFile(), JSON.stringify({ theme: "dark" }));
  const gem = { id: "gemini-key", group: "antigravity", login: false, authStyle: "gemini-api-key", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "<redacted>", defaultModel: "gemini-3.8-flash" };
  const r1 = syncTermAgySettings(gem, "<redacted>");
  assert.equal(r1.error, undefined, "同步不应报错：" + JSON.stringify(r1));
  assert.equal(JSON.parse(fs.readFileSync(agySettingsFile(), "utf8")).modelProvider, "gemini");
  const sub = { id: "antigravity", group: "antigravity", login: true, authType: "oauth-personal" };
  syncTermAgySettings(sub, null);
  assert.equal("modelProvider" in JSON.parse(fs.readFileSync(agySettingsFile(), "utf8")), false, "切回订阅登录后终端同步应清掉残留的 modelProvider");
});

test("MIG-28（reg-models F-2 已回退）：终端环境不得注入 GEMINI_API_KEY；termNew 不再同步 agy 设置", async () => {
  const { termEnv } = await import("../gw/terminal.mjs");
  const env = termEnv();
  assert.equal(env.GEMINI_API_KEY, undefined, "终端 env 里不得出现 GEMINI_API_KEY");
  const src = fs.readFileSync(path.join(ROOT, "gateway", "gw", "terminal.mjs"), "utf8");
  // F-2 回退了 MIG-28 的调用点（条件性/预防性，因果未验证）：termNew 不得再调同步，
  // 恢复基线“终端开启不碰 settings.json”。函数本体保留，上面“终端同步按厂商写
  // settings.json”一测仍覆盖它本身的行为。
  assert.doesNotMatch(src, /syncTermAgySettings\(\);/, "termNew 里不得再有 syncTermAgySettings() 调用");
  assert.doesNotMatch(src, /env\.GEMINI_API_KEY\s*=/, "终端不得把 GEMINI_API_KEY 写进环境");
});
