# hachimia (`ha.chi.mia`) — 基于 cccodroid 0.7.9 改造的 Antigravity CLI (`agy`) 安卓初版

本仓库由 `cccodroid-v0.7.9` 改造而来，面向官方原生 Android (bionic) 构建的 **Antigravity CLI (`agy`)**，网关协议采用 **ACP (Agent Client Protocol, `agy acp`)** JSON-RPC 2.0 over stdio。

## 核心改动清单

1. **等长包名与品牌隔离**
   - 包名：`cc.codroid`（10 字符）→ **`ha.chi.mia`**（10 字符，全仓 111 个文件及 `android/java/ha/chi/mia`、`android/tests/ha/chi/mia`、`android/prebuilt/gwpin-ha.chi.mia.json` 已同步）。
   - 应用名：`cccodroid` → **`hachimia`**（`versionName="0.1.0"`，`versionCode="1"`）。
   - 网关默认端口：`8791` → **`8793`**，共享目录 `/sdcard/hachimia`，CLI 安装目录 `~/.local/share/hachimia/agy/current/agy`——可与 `cccodroid` 同机共存不冲突。

2. **Android 宿主层（安装 / 更新 / 权限 / 保护）**
   - 新增 `android/assets/scripts/install-agy.mjs`、`install-agy.sh` 与原生包装脚本 `android/assets/bin/agy`，通过 `https://antigravity.google/cli/install.sh`（支持 `--skip-path --skip-aliases`、`--check`、`--recheck`）安装并维护本地 SHA-256 清单。
   - 改造 `Updater.java`：移除 `downloads.claude.ai` 依赖，改为调用 `install-agy.mjs --check` 检查 `agy` 版本；仓库与 APK 名更新为 `Buddy-Further/hachimia` 与 `hachimia.apk` / `hachimia-36.apk`。
   - 改造 `Env.java`、`Installer.java`、`MainActivity.java`、`DeviceTools.java`、`Docs.java`、`FactoryReset.java`、`Notify.java`、`Priv.java`、`strings.xml`、`scripts/build.sh`。

3. **网关后端（ACP 协议 + 双认证路线）**
   - 新增 `gateway/gw/acp.mjs`：完整实现 `agy acp` 双向 JSON-RPC 2.0（`initialize` → `authenticate` → `session/new` / `session/load` → `session/prompt` → `session/update` 流式映射 + `session/request_permission` 权限卡片回调 + `session/cancel` 中断 + 兼容 `sessions.mjs` / `transcript.mjs` 的本地 `.jsonl` 落盘）。
   - 改造 `gateway/gw/login.mjs`：对接 `agy acp --login` 浏览器 OAuth 流程与终端 Remote SSH OAuth 手动授权码流程，网关不触碰/不中转 OAuth 凭据。
   - 改造 `gateway/gw/providers.mjs`、`models.mjs`、`claude.mjs`、`run.mjs`、`claudeseal.mjs`：
     - 预置 `antigravity`（Google 个人订阅登录）、`antigravity-enterprise`（Google Cloud / Gemini Enterprise）、`gemini-key`（Google AI Studio `GEMINI_API_KEY`）、`gemini-custom`（`GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`）。
     - 自动同步 `~/.gemini/antigravity-cli/settings.json` 中的 `modelProvider: "gemini"`（API Key 模式写入，切回订阅登录自动清除防止 `agy` 报错）。
     - 兼容 Gemini `/v1beta/models` 响应结构解析。

4. **前端界面**
   - 更新 `gateway/web/index.html`、`09-settings.js`、`10-settings-device.js`、`18-terminal.js`：品牌改为 `hachimia`，接口页默认突出 Google Antigravity / Gemini 分组，登录卡片和终端登录命令切换为 `agy acp --login`。

## 本地出包步骤（需 Android SDK / NDK / JDK 17 环境）

1. **构建 `ha.chi.mia` 配套 devkit（或复用等长改写工具链）**
   - `devkit-pin.json` 与 `android/prebuilt/gwpin-ha.chi.mia.json` 已将 `target` 改为 `ha.chi.mia`；首次打正式包前，请用 `node devkit/devkit.mjs` 为 `ha.chi.mia` 生成并发布对应的 `devkit-ha.chi.mia.tar.gz` 与 `devkit-pin.json`（`scripts/pin-devkit.mjs`）。
2. **编译并签名 APK**
   ```bash
   # 方式 A：使用自带 apklib + 签名钥匙 JSON
   KEY=~/.bldtools/hachimia-release.json sh scripts/build.sh
   # 方式 B：使用 Android SDK apksigner + keystore 快速测试包
   SIGN=apksigner KS=debug.keystore KS_PASS=android sh scripts/build.sh
   # 如需 targetSdk 36 版本：
   TARGET_SDK=36 SIGN=apksigner KS=debug.keystore KS_PASS=android sh scripts/build.sh
   ```
   产物输出至 `dist/hachimia.apk`。
