#!/usr/bin/env bash
# 開工前的環境體檢。全部平行跑，硬性上限 ~8 秒。
#
# 每一項都對應一個真的發生過、而且「不會報錯只會怪怪的」的故障。
# 沒有推理，只有實測——所以看到 ✗ 就是真的壞了，不用再確認一次。
set -u
SP="${TMPDIR:-/tmp}/preflight.$$"; mkdir -p "$SP"; trap 'rm -rf "$SP"' EXIT
G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'

# printf 的 %-22s 是按**位元組**補空白，中文一個字 3 位元組卻只佔 2 欄，
# 所以欄位會歪。自己算顯示寬度：非 ASCII 的字各多算一欄。
pad(){ local s=$1 w=${2:-22} n a
  n=${#s}; a=$(printf '%s' "$s" | tr -cd '\40-\176' | wc -c | tr -d ' ')
  printf '%s%*s' "$s" $(( w - n - (n - a) )) ''; }
ok(){   printf '  %s✓%s %s %s\n'       "$G" "$N" "$(pad "$1")" "${2-}"; }
no(){   printf '  %s✗%s %s %s%s%s\n'   "$R" "$N" "$(pad "$1")" "$D" "${2-}" "$N"; }
warn(){ printf '  %s!%s %s %s%s%s\n'   "$Y" "$N" "$(pad "$1")" "$D" "${2-}" "$N"; }

# ── 平行發動所有會等待的檢查 ───────────────────────────
( curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:5250/api/state >"$SP/dash" 2>&1 ) &
# victus 從 2026-09-16 起也有 ssh 別名（之前是 IP 寫死的 user@192.168.1.105，
# DHCP 一變號就只會說連不上、不會說是位址換了）。三台一起用別名查。
for h in pro victus desk; do
  ( ssh -o ConnectTimeout=4 -o BatchMode=yes "$h" 'echo up' >"$SP/ssh.$h" 2>&1 ) &
done
( ls ~/Documents >/dev/null 2>&1 && echo ok >"$SP/tcc" || echo no >"$SP/tcc" ) &

# **一定要等背景工作寫完才去讀它們的輸出檔。**
# 第一版把 wait 放在最後，於是控制台那一格讀到的是還沒被寫入的空檔案，
# 明明回 200 卻報「連不上」—— 一個會謊報故障的健檢比沒有健檢更糟。
wait

echo
echo "  ── 身分 ──────────────────────────────────────"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
ok "設定目錄" "$CFG"
GE=$(git config user.email 2>/dev/null || true)
case "$GE" in
  you@example.com|*users.noreply.github.com) ok "git 作者" "$GE" ;;
  "") warn "git 作者" "這個目錄沒設 —— 會沿用全域，commit hook 可能擋下來" ;;
  # 大括號不能省：$GE 後面直接接全形括號時，bash 會把那個多位元組字元
  # 當成變數名的一部分，配上 set -u 就是「unbound variable」直接中止。
  # 這條只在失敗路徑上，正常跑一百次也不會發現——所以健檢一定要注入故障測。
  *) no "git 作者" "${GE}（不是那兩個有效身分，commit 會被 hook 擋）" ;;
esac

# .zshrc 修過的洩漏：這個變數若被整棵終端機繼承，transcript 會寫不進去
if [ -n "${CLAUDE_CODE_CHILD_SESSION:-}" ] && [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  no "子 session 變數" "CLAUDE_CODE_CHILD_SESSION 被繼承了，transcript 可能沒在存"
else
  ok "子 session 變數" "正常"
fi

echo "  ── 設定 ──────────────────────────────────────"
S="$CFG/settings.json"
if [ -f "$S" ] && python3 -c "import json,sys;json.load(open('$S'))" 2>/dev/null; then
  MODE=$(python3 -c "import json;print(json.load(open('$S')).get('permissions',{}).get('defaultMode','(未設)'))")
  NH=$(python3 -c "import json;h=json.load(open('$S')).get('hooks',{});print(sum(len(v) for v in h.values()))")
  ND=$(python3 -c "import json;print(len(json.load(open('$S')).get('permissions',{}).get('deny',[])))")
  ok "settings.json" "可解析 · defaultMode=$MODE · hook ${NH} 組 · deny ${ND} 條"
else
  no "settings.json" "解析失敗或不存在 —— 權限與 hook 全部不會生效"
fi
[ -f "$CFG/memory/MEMORY.md" ] \
  && ok "記憶索引" "$(cat "$CFG/memory/MEMORY.md" "$CFG/memory/INDEX.md" 2>/dev/null | grep -c '^- \[') 條（MEMORY.md＋INDEX.md）" \
  || no "記憶索引" "找不到 MEMORY.md"

echo "  ── 這台機器 ──────────────────────────────────"
[ "$(cat "$SP/tcc" 2>/dev/null)" = ok ] \
  && ok "~/Documents" "讀得到" \
  || no "~/Documents" "EPERM —— iCloud 同步或 TCC，見 env-doctor"
DASH=$(cat "$SP/dash" 2>/dev/null)
case "$DASH" in
  200) ok "專案控制台" "localhost:5250 回 200" ;;
  000|"") no "專案控制台" "連不上 —— proj dash 看它還在不在" ;;
  *) warn "專案控制台" "回 ${DASH}（活著但在噴錯）" ;;
esac
if command -v proj >/dev/null 2>&1; then
  PD=$(proj doctor 2>&1 | tail -3 | tr -d '\033' | sed 's/\[[0-9;]*m//g')
  case "$PD" in
    *"沒有發現問題"*) ok "proj doctor" "沒有發現問題" ;;
    *) warn "proj doctor" "$(printf '%s' "$PD" | grep -oE '共 [0-9]+ 個問題' | head -1) —— 跑 proj doctor 看細節" ;;
  esac
else
  no "proj" "不在 PATH"
fi

# 文件漂移。放在這裡是因為 sync-docs 缺的一直是「時機」——沒有人會開口說
# 「幫我檢查文件」，那是做事途中才會撞到的問題。開工前順手看一眼最便宜。
if [ -f CLAUDE.md ]; then
  # 用 $CFG 不要寫死 ~/.claude —— 上面查身分那段已經認 CLAUDE_CONFIG_DIR 了，
  # 這裡跟著認才不會在別的 profile 下找不到腳本（M5 Pro 的 bruce profile 就是
  # 這種情況）。
  #
  # 傳絕對路徑，不要傳 `.`——被呼叫端曾經用 `root.length + 1` 切前綴，
  # `.` 會被 path.join 正規化掉而把檔名切壞。那邊已經修成 path.relative，
  # 這裡不依賴它也是為了讓兩端各自都成立。
  DRIFT=$(node "$CFG/skills/sync-docs/check-paths.mjs" "$PWD" --quiet 2>/dev/null)
  [ -n "$DRIFT" ] && warn "文件漂移" "${DRIFT#! }" || ok "CLAUDE.md" "提到的檔案都還在"
fi

echo "  ── 其他三台 ──────────────────────────────────"
for pair in "pro:M5 Pro" "desk:DESKTOP-KR4TOIA" "victus:BRUCEVICTUS"; do
  h=${pair%%:*}; label=${pair#*:}
  if grep -q up "$SP/ssh.$h" 2>/dev/null; then ok "$label" "ssh 通"
  else warn "$label" "ssh 不通（沒開機或不在同網段就是正常的）"; fi
done
echo
echo "  ${D}Chrome 擴充要在瀏覽器裡才驗得到，這裡測不出來。${N}"
echo "  ${D}真的要用瀏覽器時，連不上先看擴充功能有沒有登入。${N}"
echo
