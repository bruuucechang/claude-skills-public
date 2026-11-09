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

# ── scaffold.sh 前端用共用設計規格 ─────────────────────────────────
# U1（2026-10-23）：新專案的前端一律吃 templates/tokens.css＋app.css，元件不寫 inline style。
# app.css 只准引用變數；tokens.css 要有焦點、減少動態、等寬數字、亮暗兩色。
printf '\n  scaffold.sh 前端設計規格\n\n'
for mode in db nodb; do
  flag=""; [ "$mode" = nodb ] && flag="--no-db"
  rm -rf "$T/tk"
  bash "$S/newproj/scaffold.sh" tk --dir "$T/tk" --web-port 5999 --api-port 5998 \
    --no-registry --no-createdb $flag >/dev/null 2>&1
  src="$T/tk/frontend/src"
  if [ -f "${src}/tokens.css" ] && [ -f "${src}/app.css" ] \
     && grep -q "import './tokens.css'" "${src}/main.tsx" && grep -q "import './app.css'" "${src}/main.tsx"; then
    g "${mode}：tokens.css／app.css 複製進去並在 main.tsx 匯入"
  else
    b "${mode}：前端沒接上設計規格" "$(ls "${src}" 2>&1 | tr '\n' ' ')"
  fi
  n=$(grep -c 'style={{' "${src}/App.tsx")
  [ "$n" = 0 ] && g "${mode}：App.tsx 沒有 inline style" || b "${mode}：App.tsx 還有 ${n} 個 inline style" "改用 app.css 的 class"
done
hex=$(grep -nE '#[0-9a-fA-F]{3,8}\b' "$S/newproj/templates/app.css")
[ -z "$hex" ] && g "app.css 沒有寫死色碼" || b "app.css 寫死了色碼" "$hex"
for need in 'prefers-reduced-motion' ':focus-visible' 'tabular-nums' 'light-dark(' '[data-theme="dark"]' '--accent:'; do
  grep -qF -- "$need" "$S/newproj/templates/tokens.css" && g "tokens.css 有 ${need}" || b "tokens.css 少了 ${need}" ""
done

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

# ── hooks/session-title.mjs ───────────────────────────────────────
# 缺陷：標題蓋掉使用者 /rename 的名字、headless 也叫 Haiku、專案名半個字就中。
printf '\n  session-title 自動取名\n\n'
if out=$( node "$S/home/claude/hooks/test-session-title.mjs" 2>&1 ); then
  g "全部通過"
else
  b "有失敗" "$(printf '%s' "$out" | head -5)"
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
# zh-guard（回覆與選項框的簡體字、打錯的冷僻字）：2026-10-22
# git-wipe-guard（reset --hard／checkout .／clean -f／branch -D／stash 擋、push 放）：2026-10-23 X1
for t in kill-guard lang-guard zh-guard git-wipe-guard; do
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
  b "argv 或容錯不對（rc=${rc}）" "$out"
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
if [ ! -f "$S/home/bin/test-handoff-open.sh" ]; then
  printf '  · 沒有 handoff-open（公開版拿掉了），跳過\n'
elif out=$( bash "$S/home/bin/test-handoff-open.sh" 2>&1 ); then
  g "handoff-open 開場白全部通過（$(printf '%s' "$out" | grep -oE '[0-9]+ 過' | tail -1)）"
else
  b "handoff-open 開場白有失敗" "$(printf '%s' "$out" | grep -A1 '✗' | head -6)"
fi

# ── rate-limit-switch：bruce 撞額度上限馬上換到 peter（2026-10-21 W5）─────────────────
# 突變測過：不看 error、不記「這格換過」、不看換不換得了、反向也換、不看 peter 額度、不補 pane done，各自都會紅。
printf '\n  rate-limit-switch\n\n'
if [ ! -f "$S/home/claude/hooks/test-rate-limit-switch.mjs" ]; then
  printf '  · 沒有 rate-limit-switch（公開版拿掉了），跳過\n'
