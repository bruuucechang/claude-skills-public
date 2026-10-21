# 派工給 worker

`worker` 的第二階段。接機看 [enlist.md](enlist.md)，盯它看 [watch.md](watch.md)。

三種派法，選錯了會很痛：

| 要派的東西 | 用哪種 | 往下看哪一節 |
|---|---|---|
| 一件會跑完的事（解資料、轉檔、爬） | **headless `claude -p`** | A |
| 要跑很久、可能要回去看的互動工作 | **tmux 裡開一個 claude** | B |
| 長期在那台上跑的服務 | **部署包 + Docker** | C |

---

## A. headless `claude -p`：四個坑，每個都踩過

> **先用 `fleet.py dispatch`**（見 [SKILL.md](SKILL.md) 的 fleet.py 一節）：下面四個坑它都處理了
> （Windows 走 S4U 排程不靠連線、提示詞從檔案餵且三個 encoding 都設、自動加「沒有下一輪」須知、
> 輸出用 UTF-8 寫、最後一行 DONE／FAIL）。先 `--dry-run` 看它會跑什麼。這一節留著是為了
> 它不夠用、要手寫的時候知道在躲什麼。

2026-08-12 在 BRUCEVICTUS 上解 Palworld 資料時全部踩過一次。

### A1. SSH 連線斷掉，遠端的程序會跟著死

`Start-Process ... -WindowStyle Hidden` 起的程序，在 SSH session 結束時會被一起帶走——
**試了兩次都是「回報 PID 之後就靜靜死掉，輸出檔 0 bytes」**。

做法：**用背景的 ssh，在前景跑那支腳本，連線活著它就活著。**
在這台的 Claude Code 裡就是 `run_in_background: true` 的 Bash 呼叫。

### A2. 多行提示詞不能當參數傳

`Start-Process -ArgumentList` 會把換行拆掉，**claude 直接死掉且不留任何訊息**。
改成從檔案餵：

```powershell
$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [Text.UTF8Encoding]::new()
Get-Content C:\Users\user\brief.md -Raw -Encoding UTF8 | claude -p
```

**三個 encoding 都要設**，少一個中文提示詞就變亂碼。提示詞檔在**這台**寫好再 `scp`
過去，不要在對面用 `>` 生（那會產生 UTF-16，見 A4）。

### A3. headless 沒有下一輪，所以它不能「等」

第一次派工它做到一半說「等背景重建完成，完成後我會自動繼續」然後就結束回合了——
**那個「自動繼續」在 `-p` 模式下不存在。**

所以簡報（brief）裡要明講：

```
你在一台遠端機器上以 headless 模式執行。
沒有人可以回答你的問題，也沒有下一輪對話。
需要什麼就同步跑完，不要說「稍後繼續」。
做完把結果寫進 <指定路徑>，並在最後一行印 DONE。
```

最後那行是給監看用的（見 watch.md）。

### A4. 輸出不要用 PowerShell 的 `>` 產生

`repak list ... > x.txt` 產生的 185,003 行清單**整份是 UTF-16**，用 bash 工具讀
會看到字元中間夾 null。要嘛用 bash 的重導向，要嘛
`[IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($false)))`。

（`Out-File -Encoding utf8` 在 PowerShell 5.1 一定帶 BOM——grep 讀得到，
但**那個檔要是給 bash 執行的腳本就會炸**：`$'\357\273\277set': command not found`。）

### 拉結果回來

**大檔／大量輸出不要用 `ssh ... Get-Content` 拉**，會卡到逾時。用 `scp`，
而且 Windows 那端的路徑要寫 `user@host:D:/path`——`/d/path` 那種 git-bash 寫法 `scp` 不認。

---

## B. tmux 裡開一個 claude（mac worker）

```bash
ssh pro -t 'tmux new -A -s main'
```

`-A` 是「有就接上、沒有就開」，所以這道指令永遠安全，不會開出第二個。
斷線之後工作還在，再打同一道就回到現場。

**Windows 那台沒有 tmux。** 它的對應做法是：

- 要在**桌面 session** 執行（開視窗、動 GUI）→ 用排程工作，見下一節。
- 只是要它跑久一點 → 用背景的 ssh 撐著連線（A1），或直接在那台的桌面上
  開一個 Claude Code，然後用檔案跟它溝通（`scp` 一份 `task.md` 進它的工作目錄，
  在它的輸入框打一行全小寫的
  `read task.md in this folder and do everything it says`——
  那行每個字元都不需要 Shift，繞得過遠端桌面不傳 Shift 的限制）。

### Windows：要碰到桌面就得走排程工作

**SSH 進去是 session 0，桌面是 session 1，兩者隔離**，`SetWindowPos` 之類的呼叫
會回 `False`（不是權限問題，重試沒用）。

```powershell
schtasks /create /tn t1 /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\x.ps1" /sc once /st 00:00 /ru user /it /f
schtasks /run /tn t1
```

`/ru user /it` 是關鍵，`/it` 才會跑在互動 session。**腳本要自己寫 log 檔**
（排程工作的 stdout 沒地方去），而且**寫成純 ASCII**——無 BOM 的 UTF-8 檔案裡
有中文，PowerShell 5.1 會用 big5 去讀、把引號吃掉，症狀是**離開碼 1、log 檔連建都沒建**。

**用完 `schtasks /delete /tn t1 /f`。**

---

## C. 把服務丟過去跑

做法是**部署包**：在專案裡開一個 `remote/` 目錄，裝 README、`docker-compose.yml`、
建置腳本，整包 `scp` 過去。`trip-atlas/remote/` 就是這樣（三個吃資源的服務要跑在
M5 Pro 上，因為這台 Air 的 16 GB 建不出日本的 OTP 圖）。

四件一開始就要決定的事：

1. **資源夠不夠**——先量。trip-atlas 那三個服務要 5–10 GB／50–80 GB／10–20 GB 磁碟，
   這種數字要寫進部署包的 README，不要讓下一次重新估。
2. **埠位**——寫進部署包，並回填到專案的 `.env`（`TILES_URL` 那類）。
   **留空要是「正常的降級狀態」而不是壞掉**：trip-atlas 沒設就用公開 Nominatim、
   規劃器改直線距離並標 `routed=false`。
3. **不要對外開埠。** 那些服務沒有認證、只有唯讀資料，只在信任的區網／tailnet 跑。
4. **`proj` 那筆要設 `stop` 與 `detached`**（Docker 專案）——殺掉 `docker compose up`
   那個程序不會停掉容器；沒設 `detached` 的話容器明明在跑，`proj` 卻因為找不到 pid 檔
   而顯示「外部佔用」且拒絕停止。

Windows worker 上的資料庫也是這條路：那台**主機上沒有 `psql`／`createdb`**，
PostgreSQL 是跑在容器裡的（見 `newproj` 的 windows.md）。

---

## 派出去之前的最後檢查

- 提示詞／輸入檔是**在這台寫好再傳過去**的嗎（不是在對面用 `>` 生的）？
- brief 裡講清楚「沒有下一輪」了嗎？
- 結果要寫到哪裡、怎麼判斷做完了（`DONE` 那類標記）講了嗎？
- 你知道**怎麼盯**它嗎（watch.md）？不知道就先別派。
