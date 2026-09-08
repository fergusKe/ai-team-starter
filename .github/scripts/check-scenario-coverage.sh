#!/usr/bin/env bash
# **缺口報告，不是閘門。** 列出「沒有任何通過的測試指著它」的 Scenario。
#
#     bash .github/scripts/check-scenario-coverage.sh
#
# 有缺口也回 0 —— 這支不接進 CI，不擋任何 PR。它的用途是在
# `prompts/05-verify.md` 那一步把清單攤開，由人對每一條說出處置
# （補測試／改成人工驗證並寫進 tasks.md／說明它為什麼不需要自動測試）。
#
# **為什麼從閘門降級成報告**：它證明得了的事只有「這個 ID 出現在一個通過的
# 測試標題裡」，證明不了那個測試真的在驗那條 Scenario 的行為。當它是閘門，
# 唯一保證會發生的事是「補一條標題帶 ID 的測試」—— 那比沒有閘門更糟，
# 因為它會產生已經驗過的**外觀**。詳見 `docs/DECISIONS.md`。
#
# **不掃測試原始碼。** 實測：`FE-X01-S10` 只出現在 `tests/scaffold.test.ts`
# 第 5 行的一行註解裡，`grep` 會把它算成已覆蓋。所以這裡看的是
# `vitest --reporter=json` 的執行結果，而且只認 `passed` 的**葉節點**標題。
#
# 退出碼：0 = 量到了（不管有沒有缺口）；2 = **量不到**（測試沒綠、報告產不
# 出來、規格掃不到）。量不到跟沒有缺口是兩件事，不可以都回 0。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# 零份現況 spec 是合法狀態（剛從模板複製的專案）。問 OpenSpec，不要自己 glob——
# 放一份帶 markdown 範例的 README 進去，glob 看得到 Scenario 而 OpenSpec 說沒有。
SPECS_JSON="$(npx openspec list --specs --json 2>/dev/null)" || SPECS_JSON=""
if [ -n "$SPECS_JSON" ] && printf '%s' "$SPECS_JSON" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(d.get("specs"), list) and not d["specs"] else 1)
'; then
  echo "還沒有任何現況 spec（openspec list --specs 回空），沒有東西可以看"
  exit 0
fi

W="$(mktemp -d "${TMPDIR:-/tmp}/scenario-cov.XXXXXXXX")"
REPORT="$W/vitest.json"

# 每次都用全新的暫存檔 —— 讀到上一次留下的報告是這種檢查最典型的說謊方式。
if ! npx vitest run --reporter=json --outputFile="$REPORT" >"$W/vitest.log" 2>&1; then
  echo "✗ 測試沒有全綠 —— 先把測試修綠，缺口清單在那之前沒有意義" >&2
  tail -20 "$W/vitest.log" >&2
  echo "測試輸出留在：$W" >&2
  exit 2
fi
if [ ! -s "$REPORT" ]; then
  echo "✗ vitest 沒有產生報告（${REPORT}）—— 產不出來不等於沒有缺口" >&2
  echo "測試輸出留在：$W" >&2
  exit 2
fi

REPORT="$REPORT" python3 - <<'PY'
import io, json, os, pathlib, re, sys

# **跟 `check-pr-branch.sh` 用同一份文法。** 兩份文法就是兩種答案。
SID = r"[A-Z0-9]+(?:-[A-Z0-9]+)*-S[0-9]{2}"
HEAD_RE = re.compile(r"^####\s+Scenario:\s*\[(" + SID + r")\]\s+\S")
ANY_HEAD_RE = re.compile(r"^####\s+Scenario:\s*(.*)$")
ANY_MD_HEAD_RE = re.compile(r"^#{1,6}\s")   # 任何標題都結束前一條的範圍
NOTE_RE = re.compile(r"^\s*-\s*\*\*(?:VERIFY-BY|驗證方式)\*\*\s*(.+?)\s*$")

scenarios, notes, odd, files = {}, {}, [], 0
for f in sorted(pathlib.Path("openspec/specs").rglob("*.md")):
    files += 1
    cur = None
    for i, line in enumerate(io.open(f, encoding="utf-8").read().splitlines(), 1):
        if ANY_MD_HEAD_RE.match(line) and not ANY_HEAD_RE.match(line):
            cur = None
            continue
        if ANY_HEAD_RE.match(line):
            mid = HEAD_RE.match(line)
            cur = mid.group(1) if mid else None
            if not mid:
                odd.append(f"{f}:{i} 的 Scenario ID 不合文法：{line.strip()[:60]}")
            elif cur in scenarios:
                odd.append(f"Scenario ID {cur} 出現不只一次（{scenarios[cur]}、{f}:{i}）")
            else:
                scenarios[cur] = f"{f}:{i}"
            continue
        # 人寫的驗證方式註記：**原文照印，不解析、不驗證、不當豁免。**
        mn = NOTE_RE.match(line)
        if mn and cur:
            notes.setdefault(cur, mn.group(1))

if files == 0:
    print("✗ 一份規格檔都沒掃到 —— 掃不到不等於沒有缺口", file=sys.stderr)
    raise SystemExit(2)
if not scenarios:
    print(f"✗ 掃了 {files} 份規格檔卻一條 Scenario 都沒有 —— 標題文法變了嗎？",
          file=sys.stderr)
    raise SystemExit(2)

data = json.load(io.open(os.environ["REPORT"], encoding="utf-8"))
results = data.get("testResults")
if not isinstance(results, list):
    print("✗ vitest 報告裡沒有 testResults 陣列 —— 格式變了？", file=sys.stderr)
    raise SystemExit(2)
passed, total = set(), 0
for fres in results:
    for a in fres.get("assertionResults", []) or []:
        total += 1
        if a.get("status") == "passed":
            # 只認葉節點標題 —— ID 寫在 describe 上會沾到底下每一條，包括 skip 的。
            passed.update(re.findall(r"\[([A-Z0-9-]+)\]", a.get("title", "")))
if total == 0:
    print("✗ vitest 報告裡一條測試結果都沒有 —— 真的跑到測試了嗎？", file=sys.stderr)
    raise SystemExit(2)

gaps = sorted(s for s in scenarios if s not in passed)
print(f"Scenario 缺口：{len(scenarios)} 條規格，{len(scenarios) - len(gaps)} 條有"
      f"通過的測試指著它，{len(gaps)} 條沒有")
for s in gaps:
    print(f"    {s}  {scenarios[s]}"
          + (f"\n        註記：{notes[s]}" if s in notes else ""))
for m in odd:
    print(f"    ⚠ {m}")
if gaps:
    print("\n  這是**待處置清單，不是錯誤**。對每一條給出處置："
          "補測試／改成人工驗證並寫進 tasks.md／說明它為什麼不需要自動測試。")
PY
RC=$?
if [ "$RC" != 0 ]; then
  echo "測試輸出留在：$W" >&2
  exit "$RC"
fi
rm -rf "$W"
exit 0
