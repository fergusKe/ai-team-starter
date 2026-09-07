#!/usr/bin/env bash
# `.github/workflows/ci.yml` 自己的合約測試。
#
# 為什麼需要這一支：另外兩支測試（test-progress-check.sh、test-check-pr-branch.sh）
# 測的是**腳本**。但 2026-09-07 找到的那個洞不在腳本裡，在**這份 YAML 怎麼呼叫腳本**：
#
#     run: bash .github/scripts/check-pr-branch.sh "${{ github.head_ref }}"
#
# Actions 的 `${{ }}` 是**文字替換**，不是參數傳遞。而 git 收 `chore/$(...)`
# 這種分支名（`git check-ref-format --branch 'chore/$(printf${IFS}X)'` rc=0），
# 所以插值後那段會被 shell 執行 —— **在閘門拿到參數之前**。
# 任何能開 PR 的人都能在 runner 上執行指令。這是 GitHub 官方點名的 script injection。
#
# 腳本自己是乾淨的（`BASE="${1:?…}"`／`HEAD="${2:?…}"`，用到的地方都有引號），
# 所以直接呼叫腳本的測試**永遠測不到這個洞**。閘門的輸入層要有自己的讀者。
#
# 判準跟其他兩支一樣：**把防禦拿掉，這支要變紅。** 四種突變各自對應一條：
#   把 env 中介變數改回直接插值        → T1／T3 紅
#   把 `npm ci` 移回 Branch 後面        → T4 紅
#   刪掉任何一支閘門測試的步驟          → T5 紅
#   給某一步加 continue-on-error        → T6 紅
#
# 零依賴：bash + 系統 python3，**不用 YAML 套件**（CI 閘門的零依賴限制跟測試
# 不同，見 docs/DECISIONS.md）。因此解析刻意保守：只認這份檔案實際用的形狀，
# 認不出來就直接失敗 —— **解析器瞎掉不能等於全綠**。
#
# 這支不用 `eval`：parser 吐一份扁平的 key=value facts 檔，下面照 key 讀。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WF="$ROOT/.github/workflows/ci.yml"
W="${TMPDIR:-/tmp}/ci-workflow-test.$$"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; return 0; }

[ -f "$WF" ] || { echo "✗ 找不到 $WF"; exit 1; }
mkdir -p "$W"

FACTS="$W/facts.txt"
python3 - "$WF" "$FACTS" <<'PARSE'
import re, sys
wf, out = sys.argv[1], sys.argv[2]
lines = open(wf, encoding="utf-8").read().splitlines()

def die(msg): sys.exit("PARSE_FAIL: " + msg)

try:    j = next(i for i, l in enumerate(lines) if l.rstrip() == "jobs:")
except StopIteration: die("找不到 jobs:")
try:    c = next(i for i in range(j + 1, len(lines)) if lines[i].rstrip() == "  ci:")
except StopIteration: die("找不到 ci job")

end = len(lines)
for i in range(c + 1, len(lines)):
    s = lines[i]
    if s.strip() and s.startswith("  ") and not s.startswith("    "):
        end = i; break
job = lines[c:end]

# 認不得的 key 寫法一律 parse-fail。
# 2026-09-07 審查實測：`"i\u0066": false` 被真的 YAML parser 解成 `if: false`，
# 而這支只認 bare 與單純 quoted 的 key，於是「沒看見就通過」——那是 fail-open。
# 這裡不去支援 YAML 的全部跳脫語法（支援不完），改成**看到就拒**。
for l in job:
    if re.search(r"""^\s*['"][^'"]*\\[uUx][0-9A-Fa-f]""", l) or re.search(r"^\s*[?&*]", l):
        die("YAML key 用了這支 parser 不支援的寫法（跳脫序列／anchor／複雜 key）：\n    "
            + l.strip() + "\n  認不得就拒，不要猜。")

steps, cur = [], None
for l in job:
    if re.match(r"^      - ", l):
        if cur is not None: steps.append(cur)
        # 步驟第一行的 key 前面有 `- `（`      - name: X`）。把 `- ` 換成兩個
        # 空白之後，下面的 field() 才抓得到它 —— 否則第一行的 name/run/uses
        # 會整個看不見，而那正是「解析器瞎掉」的樣子。
        cur = [re.sub(r"^(      )- ", r"\1  ", l)]
    elif cur is not None and (l.startswith("        ") or not l.strip()):
        cur.append(l)
    elif cur is not None and l.strip():
        steps.append(cur); cur = None
