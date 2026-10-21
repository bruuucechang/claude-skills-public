#!/bin/bash
# test-ship-pr.sh — ship-pr 的迴歸測試（假的 origin＋假的共用 checkout＋假的 gh，不碰真的 repo 與 GitHub）。
#   bash ~/.claude/skills/home/bin/test-ship-pr.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); T=$(cd "$T" && pwd -P); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok(){ printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
ng(){ printf '  ✗ %s\n      %s\n' "$1" "${2-}"; FAIL=$((FAIL+1)); }
B=feature/x
export HOME="$T/home" SHIP_PR_WORKTREES="$T/wt" PATH="$T/bin:$PATH"
mkdir -p "$HOME" "$T/bin"
git config --global user.email t@t; git config --global user.name t; git config --global init.defaultBranch $B
G(){ git -C "$T/$1" "${@:2}"; }

# 假的 gh：記下參數；pr merge 把 origin 的目標分支快轉到 PR 分支（當作 squash 合併）
cat > "$T/bin/gh" <<STUB
#!/bin/bash
printf '%s\n' "\$*" >> "$T/gh.log"
case "\$1 \$2" in
  "pr create") cat "$T/gh.body" >/dev/null 2>&1; for a; do [ "\$p" = --body-file ] && cp "\$a" "$T/gh.body"; p=\$a; done
               echo "https://github.com/o/r/pull/7" ;;
  "pr view")   case "\$*" in *headRefName*) cat "$T/gh.head" ;; *) cat "$T/gh.state" 2>/dev/null || echo OPEN ;; esac ;;
  "repo view") echo "https://github.com/o/r" ;;
  "pr merge")  [ -f "$T/gh.failmerge" ] && exit 1; git --git-dir="$T/origin.git" update-ref refs/heads/$B "refs/heads/\$(cat "$T/gh.head")" && echo MERGED > "$T/gh.state" ;;
esac
STUB
chmod +x "$T/bin/gh"

setup() {
  rm -rf "$T/origin.git" "$T/shared" "$T/other" "$T/wt" "$T/gh."*
  git init -q --bare "$T/origin.git"
  git clone -q "$T/origin.git" "$T/shared" 2>/dev/null
  mkdir -p "$T/shared/sub"
  echo a > "$T/shared/a.js"; echo b > "$T/shared/b.js"; echo gone > "$T/shared/sub/del.js"
  G shared add -A; G shared commit -q -F - <<<'init'; G shared push -q origin HEAD:$B 2>/dev/null
  G shared branch -q -u origin/$B 2>/dev/null
  git clone -q -b $B "$T/origin.git" "$T/other" 2>/dev/null
  printf 'W3 測試：$HOME 與 \\n 原樣\n\n為什麼：測試\n' > "$T/msg"
}
run() { ( cd "${2:-$T/shared}" && bash "$HERE/ship-pr" $1 ) >"$T/out" 2>&1; echo $?; }
br() { G shared for-each-ref --format='%(refname:short)' 'refs/heads/pr/*'; }

# 1. 正常路徑：搬自己的三個檔（改、新增、刪除），別人的改動原封不動
setup
echo a2 > "$T/shared/a.js"; mkdir -p "$T/shared/new/deep"; echo n > "$T/shared/new/deep/n.js"; rm "$T/shared/sub/del.js"
echo dirty > "$T/shared/b.js"; echo staged > "$T/shared/c.js"; G shared add c.js
rc=$(run "-F $T/msg demo a.js new/deep/n.js sub/del.js")
P=$(br)
files=$(git --git-dir="$T/origin.git" diff --name-only $B "$P" 2>/dev/null | tr '\n' ' ')
[ "$rc" = 0 ] && [ -n "$P" ] && [ "$files" = "a.js new/deep/n.js sub/del.js " ] \
  && ok "分支推上 origin，只含自己的三個檔" || ng "分支推上 origin，只含自己的三個檔" "rc=$rc P=$P files=$files $(cat "$T/out")"
