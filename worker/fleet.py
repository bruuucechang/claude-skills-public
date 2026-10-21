#!/usr/bin/env python3
"""fleet.py —— 讀 fleet.yaml，列機器、測連線、查遠端 claude、派 headless 工作。

子指令：
  list                                   表列機器與角色
  ping     [機器]                        先試區網別名，失敗再試 tailnet 別名
  status   [機器]                        查遠端正在跑的 claude 程序（只讀）
  dispatch <機器> <專案相對路徑> <提示詞檔> [--dry-run] [--no-preamble]
                                         把提示詞送過去，在遠端背景跑 claude -p

只用 Python 3 標準庫；有 PyYAML 就用它讀 fleet.yaml，沒有就用下面的極簡解析器
（只支援 fleet.yaml 開頭註解列出的那個子集合）。
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FLEET_FILE = HERE / "fleet.yaml"

SSH_OPTS = ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes"]

# 每份 headless 派工單都要有的開場（dispatch.md A3 與 headless-claude-on-windows 記憶檔）。
# 最後一條是 2026-09-18 在 desk 上踩到的：全域規則叫互動 session「不要前景空等」，
# 在 -p 底下照做會讓背景工作跟著行程一起死。
PREAMBLE = """\
【headless 派工須知（fleet.py 自動加上）】
- 你在一台遠端機器上以 headless 模式（claude -p）執行。沒有人可以回答你的問題，也沒有下一輪對話。
- 需要什麼就同步跑完，不要說「稍後繼續」或「等通知」——那在 -p 底下不存在。
- 不准使用背景執行，所有長工前景等到完；寫散文＝回合結束，做完全部之前不要寫總結。
- 結束碼與最後一行 DONE／FAIL 由外層包裝寫，你不用自己印。

---

"""


# ───────────────────────────── 極簡 YAML 解析器 ─────────────────────────────

class YamlError(Exception):
    pass


def _strip_comment(line: str) -> str:
    """去掉註解：整行 # 或「空白後的 #」；引號內的 # 不算。"""
    out, quote = [], None
    for i, ch in enumerate(line):
        if quote:
            out.append(ch)
            if ch == quote:
                # 單引號裡 '' 是跳脫，下一個字元也是 ' 時不結束
                if quote == "'" and i + 1 < len(line) and line[i + 1] == "'":
                    continue
                quote = None
            continue
        if ch in ("'", '"') and (not out or out[-1] in " :-\t" or "".join(out).strip() == ""):
            quote = ch
            out.append(ch)
            continue
        if ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        out.append(ch)
    return "".join(out).rstrip()


def _scalar(text: str):
    t = text.strip()
    if t == "" or t in ("~", "null", "Null", "NULL"):
        return None
    if t.startswith("'"):
        if not t.endswith("'") or len(t) < 2:
            raise YamlError(f"單引號沒有收尾：{t}")
        return t[1:-1].replace("''", "'")
    if t.startswith('"'):
        if not t.endswith('"') or len(t) < 2:
            raise YamlError(f"雙引號沒有收尾：{t}")
        body = t[1:-1]
        return body.encode("utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8")
    if t[0] in "{[|>&*!":
        raise YamlError(f"極簡解析器不支援這種寫法：{t}")
    if t in ("true", "True", "TRUE"):
        return True
    if t in ("false", "False", "FALSE"):
        return False
    if re.fullmatch(r"[-+]?\d+", t):
        return int(t)
    if re.fullmatch(r"[-+]?\d+\.\d+", t):
        return float(t)
    return t


def _split_key(text: str):
    """'key: value' → (key, value)；不是 mapping 行回 None。"""
    m = re.match(r"^([^'\"\s][^:]*?|'[^']*'|\"[^\"]*\"):(?:\s+(.*))?$", text)
    if not m:
        return None
    key = m.group(1)
    if key[0] in "'\"":
        key = key[1:-1]
    return key, (m.group(2) or "")