elif out=$( node "$S/home/claude/hooks/test-rate-limit-switch.mjs" 2>&1 ); then
  g "rate-limit-switch 案例表全對（$(printf '%s' "$out" | grep -oE '[0-9]+ 過' | tail -1)）"
else
  b "rate-limit-switch 案例表有錯" "$(printf '%s' "$out" | grep '✗' | head -5)"
fi

# ── peer-msg：pushq 用 inbox socket 交修理指示（2026-10-21 W6）──────────────────────
# 突變測過：不檢查是不是 socket、不比 pid、不等開工、格式錯、只看 busy、waiting 也算開工，各自都會紅。
printf '\n  peer-msg\n\n'
if out=$( node "$S/home/claude/tools/test-peer-msg.mjs" 2>&1 ); then
  g "peer-msg 案例表全對（$(printf '%s' "$out" | grep -oE '[0-9]+ 過' | tail -1)）"
else
  b "peer-msg 案例表有錯" "$(printf '%s' "$out" | grep '✗' | head -5)"
fi

# ── ctx-panel mod：唯讀 context 面板（2026-10-21 W8，試水溫、預設不載入）─────────────
# 突變測過：TIER2 改 900k、拿掉 < 1k 過濾，各自都會紅。
printf '\n  ctx-panel mod\n\n'
# 要真的有測試跑過（pass > 0）才算過；沒有 `claude plugin test` 的版本（舊版、Windows）跳過，不算失敗。
if ! command -v claude >/dev/null 2>&1 || ! claude plugin test --help >/dev/null 2>&1; then
  printf '  · 沒有 claude plugin test，跳過\n'
elif out=$( claude plugin test "$S/home/claude/mods/ctx-panel" 2>&1 ) && printf '%s' "$out" | grep -q ' 0 fail' \
     && printf '%s' "$out" | grep -qE ' [1-9][0-9]* pass'; then
  g "ctx-panel 面板測試全過（$(printf '%s' "$out" | grep -oE '[0-9]+ pass' | tail -1)）"
else
  b "ctx-panel 面板測試有錯" "$(printf '%s' "$out" | grep -E 'fail|Error' | head -5)"
fi

# ── gd-outline.py：GDScript 只留簽名（2026-10-23 X3）──────────────────────────
# 突變測過：本體一律寫 pass（有回傳型別的 Godot 報 Not all code paths return a value）、
# 不追蹤多行字串（字串裡頂格的行被當成本體結束）、註解頂格就結束本體，各自都會紅。
printf '\n  gd-outline.py\n\n'
G="$T/gd"; mkdir -p "$G"
cat > "$G/in.gd" <<'GD'
class_name OutlineFixture
extends RefCounted
signal changed(value: int)
@export var speed := 3
const TABLE := {
	"a": 1,
}
enum Kind { A, B }

func plain(x: int) -> void:
	print("BODY_SECRET_1")

static func typed(a: int,
		b: String = "x:y") -> Kind:
	var s := """
BODY_SECRET_2 頂格的字串行
"""
# BODY_SECRET_3 頂格的註解
	return Kind.A

func one() -> int: return 7

func many() -> Array: return [
	"BODY_SECRET_5",
]

const DOC := """
func not_a_function():
	this is just text
"""

var after := 1

class Inner:
	var hp := 10
	func hit(n: int) -> bool:
		return n > 0 # BODY_SECRET_4
GD
out=$( python3 "$S/home/claude/tools/gd-outline.py" "$G/in.gd" 2>&1 ); rc=$?
printf '%s\n' "$out" > "$G/out.gd"
if [ "$rc" -ne 0 ]; then b "gd-outline 跑不起來" "$out"
elif printf '%s' "$out" | grep -q BODY_SECRET; then b "本體沒有清乾淨" "$(printf '%s' "$out" | grep BODY_SECRET)"
elif [ "$(printf '%s\n' "$out" | grep -c 'body elided')" -ne 5 ]; then b "應該剛好換掉 5 個本體" "$out"
else
  miss=""
  for want in 'signal changed' '@export var speed' '"a": 1,' 'enum Kind' 'b: String = "x:y") -> Kind:' 'var after := 1' 'class Inner:' 'func not_a_function():' 'this is just text' 'func hit(n: int) -> bool:' 'func one() -> int: return {}.get(0) # body elided'; do
    printf '%s' "$out" | grep -qF "$want" || miss="${miss}｜${want}"
  done
  [ -z "$miss" ] && g "簽名與宣告都留著、5 個本體都換掉（多行字串裡的 func 不算）" || b "少了該留的行" "$miss"
