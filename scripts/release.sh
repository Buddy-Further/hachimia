#!/system/bin/sh
# ─────────────────────────────────────────────────────────────────────
#  release.sh —— 发布 APK：建 GitHub Release（tag v<版本>）并上传 dist/hachimia.apk
#
#  APK 在构建机上签名（发布钥匙不进 CI），所以 Release 也从这里建。
#  认证：优先用 TOKEN 文件（如 ~/.bldtools/gh-token-hachimia），没有则回落到 `gh auth token`。
#  用法:  sh scripts/release.sh            先跑 build.sh；版本取自 AndroidManifest 的 versionName
#         NOTES=说明.md NOTES_EN=notes.en.md sh scripts/release.sh   （缺省用 android/assets/whatsnew/v<版本>.*.md）
#  说明是中英双语：中文在前，--- 之后是 ## English。NOTES_EN 缺省时英文部分只有安装与校验
#  正式版直接发；tag 带后缀（v0.2.0-beta1）的标成预发布，App 内更新检查只认正式版
# ─────────────────────────────────────────────────────────────────────
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OLDB=/data/user/0/li.dsh.claudecli/files/bldtools
[ -d "$OLDB" ] || OLDB=${BLDTOOLS:-$HOME/.bldtools}
TOKEN=${TOKEN:-$OLDB/gh-token-hachimia}
REPO=Buddy-Further/hachimia
APK="$ROOT/dist/hachimia.apk"
# 双方案：hachimia-36.apk（targetSdk 36）同版本一起发；没打出来就只发 28 的
APK36="$ROOT/dist/hachimia-36.apk"
if [ -s "$TOKEN" ]; then
  GH_TOKEN_VAL=$(cat "$TOKEN" | tr -d '\r\n')
elif command -v gh >/dev/null 2>&1; then
  GH_TOKEN_VAL=$(gh auth token 2>/dev/null || true)
fi
[ -n "$GH_TOKEN_VAL" ] || { echo "✗ 找不到 GitHub Token（既没有 $TOKEN，也没有已登录的 gh CLI）"; exit 1; }
[ -s "$APK" ] || { echo "✗ 没有 $APK，先跑 build.sh"; exit 1; }
VER=$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$ROOT/android/AndroidManifest.xml")
TAG="v$VER"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "✗ 工作区有未提交的改动，发布要对应一个确定的提交"; exit 1; }
DEVKIT=$(sed -n 's|.*/download/\([^/]*\)/.*|\1|p' "$ROOT/devkit-sources.txt" | head -1)
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
SHA36=""
[ -s "$APK36" ] && SHA36=$(sha256sum "$APK36" | cut -d' ' -f1) || true
COMMIT=$(git -C "$ROOT" rev-parse HEAD)
git -C "$ROOT" fetch -q origin main 2>/dev/null || true
git -C "$ROOT" merge-base --is-ancestor "$COMMIT" origin/main 2>/dev/null || { echo "✗ 提交 ${COMMIT%${COMMIT#???????}} 还没推到 origin/main，先 git push"; exit 1; }

