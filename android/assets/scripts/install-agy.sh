#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
#  install-agy.sh —— 安装或更新官方 Antigravity CLI (agy)
#  逻辑在旁边的 install-agy.mjs，这里给 Android 宿主与终端留统一入口。
# ─────────────────────────────────────────────────────────────────────
exec "$PREFIX/bin/node" "$(dirname "$0")/install-agy.mjs" "$@"
