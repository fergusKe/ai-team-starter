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
  mkdir -p "$W/repo/openspec/specs/demo" "$W/repo/bin" "$W/tmp"
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
python3 - "$W/repo/openspec/specs/demo/spec.md" <<'PY'
import io, sys
p = sys.argv[1]
t = io.open(p, encoding="utf-8").read()
t = t.replace("#### Scenario: [DEMO-01-S02] 第二條\n\n- **WHEN** a\n- **THEN** b",
              "#### Scenario: [DEMO-01-S02] 第二條\n\n- **WHEN** a\n- **THEN** b\n"
              "- **VERIFY-BY** `manual-browser`｜PR #1 的截圖｜這條要真的畫面才驗得到")
io.open(p, "w", encoding="utf-8").write(t)
PY
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 0 "有 VERIFY-BY 豁免就算過" "豁免"

# 列舉裡的每一種都要真的被接受（陽性對照 —— 少了它，把某一種從列舉裡刪掉
# 不會有任何測試變紅）。
setup
add_verify '- **VERIFY-BY** `ci-job`｜ci.yml 的四個步驟｜CI 的 job 本身就是這條的執行'
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 0 "ci-job 也是認得的豁免種類" "ci-job"

# 種類是封閉列舉 —— 打錯字的豁免等於沒有豁免，但它看起來跟真的一模一樣。
setup
add_verify '- **VERIFY-BY** `眼睛看過了`｜PR #1｜這條要真的畫面才驗得到'
FAKE_JSON="$(json_all_pass)"
run 1 "不認得的豁免種類要紅" "不在列舉裡"

setup
add_verify '- **VERIFY-BY** `manual-browser`｜PR #1｜TBD'
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

# **過期的豁免要拿掉。** 測試補上了、豁免還留著，那張免死金牌會一直有效。
setup
add_verify '- **VERIFY-BY** `manual-browser`｜PR #1｜這條要真的畫面才驗得到'
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

# **掃不到不等於全部覆蓋。** 目錄搬走、正規表示式寫壞，差集都會變成空的。
setup
rm -rf "$W/repo/openspec/specs"
FAKE_JSON="$(json_all_pass)"
run 1 "一份規格檔都沒掃到要紅" "掃不到不等於全部覆蓋"

# change 裡的 spec 也要算 —— 只掃 main 的話，缺口要等到 archive 才會出現，
# 而那時候實作早就合併了。
# **ID 文法要跟分支閘門同一份。** 寬鬆成 `[A-Z0-9-]+` 的話，`[BAD]` 配上一條
# 標題含 `[BAD]` 的通過測試就 rc=0 全綠 —— 一個分支閘門會擋下來的 ID，
# 在這裡卻算數。（外部審查實測的反例。）
setup
printf '\n#### Scenario: [BAD] 不合法的 ID\n\n- **WHEN** a\n- **THEN** b\n' \
  >> "$W/repo/openspec/specs/demo/spec.md"
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]},
  {"title":"[DEMO-01-S02] 第二條","status":"passed","ancestorTitles":["demo"]},
  {"title":"[BAD] 不合法","status":"passed","ancestorTitles":["demo"]}]}]}'
run 1 "不合文法的 Scenario ID 要紅（不可以當成不存在）" "不合文法"

# **豁免不可以跨出它的 Scenario。** 遇到 `### Requirement:` 之類的標題就
# 結束範圍 —— 原本只在下一條 `#### Scenario:` 才換，於是寫在別的段落底下的
# VERIFY-BY 會被算成上一條的豁免。（外部審查實測的反例。）
setup
printf '\n### Requirement: 另一個需求\n\n- **VERIFY-BY** `manual-browser`｜PR #1｜這條要真的畫面才驗得到\n' \
  >> "$W/repo/openspec/specs/demo/spec.md"
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 1 "豁免寫在別的段落底下不算（孤兒）" "孤兒豁免"

# 同一條有兩份豁免 —— 哪一份算數沒有唯一答案，不可以挑一個。
setup
add_verify '- **VERIFY-BY** `manual-browser`｜PR #1｜這條要真的畫面才驗得到'
add_verify '- **VERIFY-BY** `playwright`｜PR #2｜另外一個理由寫在這裡'
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 1 "同一條有兩份豁免要紅" "不只一條"

# 理由的長度門檻要真的擋得住 —— 降到 4 個字的話 `尚未確認` 就過關了。
setup
add_verify '- **VERIFY-BY** `manual-browser`｜PR #1｜尚未確認'
FAKE_JSON="$(json_all_pass)"
run 1 "四個字的理由不算實質理由" "沒有寫出實質理由"

# **VERIFY-BY 要在行首的列表項上。** 放寬成「一行裡任何位置出現」的話，
# 散文或程式碼區塊裡提到這個字串就會變成一張真的免死金牌。
setup
printf '\n這一段散文提到 - **VERIFY-BY** `manual-browser`｜PR #1｜只是在講解用法而已\n' \
  >> "$W/repo/openspec/specs/demo/spec.md"
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 1 "散文裡提到 VERIFY-BY 不算豁免" "DEMO-01-S02"

# **每一個測試檔的結果都要走。** vitest 一個檔案就是一個 testResults 條目，
# 只讀第一個的話，第二個檔案以後的覆蓋全部消失。
setup
FAKE_JSON='{"testResults":[
  {"assertionResults":[{"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["a"]}]},
  {"assertionResults":[{"title":"[DEMO-01-S02] 第二條","status":"passed","ancestorTitles":["b"]}]}]}'
run 0 "第二個測試檔的覆蓋也要算" "Scenario 覆蓋"

setup
mkdir -p "$W/repo/openspec/changes/demo-change/specs/demo"
printf '#### Scenario: [DEMO-02-S01] change 裡的\n\n- **WHEN** a\n- **THEN** b\n' \
  > "$W/repo/openspec/changes/demo-change/specs/demo/spec.md"
FAKE_JSON="$(json_all_pass)"
run 1 "change 裡的 spec 也要納入檢查" "DEMO-02-S01"

echo
printf '通過 %s / 失敗 %s / 共 %s\n' "$PASS" "$FAIL" "$((PASS + FAIL))"
if [ "$FAIL" -eq 0 ]; then
  rm -rf "$W"
else
  echo "測試目錄留著給你看：$W"
fi
[ "$FAIL" -eq 0 ]