def mini_yaml_load(src: str):
    lines = []
    for n, raw in enumerate(src.splitlines(), 1):
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise YamlError(f"第 {n} 行：縮排不能用 tab")
        body = _strip_comment(raw)
        if body.strip() == "":
            continue
        indent = len(body) - len(body.lstrip(" "))
        lines.append((n, indent, body.strip()))

    pos = 0

    def parse_block(indent: int):
        nonlocal pos
        if pos >= len(lines):
            return None
        _, ind, text = lines[pos]
        if text.startswith("- ") or text == "-":
            return parse_list(ind)
        return parse_map(ind)

    def parse_map(indent: int, first: tuple | None = None):
        nonlocal pos
        result = {}
        if first is not None:
            key, val = first
            result[key] = parse_value(val, indent)
        while pos < len(lines):
            n, ind, text = lines[pos]
            if ind < indent:
                break
            if ind > indent:
                raise YamlError(f"第 {n} 行：縮排不對")
            if text.startswith("- "):
                break
            kv = _split_key(text)
            if kv is None:
                raise YamlError(f"第 {n} 行：看不懂（預期 key: value）：{text}")
            pos += 1
            key, val = kv
            if key in result:
                raise YamlError(f"第 {n} 行：重複的 key {key}")
            result[key] = parse_value(val, indent)
        return result

    def parse_value(val: str, indent: int):
        nonlocal pos
        if val.strip() != "":
            return _scalar(val)
        # 空值：下一行更深就是巢狀區塊，否則是 null
        if pos < len(lines) and lines[pos][1] > indent:
            return parse_block(lines[pos][1])
        # list 可以跟 key 同一個縮排（YAML 允許）
        if pos < len(lines) and lines[pos][1] == indent and lines[pos][2].startswith("- "):
            return parse_list(indent)
        return None

    def parse_list(indent: int):
        nonlocal pos
        result = []
        while pos < len(lines):
            n, ind, text = lines[pos]
            if ind != indent or not (text.startswith("- ") or text == "-"):
                if ind > indent:
                    raise YamlError(f"第 {n} 行：縮排不對")
                break
            pos += 1
            item = text[1:].strip()
            if item == "":
                result.append(parse_block(lines[pos][1]) if pos < len(lines) and lines[pos][1] > indent else None)
                continue
            kv = _split_key(item)
            if kv is not None and not item.startswith(("'", '"')):
                # 「- key: value」開頭的 mapping，其餘 key 對齊在 dash 後面
                child_indent = indent + (len(text) - len(text[1:].lstrip()))
                result.append(parse_map(child_indent, first=kv))
            else:
                result.append(_scalar(item))
        return result

    doc = parse_block(0)
    if pos != len(lines):
        n = lines[pos][0]
        raise YamlError(f"第 {n} 行之後沒有解析完")
    return doc


def load_fleet(path: Path = FLEET_FILE) -> dict:
    src = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(src)
    except ImportError:
        data = mini_yaml_load(src)
    if not isinstance(data, dict) or "members" not in data:
        raise SystemExit(f"{path} 格式不對：最外層要有 members")
    return data


def members(fleet: dict) -> list[dict]:
    return list(fleet.get("members") or [])


def find_member(fleet: dict, name: str) -> dict:
    name_l = name.lower()
    for m in members(fleet):
        aliases = {str(m.get("id", "")).lower(), str(m.get("display_name", "")).lower()}
        ssh = m.get("ssh") or {}
        aliases |= {str(v).lower() for v in ssh.values() if v}
        if name_l in aliases:
            return m
    ids = "、".join(str(m.get("id")) for m in members(fleet))
    raise SystemExit(f"找不到機器「{name}」。可用：{ids}")


def workers(fleet: dict) -> list[dict]:
    """有 ssh 別名的才算遠端機器（Air 是本機）。"""
    return [m for m in members(fleet) if any((m.get("ssh") or {}).values())]


def routes(m: dict) -> list[tuple[str, str]]:
    ssh = m.get("ssh") or {}
    out = []
    if ssh.get("lan"):
        out.append(("區網", ssh["lan"]))
    if ssh.get("tailnet"):
        out.append(("tailnet", ssh["tailnet"]))
    return out


# ───────────────────────────── 共用：跑 ssh ─────────────────────────────

def run(cmd: list[str], timeout: int = 30, input_bytes: bytes | None = None):
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout, input=input_bytes)
        return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return 124, "", f"逾時（{timeout} 秒）"


def ssh_cmd(alias: str, remote: str) -> list[str]:
    return ["ssh", *SSH_OPTS, alias, remote]


