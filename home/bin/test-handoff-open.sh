#!/bin/bash
# test-handoff-open.sh — 換手開場白預塞資料（2026-10-21 W4）：
#   handoff-open 的開場白含交接單全文與 recon-check 快照；session-restore 在 handoff-open 打的 /clear 注入它、只注一次。
#   bash ~/.claude/skills/home/bin/test-handoff-open.sh
# --dry 不寫任何檔、不打字；hook 那段用假 HOME 與 HANDOFF_CLAUDE_PID，不碰真的 ~/.claude/state。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
HOOK="$HERE/../claude/hooks/session-restore.mjs"
T=$(cd "$(mktemp -d)" && pwd -P); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok(){ printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
ng(){ printf '  ✗ %s\n      %s\n' "$1" "${2-}"; FAIL=$((FAIL+1)); }
has(){ grep -qF -- "$2" <<<"$1"; }

# ── 開場白：交接單全文＋recon-check 快照 ──
if [ -z "${TMUX:-}" ] && [ ! -d /Applications/iTerm.app ]; then
  printf '  · 這台沒有 iTerm2 也不在 tmux 裡，handoff-open 不開場，跳過開場白那段\n'
else
  git init -q --bare "$T/origin.git"
  git init -q "$T/repo"; git -C "$T/repo" config user.email t@t; git -C "$T/repo" config user.name t
  echo a > "$T/repo/a"; git -C "$T/repo" add a; git -C "$T/repo" commit -qm init
  git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -qu origin HEAD 2>/dev/null
  printf '# 交接：測試\n\n## 下一步\n1. 斑馬-42 這行要原樣出現\n' > "$T/h.md"
  prompt(){ node "$HERE/handoff-open" --dry --stay "$T/h.md" --cwd "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).prompt))'; }
  p=$(prompt "$T/repo")
  has "$p" "斑馬-42 這行要原樣出現" && ok "開場白含交接單全文" || ng "開場白含交接單全文" "$p"
  has "$p" "ahead 0 · behind 0" && has "$p" "repo   $T/repo" && ok "開場白含 recon-check 輸出" || ng "開場白含 recon-check 輸出" "$p"
  has "$p" "不用再跑 /recon" && ! has "$p" "讀交接單 " && ok "叫新 session 不用再讀檔、不用再 /recon" || ng "叫新 session 不用再讀檔" "$p"
  mkdir -p "$T/plain"
  p=$(prompt "$T/plain")
  has "$p" "自己跑 /recon" && has "$p" "exit 2" && ok "不是 repo：快照沒跑成就叫它自己 /recon" || ng "不是 repo 的退路" "$p"
fi

# ── session-restore：handoff-open 打的 /clear 才注、只注一次 ──
H="$T/home"; D="$H/.claude/state/handoff"; mkdir -p "$D"
iso(){ node -e "console.log(new Date(Date.now()-($1)*60000).toISOString())"; }
printf '開場白-長頸鹿\n' > "$D/p.md"
mk(){ printf '{"mode":"clear","pid":%s,"promptFile":"%s","created":"%s"%s}' "$2" "$D/p.md" "$(iso 1)" "$3" > "$D/$1.json"; }
hook(){ printf '{"source":"%s","cwd":"%s"}' "$1" "$T" | HOME="$H" HANDOFF_CLAUDE_PID=4242 node "$HOOK"; }
mk 2026-10-21T01-00-00-000Z 4242 ''
[ -z "$(hook clear)" ] && ok "還沒打 /clear（沒有 clearing）不注" || ng "沒有 clearing 不該注"
mk 2026-10-21T01-00-01-000Z 999 ",\"clearing\":\"$(iso 0)\""
[ -z "$(hook clear)" ] && ok "別格 claude 的標記不注" || ng "別格的標記不該注"
mk 2026-10-21T01-00-02-000Z 4242 ",\"clearing\":\"$(iso 0)\""
[ -z "$(hook startup)" ] && ok "startup 不注換手開場白" || ng "startup 不該注"
out=$(hook clear)
has "$out" "開場白-長頸鹿" && has "$out" '"additionalContext"' && ok "handoff-open 打的 /clear 注入開場白" || ng "該注入開場白" "$out"
[ -z "$(hook clear)" ] && ok "同一份只注一次" || ng "同一份只注一次"
mk 2026-10-21T01-00-03-000Z 4242 ",\"clearing\":\"$(iso 30)\""
[ -z "$(hook clear)" ] && ok "太久以前的 clearing 不注（使用者自己 /clear）" || ng "舊的 clearing 不該注"

mk 2026-10-21T01-00-04-000Z 4242 ",\"clearing\":\"$(iso 0)\""
node -e 'process.stdout.write("長".repeat(9500))' > "$D/p.md"
out=$(hook clear)
has "$out" "先讀" && has "$out" "$D/p.md" && ! has "$out" "長長長長長長長長長長" && ok "開場白太長只注檔名、叫它讀檔" || ng "太長該只注檔名" "${out:0:200}"
p0=$(printf '{"source":"clear","cwd":"/x"}' | HOME="$T/empty" node "$HOOK")
[ -z "$p0" ] && ok "沒有標記目錄：一般 /clear 什麼都不注" || ng "沒有標記目錄該零輸出" "$p0"

printf '\n  %s 過 · %s 失敗\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
