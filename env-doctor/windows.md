# 環境診斷 — Windows

`env-doctor` 的 Windows 半邊。mac 看 [macos.md](macos.md)，**兩邊不通用**。

下面寫「這台」的，指作者的一台 Windows 11 家用版（實測來源）。版本、碼頁、路徑換成你自己的；
坑本身在其他 PowerShell 5.1 的 Windows 上大多一樣。例：那台的基本事實（2026-08-16 實測）：

| | |
|---|---|
| 殼層 | **Windows PowerShell 5.1**（26100.9168），**不是** PowerShell 7 |
| 主控台碼頁 | `chcp` = **950**，`[Console]::OutputEncoding` = **big5** |
| 家目錄 | `$env:USERPROFILE`（例：`C:\Users\user`） |
| skills repo | `$env:USERPROFILE\.claude\skills`（**實體目錄**，repo 本體就在這裡） |
| 專案 | 自己定（例：`D:\Claude\Projects\`） |
| claude / proj | `$env:USERPROFILE\.local\bin\claude.exe`、`...\proj.cmd`（proj 選配） |

---

## 症狀：中文變亂碼，或 grep 找不到明明存在的字

**這台最常咬人的一條，而且有三個彼此獨立的成因。** 依序排除：

### 1. `Get-Content` 預設不是用 UTF-8 讀

PowerShell 5.1 預設用系統 ANSI（這台是 big5）讀檔。實測寫入「測試中文」再讀回來：

```powershell
Get-Content $f -Raw                 # → ?��?岫�???   ← 全毀
Get-Content $f -Raw -Encoding UTF8  # → 測試中文       ← 正確
```

**這台上讀任何含中文的檔案都要加 `-Encoding UTF8`**，包含 `Import-Csv`、
`ConvertFrom-Json`（實測：直接把 UTF-8 的 `settings.json` 讀進來再 `ConvertFrom-Json`
會炸在「傳入了無效的字元」，成因是讀進來就已經是亂碼了，不是 JSON 有問題）。

### 2. `>` 重導向產生 UTF-16，unix 工具讀不到

```powershell
"hello" > f.txt
# 實測前六個位元組：255,254,104,0,101,0   ← UTF-16LE + BOM
```

| 用什麼找 | 結果 |
|---|---|
| `Select-String -Pattern hello` | **找得到** |
| `C:\Program Files\Git\usr\bin\grep.exe -c hello` | **0**（找不到） |

`Out-File -Encoding utf8` 產生的是 BOM 版 UTF-8（`239,187,191,...`），grep 實測回 1。

**所以：要餵給 git／grep／任何 unix 工具的檔案，不要用 `>` 產生。**
症狀是「明明剛寫進去的字，grep 說沒有」。

**但 `Out-File -Encoding utf8` 也不能拿來產生 shell 腳本**——PowerShell 5.1 的
`utf8` 一定帶 BOM，而 bash 會把 BOM 當成第一個指令的一部分：

```
line 1: $'\357\273\277set': command not found      ← 實測踩到
```

要產生給 bash 吃的檔案，用不帶 BOM 的寫法：

```powershell
[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
```

（更省事的做法是**在 mac 這側寫好再 `scp` 過去**，就不會碰到這一整類問題。）

> mac 上同樣的症狀是「grep 把含中文的檔當 binary 靜默跳過」，解法是 `-a`。
> **這台加 `-a` 沒有用**，成因是編碼不是判定。

### 3. 過 SSH 看輸出時的亂碼

從 mac `ssh` 過去跑的東西，中文輸出會經過 big5 主控台。要看得懂就在指令最前面加：

```powershell
chcp 65001 > $null; [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
```

**先確認亂碼是「輸出被轉壞」還是「檔案本身被寫壞」**——前者無害，後者會讓後續所有搜尋失效。

---

## 症狀：指令名稱明明對，行為卻不對

這台有四個名字會騙人，**每一個都實測確認過**：

| 打下去 | 實際上是什麼 | 要用什麼 |
|---|---|---|
| `curl` | **`Invoke-WebRequest` 的別名**（PS 5.1），參數語法完全不同 | **`curl.exe`**（`C:\windows\system32\curl.exe`） |
| `wget` | 同樣是別名 | `curl.exe` |
| `bash` | `C:\windows\system32\bash.exe`＝**WSL 的 Ubuntu**（這台裝了 Ubuntu 與 docker-desktop 兩個 distro） | Git Bash：**`C:\Program Files\Git\bin\bash.exe`** |
| `grep` / `sed` / `awk` | **PowerShell 的 PATH 裡根本沒有**（實測 `Get-Command` 全 miss） | `C:\Program Files\Git\usr\bin\` 底下那些，或改用 `Select-String` |

`bash` 那條最貴：直接打 `bash something.sh` 會跑進 **WSL 裡**，看到的是 `/mnt/d/...` 的
檔案系統與 Linux 的 node／python，**跟 Windows 這側是兩套環境**。腳本「跑起來了但結果不對」
先確認自己在哪個 bash 裡（`uname -s`：Git Bash 回 `MINGW64_NT-...`，WSL 回 `Linux`）。

### 從 mac 用 SSH 打過來時：預設殼層是 `cmd.exe`

實測 `%COMSPEC%` = `C:\WINDOWS\system32\cmd.exe`。兩個立刻會咬人的差異：

- **`cd` 不會換磁碟機。** `ssh <你的 Windows 主機> 'cd D:\Projects\<repo> && git log'` 會在
  `%USERPROFILE%` 底下跑 git，回一句 `not a git repository`——**看起來像 repo 不見了**。
  要寫 **`cd /d D:\...`**（實測加了就正常）。
- **`&&` 可以用，`;` 不行**；要用 PowerShell 的語法就整段包起來：
  `ssh <你的 Windows 主機> 'powershell -NoProfile -Command "..."'`。指令複雜到需要引號巢狀時，
  **寫成 `.ps1` 用 `scp` 傳過去再 `powershell -File` 跑**，比在引號裡搏鬥快得多
  （這份文件裡的實測數據就是這樣拿到的）。

---

## 症狀：服務起來了，卻打不到

`lsof` 不存在。對應指令：

```powershell
Get-NetTCPConnection -State Listen -LocalPort <port> |
  Select-Object LocalAddress, LocalPort, OwningProcess
Get-Process -Id <pid>
```

**這台一樣要三種位址都試**（實測 3000 埠：`wslrelay` 綁 `::1`、`com.docker.backend` 綁 `::`，
三種寫法都回 200，但那是這一次；綁在哪由容器怎麼發佈決定）：

```powershell
curl.exe -sS -o NUL -w "%{http_code}`n" --max-time 4 http://localhost:<port>/
curl.exe -sS -o NUL -w "%{http_code}`n" --max-time 4 http://127.0.0.1:<port>/
curl.exe -sS -o NUL -w "%{http_code}`n" --max-time 4 "http://[::1]:<port>/"
```

看到 `wslrelay` 或 `com.docker.backend` 佔著埠是**正常的**——容器的埠是它們代理出來的，
不是有人佔用，去殺它等於把 Docker 的網路拆掉。

---

## 症狀：Docker 指令沒反應

**不要看 Windows 服務的狀態判存活。** 實測 `com.docker.service` 顯示 **Stopped**，
但引擎照樣活著（走 WSL2 後端）。可靠的兩個檢查：

```powershell
Test-Path \\.\pipe\docker_engine                    # 命名管道在不在
docker version --format '{{.Server.Version}}'       # 實測 144ms 回 29.6.2
```

`docker version` 在這台是快的（不像 mac 上 `docker info` 會卡兩分鐘），可以直接當存活檢查。

**這台的資料庫是跑在容器裡的**（實測 `interiordesign-db-1` = `postgres:17-alpine`），
主機上**沒有 `psql` 也沒有 `createdb`**。任何寫著「本機共用的 PostgreSQL」的步驟
都是 mac 專屬的，見 `newproj` 的 windows.md。

---

## 症狀：檔案／目錄讀不到，或 git 一直抱怨 dubious ownership

**這台的成因跟 mac 完全不同，跟權限對話框無關。**

### junction 被標成「未受信任的掛載點」

`mklink /J` **一定要在提權的程序裡建**，否則之後任何程序都穿不過去。
最陰險的是**兩次都是靜默失敗**：`mklink` 回報成功、`dir /al` 也列得出來，只有實際去讀才炸。
踩過的兩次：`~\.claude\skills` 那條讓 8 個 skill 一個都沒生效（看起來卻像設定好了）、
另一個 session 建的 `~\.claude\memory` 建好了但讀不到。

> 一開始誤判成「跨磁碟區才會發生」。**不是**，memory 那條是同一顆碟一樣中。
> 變因是建立者的權杖，不是磁碟。SSH session 本來就有完整管理員權杖，從 SSH `rmdir` 再
> `mklink /J` 重建即可。

**建完一定要實際讀一次**，不能只看 `dir /al` 列不列得出來：

```powershell
Get-ChildItem $env:USERPROFILE\.claude\memory -ErrorAction Stop
Get-Item <path> -Force | Select-Object LinkType, Target    # 確認連到哪
```

目前的實際狀態（2026-08-16 實測）：`~\.claude\skills` 是**實體目錄**（repo 本體），
`~\.claude\memory` 與 `~\.claude\commands` 是 **junction** 指進 `skills\home\claude\` 底下，
`~\.claude\settings.json` 是**獨立的一份檔案，不是連結**（內容跟 mac 的刻意不同，見 README）。

### 提權搬檔改掉了擁有者

`robocopy` 從提權的 SSH session 搬 repo 之後，檔案擁有者變成 `BUILTIN\Administrators`，
於是 git 每個指令都回報 **dubious ownership**。

**不要用 `safe.directory` 繞過**（那是把症狀藏起來），直接把擁有權還回去：

```powershell
icacls "$env:USERPROFILE\.claude\skills" /setowner "$env:USERNAME" /T /C
```

（實測 172 個檔案處理完，`git status` 立刻 exit 0、警告消失。
另外：`move` 不能跨磁碟區搬目錄，要搬 repo 用 `robocopy /E /MOVE`。）

---

## 症狀：從 SSH 下的指令碰不到桌面上的東西

**SSH 進來是 session 0，桌面是 session 1，兩者隔離。** `SetWindowPos` 之類的 user32
呼叫會回 `False`——不是權限問題，重試幾次也沒用。要在桌面那個 session 執行東西，
走排程工作：

```powershell
schtasks /create /tn t1 /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\x.ps1" /sc once /st 00:00 /ru $env:USERNAME /it /f
schtasks /run /tn t1
```

`/ru <使用者> /it` 是關鍵，`/it` 才會跑在互動 session。**腳本要自己寫 log 檔回報結果**，
排程工作的 stdout 沒地方去。**用完記得 `schtasks /delete /tn t1 /f`**。

**看得到畫面**：讓那支腳本自己截圖，再從 mac `scp` 回來看（2026-08-16 實測有效，
作者驗終端機排版那輪就是這樣做的）。這比 Chrome 遠端桌面快，而且不必有人坐在那台前面：

```powershell
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save("$env:USERPROFILE\shot.png", [System.Drawing.Imaging.ImageFormat]::Png)
```

**排程跑的 `.ps1` 寫成純 ASCII。** 無 BOM 的 UTF-8 檔案裡只要有中文，PowerShell 5.1
就會用 big5 去讀，可能把引號吃掉——症狀是**離開碼 1、log 檔連建都沒建**，
因為 parse error 讓整支腳本一行都沒跑。先驗語法再排：

```powershell
$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$null,[ref]$e); $e.Count
```

**剪貼簿也是分 session 的**——從 SSH `Set-Clipboard` 設的內容跟桌面那份是兩份，
不能拿來跨 session 傳訊息。要跟桌面上的 Claude session 溝通，用檔案：`scp` 進它的
工作目錄，然後在它的輸入框打一行**全小寫、不需要 Shift** 的指令
（`read task.md in this folder and do everything it says`）。

> 為什麼要挑不用 Shift 的字：Chrome 遠端桌面**完全不傳 Shift**，
> 打不出 `~ | * $ : _` 與任何大寫；注音輸入法連單一數字都會攔截（打 `1` 變成 `ㄅ`）。
> 要回答 Claude Code 的選單就**用滑鼠點**，不要打數字，實測每次都成功。
> 這台是 Windows 11 **家用版**，沒有 RDP 被連端（3389 永遠關著），只能用 Chrome 遠端桌面。

---

## 症狀：環境變數莫名其妙存在（或設了卻沒生效）

Windows 有三層，`Get-ChildItem Env:` 只看得到最終合併後的 process 層。要分辨是誰設的：

```powershell
$env:VAR                                                  # process（含繼承）
[Environment]::GetEnvironmentVariable('VAR','User')       # 註冊表 HKCU
[Environment]::GetEnvironmentVariable('VAR','Machine')    # 註冊表 HKLM
```

- **User／Machine 有值** → `setx` 或系統設定裡設過。改了**只對之後新開的程序生效**，
  已經在跑的殼層與它的子程序拿不到，要重開終端機。
- **只有 process 層有** → 是繼承來的，往上追父程序。

實測目前 `CLAUDE_CODE_CHILD_SESSION` 三層都是空的——mac 那條「Terminal.app 整棵中毒」
的問題**這台沒有**（成因是 macOS 的 LaunchServices，Windows 沒有對應機制）。
如果哪天這台真的出現 transcript 沒在存，先照上面三層查，不要照抄 mac 的判斷樹。

---

## 症狀：Claude Code 的畫面文字重疊、排序錯亂、中間穿插奇怪文字

**先看掛勾，不要先懷疑終端機。** 2026-08-17 作者的兩台 Windows 都有這個症狀，
成因是 `settings.json` 的掛勾是 **POSIX shell** 寫的，而
**Windows 上 Claude Code 是用 PowerShell 5.1 跑掛勾**：

| 掛勾裡的寫法 | PowerShell 5.1 的下場 |
|---|---|
| `... 2>/dev/null \|\| true` | 剖析錯誤——`\|\|` 是 PowerShell **7** 才有的 |
| `printf '%s' '{...}'` | `printf` 這個指令不存在 |
| `c=$(jq -r ...); case ... esac` | 剖析錯誤 |

`Stop` 掛勾**每次回覆結束都會跑**，那段多行剖析錯誤就一直插進 TUI 的重繪裡。
mac 不中，因為 zsh 看得懂那些語法——所以這是「同一份設定跨平台」造成的，
跟 conhost 的臭蟲、Windows 版本、終端機程式都無關（實測 Win 10 Pro 與 Win 11
家用版症狀一模一樣，兩台都是 PowerShell 5.1）。

**更該在意的是它安靜的那一面**：剖析失敗的掛勾等於沒有掛勾——
作者身分守門在那兩台 Windows 上從來沒生效過，SessionStart 的行為約定也從來沒送達過。

修法與可直接用的 PowerShell 版本在 `~/.claude/skills/home/claude/hooks/`。
改掛勾之前先驗語法：

```powershell
$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput('<指令>',[ref]$null,[ref]$e); $e.Count
```

**含中文的 `.ps1` 一定要存成帶 BOM 的 UTF-8**（見上面的編碼那節）——
寫這份修法的時候我自己又踩了一次：無 BOM 的守門腳本被 big5 讀壞、
引號被吃掉、整支剖析失敗，症狀跟它要修的問題長得一模一樣。

---

## 收尾

診斷完如果發現的是新的成因，寫回這一份（只有兩台都成立才寫進 SKILL.md）。
相關背景在作者的記憶檔 `windows-machine.md`（SSH 怎麼接起來的、deploy key、
遠端桌面的鍵盤限制）、`projctl.md`（`proj` 的位置與埠位對照表）；你沒有就略過。
