#!/usr/bin/env bash
# archive 前的雙模型影子審查：把一個 change 的**全部**攤給第二、第三個模型看一次。
#
#   bash .github/scripts/archive-review.sh <change-id>                    第一輪：bundle → 兩個模型平行 → 結果＋帳本
#   bash .github/scripts/archive-review.sh <change-id> --rereview         第二輪（**只准一次**）：修正後的 diff 對上一輪的「需修正」
#   bash .github/scripts/archive-review.sh <change-id> --judge <codex|gemini> <第N條需修正> <誤報|已驗證|已修> [備註]
#                                                                         已修 ＝ 重現了、修了、而且那個模型回審過（要有 r2）
#   bash .github/scripts/archive-review.sh --report                       帳本結算：升阻塞的條件成不成立
#
# 為什麼有這支：當一個 change 的每個 slice 都由同一個作者（人或 agent）寫、同一個人合併，單一 slice 的 PR review
# 看不到跨 slice 的不一致、規格說了但沒有任何 slice 做的缺口。審查單位所以是 change（archive 前一次），不是 PR。
# 這支是模板的共用治理腳本：**真源在 ai-team-starter**，衍生專案逐字拿，要改回模板改。
#
# **是影子試跑，不阻塞。** 跑在 `/opsx:archive` 之前、`tasks.md` 全勾之後；結果只有三種標籤
# （需修正／可接受風險／誤報候選），只有指得出規格與檔案、給得出驗證方法的才算需修正。
# 升成阻塞的條件只定義在下面那幾個常數，`--report` 會把用到的條件印出來；AGENTS／DECISIONS 不重複數值。
# **不成立就刪這支、prompts/06 與帳本，不留空殼。** 修正之後回審**只准一次**；還要第三輪就是這套流程在製造等待。
#
# 產物全在 `.local/archive-review/`（gitignore）：`<id>/r1|r2/{bundle,codex,gemini}.md`、`.local/archive-review.jsonl`。
# 模型與執行檔走環境變數：ARCHIVE_REVIEW_CODEX（模型）、ARCHIVE_REVIEW_CODEX_BIN（預設 codex）、
# ARCHIVE_REVIEW_GEMINI（模型）、ARCHIVE_REVIEW_GEMINI_BIN（預設 agy）、ARCHIVE_REVIEW_TIMEOUT（秒）。
# 哪個 CLI 不在就**明說跳過**並記進帳本；少一個模型的 change 不算雙模型樣本。
set -euo pipefail

# ── 升阻塞的條件（唯一定義處；改這裡，report 會印出來） ──────────────────────────────────────────
TRIAL_N=10          # 試驗樣本：最早的 N 個「兩個模型都回答了」的 change，之後的不算（樣本凍結，不能一直跑到成立為止）
MIN_VERIFIED=2      # 樣本內，經人工判定「已修」（重現了、修了、回審過）的需修正 ≥ 這個數；「已驗證」只算真陽性，不算這個
MAX_FP=20           # 樣本內，人工判定的誤報率 ≤ 這個百分比；**任何一條需修正還沒判定，就不能下結論**
MAX_WAIT_P90=1200   # 樣本內，每個 change 的等待（兩個模型裡慢的那個）P90 ≤ 這個秒數（nearest-rank）

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
LEDGER=".local/archive-review.jsonl"
CODEX_BIN="${ARCHIVE_REVIEW_CODEX_BIN:-codex}";  CODEX_MODEL="${ARCHIVE_REVIEW_CODEX:-gpt-5.6-sol}"
GEMINI_BIN="${ARCHIVE_REVIEW_GEMINI_BIN:-agy}";  GEMINI_MODEL="${ARCHIVE_REVIEW_GEMINI:-gemini-3.1-pro-high}"
mkdir -p .local/archive-review

