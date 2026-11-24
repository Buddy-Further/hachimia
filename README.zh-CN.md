# hachimia

**简体中文** · [English](README.md) · [讨论区](https://github.com/Buddy-Further/hachimia/discussions) · [参与开发](CONTRIBUTING.zh-CN.md)

**在安卓手机上运行官方 Antigravity CLI（`agy`）的开发启动台。** 免 Root、免定制 ROM、免 chroot / proot / 虚拟机。

[![Release](https://img.shields.io/github/v/release/Buddy-Further/hachimia?color=4285f4&label=release)](https://github.com/Buddy-Further/hachimia/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Buddy-Further/hachimia/total?color=4285f4)](https://github.com/Buddy-Further/hachimia/releases)
[![Stars](https://img.shields.io/github/stars/Buddy-Further/hachimia?color=4285f4)](https://github.com/Buddy-Further/hachimia/stargazers)
![Android 8.0+](https://img.shields.io/badge/Android-8.0%2B-3ddc84)
[![License](https://img.shields.io/github/license/Buddy-Further/hachimia)](LICENSE)

<p align="center">
  <a href="https://github.com/Buddy-Further/hachimia/releases/latest/download/hachimia.apk"><b>下载 APK</b></a>
  &nbsp;·&nbsp; <a href="#安装">安装指南</a>
</p>

安卓本来就跑在 Linux 内核上。工具一旦能在这个内核上原生运行，手机就能做真正的 AI 辅助开发：
写代码、编译 C/C++、跑 Python / Node、打 APK、用 git 推送——全在手机上完成。

> hachimia 是独立的第三方项目，与 Google 没有隶属关系。它运行的是**官方原版 Antigravity CLI（`agy`）**：
> 安装时从 Google 官方渠道下载，按官方 sha256 清单校验，从不改动。

## 为什么做这个

在手机上用 AI 时，模型一旦要真正动手（跑代码、改文件、打包），活儿通常会被送到云端沙箱，手机只剩一块屏幕。
hachimia 把执行拿回你自己的设备：云端只做模型推理，代码、文件和工具链都留在本地，环境跨会话保持，智能体还能直接触达设备本身。

设计思路见 **[设计哲学](docs/design-philosophy.zh-CN.md)**。

## 功能

- **官方 Antigravity CLI + 图形界面**：对话、流式输出、思考、工具调用、文件浏览、会话历史。
  - Antigravity 干活时你发的消息会在对话末尾排队，标着*已排队*；**立即发送**会把其中一条塞进正在跑的这一轮，不打断它。**停止只会停止**——排队的消息会被暂停，绝不会自动发出。
  - `/compact`、`/context` 等内置命令的结果会立刻显示。
  - 每条回复下面有实时生成计时，结束时定格成总耗时。
  - **外观与字体**：多套配色（含 AGY 莫奈拾色主题），浅色、深色或跟随系统（状态栏也跟）。字体随应用内置，手机系统字体不会改变显示效果。设置里可以换界面字体、回复字体（衬线 / 无衬线）和字号（小 / 中 / 大）。
  - 你的消息在右边，回复占满宽度，和桌面版一样。两段回复之间的工具调用会折成一行“N 步”，点开看每一步。有待确认或失败的分组会自动展开。每条回复下面有**复制**（原始 Markdown）和**分享**（系统分享面板）。回复渲染 Markdown，支持表格、任务列表、LaTeX 数学公式和语法高亮代码块。
  - **内置帮助**（侧栏 → 更多 → 帮助）：完整用户指南与进阶技巧，带目录，中英双语。旁边的版本说明收录每个版本的更新，可搜索。
  - **横屏平板与展开的折叠屏**：按窗口宽度变成两栏（对话 + 右侧工作区）或三栏（再加一个常驻侧栏）。文件、查看器、终端和内置浏览器在右侧打开，不盖住对话，分隔条可以拖。竖屏手机和窄分屏和以前一样。
  - **切后台也能接着干**：一轮跑完或 Antigravity 等你确认时会有系统通知，不弹横幅。通知里只有*拒绝*和*打开*；要允许某条命令，必须回到应用里看完整内容再点。系统杀掉应用后重开，未完成的那轮会标成*已中断*并带一个*继续*按钮，排队的消息还在。
  - **会话管理**：侧栏的对话页可以按消息内容搜索和筛选，常用的对话可以置顶。删掉的会话先进入回收站。可以一个一个或全部选中，把会话导出成 zip——用系统*保存到*存到任意位置，或直接分享——再在另一台设备上导入，接着聊。
  - **终端**（顶栏）：真正的终端，带标签页，跑的是和 Antigravity 同一套 bash 与工具链——hx（Helix）、less、top、git 等等。一排附加按键补上手机键盘没有的东西（Esc、Tab、粘住的 Ctrl / Alt、方向键、Home / End、PgUp / PgDn、粘贴、字号）；文本视图可以长按选中复制输出。收起面板后终端继续跑，回来时回放输出。
  - **文件查看 / 编辑**（从文件浏览器进入）：编辑文本和代码并保存——如果你打开之后文件在磁盘上被改过（比如 Antigravity 改了），覆盖前会先问你。Markdown 渲染后可以切换编辑；图片打开时按屏幕适配，点一下看 1:1；PDF 用 [pdf.js](https://mozilla.github.io/pdf.js/) 渲染（支持 CJK 文字和加密文件），页面滚动到才画。Word 和 Excel 文件直接打开；PowerPoint 和旧版 .doc 文件装了 LibreOffice 组件后会先转成 PDF。`.html` 文件显示为实时页面——同文件夹或父文件夹里的 CSS、JS 和图片都会加载，文件一改页面就重载，所以 Antigravity 写的浏览器小游戏点一下就能玩。右上角按钮是**分享**，把文件交给系统分享面板。
  - **开发者工具**：HTML 预览和内置浏览器可以打开随应用内置的 [Eruda](https://github.com/liriliri/eruda)——元素、控制台、网络、存储——离线可用。打开后**点选元素**会把你点的东西的选择器和一小段 HTML 塞进输入框，告诉 Antigravity 改哪里。
  - **Git 面板**（从文件浏览器或编辑器进入）：看改动、历史和逐行 diff，勾文件、写提交信息提交，还可以丢弃改动、切换或新建分支、拉取和推送。
  - **输入框下面直接换**：模型、思考强度和权限模式。新对话的起始页可以先选项目和模型再说话。
  - `/goal <条件>` 让 Antigravity 一轮接一轮干下去，直到条件满足，检查项和已用时间显示在输入框上方。在接口与型号页拖动压缩线，选从哪里开始压缩。
  - **回到这里重来**：你发的每条消息都能倒回——只撤销 Antigravity 从那之后改过的文件，或者从那一点切出新会话重新问。任何回复也可以**分叉**成新会话，原会话不动。Antigravity 干长活时，**任务清单**在输入框上方，子代理各有一张卡片：一行写状态和当前步骤，还有谁跟谁说了什么、为什么的联络记录，以及它们的简报和报告都存成项目里的文件。后台命令也在那里列着，多了就折成一行，点开逐个查看和停止。
  - **脉络**（侧栏）：会话之间的分叉、接续和倒回画成一张地铁图（或缩进树），一眼看出每个会话从哪来。每个会话自动有个档号，点一个站就跳到那一章。旧会话可以一键补档，第一次打开时有个简短导览教你怎么读这张图。
  - **附件**：＋面板第一行是附加文件、拍照、截屏和浏览文件。拍照打开系统相机，照片会按长边缩到 2048 px 并摆正再附加。截屏走 Shizuku，长按截屏可以 5 秒后截，给你时间切到想截的应用。从别的应用分享到 hachimia 也会附加文件。
  - 往上翻长对话时会出现一个 **↓ 按钮**，点一下跳到最新消息；上面有个点表示期间又有新输出。
  - **回复里的路径就是链接**：点一下 `/storage/emulated/0/…/report.pdf` 这样的绝对路径（或 `file.js:12`）就会在查看器里打开，文件夹则在文件浏览器里打开。Antigravity 被要求写完整路径，所以这招一直管用。读写文件的工具卡上也有一个 ↗ 按钮。
  - **内置浏览器**（顶栏的地球图标）：回复里的网页链接在应用内打开——看 `http://127.0.0.1:<端口>/` 的开发服务器很方便。宽屏时在右侧工作区打开，挨着对话。用的是系统 WebView，不增加下载。登录页面还是会交给你的常用浏览器。
  - 界面支持 10 种语言：简体中文、繁體中文、English、Français、Español、Русский、العربية（RTL）、日本語、한국어、Bahasa Indonesia（机器翻译草稿，欢迎校对）。
- **项目与定时任务**：
  - 项目就是一个工作目录，加上它的 AGENTS.md / CLAUDE.md 和默认接口、模型、思考强度与权限；会话按目录归到项目下面。
  - 定时任务让 Antigravity 按计划干活——每天、每周、每月、每几小时、一次或 cron 表达式——到点由系统闹钟唤醒。可以限制任务只读、只限本项目或指定工具，并封顶单次运行时长和每天总耗时。没人看着的时候跑，需要你确认的一律拒绝。
- **用量与限额**：顶栏下面上下文行的后半段显示当前接口还剩多少额度，快用完会提醒。用量页记录对话、活跃天数和用过的模型，附一张月度报告卡可以保存或分享；只计用量，不记内容。
- **工具链按模块安装**（扩展 → 工具包模块）：拆成基础、命令行工具、C/C++ 编译器、Java 与安卓打包、图形库、音视频、文档与数据、Go 和 Node.js 生态。首次安装时自选模块，以后可以随时加装或卸载。每个模块都列出用途、主要命令、大小、依赖和哪些组件用它；敲了没装的模块里的命令，会告诉你去哪里找。
- **可选组件**（扩展 → 可选组件）：不随应用安装的大工具，需要再下载。每个构建都对应某个工具链版本，安装前按 SHA-256 和逐文件清单核对，卸载干净。
  - **浏览器组件（无头 Chromium）**：让 Antigravity 无头打开页面——截屏、导出 PDF、读渲染后的 DOM、用 puppeteer-core 写脚本浏览。附带一个技能，告诉 Antigravity 怎么用它。
  - **社区组件**：开发：GitHub CLI（gh）、Godot（无头运行、导出 APK）、Graphviz / PlantUML 画图、Hugo、逆向（rizin、binwalk）。媒体：Blender（无头合成与渲染、GPU 上跑 3D）、LilyPond（乐谱雕版）、音乐制作工具链。办公：LibreOffice、Pandoc、PDF 工具箱、OCR（中英）、LaTeX（Tectonic，支持中文）。AI：llama.cpp。3D 与科学：OpenSCAD、GNU Octave、科学 Python（numpy / scipy / matplotlib）。EDA：ngspice / gnucap、Icarus Verilog / Yosys。GPU：骁龙驱动（Vulkan / OpenGL / OpenCL）、Mali 驱动、GPU 跑分。网络：Cloudflare（wrangler）、rclone、QQ 机器人（原生 NapCat / SnowLuma，OneBot v11）。索引经过 ed25519 签名，验不过就拒收；社区组件会标出来，没人真机验过的构建会先问你。
  - **自定义组件**：导入市场上没有的 Linux arm64 程序（单个二进制或 .tar.gz / .zip）。它会判断程序是 glibc、安卓原生、静态还是脚本，从 Termux glibc 仓库补缺的库，装好后就是一条 Antigravity 和终端都能用的命令。来源由你自己负责。
- **几种接法**：
  - 在应用里用 Google 账户登录（个人 Free / Pro / Ultra，或 Gemini Enterprise / Google Cloud 企业账号）；在浏览器里授权后会自动回来，或粘贴授权码。账户卡显示用量限额和重置时间。
  - Gemini API Key（Google AI Studio）。
  - 自己加任意 Gemini 兼容端点，填地址和 Key 就能用。
  - **按对话切换**：设置里的接口、模型和思考强度只是默认值，在对话里换只影响这一个对话。多个对话可以同时跑——一个走 Google 账户，另一个走 Gemini API Key——互不干扰。
- **一套完整的开发工具链**（约 250 个包，取自官方 [Termux](https://termux.dev) 仓库）：
  - C/C++：clang 21 / lld、make / cmake / ninja、gdb / strace。
  - 语言：Python 3.14（pip、venv）、Node 26（npm、npx）。
  - 安卓打包：OpenJDK 21、aapt2 / d8 / apksigner——在手机上打 APK。
  - 版本控制与网络：git、ssh、curl。
  - 音视频：ffmpeg 9（x264 / x265 / VP9 / AV1 / Opus…），手机硬件编码（`h264_mediacodec` / `hevc_mediacodec`），比软件编码快 3 倍以上。
  - 命令行工具：rg / fd / bat / jq / sqlite3 / typst / ImageMagick…交互式 bash 里 Tab 补全能用；`hx-grammar` 只装你需要的 Helix 语法；typst 开箱就能找到系统 CJK 字体。
  - 还缺什么：终端里 `pkg install` 从 Termux 仓库装，`pkg verified` 列出实测可用的包。
- **系统权限（可选）**：[Shizuku](https://shizuku.rikka.app) 集成。终端里 `priv '<命令>'` 可以用 shell 身份跑 pm / am / settings / logcat / screencap…。
  - 设置里一键安装激活：从 Shizuku 官方发布下载（验签名证书），用系统安装器装好，
    再通过无线调试激活——不需要电脑。配对码在一直悬在屏幕顶部的通知里填，配对对话框保持打开。
  - 重启手机后，hachimia 会自己重新打开无线调试并激活 Shizuku（需要连着 Wi‑Fi）。
- **设备工具（默认关）**：在设置 → 设备工具里打开，Antigravity 就能发通知、读写剪贴板、分享文件到别的应用、打开链接或应用、查看电池和网络；读屏和点按走无障碍，是另一个单独开关。底层是走 Priv 调系统的 MCP 服务器。日历、邮件这类只做预填，保存和发送由你自己来。
- **内存管家（默认关）**：跑构建、渲染这类重活之前，通过 Shizuku 停掉白名单之外的后台应用，活干一半它们跑回来还会再停。你正在看的应用、分屏应用和带前台通知的一律不动。终端里用 `cc-mem run -- <命令>`。内存数字怎么读、怎么找吃内存的元凶：[docs/memory-management.zh-CN.md](docs/memory-management.zh-CN.md)。
- **工作岛（ColorOS，默认关）**：装了社区开发的工作岛应用后，Antigravity 干活中、等你确认和做完任务都会显示在 ColorOS 16 的流体云小岛上。见 [docs/work-island.zh-CN.md](docs/work-island.zh-CN.md)。
- **自动更新**（默认开，可以关掉或在设置里手动触发）：
  - Antigravity CLI：从官方渠道静默更新（stable / latest，或固定到某个版本）；正在跑的对话不受影响。
  - hachimia 本身：下载好、验过签名再提示安装；有 Shizuku 时空闲自动装。有 targetSdk 28 和 36 两个 APK，更新跟着你装的那个走，设置里可以切换（只接受 36 的系统换过去就换不回 28）。
  - 工具包：只在 Wi‑Fi 下预先下载，下次打开应用时装上；你用 pip / npm -g 装的东西会保留。
  - 更新互相不打断：工具包正在下载或替换时，应用更新会等着。替换前先按发布清单核对，万一中途被打断（应用重启、进程被杀），下次启动会接着完成或回滚。
  - 设置里的**校验 / 修复**会按记录的哈希逐项核对工具链文件；修复会重装同一版本，保留你自己的包。每次启动也会快速检查一次。
- **扩展**：装、启用、停用、卸载 Antigravity 插件（搜官方目录或加别的市场），从 zip 装技能，增删改 MCP 服务器（长按或双击条目直接改，令牌只显示名字不回显）——都在扩展页。从 0.6.7 起插件 hooks 不运行，你自己的技能以 `/user:名字` 调用。
- **跑之前先检查**：
  - Antigravity CLI 只有和它那一版记录的 sha256 清单对上才跑。网关用自己那份运行时，启动前按安装包核对，包升级和工具包更新都动不了它。
  - 交给 Antigravity 的配置（AGENTS.md / CLAUDE.md、规则、技能、命令、子代理、输出风格、插件里的文字、自动记忆）先扫一遍越狱特征。命中了这轮就不跑，并告诉你是哪个文件哪一行。MCP 服务器按 `~/.claude.json` 里的注册原样透传，不在这次扫描里。
  - 会自己跑的项目配置（hooks、`.mcp.json` 里的 MCP 服务器）不加载。之前对话留下的后台程序会先摆出来给你看，再接着跑。
- **排障**：
  - **安全模式**：某个 hook、插件、MCP 服务器或 AGENTS.md 搞坏了东西，就打开安全模式，Antigravity 以受限模式启动——不加载自定义内容，登录、Key、会话和模型照旧。什么都不挪、不改，关掉就恢复。
  - **我卡住了 · 打包诊断**（设置里，安装失败的页面上也有）：诊断、自检、应用日志、网关日志和修复账本打成 zip 交给系统分享。打包前先给你看清单。密钥、令牌、邮箱和你发给 Antigravity 的消息内容会先 scrub 掉，对话记录本身不在包里。
  - **大白话的首装报错**：下载前先检查剩余空间，告诉你还差多少。离线、限流、校验和对不上这类失败都会用人话解释。*重试*会从已下载的部分续传。
  - **修复账本**：每次工具链安装、校验、修复和启动恢复都记下来（发现了什么、做了什么、成没成），在设置里能看。
  - **已知问题**：还没完全解释或排除的问题和目前掌握的情况，列在 [docs/known-issues.zh-CN.md](docs/known-issues.zh-CN.md)。
  - **权限**：每个权限是干什么的、什么时候问、拒绝会怎样，见 [docs/permissions.zh-CN.md](docs/permissions.zh-CN.md)。发现安全问题？按 [SECURITY.md](SECURITY.md) 里说的私下报告。
- **USB 调试另一台设备**：用 OTG 线连上，跑 `usb-adb`，然后 `adb devices / install / shell` 照常用。
- **自检**：随包带的自检会把 70 多项工具和用法逐项跑一遍（包括 ffmpeg 和硬件编码探测）；工具说明会注入 Antigravity 的系统提示，让它知道这台设备上什么能用。

## 安装

1. 从 [Releases](https://github.com/Buddy-Further/hachimia/releases) 下载 `hachimia.apk` 并安装。如果安卓说不兼容装不上，就用同一个发布里的 `hachimia-36.apk`（targetSdk 36，功能一样；两个的区别见应用内帮助的“更新与修复”）。
2. 打开应用。首次启动会自动：
   - 下载工具链：先选模块，基础必选，命令行工具和 C/C++ 编译器默认勾上，总共约 350 MB（全部模块约 740 MB）；可续传、验 sha256 再解开；
   - 从 Google 官方渠道下载 Antigravity CLI。
3. 在设置里选接法：用 Google 账户登录，或填 Gemini API Key。
4. （可选）装好并启动 Shizuku，再在设置里授权，就能用 `priv` 和更强的保活。

要求：Android 8.0+、arm64、约 4 GB 空闲空间。

带后缀的版本（比如 `v0.2.0-rc1`）是预发布版。应用内更新只推稳定版；预发布版去 Releases 里手动下载。

**厂商 ROM 上允许后台运行**：有些厂商的省电策略不理会前台服务，会在后台把整个应用冻住，正在跑的任务就停了。hachimia 在任务进行中检测到被冻住时，会在设置里准确告诉你去哪里改。

**离线安装**：先把 `devkit-ha.chi.mia.tar.gz` 下到手机上，首次启动时选“从本地文件选择…”，其他什么都不用下载，文件会先按已发布的版本核对再安装。

**版本**：v0.1.0 是第一个可用版本。每次发布都能直接覆盖安装，数据和装好的工具都保留。

## 交流与参与

- **提问、想法、机型报告**：[GitHub Discussions](https://github.com/Buddy-Further/hachimia/discussions)，中文或英文都行。还有个中文 QQ 交流群，1062538743。
- **报 bug**：在应用里点设置 → 到 GitHub 反馈，机型和自检结果会自动带上。

**日常维护基本还是一个人，另有几位社区成员帮忙测试、审代码和红队测试，非常需要帮手。** 机型报告、译文校对、组件配方、文档和代码都欢迎，不会写代码也能帮忙。参与方式见 [贡献指南](CONTRIBUTING.zh-CN.md)。

## 工作原理

```
hachimia.apk（Java 外壳：安装器 + 前台服务 + WebView）
  ├─ files/usr/      工具链：官方 Termux 包，经等长前缀重定位后原生运行
  ├─ 官方 Antigravity CLI（agy，Android bionic 构建，原版二进制）
  │     └─ 网关通过 ACP 协议（JSON-RPC）驱动，按记录的 sha256 校验
  ├─ lib/arm64-v8a/libldlinux.so   同一份 glibc 加载器；36 的包经它启动 glibc 程序
  ├─ files/gw/       网关自己的运行时（Node、glibc 等），启动前按安装包核对
  └─ gateway gateway/server.mjs + gw/（Node）：跑 agy、事件流、队列、接口配置 → 界面 gateway/web/
```

- **等长前缀重定位**：Termux 的二进制在编译时把 `/data/data/com.termux/` 烘进去了。包名 `ha.chi.mia` 和 `com.termux` 正好都是 10 个字符，逐字节替换就能修好所有 RUNPATH、shebang 和配置路径——不用 `LD_LIBRARY_PATH`、不用包装脚本、不用改二进制。zip / jmod 压缩包里的条目也一起改写。见 [devkit/README.md](devkit/README.md)。
- **seccomp**：安卓给应用进程装了一份系统调用白名单，白名单外的调用会被 SIGSYS 打死。Android 14 不允许 `epoll_pwait2`，glibc 程序启动就会被打死。[`seccomp-enosys.c`](android/native/seccomp-enosys.c) 把这类调用改成返回 ENOSYS，让程序走自己的兜底路径；`enosys-run` 用 ptrace 从外面给静态二进制做同样的事。
- **targetSdk 36**：Android 10 起，targetSdk 29 及以上的应用不能执行自己数据目录里的文件。常规 APK 还是 target 28。36 的包把 glibc 加载器放进 APK 的 native 库目录（系统允许执行），bionic 程序经 `/system/bin/linker64` 启动，执行垫片（[`exec-shim.c`](android/native/exec-shim.c)）把每次程序启动改写成这两种形式之一。两个 APK 功能一样，每个组件都在 36 的包上真机跑过。
- **网关访问控制**：网关监听两个回环地址：127.0.0.2 专给界面，127.0.0.1 给本地工具。每个 `/api/*` 请求都必须带应用私有目录里的 256 位令牌，还要过 Host 和 Origin 检查。会话 cookie 只在 127.0.0.2 的请求上认，内置浏览器拦着这个地址，所以 cookie 到不了设备上的其他服务。应用本身从不直接发原始令牌：每个请求只签一次（时间戳、一次性 nonce、启动 ID、监听地址、方法和 body 哈希的 HMAC），截获的请求没法重放。交出任何凭据之前，应用还会让网关用令牌做 HMAC 应答，证明应答的确实是真的网关。设备上的其他应用和网页驱动不了它。
- **凭据**：账户登录由 Antigravity CLI 自己完成。网关把授权地址交给系统浏览器，从不读取或保存 Google 凭据；一次性授权码也不经手（见 [条款与合规](#条款与合规)）。第三方 API Key 存在应用私有目录里，经环境变量交给 agy，不会写进所有人可读的文件。

项目一直守的几条规则：

- **只跑官方版本，绝不改动。** Antigravity CLI 只从官方渠道来。APK 里不捆它。
- **不 Root、不 proot。** 工具链原生跑。平台限制用前缀重定位、seccomp 垫片和加载器解决，特权操作只走 Shizuku。
- **网关拥有运行。** 界面只订阅事件，页面重载、切后台、多会话并行都不会打断正在跑的一轮。
- **先验再信。** 工具包、模块、组件索引、通知和发布清单都按 ed25519 或 sha256 签名核对，并绑定到具体发布，防重放。
- **每次改动都要验证。** 网关测试只走测试运行器，每次发布和工具包发布都核对哈希，组件要注明是否真机验过。

## 隐私与数据保护

完整说明见 **[隐私与数据保护说明（PRIVACY.zh-CN.md）](PRIVACY.zh-CN.md)**。hachimia **没有用户账号体系、没有后端业务服务器、没有对话云同步，也没有任何第一方遥测或闭源统计 SDK**；以下每一项控制与边界均可直接在仓库源码中逐行核查：

- **零第一方遥测、零外部 CDN 与上游 CLI 边界披露**：
  - hachimia 本身不生成持久化安装 ID（`iid`）、不上传崩溃或使用统计，未集成 Google Play Services、ML Kit、Firebase、Sentry 或任何广告 SDK；界面全部脚本与字体均随包离线内置于 [`gateway/web/vendor/`](gateway/web/vendor/)。
  - **关于上游 Antigravity CLI（`agy`）的如实说明**：hachimia 启动的是你首次运行时从 Google 官方渠道下载的原版闭源二进制 `agy`（按官方清单校验 SHA-256，绝不反编译或打补丁，见 [`android/assets/scripts/install-agy.mjs`](android/assets/scripts/install-agy.mjs)）。`agy` 直连 Google 服务完成认证与模型推理，其进程内部可能包含受 [Google 隐私政策](https://policies.google.com/privacy)约束的官方诊断/遥测逻辑，该流量不经过 hachimia 任何服务器。对于可选的 Claude Code 路径，网关在 [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs)（`claudeEnv`）中注入 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"` 抑制非必要流量。
- **凭据隔离、本地统计与诊断脱敏**：
  - 清单声明 `android:allowBackup="false"`（[`android/AndroidManifest.xml`](android/AndroidManifest.xml)），会话、设置与凭据仅存于应用私有目录 `/data/data/ha.chi.mia/files/home/`，不进系统云备份。
  - Google 登录走 `agy` 自有 OAuth 流程；hachimia 仅检测凭据目录是否存在非空会话文件，**从不读取、解析或上传 OAuth 令牌内容**（[`gateway/gw/agy-creds.mjs`](gateway/gw/agy-creds.mjs) `hasAgySessionFiles`、[`gateway/gw/login.mjs`](gateway/gw/login.mjs)）。
  - 本机网关仅监听回环 `127.0.0.2`（界面专用）与 `127.0.0.1`，要求 256 位安装令牌、Host/Origin 核验与启动期派生的单次防重放 HMAC 签名（[`gateway/gw/access.mjs`](gateway/gw/access.mjs)、[`android/java/ha/chi/mia/Events.java`](android/java/ha/chi/mia/Events.java)）。
  - 「用量」页仅统计本地会话文件，零网络请求（[`gateway/gw/usage.mjs`](gateway/gw/usage.mjs)）；「打包诊断」在调用系统分享面板前本地抹除密钥、令牌、邮箱与你发出的消息正文且不含会话记录（[`android/java/ha/chi/mia/Share.java`](android/java/ha/chi/mia/Share.java) `bundleLogs`）；「到 GitHub 反馈」仅在你主动点击时拼出浏览器预填链接供你审阅（[`gateway/gw/feedback.mjs`](gateway/gw/feedback.mjs) `issueDraft`）。
- **出站网络请求全量清单与一键关闭开关**（除你在对话/终端主动让模型执行的命令外，应用自身仅存在以下联网路径）：

| 用途 | 默认状态与关闭方式 | 目标地址 | 校验锚点与对应源码 |
|---|---|---|---|
| 模型推理与账户登录 | 你发消息或登录时触发 | Google 官方接口（经 `agy` ACP）或你自行填写的第三方调用地址 | [`gateway/gw/acp.mjs`](gateway/gw/acp.mjs)、[`gateway/gw/providers.mjs`](gateway/gw/providers.mjs)、[`gateway/gw/login.mjs`](gateway/gw/login.mjs) |
| 自动检查更新（每 6 小时） | 默认开；**设置 → 更新 → 自动更新** 可关 | `api.github.com`（`Buddy-Further/hachimia`）、`antigravity.google` 及官方 `agy` manifest 服务 | APK 验签名证书 + SHA-256；工具包验钉死 SHA-256 / `ed25519`；`agy` 验官方 manifest SHA-256（[`android/java/ha/chi/mia/Updater.java`](android/java/ha/chi/mia/Updater.java) `AUTO_EVERY`、[`android/assets/scripts/install-agy.mjs`](android/assets/scripts/install-agy.mjs)） |
| 维护者签名公告与兼容记录（每 3 小时） | 默认开；**设置 → 更新 → 接收维护公告** 可彻底关闭 | `raw.githubusercontent.com/Buddy-Further/hachimia`（纯静态 `GET`，无设备参数） | 强制核验内置 `ed25519` 公钥分离签名 `.sig`（[`gateway/gw/notices.mjs`](gateway/gw/notices.mjs) `refreshNotices`、[`gateway/gw/ccverified.mjs`](gateway/gw/ccverified.mjs) `refreshVerified`） |
| GitHub 第三方代理兜底 | **默认关闭**；仅主动开启 **设置 → 更新 → GitHub 第三方代理兜底** 且官方源失败时启用 | `gh-proxy.com`（外部公共代理，开启后对方可见你的公网 IP 与目标 URL） | 下载字节仍强制核对钉死 SHA-256 与签名（[`android/java/ha/chi/mia/Installer.java`](android/java/ha/chi/mia/Installer.java) `ghProxyEnabled`、[`gateway/gw/pget.mjs`](gateway/gw/pget.mjs) `ghProxy`） |
| 工具包 / 组件 / 端侧模型下载 | 首装或你在「扩展」页点击安装时触发 | GitHub Releases、Termux 官方及高校镜像、魔搭 / HuggingFace | 钉死 SHA-256、Termux PGP 签名或 `ed25519` 索引签名（[`gateway/gw/components.mjs`](gateway/gw/components.mjs)、[`gateway/gw/modules.mjs`](gateway/gw/modules.mjs)、[`android/assets/bin/pkg.mjs`](android/assets/bin/pkg.mjs)） |

- **权限最小化与金融/口令界面硬隔离**：
  - 绝不申请相机（`CAMERA`）、麦克风（`RECORD_AUDIO`）、定位（`ACCESS_*_LOCATION`）、通讯录、短信、通话记录、日历（`READ_CALENDAR`）、应用使用统计（`PACKAGE_USAGE_STATS`）、通知监听（`NotificationListenerService`）或录屏投影（`MediaProjection`），详见 [docs/permissions.zh-CN.md](docs/permissions.zh-CN.md)。
  - 设备工具与无障碍默认全关；开启需经系统锁屏验证（[`android/java/ha/chi/mia/Consent.java`](android/java/ha/chi/mia/Consent.java)）与前台原生弹窗确认（[`android/java/ha/chi/mia/DeviceTools.java`](android/java/ha/chi/mia/DeviceTools.java)），闲置 10 分钟自动调用 `disableSelf()` 自关（[`android/java/ha/chi/mia/A11y.java`](android/java/ha/chi/mia/A11y.java) `scheduleIdle`）；自动抹除密码框文本（`isPassword()`），并对支付宝、云闪付、手机银行、2FA 动态口令应用、密码管理器及系统权限控制器实施**硬性拦截**（[`android/java/ha/chi/mia/A11y.java`](android/java/ha/chi/mia/A11y.java) `isProtectedPackage`），禁止读屏、截屏与模拟点击；内存态安全守卫（[`gateway/guard/cc-guard.mjs`](gateway/guard/cc-guard.mjs)）与 ACP 权限卡片（[`gateway/gw/acp.mjs`](gateway/gw/acp.mjs)）对敏感操作强制逐次确认。
  - **第三方调用提示**：发往模型接口的提示词、代码与工具输出受对应服务商隐私政策约束；来路不明的第三方调用运营者可见经过的密钥与内容，切勿在不可信的第三方调用上处理敏感私密数据。

## 条款与合规

hachimia 希望遵守 Google 对运行 Antigravity CLI 的产品的要求。下面是应用实际的做法，你可以自己判断：

- **二进制怎么跑。** Antigravity CLI 文件就是官方 Android 构建的原样：按官方 sha256 清单核对，从不打补丁。
- **用 Google 账户登录。** 登录走 Antigravity CLI 自己的 OAuth 流程。你在 Google 页面上授权，agy 把令牌写进自己的凭据存储（应用从不读那个文件），登录后 agy 直接和 Google 的服务说话，不经过我们的任何进程。实际效果和 SSH 到一台你自己的 Linux 机器上跑 agy 再登录是一样的：这里 Linux 机器就是手机，应用是屏幕和键盘。每一轮都由你发起：要么是你发的消息，要么是你自己设的定时任务。定时任务在你自己的手机上、用你自己的账户、跑同一个原版 agy；没人看着的时候，需要确认的一律拒绝——应用从不替你点“允许”。会在订阅账户上跑的定时任务默认是关的，由你自己打开。
- **一次性授权码。** 正常情况下浏览器会自动把码交回 agy，全程在本设备上，不经过应用。如果失败了（比如你在别的设备上授权），应用会打开内置终端跑 `agy`，你把码贴进 agy 自己的提示。终端就是个通用字节通道，和 Termux、SSH 一样；应用没有接收授权码的字段，从不解析、保存或记录它。
- **权限确认。** 和官方 CLI 一样，Antigravity 改文件、跑命令或联网前会先问你，你在对话里回答。默认模式是“逐项确认”；“全部放行”也有，但要先确认。
- **不转售、不做中间商。** hachimia 免费开源，没有服务器，不提供、不代付、不转售任何模型用量：你用自己的账户登录或自带 API Key，用量直接记在你账上。

### 这个项目不做的事

hachimia 免费开源，没有服务器，不提供、不代付、不转售任何模型用量：你用自己的账户登录或自带 API Key，用量直接记在你账上。

- **不共享、不转售账户。** 一个订阅分给多人用，或把订阅用量包装成 API 卖，不支持；不会为此做功能，也不接受加这类功能的 PR，组件市场也不收这类组件。
- **不越狱。** 绕过模型的安全限制、套取它本来会拒绝的有害内容，不支持。
- **不批量控号。** 用智能体批量注册、养号、跑号，冒充真人去刷评论区，不支持。

第三方端点是另一回事：应用允许你接任意讲兼容协议的第三方端点，地址和 Key 由你提供。反向代理是技术；我们反对的是分拆订阅、转售用量、偷 Key、换模型——不是因为支付、地区或网络原因用代理。

第三方端点有真实风险：运营方能看到经过的代码、Key 和对话；共享或转售的账户可能被封；模型可能被换。这些风险由用户自己承担。

我们不去管别人怎么选。但这个项目不提供共享 / 转售功能，也不帮着排查这类用法。

## 构建

```sh
sh scripts/build.sh                 # javac → d8 → aapt2 → 签名，产出 dist/hachimia.apk（targetSdk 28）
TARGET_SDK=36 sh scripts/build.sh   # 36 的包；scripts/ship.mjs 会给发布构建两个包
node devkit/devkit.mjs build --target ha.chi.mia   # 构建工具链（CI 也能做）
```

**不用配环境**：GitHub Actions 会给每个 pull request 和每次推送到 main 构建 APK，从那次运行的 Artifacts 里下载（见 [.github/workflows/apk.yml](.github/workflows/apk.yml)）。main 上的构建用发布密钥签名，能直接覆盖安装已发布的版本。fork 的 PR 用一次性测试密钥签名，得先卸载已发布的应用再装，最好用备用机。

要在自己机器上构建，装好 JDK 17、Node.js、Android SDK（build-tools 和一个 platform）和 NDK，再按 `build.sh` 开头的说明设置环境变量。`apk.yml` 就是个能跑的例子。脚本默认的工具路径指向作者的安卓平板。

正式版的签名证书 SHA-256：`D3:41:C3:91:A8:25:BB:B7:30:39:7F:00:9F:7B:82:54:B9:7A:00:DB:57:CA:E2:54:FA:14:AA:3A:2F:F4:5A:48`。

工具链由 GitHub Actions 构建发布：推一个 `devkit-YYYY.MM.DD` 这样的 tag（见 [.github/workflows/devkit.yml](.github/workflows/devkit.yml)）。
应用下载哪个版本的工具链由 [devkit-sources.txt](devkit-sources.txt) 定。那个版本的大小和 SHA-256 在 [devkit-pin.json](devkit-pin.json) 里，随 APK 一起发：首次安装（从 GitHub 或本地文件）和本地文件核对都信它，不信下载来源。它还钉了锁文件 `devkit.lock.json` 本身的 SHA-256，`build.sh` 在解开 glibc 加载器之前会先核对它，而不是只信 HTTPS。换版本时改前者，跑 `node scripts/pin-devkit.mjs "$(head -1 devkit-sources.txt)" devkit-pin.json`，两个一起提交；`build.sh` 会检查它们是否一致。

目录结构：

| 目录 | 内容 |
|---|---|
| `android/` | Java 外壳、Manifest、资源、终端辅助脚本（`assets/bin/`）、native 库（`native/`）、APK 里自带的原版 glibc 加载器（`prebuilt/glibc/`） |
| `gateway/` | 网关（`server.mjs` + `gw/` 下的功能模块，Node.js）和界面（`web/`，原生 JS，没有构建步骤） |
| `i18n/` | 界面翻译：每种语言一个 txt，加生成和检查脚本，见 [i18n/README.md](i18n/README.md) |
| `devkit/` | 工具链构建脚本与清单 |
| `docs/design-philosophy.zh-CN.md` | 这个项目为什么存在，背后的原则 |
| `docs/large-screen.md` | 大屏布局（平板、折叠屏）与代码位置 |
| `docs/known-issues.zh-CN.md` | 已知问题与未排除的风险，以及造出假 bug 的测试动作 |
| `docs/download-sources.zh-CN.md` | 每条下载链：来源、信任锚点、服务器镜像、检查与维护方法 |
| `docs/memory-management.zh-CN.md` | 内存数字怎么读、怎么找吃内存的元凶 |
| `docs/work-island.zh-CN.md` | 工作岛（ColorOS）集成：组成部分、开关、设计说明与已知限制 |
| `docs/permissions.zh-CN.md` | 每个权限是干什么的、什么时候问、拒绝会怎样，以及三个重权限的风险 |
| `docs/operit2-on-device-build.zh-CN.md` | 案例：在手机上从源码构建 Operit2（Flutter + Rust）成 APK，遇到的每个坑 |
| `third_party/` | Shizuku-API 13.1.5（MIT，Maven Central 原样） |

## 特别感谢

- **[Eruda](https://github.com/liriliri/eruda)**（liriliri，MIT）：预览和浏览器面板里的开发者工具；许可证在 [ThirdPartyLicenses/eruda](ThirdPartyLicenses/eruda/LICENSE)。
- **[Termux](https://termux.dev)**：工具链取自它的官方包。
- **[Shizuku](https://shizuku.rikka.app)**（RikkaApps）：不用 Root 的系统权限。
- **[OpenCC](https://github.com/BYVoid/OpenCC)** / [opencc-js](https://github.com/nk2028/opencc-js)：繁体中文界面字符串由它转换，再人工校对。

## 许可

hachimia 本身以 [Apache License 2.0](LICENSE) 发布（另见 [NOTICE](NOTICE)）。

- **Antigravity CLI（`agy`）**：Google LLC 的专有软件，**不随本项目分发**，使用时须遵守 Google 相关服务条款与隐私政策。
- **开发工具包与随包 LGPL 组件**：工具包取自 Termux 官方仓库，各包许可证（`license`）载于每个 Release 附带的 `devkit.lock.json` / `SBOM.tsv`；随 APK 分发的 glibc 动态加载器（[third_party/glibc/README.md](third_party/glibc/README.md)）、7-Zip 26.06（[third_party/7zip/README.md](third_party/7zip/README.md)）及著佐权工具包组件的对应源码由 [`devkit/archive-sources.mjs`](devkit/archive-sources.mjs) 归档备存并自每次二进制分发之日起至少保留三年，需要源码副本的请在 Issues 中提出。
