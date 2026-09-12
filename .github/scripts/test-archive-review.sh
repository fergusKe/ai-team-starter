#!/usr/bin/env bash
# `archive-review.sh` 的帳本與判定邏輯的測試。它是影子不是閘門，但 `--report` 的結論會被人拿去決定
# 「升阻塞還是拆掉」—— 報錯的尺比沒有尺更糟（同 check-scenario-coverage 留測試的理由）。
#
# 測的是**可以把數字做出來的洞**（第 11–12 輪外部審查點名的）：
#   只有一個模型回答的 change 不算樣本；樣本是最早 N 個、第 N+1 個不算；補跑不會插隊；
#   還有需修正沒判定就不下結論；「已驗證」不算升阻塞的數，「已修」才算，而「已修」要有回審；
#   帳本說答過、檔案卻不在 → 拒絕重跑；兩個都答過 → 拒絕重跑。
# 判準跟其他幾支一樣：**把對應的守衛拿掉，這支要變紅。**
#
# 零依賴：bash + 系統 python3。**不打網路、不叫模型**：gh 用只會回空的替身，跑不到送出那一段。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/archive-review.sh"
W="$(mktemp -d "${TMPDIR:-/tmp}/archive-review-test.XXXXXXXX")"
trap 'rm -rf "$W"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; return 0; }

# ── 假 repo：只有腳本、openspec/changes/<id>、.local ─────────────────────────────────────────
mkdir -p "$W/repo/.github/scripts" "$W/repo/.local/archive-review" "$W/repo/openspec/changes/app-c01-x" "$W/bin"
cp "$SCRIPT" "$W/repo/.github/scripts/archive-review.sh"
printf '#!/bin/sh\nexit 0\n' > "$W/bin/gh"; chmod +x "$W/bin/gh"        # 替身：存在、什麼都不回
export PATH="$W/bin:$PATH"
cd "$W/repo" || exit 1
AR="bash .github/scripts/archive-review.sh"
L=".local/archive-review.jsonl"

row() { # row <id> <model> <round> <seconds> <need_fix> <ok> <ts>
  printf '{"kind": "review", "id": "%s", "round": %s, "model": "%s", "seconds": %s, "need_fix": %s, "risk": 0, "fp": 0, "ok": %s, "session": "", "ts": "%s"}\n' "$1" "$3" "$2" "$4" "$5" "$6" "$7" >> "$L"
}
judge() { printf '{"kind": "judge", "id": "%s", "model": "%s", "finding": %s, "verdict": "%s", "note": "", "ts": "2026-01-02T00:00:00+00:00"}\n' "$1" "$2" "$3" "$4" >> "$L"; }
ts() { printf '2026-01-01T%02d:%02d:00+00:00' "$1" "$2"; }
r1md() { # r1md <id> <model> <n 條需修正>
  mkdir -p ".local/archive-review/$1/r1"; { for i in $(seq 1 "$3"); do echo "[需修正] APP-C01-S0$i — a.ts:1 — x — 驗證：y"; done; echo "結論：需修正 $3 條／可接受風險 0 條／誤報候選 0 條"; } > ".local/archive-review/$1/r1/$2.md"
}
report() { $AR --report 2>&1; }
expect_rc() { # expect_rc <rc> <label> <cmd...>
  local want=$1 label=$2; shift 2; local out rc; out="$("$@" 2>&1)"; rc=$?
  [ "$rc" = "$want" ] && ok "$label" || bad "$label" "rc=${rc}（要 ${want}）：$(echo "$out" | tail -1)"
}
expect_grep() { # expect_grep <pattern> <label> <cmd...>
  local pat=$1 label=$2; shift 2; local out; out="$("$@" 2>&1)"
  echo "$out" | grep -q -- "$pat" && ok "$label" || bad "$label" "沒看到「${pat}」：$(echo "$out" | tail -2 | tr '\n' ' ')"
}

echo "── archive-review：輸入 ──"
expect_rc 2 "change id 帶路徑字元被擋"            $AR 'app-c01/../x'
expect_rc 2 "change id 大寫被擋"                  $AR 'APP-C01-x'
expect_rc 2 "--judge 模型名不在兩個之內被擋"       $AR app-c01-x --judge claude 1 誤報
expect_rc 2 "--judge 判定不在三種之內被擋"         $AR app-c01-x --judge codex 1 可能

