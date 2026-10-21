#!/usr/bin/env python3
"""cx — 讓 Claude Code 在背景 tmux 裡驅動 Codex 互動畫面。規格見同目錄 SPEC.md。

  cx.py start <專案目錄>          建／找 tmux session codex-<名>（不開視窗；要看自己 tmux attach -t <名>）
  cx.py send  <名> <工作單檔>     把工作單貼進 Codex 並送出
  cx.py wait  <名> [逾時秒]       等這一輪結束；印出 Codex 最後的回覆與 context 用量
                                  退出碼 0 成功／2 崩潰／3 逾時／4 帶錯誤結束／5 暫時性錯誤可重送／6 停滯（多半卡在提示）
  cx.py status <名>               context 用量、額度、session 是否還活著
  cx.py screen <名>               印出目前畫面（看它卡在哪個提示）
  cx.py keys  <名> <按鍵...>      送按鍵（例如 Enter、Escape、y）
  cx.py close-window <名>         關掉舊版開過的 Terminal 視窗（tmux 留著；新版不再開視窗）
  cx.py kill  <名>                結束 tmux session 與視窗（換新對話前用）

結束判斷讀 Codex 自己寫的 rollout（~/.codex/sessions/**.jsonl）的 task_complete，
不靠畫面文字猜（只認主對話：Auto-review 審查員的同 cwd rollout 要排除）；context 用量 = 最後一次 last_token_usage.input_tokens / model_context_window。
"""
import glob, json, os, shlex, subprocess, sys, time

STATE_DIR = os.path.expanduser("~/.cache/codex-drive")
SESSIONS = os.path.expanduser("~/.codex/sessions")
IDLE_KILL_SEC = 2 * 3600          # 閒置 2 小時自動結束（SPEC 的假設）
HANDOFF_PCT = 50                  # context 用到 50% 就換新對話
SKILLS_OFF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker-skills-off.txt")
DOC_MAX = 32 * 1024               # Codex 的 project_doc_max_bytes 預設值；超過的部分安靜截掉
STALL_SEC = 900                   # rollout 15 分鐘沒寫入＝多半卡在提示；只是長指令就再 wait 一次
NO_ROLLOUT_SEC = 120              # 送出 2 分鐘還沒建 rollout＝工作單沒送進去（多半停在開場提示）
TRANSIENT = ("at capacity", "stream disconnected", "overloaded")   # 2026-10-07／09 兩次「Selected model is at capacity」，重送就好


def skills_off_arg():
    """關掉 Codex 當工人用不到的 skill（-c 才有效，-p profile 實測無效；2026-10-13 量到每次請求省約 2.4K tokens）。"""
    try:
        names = [l.strip() for l in open(SKILLS_OFF) if l.strip() and not l.startswith("#")]
    except OSError:
        return []
    home = os.path.expanduser("~/.codex/skills")
    items = ",".join(f'{{path="{home}/{n}/SKILL.md",enabled=false}}' for n in names
                     if os.path.exists(f"{home}/{n}/SKILL.md"))
    return ["-c", f"skills.config=[{items}]"] if items else []


def check_agents_md(cwd):
    """Codex 只讀專案 AGENTS.md（git 根到 cwd 一路疊加）的前 32 KiB，後面的規則它看不到也不會警告。"""
    root = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                          capture_output=True, text=True).stdout.strip() or cwd
    total, d, files = 0, cwd, []
    while True:
        for n in ("AGENTS.override.md", "AGENTS.md"):
            f = os.path.join(d, n)
            if os.path.isfile(f):
                total += os.path.getsize(f); files.append(f); break
        if os.path.realpath(d) == os.path.realpath(root) or d == os.path.dirname(d):
            break
        d = os.path.dirname(d)
    if total > DOC_MAX:
        print(f"!! 專案 AGENTS.md 共 {total} bytes，超過 Codex 讀得到的 {DOC_MAX}：超出的部分 Codex 看不到。"
              f"把只有特定工作才用到的段落搬到 docs/（做法見 animyria 2026-10-13 那次）：{' '.join(files)}",
              file=sys.stderr)


def sh(*a, check=True, capture=True):
    r = subprocess.run(a, text=True, capture_output=capture)
    if check and r.returncode != 0:
        sys.exit(f"指令失敗：{' '.join(a)}\n{r.stderr}")
    return r.stdout if capture else ""


def tmux_alive(name):
    return subprocess.run(["tmux", "has-session", "-t", name], capture_output=True).returncode == 0


def state_path(name):
    return os.path.join(STATE_DIR, name + ".json")


def load(name):
    try:
        return json.load(open(state_path(name)))
    except (OSError, ValueError):
        return {}


def save(name, st):
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(st, open(state_path(name), "w"), ensure_ascii=False, indent=1)


