#!/usr/bin/env bash
#
# tests/run.sh — 這些 skill 附帶的腳本的迴歸測試。
#
# 為什麼是殼層測試而不是 evals.json：這個 repo 沒有 eval runner，寫一份沒人
# 執行的 evals.json 只會變成綠燈假象。下面每一條都對應一個**真的發生過**的
# 缺陷，而且都是機械可測的——不需要模型參與就能判對錯。
#
# 每加一條規則就先把 bug 放回去確認它會紅。寫了不會失敗的測試比沒寫更糟。
#
#   bash ~/.claude/skills/tests/run.sh
#
set -uo pipefail

S="${SKILLS_ROOT:-$HOME/.claude/skills}"   # 在 PR 的 worktree 裡驗：SKILLS_ROOT=<worktree> bash tests/run.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
g(){ printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
b(){ printf '  \033[31m✗\033[0m %s\n' "$1"; printf '      %s\n' "${2-}"; FAIL=$((FAIL+1)); }

# ── check-paths.mjs ────────────────────────────────────────────────
# 缺陷：onDisk.push(p.slice(root.length + 1))。root 是 `.` 時 path.join 會把
# 它正規化掉，slice(2) 於是砍掉檔名前兩個字元，「磁碟上有但沒進版控的檔案
# 也算數」整條失效。preflight 固定傳 `.`，所以每次開工體檢都跑在壞路徑上。
printf '\n  check-paths.mjs\n\n'
R="$T/cp"; mkdir -p "$R/src"
( cd "$R" && git init -q . \
  && echo x > src/tracked.ts && echo y > generated.js \
  && printf 'node_modules\ngenerated.js\n' > .gitignore \
  && git add -A && git -c user.email=t@t -c user.name=t commit -qm init )

printf '見 `src/tracked.ts` 與 `generated.js`\n' > "$R/CLAUDE.md"
for arg in "$R" "."; do
  out=$( cd "$R" && node "$S/sync-docs/check-paths.mjs" "$arg" 2>&1 )
  case "$out" in
    *"都在"*) g "gitignore 掉但存在的檔案不算漂移（root=${arg#$T/})" ;;
    *) b "gitignore 掉但存在的檔案被誤報成漂移（root=${arg#$T/})" "$out" ;;
  esac
done

printf '見 `src/tracked.ts` 與 `src/gone.ts`\n' > "$R/CLAUDE.md"
out=$( cd "$R" && node "$S/sync-docs/check-paths.mjs" . 2>&1 )
case "$out" in
  *"src/gone.ts"*) g "真的不見的檔案照樣抓得到（沒有為了消誤報而放水）" ;;
  *) b "真漂移沒被抓到" "$out" ;;
esac

# quiet 模式：沒事要完全安靜，有事才印一行。
printf '見 `src/tracked.ts`\n' > "$R/CLAUDE.md"
out=$( cd "$R" && node "$S/sync-docs/check-paths.mjs" . --quiet 2>&1 )
[ -z "$out" ] && g "quiet 模式沒事時完全安靜" || b "quiet 模式沒事卻出聲" "$out"

# ── scaffold.sh 專案名驗證 ─────────────────────────────────────────
# 缺陷：case "$NAME" in [a-z0-9]*) —— glob 的 * 匹配任意後綴，等於只檢查
# 第一個字元。`a/../../tmp/evil` 會通過並讓 DIR 落到 ~/Projects 外面；
# `a|b` 會通過並讓 subst() 的 sed 報 bad flag in substitute command。
printf '\n  scaffold.sh 專案名驗證\n\n'
# **要比對驗證訊息，不能只看 exit code。** 舊版驗證下 `a|b` 是「通過驗證、
# 稍後在 subst() 的 sed 崩掉」，exit code 一樣非零——只看 exit code 會把
# 崩潰誤判成擋下，測試就變成綠燈假象（實測過，這條就是這樣被抓出來的）。
for bad in "a/../../tmp/evil" "a|b" "a;rm -rf x" 'a$(id)' "MyProj" "-lead" "trail-" "有中文"; do
  out=$( bash "$S/newproj/scaffold.sh" "$bad" --dir "$T/x" --web-port 1 --api-port 2 \
         --no-registry --no-createdb --no-db 2>&1 )
  # 兩個都算數：以 `-` 開頭的會先被選項解析器攔下（訊息不同但同樣是動手前擋掉）。
  # 關鍵是**不能**接受 sed 崩潰或其他事後爆炸當作「擋下」。
  case "$out" in
    *"專案名只能是"*|*"不認得的選項"*) g "擋下 ${bad}" ;;
    *) b "應該在動手前擋下卻沒有：${bad}" "實際輸出：$(printf '%s' "$out" | head -1)" ;;
  esac
