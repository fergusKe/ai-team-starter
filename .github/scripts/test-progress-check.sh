#!/usr/bin/env bash
# progress.sh --check 的負向測試。
#
#     bash .github/scripts/test-progress-check.sh
#
# **一個從來沒紅過的檢查等於沒有檢查。** 這支腳本對每一條不變量各造一次違規，
# 斷言它真的會紅；最後再驗乾淨的表格是綠的。
#
# 下面每一條都曾經**靜默通過**（由對抗審查實測繞過），才被補起來的：
#
#   標記欄只有理由沒有標記        `｜有理由`
#   `【沒答案就】` 後面是空的      貼了標籤但沒寫處置
#   依賴指向不存在的 ID          `DEP-G99`，連帶讓「工作不得早於裁決」那條也不驗
#   ID 不是合法格式              例如被加粗成 `**APP-P03**`，會被當成上一列的續行
#   表格列前面有空白             整列從所有檢查裡消失
#
# **改 progress.sh 之前跑一次，改完再跑一次。**

set -uo pipefail
# **ROOT 不要靠 git 推。** 原本是 `git rev-parse --show-toplevel`：把這套
# 東西複製出去（新專案還沒 `git init`）就解析失敗 → 下面的 `cp` 失敗 →
# `$W` 裡留著**上一次執行留下的 progress.sh**，於是測到的是舊檔、而且全綠。
# 一支專門在抓 fail-open 的腳本自己 fail-open。（實測踩到過。）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/progress.sh"
[ -f "$SCRIPT" ] || { echo "✗ 找不到 $SCRIPT"; exit 1; }
# **不複製 progress.sh，用絕對路徑直接跑它。** 複製就有「測到舊檔」的可能，
# 不複製就沒有 —— 這比加一條「cp 失敗就 exit」的守衛牢靠。
# 工作目錄要**每次執行都不一樣**（repo 名字 ＋ PID）。只按 repo 名字分開
# 的話，同一個 repo 跑兩次（例如手動跑跟背景跑撞在一起）會互相改對方的
# fixture，跑出一堆假紅燈 —— 實測踩過，而且第一時間會以為是被測的程式壞了。
#
# 不需要清掉它。**不是因為殘留沒有影響** —— 在裡面多放一份提到不存在
# 的 ID 的文件，綠燈那幾條會紅（實測 67 過 10 失敗）。是因為殘留的違規
# 跟 fixture 的狀態無關（殘留檔不會被 edit 動到），所以它只會讓**綠燈**
# 測試變紅、不會讓**紅燈**測試變綠 —— 遮不住回歸，而且整套是紅的。
W="${TMPDIR:-/tmp}/progress-check-test.$(basename "$ROOT").$$"

PASS=0
FAIL=0

# 一份最小但合法的工作分解表。每個案例都從它出發，只壞一個地方 ——
# 這樣紅燈的原因就只可能是那一個地方。
baseline() {
  mkdir -p "$W/docs"
  cat > "$W/docs/WBS.md" <<'WBS'
# 測試用的工作分解

## 舊 ID 去哪了

APP-Z99 已經改名。**這一節提到不存在的 ID 是它的工作**，不該被當成違規。

## DEP-G 外部缺口

## APP-C 應用

## APP-P 清單

## APP-O 平台與交付

## 阻塞類型

| 阻塞類型 | 意思 | 該做什麼 |
|---|---|---|
| **待銜接** | 我們在本地自己做了，之後要對齊 | 照常排週次做 |
| `外部-缺` | 對方明文排除 | 本地做得出來，但上不了線 |
| `待裁決` | 語意還沒定 | 人要拍板 |

## 工作項目

| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |
|---|---|---|---|---|---|---|
| DEP-G01 | 外部服務沒有搜尋 | 去問對方。**【沒答案就】**介面誠實地叫「瀏覽」 | 決策≤W1 | — | `外部-缺` | Alarm｜這是核心價值 |
| APP-C01 | 應用骨架 | 專案骨架 | W1 | 3 | | |
| | | 全域 Layout | W1 | 2 | | |
| APP-P03 | 清單元件 | 列表與翻頁 | W2 | 5 | | |
| | | 搜尋與篩選 | W2 | 3 | DEP-G01 `外部-缺` | Pending｜對方還沒提供 |
| APP-O10 | 文件維護 | 常態 | 常態 | — | | Regular｜沒有完成點 |
WBS
  # 產品意圖那一份。它沒有工作分解表，只靠 ID 指過來 ——
  # 檢查要掃它、而且**不能**因為它沒有表就報「找不到工作分解表」。
  cat > "$W/docs/ROADMAP.md" <<'RM'
# 測試用的產品全貌

## 舊 ID 去哪了

APP-Z98 已經改名。這一節在兩份文件裡都是例外。

## 功能地圖

| 功能域 | WBS |
|---|---|
| 骨架 | `APP-C01` |
| 清單 | `APP-P03` |

整組能力在 `APP-O`；外部缺口見 `DEP-G`。
`外部-缺` 是分類詞，不是群組 —— 不該被當成引用。

圍籬裡是格式範例，不是引用：

```markdown
| XYZ-Q99 | 範例 | 示範表格長相 | W1 | 3 | | |
```
RM
  ( cd "$W" && git init -q 2>/dev/null; git -C "$W" add -A 2>/dev/null; ) >/dev/null 2>&1
}

# run_absent <期望退出碼> <說明> <訊息裡**不該**出現的字>
#
# 只斷言「該出現的出現了」不夠 —— 一個誤報會照樣讓那種斷言通過。
# 群組檢查最可能的誤報是把 `APP-C01` 的前五個字當成群組引用。
run_absent() {
  local want="$1" desc="$2" needle="$3"
  local out rc
  out="$(cd "$W" && bash "$SCRIPT" --check 2>&1)"; rc=$?
  if [ "$rc" != "$want" ]; then
    echo "✗ ${desc} —— 期望退出碼 ${want}，實際 ${rc}"
    FAIL=$((FAIL + 1)); return
  fi
  if printf '%s' "$out" | grep -q "$needle"; then
    echo "✗ ${desc} —— 訊息裡不該出現「${needle}」，但它出現了"
    echo "$out" | sed 's/^/      /' | head -20
    FAIL=$((FAIL + 1)); return
  fi
  echo "✓ $desc"
  PASS=$((PASS + 1))
}

# run <期望退出碼> <說明> <關鍵字>
run() {
  local want="$1" desc="$2" needle="$3"
  local out rc
  out="$(cd "$W" && bash "$SCRIPT" --check 2>&1)"; rc=$?
  if [ "$rc" != "$want" ]; then
    echo "✗ ${desc} —— 期望退出碼 ${want}，實際 ${rc}"
    FAIL=$((FAIL + 1)); return
  fi
  if [ -n "$needle" ] && ! printf '%s' "$out" | grep -q "$needle"; then
    echo "✗ ${desc} —— 退出碼對了，但訊息裡沒有「${needle}」"
    echo "$out" | sed 's/^/      /' | head -20
    FAIL=$((FAIL + 1)); return
  fi
  echo "✓ $desc"
  PASS=$((PASS + 1))
}

# sed 在 macOS 與 GNU 上的 -i 語意不同，改用 python 做代換。
#
# **代換失敗一定要當場停下來。** 找不到要改的字串卻繼續跑，
# 後面那個 run 會拿沒被改過的檔案去測 —— 它會報「期望紅、實際綠」，
# 讓人以為是被測的檢查壞了，其實是測試腳本自己壞了。（踩過。）
# --json 的 violations 必須跟 --check 看到的是同一份。**一個永遠空的欄位
# 比沒有這個欄位更糟** —— 讀的人會以為自己檢查過了。原本治理不變量整段
# 排在 JSON 輸出之後，所以 --json 對任何違規都印 `"violations": []`。
run_json_has() {
  local desc="$1" out n
  out="$(cd "$W" && bash "$SCRIPT" --json 2>/dev/null)"
  n="$(printf '%s' "$out" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("violations",[])))' 2>/dev/null)"
  if [ "${n:-0}" -gt 0 ]; then
    echo "✓ $desc"; PASS=$((PASS + 1))
  else
    echo "✗ ${desc} —— --check 有違規，但 --json 的 violations 是空的"
    FAIL=$((FAIL + 1))
  fi
}

