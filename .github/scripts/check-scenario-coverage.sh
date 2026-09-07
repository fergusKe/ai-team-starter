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

# **零份現況 spec 是一個合法狀態，不是錯誤。**
#
# 剛從模板複製的專案還沒有任何 `openspec/specs/`。原本的處置是「不要把這支
# 接進 CI，等有規格再接」—— 那製造了一個**沒有任何合法 PR 能修好的死結**：
#
#     第一次 archive 產生現況 spec → 合約測試開始要求 ci.yml 有這一步
#     而 archive/<id> 分支不准碰 .github/ → 那個 PR 永遠是紅的
#
# （外部審查指出、實測確認。）所以改成：**從模板起就永遠接在 CI 上**，
# 而零份 spec 的時候安全地回 0。
#
# **問 OpenSpec，不要自己 glob。** 用 `openspec/specs/` 存不存在去判斷會漂 ——
# 放一份帶 ```` ```markdown ```` 範例的 README 進去，glob 看得到 Scenario、
# 而 OpenSpec 說沒有任何 item（審查者實測的 false positive）。
SPECS_JSON="$(npx openspec list --specs --json 2>/dev/null)" || SPECS_JSON=""
if [ -n "$SPECS_JSON" ] && printf '%s' "$SPECS_JSON" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)          # 解析不出來就不要當成「零份」
sys.exit(0 if isinstance(d.get("specs"), list) and not d["specs"] else 1)
'; then
  echo "✓ 還沒有任何現況 spec（openspec list --specs 回空），沒有東西可以檢查"
  exit 0
fi

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


# **跟 `check-pr-branch.sh` 用同一份文法。** 那邊要求 `[群組-S99] 標題`：
#
#     ID_RE = re.compile(r"^\[([A-Z0-9]+(?:-[A-Z0-9]+)*-S[0-9]{2})\]\s+\S")
#
# 這裡原本寫成寬鬆的 `[A-Z0-9-]+`，於是 `#### Scenario: [BAD] …` 配上一條
# 標題含 `[BAD]` 的通過測試，rc=0 全綠 —— 一個分支閘門會擋下來的 ID，
# 在覆蓋檢查這邊卻算數。**兩份文法就是兩種答案。**（外部審查實測反例。）
SID = r"[A-Z0-9]+(?:-[A-Z0-9]+)*-S[0-9]{2}"
HEAD_RE = re.compile(r"^####\s+Scenario:\s*\[(" + SID + r")\]\s+\S")
ANY_HEAD_RE = re.compile(r"^####\s+Scenario:\s*(.*)$")
# 任何一種標題都會結束前一條 Scenario 的範圍。
ANY_MD_HEAD_RE = re.compile(r"^#{1,6}\s")
# 豁免：`- **VERIFY-BY** <種類>｜<證據>｜<理由>`
VERIFY_RE = re.compile(r"^\s*-\s*\*\*VERIFY-BY\*\*\s*(.+)$")
# **封閉列舉。** 不認得的種類直接紅 —— 打錯字的豁免等於沒有豁免，
# 而它看起來跟真的豁免一模一樣。
# `ci-job`：CI 的 job 本身就是這條 Scenario 的執行。用在「四個工程品質指令
# 都以 0 結束」那種 —— 在測試裡遞迴跑 `npm run build` 是沒有意義的。
KINDS = {"vitest", "playwright", "command-negative", "manual-browser", "ci-job"}

