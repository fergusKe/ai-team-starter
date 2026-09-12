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
#
# 信任邊界：帳本與回答檔都在本機、gitignore、負責人自己可以改。這套守的是**誤操作與模型的半成品**
# （移走重跑、沒答完、結論跟明細對不上、判定套到別的發現上），**不防惡意竄改** —— 一個人合併的專案，
# 竄改自己的試驗量尺沒有對手。升阻塞的決定仍由人看 --report 與檔案下，不是腳本自動升。
set -euo pipefail
[[ "${ARCHIVE_REVIEW_TIMEOUT:-1500}" =~ ^[1-9][0-9]*$ ]] || { echo "✗ ARCHIVE_REVIEW_TIMEOUT 要是正整數秒數，不是「${ARCHIVE_REVIEW_TIMEOUT}」" >&2; exit 2; }

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
count() { local n; n=$(grep -Ec "${TAG}\[$2\]" "$1" 2>/dev/null); echo "${n:-0}"; }   # 檔案不在也回 0，不回空字串（空字串進算式會炸）
# 一次審查「算數」的條件：CLI rc=0 而且真的照格式**答完整** ——
# 第一輪：有結論那一行，而且結論裡的三個數字跟明細裡的標籤數一致（「結論說 3 條、明細沒有」不算數）；
# 第二輪：上一輪的每一條需修正（r2 bundle 的每個編號）都有一行 `N. 已修／未修／改壞了別的`（只答一半不算數）。
# 沒答完整的記 ok=false，report 不算它，補跑會重送。
r2_expected() { echo $(( $(count "$DIR/r1/codex.md" 需修正) + $(count "$DIR/r1/gemini.md" 需修正) )); }
answered() { # answered <rc> <file> [round]
  [ "$1" = 0 ] && [ -s "$2" ] || { echo false; return; }
  if [ "${3:-1}" = 2 ]; then
    local n; n=$(r2_expected); [ "$n" -gt 0 ] || { echo true; return; }
    # 每一號恰好一次（重複、矛盾都不算）；狀態詞後面要斷開（「已修但不確定」不是已修）；不准有 1..N 以外的編號行。
    local i=1; while [ "$i" -le "$n" ]; do [ "$(grep -Ec "^[[:space:]]*${i}[.)][[:space:]]*(已修|未修|改壞了(別的)?)([[:space:]—:：-]|$)" "$2")" = 1 ] || { echo false; return; }; i=$((i+1)); done
    [ "$(grep -Ec "^[[:space:]]*[0-9]+[.)][[:space:]]*(已修|未修|改壞了(別的)?)" "$2")" = "$n" ] || { echo false; return; }; echo true
  else
    # 結論行是最後一個非空行、格式固定、只能有一行；三個數字＝明細標籤數。
    [ "$(grep -c "^結論[：:]" "$2")" = 1 ] || { echo false; return; }
    local last; last="$(grep -v '^[[:space:]]*$' "$2" | tail -n 1)"
    [[ "$last" =~ ^結論[：:]需修正\ ([0-9]+)\ 條／可接受風險\ ([0-9]+)\ 條／誤報候選\ ([0-9]+)\ 條[[:space:]]*$ ]] || { echo false; return; }
    [ "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}" = "$(count "$2" 需修正) $(count "$2" 可接受風險) $(count "$2" 誤報候選)" ] && echo true || echo false
  fi
}
# 沒有 coreutils timeout（macOS）：自己盯。超過 ARCHIVE_REVIEW_TIMEOUT（預設 1500 秒）就殺，不要讓 wait 等到天亮。
# 逾時要**殺整棵樹並收割**：只 kill 父行程，子行程會繼續寫回答檔。殺不乾淨的那一小撮由 finish() 的暫存檔隔開。
killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null || true; }
watch() {
  local pid=$1 t=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$t" -ge "${ARCHIVE_REVIEW_TIMEOUT:-1500}" ]; then
      killtree "$pid"; sleep 2; kill -0 "$pid" 2>/dev/null && { pkill -KILL -P "$pid" 2>/dev/null || true; kill -KILL "$pid" 2>/dev/null || true; }
      wait "$pid" 2>/dev/null || true; return 124
    fi
    sleep 5; t=$((t+5))
  done
  wait "$pid"
}
# 回答先寫進**這一次獨有**的暫存檔，跑完才**複製**成 <model>.md —— cp 是新 inode，mv 不是：CLI 正常退出（rc=0）
# 卻留下還握著 stdout 的子行程時，mv 發布的就是它握的那個檔（第 21 輪）。殺樹殺不乾淨的孤兒同理，握的是暫存檔，
# 寫不進發布的那份；逾時那份改名留著看，永遠不發布。
finish() { # finish <model> <rc> <tmp>
  if [ "$2" = 124 ]; then
    mv "$3" "$OUT/$1.timeout.md"; echo "（逾時 ${ARCHIVE_REVIEW_TIMEOUT:-1500} 秒，殺掉了；殘餘輸出在 $OUT/$1.timeout.md，不算回答）" > "$OUT/$1.md"
  else cp "$3" "$OUT/$1.md" && rm -f "$3"; fi
}

