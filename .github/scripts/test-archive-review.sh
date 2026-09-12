#!/usr/bin/env bash
# `archive-review.sh` 的帳本與判定邏輯的測試。它是影子不是閘門，但 `--report` 的結論會被人拿去決定
# 「升阻塞還是拆掉」—— 報錯的尺比沒有尺更糟（同 check-scenario-coverage 留測試的理由）。
#
# 測的是**可以把數字做出來的洞**（第 11–12 輪外部審查點名的）：
#   只有一個模型回答的 change 不算樣本；樣本是最早 N 個、第 N+1 個不算；補跑不會插隊；
#   還有需修正沒判定就不下結論；「已驗證」不算升阻塞的數，「已修」才算，而「已修」要有回審；
#   帳本說答過、檔案卻不在 → 拒絕重跑；兩個都答過 → 拒絕重跑；補跑沿用第一輪的 bundle 與 main.sha；
#   「已修」要那個模型第二輪對那一號寫「已修」；任一 PR 的 diff 拿不到 → 整輪不算數。
# 判準跟其他幾支一樣：**把對應的守衛拿掉，這支要變紅。**
#
# 零依賴：bash + git + 系統 python3。**不打網路、不叫模型**：origin 是 repo 自己，gh 是照 $GH_MODE 回話的替身，
# 模型執行檔指到不存在的路徑（腳本會「明說跳過」而不送出）。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/archive-review.sh"
W="$(mktemp -d "${TMPDIR:-/tmp}/archive-review-test.XXXXXXXX")"
trap 'rm -rf "$W"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; return 0; }

# ── 假 repo：腳本、progress.sh、main 上的規格、.local；origin 指回自己 ──────────────────────────
mkdir -p "$W/repo/.github/scripts" "$W/repo/.local/archive-review" "$W/bin"
cp "$SCRIPT" "$ROOT/.github/scripts/progress.sh" "$W/repo/.github/scripts/"
cd "$W/repo" || exit 1
git init -q -b main . && git config user.email t@t && git config user.name t
mkdir -p openspec/changes/app-c1-x openspec/changes/app-c2-x
echo "# proposal" > openspec/changes/app-c1-x/proposal.md; echo "# proposal" > openspec/changes/app-c2-x/proposal.md
git add -A && git commit -qm "spec" && git remote add origin "$W/repo"
# gh 替身：pr list 回一個 PR（merge commit＝現在的 HEAD），pr diff 照 $GH_MODE 決定成功或失敗
cat > "$W/bin/gh" <<'GHEOF'
#!/bin/bash
case "$1 $2" in
  "pr list") sha=$(git rev-parse HEAD); printf '[{"number":7,"headRefName":"%s","mergeCommit":{"oid":"%s"},"mergedAt":"2026-01-01T00:00:00Z","body":"PR 說明"}]\n' "$GH_BRANCH" "$sha" ;;
  "pr diff") [ "$(cat "$GH_MODE")" = ok ] && printf 'diff --git a/x.ts b/x.ts\n+1\n' || { echo boom >&2; exit 1; } ;;
  *) exit 0 ;;