ledger() { python3 -c 'import json,sys,datetime;d=json.loads(sys.argv[1]);d["ts"]=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds");print(json.dumps(d,ensure_ascii=False))' "$1" >> "$LEDGER"; }
TAG='^[[:space:]]*([-*]|[0-9]+[.)])?[[:space:]]*'
count() { grep -Ec "${TAG}\[$2\]" "$1" 2>/dev/null || true; }
# 一次審查「算數」的條件：CLI rc=0 而且真的照格式回答了 —— 第一輪要有結論那一行，第二輪要有逐條的 已修／未修／改壞了別的。
# 沒回答的記 ok=false，report 不算它。
answered() { # answered <rc> <file> [round]
  [ "$1" = 0 ] || { echo false; return; }
  if [ "${3:-1}" = 2 ]; then grep -Eq "已修|未修|改壞了" "$2" && echo true || echo false
  else grep -q "^結論[：:]" "$2" && echo true || echo false; fi
}
# 沒有 coreutils timeout（macOS）：自己盯。超過 ARCHIVE_REVIEW_TIMEOUT（預設 1500 秒）就殺，不要讓 wait 等到天亮。
watch() { local pid=$1 t=0; while kill -0 "$pid" 2>/dev/null; do [ "$t" -ge "${ARCHIVE_REVIEW_TIMEOUT:-1500}" ] && { kill "$pid" 2>/dev/null; return 124; }; sleep 5; t=$((t+5)); done; wait "$pid"; }

if [ "${1:-}" = "--report" ]; then
  [ -s "$LEDGER" ] || { echo "帳本是空的（${LEDGER}）"; exit 0; }
  python3 - "$LEDGER" "$TRIAL_N" "$MIN_VERIFIED" "$MAX_FP" "$MAX_WAIT_P90" <<'ZZPY'
import json, sys, math
rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
N, MINV, MAXFP, MAXP90 = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
rev = [r for r in rows if r.get("kind") == "review"]
r1ok = {}                                             # id → {model: 最早回答了的第一輪 row}；之後的重跑不算
for r in rev:
    if r["round"] == 1 and r.get("ok", True): r1ok.setdefault(r["id"], {}).setdefault(r["model"], r)   # 舊 row 沒有 ok 欄：當時只有回答了才會寫 row
seen = [r["id"] for r in rev if r["round"] == 1]; seen = list(dict.fromkeys(seen))
done = {i: max(r1ok[i][m]["ts"] for m in ("codex", "gemini")) for i in seen if {"codex", "gemini"} <= set(r1ok.get(i, {}))}
both = sorted(done, key=done.get)                      # 樣本順序＝兩個模型都答齊的時間，補跑沒回答的那個不會插隊
half = [i for i in seen if i not in done]
cohort = both[:N]
print(f"條件：最早 {N} 個雙模型樣本內 已修 ≥{MINV}、誤報率 ≤{MAXFP}%、等待 P90 ≤{MAXP90} 秒")
print(f"雙模型樣本：{len(both)} 個（樣本取前 {N}：{', '.join(cohort) or '—'}）；只有一個模型回答、不算樣本的：{len(half)} 個（{', '.join(half) or '—'}）")
if not cohort: print("還沒有任何雙模型樣本"); sys.exit(0)
def p90(xs):
    xs = sorted(xs); return xs[max(0, math.ceil(0.9 * len(xs)) - 1)]
for m in ("codex", "gemini"):
    rs = [r1ok[i][m] for i in cohort]
    print(f"{m}：需修正 {sum(r['need_fix'] for r in rs)}／可接受風險 {sum(r['risk'] for r in rs)}／誤報候選 {sum(r['fp'] for r in rs)}；等待 P50 {sorted(r['seconds'] for r in rs)[(len(rs)-1)//2]} 秒、P90 {p90([r['seconds'] for r in rs])} 秒")
total_nf = sum(r1ok[i][m]["need_fix"] for i in cohort for m in ("codex", "gemini"))
judg = [r for r in rows if r.get("kind") == "judge" and r["id"] in cohort and r["model"] in r1ok.get(r["id"], {})]
ok = sum(1 for j in judg if j["verdict"] == "已修")
ok_norere = sum(1 for j in judg if j["verdict"] == "已驗證")
fp = sum(1 for j in judg if j["verdict"] == "誤報")
pending = total_nf - len(judg)
waits = [max(r1ok[i][m]["seconds"] for m in ("codex", "gemini")) for i in cohort]
w90 = p90(waits)
fprate = (fp / len(judg) * 100) if judg else None
print(f"需修正共 {total_nf} 條：已修 {ok}、已驗證但沒修 {ok_norere}、誤報 {fp}、**還沒判定 {pending}**"
      f"；誤報率 {'—' if fprate is None else f'{fprate:.0f}%'}；每個 change 的等待 P90 {w90} 秒")