fi
GODOT_BIN="${GODOT:-$(command -v godot || true)}"
if [ -z "$GODOT_BIN" ]; then
  printf '  · 沒有 godot，跳過「仍是合法 GDScript」\n'
else
  mkdir -p "$G/proj" && printf 'config_version=5\n' > "$G/proj/project.godot"
  # Godot 解析錯誤時離開碼照樣是 0，只能看輸出。所以先拿一份壞檔當對照：
  # 它一定要報 ERROR，才證明 godot 真的有跑起來、有在解析（不然「沒有 ERROR」什麼都證明不了）
  printf 'extends RefCounted\nfunc f() -> int:\n\tpass\n' > "$G/broken.gd"
  "$GODOT_BIN" --headless --path "$G/proj" --check-only --script "$G/broken.gd" > "$G/control.log" 2>&1
  "$GODOT_BIN" --headless --path "$G/proj" --check-only --script "$G/out.gd" > "$G/check.log" 2>&1; grc=$?
  if ! grep -q 'ERROR' "$G/control.log"; then
    b "godot 沒有在解析（壞檔對照沒報錯），合法性沒驗到" "$(head -3 "$G/control.log")"
  elif [ "$grc" -ne 0 ] || grep -q 'ERROR' "$G/check.log"; then
    b "輸出不是合法 GDScript（godot --check-only，rc=${grc}）" "$(grep -m3 ERROR "$G/check.log")"
  else
    g "輸出仍是合法 GDScript（godot --check-only，壞檔對照有報錯）"
  fi
fi
printf 'const X := """\nfunc f() -> int:\n\treturn 1\n' > "$G/open.gd"
python3 "$S/home/claude/tools/gd-outline.py" "$G/open.gd" > /dev/null 2> "$G/open.err"; rc=$?
[ "$rc" -eq 1 ] && grep -q '還沒關' "$G/open.err" && g "字串沒關到檔尾時出聲、exit 1（大綱不完整不能裝沒事）" \
  || b "字串沒關到檔尾卻沒出聲（rc=${rc}）" "$(cat "$G/open.err")"

# ── rules-audit.sh 的 @ 匯入檢查（2026-10-23 X3）─────────────────────────────
# 突變測過：不往下追被匯入的檔、不跳過程式碼區塊、email 也當成匯入，各自都會紅。
printf '\n  rules-audit.sh @ 匯入\n\n'
I="$T/imp"; mkdir -p "$I/docs"
printf 'ok\n@../gone-nested.md\n' > "$I/docs/ok.md"
printf '@docs/ok.md\n@docs/gone.md\n寄給 a@b.md 或 `@x/inline.md`\n```\n@fenced/gone.md\n```\n' > "$I/CLAUDE.md"
out=$( bash "$S/home/claude/tools/rules-audit.sh" --imports "$I/CLAUDE.md" 2>&1 ); rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q '✗.*@docs/gone.md' && printf '%s' "$out" | grep -q '✗.*@../gone-nested.md' \
   && [ "$(printf '%s\n' "$out" | grep -c '✗')" -eq 2 ]; then
  g "壞掉的 @ 匯入報 ✗（含被匯入的檔裡的），email／code span／程式碼區塊不誤報"
else
  b "@ 匯入檢查不對（rc=${rc}）" "$out"
fi
printf 'ok\n' > "$I/docs/ok.md"; printf '@docs/ok.md\n' > "$I/good.md"
out=$( bash "$S/home/claude/tools/rules-audit.sh" --imports "$I/good.md" 2>&1 ) && printf '%s' "$out" | grep -q '✓' \
  && g "全部找得到時報 ✓、離開碼 0" || b "好的 fixture 被誤報" "$out"
