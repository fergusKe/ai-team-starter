#!/usr/bin/env bash
# check-pr-branch.sh 的測試檯。
#
#     bash .github/scripts/test-check-pr-branch.sh
#
# **改閘門之前先跑一次，改完再跑一次。** 那支腳本是執法層本體 ——
# 調 CHORE_MAX_BYTES、加一個分類、動一條 regex，都可能在別的地方開一個洞，
# 而洞是安靜的：它不會讓任何東西變紅，只會讓本來該紅的東西變綠。
#
# 每個案例 clone 一份乾淨的 baseline，避免案例之間互相污染。
# （踩過：分支名重複用的時候 `git checkout -b` 會失敗，測試就把檔案
#  commit 到 baseline 上，後面每個案例都被污染。）

set -uo pipefail

REPO="$(git rev-parse --show-toplevel)"
GATE="$REPO/.github/scripts/check-pr-branch.sh"
ROOT="$(mktemp -d -t gate-test)"
BASELINE="$ROOT/_baseline"
PASS=0; FAIL=0; N=0

[ -f "$GATE" ] || { echo "找不到 $GATE" >&2; exit 2; }

mkdir -p "$BASELINE"
# 用 HEAD 而不是某個寫死的分支名 —— 這樣在任何分支上都能跑。
git -C "$REPO" archive HEAD | tar -x -C "$BASELINE"
cd "$BASELINE"
git init -q && git config user.email t@t && git config user.name t

# main 上先放一個「已經談定並合併」的 change，模擬實作階段的前提。
mkdir -p openspec/changes/demo-change/specs/demo
cat > openspec/changes/demo-change/proposal.md <<'EOF'
## Why
測試檯用的既有 change。

## What Changes
- 示範

## Non-goals
- 無
EOF
printf '## 1. 規格\n- [x] 1.1 談定\n- [x] 1.2 實作\n' > openspec/changes/demo-change/tasks.md
cat > openspec/changes/demo-change/specs/demo/spec.md <<'EOF'
## ADDED Requirements

### Requirement: 示範需求
系統 SHALL 提供示範行為，並在輸入不合法時回錯誤。

#### Scenario: [DEMO-01-S01] 正常路徑
- **WHEN** 使用者觸發示範
- **THEN** 系統回應成功

#### Scenario: [DEMO-01-S02] 輸入不合法
- **WHEN** 輸入不合法
- **THEN** 系統回應錯誤
EOF
git add -A && git commit -qm base && git branch -M main

run() { # run <期望exit> <base> <分支> <說明> <造檔案的指令...>
  local want="$1" base="$2" br="$3" desc="$4"; shift 4
  N=$((N+1))
  local W="$ROOT/c$N"
  git clone -q "$BASELINE" "$W" 2>/dev/null
  echo node_modules >> "$W/.git/info/exclude"
  ln -s "$REPO/node_modules" "$W/node_modules" 2>/dev/null
  ( cd "$W" && git config user.email t@t && git config user.name t \
    && git checkout -qb "$br" && "$@" >/dev/null 2>&1
    git add -A >/dev/null 2>&1; git commit -qm x >/dev/null 2>&1 )
  ( cd "$W" && bash "$GATE" "$base" "$br" ) >"$ROOT/c$N.out" 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    printf '  \033[32m✓\033[0m %-46s exit=%s\n' "$desc" "$got"; PASS=$((PASS+1))
  else
    printf '  \033[31m✗\033[0m %-46s 期望=%s 實際=%s\n' "$desc" "$want" "$got"; FAIL=$((FAIL+1))
    sed 's/^/      /' "$ROOT/c$N.out" | head -5
  fi
}

echo "── base 檢查 ──"
run 1 dev  feat/demo-change--x "base 不是 main"          sh -c 'mkdir -p src && echo a > src/a.ts'

