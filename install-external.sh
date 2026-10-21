#!/usr/bin/env bash
#
# install-external.sh — 把外來的 skill／plugin 裝回這台機器。
#
# 為什麼要有這支：外來程式碼**不進這個 repo**（2026-09-03 裁示）。
# archify 一個就 113 MB，sprite-gen 16 MB，全 commit 進來會把 repo 撐爛，
# 而且 Windows 那邊是 junction 接的，clone 一慢整個接機流程都會拖。
# 所以改成「repo 只存這份清單，程式碼跑這支腳本抓」。四台機器版本一致。
#
# 重跑是安全的：已經在的會跳過，要更新就先砍掉目錄再跑。
#
# **Windows 上用 Git Bash 跑**（`bash` 直接打會跑進 WSL，跟 newproj 同一個坑）：
#
#   ssh victus '"C:\Program Files\Git\bin\bash.exe" -lc "bash ~/.claude/skills/install-external.sh"'
#
# 從 mac 派過去時整包會跑超過兩分鐘（archify 的 clone 加 dev-browser 的 91 MB
# Chromium），要用 run_in_background，不要卡在前景等。
#
# ⚠️ superpowers 不在這份清單裡，而且**不要加進來**。
#    2026-09-02 已裁示這台 Mac 不裝，理由見記憶檔 cross-machine-stats.md。
#    連 cherry-pick 個別 skill 也不要——上游 skill 之間互相 @ 引用，
#    抄三個進來會拖出剩下的十一個。
#
set -uo pipefail

# **認 CLAUDE_CONFIG_DIR，不要寫死 ~/.claude。** M5 Pro 的 bruce profile 在
# ~/.profiles/bruce/claude（skills 是 symlink 指到 ~/.profiles/bruce/claude-skills），
# 而那台的 ~/.claude/skills 是另一套 rivendell 的 symlink 農場——寫死就會把外來
# skill 裝到完全無關的地方去。`claude plugin` 自己也吃這個環境變數，所以外掛會
# 一起落在對的 profile。
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
S="$CFG/skills"
[ -d "$S" ] || { printf '\n  找不到 %s —— CLAUDE_CONFIG_DIR 設對了嗎？\n\n' "$S" >&2; exit 1; }
g() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
y() { printf '  \033[33m!\033[0m %s\n' "$1"; }
d() { printf '  \033[2m·\033[0m %s\n' "$1"; }

# ── 第一部分：plugin marketplace ─────────────────────────────────────
#
# 這些 repo 自己就是 marketplace，裝進 ~/.claude/plugins/，完全不碰這個 repo。
# 有 marketplace 的一律走這條，不要手動 clone。

MARKETPLACES=(
  gamedev-skills/awesome-gamedev-agent-skills   # → awesome-gamedev-agent-skills
  jakubkrehel/skills                            # → interfaces
  intercom/2x-skills                            # → fin-2x
  SawyerHood/dev-browser                        # → dev-browser-marketplace
)

# 只裝用得到的 bundle。gamedev 全裝是 67 個 skill，其中 Godot／Unity／Unreal
# 這台永遠用不到（palrogue 是 Phaser），所以只取 web-engines。
PLUGINS=(
  router@awesome-gamedev-agent-skills
  web-engines@awesome-gamedev-agent-skills      # Phaser 4.2 / PixiJS / three.js
  genres@awesome-gamedev-agent-skills           # roguelike / RPG 樣板
  disciplines@awesome-gamedev-agent-skills      # 存檔、程序生成、視覺資產、音效
  interfaces@interfaces
  skill-tools@fin-2x
  claude-code-tools@fin-2x
  code-review-tools@fin-2x
  test-tools@fin-2x
  dev-browser@dev-browser-marketplace
)

printf '\n  plugin marketplace…\n\n'
for m in "${MARKETPLACES[@]}"; do
  if claude plugin marketplace add "$m" >/dev/null 2>&1; then g "$m"; else d "${m}（已在）"; fi
done

printf '\n  plugin…\n\n'
for p in "${PLUGINS[@]}"; do
  if claude plugin install "$p" >/dev/null 2>&1; then g "$p"; else d "${p}（已在）"; fi
done

# ── 第二部分：沒有 marketplace 的，直接 clone 進 skills 目錄 ───────────
#
# 這四個上游沒做成 plugin，只能放 ~/.claude/skills/<name>/。
# 它們都在 .gitignore 裡，不會被 commit。
#
# 欄位：目錄名 | repo | 釘住的 commit | repo 內的子路徑（. = 根目錄）
#
# commit 是**刻意釘死的**，不是隨手記的 HEAD。要升級就自己改這裡，
# 這樣四台機器不會各自漂到不同版本。

EXTERNAL=(
  "agents-best-practices|DenisSergeevitch/agents-best-practices|dace8b70c563ef36e36c8d2196b1630184ec7912|."
  "archify|tt-a1i/archify|06dd052602dd|archify"
  "security-audit|cloudflare/security-audit-skill|8bac42001ddd|skills/security-audit"
)

