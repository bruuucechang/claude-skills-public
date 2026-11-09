#!/usr/bin/env bash
# 裝成 LaunchAgent（登入就跑、每 10 秒檢查一次）。重跑會換新。只有 macOS。
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "只有 macOS 需要"; exit 0; }
LABEL=tw.work.window-rescue
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# 複製一份到固定位置再跑：這個 repo 是多 session 共用的 checkout，換分支或開 PR 時檔案會暫時不在原地。
# 改了 window-rescue.js 要重跑這支才生效。
RT="$HOME/Library/Application Support/window-rescue"
mkdir -p "$RT"
cp "$DIR/window-rescue.js" "$RT/window-rescue.js"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/osascript</string><string>-l</string><string>JavaScript</string>
    <string>$RT/window-rescue.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/window-rescue.err</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/window-rescue.err</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout 是非同步的，舊工作還沒收完時 bootstrap 會失敗；多試幾次，全失敗才算失敗
ok=
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || { echo "安裝失敗：launchctl bootstrap 五次都沒成功（$LABEL）" >&2; exit 1; }
echo "已裝：$LABEL"
