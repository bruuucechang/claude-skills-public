#!/usr/bin/env bash
#
# trend-scout/run.sh — 每週熱門 repo 偵查（規格 home/claude/docs/2026-10-30-trend-scout/spec.md）
#
#   bash ~/.claude/skills/trend-scout/run.sh [--dry-run] [--force]
#
# launchd 每天 09:30 叫一次；這一週（ISO 週）做完過就直接退出，所以週一做成了其他天都是空跑，
# 週一失敗（沒網路、被額度擋、闔著蓋子）隔天自動補。
# --dry-run：收集＋篩選＋深入＋週報草稿，不開 PR、不推、不通知、不寫 done 記號。
# --force：這週做過也再跑。
#
# 測試用的環境變數：TREND_SCOUT_STATE／_LOGS／_CLAUDE（假 claude）／_COLLECT（假收集）／
# _NOTIFY_DRY=1（通知只印）／_WEEK（指定週）／_TIMEOUT（秒）／_GH（假 gh）。
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SKILLS=${TREND_SCOUT_SKILLS:-$HOME/.claude/skills}
STATE=${TREND_SCOUT_STATE:-$HOME/.claude/state/trend-scout}
LOGS=${TREND_SCOUT_LOGS:-$HOME/.claude/logs}
CLAUDE=${TREND_SCOUT_CLAUDE:-claude}
COLLECT=${TREND_SCOUT_COLLECT:-python3 $HERE/collect.py}
WEEK=${TREND_SCOUT_WEEK:-$(date +%G-W%V)}
TIMEOUT=${TREND_SCOUT_TIMEOUT:-10800}
GH=${TREND_SCOUT_GH:-gh}
REPO=${TREND_SCOUT_REPO:-bruuucechang/claude-skills}
# 這些路徑每個 session 都會載入或執行（全域規則、hook、設定、各 skill 的規則檔、安裝腳本、測試、本支守門）：
# 動到就不自動合，留給使用者。這是機制，不靠 SKILL.md 的提示詞（審查 PR #78）
PROTECTED='(^home/|^githooks/|^\.github/|(^|/)hooks/|(^|/)install[^/]*\.sh$|(^|/)bootstrap\.sh$|^export-public\.sh$|^\.gitignore$|^tests/run\.sh$|^trend-scout/run\.sh$|^(agents|commands|rules)/|(^|/)(SKILL|AGENTS|CLAUDE)\.md$)'
MAX_FILES=60

DRY=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    *) echo "用法：run.sh [--dry-run] [--force]" >&2; exit 64 ;;
  esac
done

mkdir -p "$STATE" "$LOGS"
LOG="$LOGS/trend-scout-$(date +%F).log"
RUN="$STATE/runs/$WEEK"; mkdir -p "$RUN"
say(){ printf '%s %s\n' "$(date +%T)" "$*" | tee -a "$LOG" >&2; }

notify(){  # 標題 內文
  if [ "$DRY" = 1 ] || [ "${TREND_SCOUT_NOTIFY_DRY:-}" = 1 ]; then say "通知（只印）：$1 — $2"; return; fi
  osascript -e 'on run a' -e 'display notification (item 2 of a) with title (item 1 of a)' -e 'end run' "$1" "$2" >/dev/null 2>&1 || true
  python3 -c 'import json,sys; print(json.dumps({"title":sys.argv[1],"body":sys.argv[2],"thread":"trend-scout"}))' "$1" "$2" |
    curl -s -m 10 -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:5391/notify >/dev/null 2>&1 \
    || say "手機推播失敗（session-remote 沒開？）"
}
fail(){ say "失敗：$1"; notify "熱門 repo 偵查失敗" "$1；log：$LOG"; exit 1; }

if [ "$DRY" = 0 ] && [ "$FORCE" = 0 ] && [ -e "$STATE/done-$WEEK" ]; then
  say "$WEEK 已經做完（$STATE/done-${WEEK}），跳過"; exit 0
fi