out=$( bash "$S/home/claude/tools/rules-audit.sh" --imports "$I/nothere.md" 2>&1 ); rc=$?
[ "$rc" -eq 2 ] && g "一個檔都沒讀到時 exit 2（沉默不等於成功）" || b "讀不到檔卻沒有 exit 2（rc=${rc}）" "$out"
# 深度：a 直接匯入 c、也經 b 匯入 c；c 底下接 4 層。走 a→b→c 先到的話 c 在第 2 層、鏈尾超過 5 層，
# 但 a→c 是第 1 層、Claude Code 照樣載得到——要記最淺深度，不能看走訪順序。再多一層才真的超過
mkdir -p "$I/deep"; D="$I/deep"
printf '@b.md\n@c.md\n' > "$D/a.md"; printf '@c.md\n' > "$D/b.md"; printf '@d1.md\n' > "$D/c.md"
for k in 1 2 3; do printf '@d%s.md\n' $((k+1)) > "$D/d$k.md"; done; printf 'end\n' > "$D/d4.md"
out=$( bash "$S/home/claude/tools/rules-audit.sh" --imports "$D/a.md" 2>&1 ) \
  && g "同一個檔有較淺的路線就不算超過 5 層" || b "走訪順序造成「超過 5 層」誤報" "$out"
printf '@d5.md\n' > "$D/d4.md"; printf 'end\n' > "$D/d5.md"
out=$( bash "$S/home/claude/tools/rules-audit.sh" --imports "$D/a.md" 2>&1 ); rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q '超過 5 層' && g "真的超過 5 層報 ✗" || b "超過 5 層沒報（rc=${rc}）" "$out"
mkdir -p "$I/adir"; printf '@./adir/\n' > "$I/dir.md"
out=$( bash "$S/home/claude/tools/rules-audit.sh" --imports "$I/good.md" "$I/typo.md" "$I/dir.md" 2>&1 ); rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'typo.md 不存在' && printf '%s' "$out" | grep -q '指向資料夾' \
  && g "--imports 點名的檔不見、@ 指到資料夾都報 ✗" || b "點名的檔不見或指到資料夾卻沒報（rc=${rc}）" "$out"

