#!/usr/bin/env bash
# check-scenario-coverage.sh 的負向測試。
#
#     bash .github/scripts/test-scenario-coverage.sh
#
# **一個從來沒紅過的檢查等於沒有檢查。** 這支腳本對每一條規則各造一次違規，
# 斷言它真的會紅；再用一份完全乾淨的輸入當陽性對照。
#
# `npx` 用只吐固定 JSON 的替身 —— **不跑真的測試**（那要幾十秒，而且會讓
# 這支測試的結果取決於別的東西）。替身只攔 `vitest`，其他一律照舊。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/.github/scripts/check-scenario-coverage.sh"
[ -f "$GATE" ] || { echo "✗ 找不到 $GATE"; exit 1; }

W="$(mktemp -d "${TMPDIR:-/tmp}/scen-cov-test.XXXXXXXX")"
PASS=0
FAIL=0
# 失敗登記只有這一個入口 —— 分散的話自測只走得到其中幾處。
bump_fail() { FAIL=$((FAIL + 1)); }

# ── fixture ────────────────────────────────────────────────────────
# 每個案例都從乾淨的狀態出發，只壞一個地方。
setup() {
  rm -rf "$W/repo"
  mkdir -p "$W/repo/openspec/specs/demo" "$W/repo/bin" "$W/tmp" "$W/repo/.github/workflows"
  # `ci-job` 豁免的證據欄要指到這裡面真的有的步驟名稱。
  printf 'jobs:\n  ci:\n    steps:\n      - name: Lint\n        run: x\n      - name: Build\n        run: y\n' \
    > "$W/repo/.github/workflows/ci.yml"
  ( cd "$W/repo" && git init -q \
    && git -c user.email=t@t.invalid -c user.name=t commit -q --allow-empty -m x )
  cat > "$W/repo/openspec/specs/demo/spec.md" <<'SPEC'
# demo

## Requirements

### Requirement: 示範

#### Scenario: [DEMO-01-S01] 第一條

- **WHEN** a
- **THEN** b

#### Scenario: [DEMO-01-S02] 第二條

- **WHEN** a
- **THEN** b
SPEC
  # `npx` 替身：只攔 vitest，把預先寫好的 JSON 放到 --outputFile 指的位置。
  cat > "$W/repo/bin/npx" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" != "vitest" ]; then exec /usr/bin/env npx "$@"; fi
out=""
while [ $# -gt 0 ]; do
  case "$1" in --outputFile=*) out="${1#--outputFile=}" ;;
               --outputFile) shift; out="${1:-}" ;; esac
  shift
done
[ -n "$out" ] && [ -n "${FAKE_JSON:-}" ] && printf '%s' "$FAKE_JSON" > "$out"
exit "${FAKE_RC:-0}"
STUB
  chmod +x "$W/repo/bin/npx"
}

# 兩條都通過的報告。**葉節點標題帶 ID**，那才是被認的地方。
json_all_pass() {
  printf '%s' '{"testResults":[{"assertionResults":[
    {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]},
    {"title":"[DEMO-01-S02] 第二條","status":"passed","ancestorTitles":["demo"]}]}]}'
}

# run <期望退出碼> <說明> <訊息片段>：在 fixture 上跑閘門
run() {
  local want="$1" desc="$2" needle="$3" out rc
  # **TMPDIR 指到自己的工作目錄。** 閘門失敗時會保留它的暫存目錄（那是對的，
  # 失敗要留現場），而這支測試裡有 16 個案例**故意失敗** —— 跑一次就在系統的
  # $TMPDIR 留 16 個目錄。指到 $W 之後，它們跟著 $W 一起被清掉。
  out="$(cd "$W/repo" && PATH="$W/repo/bin:$PATH" TMPDIR="$W/tmp" \
         FAKE_JSON="${FAKE_JSON:-}" FAKE_RC="${FAKE_RC:-0}" bash "$GATE" 2>&1)"; rc=$?
  if [ "$rc" != "$want" ]; then
    echo "✗ ${desc} —— 期望退出碼 ${want}，實際 ${rc}"
    echo "$out" | sed 's/^/      /' | head -12
    bump_fail; return
  fi
  if [ -n "$needle" ] && ! printf '%s' "$out" | grep -q -- "$needle"; then
    echo "✗ ${desc} —— 退出碼對了，但訊息裡沒有「${needle}」"
    echo "$out" | sed 's/^/      /' | head -12
    bump_fail; return
  fi
  echo "✓ $desc"; PASS=$((PASS + 1))
}