case "$P" in pr/[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-demo) ok "分支名 pr/YYMMDD-HHMM-短名" ;; *) ng "分支名格式不對" "$P" ;; esac
[ "$(git --git-dir="$T/origin.git" log -1 --format=%B "$P" 2>/dev/null)" = "$(cat "$T/msg")" ] \
  && ok "commit 訊息跟檔案一字不差（\$HOME、反斜線沒被展開）" || ng "commit 訊息被改了" "$(git --git-dir="$T/origin.git" log -1 --format=%B "$P" 2>&1)"
[ "$(cat "$T/shared/a.js")" = a ] && [ ! -e "$T/shared/new" ] && [ -f "$T/shared/sub/del.js" ] \
  && ok "共用 checkout 拿掉了自己的改動（新檔的空目錄也收掉）" || ng "共用 checkout 沒拿乾淨" "$(G shared status --short)"
[ "$(cat "$T/shared/b.js")" = dirty ] && [ "$(G shared diff --cached --name-only)" = c.js ] \
  && ok "別人的工作區改動與暫存原封不動" || ng "別人的改動被動到" "$(G shared status --short)"
gh=$(cat "$T/gh.log" 2>/dev/null)
case "$gh" in *"pr create --base $B --head $P --title W3 測試："*) ok "gh pr create 帶 --base 與 --head" ;; *) ng "gh 參數不對" "$gh" ;; esac
[ "$(tail -1 "$T/out")" = "https://github.com/o/r/pull/7" ] && grep -q 'code-review high https://github.com/o/r/pull/7 --comment' "$T/out" \
  && ok "最後一行是 PR 完整網址、審查指令帶網址" || ng "沒印出完整網址" "$(cat "$T/out")"
[ "$(cat "$T/gh.body" 2>/dev/null)" = "為什麼：測試" ] && ok "PR 內文預設是訊息第二段起" || ng "PR 內文不對" "$(cat "$T/gh.body" 2>&1)"

# 2. --merge：worktree 有未追蹤檔就停下列出來；清掉後合併、刪 worktree、共用 checkout 快轉
echo "$P" > "$T/gh.head"; W="$T/wt/${P//\//-}"
echo junk > "$W/scp-leftover"
rc=$(run "--merge https://github.com/o/r/pull/7")
[ "$rc" != 0 ] && grep -q scp-leftover "$T/out" && [ -d "$W" ] && ! grep -q 'pr merge' "$T/gh.log" \
  && ok "--merge：worktree 有未追蹤檔就停、列出檔名、不合併" || ng "--merge 沒擋住髒 worktree" "rc=$rc $(cat "$T/out")"
rm "$W/scp-leftover"
# 修了 commit 卻沒推：不准合併（合併的會是舊版，刪本機分支就把修正弄丟）
echo fix > "$W/a.js"; G "${W#$T/}" commit -q -a -F - <<<'審查修正'
rc=$(run "--merge https://github.com/o/r/pull/7")
[ "$rc" != 0 ] && grep -q '沒推的 commit' "$T/out" && [ -d "$W" ] && ! grep -q 'pr merge' "$T/gh.log" \
  && ok "--merge：worktree 有沒推的 commit 就停" || ng "--merge 沒擋沒推的 commit" "rc=$rc $(cat "$T/out")"
G "${W#$T/}" push -q 2>/dev/null
# 合併失敗（checks 沒過）：worktree 要留著給你修
touch "$T/gh.failmerge"; rc=$(run "--merge https://github.com/o/r/pull/7"); rm "$T/gh.failmerge"
[ "$rc" != 0 ] && [ -d "$W" ] && [ -n "$(br)" ] && ok "--merge：沒合併成功時 worktree 與分支都留著" || ng "--merge 失敗卻收掉了 worktree" "rc=$rc $(cat "$T/out")"
rc=$(run "--merge https://github.com/o/r/pull/7")
[ "$rc" = 0 ] && [ ! -d "$W" ] && [ -z "$(br)" ] && [ "$(cat "$T/shared/a.js")" = fix ] \
  && ! git --git-dir="$T/origin.git" show-ref -q --verify "refs/heads/$P" \
  && ok "--merge：移 worktree、刪本機分支、合併、共用 checkout 快轉" || ng "--merge 沒做完" "rc=$rc $(cat "$T/out") $(br)"