if len(cohort) < N:            verdict = f"樣本還沒滿（{len(cohort)}/{N}）"
elif pending > 0:              verdict = f"不能下結論：還有 {pending} 條需修正沒判定（--judge）"
elif ok >= MINV and fprate is not None and fprate <= MAXFP and w90 <= MAXP90: verdict = "**條件全部成立，可以討論升阻塞**"
else:                          verdict = "不成立 → 拆：刪這支、prompts/06 與帳本，不留空殼"
print(f"結論：{verdict}")
ZZPY
  exit 0
fi

ID="${1:?用法見檔頭}"; shift
# change id 會拿去組路徑、篩分支，先驗文法（跟 check-pr-branch.sh 的 ID_RE 同一條）。
[[ "$ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "✗ change id '${ID}' 格式不合（小寫英數與單一連字號）" >&2; exit 2; }
DIR=".local/archive-review/$ID"

if [ "${1:-}" = "--judge" ]; then
  [ $# -ge 4 ] || { echo "用法：--judge <codex|gemini> <第N條需修正> <誤報|已驗證|已修> [備註]" >&2; exit 2; }
  case "$2" in codex|gemini) ;; *) echo "模型只能是 codex 或 gemini" >&2; exit 2;; esac
  case "$4" in 誤報|已驗證|已修) ;; *) echo "判定只能是 誤報、已驗證（重現了但還沒修）或 已修（重現了、修了、回審過）" >&2; exit 2;; esac
  # 「已修」是升阻塞數的那個 —— 要有證據：那個模型的第二輪回答存在。沒回審過就只能標「已驗證」。
  [ "$4" != 已修 ] || [ "$(answered 0 "$DIR/r2/$2.md" 2 2>/dev/null)" = true ] || { echo "✗ 要標「已修」先 --rereview，讓 $2 看過修正（$DIR/r2/$2.md 不存在或沒回答）" >&2; exit 2; }
  # 只能判真的存在的那一條，而且一條只判一次 —— 不然精確率是編出來的。
  N=$(grep -Ec "${TAG}\[需修正\]" "$DIR/r1/$2.md" 2>/dev/null || true)
  [ "$3" -ge 1 ] 2>/dev/null && [ "$3" -le "${N:-0}" ] || { echo "✗ $2 第一輪只有 ${N:-0} 條需修正，沒有第 $3 條" >&2; exit 2; }
  ! grep -q "\"kind\": \"judge\", \"id\": \"$ID\", \"model\": \"$2\", \"finding\": $3," "$LEDGER" 2>/dev/null || { echo "✗ $ID $2 第 $3 條已經判過了" >&2; exit 2; }
  ledger "$(python3 -c 'import json,sys;print(json.dumps({"kind":"judge","id":sys.argv[1],"model":sys.argv[2],"finding":int(sys.argv[3]),"verdict":sys.argv[4],"note":" ".join(sys.argv[5:])},ensure_ascii=False))' "$ID" "$2" "$3" "$4" "${@:5}")"
  echo "✓ 記下了：$ID $2 第 $3 條 → $4"; exit 0
fi

[ -d "openspec/changes/$ID" ] || { echo "✗ openspec/changes/$ID 不存在 —— 已經封存了？這支要在 /opsx:archive **之前**跑。" >&2; exit 2; }
command -v gh >/dev/null || { echo "✗ 找不到 gh —— slice 清單從 PR 的分支名來，沒有它這一輪不算數" >&2; exit 2; }

