#!/usr/bin/env bash
#
# install.sh — 把這套 skills 裝進 ~/.claude（macOS、Linux）。預設只裝 skills，不動你的規則與設定。
#
#   git clone https://github.com/bruuucechang/claude-skills-public.git ~/claude-skills
#   bash ~/claude-skills/install.sh                  # 只裝 skills
#   bash ~/claude-skills/install.sh --with-hooks     # 加裝 hooks（會問 GitHub 帳號與 email）
#   bash ~/claude-skills/install.sh --with-rules     # 加裝作者的全域規則（你原本的先備份）
#   bash ~/claude-skills/install.sh --full --owner octocat --email me@example.com --lang none --yes
#   bash ~/claude-skills/install.sh --uninstall
#
# 做的事（重跑是安全的，已經做過的會跳過）：
#   一律：每個 skill 目錄 symlink 進 ~/.claude/skills/<名字>，home 也連進去（recon、ship 要用裡面的工具）
#   --with-hooks：寫 home/claude/config.json、把 hooks 合併進 ~/.claude/settings.json（先備份）、裝全域 pre-push
#   --with-rules：AGENTS.md、CLAUDE.md、rules、commands symlink 進 ~/.claude；原本有的先備份成 *.bak-<時間>
#
# 裝完開一個新的 claude session 才會生效。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STAMP="$(date +%Y%m%d-%H%M%S)"
CONFIG="$REPO/home/claude/config.json"

g() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
y() { printf '  \033[33m!\033[0m %s\n' "$1"; }
d() { printf '  \033[2m·\033[0m %s\n' "$1"; }
die() { printf '\n  \033[31m✗\033[0m %s\n\n' "$1" >&2; exit 1; }

OWNER=''; EMAILS=''; NAME=''; LANG_OPT=''; YES=0; UNINSTALL=0; HOOKS=0; RULES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNER="${2:?--owner 要帶值}"; shift 2 ;;
    --email) EMAILS="${2:?--email 要帶值}"; shift 2 ;;
    --name) NAME="${2:?--name 要帶值}"; shift 2 ;;
    --lang) LANG_OPT="${2:?--lang 要帶值}"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --with-hooks) HOOKS=1; shift ;;
    --with-rules) RULES=1; shift ;;
    --full) HOOKS=1; RULES=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1（--help 看用法）" ;;
  esac
done

# 帳號相關的參數只有 hooks 用得到。不准因為給了參數就默默裝 hooks、改全域 git 設定。
if [ -n "$OWNER$EMAILS$NAME$LANG_OPT" ] && [ "$HOOKS" = 0 ] && [ "$UNINSTALL" = 0 ]; then
  die '--owner／--email／--name／--lang 要搭配 --with-hooks 或 --full'
fi

command -v git >/dev/null 2>&1 || die '缺 git'
if [ "$HOOKS" = 1 ]; then
  command -v jq >/dev/null 2>&1 || die '缺 jq（合併 settings.json 要用）：brew install jq 或 apt install jq'
  command -v node >/dev/null 2>&1 || die '缺 node（hooks 用 node 跑，要 20 以上）'
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "node 版本太舊：$(node -v)，要 20 以上"
fi
# 私人版（有 bootstrap.sh）的 settings.json 用 "$HOME/…" 寫 hook，這支加的是展開後的路徑，會重複掛、還會寫進 repo
[ -f "$REPO/bootstrap.sh" ] && die '這是私人版 repo，請用 bootstrap.sh；install.sh 給公開版用'

