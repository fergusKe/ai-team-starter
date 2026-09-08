#!/usr/bin/env bash
# check-scenario-coverage.sh 的測試。
#
#     bash .github/scripts/test-scenario-coverage.sh
#
# 那支是**報告**不是閘門，所以這裡測的不是「違規會不會紅」，而是兩件事：
#
#   1. **有缺口的時候它要說得出是哪幾條**（報錯的尺跟沒有尺一樣糟）。
#   2. **量不到的時候它要回 2，不可以裝作沒有缺口**（`0` 只能代表「量到了」）。
#
# `npx` 用只吐固定 JSON 的替身 —— 不跑真的測試（那要幾十秒，而且會讓這支
# 測試的結果取決於別的東西）。替身只攔 `vitest` 與 `openspec`，其他照舊。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/.github/scripts/check-scenario-coverage.sh"
[ -f "$GATE" ] || { echo "✗ 找不到 $GATE"; exit 1; }

W="$(mktemp -d "${TMPDIR:-/tmp}/scen-cov-test.XXXXXXXX")"
PASS=0
FAIL=0
bump_fail() { FAIL=$((FAIL + 1)); }

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
  cat > "$W/repo/bin/npx" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "openspec" ]; then
  if [ -n "${FAKE_SPECS_EMPTY:-}" ]; then printf '{"specs":[]}'; else printf '{"specs":[{"id":"demo"}]}'; fi
  exit 0
fi
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

# run <期望退出碼> <說明> <訊息要有> [訊息不可以有]
run() {
  local want="$1" desc="$2" needle="$3" anti="${4:-}" out rc
  # TMPDIR 指到自己的工作目錄 —— 量不到的案例會保留現場，不要留在系統的 TMPDIR。
  out="$(cd "$W/repo" && PATH="$W/repo/bin:$PATH" TMPDIR="$W/tmp" \
         FAKE_JSON="${FAKE_JSON:-}" FAKE_RC="${FAKE_RC:-0}" \
         FAKE_SPECS_EMPTY="${FAKE_SPECS_EMPTY:-}" bash "$GATE" 2>&1)"; rc=$?
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
  if [ -n "$anti" ] && printf '%s' "$out" | grep -q -- "$anti"; then
    echo "✗ ${desc} —— 訊息裡不該出現「${anti}」"
    echo "$out" | sed 's/^/      /' | head -12
    bump_fail; return
  fi
  echo "✓ $desc"; PASS=$((PASS + 1))
}

echo "check-scenario-coverage.sh 的測試"
echo

# ── 自測：run 真的會判紅嗎 ─────────────────────────────────────────
# **少了這一條，下面每一條都可能是假的綠燈。**
_before=$FAIL
FAKE_JSON="$(json_all_pass)"; FAKE_RC=0; setup
run 2 "自測（不計入）" "" "" >/dev/null 2>&1
if [ "$FAIL" -eq "$((_before + 1))" ]; then
  FAIL=$_before; echo "✓ run 自測：失敗真的會被計進 \$FAIL"; PASS=$((PASS + 1))
else
  FAIL=$((_before + 1)); echo "✗ run 自測：失敗沒有被計進 \$FAIL —— 這支測試的綠燈是假的"
fi

echo
echo "── 缺口要點得出來 ──"
FAKE_JSON="$(json_all_pass)"; FAKE_RC=0; setup
run 0 "兩條都有通過的測試：0 條缺口" "2 條有通過的測試指著它，0 條沒有"

setup
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 0 "少一條要點名，但不擋（rc=0）" "DEMO-01-S02"

# **skipped 不算覆蓋。** 這是「出現這個 ID」與「真的被驗了」之間最常見的差。
setup
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]},
  {"title":"[DEMO-01-S02] 第二條","status":"skipped","ancestorTitles":["demo"]}]}]}'
run 0 "skipped 不算覆蓋" "DEMO-01-S02"

setup
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]},
  {"title":"[DEMO-01-S02] 第二條","status":"failed","ancestorTitles":["demo"]}]}]}'
run 0 "failed 不算覆蓋" "DEMO-01-S02"

# **ID 寫在 describe 上不算。** 那個 describe 底下每一條都會沾到它，
# 包括被 skip 的那些。
setup
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"第一條","status":"passed","ancestorTitles":["[DEMO-01-S01] 群組"]},
  {"title":"第二條","status":"passed","ancestorTitles":["[DEMO-01-S02] 群組"]}]}]}'
