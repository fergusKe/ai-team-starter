#!/usr/bin/env bash
# arch-view.sh 的測試。
#
#     bash .github/scripts/test-arch-view.sh
#
# 那支是**報告**不是閘門，所以這裡測的是：
#
#   1. 每一種它宣稱抓得到的反例，它真的說得出是哪一條（退出碼 1）。
#   2. 量不到的時候回 2，不可以裝作沒有問題。
#   3. 乾淨的輸入回 0，而且頁面產得出來。
#
# 每一個 case 都用全新的假 repo；不碰真的 openspec/。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOL="$ROOT/.github/scripts/arch-view.sh"
[ -f "$TOOL" ] || { echo "✗ 找不到 $TOOL"; exit 1; }

# mktemp 失敗（唯讀沙箱、TMPDIR 不存在）要**立刻停**：沒有 set -e，放過去的話 W 是空字串，
# setup 會對 "/repo" 做刪除與 mkdir —— codex 2026-09-12 在唯讀沙箱裡實際踩到。
W="$(mktemp -d "${TMPDIR:-/tmp}/arch-view-test.XXXXXXXX")" || { echo "✗ mktemp 失敗，量不到"; exit 2; }
[ -n "$W" ] && [ -d "$W" ] || { echo "✗ 暫存目錄不對：'${W}'"; exit 2; }
PASS=0
FAIL=0

# 一個「什麼都對」的假 repo：兩個 capability 互相引用、一份 design 有兩條決策、
# 一份 ADR 標了狀態與證據。每個 case 從這裡出發，再壞掉一件事。
setup() {
  rm -rf "${W:?}/repo"
  mkdir -p "$W/repo/openspec/specs/cap-alpha" "$W/repo/openspec/specs/cap-beta" \
           "$W/repo/openspec/changes/archive/2026-01-01-c1" \
           "$W/repo/openspec/changes/c2" \
           "$W/repo/docs/adr" "$W/repo/tests"
  ( cd "$W/repo" && git init -q \
    && git -c user.email=t@t.invalid -c user.name=t commit -q --allow-empty -m x )
  cat > "$W/repo/openspec/specs/cap-alpha/spec.md" <<'SPEC'
# cap-alpha Specification

## Purpose
cap-alpha 存在是因為 `cap-beta` 需要它。

## Requirements

### Requirement: 一

#### Scenario: [A-01-S01] 例

- **WHEN** 用 `data-testid` 找
- **THEN** 找得到
SPEC
  cat > "$W/repo/openspec/specs/cap-beta/spec.md" <<'SPEC'
# cap-beta Specification

## Purpose
cap-beta 是下游。

## Requirements

### Requirement: 一

它把值交給 `cap-alpha`。

#### Scenario: [B-01-S01] 例

- **WHEN** a
- **THEN** b
SPEC
  cat > "$W/repo/openspec/changes/archive/2026-01-01-c1/design.md" <<'DESIGN'
# c1 design

## D1｜第一條決策

理由。

## D2 第二條決策

理由。

### D2 補記：實作之後多知道的事

### D2b —— 編號帶字母的
DESIGN
  cat > "$W/repo/openspec/changes/c2/design.md" <<'DESIGN'
# c2 design

## D1：取代 c1 的第二條

- **Supersedes**: c1/D2
DESIGN
  cat > "$W/repo/docs/adr/0001-example.md" <<'ADR'
# 0001. 範例邊界

- **Status**: Accepted
- **Date**: 2026-01-01
- **邊界狀態**: 已強制
- **證據**: tests/example.test.ts
ADR
  printf 'test("x", () => {})\n' > "$W/repo/tests/example.test.ts"
}

