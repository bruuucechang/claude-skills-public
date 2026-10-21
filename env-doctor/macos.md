# 環境診斷 — macOS

`env-doctor` 的 macOS 半邊。Windows 看 [windows.md](windows.md)，**兩邊不通用**。

下面寫「這台」的，指作者那台 MacBook Air（實測來源）；成因與判斷樹在其他 Mac 上一樣成立。

診斷用的指令一律用 curl／CLI，不要開 Chrome 分頁。

---

## 症狀：檔案讀不到（EPERM / Operation not permitted）

`~/Documents` 整棵樹讀不到，連 `ls` 都不行。**有兩個完全不同的成因，解法相反。**

### 第一步：確定是不是整棵樹

```bash
for d in ~/Documents ~/Desktop ~/Downloads; do
  printf '%s : ' "$d"; ls "$d" >/dev/null 2>&1 && echo OK || echo DENIED
done
```

- `Documents` DENIED 而 `Desktop`／`Downloads` OK → 往下走
- 全部 OK → 不是這個問題，去看檔案本身的權限與 ACL（`ls -le`）

### 第二步：分辨 TCC 還是 iCloud

| | TCC | iCloud 同步 |
|---|---|---|
| 成因 | 宿主終端機 app 沒有「完全取用磁碟」 | 桌面與文件同步把檔案抽走 |
| 重開終端機 | **有效**（要 ⌘Q 完全結束再開） | 無效 |
| 持續時間 | 直到授權為止 | 會自己恢復 |

兩者共通、而且最容易浪費時間的一點：**TCC 判定綁在 process 上，授權不會回溯套用到已在跑的程序。**
授權之後必須整個 app ⌘Q 再開，或改用另一個終端機視窗（新 process）。
**`!` 前綴繞不過去**——它跑在同一個 process 裡，握的是同一份已被拒絕的判定。
關掉 Claude Code 的 sandbox（`dangerouslyDisableSandbox`）也沒有用，這是 OS 層不是沙箱層。

TCC 的授權對象是**宿主終端機 app**（例：`/System/Applications/Utilities/Terminal.app`；用 iTerm 等就是那個 app），
不是 `claude` 自己。

### 第三步：如果是 launchd 底下的程序讀不到

**這是第三種情況，跟上面兩個都不一樣，而且症狀一模一樣。**

launchd 起的程序有自己的一套判定，要分開測。用一次性 probe agent 實測，不要推論：

```bash
L=com.probe.tmp; P=~/Library/LaunchAgents/$L.plist
cat > $P <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.probe.tmp</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/node</string><string>-e</string>
  <string>const fs=require("fs");try{fs.readFileSync("/path/to/target");fs.writeFileSync("/tmp/probe.log","ok")}catch(e){fs.writeFileSync("/tmp/probe.log","no "+e.code)}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
rm -f /tmp/probe.log
launchctl bootout gui/$(id -u)/$L 2>/dev/null
launchctl bootstrap gui/$(id -u) $P; sleep 3; cat /tmp/probe.log
launchctl bootout gui/$(id -u)/$L; rm -f $P
```

**結果寫 `/tmp`**，那裡不受 TCC 管——寫在目標目錄裡的話，「沒權限」會連結果都寫不出來，
跟「還沒跑完」分不出來。

**probe 一定要用真正會跑 agent 的那個 binary。** TCC 綁在執行檔上，用 `/bin/sh` 去測
只會告訴你 `/bin/sh` 有沒有權限——實際誤報過。

---

## 症狀：launchd agent 起不來，log 完全空白

```bash
launchctl print gui/$(id -u)/<label> | grep -E "state|runs|last exit code"
```

**`last exit code = 78: EX_CONFIG`** 且 log 一個字都沒有 → 程式根本沒被執行，
是 launchd 自己在 spawn 前就失敗。**這種情況 log 裡永遠不會有線索，只能看 exit code。**

已知成因（2026-08-06 實測確認）：