echo "check-scenario-coverage.sh 的負向測試"
echo

# ── 自測：run 真的會判紅嗎 ─────────────────────────────────────────
# **少了這一條，下面每一條都可能是假的綠燈。**
_before=$FAIL
FAKE_JSON="$(json_all_pass)"; FAKE_RC=0; setup
run 1 "自測（不計入）" "" >/dev/null 2>&1
if [ "$FAIL" -eq "$((_before + 1))" ]; then
  FAIL=$_before; echo "✓ run 自測：失敗真的會被計進 \$FAIL"; PASS=$((PASS + 1))
else
  FAIL=$((_before + 1)); echo "✗ run 自測：失敗沒有被計進 \$FAIL —— 這支測試的綠燈是假的"
fi

echo
echo "── 陽性對照 ──"
FAKE_JSON="$(json_all_pass)"; FAKE_RC=0; setup
run 0 "兩條都有通過的測試：綠" "Scenario 覆蓋"

echo
echo "── 覆蓋 ──"
setup
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 1 "少一條就要紅" "DEMO-01-S02"

# **skipped 不算覆蓋。** 這是「出現這個 ID」與「真的被驗了」之間最常見的差。
setup
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]},
  {"title":"[DEMO-01-S02] 第二條","status":"skipped","ancestorTitles":["demo"]}]}]}'
run 1 "skipped 不算覆蓋" "DEMO-01-S02"

setup
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]},
  {"title":"[DEMO-01-S02] 第二條","status":"failed","ancestorTitles":["demo"]}]}]}'
run 1 "failed 不算覆蓋" "DEMO-01-S02"

# **ID 寫在 describe 上不算。** 那個 describe 底下每一條都會沾到它，
# 包括被 skip 的那些 —— 一條 ID 就能替一整群測試背書。
setup
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]},
  {"title":"某條沒有 ID 的測試","status":"passed","ancestorTitles":["[DEMO-01-S02] 第二條"]}]}]}'
run 1 "ID 只寫在 describe 上不算覆蓋" "DEMO-01-S02"

echo
echo "── 測試本身的狀態 ──"
setup
FAKE_JSON="$(json_all_pass)"; FAKE_RC=1
run 1 "測試沒全綠就直接失敗" "測試沒有全綠"

# **產不出報告不等於全部覆蓋。** 這是最危險的一種綠燈。
setup
FAKE_JSON=""; FAKE_RC=0
run 1 "沒有產生報告要紅" "沒有產生報告"

setup
FAKE_JSON='{"nope":[]}'; FAKE_RC=0
run 1 "報告 schema 變了要紅（不可以當成空集合）" "testResults"

setup
FAKE_JSON='{"testResults":[]}'; FAKE_RC=0
run 1 "報告裡零條測試要紅" "一條測試結果都沒有"

echo
echo "── 豁免 ──"
add_verify() { printf '%s\n' "$1" >> "$W/repo/openspec/specs/demo/spec.md"; }

# 豁免要真的生效（陽性對照 —— 少了它，「一律報缺」也會讓上面那些全綠）
setup
HEADSHA="$(git -C "$W/repo" rev-parse HEAD)"
python3 - "$W/repo/openspec/specs/demo/spec.md" "$HEADSHA" <<'PY'
import io, sys
p = sys.argv[1]
t = io.open(p, encoding="utf-8").read()
t = t.replace("#### Scenario: [DEMO-01-S02] 第二條\n\n- **WHEN** a\n- **THEN** b",
              "#### Scenario: [DEMO-01-S02] 第二條\n\n- **WHEN** a\n- **THEN** b\n"
              "- **VERIFY-BY** `manual-browser`｜" + sys.argv[2] + " 的驗證紀錄｜這條要真的畫面才驗得到")
