#!/usr/bin/env bash
#
# spend.sh — 四台機器近 N 天的 token 花費，依專案分帳。
#
#   bash ~/.claude/skills/home/claude/tools/spend.sh [天數，預設 30]
#
# 做三件事：本機跑一次 spend.mjs、把同一支腳本送到三台遠端跑、把四份 JSON
# 合成報告。輸出目錄印在最後，JSON 留著可以重算不用重掃。
#
# ## 為什麼是「送腳本過去用 node 跑」而不是 ssh 帶一行式
#
# 一行式量錯過兩次，而且都是**安靜地回一個看起來合理的數字**（見 memory 的
# cross-machine-stats）。PowerShell 的引號逃逸在 ssh 底下尤其難搞，而
# parse 失敗跟「查無資料」在輸出上長得一模一樣。node 四台都有。
#
# ## 口徑
#
# 一輪的花費＝ input + output + cache_read + cache_creation，四項都要。
# **漏掉 cache read 會差 80 倍**——它佔 token 的 98.3%、佔成本的 77.7%。
# 2026-09-25 的交接單就是漏了這一項，把 89.9B 寫成 1,120.6M。
#
# ## 分帳
#
# 優先用每則訊息的 cwd；cwd 分不出來的（從家目錄開的 session）用「這個
# session 裡提到最多次的專案路徑」回推，門檻 5 次。實測未歸屬可以壓到 1.5%。
# how=mentions 的那些帶這個啟發式的不確定性，不要當成精確分帳。

set -uo pipefail

DAYS="${1:-30}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${TMPDIR:-/tmp}/spend-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

echo "本機掃描中（近 ${DAYS} 天）…"
node "$HERE/spend.mjs" "$DAYS" > "$OUT/air.json" 2> "$OUT/air.err" \
  || { echo "!! 本機失敗："; cat "$OUT/air.err"; }

# 遠端三台同時跑。Victus 的 transcript 有 8 GB 級，比另外兩台久得多。
for h in pro:pro victus:victus desk:desk; do
  host="${h%%:*}"; name="${h##*:}"
  (
    scp -q "$HERE/spend.mjs" "${host}:spend.mjs" 2>"$OUT/${name}.err" \
      && ssh -o ConnectTimeout=15 "$host" "node spend.mjs ${DAYS}" \
         > "$OUT/${name}.json" 2>>"$OUT/${name}.err"
    echo "${name} exit=$?" >> "$OUT/status"
  ) &
done
echo "三台遠端跑著（Victus 最久，8 GB 級的 transcript）…"
wait

echo
cat "$OUT/status" 2>/dev/null
for f in "$OUT"/*.err; do [ -s "$f" ] && { echo "--- $(basename "$f") ---"; head -c 400 "$f"; }; done
echo

node "$HERE/spend-report.mjs" "$OUT"

echo
# ⚠️ 一定要寫 ${OUT} 不能寫 $OUT：後面接的是全形括號，bash 會把它當成變數名的
# 一部分吃進去，配上 set -u 就是 "OUT（: unbound variable"。2026-09-26 踩到。
echo "JSON 留在 ${OUT}（重算報告不用重掃：node ${HERE}/spend-report.mjs ${OUT}）"