def try_route(alias: str) -> tuple[bool, str]:
    rc, out, err = run(ssh_cmd(alias, "echo fleet-ok"), timeout=15)
    if rc == 0 and "fleet-ok" in out:
        return True, "通"
    msg = (err.strip().splitlines() or [f"rc={rc}"])[-1]
    return False, msg


def pick_route(m: dict, verbose: bool = True) -> str | None:
    for label, alias in routes(m):
        ok, msg = try_route(alias)
        if verbose:
            print(f"  {label:<7} {alias:<10} {'✓ 通' if ok else '✗ ' + msg}")
        if ok:
            return alias
    return None


def ps_encoded(script: str) -> str:
    """把一段 PowerShell 編成 -EncodedCommand：一個 token 過 ssh＋cmd，不必跟引號搏鬥。
    （多行的 -Command 經過 ssh 會整段不執行且不報錯，見 headless-claude-on-windows。）"""
    prefix = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ProgressPreference='SilentlyContinue';\n"
    b64 = base64.b64encode((prefix + script).encode("utf-16-le")).decode("ascii")
    cmd = f"powershell -NoProfile -NonInteractive -EncodedCommand {b64}"
    if len(cmd) > 8000:  # cmd.exe 一行上限 8191，超過會回「The command line is too long.」
        raise SystemExit(f"PowerShell 片段編碼後 {len(cmd)} 字元，超過 cmd.exe 上限；改成寫檔 scp 過去再 -File 執行")
    return cmd


# ───────────────────────────── list ─────────────────────────────

def cmd_list(fleet: dict, _args) -> int:
    rows = [("id", "顯示名", "角色", "平台", "CPU／記憶體", "區網", "tailnet", "專案根目錄")]
    for m in members(fleet):
        ssh = m.get("ssh") or {}
        cpu = m.get("cpu") or "?"
        cores = f"{m['cores']} 核" if m.get("cores") else "? 核"
        mem = f"{m['memory_gb']} GB" if m.get("memory_gb") is not None else "? GB"
        roots = "、".join(m.get("project_roots") or []) or "-"
        rows.append((
            str(m.get("id")), str(m.get("display_name") or ""), str(m.get("role") or ""),
            str(m.get("platform") or ""), f"{cpu}／{cores}／{mem}",
            ssh.get("lan") or "-", ssh.get("tailnet") or "-", roots,
        ))
    _print_table(rows)
    print()
    for m in members(fleet):
        good = m.get("good_for") or []
        if good:
            print(f"{m.get('id')}：適合 " + "；".join(map(str, good)))
    return 0


def _width(s: str) -> int:
    import unicodedata
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def _print_table(rows):
    widths = [max(_width(r[i]) for r in rows) for i in range(len(rows[0]))]
    for k, r in enumerate(rows):
        print("  ".join(c + " " * (widths[i] - _width(c)) for i, c in enumerate(r)).rstrip())
        if k == 0:
            print("  ".join("─" * w for w in widths))


# ───────────────────────────── ping ─────────────────────────────

def cmd_ping(fleet: dict, args) -> int:
    targets = [find_member(fleet, args.machine)] if args.machine else workers(fleet)
    bad = 0
    for m in targets:
        if not routes(m):
            print(f"{m['id']}：本機，不需要 ssh")
            continue
        print(f"{m['id']}（{m.get('display_name')}）")
        alias = pick_route(m)
        if alias:
            print(f"  → 用 {alias}")
        else:
            print("  → 兩條都不通")
            bad += 1
    return 1 if bad else 0


# ───────────────────────────── status ─────────────────────────────

MAC_STATUS = r"""ps -axo pid=,lstart=,command= | grep -E '[c]laude( |$)|[/]claude ' | grep -v -e 'ps -axo' -e 'grep -E' ; echo FLEET-END"""

WIN_STATUS = r"""
$p = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'")
foreach ($x in $p) {
  $t = $x.CreationDate.ToString('yyyy-MM-dd HH:mm:ss')
  $s = (Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue).SessionId
  Write-Output ("{0}`t{1}`tsession={2}`t{3}" -f $x.ProcessId, $t, $s, $x.CommandLine)
}
Write-Output 'FLEET-END'
"""


