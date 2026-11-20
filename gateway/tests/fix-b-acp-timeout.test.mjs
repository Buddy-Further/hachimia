// B12：session/prompt 默认必须有超时（不再无限等待），超时后回合失败且不占住车道
process.env.CCAPP_ACP_PROMPT_TIMEOUT_MS = "800";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";

const { runAcpTurn, closeAllAcpClients, ACP_DEFAULT_PROMPT_TIMEOUT_MS } = await import("../gw/acp.mjs");

function makeHangMock(dir) {
  const script = path.join(dir, "mock-agy-hang");
  fs.writeFileSync(script, `#!${process.execPath}
const readline = require("node:readline");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (msg.method === "authenticate") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "agy-sess-hang", models: { currentModelId: "gemini-4-neon" } } });
  if (msg.method === "session/set_config_option" || msg.method === "session/set_mode") return send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  if (msg.method === "session/prompt") return; // 假死：不回包也不退出
});
`, { mode: 0o755 });
  return script;
}

test("B12 默认 prompt 超时是有限值", () => {
  assert.ok(Number.isFinite(ACP_DEFAULT_PROMPT_TIMEOUT_MS) && ACP_DEFAULT_PROMPT_TIMEOUT_MS > 0);
});

test("B12 agent 假死时 session/prompt 在默认超时内失败返回", { timeout: 15000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-b-hang-"));
  const mockBin = makeHangMock(tmp);
  try {
    const t0 = Date.now();
    const r = await runAcpTurn({
      bin: process.execPath,
      args: [mockBin],
      cwd: CFG.workspace,
      env: process.env,
      prompt: "hi",
      run: { id: "r-b-hang", bgList: [], bgTasks: 0 },
      emit: () => {},
      keepAlive: false,
      // timeoutMs 不传：走默认超时（本测试用环境变量缩到 800ms）
    });
    const dt = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(String(r.error || ""), /timeout/i);
    assert.ok(dt < 10000, `应在默认超时内返回，实际 ${dt}ms`);
  } finally { closeAllAcpClients(); }
});