# 答過的不重送：一個模型的第一輪答案就是它在樣本裡的那一份。帳本說它答過、檔案卻不在 → 有人移走 r1 想重跑，拒絕。
# 重跑只補沒回答的那個模型（CLI 不在、逾時），樣本順序以兩個都答齊的時間算，補跑不會插隊。
has_answer() { [ "$(answered 0 "$DIR/r$2/$1.md" "$2" 2>/dev/null)" = true ]; }
in_ledger() { grep -q "\"kind\": \"review\", \"id\": \"$ID\", \"round\": $2, \"model\": \"$1\"," "$LEDGER" 2>/dev/null && grep "\"id\": \"$ID\", \"round\": $2, \"model\": \"$1\"," "$LEDGER" | grep -qv '"ok": false'; }
if [ "${1:-}" = "--rereview" ]; then
  ROUND=2; [ -s "$DIR/r1/main.sha" ] || { echo "✗ 沒有第一輪，先跑 bash .github/scripts/archive-review.sh $ID" >&2; exit 2; }
  [ ! -d "$DIR/r2" ] || { echo "✗ 回審只准一次（$DIR/r2 已存在）。還要一輪就是這套流程在製造等待 —— 人工處理，不要第三輪。" >&2; exit 2; }
else
  ROUND=1
  for m in codex gemini; do ! in_ledger "$m" 1 || has_answer "$m" 1 || { echo "✗ 帳本說 $m 第一輪答過了，$DIR/r1/$m.md 卻不在 —— 不要移走 r1 重跑；答過的那份就是樣本。" >&2; exit 2; }; done
  ! { has_answer codex 1 && has_answer gemini 1; } || { echo "✗ 兩個模型第一輪都答過了（$DIR/r1）。要回審用 --rereview。" >&2; exit 2; }
fi
git fetch -q origin main
MAIN="$(git rev-parse origin/main)"
OUT="$DIR/r$ROUND"; mkdir -p "$OUT"; printf '%s\n' "$MAIN" > "$OUT/main.sha"

# ── bundle ────────────────────────────────────────────────────────────────────────────────────────
# WBS 的對應**跟 progress.sh --json 要**（AGENTS：不要自己再解析一次 docs/WBS.md）。對不到就明說 —— 那本身是 --check 違規。
WBS_JSON="$(bash .github/scripts/progress.sh --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin); its=[i for i in d["items"] if sys.argv[1] in i.get("changes",[])]
if len(its)>1: sys.exit("✗ WBS 上有 %d 個項目都指到這個 change：%s" % (len(its), ", ".join(i["id"] for i in its)))
print(json.dumps(its[0], ensure_ascii=False, indent=1) if its else "")' "$ID")" || { echo "$WBS_JSON" >&2; exit 2; }
WBS="$(printf '%s' "$WBS_JSON" | python3 -c 'import json,sys;s=sys.stdin.read().strip();print(json.loads(s)["id"] if s else "")')"