if [ "${1:-}" = "--report" ]; then
  [ $# -eq 1 ] || { echo "✗ --report 不收其他參數" >&2; exit 2; }
  [ -s "$LEDGER" ] || { echo "帳本是空的（${LEDGER}）"; exit 0; }
  python3 - "$LEDGER" "$TRIAL_N" "$MIN_VERIFIED" "$MAX_FP" "$MAX_WAIT_P90" <<'ZZPY'
import json, sys, math, re, os
# 帳本是索引，檔案才是證據：每一個數字都從檔案重算，帳本只提供「哪一次算數」「花了幾秒」「順序」。
# 跟腳本的 answered()／--judge 是同一把尺，寫在這裡是因為 report 要在沒有 bash 狀態的情況下重驗。
rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
N, MINV, MAXFP, MAXP90 = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
TAG = r"(?m)^\s*(?:[-*]|\d+[.)])?\s*\[%s\]"
def read(i, m, rnd):
    f = f".local/archive-review/{i}/r{rnd}/{m}.md"
    return open(f, encoding="utf-8").read() if os.path.isfile(f) else None
def tags(txt): return {k: len(re.findall(TAG % k, txt)) for k in ("需修正", "可接受風險", "誤報候選")}
def r1_ok(txt):   # 結論行只有一行、是最後一個非空行、格式固定；三個數字＝明細的標籤數
    if txt is None or len(re.findall(r"(?m)^結論[：:]", txt)) != 1: return False
    last = [l for l in txt.splitlines() if l.strip()][-1:]
    m1 = re.fullmatch(r"結論[：:]需修正 (\d+) 條／可接受風險 (\d+) 條／誤報候選 (\d+) 條\s*", last[0]) if last else None
    return bool(m1) and [int(x) for x in m1.groups()] == list(tags(txt).values())
def r2_lines(txt, n): return re.findall(r"(?m)^\s*%d[.)]\s*(已修|未修|改壞了(?:別的)?)(?=[\s—:：-]|$)" % n, txt)
def r2_line(txt, n): m2 = r2_lines(txt, n); return m2[0] if len(m2) == 1 else None
def r2_extra(txt, n): return len(re.findall(r"(?m)^\s*\d+[.)]\s*(?:已修|未修|改壞了(?:別的)?)", txt)) != n
def r2_ok(txt, n):  # 1..n 每一號**恰好一次**：缺號、重複、矛盾、多餘的編號都不算
    return txt is not None and (n == 0 or (all(len(r2_lines(txt, k)) == 1 for k in range(1, n + 1)) and not r2_extra(txt, n)))
rev = [r for r in rows if r.get("kind") == "review"]
led = {}                                              # (id, round, model) → 最早 ok 的 row；之後的重跑不算
for r in rev:
    if r.get("ok", True): led.setdefault((r["id"], r["round"], r["model"]), r)   # 舊 row 沒有 ok 欄：當時只有回答了才會寫 row
# 樣本先照**帳本**凍結（最早 N 個兩個模型都有 ok row 的 change），再驗每一份檔案；壞了就不能下結論，**不遞補**——
# 遞補等於讓後面的 change 換掉前面的樣本。
seen = list(dict.fromkeys(r["id"] for r in rev if r["round"] == 1))
done = {i: max(led[(i, 1, m)]["ts"] for m in ("codex", "gemini")) for i in seen if all((i, 1, m) in led for m in ("codex", "gemini"))}
both = sorted(done, key=done.get)                      # 樣本順序＝兩個模型都答齊的時間，補跑沒回答的那個不會插隊
half = [i for i in seen if i not in done]
cohort = both[:N]
r1, broken = {}, []                                   # r1[id][model] = (row, tags)；broken = 樣本裡帳本說答過、檔案卻不成立的
for i in cohort:
    for m in ("codex", "gemini"):
        txt = read(i, m, 1)
        if r1_ok(txt): r1.setdefault(i, {})[m] = (led[(i, 1, m)], tags(txt))
        else: broken.append(f"{i}/{m}")
print(f"條件：最早 {N} 個雙模型樣本內 已修 ≥{MINV}、誤報率 ≤{MAXFP}%、等待 P90 ≤{MAXP90} 秒")
print(f"雙模型樣本：{len(both)} 個（樣本取前 {N}：{', '.join(cohort) or '—'}）；兩個模型還沒都答完、不算樣本的：{len(half)} 個（{', '.join(half) or '—'}）")
if not cohort: print("還沒有任何雙模型樣本"); sys.exit(0)
if broken:
    print(f"樣本裡帳本說答過、檔案卻不在或不完整：{', '.join(broken)}")
    print(f"結論：不能下結論：{len(broken)} 份樣本的第一輪回答檔不成立（樣本不遞補）"); sys.exit(0)
def p90(xs):
    xs = sorted(xs); return xs[max(0, math.ceil(0.9 * len(xs)) - 1)]
nf = {i: {m: r1[i][m][1]["需修正"] for m in ("codex", "gemini")} for i in cohort}
for m in ("codex", "gemini"):
    tg = [r1[i][m][1] for i in cohort]; secs = sorted(r1[i][m][0]["seconds"] for i in cohort)
    print(f"{m}：需修正 {sum(x['需修正'] for x in tg)}／可接受風險 {sum(x['可接受風險'] for x in tg)}／誤報候選 {sum(x['誤報候選'] for x in tg)}；等待 P50 {secs[(len(secs)-1)//2]} 秒、P90 {p90(secs)} 秒")
total_nf = sum(nf[i][m] for i in cohort for m in ("codex", "gemini"))
VERDICTS = ("誤報", "已驗證", "已修")
badrow = [r for r in rows if r.get("kind") == "judge" and (r.get("verdict") not in VERDICTS or not isinstance(r.get("finding"), int) or isinstance(r.get("finding"), bool))] \
       + [r for r in rev if not isinstance(r.get("ok", True), bool)]
judg = [r for r in rows if r.get("kind") == "judge" and r["id"] in cohort and r["model"] in nf[r["id"]]
        and isinstance(r["finding"], int) and 1 <= r["finding"] <= nf[r["id"]][r["model"]] and r["verdict"] in VERDICTS]   # 判到檔案上沒有的那一條、不在列舉裡的判定，不算
keys = [(j["id"], j["model"], j["finding"]) for j in judg]
dup = sorted({f"{i}/{m}#{n}" for k in set(keys) if keys.count(k) > 1 for (i, m, n) in [k]})
# 「已修」要回頭驗第二輪證據：那個模型第二輪有 ok row、1..N 全答、對應那一號寫的是「已修」。證據不成立就不能下結論。
def fixed_ok(j):
    i, m = j["id"], j["model"]; n = nf[i]["codex"] + nf[i]["gemini"]
    if (i, 2, m) not in led: return False
    txt = read(i, m, 2)
    if not r2_ok(txt, n): return False
    g = j["finding"] + (nf[i]["codex"] if m == "gemini" else 0)
    return r2_line(txt, g) == "已修"
ok = sum(1 for j in judg if j["verdict"] == "已修" and fixed_ok(j))
bad_fixed = [f"{j['id']}/{j['model']}#{j['finding']}" for j in judg if j["verdict"] == "已修" and not fixed_ok(j)]
ok_norere = sum(1 for j in judg if j["verdict"] == "已驗證")
fp = sum(1 for j in judg if j["verdict"] == "誤報")
pending = total_nf - len(judg)
w90 = p90([max(r1[i][m][0]["seconds"] for m in ("codex", "gemini")) for i in cohort])
fprate = (fp / len(judg) * 100) if judg else None
print(f"需修正共 {total_nf} 條：已修 {ok}、已驗證但沒修 {ok_norere}、誤報 {fp}、**還沒判定 {pending}**"
      f"；誤報率 {'—' if fprate is None else f'{fprate:.0f}%'}；每個 change 的等待 P90 {w90} 秒")
if bad_fixed: print(f"標了「已修」但第二輪證據不成立（沒有 ok 的第二輪、沒答完、或那一號不是已修）：{', '.join(bad_fixed)}")
if badrow: print(f"帳本有 {len(badrow)} 筆欄位不合（verdict 不在列舉、finding 不是整數、ok 不是布林）—— 手改過？"); print("結論：不能下結論：帳本欄位不合"); sys.exit(0)
if dup:
    print(f"同一條被判了不只一次（帳本被手改過？）：{', '.join(dup)}")
    print(f"結論：不能下結論：{len(dup)} 條被判了不只一次（統計不做，數字會失真）"); sys.exit(0)
if len(cohort) < N:            verdict = f"樣本還沒滿（{len(cohort)}/{N}）"

elif pending > 0:              verdict = f"不能下結論：還有 {pending} 條需修正沒判定（--judge）"
elif bad_fixed:                verdict = f"不能下結論：{len(bad_fixed)} 條「已修」的第二輪證據不成立"
elif ok >= MINV and fprate is not None and fprate <= MAXFP and w90 <= MAXP90: verdict = "**條件全部成立，可以討論升阻塞**"
else:                          verdict = "不成立 → 拆：刪這支、prompts/06 與帳本，不留空殼"
print(f"結論：{verdict}")
ZZPY
  exit 0
fi

ID="${1:?用法見檔頭}"; shift
# 模式是封閉列舉：<id>、<id> --rereview、<id> --judge …。打錯字（--rereveiw）不能悄悄變成第一輪。
case "${1:-}" in
  "") ;;
  --rereview) [ $# -eq 1 ] || { echo "✗ --rereview 不收其他參數" >&2; exit 2; } ;;
  --judge) ;;
  *) echo "✗ 不認得「$1」。用法見檔頭：<id>、<id> --rereview、<id> --judge <codex|gemini> <N> <誤報|已驗證|已修> [備註]、--report" >&2; exit 2 ;;