# 取代檔案裡的一段字。不用 sed -i —— macOS 與 GNU 的 -i 語法不同，CI 是 linux。
rep() { python3 -c 'import sys,io
p,a,b=sys.argv[1:]; s=io.open(p,encoding="utf-8").read()
assert a in s, f"fixture 裡沒有 {a!r}"
io.open(p,"w",encoding="utf-8").write(s.replace(a,b))' "$1" "$2" "$3"; }

# run <期望退出碼> <case 名> [<stdout 必須含的字串>...]
run() {
  local want="$1" name="$2"; shift 2
  local out rc
  out="$(cd "$W/repo" && bash "$TOOL" 2>&1)"; rc=$?
  local ok=1
  [ "$rc" = "$want" ] || ok=0
  for s in "$@"; do printf '%s' "$out" | grep -qF -- "$s" || ok=0; done
  if [ "$ok" = 1 ]; then
    PASS=$((PASS + 1)); echo "  ✓ $name"
  else
    FAIL=$((FAIL + 1)); echo "  ✗ ${name}（期望 rc=${want} 實際 rc=${rc}）"
    printf '%s\n' "$out" | sed 's/^/      /'
  fi
}

echo "arch-view.sh"

setup
run 0 "乾淨的輸入回 0，而且列得出引用與決策" \
  "cap-alpha" "cap-beta" "→ cap-beta" "← cap-alpha" "設計決策：4 條"

setup
( cd "$W/repo" && out="$(bash "$TOOL" --decisions 2>&1)" && printf '%s' "$out" | grep -qF "c1 · D1 · 第一條決策" \
  && printf '%s' "$out" | grep -qF "c1 · D2 · 第二條決策（已被取代）" && printf '%s' "$out" | grep -qF "取代 c1/D2" ) \
  && { PASS=$((PASS + 1)); echo "  ✓ --decisions 列得出三種分隔符的決策，被取代的有標"; } \
  || { FAIL=$((FAIL + 1)); echo "  ✗ --decisions 輸出不對"; }
( cd "$W/repo" && bash "$TOOL" --decisions 2>&1 | grep -qF "補記：實作之後多知道的事" ) \
  && { PASS=$((PASS + 1)); echo "  ✓ 同編號的「補記」掛在原決策底下，不算重複"; } \
  || { FAIL=$((FAIL + 1)); echo "  ✗ 補記沒掛上或被當成重複"; }

setup
printf '\n## D1｜同一個編號又出現一次\n' >> "$W/repo/openspec/changes/c2/design.md"
run 1 "同一份檔同一個編號出現兩次（不是補記）→ 1" "c2/D1 出現不只一次"

setup
( cd "$W/repo" && bash "$TOOL" --decisions 第一 2>&1 | grep -qF "1 條（過濾：第一），共 4 條" ) \
  && { PASS=$((PASS + 1)); echo "  ✓ --decisions 關鍵字過濾"; } \
  || { FAIL=$((FAIL + 1)); echo "  ✗ --decisions 關鍵字過濾不對"; }

setup
rep "$W/repo/openspec/specs/cap-alpha/spec.md" '`cap-beta` 需要它' '`cap-gamma` 需要它'
run 1 "Purpose 引用不存在的 capability → 1，而且說出是哪一個" \
  "cap-gamma" "cap-alpha/spec.md"

setup
run 0 "Requirement 內文裡的非 capability 名稱（data-testid）不當懸空引用" "cap-alpha"
( cd "$W/repo" && bash "$TOOL" 2>&1 | grep -qF "data-testid" ) \
  && { FAIL=$((FAIL + 1)); echo "  ✗ data-testid 被當成引用報出來了"; } \
  || { PASS=$((PASS + 1)); echo "  ✓ data-testid 沒被報"; }

setup
printf '\n## D3\n' >> "$W/repo/openspec/changes/c2/design.md"
run 1 "疑似決策標題但沒有標題文字 → 1，不安靜略過" "D3" "c2/design.md"

setup
rep "$W/repo/openspec/changes/c2/design.md" 'c1/D2' 'c1/D9'
run 1 "Supersedes 指向不存在的決策 → 1" "c1/D9"

setup
rep "$W/repo/openspec/changes/archive/2026-01-01-c1/design.md" '理由。

### D2 補記' '理由。

- **Supersedes**: c2/D1

### D2 補記'
run 1 "Supersedes 形成循環 → 1" "循環"

setup
rep "$W/repo/docs/adr/0001-example.md" 'tests/example.test.ts' 'tests/nope.test.ts'
run 1 "ADR 證據路徑不存在 → 1" "tests/nope.test.ts"

setup
rep "$W/repo/docs/adr/0001-example.md" 'tests/example.test.ts' 'docs/adr/0001-example.md'
run 1 "「已強制」的證據指向文件而不是測試 → 1" "已強制" "0001"

setup
rep "$W/repo/docs/adr/0001-example.md" '已強制' '大概吧'
run 1 "邊界狀態不是三種之一 → 1" "大概吧"

setup
rep "$W/repo/docs/adr/0001-example.md" '已強制' '僅約定'
rep "$W/repo/docs/adr/0001-example.md" 'tests/example.test.ts' 'openspec/specs/cap-alpha/spec.md'
run 0 "「僅約定」可以只連 spec" "僅約定"

setup
rm -rf "$W/repo/openspec/specs"
run 2 "沒有 openspec/specs/ → 2（量不到不等於沒問題）"

setup
( cd "$W/repo/openspec/specs" && mv cap-alpha/spec.md cap-alpha/README.md && mv cap-beta/spec.md cap-beta/README.md )
run 2 "openspec/specs/ 存在但一份 spec.md 都沒有 → 2"

# ── 以下是 codex 2026-09-12 對抗審查列出的「靜態可證存活突變」，每一條配一個 case ──

setup
rep "$W/repo/docs/adr/0001-example.md" 'tests/example.test.ts' 'tests/'
run 1 "「已強制」的證據是 tests/ 目錄不是檔案 → 1（目錄冒充不了測試）" "tests/"

setup
rep "$W/repo/docs/adr/0001-example.md" 'tests/example.test.ts' 'docs/adr/0001-example.md、openspec/specs/cap-alpha/spec.md'
run 1 "「已強制」兩條證據都是文件 → 1（不是只看第一條或只在剛好一條時檢查）" "已強制"

setup
rep "$W/repo/docs/adr/0001-example.md" 'tests/example.test.ts' 'tests/example.test.ts、tests/nope.test.ts'
run 1 "兩條證據裡第二條不存在 → 1" "tests/nope.test.ts"

setup
rep "$W/repo/docs/adr/0001-example.md" '- **證據**: tests/example.test.ts
' ''
run 1 "標了邊界狀態卻沒有證據欄 → 1" "沒有 **證據**"

setup
mkdir -p "$W/repo/openspec/specs/cap-gamma"
run 1 "某個 capability 目錄沒有 spec.md（其他都有）→ 1" "cap-gamma/ 沒有 spec.md"

setup
rep "$W/repo/openspec/specs/cap-alpha/spec.md" 'cap-alpha 存在是因為 `cap-beta` 需要它。' 'cap-alpha 存在是因為 `cap-beta` 需要它。
第二行提到 `cap-delta`。'
run 1 "Purpose 第二行的懸空引用也要抓 → 1" "cap-delta" "spec.md:5"

setup
printf '\n### D4\n\n## D5｜｜\n' >> "$W/repo/openspec/changes/c2/design.md"
run 1 "### 層無標題、以及只有分隔符的標題 → 都報" "D4" "D5"

setup
printf '\n## D1｜archive 裡同一個編號又出現\n' >> "$W/repo/openspec/changes/archive/2026-01-01-c1/design.md"
run 1 "archive 裡的重複也要報 → 1" "c1/D1 出現不只一次"

setup
rep "$W/repo/openspec/changes/c2/design.md" 'c1/D2' 'ghost/D2'
run 1 "Supersedes 的 change id 不存在（即使別的 change 有 D2）→ 1" "ghost/D2"

setup
printf '\n## D3｜三節點循環的第三個\n\n- **Supersedes**: c1/D1\n' >> "$W/repo/openspec/changes/c2/design.md"
rep "$W/repo/openspec/changes/archive/2026-01-01-c1/design.md" '## D1｜第一條決策

理由。' '## D1｜第一條決策

- **Supersedes**: c2/D3

理由。'
rep "$W/repo/openspec/changes/c2/design.md" '- **Supersedes**: c1/D2' '- **Supersedes**: c1/D1'
run 1 "三節點的 Supersedes 循環 → 1" "循環"

setup
printf '\n### D7 補記：沒有 D7 的補記\n' >> "$W/repo/openspec/changes/c2/design.md"
run 1 "沒有原決策的「補記」→ 1，不是安靜變成一條新決策" "D7" "補記"

setup
( cd "$W/repo" && out="$(bash "$TOOL" --json 2>/dev/null)" && printf '%s' "$out" | python3 -c '
import json,sys; d=json.load(sys.stdin)
assert "cap-alpha" in d["capabilities"] and d["capabilities"]["cap-alpha"]["refs"]==["cap-beta"], d["capabilities"]
assert len(d["decisions"])==4 and d["findings"]==[] and d["adrs"][0]["state"]=="已強制", (len(d["decisions"]), d["findings"], d["adrs"])' ) \
  && { PASS=$((PASS + 1)); echo "  ✓ --json 的內容跟文字模式一致（引用、決策數、ADR 狀態、findings）"; } \
  || { FAIL=$((FAIL + 1)); echo "  ✗ --json 內容不對"; }

setup
rm -rf "${W:?}/repo/openspec/specs"
( cd "$W/repo" && bash "$TOOL" --json >/dev/null 2>&1; [ $? = 2 ] ) && ( cd "$W/repo" && bash "$TOOL" --html >/dev/null 2>&1; [ $? = 2 ] ) \
  && { PASS=$((PASS + 1)); echo "  ✓ --json／--html 量不到時一樣回 2"; } \
  || { FAIL=$((FAIL + 1)); echo "  ✗ --json 或 --html 在沒有 specs 時沒有回 2"; }

setup
( cd "$W/repo" && bash "$TOOL" --html >/dev/null 2>&1 && [ -s docs/arch.html ] \
  && grep -qF "cap-alpha" docs/arch.html && grep -qF "c2 · D1" docs/arch.html ) \
  && { PASS=$((PASS + 1)); echo "  ✓ --html 產出 docs/arch.html，內容有 capability 與決策"; } \
  || { FAIL=$((FAIL + 1)); echo "  ✗ --html 沒有產出或內容不對"; }

# 空殼檢查：真的 repo 的 .gitignore 要擋掉產物。
if grep -qxF "docs/arch.html" "$ROOT/.gitignore"; then
  PASS=$((PASS + 1)); echo "  ✓ docs/arch.html 在 .gitignore 裡"
else
  FAIL=$((FAIL + 1)); echo "  ✗ docs/arch.html 不在 .gitignore 裡 —— 產物會被 commit 進去然後漂"
fi

rm -rf "${W:?}"
echo
echo "通過 ${PASS}，失敗 ${FAIL}"
[ "$FAIL" = 0 ]
