#!/usr/bin/env bash
#
# bootstrap.sh — 在一台新機器上把這份設定接回生效位置。
#
#   git clone git@github.com:bruuucechang/claude-skills.git ~/.claude/skills
#   ~/.claude/skills/bootstrap.sh
#
# 做法是 symlink 而不是複製：之後改設定就等於改 repo，兩邊不會分岔。
# 重跑是安全的——已經連好的會跳過，被換成一般檔案的會先備份再重新連。
#
# 這支腳本只還原「檔案」。裝套件、開 TCC 權限、gh 登入那些**它做不到**，
# 跑完會列出清單，照著做完才算真的能用。詳見 BOOTSTRAP.md。
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
TILDE='~'   # 直接寫在替換式裡會被展開成家目錄，繞一層變數

g() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
y() { printf '  \033[33m!\033[0m %s\n' "$1"; }
d() { printf '  \033[2m·\033[0m %s\n' "$1"; }

# link <repo 內的來源> <要連到的位置>
link() {
  src="$REPO/$1"; dst="$2"
  [ -e "$src" ] || { y "來源不存在，跳過：$1"; return 0; }
  mkdir -p "$(dirname "$dst")"

  if [ -L "$dst" ]; then
    if [ "$(readlink "$dst")" = "$src" ]; then d "已經連好：${dst/#$HOME/$TILDE}"; return 0; fi
    rm "$dst"                       # 指到別的地方的舊連結，直接換掉
  elif [ -e "$dst" ]; then
    # 一般檔案／目錄：先備份再取代。symlink 有可能被「寫臨時檔再 rename」
    # 的存檔方式換成一般檔案，那時這裡會把它救回來。
    mv "$dst" "$dst.bak-$STAMP"
    y "原本的 ${dst/#$HOME/$TILDE} 已備份成 $(basename "$dst").bak-$STAMP"
  fi

  ln -s "$src" "$dst"
  g "${dst/#$HOME/$TILDE}  →  ${src/#$HOME/$TILDE}"
}

printf '\n  把設定接回生效位置…\n\n'

link home/zshrc                  "$HOME/.zshrc"
link home/claude/settings.json   "$HOME/.claude/settings.json"
link home/claude/commands        "$HOME/.claude/commands"
link home/claude/memory          "$HOME/.claude/memory"

# 規則本體（2026-09-08 起拆成 AGENTS.md 正本 + CLAUDE.md 橋接）
#
# AGENTS.md 是跨工具的標準檔名，Codex/Cursor/Copilot/Windsurf 都讀它；
# Claude Code 只讀 CLAUDE.md，所以 CLAUDE.md 用一行 @AGENTS.md 匯入。
# **~/.claude/AGENTS.md 與 ~/.codex/AGENTS.md 兩個都要建**：前者是因為
# ~/.claude/CLAUDE.md 本身是 symlink，相對路徑的 import 可能從實體檔位置
# 或連結位置解析，只鋪一邊會靜默失效；後者是 Codex 的全域指令檔。
link home/claude/AGENTS.md       "$HOME/.claude/AGENTS.md"
link home/claude/CLAUDE.md       "$HOME/.claude/CLAUDE.md"
link home/claude/rules           "$HOME/.claude/rules"

# subagent 定義（2026-10-12）：歸 office repo 管（四位角色的出差版），這台有 office 才接
if [ -d "$HOME/Projects/office/office/agents" ]; then
  [ -L "$HOME/.claude/agents" ] || [ ! -e "$HOME/.claude/agents" ] && ln -sfn "$HOME/Projects/office/office/agents" "$HOME/.claude/agents" && g "~/.claude/agents  →  ~/Projects/office/office/agents"
else
  y "沒有 ~/Projects/office，跳過 subagent（~/.claude/agents）"