# ── spend.mjs／spend-report.mjs 依工具分帳（2026-10-23 X3）──────────────────
# 突變測過：Bash 不剝 cd、tool_result 不算進形狀、報告不設 ≥ 3 次門檻，各自都會紅。
printf '\n  spend 依工具分帳\n\n'
H="$T/sh"; mkdir -p "$H/.claude/projects/p" "$H/out"
node -e '
const now = new Date().toISOString(), L = [];
const big = "x".repeat(400000);          // 4 字元 1 token → 100k
for (let i = 0; i < 3; i++) {
  L.push({ type: "assistant", timestamp: now, sessionId: "s", message: { usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "tool_use", id: "a" + i, name: "Bash", input: { command: "cd ~/x && git -C /r diff --stat" } }] } });
  L.push({ type: "user", timestamp: now, sessionId: "s", message: { content: [{ type: "tool_result", tool_use_id: "a" + i, content: big }] } });
}
L.push({ type: "assistant", timestamp: now, sessionId: "s", message: { content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/a/b.png" } }] } });
L.push({ type: "user", timestamp: now, sessionId: "s", message: { content: [{ type: "tool_result", tool_use_id: "r", content: [{ type: "text", text: big }] }] } });
require("fs").writeFileSync(process.argv[1], L.map(x => JSON.stringify(x)).join("\n") + "\n");
' "$H/.claude/projects/p/s.jsonl"
HOME="$H" USERPROFILE="$H" node "$S/home/claude/tools/spend.mjs" 30 > "$H/out/air.json" 2>&1
if node -e 'const d=require(process.argv[1]).toolShapes; process.exit(d["Bash(git diff)"]?.calls===3 && d["Bash(git diff)"].tokens===300000 && d["Read(*.png)"]?.calls===1 ? 0 : 1)' "$H/out/air.json"; then
  g "spend.mjs 依呼叫形狀分帳（剝掉 cd、git -C；Read 只留副檔名）"
else
  b "spend.mjs 的 toolShapes 不對" "$(head -c 400 "$H/out/air.json")"
fi
out=$( node "$S/home/claude/tools/spend-report.mjs" "$H/out" 2>&1 )
sec=$(printf '%s\n' "$out" | sed -n '/依工具分帳/,$p')
if printf '%s' "$sec" | grep -q '本機估算' && printf '%s' "$sec" | grep -q 'Bash(git diff)' && ! printf '%s' "$sec" | grep -q 'Read(\*.png)'; then
  g "spend-report 印出呼叫形狀、註明本機估算、只出現 1 次的不列"
else
  b "spend-report 的依工具分帳不對" "$sec"
fi

# ── inspect-ui 的驗收量測（U2，2026-10-23）─────────────────────────
# source-lint.mjs：反例每一條都要抓到、正例 0 發現、掃不到檔要 exit 2（沉默不等於成功）。
# design-scan.js 的工具畫面類與無障礙類：fixtures/check.py 用 dev-browser --headless 開 file://。
# 突變測過：拿掉 a11y-good.html 的 :focus-visible 陰影、reduced-motion、aria-label、sr-only 字，check.py 都會紅。
printf '\n  inspect-ui 驗收量測\n\n'
F="$S/inspect-ui/fixtures"
out=$( node "$S/inspect-ui/source-lint.mjs" "${F}/lint-bad" --json 2>&1 ); rc=$?
miss=""
for id in transition-all 100vh emoji lorem placeholder-data framework-colour hex-outside-tokens no-focus-visible no-reduced-motion; do
  printf '%s' "$out" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(d.各規則[process.argv[1]] ? 0 : 1)' "$id" || miss="${miss} ${id}"
done
[ "$rc" = 1 ] && [ -z "$miss" ] && g "source-lint 反例 9 條都抓到、exit 1" || b "source-lint 反例漏抓（exit ${rc}）" "漏：${miss}"
hexn=$( printf '%s' "$out" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).各規則["hex-outside-tokens"])' )
[ "$hexn" = 3 ] && g "source-lint 的色碼：註解與 :root 裡的不算、JSX 與 tailwind 任意值的算" || b "hex-outside-tokens 應該是 3 個" "實際 ${hexn}"
out=$( node "$S/inspect-ui/source-lint.mjs" "${F}/lint-good" 2>&1 ); rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q '個檔，0 個發現' && g "source-lint 正例 0 發現" || b "source-lint 正例有誤報（exit ${rc}）" "$out"
out=$( node "$S/inspect-ui/source-lint.mjs" "${F}/lint-still" 2>&1 ); rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q '個檔，0 個發現' && g "source-lint 不誤報錨點色碼、scss／跨行 HTML 註解、example.com 提示、型別欄位叫 animation" || b "source-lint 的 lint-still 有誤報（exit ${rc}）" "$out"
mkdir -p "$T/empty"; node "$S/inspect-ui/source-lint.mjs" "$T/empty" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && g "source-lint 一個檔都沒掃到 → exit 2" || b "source-lint 掃到 0 個檔沒有 exit 2" "exit ${rc}"
if command -v dev-browser >/dev/null 2>&1; then
  out=$( python3 "$S/inspect-ui/fixtures/check.py" 2>&1 ); rc=$?
  [ "$rc" = 0 ] && g "design-scan fixture：反例全抓到、正例 0 誤報（$(printf '%s' "$out" | tail -1)）" || b "design-scan fixture 不符合（exit ${rc}）" "$(printf '%s' "$out" | grep -v '^✓' | head -20)"
else
  printf '  \033[33m－\033[0m %s\n' "略過 design-scan fixture：這台沒有 dev-browser（Windows 等），在有的機器上跑 inspect-ui/fixtures/check.py"
fi

# ── 匯出的私人段落標記（2026-11-09，public-anyone-spec.md）。公開版沒有這支，跳過 ───
if [ -f "$S/export-strip-private.pl" ]; then
  printf '\n  export-strip-private\n\n'
  sp="$T/strip.md"
  printf 'a\n  <!-- private:start -->\nsecret\n  <!-- private:end -->\n<!-- public: pub -->\nb\n' > "$sp"
  if perl "$S/export-strip-private.pl" "$sp" && [ "$(cat "$sp")" = "$(printf 'a\npub\nb')" ]; then g '成對標記刪乾淨、public 打開'; else b '標記處理結果不對' "$(cat "$sp")"; fi
  printf 'a\n<!-- private:start -->\nsecret\n' > "$sp"
  if perl "$S/export-strip-private.pl" "$sp" 2>/dev/null; then b '有開沒關應該要失敗' "$(cat "$sp")"; else g '有開沒關會失敗'; fi
  if grep -q secret "$sp"; then g '失敗時不改檔'; else b '失敗時動到檔案' "$(cat "$sp")"; fi
  printf 'a\n<!-- private:end -->\n' > "$sp"
  if perl "$S/export-strip-private.pl" "$sp" 2>/dev/null; then b '有關沒開應該要失敗' ''; else g '有關沒開會失敗'; fi
fi

# 公開版拿掉了 trend-scout

if [ -d "$S/trend-scout" ]; then
printf '\n  trend-scout\n\n'
F="$S/tests/fixtures/trend-scout"
out=$( python3 "$S/trend-scout/collect.py" --seen /dev/null/x --html "$F/trending.html" --search-json "$F/agent-skills.json" 2>&1 )
printf '%s' "$out" | python3 -c '
import json,sys; d={c["name"]:c for c in json.load(sys.stdin)}
c=d["cloudflare/security-audit-skill"]
assert len(d)==4 and c["stars"]==52626 and c["stars_week"]==16002 and c["license"]=="MIT" and "topic:agent-skills" in c["source"], d
' 2>/dev/null && g "collect：週榜星數（夾 svg）、本週新星、跟主題搜尋去重合併" || b "collect 解析不對" "$out"
echo '["Cloudflare/Security-Audit-Skill"]' > "$T/seen.json"
n=$( python3 "$S/trend-scout/collect.py" --seen "$T/seen.json" --html "$F/trending.html" --search-json "$F/agent-skills.json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' )
[ "$n" = 3 ] && g "collect：看過的不再列（大小寫不分）" || b "collect 沒去掉 seen 的" "剩 $n 個"
echo '<html></html>' > "$T/empty.html"
python3 "$S/trend-scout/collect.py" --seen /dev/null/x --html "$T/empty.html" --search-json >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && g "collect：週榜解析出 0 筆 → exit 2（不當成這週沒東西）" || b "週榜 0 筆沒有 exit 2" "exit $rc"

echo 'not json' > "$T/bad-seen.json"
n=$( python3 "$S/trend-scout/collect.py" --seen "$T/bad-seen.json" --html "$F/trending.html" --search-json "$F/agent-skills.json" 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' )
[ "$n" = 4 ] && g "collect：seen.json 壞掉當成空的，不讓每天都失敗" || b "壞掉的 seen.json 讓 collect 失敗" "得到 ${n:-錯誤}"
echo '{"cloudflare/security-audit-skill":"2026-01-01","jakeschincariol/replica-skill":"2026-01-01"}' > "$T/old-seen.json"
out=$( python3 "$S/trend-scout/collect.py" --seen "$T/old-seen.json" --html "$F/trending.html" --search-json "$F/agent-skills.json" )
printf '%s' "$out" | python3 -c '
import json,sys; d={c["name"]:c for c in json.load(sys.stdin)}
assert d["cloudflare/security-audit-skill"]["reseen"]=="2026-01-01" and "Jakeschincariol/replica-skill" not in d, d' 2>/dev/null \
  && g "collect：≥ 4 週前看過、又進週榜的重看；只在主題搜尋的不重看" || b "重看規則不對" "$out"
echo '{"2026-10-20":{"zhuyansen/new-term-radar":1259,"jakeschincariol/replica-skill":0},"2026-10-24":{"x/y":1},"2026-10-29":{"zhuyansen/new-term-radar":1900},"2026-10-30":{"a/b":5},"junk":1}' > "$T/stars.json"
out=$( python3 "$S/trend-scout/collect.py" --seen /dev/null/x --stars "$T/stars.json" --today 2026-10-30 --html "$F/trending.html" --search-json "$F/agent-skills.json" 2>&1 )
printf '%s' "$out" | python3 -c '
import json,sys; d={c["name"]:c for c in json.load(sys.stdin)}
r=d["zhuyansen/new-term-radar"]; s=json.load(open(sys.argv[1]))
assert r["stars_week"]==490 and r["per_day"]==109 and d["Jakeschincariol/replica-skill"]["stars_week"] is None, d
assert sorted(s)==["2026-10-20","2026-10-24","2026-10-29","2026-10-30"] and s["2026-10-30"]["zhuyansen/new-term-radar"]==1959 and s["2026-10-30"]["a/b"]==5, s
' "$T/stars.json" 2>/dev/null && g "collect：週增星從 ≥ 5 天前、有這個 repo 的快照算（換算 7 天；0 不當基準），今天的快照併回去" || b "星數快照算錯" "$out"

# run.sh：假 claude／假 gh 照環境變數決定行為
TS="$T/ts"; mkdir -p "$TS/bin"
cat > "$TS/bin/claude" <<'SH'
#!/bin/bash
sum=$(printf '%s\n' "$2" | sed -n 's/^summary.json：//p')
case "$FAKE" in
  ok) echo '{"week":"W","report":"r.md","worth":2,"ready":["https://github.com/o/r/pull/1","https://github.com/o/r/pull/2","https://github.com/o/r/pull/4","https://github.com/o/r/pull/5","https://github.com/evil/x/pull/1"],"pending":["https://github.com/o/r/pull/3"],"project_tips":1,"analyzed":["a/b","C/D"]}' > "$sum" ;;
  slow) ( sleep 300 & echo $! > "$TSDIR/child.pid"; wait ) ; exit 0 ;;
  err) echo '{"error":"clone 失敗 a b"}' > "$sum" ;;
  quota) echo "Claude usage limit reached"; exit 1 ;;
  ratelimit-text) echo "分析：這個 repo 是 rate limit 函式庫"; exit 3 ;;