if cur is not None: steps.append(cur)
if not steps: die("ci job 裡抽不到任何步驟")

def field(raw, key):
    # bare 與 quoted 都要認。只認 bare 的話，`"continue-on-error": true`
    # 會「沒看見而通過」—— 那是 fail-open，不是 fail-closed。
    pat = re.compile(r"^\s*(?:%s|\"%s\"|\'%s\'):\s?(.*)$"
                     % (re.escape(key), re.escape(key), re.escape(key)))
    for l in raw:
        m = pat.match(l)
        if m: return m.group(1)
    return None

def envmap(raw):
    out, inenv, ind = {}, False, 0
    for l in raw:
        if re.match(r"^\s*env:\s*$", l):
            inenv = True; ind = len(l) - len(l.lstrip()); continue
        if inenv:
            if not l.strip(): continue
            if len(l) - len(l.lstrip()) <= ind: inenv = False; continue
            m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$", l)
            if m: out[m.group(1)] = m.group(2)
    return out

names   = [(field(s, "name") or "").strip() for s in steps]
runs    = [field(s, "run") or "" for s in steps]
coe     = [field(s, "continue-on-error") for s in steps]
ifs     = [field(s, "if") for s in steps]
# 自訂 shell 可以整步中和：`shell: bash {0} || true` 讓 run 怎麼寫都不會紅。
shells  = [field(s, "shell") for s in steps]

# job 層的鍵（縮排 4 格，不在 steps: 底下）。
# 2026-09-07 審查抓到：原本只掃 step 層，`ci:` 底下加一行
# `continue-on-error: true` 整個 job 失敗都不算失敗，而測試全綠。
job_keys = {}
in_steps = False
for l in job:
    if re.match(r"^    steps:\s*$", l): in_steps = True; continue
    if in_steps and re.match(r"^    [A-Za-z_-]+:", l): in_steps = False
    if in_steps: continue
    m = re.match(r"""^    (?:([A-Za-z_-]+)|"([^"]+)"|'([^']+)'):\s?(.*)$""", l)
    if m: job_keys[m.group(1) or m.group(2) or m.group(3)] = m.group(4)

f = open(out, "w", encoding="utf-8")
def put(k, v): f.write("%s\t%s\n" % (k, v))

if "Branch" not in names: die("ci job 裡沒有 name: Branch 的步驟")
bi = names.index("Branch")
put("branch_found", "1")
put("branch_run", runs[bi])
e = envmap(steps[bi])
put("branch_env_base", e.get("BASE_REF", ""))
put("branch_env_head", e.get("HEAD_REF", ""))

inst = [i for i, r in enumerate(runs) if r.strip() == "npm ci"]
if not inst: die("ci job 裡找不到 `run: npm ci`")
put("install_before_branch", "1" if min(inst) < bi else "0")
put("install_idx", str(min(inst))); put("branch_idx", str(bi))

for t in ("test-progress-check.sh", "test-check-pr-branch.sh", "test-ci-workflow.sh", "test-prompts.sh",
           "test-scenario-coverage.sh", "check-scenario-coverage.sh"):
    put("has_" + t, "1" if any(t in r for r in runs) else "0")

put("continue_on_error", "1" if any(v is not None for v in coe) else "0")
put("job_continue_on_error", "1" if "continue-on-error" in job_keys else "0")
# job 層的 `if: false` 會讓整個 job 被 skip，而 skip 在 required check 上算通過。
put("job_if", "1" if "if" in job_keys else "0")
# job 層的 defaults.run.shell 會套用到每一步，效果跟逐步加 shell: 一樣。
put("job_defaults", "1" if "defaults" in job_keys else "0")

# env 值要**完全相等**，不是「包含」。`prefix-${{ github.head_ref }}` 也含那串字，
# 但傳進閘門的就不是分支名了（2026-09-07 審查的存活突變之一）。
put("branch_env_base_exact", "1" if e.get("BASE_REF", "").strip() == "${{ github.base_ref }}" else "0")
put("branch_env_head_exact", "1" if e.get("HEAD_REF", "").strip() == "${{ github.head_ref }}" else "0")