esac
GHEOF
chmod +x "$W/bin/gh"; export GH_MODE="$W/gh-mode" GH_BRANCH="feat/app-c1-x--a"; echo ok > "$GH_MODE"
mkdir -p prompts && cp "$ROOT/prompts/06-archive-review.md" prompts/
export PATH="$W/bin:$PATH" ARCHIVE_REVIEW_CODEX_BIN=/nonexistent/codex ARCHIVE_REVIEW_GEMINI_BIN=/nonexistent/agy
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
# 有回審、而且那個模型對那一號說「已修」，才能標已修（第二輪的編號：codex 的在前、gemini 的在後）
mkdir -p .local/archive-review/app-c2-x/r1 .local/archive-review/app-c2-x/r2; r1md app-c2-x codex 2; r1md app-c2-x gemini 1
printf '1. 未修\n2. 已修\n3. 已修\n' > .local/archive-review/app-c2-x/r2/codex.md
printf '1. 已修\n2. 已修\n3. 未修\n' > .local/archive-review/app-c2-x/r2/gemini.md
expect_rc 2 "--judge 第二輪說「未修」的不能標「已修」"           $AR app-c2-x --judge codex 1 已修
expect_rc 0 "--judge 第二輪說「已修」的可以標「已修」"           $AR app-c2-x --judge codex 2 已修
expect_rc 2 "--judge gemini 第 1 條對到第二輪第 3 號（未修）"    $AR app-c2-x --judge gemini 1 已修
expect_rc 0 "--judge 說未修的那條還是可以標誤報"                 $AR app-c2-x --judge codex 1 誤報
judge app-c2-x gemini 1 誤報
# 帳本裡 c2 的需修正是 0（上面的 row），手動補成 codex 2、gemini 1 讓 pending 對得上
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
for r in rows:
    if r.get("kind")=="review" and r["id"]=="app-c2-x": r["need_fix"]={"codex":2,"gemini":1}[r["model"]]
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "已修 1、已驗證但沒修 1、誤報 2、\*\*還沒判定 0\*\*" "三種判定各算各的" report
expect_grep "不成立" "已修 1 < 門檻 → 不成立" report
# 再一條已修 → 已修 2、誤報 2/4=50% → 仍不成立（誤報率）
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
for r in rows:
    if r.get("kind")=="judge" and r["id"]=="app-c1-x": r["verdict"]="已修"
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "誤報率 50%" "誤報率算對" report
expect_grep "不成立" "誤報率超過 → 不成立" report
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
for r in rows:
    if r.get("kind")=="judge" and r["verdict"]=="誤報": r["verdict"]="已修"
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "條件全部成立" "全部已修、樣本滿、等待在門檻內 → 成立" report

echo "── archive-review：答過的不重跑、樣本凍結、diff fail-closed ──"
expect_grep "不要移走 r1" "帳本說 gemini 答過、r1/gemini.md 不在 → 拒絕" $AR app-c1-x
r1md app-c1-x gemini 0
expect_grep "都答過了" "兩個都答過 → 拒絕重跑、指向 --rereview" $AR app-c1-x
# 新的 change：第一次跑（兩個模型都「找不到 CLI」→ 都不算數，但 bundle 與 main.sha 留下）
python3 -c 'open(".local/archive-review.jsonl","w").close()'
mkdir -p openspec/changes/app-c3-x; echo "# p" > openspec/changes/app-c3-x/proposal.md; git add -A && git commit -qm spec3
export GH_BRANCH="feat/app-c3-x--a"
echo fail > "$GH_MODE"
expect_grep "拿不到 PR #7 的 diff" "PR diff 拿不到 → 整輪不算數" $AR app-c3-x
[ ! -s "$L" ] && ok "diff 拿不到 → 沒寫帳本" || bad "diff 拿不到 → 沒寫帳本"
echo ok > "$GH_MODE"
expect_grep "跳過 codex" "diff 拿得到 → 走到送出（模型不在就明說跳過）" $AR app-c3-x
grep -q "^+1$" .local/archive-review/app-c3-x/r1/bundle.md && ok "bundle 含 PR 的 diff" || bad "bundle 含 PR 的 diff"
grep -q "^# p$" .local/archive-review/app-c3-x/r1/bundle.md && ok "規格從 main 讀進 bundle" || bad "規格從 main 讀進 bundle"
SHA1="$(cat .local/archive-review/app-c3-x/r1/main.sha)"
echo "改了" >> openspec/changes/app-c3-x/proposal.md; git commit -qam "main 動了"
expect_grep "沿用第一輪的 bundle" "補跑沒回答的模型 → 沿用第一輪 bundle" $AR app-c3-x
[ "$(cat .local/archive-review/app-c3-x/r1/main.sha)" = "$SHA1" ] && ok "補跑不改 main.sha" || bad "補跑不改 main.sha"
grep -q "改了" .local/archive-review/app-c3-x/r1/bundle.md && bad "補跑不重建 bundle" || ok "補跑不重建 bundle"

echo
echo "通過 $PASS / 失敗 $FAIL / 共 $((PASS+FAIL))"
[ "$FAIL" -eq 0 ]