# 指向 repo 裡某個東西的 symlink 才算我們裝的
ours() { [ -L "$1" ] && case "$(readlink "$1")" in "$REPO"/*) return 0 ;; esac; return 1; }

link() {
  local src="$REPO/$1" dst="$2"
  [ -e "$src" ] || { y "來源不存在，跳過：$1"; return 0; }
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then d "已經連好：$dst"; return 0; fi
  if [ -L "$dst" ] || [ -e "$dst" ]; then mv "$dst" "$dst.bak-$STAMP"; y "原本的 $dst 備份成 $(basename "$dst").bak-$STAMP"; fi
  ln -s "$src" "$dst"; g "$dst → $src"
}

# ── 解除安裝 ────────────────────────────────────────────────────────
if [ "$UNINSTALL" = 1 ]; then
  for p in "$CLAUDE"/AGENTS.md "$CLAUDE"/CLAUDE.md "$CLAUDE"/rules "$CLAUDE"/commands "$CLAUDE"/skills/*; do
    ours "$p" && rm "$p" && g "移除 $p"
  done
  S="$CLAUDE/settings.json"
  if [ -f "$S" ] && grep -qF "$REPO/" "$S"; then
    command -v jq >/dev/null 2>&1 || die '缺 jq：拿掉 settings.json 裡的 hooks 要用'
    cp "$S" "$S.bak-$STAMP"
    jq --arg r "$REPO/" '
      if .hooks then .hooks |= (with_entries(.value |= (map(.hooks |= map(select((.command // "") | contains($r) | not)))
        | map(select(.hooks | length > 0)))) | with_entries(select(.value | length > 0))) else . end' \
      "$S.bak-$STAMP" > "$S"
    g "從 settings.json 拿掉指向 $REPO 的 hooks（備份：settings.json.bak-${STAMP}）"
  fi
  if git config --global --get hook.pr-guard.command 2>/dev/null | grep -qF "$REPO/"; then
    git config --global --unset hook.pr-guard.command; git config --global --unset hook.pr-guard.event || true
    g '拿掉全域 git 的 hook.pr-guard.*'
  fi
  y '被備份的原檔（*.bak-*）沒有自動還原，要的話自己改回來'
  exit 0
fi

printf '\n  安裝到 %s\n\n' "$CLAUDE"

if [ "$HOOKS" = 1 ]; then
# ── 1. 設定檔 ───────────────────────────────────────────────────────
ask() {  # ask <提示> <預設值> → 印出答案
  local a
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then printf '%s' "$2"; return; fi
  read -r -p "  $1 [$2]: " a </dev/tty; printf '%s' "${a:-$2}"
}
if [ -f "$CONFIG" ] && [ -z "$OWNER$EMAILS$NAME$LANG_OPT" ]; then
  d "已經有 config.json，沿用（要改就直接編輯 $CONFIG 或帶參數重跑）"
else
  def_owner=''
  # 參數給了或非互動就不打網路
  if [ -z "$OWNER" ] && [ "$YES" = 0 ] && [ -t 0 ]; then def_owner=$(gh api user -q .login 2>/dev/null || true); fi
  def_email=$(git config --global user.email 2>/dev/null || true)
  def_name=$(git config --global user.name 2>/dev/null || true)
  [ -n "$OWNER" ] || OWNER=$(ask 'GitHub 帳號（pr-guard／update-check 只管這個帳號的 repo，留空＝不管）' "$def_owner")
  [ -n "$EMAILS" ] || EMAILS=$(ask 'commit 用的 email，多個用逗號分開（留空＝不檢查作者）' "$def_email")
  [ -n "$NAME" ] || NAME=$(ask 'commit 用的名字' "$def_name")
  [ -n "$LANG_OPT" ] || LANG_OPT=$(ask '要擋英文收尾的回報嗎？zh-TW＝擋、none＝不擋' 'none')
  case "$LANG_OPT" in zh-TW) ;; none|'') LANG_OPT='' ;; *) die "--lang 只能是 zh-TW 或 none：$LANG_OPT" ;; esac
  jq -n --arg o "$OWNER" --arg n "$NAME" --arg e "$EMAILS" --arg l "$LANG_OPT" '{
    github_owner: $o, git_name: $n,
    git_emails: ($e | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))),
    language: (if $l == "" then null else $l end)
  }' > "$CONFIG"
  g "寫好 $CONFIG"
fi

# ── 1b. 全域 pre-push（pr-guard）───────────────────────────────────
# 擋 agent 直推自己 repo 的目標分支，靠 git 2.55 起的設定式 hook（hook.<名字>.*）。
# git 太舊就不裝，並在 config 寫 pr_guard: false——不然 pr-guard 會因為「pre-push 沒裝」擋下每一次 push。
gv=$(git --version | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1 \2/')
if [ "${gv% *}" -gt 2 ] || { [ "${gv% *}" -eq 2 ] && [ "${gv#* }" -ge 55 ]; }; then
  git config --global hook.pr-guard.event pre-push
  # 找不到檔或沒有 node 就放行：檔搬走時不能讓每個 repo 都推不出去
  git config --global hook.pr-guard.command "f='$REPO/home/bin/pr-prepush.mjs'; [ -f \"\$f\" ] && command -v node >/dev/null 2>&1 || { cat >/dev/null; exit 0; }; exec node \"\$f\""
  PRG=true; g '全域 git 設定加了 hook.pr-guard.*（--uninstall 會拿掉）'
else
  PRG=false; y "git $(git --version | awk '{print $3}') 不到 2.55，不裝 pre-push；pr-guard 關閉"
fi
tmp=$(mktemp); jq --argjson p "$PRG" '.pr_guard = $p' "$CONFIG" > "$tmp" && mv "$tmp" "$CONFIG"
fi

# ── 2. skills ──────────────────────────────────────────────────────
mkdir -p "$CLAUDE/skills"
if [ "$(cd "$CLAUDE/skills" && pwd -P)" = "$(cd "$REPO" && pwd -P)" ]; then
  d 'repo 本身就是 ~/.claude/skills，skill 不用另外連'
else
  # 新版拿掉的 skill 會留下斷掉的連結，順手收掉
  for p in "$CLAUDE"/skills/*; do
    if ours "$p" && [ ! -e "$p" ]; then rm "$p"; d "移除斷掉的連結：$(basename "$p")"; fi
  done
  for dir in "$REPO"/*/; do
    n=$(basename "$dir"); [ -f "$dir/SKILL.md" ] || continue
    dst="$CLAUDE/skills/$n"
    if [ -e "$dst" ] && ! ours "$dst"; then y "~/.claude/skills/$n 已經有別的東西，跳過"; continue; fi
    link "$n" "$dst" >/dev/null; g "skill：$n"
  done
  # recon、ship 寫死 ~/.claude/skills/home/bin/…；home 沒有 SKILL.md，不會被當成 skill
  if [ -e "$CLAUDE/skills/home" ] && ! ours "$CLAUDE/skills/home"; then
    y '~/.claude/skills/home 已經有別的東西，跳過；recon、ship 的輔助工具會找不到'
  else
    link home "$CLAUDE/skills/home" >/dev/null; g '工具目錄：home'
  fi
fi

# ── 3. 規則 ─────────────────────────────────────────────────────────
# AGENTS.md 是正本、CLAUDE.md 一行 @AGENTS.md 匯入；兩個都要在 ~/.claude，只鋪一邊匯入會靜默失效。
if [ "$RULES" = 1 ]; then
  link home/claude/AGENTS.md "$CLAUDE/AGENTS.md"
  link home/claude/CLAUDE.md "$CLAUDE/CLAUDE.md"
  link home/claude/rules     "$CLAUDE/rules"
  link home/claude/commands  "$CLAUDE/commands"
fi

if [ "$HOOKS" = 1 ]; then
# ── 4. hooks 合併進 settings.json ───────────────────────────────────
S="$CLAUDE/settings.json"
[ -f "$S" ] || echo '{}' > "$S"
jq empty "$S" 2>/dev/null || die "$S 不是合法的 JSON，先修好再跑"
NEW=$(sed "s#__REPO__#$REPO#g" "$REPO/home/claude/settings.example.json")
# 比對前把既有指令裡的 $HOME／~ 展開，寫法不同的同一條不會重複加
MERGED=$(jq --argjson add "$NEW" --arg home "$HOME" '
  def norm: gsub("\\$HOME|\\$\\{HOME\\}"; $home) | gsub("(?<a>[\\s\"])~/"; "\\(.a)\\($home)/");
  reduce ($add.hooks | to_entries[]) as $ev (.;
    reduce $ev.value[] as $m (.;
      if ([.hooks[$ev.key][]?.hooks[]?.command | norm] | index($m.hooks[0].command)) then .
      else .hooks[$ev.key] = ((.hooks[$ev.key] // []) + [$m]) end))' "$S")
if [ "$MERGED" = "$(jq . "$S")" ]; then
  d 'settings.json 已經有這些 hooks'
else
  cp "$S" "$S.bak-$STAMP"
  printf '%s\n' "$MERGED" > "$S"
  g "hooks 合併進 settings.json（備份：settings.json.bak-${STAMP}）"
fi

fi

# ── 5. 提醒缺的前置工具：只提醒，不自動裝、不算失敗 ───────────────────
for pair in ship:gh ship:jq codex-drive:codex codex-drive:tmux inspect-ui:dev-browser; do
  s=${pair%%:*}; c=${pair#*:}
  [ -e "$CLAUDE/skills/$s" ] || continue
  command -v "$c" >/dev/null 2>&1 || y "$s 要用 $c，這台沒裝；其他 skills 不受影響"
done

scope='skills'
[ "$HOOKS" = 1 ] && scope="$scope、hooks"
[ "$RULES" = 1 ] && scope="$scope、全域規則"
cat <<EOF

  裝好了（$scope）。開一個新的 claude session 才會生效。

  加裝 hooks：bash "$REPO/install.sh" --with-hooks
  加裝作者的規則：bash "$REPO/install.sh" --with-rules
  解除安裝：bash "$REPO/install.sh" --uninstall

EOF