# ── 規格：main 上的，以及還在 change 裡的 ──────────────────────────
#
# **只掃 openspec/specs/ 不夠。** 一份 change 在 feat 階段，它的 spec 還在
# openspec/changes/<id>/specs/ 底下 —— 只掃 main 的話，缺口要等到 archive
# 才會被發現，而那時候實作早就合併了。
#
# **只掃 `openspec/specs/`，不掃還沒 archive 的 change。**
#
# 第一版連 active change 的 delta 一起掃，理由是「只掃 main 的話缺口要等到
# archive 才會被發現」。那個理由本身沒錯，但它**跟這個 repo 的流程互鎖**：
#
#     spec/<id> 分支依設計不能加測試（閘門只准動 openspec/changes/<id>/**）
#     → 第一個 spec PR 就會紅，因為新 Scenario 還沒有測試
#     → 合進 main 之後 main 一直紅，直到 feat PR 落地
#
# 實測（外部審查指出、我重現）：加一份 strict-valid、尚未實作的新 change，
# rc=1、訊息是「FE-W06-S01 沒有任何通過的測試指著它」。**規格先行的流程被
# 自己的覆蓋閘門鎖死了。**
#
# 所以判準改成：**一條 Scenario 進入 `openspec/specs/` 的那一刻要有人驗它。**
# 那一刻就是 archive —— 而 archive 正是「這個 change 變成現況描述」的時點，
# 也是 `AGENTS.md`〈完成的定義〉該生效的時點。
#
# 代價講清楚：實作階段漏掉的測試，要到 archive PR 才會紅。**沒有更早的
# 選項** —— 提早驗就得知道「哪一個 feat slice 是最後一個」，而那件事機器
# 分不出來（一個 change 可以有很多個 feat PR）。
roots = [pathlib.Path("openspec/specs")]

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
            # **任何標題都結束前一條 Scenario 的範圍。** 原本只在遇到下一條
            # `#### Scenario:` 時才換 `cur`，於是寫在 `### Requirement:` 底下
            # 的 VERIFY-BY 會被算成上一條 Scenario 的豁免 —— 那條 Scenario
            # 明明已經結束了。（外部審查實測反例：rc=0，豁免生效。）
            if ANY_MD_HEAD_RE.match(line) and not ANY_HEAD_RE.match(line):
                cur = None
                continue
            m = ANY_HEAD_RE.match(line)
            if m:
                mid = HEAD_RE.match(line)
                if not mid:
                    # ID 不合文法的 Scenario。**不可以當成不存在** ——
                    # 那樣它就永遠不會出現在差集裡，等於免驗。
                    die(f"{f}:{i} 的 Scenario ID 不合文法（要 `[群組-S99] 標題`，"
                        f"跟分支閘門同一份）：{line.strip()[:60]}")
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

def _commit_state(sha):
    """這個 commit 在不在**這份 tree 的歷史**裡。跟 `progress.sh` 同一份語意。

    `missing`（本機沒有這個物件）跟 `not-ancestor`（有物件但還沒合併）
    **不可以混為一談** —— 前者可能只是淺 clone，後者是證據真的還沒進來。
    """
    import subprocess
    try:
        if subprocess.run(["git", "cat-file", "-e", sha + "^{commit}"],
                          capture_output=True).returncode != 0:
            return "missing"
        return "ok" if subprocess.run(
            ["git", "merge-base", "--is-ancestor", sha, "HEAD"],
            capture_output=True).returncode == 0 else "not-ancestor"
    except Exception:
        return "missing"


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
    # **每一個檔案的結果都要走。** 只讀 `results[0]` 的話，第二個測試檔以後
    # 的覆蓋全部消失 —— 而 vitest 一個檔案就是一個 testResults 條目。
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
# 原本這裡還有一條「VERIFY-BY 指到不存在的 Scenario」。**它不可達** ——
# `exempt` 的鍵一定來自已經進 `scenarios` 的 `cur`，差集永遠是空的。
# 「改名之後留下的孤兒豁免」實際上是由**位置**擋掉的：豁免必須寫在它那條
# Scenario 的範圍裡，改名等於換了範圍，那條豁免就變成別條的、或者沒有歸屬。
# 不可達的防禦沒辦法被測試鎖住 —— 要嘛可達，要嘛不要留。