# mkchange <change-id>...：在 fixture 裡開幾個 OpenSpec change
mkchange() {
  local c
  for c in "$@"; do
    mkdir -p "$W/openspec/changes/$c"
    printf '# %s\n' "$c" > "$W/openspec/changes/$c/proposal.md"
    printf -- '- [x] 一\n- [ ] 二\n' > "$W/openspec/changes/$c/tasks.md"
  done
}

# run_field_has <說明> <項目 ID> <欄位> <該欄位裡應該出現的字>
#
# **有些東西只在資料裡看得到，訊息上看不到。** 例如「`\|` 有沒有被還原成
# `|`」：欄數切對了就 rc=0、也沒有錯誤訊息，格子裡存的是 `\|` 還是 `|`
# 從外面完全看不出來 —— 突變體因此存活過。
run_field_has() {
  local desc="$1" item="$2" field="$3" want="$4" out
  out="$(cd "$W" && bash "$SCRIPT" --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
i = [x for x in d["items"] if x["id"] == sys.argv[1]]
print("yes" if i and sys.argv[3] in str(i[0].get(sys.argv[2], "")) else "no")' "$item" "$field" "$want")"
  if [ "$out" = yes ]; then
    echo "✓ $desc"; PASS=$((PASS + 1))
  else
    echo "✗ ${desc} —— ${item} 的 ${field} 裡沒有「${want}」"
    FAIL=$((FAIL + 1))
  fi
}

# run_no_item <說明> <不該存在的工作項目 ID>
#
# **有些東西 `--check` 的訊息上看不到。** 它只印違規與摘要，不印項目表 ——
# 所以「圍籬裡的範例被當成真項目」這件事，拿 `--check` 的輸出當 needle
# 是看不到的（實測：突變體照樣 105/105 全過）。直接問 `--json`。
run_no_item() {
  local desc="$1" bad="$2" out
  out="$(cd "$W" && bash "$SCRIPT" --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("yes" if any(i["id"] == sys.argv[1] for i in d["items"]) else "no")' "$bad")"
  if [ "$out" = no ]; then
    echo "✓ $desc"; PASS=$((PASS + 1))
  else
    echo "✗ ${desc} —— ${bad} 被當成真的工作項目讀進來了"
    FAIL=$((FAIL + 1))
  fi
}

# run_blockers_has <說明> <項目 ID> <應該出現在它 blockers 裡的 ID>
#
# **阻塞欄的展開只能這樣測。** 拿 --check 的訊息當 needle 會被
# docs/WBS.md 整份的敘述掃描滿足（表格列也在掃描範圍裡），
# 阻塞欄那條路徑就算完全不展開也照過 —— 那是恆真的斷言。
# 實測：`blockers.update(found[:1])` 這個突變體在補上這個 helper 之前是存活的。
run_blockers_has() {
  local desc="$1" item="$2" want="$3" out
  out="$(cd "$W" && bash "$SCRIPT" --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
i = [x for x in d["items"] if x["id"] == sys.argv[1]]
print("yes" if i and sys.argv[2] in i[0]["blockers"] else "no")' "$item" "$want")"
  if [ "$out" = yes ]; then
    echo "✓ $desc"; PASS=$((PASS + 1))
  else
    echo "✗ ${desc} —— ${item} 的 blockers 裡沒有 ${want}"
    FAIL=$((FAIL + 1))
  fi
}

edit() { edit_in docs/WBS.md "$1" "$2"; }
edit_roadmap() { edit_in docs/ROADMAP.md "$1" "$2"; }

edit_in() {
  python3 - "$W/$1" "$2" "$3" <<'PY'
import io, sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
t = io.open(path, encoding="utf-8").read()
if old not in t:
    sys.exit(1)
io.open(path, "w", encoding="utf-8").write(t.replace(old, new, 1))
PY
  if [ $? -ne 0 ]; then
    echo "✗ 測試腳本自己壞了：edit 找不到要代換的字串"
    echo "    $1"
    exit 1
  fi
}

echo "progress.sh --check 的負向測試"
echo

# ── 正向：乾淨的表格必須是綠的 ────────────────────────────────────
baseline
run 0 "乾淨的表格：綠燈" ""

# ── 標記 ──────────────────────────────────────────────────────────
baseline
edit "Regular｜沒有完成點" "Regular"
run 1 "標記沒有理由：紅" "標記沒有理由"

baseline
edit "| Regular｜沒有完成點 |" "| ｜這是理由但沒有標記 |"
run 1 "只有理由沒有標記：紅" "沒有標記"

baseline
edit "Regular｜沒有完成點" "Rgular｜打錯字"
run 1 "不認得的標記：紅" "不認得的標記"

baseline
edit "Pending｜對方還沒提供" "Pending＋Cancelled｜兩個都標"
run 1 "互斥的處置並存：紅" "互斥"

# ── 缺口的決策期限與 fallback ─────────────────────────────────────
baseline
edit "| 決策≤W1 |" "| — |"
run 1 "缺口沒有決策期限：紅" "沒有決策期限"

baseline
edit "**【沒答案就】**介面誠實地叫「瀏覽」" "沒有 fallback"
run 1 "缺口沒有 fallback：紅" "沒有 fallback"

baseline
edit "**【沒答案就】**介面誠實地叫「瀏覽」" "**【沒答案就】**"
run 1 "貼了 fallback 標籤但沒寫處置：紅" "沒有寫出實質的處置"

# ── 排程自我矛盾 ──────────────────────────────────────────────────
# **被擋住的那一列自己要有週次**才會進入這條檢查 —— 阻塞寫在列上，
# 所以比對也是逐列的。沒有週次的列代表沒排程，沒有矛盾可言。
baseline
edit "| 決策≤W1 |" "| 決策≤W2 |"
run 1 "工作排在它依賴的裁決同一週：紅" "之前或同週"

baseline
edit "| 決策≤W1 |" "| 決策≤W5 |"
run 1 "工作排在它依賴的裁決之前：紅" "之前或同週"

# ── 解析器 fail-open ──────────────────────────────────────────────
baseline
edit "DEP-G01 \`外部-缺\`" "DEP-G99 \`外部-缺\`"
run 1 "依賴指向不存在的 ID：紅" "不存在"

baseline
edit "| APP-P03 |" "| **APP-P03** |"
run 1 "ID 被加粗（會被當成續行）：紅" "不是合法的工作項目 ID"

# **不要用「退出碼 0」當作「那一列還在」的證據** —— 整列消失一樣是 0。
# 要真的去看輸出裡有沒有它。
baseline
edit "| APP-C01 | 應用骨架 |" " | APP-C01 | 應用骨架 |"
if (cd "$W" && bash "$SCRIPT" --all 2>&1) | grep -q "APP-C01"; then
  echo "✓ 表格列前面有空白：那一列還看得見"
  PASS=$((PASS + 1))
else
  echo "✗ 表格列前面有空白：那一列從輸出裡消失了"
  FAIL=$((FAIL + 1))
fi

baseline
edit "| APP-C01 | 應用骨架 | 專案骨架 | W1 | 3 | | |" \
     "  | APP-C01 | 應用骨架 | 專案骨架 | W1 | 3 | | Rgular |"
run 1 "前置空白的列一樣要被檢查：紅" "不認得的標記"

