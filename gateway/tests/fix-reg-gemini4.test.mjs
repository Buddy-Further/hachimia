// Gemini 4 专项（INV-4）探针改写为正式回归测试 + F-G4-3 会话钉选迁移。
//   结论先行：Gemini 4 在拉取/解析管线里没有丢——同一份 mock 在两版上 id 逐字相同。
//   唯一能让“整个 Gemini 4 系列”消失的代码路径，是会话钉在 anthropic 上时走
//   LOGIN_MODELS（21 条 Claude-only，0 个 Gemini）。MIG-10 只迁移了全局 active，
//   会话钉选未迁；F-G4-3 把它补上（启动时迁回 antigravity）。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { dropModelCache, fetchModels, parseAgyModelsOutput } from "../gw/models.mjs";
import { providerById } from "../gw/providers.mjs";
import { effectiveModel, flushSessModel, migrateHiddenSessionPins, sessModel, setSessModel } from "../gw/sessmodel.mjs";

const SESS_FILE = path.join(CFG.home, "ccapp-session-models.json");

// INV-4 §3.1 的 mock live 清单：26 行模型行 → 14 个家族，含 7 个 gemini-4*
// （neon/carbon/argon/hydrogen 各带档位行 + live-only 探测行 gemini-4-pro、
// gemini-4-flash、gemini-4.5-pro——后三者是探测行，真实 live 清单以真机输出为准，
// 不得直接写入 fallback 表，见 F-G4-2）。
const FULL_LINES = [
  ["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
  ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
  ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
  ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
  ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"],
  ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
  ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
  ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
  ["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"],
  ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
  ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
  ["gemini-4-pro", "Gemini 4 Pro"],
  ["gemini-4-flash", "Gemini 4 Flash"],
  ["gemini-4.5-pro", "Gemini 4.5 Pro"],
  ["gemini-pro-orchestrator-neon", "Gemini Pro Orchestrator Neon"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.1-pro", "Gemini 3.1 Pro"],
  ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["gpt-oss-120b-medium", "GPT OSS 120B Medium"],
];
const FULL_TEXT = ["Available models:", "WARNING: using cached credentials", ...FULL_LINES.map(([id, name]) => `${id}\t${name}`)].join("\n") + "\n";
const EXPECTED_14 = ["gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen",
  "gemini-4-pro", "gemini-4-flash", "gemini-4.5-pro", "gemini-pro-orchestrator-neon",
  "gemini-3.8-flash", "gemini-3.1-pro", "gemini-2.5-pro", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b-medium"];
const ids = (list) => list.map((m) => m.id).sort();
const g4 = (list) => list.filter((m) => m.id.startsWith("gemini-4"));

// 假 agy：AGY_MODELS_MODE=full 印完整清单，empty 空输出（exit 1）→ 回落
function makeFakeAgy(dir) {
  const script = path.join(dir, "fake-agy-g4");
  const body = FULL_LINES.map(([id, name]) => `printf '${id}\\t${name}\\n'`).join("\n      ");
  fs.writeFileSync(script, `#!/bin/sh
if [ "$1" = "models" ]; then
  case "$AGY_MODELS_MODE" in
    full)
      printf 'Available models:\\n'
      printf 'WARNING: using cached credentials\\n'
      ${body}
      exit 0 ;;
    empty)
      exit 1 ;;
  esac
fi
exit 1
`, { mode: 0o755 });
  return script;
}

const tmpRoot = fs.mkdtempSync(path.join(CFG.home, "fix-reg-gemini4-"));
const fake = makeFakeAgy(tmpRoot);
const prevAgy = PATHS.agy, prevClaude = PATHS.claude;
const NO_CLAUDE = path.join(CFG.home, "fix-reg-gemini4-no-claude");
after(() => {
  PATHS.agy = prevAgy; PATHS.claude = prevClaude;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(SESS_FILE, { force: true });
  delete process.env.AGY_MODELS_MODE;
});
/** agy-only 环境：有 agy、无旧版 claude——MIG-10/F-G4-3 的迁移只在这种设备上触发 */
function agyOnly() { PATHS.agy = fake; PATHS.claude = NO_CLAUDE; }
function notAgyOnly() { PATHS.agy = path.join(CFG.home, "fix-reg-gemini4-no-agy"); PATHS.claude = NO_CLAUDE; }

// ── INV-4 T1–T5：管线钉子 ──────────────────────────────────────────────
test("T1 解析全过：mock live 输出解析出 14 个家族，7 个 gemini-4* 一个不少", () => {
  const list = parseAgyModelsOutput(FULL_TEXT);
  assert.deepEqual(ids(list), [...EXPECTED_14].sort(), "解析应原样透传 Gemini 4 全系列");
  assert.equal(g4(list).length, 7, "应有 7 个 gemini-4* 家族");
  const neon = list.find((m) => m.id === "gemini-4-neon");
  assert.deepEqual(neon.effort.supported_levels, ["low", "medium", "high", "xhigh"], "neon 档位应归并齐全");
});

test("T2 拉取全过：mock agy 挂到 PATHS.agy 上，fetchModels 返回与解析相同的 id 集合", async () => {
  agyOnly();
  dropModelCache();
  process.env.AGY_MODELS_MODE = "full";
  try {
    const list = await fetchModels(true, providerById("antigravity"));
    assert.deepEqual(ids(list), [...EXPECTED_14].sort(), "拉取应原样服务 live 清单");
    assert.equal(g4(list).length, 7);
  } finally { delete process.env.AGY_MODELS_MODE; }
});

test("T3 回落表不断档：live 为空时回落的 9 条里仍有 4 个 Gemini 4", async () => {
  agyOnly();
  dropModelCache();
  process.env.AGY_MODELS_MODE = "empty";
  try {
    const list = await fetchModels(true, providerById("antigravity"));
    assert.equal(list.length, 9, "回落清单应为 9 条 fallback");
    assert.equal(g4(list).length, 4, "回落清单里应仍有 4 个 Gemini 4（neon/carbon/argon/hydrogen）");
    const inTable = providerById("antigravity").fallbackModels.filter((m) => m.id.startsWith("gemini-4")).length;
    assert.equal(g4(list).length, inTable, "回落的 Gemini 4 条目数应与 fallback 表一致——今后改表删了 Gemini 4，此测试即红");
  } finally { delete process.env.AGY_MODELS_MODE; }
});

test("T4 钉选分支可辨：anthropic 厂商返回的清单里 0 个 Gemini（已知行为）", async () => {
  agyOnly();
  dropModelCache();
  process.env.AGY_MODELS_MODE = "full";
  try {
    const list = await fetchModels(true, providerById("anthropic"));
    assert.equal(list.length, 21, "anthropic 应返回 21 条 Claude 静态清单 LOGIN_MODELS");
    assert.equal(g4(list).length, 0, "Claude 静态清单里 0 个 Gemini——这是唯一能让整个 Gemini 4 系列消失的代码路径");
  } finally { delete process.env.AGY_MODELS_MODE; }
  // 约定：F-G4-3 的迁移在会话记录层，不改 fetchModels 本身，所以此断言保持；
  // 若将来改动 fetchModels 使 anthropic 也走 live，这里须同步改断言。
});

test("T5 解析边界：裸 id 行与冒号 id 行被丢，括号后带尾巴的行保留不归并", () => {
  const list = parseAgyModelsOutput([
    "gemini-4-neon",                                  // 裸 id 行（无显示名）：丢
    "gemini-4-neon:low\tGemini 4 Neon Low",           // 冒号 id：丢
    "gemini-4-neon-high\tGemini 4 Neon (High) extra text",  // 括号后带尾巴：保留，不归并
    "gemini-4-pro Gemini 4 Pro",                      // 空格分隔：保留
    "",
  ].join("\n"));
  assert.deepEqual(ids(list), ["gemini-4-neon-high", "gemini-4-pro"]);
});

// ── F-G4-3：会话钉选迁移 ───────────────────────────────────────────────
test("F-G4-3：agy-only 下钉在 Claude 预置的会话被迁回 antigravity，模型置空、只钉强度者保持 null", () => {
  agyOnly();
  setSessModel("sess-g4-old", { provider: "anthropic", model: "claude-opus-5-5" });
  setSessModel("sess-g4-eff", { provider: "anthropic-key", model: null, effort: "high" });
  setSessModel("sess-g4-ok", { provider: "antigravity", model: "gemini-4-neon" });
  const moved = migrateHiddenSessionPins();
  assert.deepEqual(moved.sort(), ["sess-g4-eff", "sess-g4-old"], "应迁走两个钉在 Claude 预置的会话");
  assert.equal(sessModel("sess-g4-old").provider, "antigravity", "旧会话应迁到 antigravity");
  assert.equal(sessModel("sess-g4-old").model, "", "钉过 Claude 模型的，模型应置空（接口默认），跟换家的做法一致");
  assert.equal(sessModel("sess-g4-eff").provider, "antigravity");
  assert.equal(sessModel("sess-g4-eff").model, null, "只钉了思考强度的，模型保持 null，仍跟随默认");
  assert.equal(sessModel("sess-g4-eff").effort, "high", "思考强度保留");
  assert.equal(sessModel("sess-g4-ok").provider, "antigravity", "本来就在 antigravity 的会话不动");
  assert.equal(sessModel("sess-g4-ok").model, "gemini-4-neon");
  assert.equal(effectiveModel("sess-g4-old").provider, "antigravity");
  // 落盘：重读文件也应是迁后的值
  flushSessModel();
  const disk = JSON.parse(fs.readFileSync(SESS_FILE, "utf8"));
  assert.equal(disk["sess-g4-old"].provider, "antigravity");
  assert.equal(disk["sess-g4-old"].model, "");
  assert.equal(disk["sess-g4-eff"].provider, "antigravity");
  assert.equal(disk["sess-g4-eff"].model, null);
  // 幂等：再跑一次无事可做
  assert.deepEqual(migrateHiddenSessionPins(), [], "第二次迁移应无事可做");
});

test("F-G4-3 症状：钉在 anthropic 的会话迁移后能看到 Gemini 4", async () => {
  agyOnly();
  dropModelCache();
  setSessModel("sess-g4-see", { provider: "anthropic", model: "claude-opus-5-5" });
  process.env.AGY_MODELS_MODE = "full";
  try {
    // 迁移前：这个会话真跑的那家是 anthropic，清单 0 个 Gemini（T4 的机制）
    const before = await fetchModels(true, providerById("anthropic"));
    assert.equal(g4(before).length, 0, "迁移前该会话看到的清单应 0 个 Gemini");
    // 迁移后：会话回到 antigravity，live 清单 7 个 Gemini 4
    migrateHiddenSessionPins();
    assert.equal(effectiveModel("sess-g4-see").provider, "antigravity", "迁移后会话应回到 antigravity");
    const after = await fetchModels(true, providerById("antigravity"));
    assert.equal(g4(after).length, 7, "迁移后该会话应看到 7 个 Gemini 4");
    assert.ok(after.some((m) => m.id === "gemini-4-neon"), "应含 Gemini 4 系列");
  } finally { delete process.env.AGY_MODELS_MODE; }
});
