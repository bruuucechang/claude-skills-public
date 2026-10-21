#!/bin/bash
# test-handoff-watch.sh — handoff-watch 的判準，以及 handoff-open --inject 撞到 -1719 時會重試、最後一定留下 gaveUp。
#   bash ~/.claude/skills/home/bin/test-handoff-watch.sh
# 不推通知（HANDOFF_NOTIFY= HANDOFF_NO_OSA=1）。--inject 那段會對 iTerm2 跑唯讀的 AppleScript 找一個不存在的 session，
# 不打字、不 activate；這台沒在跑 iTerm2 就跳過（tell application 會把它叫起來）。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok(){ printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
ng(){ printf '  ✗ %s\n      %s\n' "$1" "${2-}"; FAIL=$((FAIL+1)); }
S="$T/state"; mkdir -p "$S"
export HANDOFF_STATE="$S" HANDOFF_NOTIFY= HANDOFF_NO_OSA=1
iso(){ node -e "console.log(new Date(Date.now()-($1)*60000).toISOString())"; }
mk(){ local name=$1 extra=$2 ago=$3; printf '{"mode":"clear","tty":"/dev/ttys0","cwd":"/x","handoff":"/x/h.md","created":"%s"%s}' "$(iso "$ago")" "$extra" > "$S/$name.json"; }

mk 2026-10-21T01-00-00-000Z ',"gaveUp":"找不到那格"' 1
mk 2026-10-21T01-00-01-000Z ',"unconfirmed":"40 秒沒開工"' 1
mk 2026-10-21T01-00-02-000Z ',"started":"x"' 1
mk 2026-10-21T01-00-03-000Z '' 1; sleep 0 & dead=$!; wait $dead; echo $dead > "$S/2026-10-21T01-00-03-000Z.pid"
mk 2026-10-21T01-00-04-000Z '' 1; echo $$ > "$S/2026-10-21T01-00-04-000Z.pid"
mk 2026-10-21T01-00-05-000Z ',"gaveUp":"舊的"' 300
mk 2026-10-21T01-00-06-000Z '' 20
mk 2026-10-21T01-00-07-000Z ',"gaveUp":"x","mode":"split"' 1
out=$(node "$HERE/handoff-watch")
has(){ grep -q "$1" <<<"$out"; }
has 01-00-00 && ok "gaveUp 會叫" || ng "gaveUp 會叫" "$out"
has 01-00-01 && ok "unconfirmed 會叫" || ng "unconfirmed 會叫" "$out"
has 01-00-02 && ng "started 不該叫" "$out" || ok "started 不叫"
has 01-00-03 && ok "背景程序死了、沒結果 會叫" || ng "背景程序死了、沒結果 會叫" "$out"
has 01-00-04 && ng "背景程序還活著不該叫" "$out" || ok "背景程序還活著不叫"
has 01-00-05 && ng "2 小時前的舊帳不該叫" "$out" || ok "2 小時前的舊帳不叫"
has 01-00-06 && ok "超過 15 分鐘沒結果 會叫" || ng "超過 15 分鐘沒結果 會叫" "$out"
has 01-00-07 && ng "split 不該叫" "$out" || ok "split 不叫"
out2=$(node "$HERE/handoff-watch")
[ -z "$out2" ] && ok "每個標記只叫一次" || ng "每個標記只叫一次" "$out2"

# --inject：撞到 -1719 會重試；重試用完或找不到那格都要寫 gaveUp，不能默默死掉
if ps -axo args= | grep 'iTerm.app/Contents/MacOS/iTerm2$' >/dev/null; then   # 不用 grep -q：pipefail 下 ps 會吃 SIGPIPE
  H="$T/home"; mkdir -p "$H/.claude/state/panes" "$H/.claude/state/handoff"
  inject() {   # $1 = 假裝撞幾次 -1719
    local m="$H/.claude/state/handoff/t$1.json"
    printf '{"mode":"clear","uid":"no-such-session-%s","tty":"/dev/ttysFAKE","cwd":"/x","handoff":"/x/h.md","created":"%s","promptFile":"/x/p.md"}' "$1" "$(iso 1)" > "$m"
    printf '{"state":"done","updated":"%s"}' "$(iso -5)" > "$H/.claude/state/panes/ttysFAKE.json"
    HOME="$H" ITERM_FAKE_1719=$1 node "$HERE/handoff-open" --inject "$m" 2>"$H/err$1"
    node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(m.gaveUp||"NO-RESULT")' "$m"
  }
  r=$(inject 2); n=$(grep -c '重試' "$H/err2")
  [ "$r" = "找不到那格（session 不見了）" ] && [ "$n" = 2 ] && ok "-1719 兩次後重試成功（那格不存在 → gaveUp）" || ng "-1719 重試" "r=$r n=$n $(cat "$H/err2")"
  r=$(inject 99)
  case "$r" in *-1719*) ok "-1719 重試用完 → gaveUp 寫明原因" ;; *) ng "-1719 重試用完" "r=$r $(cat "$H/err99")" ;; esac
else
  printf '  - 這台沒在跑 iTerm2，跳過 --inject 那段\n'
fi

printf '\n  %d 通過，%d 失敗\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
