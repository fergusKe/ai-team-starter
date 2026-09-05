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

## 舊 ID 去哪了

APP-Z99 已經改名。**這一節提到不存在的 ID 是它的工作**，不該被當成違規。

## DEP-G 外部缺口

## APP-C 應用

## APP-P 清單

## APP-O 平台與交付

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
  out="$(cd "$W" && bash .github/scripts/progress.sh --check 2>&1)"; rc=$?
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
# --json 的 violations 必須跟 --check 看到的是同一份。**一個永遠空的欄位
# 比沒有這個欄位更糟** —— 讀的人會以為自己檢查過了。原本治理不變量整段
# 排在 JSON 輸出之後，所以 --json 對任何違規都印 `"violations": []`。
run_json_has() {
  local desc="$1" out n
  out="$(cd "$W" && bash .github/scripts/progress.sh --json 2>/dev/null)"
  n="$(printf '%s' "$out" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("violations",[])))' 2>/dev/null)"
  if [ "${n:-0}" -gt 0 ]; then
    echo "✓ $desc"; PASS=$((PASS + 1))
  else
    echo "✗ ${desc} —— --check 有違規，但 --json 的 violations 是空的"
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

echo
if [ "$FAIL" -gt 0 ]; then
  echo "✗ $PASS 過、$FAIL 失敗"
  exit 1
fi
echo "✓ $PASS/$PASS 全過"