echo "── spec/ ──"
run 0 main spec/demo-change "只動自己的 change"          sh -c 'echo "" >> openspec/changes/demo-change/proposal.md'
run 0 main spec/demo-change "可以加 ADR"                 sh -c 'mkdir -p docs/adr && echo "# ADR" > docs/adr/0001-x.md'
run 1 main spec/demo-change "夾帶產品程式碼"              sh -c 'mkdir -p src && echo a > src/a.ts'
run 1 main spec/demo-change "動別人的 change"             sh -c 'mkdir -p openspec/changes/other && echo x > openspec/changes/other/proposal.md'
run 1 main spec/Bad--Id     "id 格式不合"                 sh -c 'echo x > z.md'
run 1 main spec/nonexistent "id 在 changes/ 下不存在"     sh -c 'mkdir -p docs/adr && echo x > docs/adr/0002-y.md'

echo "── feat/ fix/ ──"
run 0 main feat/demo-change--slice "change 已在 main"     sh -c 'mkdir -p src && echo a > src/a.ts'
run 0 main feat/demo-change        "沒有 slice 也可以"     sh -c 'mkdir -p src && echo a > src/a.ts'
run 0 main fix/demo-change--bug    "fix 同樣可以"          sh -c 'mkdir -p src && echo a > src/a.ts'
run 0 main feat/demo-change--t     "可以打勾 tasks"        sh -c 'mkdir -p src && echo a > src/a.ts && printf "## 1.\n- [x] d\n" > openspec/changes/demo-change/tasks.md'
run 1 main feat/nonexistent--x     "change 不在 main 上"   sh -c 'mkdir -p src && echo a > src/a.ts'
run 1 main feat/demo-change--x     "回改 proposal"         sh -c 'mkdir -p src && echo a > src/a.ts && echo "偷改" >> openspec/changes/demo-change/proposal.md'
run 1 main feat/demo-change--x     "回改 specs/"           sh -c 'mkdir -p src && echo a > src/a.ts && echo "偷改" >> openspec/changes/demo-change/specs/demo/spec.md'
run 1 main feat/demo-change--x     "夾帶 archive"          sh -c 'mkdir -p src openspec/specs/demo && echo a > src/a.ts && echo x > openspec/specs/demo/spec.md'

echo "── chore/ ──"
run 0 main chore/tidy-readme   "小改"                     sh -c 'echo "一行" >> README.md'
run 1 main chore/sneak-spec    "碰 openspec/"             sh -c 'echo "x: 1" >> openspec/config.yaml'
run 1 main chore/sneak-ci      "碰 .github/"              sh -c 'echo "#" >> .github/workflows/ci.yml'
run 1 main chore/symlink       "加 symlink"               sh -c 'ln -s /etc/passwd link.txt'
run 1 main chore/binary        "加 binary（含 NUL）"       sh -c 'printf "PNG\x00\x01\x02\x03binary" > blob.bin'
run 1 main chore/huge          "超過 bytes 上限"           sh -c 'head -c 30000 /dev/zero | tr "\0" "a" > big.txt'
run 1 main chore/minified      "一行 minified"             sh -c 'head -c 30000 /dev/zero | tr "\0" "x" | tr -d "\n" > min.js'
run 0 main chore/lockfile-bump "大 lockfile 不計入大小"     sh -c 'head -c 40000 /dev/zero | tr "\0" "b" > package-lock.json'

echo "── archive/ ──"
run 1 main archive/demo-change "夾帶程式碼"                sh -c 'mkdir -p src && echo a > src/a.ts'
run 1 main archive/demo-change "順手改了 change"           sh -c 'echo "改" >> openspec/changes/demo-change/proposal.md'
run 0 main archive/demo-change "archive + 補上 Purpose"    sh -c 'npx openspec archive demo-change --yes && perl -0pi -e "s/TBD - created by archiving change [^\n]*/示範能力的完整說明：這一份描述系統目前在這個 capability 上的行為、邊界與失敗處理，是新加入的人要看的第一份文件。/" openspec/specs/demo/spec.md'
run 1 main archive/demo-change "archive 但 Purpose 留 TBD"  sh -c 'npx openspec archive demo-change --yes'

