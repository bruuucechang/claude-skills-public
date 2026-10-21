# 開新專案 — Windows

`newproj` 的 Windows 半邊。共通的部分在 [SKILL.md](SKILL.md)，mac 看 [macos.md](macos.md)，
**指令不通用**。

下面的事實取自作者的一台 Windows 機器（下稱「這台」，2026-08 實測）；路徑換成你自己的，
坑本身在其他 Windows 機器上大多一樣。

| | |
|---|---|
| 專案根 | 自己定（例：`D:\Claude\Projects\<name>`；下面用 `<專案根>` 代稱） |
| `proj` | 選配（例：`$env:USERPROFILE\.local\bin\proj.cmd`）。沒有就照 SKILL.md 開頭的手動做法，scaffold 加 `--web-port`／`--api-port` |
| Python | 3.11.9（`...\WindowsApps\python.exe`），**沒有 `py` 啟動器** |
| 資料庫 | **Docker 容器**（例如 `interiordesign-db-1` = `postgres:17-alpine`）。主機上**沒有 `psql`／`createdb`** |

---

## 跑 scaffold：指名 Git Bash，不要打 `bash`

```powershell
proj new <name>
& "C:\Program Files\Git\bin\bash.exe" "$env:USERPROFILE\.claude\skills\newproj\scaffold.sh" `
    <name> --dir <專案根>\<name> --no-createdb
```

**2026-08-16 實測**：這樣跑得起來，exit 0，產出 33 個檔案，三層目錄與 `run.sh`、
`CLAUDE.md`、`db/schema.sql` 都在。

四個必須照做的地方：

1. **`bash` 這個名字是 WSL 的。** `C:\windows\system32\bash.exe` 是 WSL 的 Ubuntu，
   在那裡面跑會看到 `/mnt/d/...` 的檔案系統與 Linux 那套 node／python，
   產出的專案會長在錯的地方。一定要用完整路徑指名 Git Bash。
2. **用 `bash scaffold.sh`，不要 `./scaffold.sh`。** 這台的 `core.autocrlf=true`，
   checkout 出來的 `scaffold.sh` 是 CRLF（實測前 2000 位元組有 45 對 CRLF）。
   直接執行會讓 shebang 帶著 `\r` 而報 bad interpreter；把它當參數餵給 bash 就沒事。
3. **一定要加 `--no-createdb`。** 這台沒有 `createdb`。（腳本自己也會偵測到並跳過，
   明著寫是為了讓輸出裡不要出現看起來像失敗的提示。）
4. **`--dir` 一定要給**（或設 `PROJECTS_ROOT`）。預設值是 `~/Projects/<name>`，在 Git Bash 裡會跑到
   `%USERPROFILE%\Projects`，不一定是你放專案的地方。

## 產出的 `run.sh` 已經兩邊通用（2026-08-16 修的）

Windows 的 venv 把執行檔放在 **`.venv/Scripts/`**，POSIX 放 `.venv/bin/`
（實測 `python3 -m venv` 在這台產出的是 `Include`／`Lib`／`Scripts`／`pyvenv.cfg`）。
`scaffold.sh` 產的 `run.sh` 現在自己判斷：

```bash
if [ -d "$VENV/Scripts" ]; then VBIN="$VENV/Scripts"; else VBIN="$VENV/bin"; fi
```

**實測**：在這台跑修過的 scaffold（exit 0）→ `python3 -m venv` → 這段解析出
`VBIN=.../.venv/Scripts`，`pip` 找得到。

> 寫成 `[ -d "$VENV/Scripts" ] && VBIN=...` 會出事：條件不成立時整句回傳 1，
> 配上 `run.sh` 開頭的 `set -e` 會直接把腳本結束掉——而那正是 mac 上的路徑。
> 改這段的時候不要「簡化」成 `&&`。

`run.sh` 是 scaffold 在本機產生的（不經過 git），所以是 LF，Git Bash 直接吃得下。

**要手動起（除錯時比較好看到錯誤）**：

```powershell
cd <專案根>\<name>\backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\uvicorn app.main:app --reload --port <api_port>

# 另一個視窗
cd <專案根>\<name>\frontend
npm install
npm run dev -- --port <web_port> --strictPort
```

跑測試同理：**`.\.venv\Scripts\pytest`**，不是 `./.venv/bin/pytest`。

## 資料庫：起一個容器，不要找 psql

主機上沒有 PostgreSQL。既有專案的做法是每個專案一個容器
（實測跑著的：`interiordesign-db-1`、`news-stock-*` 那一串）。新專案照樣：

```powershell
docker run -d --name <name>-db -e POSTGRES_PASSWORD=<pw> -e POSTGRES_DB=<db_name> `
    -p <host_port>:5432 postgres:17-alpine

# 套 schema（容器裡才有 psql）
docker exec -i <name>-db psql -U postgres -d <db_name> < db\schema.sql
docker exec -i <name>-db psql -U postgres -d <db_name> < db\seed.sql
```

**`.env` 的 `DATABASE_URL` 要指到你發佈出來的主機埠**，不是 5432——
除非你確定沒有別的容器佔著它。

`projects.json` 那筆記得補 `stop` 與 `detached`（見 SKILL.md 第 5 節），
Docker 專案不設這兩個，`proj` 會判成「外部佔用」而拒絕停止。

## 驗證

**`curl` 在 PowerShell 5.1 是 `Invoke-WebRequest` 的別名**，參數語法完全不同。
一律打 `curl.exe`：

```powershell
curl.exe -sS http://localhost:<api_port>/health      # 要回 {"ok":true,"db":"ok"}
curl.exe -sS http://localhost:<api_port>/api/items   # 要看到 seed 的兩筆
curl.exe -sS -o NUL -w "%{http_code}`n" http://localhost:<web_port>/
```

打不到就三種位址都試（`localhost`／`127.0.0.1`／`[::1]`）。看埠位用：

```powershell
Get-NetTCPConnection -State Listen -LocalPort <port> | Select-Object LocalAddress,OwningProcess
```

看到 `wslrelay` 或 `com.docker.backend` 佔著埠是正常的，那是容器的埠代理，不要去殺。
其餘見 `env-doctor` 的 windows.md。