# ── `ci-job` 的證據要真的存在 ────────────────────────────────────
#
# **這一類完全可以機器驗，不該是任意文字。**（外部審查指出：原本 `ci-job`
# 的證據欄寫什麼都算數，跟「宣告即證據」沒有兩樣。）
# 約定：證據欄要列出 `ci.yml` 裡的**步驟名稱**，用「／」或「/」分隔；
# 每一個都必須真的是那份 workflow 的一個 `- name:`。
if any(k == "ci-job" for k, *_ in exempt.values()):
    wf = pathlib.Path(".github/workflows/ci.yml")
    if not wf.is_file():
        die("有 ci-job 豁免，但找不到 .github/workflows/ci.yml")
        step_names = set()
    else:
        step_names = set(re.findall(r"^\s*-\s*name:\s*(.+?)\s*$",
                                    wf.read_text(encoding="utf-8"), re.M))
    for sid, (kind, ev, _why) in exempt.items():
        if kind != "ci-job":
            continue
        # 證據欄裡把步驟名稱抓出來：切掉說明文字，只認列舉的那幾個名字。
        named = [x.strip() for x in re.split(r"[／/、,，]", ev) if x.strip()]
        # 「ci.yml 的 Lint／Typecheck／Test／Build 四個步驟」這種寫法：
        # 第一段帶前綴、最後一段帶後綴，各自再切一次。
        cleaned = []
        for x in named:
            m = re.search(r"([A-Za-z][A-Za-z0-9 _-]*)", x)
            if m:
                cleaned.append(m.group(1).strip())
        hit = [c for c in cleaned if c in step_names]
        if not hit:
            die(f"{sid} 的 ci-job 豁免，證據欄 `{ev}` 裡沒有任何一個是 "
                f"ci.yml 真的有的步驟名稱（現有：{'、'.join(sorted(step_names))}）")

# ── `manual-browser` 的證據要是不可變、離線取得回的 ────────────────
#
# **「PR #37 的 V1 驗證紀錄」不是證據，是宣告。** PR 內文可以被編輯、附件
# 可以被刪，而且要連網才查得到 —— 一份離線的 clone 沒辦法確認它存在
# （外部審查指出：`gh pr view 37` 在沙箱裡 rc=1，無法確認附件）。
#
# 約定：證據欄要含一個 **40 位完整 commit SHA**，而且它要在 HEAD 的歷史裡。
# commit 進了 main 就改不掉、離線也驗得到、`git show` 就取得回它帶的內容
# （通常是那個 change 的 `tasks.md`／`design.md` 裡的驗證紀錄）。
#
# **這不是要求要有圖片。** 機器證明不了「人真的看過畫面」——
# 它能證明的是「這份紀錄存在、而且從此不會變」。人工項的可信度來自
# review，不是來自截圖；截圖進 repo 只是讓 diff 變大，沒有多證明什麼。
SHA_RE = re.compile(r"\b[0-9a-f]{40}\b")
for sid, (kind, ev, _why) in exempt.items():
    if kind != "manual-browser":
        continue
    m = SHA_RE.search(ev)
    if not m:
        die(f"{sid} 的 manual-browser 豁免，證據欄 `{ev}` 裡沒有 40 位完整 "
            f"commit SHA —— PR 號碼與連結會變，commit 不會")
        continue
    st = _commit_state(m.group(0))
    if st != "ok":
        die(f"{sid} 的 manual-browser 豁免指到的 commit `{m.group(0)[:12]}` "
            + ("在本機找不到（還沒 fetch？淺 clone？）" if st == "missing"
               else "不在目前 HEAD 的歷史裡 —— 還沒合併的東西不算證據"))

for s in missing:
    die(f"{s}（{scenarios[s]}）沒有任何通過的測試指著它，也沒有 VERIFY-BY 豁免")
for s in stale:
    die(f"{s} 同時有通過的測試與 VERIFY-BY 豁免 —— 豁免過期了，拿掉它")

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
