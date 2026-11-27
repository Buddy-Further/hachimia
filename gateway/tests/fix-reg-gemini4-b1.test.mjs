// F-G4-3 B1（审查打回）：项目默认钉选与定时任务钉选迁移。
//   INV-4 F-G4-3(a) 原案要求 sessmodel 与项目默认里的 group === "claude" 钉选都迁回
//   antigravity；第一轮只迁了会话。项目默认经 effectiveModel / pickProvider 回落，
//   定时任务经 taskItem → pickProvider 最高优先级——两者都会让会话走到 0 个 Gemini
//   的 LOGIN_MODELS，与修复前症状完全相同。
//   本文件静态只 import node 内置模块；夹具与 agy-only 环境先摆好，再动态 import，
//   且 providers.mjs 先于 projects/sched 被 import（TDZ 崩溃的顺序，见 lazy 测试）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fix-reg-gemini4-b1-"));

// INV-4 §3.1 的 mock live 清单（与 fix-reg-gemini4.test.mjs 同一份探针）
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
const g4 = (list) => list.filter((m) => m.id.startsWith("gemini-4"));
function makeFakeAgy(dir) {
  const script = path.join(dir, "fake-agy-b1");
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
const fakeAgy = makeFakeAgy(tmpRoot);
// 注意：必须在 import config 之前先把环境变量摆好（PATHS 在 import 时快照），见 fix-a-agyonly。
process.env.CCAPP_AGY = fakeAgy;
delete process.env.CCAPP_CLAUDE;

const { CFG, PATHS } = await import("../gw/config.mjs");
const PROJ_FILE = path.join(CFG.home, "ccapp-projects.json");
const SCHED_FILE = path.join(CFG.home, "ccapp-sched.json");
const SESS_FILE = path.join(CFG.home, "ccapp-session-models.json");
const NO_AGY = path.join(CFG.home, "fix-reg-gemini4-b1-no-agy");
const NO_CLAUDE = path.join(CFG.home, "fix-reg-gemini4-b1-no-claude");
const projDisk = () => JSON.parse(fs.readFileSync(PROJ_FILE, "utf8"));
const schedDisk = () => JSON.parse(fs.readFileSync(SCHED_FILE, "utf8"));

// 夹具先写好（import 之前）：一个钉 anthropic 的旧项目（含模型）、一个只钉了
// provider 的项目、一个本来就在 antigravity 的项目、一个跟随全局的项目；
// 定时任务同样三类；会话记录为空（effectiveModel 回落到项目默认）。
fs.writeFileSync(PROJ_FILE, JSON.stringify([
  { id: "proj-g4-old", name: "旧项目", path: path.join(tmpRoot, "proj-old"), provider: "anthropic", model: "claude-sonnet-5-5", effort: "", perm: "", created: 1 },
  { id: "proj-g4-eff", name: "只钉接口的项目", path: path.join(tmpRoot, "proj-eff"), provider: "anthropic-key", model: "", effort: "high", perm: "", created: 2 },
  { id: "proj-g4-ok", name: "正常项目", path: path.join(tmpRoot, "proj-ok"), provider: "antigravity", model: "gemini-4-neon", effort: "", perm: "", created: 3 },
  { id: "proj-g4-follow", name: "跟随项目", path: path.join(tmpRoot, "proj-follow"), provider: "", model: "", effort: "", perm: "", created: 4 },
]));
fs.writeFileSync(SCHED_FILE, JSON.stringify({
  tasks: [
    { id: "task-g4-old", name: "旧任务", on: false, provider: "anthropic", model: "claude-sonnet-5-5", effort: "" },
    { id: "task-g4-ok", name: "正常任务", on: false, provider: "antigravity", model: "gemini-4-neon", effort: "" },
    { id: "task-g4-follow", name: "跟随任务", on: false, provider: "", model: "", effort: "" },
  ],
  dailyBudget: 0, missed: [], pending: [], sids: [], lastTick: 0, allowLogin: false,
  spent: {}, monthly: {}, monthlySeeded: false, retries: [],
}));
fs.writeFileSync(SESS_FILE, JSON.stringify({}));
after(() => {
  PATHS.agy = prevAgy; PATHS.claude = prevClaude;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  for (const f of [PROJ_FILE, SCHED_FILE, SESS_FILE]) fs.rmSync(f, { force: true });
  delete process.env.AGY_MODELS_MODE;
});
const prevAgy = PATHS.agy, prevClaude = PATHS.claude;

// providers 先 import（TDZ 崩溃的顺序）：若迁移还在模块顶层，这里即抛 ReferenceError。
const prov = await import("../gw/providers.mjs");
const { projectById, projectDefaults, migrateHiddenProjectPins } = await import("../gw/projects.mjs");
const { effectiveModel } = await import("../gw/sessmodel.mjs");
const { migrateHiddenTaskPins } = await import("../gw/sched.mjs");
const { dropModelCache, fetchModels } = await import("../gw/models.mjs");
const { pickProvider } = await import("../gw/run.mjs");

test("B1 懒迁移：import 完成时落盘文件仍是旧钉选", () => {
  assert.equal(prov.isAgyOnlyMode(), true, "本用例应在 agy-only 模式下跑");
  assert.equal(projDisk().find((p) => p.id === "proj-g4-old").provider, "anthropic", "import 完成时项目钉选不得已跑（懒迁移）");
  assert.equal(schedDisk().tasks.find((t) => t.id === "task-g4-old").provider, "anthropic", "import 完成时任务钉选不得已跑（懒迁移）");
});

test("B1 项目默认钉选迁移：首次读 projectDefaults 时迁回 antigravity，模型置空、落盘、幂等", () => {
  // 触发点是 projectDefaults（effectiveModel / pickProvider / startRun 都经它）：
  // 调用之前磁盘仍是旧值，调用之后即迁移——不用直接调迁移函数。
  const before = projectDefaults(projectById("proj-g4-old"));
  assert.equal(before.provider, "antigravity", "首次读项目默认时旧项目应已迁到 antigravity");
  assert.equal(before.model, undefined, "钉过 Claude 模型的，模型应置空（跟随默认），跟会话迁移一致");
  const eff = projectDefaults(projectById("proj-g4-eff"));
  assert.equal(eff.provider, "antigravity");
  assert.equal(eff.effort, "high", "思考强度保留");
  assert.equal(eff.model, undefined);
  const ok = projectDefaults(projectById("proj-g4-ok"));
  assert.equal(ok.provider, "antigravity", "本来就在 antigravity 的项目不动");
  assert.equal(ok.model, "gemini-4-neon");
  const follow = projectDefaults(projectById("proj-g4-follow"));
  assert.equal(follow.provider, undefined, "跟随全局的项目不动：provider 仍是跟随");
  assert.equal(follow.model, undefined, "跟随全局的项目不动：model 仍是跟随");
  // 落盘：重读文件也应是迁后的值
  const disk = projDisk();
  assert.equal(disk.find((p) => p.id === "proj-g4-old").provider, "antigravity");
  assert.equal(disk.find((p) => p.id === "proj-g4-old").model, "");
  assert.equal(disk.find((p) => p.id === "proj-g4-eff").provider, "antigravity");
  // 幂等：再跑一次无事可做
  assert.deepEqual(migrateHiddenProjectPins(), [], "第二次迁移应无事可做");
});

test("B1 症状：项目默认钉 anthropic 的会话迁移后能看到 Gemini 4（effectiveModel + pickProvider）", async () => {
  dropModelCache();
  process.env.AGY_MODELS_MODE = "full";
  try {
    // 迁移前：这个项目默认的那家是 anthropic，清单 0 个 Gemini（T4 的机制）
    const before = await fetchModels(true, prov.providerById("anthropic"));
    assert.equal(g4(before).length, 0, "迁移前该项目默认看到的清单应 0 个 Gemini");
    // 迁移后（上一测试已迁）：无会话钉选时回落到项目默认 antigravity，live 清单 7 个 Gemini 4
    assert.equal(effectiveModel("", "proj-g4-old").provider, "antigravity", "迁移后回落到项目默认应是 antigravity");
    assert.equal(pickProvider({ projectId: "proj-g4-old" }).P.id, "antigravity", "run.mjs pickProvider 也应走到 antigravity（审查证据链第 3 点）");
    const after = await fetchModels(true, prov.providerById("antigravity"));
    assert.equal(g4(after).length, 7, "迁移后该项目默认应看到 7 个 Gemini 4");
    assert.ok(after.some((m) => m.id === "gemini-4-neon"), "应含 Gemini 4 系列");
  } finally { delete process.env.AGY_MODELS_MODE; }
});

test("O3 定时任务钉选迁移：钉在 Claude 预置的任务迁回 antigravity，模型置空、落盘、幂等", () => {
  const moved = migrateHiddenTaskPins();
  assert.deepEqual(moved, ["task-g4-old"], "应迁走钉在 anthropic 的任务");
  const disk = schedDisk();
  assert.equal(disk.tasks.find((t) => t.id === "task-g4-old").provider, "antigravity");
  assert.equal(disk.tasks.find((t) => t.id === "task-g4-old").model, "", "钉过 Claude 模型的，模型应置空");
  assert.equal(disk.tasks.find((t) => t.id === "task-g4-ok").provider, "antigravity", "本来就在 antigravity 的任务不动");
  assert.equal(disk.tasks.find((t) => t.id === "task-g4-ok").model, "gemini-4-neon");
  assert.equal(disk.tasks.find((t) => t.id === "task-g4-follow").provider, "", "跟随的任务不动");
  assert.deepEqual(migrateHiddenTaskPins(), [], "第二次迁移应无事可做");
});
