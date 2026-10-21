#!/usr/bin/env bash
# 裝成 LaunchAgent（登入就跑、死了 launchd 拉回來）。重跑會換新。只有 macOS。
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "只有 macOS 需要"; exit 0; }
LABEL=tw.work.focus-keeper
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/osascript</string><string>-l</string><string>JavaScript</string>
    <string>$DIR/focus-keeper.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/focus-keeper.log</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/focus-keeper.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已裝：$LABEL"
