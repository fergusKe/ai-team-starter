#!/usr/bin/env bash
# 每一條 Scenario 都要有一個**真的跑過而且通過**的測試指著它。
#
#     bash .github/scripts/check-scenario-coverage.sh
#
# `AGENTS.md`〈完成的定義〉第 2 條寫「每個 Scenario 都有對應測試」，
# 而在這支腳本出現以前，**沒有任何機器在檢查它**。實測差集有 8 條。
#
# **不掃測試原始碼。** 實測：`FE-X01-S10` 只出現在 `tests/scaffold.test.ts`
# 第 5 行的一行註解裡，`grep` 會把它算成已覆蓋。所以這裡看的是
# `vitest --reporter=json` 的執行結果，而且只認 `passed` 的**葉節點**標題 ——
# 「出現這個 ID」跟「這條 Scenario 真的被驗了」中間差著：有沒有被 skip、
# 有沒有編譯錯誤、有沒有真的通過。
#
# 不用單元測試驗的 Scenario，在它自己底下寫一行豁免：
#
#     - **VERIFY-BY** `manual-browser`｜PR #37 的截圖｜WebGL 像素結果 jsdom 證明不了
#
# **豁免寫在 Scenario 裡面，不另外開一份清單。** 理由是 `feat/` 分支不得
# 回改已批准的 specs（`check-pr-branch.sh` 擋著），所以豁免只能在 spec PR
# 階段加 —— 實作者沒辦法寫到一半才給自己補一張免死金牌。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

FAIL=0
die() { echo "✗ $*" >&2; FAIL=1; }

W="$(mktemp -d "${TMPDIR:-/tmp}/scenario-cov.XXXXXXXX")"
REPORT="$W/vitest.json"

# **每次都用全新的暫存檔。** 讀到上一次留下的報告，是這種檢查最典型的說謊
# 方式：測試這次紅了，但報告是上次綠的那一份。
if ! npx vitest run --reporter=json --outputFile="$REPORT" >"$W/vitest.log" 2>&1; then
  echo "✗ 測試沒有全綠 —— 覆蓋率沒有意義，先把測試修綠" >&2
  tail -20 "$W/vitest.log" >&2
  echo "測試輸出留在：$W" >&2
  exit 1
fi
if [ ! -s "$REPORT" ]; then
  echo "✗ vitest 沒有產生報告（${REPORT}）—— 產不出來不等於全部覆蓋" >&2
  echo "測試輸出留在：$W" >&2
  exit 1
fi

REPORT="$REPORT" python3 - <<'PY'
import io, json, os, pathlib, re, sys

FAIL = []


def die(msg):
    FAIL.append(msg)


# `check-pr-branch.sh` 認的就是這個形狀。**兩邊要是同一份文法** ——
# 分開寫的話，一邊認得、另一邊認不得的 Scenario 會從覆蓋檢查裡整個消失。
HEAD_RE = re.compile(r"^####\s+Scenario:\s*\[([A-Z0-9-]+)\]")
ANY_HEAD_RE = re.compile(r"^####\s+Scenario:\s*(.*)$")
# 豁免：`- **VERIFY-BY** <種類>｜<證據>｜<理由>`
VERIFY_RE = re.compile(r"^\s*-\s*\*\*VERIFY-BY\*\*\s*(.+)$")
# **封閉列舉。** 不認得的種類直接紅 —— 打錯字的豁免等於沒有豁免，
# 而它看起來跟真的豁免一模一樣。
KINDS = {"vitest", "playwright", "command-negative", "manual-browser"}

# ── 規格：main 上的，以及還在 change 裡的 ──────────────────────────
#
# **只掃 openspec/specs/ 不夠。** 一份 change 在 feat 階段，它的 spec 還在
# openspec/changes/<id>/specs/ 底下 —— 只掃 main 的話，缺口要等到 archive
# 才會被發現，而那時候實作早就合併了。
roots = [pathlib.Path("openspec/specs")]
cdir = pathlib.Path("openspec/changes")
if cdir.is_dir():
    roots += [p / "specs" for p in cdir.iterdir()
              if p.is_dir() and p.name != "archive"]

