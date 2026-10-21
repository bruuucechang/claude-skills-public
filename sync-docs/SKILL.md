---
name: sync-docs
description: 核對專案的 CLAUDE.md／README 與實際程式碼是否還對得上——測試數量、埠位、檔案是否存在、指令能不能跑。文件腐爛是必然的，這個 skill 是用來實際跑一次而不是用讀的。改完一個模組、發現文件講的跟眼前的程式碼不一樣、或 preflight 報了「文件漂移」的時候跑。
---

# 文件與程式碼的一致性檢查

**規則：文件裡每一個可驗證的斷言都要實際跑一次，不要用讀的。**

## 先跑這個（唯一機械化的那一項）

```bash
node ~/.claude/skills/sync-docs/check-paths.mjs [專案目錄]
```

列出 `CLAUDE.md` 裡提到、但實際上不存在的程式碼檔。檔案被改名或刪掉是文件
腐爛最常見的形式，而這一項不需要任何專案知識就驗得了。

比對的是 `git ls-files` 加上實際在磁碟上的檔案（gitignore 掉的產物也算），
並且會排除隔壁 repo 的檔案（`projctl/projects.json` 這種跨 repo 引用不是漂移）。

**這是報告不是關卡**，精確度不到 100%。實測六個專案 10 個標記裡 4 個是真漂移。
每一項自己判斷是哪一種：檔案改名了（改文件）／檔案刪了（那段可能整段過期）／
引用別台機器的東西（文件要講明「只在某某機器上」）。

> **觸發時機由 `preflight` 負責**：當前目錄有 `CLAUDE.md` 時它會自動跑上面那支
> 的 `--quiet`，有漂移才出聲。
> 不要指望有人開口說「幫我檢查文件」——三台機器 252 個 transcript、0 次。
> 文件腐爛是做事途中才會撞到的問題，不是會被主動提出來的需求。

其餘的斷言（測試數量、埠位、指令能不能跑）機器驗不了，照下面的做法人工跑一次。

這不是假想的問題。實際發生過的落差：

- 記憶檔說前端 51 個測試，實際 139
- 記憶檔說後端 16 個，實際 27
- 記憶檔說字體「刻意不做 subset」，實際目錄裡只有 subset 版
- 記憶檔說 master 領先 origin 16 個 commit，實際早就同步了
- README 說埠位 8000/5173，實際是 5300/5301
- CLAUDE.md 寫 Docker 開 `localhost:8787`，實際主機埠是 18787
- 記憶檔整段描述某個換裝系統，那些檔案**在當前分支根本不存在**（在別的分支）

最後一項最危險：照著不存在的架構去改程式碼，會浪費掉一整輪。

---

## 檢查什麼

逐條看文件，把可驗證的斷言挑出來實跑：

**測試數量** — 直接跑，不要相信文件

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)|Ran [0-9]+ test|^OK|passed|failed"
```

**埠位** — 三個地方都要對得上：文件、設定檔、實際監聽

```bash
grep -rn "localhost:[0-9]\|port" <設定檔>
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

Windows 上沒有 `lsof`，也**沒有 `grep`**（PowerShell 的 PATH 裡沒有）：

```powershell
Select-String -Path <設定檔> -Pattern "localhost:\d+|port"
Get-NetTCPConnection -State Listen -LocalPort <port> | Select-Object LocalAddress,OwningProcess
```

Docker 專案特別注意**主機埠與容器埠可能不同**（`"18787:8787"` 這種）,
文件要寫的是使用者實際打得到的那個。

**檔案與目錄** — 文件提到的路徑逐一確認存在

```bash
for f in <文件裡提到的檔案>; do [ -e "$f" ] && echo "✓ $f" || echo "✗ $f"; done
```

```powershell
<文件裡提到的檔案> | ForEach-Object { "{0} {1}" -f $(if(Test-Path $_){"✓"}else{"✗"}), $_ }
```

**✗ 的那些先確認是不是在別的分支**：

```bash
git branch -a
git ls-tree <其他分支> --name-only | grep <檔名>
```

在別的分支的話，文件要**明講那是哪個分支**，不要讓人以為當前分支有。

**指令** — 文件寫的指令要真的能跑。`package.json` 的 scripts 對照文件的 Build & Run 段。

**git 狀態** — 文件裡若寫了「領先 N 個 commit」「某分支未合併」這種，一律重驗

```bash
git fetch origin; git status -sb | head -1; git branch --no-merged
```

**待辦** — 文件列的待辦有可能早就做完了。每一條都要找到對應的程式碼或 commit 才算數。

---

## 找出文件沒寫到的東西

反過來看：最近的 commit 有沒有帶進文件裡完全沒提的東西？

```bash
git log --oneline -20
git diff --stat HEAD~20 HEAD | tail -20
```

新增的頂層目錄、新的依賴、新的建置方式，都該在文件裡有一句。

---

## 修的時候

- **以程式碼為準**，不是以文件為準
- 修完在對應的地方留下可驗證的形式（寫數字就附上產生那個數字的指令）
- 有版控的專案，文件跟著程式碼一起 commit——記憶檔沒有版控，會再腐爛一次
- 如果落差是「文件記的是意圖，程式碼做的是另一回事」，**兩邊都要處理**：
  不只是改文件，要判斷程式碼是不是也偏離了原本的設計意圖

### 什麼時候停下來（2026-09-16 補）

這一支是「查 → 修 → 再查」的迴圈，而這種迴圈少了退出條件就會一直修下去。
**同一個落差修過兩次還是對不上，就停下來，把它寫成問題丟給使用者，不要修第三次。**

修不好通常代表你判斷錯了「哪一邊才是真相」——例如文件寫的其實是**別的分支**、
或者是**別台機器**的狀態（`trip-atlas` 在 M5 Pro 有 176 個未提交檔案，在 Air 上
怎麼核對都對不起來）。這種情況再修一次只會把正確的文件改壞。

停下來的時候要交出：**哪一條斷言、兩次分別看到什麼、你認為真相在哪一邊、為什麼不確定。**
不要只說「有落差修不好」。

---

## 在 Windows 上核對時，先確認自己看到的是真的

這台（BRUCEVICTUS）有三個會讓「核對」本身給出錯誤結論的陷阱，全部實測確認過
（細節在 `env-doctor` 的 windows.md）：

- **`Get-Content` 預設不是 UTF-8**（主控台碼頁 950）。讀含中文的文件會是亂碼，
  很容易誤判成「文件壞了」。一律加 `-Encoding UTF8`。
- **`>` 產生 UTF-16**。把檢查結果導進檔案再用 git 的 `grep` 去找，會什麼都找不到
  （實測 count=0）。要給 unix 工具吃的用 `Out-File -Encoding utf8`。
- **`curl` 是 `Invoke-WebRequest` 的別名**。文件裡的 `curl` 指令要驗證能不能跑，
  在這台要打 `curl.exe`——文件不必改，但**不要因為 `curl -sS` 報錯就判定文件過時**。

`core.autocrlf=true`：checkout 出來是 CRLF、commit 回去是 LF，所以正常情況
`git status` 是乾淨的。看到整個檔案都變動時先排除換行：`git diff --ignore-cr-at-eol`。

---

## 什麼時候跑

- rebase 或 merge 進來一批別人的 commit 之後（最需要的時機）
- 準備依照文件動手做一件比較大的事之前
- 交接、或很久沒碰的專案要重新開工時