fi
link home/claude/ARCHITECTURE.md "$HOME/.claude/ARCHITECTURE.md"
mkdir -p "$HOME/.codex"
link home/claude/AGENTS.md       "$HOME/.codex/AGENTS.md"
# AGENTS.md 上限 150 行由 repo 內的 pre-commit hook 擋（2026-10-07）；
# core.hooksPath 是本機設定，不會跟著 clone 過來，每台都要設。
git -C "$REPO" config core.hooksPath githooks
link home/bin/quad               "$HOME/.local/bin/quad"
link home/bin/ship-classify      "$HOME/.local/bin/ship-classify"
link home/bin/handoff-open       "$HOME/.local/bin/handoff-open"   # skill 裡寫的是裸的 handoff-open（2026-10-21：沒連時 87 次 command not found）
# 背景排程（macOS，2026-10-21）：memsync 每 15 分鐘把記憶目錄 commit＋push；handoff-watch 每分鐘看換手失敗推通知。
# plist 裡寫死的 /Users/bruuucemac 換成這台的 $HOME、repo 路徑換成 $REPO、node 換成這台的。
if [ "$(uname)" = Darwin ]; then
  NODE=$(command -v node || echo /opt/homebrew/bin/node)
  for n in memsync handoff-watch; do
    L=com.bruuucechang.$n; P="$HOME/Library/LaunchAgents/$L.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claude/logs"
    sed -e "s#/Users/bruuucemac/.claude/skills#$REPO#g" -e "s#/Users/bruuucemac#$HOME#g" -e "s#/opt/homebrew/bin/node#$NODE#g" \
      "$REPO/home/claude/launchagents/$L.plist" > "$P.new"
    if cmp -s "$P.new" "$P" && launchctl print "gui/$(id -u)/$L" >/dev/null 2>&1; then rm "$P.new"; d "已經裝好：$L"; continue; fi
    mv "$P.new" "$P"
    launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true
    # bootout 是非同步的，馬上 bootstrap 常撞 error 5：等它真的卸掉（最多 5 秒）
    for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl print "gui/$(id -u)/$L" >/dev/null 2>&1 || break; sleep 0.5; done
    launchctl bootstrap "gui/$(id -u)" "$P" && g "launchd：$L" || y "launchd 載入失敗：$L"
  done
  chmod +x "$REPO/home/bin/memsync" "$REPO/home/bin/handoff-watch" 2>/dev/null || true
fi
# 全域 pre-push：agent 不准把程式碼直推自己 repo 的目標分支（ship skill 5b）。跟 repo 自己的 pre-push 一起跑（git 2.55 實測）
git config --global hook.pr-guard.event pre-push
# 指令寫成「找不到檔或沒有 node 就放行」：直接指檔的話，檔搬走或 GUI 程式的 PATH 沒有 node 時，
# 這台每一個 repo（含別人的）都推不出去（PR #2 審查實測）。git 會自己在後面補 "$@"，這裡不要再寫。
# 路徑用 $REPO 在這裡展開：M5 Pro 的 clone 不在 ~/.claude/skills。
git config --global hook.pr-guard.command "f='$REPO/home/bin/pr-prepush.mjs'; [ -f \"\$f\" ] && command -v node >/dev/null 2>&1 || { cat >/dev/null; exit 0; }; exec node \"\$f\""
chmod +x "$REPO/home/bin/pr-prepush.mjs" 2>/dev/null || true
chmod +x "$REPO/home/bin/quad" 2>/dev/null || true

