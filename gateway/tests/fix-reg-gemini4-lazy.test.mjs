// F-G4-3 懒迁移：迁移不在模块顶层跑，首次读会话记录时才跑。
// 单独成文件——本文件静态只 import node 内置模块，夹具与 agy-only 环境先摆好，
// 再动态 import，且 providers.mjs 先于 sessmodel.mjs 被 import（当初 TDZ 崩溃的
// 顺序：providers → models → sessmodel，顶层调 providerById 时 providers 的
// `let PROVIDER` 还没初始化）。若将来有人把迁移改回顶层调用，本测试即复现崩溃。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fix-reg-gemini4-lazy-"));
const fakeAgy = path.join(tmpRoot, "agy");
fs.writeFileSync(fakeAgy, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
// 注意：必须在 import config 之前先把环境变量摆好（PATHS 在 import 时快照），见 fix-a-agyonly。
process.env.CCAPP_AGY = fakeAgy;
delete process.env.CCAPP_CLAUDE;

const { CFG, PATHS } = await import("../gw/config.mjs");
const SESS_FILE = path.join(CFG.home, "ccapp-session-models.json");
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(SESS_FILE, { force: true });
});

test("F-G4-3 懒迁移：providers 先 import 也不撞暂时性死区，首次读记录时才迁移", async () => {
  assert.equal(fs.existsSync(PATHS.claude), false, "本用例要求测试环境里没有独立的 claude 二进制");
  // 夹具先写好：一个钉 anthropic 的旧会话，一个本来就在 antigravity 的会话
  fs.writeFileSync(SESS_FILE, JSON.stringify({
    "sess-g4-lazy-old": { model: "claude-opus-5-5", effort: null, provider: "anthropic", at: 1 },
    "sess-g4-lazy-ok": { model: "gemini-4-neon", effort: null, provider: "antigravity", at: 2 },
  }));
  // providers 先 import（TDZ 崩溃的顺序）：若迁移还在模块顶层，这里即抛
  // ReferenceError: Cannot access 'PROVIDER' before initialization。
  const prov = await import("../gw/providers.mjs");
  assert.equal(prov.isAgyOnlyMode(), true, "本用例应在 agy-only 模式下跑");
  // import 完成时迁移还没跑：落盘文件仍是旧钉选（懒迁移的证明）
  assert.equal(JSON.parse(fs.readFileSync(SESS_FILE, "utf8"))["sess-g4-lazy-old"].provider, "anthropic",
    "import 完成时迁移不得已跑（懒迁移）");
  // 首次读记录时迁移：
  const { effectiveModel, sessModel } = await import("../gw/sessmodel.mjs");
  assert.equal(sessModel("sess-g4-lazy-old").provider, "antigravity", "首次读记录时旧会话应已迁到 antigravity");
  assert.equal(sessModel("sess-g4-lazy-old").model, "", "迁移应把模型置空（接口默认）");
  assert.equal(effectiveModel("sess-g4-lazy-old").provider, "antigravity");
  assert.equal(sessModel("sess-g4-lazy-ok").provider, "antigravity", "本来就在 antigravity 的会话不动");
  assert.equal(sessModel("sess-g4-lazy-ok").model, "gemini-4-neon");
  // 落盘：重读文件也应是迁后的值
  const disk = JSON.parse(fs.readFileSync(SESS_FILE, "utf8"));
  assert.equal(disk["sess-g4-lazy-old"].provider, "antigravity");
  assert.equal(disk["sess-g4-lazy-old"].model, "");
});
