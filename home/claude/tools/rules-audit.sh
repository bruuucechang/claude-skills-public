#!/bin/bash
# 規則健檢：把「規則有沒有腐爛」寫成可以跑的檢查，而不是一個模糊的打算。
#
# 由 ~/Library/LaunchAgents/com.bruce.rules-audit.plist 每季觸發（1/4/7/10 月 1 日），
# 也可以隨時手動跑：bash ~/.claude/skills/home/claude/tools/rules-audit.sh
#
# 檢查的每一項都對應 2026-09-07 那份調查裡的一條共識，見
# ~/.claude/projects/<家目錄消毒後的名字>/memory/claude-md-context-mechanics.md

set -uo pipefail
CLAUDE_HOME="$HOME/.claude/skills/home/claude"
MEM="$HOME/.claude/projects/-$(printf %s "${HOME#/}" | tr / -)/memory"
PROJ="$HOME/Projects"
LIMIT=200
issues=0

say() { printf '%s\n' "$*"; }
bad() { issues=$((issues+1)); printf '  ✗ %s\n' "$*"; }
ok()  { printf '  ✓ %s\n' "$*"; }

# ── @ 匯入檢查（第 6 節；也能單獨跑：rules-audit.sh --imports 檔案...）─────
# Claude Code 讀到 `@路徑` 會把那個檔整份匯入；指到不存在的檔是**安靜的**——
# 不報錯、只是那份規則沒載入。判準抄自 caveman 的 detect_memory_health.go：
# 跳過 code span 與程式碼區塊；只把 ./ ../ ~/ / 開頭或帶副檔名的當路徑；
# @ 前面要是行首或空白（排除 email），排除 //host。順著匯入往下追，最多 5 層。
check_imports() {
  python3 - "$@" <<'PYIMP'
import os, re, sys
EXT = re.compile(r'\.(md|mdx|txt|json|jsonc|ya?ml|toml|sh|py|mjs|js|ts)$')
TOK = re.compile(r'(?:^|(?<=\s))@([^\s`，。；：、（）「」]+)')
seen, bad, n = {}, 0, 0   # realpath -> 走到過的最淺深度
def refs(path):
    fence = False
    for no, line in enumerate(open(path, encoding='utf-8', errors='replace'), 1):
        if line.lstrip().startswith(('```', '~~~')):
            fence = not fence; continue
        if fence: continue
        line = re.sub(r'`[^`]*`', '', line)
        for m in TOK.finditer(line):
            t = m.group(1).rstrip('.,;:!?)]}」）』，。；：')
            if not t or t.startswith('//') or '@' in t: continue
            if not (t.startswith(('./', '../', '~/', '/')) or EXT.search(t)): continue
            yield no, t
short = lambda p: p.replace(os.path.expanduser('~'), '~')
# 先 BFS 求每個檔的最淺深度、再統一判斷：邊走邊報的話「超過 5 層」會看走訪順序
# （同一個檔先從深的路線走到、其實還有淺的路線，Claude Code 照樣載得到）
from collections import deque
q, edges = deque(), {}
def push(path, depth):
    real = os.path.realpath(path)
    if real in seen: return
    seen[real] = depth
    q.append((path, real, depth))
for f in sys.argv[1:]:
    if os.path.isfile(f): push(f, 0)
    elif os.environ.get('IMPORTS_STRICT'):   # --imports 明講的檔不見要出聲；整體健檢掃到的清單本來就是有才列
        bad += 1
        print(f'  ✗ {short(f)} {"是資料夾不是檔" if os.path.isdir(f) else "不存在"}')
while q:
    path, real, depth = q.popleft()
    edges[real] = []
    for no, t in refs(path):
        n += 1
        target = os.path.normpath(os.path.expanduser(t) if t.startswith('~/') else os.path.join(os.path.dirname(path), t))
        edges[real].append((path, no, t, target))
        if os.path.isfile(target): push(target, depth + 1)
for real, es in edges.items():
    for path, no, t, target in es:
        why = None
        if os.path.isdir(target): why = '指向資料夾不是檔'
        elif not os.path.isfile(target): why = '指向不存在的檔'
        elif seen[real] + 1 > 5: why = '超過 5 層，Claude Code 不會載入'
        if why:
            bad += 1
            print(f'  ✗ {short(path)}:{no}　@{t} {why}（這份規則安靜地沒載入）')
print(f'IMPORTS {len(seen)} {n} {bad}')
PYIMP
}

if [ "${1-}" = "--imports" ]; then
  shift
  out=$(IMPORTS_STRICT=1 check_imports "$@")
  printf '%s\n' "$out" | grep -v '^IMPORTS '
  read -r _ files refs nbad <<<"$(printf '%s\n' "$out" | grep '^IMPORTS ')"
  [ -z "${nbad-}" ] && { echo "  ✗ 檢查本身沒跑完（python 崩潰？），結果不可信"; exit 2; }
  [ "${files:-0}" -eq 0 ] && { echo "  ✗ 一個檔都沒讀到——路徑八成壞了"; exit 2; }
  [ "$nbad" -eq 0 ] && echo "  ✓ ${files} 個檔、${refs} 個 @ 匯入都找得到"
  [ "$nbad" -eq 0 ]; exit
fi

say "# 規則健檢　$(date '+%Y-%m-%d %H:%M')"
say ""

# ── 1. 指令檔篇幅（官方目標 200 行）──────────────────────────
say "## 1. 指令檔篇幅（官方目標 ${LIMIT} 行）"
seen=0
while IFS= read -r d; do
  r=$(basename "$d")
  for f in AGENTS.md CLAUDE.md; do
    [ -f "$d/$f" ] || continue
    seen=$((seen+1))
    n=$(wc -l < "$d/$f" | tr -d ' ')
    [ "$n" -gt "$LIMIT" ] && bad "${r}/${f}　${n} 行（超出 $((n-LIMIT))）"
  done
done < <(find "$PROJ" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) | sort)
for f in "$CLAUDE_HOME/AGENTS.md" "$CLAUDE_HOME/CLAUDE.md"; do
  [ -f "$f" ] || continue
  n=$(wc -l < "$f" | tr -d ' ')
  [ "$n" -gt "$LIMIT" ] && bad "全域 $(basename "$f")　$n 行"
