---
description: 啟動專案並在背景開頁面。取代「run the project／run project X」。用法：/up [專案名，可簡寫]
argument-hint: "[專案名]"
---

把專案跑起來給使用者看：$ARGUMENTS

1. 決定專案：有參數就用參數（`proj` 接受簡寫）；沒有就用目前所在 repo 的目錄名。
   不在 `proj status` 清單上的專案，照該 repo `CLAUDE.md`／`AGENTS.md` 寫的啟動方式，用 `run_in_background` 跑，不要前景空等。
2. `proj start <name>`（它會等到就緒才回來）。失敗就 `proj logs <name> | tail -40` 找原因、修到能起來；修不了才回報。
3. `proj open <name>`——在背景開，不切走使用者正在看的分頁、不開新視窗。
4. 用 `curl -s -o /dev/null -w '%{http_code}'` 打一次首頁與主要 API 確認不是空白頁或 5xx。
5. 回報一行：網址、埠、哪個程序、log 指令。不要問「要不要開」——開就對了。
