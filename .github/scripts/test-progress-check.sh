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
ROOT="$(git rev-parse --show-toplevel)"
SCRIPT="$ROOT/.github/scripts/progress.sh"
W="${TMPDIR:-/tmp}/progress-check-test"

PASS=0
FAIL=0

# 一份最小但合法的工作分解表。每個案例都從它出發，只壞一個地方 ——
# 這樣紅燈的原因就只可能是那一個地方。
baseline() {
  mkdir -p "$W/docs" "$W/.github/scripts"
  cp "$SCRIPT" "$W/.github/scripts/progress.sh"
  cat > "$W/docs/WBS.md" <<'WBS'
# 測試用的工作分解

| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |
|---|---|---|---|---|---|---|
| DEP-G01 | 外部服務沒有搜尋 | 去問對方。**【沒答案就】**介面誠實地叫「瀏覽」 | 決策≤W1 | — | `外部-缺` | Alarm｜這是核心價值 |
| APP-C01 | 應用骨架 | 專案骨架 | W1 | 3 | | |
| | | 全域 Layout | W1 | 2 | | |
| APP-P03 | 清單元件 | 列表與翻頁 | W2 | 5 | | |
| | | 搜尋與篩選 | W2 | 3 | DEP-G01 `外部-缺` | Pending｜對方還沒提供 |
| APP-O10 | 文件維護 | 常態 | 常態 | — | | Regular｜沒有完成點 |
WBS
  ( cd "$W" && git init -q 2>/dev/null; git -C "$W" add -A 2>/dev/null; ) >/dev/null 2>&1
}

# run <期望退出碼> <說明> <關鍵字>
run() {
  local want="$1" desc="$2" needle="$3"
  local out rc
  out="$(cd "$W" && bash .github/scripts/progress.sh --check 2>&1)"; rc=$?
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
edit() {
  python3 - "$W/docs/WBS.md" "$1" "$2" <<'PY'
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
if (cd "$W" && bash .github/scripts/progress.sh --all 2>&1) | grep -q "APP-C01"; then
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

# 欄數不足的資料列 —— 原本整列無聲消失
baseline
edit "| APP-C01 | 應用骨架 | 專案骨架 | W1 | 3 | | |" "| APP-C01 | 應用骨架 | 專案骨架 |"
run 1 "工作項目列欄數不足：紅" "欄"

# ── 表頭與表格範圍（表格範圍化自己引入的一整類 fail-open）─────────
# 這一類實測過：把表頭的 ID 加粗，122 項掉到 19 項，而 --check 照樣是 0。
baseline
edit "| ID | 項目 |" "| **ID** | 項目 |"
if (cd "$W" && bash .github/scripts/progress.sh --all 2>&1) | grep -q "APP-C01"; then
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
run 1 "敘述裡有沒跳脫的 | 造成欄位漂移：紅" "欄"

# 同一個 ID 出現兩次：前一段被蓋掉，又被重複計入
baseline
edit "| APP-P03 | 清單元件 |" "| APP-C01 | 清單元件 |"
run 1 "同一個 ID 出現兩次：紅" "出現不只一次"

# 表格第一筆資料列漏了 ID。**畫面上仍然是一張正常的表**，
# 而那一列的週次、點數、阻塞、標記會全部消失。
baseline
edit "| DEP-G01 | 外部服務沒有搜尋 |" "| | 外部服務沒有搜尋 |"
run 1 "第一筆資料列沒有 ID：紅" "還沒有任何項目可以續行"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "✗ $PASS 過、$FAIL 失敗"
  exit 1
fi
echo "✓ $PASS/$PASS 全過"
