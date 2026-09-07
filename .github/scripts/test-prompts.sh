#!/usr/bin/env bash
# `prompts/` 自己的合約測試：提示檔教的操作，閘門收不收得下。
#
# 為什麼需要這一支（2026-09-07 外部架構審查實測）：
# `prompts/02-to-spec.md` 教人 `git switch -c feat/<change-name>` 去推第一份規格，
# 但 `feat/` 那條要求 proposal **已經在 main 上**，所以照著做一定被自己的閘門擋下來：
#
#     ✗ main 上沒有 openspec/changes/<id>/proposal.md。規格要先用 spec/<id> 開 PR 談定並合併。
#
# 那個錯誤在 repo 裡活了很久，因為**沒有任何東西在讀提示檔**。
# 分支閘的測試測的是閘，不是「文件有沒有教對」——
# 而新來的人（跟 AI）照的是文件。文件也要有讀者。
#
# 判準跟其他幾支一樣：**把修正改回去，這支要變紅。**
#   02 的分支改回 feat/            → T1／T6 紅
#   拿掉 gh pr create 的 --base main → T3 紅
#   03 的 npx openspec 改回裸指令    → T4 紅
#   03 的 git pull 拿掉 --ff-only    → T5 紅
#
# 零依賴：bash + git + 系統 python3。**不打網路**：origin 是本機 bare repo，
# `gh` 用只記錄參數的替身。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/.github/scripts/check-pr-branch.sh"
P02="$ROOT/prompts/02-to-spec.md"
P03="$ROOT/prompts/03-spec-review.md"
W="$(mktemp -d "${TMPDIR:-/tmp}/prompts-test.XXXXXXXX")"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; return 0; }

for f in "$P02" "$P03" "$GATE"; do
  [ -f "$f" ] || { echo "✗ 找不到 $f"; exit 1; }
done

# ── 抽出提示檔裡的 shell 區塊 ───────────────────────────────────────────────
# 只認 ```bash 圍籬。抽不到就直接失敗 —— 抽不到不等於「沒有問題」。
extract() { # extract <檔> > <shell 區塊全文>
  python3 - "$1" <<'EX'
import sys, re
t = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"(?ms)^```bash\n(.*?)^```", t)
if not blocks:
    sys.exit("NO_BASH_BLOCK")
sys.stdout.write("\n".join(blocks))
EX
}

B02="$(extract "$P02")" || { echo "✗ prompts/02 抽不到 \`\`\`bash 區塊"; exit 1; }
B03="$(extract "$P03")" || { echo "✗ prompts/03 抽不到 \`\`\`bash 區塊"; exit 1; }

echo "── prompts 合約 ──"

# ── T1：02 的第一份規格走 spec/，不是 feat/ ────────────────────────────────
SW02="$(printf '%s\n' "$B02" | grep -oE 'git switch -c [a-z]+/' | head -1 | awk '{print $4}')"
[ "$SW02" = "spec/" ] && ok "02 開的是 spec/ 分支" || bad "02 開的是 spec/ 分支" "實際：${SW02:-（抽不到 git switch -c）}"

# ── T2：push 目標跟開的分支是同一個 ────────────────────────────────────────
PU02="$(printf '%s\n' "$B02" | grep -oE 'git push -u origin [a-z]+/' | head -1 | awk '{print $5}')"
[ -n "$SW02" ] && [ "$PU02" = "$SW02" ] \
  && ok "02 的 push 目標跟開的分支一致" \
  || bad "02 的 push 目標跟開的分支一致" "switch=${SW02:-?} push=${PU02:-?}"

# ── T3：gh pr create 明帶 --base main ──────────────────────────────────────
printf '%s\n' "$B02" | grep -q -- '--base main' \
  && ok "02 的 gh pr create 帶 --base main" \
  || bad "02 的 gh pr create 帶 --base main" "分支閘只接受 base=main，不明寫會依賴預設分支設定"

# ── T4：提示檔裡的 openspec 一律是 npx openspec ────────────────────────────
# 裸 openspec 解析到的是全域那份，不是 lockfile 鎖住的版本（README 有一整節）。
BARE="$(printf '%s\n%s\n' "$B02" "$B03" | grep -nE '(^|[;&|(]|\s)openspec\s' | grep -v 'npx openspec' || true)"
[ -z "$BARE" ] && ok "提示檔裡沒有裸 openspec 指令" || bad "提示檔裡沒有裸 openspec 指令" "$BARE"

# ── T5：更新 main 用 --ff-only（別在本機生出 merge commit）─────────────────
printf '%s\n' "$B03" | grep -q 'git pull --ff-only' \
  && ok "03 更新 main 用 git pull --ff-only" \
  || bad "03 更新 main 用 git pull --ff-only"