# fallback 只有標點／底線／HTML 註解 —— 貼了標籤但實質是空的
baseline
edit "**【沒答案就】**介面誠實地叫「瀏覽」" "**【沒答案就】**_"
run 1 "fallback 只有一個底線：紅" "沒有寫出實質的處置"

baseline
edit "**【沒答案就】**介面誠實地叫「瀏覽」" "**【沒答案就】**<!-- 之後再寫 -->"
run 1 "fallback 只有 HTML 註解：紅" "沒有寫出實質的處置"

# 看起來像依賴、卻不是合法 ID —— 原本會直接從 blockers 消失，
# 連帶讓「工作不得排在裁決之前」那條也不驗
baseline
edit "DEP-G01 \`外部-缺\`" "DEP-GO1 \`外部-缺\`"
run 1 "阻塞欄的依賴 ID 打錯（字母 O）：紅" "不是合法的工作項目 ID"

# **上面那條現在是被敘述掃描接住的**（docs/WBS.md 整份都會掃，表格列也是），
# 不是被阻塞欄那條接住的。所以阻塞欄自己的路徑要另外測 —— 下面兩個
# 是敘述掃描**看不到**的形狀：散文用的窄 token 要求頭部有數字、
# 而且只認大寫，這兩個都不符合。
#
# 突變體證明過：把阻塞欄改成窄 token、或讓它的錯誤不報，
# 只有這兩條會紅。
baseline
edit "DEP-G01 \`外部-缺\`" "DEP-GXX \`外部-缺\`"
run 1 "阻塞欄裡沒有數字的 ID 要紅" "阻塞欄的 DEP-GXX"

baseline
edit "DEP-G01 \`外部-缺\`" "dep-g01 \`外部-缺\`"
run 1 "阻塞欄裡的小寫 ID 要紅" "阻塞欄的 dep-g01"

# **整格都要吃得完。** 撈不到 token 就當作沒有阻塞，是這一欄最後一個
# fail-open：下面這幾種跟「這一格真的沒有 ID」長得一模一樣 ——
# 而週欄與點欄早就是整格驗的。
baseline
edit "DEP-G01 \`外部-缺\`" "DEP-G \`外部-缺\`"
run 1 "阻塞欄只寫群組要紅" "是群組，不是工作項目"

baseline
edit "DEP-G01 \`外部-缺\`" "DEP_G01 \`外部-缺\`"
run 1 "阻塞欄用底線寫的 ID 要紅" "既不是工作項目 ID"

# 反過來：**宣告過的阻塞類型不准被掃到。** 詞彙是從 docs/WBS.md 自己那張
# 〈阻塞類型〉表讀出來的，不是寫死在腳本裡，也不是靠「長得像不像」猜。
baseline
edit "DEP-G01 \`外部-缺\`" "待銜接 + \`外部-缺\`"
run_absent 0 "宣告過的阻塞類型不算違規" "既不是工作項目 ID"

# **沒宣告過的就要報。** 這是「從表讀詞彙」跟「用形狀猜」的差別 ——
# `DEP-拒` 長得跟 `外部-缺` 一模一樣（英文前綴接中文），形狀規則會放行它。
baseline
edit "DEP-G01 \`外部-缺\`" "待銜接 + \`DEP-拒\`"
run 1 "沒宣告過的阻塞類型要紅" "DEP-拒 既不是工作項目 ID"

# 純中文的亂寫也要報。殘留法對這個 100% 免疫（它只看有沒有 ASCII）。
baseline
edit "DEP-G01 \`外部-缺\`" "今天天氣真好"
run 1 "阻塞欄的純中文亂寫要紅" "今天天氣真好 既不是工作項目 ID"

# 形狀對、詞彙沒宣告過 —— `x-待銜接` 在形狀規則下是合法的。
baseline
edit "DEP-G01 \`外部-缺\`" "x-待銜接"
run 1 "形狀像分類詞但沒宣告過也要紅" "x-待銜接 既不是"

# `plain()` 會把 `<...>` 整段刪掉，於是格子正規化完是空的、跟「真的沒寫」
# 一樣。受控欄位要用 `plain_field()`：看不懂的東西留在原地被報出來。
baseline
edit "DEP-G01 \`外部-缺\`" "<待確認>"
run 1 "阻塞欄的尖括號佔位要紅" "既不是工作項目 ID"

baseline
edit "DEP-G01 \`外部-缺\`" "<!-- DEP-G01 -->"
run 1 "阻塞欄的 HTML 註解要紅" "既不是工作項目 ID"

# 截斷的斜線清單。殘留法只看「剩下的字有沒有 ASCII」，不看結構，
# 於是這個被當成單一個 DEP-G01 靜靜通過。
baseline
edit "DEP-G01 \`外部-缺\`" "DEP-G01/ 待銜接"
run 1 "阻塞欄截斷的斜線清單要紅" "既不是工作項目 ID"

# ── 圍籬在 WBS 解析裡也要認（第六輪）─────────────────────────────

# **引用掃描早就跳過圍籬，WBS 解析原本沒有。** 於是一段 ```markdown
# 包起來的示範表格會被當成真的工作項目讀進來：ID 註冊、點數計入、
# 狀態算出來，而引用掃描那邊又跳過它 —— 同一份檔案兩種讀法。
baseline
edit "## 工作項目" $'```markdown\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X99 | 範例 | 格式範例 | W1 | 3 | | |\n```\n\n## 工作項目'
run_no_item "圍籬裡的範例表格不算工作項目" "APP-X99"

# ── 同形與不可見字元：靠清單永遠列不完（第六輪）───────────────────