done
for ok in "myproj" "my-proj" "trip-atlas" "a1"; do
  rm -rf "$T/ok"
  if bash "$S/newproj/scaffold.sh" "$ok" --dir "$T/ok" --web-port 5999 --api-port 5998 \
       --no-registry --no-createdb --no-db >/dev/null 2>&1 && [ -f "$T/ok/run.sh" ]; then
    g "合法名稱照樣建得起來：${ok}"
  else
    b "合法名稱被誤擋：${ok}" "驗證式收太緊了"
  fi
done

# ── scaffold.sh 防覆寫 ─────────────────────────────────────────────
# guardrail：已經有 backend/app/ 就拒絕執行，不覆蓋改過的程式碼。
printf '\n  scaffold.sh 防覆寫\n\n'
rm -rf "$T/ow"; mkdir -p "$T/ow/backend/app"
echo "我改過的東西" > "$T/ow/backend/app/main.py"
before=$(cat "$T/ow/backend/app/main.py")
bash "$S/newproj/scaffold.sh" ow --dir "$T/ow" --web-port 5999 --api-port 5998 \
  --no-registry --no-createdb >/dev/null 2>&1
rc=$?
after=$(cat "$T/ow/backend/app/main.py")
[ "$rc" -ne 0 ] && g "已有骨架時拒絕執行（exit ${rc}）" || b "已有骨架卻仍然執行" "exit 0"
[ "$before" = "$after" ] && g "既有程式碼沒被覆蓋" || b "既有程式碼被覆蓋了" "這是不可逆的"

# ── quad 的兩道防 fork bomb 閘 ─────────────────────────────────────
# guardrail：--auto 只有「畫面上只有這一個視窗」時才動作，否則以 10 結束。
# 這一條擋的是 4 → 16 → 64 的視窗爆炸，是這批 skill 裡破壞性最高的失敗模式。
# 用假的 osascript 餵視窗數，全程不碰真的 Terminal。
printf '\n  quad 防 fork bomb\n\n'
if [ -x "$HOME/.local/bin/quad" ]; then
  mkdir -p "$T/bin"
  cat > "$T/bin/osascript" <<'STUB'
#!/usr/bin/env bash
# 只攔「數視窗」那一問，回報 2（＝畫面上還有別的視窗）。
# 其餘的問題原樣轉給真的 osascript，這樣幾何運算照常。
for a in "$@"; do
  case "$a" in *"count windows"*) echo 2; exit 0 ;; esac
done
exec /usr/bin/osascript "$@"
STUB
  chmod +x "$T/bin/osascript"
  rm -f "${TMPDIR:-/tmp}/.quad.lock"
  PATH="$T/bin:$PATH" "$HOME/.local/bin/quad" --auto >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 10 ] && g "視窗數 > 1 時 --auto 什麼都不做（exit 10）" \
                   || b "閘二沒擋住：--auto 在有 2 個視窗時 exit ${rc}" "遞迴就是斷在這一條，破了會 4→16→64"

  # 閘一：時間鎖。剛跑過就再跑一次，應該同樣以 10 結束。
  touch "${TMPDIR:-/tmp}/.quad.lock"
  PATH="$T/bin:$PATH" "$HOME/.local/bin/quad" --auto >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 10 ] && g "時間鎖在 TTL 內擋下第二次觸發（exit 10）" \
                   || b "閘一沒擋住：TTL 內第二次觸發 exit ${rc}" ""
  rm -f "${TMPDIR:-/tmp}/.quad.lock"
else
  printf '  \033[2m·\033[0m 跳過（這台沒有 ~/.local/bin/quad，Windows 本來就沒有）\n'