# ── Codex 也用同一批 skill（2026-09-09）────────────────────────────────
#
# Codex 的 skill 目錄格式跟 Claude 一樣（<name>/SKILL.md，frontmatter 有
# name 與 description），所以直接把每個 skill 目錄 symlink 過去就好。
#
# **但光接上去不會生效。** skill 的 body 只有在模型決定要用它的時候才載入，
# 而 Codex 預設的 model_reasoning_effort 是 none —— 實測它不會去載，
# 於是 17 個 skill 全接上了卻等於裝飾品，而且完全沒有錯誤訊息。
# ~/.codex/config.toml 要有 model_reasoning_effort = "medium"（放在任何
# [table] 之前，跟 sandbox_mode 同一個坑）。
if [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex/skills"
  n=0
  for d in "$REPO"/*/; do
    [ -f "$d/SKILL.md" ] || continue
    link "$(basename "$d")" "$HOME/.codex/skills/$(basename "$d")" >/dev/null
    n=$((n+1))
  done
  y "Codex 也接了 $n 個 skill"
  if grep -q '^model_reasoning_effort' "$HOME/.codex/config.toml" 2>/dev/null; then
    y "Codex 的 model_reasoning_effort 有設，skill 才會真的被載入"
  else
    y "Codex 的 config.toml 沒有 model_reasoning_effort —— skill 接了也不會生效"
  fi
else
  d "沒有 ~/.codex，跳過 Codex 的 skill"
fi

# 記憶檔的舊路徑相容
#
# settings.json 已經把 autoMemoryDirectory 釘成 ~/.claude/memory，但這台機器
# 可能還有一個 ~/.claude/projects/<消毒過的 cwd>/memory 的舊目錄。把它也指過去，
# 兩條路徑讀到的才是同一份。
legacy="$HOME/.claude/projects/-$(printf '%s' "${HOME#/}" | tr '/' '-')/memory"
if [ -e "$legacy" ] || [ -L "$legacy" ]; then
  link home/claude/memory "$legacy"
else
  d "沒有記憶檔的舊路徑，不用相容處理"
fi

printf '\n  檢查依賴…\n\n'

need() { command -v "$1" >/dev/null 2>&1 && g "$1" || y "缺 $1${2:+  —  $2}"; }
need git
need gh          "brew install gh，然後 gh auth login"
need node        "brew install node"
need jq          "brew install jq（hook 用來核對 git 作者身分）"
need psql        "brew install postgresql@17 && brew services start postgresql@17"
need docker      "裝 Docker Desktop"
need ollama      "brew install ollama（只有 namecard-archive 需要）"

# proj 要另外 clone，而且它必須住在專案目錄裡面——lib.mjs 是用
# ROOT = resolve(HERE, '..') 推算專案位置的，搬走就找不到專案。
if [ -x "$HOME/Projects/projctl/proj.mjs" ] || [ -x "$HOME/Projects/.projctl/proj.mjs" ]; then
  if [ -L /opt/homebrew/bin/proj ] || [ -x /opt/homebrew/bin/proj ]; then
    g "proj 已安裝"
  else
    y "projctl 在，但 proj 沒進 PATH → ln -s ~/Projects/projctl/proj.mjs /opt/homebrew/bin/proj"
  fi
else
  y "還沒有 projctl → git clone git@github.com:bruuucechang/projctl.git ~/Projects/projctl"
fi

# 外來的 skill 與 plugin 不在這個 repo 裡（見 .gitignore 的說明），
# 要另外抓。清單與釘死的 commit 都在 install-external.sh。
if [ -f "$HOME/.claude/skills/sprite-gen/SKILL.md" ]; then
  g "外來 skill 已裝"
else
  y "外來 skill 還沒裝 → ~/.claude/skills/install-external.sh"
fi

cat <<'EOF'

  檔案的部分好了。以下**腳本做不到**，要手動：

    1. TCC「完全取用磁碟」——最容易漏、症狀最難懂的一項
       系統設定 → 隱私權與安全性 → 完全取用磁碟，加入：
         · Terminal.app（不加的話 Claude Code 對 ~/Documents 整棵樹 EPERM）
         · node 的「實體路徑」（含版本號，例如 /opt/homebrew/Cellar/node/25.6.1/bin/node
           ——加 symlink 沒有用，Finder 會解析掉）
       加完要整個 app ⌘Q 再開，授權不會回溯套用到已在跑的程序。

    2. gh auth login

    3. 重開一個終端機視窗讓 ~/.zshrc 生效
       （這一步之後 quad 會接管視窗排版並自動起 claude）

    4. proj dash install        讓控制台開機自動起

  驗證：
    proj doctor
    bash ~/.claude/skills/tests/run.sh      腳本的迴歸測試
    claude  然後隨便問一句，看 hook 有沒有載進來

EOF
