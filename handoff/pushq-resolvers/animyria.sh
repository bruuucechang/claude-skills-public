#!/usr/bin/env bash
# pushq 的 animyria 衝突解法（repos.json 的 resolve 指到這支；在佇列的 worktree 裡、合併撞衝突時跑）。
#
# 2026-10-20 佇列第一輪 14 件有 12 件被退回，撞的幾乎都是同一批「生成的」檔：
#   game/locale/*.pot／*.po   tools/i18n.py extract 從原始碼重產（.po 的 msgstr 全是空的，沒有人工翻譯）
#   docs/notebook.md          「目前 core/ 模組 N 個、目前測試 N 個」那一行，數字由 tools/vitals.py 量；
#                             以及兩邊都在檔尾各加一節（只增不改，聯集就對）
#   docs/module-map.md        兩邊在樹的同一處各插一行新模組（base 是空的，聯集就對；2026-10-21）。
#                             同日起新模組改寫 docs/module-map.d/<塊>.md，這條是給碎片制度之前開的分支用的
# locale 與 notebook 數字那一行取 master 那邊再重產／重量；notebook 檔尾與 module-map 同處新增是兩邊都留。**其他衝突一律不碰**（exit 非 0 → 佇列照舊退給人修）：
# blocks.md 的狀態、程式碼、notebook 的其他段落都要人判斷。解完佇列照跑完整的 pre-push，解錯會被擋下來。
#
# 慣例：佇列的合併是「站在 master 上合進分支」，所以 ours（:2）＝master、theirs（:3）＝分支。
set -euo pipefail

# notebook 的數字那一行照合併後的實際值寫（跟 vitals 的宣稱核對一致）
refresh_counts() {
  python3 - <<'PY'
import re, subprocess
out = subprocess.run(["python3", "tools/vitals.py"], capture_output=True, text=True).stdout
m = re.search(r"core_modules\s+(\d+)", out); n = re.search(r"test_methods\s+(\d+)", out)
if m and n:
    p = "docs/notebook.md"
    t = open(p, encoding="utf-8").read()
    t = re.sub(r"(目前 core/ 模組 )\d+( 個、目前測試 )\d+( 個)", rf"\g<1>{m.group(1)}\g<2>{n.group(1)}\g<3>", t, count=1)
    open(p, "w", encoding="utf-8").write(t)
PY
}

# --refresh：合併沒撞衝突也跑（2026-10-21）。兩邊各自加了測試、數字那一行只有一邊改 → 合併乾淨但數字過期，
# pre-push 的 vitals 會擋（BX4 第二次就這樣被退）。只動那一行，有改就 git add，由佇列 commit。
if [ "${1:-}" = "--refresh" ]; then
  refresh_counts
  git add -- docs/notebook.md
  git diff --cached --quiet || echo "resolve：合併後對齊 notebook 的 vitals 數字"
  exit 0
fi

U=()
while IFS= read -r f; do [ -n "$f" ] && U+=("$f"); done < <(git diff --name-only --diff-filter=U)   # macOS 的 bash 3.2 沒有 mapfile
[ "${#U[@]}" -gt 0 ] || exit 0

for f in "${U[@]}"; do
  case "$f" in
    game/locale/*.pot|game/locale/*.po|docs/notebook.md|docs/module-map.md) ;;
    *) echo "resolve：$f 不是生成檔，留給人修" >&2; exit 3 ;;
  esac
done

locale=0
for f in "${U[@]}"; do
  case "$f" in
    game/locale/*.po)
      # 有人工翻譯就不能用重產的蓋掉
      for stage in 2 3; do
        if git show ":$stage:$f" 2>/dev/null | grep -qE '^msgstr ".+"'; then
          echo "resolve：$f 有已翻譯的條目，留給人修" >&2; exit 4
        fi
      done
      locale=1 ;;
    game/locale/*.pot) locale=1 ;;
  esac
done

# 每一塊衝突只能是兩種，否則留給人修：
#   兩邊都只有數字那一行（只有 notebook 有）→ 取 master 的（之後照實際值重量）
#   base 是空的、兩邊都只是新增 → 兩邊都留，master 的在前（2026-10-21）：
#     notebook 只增不改，兩塊都在檔尾加一節；module-map 是兩塊在樹的同一處各插一行新模組
# 用 diff3 重產一次才看得到 base。
union_add() {
  local f=$1 d
  d=$(mktemp -d)
  for s in 1 2 3; do git show ":$s:$f" > "$d/$s" 2>/dev/null || : > "$d/$s"; done
  git merge-file -p --diff3 -L master -L base -L branch "$d/2" "$d/1" "$d/3" > "$d/m" || true
  python3 - "$d/m" "$f" <<'PY' || { rm -rf "$d"; exit 5; }
import re, sys
t = open(sys.argv[1], encoding="utf-8").read()
f = sys.argv[2]
COUNT = re.compile(r"^目前 core/ 模組 \d+ 個、目前測試 \d+ 個")
HUNK = re.compile(r"^<<<<<<< master\n(.*?)^\|\|\|\|\|\|\| base\n(.*?)^=======\n(.*?)^>>>>>>> branch\n", flags=re.S | re.M)
if not HUNK.search(t):
    sys.exit(f"resolve：{f} 的衝突格式認不得")
def solve(m):
    ours, base, theirs = m.group(1), m.group(2), m.group(3)
    ol, tl = ours.splitlines(), theirs.splitlines()
    if f == "docs/notebook.md" and len(ol) == 1 and len(tl) == 1 and COUNT.match(ol[0]) and COUNT.match(tl[0]):
        return ours
    if not base.strip():
        sep = "\n\n" if f == "docs/notebook.md" else "\n"   # module-map 是樹，各插一行，不加空行
        return ours.rstrip("\n") + sep + theirs.lstrip("\n")
    sys.exit(f"resolve：{f} 有改到既有段落的衝突，留給人修")
t = HUNK.sub(solve, t)
if re.search(r"^(<<<<<<<|\|\|\|\|\|\|\||>>>>>>>) ", t, flags=re.M):
    sys.exit(f"resolve：{f} 還有衝突標記")
open(f, "w", encoding="utf-8").write(t)
PY
  rm -rf "$d"
}
for f in docs/notebook.md docs/module-map.md; do
  if printf '%s\n' "${U[@]}" | grep -qx "$f"; then union_add "$f"; fi
done

if [ "$locale" = 1 ]; then
  git checkout --ours -- game/locale/
  python3 tools/i18n.py extract >/dev/null
  python3 tools/i18n.py check >/dev/null || { echo "resolve：重產翻譯表後 i18n check 還是紅" >&2; exit 6; }
fi

if printf '%s\n' "${U[@]}" | grep -qx 'docs/notebook.md'; then refresh_counts; fi

# 只 add 這次真的解了的檔（凍結的文件之後改名或移除，也不會讓整個 add 因為 pathspec 對不上而失敗）
git add -- "${U[@]}" 2>/dev/null || true
[ "$locale" = 1 ] && { git add -- game/locale/ 2>/dev/null || true; }
left=$(git diff --name-only --diff-filter=U)
[ -z "$left" ] || { echo "resolve：還有沒解的：$left" >&2; exit 7; }
echo "resolve：自動解了 ${U[*]}"