scenarios = {}      # id -> 檔案:行
exempt = {}         # id -> (種類, 證據, 理由)
files = 0
for root in roots:
    if not root.is_dir():
        continue
    for f in sorted(root.rglob("*.md")):
        files += 1
        cur = None
        for i, line in enumerate(io.open(f, encoding="utf-8").read().splitlines(), 1):
            m = ANY_HEAD_RE.match(line)
            if m:
                mid = HEAD_RE.match(line)
                if not mid:
                    # 沒有穩定 ID 的 Scenario。**不可以當成不存在** ——
                    # 那樣它就永遠不會出現在差集裡，等於免驗。
                    die(f"{f}:{i} 的 Scenario 沒有 `[ID]`：{line.strip()[:60]}")
                    cur = None
                    continue
                cur = mid.group(1)
                if cur in scenarios:
                    # **不可以靜靜合併。** `sort -u` 會把重複折疊掉，
                    # 於是「兩條不同的 Scenario 共用一個 ID」看起來像一條。
                    die(f"Scenario ID {cur} 出現不只一次（{scenarios[cur]}、{f}:{i}）")
                scenarios[cur] = f"{f}:{i}"
                continue
            mv = VERIFY_RE.match(line)
            if mv:
                if cur is None:
                    die(f"{f}:{i} 的 VERIFY-BY 不屬於任何 Scenario（孤兒豁免）")
                    continue
                parts = [x.strip() for x in mv.group(1).split("｜")]
                # **三段都要有東西。** `manual-browser｜｜理由` 切出來仍然是
                # 三段，中間那段是空字串 —— 沒有證據的豁免跟有證據的長得一樣。
                # （Gemini 3.1 Pro 預測、實測存活的突變：拿掉 `not all(parts)`
                # 之後 19 條測試全綠。）
                if len(parts) != 3 or not all(parts):
                    die(f"{cur} 的豁免格式不對，要三段："
                        f"`- **VERIFY-BY** <種類>｜<證據>｜<理由>`（{f}:{i}）")
                    continue
                kind = parts[0].strip("`").strip()
                if kind not in KINDS:
                    die(f"{cur} 的豁免種類 `{kind}` 不在列舉裡"
                        f"（只有 {'、'.join(sorted(KINDS))}）（{f}:{i}）")
                    continue
                if len(parts[2]) < 8:
                    die(f"{cur} 的豁免沒有寫出實質理由（{f}:{i}）")
                    continue
                if cur in exempt:
                    die(f"{cur} 有不只一條 VERIFY-BY（{f}:{i}）")
                    continue
                exempt[cur] = (kind, parts[1], parts[2])

if files == 0:
    die("一份規格檔都沒掃到 —— **掃不到不等於全部覆蓋**。"
        "openspec/specs/ 的位置變了嗎？")
if not scenarios and files:
    die("掃了 %d 份規格檔卻一條 Scenario 都沒有 —— 標題文法變了嗎？" % files)

# ── 測試：真的跑過而且通過的葉節點標題 ─────────────────────────────
try:
    data = json.load(io.open(os.environ["REPORT"], encoding="utf-8"))
except Exception as e:
    die(f"讀不到 vitest 的報告：{e}")
    data = None

passed_ids = set()
if data is not None:
    results = data.get("testResults")
    if not isinstance(results, list):
        # schema 變了就直接失敗。**解析不出來當成空集合，會讓差集變空、
        # 然後宣布「全部覆蓋」** —— 那是這裡最危險的一種綠燈。
        die("vitest 報告裡沒有 testResults 陣列 —— 格式變了？")
        results = []
    total = 0
    for fres in results:
        for a in fres.get("assertionResults", []) or []:
            total += 1
            if a.get("status") != "passed":
                continue
            # **只認葉節點標題。** ID 寫在 describe 上的話，那個 describe
            # 底下每一條測試都會沾到它 —— 包括被 skip 的那些。
            for sid in re.findall(r"\[([A-Z0-9-]+)\]", a.get("title", "")):
                passed_ids.add(sid)
    if total == 0:
        die("vitest 報告裡一條測試結果都沒有 —— 真的跑到測試了嗎？")

# ── 比對 ──────────────────────────────────────────────────────────
missing = sorted(s for s in scenarios if s not in passed_ids and s not in exempt)
stale = sorted(s for s in exempt if s in passed_ids)
orphan = sorted(s for s in exempt if s not in scenarios)

for s in missing:
    die(f"{s}（{scenarios[s]}）沒有任何通過的測試指著它，也沒有 VERIFY-BY 豁免")
for s in stale:
    die(f"{s} 同時有通過的測試與 VERIFY-BY 豁免 —— 豁免過期了，拿掉它")
for s in orphan:
    die(f"VERIFY-BY 指到 {s}，但沒有這條 Scenario（改名或刪掉之後留下的）")

if FAIL:
    print("✗ Scenario 覆蓋檢查沒過：", file=sys.stderr)
    for m in FAIL:
        print(f"    {m}", file=sys.stderr)
    print(f"\n  規格 {len(scenarios)} 條、"
          f"有通過的測試 {len(scenarios) - len(missing) - len(exempt)} 條、"
          f"豁免 {len(exempt)} 條、缺 {len(missing)} 條", file=sys.stderr)
    raise SystemExit(1)

print(f"✓ Scenario 覆蓋：{len(scenarios)} 條規格，"
      f"{len(scenarios) - len(exempt)} 條有通過的測試、{len(exempt)} 條豁免")
for s in sorted(exempt):
    k, ev, why = exempt[s]
    print(f"    {s}  {k}｜{ev}｜{why}")
PY
RC=$?

if [ "$RC" != 0 ]; then
  echo "測試輸出留在：$W" >&2
  exit 1
fi
rm -rf "$W"
exit 0
