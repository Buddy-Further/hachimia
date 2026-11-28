// 跨片遗留 C9-2 / C5-2：run.mjs 的 ACP 轮后接线。
// C9-2：未设压缩线时 ACP 模式也要按 defaultAcpCompactLine（窗口八成、留 40k）触发压缩。
// C5-2：ACP 轮结束后把 usage_update.size（context_window）喂给 learnWindow，
//   否则纯 agy 模式窗口永远学不到。密钥、模型名全是 fixture。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import { providerById } from "../gw/providers.mjs";
import { withWindows } from "../gw/models.mjs";
import { acpAutoCompactLine, feedAcpWindow } from "../gw/run.mjs";

test("C9-2：未设压缩线时 ACP 默认线按窗口八成算（200k→160k、128k→88k）", () => {
  const p = providerById("antigravity");
  assert.equal(acpAutoCompactLine(200000, p), 160000);
  assert.equal(acpAutoCompactLine(128000, p), 88000);
  assert.equal(acpAutoCompactLine(1000000, p), 800000);
  assert.equal(acpAutoCompactLine(1048576, p), 838000, "C 片口径：1MiB 窗口→838000");
  assert.equal(acpAutoCompactLine(0, p), null, "窗口未知时没有默认线");
});

test("C9-2：用户显式设了压缩线时与 compactLineOf 同口径（未知窗口留原值、已知窗口取 min）", () => {
  const prev = SETTINGS.autoCompactWindow;
  const p = providerById("antigravity");
  try {
    SETTINGS.autoCompactWindow = 120000;
    assert.equal(acpAutoCompactLine(200000, p), 120000, "显式值低于窗口时以用户值为准");
    SETTINGS.autoCompactWindow = 500000;
    assert.equal(acpAutoCompactLine(0, p), 500000, "未知窗口时保留用户设的值");
    assert.equal(acpAutoCompactLine(200000, p), 200000, "显式值大于模型窗口时按窗口截断，与展示侧一致");
  } finally {
    if (prev === undefined) delete SETTINGS.autoCompactWindow;
    else SETTINGS.autoCompactWindow = prev;
  }
});

test("C5-2：ACP 轮的 context_window 能喂给 learnWindow，之后 withWindows 认得", () => {
  const modelId = "fix-x-agy-window-model";
  assert.equal(feedAcpWindow({ model: modelId, contextWindow: 200000, provider: providerById("antigravity") }), true);
  const got = withWindows([{ id: modelId, context_window: 0 }]);
  assert.equal(got[0].context_window, 200000, "200k 窗口应被学到并补进清单");
});

test("C5-2：窗口/模型缺失时不投喂", () => {
  assert.equal(feedAcpWindow({ model: "fix-x-agy-window-model", contextWindow: 0, provider: providerById("antigravity") }), false);
  assert.equal(feedAcpWindow({ model: "", contextWindow: 200000, provider: providerById("antigravity") }), false);
  assert.equal(feedAcpWindow({ model: null, contextWindow: 200000, provider: providerById("antigravity") }), false);
});
