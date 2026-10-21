#!/usr/bin/env bash
# 產 nofocus.dylib（universal：arm64＋x86_64）。換機器或改 nofocus.m 後重跑。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
clang -dynamiclib -arch arm64 -arch x86_64 -framework Foundation -lobjc -o nofocus.dylib nofocus.m
codesign -s - -f nofocus.dylib >/dev/null 2>&1 || true
echo "已建：$(pwd)/nofocus.dylib"
