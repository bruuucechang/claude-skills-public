#!/bin/sh
# 把 Claude Code 的 skills、plugin skills、hooks 接進 Codex（~/.codex）。可重跑，冪等。
#
#   sh ~/.claude/skills/home/claude/tools/codex-sync.sh          # 安裝／更新
#   sh ~/.claude/skills/home/claude/tools/codex-sync.sh --check  # 只列出會做什麼
#
# 做四件事：
#   1. ~/.claude/skills/*/SKILL.md（自己寫的）      → ~/.codex/skills/<名字>
#   2. Claude 已啟用 plugin 的 skill                → ~/.codex/skills/<plugin>--<skill>
#      （plugin cache 路徑帶版本雜湊，plugin 更新後舊連結會斷——重跑這支就好，斷的會被清掉）
#   3. home/codex/skills/*（Codex 專屬，例如 claude-bridge）→ ~/.codex/skills/<名字>
#   4. hooks/codex-hooks.json                        → ~/.codex/hooks.json
#      每個事件一條 `dispatch.mjs <事件> codex`；要加減檢查改 dispatch.mjs 的 CODEX_ROUTES，不用動這份 JSON。
#      **新加的 hook（JSON 裡的指令有變）要使用者在 Codex 裡核准一次才會跑**（config.toml 的
#      [hooks.state.*] trusted_hash）。這一步不能、也不該由 agent 代勞。
#
# 只動指向 ~/.claude 的 symlink；~/.codex/skills/.system 與其他實體目錄一律不碰。
set -eu
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
SRC="$HOME/.claude/skills"
DST="$HOME/.codex/skills"
mkdir -p "$DST"

link() { # $1=來源目錄 $2=連結名
  cur=$(readlink "$DST/$2" 2>/dev/null || true)
  [ "$cur" = "$1" ] && return 0
  if [ -e "$DST/$2" ] && [ ! -L "$DST/$2" ]; then echo "略過（已有實體目錄）：$2"; return 0; fi
  echo "接上：$2 -> $1"
  [ $CHECK = 1 ] || ln -sfn "$1" "$DST/$2"
}

# 1. 自己寫的 skill
for d in "$SRC"/*/; do
  d=${d%/}; [ -f "$d/SKILL.md" ] && link "$d" "$(basename "$d")"
done

# 2. plugin skill：照 installed_plugins.json ＋ settings.json 的 enabledPlugins，
#    plugin 的 skill 清單優先讀 marketplace.json 的 skills 欄位（gamedev 那包四個 plugin 共用整個 repo）
PLUGIN_LINKS=$(python3 - <<'PY'
import glob, json, os, sys
H = os.path.expanduser('~')
inst = json.load(open(f'{H}/.claude/plugins/installed_plugins.json'))['plugins']
on = json.load(open(f'{H}/.claude/settings.json')).get('enabledPlugins', {})
for key, v in inst.items():
    if not on.get(key):
        continue
    plugin = key.split('@')[0]
    root = v[0]['installPath']
    rels = None
    mp = os.path.join(root, '.claude-plugin', 'marketplace.json')
    if os.path.exists(mp):
        for p in json.load(open(mp)).get('plugins', []):
            if p.get('name') == plugin and p.get('skills'):
                rels = p['skills']
    dirs = [os.path.normpath(os.path.join(root, r)) for r in rels] if rels \
        else [os.path.dirname(s) for s in glob.glob(f'{root}/skills/*/SKILL.md')]
    for d in dirs:
        if os.path.exists(os.path.join(d, 'SKILL.md')):
            print(f'{d}\t{plugin}--{os.path.basename(d)}')
PY
)
printf '%s\n' "$PLUGIN_LINKS" | while IFS="$(printf '\t')" read -r path name; do [ -n "$name" ] && link "$path" "$name"; done

# 3. Codex 專屬 skill
for d in "$SRC"/home/codex/skills/*/; do
  d=${d%/}; [ -f "$d/SKILL.md" ] && link "$d" "$(basename "$d")"
done

# 清掉斷掉的、或指向已停用 plugin 的舊連結（只動指向 ~/.claude 的 symlink）
for l in "$DST"/*; do
  [ -L "$l" ] || continue
  case "$(readlink "$l")" in "$HOME/.claude/"*) ;; *) continue;; esac
  n=$(basename "$l")
  if [ -e "$l" ]; then
    # Claude 停用／移除的 plugin：cache 還在所以連結沒斷，但 Codex 不該再看到它（2026-10-20 量到殘留 44 個）
    case "$(readlink "$l")" in "$HOME/.claude/plugins/cache/"*) ;; *) continue;; esac
    printf '%s\n' "$PLUGIN_LINKS" | cut -f2 | grep -qxF "$n" && continue
    echo "清掉已停用 plugin 的連結：$n"
  else
    echo "清掉斷連結：$n"
  fi
  [ $CHECK = 1 ] || rm "$l"
done

# 4. hooks
if ! cmp -s "$SRC/home/claude/hooks/codex-hooks.json" "$HOME/.codex/hooks.json"; then
  echo "更新：~/.codex/hooks.json（新 hook 要在 Codex 裡核准一次才會跑）"
  [ $CHECK = 1 ] || cp "$SRC/home/claude/hooks/codex-hooks.json" "$HOME/.codex/hooks.json"
fi
echo "完成：~/.codex/skills 共 $(find "$DST" -maxdepth 1 -mindepth 1 ! -name '.*' | wc -l | tr -d ' ') 個 skill"