def _mode(cmdline: str) -> str:
    if "--chrome-native-host" in cmdline:
        return "Chrome 橋接"
    if re.search(r"(^| )(-p|--print)( |$)", cmdline):
        return "headless"
    return "互動"


def cmd_status(fleet: dict, args) -> int:
    targets = [find_member(fleet, args.machine)] if args.machine else workers(fleet)
    rc_all = 0
    for m in targets:
        if not routes(m):
            print(f"{m['id']}：本機，略過（自己 ps 就好）")
            continue
        print(f"{m['id']}（{m.get('display_name')}）")
        alias = pick_route(m, verbose=False)
        if not alias:
            print("  ✗ 連不上（區網與 tailnet 都不通）——狀態未知，不是「沒有程序」")
            rc_all = 1
            continue
        remote = MAC_STATUS if m.get("platform") == "macos" else ps_encoded(WIN_STATUS)
        rc, out, err = run(ssh_cmd(alias, remote), timeout=40)
        # 三態：有 FLEET-END 才算 ssh 有回答；沒有就是「不知道」，不能當成沒有程序
        if "FLEET-END" not in out:
            print(f"  ? 經 {alias} 查詢沒有完整回答（rc={rc}）：{err.strip()[:200]}")
            rc_all = 1
            continue
        procs = [l for l in out.splitlines() if l.strip() and l.strip() != "FLEET-END"]
        if not procs:
            print(f"  經 {alias}：沒有 claude 程序")
            continue
        print(f"  經 {alias}：{len(procs)} 個 claude 程序")
        for l in procs:
            if m.get("platform") == "macos":
                parts = l.split()
                pid, start, cmdline = parts[0], " ".join(parts[1:6]), " ".join(parts[6:])
                mode = _mode(cmdline)
                print(f"    pid {pid:<7} 啟動 {start}  [{mode}]  {cmdline[:120]}")
            else:
                f = l.split("\t")
                pid, start, sess, cmdline = (f + ["", "", "", ""])[:4]
                mode = _mode(cmdline)
                print(f"    pid {pid:<7} 啟動 {start}  {sess}  [{mode}]  {cmdline[:120]}")
    return rc_all


# ───────────────────────────── dispatch ─────────────────────────────

