#!/usr/bin/env bash
# `archive-review.sh` 的帳本與判定邏輯的測試。它是影子不是閘門，但 `--report` 的結論會被人拿去決定
# 「升阻塞還是拆掉」—— 報錯的尺比沒有尺更糟（同 check-scenario-coverage 留測試的理由）。
#
# 測的是**可以把數字做出來的洞**（第 11–12 輪外部審查點名的）：
#   只有一個模型回答的 change 不算樣本；樣本是最早 N 個、第 N+1 個不算；補跑不會插隊；
#   還有需修正沒判定就不下結論；「已驗證」不算升阻塞的數，「已修」才算，而「已修」要有回審；
#   帳本說答過、檔案卻不在 → 拒絕重跑；兩個都答過 → 拒絕重跑；補跑沿用第一輪的 bundle 與 main.sha；
#   「已修」要那個模型第二輪對那一號寫「已修」；任一 PR 的 diff 拿不到 → 整輪不算數；
#   第二輪照 prompts/06 原文答的算答完；逾時殺剩的孤兒寫不進發布的回答檔（第 20 輪）。
# 判準跟其他幾支一樣：**把對應的守衛拿掉，這支要變紅。**
#
# 零依賴：bash + git + 系統 python3。**不打網路、不叫模型**：origin 是 repo 自己，gh 是照 $GH_MODE 回話的替身，
# 模型執行檔指到不存在的路徑（腳本會「明說跳過」而不送出）。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/archive-review.sh"
W="$(mktemp -d "${TMPDIR:-/tmp}/archive-review-test.XXXXXXXX")"
trap 'touch "$W/orphan-go" "$W/orphan-go2"; rm -rf "$W"' EXIT   # 孤兒測試的子行程等這個檔才退，測試中途死掉也不留行程
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
  "pr list") sha=$(git rev-parse HEAD); [ "$(cat "$GH_MODE")" = offmain ] && sha=0000000000000000000000000000000000000000
    if [ "$(cat "$GH_MODE")" = many ]; then python3 -c 'import json;print(json.dumps([{"number":n,"headRefName":"feat/other","mergeCommit":{"oid":"0"*40},"mergedAt":"2026-01-01T00:00:00Z","body":""} for n in range(1000)]))'
    else printf '[{"number":7,"headRefName":"%s","mergeCommit":{"oid":"%s"},"mergedAt":"2026-01-01T00:00:00Z","body":"PR 說明"}]\n' "$GH_BRANCH" "$sha"; fi ;;
  "pr diff") { [ "$(cat "$GH_MODE")" = ok ] || [ "$(cat "$GH_MODE")" = offmain ]; } && printf 'diff --git a/x.ts b/x.ts\n+1\n' || { echo boom >&2; exit 1; } ;;
  *) exit 0 ;;
esac
GHEOF
chmod +x "$W/bin/gh"; export GH_MODE="$W/gh-mode" GH_BRANCH="feat/app-c1-x--a"; echo ok > "$GH_MODE"
mkdir -p prompts && cp "$ROOT/prompts/06-archive-review.md" prompts/
export PATH="$W/bin:$PATH" ARCHIVE_REVIEW_CODEX_BIN=/nonexistent/codex ARCHIVE_REVIEW_GEMINI_BIN=/nonexistent/agy
AR="bash .github/scripts/archive-review.sh"
L=".local/archive-review.jsonl"