# 同一時間只准一支（launchd 補跑＋手動同時跑會開兩份 PR）。鎖記 pid＋那個程序的啟動時間：
# 兩個都對得上才算佔著（重開機後 pid 會被別的程序重用；比對指令字串會被同名腳本騙）
LOCK="$STATE/lock"
started(){ ps -o lstart= -p "$1" 2>/dev/null | tr -s ' '; }
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$LOCK/pid" 2>/dev/null); oldst=$(cat "$LOCK/start" 2>/dev/null)
  if [ -z "$old" ] && [ -n "$(find "$LOCK" -maxdepth 0 -newermt '-60 seconds' 2>/dev/null)" ]; then
    say "另一支剛拿到鎖，退出"; exit 0
  fi
  if [ -n "$old" ] && [ -n "$oldst" ] && [ "$(started "$old")" = "$oldst" ]; then
    say "已經有一支在跑（pid ${old}），退出"; exit 0
  fi
  say "收回殘留的鎖（pid ${old:-空}）"
  rm -rf "$LOCK"; mkdir "$LOCK" || fail "拿不到鎖 $LOCK"
fi
started $$ > "$LOCK/start"; echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

say "開始 ${WEEK}（dry=${DRY}）"
$COLLECT --seen "$STATE/seen.json" > "$RUN/candidates.json" 2>>"$LOG" || fail "收集候選失敗"
n=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$RUN/candidates.json" 2>/dev/null) || fail "候選 JSON 讀不懂"
say "候選 $n 個"
if [ "$n" = 0 ]; then
  say "沒有新候選，不叫 claude"
  [ "$DRY" = 0 ] && { touch "$STATE/done-$WEEK"; notify "本週熱門 repo（${WEEK}）" "沒有新候選（都看過了）"; }
  exit 0
fi

# 重跑要冪等：上次失敗前可能已經開了 PR、推了週報。PR 內文帶 `trend-scout:<週>`，把這週已有的交給 claude 接著做
rm -f "$RUN/summary.json"; rm -rf "$RUN/clones"
$GH pr list --repo "$REPO" --state all --search "\"trend-scout:$WEEK\" in:body" --json url,state,title,headRefName \
  > "$RUN/existing-prs.json" 2>>"$LOG" || echo '[]' > "$RUN/existing-prs.json"
mode=$([ "$DRY" = 1 ] && echo "dry-run（第 4 步只寫計畫、週報寫到 $RUN/report-draft.md、不推）" || echo "正式")
PROMPT="照 $HERE/SKILL.md 做第 2～6 步（無人值守，不准問問題）。
週：$WEEK
模式：$mode
候選：$RUN/candidates.json
這週已經開過的 PR（重跑時接著做，不要重開）：$RUN/existing-prs.json
clones 目錄：$RUN/clones
PR worktree 目錄：$RUN/wt
週報草稿路徑（dry-run 用）：$RUN/report-draft.md
summary.json：$RUN/summary.json
skills 的共用 checkout（只讀，不准在這裡改檔）：$SKILLS"