esac
SH
cat > "$TS/bin/gh" <<'SH'
#!/bin/bash
echo "gh $*" >> "$GHLOG"
case "$1 $2" in
  "pr list") echo '[]' ;;
  "pr view") case "$*" in
      *body*) case "$3" in *pull/5) echo "沒有標記" ;; *) printf 'x\ntrend-scout:2026-W44\n' ;; esac ;;
      *state*) grep -q "pr merge $3 " "$GHLOG" && echo MERGED || echo OPEN ;;
    esac ;;
  "api --paginate") case "$3" in
      */pulls/1/files) echo trend-scout/collect.py; echo tests/fixtures/trend-scout/a.json ;;
      */pulls/2/files) echo home/claude/AGENTS.md ;;
      */pulls/4/files) echo ship/notes.md; echo ship/SKILL.md ;;
      *) echo x/y.py ;;
    esac ;;
esac
SH
chmod +x "$TS/bin/claude" "$TS/bin/gh"
ts(){ FAKE=$1 TSDIR="$TS" TREND_SCOUT_REPO=o/r GHLOG="$TS/gh.log" TREND_SCOUT_STATE="$TS/st" TREND_SCOUT_LOGS="$TS/log" TREND_SCOUT_SKILLS="$TS" TREND_SCOUT_NOTIFY_DRY=1 \
  TREND_SCOUT_CLAUDE="$TS/bin/claude" TREND_SCOUT_GH="$TS/bin/gh" TREND_SCOUT_COLLECT="${COLLECT_CMD:-python3 $S/trend-scout/collect.py --html $F/trending.html --search-json}" \
  TREND_SCOUT_WEEK=2026-W44 bash "$S/trend-scout/run.sh" 2>&1; }