# 下面每一個都曾經**整段靜默**（`APP-Q99` 不存在也不會紅）。
# 現在靠 Unicode 類別（Cf/Mn 拿掉、Pd 折成 `-`）而不是一串 replace。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP─Q99\` |"
run 1 "U+2500 製表線寫的 ID 也要驗" "APP-Q99 不存在"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APPーQ99\` |"
run 1 "U+30FC 日文長音寫的 ID 也要驗" "APP-Q99 不存在"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP﹣Q99\` |"
run 1 "U+FE63 小型連字號寫的 ID 也要驗" "APP-Q99 不存在"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-Q9‎9\` |"
run 1 "夾了 LRM 的 ID 也要驗" "APP-Q99 不存在"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`ＡＰＰ-Ｑ99\` |"
run 1 "全形字母寫的 ID 也要驗" "APP-Q99 不存在"

# `plain()` 原本用 `<[^:@\s]*?>` 剝 HTML tag，於是 `<APP-Q99>`
# 這種用角括號當佔位符的寫法整段被吃掉。只剝標籤名是小寫的才算 HTML。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、<APP-Q99> |"
run 1 "角括號裡的 ID 也要驗" "APP-Q99 不存在"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01\`<br/> |"
run_absent 0 "真的 HTML tag 照樣剝掉" "不是合法的工作項目 ID"

# 孤立的斜線：token 的尾巴吃不下沒接英數的 `/`，於是 `APP-C01/`
# 切出一個合法的 `APP-C01` 就收工 —— 截斷的清單靜靜變成單一個 ID。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01/\` |"
run 1 "孤立的斜線要紅" "後面沒有東西"

# ── Markdown 結構只讀一份（第七輪）───────────────────────────────

# **圍籬的開關不是「數次數」。** CommonMark 說閉合圍籬要跟開啟的同字元、
# 長度不能比它短。只數次數的話，下面三種寫法都能無聲塞進一個假項目 ——
# 而且切換次數是偶數，連「未閉合圍籬」那條也不會響。
baseline
edit "## 工作項目" $'````markdown\n```\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X99 | 假 | 範例 | W1 | 3 | | |\n```\n````\n\n## 工作項目'
run_no_item "巢狀圍籬裡的範例表格不算工作項目" "APP-X99"

baseline
edit "## 工作項目" $'```markdown\n~~~\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X98 | 假 | 範例 | W1 | 3 | | |\n~~~\n```\n\n## 工作項目'
run_no_item "圍籬裡混用另一種圍籬也不算" "APP-X98"

# 跨行 HTML 註解。`plain()` 的 `<!--.*?-->` 是逐行的，而 WBS 解析根本
# 沒看註解 —— 把草稿表格註解掉，它照樣被當成真項目。
baseline
edit "## 工作項目" $'<!--\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X97 | 假 | 範例 | W1 | 3 | | |\n-->\n\n## 工作項目'
run_no_item "跨行 HTML 註解裡的表格不算工作項目" "APP-X97"

# 跳過機制要自己會叫 —— 註解跟圍籬一樣。
baseline
edit "## 工作項目" $'<!--\n忘了關註解\n\n## 工作項目'
run 1 "沒關起來的 HTML 註解要紅" "沒關起來的 HTML 註解"

# ── 〈阻塞類型〉表本身也要驗（第七輪）─────────────────────────────

# **圍籬裡的類型表不算宣告。** 突變體證明過：拿掉這條，整套照樣全過。
baseline
edit "## 阻塞類型" $'```markdown\n| 阻塞類型 | 意思 | 該做什麼 |\n|---|---|---|\n| 假類型 | x | y |\n```\n\n## 阻塞類型'
edit "DEP-G01 \`外部-缺\`" "假類型"
run 1 "圍籬裡宣告的阻塞類型不算數" "既不是工作項目 ID"

# **類型詞不准跟 ID 文法撞名。** 查表排在文法前面，所以宣告一個
# `DEP-G01`，阻塞欄寫它就直接 continue —— 相依性從 blockers 靜靜消失。
baseline
edit "| \`外部-缺\` | 對方明文排除 | 本地做得出來，但上不了線 |" "| DEP-G01 | 假的 | 撞名 |"
run 1 "阻塞類型跟 ID 撞名要紅" "裡面有工作項目 ID 的形狀"

# **用 `search` 不是 `fullmatch`。** 只擋「整個詞就是一個 ID」的話，
# 後面多一個句號就繞過去了 —— 阻塞欄寫同樣的字，相依性照樣靜靜消失。
baseline
edit "| \`外部-缺\` | 對方明文排除 | 本地做得出來，但上不了線 |" "| DEP-G01。 | 假的 | 撞名加句號 |"
run 1 "阻塞類型含 ID 形狀（後面多字）也要紅" "裡面有工作項目 ID 的形狀"

# ── Markdown 子集：子集外一律 fail-closed（第八輪）──────────────

# **閉合圍籬不能帶語言名**（CommonMark 4.5）。只看開頭的話，圍籬裡示範
# 一行 ```python 就能讓它從中間裂開，後面那半段被當成資料讀進來。
baseline
edit "## 工作項目" $'```\n```python\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X99 | 假 | 範例 | W1 | 3 | | |\n```\n```\n\n## 工作項目'
run_no_item "圍籬裡示範另一段圍籬不算工作項目" "APP-X99"

# `<style>`／`<script>`／`<pre>`／`<textarea>` 是 raw HTML block，
# **瀏覽器不顯示它們的內容** —— 讀者看不到的東西不是資料。
baseline
edit "## 工作項目" $'<style>\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X95 | 假 | 範例 | W1 | 3 | | |\n</style>\n\n## 工作項目'
run_no_item "<style> 裡的表格不算工作項目" "APP-X95"

baseline
edit "## 工作項目" $'<style>\n忘了關\n\n## 工作項目'
run 1 "沒關起來的 <style> 要紅" "沒關起來的"

# 縮排四格以上，Markdown 當成程式碼區塊。**兩個方向都不能靜默** ——
# 跳過的話真表格被藏掉，讀進來的話範例變資料。所以報。
baseline
edit "| APP-C01 | " "    | APP-C01 | "
run 1 "表格列縮排四格以上要紅" "縮排了四格以上"

# GFM 允許表格列省略開頭的 `|`，我們不支援 —— 但不能靜靜丟掉那一列
# （實測：點數少算、Cancelled 不見，而畫面上它還是一列表格）。
baseline
edit "| APP-O10 | 文件維護" "APP-O10 | 文件維護"
run 1 "表格列少了開頭的豎線要紅" "開頭少了"

# ── 同形字元：認形狀，不認清單（第八輪）───────────────────────

