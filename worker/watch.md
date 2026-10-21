# 盯 worker，以及收尾

`worker` 的第三階段。接機看 [enlist.md](enlist.md)，派工看 [dispatch.md](dispatch.md)。

---

## 盯一個遠端的 Claude Code session：讀它的 transcript

**不要靠遠端桌面截圖判斷它在幹嘛。** 畫面會被別的視窗蓋住——實際發生過的是那個
session 自己把 Chrome 設成 `HWND_TOPMOST`，終端機從此永遠在後面、工作列點不回來、
遠端桌面又不轉送 Alt+Tab。**截圖從此瞎掉，但 transcript 一直在寫。**

```
mac      ~/.claude/projects/<cwd-slug>/<session-id>.jsonl
Windows  C:\Users\user\.claude\projects\<cwd-slug>\<session-id>.jsonl
```

用 `LastWriteTime`（mac 用 `ls -t`）排序找出正在跑的那一個，`-Tail 6` 就夠。

**判斷狀態看最後一筆**：

| 最後一筆 | 意思 |
|---|---|
| `assistant` 有 `tool_use`，久久沒有對應的 `tool_result` | **卡在待批准** |
| `assistant` 只有 `text` | 它停下來了，在等使用者 |
| `user` 有 `tool_result` | 正在跑 |

用「**超過 100 秒沒動**」當門檻去輪詢，比每隔幾秒截圖便宜也準。要按東西的時候
再切回遠端桌面。

**編碼**：從 SSH 抓回來的中文會是亂碼（主控台碼頁），**判斷狀態不要靠中文字串**，
看 JSON 的欄位名。

## 盯一件 headless 工作

它不會回報進度，所以在派出去的時候就要約好訊號（dispatch.md 的 brief 那段）：

```bash
# 輸出檔有沒有長大 / 有沒有出現約好的結尾標記
until ssh <host> 'findstr /c:"DONE" C:\path\out.log' >/dev/null 2>&1; do sleep 10; done
```

**不要用「睡固定秒數再回來看」**——工作提早結束你會空等，晚結束你會誤判成失敗。
在這台的 Claude Code 裡，等待要寫成 `until <檢查>; do sleep N; done` 這種輪詢，
或把工作丟進背景任務等它通知。

**輸出檔 0 bytes** 幾乎都是 dispatch.md 的 A1（SSH 一斷，遠端程序就被帶走），
不是工作失敗。

## 看得到畫面（Windows）

真的需要看畫面時，**讓排程工作自己截圖再 `scp` 回來**，比開遠端桌面快，
而且不必有人坐在那台前面（2026-08-16 實測有效）：

```powershell
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save("C:\Users\user\shot.png", [System.Drawing.Imaging.ImageFormat]::Png)
```

（要跑在桌面 session，所以還是走 `schtasks /ru user /it`，見 dispatch.md。）

---

## 收尾清單

**每一項都要在同一輪清掉。** 漏掉的代價是下次有人接手時看到一台狀態不明的機器——
而那個人很可能是另一個 session，它不知道這些東西是誰留的。

| 要清的 | 怎麼清 |
|---|---|
| 排程工作 | `schtasks /delete /tn <name> /f`，然後 `schtasks /query /tn <name>` 確認真的沒了 |
| 傳過去的腳本、log、截圖 | `del /q`／`rm`，清完 `dir`／`ls` 再看一次 |
| 自己開的程序／視窗 | 見下面「認指令列不認 PID」 |
| 自己起的容器 | `docker compose down`（要留著的服務就不要清，但要講清楚留了什麼） |
| 對面的 git 工作區 | 有未提交的改動就**留著並回報**，不要順手 commit 或 checkout 掉——那可能是別人做到一半的 |

### 認指令列，不要認 PID

**Windows Terminal 的 `wt -w new` 不會產生新的 WindowsTerminal 程序**（實測 PID
清單完全沒變），所以「比對前後 PID、殺掉新出現的那個」在那裡是無效的——照做的結果是
視窗全部留在使用者桌面上。要清自己開的東西，認得出來的特徵是**指令列**：

```powershell
Get-CimInstance Win32_Process -Filter "ParentProcessId = <父程序 PID>" |
  Where-Object { $_.CommandLine -like "*<你自己下的指令特徵>*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**`CreationDate` 拿來二次確認**：使用者自己那些程序的建立時間會明顯早於你派工的時間。
分不出來就不要殺——留著回報，比殺掉別人正在用的東西好。

### 最後回報什麼

- 結果在哪（對面的路徑／拉回來的檔案）
- **留在那台上的東西**（還在跑的服務、容器、沒清的資料）
- 過程中改到那台狀態的事（裝了什麼、改了什麼設定）