# 每一支必跑的測試：不得有 if:（會被 skip）、run 不得被 `|| true` 之類中和。
# **精確 allow-list**，不是「列舉會忽略失敗的寫法」。
# deny-list 列不完：`|| true`、`|| :`、`|| echo x`、`|| exit 0`、`; true`…
# 只要 run 不是剛好那一句，就當作被動過。
for t_ in ("test-progress-check.sh", "test-check-pr-branch.sh", "test-ci-workflow.sh", "test-prompts.sh",
           "test-scenario-coverage.sh", "check-scenario-coverage.sh"):
    want = "bash .github/scripts/%s" % t_
    idxs = [i for i, r in enumerate(runs) if t_ in r]
    put("exact_" + t_, "1" if any(
        runs[i].strip() == want and ifs[i] is None and shells[i] is None
        for i in idxs) else "0")
    put("actual_" + t_, (runs[idxs[0]].strip() if idxs else ""))

# 四個工程品質步驟。**它們原本完全沒被鎖住** —— 把 Build 改成 `run: true`，
# 這支測試照樣 17/17（外部審查實測）。而 `FE-X01-S10` 的 `ci-job` 豁免正是
# 拿「CI 有跑這四步」當證據，那條證據站不住的話豁免也站不住。
#
# **掃整份 workflow，不是只掃 ci job。** 模板把這四關放在獨立的 `quality:`
# job，衍生專案放在 `ci:` —— 兩種擺法都合法，而「它們有沒有真的跑」跟放在
# 哪個 job 無關。（第一版只掃 ci job，於是模板四條全紅，而模板其實是對的。）
all_steps, _cur = [], None
_after_jobs = lines[j + 1:]
for l in _after_jobs:
    if re.match(r"^      - ", l):
        if _cur is not None: all_steps.append(_cur)
        _cur = [re.sub(r"^(      )- ", r"\1  ", l)]
    elif _cur is not None and (l.startswith("        ") or not l.strip()):
        _cur.append(l)
    elif _cur is not None and l.strip():
        all_steps.append(_cur); _cur = None
if _cur is not None: all_steps.append(_cur)
all_names = [(field(s, "name") or "").strip() for s in all_steps]
all_runs = [field(s, "run") or "" for s in all_steps]
all_ifs = [field(s, "if") for s in all_steps]
all_shells = [field(s, "shell") for s in all_steps]

for _n, _want in (("Lint", "npm run lint"), ("Typecheck", "npm run typecheck"),
                  ("Test", "npm test"), ("Build", "npm run build")):
    _i = [k for k, nm in enumerate(all_names) if nm == _n]
    put("quality_" + _n, "1" if (_i and all_runs[_i[0]].strip() == _want
                                 and all_ifs[_i[0]] is None and all_shells[_i[0]] is None) else "0")
    put("quality_actual_" + _n, (all_runs[_i[0]].strip() if _i else "（沒有這一步）"))

# **整份 workflow 都不准出現 continue-on-error。** 原本只掃 ci job 的 step 層
# 與 job 層 —— 別的 job（例如模板的 `quality:`）設了它，一樣是「失敗不算失敗」。
put("coe_anywhere", "1" if re.search(r"^\s*(?:continue-on-error|\"continue-on-error\"|'continue-on-error'):",
                                     "\n".join(lines), re.M) else "0")

# npm ci 那一步也不得被 if: 關掉（關掉再在後面放一個真的，順序檢查會被騙過）。
inst_live = [i for i in inst if ifs[i] is None]
put("install_live_before_branch", "1" if inst_live and min(inst_live) < bi else "0")
f.close()
PARSE
if [ $? -ne 0 ]; then
  echo "✗ 解析 ci.yml 失敗 —— 解析不了不等於通過"
  exit 1
fi

get() { awk -F'\t' -v k="$1" '$1==k{sub(/^[^\t]*\t/,""); print; exit}' "$FACTS"; }

echo "── ci.yml 合約 ──"

