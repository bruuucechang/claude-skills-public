#!/bin/bash
# test-recon-check.sh — recon-check 的迴歸測試（假的 origin＋假的共用 checkout，不碰真的 repo）。
#   bash ~/.claude/skills/home/bin/test-recon-check.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); T=$(cd "$T" && pwd -P); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok(){ printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
ng(){ printf '  ✗ %s\n      %s\n' "$1" "${2-}"; FAIL=$((FAIL+1)); }
B=feature/x
export HOME="$T/home"; mkdir -p "$HOME"
git config --global user.email t@t; git config --global user.name t; git config --global init.defaultBranch $B
G(){ git -C "$T/$1" "${@:2}"; }

git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/shared" 2>/dev/null
mkdir -p "$T/shared/sub"; echo a > "$T/shared/a.js"; echo b > "$T/shared/sub/b.js"; echo c > "$T/shared/c.js"
G shared add -A; G shared commit -q -F - <<<'init'; G shared push -q origin HEAD:$B 2>/dev/null
G shared branch -q -u origin/$B 2>/dev/null
git clone -q -b $B "$T/origin.git" "$T/other" 2>/dev/null
# origin 前進兩個 commit：一個碰 a.js、一個只碰 c.js；這裡也有一個沒推的 commit
echo a2 > "$T/other/a.js"; G other commit -q -a -F - <<<'碰到 a'; echo c2 > "$T/other/c.js"; G other commit -q -a -F - <<<'只碰 c'
G other push -q 2>/dev/null
echo local > "$T/shared/local.js"; G shared add local.js; G shared commit -q -F - <<<'沒推的'
# 別人的未 commit：改了 sub/b.js、新目錄 junk/ 底下一堆檔；我的：新檔 new/n.js
echo dirty > "$T/shared/sub/b.js"; mkdir -p "$T/shared/junk" "$T/shared/new"
for i in 1 2 3 4 5; do echo x > "$T/shared/junk/$i"; done; echo n > "$T/shared/new/n.js"

out=$( cd "$T/shared/sub" && bash "$HERE/recon-check" ../a.js ../new/n.js 2>&1 ); rc=$?
[ "$rc" = 0 ] && ok "跑完 exit 0" || ng "exit $rc" "$out"
printf '%s' "$out" | grep -q 'ahead 1 · behind 2' && ok "fetch 後算 ahead/behind" || ng "ahead/behind 不對" "$out"
printf '%s' "$out" | grep -q '碰到你要碰的檔' && printf '%s' "$out" | sed -n '/碰到你要碰的檔/,/^[^ ]/p' | grep -q '碰到 a' \
  && ! printf '%s' "$out" | sed -n '/碰到你要碰的檔/,/這裡有/p' | grep -q '只碰 c' \
  && ok "origin 多的 commit 只把碰到要碰的檔的那個標出來" || ng "碰到要碰的檔的 commit 沒標對" "$out"
printf '%s' "$out" | grep -q '沒推的' && ok "列出這裡有、origin 沒有的 commit" || ng "沒列 ahead 的 commit" "$out"
printf '%s' "$out" | grep -Eq '^  \?\? .*new/n\.js  ←' && printf '%s' "$out" | grep -Eq '^  ·· .*a\.js$' \
  && ok "要碰的檔：未追蹤目錄裡的新檔也看得到、乾淨的標 ··" || ng "要碰的檔狀態不對" "$out"
others=$(printf '%s' "$out" | sed -n '/其他未 commit/,/最近 commit/p')
printf '%s' "$others" | grep -q 'M sub/b.js' && printf '%s' "$others" | grep -q '?? junk/$' \
  && ! printf '%s' "$others" | grep -q 'junk/1' && ! printf '%s' "$others" | grep -q 'new/' \
  && ok "別人的未 commit 列出來、未追蹤目錄收成一行、自己的不重複列" || ng "其他未 commit 的清單不對" "$others"

# 自己改名的檔、帶空白的檔、所在目錄還不存在的檔：都要認得是「要碰的」；--no-fetch 放最後也算
G shared mv c.js "c renamed.js"; echo s > "$T/shared/sub/has space.js"
out=$( cd "$T/shared/sub" && bash "$HERE/recon-check" "../c renamed.js" "has space.js" ../later/x.js --no-fetch 2>&1 ); rc=$?
mine=$(printf '%s' "$out" | sed -n '/要碰的檔/,/其他未 commit/p'); others=$(printf '%s' "$out" | sed -n '/其他未 commit/,/最近 commit/p')
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q '略過（--no-fetch）' && ok "--no-fetch 放在檔名後面也認得" || ng "--no-fetch 放後面不認得" "rc=$rc $out"
printf '%s' "$mine" | grep -Eq '^  [RA]  .*c renamed\.js  ←' && printf '%s' "$mine" | grep -Eq '^  \?\? .*sub/has space\.js  ←' \
  && printf '%s' "$mine" | grep -Eq '（不存在）  later/x\.js$' \
  && ok "改名、帶空白、目錄還沒建的檔都對到要碰的檔" || ng "要碰的檔沒對上" "$mine"
! printf '%s' "$others" | grep -q 'renamed' && ! printf '%s' "$others" | grep -q 'has space' \
  && ok "自己改名／帶空白的檔不會被列成別人的" || ng "自己的檔被列成別人的" "$others"

# 落後超過 10 筆：要說還有幾筆沒列
for i in $(seq 1 11); do echo $i > "$T/other/n.js"; G other add n.js; G other commit -q -F - <<<"多 $i"; done; G other push -q 2>/dev/null
out=$( cd "$T/shared" && bash "$HERE/recon-check" 2>&1 )
printf '%s' "$out" | grep -q 'behind 13' && printf '%s' "$out" | grep -q '還有 3 筆' && ok "清單截斷時說還有幾筆" || ng "截斷沒標" "$out"

# fetch 失敗要大聲：exit 1、明說 ahead/behind 不能信
G shared remote set-url origin "$T/nope.git"
out=$( cd "$T/shared" && bash "$HERE/recon-check" 2>&1 ); rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q '不能信' && ok "fetch 失敗：exit 1、明說數字是舊的" || ng "fetch 失敗沒出聲" "rc=$rc $out"

out=$( cd "$T" && bash "$HERE/recon-check" 2>&1 ); rc=$?
[ "$rc" = 2 ] && ok "不是 repo：exit 2" || ng "不是 repo 沒擋" "rc=$rc $out"

printf '\n  %s 過 · %s 失敗\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