esac
# 「答過」＝那一輪帳本有 ok 的 row **而且** 檔案有照格式回答。只看檔案不行：CLI 非零／逾時可能留下格式完整的半成品；
# 只看帳本不行：帳本說答過、檔案卻被移走，那是有人想重跑。兩者不一致 → 拒絕，不猜。
file_ok()    { [ "$(answered 0 ".local/archive-review/$ID/r$2/$1.md" "$2" 2>/dev/null)" = true ]; }
in_ledger()  { grep "\"kind\": \"review\", \"id\": \"$ID\", \"round\": $2, \"model\": \"$1\"," "$LEDGER" 2>/dev/null | grep -qv '"ok": false'; }
has_answer() { in_ledger "$1" "$2" && file_ok "$1" "$2"; }
# change id 會拿去組路徑、篩分支，先驗文法（跟 check-pr-branch.sh 的 ID_RE 同一條）。
[[ "$ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "✗ change id '${ID}' 格式不合（小寫英數與單一連字號）" >&2; exit 2; }
DIR=".local/archive-review/$ID"

if [ "${1:-}" = "--judge" ]; then
  [ $# -ge 4 ] || { echo "用法：--judge <codex|gemini> <第N條需修正> <誤報|已驗證|已修> [備註]" >&2; exit 2; }
  case "$2" in codex|gemini) ;; *) echo "模型只能是 codex 或 gemini" >&2; exit 2;; esac
  case "$4" in 誤報|已驗證|已修) ;; *) echo "判定只能是 誤報、已驗證（重現了但還沒修）或 已修（重現了、修了、回審過）" >&2; exit 2;; esac
  [[ "$3" =~ ^[1-9][0-9]*$ ]] || { echo "✗ 第幾條要是正整數（1、2、3…），不是「$3」" >&2; exit 2; }   # 「01」會繞過「判過了」的檢查
  # 「已修」是升阻塞數的那個 —— 要有證據：那個模型第二輪**算數**（帳本 ok）而且**對這一條**寫了「已修」。
  # 第二輪 bundle 把上一輪的需修正逐條編號（codex 的在前、gemini 的在後），模型照編號答；這裡查對應那一號。
  if [ "$4" = 已修 ]; then
    has_answer "$2" 2 || { echo "✗ 要標「已修」先 --rereview，而且 $2 的第二輪要算數（帳本 ok、$DIR/r2/$2.md 有逐條回答）" >&2; exit 2; }
    G=$3; if [ "$2" = gemini ]; then C=$(count "$DIR/r1/codex.md" 需修正); G=$(( ${C:-0} + $3 )); fi   # grep -c 找不到時 exit 1，不能 `|| echo 0`
    grep -Eq "^[[:space:]]*${G}[.)][[:space:]]*已修" "$DIR/r2/$2.md" 2>/dev/null || { echo "✗ 要標「已修」，$2 的第二輪回答（$DIR/r2/$2.md）要有「${G}. 已修」這一行 —— 它說未修就只能標「已驗證」" >&2; exit 2; }
  fi
  # 判定綁的是「算數的第一輪回答」：帳本 ok 且檔案完整。半成品先判、重跑蓋掉之後舊判定會套到別的發現上。
  has_answer "$2" 1 || { echo "✗ $2 的第一輪還不算數（帳本沒有 ok 的 row、或 $DIR/r1/$2.md 不在／不完整）—— 沒有東西可判" >&2; exit 2; }
  # 只能判真的存在的那一條，而且一條只判一次 —— 不然精確率是編出來的。
  N=$(count "$DIR/r1/$2.md" 需修正)
  [ "$3" -ge 1 ] 2>/dev/null && [ "$3" -le "${N:-0}" ] || { echo "✗ $2 第一輪只有 ${N:-0} 條需修正，沒有第 $3 條" >&2; exit 2; }
  ! grep -q "\"kind\": \"judge\", \"id\": \"$ID\", \"model\": \"$2\", \"finding\": $3," "$LEDGER" 2>/dev/null || { echo "✗ $ID $2 第 $3 條已經判過了" >&2; exit 2; }
  ledger "$(python3 -c 'import json,sys;print(json.dumps({"kind":"judge","id":sys.argv[1],"model":sys.argv[2],"finding":int(sys.argv[3]),"verdict":sys.argv[4],"note":" ".join(sys.argv[5:])},ensure_ascii=False))' "$ID" "$2" "$3" "$4" "${@:5}")"
  echo "✓ 記下了：$ID $2 第 $3 條 → $4"; exit 0
