// mig/residue：迁移收尾 R-01–R-13、C-01–C-06、HACHIMIA-MIGRATION 端口笔误。
// 先写红、再修绿。口径：只算用户可见处与行为影响处；B-02 真实磁盘路径、
// B-07 格式名/标记名/协议名/二进制名、历史引用不在此列，有意未改的在下面如实断言现状。
// R-02（notices.json）因签名钥匙不在本机而有意未改：下面只断言签名仍有效，
// 任何无重签的改动都会让这条变红。
import "../gw/config.mjs"; // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// ── R-01 应用内帮助全文 ──
test("R-01 help/zh.md 不再写 cccodroid / 官方原版 Claude Code / cccodroid.net，写 hachimia 与 Antigravity", () => {
  const s = read("gateway/web/help/zh.md");
  // 唯一允许的 cccodroid 是真实磁盘路径 .cccodroid/agents/（子代理交代/汇报存放处）
  assert.equal((s.match(/cccodroid/g) || []).length, 1, "cccodroid 只应剩 .cccodroid/agents/ 一处");
  assert.match(s, /\.cccodroid\/agents\//);
  assert.doesNotMatch(s, /官方原版 Claude Code/);
  assert.doesNotMatch(s, /cccodroid\.net/);
  assert.match(s, /# hachimia 使用帮助/);
  assert.match(s, /hachimia\.apk/);
  assert.match(s, /hachimia-36\.apk/);
  assert.match(s, /Antigravity/);
  assert.match(s, /GitHub/);
  assert.doesNotMatch(s, /账户登录由 Claude Code 自己完成/);
});

test("R-01 help/en.md 不再写 cccodroid / official, unmodified Claude Code / cccodroid.net", () => {
  const s = read("gateway/web/help/en.md");
  // 唯一允许的 cccodroid 是真实磁盘路径 .cccodroid/agents/
  assert.equal((s.match(/cccodroid/g) || []).length, 1, "cccodroid 只应剩 .cccodroid/agents/ 一处");
  assert.match(s, /\.cccodroid\/agents\//);
  assert.doesNotMatch(s, /official, unmodified Claude Code/);
  assert.doesNotMatch(s, /cccodroid\.net/);
  assert.match(s, /# hachimia help/);
  assert.match(s, /hachimia\.apk/);
  assert.match(s, /hachimia-36\.apk/);
  assert.match(s, /Antigravity/);
});

// ── R-02 活通知文件：钥匙不在本机，不改内容，只守签名 ──
test("R-02 notices.json 签名仍有效（无钥匙改了就失效，整个通知源都会被拒）", () => {
  const pubPem = /-----BEGIN PUBLIC KEY-----\\n([A-Za-z0-9+/=]+)\\n/.exec(read("gateway/gw/notices.mjs"))[1];
  const pub = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----\n${pubPem}\n-----END PUBLIC KEY-----\n`);
  const body = fs.readFileSync(path.join(ROOT, "notices/notices.json"));
  const sig = fs.readFileSync(path.join(ROOT, "notices/notices.json.sig"), "utf8").trim();
  assert.equal(crypto.verify(null, body, pub, Buffer.from(sig, "base64")), true);
});

test("R-02b claude-code/verified.json 签名有效（与 notices.mjs 正式公钥配套）", () => {
  const pubPem = /-----BEGIN PUBLIC KEY-----\\n([A-Za-z0-9+/=]+)\\n/.exec(read("gateway/gw/notices.mjs"))[1];
  const pub = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----\n${pubPem}\n-----END PUBLIC KEY-----\n`);
  const body = fs.readFileSync(path.join(ROOT, "claude-code/verified.json"));
  const sig = fs.readFileSync(path.join(ROOT, "claude-code/verified.json.sig"), "utf8").trim();
  assert.equal(crypto.verify(null, body, pub, Buffer.from(sig, "base64")), true);
});

// ── R-03 发布脚本 SITE ──
test("R-03 notice/claude-verified 的 SITE 与运行时取数地址一致（raw.githubusercontent.com/Buddy-Further/hachimia/main/…）", () => {
  assert.match(read("scripts/notice.mjs"), /const SITE = "https:\/\/raw\.githubusercontent\.com\/Buddy-Further\/hachimia\/main\/notices\/notices\.json"/);
  assert.match(read("scripts/claude-verified.mjs"), /const SITE = "https:\/\/raw\.githubusercontent\.com\/Buddy-Further\/hachimia\/main\/claude-code\/verified\.json"/);
  assert.doesNotMatch(read("scripts/notice.mjs"), /cccodroid\.net/);
  assert.doesNotMatch(read("scripts/claude-verified.mjs"), /cccodroid\.net/);
  const pub = read("scripts/signed-pub.mjs");
  assert.doesNotMatch(pub, /cccodroid\.net/);
  assert.doesNotMatch(pub, /cccodroid-site\.service/);
  assert.match(pub, /GitHub raw/);
});

// ── R-04/R-05/R-06 网关报错文案 + 新词典键 ──
test("R-04 sealBlockMessage 写 hachimia（旧键退役，新键进词典）", () => {
  assert.match(read("gateway/gw/seal.mjs"), /hachimia 不加载它们/);
  assert.doesNotMatch(read("gateway/gw/seal.mjs"), /cccodroid 不加载它们/);
  assert.match(read("gateway/web/lang-en.js"), /hachimia 不加载它们/);
});

test("R-05 自定义组件撞名报错写 hachimia", () => {
  assert.match(read("gateway/gw/custom.mjs"), /tz\("命令 \{c\} 是系统或 hachimia 自带的，换个名字"/);
  assert.doesNotMatch(read("gateway/gw/custom.mjs"), /系统或 cccodroid 自带的/);
  assert.match(read("gateway/web/lang-en.js"), /是系统或 hachimia 自带的/);
});

test("R-06 会话包导入报错写 hachimia，格式标识 cccodroid-sessions 保持不变", () => {
  const s = read("gateway/gw/sessionops.mjs");
  assert.match(s, /tz\("不是 hachimia 会话包"\)/);
  assert.doesNotMatch(s, /不是 cccodroid 会话包/);
  assert.match(s, /format: "cccodroid-sessions"/);
  assert.match(s, /manifest\.format !== "cccodroid-sessions"/);
  assert.match(read("gateway/web/lang-en.js"), /不是 hachimia 会话包/);
});

// ── R-07 内置 hook 的 git 身份 ──
test("R-07 内置 hook 脚本的 git 身份是 hachimia，5 个头注释同步", () => {
  const s = read("gateway/gw/extensions.mjs");
  assert.match(s, /user\.name=hachimia/);
  assert.match(s, /autosave@hachimia\.local/);
  assert.doesNotMatch(s, /user\.name=cccodroid/);
  assert.doesNotMatch(s, /autosave@cccodroid\.local/);
  assert.equal((s.match(/\/\/ hachimia 内置 hook/g) || []).length, 5);
});

// ── R-08 终端包装与 guard 前缀 ──
test("R-08 cc-seal.mjs 终端前缀写 hachimia，不写 cccodroid", () => {
  const s = read("gateway/guard/cc-seal.mjs");
  assert.doesNotMatch(s, /cccodroid: /);
  assert.match(s, /hachimia: 这个版本还没有官方签名清单/);
  assert.match(s, /hachimia: \$\{flag\} 在发行版里不能用/);
});

test("R-08 guard 协议前缀与 run.mjs 同步改成 hachimia-guard，拒写句同步", () => {
  assert.match(read("gateway/guard/cc-guard.mjs"), /hachimia-guard\|\$\{b\.cat\}\|\$\{b\.what\}\. hachimia refuses to write this/);
  assert.match(read("gateway/guard/cc-guard.mjs"), /hachimia-guard\|\$\{r\.cat\}\|\$\{r\.what\}/);
  assert.doesNotMatch(read("gateway/guard/cc-guard.mjs"), /cccodroid-guard/);
  assert.doesNotMatch(read("gateway/guard/cc-guard.mjs"), /cccodroid refuses to write this/);
  assert.match(read("gateway/gw/run.mjs"), /\^hachimia-guard\\\|/);
  assert.doesNotMatch(read("gateway/gw/run.mjs"), /cccodroid-guard/);
});

// ── R-09 claude 路径模型侧系统提示 ──
test("R-09 claude 路径的模型侧提示写 hachimia，自检二进制名 cccodroid-selftest 不动", () => {
  assert.match(read("gateway/gw/stream.mjs"), /hachimia 不在前台时直接拒绝/);
  assert.match(read("gateway/gw/stream.mjs"), /cccodroid-selftest/);
  assert.match(read("gateway/gw/integrity.mjs"), /changed outside hachimia since your last turn/);
  assert.match(read("gateway/gw/archive.mjs"), /Session archiving \(hachimia\)/);
  assert.match(read("gateway/gw/archive-core.mjs"), /hachimia: the context was just compacted/);
  assert.match(read("gateway/gw/claude.mjs"), /hachimia: the safety check could not be verified/);
  assert.match(read("gateway/archive/cc-archive.mjs"), /not running inside a hachimia session/);
  assert.match(read("gateway/archive/spec.zh.md"), /你在 hachimia 里工作/);
  assert.match(read("gateway/archive/spec.en.md"), /You are working inside hachimia/);
});

// ── R-10 agyEnv PATH ──
test("R-10 agyEnv 的 PATH 含 ~/.cccodroid/bin（方案 a，最小改动）", async () => {
  const { agyEnv } = await import("../gw/claude.mjs");
  const { providerById } = await import("../gw/providers.mjs");
  const { CFG } = await import("../gw/config.mjs");
  const env = agyEnv({ provider: providerById("antigravity"), sync: false });
  const parts = String(env.PATH || "").split(":");
  assert.ok(parts.includes(path.join(CFG.home, ".cccodroid", "bin")), "agyEnv PATH 缺 ~/.cccodroid/bin：" + env.PATH);
  assert.ok(parts.includes(path.join(CFG.home, ".hachimia", "bin")), "agyEnv PATH 仍应含 ~/.hachimia/bin");
});

// ── R-11/R-12/R-13 ──
test("R-11 端侧小模型技能描述写 hachimia，cccodroid:managed 标记与真实路径不动", () => {
  const s = read("gateway/web/skills/local-model-mode/SKILL.md");
  assert.match(s, /帮用户给 hachimia 的「端侧小模型」/);
  assert.match(s, /hachimia 用 llama\.cpp 在手机上跑 GGUF 小模型/);
  assert.match(s, /cccodroid:managed/);
  assert.match(s, /~\/.cccodroid\/local-mode\.json/);
});

test("R-12 Issue 模板问 hachimia 版本", () => {
  assert.match(read(".github/ISSUE_TEMPLATE/device.yml"), /告诉我们 hachimia 在你的机型上用得怎么样/);
  assert.match(read(".github/ISSUE_TEMPLATE/device.yml"), /label: hachimia 版本 \/ Version/);
  assert.match(read(".github/ISSUE_TEMPLATE/bug.yml"), /label: hachimia 版本 \/ Version/);
});

test("R-13 15-pages.js 去掉 Discord 链接；ship.mjs 部署目标明确停用", () => {
  const s = read("gateway/web/app/15-pages.js");
  assert.doesNotMatch(s, /discord\.gg/);
  assert.doesNotMatch(s, /Discord/);
  const ship = read("scripts/ship.mjs");
  assert.match(ship, /已停用/);
  const siteBody = ship.slice(ship.indexOf("async site()"), ship.indexOf("async site()") + 3000);
  assert.ok(siteBody.indexOf("已停用") < siteBody.indexOf("systemctl start"), "停用守卫必须在 systemctl 调用之前");
});

// ── C-01 孤儿键 ──
// 注意：scan.mjs 曾有两处盲区，初版 sweep 按它的孤儿表删键误删了在用的键：
// ① 只登记含汉字的 t() 键，不含汉字的在用键（"API Key"、"{p}：{n}"、"「{n}」{w}"）会被误报成孤儿
//    （由 components-ui 测出）；② 动态查键——t(变量)、sendJson 的 message 翻译、L()/warnRecover()
//    别名、COMMAND_META 的 desc/cat、index.html 内联脚本里的 I18N.t(msg)——静态扫不到，
//    初版 sweep 又误删了 17 个（caps/feedback/queue/commands/fonts/index.html 各处，由全量测试测出）。
// 两处都已修（scan.mjs：无汉字静态键先登记；动态字面量 pass），20 个误删键已按原译文追加回
// 词典末尾（新号 3130–3132、3134–3150），另补了旧扫描同样看不见的缺译键
// "Google Antigravity / Gemini"（09-settings.js:14，#3133）。以下断言把这组回归锁住。
test("C-01 i18n/scan.mjs --all：孤儿键 0，九语仍全译", () => {
  const r = spawnSync(process.execPath, ["i18n/scan.mjs", "--all"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, "scan --all 应 exit 0：\n" + r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /孤儿键/);
  const translated = [...r.stdout.matchAll(/已译 (\d+)\/(\d+)/g)];
  assert.equal(translated.length, 9, "应有九语的已译行：\n" + r.stdout);
  for (const [, a, b] of translated) assert.equal(a, b, `有缺译：已译 ${a}/${b}`);
  const enSrc = read("gateway/web/lang-en.js");
  // 误删后恢复的键：无汉字静态键 3 个 + 动态查键 17 个 + 补的缺译键 1 个
  for (const k of ["API Key", "{p}：{n}", "「{n}」{w}", "Google Antigravity / Gemini",
    "查看或切换模型", "上下文", "压缩对话历史，释放上下文空间",
    "遇到了什么", "做了什么、想要什么结果、实际怎样。截图可以直接拖进来。", "怎么复现",
    "运行状态没保存上（存储可能满了或没有权限）：App 被系统结束时，这一轮可能没法恢复或继续。",
    "上次的运行状态没恢复（记录读不了或格式不对），中断的轮次和排队的消息不会出现；原文件已留底。",
    "名字只能用字母、数字、- 和 _，不超过 40 个字符", "和自带的命令重名了，换个名字",
    "指令内容不能是空的", "指令内容太长了（上限 64 KB）", "已经有同名的指令了",
    "最多导入 10 个字体，先删掉一个再导入", "这是字体集合（.ttc），浏览器用不了；请换成单个的 ttf / otf",
    "不是能用的字体文件，只支持 ttf、otf、woff、woff2", "界面脚本没能加载，点这里重试"]) {
    assert.ok(enSrc.includes(JSON.stringify(k) + ":"), `lang-en.js 应有键 ${k}`);
  }
  assert.doesNotMatch(enSrc, /请在 cccodroid 应用里打开/);
  assert.doesNotMatch(enSrc, /系统或 cccodroid 自带同名命令，换个名字/);
  assert.doesNotMatch(enSrc, /不是 cccodroid 会话包/);
});

// ── C-02 注释类残留（应用名指本应用的改 hachimia；历史/真实路径/二进制名留着）──
test("C-02 应用名注释写 hachimia", () => {
  const checks = [
    ["gateway/web/app/13-nav-menus.js", /再没有就叫 hachimia/],
    ["gateway/web/app/01-core.js", /不在 hachimia 里（开发端、浏览器）时退回下载/],
    ["gateway/web/app/01-core.js", /（hachimia \/ 开发端外壳提供）/],
    ["gateway/web/app/04-session-flow.js", /维护者通知（经 GitHub raw，网关验过签/],
    ["gateway/web/app/19-boot.js", /日志分享靠安卓壳（hachimia）打包/],
    ["gateway/web/app/19-boot.js", /打包诊断、到 GitHub 反馈只有 hachimia 有/],
    ["gateway/web/app/10-settings-device.js", /更新：应用本体 \/ 开发工具包 \/ Antigravity CLI/],
    ["gateway/web/app/08-extensions.js", /以插件「user」交给 Antigravity/],
    ["gateway/gw/access.mjs", /hachimia 的界面因此改走 127\.0\.0\.2/],
    ["gateway/gw/access.mjs", /hachimia 里只有界面专用地址可以/],
    ["gateway/gw/access.mjs", /hachimia 里 Cookie 不用令牌本身/],
    ["gateway/gw/config.mjs", /前缀布局（hachimia）/],
    ["gateway/gw/config.mjs", /hachimia：给 claude 预加载的小库/],
    ["gateway/gw/edition.mjs", /开发版（hachimia-dev）/],
    ["gateway/gw/gitsafe.mjs", /只管 hachimia 自己的 HOME/],
    ["gateway/gw/local.mjs", /hachimia 由 App 进程做/],
    ["gateway/gw/runs.mjs", /hachimia 的冻结检测/],
    ["gateway/gw/leftover.mjs", /只在 hachimia 里认/],
    ["gateway/gw/leftover.mjs", /hachimia 里只有一个网关/],
    ["gateway/gw/usage.mjs", /只在 hachimia 布局下存在/],
    ["gateway/gw/usage.mjs", /hachimia 里它和网关同在 app\/bin/],
    ["gateway/gw/usage.mjs", /不是 hachimia 布局/],
    ["gateway/gw/claude.mjs", /hachimia：用 \$PREFIX\/tmp/],
    ["gateway/gw/claude.mjs", /seccomp 监督器：hachimia 在 APK 原生库目录/],
    ["gateway/gw/claude.mjs", /只在 hachimia 做：开发端换网关/],
    ["gateway/gw/seal.mjs", /hachimia: your skills, commands, agents/],
    ["android/java/ha/chi/mia/MainActivity.java", /别让它冒充 hachimia 要密钥/],
    ["android/java/ha/chi/mia/Mark.java", /hachimia 的标识：三道套在一起的 c/],
    ["android/java/ha/chi/mia/ShizukuSetup.java", /由 hachimia 代劳/],
    ["android/java/ha/chi/mia/Priv.java", /先不接装 Antigravity CLI/],
    ["android/java/ha/chi/mia/Priv.java", /只在 hachimia 前台时受理/],
    ["android/java/ha/chi/mia/Updater.java", /三样东西的更新：应用本体（APK）、开发工具包（devkit）、Antigravity CLI/],
    ["android/java/ha/chi/mia/Updater.java", /Antigravity CLI：装进新的版本目录再切 current 指针/],
    ["android/java/ha/chi/mia/Updater.java", /Antigravity CLI 走官方 manifest/],
    ["android/java/ha/chi/mia/Updater.java", /Antigravity CLI 也由首装流程来装/],
    ["android/java/ha/chi/mia/Updater.java", /version：只对 Antigravity CLI 有用/],
    ["android/java/ha/chi/mia/Env.java", /Antigravity CLI：install-agy\.sh 装好后写下的版本指针/],
  ];
  for (const [f, re] of checks) assert.match(read(f), re, f + " 应含 " + re);
});

test("C-02 有意保留的历史/真实路径/二进制名注释不动", () => {
  assert.match(read("gateway/gw/access.mjs"), /hachimia 9793 与 cccodroid 8791/);
  assert.match(read("android/java/ha/chi/mia/Updater.java"), /cccodroid 的镜像只放 cccodroid 的文件，用不上/);
  assert.match(read("android/java/ha/chi/mia/Updater.java"), /老版本的命名不一定带 cccodroid- 前缀/);
  assert.match(read("android/java/ha/chi/mia/Installer.java"), /cccodroid 的镜像只放 cccodroid 的文件，用不上/);
  assert.match(read("gateway/gw/modules.mjs"), /cccodroid 的镜像只放 cccodroid 的文件/);
});

// ── C-03 死文件 / 死引用 ──
test("C-03 install-claude.sh 已删；测试临时目录名前缀改成 hachimia-test-", () => {
  assert.equal(exists("android/assets/scripts/install-claude.sh"), false);
  assert.doesNotMatch(read("scripts/test.mjs"), /cccodroid-test-/);
  assert.match(read("scripts/test.mjs"), /hachimia-test-/);
  assert.doesNotMatch(read(".github/workflows/apk.yml"), /cccodroid-test-/);
  assert.match(read("gateway/tests/bridge-models.test.mjs"), /hachimia-test-/);
  assert.match(read("gateway/gw/extensions.mjs"), /session_id: "hachimia-test"/);
  assert.match(read("gateway/gw/extensions.mjs"), /"User-Agent": "hachimia"/);
  assert.match(read("gateway/gw/run.mjs"), /name: "\(hachimia\)"/);
  // devkit.yml：旧 cccodroid-test / cc.codtest 概念已废弃（注释里写明即可），不再有活的 target
  assert.match(read(".github/workflows/devkit.yml"), /旧 cccodroid-test \/ cc\.codtest 概念已废弃/);
  assert.doesNotMatch(read(".github/workflows/devkit.yml"), /target=cc\.codtest/);
  assert.match(read("gateway/web/vendor/cc-pick.js"), /hachimia 预览里的「选取元素」/);
  assert.match(read("gateway/web/vendor/cc-pick.js"), /hachimia 界面/);
  assert.match(read("gateway/web/vendor/cc-pick.js"), /\{cc:"pick"\}/);
  // install-claude.sh 删掉后，它的报错键也随之改名（九语键数与 en 保持完全一致）
  const en = JSON.parse(read("android/assets/i18n/java-en.json"));
  assert.equal(en["install-agy.sh 返回 "], "install-agy.sh returned ");
  assert.equal(en["install-claude.sh 返回 "], undefined);
  for (const l of ["ar", "es", "fr", "id", "ja", "ko", "ru", "zh-Hant"]) {
    const d = JSON.parse(read(`android/assets/i18n/java-${l}.json`));
    assert.equal(Object.keys(d).length, Object.keys(en).length);
    assert.ok("install-agy.sh 返回 " in d);
    assert.equal("install-claude.sh 返回 " in d, false);
  }
});

// ── C-04/C-05/C-06 ──
test("C-04 download-sources 两份文档已标注归档（镜像体系是 cccodroid 时代的）", () => {
  for (const f of ["docs/download-sources.md", "docs/download-sources.zh-CN.md"]) {
    assert.match(read(f), /归档|Archived|已过期|不再适用/);
    assert.match(read(f), /hachimia has no mirror|hachimia 没有.*镜像/);
  }
});

test("C-05 构建期脚本注释走 hachimia-components", () => {
  assert.match(read("devkit/components-index.mjs"), /hachimia-components 仓库的 CI/);
  assert.match(read("devkit/devkit.mjs"), /hachimia-components 仓库的 recipes\//);
});

test("C-06 零星注释与临时目录名", () => {
  assert.match(read("scripts/build.sh"), /hachimia 终端/);
  assert.match(read("scripts/java-tests.sh"), /hachimia-java-tests/);
  assert.match(read("scripts/test.mjs"), /在 hachimia 里跑时环境里有二十几个 CCAPP_\*/);
});

// ── HACHIMIA-MIGRATION.md 端口笔误 ──
test("HACHIMIA-MIGRATION.md 网关默认端口是 9793，不是 8793", () => {
  const s = read("HACHIMIA-MIGRATION.md");
  assert.match(s, /网关默认端口：`8791` → \*\*`9793`\*\*/);
  assert.doesNotMatch(s, /8793/);
});