row() { # row <id> <model> <round> <seconds> <need_fix> <ok> <ts>  —— ok 的 row 順手產生一份對得上的回答檔（已存在就不動）
  printf '{"kind": "review", "id": "%s", "round": %s, "model": "%s", "seconds": %s, "need_fix": %s, "risk": 0, "fp": 0, "ok": %s, "session": "", "ts": "%s"}\n' "$1" "$3" "$2" "$4" "$5" "$6" "$7" >> "$L"
  [ "$6" = true ] && [ ! -s ".local/archive-review/$1/r$3/$2.md" ] || return 0
  if [ "$3" = 1 ]; then r1md "$1" "$2" "$5"; else mkdir -p ".local/archive-review/$1/r2"; printf '1. 已修\n2. 已修\n3. 已修\n' > ".local/archive-review/$1/r2/$2.md"; fi
}
judge() { printf '{"kind": "judge", "id": "%s", "model": "%s", "finding": %s, "verdict": "%s", "note": "", "ts": "2026-01-02T00:00:00+00:00"}\n' "$1" "$2" "$3" "$4" >> "$L"; }
ts() { printf '2026-01-01T%02d:%02d:00+00:00' "$1" "$2"; }
r1md() { # r1md <id> <model> <n 條需修正>
  mkdir -p ".local/archive-review/$1/r1"; { i=0; while [ "$i" -lt "$3" ]; do i=$((i+1)); echo "[需修正] APP-C01-S0$i — a.ts:1 — x — 驗證：y"; done; echo "結論：需修正 $3 條／可接受風險 0 條／誤報候選 0 條"; } > ".local/archive-review/$1/r1/$2.md"
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
expect_rc 2 "--judge 第幾條寫「0」被擋"                 $AR app-c01-x --judge codex 0 誤報
expect_grep "不認得「--rereveiw」" "打錯的模式（--rereveiw）不能悄悄變第一輪"   $AR app-c01-x --rereveiw
expect_rc 2 "--rereview 帶多餘參數被擋"                  $AR app-c01-x --rereview foo
expect_rc 2 "--report 帶多餘參數被擋"                    $AR --report foo
out="$(ARCHIVE_REVIEW_TIMEOUT=abc $AR --report 2>&1)"; echo "$out" | grep -q "正整數秒數" && ok "ARCHIVE_REVIEW_TIMEOUT 不是正整數被擋" || bad "ARCHIVE_REVIEW_TIMEOUT 不是正整數被擋"

echo "── archive-review：--report 的樣本 ──"
: > "$L"
# 11 個 change 兩個模型都答了；第 12 個只有 codex 答；第 1 個 codex 有 1 條需修正
for k in $(seq 1 11); do row "app-c$k-x" codex 1 100 "$([ "$k" = 1 ] && echo 1 || echo 0)" true "$(ts 1 "$k")"; row "app-c$k-x" gemini 1 200 0 true "$(ts 2 "$k")"; done
row app-half-x codex 1 50 1 true "$(ts 0 1)"; row app-half-x gemini 1 0 0 false "$(ts 0 1)"
expect_grep "不算樣本的：1 個（app-half-x）" "只有一個模型回答的不算樣本" report
expect_grep "app-c10-x）" "樣本取最早 10 個" report
out="$(report)"; echo "$out" | grep -q "app-c11-x" && bad "第 11 個 change 不進樣本" "報告提到 app-c11-x" || ok "第 11 個 change 不進樣本"
expect_grep "還沒判定 1" "需修正沒判定 → 報告數得出來" report
# 結論說 1 條、明細沒有 → 這份回答不算數（report 排除、has_answer 也不算）
printf '結論：需修正 1 條／可接受風險 0 條／誤報候選 0 條\n' > .local/archive-review/app-c9-x/r1/codex.md
expect_grep "檔案卻不在或不完整：app-c9-x/codex" "第一輪結論數字跟明細對不上 → report 點名" report
expect_grep "不能下結論.*樣本不遞補" "樣本裡有一份不成立 → 不下結論、不遞補" report
out="$(report)"; echo "$out" | grep -q "app-c11-x" && bad "不遞補：第 11 個不能補進來" || ok "不遞補：第 11 個不能補進來"
r1md app-c9-x codex 0
# 同一把尺在腳本本體：帳本說答過、檔案結論說 2 條但明細 1 條 → 不完整 → 拒絕（不是「都答過了」）
mkdir -p openspec/changes/app-c8-x; echo "# p" > openspec/changes/app-c8-x/proposal.md; git add -A && git commit -qm spec8
printf '[需修正] x\n結論：需修正 2 條／可接受風險 0 條／誤報候選 0 條\n' > .local/archive-review/app-c8-x/r1/codex.md
expect_grep "不在或不完整" "第一輪結論數字跟明細對不上 → has_answer 不算、拒絕" $AR app-c8-x
printf '[需修正] x\n結論：需修正 1 條／可接受風險 0 條／誤報候選 0 條\n補充：其實還有一條\n' > .local/archive-review/app-c8-x/r1/codex.md
expect_grep "不在或不完整" "結論不是最後一行 → 不算完整" $AR app-c8-x
printf '[需修正] x\n結論：1 需修正、0 可接受、0 誤報\n' > .local/archive-review/app-c8-x/r1/codex.md
expect_grep "不在或不完整" "結論格式不固定 → 不算完整" $AR app-c8-x
r1md app-c8-x codex 0
expect_grep "不能下結論" "需修正沒判定 → 不下結論" report
# 補跑：app-half-x 的 gemini 後來答了 → 它排到最後，不插隊
row app-half-x gemini 1 10 0 true "$(ts 3 0)"
expect_grep "app-c10-x）" "補跑不插隊：樣本仍是 c1–c10" report
out="$(report)"; echo "$out" | grep -q "app-half-x）" && bad "補跑不插隊：app-half-x 不在樣本裡" || ok "補跑不插隊：app-half-x 不在樣本裡"

echo "── archive-review：--judge 與升阻塞 ──"
r1md app-half-x gemini 1   # 帳本裡 app-half-x/gemini 第一次是 ok=false（後來補答才 ok）——先確認判定綁的是算數的那份
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
rows=[r for r in rows if not (r.get("kind")=="review" and r["id"]=="app-half-x" and r["model"]=="gemini" and r.get("ok"))]
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_rc 2 "--judge 第一輪帳本只有 ok=false（半成品）→ 不能判" $AR app-half-x --judge gemini 1 誤報
row app-half-x gemini 1 10 0 true "$(ts 3 0)"
# app-c1-x：codex 第一輪 1 條（helper 產的檔對得上帳本）
expect_rc 2 "--judge 第 2 條不存在被擋"                       $AR app-c1-x --judge codex 2 誤報
expect_rc 2 "--judge 沒回審不能標「已修」"                     $AR app-c1-x --judge codex 1 已修
expect_rc 0 "--judge 已驗證（還沒修）收下"                     $AR app-c1-x --judge codex 1 已驗證
expect_rc 2 "--judge 同一條不能判兩次"                         $AR app-c1-x --judge codex 1 誤報
expect_rc 2 "--judge 第幾條寫「01」被擋（不然繞得過「判過了」）" $AR app-c1-x --judge codex 01 誤報
expect_grep "已驗證但沒修 1" "已驗證記進報告" report
expect_grep "不成立" "只有已驗證、沒有已修 → 不成立" report
# app-c2-x：codex 2 條、gemini 1 條（第二輪編號 1、2 是 codex 的，3 是 gemini 的）
r1md app-c2-x codex 2; r1md app-c2-x gemini 1
mkdir -p .local/archive-review/app-c2-x/r2
printf '1. 未修\n2. 已修\n3. 已修\n' > .local/archive-review/app-c2-x/r2/codex.md
printf '1. 已修\n2. 已修\n3. 未修\n' > .local/archive-review/app-c2-x/r2/gemini.md
expect_rc 2 "--judge 第二輪檔案在、帳本沒說算數 → 不能標「已修」"  $AR app-c2-x --judge codex 2 已修
row app-c2-x codex 2 10 0 false "$(ts 4 0)"
expect_rc 2 "--judge 第二輪帳本 ok=false（半成品）→ 不能標「已修」" $AR app-c2-x --judge codex 2 已修
row app-c2-x codex 2 10 0 true "$(ts 4 1)"; row app-c2-x gemini 2 10 0 true "$(ts 4 1)"
cp .local/archive-review/app-c2-x/r2/codex.md "$W/c2-codex-r2.bak"; printf '1. 已修\n2. 已修\n' > .local/archive-review/app-c2-x/r2/codex.md
expect_rc 2 "--judge 第二輪只答了 1、2 號（三條要答完）→ 不算數、不能標已修" $AR app-c2-x --judge codex 2 已修
printf '2. 已修\n1. 已修\n2. 未修\n3. 已修\n' > .local/archive-review/app-c2-x/r2/codex.md
expect_rc 2 "--judge 第二輪同一號出現兩次（矛盾）→ 不算數、不能標已修" $AR app-c2-x --judge codex 2 已修
printf '1. 已修\n2. 已修\n3. 已修\n4. 已修\n' > .local/archive-review/app-c2-x/r2/codex.md
expect_rc 2 "--judge 第二輪多了第 4 號（只有 3 條）→ 不算數" $AR app-c2-x --judge codex 2 已修
printf '1. 已修\n2. 已修但其實不確定\n3. 已修\n' > .local/archive-review/app-c2-x/r2/codex.md
expect_rc 2 "--judge 「已修但其實不確定」不是已修" $AR app-c2-x --judge codex 2 已修
cp "$W/c2-codex-r2.bak" .local/archive-review/app-c2-x/r2/codex.md
expect_rc 2 "--judge 第二輪說「未修」的不能標「已修」"           $AR app-c2-x --judge codex 1 已修
expect_rc 0 "--judge 第二輪說「已修」的可以標「已修」"           $AR app-c2-x --judge codex 2 已修
expect_rc 2 "--judge gemini 第 1 條對到第二輪第 3 號（未修）"    $AR app-c2-x --judge gemini 1 已修
expect_rc 0 "--judge 說未修的那條還是可以標誤報"                 $AR app-c2-x --judge codex 1 誤報
expect_rc 0 "--judge gemini 那條標誤報"                          $AR app-c2-x --judge gemini 1 誤報
expect_grep "已修 1、已驗證但沒修 1、誤報 2、\*\*還沒判定 0\*\*" "三種判定各算各的（數字從檔案來）" report
expect_grep "不成立" "已修 1 < 門檻 → 不成立" report
# 帳本裡把 app-c1-x 的已驗證改成已修，但沒有第二輪證據 → report 拒絕下結論
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
for r in rows:
    if r.get("kind")=="judge" and r["id"]=="app-c1-x": r["verdict"]="已修"
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "第二輪證據不成立.*app-c1-x/codex#1" "帳本說已修、沒有第二輪證據 → report 點名" report
expect_grep "不能下結論" "已修證據不成立 → 不下結論" report
# 補上證據 → 已修 2、誤報 2/4=50% → 仍不成立（誤報率）
mkdir -p .local/archive-review/app-c1-x/r2; printf '1. 已修\n' > .local/archive-review/app-c1-x/r2/codex.md; printf '1. 已修\n' > .local/archive-review/app-c1-x/r2/gemini.md
row app-c1-x codex 2 10 0 true "$(ts 4 3)"; row app-c1-x gemini 2 10 0 true "$(ts 4 3)"
expect_grep "誤報率 50%" "誤報率算對" report
expect_grep "不成立" "誤報率超過 → 不成立" report
# 判定改成全部已修、第二輪檔案也改成全部已修 → 成立
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
for r in rows:
    if r.get("kind")=="judge" and r["verdict"]=="誤報": r["verdict"]="已修"
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "不能下結論" "判定改了、第二輪檔案還說未修 → 不能下結論" report
printf '1. 已修\n2. 已修\n3. 已修\n' > .local/archive-review/app-c2-x/r2/codex.md; cp .local/archive-review/app-c2-x/r2/codex.md .local/archive-review/app-c2-x/r2/gemini.md
expect_grep "條件全部成立" "全部已修、有證據、樣本滿、等待在門檻內 → 成立" report
# 第二輪某一號重複出現（矛盾），即使不是被判的那一號 → 那份回答不完整 → 不能下結論
printf '1. 已修\n2. 已修\n3. 已修\n3. 未修\n' > .local/archive-review/app-c2-x/r2/codex.md
expect_grep "不能下結論" "第二輪同一號出現兩次 → report 不算那份回答" report
printf '1. 已修\n2. 已修\n3. 已修\n' > .local/archive-review/app-c2-x/r2/codex.md
# 判定寫進帳本之後，把第二輪檔案截短 → report 要退回不能下結論（證據是檔案，不是帳本）
printf '1. 已修\n' > .local/archive-review/app-c1-x/r2/codex.md; printf '' > .local/archive-review/app-c2-x/r2/codex.md
expect_grep "不能下結論" "判定後第二輪檔案被截短 → 不能下結論" report
printf '1. 已修\n2. 已修\n3. 已修\n' > .local/archive-review/app-c2-x/r2/codex.md
# 同一條在帳本裡出現兩筆判定（手改的）→ 不能下結論
judge app-c2-x codex 2 已修
expect_grep "被判了不只一次.*app-c2-x/codex#2" "同一條兩筆判定 → 點名" report
expect_grep "不能下結論" "同一條兩筆判定 → 不下結論" report
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
seen=set(); out=[]
for r in rows:
    k=(r.get("kind"),r.get("id"),r.get("model"),r.get("finding"))
    if r.get("kind")=="judge" and k in seen: continue
    seen.add(k); out.append(r)
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in out)+"\n")
ZZPY
expect_grep "條件全部成立" "去掉重複那筆 → 成立" report
judge app-c2-x codex 1 大概吧
expect_grep "帳本欄位不合" "未知的判定值（手改）→ 不能下結論" report
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
rows=[r for r in rows if r.get("verdict")!="大概吧"]
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "條件全部成立" "去掉那筆 → 成立" report
# 第一輪檔案內部一致、但數量跟帳本不同 → report 用檔案的數字（多出一條沒判定 → 不能下結論）
r1md app-c5-x codex 1
expect_grep "還沒判定 1" "第一輪檔案的數量才算數，不是帳本的" report
r1md app-c5-x codex 0
expect_grep "條件全部成立" "改回去 → 成立" report
# codex 第一輪 0 條需修正時，gemini 的編號從 1 起算（grep -c 找不到時 exit 1 的雷）
mkdir -p .local/archive-review/app-c4-x/r2; r1md app-c4-x codex 0; r1md app-c4-x gemini 1
printf '1. 已修\n' > .local/archive-review/app-c4-x/r2/gemini.md; row app-c4-x gemini 2 10 0 true "$(ts 4 2)"
expect_rc 0 "--judge codex 0 條時 gemini 第 1 條對到第 1 號"       $AR app-c4-x --judge gemini 1 已修
# 已修的證據要三件齊：第二輪 ok row、1..N 全答、那一號寫已修 —— 各缺一件都要被 report 點名
python3 - <<'ZZPY'
import json,pathlib
p=pathlib.Path(".local/archive-review.jsonl"); rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
rows=[r for r in rows if not (r.get("kind")=="review" and r["id"]=="app-c4-x" and r["round"]==2)]
p.write_text("\n".join(json.dumps(r,ensure_ascii=False) for r in rows)+"\n")
ZZPY
expect_grep "第二輪證據不成立.*app-c4-x/gemini#1" "第二輪 ok row 不在 → 已修證據不成立" report
row app-c4-x gemini 2 10 0 true "$(ts 4 2)"
r1md app-c4-x codex 1; printf '2. 已修\n' > .local/archive-review/app-c4-x/r2/gemini.md   # N=2，只答了自己那一號
expect_grep "第二輪證據不成立.*app-c4-x/gemini#1" "第二輪沒答完（1..N）→ 已修證據不成立" report
printf '1. 改壞了別的 — 哪裡\n2. 已修\n' > .local/archive-review/app-c4-x/r2/gemini.md   # 第 1 號照 prompts/06 原文答
out="$(report)"; echo "$out" | grep -q "第二輪證據不成立.*app-c4-x/gemini#1" && bad "report 的文法跟腳本一致：「改壞了別的」算答完" || ok "report 的文法跟腳本一致：「改壞了別的」算答完"
r1md app-c4-x codex 0; printf '1. 已修\n' > .local/archive-review/app-c4-x/r2/gemini.md

