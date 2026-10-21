#!/bin/bash
# 驗證這台到 M5 Pro 的整條路。setup.sh 跑完、對方加好公鑰後執行。
set -uo pipefail

TS_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale
PRO_ALIAS=pro

pass() { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
FAILED=0

echo "檢查 $(scutil --get ComputerName) -> M5 Pro"
echo

if [ -x "$TS_BIN" ]; then pass "Tailscale 已安裝"; else fail "Tailscale 未安裝"; fi

if "$TS_BIN" status >/dev/null 2>&1; then
  pass "已連上 tailnet（本機 $("$TS_BIN" ip -4 2>/dev/null)）"
else
  fail "未連上 tailnet — 跑 setup.sh 或檢查 auth key"
fi

if "$TS_BIN" status 2>/dev/null | grep -q m5prodemacbook-pro; then
  pass "看得到 M5 Pro"
else
  fail "tailnet 裡看不到 M5 Pro — 確認它開著"
fi

if [ -f ~/.ssh/id_ed25519 ]; then pass "SSH 金鑰存在"; else fail "SSH 金鑰不存在"; fi

if grep -qE "^Host +$PRO_ALIAS\$" ~/.ssh/config 2>/dev/null; then
  pass "~/.ssh/config 有 Host $PRO_ALIAS"
else
  fail "~/.ssh/config 缺 Host $PRO_ALIAS"
fi

if OUT=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$PRO_ALIAS" \
         'echo "$(whoami)@$(scutil --get ComputerName)"' 2>&1); then
  pass "SSH 連入成功：$OUT"
else
  fail "SSH 連不進去 — 公鑰可能還沒加到對方的 authorized_keys"
  echo "       $(echo "$OUT" | head -1)"
  echo
  echo "       要交給 M5 Pro 的公鑰："
  echo "       $(cat ~/.ssh/id_ed25519.pub 2>/dev/null)"
fi

if ssh -o BatchMode=yes -o ConnectTimeout=10 "$PRO_ALIAS" \
   'command -v tmux >/dev/null' 2>/dev/null; then
  pass "對方有 tmux（可跑可續接的工作階段）"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32m全部通過。\033[0m 開始用：\n'
  echo "  ssh pro                              # 進去下指令"
  echo "  ssh pro -t 'tmux new -A -s main'     # 斷線不中斷的工作階段"
else
  printf '\033[31m有項目未通過，見上方。\033[0m\n'
  exit 1
fi