rc=$(run "--merge https://github.com/other/r/pull/7")
[ "$rc" = 2 ] && grep -q '不是 origin' "$T/out" && ok "--merge 別的 repo 的網址就拒絕" || ng "--merge 收了別的 repo 的網址" "$(cat "$T/out")"
echo feature/x > "$T/gh.head"; rc=$(run "--merge https://github.com/o/r/pull/7")
[ "$rc" = 2 ] && grep -q '不是 pr/' "$T/out" && ok "--merge：不是 pr/ 分支的 PR 就拒絕" || ng "--merge 收了長期分支的 PR" "$(cat "$T/out")"
rc=$(run "--merge 7")
[ "$rc" = 2 ] && grep -q 完整網址 "$T/out" && ok "--merge 只給號碼就拒絕" || ng "--merge 收了號碼" "$(cat "$T/out")"

# 3. origin 對同一個檔已經前進：套不上 → 全部收回，共用 checkout 一個位元都沒動
setup
echo theirs > "$T/other/a.js"; G other commit -q -a -F - <<<'upstream'; G other push -q 2>/dev/null
echo mine > "$T/shared/a.js"; G shared add a.js
rc=$(run "-F $T/msg demo a.js")
[ "$rc" != 0 ] && [ -z "$(br)" ] && [ -z "$(ls -A "$T/wt" 2>/dev/null)" ] \
  && [ "$(cat "$T/shared/a.js")" = mine ] && [ "$(G shared diff --cached --name-only)" = a.js ] \
  && ok "套不上 origin：worktree 與分支收回，共用 checkout 原樣（暫存也還在）" || ng "套不上時留下殘骸或動了共用 checkout" "rc=$rc $(br) $(cat "$T/out")"

# 4. 動手前就擋下的參數
setup
rc=$(run "-F $T/msg demo b.js"); [ "$rc" = 2 ] && grep -q 沒有改動 "$T/out" && ok "沒改動的檔：擋下" || ng "沒改動的檔沒擋" "$(cat "$T/out")"
echo x > "$T/shared/a.js"
rc=$(run "demo a.js"); [ "$rc" = 2 ] && grep -q -- '-F' "$T/out" && ok "沒給 -F：擋下" || ng "沒給 -F 沒擋" "$(cat "$T/out")"
rc=$(run "-F $T/msg Demo_X a.js"); [ "$rc" = 2 ] && ok "短名不合法：擋下" || ng "短名不合法沒擋" "$(cat "$T/out")"
rc=$(run "-F $T/msg demo sub"); [ "$rc" = 2 ] && ok "給目錄：擋下" || ng "給目錄沒擋" "$(cat "$T/out")"
rc=$( ( cd "$T/shared" && perl -e 'alarm 10; exec @ARGV' bash "$HERE/ship-pr" -F ) >"$T/out" 2>&1; echo $? )
[ "$rc" = 2 ] && ok "選項缺值（只給 -F）：擋下、不卡死" || ng "選項缺值沒擋或卡死（rc=${rc}）" "$(cat "$T/out")"
[ -z "$(br)" ] && [ "$(cat "$T/shared/a.js")" = x ] && ok "擋下時什麼都沒動" || ng "擋下時動了東西" "$(br)"

# 5. 在子目錄跑、用相對 cwd 的路徑；-F - 從 stdin 讀
setup
echo s2 > "$T/shared/sub/del.js"
rc=$( ( cd "$T/shared/sub" && bash "$HERE/ship-pr" -F - demo del.js <<<'從 stdin' ) >"$T/out" 2>&1; echo $? )
P=$(br)
[ "$rc" = 0 ] && [ "$(git --git-dir="$T/origin.git" diff --name-only $B "$P" 2>/dev/null)" = sub/del.js ] \
  && [ "$(git --git-dir="$T/origin.git" log -1 --format=%s "$P")" = 從\ stdin ] \
  && ok "子目錄裡的相對路徑、stdin 訊息" || ng "子目錄／stdin 不對" "rc=$rc $(cat "$T/out")"