# 清單永遠列不完 —— 第六輪補了六個，第八輪又找到五個。
# 改成認形狀：兩個以上大寫字母 ＋ 一個不是連字號的東西 ＋ 大寫字母加數字。
# 下面兩個來源不同（一個是製表符號、一個是韓文字母），刻意各測一次。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP⎯Q99\` |"
run 1 "中間不是連字號的 ID 形狀要紅（製表符號）" "不是連字號"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APPᅳQ99\` |"
run 1 "中間不是連字號的 ID 形狀要紅（非 ASCII 字母）" "不是連字號"

# **一組字元只測一個成員，等於只鎖住那一個。** 下面三條各補一個
# 同組但不同成員的字元 —— 突變體證明過：只留一個成員，整套照樣全過。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01～APP-C09\` |"
run 1 "全形波浪號當範圍也要紅（台灣最常打的那個）" "範圍要用"

baseline
edit "| \`外部-缺\` | 對方明文排除 | 本地做得出來，但上不了線 |" "| 待+銜接 | 假的 | 含加號 |"
run 1 "阻塞類型含加號也要紅" "含有空白或分隔符"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-Q9󠄁9\` |"
run 1 "變體選擇符補充區夾在 ID 中間也要驗" "APP-Q99 不存在"

# ── 一個工作項目可以有多個 change（第八輪）─────────────────────

# 原本 `change_for` 只回 `hits[0]`：第二個 change **既不在列上、也不在
# 孤兒清單、也不在 `--json` 裡** —— 它從整個輸出消失。
# 以前是錯訊號（被當成命名不合規的孤兒），改成只取第一個之後
# 變成**沒有訊號**，那更糟。突變體證明過：這條沒測的時候它存活。
baseline
mkchange app-c01-api app-c01-ui
run_field_has "同一個 ID 的每一個 change 都要進 --json" "APP-C01" "changes" "app-c01-ui"

# **列上也要看得出來有多個。** `--json` 有了不代表人看得到 ——
# 終端機那一欄只印一個 change 的話，開了兩個這件事在畫面上是隱形的。
# 突變體證明過：只斷言 `--json`，`change_for` 退回只取第一個照樣全過。
baseline
mkchange app-c01-api app-c01-ui
if (cd "$W" && bash "$SCRIPT" --all 2>&1) | grep -q "+1"; then
  echo "✓ 同一個 ID 開了兩個 change：列上看得出來"
  PASS=$((PASS + 1))
else
  echo "✗ 同一個 ID 開了兩個 change：列上只看到一個"
  FAIL=$((FAIL + 1))
fi

# 讀阻塞類型表要跟工作分解表**用同一份切列**（`split_row`）。
# 分開寫的話，含 `\|` 的類型詞在兩邊會被切成不一樣的東西 ——
# 同一支腳本兩種切列，正是這支腳本在抓的事。
baseline
edit "| \`待裁決\` | 語意還沒定 | 人要拍板 |" $'| `待裁決` | 語意還沒定 | 人要拍板 |\n| 待\\|銜接 | 假的 | 含跳脫豎線 |'
edit "DEP-G01 \`外部-缺\`" "待\\|銜接"
run_absent 0 "類型詞裡的跳脫豎線兩邊要切成一樣" "既不是工作項目 ID"

# ── Markdown 子集：開啟那一邊也要照規範（第九輪）─────────────────

# **認太寬跟認太窄一樣嚴重。** 開啟圍籬如果不驗，一個假圍籬就能把
# **真的一列**藏起來 —— 反引號圍籬的 info string 不能含反引號（spec 4.5），
# 縮排四格以上的也不是圍籬而是程式碼區塊。
baseline
edit "| APP-O10 | 文件維護" $'```x`y\n| APP-O10 | 文件維護'
run 1 "假的開啟圍籬藏不住真的一列" "APP-O10"

# 縮排四格以上的不是圍籬，是程式碼區塊 —— **開啟那一邊的兩個條件是
# 一組，只測一個等於只鎖住那一個**（實測：只測 info string 的話，
# 把縮排那個守衛拿掉，整套照樣全過）。把它當成圍籬的話，
# 中間那個懸空引用會被消音。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" $'    ```\n見 `APP-Q99`。\n    ```\n\n| 骨架 | `APP-C01` |'
run 1 "縮排四格的反引號不是圍籬，消音不了引用" "APP-Q99 不存在"

# tab 縮排。CommonMark 的 tab 走到下一個 4 的 tab stop，而只數空白的話
# 一個 tab 就能讓表格列變成程式碼區塊，我們卻照樣讀成資料。
baseline
edit "| APP-O10 | 文件維護" $'\t| APP-O10 | 文件維護'
run 1 "tab 縮排的表格列要紅" "縮排了四格以上"

# HTML block 的第 3／4／5 種在瀏覽器裡是 bogus comment，完全不顯示。
# **一組只認一個成員，等於只鎖住那一個** —— 下面三種各測一次。
baseline
edit "## 工作項目" $'<![CDATA[\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X97 | 假 | 範例 | W1 | 3 | | |\n]]>\n\n## 工作項目'
run_no_item "<![CDATA[ 裡的表格不算工作項目" "APP-X97"

baseline
edit "## 工作項目" $'<?php\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X96 | 假 | 範例 | W1 | 3 | | |\n?>\n\n## 工作項目'
run_no_item "<?…?> 裡的表格不算工作項目" "APP-X96"

# type 1 的四個標籤也是一組 —— 之前只測了 <style>。
baseline
edit "## 工作項目" $'<textarea>\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X94 | 假 | 範例 | W1 | 3 | | |\n</textarea>\n\n## 工作項目'
run_no_item "<textarea> 裡的表格不算工作項目" "APP-X94"

baseline
edit "## 工作項目" $'<script>\n| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |\n|---|---|---|---|---|---|---|\n| APP-X93 | 假 | 範例 | W1 | 3 | | |\n</script>\n\n## 工作項目'
run_no_item "<script> 裡的表格不算工作項目" "APP-X93"

# ── 一組只測一個成員的其餘三處（第九輪）───────────────────────

# 表格列的頭尾豎線 GFM 都可以省。之前只測了「少開頭」。
baseline
edit "| APP-O10 | 文件維護 | 常態 | 常態 | — | | Regular｜沒有完成點 |" "APP-O10 | 文件維護 | 常態 | 常態 | — | | Regular｜沒有完成點"
run 1 "表格列頭尾豎線都省也要紅" "開頭少了"

# 類型詞裡的 ID 不一定在開頭 —— `match` 只擋開頭，要用 `search`。
baseline
edit "| \`外部-缺\` | 對方明文排除 | 本地做得出來，但上不了線 |" "| （DEP-G01） | 假的 | ID 在中間 |"
run 1 "類型詞中間有 ID 形狀也要紅" "裡面有工作項目 ID 的形狀"

# 範圍符號還有兩個成員沒測。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01〰APP-C09\` |"
run 1 "波浪破折號當範圍也要紅" "範圍要用"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01゠APP-C09\` |"
run 1 "片假名雙連字號當範圍也要紅" "範圍要用"

# ── 同形的不只連字號，字母也會（第九輪）───────────────────────

# 西里爾／希臘字母跟 ASCII 長得一模一樣，而 `_TOKEN` 只認 `[A-Z]` ——
# 整個引用不存在。跟連字號那條是同一件事，換個位置而已。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-С99\` |"
run 1 "西里爾字母寫的 ID 要紅" "不是 ASCII 的字母"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APΡ-Q99\` |"
run 1 "希臘字母寫的 ID 要紅" "不是 ASCII 的字母"

# 形狀報警的前綴長度要跟 `_GRP` 一樣是 `+`，不是寫死兩個字母。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`API⎯W03\` |"
run 1 "三個字母前綴的形狀報警也要紅" "不是連字號"

# **類型詞不准含分隔符。** 阻塞欄是按空白切段的，含空白的詞永遠對不上
# 自己 —— 而訊息還會一邊說沒宣告、一邊把它列在「目前宣告過的」裡面。
baseline
edit "| \`外部-缺\` | 對方明文排除 | 本地做得出來，但上不了線 |" "| 外部 API | 假的 | 含空白 |"
run 1 "阻塞類型含空白要紅" "含有空白或分隔符"

# **表頭的定義是「下一行是分隔線」。** 只看第一欄的話，任何一張表裡出現
# 一列 `| 阻塞類型 | … |`，底下每一列就都變成宣告過的類型。
baseline
edit "## 阻塞類型" $'## 里程碑\n\n| 名稱 | 說明 |\n|---|---|\n| 阻塞類型 | 一般資料 |\n| 假類型 | 也算嗎 |\n\n## 阻塞類型'
edit "DEP-G01 \`外部-缺\`" "假類型"
run 1 "一般資料列寫「阻塞類型」不算表頭" "既不是工作項目 ID"

# ── 其餘（第七輪）───────────────────────────────────────────────

# **照著錯誤訊息寫 `\|` 要真的有用。** `split("|")` 不理跳脫字元，於是
# 欄數檢查會對一列已經照規矩寫的敘述報「敘述裡的 `|` 要寫成 `\|`」——
# 一條叫人做一件做了也沒用的事的訊息，比沒有訊息更糟。
baseline
edit "| APP-C01 | 應用骨架 | 專案骨架 | W1 | 3 | | |" "| APP-C01 | 應用骨架 | 用 \\| 隔開 | W1 | 3 | | |"
run_absent 0 "照規矩跳脫的 | 不該再被報" "要寫成"
# 而且格子裡要存回真正的 `|`，不是留著反斜線 —— 這件事訊息上
# 看不到，只有資料裡看得到（突變體因此存活過）。
baseline
edit "| APP-C01 | 應用骨架 |" "| APP-C01 | 應用骨架 \\| 加註 |"
run_field_has "跳脫的 | 要還原成真正的 |" "APP-C01" "name" "應用骨架 | 加註"

# 範圍只有一種寫法。`〜` 不折成 `-`（折了就是兩種範圍文法），
# 但不折的話它會被讀成兩個獨立引用、中間完全不驗 —— 所以要說出來。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01〜APP-C09\` |"
run 1 "用波浪號當範圍要紅" "範圍要用"

# 變體選擇符（VS16）夾在 ID 中間，畫面上完全看不出來。
# **只剝變體選擇符，不整類剝 `Mn`** —— `Mn` 裡有會改變字義的東西。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-Q9️9\` |"
run 1 "夾了變體選擇符的 ID 也要驗" "APP-Q99 不存在"

# ── 散文：長得一樣的字要讀成同一個（第五輪）─────────────────────

# `--` 從中間裂開：尾巴只在 `-` 後面接英數時才吃 `-`，而左邊界擋 `-`，
# 於是後半段整個消失。**這是 `APP-C01/02x` 的鏡像** ——
# 不變量對右邊界成立、對左邊界不成立。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01--APP-C99\` |"
run 1 "雙連字號要紅" "APP-C01--APP-C99"

# 全形數字、全形字母、U+2212 減號、零寬字元 —— 畫面上完全看不出差別，
# 但 token 會在那裡收尾，變成一個「群組引用」靜靜通過（群組存在，不會紅）。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C９９\` |"
run 1 "全形數字寫的 ID 也要驗" "APP-C99 不存在"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP−C99\` |"
run 1 "U+2212 減號寫的 ID 也要驗" "APP-C99 不存在"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C9​9\` |"
run 1 "夾了零寬字元的 ID 也要驗" "APP-C99 不存在"

# 黏在別的字後面的引用。左邊界原本擋 `-`，`W1-APP-C99` 整段消失。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、W1-APP-C99 |"
run 1 "黏在連字號後面的引用也要驗" "APP-C99 不存在"

# ── 週欄的範圍套跟 ID 範圍同一條規則 ────────────────────────────

# 只驗格式的話 `W9–W1` 是綠的，而 `--week W5` 看不到那一項。
baseline
edit "專案骨架 | W1 | 3" "專案骨架 | W9–W1 | 3"
run 1 "週欄範圍反著寫要紅" "反著寫或兩端相同"

# 兩端相同是 `>=` 收掉的另一半。**跟 ID 範圍完全一樣的陷阱** ——
# 一條 `>=` 有兩個意思，只測一個的話 `>` 這個突變體會存活（實測過）。
baseline
edit "專案骨架 | W1 | 3" "專案骨架 | W2–W2 | 3"
run 1 "週欄範圍兩端相同要紅" "兩端相同"

baseline
edit "專案骨架 | W1 | 3" "專案骨架 | W1–W99 | 3"
run 1 "週欄範圍跨度超過上限要紅" "超過上限"

# 欄數不足的資料列 —— 原本整列無聲消失
baseline
edit "| APP-C01 | 應用骨架 | 專案骨架 | W1 | 3 | | |" "| APP-C01 | 應用骨架 | 專案骨架 |"
run 1 "工作項目列欄數不足：紅" "欄"

# ── 表頭與表格範圍（表格範圍化自己引入的一整類 fail-open）─────────
# 這一類實測過：把表頭的 ID 加粗，122 項掉到 19 項，而 --check 照樣是 0。
baseline
edit "| ID | 項目 |" "| **ID** | 項目 |"
if (cd "$W" && bash "$SCRIPT" --all 2>&1) | grep -q "APP-C01"; then
  echo "✓ 表頭的 ID 被加粗：照樣認得出來"
  PASS=$((PASS + 1))
else
  echo "✗ 表頭的 ID 被加粗：整張表消失了"
  FAIL=$((FAIL + 1))
fi

baseline
edit "| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |" "| ID | 項目 | 工作 | 週 |"
run 1 "表頭欄數不足：紅" "表頭"

baseline
edit "| APP-P03 | 清單元件 |" "\n<!-- 分組 -->\n| APP-P03 | 清單元件 |"
run 1 "表格被註解截斷、後面還有工作列：紅" "不在表格範圍內"

baseline
edit "| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |" "| 欄 | 意思 | 工作 | 週 | 點 | 阻塞 | 標記 |"
run 1 "整份找不到工作分解表：紅" "找不到任何工作分解表"

# 用 Markdown／非 ASCII 字元把壞掉的 ID 藏起來
baseline
edit "DEP-G01 \`外部-缺\`" "DEP-G**O**1 \`外部-缺\`"
run 1 "依賴 ID 夾星號藏住錯字：紅" "不是合法的工作項目 ID"

baseline
edit "DEP-G01 \`外部-缺\`" "DEP‑GO1 \`外部-缺\`"
run 1 "依賴 ID 用非 ASCII 連字號：紅" "不是合法的工作項目 ID"

baseline
edit "**【沒答案就】**介面誠實地叫「瀏覽」" "**【沒答案就】**[](https://example.com)"
run 1 "fallback 只有一個空連結：紅" "沒有寫出實質的處置"

# ── 續行完整性、欄位漂移、ID 唯一性 ──────────────────────────────
# 截斷之後**只剩續行**：第一欄是空的，用「第一欄是不是 ID」認不出來，
# 而消失的正好是阻塞與標記那兩欄。
baseline
edit "| | | 搜尋與篩選 |" "\n<!-- 分組 -->\n| | | 搜尋與篩選 |"
run 1 "表格截斷後只剩續行：紅" "不在表格範圍內"

# 敘述裡一個沒跳脫的 `|`，整排欄位右移一格 —— 畫面上看起來正常
baseline
edit "| APP-C01 | 應用骨架 | 專案骨架 | W1 | 3 | | |" \
     "| APP-C01 | 應用骨架 | 專案骨架（a|b） | W1 | 3 | | |"
# **needle 不能只寫「欄」。** 欄位漂移會讓點數跑到週次欄，於是
# 週欄文法印出「⋯的**週次欄** `3` 不是合法的寫法」—— 裡面也有「欄」。
# 把欄數檢查整條拿掉，這條照樣綠（實測）。needle 要挑只有欄數檢查
# 會印的字。
run 1 "敘述裡有沒跳脫的 | 造成欄位漂移：紅" "表頭是"

# 同一個 ID 出現兩次：前一段被蓋掉，又被重複計入
baseline
edit "| APP-P03 | 清單元件 |" "| APP-C01 | 清單元件 |"
run 1 "同一個 ID 出現兩次：紅" "出現不只一次"

# 表格第一筆資料列漏了 ID。**畫面上仍然是一張正常的表**，
# 而那一列的週次、點數、阻塞、標記會全部消失。
baseline
edit "| DEP-G01 | 外部服務沒有搜尋 |" "| | 外部服務沒有搜尋 |"
run 1 "第一筆資料列沒有 ID：紅" "還沒有任何項目可以續行"

# 敘述裡指向不存在的項目。**重整群組之後最容易斷的就是這種** ——
# 「由 XXX 取代」而 XXX 已經不在了，沒有任何東西會發現。
baseline
edit "列表與翻頁" "列表與翻頁（由 APP-Z99 取代）"
run 1 "敘述裡提到不存在的項目：紅" "不存在"

# ── docs/ROADMAP.md ───────────────────────────────────────────────
# 產品意圖那一份靠指向工作分解表的 ID 活著。它一旦自己養一份排程或功能表，
# 重排之後不會有任何東西發現 —— 同一個 W8 在兩份文件裡變成兩件事，
# 而且頂端加了警告也沒用，讀的人滑過警告就看表了。排程只放一份，
# 剩下的 ID 由這個檢查看著。
baseline
edit_roadmap "| 清單 | \`APP-P03\` |" "| 清單 | \`APP-Z99\` |"
run 1 "ROADMAP 指向不存在的項目：紅" "ROADMAP"

# ROADMAP 沒有工作分解表是正常的。**不可以**因此報「找不到工作分解表」——
# 那會把兩件事混在一起，而且會在真的沒有表時失去這個訊號。
baseline
run 0 "ROADMAP 沒有工作分解表：不影響綠燈" ""

# 〈舊 ID 去哪了〉的例外在兩份文件裡都要成立
baseline
edit_roadmap "APP-Z98 已經改名。" "APP-Z98 與 APP-Z97 都已經改名。"
run 0 "ROADMAP 的〈舊 ID 去哪了〉可以提舊 ID：綠" ""

# ── 群組 ID ───────────────────────────────────────────────────────
# 群組 ID 沒有數字，原本整套檢查都看不到它們。重切群組之後 `FE-D`／`FE-I`
# 這類引用會躺著沒人發現 —— 實際發生過，其中兩個就在工作分解表自己裡面。
baseline
edit_roadmap "整組能力在 \`APP-O\`" "整組能力在 \`APP-D\`"
run 1 "提到不存在的群組：紅" "群組 APP-D 不存在"

baseline
edit "## APP-C 應用" "## APP-C 應用（改名了）"
run 0 "群組標題後面的說明可以改：綠" ""

# 工作項目的 ID 不可以被誤判成群組 —— `APP-C01` 的前五個字是 `APP-C`
baseline
# **用一個沒有定義過的群組**。原本這裡寫 `APP-C02`，而 fixture 裡有
# `## APP-C 應用` —— `APP-C` 在群組清單裡，所以「群組 APP-C 不存在」
# 這句話永遠印不出來，這條斷言恆真。實測：把 regex 的 `(?![0-9A-Za-z])`
# 拿掉（也就是真的把項目誤判成群組），40 條照樣全過。
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-Q02\` |"
run 1 "項目不存在要報出來" "APP-Q02 不存在"
run_absent 1 "但不該順便把它的前五個字當成不存在的群組" "群組 APP-Q 不存在"

# 非 A-Z 結尾的分類詞不是群組（`外部-缺`、`BE-拒` 這種）
baseline
edit_roadmap "\`外部-缺\` 是分類詞" "\`外部-缺\` 與 \`外部-拒\` 是分類詞"
run 0 "非 A-Z 結尾的分類詞不算群組引用：綠" ""

# 圍籬裡的 ID 是格式範例。**不跳過的話，每個複製模板的專案一開工就是紅的**
# —— README 用 `APP-C01` 示範表格長相，而那個專案的 ID 是別的前綴。
baseline
run_absent 0 "圍籬裡的範例 ID 不算引用：綠" "XYZ-Q99"

# 但圍籬外的同一個 ID 要照樣被抓 —— 免得「跳過圍籬」變成一個萬用消音器
baseline
edit_roadmap "圍籬裡是格式範例，不是引用：" "圍籬外提到 \`XYZ-Q99\`："
run 1 "圍籬外的同一個 ID 照樣要紅" "XYZ-Q99 不存在"

# 尾隨清單 `APP-C01/99` 的每一個號碼都是一個引用。註解說「這種縮寫也要展開」，
# 但展開壞掉的話沒有任何測試會紅 —— 實測把展開拿掉，40 條全過。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01/99\` |"
run 1 "尾隨清單裡的每一個號碼都要驗" "APP-C99 不存在"

# 中文緊接著群組 ID。Python 的 `\w` 認得中文，所以 `\b` 在「見」與「D」
# 之間**沒有**邊界 —— 用 `\b` 的話這個引用整個漏掉。
baseline
edit_roadmap "外部缺口見 \`DEP-G\`" "外部缺口見DEP-D"
run 1 "中文緊接著群組 ID 也要認得" "群組 DEP-D 不存在"

# 前綴長度不能寫死。工作項目那條是 `[A-Z]+`，群組那條原本是 `{2,4}` ——
# 兩條不對稱的話 `ADMIN-Z` 這種群組只有一半會被驗到。
baseline
edit_roadmap "外部缺口見 \`DEP-G\`" "外部缺口見 \`ADMIN-Z\`"
run 1 "五個字母的前綴也是群組" "群組 ADMIN-Z 不存在"

# HTML 註解裡的舊 ID 是給人看的說明，不是引用。抽 ID 之前要先過 plain()，
# 不然「把舊名寫在註解裡」這個最自然的做法會直接讓閘門變紅。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | <!-- APP-D 已改名 --> \`APP-C01\` |"
run 0 "HTML 註解裡的舊 ID 不算引用：綠" ""

# 非 ASCII 連字號長得跟 `-` 一模一樣。不正規化的話，貼上來的文字裡
# 一個 U+2011 就能讓整個引用消失。
baseline
edit_roadmap "外部缺口見 \`DEP-G\`" "外部缺口見 \`DEP‑D\`"
run 1 "非 ASCII 連字號也要認得" "群組 DEP-D 不存在"

# **沒關起來的圍籬會讓檔案後半段的引用全部消音，而且是綠的。**
# 「跳過圍籬」是為了放過格式範例，不是給人一個萬用消音器。
baseline
edit_roadmap $'| XYZ-Q99 | 範例 | 示範表格長相 | W1 | 3 | | |\n```' '| XYZ-Q99 | 範例 | 示範表格長相 | W1 | 3 | | |'
run 1 "沒關起來的圍籬要報出來" "沒關起來的程式碼圍籬"

