// hachimia 模型拉取回归（reg-models）F-4：
//   模型区域文案残留——“接口与型号”页与 /model 回复还写着“由 claude 决定”，
//   实际决定模型的是 Antigravity CLI。只改文案与注释，不动逻辑。
//   旧串是 i18n 的 key（t(...)），改 key 必须同步九语词典，否则旧 key 译文变孤儿。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 旧串（模型决定类）——这 6 个源串的旧版；新串在各文件里应原样出现
const OLD_KEYS = [
  "（默认，由 claude 决定）",
  "（默认，由 claude 按模型决定）",
  "没指定模型 → <b>由 claude 自己决定</b>（官方账户当前默认 <code>{model}</code>）。",
  "claude 内置默认",
  "该厂商由 claude 自己决定模型，没有可切换的清单。要指定就改 <code>ccapp-providers.json</code> 的 <code>defaultModel</code>。",
  "没设，交给 claude 按窗口决定",
];
const NEW_KEYS = [
  "（默认，由 Antigravity 决定）",
  "（默认，由 Antigravity 按模型决定）",
  "没指定模型 → <b>由 Antigravity 自己决定</b>（官方账户当前默认 <code>{model}</code>）。",
  "Antigravity 内置默认",
  "该厂商由 Antigravity 自己决定模型，没有可切换的清单。要指定就改 <code>ccapp-providers.json</code> 的 <code>defaultModel</code>。",
  "没设，由 Antigravity 按模型窗口决定",
];

test("F-4 模型能力页不再出现“由 claude 决定”类文案", () => {
  const fe = read("gateway/web/app/12-model-caps.js");
  for (const k of OLD_KEYS) assert.ok(!fe.includes(k), `12-model-caps.js 仍有旧串：${k}`);
  for (const k of NEW_KEYS) assert.ok(fe.includes(k), `12-model-caps.js 缺新串：${k}`);
  // 注释里的同类残留（压缩线滑块）也应同步
  assert.ok(!fe.includes("没设 = 交给 claude"), "滑块注释仍写交给 claude");
  assert.ok(fe.includes("没设 = 交给 Antigravity"), "滑块注释应写交给 Antigravity");
  assert.ok(!fe.includes("claude 只认 100k"), "滑块注释仍写 claude 只认 100k");
});

test("F-4 /model 回复与网关注释：:138 改、:91 不动、claude.mjs 注释改", () => {
  const cmd = read("gateway/gw/modelcmd.mjs");
  assert.ok(!cmd.includes("原生厂商由 claude 自己决定模型"), "modelcmd.mjs:138 仍是 claude 口径");
  assert.ok(cmd.includes("原生厂商由 Antigravity 自己决定模型"), "modelcmd.mjs:138 应是 Antigravity 口径");
  assert.ok(cmd.includes("默认（由 Antigravity 按模型窗口决定）"), "modelcmd.mjs:91 的 Antigravity 口径不应被动");
  const cl = read("gateway/gw/claude.mjs");
  assert.ok(!cl.includes("交给 claude 自己决定默认模型"), "claude.mjs:311 仍是 claude 口径");
  assert.ok(!cl.includes("让 claude 自己按窗口比例决定"), "claude.mjs:353 仍是 claude 口径");
  assert.ok(cl.includes("交给 Antigravity 自己决定默认模型"), "claude.mjs:311 应是 Antigravity 口径");
  assert.ok(cl.includes("让 Antigravity 自己按窗口比例决定"), "claude.mjs:353 应是 Antigravity 口径");
});

test("F-4 i18n：旧 key 已清、新 key 九语齐全、无孤儿", () => {
  const en = read("gateway/web/lang-en.js");
  for (const k of OLD_KEYS) assert.ok(!en.includes(`"${k}"`), `lang-en.js 仍有旧 key：${k}`);
  for (const k of NEW_KEYS) assert.ok(en.includes(`"${k}"`), `lang-en.js 缺新 key：${k}`);
  // 英文值也同步（旧英文值不应残留）
  assert.ok(!en.includes("claude decides"), "lang-en.js 仍有 claude decides");
  assert.ok(!en.includes("claude's built-in default"), "lang-en.js 仍有 claude's built-in default");
  assert.ok(!en.includes("lets claude pick the model"), "lang-en.js 仍有 lets claude pick");
  for (const lang of ["ar", "es", "fr", "id", "ja", "ko", "ru", "zh-Hant"]) {
    const dict = read(`gateway/web/lang-${lang}.js`);
    assert.ok(dict.includes("（默认，由 Antigravity 决定）"), `lang-${lang}.js 缺新 key（默认，由 Antigravity 决定）`);
    assert.ok(!dict.includes("由 claude 决定"), `lang-${lang}.js 仍有“由 claude 决定”`);
    assert.ok(!dict.includes("claude 自己决定"), `lang-${lang}.js 仍有“claude 自己决定”`);
    // txt 才是源头：6 条对应序号行的译文都应含 Antigravity、不含 claude
    const txt = read(`i18n/lang-${lang}.txt`);
    for (const n of [188, 189, 193, 194, 196, 1850]) {
      const line = txt.split("\n").find((l) => l.startsWith(`${n}\t`));
      assert.ok(line, `lang-${lang}.txt 缺序号 ${n}`);
      assert.ok(line.includes("Antigravity"), `lang-${lang}.txt:${n} 译文未同步 Antigravity`);
      assert.ok(!line.includes("claude"), `lang-${lang}.txt:${n} 译文仍有 claude`);
    }
  }
});
