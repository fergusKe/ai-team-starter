#!/usr/bin/env bash
# 架構視圖：**從現況推導出來，不是維護出來的。**
#
#     bash .github/scripts/arch-view.sh                 # 文字報告 + 對不上的清單
#     bash .github/scripts/arch-view.sh --decisions [字]  # 列出所有設計決策（可用關鍵字過濾）
#     bash .github/scripts/arch-view.sh --html [--open]  # 產生 docs/arch.html（不進版控）
#     bash .github/scripts/arch-view.sh --json
#
# 三個來源，三個區塊，**各說各的、不互相冒充**：
#
#   openspec/specs/*/spec.md            → capability **引用圖**。「引用」= spec 內文用反引號
#                                          提到另一個 capability。它不是 runtime 依賴圖；
#                                          一個 capability 可以在程式碼上依賴另一個而規格沒提。
#   openspec/changes/**/design.md       → 設計決策搜尋。`## D1｜…` 這種標題跨所有 change 聚合。
#                                          （衍生專案實測：271 條裡大多是局部實作選擇）**這一區是搜尋用的，
#                                          不是架構摘要** —— 架構邊界在下一區。
#   docs/adr/*.md                       → 架構邊界。ADR 多兩個欄位：
#                                            - **邊界狀態**: 已強制｜僅約定｜已知缺口
#                                            - **證據**: 路徑[:行]（可多個，用 、 分開）
#                                          **`已強制` 只能連測試或 .github/scripts/ 的檢查** ——
#                                          spec 與 ADR 自己不算證據；它們說「應該」，說不了「真的」。
#
# 為什麼不手寫一份總覽：衍生專案的 docs/ROADMAP.md 曾經有兩張總覽表，WBS 重排後沒跟著改，
# 「頂端加了警告也沒用」，最後是刪掉不是修好。手寫的總覽沒有機器對它，就會漂。
# 這一支對得到的東西才印；對不到的（例如「這條邊界為什麼重要」）留在 ADR 裡由人寫。
#
# **不是閘門。** 它不在 CI 裡跑；用途是接續一個 change 之前先看鄰域（prompts/04）、
# 以及 review 的時候把邊界攤開。退出碼：0 = 對得上；1 = 有對不上的（下面列出）；
# 2 = **量不到**（沒有 openspec/specs、一份 spec 都沒有）。量不到不等於沒問題。
#
# 對不上的清單，每一條都是機器認得的反例，`test-arch-view.sh` 逐條驗：
#   - Purpose 段落裡**帶連字號**的反引號名稱一律當 capability 引用；不存在就是懸空。
#     （只看 Purpose，不看全篇 —— 全篇的反引號裡有 data-testid、aria-pressed 這種東西，
#     衍生專案實測 28 個非 capability 名稱，分不出來。只認帶連字號的 —— Purpose 裡的單字
#     反引號實測 22 個全是 `fetch`、`id` 這種。兩個條件加起來實測零誤報、一個真懸空。
#     代價：單字命名的 capability 寫錯了抓不到。）
#   - `## D<n>` 開頭的標題解析不出（沒有標題文字）—— 報出來，不安靜略過。
#   - `**Supersedes**: <change>/D<n>` 指向不存在的決策，或形成循環。
#   - ADR 的 邊界狀態 不是三種之一；證據路徑不存在；已強制 卻沒有任何一條證據是測試。
#
# 它**抓不到**的，不要以為它抓得到：兩條決策語意衝突但沒寫 Supersedes（never inferred，
# 這是人審的責任）；ADR 說已強制而測試其實是 test.skip（證據路徑存在只代表有交卷）；
# 程式碼有依賴但 spec 沒寫（這裡是引用圖不是依賴圖）。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

MODE=text; KW=""; OPEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --html) MODE=html ;;
    --json) MODE=json ;;
    --decisions) MODE=decisions; [ $# -gt 1 ] && [ "${2#--}" = "$2" ] && { KW="$2"; shift; } ;;
    --open) OPEN=1 ;;
    *) echo "不認得的參數：$1" >&2; exit 2 ;;
  esac
  shift
done

MODE="$MODE" KW="$KW" python3 - <<'PY'
import io, json, os, pathlib, re, sys, html

MODE, KW = os.environ["MODE"], os.environ["KW"]
findings = []
def bad(msg): findings.append(msg)

# ── capability 引用圖 ────────────────────────────────────────────────
specs_dir = pathlib.Path("openspec/specs")
if not specs_dir.is_dir():
    print("✗ 沒有 openspec/specs/ —— 量不到", file=sys.stderr); raise SystemExit(2)