fi

# ── context-tier 的累積層 ─────────────────────────────────────────
# 缺陷（實際會發生的四種，每一種都用突變測過會讓下面紅）：
#   · 分塊解碼不留位元組 carry → 中文字被切斷成替代字元，**安靜地少算**
#   · offset 推到檔尾而不是最後一個完整行 → 下一輪從半行接，永遠對不齊
#   · 檔案變小（/clear 換新 transcript）不 reset → 從不存在的位置讀，永遠回 0
#   · 不判斷有沒有跨階 → 每一輪都叫，叫到被當成雜訊
# 測試自己合成 6 MB 帶中文的 transcript（CHUNK 是 4 MB，不跨過去就測不到）。
printf '\n  context-tier 累積層\n\n'
if out=$( node "$S/home/claude/hooks/test-context-tier.mjs" 2>&1 ); then
  n=$(printf '%s' "$out" | grep -oE '[0-9]+ 過' | grep -oE '[0-9]+')
  g "全部通過（${n:-?} 條）"
else
  b "有失敗" "$(printf '%s' "$out" | grep '✗' | head -5)"
fi

# ── hooks/lib/log.mjs ─────────────────────────────────────────────
# 缺陷：hook 的 log 只增不減（ask-with-options.log 長到 5851 行、
# instructions-loaded.jsonl 3.3MB）。改成每天第一次寫入時刪 30 天以前的行。
printf '\n  hook log 30 天輪替\n\n'
if out=$( node "$S/home/claude/hooks/lib/log.test.mjs" 2>&1 ); then
  g "修剪、鎖、一天一次都對"
else
  b "有失敗" "$(printf '%s' "$out" | head -5)"
fi

# ── hooks/dispatch.mjs ────────────────────────────────────────────
# 每個事件只開一個 node 的分派器（2026-10-20）。突變測過：合併只留第一個 deny、
# 作者檢查一律放行、拿掉單一檢查的逾時，下面都會紅（最後一個是整支沒印總結就退出）。
printf '\n  hook 分派器\n\n'
if out=$( node "$S/home/claude/hooks/test-dispatch.mjs" 2>&1 ); then
  n=$(printf '%s' "$out" | grep -oE '[0-9]+ 過' | grep -oE '[0-9]+')
  g "全部通過（${n:-?} 條）"
else
  b "有失敗" "$(printf '%s' "$out" | grep -E '✗' | head -5)"
fi

# focus-guard 的案例表（改成 run(input) 之後單獨執行也要照舊）
if out=$( node "$S/home/claude/hooks/test-focus-guard.mjs" 2>&1 ); then
  g "focus-guard 案例表全對"
else
  b "focus-guard 案例表有錯" "$(printf '%s' "$out" | grep '✖' | head -5)"
fi

# ask-with-options 的判斷式：每一筆歷史擋下逐筆標過該擋／誤擋（2026-10-20 H3）
if out=$( node "$S/home/claude/hooks/test-ask-with-options.mjs" 2>&1 ); then
  g "ask-with-options 案例表全對"
else
  b "ask-with-options 案例表有錯" "$(printf '%s' "$out" | grep '✗' | head -5)"
fi

# commit-message-guard／git-author-guard／ask-hides-prose 的案例表（2026-10-21 P1：誤擋與漏擋）
for t in commit-message-guard git-author-guard ask-hides-prose; do
  if out=$( node "$S/home/claude/hooks/test-$t.mjs" 2>&1 ); then
    g "$t 案例表全對"
  else
    b "$t 案例表有錯" "$(printf '%s' "$out" | grep '✗' | head -5)"
  fi
done

# kill-guard（pkill／killall／kill $(pgrep) 擋、kill <pid> 放）與 lang-guard（英文收尾擋、一回合一次）：2026-10-21 P3
for t in kill-guard lang-guard; do
  if out=$( node "$S/home/claude/hooks/test-$t.mjs" 2>&1 ); then
    g "$t 案例表全對（$(printf '%s' "$out" | grep -oE '[0-9]+ 過' | tail -1)）"
  else
    b "$t 案例表有錯" "$(printf '%s' "$out" | grep '✗' | head -5)"
  fi