out=$(ts none); rc=$?
[ "$rc" = 1 ] && [ ! -e "$TS/st/done-2026-W44" ] && printf '%s' "$out" | grep -q '沒交出 summary.json' && g "run.sh：claude 沒交 summary → 失敗通知、不寫 done" || b "沒交 summary 沒當失敗" "rc=$rc $out"
out=$(ts quota); rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q '額度被擋' && g "run.sh：額度被擋講清楚是額度" || b "額度被擋沒認出來" "rc=$rc $out"
out=$(ts ratelimit-text); rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q '沒交出 summary' && g "run.sh：輸出裡提到 rate limit 的內文不誤判成額度" || b "內文的 rate limit 被當成額度" "rc=$rc $out"
out=$(ts err); rc=$?
[ "$rc" = 1 ] && [ ! -e "$TS/st/done-2026-W44" ] && printf '%s' "$out" | grep -q 'clone 失敗 a b' && g "run.sh：summary 帶 error → 失敗、不寫 done" || b "summary 的 error 沒當失敗" "rc=$rc $out"
mkdir -p "$TS/st/lock"; echo $$ > "$TS/st/lock/pid"; echo 'Thu Jan  1 00:00:00 2026' > "$TS/st/lock/start"   # pid 活著但啟動時間對不上（重開機後被重用）：殘留的鎖
: > "$TS/gh.log"; out=$(ts ok); rc=$?
[ "$rc" = 0 ] && [ -e "$TS/st/done-2026-W44" ] && grep -q '"c/d": "20' "$TS/st/seen.json" && printf '%s' "$out" | grep -q '收回殘留的鎖' \
  && g "run.sh：成功 → done 記號、seen 記日期；pid 被重用的殘留鎖會收回" || b "成功那次不對" "rc=$rc $out"
