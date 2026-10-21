---
description: 彙報目前進度：在跑的背景任務、各 repo 未 commit／未 push、交接單、下一步。取代「目前狀態／進度／現在在跑什麼」。
---

彙報**這個 session** 目前的狀態，一次講完，不要問問題、不要開新工作。$ARGUMENTS

只用唯讀的方式查（不 fetch、不叫模型、不開瀏覽器）：

1. **在跑什麼**：這個 session 啟動的背景任務（Bash 背景工作、Monitor、subagent、workflow）各自的狀態；
   有 PID 的用 `ps -p <pid> -o pid,etime,command` 確認真的活著——沉默不等於還在跑。
2. **repo 狀態**：這個 session 動過的每個 repo 跑 `git status --short | head` 與 `git status -sb | head -1`，
   分清楚哪些未 commit 的改動是我的、哪些是別的 session 的。
3. **規格與交接**：若有規格檔或交接單，列出路徑與裡面還沒做完的項目。
4. **下一步**：還沒完成的事，按順序列，標出哪些卡在等使用者決定。

格式：先一行總結（例如「3 件做完、1 件在跑、1 件等你決定」），再用短表格或清單。
繁體中文。如果有要使用者決定的事，最後用 AskUserQuestion 給選項。