echo "── archive-review：答過的不重跑、樣本凍結、diff fail-closed ──"
python3 -c 'import os;os.remove(".local/archive-review/app-c1-x/r1/gemini.md")'   # helper 產的那份拿掉，模擬有人移走
expect_grep "不要移走" "帳本說 gemini 答過、r1/gemini.md 不在 → 拒絕" $AR app-c1-x
r1md app-c1-x gemini 0
expect_grep "都答過了" "兩個都答過 → 拒絕重跑、指向 --rereview" $AR app-c1-x
# 新的 change：第一次跑（兩個模型都「找不到 CLI」→ 都不算數，但 bundle 與 main.sha 留下）
python3 -c 'open(".local/archive-review.jsonl","w").close()'
mkdir -p openspec/changes/app-c3-x; echo "# p" > openspec/changes/app-c3-x/proposal.md; git add -A && git commit -qm spec3
export GH_BRANCH="feat/app-c3-x--a"
echo many > "$GH_MODE"
expect_grep "可能被截斷" "gh pr list 剛好 1000 筆 → 清單可能截斷 → 整輪不算數" $AR app-c3-x
echo offmain > "$GH_MODE"
expect_grep "不在這一輪釘住的 main" "slice 的 merge commit 不在釘住的 main 上 → 整輪不算數" $AR app-c3-x
echo fail > "$GH_MODE"
expect_grep "拿不到 PR #7 的 diff" "PR diff 拿不到 → 整輪不算數" $AR app-c3-x
mkdir -p .local/archive-review/app-c3-x/r1/.lock
expect_grep "同一輪已經在跑" "lock 在 → 拒絕同時跑第二個" $AR app-c3-x
rmdir .local/archive-review/app-c3-x/r1/.lock
[ ! -s "$L" ] && ok "diff 拿不到 → 沒寫帳本" || bad "diff 拿不到 → 沒寫帳本"
echo ok > "$GH_MODE"
expect_grep "跳過 codex" "diff 拿得到 → 走到送出（模型不在就明說跳過）" $AR app-c3-x
grep -q "^+1$" .local/archive-review/app-c3-x/r1/bundle.md && ok "bundle 含 PR 的 diff" || bad "bundle 含 PR 的 diff"
grep -q "^# p$" .local/archive-review/app-c3-x/r1/bundle.md && ok "規格從 main 讀進 bundle" || bad "規格從 main 讀進 bundle"
SHA1="$(cat .local/archive-review/app-c3-x/r1/main.sha)"
echo "改了" >> openspec/changes/app-c3-x/proposal.md; git commit -qam "main 動了"
expect_grep "沿用第 1 輪已組好的 bundle" "補跑沒回答的模型 → 沿用第一輪 bundle" $AR app-c3-x
[ "$(cat .local/archive-review/app-c3-x/r1/main.sha)" = "$SHA1" ] && ok "補跑不改 main.sha" || bad "補跑不改 main.sha"
grep -q "改了" .local/archive-review/app-c3-x/r1/bundle.md && bad "補跑不重建 bundle" || ok "補跑不重建 bundle"
# CLI 非零但留下格式完整的半成品：帳本 ok=false → 不算答過，補跑要重送（模型不在 → 印跳過，而不是「已經答過」）
{ echo "[需修正] x"; echo "結論：需修正 1 條／可接受風險 0 條／誤報候選 0 條"; } > .local/archive-review/app-c3-x/r1/codex.md
expect_grep "跳過 codex" "帳本 ok=false 的半成品不算答過 → 重送" $AR app-c3-x
out="$($AR app-c3-x 2>&1)"; echo "$out" | grep -q "codex 第 1 輪已經答過" && bad "半成品不該被當成答過" || ok "半成品不該被當成答過"
# 第二輪也一樣：diff 失敗留下 r2/ 不能變成「第三輪」；兩個都答過第二輪才是只准一次
row app-c3-x codex 1 10 1 true "$(ts 5 0)"; r1md app-c3-x codex 1   # 上一步重送把檔案蓋掉了，補回一份算數的
expect_grep "兩個模型的第一輪都答完才能回審" "只有一個模型答完第一輪 → 不能開第二輪" $AR app-c3-x --rereview
row app-c3-x gemini 1 10 0 true "$(ts 5 1)"; r1md app-c3-x gemini 0
echo fail > "$GH_MODE"
expect_grep "拿不到 PR #7 的 diff" "第二輪 diff 拿不到 → 這輪不算數" $AR app-c3-x --rereview
echo ok > "$GH_MODE"
expect_grep "跳過 codex" "第二輪 diff 失敗過之後還能再跑（不是第三輪）" $AR app-c3-x --rereview
grep -q "^1\. " .local/archive-review/app-c3-x/r2/bundle.md && ok "第二輪 bundle 把需修正編號" || bad "第二輪 bundle 把需修正編號"
# 第二輪的回答照 prompts/06 的原文寫（`3. 改壞了別的 — 哪裡`）要算答過 —— 文法跟提示不一致，照提示答的會被判沒答完
printf '1. 改壞了別的 — 哪裡\n' > .local/archive-review/app-c3-x/r2/codex.md; printf '1. 未修 — 為什麼\n' > .local/archive-review/app-c3-x/r2/gemini.md
row app-c3-x codex 2 10 0 true "$(ts 6 0)"; row app-c3-x gemini 2 10 0 true "$(ts 6 0)"
expect_grep "回審只准一次" "兩個都答過第二輪（照 prompt 原文答）→ 第三輪拒絕" $AR app-c3-x --rereview
printf '1. 改壞了別的東西\n' > .local/archive-review/app-c3-x/r2/codex.md
expect_grep "不在或不完整" "「改壞了別的東西」不是封閉列舉裡的詞 → codex 第二輪不算完整（帳本說答過 → 拒絕）" $AR app-c3-x --rereview

