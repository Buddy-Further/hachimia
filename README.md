# hachimia

**English** · [简体中文](README.zh-CN.md) · [Discussions](https://github.com/Buddy-Further/hachimia/discussions) · [Contributing](CONTRIBUTING.md)

**A development launcher that runs the official Antigravity CLI (`agy`) on Android phones.** No root, no custom ROM, no chroot / proot / VM.

[![Release](https://img.shields.io/github/v/release/Buddy-Further/hachimia?color=4285f4&label=release)](https://github.com/Buddy-Further/hachimia/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Buddy-Further/hachimia/total?color=4285f4)](https://github.com/Buddy-Further/hachimia/releases)
[![Stars](https://img.shields.io/github/stars/Buddy-Further/hachimia?color=4285f4)](https://github.com/Buddy-Further/hachimia/stargazers)
![Android 8.0+](https://img.shields.io/badge/Android-8.0%2B-3ddc84)
[![License](https://img.shields.io/github/license/Buddy-Further/hachimia)](LICENSE)

<p align="center">
  <a href="https://github.com/Buddy-Further/hachimia/releases/latest/download/hachimia.apk"><b>Download the APK</b></a>
  &nbsp;·&nbsp; <a href="#install">Install guide</a>
</p>

Android already runs on a Linux kernel. Once the tools run natively on that kernel, a phone can do real AI-assisted development:
write code, compile C/C++, run Python / Node, build APKs and push with git — all on the phone.

> hachimia is an independent, third-party project and is not affiliated with Google. It runs the **official, unmodified Antigravity CLI (`agy`)**:
> downloaded from Google's official channel at install time, verified against the official sha256 manifest, never modified.

## Why

When you use AI on a phone and the model needs to actually do something (run code, edit files, build a package), the work usually goes to a cloud sandbox, and the phone is just a screen.
hachimia brings execution back to your own device: the cloud does model inference, while your code, files and toolchain stay local, the environment persists across sessions, and the agent can reach the device itself.

See **[Design philosophy](docs/design-philosophy.md)**.

## Features

- **Official Antigravity CLI with a GUI**: chat, streaming output, thinking, tool calls, file browser, session history.
  - Messages sent while Antigravity is working wait at the end of the chat marked *Queued*; **Send now** delivers one into the running turn without interrupting it. **Stop only stops** — queued messages are paused, never sent automatically.
  - `/compact`, `/context` and other built-in commands show their results immediately.
  - Each reply shows a live generation timer that settles to the total time when it finishes.
  - **Appearance and fonts**: palettes (including an AGY Monet color-picking theme), light or dark or following the system (status bar included). Fonts ship with the app, so the phone's system font doesn't change how it looks. Settings lets you change the interface font, the response font (serif / sans) and the text size (small / medium / large).
  - Your messages sit on the right and replies span the width, as in the desktop app. Tool calls between two pieces of reply text fold into one "N steps" line; tap to see each step. Groups with a pending approval or a failure open by themselves. Under each reply: **Copy** (the raw Markdown) and **Share** (system share sheet). Replies render Markdown with tables, task lists, LaTeX math and syntax-highlighted code blocks.
  - **Built-in help** (sidebar → More → Help): a full user guide and advanced tips, with a table of contents, in Chinese and English. Next to it, Release notes collects every version's notes and is searchable.
  - **Tablets in landscape and unfolded foldables**: depending on the window width, the layout becomes two columns (chat plus a workspace on the right) or three (plus a docked sidebar). Files, the viewer, the terminal and the in-app browser open on the right without covering the chat, and you can drag the divider between them.
  - **Work survives the background**: you get a system notification when a turn finishes or Antigravity is waiting for your approval. It shows no heads-up banner. The notification only offers *Deny* and *Open*; to allow a command you have to return to the app and read it in full. If the system kills the app, reopening it marks the unfinished turn as *Interrupted* with a *Continue* button, and queued messages are still there.
  - **Session management**: the Chats page in the sidebar searches message content and filters, and you can pin the chats you use most. Deleted sessions go to a recycle bin first. Pick sessions one by one or all at once and export them as a zip — save it anywhere with the system *Save to* picker, or share it directly — then import the zip on another device and carry on where you left off.
  - **Terminal** (top bar): a real terminal with tabs, running the same bash and toolchain Antigravity uses — hx (Helix), less, top, git and the rest. A row of extra keys supplies what phone keyboards lack (Esc, Tab, sticky Ctrl / Alt, arrows, Home / End, PgUp / PgDn, paste, font size); a text view lets you long-press to select and copy output. Terminals keep running when you close the panel and replay their output when you come back.
  - **File viewer / editor** (from the file browser): edit text and code and save — if the file changed on disk after you opened it (say Antigravity edited it), you are asked before anything is overwritten. Markdown renders with an edit toggle; images open fit-to-screen and tap to 1:1; PDFs render with [pdf.js](https://mozilla.github.io/pdf.js/) (CJK text and password-protected files included), pages drawn only as they scroll into view. Word and Excel files open directly; PowerPoint and legacy .doc files are converted to PDF once the LibreOffice component is installed. `.html` files show as live pages — CSS, JS and images they reference (in the same folder or a parent folder) load, and the page reloads when the file changes, so a browser game Antigravity wrote is playable with one tap. The top-right button is **Share**, which hands the file to the system share sheet.
  - **DevTools**: HTML previews and the in-app browser can open the bundled [Eruda](https://github.com/liriliri/eruda) — elements, console, network, storage — offline. With it on, **Pick element** puts the selector and a short HTML snippet of whatever you tap into the message box, so you can tell Antigravity what to change.
  - **Git panel** (from the file browser or the editor): see changes, history and line-by-line diffs, tick files and write a message to commit, and also discard changes, switch or create branches, pull and push.
  - **Switch right under the input box**: model, thinking effort and permission mode. On a new chat's start screen you can pick the project and model before you say anything.
  - `/goal <condition>` keeps Antigravity going turn after turn until the condition is met, with checks and elapsed time shown above the input box. Drag the compaction line on the provider and model page to choose where compaction starts.
  - **Rewind to here**: every message you sent can be rewound — undo only the files Antigravity changed since, or cut the chat back to that point in a new session and ask again. Any reply can also be **forked** into a new session, leaving the original alone. When Antigravity works through a long job, its **task list** sits above the input box, and subagents get a card of their own: one row each with status and current step, a log of who messaged whom and why, and their briefs and reports saved as files in the project. Background commands are listed there too; when there are several they fold into one line you can open to see and stop each one.
  - **Lineage** (sidebar): forks, continuations and rewinds between sessions are drawn as a metro map (or an indented tree), so you can see where each session came from. Every session gets a file number automatically; tap a stop to jump straight to that chapter. Older sessions can be filed in one go, and a short tour explains how to read the map the first time you open it.
  - **Attachments**: the top row of the ＋ panel is Attach file, Take photo, Screenshot and Browse files. Take photo opens the system camera; the photo is scaled to 2048 px on the long side and turned upright before it's attached. Screenshots go through Shizuku; long-press Screenshot to take one in 5 seconds, giving you time to switch to the app you want. Sharing to hachimia from another app attaches the file too.
  - A **↓ button** appears when you scroll up through a long chat; tap it to jump to the latest message. A dot on it means new output arrived meanwhile.
  - **Paths in replies are links**: tap an absolute path such as `/storage/emulated/0/…/report.pdf` (or `file.js:12`) and it opens in the viewer; a folder opens in the file browser. Antigravity is told to write full paths so this always works. Tool cards that read or write a file get a ↗ button too.
  - **In-app browser** (globe in the top bar): web links in replies open inside the app — handy for checking a dev server at `http://127.0.0.1:<port>/`. On wide screens it opens in the workspace on the right, next to the chat. It uses the system WebView, so it adds no download. Sign-in pages still go to your normal browser.
  - UI in 10 languages: 简体中文, 繁體中文, English, Français, Español, Русский, العربية (RTL), 日本語, 한국어, Bahasa Indonesia (machine-translated draft; corrections welcome).
- **Projects and scheduled tasks**:
  - A project is a working directory plus its AGENTS.md / CLAUDE.md and default provider, model, effort and permissions; sessions are grouped under projects by directory.
  - Scheduled tasks have Antigravity do something on a schedule — daily, weekly, monthly, every few hours, once, or a cron expression — woken on time by a system alarm. You can limit a task to read-only, to this project, or to chosen tools, and cap the cost and duration of a run and the total per day. Nobody is watching while it runs, so anything that needs your approval is refused.
- **Usage and limits**: the second half of the context line under the top bar shows what is left on the current provider, and warns you when it runs low. The Usage page records conversations, active days and models used, with a monthly report card to save or share; it counts usage only, never content.
- **The toolchain installs by module** (Extensions → Toolkit modules): it is split into base, command-line tools, C/C++ compilers, Java and Android packaging, graphics libraries, audio/video, docs and data, Go and the Node.js ecosystem. You pick modules on first install and can add or remove them later. Each one lists its purpose, main commands, size, dependencies and which components use it; typing a command from a module you have not installed tells you where to find it.
- **Optional components** (Extensions → Optional components): large tools that don't ship with the app; download them only if you need them. Each build matches a specific toolchain release, is checked against its SHA-256 and a per-file manifest before anything is installed, and uninstalls cleanly.
  - **Browser component (headless Chromium)**: lets Antigravity open pages headlessly — screenshots, PDF export, the rendered DOM, and scripted browsing with puppeteer-core. It comes with a skill that tells Antigravity how to use it.
  - **Community components** from the components repository. Dev: GitHub CLI (gh), Godot (headless runs, APK export), Graphviz / PlantUML diagrams, Hugo, reverse engineering (rizin, binwalk). Media: Blender (headless compositing and rendering, 3D on the GPU), LilyPond (music engraving), a music production toolchain. Office: LibreOffice, Pandoc, a PDF toolbox, OCR (Chinese and English), LaTeX (Tectonic, with Chinese support). AI: llama.cpp. 3D and science: OpenSCAD, GNU Octave, scientific Python (numpy / scipy / matplotlib). EDA: ngspice / gnucap, Icarus Verilog / Yosys. GPU: Snapdragon driver (Vulkan / OpenGL / OpenCL), Mali driver, GPU benchmarks. Net: Cloudflare (wrangler), rclone, QQ bots (native NapCat / SnowLuma, OneBot v11). Indexes are ed25519-signed and rejected if they do not check out; community components are labelled as such, and builds nobody has verified on a real device ask first.
  - **Custom components**: import a Linux arm64 program the market doesn't have (a single binary or a .tar.gz / .zip). It works out whether the program is glibc, Android-native, static or a script, and pulls missing libraries from the Termux glibc repository; once installed it is one command that both Antigravity and the terminal can use. Where it comes from is your responsibility.
- **Several ways to connect**:
  - Sign in with a Google account inside the app (personal Free / Pro / Ultra, or a Gemini Enterprise / Google Cloud business account); after authorizing in the browser you are brought back, or you paste the authorization code. The account card shows your usage limits with their reset times.
  - Gemini API key (Google AI Studio).
  - Any other Gemini-compatible endpoint you add, with its own address and key.
  - **Per conversation**: the provider, model and effort in Settings are defaults; picking something inside a conversation changes only that one. Several conversations can run at once — one on a Google account, another on a Gemini API key — without getting in each other's way.
- **A complete development toolchain** (about 250 packages, taken from the official [Termux](https://termux.dev) repositories):
  - C/C++: clang 21 / lld, make / cmake / ninja, gdb / strace.
  - Languages: Python 3.14 (pip, venv), Node 26 (npm, npx).
  - Android builds: OpenJDK 21, aapt2 / d8 / apksigner — build APKs on the phone.
  - VCS and network: git, ssh, curl.
  - Audio and video: ffmpeg 9 (x264 / x265 / VP9 / AV1 / Opus…) with hardware encoding on the phone (`h264_mediacodec` / `hevc_mediacodec`), more than 3× faster than software encoding.
  - CLI tools: rg / fd / bat / jq / sqlite3 / typst / ImageMagick… Tab completion works in interactive bash; `hx-grammar` installs just the Helix syntax grammars you need; typst finds the system CJK fonts out of the box.
  - Anything missing: `pkg install` in the terminal installs it from the Termux repositories, and `pkg verified` lists the packages tested to work.
- **System privileges (optional)**: [Shizuku](https://shizuku.rikka.app) integration. In the terminal, `priv '<cmd>'` runs pm / am / settings / logcat / screencap… as the shell user.
  - One-tap install and activation from Settings: downloaded from Shizuku's official release (signing certificate verified), installed with the system installer,
    then activated over Wireless debugging — no computer needed. The pairing code is entered in a notification that stays at the top of the screen, so the pairing dialog stays open.
  - After a reboot, hachimia turns Wireless debugging back on and re-activates Shizuku by itself (Wi‑Fi required).
- **Device tools (off by default)**: turn them on in Settings → Device tools and Antigravity can post notifications, read and write the clipboard, share files to other apps, open links or apps, and check battery and network; reading and tapping the screen uses accessibility and is a separate switch. Under the hood this is an MCP server for Antigravity that calls the system through Priv. Calendar, mail and the like are only pre-filled; you save or send them yourself.
- **Memory manager (off by default)**: before heavy jobs such as builds or renders, it stops background apps outside an allowlist through Shizuku, and stops them again if they come back while the job runs. The app you're looking at, split-screen apps and anything with a foreground notification are left alone. In the terminal, use `cc-mem run -- <command>`. How to read memory numbers and find the culprit: [docs/memory-management.md](docs/memory-management.md).
- **Work Island (ColorOS, off by default)**: with the community-built Work Island app installed, Antigravity working, waiting for your approval and finishing a task show up on the ColorOS 16 Fluid Cloud island. See [docs/work-island.md](docs/work-island.md).
- **Automatic updates** (on by default; can be turned off or triggered manually in Settings):
  - Antigravity CLI: silent updates from the official channel (stable / latest, or pinned to a specific version); running conversations are not affected.
  - hachimia itself: downloaded, signature-checked, then offered for install; installed silently when idle if Shizuku is available. There are two APKs, targetSdk 28 and 36; updates follow the one you have installed, and you can switch in Settings (a system that only accepts 36 won't let you switch back to 28).
  - Toolchain: pre-downloaded on Wi‑Fi only and swapped in the next time the app opens; anything you installed with pip / npm -g is kept.
  - Updates never cut each other off: while the toolchain is downloading or being replaced, the app update waits. The replacement is checked against the release manifest before the old toolchain is touched, and if it is interrupted (app restart, process killed) the next launch finishes it or rolls back.
  - **Verify / Repair** in Settings checks every toolchain file against its recorded hash; Repair reinstalls the same version and keeps your own packages. A quick check also runs at each launch.
- **Extensions**: install, enable, disable and uninstall Antigravity plugins (search the official directory or add other marketplaces), install skills from a zip, and add, edit or remove MCP servers (long-press or double-tap an entry to edit it directly; tokens are never echoed, only their names) — all from the Extensions tab. From 0.6.7, plugin hooks don't run, and your own skills are invoked as `/user:name`.
- **Checked before anything runs**:
  - Antigravity CLI only runs if it matches the recorded sha256 manifest for its version. The gateway uses its own copy of its runtime, checked against the app package before every start, so package upgrades and toolkit updates can't touch it.
  - Config handed to Antigravity (AGENTS.md / CLAUDE.md, rules, skills, commands, agents, output styles, text in plugins, auto memory) is scanned for jailbreak patterns first. If something matches, that turn doesn't run and you're told which file and line. MCP servers are passed on as registered in `~/.claude.json`; their definitions aren't part of this scan.
  - Project config that would run on its own (hooks, MCP servers in `.mcp.json`) isn't loaded. Background programs left by an earlier conversation are shown to you before anything continues.
- **Troubleshooting**:
  - **Safe mode**: if a hook, plugin, MCP server or AGENTS.md breaks things, turn on safe mode and Antigravity starts in a restricted mode — no customizations loaded, while sign-in, keys, sessions and model stay as they are. Nothing is moved or edited; turning it off restores everything.
  - **I'm stuck · bundle diagnostics** (in Settings, and on the install-failure screen): diagnostics, the app log, the gateway log and the repair ledger, packed into a zip and handed to the system share sheet. Before packing, you see a list of what goes in. Keys, tokens, email addresses and the content of your messages to Antigravity are scrubbed first, and conversation transcripts are not included.
  - **Plain-language first-install errors**: the app checks free space before downloading and tells you how much it needs. Failures such as being offline, rate limiting or a checksum mismatch are explained in plain words. *Retry* resumes from what was already downloaded.
  - **Repair ledger**: every toolchain install, verification, repair and startup recovery is recorded (what was found, what was done, the result) and can be read in Settings.
  - **Known issues**: problems not yet fully explained or ruled out, and what we know about each, are listed in [docs/known-issues.md](docs/known-issues.md).
  - **Permissions**: what each permission is for, when you're asked and what happens if you say no, in [docs/permissions.md](docs/permissions.md). Found a security problem? Report it privately as described in [SECURITY.md](SECURITY.md).
- **USB debugging of another device**: connect it with an OTG cable and run `usb-adb`, then `adb devices / install / shell` as usual.
- **Self-test**: the bundled self-test exercises more than 70 tools and usages (including ffmpeg and a hardware-encoding probe); the tool notes are injected into Antigravity's system prompt so it knows what it has.

## Install

1. Download `hachimia.apk` from [Releases](https://github.com/Buddy-Further/hachimia/releases) and install it. If Android says it isn’t compatible and won’t install it, use `hachimia-36.apk` from the same release instead (targets SDK 36, same features; see “Updates and repair” in the in-app help for how the two differ).
2. Open the app. The first launch automatically:
   - downloads the toolchain: you pick modules first; the base is required, and the command-line tools and C/C++ compilers are ticked by default, about 350 MB in total (all modules about 740 MB); resumable, sha256-verified, then unpacked;
   - downloads Antigravity CLI from Google's official channel.
3. Choose how to connect in Settings: sign in with a Google account, or enter a Gemini API key.
4. (Optional) Install and start Shizuku, then grant it in Settings to enable `priv` and stronger keep-alive.

Requirements: Android 8.0+, arm64, about 4 GB free space.

Versions with a suffix (such as `v0.2.0-rc1`) are pre-releases. In-app updates only offer stable releases; download pre-releases from Releases by hand.

**Allow background running on vendor ROMs**: some vendors' power savers ignore foreground services and freeze the whole app in the background, stopping any running task. When hachimia detects a freeze during a running task, Settings tells you exactly where to fix it.

**Offline install**: download `devkit-ha.chi.mia.tar.gz` to the phone first, then on first launch choose "Choose a local file…" and pick it. Nothing else is downloaded, and the file is checked against the published releases before installing.

**Versions**: v0.1.0 was the first usable release. Each release installs over the old one and keeps your data and installed tools.

## Community and contributing

- **Questions, ideas, device reports**: [GitHub Discussions](https://github.com/Buddy-Further/hachimia/discussions), in English or Chinese. There is also a Chinese-speaking QQ group, 1062538743.
- **Bugs**: in the app, tap Settings → Report on GitHub; your device and self-test results are filled in for you.

**Day-to-day maintenance is still mostly one person, with a few community members testing, reviewing and red-teaming, so help is very welcome.** Device reports, translation fixes, component recipes, docs and code are all welcome, and you can help without writing code. See the [contributing guide](CONTRIBUTING.md).

## How it works

```
hachimia.apk (Java shell: installer + foreground service + WebView)
  ├─ files/usr/      toolchain: official Termux packages, run natively after same-length prefix relocation
  ├─ official Antigravity CLI (agy, Android bionic build, unmodified binary)
  │     └─ driven by the gateway over the ACP protocol (JSON-RPC), checked against its recorded sha256
  ├─ lib/arm64-v8a/libldlinux.so   the same glibc loader; the 36 build starts glibc programs through it
  ├─ files/gw/       the gateway's own runtime (Node, glibc and so on), checked against the app package before every start
  └─ gateway gateway/server.mjs + gw/ (Node): runs agy, event stream, queue, provider config → UI gateway/web/
```

- **Same-length prefix relocation**: Termux binaries have `/data/data/com.termux/` baked in at build time. The package name `ha.chi.mia` has exactly the same 10 characters as `com.termux`, so a byte-for-byte replacement fixes every RUNPATH, shebang and config path — no `LD_LIBRARY_PATH`, wrapper scripts or binary patching. Entries inside zip / jmod archives are rewritten too. See [devkit/README.md](devkit/README.md).
- **seccomp**: Android installs a syscall allow-list on app processes and kills anything outside it with SIGSYS. Android 14 does not allow `epoll_pwait2`, so a glibc program would be killed at startup. [`seccomp-enosys.c`](android/native/seccomp-enosys.c) turns such calls into ENOSYS so programs take their own fallback path; `enosys-run` does the same from outside (ptrace) for static binaries.
- **targetSdk 36**: since Android 10, apps targeting SDK 29 or later can't execute files in their own data directory. The regular APK still targets 28. The 36 build puts the glibc loader in the APK's native library directory, which the system does allow, starts bionic programs through `/system/bin/linker64`, and an exec shim ([`exec-shim.c`](android/native/exec-shim.c)) rewrites every program launch into one of those two forms. Both APKs have the same features; every component has been run on a real device with the 36 build.
- **Gateway access control**: the gateway listens on two loopback addresses: 127.0.0.2, dedicated to the UI, and 127.0.0.1 for local tools. Every `/api/*` request must carry a 256-bit token from the app private directory, and Host and Origin are checked. The session cookie is honored only on requests that arrive at 127.0.0.2, and the built-in browser blocks that address, so the cookie never reaches other services on the device. The app itself never sends the raw token: each request is signed once (an HMAC over a timestamp, a single-use nonce, the boot ID, the listening address, the method and the body hash), so a captured request cannot be replayed. Before handing over any credentials, the app also challenges the gateway to answer an HMAC keyed with the token, proving that whatever answers on the port is the real gateway. Other apps and web pages on the device cannot drive it.
- **Credentials**: account sign-in is done by Antigravity CLI itself. The gateway hands the authorization URL to the system browser and never reads or stores Google credentials; it does not handle the one-time authorization code either (see [Terms and compliance](#terms-and-compliance)). Third-party API keys live in the app's private directory and reach agy through environment variables, never through world-readable files.

Rules the project holds to:

- **Launch the official package, never modify it.** Antigravity CLI comes from official channels only. The APK never bundles it.
- **No root, no proot.** The toolchain runs natively. Platform limits are handled with prefix relocation, the seccomp shim and the loader, and privileged actions go only through Shizuku.
- **The gateway owns runs.** The UI only subscribes to events, so a page reload, going to the background or parallel sessions never interrupt a turn in progress.
- **Verify before trusting.** Toolkits, modules, component indexes, notices and release lists are checked against ed25519 or sha256 signatures bound to a specific release.
- **Every change gets verified.** Gateway tests run only through the runner, every release and toolkit publish step checks hashes, and components state whether they have been verified on a real device.

## Privacy & data protection

See **[PRIVACY.md](PRIVACY.md)** for the full breakdown. hachimia has **no user accounts, no backend server, no cloud chat sync, and zero first-party telemetry or proprietary analytics SDKs** — every control and boundary below can be verified directly in the source tree:

- **Zero first-party telemetry, zero external CDNs & honest upstream CLI boundary**:
  - hachimia itself generates no persistent install ID (`iid`), uploads no usage or crash telemetry, and bundles no Google Play Services, ML Kit, Firebase, Sentry, or ad SDKs; all UI scripts and fonts ship offline in [`gateway/web/vendor/`](gateway/web/vendor/).
  - **Upstream Antigravity CLI (`agy`) boundary**: hachimia launches Google's official, unmodified proprietary `agy` binary downloaded on first run (verified by SHA-256, never patched; see [`android/assets/scripts/install-agy.mjs`](android/assets/scripts/install-agy.mjs)). `agy` connects directly to Google's services for authentication and inference, and may carry Google's own internal diagnostics/telemetry governed by [Google's Privacy Policy](https://policies.google.com/privacy); none of that traffic goes through any hachimia server. For the optional Claude Code path, [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs) (`claudeEnv`) sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"`.
- **Credential isolation, local usage & scrubbed diagnostics**:
  - `android:allowBackup="false"` in [`android/AndroidManifest.xml`](android/AndroidManifest.xml) keeps chats, settings, and credentials inside `/data/data/ha.chi.mia/files/home/` and out of Android cloud backups.
  - Google sign-in uses `agy`'s own OAuth flow; hachimia checks locally only whether session JSON files parse as non-empty objects and **never extracts, logs, or uploads OAuth token fields** ([`gateway/gw/agy-creds.mjs`](gateway/gw/agy-creds.mjs) `hasAgySessionFiles`, [`gateway/gw/login.mjs`](gateway/gw/login.mjs)).
  - The gateway binds loopback `127.0.0.2` (UI) and `127.0.0.1` only, requiring a 256-bit token, Host/Origin checks, and boot-scoped single-use HMAC request signatures ([`gateway/gw/access.mjs`](gateway/gw/access.mjs), [`android/java/ha/chi/mia/Events.java`](android/java/ha/chi/mia/Events.java)).
  - Usage stats read local session files only with zero network requests ([`gateway/gw/usage.mjs`](gateway/gw/usage.mjs)); diagnostic zips scrub keys, tokens, emails, and user prompts locally before invoking the system share sheet and exclude transcripts ([`android/java/ha/chi/mia/Share.java`](android/java/ha/chi/mia/Share.java) `bundleLogs`); GitHub feedback pre-fills a browser URL only when you tap the button ([`gateway/gw/feedback.mjs`](gateway/gw/feedback.mjs) `issueDraft`).
- **Complete outbound network inventory & switches** (aside from commands you explicitly run in chats/terminals):

| Purpose | Default & Switch | Destinations | Trust Anchor & Source |
|---|---|---|---|
| Model inference & sign-in | When you chat or sign in | Google's official endpoints (via `agy` ACP) or your custom third-party endpoint | [`gateway/gw/acp.mjs`](gateway/gw/acp.mjs), [`gateway/gw/providers.mjs`](gateway/gw/providers.mjs), [`gateway/gw/login.mjs`](gateway/gw/login.mjs) |
| Automatic update checks & verified list | On (updates every 6h, verified list every 3h); turn off both in **Settings → Updates → Automatic updates** | `api.github.com` (`Buddy-Further/hachimia`), `raw.githubusercontent.com`, `antigravity.google`, official `agy` manifest service | APK signing cert + SHA-256; pinned SHA-256 / `ed25519` for devkit; official manifest SHA-256 + `ed25519` `.sig` for `agy` ([`android/java/ha/chi/mia/Updater.java`](android/java/ha/chi/mia/Updater.java) `AUTO_EVERY`, [`android/assets/scripts/install-agy.mjs`](android/assets/scripts/install-agy.mjs), [`gateway/gw/ccverified.mjs`](gateway/gw/ccverified.mjs) `refreshVerified`) |
| Signed maintainer notices (every 3h) | On; turn off in **Settings → Updates → Maintainer notices** | `raw.githubusercontent.com/Buddy-Further/hachimia` (static `GET`, no device parameters) | Pinned `ed25519` public key detached `.sig` ([`gateway/gw/notices.mjs`](gateway/gw/notices.mjs) `refreshNotices`) |
| Third-party GitHub proxy (`gh-proxy.com`) | **Off by default**; opt in via **Settings → Updates → GitHub third-party proxy fallback** | `gh-proxy.com` (external public proxy; sees your IP and target URL if enabled) | Pinned SHA-256 and signatures still enforced ([`android/java/ha/chi/mia/Installer.java`](android/java/ha/chi/mia/Installer.java) `ghProxyEnabled`, [`gateway/gw/pget.mjs`](gateway/gw/pget.mjs) `ghProxy`) |
| Toolkit / component / local model downloads | First-run setup or tapping Install in Extensions | GitHub Releases, Termux & university mirrors, ModelScope / HuggingFace | Pinned SHA-256, Termux PGP signature, or `ed25519` index signature ([`gateway/gw/components.mjs`](gateway/gw/components.mjs), [`gateway/gw/modules.mjs`](gateway/gw/modules.mjs), [`android/assets/bin/pkg.mjs`](android/assets/bin/pkg.mjs)) |

- **Permission minimization & protected-app screen blocking**:
  - Never requests `CAMERA`, `RECORD_AUDIO`, `ACCESS_*_LOCATION`, contacts, SMS, call logs, `READ_CALENDAR`, `PACKAGE_USAGE_STATS`, `NotificationListenerService`, or `MediaProjection`; see [docs/permissions.md](docs/permissions.md).
  - Device tools and accessibility are off by default, gated by lock-screen biometric check ([`android/java/ha/chi/mia/Consent.java`](android/java/ha/chi/mia/Consent.java)) and a foreground native dialog ([`android/java/ha/chi/mia/DeviceTools.java`](android/java/ha/chi/mia/DeviceTools.java)), auto-disable after 10 minutes of inactivity in the default "Auto (on demand)" mode ([`android/java/ha/chi/mia/A11y.java`](android/java/ha/chi/mia/A11y.java) `scheduleIdle`), strip `isPassword()` text, **hard-block active banking, Alipay/UnionPay/wallets, 2FA authenticators, password managers, and system permission controllers on the Accessibility channel** ([`android/java/ha/chi/mia/A11y.java`](android/java/ha/chi/mia/A11y.java) `isProtectedPackage`), and enforce an in-memory safety guard ([`gateway/guard/cc-guard.mjs`](gateway/guard/cc-guard.mjs)) plus ACP permission cards ([`gateway/gw/acp.mjs`](gateway/gw/acp.mjs)).
  - **Custom third-party endpoints**: Prompts, code, and tool outputs sent to any model endpoint are governed by that operator's privacy policy — never use untrusted third-party endpoints for sensitive secrets or personal data.

## Terms and compliance

hachimia aims to follow Google's terms for products that run Antigravity CLI. Below is exactly what the app does, so you can judge for yourself:

- **How the binary runs.** The Antigravity CLI file is byte-for-byte the official Android build: checked against the official sha256 manifest and never patched.
- **Signing in with a Google account.** Sign-in is Antigravity CLI's own OAuth flow. You authorize on Google's page in your browser, agy writes the token to its own credential store (the app never reads that file), and while signed in agy talks to Google's services directly, not through any process of ours. In practice this is the same as SSHing into a Linux machine you own, running agy there and signing in: here the Linux machine is the phone, and the app is the screen and keyboard. Every turn starts with you: either a message you send, or a scheduled task you set up yourself. Scheduled tasks run on your own phone, under your own account, with the same unmodified agy; since nobody is watching, anything that needs approval is refused — the app never clicks "Allow" for you. Scheduled tasks that would run on a subscription account are off by default; you turn them on yourself.
- **The one-time authorization code.** Normally the browser hands the code back to agy automatically, on this device, without passing through the app. If that fails (for example you authorized on another device), the app opens its built-in terminal and runs `agy` there; you paste the code into agy's own prompt. The terminal is a generic byte channel, like Termux or SSH; the app has no field that accepts the code and never parses, saves or logs it.
- **Permission prompts.** Like the official CLI, Antigravity asks before editing files, running commands or going online, and you answer in the chat. The default mode is "Ask each time"; "Allow everything" is available but asks for confirmation first.
- **No resale, no middleman.** hachimia is free and open source, has no server, and does not provide, pay for or resell any model usage: you sign in with your own account or bring your own API key, and usage is billed to you directly.

### What this project does not do

hachimia is free and open source, has no server, and does not provide, pay for or resell any model usage: you sign in with your own account or bring your own API key, and usage is billed to you directly.

- **No shared or resold accounts.** Splitting one subscription among multiple people, or repackaging subscription usage as an API for sale, is not supported; we don't build features for it or accept PRs that add it, and the component market does not accept such components.
- **No jailbreaking.** Getting around a model's safety limits to extract harmful content it would otherwise refuse is not supported.
- **No mass-controlled accounts.** Using agents to register, farm or run accounts in bulk to flood comment sections while passing as real people is not supported.

Third-party endpoints are a separate matter: the app lets you connect to any third-party endpoint that speaks a compatible protocol, with an address and key you provide. A reverse proxy is a technology; what we oppose is splitting subscriptions, reselling usage, stealing keys or swapping models — not using a proxy because of payment, region or network constraints.

Third-party endpoints carry real risks: the operator can see the code, keys and conversations that pass through; shared or resold accounts can be banned; models can be swapped. Those risks are the user's to bear.

We don't police other people's choices. But this project does not provide shared/resale features, and does not help troubleshoot those uses.

## Build

```sh
sh scripts/build.sh                 # javac → d8 → aapt2 → sign, produces dist/hachimia.apk (targetSdk 28)
TARGET_SDK=36 sh scripts/build.sh   # the 36 build; scripts/ship.mjs builds both for a release
node devkit/devkit.mjs build --target ha.chi.mia   # build the toolchain (CI can do this too)
```

**No setup needed**: GitHub Actions builds an APK for every pull request and every push to main; download it from that run's Artifacts (see [.github/workflows/apk.yml](.github/workflows/apk.yml)). Builds from main are signed with the release key and install over the released app. Pull requests from forks are signed with a throwaway test key, so you have to uninstall the released app first; a spare device is best.

To build on your own machine, install JDK 17, Node.js, the Android SDK (build-tools and a platform) and the NDK, then set the environment variables described at the top of `build.sh`. `apk.yml` is a working example. The script's default tool paths point at the author's Android tablet.

Release signing certificate SHA-256: `D3:41:C3:91:A8:25:BB:B7:30:39:7F:00:9F:7B:82:54:B9:7A:00:DB:57:CA:E2:54:FA:14:AA:3A:2F:F4:5A:48`.

The toolchain is built and published by GitHub Actions: push a tag like `devkit-YYYY.MM.DD` (see [.github/workflows/devkit.yml](.github/workflows/devkit.yml)).
Which toolchain version the app downloads is set in [devkit-sources.txt](devkit-sources.txt). The size and SHA-256 of that version live in [devkit-pin.json](devkit-pin.json), which ships inside the APK: the first install (from GitHub, or a local file) and the check on local files both trust it rather than the download source. It also pins the SHA-256 of the lock file `devkit.lock.json` itself, which `build.sh` checks before extracting the glibc loader instead of relying on HTTPS alone. When you switch versions, edit the former, run `node scripts/pin-devkit.mjs "$(head -1 devkit-sources.txt)" devkit-pin.json`, and commit both; `build.sh` checks that they match.

Layout:

| Directory | Contents |
|---|---|
| `android/` | Java shell, Manifest, resources, terminal helpers (`assets/bin/`), native libraries (`native/`), the original glibc loader shipped in the APK (`prebuilt/glibc/`) |
| `gateway/` | Gateway (`server.mjs` + feature modules in `gw/`, Node.js) and UI (`web/`, plain JS, no build step) |
| `i18n/` | UI translations: one txt per language plus the generate and check scripts, see [i18n/README.md](i18n/README.md) |
| `devkit/` | Toolchain build script and manifests |
| `docs/design-philosophy.md` | Why the project exists and the principles behind it |
| `docs/large-screen.md` | Large-screen layout (tablets, foldables) and where its code lives |
| `docs/known-issues.md` | Known issues and unresolved risks, plus test actions that create fake bugs |
| `docs/download-sources.md` | Every download chain: sources, trust anchors, server mirrors, how to check and maintain them |
| `docs/memory-management.md` | Reading memory numbers, finding the process that eats memory, and how the memory manager works |
| `docs/work-island.md` | The Work Island (ColorOS) integration: parts, turning it on and off, design notes and known limits |
| `docs/permissions.md` | What each permission is for, when you're asked and what happens if you refuse, and the risks of the three heavy ones |
| `docs/operit2-on-device-build.md` | Case study: building Operit2 (Flutter + Rust) from source into an APK on a phone, with every gap and fix |
| `third_party/` | Shizuku-API 13.1.5 (MIT, unmodified from Maven Central) |

## Special thanks

- **[Eruda](https://github.com/liriliri/eruda)** (liriliri, MIT): the developer tools in previews and the browser pane; license in [ThirdPartyLicenses/eruda](ThirdPartyLicenses/eruda/LICENSE).
- **[Termux](https://termux.dev)**: the toolchain is assembled from its official packages.
- **[Shizuku](https://shizuku.rikka.app)** (RikkaApps): system privileges without root.
- **[OpenCC](https://github.com/BYVoid/OpenCC)** / [opencc-js](https://github.com/nk2028/opencc-js): the Traditional Chinese UI strings were converted with it, then reviewed by hand.

## License

hachimia itself is released under the [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)).

- **Antigravity CLI (`agy`)**: proprietary software by Google LLC, **not distributed with this project**; its use is subject to Google's applicable terms and privacy policy.
- **Toolchain & bundled LGPL libraries**: toolchain packages come from the official Termux repositories with per-package licenses (`license`) recorded in each release's `devkit.lock.json` / `SBOM.tsv`. Source-archiving tooling for the bundled glibc loader ([third_party/glibc/README.md](third_party/glibc/README.md)), 7-Zip 26.06 ([third_party/7zip/README.md](third_party/7zip/README.md)), and copyleft toolchain packages is provided in [`devkit/archive-sources.mjs`](devkit/archive-sources.mjs); complete Corresponding Source is provided upon written request (for example in Issues) for at least three years from each binary release.