done

# agent-model-guard：同一則訊息 ≥4 個 opus general-purpose 擋（2026-10-21 P2）。突變測過：上限改成 99 會紅 7 條
if out=$( node "$S/home/claude/hooks/test-agent-model-guard.mjs" 2>&1 ); then
  g "agent-model-guard 案例表全對"
else
  b "agent-model-guard 案例表有錯" "$(printf '%s' "$out" | grep '✗' | head -5)"
fi

# ── ext.mjs（外部回報腳本的掛法，2026-10-20 H4）──────────────────────
# 缺陷：拿掉外層 `[ -f ] && … || true` 之後，別台機器沒 clone 那個 repo 時 node 會 exit 1；
# 被載入的腳本也必須看到跟直接執行一樣的 argv（report.mjs 讀 argv[2] 當事件名）。
printf '\n  ext.mjs 外部 hook 掛法\n\n'
X="$S/home/claude/hooks/ext.mjs"
if out=$( echo '{}' | node "$X" "$T/nope.mjs" Stop 2>&1 ) && [ -z "$out" ]; then
  g "檔案不存在：exit 0、不輸出"
else
  b "檔案不存在時沒有安靜結束" "$out"
fi
printf 'console.log(process.argv.slice(1).join("|")); throw new Error("壞掉")\n' > "$T/argv.mjs"
out=$( node "$X" "$T/argv.mjs" Stop 2>&1 ); rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "$T/argv.mjs|Stop" ]; then
  g "argv 跟直接執行一樣、腳本丟例外照樣 exit 0"
else
  b "argv 或容錯不對（rc=$rc）" "$out"
fi

# ── settings-fields.mjs（Windows 的 settings.json 補共通欄位，2026-10-21 W2）──────
# 缺陷：兩台 Windows 的 settings.json 是實體檔，mac 加的欄位到不了；補的時候不准動別的欄位，
# 已經對了就不准重寫檔案（每次 sync 都改 mtime 會把別人的未存改動蓋掉）。
printf '\n  settings-fields.mjs\n\n'
F="$T/settings.json"
printf '{"env":{"KEEP":"1"},"model":"opus","idleCompaction":true}\n' > "$F"
if SETTINGS_FIELDS_FILE="$F" node "$S/home/claude/tools/settings-fields.mjs" --check >/dev/null 2>&1; then
  b "--check 在缺欄位時回 0" "$(cat "$F")"
else
  g "--check 缺欄位回 1、不改檔"
fi
SETTINGS_FIELDS_FILE="$F" node "$S/home/claude/tools/settings-fields.mjs" >/dev/null 2>&1
out=$( node -e 'const s=require(process.argv[1]);console.log(s.env.CLAUDE_CODE_SUBAGENT_MODEL,s.idleCompaction,s.env.KEEP,s.model)' "$F" )
if [ "$out" = "sonnet false 1 opus" ]; then g "補上兩欄、其他欄位原樣"; else b "補欄位結果不對" "$out"; fi
mt(){ node -e 'console.log(require("fs").statSync(process.argv[1]).mtimeMs)' "$1"; }
before=$( mt "$F" ); rm -f "$F.bak-settings-fields"
SETTINGS_FIELDS_FILE="$F" node "$S/home/claude/tools/settings-fields.mjs" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$( mt "$F" )" = "$before" ] && [ ! -e "$F.bak-settings-fields" ]; then
  g "已齊全：exit 0、不重寫、不留備份"
else
  b "已齊全時仍動了檔案（rc=${rc}）" "$before"
fi
printf '\357\273\277{"env":{},"idleCompaction":true}\r\n' > "$F"
out=$( SETTINGS_FIELDS_FILE="$F" node "$S/home/claude/tools/settings-fields.mjs" 2>&1 ); rc=$?
if [ "$rc" -eq 0 ] && [ "$(head -c3 "$F" | od -An -tx1 | tr -d ' \n')" = efbbbf ] && grep -q $'\r$' "$F" \
   && printf '%s' "$out" | grep -q '原本是 true'; then
  g "帶 BOM／CRLF 的檔：照補、BOM 與行尾保留、印出被改掉的舊值"