done
# 沉默不等於成功：掃到 0 個檔一定是路徑壞了，不是「全部通過」
if [ "$seen" -lt 5 ]; then
  bad "只掃到 ${seen} 個指令檔——路徑八成壞了，這一節的結果不可信"
elif [ "$issues" -eq 0 ]; then
  ok "掃了 ${seen} 個指令檔，全部在 ${LIMIT} 行以內"
fi
say ""

# ── 2. 跨工具橋接：有 CLAUDE.md 就該有 AGENTS.md ────────────
say "## 2. 跨工具橋接（Codex 讀 AGENTS.md，不讀 CLAUDE.md）"
n2=0
while IFS= read -r d; do
  r=$(basename "$d")
  # 是 repo 但兩個規則檔都沒有 —— 先前的寫法只看「有 CLAUDE.md 卻沒 AGENTS.md」，
  # 所以「兩個都沒有」的專案會整個從縫裡漏掉（siri-claude 就是這樣漏了）。
  if [ -d "$d/.git" ] && [ ! -f "$d/CLAUDE.md" ] && [ ! -f "$d/AGENTS.md" ]; then
    bad "${r} 兩個規則檔都沒有 —— Claude 與 Codex 都拿不到這個專案的任何規則"; n2=$((n2+1))
  elif [ -f "$d/CLAUDE.md" ] && [ ! -f "$d/AGENTS.md" ]; then
    bad "${r} 只有 CLAUDE.md，沒有 AGENTS.md —— Codex 讀不到這個專案的規則"; n2=$((n2+1))
  elif [ -f "$d/AGENTS.md" ] && [ ! -f "$d/CLAUDE.md" ]; then
    bad "${r} 只有 AGENTS.md，沒有 CLAUDE.md 橋接 —— Claude Code 讀不到"; n2=$((n2+1))
  fi
done < <(find "$PROJ" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) | sort)
[ "$n2" -eq 0 ] && ok "每個有 CLAUDE.md 的專案都有 AGENTS.md"
say ""

# ── 2b. newproj 樣板的五層還在嗎 ─────────────────────────
say "## 2b. 專案骨架（newproj 樣板的守衛）"
n2b=0
while IFS= read -r d; do
  r=$(basename "$d")
  { [ -f "$d/AGENTS.md" ] || [ -f "$d/CLAUDE.md" ]; } || continue
  [ -f "$d/project-map.json" ] || { bad "${r} 缺 project-map.json（工作分類的單一真相）"; n2b=$((n2b+1)); }
  ls "$d"/tools/doc-audit* >/dev/null 2>&1 || { bad "${r} 缺 tools/doc-audit（文件腐爛偵測）"; n2b=$((n2b+1)); }
done < <(find "$PROJ" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) | sort)
[ "$n2b" -eq 0 ] && ok "每個專案都有作業圖與文件守衛"
say ""

