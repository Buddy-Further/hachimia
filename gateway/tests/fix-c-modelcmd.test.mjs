// C10 / C15（modelcmd.mjs）：/autocompact 三处数值一致、/model 档位回退不打 `null`。
// 不写厂商配置文件：C10 用默认厂商（fallback 清单即可）；C15 用 upsertProvider 建一个
// 无 key 的自定义厂商并钉到会话上（只改会话，不改全局 active；和 daily-v063 同款做法）。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

let savedSettings = null;
after(async () => {
  const { SETTINGS, saveSettings } = await import("../gw/settings-store.mjs");
  if (savedSettings) {
    SETTINGS.model = savedSettings.model;
    SETTINGS.effort = savedSettings.effort;
    SETTINGS.autoCompactWindow = savedSettings.autoCompactWindow;
    saveSettings();   // 写回磁盘：共用池 home，别把改过的压缩线留给别的测试文件
  }
});
async function settings() {
  const { SETTINGS } = await import("../gw/settings-store.mjs");
  if (!savedSettings) savedSettings = { model: SETTINGS.model, effort: SETTINGS.effort, autoCompactWindow: SETTINGS.autoCompactWindow };
  return SETTINGS;
}

// ── C10（P2）：/autocompact 50k 三处数值不一致 ──
test("C10：/autocompact 50k 按 100k 下限钳制并如实回复，存的值与生效值一致", async () => {
  const { handleLocalCommand } = await import("../gw/modelcmd.mjs");
  const { effectiveAutoCompact } = await import("../gw/stream.mjs");
  const SETTINGS = await settings();
  SETTINGS.model = null;
  SETTINGS.effort = null;
  SETTINGS.autoCompactWindow = null;
  let out = "";
  await handleLocalCommand("autocompact", "50k", (t) => { out = t; }, null);
  assert.equal(SETTINGS.autoCompactWindow, 100000, "存进设置的值应是钳制后的 100k");
  assert.equal(effectiveAutoCompact(), 100000, "生效值应与存的值一致");
  assert.ok(out.includes("已设为 **100k"), "回复应写实际生效的 100k，而不是用户填的 50k：" + out);
  assert.ok(!out.includes("已设为 **50k"), "回复不得谎称设成了 50k");
  assert.ok(out.includes("50k"), "应告诉用户填的值被钳制了");
  let out2 = "";
  await handleLocalCommand("autocompact", "2m", (t) => { out2 = t; }, null);
  assert.equal(SETTINGS.autoCompactWindow, 1000000, "2m 应按 1M 上限钳制");
  assert.ok(out2.includes("已设为 **1M"), "回复应写实际生效的 1M：" + out2);
});

// ── C15（P2）：/model 切换档位时回复文案打出 `null` ──
test("C15：/model 切到不支持当前 effort 的模型时，回复不得出现 `null`", async () => {
  const { handleLocalCommand } = await import("../gw/modelcmd.mjs");
  const { upsertProvider } = await import("../gw/providers.mjs");
  const { setSessModel } = await import("../gw/sessmodel.mjs");
  const { normEffort } = await import("../gw/models.mjs");
  await settings();
  // 前置：normEffort 在档位不支持且无 default_level 时返回 null（根因一半）
  assert.equal(normEffort({ id: "m-low", effort: { supported_levels: ["low"], default_level: null } }, "max", { nativeModels: false, group: "third" }), null);
  // 内嵌清单的自定义厂商：m-low 只支持 low、default_level 为 null（上游给了不在档位表里的值）
  const inline = { data: [
    { id: "m-low", name: "M Low", context_window: 200000, effort: { supported_levels: ["low"], default_level: "bogus" } },
    { id: "m-big", name: "M Big", context_window: 200000, effort: { supported_levels: ["low", "high"], default_level: "high" } },
  ] };
  const created = upsertProvider(null, {
    label: "Fixture C15", baseUrl: "https://fixture.example.invalid/anthropic",
    modelsUrl: "data:application/json," + encodeURIComponent(JSON.stringify(inline)),
    defaultModel: "m-low", fastModel: "m-low",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  // 会话钉在这家、模型 m-low、effort 是 m-low 不支持的 max
  const sid = crypto.randomUUID();
  setSessModel(sid, { provider: created.id, model: "m-low", effort: "max" });
  let out = "";
  await handleLocalCommand("model", "m-low", (t) => { out = t; }, sid);
  assert.ok(out.includes("已切换到 **m-low**"), "应正常切换：" + out);
  assert.ok(!out.includes("`null`"), "回复不得打出 `null`：" + out);
  assert.ok(/默认|清除/.test(out), "应说明 effort 回到了默认/被清除：" + out);
});