# `~~~` 也是合法圍籬。不認得它，裡面的範例就會被當成真引用。
baseline
edit_roadmap '```markdown' '~~~markdown'
edit_roadmap $'| XYZ-Q99 | 範例 | 示範表格長相 | W1 | 3 | | |\n```' $'| XYZ-Q99 | 範例 | 示範表格長相 | W1 | 3 | | |\n~~~'
run_absent 0 "~~~ 圍籬裡的範例 ID 也不算引用：綠" "XYZ-Q99"

# 一張群組都認不出來的時候不驗群組 —— 那是別的問題（標題格式壞了），
# 在這裡報一堆「群組不存在」只會蓋掉真正的訊號。**這個守衛本身要有測試**，
# 不然把它拿掉之後，唯一的症狀是一份好文件突然全紅。
baseline
edit "## DEP-G 外部缺口" "## 外部缺口"
edit "## APP-C 應用" "## 應用"
edit "## APP-P 清單" "## 清單"
edit "## APP-O 平台與交付" "## 平台與交付"
run 0 "一張群組標題都認不出來的時候不驗群組：綠" ""

# --json 不能對違規說謊
baseline
edit "Regular｜沒有完成點" "Regular"
run 1 "標記沒有理由：紅（--check）" "標記沒有理由"
run_json_has "同一筆違規也要出現在 --json 的 violations 裡"