**`StandardOutPath` / `StandardErrorPath` 指向 `~/Documents` 底下已經存在的檔案。**
那兩個路徑是 launchd 自己去開的，不是你的程式。launchd 開不了 `~/Documents` 裡的既有檔案，
但**建得出新檔**（大概是 create 不需要先 stat，而 stat 被擋）。

這個坑特別陰險：**第一次 install 一定成功**（log 檔是那時新建的），要等重開機或重載，
launchd 去開既有檔才失敗——而那時 log 裡還留著上次的正常輸出，看起來像「昨天還好好的」。

**解法：agent 的 log 放 `~/Library/Logs/<name>/`，不要放在 `~/Documents` 底下。**

其他 78 的可能：`ProgramArguments` 第一個元素路徑不存在、`WorkingDirectory` chdir 不了。
逐項二分測試，每次只改一個 key。

> Windows 沒有 launchd，對應的機制是排程工作（`schtasks`），坑完全不同，見 windows.md。

---

## 症狀：服務明明起來了，curl 卻打不到

**這台機器 IPv4/IPv6 分裂，而且兩個方向都會咬人。** 先兩種寫法都試：

```bash
curl -sS -o /dev/null -w 'localhost  → %{http_code}\n' http://localhost:PORT/
curl -sS -o /dev/null -w '127.0.0.1  → %{http_code}\n' http://127.0.0.1:PORT/
lsof -nP -iTCP:PORT -sTCP:LISTEN
```

實際案例，兩個方向相反：

- **vite 只綁 `[::1]`** → `curl 127.0.0.1:5273` 完全打不到，要用 `localhost`
- **兩個服務各綁 `*:3001` 與 `[::1]:3001`** → 位址不同所以都能綁成功、不報 EADDRINUSE，
  但 `curl localhost:3001` 會優先走 IPv6 打到**錯的服務**。這種情況查 `lsof` 會看到兩筆不同的程序

---

## 症狀：一個埠上有兩個 pid，看起來像衝突

**先確認是不是誤報。** 父子程序共用同一個 socket 不是衝突：

```bash
for p in $(lsof -nP -iTCP:PORT -sTCP:LISTEN -t); do ps -o pid=,pgid=,comm= -p $p; done
lsof -nP -iTCP:PORT -sTCP:LISTEN   # 看 DEVICE 欄
```

- **DEVICE（socket 物件）相同、pgid 相同** → 同一個服務，正常。
  uvicorn `--reload` 就是這樣：reloader 先 `bind()`，worker 繼承 fd。
  **這種情況去 kill 會殺掉自己剛起好的服務。**
- DEVICE 不同、pgid 不同 → 真的是兩個服務搶同一個埠

---

## 症狀：Docker 指令沒反應

**不要用 `docker info` 做存活檢查**——daemon 沒跑時會卡兩分鐘。用：

```bash
curl -s --max-time 2 --unix-socket ~/.docker/run/docker.sock http://localhost/_ping
```

`/usr/local/bin/docker` 曾指向已清除的 AppTranslocation 路徑而失效。
CLI 的可靠位置是 `/Applications/Docker.app/Contents/Resources/bin`，
可以自己連一份到 `~/.local/bin/docker`（例：作者那台就是這樣）。

---

## 症狀：grep 找不到明明存在的字

**macOS 的 `grep` 會把含中文的檔案當 binary 而靜默跳過整個檔案。一律加 `-a`。**

檔案裡有 NUL byte 時也一樣（曾經有一個 `.ts` 檔因此整支被跳過）。

> 同樣的症狀在 Windows 上是**檔案被寫成 UTF-16** 造成的，加 `-a` 沒有用，見 windows.md。

---

## 症狀：環境變數沒有人設，卻莫名其妙存在

代表案例：Claude Code 開場印
`Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`，
整場對話不寫 `~/.claude/projects/.../*.jsonl`，事後 `/resume` 找不到。

**症狀跟成因隔得很遠**：看起來是 claude 的問題，實際上是 **Terminal.app 這個 process 整棵中毒**。

### 成因

從 claude 的 Bash tool 裡**冷啟** Terminal.app——`open -a Terminal`，或 Terminal 沒在跑時
下 `osascript -e 'tell application "Terminal" ...'`——LaunchServices 會把呼叫端的環境
整包塞進 Terminal.app。之後它開的**每一個視窗與分頁**都繼承下去。
**關視窗沒用，⌘Q 完全結束才會消。**

