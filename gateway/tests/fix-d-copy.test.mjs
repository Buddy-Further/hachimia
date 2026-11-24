// D-04 / D-07 / D-08 / D-09：文案与仓库地址残留（文件内容断言）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ── D-04：java-en.json ──
test("D-04 java-en.json 更新通知与相关文案不写 cccodroid / Claude Code", () => {
  const d = JSON.parse(read("android/assets/i18n/java-en.json"));
  assert.equal(Object.keys(d).length, 573); // 568 基线 + A11y 隐私拦截 3 键 + 恢复初始设置简明化同步净增 2 键 = 573
  for (const [k, v] of Object.entries(d)) {
    assert.doesNotMatch(String(k), /cccodroid/, `键仍含 cccodroid: ${JSON.stringify(k)}`);
    assert.doesNotMatch(String(k), /Claude Code/, `键仍含 Claude Code: ${JSON.stringify(k)}`);
    assert.doesNotMatch(String(v), /cccodroid/, `键 ${JSON.stringify(k)} 的英文值仍含 cccodroid: ${JSON.stringify(v)}`);
    assert.doesNotMatch(String(v), /Claude Code/, `键 ${JSON.stringify(k)} 的英文值仍含 Claude Code: ${JSON.stringify(v)}`);
  }
  // 活键改名（rem/copy）：旧键已不存在，新键与 Updater.java:467 的调用一致
  assert.equal(d["来自 hachimia.net 镜像"], "from the hachimia.net mirror");
  assert.equal(d[" · 来自 hachimia.net 镜像"], " · from the hachimia.net mirror");
  assert.equal(d["来自 cccodroid.net 镜像"], undefined);
  assert.equal(d[" · 来自 cccodroid.net 镜像"], undefined);
  assert.equal(d["hachimia 已更新到 v{0}"], "hachimia updated to v{0}");
  assert.match(d["hachimia 已更新到 v{0}（系统不让它在后台自己启动）"], /^hachimia updated to v\{0\}/);
});

