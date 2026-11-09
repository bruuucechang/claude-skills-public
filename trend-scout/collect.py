#!/usr/bin/env python3
"""每週熱門 repo 的候選清單（trend-scout 第 1 步，不花 Claude 額度）。

來源兩個：github.com/trending 週榜（全語言，HTML）＋ GitHub 搜尋 API 的 AI 代理主題
（近 30 天建立、依星數）。去掉 seen.json（{repo: 分析日期}）裡看過的——週榜上又出現、且距上次分析 ≥ 4 週的例外，
重新列入並標 "reseen"。印 JSON 到 stdout。

主題搜尋給不出「這週漲多少」，所以每次把看到的星數存成快照（seen.json 旁邊的 stars.json，
{日期: {repo: 星數}}），下次拿隔 ≥ 5 天的那份算差值、換算成 7 天，填進 stars_week；
另外算 per_day（星數／建立天數），沒有快照時拿它排序，不再只看總星數。
做法改寫自 zhuyansen/new-term-radar@3cf6515c4076 radar/breakout.py（MIT），程式是自己重寫的。

  python3 collect.py [--seen 檔] [--stars 檔] [--html 檔] [--search-json 檔…] [--limit 40] [--today YYYY-MM-DD]

--html／--search-json 給檔案就不連網（測試用 fixture）；這時沒給 --stars 就不讀也不寫快照。
"""
import argparse, datetime as dt, html as H, json, re, subprocess, sys, urllib.request
from pathlib import Path

TRENDING = "https://github.com/trending?since=weekly"
TOPICS = ["claude-code", "agent-skills", "claude-skills", "mcp", "ai-agents"]


def num(s):
    return int(re.sub(r"[^\d]", "", s) or 0)


def parse_trending(text):
    out = []
    for art in text.split('<article class="Box-row')[1:]:
        m = re.search(r'<h2[^>]*>.*?href="/([^"/]+/[^"/]+)"', art, re.S)
        if not m:
            continue
        name = m.group(1)
        desc = re.search(r'<p class="col-9[^"]*">(.*?)</p>', art, re.S)
        lang = re.search(r'itemprop="programmingLanguage">([^<]*)<', art)
        # 星數前面夾著一個 <svg>，取整個 <a> 去掉標籤再讀數字
        stars = re.search(r'href="/%s/stargazers"[^>]*>(.*?)</a>' % re.escape(name), art, re.S)
        week = re.search(r"([\d,]+) stars this week", art)
        out.append({
            "name": name,
            "description": H.unescape(re.sub(r"\s+", " ", desc.group(1)).strip()) if desc else "",
            "language": lang.group(1).strip() if lang else "",
            "stars": num(re.sub(r"<.*?>", "", stars.group(1), flags=re.S)) if stars else 0,
            "stars_week": num(week.group(1)) if week else 0,
            "source": "trending",
        })
    return out


def parse_search(data, topic):
    return [{
        "name": it["full_name"],
        "description": it.get("description") or "",
        "language": it.get("language") or "",
        "stars": it.get("stargazers_count", 0),
        "stars_week": None,
        "license": (it.get("license") or {}).get("spdx_id") or "",
        "topics": it.get("topics", []),
        "created": (it.get("created_at") or "")[:10],
        "source": f"topic:{topic}",
    } for it in data.get("items", [])]


