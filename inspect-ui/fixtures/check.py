#!/usr/bin/env python3
"""design-scan.js 的 fixture 驗收：反例每一條都要抓到、正例 0 誤報（期望值在 expect.json）。

用法：check.py [--verbose]
期望值三種：must（要抓到）、none（正規式比對到的一條都不准出現）、count（那條規則剛好幾筆）
離開碼：0 全部符合　1 有不符合（漏抓或誤報）　2 環境錯誤（沒有 dev-browser、頁面打不開）

用 dev-browser --headless 開 file:// 網址，不起伺服器、不碰使用者的瀏覽器。
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARK = "@@FIXTURE "


def main(argv):
    verbose = "--verbose" in argv
    if not shutil.which("dev-browser"):
        print("找不到 dev-browser，fixture 驗收跑不了", file=sys.stderr)
        return 2
    spec = json.loads((HERE / "expect.json").read_text(encoding="utf-8"))
    cases = []
    for c in spec["cases"]:
        path, _, query = c["file"].partition("?")
        f = (HERE / path).resolve()
        if not f.exists():
            print(f"找不到 fixture：{f}", file=sys.stderr)
            return 2
        cases.append({**c, "url": f.as_uri() + ("?" + query if query else "")})
    design = (HERE.parent / "design-scan.js").read_text(encoding="utf-8")
    script = f"""
const CASES = {json.dumps(cases, ensure_ascii=False)};
const DESIGN = {json.dumps(design)};
const page = await browser.getPage("inspect-fixtures");
for (const c of CASES) {{
  try {{
    await page.setViewportSize({{ width: c.width, height: 900 }});
    await page.goto(c.url, {{ waitUntil: "load" }});
    await page.waitForTimeout(150);
    const d = await page.evaluate(DESIGN);
    console.log({json.dumps(MARK)} + JSON.stringify({{ file: c.file, width: c.width, hits: d["命中"].map(h => ({{ id: h.id, 細節: h.細節, 在: h.選擇器或節點描述 }})), errors: d["錯誤"] }}));
  }} catch (e) {{
    console.log({json.dumps(MARK)} + JSON.stringify({{ file: c.file, width: c.width, broke: String(e.message || e) }}));
  }}
}}
"""
    r = subprocess.run(["dev-browser", "--headless", "--browser", "inspect-fixtures"],
                       input=script, capture_output=True, text=True, timeout=300)
    recs = [json.loads(l[len(MARK):]) for l in r.stdout.splitlines() if l.startswith(MARK)]
    if len(recs) != len(cases):
        print(f"dev-browser 只回了 {len(recs)}／{len(cases)} 筆：\n" + (r.stdout + r.stderr)[-2000:], file=sys.stderr)
        return 2
    bad = 0
    for c, rec in zip(cases, recs):
        head = f"{c['file']} @ {c['width']}px"
        if rec.get("broke"):
            print(f"✗ {head}：打不開——{rec['broke']}")
            return 2
        if rec["errors"]:
            print(f"✗ {head}：規則執行出錯 {rec['errors']}")
            bad += 1
            continue
        ids = {h["id"] for h in rec["hits"]}
        missing = [i for i in c.get("must", []) if i not in ids]
        wrong = [h for h in rec["hits"] if c.get("none") and re.search(c["none"], h["id"])]
        miscount = [f"{i} 要 {n} 筆、報了 {sum(h['id'] == i for h in rec['hits'])} 筆"
                    for i, n in c.get("count", {}).items() if sum(h["id"] == i for h in rec["hits"]) != n]
        ok = not missing and not wrong and not miscount
        bad += not ok
        print(f"{'✓' if ok else '✗'} {head}" + (f"　要抓 {len(c['must'])} 條" if c.get("must") else "　正例") +
              (f"　漏抓：{'、'.join(missing)}" if missing else "") + (f"　誤報 {len(wrong)}" if wrong else "") + (f"　筆數不對：{'、'.join(miscount)}" if miscount else ""))
        for h in wrong:
            print(f"    誤報 {h['id']}：{h['細節']}　{h['在']}")
        if verbose:
            for h in rec["hits"]:
                print(f"    · {h['id']}：{h['細節']}")
    print(f"\n{len(cases)} 個案例，{bad} 個不符合")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