echo "── governance/ ──"
run 0 main governance/fix-ci     "改 CI"                  sh -c 'echo "#" >> .github/workflows/ci.yml'
run 0 main governance/fix-agents "改 AGENTS.md"           sh -c 'echo "" >> AGENTS.md'
run 0 main governance/decisions   "改 docs/DECISIONS.md"     sh -c 'mkdir -p docs && echo "x" >> docs/DECISIONS.md'
run 0 main governance/setup-doc   "改 SETUP-GITHUB.md"       sh -c 'echo "x" >> SETUP-GITHUB.md'
run 1 main governance/sneak-docs  "夾帶 docs/ 底下別的檔案"    sh -c 'mkdir -p docs && echo "x" > docs/RANDOM.md'
run 1 main governance/sneak-code "夾帶產品程式碼"           sh -c 'mkdir -p src && echo a > src/a.ts'
run 1 main governance/sneak-spec "動 changes/"            sh -c 'echo "x" >> openspec/changes/demo-change/proposal.md'

echo "── rename / 路徑轉移（Codex R4 找到的整類空白）──"
run 1 main feat/demo-change--rn1 "rename 掉 proposal.md"           sh -c 'git mv openspec/changes/demo-change/proposal.md openspec/changes/demo-change/approved.txt'
run 1 main feat/demo-change--rn2 "把 approved spec 搬成產品程式碼"   sh -c 'mkdir -p src && git mv openspec/changes/demo-change/specs/demo/spec.md src/interpolation.ts'
run 1 main spec/demo-change      "spec 把自己的檔案搬出目錄"         sh -c 'mkdir -p src && git mv openspec/changes/demo-change/proposal.md src/p.md'
run 1 main chore/rename-out      "chore 把 openspec 檔案搬出來"      sh -c 'git mv openspec/config.yaml cfg.yaml'
run 1 main chore/weird-name      "檔名含換行字元"                   sh -c 'printf x > "$(printf "a\nb.txt")"'

echo "── archive 內容身分 ──"
run 1 main archive/demo-change "archive 之後竄改被封存的規格"        sh -c '
  npx openspec archive demo-change --yes
  perl -0pi -e "s/TBD - created by archiving change [^\n]*/這一份描述系統目前在 demo 這個 capability 上的行為、邊界與失敗處理，是新加入的人要看的第一份文件。/" openspec/specs/demo/spec.md
  f=$(ls -d openspec/changes/archive/*/specs/demo/spec.md)
  printf "\n#### Scenario: [DEMO-01-S09] 偷加的情境\n- **WHEN** a\n- **THEN** b\n" >> "$f"'

run 1 main archive/demo-change "誘餌 archive 目錄不得遮蔽竄改"     sh -c '
  npx openspec archive demo-change --yes
  f=$(ls -d openspec/changes/archive/*/specs/demo/spec.md)
  # 誘餌：排序在真正的 archive 之後、內容乾淨。
  # 舊的 regex [^/]*<id>/ 會把它也算進來並覆蓋掉真的那一份 → 假通過。
  mkdir -p openspec/changes/archive/2099-12-31-x-demo-change/specs/demo
  cp openspec/changes/archive/*-demo-change/proposal.md openspec/changes/archive/2099-12-31-x-demo-change/
  cp openspec/changes/archive/*-demo-change/tasks.md    openspec/changes/archive/2099-12-31-x-demo-change/
  cp "$f" openspec/changes/archive/2099-12-31-x-demo-change/specs/demo/
  printf "\n#### Scenario: [DEMO-01-S09] 偷加的情境\n- **WHEN** a\n- **THEN** b\n" >> "$f"
  perl -0pi -e "s/TBD - created by archiving change [^\n]*/這一份描述系統目前在 demo 這個 capability 上的行為、邊界與失敗處理，是新加入的人要看的第一份文件。/" openspec/specs/demo/spec.md'

