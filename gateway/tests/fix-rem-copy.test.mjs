// rem/copy：条件 3（D-09/D-04 文案残留）——12 处用户可见残留 + 顺带清理。
// 断言口径与评分一致：只算用户可见处。词典孤儿键、注释、兼容性产品名判断、
// 真实磁盘路径不在此列；路径绑定的 3 处（见下）因需真实路径迁移而有意未改，
// 本文件如实断言其现状，不假装已修。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ── 11-usage.js（评分新发现 4 处 + 审查 1 处）──
test("rem/copy 11-usage.js 月报标题/页脚/导出文件名不再写 cccodroid", () => {
  const s = read("gateway/web/app/11-usage.js");
  assert.doesNotMatch(s, /cccodroid/);
  assert.match(s, /text\("hachimia · " \+ t\("使用月报"\)/);
  assert.match(s, /text\("hachimia\.net"/);
  assert.match(s, /"hachimia-usage-" \+ usDayKey/);
  assert.match(s, /`hachimia-usage-\$\{y\}/);
  assert.match(s, /t\("这个版本没有原生层，只记 CPU 时间（电量、亮屏要 hachimia）。"\)/);
});

// ── 08-extensions.js:1115 ──
test("rem/copy 08-extensions.js:1115 npx 提示写 hachimia 的工具包", () => {
  const s = read("gateway/web/app/08-extensions.js");
  assert.match(s, /t\("要 npx（hachimia 的工具包里有）"\)/);
  assert.doesNotMatch(s, /要 npx（cccodroid 的工具包里有）/);
});

// ── 04-session-flow.js:695 / 19-boot.js:267-268 ──
// 外来网关场景下对方应用归属未知：不硬编码 cccodroid，也不硬编码 hachimia，
// 只说“请在应用里打开”（网关只能在宿主应用的 WebView 里打开，归属无关都成立）。
test("rem/copy 外来网关提示不写应用名：请在应用里打开", () => {
  const flow = read("gateway/web/app/04-session-flow.js");
  const boot = read("gateway/web/app/19-boot.js");
  assert.match(flow, /t\("请在应用里打开"\)/);
  assert.match(boot, /t\("请在应用里打开"\)/);
  assert.doesNotMatch(flow, /请在 cccodroid 应用里打开/);
  assert.doesNotMatch(boot, /请在 cccodroid 应用里打开/);
});

// ── 04-session-flow.js:1126 ──
test("rem/copy 04-session-flow.js:1126 封印失败提示写 Antigravity CLI", () => {
  const s = read("gateway/web/app/04-session-flow.js");
  assert.match(s, /t\("Antigravity CLI 程序被改过，已拒绝启动；"\)/);
  assert.doesNotMatch(s, /Claude Code 程序被改过/);
});

// ── 10b-storage.js:63 ──
test("rem/copy 10b-storage.js:63 存储卡片写 Antigravity CLI 杂物", () => {
  const s = read("gateway/web/app/10b-storage.js");
  assert.match(s, /t\("Antigravity CLI 杂物"\)/);
  assert.doesNotMatch(s, /Claude Code 杂物/);
});

// ── Priv.java:188 ──
test("rem/copy Priv.java:188 通知栏默认标题写 hachimia", () => {
  const s = read("android/java/ha/chi/mia/Priv.java");
  assert.match(s, /setContentTitle\(text == null \|\| text\.isEmpty\(\) \? "hachimia" : text\)/);
  assert.doesNotMatch(s, /\? "cccodroid" : text\)/);
});

// ── Updater.java:467 + java 词典活键 ──
test("rem/copy Updater.java:467 用 hachimia.net 镜像活键", () => {
  const s = read("android/java/ha/chi/mia/Updater.java");
  assert.match(s, /Tr\.t\("来自 hachimia\.net 镜像"\)/);
  assert.match(s, /Tr\.t\(" · 来自 hachimia\.net 镜像"\)/);
  assert.doesNotMatch(s, /来自 cccodroid\.net 镜像/);
});

// ── java-*.json 九语：活键改名 + 死键删除 + 其余 8 语值里的 cccodroid（573 基线清理 23 废键 = 550）──
test("rem/copy java-*.json 九语 550 键一致，键与值均无 cccodroid / Claude Code", () => {
  const langs = ["ar", "en", "es", "fr", "id", "ja", "ko", "ru", "zh-Hant"];
  const dicts = langs.map((l) => JSON.parse(read(`android/assets/i18n/java-${l}.json`)));
  for (const d of dicts) assert.equal(Object.keys(d).length, 550);
  const base = Object.keys(dicts[1]).sort();
  for (const d of dicts) assert.deepEqual(Object.keys(d).sort(), base);
  for (const d of dicts) {
    for (const [k, v] of Object.entries(d)) {
      assert.doesNotMatch(k, /cccodroid|Claude Code/, `键残留: ${k}`);
      assert.doesNotMatch(String(v), /cccodroid|Claude Code/, `值残留: ${k}`);
    }
  }
});

// ── 18g-lineage-export.js（本轮全量 grep 额外发现，同类导出品牌残留）──
// 前端改名前缀的同时网关 saveExport 白名单须放行新前缀（gw/profile.mjs），否则导出会报 bad_name。
test("rem/copy 18g 脉络导出页脚/文件名写 hachimia，网关白名单放行新前缀", () => {
  const s = read("gateway/web/app/18g-lineage-export.js");
  assert.doesNotMatch(s, /cccodroid/);
  assert.match(s, /"hachimia · " \+ t\("脉络"\)/);
  assert.match(s, /`hachimia-lineage-\$\{lxStamp\(\)\}/);
  assert.match(read("gateway/gw/profile.mjs"), /\/\^\(\?:cccodroid\|hachimia\)-lineage-/);
});

// ── 新 t() 键已进词典（只许追加；旧键曾留作孤儿，mig/residue 的 C-01 已批量清掉，见 fix-d-copy.test.mjs 的说明）──
test("rem/copy 5 条新文案键已追加进 lang-en.js（C-01 重排后为 3122–3126）", () => {
  const s = read("gateway/web/lang-en.js");
  assert.match(s, /"请在应用里打开": "Open this in the app"/);
  assert.match(s, /"要 npx（hachimia 的工具包里有）": "Needs npx \(included in the hachimia toolkit\)"/);
  assert.match(s, /"这个版本没有原生层，只记 CPU 时间（电量、亮屏要 hachimia）。": "This build has no native layer, so only CPU time is recorded \(battery and screen-on need hachimia\)."/);
  assert.match(s, /"Antigravity CLI 程序被改过，已拒绝启动；": "The Antigravity CLI program was modified and was not started; "/);
  assert.match(s, /"Antigravity CLI 杂物": "Antigravity CLI housekeeping files"/);
});

// ── 路径绑定的 3 处：有意未改（需真实路径迁移，见 rem-copy.md），如实断言现状 ──
test("rem/copy 路径绑定 3 处未改：仍指真实磁盘路径，需路径迁移时再动", () => {
  const ext = read("gateway/web/app/08-extensions.js");
  const st = read("gateway/web/app/10b-storage.js");
  assert.match(ext, /(?:模型放在|存放在) \/sdcard\/cccodroid\/models/);
  assert.match(st, /组件的运行数据（~\/\.cccodroid）/);
  assert.match(st, /共享目录 \/sdcard\/cccodroid/);
});

// ── 双路径歧义 10b-storage.js:74：装着的 Claude 二进制版本号，有意未动 ──
test("rem/copy 10b-storage.js:74 双路径行未动（指已装 Claude 二进制版本）", () => {
  assert.match(read("gateway/web/app/10b-storage.js"), /"Claude Code " \+ v\.version/);
});