def is_main_thread(p):
    """Auto-review 的審查員也寫一份同 cwd 的 rollout（thread_source=guardian_review、帶 parent_thread_id），
    而且每審一次就 task_complete 一次；挑到它的話 wait 會在 Codex 還沒做完時就回報結束（2026-10-20 量到）。"""
    return not p.get("parent_thread_id") and p.get("thread_source", "user") == "user" and p.get("source", "cli") == "cli"


def find_rollout(cwd, since):
    """since 之後建立、cwd 相符的最新主對話 rollout（排除審查員等子對話）。"""
    best = None
    for f in glob.glob(os.path.join(SESSIONS, "**", "rollout-*.jsonl"), recursive=True):
        if os.path.getmtime(f) < since - 5:
            continue
        try:
            with open(f) as fh:
                meta = json.loads(fh.readline())
        except (OSError, ValueError):
            continue
        p = meta.get("payload", {})
        if meta.get("type") == "session_meta" and is_main_thread(p) and os.path.realpath(p.get("cwd", "")) == os.path.realpath(cwd):
            if best is None or os.path.getmtime(f) > os.path.getmtime(best):
                best = f
    return best


def rollout(name, st, wait_sec=0):
    """回傳 rollout 路徑；Codex 第一次送出訊息後才會建檔，所以可以等一下。"""
    if st.get("rollout") and os.path.exists(st["rollout"]):
        try:
            with open(st["rollout"]) as fh:
                if is_main_thread(json.loads(fh.readline()).get("payload", {})):
                    return st["rollout"]
        except (OSError, ValueError):
            pass
        st.pop("rollout")                 # 舊版存到審查員的 rollout：重找
    end = time.time() + wait_sec
    while True:
        f = find_rollout(st["cwd"], st["started"])
        if f:
            st["rollout"] = f
            save(name, st)
            return f
        if time.time() >= end:
            return None
        time.sleep(1)


def scan(f):
    """task_complete 次數、最後回覆、最後錯誤、context %、額度。"""
    done, last_msg, last_err, ctx, limits = 0, None, None, None, None
    with open(f) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            p = d.get("payload") or {}
            if d.get("type") != "event_msg":
                continue
            if p.get("type") == "task_complete":
                done += 1
                last_msg = p.get("last_agent_message")
                last_err = (p.get("error") or {}).get("message")
            elif p.get("type") == "token_count":
                info = p.get("info") or {}
                win = info.get("model_context_window")
                used = (info.get("last_token_usage") or {}).get("input_tokens")
                if win and used is not None:
                    ctx = round(used * 100 / win, 1)
                limits = p.get("rate_limits") or limits
    return done, last_msg, last_err, ctx, limits


def close_window(st):
    wid = st.pop("window", None)
    if wid:
        subprocess.run(["osascript", "-e",
                        f'tell application "Terminal" to close (every window whose id is {wid}) saving no'],
                       capture_output=True)


