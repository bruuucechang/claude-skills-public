#!/bin/bash
# test-memsync.sh — memsync 的迴歸測試（假的 origin＋假的共用 checkout，不碰真的 repo）。
#   bash ~/.claude/skills/home/bin/test-memsync.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok(){ printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
ng(){ printf '  ✗ %s\n      %s\n' "$1" "${2-}"; FAIL=$((FAIL+1)); }
B=feature/x
export HOME="$T/home" MEMSYNC_BRANCH=$B MEMSYNC_NOTIFY= MEMSYNC_NO_OSA=1 TMPDIR="$T"
mkdir -p "$HOME"
git config --global user.email t@t; git config --global user.name t; git config --global init.defaultBranch $B
G(){ git -C "$T/$1" "${@:2}"; }

setup() {
  rm -rf "$T/origin.git" "$T/shared" "$T/other" "$HOME/.claude/state"
  git init -q --bare "$T/origin.git"
  git clone -q "$T/origin.git" "$T/shared" 2>/dev/null
  mkdir -p "$T/shared/home/claude/memory"
  echo a > "$T/shared/home/claude/memory/a.md"; echo code > "$T/shared/code.js"
  G shared add -A; G shared commit -q -F - <<<'init'; G shared push -q origin HEAD:$B 2>/dev/null
  G shared branch -q -u origin/$B 2>/dev/null
  git clone -q -b $B "$T/origin.git" "$T/other" 2>/dev/null
  export MEMSYNC_REPO="$T/shared"
}
run() { bash "$HERE/memsync" >"$T/out" 2>&1; echo $?; }

# 1. 只 commit 記憶目錄：別人工作區的改動、別人暫存的東西都不帶進來
setup
echo b > "$T/shared/home/claude/memory/new.md"; echo a2 > "$T/shared/home/claude/memory/a.md"
echo dirty > "$T/shared/code.js"; echo staged > "$T/shared/staged.js"; G shared add staged.js
rc=$(run)
files=$(G shared show --name-only --format= HEAD | sort | tr '\n' ' ')
pushed=$(git -C "$T/origin.git" rev-parse $B); head=$(G shared rev-parse HEAD)
[ "$rc" = 0 ] && [ "$files" = "home/claude/memory/a.md home/claude/memory/new.md " ] && [ "$pushed" = "$head" ] \
  && ok "只 commit 記憶目錄並推上去" || ng "只 commit 記憶目錄並推上去" "rc=$rc files=$files $(cat "$T/out")"
[ "$(G shared diff --cached --name-only)" = "staged.js" ] && [ "$(cat "$T/shared/code.js")" = dirty ] \
  && ok "別人暫存的與工作區的改動原封不動" || ng "別人暫存的與工作區的改動原封不動" "$(G shared status --short)"

# 2. 沒事要做就安靜結束、不 commit
before=$(G shared rev-parse HEAD); rc=$(run)
[ "$rc" = 0 ] && [ "$(G shared rev-parse HEAD)" = "$before" ] && ok "沒改動不 commit" || ng "沒改動不 commit" "$(cat "$T/out")"

# 3. origin 前進了、本機落後：先 ff 再 commit，推上去是 fast-forward
setup
echo up > "$T/other/up.js"; G other add up.js; G other commit -q -F - <<<'upstream'; G other push -q 2>/dev/null
echo m > "$T/shared/home/claude/memory/m.md"
rc=$(run)
[ "$rc" = 0 ] && [ "$(G shared log --format=%s -2 | tail -1)" = upstream ] && [ -f "$T/shared/up.js" ] \
  && ok "落後時先 ff 再 commit" || ng "落後時先 ff 再 commit" "rc=$rc $(cat "$T/out")"

# 4. 本機改過、origin 也改了、內容一模一樣（別的 session 先套了 PR）：照樣 ff，工作區不動
setup
echo v2 > "$T/other/code.js"; G other commit -q -a -F - <<<'pr merged'; G other push -q 2>/dev/null
echo v2 > "$T/shared/code.js"; echo m > "$T/shared/home/claude/memory/m.md"
rc=$(run)
[ "$rc" = 0 ] && [ -z "$(G shared status --porcelain)" ] && [ "$(G shared log --format=%s -2 | tail -1)" = "pr merged" ] \
  && ok "本機已有同樣內容的檔也能 ff" || ng "本機已有同樣內容的檔也能 ff" "rc=$rc $(cat "$T/out") $(G shared status --short)"

# 5. 本機改過、origin 改成不一樣的內容：停手，不動 HEAD、不 commit
setup
echo theirs > "$T/other/code.js"; G other commit -q -a -F - <<<'conflict'; G other push -q 2>/dev/null
echo mine > "$T/shared/code.js"; echo m > "$T/shared/home/claude/memory/m.md"
before=$(G shared rev-parse HEAD); rc=$(run)
[ "$rc" = 1 ] && [ "$(G shared rev-parse HEAD)" = "$before" ] && [ "$(cat "$T/shared/code.js")" = mine ] && grep -q '停手' "$T/out" \
  && ok "不能 ff 就停手" || ng "不能 ff 就停手" "rc=$rc $(cat "$T/out")"