// ── D-07：两份 README ──
for (const f of ["README.md", "README.zh-CN.md"]) {
  test(`D-07 ${f} 是 hachimia 的 README，不再是 cccodroid`, () => {
    const s = read(f);
    assert.doesNotMatch(s, /cccodroid/i);
    assert.doesNotMatch(s, /greyoak111\/cccodroid/);
    assert.doesNotMatch(s, /Claude Code/);
    assert.doesNotMatch(s, /downloads\.claude\.ai/);
    assert.match(s, /Buddy-Further\/hachimia/);
    assert.match(s, /hachimia\.apk/);
    assert.match(s, /D3:41:C3:91:A8:25:BB:B7:30:39:7F:00:9F:7B:82:54:B9:7A:00:DB:57:CA:E2:54:FA:14:AA:3A:2F:F4:5A:48/);
    assert.doesNotMatch(s, /B7:03:61:59/);
  });
}
test("D-07 README 标题与下载链接指向 hachimia", () => {
  assert.match(read("README.md"), /^# hachimia/m);
  assert.match(read("README.md"), /github\.com\/Buddy-Further\/hachimia\/releases\/latest\/download\/hachimia\.apk/);
  assert.match(read("README.zh-CN.md"), /^# hachimia/m);
  assert.match(read("README.zh-CN.md"), /github\.com\/Buddy-Further\/hachimia\/releases\/latest\/download\/hachimia\.apk/);
});

// ── D-08：仓库地址 greyoak111/hachimia → Buddy-Further/hachimia ──
const REPO_FILES = [
  "android/java/ha/chi/mia/Updater.java",
  "gateway/gw/ccverified.mjs",
  "gateway/gw/notices.mjs",
  "devkit-pin.json",
  "devkit-sources.txt",
  "scripts/release.sh",
  "scripts/ship.mjs",
  "scripts/changelog.mjs",
  "gateway/web/app/15-pages.js",
  "HACHIMIA-MIGRATION.md",
  ".github/ISSUE_TEMPLATE/config.yml",
];
for (const f of REPO_FILES) {
  test(`D-08 ${f} 指向 Buddy-Further/hachimia`, () => {
    const s = read(f);
    assert.doesNotMatch(s, /greyoak111\/hachimia/, `${f} 仍指 greyoak111/hachimia`);
    assert.match(s, /Buddy-Further\/hachimia/, `${f} 应含 Buddy-Further/hachimia`);
  });
}
test("D-08 publish-devkit.mjs 已随发版前置统一到 Buddy-Further（rem/release-prep）", () => {
  // 发版前置条件 2 要求三处地址统一：publish-devkit.mjs:30 的 REPO 已改为 Buddy-Further；
  // 仅 git 提交身份（user.name=greyoak111，维护者个人身份）保留，未动
  assert.match(read("scripts/publish-devkit.mjs"), /const REPO = "Buddy-Further\/hachimia"/);
  assert.doesNotMatch(read("scripts/publish-devkit.mjs"), /greyoak111\/hachimia/);
});

// ── D-09：用户可见文案残留 ──
test("D-09 诊断包确认框写 hachimia / Antigravity，不写 cccodroid / Claude", () => {
  const s = read("gateway/web/app/08-extensions.js");
  assert.doesNotMatch(s, /版本与设备：cccodroid/);
  assert.doesNotMatch(s, /你发给 Claude 的消息内容/);
  assert.match(s, /导出诊断包并调用系统分享？\\n\\n包含：版本与机型、工具包与自检状态、近期脱敏日志、修复账本、网络连通结果。\\n不含：密钥、凭据、邮箱、消息正文与会话记录。/);
  assert.doesNotMatch(s, /重新安装 Claude Code/);
  assert.match(s, /重新安装 Antigravity CLI \(agy\)/);
});

test("D-09 「全部放行」确认框写 Antigravity", () => {
  const s = read("gateway/web/app/03-perm-status.js");
  assert.doesNotMatch(s, /Claude 将不再询问/);
  assert.match(s, /Antigravity 将不再询问/);
  // 新键的英文译文在 lang-en.js 里（D-05 词典批次补）；旧键当时变孤儿留在词典里——
  // 删键会让之后所有键的序号前移，必须同步重写 txt（D-05 的教训），mig/residue 的 C-01
  // 已用 mig-c01-sweep.mjs 批量删掉全部孤儿键并重排（3129 键，0 孤儿），此后只许末尾追加
  const enSrc = read("gateway/web/lang-en.js");
  assert.match(enSrc, /Antigravity 将不再询问，可以直接改写、删除文件，运行任意命令，访问网络/);
  assert.match(enSrc, /Antigravity will stop asking/);
});

test("D-09 网关报错文案不指 cccodroid / Claude Code", () => {
  assert.doesNotMatch(read("gateway/gw/run.mjs"), /打开 cccodroid 发一条消息/);
  assert.match(read("gateway/gw/run.mjs"), /打开 hachimia 发一条消息/);
  assert.doesNotMatch(read("gateway/gw/run.mjs"), /Claude Code 程序和官方签名清单对不上/);
  assert.doesNotMatch(read("gateway/gw/run.mjs"), /这个版本的 Claude Code 还没有官方签名清单/);
  assert.match(read("gateway/gw/run.mjs"), /Antigravity CLI 程序和官方签名清单对不上/);
  assert.doesNotMatch(read("gateway/gw/reconcile.mjs"), /找不到 Claude Code 程序/);
  assert.doesNotMatch(read("gateway/gw/reconcile.mjs"), /重装 Claude Code/);
  assert.match(read("gateway/gw/reconcile.mjs"), /找不到 Antigravity CLI/);
  assert.doesNotMatch(read("gateway/gw/gwpin.mjs"), /这一轮没有启动 Claude Code/);
  assert.match(read("gateway/gw/gwpin.mjs"), /这一轮没有启动 Antigravity CLI/);
  assert.doesNotMatch(read("gateway/gw/backfill.mjs"), /Claude Code 的用户级配置/);
  assert.match(read("gateway/gw/backfill.mjs"), /Antigravity CLI 的用户级配置/);
});