run 0 "ID 只寫在 describe 上不算覆蓋" "DEMO-01-S01"

# 人寫的驗證方式註記：原文照印，讓看報告的人知道這條是刻意人工驗的。
setup
printf '\n- **VERIFY-BY** 人工瀏覽器｜PR #37 的截圖｜WebGL 像素 jsdom 證不了\n' \
  >> "$W/repo/openspec/specs/demo/spec.md"
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"[DEMO-01-S01] 第一條","status":"passed","ancestorTitles":["demo"]}]}]}'
run 0 "缺口帶著人寫的註記一起印出來" "註記：人工瀏覽器"

# **任何標題都結束前一條 Scenario 的範圍。** 寫在 `### Requirement:` 底下的
# 註記不屬於上一條 Scenario —— 那條已經結束了。掛錯人的註記會讓看報告的人
# 以為某條已經有人工驗過。
setup
cat > "$W/repo/openspec/specs/demo/spec.md" <<'SPEC'
# demo

### Requirement: 甲

#### Scenario: [DEMO-01-S01] 第一條

- **WHEN** a

### Requirement: 乙

- **VERIFY-BY** 這行屬於 Requirement 乙，不屬於 S01

#### Scenario: [DEMO-01-S02] 第二條

- **WHEN** a
SPEC
FAKE_JSON='{"testResults":[{"assertionResults":[
  {"title":"別的","status":"passed","ancestorTitles":["demo"]}]}]}'
run 0 "寫在 Requirement 底下的註記不會掛到上一條 Scenario" "DEMO-01-S01" "註記："

echo
echo "── 量不到要回 2，不可以裝作沒有缺口 ──"
setup
FAKE_JSON="$(json_all_pass)"; FAKE_RC=1
run 2 "測試沒綠：回 2" "先把測試修綠"
FAKE_RC=0

setup
FAKE_JSON='{"nope":1}'
run 2 "報告沒有 testResults：回 2" "格式變了"

setup
FAKE_JSON='{"testResults":[]}'
run 2 "報告裡一條測試結果都沒有：回 2" "真的跑到測試了嗎"

setup
rm -rf "$W/repo/openspec/specs"
FAKE_JSON="$(json_all_pass)"
run 2 "一份規格檔都掃不到：回 2" "掃不到不等於沒有缺口"

setup
printf '# demo\n\n沒有任何 Scenario\n' > "$W/repo/openspec/specs/demo/spec.md"
FAKE_JSON="$(json_all_pass)"
run 2 "掃到檔案卻一條 Scenario 都沒有：回 2" "標題文法變了嗎"

echo
echo "── 範圍 ──"
# 零份現況 spec 是合法狀態（剛從模板複製的專案），不是錯誤。
setup
FAKE_SPECS_EMPTY=1
FAKE_JSON="$(json_all_pass)"
run 0 "還沒有任何現況 spec：安全地回 0" "沒有東西可以看"
FAKE_SPECS_EMPTY=

# 已 archive 的 change 目錄不掃（內容已折進 openspec/specs，再掃就是算兩遍）；
# 還沒 archive 的 change 也不掃（否則規格先行的流程會被自己鎖死）。
setup
mkdir -p "$W/repo/openspec/changes/archive/2026-01-01-old/specs/demo" \
         "$W/repo/openspec/changes/new/specs/demo"
printf '#### Scenario: [DEMO-09-S01] 舊的\n\n- **WHEN** a\n- **THEN** b\n' \
  > "$W/repo/openspec/changes/archive/2026-01-01-old/specs/demo/spec.md"
printf '#### Scenario: [DEMO-08-S01] 還沒 archive 的\n\n- **WHEN** a\n- **THEN** b\n' \
  > "$W/repo/openspec/changes/new/specs/demo/spec.md"
FAKE_JSON="$(json_all_pass)"
run 0 "只看 openspec/specs，changes 底下的都不掃" "0 條沒有" "DEMO-0"

echo
printf '通過 %s / 失敗 %s / 共 %s\n' "$PASS" "$FAIL" "$((PASS + FAIL))"
if [ "$FAIL" -eq 0 ]; then
  rm -rf "$W"
else
  echo "測試目錄留著給你看：$W"
fi
[ "$FAIL" -eq 0 ]