# ── 引用掃描的死角（對抗審查第二輪）─────────────────────────────────

# **阻塞欄只放缺口。** 網頁與 Excel 的「銜接清單是哪一組」完全建立在這件事上：
# 把一個有工作週次的項目寫進阻塞欄，那一組會整組從「在我們手上」翻成「等外部」，
# 而 --check 原本是綠的。前端項目彼此的先後寫在〈跨項依賴〉。
baseline
edit "| DEP-G01 \`外部-缺\` |" "| APP-C01 待銜接 |"
run 1 "阻塞欄指向有工作週次的項目：紅" "有工作週次"

# **範圍寫法要展開成每一個。** 這句話宣稱中間每一個都存在，只驗端點的話
# 中間刪掉不會紅 —— 而這是產品意圖那一份引用工作分解表的主要形式。
# 更糟的是 plain() 把 `–` 正規化成 `-` 之後，右端點被左邊界擋住，
# **原本連端點都只驗到第一個**。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01\`–\`APP-C03\` |"
run 1 "範圍中間的 ID 不存在要紅" "APP-C02 不存在"

baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01\`–\`APP-P09\` |"
run 1 "範圍兩端不同組要紅" "兩端不是同一組"

# 位數要跟 WBS 第一欄那條統一。WBS 認的是 `[A-Z]+-[A-Z][0-9]+`，
# 引用寫死兩位數的話，一個項目編到三位數，它的**所有引用就都不驗了**。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C011\` |"
run 1 "三位數的引用也要驗" "APP-C011 不存在"

# 長得像工作項目 ID 卻不合法的要露出來 —— 同一支腳本對 WBS 第一欄
# 早就在報「不是合法的工作項目 ID」，引用裡卻靜靜吞掉，那是兩種讀法。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C1\` |"
run 1 "一位數的編號不合法要報" "APP-C1 不是合法的工作項目 ID"

# **編號後面黏了英數的也要報。** `APP-Q01a` 原本兩邊都沒有報 ——
# 引用那條 regex 的 `(?![0-9A-Za-z])` 讓它整個消失，
# 不合法檢查那條的 `(?![A-Za-z0-9])` 也讓它整個消失。
# 一個懸空 ID 後面加一個字母就靜靜不見了，那正是這一節要防的事。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-Q01a\` |"
run 1 "編號後面接英數也不合法" "APP-Q01a 不是合法的工作項目 ID"

# 標題只決定接下來要不要掃，**它自己照樣要被掃**。
baseline
edit_roadmap "圍籬裡是格式範例，不是引用：" "## APP-D 資料層"
run 1 "寫在標題裡的懸空群組也要紅" "群組 APP-D 不存在"

# 〈舊 ID 去哪了〉認固定標題，不是關鍵字 —— 用 `"舊 ID" in s` 的話，
# 任何含這四個字的 `## ` 標題都能消音整節。
baseline
edit_roadmap "圍籬裡是格式範例，不是引用：" $'## 為什麼舊 ID 還留著\n\n見 `APP-D`。'
run 1 "只有正牌的〈舊 ID 去哪了〉能豁免" "APP-D 不存在"