def fetch_trending():
    req = urllib.request.Request(TRENDING, headers={"User-Agent": "trend-scout"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def fetch_search(topic, since):
    q = f"topic:{topic} created:>{since}"
    r = subprocess.run(["gh", "api", "-X", "GET", "search/repositories", "-f", f"q={q}",
                        "-f", "sort=stars", "-f", "per_page=15"],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"gh search {topic}: {r.stderr.strip()}")
    return json.loads(r.stdout)


RESEE_DAYS = 28
STARS_GAP_DAYS = 5    # 同一週的重跑（隔天補跑）不拿來算週增星
STARS_KEEP_DAYS = 35


def skip(c, seen, today):
    when = seen.get(c["name"].lower())
    if when is None:
        return False
    if c["source"] == "trending":
        try:
            if (today - dt.date.fromisoformat(when)).days >= RESEE_DAYS:
                c["reseen"] = when
                return False
        except ValueError:
            pass
    return True


def load_seen(path):
    p = Path(path)
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text())
    except (ValueError, OSError) as e:
        # 壞掉的 seen 不能讓每天都失敗：當成空的，最多多看一次
        print(f"collect: seen 讀不懂（{e}），當成空的", file=sys.stderr)
        return {}
    if isinstance(d, list):  # 舊格式：沒日期，當成今天看的（寧可晚點重看）
        d = dict.fromkeys(d, dt.date.today().isoformat())
    return {k.lower(): v for k, v in d.items()} if isinstance(d, dict) else {}


def load_stars(path):
    p = Path(path)
    try:
        d = json.loads(p.read_text())
    except FileNotFoundError:
        return {}
    except (ValueError, OSError) as e:
        print(f"collect: 星數快照讀不懂（{e}），當成沒有", file=sys.stderr)
        return {}
    return d if isinstance(d, dict) else {}


def add_growth(lists, hist, today):
    """主題搜尋的候選補上 per_day，有夠舊的快照就補 stars_week（換算成 7 天）。"""
    olds = []  # 新到舊；某天哪個主題搜尋失敗、少了那批 repo，就往更舊的找
    for day in sorted(hist, reverse=True):
        try:
            gap = (today - dt.date.fromisoformat(day)).days
        except ValueError:
            continue
        if gap >= STARS_GAP_DAYS and isinstance(hist[day], dict):
            olds.append((gap, hist[day]))
    for lst in lists:
        for c in lst:
            if c.get("created"):
                try:
                    # 至少算 7 天：昨天建的 80 星不該排在一個月 1200 星前面
                    age = max((today - dt.date.fromisoformat(c["created"])).days, 7)
                    c["per_day"] = round(c["stars"] / age)
                except ValueError:
                    pass
            if c["stars_week"] is not None:
                continue
            for gap, snap in olds:
                before = snap.get(c["name"].lower())
                if isinstance(before, int) and 0 < before <= c["stars"]:
                    c["stars_week"] = round((c["stars"] - before) * 7 / gap)
                    c["stars_week_from"] = f"快照 {gap} 天前"
                    break


def save_stars(path, hist, lists, today):
    hist = {k: v for k, v in hist.items()
            if k[:1].isdigit() and (today - dt.timedelta(days=STARS_KEEP_DAYS)).isoformat() <= k <= today.isoformat()}
    # 同一天重跑就併進去，不蓋掉前一次看到的；週榜解析失敗的 0 不存（會變成假的爆紅基準）
    day = hist.setdefault(today.isoformat(), {})
    if not isinstance(day, dict):
        day = hist[today.isoformat()] = {}
    day.update({c["name"].lower(): c["stars"] for lst in lists for c in lst if c["stars"] > 0})
    try:
        p = Path(path)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(hist, indent=0, sort_keys=True))
        tmp.replace(p)
    except OSError as e:  # 存不了只是下週少一個訊號，不讓整份失敗
        print(f"collect: 星數快照存不了（{e}）", file=sys.stderr)


def merge(lists, seen, limit, today=None):
    today = today or dt.date.today()
    by = {}
    for lst in lists:
        for c in lst:
            k = c["name"].lower()
            if skip(c, seen, today):
                continue
            if k in by:
                old = by[k]
                old["source"] += "," + c["source"]
                for f in ("license", "topics", "created", "per_day"):
                    old.setdefault(f, c.get(f))
                if not old["stars_week"] and c["stars_week"]:  # 週榜沒讀到數字才拿快照估的，並帶上來源
                    old["stars_week"] = c["stars_week"]
                    if c.get("stars_week_from"):
                        old["stars_week_from"] = c["stars_week_from"]
            else:
                by[k] = dict(c)
    # 照「一週大概漲幾顆」排：有週增星（週榜的、或快照算的）用它，沒有就拿 per_day×7 估，再照總星數
    def week(c):
        return c["stars_week"] if c["stars_week"] is not None else (c.get("per_day") or 0) * 7
    rows = sorted(by.values(), key=lambda c: (-week(c), -c["stars"]))
    return rows[:limit]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seen", default=str(Path.home() / ".claude/state/trend-scout/seen.json"))
    ap.add_argument("--html")
    ap.add_argument("--search-json", nargs="*")
    ap.add_argument("--stars")
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--today", type=dt.date.fromisoformat)
    a = ap.parse_args()
    today = a.today or dt.date.today()
    stars = a.stars
    if stars is None and not a.html and a.search_json is None:
        stars = str(Path(a.seen).parent / "stars.json")

    seen = load_seen(a.seen)

    lists = [parse_trending(Path(a.html).read_text() if a.html else fetch_trending())]
    if a.search_json is not None:
        for f in a.search_json:
            lists.append(parse_search(json.loads(Path(f).read_text()), Path(f).stem))
    else:
        since = (today - dt.timedelta(days=30)).isoformat()
        for t in TOPICS:
            try:
                lists.append(parse_search(fetch_search(t, since), t))
            except Exception as e:  # 一個主題搜尋失敗（限流、5xx）不拖垮整份，週榜還在
                print(f"collect: 略過 topic:{t}（{e}）", file=sys.stderr)

    if not lists[0]:
        # 週榜一個都沒解析到＝GitHub 改版或被擋，不能當成「這週沒東西」
        print("collect: 週榜解析出 0 筆（頁面改版？）", file=sys.stderr)
        sys.exit(2)
    if stars:
        hist = load_stars(stars)
        add_growth(lists, hist, today)
        save_stars(stars, hist, lists, today)
    else:
        add_growth(lists, {}, today)
    json.dump(merge(lists, seen, a.limit, today), sys.stdout, ensure_ascii=False, indent=1)
    print()


if __name__ == "__main__":
    main()