def spawn_reaper(name):
    """背景守門：tmux 還活著但 rollout 閒置超過 IDLE_KILL_SEC 就結束它；session 沒了它自己退出。"""
    code = f"""
import os,time,subprocess,json
n={name!r}; sp={state_path(name)!r}; lim={IDLE_KILL_SEC}
while subprocess.run(['tmux','has-session','-t',n],capture_output=True).returncode==0:
    try: st=json.load(open(sp)); f=st.get('rollout'); t=os.path.getmtime(f) if f else st['started']
    except Exception: t=time.time()
    if time.time()-t>lim:
        subprocess.run(['tmux','kill-session','-t',n]); break
    time.sleep(60)
"""
    subprocess.Popen([sys.executable, "-c", code], start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cmd_start(path):
    cwd = os.path.realpath(os.path.expanduser(path))
    if not os.path.isdir(cwd):
        sys.exit(f"沒有這個目錄：{cwd}")
    name = "codex-" + os.path.basename(cwd).replace(".", "_")
    st = load(name)
    if not tmux_alive(name):
        st = {"cwd": cwd, "started": time.time()}
        check_agents_md(cwd)
        sh("tmux", "new-session", "-d", "-s", name, "-x", "160", "-y", "48", "-c", cwd,
           shlex.join(["codex", *skills_off_arg()]))
        sh("tmux", "set-option", "-t", name, "remain-on-exit", "on")   # Codex 崩潰時畫面留著看得到原因
        spawn_reaper(name)
    # 不開 Terminal 視窗（2026-10-11 使用者裁示：工作不准搶畫面）。
    # 他的四宮格就是 Terminal，do script 開的新視窗一定跳到最前面、還會被 quad 重排。
    save(name, st)
    print(name)
    print(f"要看畫面：tmux attach -t {name}", file=sys.stderr)


def need(name):
    st = load(name)
    if not st:
        sys.exit(f"沒有 {name} 的狀態，先跑 cx.py start <目錄>")
    return st


def cmd_send(name, file):
    st = need(name)
    if not tmux_alive(name):
        sys.exit(f"{name} 已經不在了")
    f = rollout(name, st)
    st["done_before"] = scan(f)[0] if f else 0
    st["sent"] = time.time()
    save(name, st)
    sh("tmux", "load-buffer", "-b", "cx", file)
    sh("tmux", "paste-buffer", "-p", "-d", "-b", "cx", "-t", name)    # -p：bracketed paste，換行不會被當成送出
    time.sleep(0.8)
    sh("tmux", "send-keys", "-t", name, "Enter")
    print("已送出")


def pane_dead(name):
    out = subprocess.run(["tmux", "display-message", "-p", "-t", name, "#{pane_dead}"],
                         capture_output=True, text=True).stdout.strip()
    return out == "1"


def cmd_wait(name, timeout="3600"):
    st = need(name)
    end = time.time() + float(timeout)
    before = st.get("done_before", 0)
    while time.time() < end:
        if not tmux_alive(name) or pane_dead(name):
            print("!! Codex 已經結束／崩潰。最後畫面：")
            print(subprocess.run(["tmux", "capture-pane", "-p", "-t", name], capture_output=True, text=True).stdout)
            sys.exit(2)
        f = rollout(name, st)
        if f:
            done, msg, err, ctx, _ = scan(f)
            if done > before:
                print(f"== 這一輪結束  context {'未知' if ctx is None else f'{ctx}%'}" + ("  → 已達換新對話門檻" if ctx and ctx >= HANDOFF_PCT else ""))
                if err:
                    print(f"!! 錯誤：{err}")
                transient = bool(err) and any(k in err.lower() for k in TRANSIENT)
                if transient:
                    print("!! 暫時性錯誤（伺服器滿載／連線斷）：等 1–2 分鐘後送一行「繼續」再 wait，不算退回次數")
                print(msg or "(沒有回覆文字)")
                # 有錯誤就不是成功：額度用完也會「正常結束這一輪」。5＝暫時性可重送，4＝其他錯誤（含額度用完）
                sys.exit(5 if transient else 4 if err else 0)
        # 卡在提示畫面（信任資料夾、核准、Hooks need review）時 rollout 一個字都不寫，不偵測就乾等到逾時
        last = os.path.getmtime(f) if f else st.get("sent", st["started"])
        if time.time() - max(last, st.get("sent", 0)) > (STALL_SEC if f else NO_ROLLOUT_SEC):
            print(f"!! {'rollout' if f else '送出後還沒有 rollout，'} {int(time.time() - max(last, st.get('sent', 0)))} 秒沒動，可能卡在提示。目前畫面：")
            print(subprocess.run(["tmux", "capture-pane", "-p", "-t", name], capture_output=True, text=True).stdout)
            sys.exit(6)
        time.sleep(3)
    print(f"!! 等了 {timeout} 秒還沒結束。目前畫面：")
    print(subprocess.run(["tmux", "capture-pane", "-p", "-t", name], capture_output=True, text=True).stdout)
    sys.exit(3)


def cmd_status(name):
    st = need(name)
    alive = tmux_alive(name) and not pane_dead(name)
    f = rollout(name, st)
    print(f"session {'活著' if alive else '已結束'}  rollout {f or '尚未建立'}")
    if f:
        done, _, err, ctx, lim = scan(f)
        print(f"已完成 {done} 輪  context {'未知' if ctx is None else f'{ctx}%'}  門檻 {HANDOFF_PCT}%")
        if err:
            print(f"最後一輪的錯誤：{err}")
        if lim and lim.get("primary"):
            p = lim["primary"]
            print(f"額度（rollout 讀數，可能是舊的）：已用 {p.get('used_percent')}%  重置 {time.strftime('%m-%d %H:%M', time.localtime(p.get('resets_at', 0)))}")


def cmd_screen(name):
    print(sh("tmux", "capture-pane", "-p", "-t", name))


def cmd_keys(name, *keys):
    sh("tmux", "send-keys", "-t", name, *keys)


def cmd_close_window(name):
    st = need(name)
    close_window(st)
    save(name, st)


def cmd_kill(name):
    st = load(name)
    close_window(st)
    subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)
    try:
        os.remove(state_path(name))
    except OSError:
        pass
    print(f"{name} 已結束")


if __name__ == "__main__":
    cmds = {"start": cmd_start, "send": cmd_send, "wait": cmd_wait, "status": cmd_status,
            "screen": cmd_screen, "keys": cmd_keys, "close-window": cmd_close_window, "kill": cmd_kill}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    cmds[sys.argv[1]](*sys.argv[2:])