else
  b "BOM／CRLF 的檔處理不對（rc=${rc}）" "$out"
fi
if [ ! -f "$S/home/claude/settings.json" ]; then
  printf '  · 沒有 repo 的 settings.json（公開版），跳過 FIELDS 一致性\n'
elif SETTINGS_FIELDS_FILE="$S/home/claude/settings.json" node "$S/home/claude/tools/settings-fields.mjs" --check >/dev/null 2>&1; then
  g "FIELDS 跟 repo 的 settings.json 一致"
else
  b "FIELDS 跟 repo 的 settings.json 對不上（mac 改了值卻沒改表，或反過來）" ""
fi
mkdir -p "$T/real" && printf '{}\n' > "$T/real/s.json" && ln -sf "$T/real/s.json" "$T/link.json"
SETTINGS_FIELDS_FILE="$T/link.json" node "$S/home/claude/tools/settings-fields.mjs" >/dev/null 2>&1
if [ -L "$T/link.json" ] && grep -q sonnet "$T/real/s.json"; then
  g "symlink 的 settings.json：寫進連結目標、連結保留"
else
  b "symlink 被換成實體檔，或目標沒被寫到" "$(ls -l "$T/link.json")"
fi
printf '{"env":' > "$F"
if SETTINGS_FIELDS_FILE="$F" node "$S/home/claude/tools/settings-fields.mjs" >/dev/null 2>&1 || [ "$(cat "$F")" != '{"env":' ]; then
  b "壞掉的 JSON 被改寫或回 0" "$(cat "$F")"
else
  g "壞掉的 JSON：回 1、原檔不動"
fi

# ── ship-pr／recon-check（ship 5b 與 /recon 的機械步驟，2026-10-21 W3）──────────
# 假 origin＋假共用 checkout＋假 gh。突變測過：拿掉 --head、失敗不收回 worktree、不檢查搬的途中被改、
# --merge 不擋髒 worktree、commit 改用 -m、選項缺值、diff.noprefix、--merge 不比對 repo、
# --merge 不查沒推的 commit／先收 worktree 再合併／不擋非 pr/、push 排在清共用 checkout 之後、壞 symlink 讓快照錯位、
# 去重用字串比對、不擋 animyria、fetch 失敗不出聲、未追蹤目錄攤開、porcelain 不用 -z、--no-fetch 只認第一個、清單截斷不標，各自都會紅。
printf '\n  ship-pr／recon-check\n\n'
for t in ship-pr recon-check; do
  if out=$( bash "$S/home/bin/test-$t.sh" 2>&1 ); then
    g "$t 全部通過（$(printf '%s' "$out" | grep -oE '[0-9]+ 過' | tail -1)）"
  else
    b "$t 有失敗" "$(printf '%s' "$out" | grep -A1 '✗' | head -6)"
  fi
done

# ── handoff-open 開場白預塞資料（2026-10-21 W4）────────────────────────────────
# 突變測過：拿掉「只注一次」、不比對 pid、不看 clearing 多舊、開場白不附交接單全文，各自都會紅。
printf '\n  handoff-open 開場白\n\n'
if out=$( bash "$S/home/bin/test-handoff-open.sh" 2>&1 ); then
  g "handoff-open 開場白全部通過（$(printf '%s' "$out" | grep -oE '[0-9]+ 過' | tail -1)）"
else
  b "handoff-open 開場白有失敗" "$(printf '%s' "$out" | grep -A1 '✗' | head -6)"
fi

# ── rate-limit-switch：bruce 撞額度上限馬上換到 peter（2026-10-21 W5）─────────────────
# 突變測過：不看 error、不記「這格換過」、不看換不換得了、反向也換、不看 peter 額度、不補 pane done，各自都會紅。
printf '\n  rate-limit-switch\n\n'
if out=$( node "$S/home/claude/hooks/test-rate-limit-switch.mjs" 2>&1 ); then
  g "rate-limit-switch 案例表全對（$(printf '%s' "$out" | grep -oE '[0-9]+ 過' | tail -1)）"
else
  b "rate-limit-switch 案例表有錯" "$(printf '%s' "$out" | grep '✗' | head -5)"
fi

printf '\n  %s 過 · %s 失敗\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