# ── ok()/bad() 自己的陽性對照 ───────────────────────────────────────────────
#
# 這支測試唯一的紅燈來源就是 `bad()` 把失敗計進 $FAIL。它壞掉（例如 +1 被寫成
# +0）的話，**真的有失敗也會報綠** —— 2026-09-07 實測：把 +1 改成 +0、同時
# 製造一個真的失敗，整支仍然 rc=0。
#
# 所以先驗它還活著：叫一次 bad，看 $FAIL 有沒有真的加一，然後撤銷。
_fail_before=$FAIL
bad "自測（不計入）" >/dev/null 2>&1
if [ "$FAIL" -eq "$((_fail_before + 1))" ]; then
  FAIL=$_fail_before
  ok "bad() 自測：失敗真的會被計進去"
else
  FAIL=$((_fail_before + 1))
  printf '  \033[31m✗\033[0m %s\n' "bad() 自測：它沒有把失敗計進去 —— 這支測試的綠燈是假的"
fi


# T1：Branch 那一步的 run 不得直接含 GitHub expression
BRUN="$(get branch_run)"
case "$BRUN" in
  *'${{'*) bad "Branch 的 run 不含 \${{ }}（要走 env 中介變數）" "run: ${BRUN}" ;;
  *)       ok "Branch 的 run 不含 \${{ }}（走 env 中介變數）" ;;
esac

# T2：env 有把兩個 ref 綁成中介變數
# 完全相等，不是包含 —— `prefix-${{ github.head_ref }}` 也「包含」那串字。
[ "$(get branch_env_base_exact)" = "1" ] && ok "env.BASE_REF 完全等於 github.base_ref" || bad "env.BASE_REF 完全等於 github.base_ref" "實際：$(get branch_env_base)"
[ "$(get branch_env_head_exact)" = "1" ] && ok "env.HEAD_REF 完全等於 github.head_ref" || bad "env.HEAD_REF 完全等於 github.head_ref" "實際：$(get branch_env_head)"

# T3：實際跑一次，斷言分支名逐字傳進閘門（假 checker 只記錄 argv）
EVIL='chore/$(printf CI_WORKFLOW_TEST_INJECTED)'
mkdir -p "$W/repo/.github/scripts"
cat > "$W/repo/.github/scripts/check-pr-branch.sh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$#" > argv.count
: > argv.list
for a in "$@"; do printf '%s\n' "$a" >> argv.list; done
FAKE
( cd "$W/repo" && BASE_REF="main" HEAD_REF="$EVIL" bash -c "$BRUN" ) >/dev/null 2>&1
GOT_N="$(cat "$W/repo/argv.count" 2>/dev/null || echo 0)"
GOT_2="$(sed -n '2p' "$W/repo/argv.list" 2>/dev/null || true)"
[ "$GOT_N" = "2" ] && ok "閘門收到剛好 2 個參數" || bad "閘門收到剛好 2 個參數" "實際 ${GOT_N} 個"
[ "$GOT_2" = "$EVIL" ] && ok "分支名逐字傳入（\$() 沒有被執行）" \
                       || bad "分支名逐字傳入（\$() 沒有被執行）" "送進去：${EVIL}／收到：${GOT_2}"

# T4：npm ci 要排在 Branch 之前（否則 Branch 內部那次 npx 會繞過 lockfile）
[ "$(get install_live_before_branch)" = "1" ] \
  && ok "有一步「真的會跑的」npm ci 排在 Branch 之前" \
  || bad "有一步「真的會跑的」npm ci 排在 Branch 之前" "npm ci 在第 $(get install_idx) 步、Branch 在第 $(get branch_idx) 步（帶 if: 的不算）"

# T5：四支閘門測試都要在 ci job 裡
# **模板不把 `check-scenario-coverage.sh` 列進來。** 剛複製的模板沒有任何
# 規格，那支閘門會紅在「一份規格檔都沒掃到」—— 而那個判斷是對的，
# 掃不到不等於全部覆蓋。衍生專案有規格之後自己加進 ci.yml 與這份清單
# （GuildHub-frontend 已經這樣做了，見它的 docs/DECISIONS.md）。
for t in test-progress-check.sh test-check-pr-branch.sh test-ci-workflow.sh test-prompts.sh \
         test-scenario-coverage.sh; do
  if [ "$(get "exact_$t")" = "1" ]; then
    ok "ci job 跑 ${t}，run 剛好是那一句、沒有 if:／shell:"
  else
    bad "ci job 跑 ${t}，run 剛好是那一句、沒有 if:／shell:" \
        "實際 run：$(get "actual_$t")（預期剛好 bash .github/scripts/${t}）"
  fi