# 同一個原因第二次不再叫（state 檔記著）
[ -f "$HOME/.claude/state/memsync.last" ] && ok "停手原因記下來（同一個原因只叫一次）" || ng "停手原因沒記下來"

# 6. HEAD 上有別人沒推的 commit：不替它推
setup
echo x > "$T/shared/x.js"; G shared add x.js; G shared commit -q -F - <<<'someone else'
echo m > "$T/shared/home/claude/memory/m.md"
rc=$(run)
[ "$rc" = 1 ] && grep -q 別人沒推 "$T/out" && [ "$(git -C "$T/origin.git" log --format=%s -1 $B)" = init ] \
  && ok "別人沒推的 commit 不替它推" || ng "別人沒推的 commit 不替它推" "rc=$rc $(cat "$T/out")"

# 7. 不在目標分支：停手
setup
G shared checkout -q -b other-branch; echo m > "$T/shared/home/claude/memory/m.md"
rc=$(run)
[ "$rc" = 1 ] && grep -q '不是' "$T/out" && ok "不在目標分支就停手" || ng "不在目標分支就停手" "rc=$rc $(cat "$T/out")"

# 8. 上次 push 被拒留下 memsync 的 commit、origin 又前進（分岔）：停手，記憶 commit 跟檔都留著（PR #10 審查：以前 reset 掉、rm 掉）
setup
echo n > "$T/shared/home/claude/memory/new.md"
git -C "$T/origin.git" config receive.denyNonFastForwards false
printf '#!/bin/sh\nexit 1\n' > "$T/origin.git/hooks/pre-receive"; chmod +x "$T/origin.git/hooks/pre-receive"
run >/dev/null; rm "$T/origin.git/hooks/pre-receive"
echo up > "$T/other/up.js"; G other add up.js; G other commit -q -F - <<<'upstream'; G other push -q 2>/dev/null
rc=$(run)
[ "$rc" = 1 ] && [ -f "$T/shared/home/claude/memory/new.md" ] && grep -q 分岔 "$T/out" && G shared log --format=%s -1 | grep -q 記憶同步 \
  && ok "分岔時停手、記憶 commit 與檔都留著" || ng "分岔時停手、記憶 commit 與檔都留著" "rc=$rc $(cat "$T/out") $(ls "$T/shared/home/claude/memory")"

# 9. 走 ff 退路時 origin 同時刪檔又改檔：刪的照刪、改的補進工作區，不留舊內容（PR #10 審查）
setup
echo old > "$T/other/old.js"; echo lib1 > "$T/other/lib.js"; G other add -A; G other commit -q -F - <<<'add'; G other push -q 2>/dev/null
G shared pull -q --ff-only 2>/dev/null
G other rm -q old.js; echo lib2 > "$T/other/lib.js"; echo v2 > "$T/other/code.js"; G other commit -q -a -F - <<<'del+mod'; G other push -q 2>/dev/null
echo v2 > "$T/shared/code.js"; echo m > "$T/shared/home/claude/memory/m.md"
rc=$(run)
[ "$rc" = 0 ] && [ -z "$(G shared status --porcelain)" ] && [ ! -e "$T/shared/old.js" ] && [ "$(cat "$T/shared/lib.js")" = lib2 ] \
  && ok "ff 退路：刪的照刪、改的補進工作區" || ng "ff 退路：刪的照刪、改的補進工作區" "rc=$rc $(cat "$T/out") $(G shared status --short)"

# 10. 走 ff 退路時 origin 在既有目錄底下新增了本機還沒有的目錄：補進工作區，不印 git 的「could not open directory」（2026-10-21 P4 回報）
setup
mkdir -p "$T/other/home/claude/docs/new"; echo r > "$T/other/home/claude/docs/new/r.md"; echo v2 > "$T/other/code.js"
G other add -A; G other commit -q -F - <<<'new dir'; G other push -q 2>/dev/null
echo v2 > "$T/shared/code.js"; echo m > "$T/shared/home/claude/memory/m.md"
rc=$(run)
[ "$rc" = 0 ] && [ "$(cat "$T/shared/home/claude/docs/new/r.md" 2>/dev/null)" = r ] && ! grep -q "could not open" "$T/out" \
  && ok "ff 退路：新目錄補進來、不印警告" || ng "ff 退路：新目錄補進來、不印警告" "rc=$rc $(cat "$T/out")"

# 11. 本機在 origin 要新增的路徑上有一個懸空的 untracked symlink：停手、不蓋掉它（PR #14 審查）
setup
echo r > "$T/other/new.js"; echo v2 > "$T/other/code.js"
G other add -A; G other commit -q -F - <<<'new file'; G other push -q 2>/dev/null
echo v2 > "$T/shared/code.js"; ln -s "$T/nowhere" "$T/shared/new.js"; echo m > "$T/shared/home/claude/memory/m.md"
rc=$(run)
[ "$rc" != 0 ] && [ -L "$T/shared/new.js" ] \
  && ok "懸空 symlink 擋住 ff：停手、symlink 留著" || ng "懸空 symlink 擋住 ff：停手、symlink 留著" "rc=$rc $(cat "$T/out")"

printf '\n  %d 通過，%d 失敗\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