io.open(p, "w", encoding="utf-8").write(t)
PY
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 0 "有 VERIFY-BY 豁免就算過" "豁免"

# 列舉裡的每一種都要真的被接受（陽性對照 —— 少了它，把某一種從列舉裡刪掉
# 不會有任何測試變紅）。
setup
add_verify '- **VERIFY-BY** `ci-job`｜ci.yml 的 Lint／Build 兩個步驟｜CI 的 job 本身就是這條的執行'
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 0 "ci-job 也是認得的豁免種類" "ci-job"

# **`ci-job` 的證據完全可以機器驗，不該是任意文字。**（外部審查指出：
# 原本寫什麼都算數，跟「宣告即證據」沒有兩樣。）
setup
add_verify '- **VERIFY-BY** `ci-job`｜ci.yml 的 Deploy 步驟｜CI 的 job 本身就是這條的執行'
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 1 "ci-job 指到不存在的步驟名稱要紅" "沒有任何一個是"

setup
python3 - "$W/repo/.github/workflows/ci.yml" <<'RM'
import io, sys, os
os.remove(sys.argv[1])
RM
add_verify '- **VERIFY-BY** `ci-job`｜ci.yml 的 Lint 步驟｜CI 的 job 本身就是這條的執行'
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 1 "有 ci-job 豁免卻找不到 ci.yml 要紅" "找不到 .github/workflows/ci.yml"

# 種類是封閉列舉 —— 打錯字的豁免等於沒有豁免，但它看起來跟真的一模一樣。
setup
add_verify '- **VERIFY-BY** `眼睛看過了`｜PR #1｜這條要真的畫面才驗得到'
FAKE_JSON="$(json_all_pass)"
run 1 "不認得的豁免種類要紅" "不在列舉裡"

setup
add_verify "- **VERIFY-BY** \`manual-browser\`｜$(git -C "$W/repo" rev-parse HEAD)｜TBD"
FAKE_JSON="$(json_all_pass)"
run 1 "豁免沒有實質理由要紅" "沒有寫出實質理由"

setup
add_verify '- **VERIFY-BY** `manual-browser`｜只有兩段'
FAKE_JSON="$(json_all_pass)"
run 1 "豁免格式不是三段要紅" "要三段"

# **三段都要有東西。** `manual-browser｜｜理由` 切出來仍然是三段，
# 中間那段是空字串 —— 沒有證據的豁免跟有證據的長得一模一樣。
setup
add_verify '- **VERIFY-BY** `manual-browser`｜｜這條要真的畫面才驗得到'
FAKE_JSON="$(json_all_pass)"
run 1 "豁免中間欄位是空的要紅" "要三段"

# **`manual-browser` 的證據要是不可變、離線取得回的。**「PR #37 的紀錄」
# 不是證據，是宣告 —— PR 內文可以編輯、附件可以刪，而且要連網才查得到
# （外部審查實測：沙箱裡 `gh pr view 37` rc=1，無法確認附件是否存在）。
setup
add_verify '- **VERIFY-BY** `manual-browser`｜PR #37 的 V1 驗證紀錄｜這條要真的畫面才驗得到'
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 1 "manual-browser 只寫 PR 號碼要紅" "沒有 40 位完整 commit SHA"

setup
add_verify '- **VERIFY-BY** `manual-browser`｜0000000000000000000000000000000000000000 的紀錄｜這條要真的畫面才驗得到'
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 1 "manual-browser 指到不存在的 commit 要紅" "在本機找不到"

# **過期的豁免要拿掉。** 測試補上了、豁免還留著，那張免死金牌會一直有效。
setup
add_verify "- **VERIFY-BY** \`manual-browser\`｜$(git -C "$W/repo" rev-parse HEAD)｜這條要真的畫面才驗得到"
FAKE_JSON="$(json_all_pass)"
run 1 "同時有通過的測試與豁免要紅（豁免過期）" "豁免過期了"