### 判斷樹（順序不能跳，第 3 步決定解法完全不同）

```bash
env | grep CLAUDE_CODE                      # 1. 確認變數真的在
grep -rn '<VAR>' ~/.zshrc ~/.zprofile ~/.zshenv ~/.profile   # 2. 有沒有人明著設
launchctl getenv <VAR>                      # 3. ← 關鍵分歧點
ps -o pid,ppid,command -p $PPID             # 4. 往上追到 Terminal.app，比對啟動時間
```

**第 3 步是關鍵**：

| `launchctl getenv` | 成因 | 解法 |
|---|---|---|
| **有值** | 有人跑過 `launchctl setenv` | `launchctl unsetenv <VAR>`。**重開 Terminal 救不了**，之後每個 app 都會拿到 |
| **空的** | process 繼承 | 清 shell 或重開 Terminal 才有用 |

`ps eww -p <其他 pid>` 讀不到別的 process 環境（macOS 擋的），第 4 步只能用**排除法**推：
dotfile 沒有 + 我這層有 + 父鏈只有 Terminal → 就是 Terminal.app 帶進來的。

### 解法：清在 `.zshrc`，判斷條件用 `interactive`

```zsh
if [[ -o interactive ]]; then
  unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID CLAUDE_CODE_BRIDGE_SESSION_ID
fi
```

**分界線是 `interactive`，不是 `login`**，這點最容易寫錯：

| shell | login | interactive | 讀 `.zshrc` |
|---|---|---|---|
| Terminal 視窗 | YES | YES | 會 |
| **claude 的 Bash tool** | **YES** | **NO** | **不會** |

所以清在 `.zshrc` 只影響終端機視窗，碰不到 claude 開的子行程，
**它自己用這個標記做的巢狀 session 判斷不會被拆掉**。
**放 `.zprofile` 就會連 Bash tool 一起清到**——那個版本會出事。

實測驗證兩條路徑都要跑（`NOQUAD=1` 是作者 `.zshrc` 的開關，不讓開機排版掛勾開視窗；你沒有就無害）：

```bash
CLAUDE_CODE_CHILD_SESSION=1 NOQUAD=1 zsh -i -c 'echo ${CLAUDE_CODE_CHILD_SESSION:-cleared}'  # 要 cleared
CLAUDE_CODE_CHILD_SESSION=1          zsh -l -c 'echo ${CLAUDE_CODE_CHILD_SESSION:-cleared}'  # 要 1
```

清除必須排在 `.zshrc` 裡任何會自動跑 `claude` 的掛勾**之前**（例：作者的 quad 掛勾）。
作者那台 2026-08-06 修好，細節在他的記憶檔 `claude-code-child-session-leak`。

**通則**：以後要從 claude 裡開 Terminal，用
`env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID open -a Terminal`。

**臨時逃生門**（提示訊息尾巴被截掉的那半句，開頭那格已經中毒但不想重開時）：

```bash
CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 claude
```

這是 claude 內建的強制開關，不管有沒有 CHILD_SESSION 標記都會寫 transcript。
**只對新開的 session 有效**——環境變數在 process 啟動時就定型，救不了已經在跑的那格。

> 這整條是 mac 專屬的：成因是 LaunchServices 把環境塞進 Terminal.app。
> 作者的 Windows 機器實測三層（process／User／Machine）都沒有這個變數，見 windows.md。

---

## 症狀：shell 迴圈沒有跑到預期的次數

**zsh 不會對未加引號的變數做斷詞（bash 會）。** `for f in $FILES` 不展開，要用陣列。
這個坑踩過三次。

---

## 收尾

診斷完如果發現的是新的成因，寫回這一份，並在對應專案的 CLAUDE.md 留一句。
相關背景在作者的記憶檔 `icloud-documents-eperm`、`projctl`，
以及他的 projctl repo 的 `CLAUDE.md` TCC 三段（你沒有就略過）。
