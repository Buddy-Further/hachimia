// C13（P2）：给 antigravity 预置存一把 key，就退出登录态、丢弃 live 模型清单。
// 厂商配置是模块加载时读的：带杂 key 的场景在子进程里用自己的临时 home 跑，
// 绝不往共用池 home 的 ccapp-providers.json 里写杂 key（别的测试文件会读它）。
// 密钥、模型名全是 fixture 假 key。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG, PATHS } from "../gw/config.mjs";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw");
const ROOT = fs.mkdtempSync(path.join(CFG.workspace, "fix-c-c13-"));
let seq = 0;
const origAgy = PATHS.agy;
// 本文件在进程内只做无 key 的 upsert（不存 key、不改 active）；跑完把厂商配置文件恢复到来时的样子
const provFile = path.join(CFG.home, "ccapp-providers.json");
const provBefore = (() => { try { return fs.readFileSync(provFile, "utf8"); } catch { return null; } })();
after(() => {
  PATHS.agy = origAgy;
  try {
    if (provBefore === null) fs.unlinkSync(provFile);
    else fs.writeFileSync(provFile, provBefore);
  } catch {}
});

/** 在子进程里：先写好 files（相对 home），再跑 code；code 里 console.log(JSON) 作为结果 */
function scenario(files, code) {
  const home = path.join(ROOT, "h" + ++seq);
  fs.mkdirSync(home, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(home, f), typeof v === "string" ? v : JSON.stringify(v));
  const src = `const CFG = await import(${JSON.stringify(path.join(GW, "config.mjs"))}); ${code}; process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    env: { ...process.env, CCAPP_HOME: home, HOME: home, CCAPP_WORKSPACE: path.join(home, "ws"), CCAPP_PREFIX: "" }, encoding: "utf8", timeout: 30000 });
  return { rc: r.status, out: (r.stdout || "").trim().split("\n").pop(), err: r.stderr, home };
}

test("C13：登录类厂商上有杂 key 时仍算登录态（字面量对象，不写配置）", async () => {
  const { isLoginMode } = await import("../gw/models.mjs");
  const { keyOf } = await import("../gw/providers.mjs");
  const p = { login: true, apiKey: "sk-test-fixture-stray-key" };
  assert.equal(String(keyOf(p) || "").length > 0, true, "前置：对象上确实带一把 key");
  assert.equal(isLoginMode(p), true, "login 厂商的杂 key 不得关掉登录态");
  const p2 = { id: "antigravity", login: true, apiKey: "sk-test-fixture-stray-key" };
  assert.equal(isLoginMode(p2), true);
});

test("C13：登录类厂商不再接受新 key，且空 key 保存不报 need_key", async () => {
  const { upsertProvider, providerById } = await import("../gw/providers.mjs");
  const r = upsertProvider("antigravity", { apiKey: "sk-test-fixture-new-stray" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.keyIgnored, true, "应告知界面密钥没存");
  assert.equal(providerById("antigravity").apiKey, undefined, "新 key 不得存进登录类厂商");
  const r2 = upsertProvider("antigravity", { apiKey: "" });
  assert.equal(r2.ok, true, "登录类厂商本来就不用 key，空 key 保存不得报 need_key：" + JSON.stringify(r2));
});

test("C13：已存杂 key 的完整链路（子进程自有 home）——登录态 + 保存自愈 + live 清单", () => {
  const mockAgy = "#!/bin/sh\nprintf 'gemini-9-testmodel-high\\tGemini 9 Testmodel (High)\\n'\n";
  const r = scenario(
    {
      "ccapp-providers.json": { active: "antigravity", providers: { antigravity: { apiKey: "sk-test-fixture-stray-key" } } },
      "agy": mockAgy,
    },
    `
    const fs = (await import("node:fs")).default;
    const path = (await import("node:path")).default;
    CFG.PATHS.agy = path.join(process.env.CCAPP_HOME, "agy");
    fs.chmodSync(CFG.PATHS.agy, 0o755);
    const P = await import(${JSON.stringify(path.join(GW, "providers.mjs"))});
    const M = await import(${JSON.stringify(path.join(GW, "models.mjs"))});
    const before = M.isLoginMode(P.providerById("antigravity"));
    const saved = P.upsertProvider("antigravity", { defaultModel: "gemini-3.8-flash" });
    const afterKey = P.providerById("antigravity").apiKey ?? null;
    const list = await M.fetchModels(true, P.providerById("antigravity"));
    console.log(JSON.stringify({ before, cleared: !!saved.keyCleared, afterKey, live: list.some((m) => m.id === "gemini-9-testmodel") }));`,
  );
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { before: true, cleared: true, afterKey: null, live: true },
    "杂 key 在时登录态要是 true；保存要清掉它；live 清单要回来：" + r.out);
});