# 權限照 settings.json 的 defaultMode（auto）：不給 bypass，被分析的 repo 是不可信的內容
# macOS 沒有 timeout：claude 開在自己的程序群組，逾時（或這支被中斷）整群砍掉，
# 不留 git clone／gh／審查子代理這些孤兒；逾時結束碼 142
( cd "$SKILLS" && perl -e '
    my $t = shift; my $p = fork // die "fork: $!";
    if (!$p) { setpgrp(0, 0); exec @ARGV or die "exec: $!" }
    my $kill = sub { kill "TERM", -$p; sleep 5; kill "KILL", -$p };
    $SIG{ALRM} = sub { $kill->(); exit 142 };
    $SIG{INT} = $SIG{TERM} = $SIG{HUP} = sub { $kill->(); exit 130 };
    alarm $t; waitpid($p, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
  ' "$TIMEOUT" $CLAUDE -p "$PROMPT" ) >"$RUN/claude.out" 2>&1
rc=$?
cat "$RUN/claude.out" >>"$LOG"
cleanup_wt(){ for w in "$RUN"/wt/*/; do [ -d "$w" ] && git -C "$SKILLS" worktree remove --force "$w" >>"$LOG" 2>&1; done
  git -C "$SKILLS" worktree prune 2>/dev/null; rm -rf "$RUN/clones"; true; }
if [ ! -s "$RUN/summary.json" ]; then
  cleanup_wt
  [ "$rc" = 142 ] && fail "超過 $((TIMEOUT / 60)) 分鐘被砍"
  # 只看這次 claude 自己的輸出（共用 log 裡有分析內文，會誤判）
  if [ "$rc" != 0 ] && grep -qiE 'usage limit|limit reached|reset at|rate_limit_error' "$RUN/claude.out"; then
    fail "Claude 額度被擋（claude 結束碼 ${rc}），明天 09:30 再試"
  fi
  fail "claude 沒交出 summary.json（結束碼 ${rc}）"
fi

out=$(python3 - "$RUN/summary.json" "$STATE/seen.json" "$DRY" <<'PY'
import datetime, json, sys
s = json.load(open(sys.argv[1]))
if sys.argv[3] == "0" and not s.get("error"):
    try:
        seen = json.load(open(sys.argv[2]))
        seen = dict.fromkeys(seen, datetime.date.today().isoformat()) if isinstance(seen, list) else dict(seen)
    except Exception:
        seen = {}
    today = datetime.date.today().isoformat()
    seen = {k.lower(): v for k, v in seen.items()}
    seen.update({k.lower(): today for k in s.get("analyzed", [])})
    json.dump(seen, open(sys.argv[2], "w"), indent=0, sort_keys=True)
print(" ".join(str(s.get("error") or "").split()))
print(" ".join(s.get("ready", [])) or "-")
print(" ".join(s.get("pending", [])) or "-")
print(s.get("worth", 0), s.get("project_tips", 0), s.get("report", "-"))
PY
) || { cleanup_wt; fail "summary.json 讀不懂"; }
err=$(printf '%s\n' "$out" | sed -n 1p)
ready=$(printf '%s\n' "$out" | sed -n 2p); [ "$ready" = - ] && ready=""
pending=$(printf '%s\n' "$out" | sed -n 3p); [ "$pending" = - ] && pending=""
read -r worth tips report <<<"$(printf '%s\n' "$out" | sed -n 4p)"
cleanup_wt
[ -n "$err" ] && fail "claude 回報錯誤：$err"

# 合併由這裡做：claude 只交「審查過了」的 PR。網址要是這個 repo、內文要帶這週的標記、
# 檔數不超過 MAX_FILES、改名的新舊路徑都不碰 PROTECTED，才合；其餘留給使用者
merged=0
for u in $ready; do
  [ "$DRY" = 1 ] && break
  num=$(printf '%s' "$u" | sed -nE "s#^https://github\.com/$REPO/pull/([0-9]+)\$#\1#p")
  if [ -z "$num" ]; then say "不是 $REPO 的 PR，不合：$u"; pending="$pending $u"; continue; fi
  if ! $GH pr view "$u" --json body -q .body 2>>"$LOG" | grep -qF "trend-scout:$WEEK"; then
    say "$u 內文沒有 trend-scout:${WEEK}，不合"; pending="$pending $u"; continue
  fi
  files=$($GH api --paginate "repos/$REPO/pulls/$num/files" -q '.[] | .filename, (.previous_filename // empty)' 2>>"$LOG") \
    || { say "讀不到 $u 的檔案清單，留著"; pending="$pending $u"; continue; }
  nf=$(printf '%s\n' "$files" | grep -c .)
  hit=$(printf '%s\n' "$files" | grep -E "$PROTECTED" | sort -u | tr '\n' ' ')
  if [ "$nf" -eq 0 ] || [ "$nf" -gt "$MAX_FILES" ] || [ -n "$hit" ]; then
    why=${hit:+動到規則／守衛／安裝腳本／測試：$hit}; why=${why:-檔數 $nf 不在 1～$MAX_FILES}
    say "$u 留給使用者：$why"
    $GH pr comment "$u" --body "trend-scout：${why}，不自動合，等使用者核准。" >>"$LOG" 2>&1
    pending="$pending $u"; continue
  fi
  $GH pr merge "$u" --squash --delete-branch >>"$LOG" 2>&1
  if [ "$($GH pr view "$u" --json state -q .state 2>/dev/null)" = MERGED ]; then merged=$((merged + 1)); say "已合 $u"
  else say "合不進去 ${u}，留著"; pending="$pending $u"; fi
done
npend=$(printf '%s\n' $pending | grep -c . || true)

msg="值得看 $worth 個、合了 ${merged}、等你核准 $npend 個 PR、專案建議 $tips 則；週報 $report"
say "完成：$msg"
if [ "$DRY" = 0 ]; then
  touch "$STATE/done-$WEEK"
  notify "本週熱門 repo（${WEEK}）" "$msg"
fi