# ── 3. 記憶索引 ─────────────────────────────────────────
say "## 3. 記憶索引（MEMORY.md 只載入前 200 行／25 KB）"
if [ -f "$MEM/MEMORY.md" ]; then
  n=$(wc -l < "$MEM/MEMORY.md" | tr -d ' '); b=$(wc -c < "$MEM/MEMORY.md" | tr -d ' ')
  [ "$n" -gt 200 ] && bad "MEMORY.md $n 行，超過 200 行上限（超出的部分載入時直接被丟掉）" || ok "MEMORY.md $n 行 / $b bytes"
  # 斷鏈：索引指到不存在的檔
  n3=0
  while IFS= read -r f; do
    [ -f "$MEM/$f" ] || { bad "索引指向不存在的檔：$f"; n3=$((n3+1)); }
  done < <(cat "$MEM/MEMORY.md" "$MEM/INDEX.md" 2>/dev/null | grep -oE '\]\([^)]+\.md\)' | tr -d ']()' )
  # 反向：有檔但索引沒收錄
  for f in "$MEM"/*.md; do
    b=$(basename "$f"); { [ "$b" = MEMORY.md ] || [ "$b" = INDEX.md ]; } && continue
    # 2026-10-06 起索引分兩份：MEMORY.md（自動載入，只放規則）＋ INDEX.md（用 tools/mem.py 查）
    # 不能用 cat … | grep -q：pipefail 下 grep 提早結束會讓 cat 吃 SIGPIPE，排在前面的條目反而被報沒收錄
    grep -qF "($b)" "$MEM/MEMORY.md" "$MEM/INDEX.md" 2>/dev/null || { bad "記憶檔沒被索引收錄：$b"; n3=$((n3+1)); }
  done
  [ "$n3" -eq 0 ] && ok "索引與檔案雙向對得上"
  # 常駐區結構（2026-10-21）：auto memory 會把新條目附加在檔尾，等於預設進常駐區
  tail_n=$(awk '/^## 其餘/{f=1;next} f&&/^- \[/' "$MEM/MEMORY.md" | wc -l | tr -d ' ')
  [ "$tail_n" -gt 0 ] && bad "MEMORY.md 的「## 其餘」之後有 $tail_n 條記憶（被附加在檔尾＝每個 session 都載入）——搬進 INDEX.md 對應章節" \
    || ok "MEMORY.md 的「## 其餘」之後沒有條目"
  res_n=$(grep -c '^- \[' "$MEM/MEMORY.md")
  [ "$res_n" -gt 25 ] && bad "MEMORY.md 常駐 $res_n 條，超過 25 條——只留跨專案、來不及查的，其餘移到 INDEX.md" \
    || ok "MEMORY.md 常駐 $res_n 條（上限 25）"
else
  bad "找不到 MEMORY.md"
fi
say ""

# ── 4. 設定檔與強制層 ────────────────────────────────────
say "## 4. 設定檔與強制層"
if python3 -c "import json,sys;json.load(open('$CLAUDE_HOME/settings.json'))" 2>/dev/null; then
  ev=$(python3 -c "import json;d=json.load(open('$CLAUDE_HOME/settings.json'));print(len(d['hooks']))")
  hk=$(python3 -c "import json;d=json.load(open('$CLAUDE_HOME/settings.json'));print(sum(len(g['hooks']) for a in d['hooks'].values() for g in a))")
  dn=$(python3 -c "import json;d=json.load(open('$CLAUDE_HOME/settings.json'));print(len(d['permissions'].get('deny',[])))")
  ok "settings.json 可解析：$ev 個事件 / $hk 個 hook 指令 / $dn 條 deny"
  grep -q "$ev 個事件" "$MEM/settings-hooks.md" 2>/dev/null \
    || bad "settings-hooks 記憶檔講的數字可能過期了（實際 $ev 個事件、$hk 個 hook 指令）"
else
  bad "settings.json 解析失敗"
fi
say ""

# ── 4b. 架構圖的數字有沒有漂掉 ───────────────────────────
say "## 4b. ARCHITECTURE.md 的數字"
if [ -f "${CLAUDE_HOME}/ARCHITECTURE.md" ] && [ -f "${CLAUDE_HOME}/tools/mkarch.py" ]; then
  # 兩邊都用 $(...) 去掉結尾換行差異，不然每次都會誤報 1 行
  if python3 "${CLAUDE_HOME}/tools/mkarch.py" > /tmp/arch-now.raw 2>/dev/null; then
    printf '%s\n' "$(cat /tmp/arch-now.raw)" > /tmp/arch-now.md
    printf '%s\n' "$(cat "${CLAUDE_HOME}/ARCHITECTURE.md")" > /tmp/arch-have.md
    if diff -q /tmp/arch-now.md /tmp/arch-have.md >/dev/null; then
      ok "圖上的數字跟現況一致"
    else
      d=$(diff /tmp/arch-now.md /tmp/arch-have.md | grep -c '^[<>]')
      bad "架構圖過期了（${d} 行對不上）——跑 tools/mkarch.py --write 重出"
    fi
  else
    bad "mkarch.py 跑不起來，架構圖無法驗證"
  fi
else
  bad "找不到 ARCHITECTURE.md 或 tools/mkarch.py"
fi
say ""

# ── 4c. ASCII 方框有沒有歪 ───────────────────────────────
# 2026-09-16：README 的架構圖在終端機裡每行剛好 74 格，在 GitHub 上卻散開 34px。
# 「中文＝2 格」只在終端機成立 —— 瀏覽器裡中文 1.661 格、全形括號 0.872 格、
# emoji 2.076 格。判準寫進 tools/boxcheck.py，這裡只負責每季叫它一次。
say "## 4c. ASCII 方框對齊"
if [ -f "${CLAUDE_HOME}/tools/boxcheck.py" ]; then
  box_out=$(python3 "${CLAUDE_HOME}/tools/boxcheck.py" 2>&1)
  box_rc=$?
  box_sum=$(printf '%s\n' "$box_out" | grep '^boxcheck:' | head -1)
  case "$box_rc" in
    0) ok "${box_sum:-沒有框在終端機裡歪掉}" ;;
    2) bad "boxcheck 掃到 0 個檔——路徑八成壞了，這一節的結果不可信" ;;
    *) bad "${box_sum:-有方框對不齊}"
       printf '%s\n' "$box_out" | grep '^BAD ' | sed 's/^/      /' ;;
  esac
else
  bad "找不到 tools/boxcheck.py"
fi
say ""

# ── 5. 這幾個位置還是 symlink 嗎 ──────────────────────────
say "## 5. 四個位置的 symlink"
for p in "$HOME/.claude/CLAUDE.md" "$HOME/.claude/AGENTS.md" "$HOME/.claude/rules" \
         "$HOME/.claude/settings.json" "$HOME/.claude/commands" "$HOME/.codex/AGENTS.md"; do
  [ -L "$p" ] && ok "$(basename "$p") → $(readlink "$p" | sed "s|$HOME|~|")" \
              || bad "$(echo "$p" | sed "s|$HOME|~|") 不是 symlink（規則可能沒有跨工具／跨機器同步）"
done
say ""

# ── 6. @ 匯入有沒有指到不存在的檔 ─────────────────────────
say "## 6. @ 匯入（指到不存在的檔＝那份規則安靜地沒載入）"
# 全域：skills 裡的正本、每個帳號的 config dir（~/.claude-xxx/CLAUDE.md 不一定是 symlink）、rules
imp_files=("$CLAUDE_HOME/CLAUDE.md" "$CLAUDE_HOME/AGENTS.md")
for f in "$HOME"/.claude*/CLAUDE.md "$HOME"/.claude/rules/*.md; do [ -f "$f" ] && imp_files+=("$f"); done
while IFS= read -r d; do
  for f in "$d/CLAUDE.md" "$d/AGENTS.md" "$d"/.claude/rules/*.md; do [ -f "$f" ] && imp_files+=("$f"); done
done < <(find "$PROJ" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) | sort)
imp_out=$(check_imports "${imp_files[@]}")
read -r _ imp_seen imp_refs imp_bad <<<"$(printf '%s\n' "$imp_out" | grep '^IMPORTS ')"
printf '%s\n' "$imp_out" | grep -v '^IMPORTS '
issues=$((issues + ${imp_bad:-0}))
if [ -z "${imp_bad-}" ]; then
  bad "這一節的檢查沒跑完（python 崩潰？），結果不可信"
elif [ "${imp_seen:-0}" -lt 5 ]; then
  bad "只讀到 ${imp_seen:-0} 個指令檔——路徑八成壞了，這一節的結果不可信"
elif [ "${imp_bad:-0}" -eq 0 ]; then
  ok "讀了 ${imp_seen} 個檔（含被匯入的）、${imp_refs} 個 @ 匯入，全部找得到"
fi
say ""

say "---"
if [ "$issues" -eq 0 ]; then
  say "沒有發現問題。"
else
  say "**$issues 項需要處理。** 深入檢查用 /sync-docs 與 /preflight，"
  say "判準見記憶檔 claude-md-context-mechanics。"
fi
exit 0