W="$ROOT/android/assets/whatsnew"
[ -z "$NOTES" ] && [ -s "$W/$TAG.zh.md" ] && NOTES="$W/$TAG.zh.md"
[ -z "$NOTES_EN" ] && [ -s "$W/$TAG.en.md" ] && NOTES_EN="$W/$TAG.en.md"
[ -z "$NOTES" ] && echo "⚠ 没有更新说明：$W/$TAG.zh.md（App 里也不会弹）"
[ -n "$NOTES" ] && [ -z "$NOTES_EN" ] && echo "⚠ 只给了中文说明（NOTES），没给英文（NOTES_EN）"
grep -q "\"v\":\"$VER\"" "$ROOT/gateway/web/changelog/zh.json" 2>/dev/null || echo "⚠ 更新日志里没有 $TAG：这个包里的「更新日志」页会缺这一版（先跑 node scripts/changelog.mjs，提交后重新打包）"
export GH_TOKEN_VAL REPO TAG COMMIT SHA SHA36 DEVKIT APK APK36 NOTES NOTES_EN
node --input-type=module -e '
import fs from "node:fs";
const { GH_TOKEN_VAL, REPO, TAG, COMMIT, SHA, SHA36, DEVKIT, APK, APK36, NOTES, NOTES_EN } = process.env;
const auth = { authorization: "Bearer " + GH_TOKEN_VAL.trim(), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const api = async (method, url, body, extra = {}) => {
  const r = await fetch(url, { method, headers: { ...auth, ...extra }, body });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → HTTP ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
};
const read = (p) => (p ? fs.readFileSync(p, "utf8").trim() + "\n\n" : "");
const devkitLink = "[" + DEVKIT + "](https://github.com/" + REPO + "/releases/tag/" + DEVKIT + ")";
const body = "**简体中文** · [English](#english)\n\n" + read(NOTES) + [
  "### 安装",
  "下载 `hachimia.apk` 安装（系统提示「与此版本的安卓不兼容」、装不上时，改装 `hachimia-36.apk`）。首次打开勾选要装的工具包模块（断点续传），再自动安装官方 Antigravity CLI (`agy`)。",
  "",
  "### 校验",
  "- `hachimia.apk` sha256：`" + SHA + "`",
  ...(SHA36 ? ["- `hachimia-36.apk`（targetSdk 36）sha256：`" + SHA36 + "`"] : []),
  "- 配套开发工具包：" + devkitLink,
  "- 源码提交：" + COMMIT,
].join("\n") + "\n\n---\n\n## English\n\n" + read(NOTES_EN) + [
  "### Install",
  "Download and install `hachimia.apk` (if Android says it isn’t compatible and won’t install it, use `hachimia-36.apk` instead). On first launch pick toolchain modules (resumable), then the official Antigravity CLI (`agy`) is installed automatically.",
  "",
  "### Verification",
  "- `hachimia.apk` sha256: `" + SHA + "`",
  ...(SHA36 ? ["- `hachimia-36.apk` (targetSdk 36) sha256: `" + SHA36 + "`"] : []),
  "- Matching toolchain: " + devkitLink,
  "- Source commit: " + COMMIT,
].join("\n");
let rel;
try { rel = await api("GET", `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`); }
catch {}
if (rel) {
  const ref = await api("GET", `https://api.github.com/repos/${REPO}/git/ref/tags/${TAG}`);
  let sha = ref.object.sha;
  if (ref.object.type === "tag") sha = (await api("GET", ref.object.url)).object.sha;
  if (sha !== COMMIT) { console.error("✗ " + TAG + " 已指向 " + sha.slice(0, 12) + "，和这次的提交 " + COMMIT.slice(0, 12) + " 不同：换个版本号，或先手动删掉那个 Release 和 tag"); process.exit(1); }
  rel.patchBody = true;
  console.log("  已有 Release " + TAG + "（同一提交），更新附件和正文");
}
else {
  rel = await api("POST", `https://api.github.com/repos/${REPO}/releases`, JSON.stringify({ tag_name: TAG, target_commitish: COMMIT, name: "hachimia " + TAG, body, prerelease: TAG.includes("-") })); console.log("  已建 Release " + TAG);
}
const files = [["hachimia.apk", APK], ...(SHA36 ? [["hachimia-36.apk", APK36]] : [])];
if (!SHA36) for (const a of rel.assets || []) if (a.name === "hachimia-36.apk") await api("DELETE", a.url);
for (const [name, file] of files) {
  for (const a of rel.assets || []) if (a.name === name) await api("DELETE", a.url);
  const up = rel.upload_url.replace(/\{.*\}$/, "") + "?name=" + name;
  const asset = await api("POST", up, fs.readFileSync(file), { "content-type": "application/vnd.android.package-archive" });
  console.log("  ✓ " + asset.browser_download_url + "  " + (asset.size / 1048576).toFixed(2) + " MB");
}
if (rel.patchBody) { await api("PATCH", rel.url, JSON.stringify({ body })); console.log("  ✓ 正文已按这次的包重写"); }
console.log("  " + rel.html_url);
'