def _safe_id(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-") or "job"


def _win_job_ps1(claude: str, cwd: str, job_dir: str, task: str) -> str:
    """遠端 Windows 上排程工作要跑的腳本。必須是純 ASCII：
    PS 5.1 讀無 BOM 的 UTF-8 會當 big5，中文會把引號吃掉（dispatch.md B 節）。"""
    s = f"""# fleet.py generated job runner (pure ASCII on purpose)
$ErrorActionPreference = 'Continue'
$dir    = '{job_dir}'
$log    = Join-Path $dir 'run.log'
$prompt = Join-Path $dir 'prompt.md'
$utf8   = New-Object Text.UTF8Encoding($false)
function Mark($t) {{ [IO.File]::AppendAllText($log, $t + "`r`n", [Text.Encoding]::ASCII) }}
Mark ('START ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' pid=' + $PID)
$rc = 1
try {{
  $OutputEncoding = $utf8
  try {{ [Console]::OutputEncoding = $utf8; [Console]::InputEncoding = $utf8 }} catch {{ Mark 'WARN console encoding not set' }}
  Set-Location -LiteralPath '{cwd}' -ErrorAction Stop
  $out = Get-Content -LiteralPath $prompt -Raw -Encoding UTF8 | & '{claude}' -p 2>&1
  $rc = $LASTEXITCODE
  [IO.File]::AppendAllText($log, (($out | ForEach-Object {{ "$_" }}) -join "`r`n") + "`r`n", $utf8)
}} catch {{
  [IO.File]::AppendAllText($log, ('EXCEPTION ' + $_.Exception.Message) + "`r`n", $utf8)
  $rc = 99
}}
try {{ Unregister-ScheduledTask -TaskName '{task}' -Confirm:$false -ErrorAction Stop }} catch {{ Mark ('WARN task not removed: ' + $_.Exception.Message) }}
if ($rc -eq 0) {{ Mark 'DONE' }} else {{ Mark ('FAIL rc=' + $rc) }}
"""
    s.encode("ascii")  # 有非 ASCII 字元就讓它在本機炸，不要送過去才安靜失敗
    return s


def _win_start_ps(job_dir: str, task: str, user: str) -> str:
    # S4U：跑在 session 0，不在使用者桌面彈黑視窗，沒人登入也會跑（windows-task-black-window）。
    # 觸發時間給 2099 年：/st 到了真的會自己跑（headless-claude-on-windows 2026-10-01 事故），
    # 實際靠 Start-ScheduledTask 啟動。Start-ScheduledTask 對啟不動的工作也回成功，
    # 所以要回頭確認 State（palrogue-autopilot-controls）。
    return f"""
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "{job_dir}\\job.ps1"'
$t = New-ScheduledTaskTrigger -Once -At ([datetime]'2099-12-31T00:00:00')
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName '{task}' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName '{task}'
Start-Sleep -Seconds 3
$st = (Get-ScheduledTask -TaskName '{task}' -ErrorAction SilentlyContinue).State
Write-Output ('FLEET-TASK-STATE ' + $st)
"""


def cmd_dispatch(fleet: dict, args) -> int:
    m = find_member(fleet, args.machine)
    if not routes(m):
        raise SystemExit(f"{m['id']} 是本機，不用派工")
    prompt_src = Path(args.prompt_file).expanduser()
    if not prompt_src.is_file():
        raise SystemExit(f"找不到提示詞檔：{prompt_src}")
    text = prompt_src.read_text(encoding="utf-8")
    if not args.no_preamble:
        text = PREAMBLE + text

    platform = m.get("platform")
    claude = m.get("claude_path")
    if not claude:
        raise SystemExit(f"{m['id']} 的 claude_path 在 fleet.yaml 裡是空的，先補上再派")
    roots = list(m.get("project_roots") or [])
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    job_id = f"{stamp}-{_safe_id(Path(args.project.replace(chr(92), '/')).name)}"
    dry = args.dry_run

    # 走哪條：dry-run 不連線，直接寫區網別名並註明
    if dry:
        alias = routes(m)[0][1]
        print(f"# [dry-run] 不連線、不寫任何東西。實際執行時會先 ping，區網不通才換 {routes(m)[-1][1]}。")
    else:
        print(f"選路：")
        alias = pick_route(m)
        if not alias:
            print("兩條都不通，沒有派。")
            return 1

    steps: list[tuple[str, list[str], str | None]] = []  # (說明, 指令, 編碼前的 PowerShell)
    local_files: list[tuple[str, str]] = []  # (遠端檔名, 內容)

    if platform == "macos":
        user_home = f"/Users/{m.get('user')}"
        job_dir = f"{user_home}/fleet-jobs/{job_id}"
        if os.path.isabs(args.project):
            cwd_candidates = [args.project]
        else:
            cwd_candidates = [f"{r.rstrip('/')}/{args.project}" for r in roots]
        env = " ".join(f"{k}={shlex.quote(str(v))}" for k, v in (m.get("claude_env") or {}).items())
        # 找第一個存在的專案目錄；都不存在就讓遠端失敗並說清楚
        find_cwd = " ".join(shlex.quote(c) for c in cwd_candidates)
        job_sh = f"""#!/bin/bash
# fleet.py 產生的工作包裝：跑 claude -p，最後一行一定寫 DONE 或 FAIL rc=N
dir={shlex.quote(job_dir)}
log="$dir/run.log"
cwd=''
for c in {find_cwd}; do [ -d "$c" ] && {{ cwd="$c"; break; }}; done
echo "START $(date '+%Y-%m-%d %H:%M:%S') pid=$$ cwd=$cwd" >> "$log"
if [ -z "$cwd" ]; then echo 'FAIL rc=2' >> "$log"; exit 2; fi
cd "$cwd" || {{ echo 'FAIL rc=3' >> "$log"; exit 3; }}
{env + ' ' if env else ''}{shlex.quote(claude)} -p < "$dir/prompt.md" >> "$log" 2>&1
rc=$?
if [ $rc -eq 0 ]; then echo DONE >> "$log"; else echo "FAIL rc=$rc" >> "$log"; fi
"""
        local_files.append(("prompt.md", text))
        local_files.append(("job.sh", job_sh))
        steps.append(("建工作目錄", ssh_cmd(alias, f"mkdir -p {shlex.quote(job_dir)}"), None))
        steps.append(("送提示詞與 job.sh", ["scp", *SSH_OPTS, "<本機暫存>/prompt.md", "<本機暫存>/job.sh", f"{alias}:{job_dir}/"], None))
        # nohup＋stdio 全部導走＋&：ssh 立刻返回，連線斷了也不會把它帶走
        launch = f"nohup bash {shlex.quote(job_dir + '/job.sh')} >/dev/null 2>&1 </dev/null & echo FLEET-LAUNCHED $!"
        steps.append(("背景啟動", ssh_cmd(alias, launch), None))
        log_path = f"{job_dir}/run.log"
        watch = [
            f"ssh {alias} 'tail -n 1 {log_path}'                 # 最後一行是 DONE 或 FAIL rc=N 就結束了",
            f"ssh {alias} 'tail -n 40 {log_path}'                # 看輸出",
            f"scp {alias}:{log_path} .                            # 拉回來",
            f"ssh {alias} 'rm -rf {job_dir}'                      # 收尾（看完結果再清）",
        ]
        wait_loop = (
            f"while :; do out=$(ssh -n -o ConnectTimeout=10 {alias} 'tail -n 1 {log_path}' 2>/dev/null); "
            f"case \"$out\" in DONE|FAIL*) echo \"$out\"; break;; '') echo 'ssh 沒回答或還沒寫，繼續等';; esac; sleep 30; done"
        )
    elif platform == "windows":
        user = m.get("user")
        base = m.get("job_dir") or f"C:\\Users\\{user}\\fleet-jobs"
        job_dir = f"{base}\\{job_id}"
        task = f"fleet-{job_id}"
        if re.match(r"^[A-Za-z]:[\\/]", args.project):
            cwd = args.project.replace("/", "\\")
        else:
            if not roots:
                raise SystemExit(f"{m['id']} 沒有 project_roots")
            cwd = roots[0].rstrip("\\") + "\\" + args.project.replace("/", "\\")
        for label, v in (("專案路徑", cwd), ("工作目錄", job_dir), ("claude 路徑", claude)):
            if not v.isascii() or "'" in v:
                raise SystemExit(f"{label} 含非 ASCII 或單引號，job.ps1 必須是純 ASCII：{v}")
        job_ps1 = _win_job_ps1(claude, cwd, job_dir, task)
        local_files.append(("prompt.md", text))
        local_files.append(("job.ps1", job_ps1))
        scp_dir = job_dir.replace("\\", "/")
        check_cwd = (
            f"New-Item -ItemType Directory -Force -Path '{job_dir}' | Out-Null\n"
            f"if (Test-Path -LiteralPath '{cwd}') {{ 'FLEET-CWD-OK' }} else {{ 'FLEET-CWD-MISSING' }}\n"
        )
        start_ps = _win_start_ps(job_dir, task, user)
        steps.append(("建工作目錄並確認專案存在", ssh_cmd(alias, ps_encoded(check_cwd)), check_cwd))
        steps.append(("送提示詞與 job.ps1", ["scp", *SSH_OPTS, "<本機暫存>/prompt.md", "<本機暫存>/job.ps1", f"{alias}:{scp_dir}/"], None))
        steps.append(("註冊 S4U 排程工作並啟動", ssh_cmd(alias, ps_encoded(start_ps)), start_ps))
        log_path = f"{job_dir}\\run.log"
        watch = [
            f"ssh {alias} \"powershell -NoProfile -Command Get-Content '{log_path}' -Tail 1\"   # DONE 或 FAIL rc=N 就結束了",
            f"ssh {alias} \"powershell -NoProfile -Command Get-Content '{log_path}' -Tail 40 -Encoding UTF8\"",
            f"scp {alias}:{scp_dir}/run.log .",
            f"python3 {HERE / 'fleet.py'} status {m['id']}                        # 看 claude 程序還在不在",
            f"ssh {alias} \"rmdir /s /q {job_dir}\"                                # 收尾（看完結果再清）",
        ]
        wait_loop = (
            f"while :; do out=$(ssh -n -o ConnectTimeout=10 {alias} \"powershell -NoProfile -Command Get-Content '{log_path}' -Tail 1\" 2>/dev/null | tr -d '\\r'); "
            f"case \"$out\" in DONE|FAIL*) echo \"$out\"; break;; '') echo 'ssh 沒回答或還沒寫，繼續等';; esac; sleep 30; done"
        )
    else:
        raise SystemExit(f"不認得的平台：{platform}")

    print(f"機器：{m['id']}（{m.get('display_name')}）  走：{alias}")
    print(f"工作：{job_id}")
    print(f"遠端工作目錄：{job_dir}")
    print()

    if dry:
        print("# 會送過去的檔案：")
        for name, content in local_files:
            print(f"#   {name}（{len(content.encode('utf-8'))} bytes）")
        print()
        for i, (label, cmd, decoded) in enumerate(steps, 1):
            print(f"# {i}. {label}")
            print(" ".join(c if c.startswith("<") else shlex.quote(c) for c in cmd))
            if decoded:
                print(f"# 　└ -EncodedCommand 解開後（前面另加一行設 UTF-8 輸出）：")
                for l in decoded.strip("\n").splitlines():
                    print(f"#   {l}")
            print()
        for name, content in local_files:
            if name.startswith("job."):
                print(f"# ── {name} 內容 ──")
                print(content)
        print("# 提示詞前 12 行：")
        for l in text.splitlines()[:12]:
            print(f"#   {l}")
        print()
        _print_watch(watch, wait_loop)
        return 0

    # ── 真的執行 ──
    with tempfile.TemporaryDirectory(prefix="fleet-") as tmp:
        for name, content in local_files:
            Path(tmp, name).write_text(content, encoding="utf-8", newline="")
        for i, (label, cmd, _decoded) in enumerate(steps, 1):
            cmd = [c.replace("<本機暫存>", tmp) for c in cmd]
            print(f"[{i}/{len(steps)}] {label} …", flush=True)
            rc, out, err = run(cmd, timeout=120)
            if rc != 0:
                print(f"  ✗ 失敗 rc={rc}\n{out}{err}")
                print(f"  遠端可能留下 {job_dir}，要清請手動處理。")
                return 1
            if "FLEET-CWD-MISSING" in out:
                print(f"  ✗ 專案目錄不存在：{cwd}")
                return 1
            if label.startswith("註冊") and "FLEET-TASK-STATE Running" not in out:
                print(f"  ? 排程工作狀態不是 Running：{out.strip()}（Start-ScheduledTask 對啟不動的工作也回成功）")
                print("    去看 run.log 有沒有 START 行再判斷。")
            out_s = out.strip()
            if out_s:
                print(f"  {out_s.splitlines()[-1]}")
    print()
    _print_watch(watch, wait_loop)
    return 0


def _print_watch(watch: list[str], wait_loop: str):
    print("查進度：")
    for w in watch:
        print(f"  {w}")
    print()
    print("等它結束（在 Claude Code 裡用 Bash 的 run_in_background 跑；三態：沒回答≠結束）：")
    print(f"  {wait_loop}")


# ───────────────────────────── main ─────────────────────────────

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="fleet.py", description="讀 fleet.yaml 管理 worker 機隊")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="表列機器與角色")
    p = sub.add_parser("ping", help="測區網／tailnet 哪條通")
    p.add_argument("machine", nargs="?")
    p = sub.add_parser("status", help="查遠端 claude 程序（只讀）")
    p.add_argument("machine", nargs="?")
    p = sub.add_parser("dispatch", help="派 headless claude -p 工作")
    p.add_argument("machine")
    p.add_argument("project", help="專案相對於 project_roots 的路徑（也可給絕對路徑）")
    p.add_argument("prompt_file")
    p.add_argument("--dry-run", action="store_true", help="只印出會執行的指令，不連線、不寫任何東西")
    p.add_argument("--no-preamble", action="store_true", help="不要自動加 headless 派工須知")
    args = ap.parse_args(argv)
    fleet = load_fleet()
    return {"list": cmd_list, "ping": cmd_ping, "status": cmd_status, "dispatch": cmd_dispatch}[args.cmd](fleet, args)


if __name__ == "__main__":
    sys.exit(main())