# 6. origin 已經有同名新檔：收回、不覆蓋
setup
echo theirs > "$T/other/n.js"; G other add n.js; G other commit -q -F - <<<'add n'; G other push -q 2>/dev/null
echo mine > "$T/shared/n.js"
rc=$(run "-F $T/msg demo n.js")
[ "$rc" != 0 ] && [ -z "$(br)" ] && [ "$(cat "$T/shared/n.js")" = mine ] \
  && ok "origin 已有同名檔：收回、本機新檔還在" || ng "同名檔沒擋或弄丟本機檔" "rc=$rc $(cat "$T/out")"

# 6b. 使用者的 diff 設定（noprefix）不能讓 patch 套不上
setup
echo a2 > "$T/shared/a.js"; git config --global diff.noprefix true
rc=$(run "-F $T/msg demo a.js"); git config --global --unset diff.noprefix
[ "$rc" = 0 ] && [ -n "$(br)" ] && ok "diff.noprefix=true 照樣套得上" || ng "diff.noprefix 讓 patch 套不上" "rc=$rc $(cat "$T/out")"

# 6c. push 失敗：全部收回，共用 checkout 原樣
setup
echo a2 > "$T/shared/a.js"
printf '#!/bin/sh\necho 拒絕 >&2; exit 1\n' > "$T/origin.git/hooks/pre-receive"; chmod +x "$T/origin.git/hooks/pre-receive"
rc=$(run "-F $T/msg demo a.js"); rm "$T/origin.git/hooks/pre-receive"
[ "$rc" != 0 ] && [ -z "$(br)" ] && [ "$(cat "$T/shared/a.js")" = a2 ] && [ -z "$(ls -A "$T/wt" 2>/dev/null)" ] \
  && ok "push 失敗：收回 worktree 與分支，共用 checkout 原樣" || ng "push 失敗時共用 checkout 已被拿掉" "rc=$rc a.js=$(cat "$T/shared/a.js") $(cat "$T/out")"

# 6d. 壞掉的 symlink 排在前面也不能讓後面的檔錯位；帶空白的檔名去重不誤殺；所在目錄刪掉的檔
setup
ln -s nowhere "$T/shared/broken"; echo a2 > "$T/shared/a.js"; echo 1 > "$T/shared/a b"; echo 2 > "$T/shared/c"; echo 3 > "$T/shared/b c"
rm -r "$T/shared/sub"
rc=$( ( cd "$T/shared" && bash "$HERE/ship-pr" -F "$T/msg" demo broken a.js "a b" c "b c" sub/del.js ) >"$T/out" 2>&1; echo $? )
files=$(git --git-dir="$T/origin.git" diff --name-only $B "$(br)" 2>/dev/null | tr '\n' '|')
[ "$rc" = 0 ] && [ "$files" = "a b|a.js|b c|broken|c|sub/del.js|" ] && ! grep -q 途中又被改過 "$T/out" \
  && [ -z "$(G shared status --porcelain)" ] \
  && ok "壞 symlink、帶空白的檔名、目錄已刪的檔：全部搬走、沒有誤報" || ng "特殊檔名處理不對" "rc=$rc files=$files $(cat "$T/out") $(G shared status --short)"

# 6e. animyria 直接擋
setup
G shared remote set-url origin "$T/animyria.git"; echo a2 > "$T/shared/a.js"
rc=$(run "-F $T/msg demo a.js")
[ "$rc" = 2 ] && grep -q pushq "$T/out" && [ -z "$(br)" ] && ok "origin 是 animyria：直接擋" || ng "animyria 沒擋" "rc=$rc $(cat "$T/out")"

# 7. commit 的同時別人又改了那個檔：不從共用 checkout 拿掉，印警告
setup
echo a2 > "$T/shared/a.js"
mkdir -p "$T/shared/.git/hooks"
printf '#!/bin/sh\necho racing > "%s/shared/a.js"\n' "$T" > "$T/shared/.git/hooks/pre-commit"; chmod +x "$T/shared/.git/hooks/pre-commit"
rc=$(run "-F $T/msg demo a.js")
[ "$rc" = 0 ] && [ "$(cat "$T/shared/a.js")" = racing ] && grep -q '途中又被改過' "$T/out" \
  && ok "搬的途中被改過的檔留在共用 checkout、印警告" || ng "途中被改過的檔被蓋掉" "rc=$rc a.js=$(cat "$T/shared/a.js") $(cat "$T/out")"

printf '\n  %s 過 · %s 失敗\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
