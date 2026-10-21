#!/usr/bin/env python3
"""狀態腳本重播（借 tester-army/e2e 的「走過一次就錄下來、下次重播」，2026-10-06）。

每個專案一份 <repo>/.inspect/states.json，記錄「怎麼進到每一種畫面狀態」。
這支用 dev-browser --headless（自帶 Chromium，不開視窗、不碰使用者的 Chrome）
逐一重播，每個狀態 × 每個寬度跑一次：

  - overlap.js      第一節的重疊偵測器＋不變量
  - design-scan.js  impeccable 改寫來的設計規則（檔案存在才跑）
  - console 錯誤與頁面例外

用法：
  replay.py <states.json 或 repo 目錄> [--state 名稱] [--width 寬度] [--json]

離開碼：0 全部乾淨　1 有發現（重疊／error 級設計規則／console 錯誤）
        3 有狀態「進不去」——畫面改了、腳本過期，**要重錄那一個狀態**
        2 參數或環境錯誤

states.json 格式：
{
  "base": "http://localhost:5250",
  "widths": [1440, 1024],              // 寬度用 headless 的 viewport，不是使用者的視窗
  "height": 900,
  "states": [
    {
      "name": "名冊打開",
      "path": "/",                       // 預設 "/"
      "steps": [                         // 依序執行；任何一步失敗就算「進不去」
        {"wait": "#rosterbtn"},          // 等到看得見（5 秒）
        {"click": "#rosterbtn"},
        {"press": "Escape"},
        {"eval": "window.foo = 1"},      // 在頁面裡跑一段 JS
        {"sleep": 300}
      ],
      "expect": ["#roster"],             // 步驟跑完必須看得見；看不見＝要重錄
      "minCount": {".row": 1},           // 至少要有幾個——空頁面永遠沒重疊，要防
      "ignore": ["#world"]               // 這些節點底下的發現不報（例如 canvas 遊戲畫面）
    }
  ]
}

步驟只放「開畫面」的動作。**不要放會寫資料、發請求、花錢的動作**（送出表單、
建任務、按「重新整理資料」之類）——重播會被反覆跑。
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARK = "@@REPLAY "


def load_spec(arg):
    p = Path(arg).expanduser()
    if p.is_dir():
        p = p / ".inspect" / "states.json"
    if not p.exists():
        sys.exit(f"找不到狀態腳本：{p}（格式見 replay.py 開頭）")
    return p, json.loads(p.read_text(encoding="utf-8"))


def build_script(spec, states, widths):
    overlap = (HERE / "overlap.js").read_text(encoding="utf-8")
    ds = HERE / "design-scan.js"
    design = ds.read_text(encoding="utf-8") if ds.exists() else "null"
    cfg = {
        "base": spec["base"].rstrip("/"),
        "height": spec.get("height", 900),
        "widths": widths,
        "states": states,
    }
    return f"""
const CFG = {json.dumps(cfg, ensure_ascii=False)};
const OVERLAP = {json.dumps(overlap)};
const DESIGN = {json.dumps(design)};
const out = (o) => console.log({json.dumps(MARK)} + JSON.stringify(o));
const page = await browser.getPage("inspect-replay");
const errors = [];
page.on("console", (m) => {{ if (m.type() === "error") errors.push(m.text().slice(0, 200)); }});
page.on("pageerror", (e) => errors.push("例外：" + String(e.message || e).slice(0, 200)));

async function visible(sel) {{
  return await page.evaluate((s) => {{
    const e = document.querySelector(s);
    if (!e) return false;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return !e.hidden && cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
  }}, sel);
}}
async function waitVisible(sel, ms) {{
  for (let t = 0; t < ms; t += 100) {{ if (await visible(sel)) return true; await page.waitForTimeout(100); }}
  return false;
}}

