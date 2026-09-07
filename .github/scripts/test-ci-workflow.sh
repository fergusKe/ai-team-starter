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

for t in ("test-progress-check.sh", "test-check-pr-branch.sh", "test-ci-workflow.sh", "test-prompts.sh"):
    put("has_" + t, "1" if any(t in r for r in runs) else "0")

put("continue_on_error", "1" if any(v is not None for v in coe) else "0")
put("job_continue_on_error", "1" if "continue-on-error" in job_keys else "0")
# job 層的 `if: false` 會讓整個 job 被 skip，而 skip 在 required check 上算通過。
put("job_if", "1" if "if" in job_keys else "0")

# env 值要**完全相等**，不是「包含」。`prefix-${{ github.head_ref }}` 也含那串字，
# 但傳進閘門的就不是分支名了（2026-09-07 審查的存活突變之一）。
put("branch_env_base_exact", "1" if e.get("BASE_REF", "").strip() == "${{ github.base_ref }}" else "0")
put("branch_env_head_exact", "1" if e.get("HEAD_REF", "").strip() == "${{ github.head_ref }}" else "0")

# 每一支必跑的測試：不得有 if:（會被 skip）、run 不得被 `|| true` 之類中和。
# **精確 allow-list**，不是「列舉會忽略失敗的寫法」。
# deny-list 列不完：`|| true`、`|| :`、`|| echo x`、`|| exit 0`、`; true`…
# 只要 run 不是剛好那一句，就當作被動過。
for t_ in ("test-progress-check.sh", "test-check-pr-branch.sh", "test-ci-workflow.sh", "test-prompts.sh"):
    want = "bash .github/scripts/%s" % t_
    idxs = [i for i, r in enumerate(runs) if t_ in r]
    put("exact_" + t_, "1" if any(runs[i].strip() == want and ifs[i] is None for i in idxs) else "0")
    put("actual_" + t_, (runs[idxs[0]].strip() if idxs else ""))

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
for t in test-progress-check.sh test-check-pr-branch.sh test-ci-workflow.sh test-prompts.sh; do
  if [ "$(get "exact_$t")" = "1" ]; then
    ok "ci job 跑 ${t}，且 run 剛好是那一句、沒有 if:"
  else
    bad "ci job 跑 ${t}，且 run 剛好是那一句、沒有 if:" \
        "實際 run：$(get "actual_$t")（預期剛好 bash .github/scripts/${t}）"
  fi
done

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

echo
printf '通過 %s / 失敗 %s / 共 %s\n' "$PASS" "$FAIL" "$((PASS+FAIL))"
echo "測試目錄：$W"
[ "$FAIL" -eq 0 ]