[ "$(grep -c 'pr merge' "$TS/gh.log")" = 1 ] && grep -q 'pr merge https://github.com/o/r/pull/1 ' "$TS/gh.log" \
  && printf '%s' "$out" | grep -q '合了 1、等你核准 5 個' \
  && g "run.sh：只合審查過、這個 repo、帶本週標記、不碰 home／SKILL.md 的；別的 repo、pending 都不合" || b "合併守門不對" "$(cat "$TS/gh.log") $out"
out=$(ts none); rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q '已經做完' && g "run.sh：這週做完過就跳過（補跑不重複）" || b "做完過沒跳過" "rc=$rc $out"
rm -f "$TS/st/done-2026-W44"; out=$(TREND_SCOUT_TIMEOUT=2 ts slow); rc=$?
sleep 1; cpid=$(cat "$TS/child.pid" 2>/dev/null)
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q '分鐘被砍' && [ -n "$cpid" ] && ! kill -0 "$cpid" 2>/dev/null \
  && g "run.sh：逾時整個程序群組砍掉（claude 開的子程序不留孤兒）" || { b "逾時沒砍乾淨" "rc=$rc child=$cpid $out"; [ -n "$cpid" ] && kill "$cpid" 2>/dev/null; }
printf '#!/bin/bash\necho "[]"\n' > "$TS/bin/collect0"; chmod +x "$TS/bin/collect0"
rm -f "$TS/st/done-2026-W44"; out=$(COLLECT_CMD="$TS/bin/collect0" ts ok); rc=$?
[ "$rc" = 0 ] && [ -e "$TS/st/done-2026-W44" ] && printf '%s' "$out" | grep -q '沒有新候選' && ! printf '%s' "$out" | grep -q '完成：' \
  && g "run.sh：0 個候選不叫 claude、記成做完" || b "0 個候選還是叫了 claude" "rc=$rc $out"

fi

printf '\n  %s 過 · %s 失敗\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