echo
echo "── 規格本身 ──"
setup
printf '\n#### Scenario: 沒有穩定 ID 的一條\n\n- **WHEN** a\n- **THEN** b\n' \
  >> "$W/repo/openspec/specs/demo/spec.md"
FAKE_JSON="$(json_all_pass)"
run 1 "Scenario 沒有 [ID] 要紅（不可以當成不存在）" "沒有"

setup
printf '\n#### Scenario: [DEMO-01-S01] 重複的 ID\n\n- **WHEN** a\n- **THEN** b\n' \
  >> "$W/repo/openspec/specs/demo/spec.md"
FAKE_JSON="$(json_all_pass)"
run 1 "Scenario ID 重複要紅（不可以靜靜折疊）" "出現不只一次"

# 同一份規格裡重複要紅（`sort -u` 會把兩條不同的 Scenario 折疊成一條）。
setup
printf '\n#### Scenario: [DEMO-01-S01] 又一條同 ID\n\n- **WHEN** a\n- **THEN** b\n' \
  >> "$W/repo/openspec/specs/demo/spec.md"
FAKE_JSON="$(json_all_pass)"
run 1 "Scenario ID 重複要紅" "出現不只一次"

# **掃不到不等於全部覆蓋。** 目錄搬走、正規表示式寫壞，差集都會變成空的。
setup
rm -rf "$W/repo/openspec/specs"
FAKE_JSON="$(json_all_pass)"
run 1 "一份規格檔都沒掃到要紅" "掃不到不等於全部覆蓋"

# **還沒 archive 的 change 不算。** `spec/` 分支依設計不能加測試，所以連
# active change 的 delta 一起掃的話，第一個 spec PR 就會紅 ——
# 規格先行的流程會被自己的覆蓋閘門鎖死（外部審查指出、實測重現：
# 加一份 strict-valid、尚未實作的 change，rc=1）。
setup
mkdir -p "$W/repo/openspec/changes/demo-change/specs/demo"
printf '## ADDED Requirements\n\n### Requirement: 新的\n\n#### Scenario: [DEMO-02-S01] 還沒實作\n\n- **WHEN** a\n- **THEN** b\n' \
  > "$W/repo/openspec/changes/demo-change/specs/demo/spec.md"
FAKE_JSON="$(json_all_pass)"
run 0 "還沒 archive 的 change 不擋（否則 spec 先行流程鎖死）" "Scenario 覆蓋"

# **但 archive 之後就要擋。** archive 會把 delta 折進 openspec/specs/，
# 那一刻起它就是現況描述，必須有人驗它。
setup
printf '\n#### Scenario: [DEMO-01-S03] archive 之後的\n\n- **WHEN** a\n- **THEN** b\n' \
  >> "$W/repo/openspec/specs/demo/spec.md"
FAKE_JSON="$(json_all_pass)"
run 1 "進了 openspec/specs 就一定要有人驗它" "DEMO-01-S03"

# 已 archive 的 change 目錄不掃（它的內容已經折進 openspec/specs 了，
# 再掃一次就是同一條算兩遍）。
setup
mkdir -p "$W/repo/openspec/changes/archive/2026-01-01-old/specs/demo"
printf '#### Scenario: [DEMO-09-S01] 舊的\n\n- **WHEN** a\n- **THEN** b\n' \
  > "$W/repo/openspec/changes/archive/2026-01-01-old/specs/demo/spec.md"
FAKE_JSON="$(json_all_pass)"
run 0 "archive 目錄裡的舊 delta 不掃" "Scenario 覆蓋"

echo
printf '通過 %s / 失敗 %s / 共 %s\n' "$PASS" "$FAIL" "$((PASS + FAIL))"
if [ "$FAIL" -eq 0 ]; then
  rm -rf "$W"
else
  echo "測試目錄留著給你看：$W"
fi
[ "$FAIL" -eq 0 ]