caps = {}
for spec in sorted(specs_dir.glob("*/spec.md")):
    caps[spec.parent.name] = spec
if not caps:
    print("✗ openspec/specs/ 底下一份 spec.md 都沒有 —— 量不到（剛從模板複製的專案是正常的）",
          file=sys.stderr); raise SystemExit(2)
for d in sorted(p for p in specs_dir.iterdir() if p.is_dir() and p.name not in caps):
    bad(f"{d}/ 沒有 spec.md —— 是 capability 嗎？")

TOKEN = re.compile(r"`([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`")   # 引用圖：任何反引號名稱，只要它是 capability
KEBAB = re.compile(r"`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`")   # 懸空檢查：只認帶連字號的
graph = {}
for name, spec in caps.items():
    text = io.open(spec, encoding="utf-8").read()
    m = re.search(r"^## Purpose\s*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    purpose = m.group(1) if m else ""
    first = next((l.strip() for l in purpose.splitlines() if l.strip()), "")
    refs = sorted((set(TOKEN.findall(text)) & set(caps)) - {name})
    # Purpose 裡的反引號 kebab 名稱一律視為 capability 引用
    if m:
        start = text[: m.start(1)].count("\n") + 1
        for j, line in enumerate(purpose.splitlines(), start):
            for t in KEBAB.findall(line):
                if t not in caps and t != name:
                    bad(f"{spec}:{j} Purpose 引用 `{t}`，沒有這個 capability")
    graph[name] = {"purpose": first, "refs": refs, "path": str(spec)}
for name in graph:
    graph[name]["refd_by"] = sorted(n for n, g in graph.items() if name in g["refs"])
mutual = sorted({tuple(sorted((a, b))) for a, g in graph.items() for b in g["refs"] if a in graph[b]["refs"]})

# ── 設計決策 ───────────────────────────────────────────────────────────
# 衍生專案實測的寫法：`## D1｜`、`## D1.`、`## D1：`、`## D1 ——`、`## D1 標題`，`##` 與 `###`
# 兩層都有（174 條在 `##`、95 條在 `###`），編號有 `D2b` 這種。全部認；認不出的才報。
# 同一份檔裡同一個編號再出現、標題以「補記」開頭 → 是那條的補記，不是新決策。
DEC = re.compile(r"^#{2,3}\s*D(\d+[a-z]?)(?:\s*[｜|.:：、\-–—]+\s*|\s+)(\S.*?)\s*$")
SUSPECT = re.compile(r"^#{2,3}\s*D\d+")
SUP = re.compile(r"^\s*-?\s*\*\*Supersedes\*\*\s*[:：]\s*([A-Za-z0-9._-]+)/D(\d+)\s*$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}-")
decisions, by_key = [], {}
design_files = sorted(pathlib.Path("openspec/changes").glob("*/design.md")) + \
               sorted(pathlib.Path("openspec/changes/archive").glob("*/design.md")) \
               if pathlib.Path("openspec/changes").is_dir() else []
for f in design_files:
    change = DATE.sub("", f.parent.name)
    archived = f.parent.parent.name == "archive"
    cur = None
    for i, line in enumerate(io.open(f, encoding="utf-8").read().splitlines(), 1):
        if line.startswith("#"):
            md = DEC.match(line)
            if md:
                key = f"{change}/D{md.group(1)}"
                if key in by_key and md.group(2).startswith("補記"):
                    by_key[key]["notes"].append(md.group(2)); cur = by_key[key]; continue
                cur = {"change": change, "n": md.group(1), "title": md.group(2), "notes": [],
                       "file": f"{f}:{i}", "archived": archived, "supersedes": None}
                if key in by_key:
                    bad(f"{f}:{i} 決策 {key} 出現不只一次（{by_key[key]['file']}）—— 補記請以「補記」開頭")
                by_key[key] = cur; decisions.append(cur)
            else:
                if SUSPECT.match(line):
                    bad(f"{f}:{i} 看起來是決策標題但解析不出（要 `## D<n>｜標題`，標題不可空）：{line.strip()[:50]}")
                cur = None
            continue
        ms = SUP.match(line)
        if ms and cur:
            cur["supersedes"] = f"{ms.group(1)}/D{ms.group(2)}"
for d in decisions:
    t = d["supersedes"]
    if t and t not in by_key:
        bad(f"{d['file']} Supersedes {t}，沒有這條決策")
for d in decisions:
    seen, x = set(), d
    while x and x["supersedes"] in by_key:
        k = f"{x['change']}/D{x['n']}"
        if k in seen:
            bad(f"{d['file']} Supersedes 形成循環：{' → '.join(sorted(seen))}"); break
        seen.add(k); x = by_key[x["supersedes"]]
superseded = {d["supersedes"] for d in decisions if d["supersedes"]}

# ── 架構邊界（ADR）─────────────────────────────────────────────────────
STATES = ("已強制", "僅約定", "已知缺口")
FIELD = re.compile(r"^-\s*\*\*(Status|邊界狀態|證據)\*\*\s*[:：]\s*(.+?)\s*$")
ENFORCED_OK = re.compile(r"(^|/)tests?/|\.test\.|^\.github/scripts/")
adrs = []
adr_dir = pathlib.Path("docs/adr")
for f in sorted(adr_dir.glob("[0-9][0-9][0-9][0-9]-*.md")) if adr_dir.is_dir() else []:
    lines = io.open(f, encoding="utf-8").read().splitlines()
    title = next((l[2:].strip() for l in lines if l.startswith("# ")), f.stem)
    title = re.sub(r"^\d{4}[.．]?\s*", "", title)
    a = {"id": f.stem[:4], "title": title, "file": str(f), "status": "", "state": "未標", "evidence": []}
    for l in lines:
        mf = FIELD.match(l)
        if not mf: continue
        k, v = mf.groups()
        if k == "Status": a["status"] = v
        elif k == "邊界狀態":
            a["state"] = v
            if v not in STATES:
                bad(f"{f} 邊界狀態「{v}」不是 {'／'.join(STATES)} 之一")
        else:
            a["evidence"] += [e.strip().strip("`") for e in re.split(r"[、,，]\s*", v) if e.strip()]
    if a["state"] in STATES and not a["evidence"]:
        bad(f"{f} 標了邊界狀態「{a['state']}」卻沒有 **證據** 欄位")
    for e in a["evidence"]:
        path = e.split(":", 1)[0]
        if not pathlib.Path(path).exists():
            bad(f"{f} 證據 {e}：路徑不存在")
    # 已強制：證據裡**至少一條**要是測試或 .github/scripts/ 的檢查。其他條可以是 src／spec，
    # 那是「在哪裡」；測試那條才是「違反了會紅」。
    if a["state"] == "已強制" and not any(ENFORCED_OK.search(e.split(":", 1)[0]) for e in a["evidence"]):
        bad(f"{f} 標「已強制」但沒有一條證據是測試或 .github/scripts/ 的檢查 —— "
            f"spec／ADR／文件說的是「應該」，不是「真的」；改成「僅約定」或連到測試")
    adrs.append(a)

data = {"capabilities": graph, "mutual": mutual, "decisions": decisions,
        "superseded": sorted(superseded), "adrs": adrs, "findings": findings}

# ── 輸出 ───────────────────────────────────────────────────────────────
if MODE == "json":
    print(json.dumps(data, ensure_ascii=False, indent=1))
elif MODE == "decisions":
    rows = [d for d in decisions if not KW or KW.lower() in (d["title"] + d["change"]).lower()]
    for d in rows:
        tag = "（已被取代）" if f"{d['change']}/D{d['n']}" in superseded else ""
        print(f"  {d['change']} · D{d['n']} · {d['title']}{tag}"
              + (f"\n      取代 {d['supersedes']}" if d["supersedes"] else "")
              + "".join(f"\n      {n}" for n in d["notes"]))
    print(f"\n{len(rows)} 條" + (f"（過濾：{KW}）" if KW else "") + f"，共 {len(decisions)} 條")
elif MODE == "html":
    def esc(s): return html.escape(str(s))
    out = ["<!doctype html><html lang=\"zh-Hant\"><head><meta charset=\"utf-8\">",
           "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
           "<title>架構視圖</title><style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;"
           "max-width:60em;margin:2em auto;padding:0 1em;color:#222}code{background:#f3f3f3;"
           "padding:0 .3em}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;"
           "padding:.3em .5em;text-align:left;vertical-align:top}h2{margin-top:2em}.bad{color:#b00}"
           ".muted{color:#777}.st-已強制{color:#070}.st-已知缺口{color:#b00}.st-僅約定{color:#960}"
           "</style></head><body>",
           "<h1>架構視圖</h1><p class=muted>從 <code>openspec/specs</code>、<code>openspec/changes/**/design.md</code>、"
           "<code>docs/adr</code> 推導；每次重跑 <code>bash .github/scripts/arch-view.sh --html</code>。"
           "這一頁不進版控。</p>"]
    if findings:
        out.append(f"<h2 class=bad>對不上的（{len(findings)}）</h2><ul>" +
                   "".join(f"<li class=bad>{esc(x)}</li>" for x in findings) + "</ul>")
    out.append(f"<h2>架構邊界（docs/adr，{len(adrs)} 份）</h2><p class=muted>"
               "<b>已強制</b>＝有測試或檢查會在違反時失敗；<b>僅約定</b>＝只有規格／ADR 說；"
               "<b>已知缺口</b>＝知道現在守不住；<b>未標</b>＝這份 ADR 不是邊界或還沒標。</p>"
               "<table><tr><th>ADR</th><th>狀態</th><th>證據</th></tr>")
    for a in adrs:
        out.append(f"<tr><td><a href=\"../{esc(a['file'])}\">{esc(a['id'])}</a> {esc(a['title'])}</td>"
                   f"<td class=\"st-{esc(a['state'])}\">{esc(a['state'])}</td>"
                   f"<td>{'<br>'.join('<code>'+esc(e)+'</code>' for e in a['evidence']) or '—'}</td></tr>")
    out.append("</table>")
    out.append(f"<h2>capability 引用圖（{len(graph)} 個）</h2><p class=muted>「引用」= spec 內文提到另一個 "
               "capability，<b>不是 runtime 依賴</b>。接續一個 change 之前看它的 → 與 ←。</p>"
               "<table><tr><th>capability</th><th>Purpose 第一句</th><th>→ 引用</th><th>← 被引用</th></tr>")
    for n, g in graph.items():
        out.append(f"<tr><td><a href=\"../{esc(g['path'])}\"><code>{esc(n)}</code></a></td><td>{esc(g['purpose'])}</td>"
                   f"<td>{', '.join('<code>'+esc(r)+'</code>' for r in g['refs']) or '—'}</td>"
                   f"<td>{', '.join('<code>'+esc(r)+'</code>' for r in g['refd_by']) or '—'}</td></tr>")
    out.append("</table>")
    if mutual:
        out.append("<p>互相引用（不一定是問題，但要知道）：" +
                   "、".join(f"<code>{esc(a)}</code> ⇄ <code>{esc(b)}</code>" for a, b in mutual) + "</p>")
    out.append(f"<h2>設計決策（{len(decisions)} 條，{len(design_files)} 份 design.md）</h2>"
               "<p class=muted>搜尋用，<b>不是架構摘要</b> —— 大多是局部實作選擇。"
               "被 <code>Supersedes</code> 指到的標「已被取代」；沒寫的不推斷。</p>"
               "<table><tr><th>change · #</th><th>決策</th></tr>")
    for d in decisions:
        key = f"{d['change']}/D{d['n']}"
        tag = " <span class=muted>（已被取代）</span>" if key in superseded else ""
        sup = f" <span class=muted>取代 {esc(d['supersedes'])}</span>" if d["supersedes"] else ""
        sup += "".join(f"<br><span class=muted>{esc(n)}</span>" for n in d["notes"])
        out.append(f"<tr><td>{esc(d['change'])} · D{d['n']}{' <span class=muted>archive</span>' if d['archived'] else ''}</td>"
                   f"<td>{esc(d['title'])}{tag}{sup}</td></tr>")
    out.append("</table></body></html>")
    pathlib.Path("docs").mkdir(exist_ok=True)
    pathlib.Path("docs/arch.html").write_text("\n".join(out), encoding="utf-8")
    print("docs/arch.html")
else:
    print(f"架構邊界（docs/adr，{len(adrs)} 份）")
    for a in adrs:
        print(f"  {a['id']} {a['title']} · {a['state']}"
              + (f" · {'、'.join(a['evidence'])}" if a["evidence"] else ""))
    print(f"\ncapability 引用圖（{len(graph)} 個；「引用」= spec 內文提到，不是 runtime 依賴）")
    for n, g in graph.items():
        print(f"  {n}")
        if g["refs"]:    print(f"    → {', '.join(g['refs'])}")
        if g["refd_by"]: print(f"    ← {', '.join(g['refd_by'])}")
    if mutual:
        print("  互相引用（不一定是問題，但要知道）：" + "、".join(f"{a} ⇄ {b}" for a, b in mutual))
    print(f"\n設計決策：{len(decisions)} 條（{len(design_files)} 份 design.md，"
          f"{len(superseded)} 條已被取代）。`--decisions [關鍵字]` 列出。")
    if findings:
        print(f"\n對不上的（{len(findings)}）：")
        for x in findings: print(f"  ✗ {x}")
    else:
        print("\n✓ 沒有對不上的。")
raise SystemExit(1 if findings else 0)
PY
RC=$?
if [ "$MODE" = html ] && [ "$OPEN" = 1 ] && [ -s docs/arch.html ]; then
  open docs/arch.html 2>/dev/null || xdg-open docs/arch.html 2>/dev/null || true
fi
exit "$RC"