done

# T5b：四個工程品質步驟也要真的跑
for q in Lint Typecheck Test Build; do
  if [ "$(get "quality_$q")" = "1" ]; then
    ok "ci job 的 ${q} 步驟 run 剛好是那一句、沒有 if:／shell:"
  else
    bad "ci job 的 ${q} 步驟 run 剛好是那一句、沒有 if:／shell:" \
        "實際：$(get "quality_actual_$q")"
  fi
done

# T5b2：整份 workflow 都不准有 continue-on-error
[ "$(get coe_anywhere)" = "0" ] \
  && ok "整份 ci.yml 都沒有 continue-on-error（不是只有 ci job）" \
  || bad "整份 ci.yml 都沒有 continue-on-error" "別的 job 設了它，一樣是失敗不算失敗"

# T5c：**有規格的專案一定要接覆蓋閘門。**
#
# 這一條取代了原本「模板與衍生各自維護一份必跑清單」的宣告式分岔 ——
# 那個分岔要靠人記得，而外部審查實測：在模板複本加一份正式 main spec、
# 完全沒有測試，這支測試仍然全過。改成同一條規則，兩邊都適用：
#   沒有規格 → 不要求（剛複製的模板）
#   有規格   → ci.yml 一定要有那一步，而且不得被中和
HAS_SPECS=0
if [ -d "$ROOT/openspec/specs" ] \
   && grep -rqE '^####[[:space:]]+Scenario:' "$ROOT/openspec/specs" 2>/dev/null; then
  HAS_SPECS=1
fi
if [ "$HAS_SPECS" = 1 ]; then
  if [ "$(get exact_check-scenario-coverage.sh)" = "1" ]; then
    ok "有規格，而且 ci.yml 接了 check-scenario-coverage.sh"
  else
    bad "有規格，而且 ci.yml 接了 check-scenario-coverage.sh" \
        "openspec/specs/ 裡有 Scenario，但 ci.yml 沒有那一步（實際：$(get actual_check-scenario-coverage.sh)）"
  fi
else
  ok "還沒有任何規格，覆蓋閘門先不要求（剛複製的模板）"
fi

# T6：ci job 不得有 continue-on-error（失敗要真的失敗）
# step 層與 **job 層**都要掃。job 層的 continue-on-error 是 Actions 正式支援的
# 失敗處理面，設了之後整個 job 失敗都不算失敗 —— 原本只掃 step 層，它存活。
[ "$(get continue_on_error)" = "0" ] \
  && ok "沒有步驟設 continue-on-error" \
  || bad "沒有步驟設 continue-on-error" "有步驟設了 continue-on-error"
[ "$(get job_continue_on_error)" = "0" ] \
  && ok "ci job 自己沒有 continue-on-error" \
  || bad "ci job 自己沒有 continue-on-error" "job 層設了 continue-on-error，整個 job 紅了也不算失敗"
# job 層的 if: false 會讓整個 job 被 skip —— 而 skipped 在 required check 上算通過。
[ "$(get job_if)" = "0" ] \
  && ok "ci job 自己沒有 if:" \
  || bad "ci job 自己沒有 if:" "job 層設了 if:，整個 job 可能被 skip 而算通過"
# defaults.run.shell 會套到每一步，等於一次中和全部。
[ "$(get job_defaults)" = "0" ] \
  && ok "ci job 沒有 defaults:（不能用 defaults.run.shell 一次中和全部）" \
  || bad "ci job 沒有 defaults:" "job 層設了 defaults，可能用 defaults.run.shell 中和每一步"

echo
printf '通過 %s / 失敗 %s / 共 %s\n' "$PASS" "$FAIL" "$((PASS+FAIL))"
# 成功就清掉，失敗才留現場 —— 理由見 `test-progress-check.sh` 開頭那段。
if [ "$FAIL" -eq 0 ]; then
  rm -rf "${W}"
else
  echo "測試目錄留著給你看：${W}"
fi
[ "$FAIL" -eq 0 ]
