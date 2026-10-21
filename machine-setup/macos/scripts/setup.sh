#!/bin/bash
# 把這台 Mac 接進 tailnet，並設定成能連進 M5 Pro（算力主機）。
#
#   bash scripts/setup.sh <tailscale-auth-key>
#
# auth key 只從參數傳入，絕不寫進版控。
set -euo pipefail

AUTHKEY="${1:-}"
if [ -z "$AUTHKEY" ]; then
  echo "用法: bash scripts/setup.sh <tailscale-auth-key>" >&2
  echo "auth key 從 https://login.tailscale.com/admin/settings/keys 產生" >&2
  exit 1
fi

TS_APP=/Applications/Tailscale.app
TS_BIN="$TS_APP/Contents/MacOS/Tailscale"

# M5 Pro 的連線參數
PRO_HOST=100.x.x.x
PRO_USER=m5pro
PRO_ALIAS=pro

step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

step "1/5 安裝 Tailscale"
if [ -d "$TS_APP" ]; then
  echo "    已安裝，跳過"
else
  # 從 stable 頁面抓當前版本，避免寫死版號後過期
  PKG_NAME=$(curl -fsSL https://pkgs.tailscale.com/stable/ \
    | grep -oE 'Tailscale-[0-9.]+-macos\.pkg' | head -1)
  [ -z "$PKG_NAME" ] && { echo "    抓不到安裝檔名稱，請手動從 https://tailscale.com/download/macos 安裝" >&2; exit 1; }
  echo "    下載 $PKG_NAME"
  TMP=$(mktemp -d)
  curl -fsSL -o "$TMP/ts.pkg" "https://pkgs.tailscale.com/stable/$PKG_NAME"
  sudo installer -pkg "$TMP/ts.pkg" -target /
  rm -rf "$TMP"
fi
open -a Tailscale
sleep 5

step "2/5 加入 tailnet"
"$TS_BIN" up --auth-key="$AUTHKEY"
MY_IP=$("$TS_BIN" ip -4)
echo "    本機 tailnet 位址: $MY_IP"

step "3/5 產生 SSH 金鑰"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
if [ -f ~/.ssh/id_ed25519 ]; then
  echo "    已存在，沿用"
else
  ssh-keygen -t ed25519 -C "$(whoami)@$(scutil --get LocalHostName)" \
    -f ~/.ssh/id_ed25519 -N "" -q
  echo "    已產生"
fi

step "4/5 寫入 ~/.ssh/config"
touch ~/.ssh/config && chmod 600 ~/.ssh/config
if grep -qE "^Host +$PRO_ALIAS\$" ~/.ssh/config; then
  echo "    Host $PRO_ALIAS 已存在，跳過"
else
  cat >> ~/.ssh/config <<EOF

# M5 Pro（算力主機）。Tailscale 節點位址綁定節點，不會變動。
Host $PRO_ALIAS
  HostName $PRO_HOST
  User $PRO_USER
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
  ServerAliveInterval 30
  ServerAliveCountMax 6
EOF
  echo "    已加入 Host $PRO_ALIAS"
fi

step "5/5 檢查到 M5 Pro 的網路可達性"
if "$TS_BIN" ping -c 2 "$PRO_HOST" >/dev/null 2>&1; then
  echo "    tailnet 可達"
else
  echo "    ping 不到 —— 確認 M5 Pro 開著且已連上 tailnet"
fi

cat <<EOF

────────────────────────────────────────────────────────────
設定完成。最後一步需要對方配合：

把下面這行公鑰交給 M5 Pro，加進它的 ~/.ssh/authorized_keys

$(cat ~/.ssh/id_ed25519.pub)

加好之後測試：
  bash scripts/verify.sh
────────────────────────────────────────────────────────────
EOF
