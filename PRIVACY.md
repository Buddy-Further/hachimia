# Privacy & Data Protection

English | [中文](PRIVACY.zh-CN.md)

hachimia has no user accounts, no backend application server, no cloud chat sync, and zero first-party telemetry or analytics. This document explains what stays on your phone, every outbound network request the app or gateway can make, how to turn each one off, the boundary with the upstream proprietary CLI binary, and where to verify each control in the source code.

## 1. Zero First-Party Telemetry & Local Data Storage

- **No first-party telemetry or proprietary analytics SDKs**: hachimia itself collects no usage statistics, generates no persistent install ID (`iid`), uploads no automatic crash reports, and bundles no Google Play Services, ML Kit, Firebase, Sentry, or ad SDKs. All UI scripts and fonts ([`gateway/web/vendor/`](gateway/web/vendor/)) are bundled offline with zero external CDN requests.
- **Upstream Antigravity CLI (`agy`) boundary**: hachimia launches the official, unmodified proprietary `agy` binary downloaded from Google on first run (verified by SHA-256, never patched; see [`android/assets/scripts/install-agy.mjs`](android/assets/scripts/install-agy.mjs)). `agy` connects directly to Google's services for sign-in and inference, and may include Google's own internal diagnostics/telemetry governed by [Google's Privacy Policy](https://policies.google.com/privacy); none of that traffic passes through any hachimia server. Subprocess environments built by [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs) (`claudeEnv`) also set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"`.
- **Credentials and transcripts stay in private storage**:
  - `android:allowBackup="false"` is set in [`android/AndroidManifest.xml`](android/AndroidManifest.xml); conversations, API keys, and login credentials live under `/data/data/ha.chi.mia/files/home/` and are excluded from Android cloud backups.
  - Google sign-in runs through `agy`'s own OAuth flow; hachimia checks locally only whether session JSON files parse as non-empty objects and **never extracts, logs, or uploads OAuth token fields** ([`gateway/gw/agy-creds.mjs`](gateway/gw/agy-creds.mjs) `hasAgySessionFiles`, [`gateway/gw/login.mjs`](gateway/gw/login.mjs)).
- **Local-only usage & scrubbed diagnostics**:
  - The Usage tab computes counts from local session files only with zero network traffic ([`gateway/gw/usage.mjs`](gateway/gw/usage.mjs)).
  - "Bundle diagnostics" scrubs keys, tokens, email addresses, and user message bodies locally before handing the zip to the system share sheet, and excludes conversation transcripts ([`android/java/ha/chi/mia/Share.java`](android/java/ha/chi/mia/Share.java) `bundleLogs`).
  - "Report on GitHub" reads device/ROM properties only when you tap the button to pre-fill a browser URL for your review ([`gateway/gw/feedback.mjs`](gateway/gw/feedback.mjs) `issueDraft`).

## 2. Complete Outbound Network Inventory & Switches

Apart from commands you or your agent explicitly run in chats/terminals, the app and gateway only ever make the following network requests:

| Purpose | Default & Switch | Destinations | What Is Sent | Verification & Source |
|---|---|---|---|---|
| **Model inference & sign-in** | Triggered when you chat or sign in | Google's official endpoints (via `agy` ACP) or your custom third-party Gemini-compatible endpoint | Prompts, tool outputs, and the credentials for that endpoint | [`gateway/gw/acp.mjs`](gateway/gw/acp.mjs), [`gateway/gw/providers.mjs`](gateway/gw/providers.mjs), [`gateway/gw/login.mjs`](gateway/gw/login.mjs) |
| **Automatic update checks & verified list** | On by default (updates every 6h, signed verified/bad-version list every 3h); turn off both in **Settings → Updates → Automatic updates** | `api.github.com` (`Buddy-Further/hachimia`), `raw.githubusercontent.com`, `antigravity.google`, and Google's official `agy` manifest endpoint | Plain HTTPS `GET` (no device fingerprint or account data) | APK signing cert + SHA-256; pinned SHA-256 / `ed25519` for devkit; official manifest SHA-256 + `ed25519` `.sig` for `agy` ([`android/java/ha/chi/mia/Updater.java`](android/java/ha/chi/mia/Updater.java), [`android/assets/scripts/install-agy.mjs`](android/assets/scripts/install-agy.mjs), [`gateway/gw/ccverified.mjs`](gateway/gw/ccverified.mjs) `refreshVerified`) |
| **Signed maintainer notices** | On by default (every 3h); turn off in **Settings → Updates → Maintainer notices** (without disabling known-bad update blocks) | `raw.githubusercontent.com/Buddy-Further/hachimia/main/notices/notices.json` | Static `GET` with no device parameters (zero requests when switched off) | Verified against pinned `ed25519` public key `.sig` ([`gateway/gw/notices.mjs`](gateway/gw/notices.mjs) `refreshNotices`) |
| **Third-party GitHub proxy (`gh-proxy.com`)** | **Off by default**; used only if you enable **Settings → Updates → GitHub third-party proxy fallback** and official hosts fail | `gh-proxy.com` (external public proxy) | Your connection IP and target GitHub Release URL | Downloaded bytes are still verified against pinned SHA-256 and signatures ([`android/java/ha/chi/mia/Installer.java`](android/java/ha/chi/mia/Installer.java) `ghProxyEnabled`, [`gateway/gw/pget.mjs`](gateway/gw/pget.mjs) `ghProxy`) |
| **On-demand toolkit / component / local model downloads** | First-run setup or when you tap Install in Extensions | GitHub Releases, Termux & university mirrors, ModelScope / HuggingFace | Standard HTTPS file downloads | Pinned SHA-256, Termux PGP signature, or `ed25519` index signature ([`gateway/gw/components.mjs`](gateway/gw/components.mjs), [`android/assets/bin/pkg.mjs`](android/assets/bin/pkg.mjs)) |

Turning off both **Automatic updates** and **Maintainer notices** in **Settings → Updates** stops all background update and notice polling.

## 3. Android Permission Minimization & Protected-App Guardrails

- **Never requested**: Camera (`CAMERA`), microphone (`RECORD_AUDIO`), coarse/fine/background location (`ACCESS_*_LOCATION`), contacts, SMS, call logs, calendar (`READ_CALENDAR`), app usage stats (`PACKAGE_USAGE_STATS`), notification listener (`NotificationListenerService`), and screen recording projection (`MediaProjection`).
- **Layered guardrails on Device Tools & Accessibility**:
  1. Off by default; enabling requires lock-screen biometric attestation ([`Consent.java`](android/java/ha/chi/mia/Consent.java)) and a foreground native confirmation dialog ([`DeviceTools.java`](android/java/ha/chi/mia/DeviceTools.java));
  2. In the default "Auto (on demand)" mode, auto-disables itself via `disableSelf()` after inactivity (10 minutes by default, [`A11y.java`](android/java/ha/chi/mia/A11y.java) `scheduleIdle`; "Always on" stays active until changed) — never auto-revives behind your back;
  3. Strips `isPassword()` fields and **hard-blocks banking, payment/wallet, 2FA authenticator, password manager, and system permission-controller active windows on the Accessibility channel** (`A11y.isProtectedPackage`) from reading, screenshots, and gestures;
  4. Enforces an in-memory safety guard ([`gateway/guard/cc-guard.mjs`](gateway/guard/cc-guard.mjs)) and ACP permission prompts ([`gateway/gw/acp.mjs`](gateway/gw/acp.mjs)) whenever an action touches credential files, reads/taps the screen, reads the clipboard, or shares files out.

## 4. Third-Party Model Providers & Custom Endpoints

Prompts, workspace files, screenshots, or UI trees sent to a model provider (Google's official endpoints or any custom third-party endpoint you configure) are processed under that provider's own privacy policy. Operators of custom third-party endpoints can inspect traffic, keys, and code passing through them — never send sensitive secrets or personal data to untrusted third-party endpoints.