fi

command -v gh >/dev/null || { echo "✗ 找不到 gh —— slice 清單從 PR 的分支名來，沒有它這一輪不算數" >&2; exit 2; }
git fetch -q origin main
MAIN="$(git rev-parse origin/main)"
# 規格從 origin/main 讀，不從 working tree —— 凍結的是 main 上那份，working tree 可能正在改。
SPEC_FILES="$(git ls-tree -r --name-only "$MAIN" -- "openspec/changes/$ID" | grep '\.md$' || true)"
[ -n "$SPEC_FILES" ] || { echo "✗ origin/main 上沒有 openspec/changes/$ID —— 已經封存了？還是 spec PR 還沒合併？這支要在 /opsx:archive **之前**跑。" >&2; exit 2; }

# 答過的不重送：一個模型的答案就是它在樣本裡的那一份。帳本說它答過、檔案卻不在 → 有人移走想重跑，拒絕。
# 重跑只補沒答的那個模型（CLI 不在、逾時、diff 拿不到），沿用同一份 bundle；樣本順序以兩個都答齊的時間算，補跑不插隊。
# 「只准一次」看的是**兩個模型都答過第二輪**，不是 r2/ 目錄存不存在 —— 目錄在失敗時也會留下。
if [ "${1:-}" = "--rereview" ]; then
  # 兩個模型的第一輪都要答完才能回審：第二輪 bundle 列的是兩個模型的需修正，少一個就是回審不完整；補完第一輪又補不進來。
  ROUND=2; [ -s "$DIR/r1/main.sha" ] && has_answer codex 1 && has_answer gemini 1 || { echo "✗ 兩個模型的第一輪都答完才能回審（先跑 bash .github/scripts/archive-review.sh $ID 補齊）" >&2; exit 2; }
