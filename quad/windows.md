# 四宮格 — Windows（BRUCEVICTUS）

**這台沒有 `quad` 腳本，也刻意不做**（理由在 [SKILL.md](SKILL.md)）。
四宮格用 Windows Terminal 自己的分割窗格達成。

`wt.exe` 在這台的位置（2026-08-16 實測存在）：
`C:\Users\user\AppData\Local\Microsoft\WindowsApps\wt.exe`

**2026-08-16 已在那台的桌面 session 實測過**（用 `schtasks /it` 跑，替身指令不跑 claude，
截圖回來確認）：下面這個形式**開出滿版四宮格，四格各自跑到指定的指令**，
左上、右上、左下、右下都對。

---

## 一行開四格，每格一個 Claude Code

在 **Windows Terminal 裡**（不是傳統主控台），**整串寫在同一行**：

```powershell
wt -w new -M -d D:\Claude\Projects\<專案> powershell -NoExit -Command claude `; split-pane -V -d D:\Claude\Projects\<專案> powershell -NoExit -Command claude `; move-focus left `; split-pane -H -d D:\Claude\Projects\<專案> powershell -NoExit -Command claude `; move-focus right `; split-pane -H -d D:\Claude\Projects\<專案> powershell -NoExit -Command claude
```

**四個實測踩到的地方：**

1. **`` `; `` 後面不能換行。** `;` 是 `wt` 的子指令分隔符，也是 PowerShell 的敘述
   分隔符，所以要用反引號跳脫——但把它寫成 `` `;` `` 再換行接續（想讓指令好讀）
   **會直接變成語法錯誤**，整支腳本連第一行都不會執行。實測：寫成多行的版本
   `ParseFile` 回報兩個 parse error，排程工作離開碼 1、什麼都沒發生。
   要好讀就把整串放進一個變數，不要用反引號折行。
2. **不要改用 `cmd.exe /c "wt ... ; split-pane ..."`。** 實測那條路
   `$LASTEXITCODE` 回 0 但**一個視窗都沒開**，看起來像成功。以那台目前的
   Windows Terminal 1.24 為準，就用上面 PowerShell 的單行形式。
3. **`-M` 是開最大化視窗**（實測有效，滿版 1920×1080）。不要自己算像素尺寸去擺——
   分割窗格是 Windows Terminal 自己按比例排的，改螢幕、改工作列都會自己跟上。
4. **`-d <路徑>` 要每一格都給。** 不給的話新窗格會沿用 profile 的預設起始目錄，
   四格會落在不同專案下，而 Claude Code 的工作目錄決定它讀哪一份 CLAUDE.md。

## ⚠ `-w new` 不會產生新的 WindowsTerminal 程序

實測：開完四宮格之後 `Get-Process WindowsTerminal` 的 PID 清單**完全沒變**——
新視窗是掛在既有的那個程序底下的。這件事在收尾時會咬人：

- **不能用「比對前後 PID、殺掉新出現的那個」來關掉自己開的視窗**，因為根本不會有新 PID。
  照著做的結果是視窗全部留在使用者桌面上。
- 要關掉自己開的窗格，**認指令列**，不要認 PID：

```powershell
Get-CimInstance Win32_Process -Filter "ParentProcessId = <WindowsTerminal 的 PID>" |
  Where-Object { $_.CommandLine -like "*<你自己下的指令特徵>*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

  使用者自己那些窗格的 `CreationDate` 會明顯早於你開的，可以拿來二次確認。
  殺掉窗格裡的 shell，那一格就會消失；最後一格消失時視窗才會關掉。

**要開四個空 shell**（不跑 claude）就把 `powershell -NoExit -Command claude` 整段拿掉。

## 讓它開機就長這樣

不要寫成掛勾去自動開視窗（那正是 mac 那邊 fork bomb 的來源）。Windows Terminal
有現成的機制，寫在 `settings.json` 的 `startupActions`：

```json
"startupActions": "-M ; split-pane -V ; move-focus left ; split-pane -H ; move-focus right ; split-pane -H"
```

（設定檔在 `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`。
這是 Windows Terminal 自己在啟動時執行的，**不會遞迴**——不像 shell 啟動檔那樣
會被新開的窗格再跑一次。）

## 手動的快捷鍵（不用記指令）

| 動作 | 按鍵 |
|---|---|
| 垂直分割 | `Alt` + `Shift` + `+` |
| 水平分割 | `Alt` + `Shift` + `-` |
| 在窗格間移動 | `Alt` + 方向鍵 |
| 調整窗格大小 | `Alt` + `Shift` + 方向鍵 |
| 關閉目前窗格 | `Ctrl` + `Shift` + `W` |

**用遠端桌面時只能靠這些鍵嗎——不行。** Chrome 遠端桌面完全不傳 `Shift`
（見 `env-doctor` 的 windows.md），上面每一個組合都按不出來。人在機器前面才用快捷鍵，
遠端就用 `wt` 指令列那條路。

## 排查

- **完全沒有反應、離開碼卻是 0** → 先確認不是走了 `cmd.exe /c` 那條（實測會這樣）。
- **腳本連第一行都沒執行** → 兩個可能：`` `; `` 後面換了行（parse error），
  或 `.ps1` 存成無 BOM 的 UTF-8 而檔案裡有中文——PowerShell 5.1 會用 big5 去讀，
  把引號吃掉（見 `env-doctor` 的 windows.md）。**排程工作跑的腳本寫成純 ASCII 最省事。**
- **只開出一格** → `;` 沒跳脫，PowerShell 把它切成好幾道指令了。
- **窗格開了但沒跑 claude** → 確認 `claude` 在 PATH
  （這台是 `C:\Users\user\.local\bin\claude.exe`），以及用的是
  `powershell -NoExit -Command claude` 而不是直接 `claude`——後者跑完就把窗格收掉。
- **關掉窗格會殺掉 Claude session**，跟 mac 一樣。移動、調大小都是安全的。