echo "── archive-review：逾時殺不乾淨的孤兒寫不進回答檔 ──"
# 父行程被 TERM 就退（watch 不會升級 KILL），子行程忽略 TERM、被 reparent 後還握著 stdout；等測試放行才寫。
cat > "$W/bin/codex-orphan" <<'ZZ'
#!/bin/bash
( trap '' TERM; while [ ! -f "$ORPHAN_GO" ]; do sleep 1; done; echo "結論：需修正 9 條／可接受風險 0 條／誤報候選 0 條" ) &
sleep 300
ZZ
cat > "$W/bin/codex-good" <<'ZZ'
#!/bin/bash
cat > /dev/null; echo "結論：需修正 0 條／可接受風險 0 條／誤報候選 0 條"
ZZ
chmod +x "$W/bin/codex-orphan" "$W/bin/codex-good"
mkdir -p openspec/changes/app-c6-x; echo "# p" > openspec/changes/app-c6-x/proposal.md; git add -A && git commit -qm spec6
export GH_BRANCH="feat/app-c6-x--a" ORPHAN_GO="$W/orphan-go"
out="$(ARCHIVE_REVIEW_TIMEOUT=1 ARCHIVE_REVIEW_CODEX_BIN="$W/bin/codex-orphan" $AR app-c6-x 2>&1)"
echo "$out" | grep -q "codex 沒有回答（rc=124" && ok "逾時 → rc=124、這次不算數" || bad "逾時 → rc=124、這次不算數" "$(echo "$out" | tail -2 | tr '\n' ' ')"
grep -q "逾時" .local/archive-review/app-c6-x/r1/codex.md && ok "逾時後回答檔只寫了「逾時」" || bad "逾時後回答檔只寫了「逾時」"
expect_grep "需修正 0 條" "重送（好的 CLI）→ 發布的是這一次的回答" bash -c "ARCHIVE_REVIEW_CODEX_BIN=$W/bin/codex-good ARCHIVE_REVIEW_GEMINI_BIN=$W/bin/codex-good $AR app-c6-x >/dev/null 2>&1; cat .local/archive-review/app-c6-x/r1/codex.md"
grep -q "需修正 0 條" .local/archive-review/app-c6-x/r1/gemini.md && ok "gemini 那條路徑也經過暫存檔發布" || bad "gemini 那條路徑也經過暫存檔發布"
grep -q '"model": "gemini".*"ok": true' "$L" && ok "gemini 帳本 ok" || bad "gemini 帳本 ok"
touch "$ORPHAN_GO"; sleep 3
grep -q "需修正 9 條" .local/archive-review/app-c6-x/r1/codex.md && bad "逾時的孤兒寫進了發布的回答檔" || ok "逾時的孤兒寫不進發布的回答檔"
grep -q "需修正 9 條" .local/archive-review/app-c6-x/r1/codex.timeout.md && ok "孤兒的輸出落在逾時那份暫存檔（證明孤兒真的活著寫了）" || bad "孤兒的輸出落在逾時那份暫存檔（證明孤兒真的活著寫了）"
# 第 21 輪：CLI **正常退出（rc=0）**但留下還握著 stdout 的子行程 —— 發布必須換 inode（cp），不然孤兒之後照樣寫進發布檔
cat > "$W/bin/codex-leaky" <<'ZZ'
#!/bin/bash
cat > /dev/null; echo "結論：需修正 0 條／可接受風險 0 條／誤報候選 0 條"
( trap '' TERM; while [ ! -f "$ORPHAN_GO2" ]; do sleep 1; done; echo "結論：需修正 8 條／可接受風險 0 條／誤報候選 0 條" ) &
exit 0
ZZ
chmod +x "$W/bin/codex-leaky"
mkdir -p openspec/changes/app-c7-x; echo "# p" > openspec/changes/app-c7-x/proposal.md; git add -A && git commit -qm spec7
export GH_BRANCH="feat/app-c7-x--a" ORPHAN_GO2="$W/orphan-go2"
expect_grep "需修正 0 條" "rc=0 但留孤兒 → 發布的是退出當下的回答" bash -c "ARCHIVE_REVIEW_CODEX_BIN=$W/bin/codex-leaky $AR app-c7-x >/dev/null 2>&1; cat .local/archive-review/app-c7-x/r1/codex.md"
touch "$ORPHAN_GO2"; sleep 3
grep -q "需修正 8 條" .local/archive-review/app-c7-x/r1/codex.md && bad "rc=0 留下的孤兒寫進了發布檔（mv 沒換 inode）" || ok "rc=0 留下的孤兒寫不進發布檔（cp 換了 inode）"
ls .local/archive-review/app-c7-x/r1/ | grep -Eq "^codex\.[A-Za-z0-9]{6}$" && bad "成功發布後暫存檔要刪掉" || ok "成功發布後暫存檔刪掉了"

echo
echo "通過 $PASS / 失敗 $FAIL / 共 $((PASS+FAIL))"
[ "$FAIL" -eq 0 ]
