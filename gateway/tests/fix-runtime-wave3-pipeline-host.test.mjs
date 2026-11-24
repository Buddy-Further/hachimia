// 第 3 波 hachimia 运行管线、池隔离、定时任务/多模态与 Java 宿主对齐回归测试（W2-F2b / C-01 / C-05 / C-06 / C-07）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG, PATHS, PREFIX } from "../gw/config.mjs";
import { agyEnv } from "../gw/claude.mjs";
import { claudeSeal } from "../gw/claudeseal.mjs";
import {
  acpPoolSessionForPid,
  isAcpToolAllowed,
  isAcpToolDisallowed,
  isSubagentTranscriptIdle,
  poolKey,
  runAcpTurn,
  translateAcpUpdate,
} from "../gw/acp.mjs";
import { collectAddDirs, privWitness } from "../gw/run.mjs";
import { deviceMcpAcpServer } from "../gw/usage.mjs";
import { providerById, upsertProvider } from "../gw/providers.mjs";
import { wantsInline } from "../gw/inlineimg.mjs";
import { reconcileNow } from "../gw/reconcile.mjs";
import { RECOVER_HOOKS, runEmit } from "../gw/queue.mjs";
import { _schedForTest as S } from "../gw/sched.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

// ── W2-F2b: send_message 后同轮又发起异步工具不得判闲 ────────────────────
test("W2-F2b: isSubagentTranscriptIdle 同轮 send_message 后又发起 invoke_subagent 不得误判已结", () => {
  const dir = path.join(CFG.workspace, "w3-f2b-sub");
  fs.rmSync(dir, { recursive: true, force: true });
  const logs = path.join(dir, "sub-1", ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const tf = path.join(logs, "transcript.jsonl");
  const lines = [
    JSON.stringify({ type: "USER_INPUT", content: "do work", timestamp: "2026-11-24T01:00:00Z" }),
    JSON.stringify({ type: "PLANNER_RESPONSE", tool_calls: [{ name: "send_message", args: { Recipient: "parent-1" } }], timestamp: "2026-11-24T01:00:05Z" }),
    JSON.stringify({ type: "PLANNER_RESPONSE", tool_calls: [{ name: "invoke_subagent", args: { Prompt: "next" } }], content: "spawned child", timestamp: "2026-11-24T01:00:06Z" }),
  ];
  fs.writeFileSync(tf, lines.join("\n") + "\n");
  try {
    const idle = isSubagentTranscriptIdle("sub-1", { brainDir: dir, parentSessionId: "parent-1", now: Date.parse("2026-11-24T01:10:00Z") });
    assert.equal(idle, false, "同轮后续发起了 invoke_subagent，不得提前判结");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── C-01: addDirs 过滤、claudeSeal O_NOFOLLOW、device-mcp、privWitness ───
test("C-01.1: collectAddDirs 拦截私有目录并保留合法工作区外部目录", () => {
  const goodDir = path.join(CFG.workspace, "w3-adddir-ok");
  fs.rmSync(goodDir, { recursive: true, force: true });
  fs.mkdirSync(goodDir, { recursive: true });
  try {
    const out = collectAddDirs(CFG.workspace, { addDirs: [CFG.home, path.dirname(CFG.home), goodDir, "/nonexistent/w3/path"] }, { local: false });
    assert.ok(out.includes(goodDir), `合法目录应保留: ${JSON.stringify(out)}`);
    assert.equal(out.includes(CFG.home), false, "CFG.home 私有目录必须被拦截");
    assert.equal(out.includes(path.dirname(CFG.home)), false, "包含私有目录的父级必须被拦截");
  } finally {
    fs.rmSync(goodDir, { recursive: true, force: true });
  }
});

test("C-01.2: claudeSeal 使用 O_NOFOLLOW 并校验普通文件与摘要一致性", async () => {
  const root = path.join(CFG.workspace, "w3-seal");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const bin = path.join(root, "agy");
  const mf = path.join(root, "manifest.json");
  const body = Buffer.from("#!/bin/sh\necho 1.5.13\n");
  const h = crypto.createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(bin, body, { mode: 0o755 });
  fs.writeFileSync(mf, JSON.stringify({ version: "1.5.13", sha256: h }));
  try {
    const ok = await claudeSeal(bin, { force: true });
    assert.equal(ok.ok, true, JSON.stringify(ok));

    // 篡改内容后必须 fail-closed
    fs.writeFileSync(bin, Buffer.from("#!/bin/sh\necho tampered\n"), { mode: 0o755 });
    const bad = await claudeSeal(bin, { force: true });
    assert.equal(bad.ok, false, JSON.stringify(bad));

    // 源码契约：sha256Async 使用 O_NOFOLLOW 并复核 dev/ino/size/ctimeNs
    const src = fs.readFileSync(path.join(REPO, "gateway/gw/claudeseal.mjs"), "utf8");
    assert.match(src, /O_NOFOLLOW/);
    assert.match(src, /ctimeNs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("C-01.3: deviceMcpAcpServer 在 loader 模式下使用 /system/bin/linker64 + gwNode 启动 device-mcp.mjs", () => {
  const gwDir = path.join(CFG.workspace, "w3-gwnode");
  fs.rmSync(gwDir, { recursive: true, force: true });
  fs.mkdirSync(gwDir, { recursive: true });
  const fakeNode = path.join(gwDir, "node");
  fs.writeFileSync(fakeNode, "elf", { mode: 0o755 });
  try {
    const entry = deviceMcpAcpServer({
      CCAPP_EXEC: "loader",
      CCAPP_GW_NODE: fakeNode,
      CCAPP_GW_LIB: gwDir,
    });
    if (PREFIX && fs.existsSync(path.join(REPO, "gateway/bin/device-mcp.mjs"))) {
      assert.ok(entry);
      assert.equal(entry.name, "device");
      assert.equal(entry.command, "/system/bin/linker64");
      assert.equal(entry.args[0], fakeNode);
      assert.ok(entry.args.some((a) => a.endsWith("device-mcp.mjs")));
      assert.ok(entry.env.some((e) => e.name === "LD_LIBRARY_PATH" && e.value === gwDir));
      assert.ok(entry.env.some((e) => e.name === "TERMUX_EXEC__PROC_SELF_EXE" && e.value === fakeNode));
    } else {
      assert.equal(entry, null);
    }
  } finally {
    fs.rmSync(gwDir, { recursive: true, force: true });
  }
});

test("C-01.4: run.mjs useAcp 接线核验（neutralizeMarkers、SPOOF_NOTE、autoTitle、refNote、CCAPP_PRIV_SESS、privWitness）", () => {
  const src = fs.readFileSync(path.join(REPO, "gateway/gw/run.mjs"), "utf8");
  const idx = src.indexOf("if (useAcp)");
  const seg = src.slice(idx, src.indexOf("const argv = [", idx));
  assert.match(seg, /isSessionRewinding/);
  assert.match(seg, /checkAppFiles\(\)/);
  assert.match(seg, /gwRuntimeBlocked\(\)/);
  assert.match(seg, /claudeSeal\(cliBin\)/);
  assert.match(seg, /projectRisks\(cwd\)/);
  assert.match(seg, /checkSessionAsync/);
  assert.match(seg, /sealSessionAsync/);
  assert.match(seg, /neutralizeMarkers\(message\)/);
  assert.match(seg, /SPOOF_NOTE/);
  assert.match(seg, /archiveHint\(run\.sessionId\)/);
  assert.match(seg, /refNote\(cleanMsg/);
  assert.match(seg, /autoTitle\(run\.sessionId/);
  assert.match(seg, /CCAPP_PRIV_SESS/);
  assert.match(seg, /deviceMcpAcpServer/);
  assert.match(seg, /finalText:\s*String\(acpRes\.resultText/);
  assert.equal(typeof privWitness, "function");
  assert.equal(typeof acpPoolSessionForPid, "function");
});

// ── C-05: agyEnv extraEnv、poolKey 指纹、并发 syncSettings 串行互斥 ──────
test("C-05.1: agyEnv 合入合法 extraEnv 并过滤 LD_PRELOAD / PATH / GEMINI_API_KEY 等敏感变量", () => {
  const env = agyEnv({
    sync: false,
    provider: {
      id: "gemini-custom",
      group: "antigravity",
      authStyle: "gemini-api-key",
      baseUrl: "https://proxy.example.com",
      extraEnv: {
        HTTPS_PROXY: "http://127.0.0.1:7890",
        API_TIMEOUT_MS: "120000",
        LD_PRELOAD: "/evil.so",
        PATH: "/evil/bin",
        CCAPP_TOKEN_FILE: "/etc/passwd",
        GEMINI_API_KEY: "hijacked",
        GOOGLE_GEMINI_BASE_URL: "https://evil.example.com",
      },
    },
  });
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.API_TIMEOUT_MS, "120000");
  assert.notEqual(env.LD_PRELOAD, "/evil.so");
  assert.notEqual(env.PATH, "/evil/bin");
  assert.equal(env.CCAPP_TOKEN_FILE, undefined);
  assert.notEqual(env.GEMINI_API_KEY, "hijacked");
  assert.notEqual(env.GOOGLE_GEMINI_BASE_URL, "https://evil.example.com");
});

test("C-05.2: poolKey 随 BaseURL / 代理 / extraEnv / extraModels / addDirs / mcpServers / CCAPP_PRIV_SESS 变化", () => {
  const base = {
    bin: "agy",
    args: ["acp"],
    cwd: "/tmp/w",
    authType: "gemini-api-key",
    apiKey: "k1",
    env: { GOOGLE_GEMINI_BASE_URL: "https://a.example", HTTPS_PROXY: "http://p1", CCAPP_PRIV_SESS: "tok1" },
    extraEnv: { FOO: "1" },
    extraModels: ["m1"],
    addDirs: ["/d1"],
    mcpServers: [{ name: "device", command: "node", args: ["a.mjs"], env: [] }],
  };
  const k0 = poolKey(base);
  assert.notEqual(poolKey({ ...base, env: { ...base.env, GOOGLE_GEMINI_BASE_URL: "https://b.example" } }), k0, "BaseURL 变更应换池键");
  assert.notEqual(poolKey({ ...base, env: { ...base.env, HTTPS_PROXY: "http://p2" } }), k0, "代理变更应换池键");
  assert.notEqual(poolKey({ ...base, env: { ...base.env, CCAPP_PRIV_SESS: "tok2" } }), k0, "特权口令变更应换池键");
  assert.notEqual(poolKey({ ...base, extraEnv: { FOO: "2" } }), k0, "extraEnv 变更应换池键");
  assert.notEqual(poolKey({ ...base, extraModels: ["m1", "m2"] }), k0, "extraModels 变更应换池键");
  assert.notEqual(poolKey({ ...base, addDirs: ["/d1", "/d2"] }), k0, "addDirs 变更应换池键");
  assert.notEqual(poolKey({ ...base, mcpServers: [] }), k0, "mcpServers 变更应换池键");
});

test("C-05.3 + C-06: 并发冷启串行同步 settings.json；disallowedTools 拒绝写工具；超时置 run.timedOut；取消态不报红", async () => {
  const root = path.join(CFG.workspace, "w3-acp-mock");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const mockPath = path.join(root, "mock-agy.mjs");
  const logFile = path.join(root, "events.log");
  fs.writeFileSync(mockPath, `
import fs from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const mode = process.env.MOCK_MODE || "normal";
const logFile = process.env.MOCK_LOG || "";
let nextReqId = 1;
const pending = new Map();

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id != null && !msg.method) {
    const fn = pending.get(msg.id);
    if (fn) { pending.delete(msg.id); fn(msg); }
    return;
  }
  if (msg.method === "initialize") {
    if (logFile) fs.appendFileSync(logFile, "init:" + process.env.MOCK_TAG + "\\n");
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "mock-agy", version: "1.5.13" },
          authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
          agentCapabilities: { sessionCapabilities: { resume: true, additionalDirectories: true } },
        },
      });
    }, mode === "lock" ? 80 : 5);
    return;
  }
  if (msg.method === "authenticate") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/new") {
    if (logFile) fs.appendFileSync(logFile, "new:" + process.env.MOCK_TAG + "\\n");
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sid-" + (process.env.MOCK_TAG || "1"),
        modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "accept-edits" }] },
      },
    });
    return;
  }
  if (msg.method === "session/set_mode") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    if (mode === "timeout") return; // 故意不回复触发 timeoutMs
    if (mode === "cancel") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Run command", name: "run_command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "echo hi" } } } });
      setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "cancelled" } }), 30);
      return;
    }
    if (mode === "perm") {
      const rid = nextReqId++;
      pending.set(rid, (resp) => {
        const outcome = resp.result?.outcome?.outcome || "";
        const opt = resp.result?.outcome?.optionId || "";
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message", messageId: "m1", content: "PERM:" + outcome + ":" + opt } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      });
      send({
        jsonrpc: "2.0",
        id: rid,
        method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "t-write", title: "Write file", name: "write_file", kind: "write", rawInput: { Path: "/tmp/x" } },
          options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject_once", kind: "reject_once" }],
        },
      });
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message", messageId: "m1", content: "OK:" + process.env.MOCK_TAG } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`);

  try {
    // 1. 并发冷启：syncSettings + initialize + session/new 严格串行，不互相交错覆盖 settings.json
    const order = [];
    const runLock = (tag) => runAcpTurn({
      bin: process.execPath,
      args: [mockPath],
      cwd: root,
      env: { ...process.env, MOCK_MODE: "lock", MOCK_TAG: tag, MOCK_LOG: logFile },
      prompt: "hi",
      authType: tag === "A" ? "oauth-personal" : "gemini-api-key",
      syncSettings: () => { order.push("sync:" + tag); fs.appendFileSync(logFile, "sync:" + tag + "\n"); },
      emit: () => {},
      keepAlive: false,
    });
    const [rA, rB] = await Promise.all([runLock("A"), runLock("B")]);
    assert.equal(rA.ok, true);
    assert.equal(rB.ok, true);
    const trace = fs.readFileSync(logFile, "utf8").trim().split("\n");
    // 第一个的 sync -> init -> new 必须全部发生在第二个的 sync 之前
    assert.deepEqual(trace.slice(0, 3), ["sync:A", "init:A", "new:A"], `冷启握手必须串行: ${JSON.stringify(trace)}`);
    assert.deepEqual(trace.slice(3, 6), ["sync:B", "init:B", "new:B"], `第二个握手须排在第一个之后: ${JSON.stringify(trace)}`);

    // 2. disallowedTools: 即使 permMode=bypassPermissions，写文件工具也必须被拒绝
    const runPerm = { id: "r-perm", denied: [] };
    const rPerm = await runAcpTurn({
      bin: process.execPath,
      args: [mockPath],
      cwd: root,
      env: { ...process.env, MOCK_MODE: "perm", MOCK_TAG: "P" },
      prompt: "write",
      permMode: "bypassPermissions",
      disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
      run: runPerm,
      emit: () => {},
      keepAlive: false,
    });
    assert.equal(rPerm.ok, true);
    assert.match(rPerm.resultText, /PERM:selected:reject_once/, `写文件工具必须被拒: ${rPerm.resultText}`);
    assert.ok(runPerm.denied.length >= 1, "应记录被拒工具");
    assert.equal(isAcpToolDisallowed("Write file", "write", ["Write"]), true);
    assert.equal(isAcpToolAllowed("run_command", "execute", ["Bash"]), true);

    // 3. 超时置 run.timedOut = true
    const runTo = { id: "r-to" };
    const rTo = await runAcpTurn({
      bin: process.execPath,
      args: [mockPath],
      cwd: root,
      env: { ...process.env, MOCK_MODE: "timeout", MOCK_TAG: "T" },
      prompt: "slow",
      timeoutMs: 150,
      run: runTo,
      emit: () => {},
      keepAlive: false,
    });
    assert.equal(rTo.ok, false);
    assert.equal(rTo.timedOut, true);
    assert.equal(runTo.timedOut, true);

    // 4. 取消态：未完结工具发 cancelled:true 且 is_error:false，且 tool_use 带 kind/rawName 并进入 run.sideTools
    const evs = [];
    const runCan = { id: "r-can", log: [], sideTools: new Map() };
    const rCan = await runAcpTurn({
      bin: process.execPath,
      args: [mockPath],
      cwd: root,
      env: { ...process.env, MOCK_MODE: "cancel", MOCK_TAG: "C" },
      prompt: "cancel-me",
      run: runCan,
      emit: (ev) => { evs.push(ev); runEmit(runCan, ev); },
      keepAlive: false,
    });
    assert.equal(rCan.ok, true);
    const tu = evs.find((e) => e.type === "tool_use" && e.id === "tc-1");
    assert.ok(tu && tu.kind === "execute" && tu.rawName === "run_command");
    const trEv = evs.find((e) => e.type === "tool_result" && e.id === "tc-1");
    assert.ok(trEv && trEv.cancelled === true && trEv.is_error === false, JSON.stringify(trEv));
    assert.equal(runCan.sideTools.size, 0, "tool_result 回来后应销账");

    // 验证仅发 tool_use（未发 tool_result，模拟进程被强杀）时，ACP 友好名与 kind 都能进 sideTools
    const runSide = { id: "r-side", log: [] };
    runEmit(runSide, { type: "tool_use", id: "s1", name: "Run command", kind: "execute", input: { CommandLine: "ls -la" } });
    runEmit(runSide, { type: "tool_use", id: "s2", name: "Write file", kind: "write", input: { Path: "/tmp/a.txt" } });
    assert.equal(runSide.sideTools.size, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── C-06.2: sched.mjs 已停用任务不排重试 ─────────────────────────────────
test("C-06.2: sched.mjs 已停用任务（t.on=false）在 RECOVER_HOOKS 中绝不排重试", () => {
  const id = "w3-disabled-retry-" + Date.now();
  const task = {
    id,
    name: "disabled-task",
    prompt: "ping",
    on: false,
    freq: { kind: "daily", time: "09:00" },
    nextAt: null,
    session: "new",
    projectId: null,
    busy: "run",
    retry: 2,
    limitCost: 0,
    limitMin: 15,
  };
  S.DB.tasks.push(task);
  try {
    const fakeRun = { id: "run-rec-" + Date.now(), sched: { taskId: id }, startedAt: Date.now() - 1000, sessionId: null };
    for (const h of RECOVER_HOOKS) h([fakeRun], { runs: [fakeRun], queue: [], handoffs: [] });
    assert.equal(S.hasRetry(id), false, "已停用任务恢复失败后绝不得排重试");
  } finally {
    const i = S.DB.tasks.indexOf(task);
    if (i >= 0) S.DB.tasks.splice(i, 1);
  }
});

// ── C-06.3: 内置 5 个 ACP 预设默认 inlineImages:true，用户可显式关闭 ──────
test("C-06.3: 5 个 ACP 预设默认 inlineImages=true 且允许用户覆盖为 false", () => {
  for (const id of ["antigravity", "antigravity-enterprise", "antigravity-adc", "gemini-key", "gemini-custom"]) {
    const p = providerById(id);
    assert.ok(p, `应存在预设 ${id}`);
    assert.equal(p.inlineImages, true, `${id} 应默认 inlineImages: true`);
    assert.equal(wantsInline(p), true, `${id} wantsInline 应为 true`);
  }
  // 用户显式关掉 antigravity 的 inlineImages
  const res = upsertProvider("antigravity", { inlineImages: false });
  assert.equal(res.error, undefined);
  assert.equal(providerById("antigravity").inlineImages, false);
  assert.equal(wantsInline(providerById("antigravity")), false);
  // 还原
  upsertProvider("antigravity", { inlineImages: true });
  assert.equal(providerById("antigravity").inlineImages, true);
});

// ── C-06.5: reconcile.mjs 检查 PATHS.agy 缺失 ───────────────────────────
test("C-06.5: reconcileNow 在 PATHS.agy 缺失时报 agy error 且带 act.t=claude", async () => {
  const prevAgy = PATHS.agy;
  PATHS.agy = path.join(CFG.workspace, "definitely-missing-agy-bin");
  try {
    const r = await reconcileNow();
    const hit = r.findings.find((f) => f.key === "agy" && f.level === "error");
    assert.ok(hit, `应检出缺失 agy: ${JSON.stringify(r.findings)}`);
    assert.deepEqual(hit.act, { t: "claude" });
  } finally {
    PATHS.agy = prevAgy;
  }
});

// ── C-07: Java 宿主四项修复契约 + install-agy.mjs 版本参数实测 ───────────
test("C-07.1: Java 宿主（Priv / Updater / Share / FactoryReset）源码契约核验", () => {
  const priv = fs.readFileSync(path.join(REPO, "android/java/ha/chi/mia/Priv.java"), "utf8");
  assert.match(priv, /"agy"\.equals\(who\)\s*\|\|\s*"claude"\.equals\(who\)/);
  assert.match(priv, /\("claude"\.equals\(item\)\s*\|\|\s*"agy"\.equals\(item\)\)\s*&&\s*ver\.trim\(\)\.isEmpty\(\)/);

  const upd = fs.readFileSync(path.join(REPO, "android/java/ha/chi/mia/Updater.java"), "utf8");
  assert.match(upd, /p\.waitFor\(30,\s*java\.util\.concurrent\.TimeUnit\.SECONDS\)/);
  assert.match(upd, /if\s*\(pinned\(\)\)/);
  assert.match(upd, /id\.equals\("claude"\)\s*\|\|\s*id\.equals\("agy"\)/);

  const share = fs.readFileSync(path.join(REPO, "android/java/ha/chi/mia/Share.java"), "utf8");
  assert.match(share, /hachimia-auth\.json/);
  assert.match(share, /\.gemini\/antigravity-cli\/settings/);
  assert.match(share, /\.config\/antigravity/);
  assert.match(share, /\.antigravity/);

  const reset = fs.readFileSync(path.join(REPO, "android/java/ha/chi/mia/FactoryReset.java"), "utf8");
  assert.match(reset, /"\.hachimia"/);
  assert.match(reset, /MOVE\s*=\s*\{[\s\S]*?\.gemini\/antigravity-cli\/settings\.json[\s\S]*?\};/);
  assert.match(reset, /KEYS\s*=\s*\{[\s\S]*?\.config\/antigravity[\s\S]*?\.antigravity[\s\S]*?\.cache\/hachimia-auth\.json[\s\S]*?\};/);
  assert.match(reset, /collectAgyCreds/);
  assert.match(reset, /"brain"\.equals\(name\)/);
});

test("C-07.2: install-agy.mjs 传入具体版本号时透传版本并校验，版本不符时报错且不覆写 current", () => {
  const root = path.join(CFG.workspace, "w3-install-agy");
  const fakeHome = path.join(root, "home");
  const fakePrefix = path.join(root, "usr");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(fakePrefix, "bin"), { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  const shBin = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  const fakeCurl = path.join(fakePrefix, "bin/curl");
  const mockScriptFile = path.join(root, "mock-install.sh");
  // 假 curl 直接把 mock-install.sh 原文吐到 stdout
  fs.writeFileSync(fakeCurl, `#!${shBin}\ncat "${mockScriptFile}"\n`, { mode: 0o755 });

  const installer = path.join(REPO, "android/assets/scripts/install-agy.mjs");
  try {
    // 1. 支持 --version 的上游脚本：精准安装 1.9.9
    fs.writeFileSync(mockScriptFile, `#!${shBin}
DIR=""
VER=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --version) VER="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$DIR"
cat > "$DIR/agy" <<EOF
#!${shBin}
echo "agy \${VER:-1.5.13}"
EOF
chmod 0755 "$DIR/agy"
`);
    const ok = spawnSync(process.execPath, [installer, "1.9.9"], {
      env: { ...process.env, HOME: fakeHome, PREFIX: fakePrefix },
      encoding: "utf8",
    });
    assert.equal(ok.status, 0, `支持 --version 应安装成功: ${ok.stderr}\n${ok.stdout}`);
    const cur1 = fs.readlinkSync(path.join(fakeHome, ".local/share/hachimia/agy/current"));
    assert.equal(cur1, "1.9.9");

    // 2. 忽略版本号的上游脚本：请求 1.8.0 但脚本装出 2.0.0 -> 必须报错退出且不覆盖 current(1.9.9)
    fs.writeFileSync(mockScriptFile, `#!${shBin}
DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$DIR"
cat > "$DIR/agy" <<EOF
#!${shBin}
echo "agy 2.0.0"
EOF
chmod 0755 "$DIR/agy"
`);
    const bad = spawnSync(process.execPath, [installer, "1.8.0"], {
      env: { ...process.env, HOME: fakeHome, PREFIX: fakePrefix },
      encoding: "utf8",
    });
    assert.notEqual(bad.status, 0, "上游返回不匹配版本时必须报错退出");
    assert.match(bad.stderr, /1\.8\.0.*2\.0\.0/);
    assert.equal(fs.readlinkSync(path.join(fakeHome, ".local/share/hachimia/agy/current")), "1.9.9", "失败不得覆盖原 current 软链");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