# slice ＝ 合併進 main、分支名是 feat/<id>[--<slice>] 或 fix/<id>[--<slice>] 的 PR（AGENTS〈分支命名〉）。
# **不用 commit 訊息去 grep**：同一個 WBS ID 可以有多個 change，主旨提到它的 WBS 列、spec PR 都會混進來（實測過）。
# squash commit 的內文只是各 commit 訊息的串接，**PR 說明（刻意的取捨）不在裡面** —— 一起從 gh 拿。
PRS="$(gh pr list --state merged --base main --limit 1000 --json number,headRefName,mergeCommit,mergedAt,body 2>/dev/null | python3 -c '
import json,sys,re
pat=re.compile(r"^(feat|fix)/%s(--|$)" % re.escape(sys.argv[1]))
ps=[p for p in json.load(sys.stdin) if pat.match(p["headRefName"]) and p.get("mergeCommit")]
ps.sort(key=lambda p:p["mergedAt"])
print(json.dumps(ps, ensure_ascii=False))' "$ID")" || { echo "✗ 拿不到合併的 PR 清單（gh 沒登入？離線？）—— 這一輪不算數" >&2; exit 2; }
# diff 從 PR 拿（`gh pr diff`），不是 merge commit 的 `git show` —— 只有 squash 合併時後者才等於整個 PR。
# 排除 lockfile 與 archive 目錄（人不讀、佔 bundle）；圖片等二進位 diff 本來就只有一行。
show_slice() { # show_slice <sha> <pr#> <body-file>
  git merge-base --is-ancestor "$1" "$MAIN" 2>/dev/null || { echo "（PR #$2 的 merge commit $1 不在 origin/main 上，略過）"; return 0; }
  echo "### PR #$2 $(git log -1 --format=%s "$1" 2>/dev/null)"; echo
  gh pr diff "$2" 2>/dev/null | python3 -c '
import sys,re
skip=re.compile(r"^diff --git a/((.*/)?(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock)|openspec/changes/archive/.*) b/")
out=[]; drop=False
for line in sys.stdin:
    if line.startswith("diff --git "): drop = bool(skip.match(line)); out.append("（略過：%s）\n" % line.split(" b/")[-1].strip() if drop else "")
    if not drop: out.append(line)
sys.stdout.write("".join(out))' || echo "（拿不到 PR #$2 的 diff）"
  echo; echo "#### PR #$2 的說明"; cat "$3"
}
slices() { # slices <since-sha|""> ：印 sha<TAB>pr#，寫各 PR 的 body 到 $OUT/pr-<n>.body
  printf '%s' "$PRS" | python3 -c '
import json,sys,subprocess,pathlib
since=sys.argv[1]; out=pathlib.Path(sys.argv[2])
for p in json.load(sys.stdin):
    sha=p["mergeCommit"]["oid"]
    if since and subprocess.run(["git","merge-base","--is-ancestor",sha,since]).returncode==0: continue  # 上一輪之前就有的
    (out / ("pr-%d.body" % p["number"])).write_text(p.get("body") or "（沒有說明）", encoding="utf-8")
    print("%s\t%d" % (sha, p["number"]))' "$1" "$OUT"
}
{
  cat prompts/06-archive-review.md
  echo; echo "# Bundle：${ID}（WBS ${WBS:-對不上}）— main $(git rev-parse --short "$MAIN") — 第 $ROUND 輪"; echo
  if [ "$ROUND" = 1 ]; then
    echo "## docs/WBS.md 上這一項（progress.sh --json）"; [ -n "$WBS_JSON" ] && printf '```json\n%s\n```\n' "$WBS_JSON" || echo "（WBS 上沒有任何項目指到 $ID —— 這本身就值得寫進發現）"
    echo; echo "## docs/DECISIONS.md 裡提到它的整節（已拒絕的方案）"
    python3 -c '
import re,sys
t=open("docs/DECISIONS.md",encoding="utf-8").read(); keys=[k for k in sys.argv[1:] if k]
parts=re.split(r"(?m)^(## .+)$", t); hit=0
for i in range(1,len(parts),2):
    sec=parts[i]+parts[i+1]
    if any(k.lower() in sec.lower() for k in keys): print(sec.rstrip()); print(); hit+=1
if not hit: print("（沒有）")' "$ID" "$WBS"
    echo; echo "## 凍結的規格（openspec/changes/$ID/）"
    find "openspec/changes/$ID" -name '*.md' -type f | sort | while read -r f; do echo; echo "### $f"; echo; cat "$f"; done
    echo; echo "## 合併進 main 的 slice（分支名 feat/${ID}[--<slice>]、fix/${ID}[--<slice>] 的 PR，舊到新）"
    n=0; while IFS=$'\t' read -r sha pr; do [ -n "$sha" ] || continue; n=$((n+1)); echo; show_slice "$sha" "$pr" "$OUT/pr-$pr.body"; done < <(slices "")
    echo; echo "（共 $n 個 slice PR）"; [ "$n" -gt 0 ] || echo "**沒有任何 slice 合併進 main —— 沒東西可審；規格本身的問題標可接受風險。**"
  else
    echo "## 上一輪標「需修正」的"; grep -Eh "${TAG}\[需修正\]" "$DIR/r1/codex.md" "$DIR/r1/gemini.md" 2>/dev/null || echo "（沒有 —— 那就不需要回審）"
    echo; echo "## 上一輪之後合併進 main 的修正"
    n=0; while IFS=$'\t' read -r sha pr; do [ -n "$sha" ] || continue; n=$((n+1)); echo; show_slice "$sha" "$pr" "$OUT/pr-$pr.body"; done < <(slices "$(cat "$DIR/r1/main.sha")")
    [ "$n" -gt 0 ] || echo "（上一輪之後沒有任何 ${ID} 的 PR 合併 —— 那就沒有東西可回審）"
  fi
} > "$OUT/bundle.md"
SIZE=$(wc -c < "$OUT/bundle.md" | tr -d " ")
[ "$SIZE" -lt 700000 ] || { echo "✗ bundle ${SIZE} bytes，超過命令列能塞的量 —— 這個 change 太大，人工拆開審。" >&2; exit 2; }
echo "bundle：$OUT/bundle.md（$SIZE bytes）；等待上限 ${ARCHIVE_REVIEW_TIMEOUT:-1500} 秒／模型，放背景跑"