else
  ROUND=1
fi
for m in codex gemini; do ! in_ledger "$m" "$ROUND" || file_ok "$m" "$ROUND" || { echo "✗ 帳本說 $m 第 $ROUND 輪答過了，$DIR/r$ROUND/$m.md 卻不在或不完整 —— 不要移走它重跑；答過的那份就是樣本。" >&2; exit 2; }; done
if has_answer codex "$ROUND" && has_answer gemini "$ROUND"; then
  [ "$ROUND" = 1 ] && echo "✗ 兩個模型第一輪都答過了（$DIR/r1）。要回審用 --rereview。" >&2 \
                   || echo "✗ 回審只准一次（兩個模型第二輪都答過了）。還要一輪就是這套流程在製造等待 —— 人工處理，不要第三輪。" >&2
  exit 2
fi
OUT="$DIR/r$ROUND"; mkdir -p "$OUT"
# 同一個 change 同一輪只能有一個在跑：兩個一起跑會互相蓋回答檔、各寫一次帳本。mkdir 是原子的。
mkdir "$OUT/.lock" 2>/dev/null || { echo "✗ $OUT/.lock 存在 —— 同一輪已經在跑（或上次沒正常結束：確認沒有在跑的 codex／agy 之後 rmdir 它）" >&2; exit 2; }
trap 'rmdir "$OUT/.lock" 2>/dev/null' EXIT
# 補跑沒回答的那個模型時，**沿用這一輪已經組好的 bundle 與 main.sha**：兩個模型要看同一份東西，不然不是同一個樣本。
if [ -s "$OUT/bundle.md" ] && [ -s "$OUT/main.sha" ]; then
  MAIN="$(cat "$OUT/main.sha")"; echo "沿用第 $ROUND 輪已組好的 bundle（main $(git rev-parse --short "$MAIN")）：$OUT/bundle.md"