run 1 main archive/demo-change "動到別的 change 的 archive"        sh -c '
  npx openspec archive demo-change --yes
  perl -0pi -e "s/TBD - created by archiving change [^\\n]*/這一份描述系統目前在 demo 這個 capability 上的行為、邊界與失敗處理，是新加入的人要看的第一份文件。/" openspec/specs/demo/spec.md
  mkdir -p openspec/changes/archive/2026-01-01-undemo-change
  echo x > openspec/changes/archive/2026-01-01-undemo-change/proposal.md'

run 1 main archive/demo-change "兩個目錄都配得上同一個 id"        sh -c '
  npx openspec archive demo-change --yes
  perl -0pi -e "s/TBD - created by archiving change [^\\n]*/這一份描述系統目前在 demo 這個 capability 上的行為、邊界與失敗處理，是新加入的人要看的第一份文件。/" openspec/specs/demo/spec.md
  cp -R openspec/changes/archive/*-demo-change openspec/changes/archive/2099-01-01-demo-change'

run 1 main archive/demo-change "archive 裡多出 main 沒有的檔案"   sh -c '
  npx openspec archive demo-change --yes
  perl -0pi -e "s/TBD - created by archiving change [^\\n]*/這一份描述系統目前在 demo 這個 capability 上的行為、邊界與失敗處理，是新加入的人要看的第一份文件。/" openspec/specs/demo/spec.md
  d=$(ls -d openspec/changes/archive/*-demo-change)
  echo "偷夾帶" > "$d/extra.md"'

run 1 main archive/nonexistent "archive 一個不存在的 change"      sh -c '
  mkdir -p openspec/specs/demo
  printf "# demo Specification\n\n## Purpose\n這一份描述系統目前在 demo 這個 capability 上的行為、邊界與失敗處理，是新加入的人要看的第一份文件。\n\n## Requirements\n\n### Requirement: R\n系統 SHALL 做事。\n\n#### Scenario: [DEMO-01-S01] a\n- **WHEN** a\n- **THEN** b\n" > openspec/specs/demo/spec.md'

echo "── chore 的 lockfile 與 LFS ──"
run 1 main chore/lock-whitespace "lockfile 塞入大量合法空白"         sh -c 'python3 -c "
import io,json
d=json.load(io.open(\"package-lock.json\",encoding=\"utf-8\"))
io.open(\"package-lock.json\",\"w\",encoding=\"utf-8\").write(json.dumps(d,indent=250))
"'
run 1 main chore/lfs-attrs       "chore 改 .gitattributes"          sh -c 'echo "assets/* filter=lfs diff=lfs merge=lfs -text" > .gitattributes'
run 1 main chore/lfs-pointer     "chore 加 LFS pointer"             sh -c 'printf "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 999999\n" > payload.bin'

echo "── Scenario ID ──"
run 1 main spec/demo-change "Scenario 沒有 ID"       sh -c 'printf "\n#### Scenario: 沒有 ID 的情境\n- **WHEN** a\n- **THEN** b\n" >> openspec/changes/demo-change/specs/demo/spec.md'
run 1 main spec/demo-change "Scenario ID 重複"       sh -c 'printf "\n#### Scenario: [DEMO-01-S01] 重複的 ID\n- **WHEN** a\n- **THEN** b\n" >> openspec/changes/demo-change/specs/demo/spec.md'
run 1 main spec/demo-change "Scenario ID 格式不合"   sh -c 'printf "\n#### Scenario: [demo-1-x] 格式不合\n- **WHEN** a\n- **THEN** b\n" >> openspec/changes/demo-change/specs/demo/spec.md'

echo "── 未知前綴 ──"
run 1 main wip/whatever "未知前綴" sh -c 'echo x > z.md'
run 1 main hotfix       "沒有前綴" sh -c 'echo x > z.md'

echo
echo "通過 ${PASS} / 失敗 ${FAIL} / 共 ${N}"
echo "測試目錄：$ROOT"
[ "$FAIL" = 0 ]