# **「交給下一條檢查」的接力要驗。** 下面每一條都曾經被某一條 regex
# 放掉、而下一條的邊界條件正好接不住 —— 放掉的東西沒有人接。

# 斜線清單尾巴黏一個字母。以前是項目 regex 的尾隨 lookahead 在 `x` 上
# 失敗、回溯把 `/02` 整段丟掉，只能靠「`APP-C02` 不存在」間接抓到。
# 現在 token 一次切出 `APP-C01/02x`，parse 不完整就直接報 —— 就算
# `APP-C02` 真的存在，這個寫法本身也是壞的。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01/02x\` |"
run 1 "斜線清單尾巴黏字母要紅" "APP-C01/02x"

# 斜線後面可以重複組別字母（`APP-B02/B03`），但**字母要對得上** ——
# `APP-C01/P02` 是打錯，不是縮寫。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01/P02\` |"
run 1 "斜線後面的組別字母對不上要紅" "對不上"

# 範圍反著寫。原本 `continue`「交給下面的單點檢查」，
# 但單點檢查的左邊界 `(?<![A-Za-z0-9-])` 正好被範圍中間那個 `-` 擋掉。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C03\`–\`APP-C02\` |"
run 1 "範圍反著寫要紅" "反著寫"

# 兩端相同：`>=` 收掉的那半。改成 `>` 的話 `APP-C01`–`APP-C01` 會靜靜
# 展開成單一個端點通過 —— 而寫的人想寫的顯然是別的東西。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01\`–\`APP-C01\` |"
run 1 "範圍兩端相同要紅" "兩端相同"

# 斜線後面只有一位數。項目 regex 的 `[0-9]{2,}` 不收它，
# **catch-all 要把斜線尾巴一起吃進來**才看得到 ——
# 不吃的話從頭只吃到 `APP-C01`，那是合法的，`/2` 就靜靜消失了。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01/2\` |"
run 1 "斜線後面一位數要紅" "APP-C01/2 不是合法的工作項目 ID"

# 跨度離譜 —— 同上，原本也是 continue 之後沒有人接。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01\`–\`APP-C99\` |"
run 1 "範圍跨度超過上限要紅" "超過上限"

# 第二端不足兩位數，同上。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01\`–\`5\` |"
run 1 "範圍端點不足兩位數要紅" "編號至少兩位數"

# **第一端也要驗。** 只驗第二端的話 `APP-C1`–`APP-C03` 靜靜通過 ——
# 而它會展開成 APP-C01…APP-C03，跟寫的人想寫的東西未必一樣。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C1\`–\`APP-C03\` |"
run 1 "範圍第一端不足兩位數要紅" "編號至少兩位數"

# WBS 第一欄與引用掃描共用同一份 ID 文法。分開寫的話，
# `APP-C1` 會在第一欄合法、在引用裡不合法 —— 同一支腳本兩種讀法。
#
# **needle 要挑只有第一欄會印的字。** 兩邊的訊息統一成「不是合法的
# 工作項目 ID」之後，敘述掃描（docs/WBS.md 整份都掃，表格列也是）
# 會印同一句話 —— 拿那句話當 needle 的話，第一欄整條放寬也照過。
# 實測：`is_id_row` 改回 `[0-9]+` 這個突變體就是這樣存活的。
baseline
edit "| APP-C01 |" "| APP-C1 |"
run 1 "WBS 第一欄的一位數 ID 也不合法" "會被當成上一列的續行"

# ── 一份文法：token 切出來，parse 不完整就報（對抗審查第四輪）─────

# **範圍第二端黏一個字母，整段靜默。** 範圍 regex 的尾隨 lookahead 在 `x`
# 上失敗 → 範圍不成立；而 `APP-C03x` 前面那個 `-` 又被項目 regex 與
# catch-all 的左邊界 `(?<![A-Za-z0-9-])` 一起擋掉 —— 三條 regex 接力，
# 放掉的東西沒有人接。這是 `APP-C01/02x` 的同一個缺陷長在範圍上。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01\`–\`APP-C03x\` |"
run 1 "範圍第二端黏字母要紅" "APP-C01-APP-C03x"

# 更糟的版本：第二端既不存在、又不合法。原本一樣是綠的。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`APP-C01\`–\`APP-C99x\` |"
run 1 "範圍第二端既不存在又不合法要紅" "APP-C01-APP-C99x"

# **不是每個大寫連字詞都是 ID。** token 的頭部要求至少有一個數字 ——
# 不要求的話 `SETUP-GITHUB.md`、`X-Ray`、`E-Mail` 全都會被 parse、
# 全都會報假違規（實測：README 立刻多一個）。
baseline
edit_roadmap "| 骨架 | \`APP-C01\` |" "| 骨架 | \`APP-C01\`、\`SETUP-GITHUB.md\` 與 X-Ray |"
run_absent 0 "沒有數字的大寫連字詞不是 ID" "SETUP-GITHUB"

# ── 欄位也要有文法（週欄、點欄）──────────────────────────────

# `W1-W3`（ASCII 連字號）跟正確的 `W1–W3` 差一個鍵，而它會讓那一項的
# 排程**靜靜消失**：週次變成「沒有排程」，`--check` 是綠的，
# 連帶「工作不得排在裁決之前」那條也因為 start 是 None 而跳過。
baseline
edit "專案骨架 | W1 | 3" "專案骨架 | W1-W3 | 3"
run 1 "週欄用 ASCII 連字號要紅" "不是合法的寫法"

baseline
edit "專案骨架 | W1 | 3" "專案骨架 | w1 | 3"
run 1 "週欄小寫要紅" "不是合法的寫法"

# 點欄一樣：`3點` 會讓那一列的點數直接不算，總數少掉沒有人會發現。
baseline
edit "專案骨架 | W1 | 3" "專案骨架 | W1 | 3點"
run 1 "點欄不是數字要紅" "點數欄"

# ── 阻塞欄走同一份文法（不是自己一份）──────────────────────────

# 阻塞欄以前自己寫一份 `[A-Z]+-[A-Z][0-9]+`：不展開斜線、不展開範圍。
# 於是 `DEP-G01/99` 只收到 G01 —— 而同一個格子的敘述掃描會展開 `/99`
# 去驗它存在。同一個格子，同一支腳本，兩種讀法。
baseline
edit "DEP-G01 \`外部-缺\`" "DEP-G01/99 \`外部-缺\`"
run 1 "阻塞欄的斜線清單要展開（--check）" "DEP-G99"
run_blockers_has "阻塞欄的斜線清單真的進了 blockers" "APP-P03" "DEP-G99"

baseline
edit "DEP-G01 \`外部-缺\`" "DEP-G01–DEP-G03 \`外部-缺\`"
run 1 "阻塞欄的範圍中間也要驗（--check）" "DEP-G02"
run_blockers_has "阻塞欄的範圍中間真的進了 blockers" "APP-P03" "DEP-G02"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "✗ $PASS 過、$FAIL 失敗"
  exit 1
fi
echo "✓ $PASS/$PASS 全過"