else
printf '%s\n' "$MAIN" > "$OUT/main.sha"    # 失敗會留下它，但沿用的條件是 bundle.md 也在；bundle 只在全部組完才落地

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
allp=json.load(sys.stdin)
if len(allp) >= 1000: sys.exit("✗ 合併的 PR 已達 gh pr list 的 --limit 1000，清單可能被截斷、舊的 slice 會漏 —— 這一輪不算數（提高 limit 或改分頁）")
ps=[p for p in allp if pat.match(p["headRefName"]) and p.get("mergeCommit")]
ps.sort(key=lambda p:p["mergedAt"])
print(json.dumps(ps, ensure_ascii=False))' "$ID" 2>&1)" || { echo "✗ 拿不到合併的 PR 清單（gh 沒登入？離線？）—— 這一輪不算數"; echo "$PRS"; exit 2; } >&2
# diff 從 PR 拿（`gh pr diff`），不是 merge commit 的 `git show` —— 只有 squash 合併時後者才等於整個 PR。
# 排除 lockfile 與 archive 目錄（人不讀、佔 bundle）；圖片等二進位 diff 本來就只有一行。
# **任何一個 PR 的 diff 拿不到，整輪不算數**（exit 2，不寫帳本）—— 少了實作內容的 bundle 不能進樣本。
fetch_diff() { # fetch_diff <pr#> → $OUT/pr-<n>.diff
  gh pr diff "$1" 2>"$OUT/pr-$1.diff.err" | python3 -c '
import sys,re
skip=re.compile(r"^diff --git a/((.*/)?(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock)|openspec/changes/archive/.*) b/")
out=[]; drop=False
for line in sys.stdin:
    if line.startswith("diff --git "): drop = bool(skip.match(line)); out.append("（略過：%s）\n" % line.split(" b/")[-1].strip() if drop else "")
    if not drop: out.append(line)
sys.stdout.write("".join(out))' > "$OUT/pr-$1.diff" && [ -s "$OUT/pr-$1.diff" ] \
    || { echo "✗ 拿不到 PR #$1 的 diff（$(tail -n 1 "$OUT/pr-$1.diff.err" 2>/dev/null)）—— 這一輪不算數" >&2; exit 2; }
}
show_slice() { # show_slice <sha> <pr#>
  git merge-base --is-ancestor "$1" "$MAIN" 2>/dev/null || { echo "✗ PR #$2 的 merge commit $1 不在這一輪釘住的 main（${MAIN}）上 —— fetch 與 pr list 之間有人合併了？重跑一次。這一輪不算數" >&2; exit 2; }
  echo "### PR #$2 $(git log -1 --format=%s "$1" 2>/dev/null)"; echo
  cat "$OUT/pr-$2.diff"
  echo; echo "#### PR #$2 的說明"; cat "$OUT/pr-$2.body"
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
SINCE=""; [ "$ROUND" = 1 ] || SINCE="$(cat "$DIR/r1/main.sha")"
SLICES="$(slices "$SINCE")"
while IFS=$'\t' read -r sha pr; do [ -n "$sha" ] || continue; fetch_diff "$pr"; done <<< "$SLICES"
{
  cat prompts/06-archive-review.md
  echo; echo "# Bundle：${ID}（WBS ${WBS:-對不上}）— main $(git rev-parse --short "$MAIN") — 第 $ROUND 輪"; echo
  if [ "$ROUND" = 1 ]; then
    echo "## docs/WBS.md 上這一項（progress.sh --json）"; [ -n "$WBS_JSON" ] && printf '```json\n%s\n```\n' "$WBS_JSON" || echo "（WBS 上沒有任何項目指到 $ID —— 這本身就值得寫進發現）"
    echo; echo "## docs/DECISIONS.md 裡提到它的整節（已拒絕的方案）"
    python3 -c '
import re,sys,os
if not os.path.exists("docs/DECISIONS.md"): print("（沒有 docs/DECISIONS.md）"); sys.exit(0)
t=open("docs/DECISIONS.md",encoding="utf-8").read(); keys=[k for k in sys.argv[1:] if k]
parts=re.split(r"(?m)^(## .+)$", t); hit=0
for i in range(1,len(parts),2):
    sec=parts[i]+parts[i+1]
    if any(k.lower() in sec.lower() for k in keys): print(sec.rstrip()); print(); hit+=1
if not hit: print("（沒有）")' "$ID" "$WBS"
    echo; echo "## 凍結的規格（openspec/changes/$ID/）"
    while read -r f; do [ -n "$f" ] || continue; echo; echo "### $f"; echo; git show "$MAIN:$f"; done <<< "$SPEC_FILES"
    echo; echo "## 合併進 main 的 slice（分支名 feat/${ID}[--<slice>]、fix/${ID}[--<slice>] 的 PR，舊到新）"
    n=0; while IFS=$'\t' read -r sha pr; do [ -n "$sha" ] || continue; n=$((n+1)); echo; show_slice "$sha" "$pr"; done <<< "$SLICES"
    echo; echo "（共 $n 個 slice PR）"; [ "$n" -gt 0 ] || echo "**沒有任何 slice 合併進 main —— 沒東西可審；規格本身的問題標可接受風險。**"
  else
    echo "## 上一輪標「需修正」的（照這個編號逐條答：\`N. 已修／未修／改壞了別的\`）"
    grep -Eh "${TAG}\[需修正\]" "$DIR/r1/codex.md" "$DIR/r1/gemini.md" 2>/dev/null | sed -E "s/${TAG}//" | awk '{ printf "%d. %s\n", NR, $0 }' | grep . || echo "（沒有 —— 那就不需要回審）"
    echo; echo "## 上一輪之後合併進 main 的修正"
    n=0; while IFS=$'\t' read -r sha pr; do [ -n "$sha" ] || continue; n=$((n+1)); echo; show_slice "$sha" "$pr"; done <<< "$SLICES"
    [ "$n" -gt 0 ] || echo "（上一輪之後沒有任何 ${ID} 的 PR 合併 —— 那就沒有東西可回審）"
  fi
} > "$OUT/bundle.md.tmp" && mv "$OUT/bundle.md.tmp" "$OUT/bundle.md"
fi
SIZE=$(wc -c < "$OUT/bundle.md" | tr -d " ")
# 上限 110 KB：gemini 的 prompt（bundle＋第二輪時再加上一輪回答）要走命令列參數（agy 不吃 stdin），
# Linux 單一參數上限 128 KiB；codex 走 stdin 沒這問題。超過就是 change 太大，人工拆開審 —— 送出前擋，不要送到一半炸。
[ "$SIZE" -lt 110000 ] || { echo "✗ bundle ${SIZE} bytes，超過 110 KB —— 這個 change 太大，人工拆開審。" >&2; exit 2; }
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
  local tmp; tmp="$(mktemp "$OUT/codex.XXXXXX")"
  if [ "$ROUND" = 2 ] && SESSION="$(python3 -c 'import json,sys;print([json.loads(l) for l in open(sys.argv[1]) if l.strip() and json.loads(l).get("kind")=="review" and json.loads(l)["id"]==sys.argv[2] and json.loads(l)["model"]=="codex" and json.loads(l).get("session")][-1]["session"])' "$LEDGER" "$ID" 2>/dev/null)" && [ -n "$SESSION" ]; then
    "$CODEX_BIN" exec --skip-git-repo-check resume "$SESSION" - < "$OUT/bundle.md" > "$tmp" 2> "$OUT/codex.err" &
  else
    "$CODEX_BIN" exec --sandbox read-only --skip-git-repo-check -m "$CODEX_MODEL" -c model_reasoning_effort="high" - < "$OUT/bundle.md" > "$tmp" 2> "$OUT/codex.err" &
  fi
  local rc=0; watch $! || rc=$?; finish codex "$rc" "$tmp"
  row codex "$t0" "$rc" "$(grep -o 'session id: [0-9a-f-]*' "$OUT/codex.err" | tail -1 | cut -d' ' -f3)"
}
run_gemini() {
  local t0; t0=$(date +%s)
  ! has_answer gemini "$ROUND" || { echo "（gemini 第 $ROUND 輪已經答過，不重送）"; return; }
  command -v "$GEMINI_BIN" >/dev/null || { echo "（跳過 gemini：找不到 ${GEMINI_BIN}）" | tee "$OUT/gemini.md"; row gemini "$t0" 127; return; }
  { [ "$ROUND" = 2 ] && { echo "## 你上一輪的回答"; cat "$DIR/r1/gemini.md"; echo; }; cat "$OUT/bundle.md"; } > "$OUT/gemini.prompt.md"
  # agy 不吃 stdin，prompt 只能走命令列參數：Linux 單一參數上限 128 KiB，取 120 000 bytes；超過就明說跳過、記帳本（這個 change 進不了雙模型樣本）。
  [ "$(wc -c < "$OUT/gemini.prompt.md" | tr -d ' ')" -lt 120000 ] || { echo "（跳過 gemini：prompt 超過 120 KB，命令列參數塞不下 —— change 太大，人工拆開審）" | tee "$OUT/gemini.md"; row gemini "$t0" 7; return; }
  local tmp; tmp="$(mktemp "$OUT/gemini.XXXXXX")"
  "$GEMINI_BIN" --print "$(cat "$OUT/gemini.prompt.md")" --model "$GEMINI_MODEL" --effort high --mode plan --print-timeout 25m > "$tmp" 2> "$OUT/gemini.err" &
  local rc=0; watch $! || rc=$?; finish gemini "$rc" "$tmp"
  row gemini "$t0" "$rc"
}
run_codex & run_gemini & wait

echo; for m in codex gemini; do echo "── ${m}（$OUT/$m.md）"; grep -E "${TAG}\[(需修正|可接受風險|誤報候選)\]|^結論" "$OUT/$m.md" || tail -n 5 "$OUT/$m.md"; done
echo; echo "下一步：需修正的 → 原 session 修、合併，再跑 --rereview（只一次）；每一條需修正判定後 --judge（誤報／已驗證／已修）；封存後 --report。"