echo "── archive-review：--report 的樣本 ──"
: > "$L"
# 11 個 change 兩個模型都答了；第 12 個只有 codex 答；第 1 個 codex 有 1 條需修正
for k in $(seq 1 11); do row "app-c$k-x" codex 1 100 "$([ "$k" = 1 ] && echo 1 || echo 0)" true "$(ts 1 "$k")"; row "app-c$k-x" gemini 1 200 0 true "$(ts 2 "$k")"; done
row app-half-x codex 1 50 1 true "$(ts 0 1)"; row app-half-x gemini 1 0 0 false "$(ts 0 1)"
expect_grep "不算樣本的：1 個（app-half-x）" "只有一個模型回答的不算樣本" report
expect_grep "app-c10-x）" "樣本取最早 10 個" report
out="$(report)"; echo "$out" | grep -q "app-c11-x" && bad "第 11 個 change 不進樣本" "報告提到 app-c11-x" || ok "第 11 個 change 不進樣本"
expect_grep "還沒判定 1" "需修正沒判定 → 報告數得出來" report
expect_grep "不能下結論" "需修正沒判定 → 不下結論" report
# 補跑：app-half-x 的 gemini 後來答了 → 它排到最後，不插隊
row app-half-x gemini 1 10 0 true "$(ts 3 0)"
expect_grep "app-c10-x）" "補跑不插隊：樣本仍是 c1–c10" report
out="$(report)"; echo "$out" | grep -q "app-half-x）" && bad "補跑不插隊：app-half-x 不在樣本裡" || ok "補跑不插隊：app-half-x 不在樣本裡"

echo "── archive-review：--judge 與升阻塞 ──"
r1md app-c1-x codex 1
expect_rc 2 "--judge 第 2 條不存在被擋"                       $AR app-c1-x --judge codex 2 誤報
expect_rc 2 "--judge 沒回審不能標「已修」"                     $AR app-c1-x --judge codex 1 已修
expect_rc 0 "--judge 已驗證（還沒修）收下"                     $AR app-c1-x --judge codex 1 已驗證
expect_rc 2 "--judge 同一條不能判兩次"                         $AR app-c1-x --judge codex 1 誤報
expect_grep "已驗證但沒修 1" "已驗證記進報告" report
expect_grep "不成立" "只有已驗證、沒有已修 → 不成立" report
# 有回審之後才能標已修
mkdir -p .local/archive-review/app-c2-x/r1 .local/archive-review/app-c2-x/r2; r1md app-c2-x codex 2
echo "1. 已修" > .local/archive-review/app-c2-x/r2/codex.md
expect_rc 0 "--judge 回審過可以標「已修」"                     $AR app-c2-x --judge codex 1 已修
expect_rc 0 "--judge 第二條標誤報"                             $AR app-c2-x --judge codex 2 誤報
# 帳本裡 c2 的需修正是 0（上面的 row），手動補成 2 條讓 pending 對得上
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
for r in rows:
    if r.get("kind")=="review" and r["id"]=="app-c2-x" and r["model"]=="codex": r["need_fix"]=2
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "已修 1、已驗證但沒修 1、誤報 1、\*\*還沒判定 0\*\*" "三種判定各算各的" report
expect_grep "不成立" "已修 1 < 門檻 → 不成立" report
# 再一條已修 → 已修 2、誤報 1/3=33% → 仍不成立（誤報率）
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
for r in rows:
    if r.get("kind")=="judge" and r["id"]=="app-c1-x": r["verdict"]="已修"
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "誤報率 33%" "誤報率算對" report
expect_grep "不成立" "誤報率超過 → 不成立" report
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
for r in rows:
    if r.get("kind")=="judge" and r["verdict"]=="誤報": r["verdict"]="已修"
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "條件全部成立" "全部已修、樣本滿、等待在門檻內 → 成立" report

echo "── archive-review：答過的不重跑 ──"
mkdir -p openspec/changes/app-c1-x
expect_grep "不要移走 r1" "帳本說 gemini 答過、r1/gemini.md 不在 → 拒絕" $AR app-c1-x
r1md app-c1-x gemini 0
expect_grep "都答過了" "兩個都答過 → 拒絕重跑、指向 --rereview" $AR app-c1-x

echo
echo "通過 $PASS / 失敗 $FAIL / 共 $((PASS+FAIL))"
[ "$FAIL" -eq 0 ]