# ── 平行送出 ──────────────────────────────────────────────────────────────────────────────────────
row() { # row <model> <t0> <rc> [session]
  ledger "{\"kind\":\"review\",\"id\":\"$ID\",\"round\":$ROUND,\"model\":\"$1\",\"seconds\":$(( $(date +%s) - $2 )),\"need_fix\":$(count "$OUT/$1.md" 需修正),\"risk\":$(count "$OUT/$1.md" 可接受風險),\"fp\":$(count "$OUT/$1.md" 誤報候選),\"ok\":$(answered "$3" "$OUT/$1.md" "$ROUND"),\"session\":\"${4:-}\"}"
  [ "$(answered "$3" "$OUT/$1.md" "$ROUND")" = true ] || echo "✗ $1 沒有回答（rc=${3}；看 $OUT/$1.err）—— 這次不算數" >&2
}
run_codex() {
  local t0; t0=$(date +%s)
  ! has_answer codex "$ROUND" || { echo "（codex 第 $ROUND 輪已經答過，不重送）"; return; }
  command -v "$CODEX_BIN" >/dev/null || { echo "（跳過 codex：找不到 ${CODEX_BIN}）" | tee "$OUT/codex.md"; row codex "$t0" 127; return; }
  if [ "$ROUND" = 2 ] && SESSION="$(python3 -c 'import json,sys;print([json.loads(l) for l in open(sys.argv[1]) if l.strip() and json.loads(l).get("kind")=="review" and json.loads(l)["id"]==sys.argv[2] and json.loads(l)["model"]=="codex" and json.loads(l).get("session")][-1]["session"])' "$LEDGER" "$ID" 2>/dev/null)" && [ -n "$SESSION" ]; then
    "$CODEX_BIN" exec --skip-git-repo-check resume "$SESSION" "$(cat "$OUT/bundle.md")" < /dev/null > "$OUT/codex.md" 2> "$OUT/codex.err" &
  else
    "$CODEX_BIN" exec --sandbox read-only --skip-git-repo-check -m "$CODEX_MODEL" -c model_reasoning_effort="high" "$(cat "$OUT/bundle.md")" < /dev/null > "$OUT/codex.md" 2> "$OUT/codex.err" &
  fi
  local rc=0; watch $! || rc=$?
  row codex "$t0" "$rc" "$(grep -o 'session id: [0-9a-f-]*' "$OUT/codex.err" | tail -1 | cut -d' ' -f3)"
}
run_gemini() {
  local t0; t0=$(date +%s)
  ! has_answer gemini "$ROUND" || { echo "（gemini 第 $ROUND 輪已經答過，不重送）"; return; }
  command -v "$GEMINI_BIN" >/dev/null || { echo "（跳過 gemini：找不到 ${GEMINI_BIN}）" | tee "$OUT/gemini.md"; row gemini "$t0" 127; return; }
  { [ "$ROUND" = 2 ] && { echo "## 你上一輪的回答"; cat "$DIR/r1/gemini.md"; echo; }; cat "$OUT/bundle.md"; } > "$OUT/gemini.prompt.md"
  "$GEMINI_BIN" --print "$(cat "$OUT/gemini.prompt.md")" --model "$GEMINI_MODEL" --effort high --mode plan --print-timeout 25m > "$OUT/gemini.md" 2> "$OUT/gemini.err" &
  local rc=0; watch $! || rc=$?
  row gemini "$t0" "$rc"
}
run_codex & run_gemini & wait

echo; for m in codex gemini; do echo "── ${m}（$OUT/$m.md）"; grep -E "${TAG}\[(需修正|可接受風險|誤報候選)\]|^結論" "$OUT/$m.md" || tail -n 5 "$OUT/$m.md"; done
echo; echo "下一步：需修正的 → 原 session 修、合併，再跑 --rereview（只一次）；每一條需修正判定後 --judge（誤報／已驗證／已修）；封存後 --report。"