for (const st of CFG.states) {{
  for (const w of (st.widths || CFG.widths)) {{
    const rec = {{ state: st.name, width: w, ok: true, broke: null, overlap: [], invariants: [], design: [], errors: [], counts: {{}} }};
    errors.length = 0;
    try {{
      await page.setViewportSize({{ width: w, height: CFG.height }});
      // 每個狀態從乾淨的儲存開始：頁面常把「上次的模式／分頁」記在 localStorage，
      // 不清的話前一個狀態會污染下一個（2026-10-06 office 實測：切過工作模式後首頁就進不去）
      await page.goto(CFG.base + "/", {{ waitUntil: "domcontentloaded" }});
      await page.evaluate(() => {{ try {{ localStorage.clear(); sessionStorage.clear(); }} catch (e) {{}} }});
      errors.length = 0;
      await page.goto(CFG.base + (st.path || "/"), {{ waitUntil: "domcontentloaded" }});
      await page.evaluate(() => {{ document.documentElement.style.scrollBehavior = "auto"; }});
      await page.waitForTimeout(st.settle || 800);
      for (const [i, step] of (st.steps || []).entries()) {{
        const where = "第 " + (i + 1) + " 步 " + JSON.stringify(step);
        if (step.wait) {{ if (!(await waitVisible(step.wait, step.timeout || 5000))) throw new Error(where + "：等不到"); }}
        else if (step.click) {{ if (!(await waitVisible(step.click, 5000))) throw new Error(where + "：找不到可點的元素"); await page.click(step.click); }}
        else if (step.press) await page.keyboard.press(step.press);
        else if (step.eval) await page.evaluate(step.eval);
        else if (step.sleep) await page.waitForTimeout(step.sleep);
        else throw new Error(where + "：不認得的步驟");
        await page.waitForTimeout(step.after || 150);
      }}
      for (const sel of (st.expect || [])) if (!(await visible(sel))) throw new Error("步驟跑完看不見 " + sel);
      for (const [sel, n] of Object.entries(st.minCount || {{}})) {{
        const c = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
        rec.counts[sel] = c;
        if (c < n) throw new Error(sel + " 只有 " + c + " 個（要至少 " + n + "）——可能沒載到這一頁");
      }}
      const ig = st.ignore || [];
      const o = await page.evaluate(OVERLAP);
      const keep = (txt) => !ig.some((s) => txt.includes(s));
      rec.overlap = o["重疊"].filter(keep);
      rec.invariants = o["不變量"].filter(keep);
      if (DESIGN !== "null") {{
        await page.evaluate((errs) => {{ window.__designScanErrors = errs; }}, errors.filter((e) => e.startsWith("例外：")));
        const d = await page.evaluate(DESIGN);
        rec.design = ((d && (d["命中"] || d.hits)) || []).filter((h) => keep(JSON.stringify(h)));
        rec.designRules = d && (d["規則數"] ?? d.ruleCount);
      }}
    }} catch (e) {{
      rec.ok = false; rec.broke = String(e.message || e).slice(0, 300);
    }}
    rec.errors = [...errors];
    out(rec);
  }}
}}
"""


def main(argv):
    args = argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if args else 2
    as_json = "--json" in args
    only_state = args[args.index("--state") + 1] if "--state" in args else None
    only_width = int(args[args.index("--width") + 1]) if "--width" in args else None
    path, spec = load_spec(args[0])
    states = [s for s in spec["states"] if not only_state or s["name"] == only_state]
    if not states:
        print(f"沒有叫「{only_state}」的狀態", file=sys.stderr)
        return 2
    widths = [only_width] if only_width else spec.get("widths", [1280])
    script = build_script(spec, states, widths)
    r = subprocess.run(["dev-browser", "--headless", "--browser", "inspect-replay"],
                       input=script, capture_output=True, text=True, timeout=600)
    recs = [json.loads(l[len(MARK):]) for l in r.stdout.splitlines() if l.startswith(MARK)]
    if not recs:
        print("dev-browser 沒有回任何結果：\n" + (r.stdout + r.stderr)[-2000:], file=sys.stderr)
        return 2
    if as_json:
        print(json.dumps(recs, ensure_ascii=False, indent=1))
    broke = found = 0
    if not as_json:
        print(f"狀態腳本：{path}\n")
    for rec in recs:
        design_err = [d for d in rec["design"] if (d.get("嚴重度") or d.get("severity")) == "error"]
        n = len(rec["overlap"]) + len(rec["invariants"]) + len(design_err) + len(rec["errors"])
        if not rec["ok"]:
            broke += 1
        elif n:
            found += 1
        if as_json:
            continue
        head = f"{rec['state']} @ {rec['width']}px"
        if not rec["ok"]:
            print(f"✗ {head}：進不去——{rec['broke']}\n    → 畫面改了，重錄這個狀態")
            continue
        cnt = "、".join(f"{k}×{v}" for k, v in rec["counts"].items())
        warn = len(rec["design"]) - len(design_err)
        print(f"{'✓' if not n else '!'} {head}" + (f"（{cnt}）" if cnt else "") +
              f"　重疊 {len(rec['overlap'])}・不變量 {len(rec['invariants'])}・設計 error {len(design_err)}／其他 {warn}・console {len(rec['errors'])}")
        for x in rec["overlap"][:8] + rec["invariants"][:8]:
            print("    " + x)
        for d in design_err[:8]:
            print(f"    [設計] {d.get('id')}：{d.get('說明') or d.get('message', '')} {d.get('選擇器或節點描述') or d.get('selector', '')}")
        if warn:
            ids = {}
            for d in rec["design"]:
                if d not in design_err:
                    ids[d.get("id")] = ids.get(d.get("id"), 0) + 1
            print("    [設計 warn/info] " + "、".join(f"{k}×{v}" for k, v in ids.items()))
        for e in rec["errors"][:5]:
            print("    [console] " + e)
    if not as_json:
        print(f"\n{len(recs)} 次重播：{broke} 次進不去、{found} 次有發現")
    return 3 if broke else (1 if found else 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
