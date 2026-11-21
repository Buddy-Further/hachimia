// P0-7b：ACP 路径跳过 Managed 桥门——桥坏了也不应拦 ACP 轮次；Claude 路径照旧拦。
// 尖锐情形：custom + protocol:"gemini" + 回环 baseUrl 的 ACP 厂商，且桥注册指向
// 同一端点——今天 providerEndpoint 非空、ensure 失败，整轮被桥门毙掉；
// 修后 ACP 轮次应直达 mock agy，组件 ensure 一次也不应被拉起。
import { PATHS } from "../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX。
import "./fixtures/uc-baseline.mjs";   // 共用 home 里前面测试留下的 ~/.claude 改动先认下，免得真起一轮时卡在确认卡片
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 即使意外走到 CLI，也只会得到可丢弃的假凭据和假入口。
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME, prefix = process.env.CCAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "fix-p07-"));
const reg = path.join(home, ".cccodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const providerFile = path.join(home, "ccapp-providers.json");
const cli = path.join(root, "fake-loader.cjs"), cliMarker = path.join(root, "cli-called");
fs.mkdirSync(path.dirname(component), { recursive: true });
fs.mkdirSync(path.dirname(reg), { recursive: true });
fs.mkdirSync(path.dirname(record), { recursive: true });
// 桥组件桩：ensure 永远失败（300ms 后 exit 1），复刻“桥未就绪”。
fs.writeFileSync(component, `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),dir=args[args.indexOf('--dir')+1];
fs.appendFileSync(path.join(dir,'calls'),args[0]+'\\n');
fs.writeFileSync(path.join(dir,'launcher.pid'),String(process.pid));
setTimeout(()=>{process.exitCode=1;},300);
`);
// 假 loader 用 sh：claude 的环境变量清掉了 LD_LIBRARY_PATH，有的机器上 node 离了它起不来（缺 libz），假 CLI 根本跑不到
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
fs.writeFileSync(cli, `#!${sh}\necho called > ${JSON.stringify(cliMarker)}\nexit 97\n`, { mode: 0o700 });
const endpoint = "http://127.0.0.1:34593";
// 最小 mock agy：initialize 报已验证版本 1.5.13（过 P0-4 版本门），
// authenticate / 建会 / prompt 只走成功路径，并把收到的 method 记进 counts。
const countsFile = path.join(root, "mock-counts.txt");
fs.writeFileSync(countsFile, "", "utf8");
const mockAgy = path.join(root, "mock-agy");
fs.writeFileSync(mockAgy, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const countsFile = ${JSON.stringify(countsFile)};
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const count = (m) => fs.appendFileSync(countsFile, m + "\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (!msg.method) return;
  count(msg.method);
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" },
      authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
    } });
  }
  if (msg.method === "authenticate") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true, methodId: msg.params.methodId } });
  if (msg.method === "session/new") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "agy-sess-p07", models: { currentModelId: "fixture-model", availableModels: [{ modelId: "fixture-model" }] } } });
  }
  if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "p07 acp ok" } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
  if (msg.id) return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
});
`, { mode: 0o755 });
// 只使用自身临时配置；KEY 检查需要非空假值，不导入活 App 的 providers。
// custom-acp-gemini 与桥用同一回环端点：providerEndpoint 非空，是桥门今天能拦住 ACP 的唯一情形。
fs.writeFileSync(providerFile, JSON.stringify({ active: "custom-managed-test", providers: {
  "custom-managed-test": { label: "Fake bridge", baseUrl: endpoint, apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
  "custom-acp-gemini": { label: "Fake ACP Gemini", baseUrl: endpoint, apiKey: "fixture-only", authStyle: "bearer", protocol: "gemini", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const previousPaths = { agy: PATHS.agy, claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.agy = mockAgy;
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { startRun } = await import("../gw/run.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { closeAllAcpClients } = await import("../gw/acp.mjs");
const events = [], requests = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => { requests.push(String(args[0])); throw new Error("fixture must not send a model request"); };
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, "instance-"));
  fs.writeFileSync(reg, JSON.stringify({ schema: 1, id: "openai-bridge", endpoint, runtimeDir: dir, instanceId: crypto.randomBytes(16).toString("hex") }));
  fs.writeFileSync(record, JSON.stringify({ id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] }));
  return { dir, calls: () => { try { return fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n"); } catch { return []; } } };
}
function acpEnded(id) {
  assert.equal(RUNS.has(id), false);
  const mine = events.filter((e) => e.runId === id), ends = mine.filter((e) => e.type === "run_end");
  assert.equal(ends.length, 1);
  assert.equal(!!ends[0].failed, false, JSON.stringify(mine.filter((e) => e.type === "error")));
  assert.equal(mine.some((e) => e.type === "error" && /本地 OpenAI 桥未就绪/.test(e.message)), false, "ACP 轮次不应被桥门拦住");
  assert.equal(requests.length, 0, "ACP 轮次不应发模型/模型列表请求");
  return mine;
}
function counts() { try { return fs.readFileSync(countsFile, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } }
after(async () => {
  off();
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  await closeAllAcpClients();
  for (const p of [reg, record, component, providerFile]) fs.rmSync(p, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("ACP 厂商 + 桥注册指向同一回环端点 + 桥 ensure 失败：本轮仍直达 agy，不拉 ensure", async () => {
  const f = fixture();
  fs.writeFileSync(countsFile, "", "utf8");
  await startRun({ id: "p07-acp-broken-bridge", provider: "custom-acp-gemini", message: "fixture message", cwd: root });
  acpEnded("p07-acp-broken-bridge");
  assert.ok(counts().includes("session/prompt"), "必须真的走到 ACP prompt，不是跳过桥门后在别处失败");
  assert.deepEqual(f.calls(), [], "ACP 路径不得拉起桥组件 ensure");
});

test("ACP 厂商 + 无桥注册（桥缺席）：本轮直达 agy", async () => {
  fs.rmSync(reg, { force: true });
  fs.writeFileSync(countsFile, "", "utf8");
  await startRun({ id: "p07-acp-no-bridge", provider: "custom-acp-gemini", message: "fixture message", cwd: root });
  acpEnded("p07-acp-no-bridge");
  assert.ok(counts().includes("session/prompt"), "必须真的走到 ACP prompt");
});

test("对照：非 ACP 桥厂商 + 桥 ensure 失败，仍被桥门拦在 CLI 之前", async () => {
  const f = fixture();
  await startRun({ id: "p07-claude-bridge-gate", message: "fixture message", cwd: root });
  assert.equal(RUNS.has("p07-claude-bridge-gate"), false);
  const mine = events.filter((e) => e.runId === "p07-claude-bridge-gate"), ends = mine.filter((e) => e.type === "run_end");
  assert.equal(ends.length, 1);
  assert.equal(!!ends[0].failed, true);
  assert.equal(mine.filter((e) => e.type === "error").length, 1);
  assert.match(mine.find((e) => e.type === "error").message, /本地 OpenAI 桥未就绪/);
  assert.deepEqual(f.calls(), ["ensure"]);
  assert.equal(fs.existsSync(cliMarker), false, "readiness 之前不能执行 CLI");
});