# ── T6：所有 git switch -c 的前綴都在閘門的封閉列舉裡 ─────────────────────
# 閘門的分類是封閉列舉，沒列到的一律擋。提示檔教一個列舉外的前綴＝教人撞牆。
PREFIXES="$(printf '%s\n%s\n' "$B02" "$B03" | grep -oE 'git switch -c [a-z]+/' | awk '{print $4}' | tr -d '/' | sort -u)"
[ -n "$PREFIXES" ] || bad "抽得到 git switch -c 的前綴"
for pfx in $PREFIXES; do
  if grep -qE "^  ${pfx}/\*[|)]" "$GATE"; then
    ok "前綴 ${pfx}/ 在閘門的封閉列舉裡"
  else
    bad "前綴 ${pfx}/ 在閘門的封閉列舉裡" "check-pr-branch.sh 的 case 沒有這一類"
  fi
done

# ── T7：真的跑一次 —— 照 02 開分支，閘門要收 ──────────────────────────────
# origin 是本機 bare repo（不打網路）；gh 用只記錄參數的替身。
CID="prompt-contract"
git init -q --bare "$W/origin.git"
git clone -q "$W/origin.git" "$W/repo" 2>/dev/null
mkdir -p "$W/bin"
cat > "$W/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
STUB
chmod +x "$W/bin/gh"

(
  cd "$W/repo" || exit 1
  git config user.email t@t; git config user.name t
  ln -s "$ROOT/node_modules" node_modules 2>/dev/null
  echo node_modules >> .git/info/exclude
  # 先做出一個「已經初始化好的專案」的 main
  git archive --remote="$ROOT" HEAD 2>/dev/null | tar -x 2>/dev/null || \
    { cp -R "$ROOT/openspec" . 2>/dev/null; cp -R "$ROOT/.github" . 2>/dev/null; }
  git add -A >/dev/null 2>&1; git commit -qm base; git branch -M main
  git push -q origin main 2>/dev/null

  # 造出 /opsx:propose 會產生的東西（提示檔的 git 區塊假設它已經在）
  mkdir -p "openspec/changes/$CID/specs/demo"
  printf 'schema: spec-driven\n' > "openspec/changes/$CID/.openspec.yaml"
  printf '## Why\n合約測試。\n\n## What Changes\n- 一條\n\n## Non-goals\n- 無\n' > "openspec/changes/$CID/proposal.md"
  printf '## ADDED Requirements\n\n### Requirement: 合約\n系統 SHALL 做某事，並在不合法時回錯誤。\n\n#### Scenario: [PC-01-S01] 正常\n- **WHEN** 觸發\n- **THEN** 成功\n\n#### Scenario: [PC-01-S02] 不合法\n- **WHEN** 不合法\n- **THEN** 回錯誤\n' > "openspec/changes/$CID/specs/demo/spec.md"

  # 把 02 的區塊裡的 placeholder 換成真的 id，然後照跑
  export PATH="$W/bin:$PATH" GH_LOG="$W/gh.log"
  printf '%s\n' "$B02" | sed "s/<change-name>/$CID/g" > "$W/block02.sh"
  bash "$W/block02.sh"
) >"$W/run02.log" 2>&1
RC02=$?

BR="$(cd "$W/repo" && git branch --show-current 2>/dev/null || true)"
[ "$BR" = "spec/$CID" ] \
  && ok "照 02 跑完，人在 spec/<id> 分支上" \
  || bad "照 02 跑完，人在 spec/<id> 分支上" "實際分支：${BR:-?}（rc=$RC02，log: $W/run02.log）"

grep -q -- "--base main" "$W/gh.log" 2>/dev/null \
  && ok "gh pr create 真的收到 --base main" \
  || bad "gh pr create 真的收到 --base main" "gh 替身收到：$(cat "$W/gh.log" 2>/dev/null || echo 無)"

# 最後一步才是重點：閘門收不收這個分支
if [ -n "$BR" ]; then
  ( cd "$W/repo" && bash "$GATE" main "$BR" ) >"$W/gate.out" 2>&1
  GRC=$?
  [ "$GRC" = "0" ] \
    && ok "閘門接受 02 教出來的分支（rc=0）" \
    || bad "閘門接受 02 教出來的分支（rc=0）" "rc=$GRC：$(head -3 "$W/gate.out" | tr '\n' ' ')"
fi

echo
printf '通過 %s / 失敗 %s / 共 %s\n' "$PASS" "$FAIL" "$((PASS+FAIL))"
echo "測試目錄：$W"
[ "$FAIL" -eq 0 ]