# sprite-gen 有硬性外部依賴，**缺了就不要裝**——一個裝了卻跑不動的 skill 比沒裝
# 更糟，模型會照著 SKILL.md 去叫一支起不來的 CLI。兩個依賴：
#   Python >= 3.10   它自己的 venv（Pillow + NumPy）。
#   codex            圖片生成的 provider（另一個選項 grok 這幾台都沒有）。
#
# **不能只看 `python3`。** 三台各是一種情況：
#   Air      homebrew 的 python3 3.14  → 直接可用
#   M5 Pro   PATH 上是系統的 3.9.6（太舊），但 /opt/homebrew/bin/python3.13 在
#   Windows  python.exe 是 Microsoft Store 的空殼，執行只回 "Access is denied"
# 所以逐個候選試，挑第一個真的跑得動且 >= 3.10 的。
PY=""
for c in python3 python3.14 python3.13 python3.12 python3.11 python3.10 \
         /opt/homebrew/bin/python3.14 /opt/homebrew/bin/python3.13 \
         /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11; do
  command -v "$c" >/dev/null 2>&1 || continue
  "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' >/dev/null 2>&1 \
    && { PY="$c"; break; }
done

if [ -n "$PY" ] && command -v codex >/dev/null 2>&1; then
  EXTERNAL+=("sprite-gen|aldegad/sprite-gen|27254c14c54deb638bfaace38a2806eed940e29f|.")
else
  SPRITE_SKIP=1
  if [ -z "$PY" ]; then SPRITE_WHY="找不到 >= 3.10 的 Python"; else SPRITE_WHY="沒有 codex"; fi
fi

printf '\n  外來 skill…\n\n'
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for row in "${EXTERNAL[@]}"; do
  IFS='|' read -r name repo sha sub <<<"$row"
  if [ -f "$S/$name/SKILL.md" ]; then d "${name}（已在）"; continue; fi

  # --filter=blob:none 讓 archify 那 113 MB 的歷史不用整包拉下來
  if ! git clone -q --filter=blob:none --no-checkout \
        "https://github.com/$repo.git" "$tmp/$name" 2>/dev/null; then
    y "$name clone 失敗（${repo}）"; continue
  fi
  git -C "$tmp/$name" checkout -q "$sha" 2>/dev/null || \
    { y "$name 釘不到 $sha"; continue; }

  rm -rf "$S/$name"
  cp -R "$tmp/$name/$sub" "$S/$name"
  rm -rf "$S/$name/.git"          # 不要在 repo 底下留巢狀 .git
  [ -f "$S/$name/SKILL.md" ] && g "$name  ($sha)" || y "$name 裝了但沒有 SKILL.md"
done

# ── 第三部分：光有檔案還不能跑的兩個 ──────────────────────────────────

printf '\n  執行環境…\n\n'

# dev-browser 是 CLI，不是純 SKILL.md。要 npm 全域裝，再抓一份自己的
# Chromium（91 MB，放 ~/Library/Caches/ms-playwright）。這份 Chromium 跟使用者
# 那個開著直播的 Chrome 是兩個行程，所以它做什麼都不會動到他的視窗。
if command -v dev-browser >/dev/null 2>&1; then
  g "dev-browser CLI"
else
  npm install -g dev-browser >/dev/null 2>&1 && dev-browser install >/dev/null 2>&1 \
    && g "dev-browser CLI（含 Chromium）" || y "dev-browser 裝失敗 → npm install -g dev-browser && dev-browser install"
fi

# sprite-gen 硬性要求 repo 內的 venv，SKILL.md 明文禁止 fallback 到全域 python3：
# homebrew 的 python3 有 Pillow 但沒有 NumPy，「裝了一個就以為齊了」是上游踩過的坑。
if [ -n "${SPRITE_SKIP:-}" ]; then
  d "sprite-gen 跳過（${SPRITE_WHY:-缺依賴}）"
elif [ -x "$S/sprite-gen/.venv/bin/sprite-gen" ]; then
  g "sprite-gen venv"
elif [ -d "$S/sprite-gen" ]; then
  # **建完 venv 一定要先升 pip。** sprite-gen 只有 pyproject.toml 沒有 setup.py，
  # 而 PEP 660 的 editable 安裝要 pip >= 21.3。macOS 系統內建的 /usr/bin/python3
  # 帶的是 pip 21.2.4（M5 Pro 實測），差一個小版號就整個裝不起來，錯誤訊息是
  # 「File "setup.py" or "setup.cfg" not found」——看起來像檔案缺了，其實是 pip 太舊。
  vlog=$(mktemp)
  if ( cd "$S/sprite-gen" \
       && "$PY" -m venv .venv \
       && .venv/bin/pip install -q --upgrade pip \
       && .venv/bin/pip install -q -e . ) >"$vlog" 2>&1; then
    g "sprite-gen venv（$("$PY" -V 2>&1) · Pillow + NumPy）"
  else
    y "sprite-gen venv 建失敗：$(tail -2 "$vlog" | tr '\n' ' ')"
    d "手動重跑：cd $S/sprite-gen && rm -rf .venv && $PY -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -e ."
  fi
  rm -f "$vlog"
  d "圖片生成走 codex CLI（已在 PATH）；grok 那條 provider 這台沒有"
fi

printf '\n  驗證：claude 重開之後打 /  看 skill 有沒有出現\n\n'
