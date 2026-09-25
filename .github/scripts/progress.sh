#!/usr/bin/env bash
# 「現在做到哪裡」的答案。
#
#     bash .github/scripts/progress.sh            # 只看有動靜的
#     bash .github/scripts/progress.sh --all      # 連還沒開始的一起列
#     bash .github/scripts/progress.sh --week W1
#     bash .github/scripts/progress.sh --blocked  # 不在自己手上的，以及誰依賴它
#     bash .github/scripts/progress.sh --check    # 有規則違規就以非零結束
#     bash .github/scripts/progress.sh --render   # 更新 docs/WBS.md 的進度區塊
#     bash .github/scripts/progress.sh --trace    # 哪些工作沒有被任何里程碑指到（報告，不擋）
#     bash .github/scripts/progress.sh --as-of 2026-10-12  # 把「今天」當成這一天（週次錨點用）
#
# **這份是算出來的，不是寫出來的。** 沒有任何人維護它。
#
# 為什麼不寫一份 STATUS.md 手動更新：手寫的狀態一定會漂。
# 這個 repo 一天之內就示範過三次 —— README 寫著「沒有人類批准的閘門」
# 而 ruleset 已經要求批准、DECISIONS.md 自己警告「數字會漂」卻寫死了
# 案例數、CLAUDE.md 半抄了 chore 的規則然後規則長出新條款。
# **漂掉的文件比沒有文件危險**，因為讀的人會相信它。
#
# 資料來源全部是機器可查的事實：
#   docs/WBS.md              有哪些工作項目（ID 是第一欄）
#   docs/ROADMAP.md          產品意圖。只檢查它提到的 ID 存不存在
#   openspec/changes/<id>/   進行中的 change 與它的 tasks.md 打勾狀態
#   openspec/changes/archive/ 已經完成並封存的
#   git branch -r            有沒有人正在某個 change 上開分支
#
# change 與 WBS 的對應靠**命名**：change id 要以 WBS ID 開頭（小寫），
# 例如 app-c01-shell 對應 APP-C01。這條寫在 AGENTS.md。
# 對不起來的 change 會單獨列在最後，那通常代表命名沒照規矩。
#
# **沒有 docs/WBS.md 也能用** —— 那時就只列 change 本身與它們的進度，
# 不做對應（沒有東西可以對，把每個 change 都說成「命名錯誤」是錯的訊號）。
#
# 要讓它認得你的 WBS，表格的**第一欄放工作項目 ID**、第四欄是週次、
# 第五欄是點數，ID 的格式是 `<大寫字母>-<大寫字母><數字>`（例如 FE-C01、API-W03）。
# 同一個項目的續行第一欄留空。
#
# 第六、七欄是選填的**阻塞**與**標記**：
#
#   阻塞  這一項被什麼擋住。**分兩種，差很多**：
#         「還沒規劃到」是需求，不是牆 —— 這種項目照樣排週次；
#         「明文不做」才是牆。詳見 docs/WBS.md 的阻塞類型表。
#   標記  算不出來的人為決定：Cancelled / Pending / TBD / Alarm，後面接理由。
#
# 它印出來的**狀態**（沒有人寫，全部是算的）：
#
#   未開始      有排週次，還沒有人動
#   規格審查中   有 spec/<id> 遠端分支
#   規格已合併   openspec/changes/<id>/ 存在
#   實作中      有 feat/ 或 fix/ 遠端分支
#   已封存      在 openspec/changes/archive/ 裡
#   等外部      沒有週次 ＋ 標記 Pending 或有阻塞 —— **不在我們手上**
#   待裁決      沒有週次 ＋ 標記 TBD —— **還沒決定要不要做**
#   已取消      標記 Cancelled
#   常態        標記 Regular，沒有完成點
#   矛盾        標了不做、卻有 change 已經封存。**不挑一邊信**
#
# 前五個是事實（git 與 OpenSpec 證明得了），後五個來自人寫的標記。
#
# 為什麼要有這兩欄：**有些狀態機器永遠猜不到。** git 看得出「有沒有開分支」，
# 看不出「我們決定不做了」。可以算的就不要讓人寫（會漂），算不出來的才由人寫，
# 而且要寫理由。週次寫 `—` 代表**沒有排程** —— 通常是還在等裁決或被擋住，
# 它們不計入「未開始」，另外列。
#
# ── 治理不變量（--check 會驗，違反就報）───────────────────────────
#
# 這一段是重點：**上面那些規則如果只寫在文件裡，它們就只是規範，
# 而規範不會擋住任何人。** 所以它們在這裡變成看得到的違規：
#
#   1. 標記必須是 `標記｜理由`。沒有理由的標記，六個月後沒有人敢刪它
#   2. 不認得的標記要報，不要當作沒看到
#   3. 互斥的處置（TBD / Pending / Cancelled / Regular）同時出現要報 ——
#      **不可以靜默挑一個**，那就是「兩份紀錄打架時自己選一邊信」
#   4. 被別的項目依賴、又沒有工作週次的「缺口」，必須有：
#        週欄   `決策≤Wn`   最晚哪一週要有答案（是**決策期限**，不是交付估時）
#        敘述欄 `【沒答案就】…`  期限到了還沒答案要怎麼辦
#      沒有 fallback 的缺口，會變成下游偷偷假設一個還不存在的能力
#   5. 一個工作的最早週次**必須嚴格晚於**它依賴的缺口的決策期限。
#      排 W4、而依賴的裁決「最晚 W4」——那不是排程，是碰運氣
#
# 標記 `Cancelled`（決定不做）的缺口不受第 4 條約束。
#
#   6. 依賴圖（2026-09-25）。阻塞欄：不准繞成一圈（缺口擋缺口）；已完成的項目
#      不准還掛著指向「待裁決」缺口的邊。〈跨項依賴〉正本表：被依賴的最晚週
#      ≤ 這一項最早週（同週合法）、不准繞成一圈、已完成的項目前置要先完成。
#      舊的自由文字表不驗、不猜，但每次都講它沒被驗。分母在 `--json` 的 `dep_graph`。
#
# 另外一整類是**解析本身要 fail-closed** —— 看起來像資料、卻解析不了，
# 一律報錯，不准安靜地跳過。下面每一條都實測繞過成功過，才被補起來：
#
#   找不到任何工作分解表          最安靜的失敗：沒有東西被檢查，所以全部「通過」
#   表頭畸形（`**ID**`、欄數不足）  整張表被當成別的表略過。實測 122 項掉到 19 項
#   表格被空行／註解截斷          後面的列全部消失，**包括第一欄是空的續行**
#   欄數跟表頭對不上              少了整列消失；多了整排右移，阻塞被擠出表格外
#   第一筆資料列漏了 ID           畫面上仍是正常的表，那一列卻整個不見
#   同一個 ID 出現兩次            前一段被蓋掉，後一段被重複計數
#   依賴 ID 打錯或夾了格式        `BE-GO1`、`BE-G**O**1`、非 ASCII 連字號
#   敘述裡指向不存在的項目         「由 XXX 取代」而 XXX 已經不在了。
#                                重整群組之後最容易斷的就是這種，實測過一次斷五處。
#                                〈舊 ID 去哪了〉那一節例外，它的工作就是提舊 ID
#
# 比對與抽 token 之前一律先 `plain()` 正規化（剝 Markdown／HTML、統一連字號）——
# **不要拿原始字串去比對**，加個星號就能讓整段檢查失效。
#
# 這些的負向測試在 .github/scripts/test-progress-check.sh（29 個案例）。
# **改這支腳本之前跑一次，改完再跑一次。**

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

ONLY_WEEK=""
SHOW_ALL=0
ONLY_BLOCKED=0
CHECK=0
JSON=0
RENDER=0
TRACE=0
AS_OF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all)     SHOW_ALL=1 ;;
    --blocked) ONLY_BLOCKED=1 ;;
    --check)   CHECK=1 ;;
    --json)    JSON=1 ;;
    --render)  RENDER=1 ;;
    --trace)   TRACE=1 ;;
    --as-of)   shift; [ $# -gt 0 ] || { echo "--as-of 要接日期（YYYY-MM-DD）" >&2; exit 2; }; AS_OF="$1" ;;
    # 要接值的參數**沒帶值就停**：`${1:-}` 會把「忘了寫」吞成空字串，然後照常跑。
    --week)    shift; [ $# -gt 0 ] || { echo "--week 要接週次（例如 W3）" >&2; exit 2; }; ONLY_WEEK="$1" ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;;
    *) echo "不認得的參數：$1" >&2; exit 2 ;;
  esac
  shift
done

# **fetch 失敗不可以靜靜吞掉。** 遠端分支是狀態的三個來源之一 ——
# 「規格審查中」與「實作中」完全靠它。fetch 失敗時腳本會拿上一次的 refs
# 繼續算，於是畫面上是一個**看起來很正常、其實是幾天前**的狀態，而且沒有
# 任何跡象。原本這裡寫 `|| true`，那正是這支腳本自己在抓的
# 「解析不出來就靜靜跳過」。
#
# 但**不中止** —— 沒有網路是常態（飛機上、離線的 CI job），而 WBS 的文法
# 檢查跟遠端一點關係也沒有。所以：照跑，但把「遠端不新鮮」講出來，並且在
# `--json` 裡標記，讓吃這份資料的工具自己決定要不要信。
REMOTE_FRESH=1
REMOTE_WHY=""
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  REMOTE_FRESH=0; REMOTE_WHY="這裡不是 git repo"
elif ! git remote get-url origin >/dev/null 2>&1; then
  REMOTE_FRESH=0; REMOTE_WHY="沒有設定 origin"
elif ! git fetch -q origin 2>/dev/null; then
  REMOTE_FRESH=0; REMOTE_WHY="git fetch origin 失敗（離線？沒有權限？）"
fi

SHOW_ALL="$SHOW_ALL" ONLY_WEEK="$ONLY_WEEK" ONLY_BLOCKED="$ONLY_BLOCKED" CHECK="$CHECK" JSON="$JSON" \
RENDER="$RENDER" TRACE="$TRACE" AS_OF="$AS_OF" REMOTE_FRESH="$REMOTE_FRESH" REMOTE_WHY="$REMOTE_WHY" python3 - <<'PY'
import os, re, sys, subprocess, pathlib, collections, unicodedata

SHOW_ALL = os.environ.get("SHOW_ALL") == "1"
ONLY_BLOCKED = os.environ.get("ONLY_BLOCKED") == "1"
CHECK = os.environ.get("CHECK") == "1"
JSON = os.environ.get("JSON") == "1"
RENDER = os.environ.get("RENDER") == "1"
TRACE = os.environ.get("TRACE") == "1"
AS_OF = os.environ.get("AS_OF") or ""
if AS_OF:
    # `--as-of` 是測試與回放用的「今天」。**格式錯就停**，不要默默改用真實時鐘 ——
    # 那樣測試會在某一天突然開始依賴日期，而且看起來還是綠的。
    import datetime as _dt0
    try:
        _dt0.date.fromisoformat(AS_OF)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", AS_OF):
            raise ValueError
    except ValueError:
        print(f"--as-of 要是 YYYY-MM-DD 而且是真的日期，現在是「{AS_OF}」", file=sys.stderr)
        raise SystemExit(2)
ONLY_WEEK = os.environ.get("ONLY_WEEK") or ""
# 遠端 refs 是不是這一次抓下來的。**不新鮮的時候要說**，見上面 shell 那段。
REMOTE_FRESH = os.environ.get("REMOTE_FRESH") == "1"
REMOTE_WHY = os.environ.get("REMOTE_WHY") or ""

G, Y, R, D, B, X = "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[1m", "\033[0m"

# ── 規則違規 ───────────────────────────────────────────────────────
# **這一段是重點。** 前面那些規則如果只寫在文件裡，它們就只是規範；
# 規範不會擋住任何人。這裡把它們變成看得到的違規。
# 圍籬：``` 或 ~~~。**開啟可以接語言名，閉合不行**（CommonMark 4.5）——
# 只看開頭的話，`` ```python `` 會被當成關，於是圍籬從中間裂開。
_FENCE = re.compile(r"^(`{3,}|~{3,})(.*)$")
_FENCE_CLOSE = re.compile(r"^(`{3,}|~{3,})\s*$")

# CommonMark 的 HTML block，**七種裡的前五種**。共同點是「瀏覽器不顯示，
# 或顯示的不是表格」—— 讀者看不到的東西不是資料。
#   type 1  <pre> <script> <style> <textarea>   到閉合標籤
#   type 2  <!-- -->                             （在 visible_lines 裡另外處理）
#   type 3  <? ... ?>        type 4  <!X ...>    type 5  <![CDATA[ ... ]]>
# 3/4/5 在瀏覽器裡是 bogus comment，完全不顯示。
_HTML_RAW = re.compile(r"^<(pre|script|style|textarea)\b", re.I)
_HTML_RAW_END = re.compile(r"</(pre|script|style|textarea)>", re.I)
_HTML_ODD = [(re.compile(r"^<\?"), "?>"),
             (re.compile(r"^<!\[CDATA\["), "]]>"),
             (re.compile(r"^<![A-Za-z]"), ">")]


def visible_lines(text, src):
    """吐出「讀者看得到的行」。**Markdown 結構只有這一份讀法。**

    回傳 `([(行號, 原始行)], 違規訊息)`。圍籬與 HTML 註解裡的行不吐出來。

    這裡曾經有三份：`read_block_types`、WBS 表格解析、引用掃描各自寫一次
    `if _FENCE.match(s): fence = not fence`。三份都錯在同一個地方 ——
    **翻轉不是 Markdown 的規則**。CommonMark 說：閉合圍籬要跟開啟的
    同字元、而且長度不能比它短。只數次數的話，這三種寫法都能無聲塞進
    一個假的工作項目（實測，`--check` 全是 0）：

        ````markdown        外圍四個，裡面示範一段三個的圍籬
        ```                 ← 被當成「關」，裡面的表格曝光給解析器
        | ID | … | XX-X99 | …
        ```                 ← 被當成「開」
        ````

        ```markdown         示範一段 ~~~ 圍籬
        ~~~                 ← 不同字元，照樣被當成關
        | ID | … | XX-X98 | …
        ~~~
        ```

        <!--                跨行註解。`plain()` 的 `<!--.*?-->` 是逐行的，
        | ID | … | XX-X97 | …      而 WBS 解析根本沒看註解
        -->

    沒關起來的圍籬與註解都要報 —— **跳過機制要自己會叫**，
    否則在檔案最上面打三個反引號就能讓整份文件消音。
    """
    out, errs = [], []
    fence = None       # (字元, 長度)
    comment = False
    raw_html = False
    odd_end = None
    for lineno, line in enumerate(text.splitlines(), 1):
        # **tab 要先展開再量縮排。** CommonMark 的 tab 走到下一個 4 的
        # tab stop，而 `len(line) - len(line.lstrip(" "))` 只數空白 ——
        # 一個 tab 就能讓表格列變成程式碼區塊，而我們照樣把它讀成資料。
        line = line.expandtabs(4)
        s = line.strip()
        indent = len(line) - len(line.lstrip(" "))
        if odd_end is not None:
            if odd_end in s:
                odd_end = None
            continue
        if comment:
            if "-->" in s:
                comment = False
            continue
        if raw_html:
            if _HTML_RAW_END.search(s):
                raw_html = False
            continue
        # **開啟圍籬也要照規範，不是只有閉合。** 縮排四格以上不是圍籬
        # 而是程式碼區塊；反引號圍籬的 info string 不能含反引號（spec 4.5）。
        # 認太寬的後果跟認太窄一樣嚴重 —— 實測 `` ```x`y `` 開頭的假圍籬
        # 可以把**真的一列**藏起來，而 --check 是 0。
        m = _FENCE.match(s) if indent < 4 else None
        if m and m.group(1)[0] == "`" and "`" in m.group(2):
            m = None
        if fence is not None:
            # **閉合圍籬不能帶語言名。** 帶了就不是閉合 —— 只看開頭的話，
            # 圍籬裡示範一行 ` ```python ` 就能讓它從中間裂開，
            # 後面那半段的東西被當成資料讀進來（實測 rc=0）。
            if (_FENCE_CLOSE.match(s) and m
                    and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1]):
                fence = None
            continue
        if m:
            fence = (m.group(1)[0], len(m.group(1)))
            continue
        if s.startswith("<!--") and "-->" not in s[4:]:
            comment = True
            continue
        if _HTML_RAW.match(s):
            if not _HTML_RAW_END.search(s):
                raw_html = True
            continue
        for _pat, _end in _HTML_ODD:
            if _pat.match(s):
                if _end not in s[2:]:
                    odd_end = _end
                break
        else:
            _pat = None
        if _pat is not None:
            continue
        # **縮排四格以上的表格列要報，不能靜靜跳過。**
        # Markdown 把它當成程式碼區塊 —— 而這裡曾經 `line.strip()` 之後
        # 直接當表格列讀，於是縮排寫的示範表格會被註冊成真項目（實測）。
        # 兩個方向都不能靜默：跳過的話真表格被藏掉，讀進來的話範例變資料。
        if s.startswith("|") and indent >= 4:
            errs.append(f"{src} 第 {lineno} 行的表格列縮排了四格以上 —— "
                        f"Markdown 會把它當成程式碼區塊。是範例就放進圍籬，"
                        f"是資料就把縮排拿掉")
            continue
        out.append((lineno, line))
    if odd_end is not None:
        errs.append(f"{src} 有沒關起來的 `<?…?>`／`<!…>`／`<![CDATA[…]]>` "
                    f"—— 後面的內容全部不會被檢查")
    if raw_html:
        errs.append(f"{src} 有沒關起來的 `<pre>`／`<script>`／`<style>`／"
                    f"`<textarea>` —— 後面的內容全部不會被檢查")
    if fence is not None:
        errs.append(f"{src} 有沒關起來的程式碼圍籬"
                    f"（`{fence[0] * fence[1]}` 開了沒關，或關的那行比它短）"
                    f" —— 後面的內容全部不會被檢查")
    if comment:
        errs.append(f"{src} 有沒關起來的 HTML 註解（`<!--` 少了 `-->`）"
                    f" —— 後面的內容全部不會被檢查")
    return out, errs

# 〈舊 ID 去哪了〉是唯一可以提不存在的 ID 的一節。**認固定標題，不是關鍵字** ——
# 用 `"舊 ID" in s` 的話，任何含這四個字的 `## ` 標題都能消音整節。
LEGACY_HEADING = "## 舊 ID 去哪了"

# **ID 的文法只有一份，而且是組出來的。** 群組是 `大寫前綴-大寫字母`，
# 工作項目是群組再接**至少兩位**數字。WBS 第一欄、引用掃描、阻塞欄
# 全部走這一份 —— 曾經各寫一次自己的位數，於是 `APP-C1` 在第一欄合法、
# 在引用裡不合法：同一個東西在同一支腳本裡兩種讀法。
_GRP = r"[A-Z]+-[A-Z]"
ID_RE = _GRP + r"[0-9]{2,}"

# **在 REF_SOURCES 那幾份文件裡，`大寫-大寫＋數字` 是保留字。**
# 掃描分不出「這是工作項目 ID」還是「剛好長一樣的別的東西」——
# `USB-C3`、`APP-C01-05 點` 都會被當成 ID 讀。這是刻意選的方向：
# **寧可誤報，不可漏報。** 漏報是一個懸空 ID 躺六個月沒人發現；
# 誤報是有人被擋一次，把那段字放進圍籬、或改寫成別的形式。
# 兩者的代價不對稱，所以不對稱地選。要寫這種 token，
# 就別寫在 REF_SOURCES 的圍籬外。

# 範圍跨度上限。超過就報 —— 一個 `FE-C01`–`FE-C99` 多半是打錯，
# 靜靜展開 99 個不存在的 ID 只會把真訊號蓋掉。
RANGE_MAX = 40

# ── 一個 token，一份文法 ─────────────────────────────────────────
#
# 這裡曾經是三條 regex 接力：一條抓範圍、一條抓斜線清單、一條 catch-all
# 報不合法。每一條有自己的邊界，「這一條放掉的交給下一條」——
# 而下一條的邊界條件正好接不住：
#
#   `APP-C01/02x`        斜線那條的尾隨 lookahead 在 `x` 上失敗，回溯把
#                       `/02` 整段丟掉；catch-all 從頭吃到 `/` 就停。
#   `APP-A01`–`APP-A99x`  範圍那條同一個洞，而第二端前面那個 `-` 又被
#                       另外兩條的左邊界擋掉 —— 整段完全靜默。
#
# 所以改成：**先切出一個最大 token，再用一份文法 parse 它，
# parse 不完整就報。** 每多一種寫法不會再生一個洞。
#
# **左右兩個邊界是兩種東西，不要用同一句話概括。** 曾經寫成
# 「token 吃的字元集合要涵蓋邊界擋的字元集合，左右都算」——
# 那句話對右邊界成立、對左邊界不成立，而且照著它改實作會壞掉。
#
#   右邊界：**這是回溯風險，必須涵蓋。** token 尾巴吃 `[A-Za-z0-9]`、
#           右邊界擋 `[A-Za-z0-9]`。貪婪吃完之後右邊界必然成立；縮短
#           只會讓它失敗，不會讓它變成另一個比較短的答案。
#           不涵蓋就會出事，實測過兩次：
#             `APP-C01/02x`  尾巴 `[0-9]{2,}` 吃不到 `x`，回溯把 `/02`
#                          整段丟掉，右邊界在 `/` 前面剛好成立
#             `APP-A01--APP-A99`  尾巴只在 `-` 後接英數時才吃 `-`，
#                          從 `--` 中間裂開（已修：尾巴改吃 `[/-]+`）
#
#   左邊界：**這不是回溯風險，是「哪些出現位置要掃」的取捨。**
#           `finditer` 由左往右掃，lookbehind 只決定一個位置可不可以
#           起頭；擋掉頭部吃不到的字元不會生出假匹配，只會讓那個位置
#           不被掃。所以這裡**刻意**擋 `[A-Za-z0-9]`，代價是
#           `W1APP-A99`、`xAPP-A99` 這種黏在英數後面的引用不驗。
#
#           放寬過，實測會壞：改成只擋 `[A-Z]`，`CONTEXT.md` 裡的
#           regex 字面 `[0-9a-zA-Z\-]+` 立刻被讀成「群組 A-Z 不存在」；
#           改成頭部先吃 `[A-Za-z0-9]*` 也一樣（會切出 `zA-Z`）。
#           散文裡本來就有 `a-zA-Z` 這種東西，而黏在英數後面的 ID
#           不是真的引用形式 —— 這個取捨往「不掃」的方向站。
#           （`W1-APP-A99`，也就是黏在**連字號**後面的，是驗的。）
#
# 頭部的英數尾巴**要求至少有一個數字**。不要求的話 `SETUP-GITHUB`、
# `X-Ray`、`E-Mail` 全都變成 token，然後 parse 失敗報一堆假違規
# （實測：README 立刻多一個）。有數字才像工作項目編號。
_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])"
    r"[A-Z]+-[A-Z](?:[A-Za-z0-9]*[0-9][A-Za-z0-9]*)?"
    r"(?:[/-]+[A-Za-z0-9]+)*"
    r"(?![A-Za-z0-9])")


# token 的三種合法形狀。**只有這三種**，其他一律報。
_SHAPE_GROUP = re.compile(_GRP)                                    # APP-C
_SHAPE_ITEM = re.compile("(" + _GRP + r")([0-9]{2,})"
                         r"((?:/[A-Z]?[0-9]{2,})*)")                # APP-C01/02
# 範圍的位數刻意放寬成 `[0-9]+`，這樣 `APP-C01`–`5` 才報得出
# 「第二端不合法」，而不是掉進最後那句籠統的訊息。
_SHAPE_RANGE = re.compile("(" + _GRP + r")([0-9]+)-"
                          "(?:(" + _GRP + r"))?([0-9]+)")           # APP-C01–APP-C05


def split_row(line):
    """把一列 Markdown 表格切成欄。**`\\|` 是跳脫，不是欄位分隔。**

    原本是 `line.strip("|").split("|")`，完全不理跳脫字元 —— 於是欄數檢查
    會對一列**已經照規矩寫了 `\\|`** 的敘述報「敘述裡的 `|` 要寫成 `\\|`」。
    **一條叫人做一件做了也沒用的事的訊息，比沒有訊息更糟。**
    """
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.replace("\\|", "|").strip()
            for c in re.split(r"(?<!\\)\|", s)]


def normalize(s: str) -> str:
    """把「畫面上長得一樣」的字元折成同一個。**不剝任何結構。**

    `plain()` 與 `plain_field()` 共用這一段 —— 分開寫的話，
    受控欄位跟散文會對同一個字元有兩種讀法。
    """
    # **同形字元不要用清單，用 Unicode 類別。** 這裡原本是一串
    # `.replace()`，然後每被審查一次就補幾個（U+2010-2014、FF0D、
    # 2212、2015⋯⋯）—— 而清單永遠列不完：實測 U+2500 `─`、U+30FC `ー`、
    # U+FE63 `﹣`、U+2043 `⁃` 全部還在外面，每一個都讓 ID 從中間裂開、
    # 整段靜默。**「靠清單」本身就是那一類問題**，不是清單不夠長。
    #
    # 拿掉不佔位的字元：`Cf`（格式字元，含零寬、LRM、軟連字號）
    # 與變體選擇符（VS1-16 及其補充區）。
    #
    # **只剝變體選擇符，不要整類剝 `Mn`。** 整類剝過，理由是 VS16 屬於
    # `Mn` —— 但 `Mn` 裡還有越南文的聲調、泰文的母音符號這些**會改變
    # 字義**的東西，剝掉之後兩個不同的詞會撞成同一個（`ป่า` 與 `ปา`
    # 都變成 `ปา`）。用「畫面上看不出差別」當理由的正規化，
    # 一旦跨過那條線就變成把不同的東西讀成一樣 —— 那是另一種漂。
    s = "".join(c for c in s
                if unicodedata.category(c) != "Cf"
                and not ("\ufe00" <= c <= "\ufe0f")
                and not ("\U000e0100" <= c <= "\U000e01ef"))
    # 連字號類折成 `-`。**只收 `Pd`，不再另外列非 `Pd` 的相似字元。**
    # 那一串（U+2212 減號、U+2500/2501 製表線、U+02D7、U+30FC/FF70 長音、
    # U+2043）是逐字元列舉，而列舉永遠列不完 —— 第六輪補六個、第八輪又找到
    # 五個。**不折不等於漏掉**：下面〈認形狀不認字元〉那條會把
    # `FE⎯C01` 這種形狀報出來（實測那七個字元一個不漏）。差別只在
    # 「靜靜當成正確」與「報一次叫人改成 ASCII」，而後者才是可維護的。
    #
    # **`Pd` 不能整類收** —— 裡面有 U+301C 波浪號
    # 與 U+30A0 片假名雙連字號，它們畫面上不像 `-`，而且 `〜` 在中文裡
    # 是「到」的意思。整類收的話 `XX-A01〜XX-A03` 會被當成範圍靜靜展開，
    # 而同一支腳本的週欄卻只認 `–`（訊息還特別寫「是 – 不是 -」）——
    # **同一支腳本兩種範圍文法**，正是這裡一直在抓的東西。
    # 範圍認哪些符號由 `_SHAPE_RANGE` 決定，不該靠正規化順便放行。
    s = "".join("-" if (unicodedata.category(c) == "Pd"
                        and c not in "\u301c\u30a0\u3030") else c
                for c in s)
    # 全形英數折回半形。**只折英數**（不折 `＋`、`｜` 這些這支腳本有在用的
    # 標點，也不要用 NFKC —— 它不折 en/em dash，卻會把 `①` 折成 `1`）。
    return "".join(chr(ord(c) - 0xFEE0)
                   if ("\uff10" <= c <= "\uff19" or "\uff21" <= c <= "\uff3a"
                       or "\uff41" <= c <= "\uff5a") else c
                   for c in s)


def plain_field(s: str) -> str:
    """**受控欄位專用的正規化。只剝強調符號，不剝結構。**

    阻塞欄一度直接用 `plain()`，而 `plain()` 是給散文用的：它會整段刪掉
    HTML tag、HTML 註解、Markdown 連結外殼。於是 `<待確認>`、`<BE-G01>`、
    `<!-- BE-G01 -->` 這幾格**正規化完變成空字串**，跟「這一格真的沒寫東西」
    完全一樣 —— 格子裡明明有字，檢查卻什麼都看不到。

    受控欄位的規則相反：**看不懂的東西要留在原地讓它被報出來。**
    """
    return normalize(re.sub(r"[*_`~]", "", s)).strip()


def plain(s: str) -> str:
    """剝掉 Markdown 與 HTML 的裝飾，只留下讀者實際看到的字。

    **不要拿原始字串去比對或抽 token。** `**ID**` 跟 `ID` 在畫面上是同一個東西，
    `BE-G**O**1` 看起來就是 `BE-GO1`；只認原始字串的話，加個星號就能讓
    整段檢查失效。非 ASCII 的連字號（‑ ‒ – —）也一併正規化 ——
    它們長得跟 `-` 一樣，貼上來的文字很容易夾帶。
    """
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)   # HTML 註解
    # **只剝真的 HTML tag，標籤名要小寫。** 原本是 `<[^:@\s]*?>`，
    # 於是 `<FE-C01>`（用角括號當佔位符，中文文件很常見）整段被吃掉 ——
    # 一個引用靜靜消失，而這正是這支腳本要抓的事。
    s = re.sub(r"</?[a-z][a-z0-9]*(?:\s[^>]*)?/?>", "", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)  # Markdown 連結，留文字
    s = re.sub(r"[*_`~]", "", s)                   # 強調符號
    return normalize(s).strip()


def scan_ids(text, where):
    """讀出一段字裡的工作項目與群組引用。**唯一一份 ID 文法在這裡。**

    回傳 `(項目 ID, 群組 ID, 違規訊息)` 三個 list。
    `where` 只進訊息（`docs/WBS.md 第 12 行`、`APP-M01：阻塞欄`）。

    **parse 不完整就報，不要「交給下一條檢查」** —— 這裡就是最後一條。

    這裡曾經有第二種寬 token 給阻塞欄用（`BE-GXX`、`be-g01` 在受控欄位裡
    一定是打錯）。**那是同一個東西的第二種讀法**，而且它擋不住真正的問題：
    撈不到 token 就當作沒有阻塞。現在阻塞欄改成整格驗殘留，寬 token 就
    不需要了。
    """
    ids, gids, errs = [], [], []
    # **不要再補同形字元的清單。** `normalize()` 折掉的是「已知長得像 `-`」
    # 的那些，而清單永遠列不完 —— 第六輪補了六個，第八輪又找到五個
    # （U+23AF、U+31D0、U+2796、U+1173、U+2504），每一個都讓引用整段靜默。
    #
    # 所以改成**認形狀不認字元**：兩個以上大寫字母、一個不是連字號也不是
    # 空白的東西、再一個大寫字母加至少兩位數字 —— 那看起來就是一個 ID，
    # 只是中間那個字元不對。實測六份真實文件 0 誤報。
    # 前綴長度用 `+` 不是 `{2,}` —— `_GRP` 是 `[A-Z]+`，兩邊寫不一樣的話
    # 三個字母的前綴（`API⎯W03`）整個不報。**同一支腳本兩種前綴長度。**
    for m in re.finditer(r"(?<![A-Za-z0-9])[A-Z]+"
                         r"([^A-Za-z0-9_\s\-/|、，,。：:（）()\[\]{}%])"
                         r"[A-Z][0-9]{2,}(?![A-Za-z0-9])", text):
        errs.append(f"{where}的 {m.group(0)} 看起來像工作項目 ID，"
                    f"但中間那個 `{m.group(1)}` 不是連字號 —— "
                    f"畫面上看不出差別，機器看得出來")
    # **同形的不只連字號，字母也會。** `FE-С99` 的 `С` 是西里爾字母
    # U+0421，`FΕ-C99` 的 `Ε` 是希臘字母 U+0395 —— 畫面上跟 ASCII 一模一樣，
    # 而 `_TOKEN` 只認 `[A-Z]`，於是整個引用不存在。跟連字號那條是同一件事，
    # 換個位置而已，所以判準也一樣：**形狀對、但有字元不是 ASCII 就報。**
    for m in re.finditer(r"(?<![^\W\d_])[^\W\d_]{2,}-[^\W\d_][0-9]{2,}"
                         r"(?![^\W\d_0-9])", text):
        if not m.group(0).isascii():
            errs.append(f"{where}的 {m.group(0)} 看起來像工作項目 ID，"
                        f"但裡面有不是 ASCII 的字母（西里爾／希臘字母跟 "
                        f"ASCII 長得一模一樣）—— 畫面上看不出差別")
    # **範圍只有一種寫法，寫錯符號要說出來。** `〜`／`〰`／`゠` 刻意不折成
    # `-`（折了就變成「同一支腳本兩種範圍文法」，見 `normalize()`），
    # 但不折的話它們會被讀成兩個獨立的引用、**中間那些完全不驗**。
    # 週欄早就在說「是 – 不是 -」，這裡要一致：看起來像範圍就要當範圍看待。
    for m in re.finditer(r"[A-Z]+-[A-Z][0-9]{2,}\s*([〜～〰゠])\s*"
                         r"(?:[A-Z]+-[A-Z])?[0-9]{2,}", text):
        errs.append(f"{where}的 {m.group(0)} 用 `{m.group(1)}` 當範圍 —— "
                    f"範圍要用 `–`（en dash），不然中間那些不會被驗")
    for m in _TOKEN.finditer(text):
        tok = m.group(0)

        # **孤立的斜線要報。** token 的尾巴是 `(?:[/-]+[A-Za-z0-9]+)*`：
        # `/` 後面沒有接英數時整段吃不下，於是 `XX-Y01/` 切出一個合法的
        # `XX-Y01`，右邊界看到 `/` 不是英數就成立 —— **截斷的斜線清單
        # 靜靜變成單一個 ID**。這是「token 吃得到、邊界擋不住」的第三種
        # 效應，跟左右邊界那兩條都不同。
        #
        # 只認 `/`，不認 `-`：`plain()` 會把中文破折號 `——` 折成 `--`，
        # 而 `` `XX-Y01`——說明 `` 是正常的中文寫法，報它是誤報。
        if text[m.end():m.end() + 1] == "/":
            errs.append(f"{where}的 {tok}/ 後面沒有東西 —— "
                        f"斜線清單要寫成 `XX-Y01/02`")

        r = _SHAPE_RANGE.fullmatch(tok)
        if r:
            a_g, a_n, b_g, b_n = r.group(1), r.group(2), r.group(3), r.group(4)
            if b_g and b_g != a_g:
                errs.append(f"{where}的範圍 {tok} 兩端不是同一組"
                            f"（{a_g} 與 {b_g}）—— 範圍只能寫在同一組裡")
                continue
            if len(a_n) < 2 or len(b_n) < 2:
                errs.append(f"{where}的範圍 {tok} 裡的 "
                            f"{a_n if len(a_n) < 2 else b_n} "
                            f"不合法（編號至少兩位數）")
                continue
            lo, hi = int(a_n), int(b_n)
            # **`>=` 不是 `>`。** 兩端相同也是打錯：它宣稱是一個範圍，
            # 實際上只有一個 ID，放過去只會展開成單一個端點。
            if lo >= hi:
                errs.append(f"{where}的範圍 {tok} 反著寫或兩端相同"
                            f"（{lo} 不小於 {hi}）")
                continue
            if hi - lo > RANGE_MAX:
                errs.append(f"{where}的範圍 {tok} 跨度 {hi - lo} "
                            f"超過上限 {RANGE_MAX}（打錯了？）")
                continue
            # **展開成每一個。**「02 到 05」這句話宣稱中間每一個都存在，
            # 只驗端點的話中間刪掉不會紅。
            w = max(len(a_n), len(b_n))
            ids.extend(f"{a_g}{k:0{w}d}" for k in range(lo, hi + 1))
            continue

        i = _SHAPE_ITEM.fullmatch(tok)
        if i:
            ids.append(i.group(1) + i.group(2))
            # 斜線後面可以重複群組字母（`APP-B02/B03`）—— 那是文件裡真實的
            # 寫法，拒絕它只會讓人去關掉檢查。但字母**要對得上**。
            for ltr, num in re.findall(r"/([A-Z]?)([0-9]{2,})", i.group(3)):
                if ltr and ltr != i.group(1)[-1]:
                    errs.append(f"{where}的 {tok} 裡，`/{ltr}{num}` 的"
                                f"組別字母跟前面的 {i.group(1)} 對不上")
                    continue
                ids.append(i.group(1) + num)
            continue

        if _SHAPE_GROUP.fullmatch(tok):
            gids.append(tok)
            continue

        errs.append(f"{where}的 {tok} 不是合法的工作項目 ID"
                    f"（`XX-Y` 加至少兩位數字；斜線清單 `XX-Y01/02`；"
                    f"範圍 `XX-Y01`–`XX-Y05`）")
    return ids, gids, errs

MARKS_EXCLUSIVE = {"TBD", "Pending", "Cancelled", "Regular", "Done"}
MARKS_FLAG = {"Alarm"}
violations = []
refs = []      # (被提到的工作項目 ID, 檔名, 行號)
grefs = []     # (被提到的群組 ID, 檔名, 行號)

# 哪些文件裡的 ID 要驗。**這是每個專案自己的選擇，預設保守。**
#
# `docs/WBS.md` 與 `docs/ROADMAP.md` 一定要驗 —— 前者是表本身，
# 後者靠指向它的 ID 活著。要不要加 AGENTS.md／CLAUDE.md／README.md／
# CONTEXT.md，看那份文件裡的 ID 是**真的引用**還是**格式範例**：
#
#   會直接點名「哪一組負責什麼」的 AGENTS.md 是真引用，斷掉會讓人
#   去翻一組不存在的東西 —— 那就加進來。
#   （實際發生過：重切群組之後 `FE-D`／`FE-I` 在四個地方躺著沒人發現。）
#
#   反過來，**判準是「圍籬外有沒有範例 ID」**，不是「這份文件有沒有範例」。
#   這個模板的 README 用 `APP-C01` 示範表格長相，但那張表在 ```markdown
#   圍籬裡，掃它是安全的（實測 0 個違規）。預設仍然只放 WBS 與 ROADMAP，
#   理由是**複製模板的專案，它的 README 寫什麼我們不知道** ——
#   預設掃一份還沒寫的文件，第一天就會紅得莫名其妙。
#
# 圍籬程式碼區塊（``` 之間）一律跳過 —— 那裡面是範例，不是引用。
# `docs/DECISIONS.md` 刻意不驗：它是歷史，會引用當時的 ID 當例子。
REF_SOURCES = ["docs/WBS.md", "docs/ROADMAP.md"]
_groups, _milestones, _deps = [], [], []
# 里程碑那一節的「適用範圍」。**`schema=None` 跟 `rows=0` 要分得出來** ——
# 沒有這一節、有這一節但讀不出來、讀出來的是舊格式，三件事的處置不一樣。
_ms_meta = {"found_heading": False, "schema": None, "rows": 0,
            "coverage_status": "unavailable", "reason": "no_milestone_section"}
# 〈跨項依賴〉的適用範圍。舊的自由文字表 `ordering_status` 永遠是 unavailable ——
# **不驗就要講出來**，不能讓「沒有逆序」跟「沒有看」長得一樣。
_xdep_meta = {"found_heading": False, "schema": None, "rows": 0,
              "ordering_status": "unavailable", "reason": "no_cross_dep_table"}
_xdep_rows = []

def parse_mark(mark: str):
    """回傳 (標記集合, 理由)。格式是 `標記｜理由`，標記之間用 ＋ 串。"""
    parts = re.split(r"[｜|]", mark, 1)
    head = parts[0].strip()
    reason = parts[1].strip() if len(parts) > 1 else ""
    words = {m.strip() for m in re.split(r"[+＋\s]+", head) if m.strip()}
    return words, reason

def check_mark(wid: str, mark: str):
    words, reason = parse_mark(mark)
    out = []
    if not words:
        # `｜有理由` —— 只有理由沒有標記。原本靜默通過。
        out.append(f"{wid}：標記欄有內容但沒有標記（格式是 `標記｜理由`）")
    unknown = words - MARKS_EXCLUSIVE - MARKS_FLAG
    if unknown:
        out.append(f"{wid}：不認得的標記 {'、'.join(sorted(unknown))}")
    both = words & MARKS_EXCLUSIVE
    if len(both) > 1:
        # **不要靜默挑一個。** 挑一個就是「兩份紀錄打架時自己選一邊信」，
        # 而那正是這份文件到處在防的事。
        out.append(f"{wid}：同時標了互斥的處置 {'、'.join(sorted(both))}")
    if not reason:
        out.append(f"{wid}：標記沒有理由（格式是 `標記｜理由`）")
    return out

# ── 阻塞類型的詞彙：從文件自己那張表讀出來 ─────────────────────────
#
# **不要把 `待銜接`／`待裁決` 這種詞寫死進腳本。** 它們是每個專案自己的
# 詞彙，而它們**本來就宣告在文件裡**：`docs/WBS.md` 有一張
# `| 阻塞類型 | 意思 | 該做什麼 |` 的表。從那張表讀第一欄就好 ——
# 跟群組是從 `## XX-Y 名稱` 標題讀出來的是同一個道理。
#
# 這裡曾經改用「殘留法」猜：把切得到的 ID 與「英文前綴接中文」的詞拿掉，
# 剩下的字如果還有 ASCII 就報。那不是「不寫死詞彙」，是**寫死了另一件事**
# —— 詞彙必須長成「純中文」或「英文-中文」。實測兩邊都漏：
# `今天天氣真好` 全綠（純中文，永遠不含 ASCII），`x-待銜接` 也全綠
# （形狀對了就過，形狀沒有語意）；反過來 `WIP`、`外部 API` 誤報。
def read_block_types(vis):
    """讀出〈阻塞類型〉表第一欄的詞彙。回傳 (詞彙集合, 違規訊息)。

    `vis` 是 `visible_lines()` 的輸出 —— 圍籬與註解裡的示範表不算宣告。
    """
    out, errs, in_table = set(), [], False
    rows = {n: l.strip() for n, l in vis}
    for n, l in vis:
        s = l.strip()
        if not s.startswith("|"):
            in_table = False
            continue
        cells = [plain_field(c) for c in split_row(s)]
        if not cells:
            continue
        # **表頭的定義是「下一行是分隔線」**，不是「第一欄剛好寫著阻塞類型」。
        # 只看第一欄的話，任何一張表裡出現一列 `| 阻塞類型 | 一般資料 |`，
        # 底下每一列就都變成「宣告過的類型」—— 一句話開一扇後門。
        if cells[0] == "阻塞類型":
            nxt = rows.get(n + 1, "")
            in_table = nxt.startswith("|") and set(nxt) <= set("-:| ")
            continue
        if not in_table or set(s) <= set("-:| "):
            continue
        w = cells[0]
        if not w:
            continue
        # **類型詞不准跟 ID 文法撞名。** 查表排在文法前面，所以表裡放什麼、
        # 阻塞欄就放行什麼：宣告一個 `BE-G01`，那個相依性就從
        # `blockers` 靜靜消失；宣告一個 `BE-G`，「群組不是阻塞」也被繞過。
        # **用 `search` 不是 `fullmatch`。** 只擋「整個詞就是一個 ID」的話，
        # 宣告一個 `XX-G01。`（後面多一個句號）就繞過去了 ——
        # 阻塞欄寫同樣的字，那條相依性照樣靜靜消失。
        if _TOKEN.search(w):
            errs.append(f"docs/WBS.md 第 {n} 行：阻塞類型 `{w}` 裡面有工作項目 ID "
                        f"的形狀 —— 它會讓阻塞欄裡的同名 ID 整個消失")
            continue
        # **類型詞不准含分隔符。** 阻塞欄是用 `[\s+＋、,，]+` 切段的，
        # 含分隔符的詞永遠對不上自己 —— 而錯誤訊息還會一邊說「沒宣告過」、
        # 一邊把它列在「目前宣告過的」裡面。
        if re.search(r"[\s+＋、,，]", w):
            errs.append(f"docs/WBS.md 第 {n} 行：阻塞類型 `{w}` 含有空白或"
                        f"分隔符 —— 阻塞欄是按這些字切段的，這個詞永遠對不上")
            continue
        out.add(w)
    return out, errs


_wbs_vis, _wbs_struct_errs = visible_lines(
    pathlib.Path("docs/WBS.md").read_text(encoding="utf-8"), "docs/WBS.md"
) if pathlib.Path("docs/WBS.md").exists() else ([], [])
BLOCK_TYPES, _bt_errs = read_block_types(_wbs_vis)
violations.extend(_wbs_struct_errs)
violations.extend(_bt_errs)

# ── WBS：ID → (名稱, 週, 點數合計) ─────────────────────────────────
wbs, order = {}, []
wbs_path = pathlib.Path("docs/WBS.md")
if wbs_path.exists():
    cur = None
    # **只在工作分解表裡解析。** 一份文件裡還有很多別的表（阻塞類型、標記說明、
    # 里程碑對照），它們的欄數不同、第一欄也不是 ID。
    # 以「表頭是 | ID | …| 且至少五欄」界定範圍，遇到非表格行就離開 ——
    # 這樣「欄數不足」才有辦法報成錯誤，而不是跟別的表混在一起只能默默跳過。
    in_table = False
    found_table = False
    ncols = 0          # 表頭有幾欄。**列的欄數要跟它一模一樣。**
    # **結構只讀一份。** 圍籬與註解裡的示範表格不是資料 —— 判斷交給
    # `visible_lines()`，這個迴圈只管表格語意。
    _vis = dict(_wbs_vis)

    def is_sep(i):
        """第 i 行（1-based 行號）是不是 Markdown 的表頭分隔線。"""
        s = _vis.get(i, "").strip()
        return s.startswith("|") and set(s) <= set("-:| ")

    for lineno, line in _wbs_vis:
        # **不能用 line.startswith("|")** —— Markdown 允許表格列前面有空白，
        # 而那樣的一列會整個從檢查裡消失（連同它的 ID、週次、標記），
        # 不會有任何錯誤訊息。先正規化再判斷。（實測繞過過。）
        line = line.strip()
        if not line.startswith("|"):
            # **GFM 允許表格列省略開頭的 `|`。** 我們不支援那種寫法（支援的話
            # 「表格到哪裡結束」會變得很難講），但**不能靜靜丟掉** ——
            # 少打一個開頭的 `|`，那一列的週次、點數、阻塞、標記全部消失，
            # 而畫面上它還是一列表格（實測：點數少 50、Cancelled 不見）。
            if in_table and "|" in line:
                violations.append(
                    f"docs/WBS.md 第 {lineno} 行看起來是表格列，但開頭少了 `|`"
                    f"（Markdown 會把它當成表格的一部分，這支腳本不會）：{line[:40]}")
            # 表格結束。**一定要重設** —— 否則下一張表的列會被當成這張表的。
            in_table = False
            cur = None
            continue
        cells = split_row(line)
        head = plain(cells[0])
        # 表頭：`| ID | 項目 | 工作 | 週 | 點 | …`
        # **用正規化後的字比對。** 只認字面上的 `ID` 的話，把表頭寫成
        # `| **ID** |` 就會讓底下整張表被當成別的表略過 —— 實測過：
        # 122 項掉到 19 項，而 --check 照樣是 0。
        # **表頭的定義是「下一行是分隔線」**，不是「第一欄剛好寫著 ID」。
        # 說明用的表格裡也會出現 `| **ID** | 工作項目編號… |` 這種資料列，
        # 只看第一欄會把它誤判成表頭。
        if head.casefold() == "id" and is_sep(lineno + 1):
            if len(cells) < 5:
                violations.append(f"docs/WBS.md 第 {lineno} 行是工作分解表的表頭，"
                                  f"但只有 {len(cells)} 欄（要 5 欄以上）")
            in_table = len(cells) >= 5
            if in_table:
                ncols = len(cells)
            # **表格最多七欄。** 多出來的欄位沒有意義，而畫面上還是一張正常
            # 的表 —— 底下每一列的解讀會跟著移位。
            if in_table and len(cells) > 7:
                violations.append(
                    f"docs/WBS.md 第 {lineno} 行：工作分解表最多 7 欄，"
                    f"這張表有 {len(cells)} 欄")
            found_table = found_table or in_table
            cur = None
            continue
        if not in_table:
            # 表格範圍外卻出現看起來像工作分解表的列 —— 通常是表頭壞了、
            # 或表格被空行／註解截斷。**這一段內容會整個從檢查裡消失，要報。**
            #
            # **不能只認第一欄是 ID 的列。** 續行的第一欄是空的，
            # 截斷之後它一樣會消失，而且消失的正是阻塞與標記那兩欄。
            # 所以改成用欄數認：跟工作分解表一樣寬的列，就該在表格裡。
            if ncols and len(cells) == ncols:
                who = head or "（續行）"
                violations.append(f"docs/WBS.md 第 {lineno} 行的 {who} "
                                  f"看起來是工作分解表的列，卻不在表格範圍內"
                                  f"（表頭壞了，或表格被空行／註解截斷）")
            continue
        # 分隔線
        if head and set(head) <= set("-: "):
            continue
        # **欄數要跟表頭一模一樣。**
        #
        # 少了會整列無聲消失。**多了更陰險** —— 敘述裡不小心打一個沒跳脫的
        # `|`，週次、點數、阻塞、標記會整排右移一格，於是阻塞跑到表格外面被丟掉，
        # 而畫面上看起來一切正常。
        if len(cells) != ncols:
            violations.append(f"docs/WBS.md 第 {lineno} 行有 {len(cells)} 欄，"
                              f"表頭是 {ncols} 欄（敘述裡的 `|` 要寫成 `\\|`）："
                              f"{line[:50]}")
            continue
        wid, name, _work, week, pts = cells[0], cells[1], cells[2], cells[3], cells[4]
        # 第六、七欄是選填的。舊的五欄表格照樣讀得動。
        blocked = cells[5].strip() if len(cells) > 5 else ""
        mark = cells[6].strip() if len(cells) > 6 else ""
        is_id_row = bool(re.fullmatch(ID_RE, wid))   # 跟引用掃描同一份文法
        # 第一欄有東西、卻不是合法 ID —— 例如 `FE-P3` 少打一個 0 ——
        # 原本會被當成上一個項目的續行，把內容默默併過去。**要報。**
        if wid and not is_id_row:
            violations.append(f"「{wid}」不是合法的工作項目 ID（格式 `FE-C01`），"
                              f"它會被當成上一列的續行")
        if is_id_row:
            if wid in wbs:
                # 同一個 ID 出現兩次：前一段的資料會被蓋掉，而它又會被
                # 重複計入總數。**兩邊都錯，而且都不會有訊息。**
                violations.append(f"{wid} 在表裡出現不只一次（第 {lineno} 行）")
            cur = wid
            wbs[wid] = {"name": name, "weeks": set(), "pts": 0,
                        "blocked": "", "mark": "", "blockers": set(),
                        "deadline": None, "fallback": False, "rows": [],
                        "detail": []}
            order.append(wid)
        if cur is None:
            # 表格的第一筆資料列沒有 ID —— 漏貼或誤刪都很平常，
            # 而且畫面上仍然是一張正常的表。原本會被當成「續行，但還沒有
            # 前一項」直接跳過，那一列的週次、點數、阻塞、標記全部消失。
            violations.append(f"docs/WBS.md 第 {lineno} 行沒有工作項目 ID，"
                              f"而它前面還沒有任何項目可以續行：{line[:50]}")
            continue
        # **週欄與點欄也要有文法。** 它們原本只有「認得就收，認不得就算了」——
        # `W1-W3`（ASCII 連字號，跟正確的 `W1–W3` 差一個鍵）會讓那一項的
        # 排程靜靜消失、翻成「沒有排程」，而 --check 是綠的；
        # 連帶「工作不得排在裁決之前」那條也因為 start 是 None 而跳過。
        # 點欄的 `5點` 一樣：那一列的點數直接不算，總數少掉沒有人會發現。
        if week and not (re.fullmatch(r"W[0-9]+(–W[0-9]+)?", week)
                         or re.fullmatch(r"決策≤W[0-9]+", week)
                         or week in ("—", "常態")):
            violations.append(
                f"{cur}（docs/WBS.md 第 {lineno} 行）的週次欄 `{week}` 不是"
                f"合法的寫法（`W3`、`W13–W16`（是 – 不是 -）、"
                f"`決策≤W5`、`常態`、`—`）")
        if pts and not (pts.isdigit() or pts == "—"):
            violations.append(
                f"{cur}（docs/WBS.md 第 {lineno} 行）的點數欄 `{pts}` "
                f"不是數字（只能是數字或 `—`）")
        # **週欄的範圍要套跟 ID 範圍同一條規則。** 只驗格式的話
        # `W9–W1` 是綠的，而 `--week W5` 看不到那一項（9≤5≤1 不成立）。
        # 反著寫、兩端相同、跨度離譜 —— 都是同一種打錯。
        _mw = re.fullmatch(r"W([0-9]+)–W([0-9]+)", week)
        if _mw:
            _a, _b = int(_mw.group(1)), int(_mw.group(2))
            if _a >= _b:
                violations.append(
                    f"{cur}（docs/WBS.md 第 {lineno} 行）的週次欄 `{week}` "
                    f"反著寫或兩端相同（{_a} 不小於 {_b}）")
            elif _b - _a > RANGE_MAX:
                violations.append(
                    f"{cur}（docs/WBS.md 第 {lineno} 行）的週次欄 `{week}` "
                    f"跨度 {_b - _a} 超過上限 {RANGE_MAX}（打錯了？）")
        if re.fullmatch(r"W[0-9]+(–W[0-9]+)?", week):
            wbs[cur]["weeks"].add(week)
        # 缺口沒有「工作週次」，它有的是**決策期限**：最晚哪一週要有答案。
        # 寫成 `決策≤W2`。**刻意跟工作週次分開解析** —— 混用會讓缺口看起來
        # 像是排得動的工作。
        md = re.fullmatch(r"決策≤W([0-9]+)", week)
        if md:
            wbs[cur]["deadline"] = int(md.group(1))
        # fallback：期限到了還沒答案要怎麼辦。用固定標記讓它可以被驗。
        if "【沒答案就】" in _work:
            # **標記後面要真的有處置。** 只放一個標記就算數的話，
            # 這個檢查只是在驗有沒有貼標籤。
            tail = _work.split("【沒答案就】", 1)[1]
            # 註解、tag、連結、標點都不算處置。**要求真的有字。**
            meat = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", plain(tail))
            if len(meat) >= 4:
                wbs[cur]["fallback"] = True
            else:
                violations.append(f"{cur}：`【沒答案就】` 後面沒有寫出實質的處置")
        if pts.isdigit():
            wbs[cur]["pts"] += int(pts)
        # 每一列的阻塞都要收 —— 一個項目底下常常只有某幾列被擋住
        # （Inbox 的清單做得了、「已讀」沒有端點），只記第一個會讓反向索引漏掉。
        if blocked:
            # **阻塞欄整格都要吃得完，一段都不准放過。**
            #
            # 它曾經自己寫一份 `[A-Z]+-[A-Z][0-9]+` 去 `finditer`：
            # 不展開斜線、不展開範圍，而且**撈不到就當作這一格沒有阻塞**。
            # 於是 `BE-G`（只寫群組）、`BE_G01`、全形數字寫的編號、
            # `<待確認>`，全部跟「這一格真的沒有 ID」長得一模一樣。
            #
            # 現在：**整格切成段，每一段要嘛是合法 ID、要嘛是宣告過的
            # 阻塞類型，兩者都不是就報。** 週欄與點欄早就是這樣驗的。
            # 用 `plain_field()` 而不是 `plain()` —— 後者會把
            # `<待確認>`、`<!-- BE-G01 -->` 整段刪掉，正規化完是空字串。
            _bsrc = plain_field(blocked)
            found = []
            for _part in re.split(r"[\s+＋、,，]+", _bsrc):
                if not _part or _part in BLOCK_TYPES:
                    continue
                if not _TOKEN.fullmatch(_part):
                    # **這一段完全不合任何文法。** 以前這裡是靜默的。
                    violations.append(
                        f"{cur}：阻塞欄的 {_part} 既不是工作項目 ID、"
                        f"也不是〈阻塞類型〉表裡宣告過的類型"
                        + ("（那張表在 docs/WBS.md，表頭是 "
                           "`| 阻塞類型 | 意思 | 該做什麼 |`，"
                           "現在讀不到任何類型）" if not BLOCK_TYPES else
                           f"（目前宣告過的：{'、'.join(sorted(BLOCK_TYPES))}）"))
                    continue
                _ids, _gids, _errs = scan_ids(_part, f"{cur}：阻塞欄")
                violations.extend(_errs)
                found.extend(_ids)
                # 群組不是阻塞。`BE-G` 擋不住任何一件具體的事，而它原本
                # 被 parse 成功之後直接丟掉 —— parse 成功卻不用，就是漏。
                for _g in _gids:
                    violations.append(
                        f"{cur}：阻塞欄的 {_g} 是群組，不是工作項目 —— "
                        f"阻塞要指到具體哪一項（`{_g}01`）")
            wbs[cur]["blockers"].update(found)
            # **逐列記下「這一列排在哪一週、被什麼擋著」。**
            # 阻塞是寫在列上的，用整個項目最早的週次去比會誤報 ——
            # 一個項目常常前幾列早、後幾列晚，而擋住的只是後面那幾列。
            if found:
                wk_here = [int(m) for m in re.findall(r"W([0-9]+)", week)]
                wbs[cur]["rows"].append((min(wk_here) if wk_here else None, found))

        # 標記的格式在**每一列**都驗。續行上的處置只管那一列，但格式一樣要對 ——
        # 一個沒有理由的 `Cancelled`，六個月後沒有人敢刪它。
        wbs[cur]["detail"].append({"work": _work, "week": week, "pts": pts,
                                   "blk": blocked, "mark": mark})
        if mark:
            violations.extend(check_mark(wid or cur, mark))

        # **整個項目的處置只認它自己那一列。** 續行上的標記只管那一列 ——
        # 例如「隱私與內容政策」底下的「帳號刪除」被取消，不代表整個項目取消。
        # 這一條跟上面那條看起來很像，但方向相反，不要合併。
        if is_id_row:
            wbs[cur]["blocked"] = blocked
            wbs[cur]["mark"] = mark

    # 全文提到的工作項目 ID。**不只阻塞欄** ——
    # 敘述與理由裡也會指來指去（「由 FE-M09 取代」「擋住 FE-S02/03」），
    # 而重整群組之後那些會斷掉，沒有任何東西會發現。實測過：一次斷了五處。
    #
    # 〈舊 ID 去哪了〉那一節例外 —— 它的工作就是提舊 ID。
    #
    # **群組 ID（`FE-O` 這種沒有數字的）也要驗。** 只驗工作項目的話，
    # 重切群組之後 `FE-D`／`FE-I` 這類引用會躺著沒人發現 ——
    # 它們指向的是「整組能力」，斷掉的時候讀的人會去翻一組不存在的東西。
    #
    # **docs/ROADMAP.md 也一起掃**（有的話）。產品意圖那一份靠指向這裡的 ID 活著；
    # 它一旦自己養一份排程或功能表，工作分解表重排之後不會有任何東西發現，
    # 於是同一個 W8 在兩份文件裡變成兩件事 —— 頂端加警告沒有用，
    # 讀的人滑過警告就看表了。排程只放一份，剩下的 ID 由這裡看著。
    #
    # 掃哪幾份見上面的 REF_SOURCES。
    for _src in [pathlib.Path(x) for x in REF_SOURCES]:
        if not _src.exists():
            continue
        in_legacy = False
        # **結構只讀一份。** 圍籬與註解裡是範例不是引用 —— 交給
        # `visible_lines()`；`docs/WBS.md` 那份在上面已經算過，
        # 這裡重算一次會讓同一個結構錯誤報兩次。
        if str(_src) == "docs/WBS.md":
            _vlines, _verrs = _wbs_vis, []
        else:
            _vlines, _verrs = visible_lines(
                _src.read_text(encoding="utf-8"), str(_src))
        violations.extend(_verrs)
        for lineno, line in _vlines:
            # **結構看原始行，ID 看正規化後的字串。** plain() 會剝掉
            # 反引號與 `~`，圍籬那一行過完它就變成空字串了。
            raw = line.strip()
            if raw.startswith("## "):
                # **標題只決定接下來要不要掃，它自己照樣要被掃。**
                # 原本這裡 `continue`，於是 `## APP-D 資料層` 這種
                # 寫在標題裡的懸空群組永遠不會紅。
                in_legacy = raw.startswith(LEGACY_HEADING)
                if in_legacy:
                    continue
            elif in_legacy:
                continue
            # 抽 ID 之前正規化。只認原始字串的話，`FE\u2011D`（非 ASCII
            # 連字號）跟 `<!-- FE-D -->`（註解裡的舊名）一個漏報一個誤報 ——
            # 同一個字串在兩個地方有兩種讀法，就是這支腳本一直在抓的那種漂移。
            s = plain(raw)
            # **同一段字只讀一次。** 這裡以前是三條 regex 各讀一遍、
            # 各有各的邊界，「這一條放掉的交給下一條」—— 而下一條接不住。
            # 現在只有 token 切分與一份文法，見 `scan_ids`。
            ids, gids, errs = scan_ids(s, f"{_src} 第 {lineno} 行")
            refs.extend((i, str(_src), lineno) for i in ids)
            grefs.extend((g, str(_src), lineno) for g in gids)
            violations.extend(errs)

    if not found_table:
        # 檔案在、卻一張工作分解表都認不出來。**這是最安靜的失敗** ——
        # 所有檢查都會「通過」，因為根本沒有東西被檢查。
        violations.append("docs/WBS.md 裡找不到任何工作分解表"
                          "（表頭要是 `| ID | 項目 | 工作 | 週 | 點 | …`，5 欄以上）")

    # 群組、里程碑、跨項依賴 —— --json 的消費端需要，順手在同一趟解析裡收
    _text = wbs_path.read_text(encoding="utf-8")
    # **不要把前綴寫死成 FE/BE。** 這支腳本是共用的；別的專案用 APP-、DEP-、
    # SVC-⋯⋯ 的話整組會被當成不存在，而它的項目照樣算進總數 ——
    # 網頁上少了一整組、計數卻是對的，兩邊都不會報錯。
    for m in re.finditer(r"^## ([A-Z]+-[A-Z]) (.+)$", _text, re.M):
        _groups.append({"id": m.group(1), "title": m.group(2).strip(), "desc": ""})
    for g in _groups:
        seg = _text.split("## " + g["id"] + " ", 1)
        if len(seg) > 1:
            g["desc"] = "\n".join(l[2:] for l in seg[1].split("\n|", 1)[0].splitlines()
                                   if l.startswith("> "))
    # ── 里程碑 ─────────────────────────────────────────────────────
    # **認表頭，不要猜資料列長相。** 這裡原本是
    # `_text.find("## 里程碑")` ＋ `startswith("| **W")`，四種吃法都實測過：
    #
    #   照 `00-map.md` 教的格式寫（第一欄是 `M1 …`）→ milestones 全空，
    #     而 `--check` 照樣 rc=0、網頁的里程碑區塊整塊空白。**最安靜的失敗。**
    #   後面任何章節的 `| **W9** | 41 |`（例如一張「每週負荷」參考表）
    #     → 被吃成一個叫「41」的里程碑。掃到檔尾就會這樣。
    #   `## 里程碑` 剛好在檔首 → `_mi > 0` 為假，整段跳過。
    #   圍籬裡的格式範例 → 這一段讀的是原始檔，不是 `visible_lines()`，
    #     所以示範表格會被當成真資料。
    #
    # 正本是四欄（`00-map.md`）；GuildHub 還在用的兩欄「每週一句話」是
    # **有期限的相容層**：讀得懂、但講清楚它沒有涵蓋資料，三個 repo 遷完就拔。
    _MS_CANON = ["里程碑", "目標週", "驗收結果", "靠哪些"]
    _ms_head, _ms_rows, _in_ms, _ms_bad, _ms_done = None, 0, False, False, False
    for lineno, raw in _wbs_vis:
        # **結構與 ID 看正規化後的字串，顯示欄位留原文。** 兩者混用的代價
        # 實測過：`plain()` 會剝掉 `**` 與 en dash，於是網頁上的里程碑敘述
        # （`md(m.text)` 渲染）粗體全失、破折號變成 ASCII。
        bare = raw.strip()
        s = plain(bare)
        if s.startswith("## "):
            _in_ms = s[3:].strip() == "里程碑"
            if _in_ms:
                _ms_meta["found_heading"] = True
            continue
        if not _in_ms or _ms_done:
            continue
        if not bare.startswith("|"):
            # **一節裡可以有第二張表。** 實測：GuildHub 的〈里程碑〉底下還有
            # 一張「這一項 | 依賴」的跨項依賴表，也是兩欄 —— 不在這裡收手，
            # 那 10 列會變成 10 個里程碑（13 列變 23 列，而且看不出來）。
            # 表在第一個非表格行（空行、小標、說明文字）就結束。
            if _ms_rows:
                _ms_done = True
            continue
        cc_raw = [x.strip() for x in bare.strip("|").split("|")]
        cc = [plain(x) for x in cc_raw]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cc if c):
            continue                                    # `|---|---|` 分隔列
        if _ms_head is None:
            if cc == _MS_CANON:
                _ms_head = "canonical"
            elif len(cc) == 2 and cc[0] == "週":
                # 舊格式：`| 週 | 這一週結束時，使用者能做什麼 |`。
                # **第一欄一定要是「週」**：只認「兩欄」的話，同一節裡那張
                # 「這一項 | 依賴」的跨項依賴表會被當成里程碑表（實測）。
                _ms_head = "legacy_week_goal"
            else:
                violations.append(
                    f"docs/WBS.md 第 {lineno} 行是〈里程碑〉的表頭，但欄位認不出來"
                    f"（{cc}）。正本是 `| 里程碑 | 目標週 | 驗收結果 | 靠哪些 |`；"
                    "舊的兩欄格式仍可讀，但會被標成沒有涵蓋資料")
                _ms_bad = True
                _in_ms = False
            continue
        want = 4 if _ms_head == "canonical" else 2
        if len(cc) != want:
            violations.append(
                f"docs/WBS.md 第 {lineno} 行在〈里程碑〉表裡有 {len(cc)} 欄，"
                f"表頭是 {want} 欄。**欄數對不上那一列就會整列被讀歪**，"
                "不是少一欄就少一個里程碑")
            continue
        _ms_rows += 1
        if _ms_head == "canonical":
            mid = cc[0].split()[0] if cc[0].split() else ""
            covers, _cg, _ce = scan_ids(cc[3], f"docs/WBS.md 第 {lineno} 行")
            violations.extend(_ce)
            if len(covers) != len(set(covers)):
                violations.append(f"里程碑 {mid or cc[0]} 的「靠哪些」裡有重複的 ID")
            # 群組不是涵蓋。`scan_ids` 認得群組、也驗了它存在，但原本收完就丟 ——
            # 寫 `APP-C` 的里程碑於是被當成「沒有指到 APP-C01」，可追溯性報它未涵蓋，
            # 而 `--check` 是綠的（實測）。「靠哪些」逐項列出工作項目 ID。
            for _g in _cg:
                violations.append(f"里程碑 {mid or cc[0]} 的「靠哪些」寫了群組 {_g}："
                                  f"只收工作項目 ID，要逐項列出（例如 `{_g}01`）")
            # 目標週：網頁按週分組靠它配對（`m.w === "W2"`），格式錯那個里程碑就在
            # 週視圖上靜靜變成「尚未排程」。文法跟工作表的週欄一致：範圍用 en dash。
            _tw = re.sub(r"[*`]", "", cc_raw[1]).strip()
            if not re.fullmatch(r"W[0-9]+(–W[0-9]+)?|—", _tw):
                violations.append(f"里程碑 {mid or cc[0]} 的「目標週」要是 `W3`、`W3–W4`（en dash）"
                                  f"或 `—`，現在是「{cc_raw[1]}」")
            _milestones.append({
                "id": mid, "name": cc_raw[0], "target_week": cc[1], "text": cc_raw[2],
                "covers": sorted(set(covers)), "coverage_status": "available",
                "source_format": "canonical",
                # `w` 是給網頁按週分組用的相容欄位，不是新的事實來源。
                "w": cc[1]})
        else:
            _milestones.append({
                "id": cc[0], "name": cc[0], "target_week": cc[0], "text": cc_raw[1],
                # **`None` 不是 `[]`。** 「不知道涵蓋了什麼」跟「涵蓋了零項」
                # 是兩個意思，混在一起，P2 的報告會對舊格式喊出 180 項全未涵蓋。
                "covers": None, "coverage_status": "unavailable",
                "source_format": "legacy_week_goal", "w": cc[0]})
    if _milestones and len({m["id"] for m in _milestones}) != len(_milestones):
        violations.append("〈里程碑〉表裡有重複的里程碑 ID")
    _ms_meta.update(
        schema=_ms_head, rows=_ms_rows,
        coverage_status=("available" if _ms_head == "canonical"
                         else "unavailable" if _ms_head else "unavailable"),
        reason=(None if _ms_head == "canonical" else
                "legacy_milestone_schema_has_no_covers_column"
                if _ms_head == "legacy_week_goal" else
                "milestone_table_not_parsed" if _ms_meta["found_heading"] else
                "no_milestone_section"))
    if _ms_meta["found_heading"] and not _ms_bad and not _ms_rows:
        # 有標題、沒有一列讀得出來。**這正是要報的那件事** ——
        # 不報的話，畫面上是一節正常的里程碑，機器手上是空陣列。
        violations.append(
            "docs/WBS.md 有〈里程碑〉這一節，但一列里程碑都解析不出來"
            f"（表頭：{_ms_head or '認不出來'}）")
    # ── 〈跨項依賴〉────────────────────────────────────────────────
    # 工作項目彼此的先後寫在這裡（阻塞欄只放缺口，見下面「阻塞欄只放缺口」）。
    # **它以前完全沒有驗**，只抽成字串給網頁顯示。GuildHub 的 WBS 自己寫著
    # 「`--check` 不驗前端項目彼此之間的先後……只有人讀得出來」，實測 9 條裡
    # 4 條逆序，其中一條規格已合併、排 W4，依賴的項目排 W9。
    #
    # 正本：`## 跨項依賴` 底下第一張表，表頭固定四欄
    #   | 這一項 | 依賴 | 關係 | 說明 |
    #   這一項  **恰好一個**工作項目 ID。只指某一條驗收的依賴不能寫在項目層級 ——
    #           週次是項目的，驗收沒有週次，排程根本驗不了。同一項可以有多列，每列都要成立
    #   依賴    一個以上 ID，用 `、` 分隔。**不收 `→` 與 `或`**：
    #           `任一` 寫在「關係」；`A → B` 是兩件事，拆成「B 依賴 A」與「這一項依賴 B」
    #   關係    `全部`（每一個都要先完成）／`任一`（至少一個）
    #   說明    自由文字。**這一欄的 ID 不是依賴**（出處、背景寫這裡）
    #
    # 舊的「已知的跨項依賴」兩欄自由文字表是**相容層**：照舊抽給網頁顯示，
    # 但**不驗、不猜** —— 自由文字裡的 ID 不全是依賴（實測：GuildHub 一列的右欄
    # 提到的 `FE-A01` 是那條驗收的出處），照字面抽會誤報。它沒被驗這件事每次跑都會講。
    _XD_CANON = ["這一項", "依賴", "關係", "說明"]
    _xd_head, _in_xd, _xd_done, _xd_bad = None, False, False, False
    for lineno, raw in _wbs_vis:
        bare = raw.strip()
        s = plain(bare)
        if s.startswith("## "):
            _in_xd = s[3:].strip() == "跨項依賴"
            if _in_xd:
                _xdep_meta["found_heading"] = True
            continue
        if not _in_xd or _xd_done:
            continue
        if not bare.startswith("|"):
            if _xdep_meta["rows"]:
                _xd_done = True
            continue
        cc_raw = [x.strip() for x in bare.strip("|").split("|")]
        cc = [plain(x) for x in cc_raw]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cc if c):
            continue
        if _xd_head is None:
            if cc == _XD_CANON:
                _xd_head = "canonical"
            else:
                violations.append(
                    f"docs/WBS.md 第 {lineno} 行是〈跨項依賴〉的表頭，但欄位認不出來"
                    f"（{cc}）。正本是 `| 這一項 | 依賴 | 關係 | 說明 |`")
                _xd_bad, _in_xd = True, False
            continue
        where = f"docs/WBS.md 第 {lineno} 行（〈跨項依賴〉）"
        if len(cc) != 4:
            violations.append(f"{where}有 {len(cc)} 欄，表頭是 4 欄")
            continue
        _xdep_meta["rows"] += 1
        src = cc[0]
        if not re.fullmatch(ID_RE, src):
            violations.append(
                f"{where}的「這一項」要恰好是一個工作項目 ID，現在是「{src}」—— "
                "只指某一條驗收的依賴不能寫在項目層級：拆成有自己週次的項目，或移到驗收層級")
            continue
        if re.search(r"→|->|或", cc[1]):
            violations.append(
                f"{where}的「依賴」不收 `→` 與 `或`：「至少一個」寫在「關係」欄的 `任一`；"
                "`A → B` 是兩件事，拆成「B 依賴 A」與「這一項依賴 B」兩列")
            continue
        parts = [p.strip() for p in cc[1].split("、")]
        if any(not re.fullmatch(ID_RE, p) for p in parts):
            violations.append(
                f"{where}的「依賴」只能是工作項目 ID、用 `、` 分隔，現在是「{cc[1]}」"
                "（說明與出處寫在「說明」欄）")
            continue
        if len(parts) != len(set(parts)):
            violations.append(f"{where}的「依賴」裡有重複的 ID")
        if src in parts:
            violations.append(f"{where}：{src} 依賴自己")
        if cc[2] not in ("全部", "任一"):
            violations.append(f"{where}的「關係」只能是 `全部` 或 `任一`，現在是「{cc[2]}」")
            continue
        _xdep_rows.append({"src": src, "deps": sorted(set(parts) - {src}),
                           "rel": cc[2], "line": lineno})
        _deps.append({"a": cc_raw[0],
                      "b": cc_raw[1] + (f"（{cc_raw[3]}）" if cc_raw[3] else "")})
    if _xdep_meta["found_heading"] and not _xd_bad and not _xdep_meta["rows"]:
        violations.append("docs/WBS.md 有〈跨項依賴〉這一節，但一列都解析不出來")

    # 相容層：舊的「已知的跨項依賴」兩欄自由文字表。照舊抽給網頁顯示，不驗。
    # **認表頭，不認散文**（跟〈里程碑〉同一個做法）：那一句話之後、下一個標題之前的
    # **第一張表**，表頭要是 `| 這一項 | 依賴 |`。原本是「原始檔找這個詞＋往後 2000 字元
    # 裡任何 `| \`` 開頭的兩欄列」—— 一句提到這個詞的散文，加上後面一張無關的兩欄表
    # （例如舊 ID 對照），就被當成舊表；旁邊有正本表時因此誤報「兩份並存」（實測）。
    _legacy, _lg = 0, None          # None 還沒看到那句；seek 找第一張表；in 表內；done
    for lineno, raw in _wbs_vis:
        bare = raw.strip()
        s = plain(bare)
        if _lg is None:
            if "已知的跨項依賴" in s and not bare.startswith("|"):
                _lg = "seek"
            continue
        # 那句話底下沒有舊表（遇到標題、或第一張表的表頭不對）：它只是一段提到這個詞的
        # 散文，**往後繼續找**，不要整份放棄。原本遇到就 break —— 前面一段說明先提了
        # 「底下那張已知的跨項依賴表」，真正的表就靜靜消失、連「沒有被驗」都不講（實測）。
        if s.startswith("#"):
            if _lg == "in":
                break
            _lg = None
            continue
        if not bare.startswith("|"):
            if _lg == "in":
                break
            continue
        cc_raw = [x.strip() for x in bare.strip("|").split("|")]
        cc = [plain(x) for x in cc_raw]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cc if c):
            continue
        if _lg == "seek":
            _lg = "in" if cc == ["這一項", "依賴"] else None
            continue
        if len(cc_raw) == 2:
            _legacy += 1
            if not _xd_head:
                _deps.append({"a": cc_raw[0], "b": cc_raw[1]})
    if _legacy and _xd_head:
        violations.append(
            "docs/WBS.md 同時有〈跨項依賴〉正本表與舊的「已知的跨項依賴」表 —— "
            "兩份會漂，遷完就刪掉舊的那張")
    elif _legacy:
        _xdep_meta.update(schema="legacy_free_text", rows=_legacy,
                          reason="legacy_cross_dep_table_is_free_text")
    if _xd_head == "canonical":
        _xdep_meta.update(schema="canonical", ordering_status="available", reason=None)
    elif _xdep_meta["found_heading"] and _xdep_meta["schema"] is None:
        # 有這一節、卻解析不出來：跟「沒有這張表」是兩件事（網頁要講的話也不同）。
        _xdep_meta["reason"] = "cross_dep_table_not_parsed"

# ── OpenSpec 的實際狀態 ────────────────────────────────────────────
def tasks_progress(d: pathlib.Path):
    f = d / "tasks.md"
    if not f.is_file():
        return None
    body = f.read_text(encoding="utf-8")
    done = len(re.findall(r"^\s*-\s*\[[xX]\]", body, re.M))
    todo = len(re.findall(r"^\s*-\s*\[ \]", body, re.M))
    return done, done + todo

changes = {}
cdir = pathlib.Path("openspec/changes")
if cdir.is_dir():
    for d in sorted(p for p in cdir.iterdir() if p.is_dir() and p.name != "archive"):
        changes[d.name] = {"state": "active", "prog": tasks_progress(d)}
adir = cdir / "archive"
if adir.is_dir():
    for d in sorted(p for p in adir.iterdir() if p.is_dir()):
        # 目錄名是 <YYYY-MM-DD>-<change-id>
        cid = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", d.name)
        changes[cid] = {"state": "archived", "prog": tasks_progress(d)}

# 遠端分支：有人正在動的 change
branches = collections.defaultdict(set)
try:
    out = subprocess.run(["git", "branch", "-r", "--format=%(refname:short)"],
                         capture_output=True, text=True, check=True).stdout
    for b in out.split():
        b = b.replace("origin/", "", 1)
        m = re.match(r"^(spec|feat|fix|archive)/([a-z0-9-]+?)(?:--.*)?$", b)
        if m:
            branches[m.group(2)].add(m.group(1))
except Exception:
    pass

def changes_for(wid):
    """一個工作項目底下**所有**對得上的 change。

    原本只回傳 `hits[0]`，而 `matched` 是用它算的 —— 於是同一個 ID 開
    兩個 change（`fe-c01-api`／`fe-c01-ui`）時，第二個永遠不在 `matched`
    裡，會被當成「命名不合規的孤兒」印出來。**一個 ID 只准一個 change**
    這條規則沒有人講過，是 `[0]` 順手訂下的。
    """
    pre = wid.lower()
    # **排序 —— 字典的插入順序（先 active 後 archived）不該影響任何判斷。**
    # 不排的話，「第一個」剛好永遠是 active 的那個，於是「聚合」跟「只看第一個」
    # 在這份資料上同解，兩者的差別觀察不到（外部審查的存活突變之一）。
    return sorted(c for c in changes if c == pre or c.startswith(pre + "-"))


def setup_todo():
    """**剛複製的模板還缺什麼。** 回傳待辦清單（空的代表都設好了）。

    這些事以前只寫在 README 與 AGENTS.md 裡。**寫在文件裡就是規勸** ——
    而這個模板自己的第一句話就是「規勸不是機制」。所以改成由腳本說：
    `CLAUDE.md` 第 2 步就叫人／LLM 跑這支腳本，跑了就會看到。
    """
    todo = []
    if not pathlib.Path("docs/WBS.md").exists():
        todo.append((
            "還沒有 docs/WBS.md（工作分解表）—— 這個專案還沒有地圖",
            "先跑 prompts/00-map.md：問全貌，攤成一張表。第一欄是工作項目 ID（`XX-Y01`），"
            "格式見那份 prompt 的範例，或 AGENTS.md〈改 docs/WBS.md 之前〉。"
            "沒有它就沒有「還有哪些沒做、下一步是什麼」的視角，每個 change 也對不回任何工作。"))
    elif not BLOCK_TYPES:
        todo.append((
            "docs/WBS.md 裡沒有〈阻塞類型〉表",
            "阻塞欄的類型詞彙是從那張表讀的，腳本裡沒有寫死任何一個詞。"
            "加一張表頭是 `| 阻塞類型 | 意思 | 該做什麼 |` 的表，"
            "宣告你這個專案的詞（`待銜接`、`待裁決`⋯⋯隨你）。"
            "沒有它的話，阻塞欄只能放 ID。"))
    pkg = pathlib.Path("package.json")
    if pkg.is_file():
        try:
            _s = pkg.read_text(encoding="utf-8")
        except Exception:
            _s = ""
        if "還沒設定" in _s:
            todo.append((
                "package.json 的 script 還是刻意會失敗的佔位",
                "建專案時把 lint／typecheck／test／build 設好，"
                "或把 ci.yml 裡對應的那幾步刪掉。不動它的話 CI 的 quality 一直是紅的。"))
    if pathlib.Path("SETUP-GITHUB.md").is_file():
        todo.append((
            "SETUP-GITHUB.md 還在",
            "建 repo 的人做一次（ruleset、code owner），**設完就可以刪掉這個檔案**。"
            "它還在就代表這一步可能還沒做 —— 沒做的話 GitHub 那道門是開的。"
            "它的〈8. 不在版控裡的那一半〉（這台機器的 setup.mjs --check、plugin 名單重判、真源 targets.json）本腳本看不到，也靠這個檔案佔位。"))
    return todo


def change_ids_for(wid):
    """狀態計算要用的**清單**（可能是空的）。顯示用的字串在 `change_label()`。

    只回 `hits[0]` 的話，第二個 change 既不在列上、也不在孤兒清單、
    也不在 `--json` 裡 —— 它從整個輸出消失。以前是錯訊號（被當成孤兒），
    改成 `changes_for` 之後變成**沒有訊號**，那更糟。

    **這裡曾經回傳顯示字串，那是一個沉默的 bug。** 2026-09-07 實測：
    原本多個 change 時回傳 `f"{hits[0]} +{n}"`，而下游拿它去
    `changes.get(cid, {})` —— 那個鍵永遠不存在，於是 `c = {}`、`br = set()`，
    四個判斷全不成立，掉進 `else` 報「有分支」。

        FE-W04  有兩個 change（兩個都已封存）  有分支  fe-w04-physics +1

    **一個項目只要有兩個 change，就永遠算不出「已封存」。**
    根因不是判斷寫錯，是**顯示字串與查詢鍵共用同一個回傳值** ——
    所以這裡拆成兩支：算狀態的拿清單，印出來的才做格式化。
    """
    # `changes_for()` 已經排好序了 —— **排序只有一個來源**。這裡再排一次的話，
    # 兩個排序會互相遮蔽：任一邊被拿掉，另一邊都會把它補回來，於是兩邊都
    # 「拿掉也不會紅」（實測過，兩個突變各自存活）。
    hits = changes_for(wid)
    if not hits:
        # 分支推出來的那一份也要排 —— 它不經過 changes_for。
        hits = sorted(c for c in branches if c == wid.lower()
                      or c.startswith(wid.lower() + "-"))
    return hits


def change_label(hits):
    """列上顯示哪一個。**多個的時候要看得出來有多個。** 只用來印，不要拿去查表。"""
    if not hits:
        return None
    return hits[0] if len(hits) == 1 else f"{hits[0]} +{len(hits) - 1}"

# ── 輸出 ───────────────────────────────────────────────────────────
rows, tally = [], collections.Counter()
# 分組統計。**不同前綴是不同性質的東西** —— 例如「後端能力缺口」跟前端工作
# 混在同一個總數裡，會讓「還有多少沒做」看起來像是我們排得動的。
by_group = collections.defaultdict(collections.Counter)
# 缺口 → 它擋住哪些項目。從各項目的「阻塞」欄反推，沒有人維護。
blocks = collections.defaultdict(set)
_state_of = {}
# 「耐久狀態」：**從這份 tree 重建得出來的那一半。**
# 「規格審查中」「實作中」「有分支」是從遠端分支推的 —— 分支開了或刪了、
# repo 沒有新 commit，那個狀態當下就過期。把它寫進版控等於把一個當下的
# 東西凍成一份紀錄，所以 WBS 的機器區塊只放這一份。
_durable_of = {}
_week_ids = set()        # `--week` 之下落在那一週的項目（只給顯示用；狀態照樣每一項都算）
for wid in order:
    info = wbs[wid]
    wk = sorted(info["weeks"])
    weeks = ",".join(wk) or "—"
    # 逐個 token 比對，不能用子字串 —— 否則 W1 會配到 W10/W11/W12。
    # 範圍寫法（W1–W5）展開成區間再判斷。
    def covers(tok, want):
        if tok == want:
            return True
        m = re.fullmatch(r"W(\d+)–W(\d+)", tok)
        if m and re.fullmatch(r"W(\d+)", want):
            return int(m.group(1)) <= int(want[1:]) <= int(m.group(2))
        return False
    # **`--week` 只是顯示篩選，不准在算出狀態之前 `continue`。** 原本這裡直接跳過，
    # 於是不在那一週的項目在 `_state_of`、`blocks` 裡不存在 —— 依賴圖、週次日曆、
    # 缺口規則全部拿到殘缺的表：`--week W2 --check` 對同一份 WBS 紅、不加 `--week`
    # 綠（實測），`--week W1 --json` 直接 KeyError。狀態對每一項都算，篩選只管顯示。
    _in_week = not ONLY_WEEK or any(covers(t, ONLY_WEEK) for t in wk)

    # 人為決定 —— 機器算不出來的那些。理由寫在同一格，用 ｜ 隔開。
    # 標記可以複合：`Alarm+Pending｜理由`。Alarm 是風險訊號，**跟其他標記並存**，
    # 不取代它們；TBD / Pending / Cancelled / Regular 之間才互斥。
    mark = info.get("mark", "")
    marks, mark_reason = parse_mark(mark)
    exclusive = marks & MARKS_EXCLUSIVE
    # 互斥值同時出現已經在上面報成違規了，這裡只是不要當掉。
    mark_word = sorted(exclusive)[0] if exclusive else ""
    blocked = info.get("blocked", "") or "、".join(sorted(info.get("blockers", ())))

    # `cids` 算狀態，`cid` 只拿來印。**不要把 cid 拿去查任何字典** ——
    # 多個 change 時它是 `"fe-x01-a +1"` 這種顯示字串，查不到任何東西。
    cids = change_ids_for(wid)
    cid = change_label(cids)
    durable = None   # 只有「看了遠端分支」的那一支要覆寫它

    # **有週次就是排得動。** 一個項目底下某一列被擋住，不代表整個項目做不了 ——
    # 那樣會把「可以先做一半」藏起來，而那正是最需要被看見的部分。
    # 所以只有「完全沒有週次」才算做不了，有週次的阻塞只當註記。
    schedulable = bool(wk)

    if mark_word == "Regular":
        # 常態性工作，沒有完成點 —— 拿它跟有終點的項目一起算進度是沒有意義的。
        state, detail, colour = "常態", "", D
    elif mark_word == "Cancelled":
        # 決定不做。**不算未開始** —— 那會讓「還有多少沒做」永遠虛高。
        reason = mark_reason
        if any(changes.get(c, {}).get("state") == "archived" for c in cids):
            # 標成不做，卻有 change 已經封存了 —— 兩個真實來源打架。
            # **不要挑一個信**，把矛盾攤出來讓人去改。
            state, detail, colour = "矛盾", f"標 Cancelled 但 {cid} 已封存", R
        else:
            state, detail, colour = "已取消", reason, D
    elif mark_word == "Done" and cids:
        # 有 change 就不要手寫 Done —— 狀態算得出來，兩個來源就會漂。
        # **不要挑一個信**，把矛盾攤出來讓人去改（跟 Cancelled 同一個處置）。
        state, detail, colour = "矛盾", f"標 Done 但有 change {cid}，狀態算得出來", R
    elif mark_word == "Done":
        # 做完了、但**沒有跟它同名的 change**。這是規則互斥造成的結構性盲區，
        # 不是誰忘了開 change：改 `.github/` 只能走 `governance/`，而
        # `governance/` 不准碰 `openspec/`，所以治理工作永遠對不到 change。
        #
        # 狀態叫「已完成」不叫「已封存」—— **這一格是人宣告的，機器沒有驗過
        # 任何東西。** 借用 OpenSpec 的字會讓兩種強度不同的結論長得一樣。
        # 理由欄要寫出憑什麼（PR 號、commit），那要人讀 diff 去對。
        state, detail, colour = "已完成", mark_reason, G
    elif not cids and not schedulable and (blocked or mark_word in ("Pending", "TBD")):
        state = "待裁決" if mark_word == "TBD" else "等外部"
        detail, colour = blocked or mark, R
    elif not cids:
        state, detail, colour = "未開始", "", D
    else:
        # **聚合，不是挑第一個。** 每一個判斷都看全部 change：
        #   全部封存        → 已封存（少一個沒封存就不是，那還有東西在動）
        #   任一個有實作分支 → 實作中
        #   任一個還 active  → 規格已合併
        # 「一個封存、一個還在做」不是矛盾，是正常的分段交付 —— 它會落在
        # 「實作中／規格已合併」，因為還有東西在動，那才是要被看見的事。
        cs = [changes.get(c, {}) for c in cids]
        brs = set().union(*(branches.get(c, set()) for c in cids))
        states = [c.get("state") for c in cs]
        # 進度條只在單一 change 時顯示 —— 多個 change 的 x/y 相加沒有意義。
        prog = cs[0].get("prog") if len(cs) == 1 else None
        bar = ""
        if prog and prog[1]:
            bar = f"{prog[0]}/{prog[1]}"
        if states and all(s == "archived" for s in states):
            state, detail, colour = "已封存", f"{cid}", G
        elif "feat" in brs or "fix" in brs:
            state, detail, colour = "實作中", f"{cid} {bar}".strip(), Y
        elif "active" in states:
            state, detail, colour = "規格已合併", f"{cid} {bar}".strip(), Y
        elif "spec" in brs:
            state, detail, colour = "規格審查中", f"{cid}", Y
        else:
            state, detail, colour = "有分支", f"{cid}", Y
        # 同一次判斷裡把「不看遠端分支會是什麼」也算出來。
        # **不要事後從 state 反推** —— 那是同一件事算兩次，遲早會分岔。
        if states and all(s == "archived" for s in states):
            durable = "已封存"
        elif "active" in states:
            durable = "規格已合併"
        else:
            durable = "未開始"
    # Alarm 不是狀態，是警示 —— 疊在算出來的狀態上，不取代它。
    if "Alarm" in marks:
        detail = (detail + " ⚠").strip()
    # 反向索引：這個項目被哪些缺口擋著。**用算的** ——
    # 手寫一份「這個缺口擋住哪些項目」的清單，是同一件事寫在兩個地方。
    for gap in info.get("blockers", ()):
        blocks[gap].add(wid)
    # 排得動但有部分被擋住：註記，不改狀態。
    if schedulable and blocked and state not in ("已取消", "常態"):
        detail = (detail + f" ({blocked} 擋住部分)").strip()
    if len(detail) > 44:
        detail = detail[:43] + "…"

    _state_of[wid] = state
    _durable_of[wid] = durable if durable is not None else state
    if not _in_week:
        continue
    _week_ids.add(wid)
    tally[state] += 1
    by_group[re.sub(r"[0-9]+$", "", wid)][state] += 1
    if ONLY_BLOCKED and state not in ("等外部", "待裁決"):
        continue
    if state == "未開始" and not (SHOW_ALL or ONLY_BLOCKED):
        continue
    # 名稱裡的 markdown 強調符號在終端機是雜訊，拿掉。
    label = re.sub(r"[*`]", "", info["name"])[:18]
    rows.append((colour, wid, label, weeks, info["pts"], state, detail))

# ── 治理不變量 ─────────────────────────────────────────────────────
def week_min(wk):
    """一個項目最早的週次。`W1–W5` 取 1。"""
    ns = [int(m) for tok in wk for m in re.findall(r"W([0-9]+)", tok)]
    return min(ns) if ns else None

for wid in order:
    info = wbs[wid]
    marks, _ = parse_mark(info.get("mark", ""))
    # 缺口（沒有工作週次、被別的項目依賴）必須說清楚「最晚何時要答案」
    # 與「沒答案怎麼辦」。**只寫在導言說「每一項都要有」是宣言，不是機制。**
    is_gap = not info["weeks"] and wid in blocks
    if is_gap and "Cancelled" not in marks:
        if info["deadline"] is None:
            violations.append(f"{wid}：缺口沒有決策期限（週欄寫 `決策≤Wn`）")
        if not info["fallback"]:
            violations.append(f"{wid}：缺口沒有 fallback（在敘述裡寫 `【沒答案就】…`）")

_gids = {g["id"] for g in _groups}
seen_gref = set()
for gid, fname, ln in grefs:
    # 一張群組都認不出來的話不驗 —— 那是別的問題（沒有 WBS 或標題格式壞了），
    # 在這裡報一堆「群組不存在」只會蓋掉真正的訊號。
    if not _gids or gid in _gids or (gid, fname) in seen_gref:
        continue
    seen_gref.add((gid, fname))
    violations.append(f"{fname} 第 {ln} 行提到的群組 {gid} 不存在"
                      f"（重整群組之後斷掉的引用？）")

seen_ref = set()
for rid, fname, ln in refs:
    if rid in wbs or (rid, fname) in seen_ref:
        continue
    seen_ref.add((rid, fname))
    violations.append(f"{fname} 第 {ln} 行提到的 {rid} 不存在"
                      f"（重整群組之後斷掉的引用？）")

for wid in order:
    info = wbs[wid]
    seen = set()
    for start, gaps in info["rows"]:
        for gap in gaps:
            if gap not in wbs:
                if (wid, gap) not in seen:
                    # 打錯的依賴（`BE-G99`）原本靜默通過，
                    # 而且第五條也就跟著不驗。
                    violations.append(f"{wid}：依賴的 {gap} 在這張表裡不存在")
                    seen.add((wid, gap))
                continue
            # **阻塞欄只放缺口。** 網頁與 Excel 的「銜接清單是哪一組」
            # 完全建立在這件事上：它們把「被寫進阻塞欄的項目所屬的組」
            # 整組當成銜接清單。所以把一個**有工作週次**的項目寫進阻塞欄，
            # 那一組會整組從「在我們手上」翻成「等外部」，而 --check 是綠的。
            # 前端項目彼此的先後不寫在這裡，寫在〈跨項依賴〉。
            if wbs[gap]["weeks"]:
                if (wid, gap, "wk") not in seen:
                    violations.append(
                        f"{wid}：阻塞欄的 {gap} 有工作週次（{'、'.join(sorted(wbs[gap]['weeks']))}），"
                        f"它不是缺口 —— 前端項目彼此的先後寫在〈跨項依賴〉，不寫在阻塞欄")
                    seen.add((wid, gap, "wk"))
                continue
            dl = wbs[gap].get("deadline")
            if dl is None or start is None:
                continue
            # 「這件事排在 W4，而它依賴的裁決最晚也是 W4」不是排程，是碰運氣。
            # 裁決要**嚴格早於**用得到它的那一週。
            if start <= dl:
                violations.append(
                    f"{wid}（W{start} 那一列）排在 {gap} 的決策期限"
                    f"（決策≤W{dl}）之前或同週 —— 要嘛提前裁決，要嘛把工作往後挪")

# ── 依賴圖（2026-09-25）────────────────────────────────────────────
# 兩張圖、各自的檢查，**分母都要講出來**：一個今天評估 0 條邊的檢查，
# 在真實 repo 上「通過」跟「根本沒看」長得一模一樣（`--json` 的 `dep_graph`）。
def week_max(wk):
    """一個項目最晚的週次。`W1–W5` 取 5。"""
    ns = [int(m) for tok in wk for m in re.findall(r"W([0-9]+)", tok)]
    return max(ns) if ns else None


def find_cycles(g):
    """圖裡的環，各轉到最小節點開頭、去重。DFS 每條回邊給一個環 ——
    不是列出所有簡單環，但**有環就一定至少報一個**，這裡要的只是這個保證。"""
    found, out, colour, stack = set(), [], {}, []

    def dfs(n):
        colour[n] = 1
        stack.append(n)
        for m in sorted(g.get(n, ())):
            c = colour.get(m, 0)
            if c == 1:
                cyc = stack[stack.index(m):]
                k = cyc.index(min(cyc))
                cyc = cyc[k:] + cyc[:k]
                if tuple(cyc) not in found:
                    found.add(tuple(cyc))
                    out.append(cyc)
            elif c == 0:
                dfs(m)
        stack.pop()
        colour[n] = 2

    for n in sorted(g):
        if colour.get(n, 0) == 0:
            dfs(n)
    return out


# 「完成」：有 change 的項目看**所有** change 都封存（上面的聚合已經是這樣算的，
# 一個封存、一個還在做會落在「實作中」）；沒有 change 的治理項目看 `Done`。
# 兩者互斥 —— 有 change 的項目不准標 `Done`。
DONE_STATES = ("已封存", "已完成")

# (1) 阻塞欄：自環與環。阻塞欄只放缺口（上面那條），兩端都有週次的邊在這裡
#     **結構上不可能** —— 所以排程逆序不在這裡驗，在〈跨項依賴〉驗。
#     但沒有規則禁止「缺口擋缺口」，繞成一圈就是誰都等不到的死結。
_bedges = sorted({(w, g) for w in order for g in wbs[w]["blockers"] if g in wbs})
_bg = collections.defaultdict(set)
_bself = 0
for w, g in _bedges:
    if w == g:
        _bself += 1
        violations.append(f"{w}：阻塞欄指向自己")
    else:
        _bg[w].add(g)
_bcycles = find_cycles(_bg)
for cyc in _bcycles:
    violations.append("阻塞欄繞成一圈：" + " → ".join(cyc + [cyc[0]])
                      + "（缺口擋缺口，誰都等不到）")

# (2) 阻塞欄：已完成，卻還掛著指向「待裁決」缺口的邊。
#     **只看「待裁決」。** 共識原文是「已完成項目仍掛著**未裁決**缺口」。
#     `待銜接`（本地做完、真後端之後對齊）的邊掛在已封存的項目上是正常狀態，
#     不是忘了刪 —— GuildHub 實測已封存又掛著邊的 5 項裡，4 項是這種。
#     缺口裁決之後，那條 `待裁決` 邊要刪或改寫；沒裁決，就表示這一項其實沒做完。
_bd7 = 0
for w in order:
    if _state_of.get(w) not in DONE_STATES:
        continue
    for g in sorted(wbs[w]["blockers"]):
        if g != w and _state_of.get(g) == "待裁決":
            _bd7 += 1
            violations.append(
                f"{w}：狀態是「{_state_of[w]}」，阻塞欄卻還指向「待裁決」的 {g} —— "
                f"{g} 裁決了就刪掉或改寫這條邊；還沒裁決，就表示 {w} 其實還沒做完")

# (3) 〈跨項依賴〉（只有正本表）：排程逆序、環、已完成而前置沒完成。
#     判準：被依賴者最晚週 <= 依賴者最早週。**同週合法** —— 一週是排程桶，
#     不是順序。`W13–W16` 被 `W16` 依賴合法，被 `W15` 依賴不合法。
#     每一條邊恰好落進一個桶：評估、或四種跳過之一。加總要等於邊數（測試釘住）。
_xd = {"edges": 0, "evaluated": 0, "skipped_dep_missing": 0,
       "skipped_src_no_week": 0, "skipped_dep_cancelled": 0,
       "skipped_dep_no_week": 0, "reversed": [], "cycles": [], "done_before_deps": 0}
_xg = collections.defaultdict(set)
for r in _xdep_rows:
    src, deps, rel = r["src"], r["deps"], r["rel"]
    smin = week_min(wbs[src]["weeks"]) if src in wbs else None
    ok_any, bad_here, evaluated_here = False, [], 0
    for dep in deps:
        _xg[src].add(dep)
        _xd["edges"] += 1
        if dep not in wbs or src not in wbs:
            _xd["skipped_dep_missing"] += 1        # 不存在的 ID 由引用掃描報，這裡不重複
            continue
        if smin is None:
            _xd["skipped_src_no_week"] += 1
            continue
        if "Cancelled" in parse_mark(wbs[dep].get("mark", ""))[0]:
            _xd["skipped_dep_cancelled"] += 1
            continue
        dmax = week_max(wbs[dep]["weeks"])
        if dmax is None:
            _xd["skipped_dep_no_week"] += 1
            # 缺口（沒有工作週次、有 `決策≤Wn`）寫在這裡會繞過不變量 5 —— 同一條依賴
            # 寫在阻塞欄會被抓到「工作排在決策期限之前或同週」。跟「阻塞欄只放缺口」
            # 對稱：這一張只放工作→工作。
            if wbs[dep].get("deadline") is not None:
                violations.append(
                    f"〈跨項依賴〉第 {r['line']} 行：{dep} 是缺口（決策≤W{wbs[dep]['deadline']}、"
                    f"沒有工作週次）—— 缺口寫在 {src} 的阻塞欄，這一張只放工作項目彼此的先後")
            else:
                # 沒有週次、也不是缺口（沒排週次的項目、或常態 Regular）：排不出先後，
                # 原本靜靜落進這個桶，同一列另一條邊被評估到時連分母那行都不印（實測）。
                # 常態的東西沒有完成點 —— 真的要依賴，拆出一個有週次的一次性項目
                # （例如「管線可用」）再依賴它（第十四輪兩位一致）。
                violations.append(
                    f"〈跨項依賴〉第 {r['line']} 行：{dep} 沒有工作週次，排不出先後 —— "
                    f"先替它排週次；常態的東西拆出一個有週次的一次性項目再依賴它")
            continue
        _xd["evaluated"] += 1
        evaluated_here += 1
        if dmax <= smin:
            ok_any = True
        else:
            bad_here.append((dep, dmax))
    rev = bad_here if rel == "全部" else (bad_here if evaluated_here and not ok_any else [])
    for dep, dmax in rev:
        _xd["reversed"].append({"src": src, "dep": dep, "src_min": smin,
                                "dep_max": dmax, "rel": rel, "line": r["line"]})
        violations.append(
            f"{src}（最早 W{smin}）依賴 {dep}（最晚 W{dmax}）—— 被依賴的要在同一週或更早"
            f"（〈跨項依賴〉第 {r['line']} 行"
            + ("；關係是「任一」，沒有一個來得及" if rel == "任一" else "") + "）")
    if _state_of.get(src) in DONE_STATES:
        done = [d for d in deps if _state_of.get(d) in DONE_STATES]
        missing = [d for d in deps if d in wbs and _state_of.get(d) not in DONE_STATES]
        if missing and (rel == "全部" or not done):
            _xd["done_before_deps"] += 1
            # 前置「已取消」跟「還沒完成」是兩件事，處置也不同：取消了還做完，
            # 通常是改用別的做法 —— 那這一列的依賴已經過時，要改寫，不是去補做前置。
            _cx = [d for d in missing if _state_of.get(d) == "已取消"]
            _nd = [d for d in missing if d not in _cx]
            _why = "、".join(
                ([f"它依賴的 {'、'.join(_nd)} 還沒完成"] if _nd else [])
                + ([f"它依賴的 {'、'.join(_cx)} 已取消（改用別的做法完成的話，改寫這一列："
                    f"刪掉或換成實際依賴的項目）"] if _cx else []))
            violations.append(
                f"{src}：狀態是「{_state_of[src]}」，但{_why}"
                f"（〈跨項依賴〉第 {r['line']} 行，關係「{rel}」）—— 兩邊的紀錄有一邊是錯的")
_xd["cycles"] = find_cycles(_xg)
for cyc in _xd["cycles"]:
    violations.append("〈跨項依賴〉繞成一圈：" + " → ".join(cyc + [cyc[0]]))

_dep_graph = {
    "blockers": {"edges_scanned": len(_bedges),
                 "gap_to_gap_candidates": sum(1 for w, g in _bedges if not wbs[w]["weeks"]),
                 "self_loops": _bself, "cycles": _bcycles,
                 "done_with_undecided_gap": _bd7},
    "cross_deps": dict(_xdep_meta, **(_xd if _xdep_meta["schema"] == "canonical" else {})),
}

# ── 里程碑可追溯性（2026-09-25）────────────────────────────────────
# **報告，不擋。** 哪些 WBS ID 沒有被任何一個里程碑的「靠哪些」指到。
# 它不是「100% 法則」—— 只證明有一條引用邊，證明不了語意上真的涵蓋，
# 更證明不了沒有漏掉還沒寫進 WBS 的範圍。
#
# 單位是 **WBS ID**，不是每一列：續行列沒有 ID，引用不到它。
# 不算 `Cancelled`（決定不做）與 `Regular`（常態、沒有完成點）。
# **不用週次截斷**：已經細化、只是還沒排週次的工作，截掉就被靜默排除了。
# 分兩組：① 已排週次卻沒被指到（該處理的）；② 沒排週次／遠期粗粒度而沒被指到。
#
# 舊的兩欄里程碑沒有「靠哪些」：`status: unavailable`，清單是 `None`，
# **不是 `[]`** —— 「不知道」與「全部被指到」是兩件事；也不是「全部未涵蓋」。
def _excluded_from_trace(w):
    ms, _ = parse_mark(wbs[w].get("mark", ""))
    return bool({"Cancelled", "Regular"} & set(ms))


if _ms_meta["schema"] == "canonical":
    _covered = set().union(*(set(m["covers"] or []) for m in _milestones))
    _pool = [w for w in order if not _excluded_from_trace(w)]
    _unc = [w for w in _pool if w not in _covered]
    _trace = {
        "status": "available", "reason": None, "unit": "wbs_id",
        "pool": len(_pool), "covered": [w for w in _pool if w in _covered],
        "uncovered_scheduled": [w for w in _unc if week_min(wbs[w]["weeks"]) is not None],
        "uncovered_unscheduled": [w for w in _unc if week_min(wbs[w]["weeks"]) is None],
        "excluded": [w for w in order if _excluded_from_trace(w)],
    }
else:
    _trace = {"status": "unavailable", "reason": _ms_meta["reason"], "unit": "wbs_id",
              "pool": None, "covered": None, "uncovered_scheduled": None,
              "uncovered_unscheduled": None, "excluded": None}

# ── 週次錨點（2026-09-25）──────────────────────────────────────────
# **純報告，exit 0。** 時間不能進 `--check` 的退出碼：同一份程式碼今天測跟明天測
# 結果要一樣（CI 冪等性）；放一個週末，無關的 PR 會突然變紅；人會學會把錨點往後推。
#
# 週次（W1、決策≤W5）本來沒有錨：W1 是哪一天沒人知道，所以 `決策≤W5` 在期限**過了之後**
# 永遠不會出聲。一張放了三個月的地圖，每條規則都綠，期限全是過去式。
#
#   <!-- wbs:week1 2026-10-05 Asia/Taipei -->
#
# 人設一次、只能有一個、**時區寫明**（台北與 UTC 的 CI 在換日那幾小時會差一天）。
# 不從 git 第一個 commit 推：匯入歷史、rebase、shallow clone 都會讓它無聲失真；
# 人改日期至少 diff 看得見。W1 是錨點起的七天；`決策≤W1` 在 W2 第一天才算過期。
# `--as-of YYYY-MM-DD` 把「今天」換掉 —— 測試不准依賴真實時鐘。
#
# 缺口三態。**「已裁決」看缺口算出來的狀態**：終態是 `已完成`（`Done`，理由欄寫答案）
# 或 `已取消`（`Cancelled`）。其他（等外部、待裁決、未開始）都追：截止前 `waiting`，
# 截止後 `fallback_effective`。fallback（`【沒答案就】…`）是強制寫的，期限到了語意上
# 就生效了 —— 報告講的是「fallback 已自 Wn 起生效」，不是永遠叫「未決」。
# （曾經定成「看 `待裁決` 類型的阻塞邊消失」：GuildHub 26 個有期限的缺口，指向它們的
# 邊沒有一條是 `待裁決` 類型 —— 全部會被判成已裁決，這個機制永遠不出聲。）
import datetime as _dt
try:
    import zoneinfo as _zi
except ImportError:                                   # Python < 3.9
    _zi = None
_cal = {"status": "disabled", "reason": "no_anchor", "anchor": None, "tz": None,
        "as_of": None, "current_week": None, "gaps": [],
        "counts": {"waiting": 0, "decided": 0, "fallback_effective": 0}}
_deadline_gaps = [w for w in order if wbs[w].get("deadline") is not None]
_cal["deadline_gaps"] = len(_deadline_gaps)
_ANCHOR = re.compile(r"^<!--\s*wbs:week1\s+(\d{4}-\d{2}-\d{2})\s+(\S+)\s*-->$")
_alines = []
if wbs_path.is_file():
    # HTML 註解：`visible_lines()` 會把它拿掉，所以這裡讀原文。圍籬裡的不算。
    _fence = None
    for _ln, _raw in enumerate(wbs_path.read_text(encoding="utf-8").splitlines(), 1):
        _m = _FENCE.match(_raw.strip())
        if _m and _fence is None:
            _fence = _m.group(1)
            continue
        if _fence is not None:
            if _FENCE_CLOSE.match(_raw.strip()) and _raw.strip().startswith(_fence[0] * len(_fence)):
                _fence = None
            continue
        if "wbs:week1" in _raw:
            _alines.append((_ln, _raw.strip()))
if len(_alines) > 1:
    violations.append("docs/WBS.md 有 " + str(len(_alines)) + " 行週次錨點（第 "
                      + "、".join(str(l) for l, _ in _alines) + " 行）——只能有一個")
    _cal["reason"] = "multiple_anchors"
elif _alines:
    _ln, _raw = _alines[0]
    _m = _ANCHOR.match(_raw)
    _anchor_date = _tz = None
    if not _m:
        violations.append(f"docs/WBS.md 第 {_ln} 行的週次錨點格式不對："
                          "要是 `<!-- wbs:week1 YYYY-MM-DD 時區 -->`（時區寫 IANA 名稱，例如 Asia/Taipei）")
        _cal["reason"] = "anchor_malformed"
    else:
        try:
            _anchor_date = _dt.date.fromisoformat(_m.group(1))
        except ValueError:
            violations.append(f"docs/WBS.md 第 {_ln} 行的週次錨點日期不存在：{_m.group(1)}")
            _cal["reason"] = "anchor_malformed"
        try:
            _tz = _zi.ZoneInfo(_m.group(2)) if _zi else None
        except Exception:
            _tz = None
        if _tz is None:
            violations.append(f"docs/WBS.md 第 {_ln} 行的週次錨點時區認不出來：{_m.group(2)}"
                              "（要 IANA 名稱，例如 Asia/Taipei、UTC）")
            _cal["reason"] = "anchor_malformed"
    if _anchor_date and _tz:
        if AS_OF:
            _today = _dt.date.fromisoformat(AS_OF)   # 開頭已經驗過格式
        else:
            _today = _dt.datetime.now(_tz).date()
        _days = (_today - _anchor_date).days
        _cw = _days // 7 + 1 if _days >= 0 else 0    # 錨點之前是 W0（還沒開始）
        _cal.update(status="enabled", reason=None, anchor=_anchor_date.isoformat(),
                    tz=_m.group(2), as_of=_today.isoformat(), current_week=_cw)
        for _g in _deadline_gaps:
            _n = wbs[_g]["deadline"]
            _st = _state_of.get(_g)
            # 終態跟依賴圖的「完成」同一個定義（有 change 的看全部封存、沒有的看 Done），
            # 再加已取消。原本只認 Done／Cancelled：有 change 的項目不准標 Done，
            # 於是用 change 做掉的缺口永遠不會被判已裁決（實測）。
            if _st in DONE_STATES + ("已取消",):
                _cs, _since = "decided", None
            elif _cw <= _n:
                _cs, _since = "waiting", None
            else:
                _cs, _since = "fallback_effective", _n + 1
            _cal["counts"][_cs] += 1
            _cal["gaps"].append({"id": _g, "deadline": _n, "state": _st,
                                 "calendar_state": _cs, "effective_since_week": _since})

# ── 對不上任何 WBS ID 的 change（2026-09-12 起是 violation，不只是紅字）────
#
# **為什麼從提示升成違規**：有地圖的專案裡，一個 change 開了、id 對不上任何
# WBS ID、CI 綠 —— 地圖就這樣靜靜過期（在測試 repo 跑得出來，見
# `test-progress-check.sh`〈孤兒 change〉）。這正是「想到什麼開發什麼」的形狀：
# 工作不在地圖上，沒有人知道它擋在誰後面、是不是重複、下一步是什麼。
# 升嚴之後：`spec/<id>` 的 PR 在**規格階段**就紅，逼人先開 `governance/` PR
# 把那一列加進 `docs/WBS.md`，再開 spec。地圖先於 change。
#
# **沒有 WBS 的時候不做這件事** —— 沒有東西可以對，把每個 change 都說成
# 「命名錯誤」是錯的訊號；舊專案沒有地圖也不會因此變紅（migration 相容）。
#
# 這是一條新的閘門，憑什麼加（繞法在測試 repo 跑得出來）記在
# `docs/DECISIONS.md`〈地圖先於 change〉。下一條閘門一樣要先跑一次繞法。
_matched = {c for w in order for c in changes_for(w)}
orphan = sorted(set(changes) - _matched) if wbs else []
for _c in orphan:
    violations.append(
        f"openspec/changes/{_c}：對不上任何 WBS ID（change id 要以 WBS ID 開頭，小寫）"
        f"—— 先開 governance/ PR 把這項工作加進 docs/WBS.md，再開 spec")

# **遠端不新鮮就講出來，而且要講清楚哪些狀態不能信。**
# 只印「fetch 失敗」不夠 —— 讀的人不會知道那影響了什麼。
if not REMOTE_FRESH and not JSON:
    print()
    print(f"{Y}⚠ 遠端狀態可能是舊的：{REMOTE_WHY}{X}")
    print(f"{D}  「規格審查中」與「實作中」是從遠端分支推的，這一次沒抓到新的，"
          f"用的是上一次的 refs。{X}")
    print(f"{D}  「已封存」「規格已合併」「未開始」不受影響 —— 那些只看這份 tree。{X}")

# 〈跨項依賴〉還是舊的自由文字表：**不驗就要講出來**，每次跑都講（含 --check，
# CI 的紀錄裡看得到）。不講的話，「沒有逆序」跟「根本沒看」長得一模一樣。
if _xdep_meta["schema"] == "legacy_free_text" and not JSON:
    print()
    print(f"{Y}⚠ 〈跨項依賴〉還是舊的自由文字表：{_xdep_meta['rows']} 列的排程與環都沒有被驗。{X}")
    print(f"{D}  改成正本 `## 跨項依賴`（`| 這一項 | 依賴 | 關係 | 說明 |`，見 AGENTS.md）才會驗。"
          f"遷移時若有逆序，那是規劃要裁決的事，不是格式轉換。{X}")
elif _xdep_meta["schema"] == "canonical" and not JSON and _xd["edges"] and not _xd["evaluated"]:
    print()
    print(f"{D}〈跨項依賴〉{_xd['edges']} 條邊，這次沒有一條比得了排程"
          f"（沒有週次 {_xd['skipped_src_no_week'] + _xd['skipped_dep_no_week']}、"
          f"依賴已取消 {_xd['skipped_dep_cancelled']}）。{X}")

# 里程碑可追溯性：**預設就印一行**（含 --check）。一份沒有人跑的報告，就是
# 「機制沒起作用、沒人知道」的形狀；零項、舊格式、沒有〈里程碑〉也各自明說 ——
# 不然「全部被指到」跟「沒有看」長得一樣。`--json` 不印（別弄壞下游的解析）。
if wbs and not JSON:
    _tr = _trace
    print()
    if _tr["status"] == "available":
        _n, _m = len(_tr["uncovered_scheduled"]), len(_tr["uncovered_unscheduled"])
        if not _n and not _m:
            print(f"{D}里程碑可追溯性：{_tr['pool']} 項全部被某個里程碑指到。{X}")
        else:
            print(f"{Y if _n else D}里程碑可追溯性：① {_n} 項已排週次，卻沒有被任何里程碑指到；"
                  f"② {_m} 項沒排週次／遠期而沒被指到{X}{D}（--trace 看是哪些）{X}")
    else:
        _why = {"legacy_milestone_schema_has_no_covers_column": "〈里程碑〉是舊的兩欄格式，沒有「靠哪些」",
                "milestone_table_not_parsed": "〈里程碑〉解析不出來，見違規",
                "no_milestone_section": "docs/WBS.md 沒有〈里程碑〉"}.get(_tr["reason"], _tr["reason"])
        print(f"{D}里程碑可追溯性：未評估（{_why}）。{X}")
    if TRACE and _tr["status"] == "available":
        for _title, _ids in (("① 已排週次，卻沒有被任何里程碑指到", _tr["uncovered_scheduled"]),
                             ("② 沒排週次／遠期，沒有被指到", _tr["uncovered_unscheduled"])):
            print(f"{B}  {_title}（{len(_ids)}）{X}")
            for _w in _ids:
                _wk = "、".join(sorted(wbs[_w]["weeks"])) or (
                    f"決策≤W{wbs[_w]['deadline']}" if wbs[_w].get("deadline") else "—")
                # 前綴 `↳` 是給人看、也給測試抓的：`--trace` 同時會印一般的狀態表，
                # 只抓 ID 的話，狀態表那一列就讓斷言恆真（突變實測存活過）。
                print(f"    ↳ {_w:<9} {re.sub(r'[*`]', '', wbs[_w]['name'])[:20]:<20} {_wk}")
        if _tr["excluded"]:
            print(f"{D}  不算（Cancelled／Regular）：{'、'.join(_tr['excluded'])}{X}")

# 週次錨點：設了就每次講今天是第幾週、幾個缺口的 fallback 已經生效；
# 沒設、但有 `決策≤Wn` 的缺口，要講「沒設所以判斷不了」；什麼期限都沒有的專案不講。
if wbs and not JSON:
    _c = _cal
    if _c["status"] == "enabled":
        _f = _c["counts"]["fallback_effective"]
        print()
        if _f:
            print(f"{Y}週次：今天 W{_c['current_week']}（錨點 {_c['anchor']} {_c['tz']}）；"
                  f"{_f} 個缺口已過決策期限、還沒有答案 —— fallback 已生效{X}{D}（--trace 看是哪些）{X}")
        else:
            print(f"{D}週次：今天 W{_c['current_week']}（錨點 {_c['anchor']} {_c['tz']}）；"
                  f"沒有缺口過了決策期限還沒答案。{X}")
        if TRACE:
            for _g in _c["gaps"]:
                if _g["calendar_state"] == "decided":
                    continue
                _tag = (f"fallback 自 W{_g['effective_since_week']} 起生效"
                        if _g["calendar_state"] == "fallback_effective" else "還在期限內")
                print(f"    ↳ {_g['id']:<9} 決策≤W{_g['deadline']:<3} {_g['state']:<6} {_tag}")
    elif _c["deadline_gaps"] and _c["reason"] == "no_anchor":
        print()
        print(f"{D}週次錨點：未設定 —— {_c['deadline_gaps']} 個缺口的決策期限（決策≤Wn）"
              f"判斷不了有沒有過期。在 docs/WBS.md 加一行 "
              f"`<!-- wbs:week1 YYYY-MM-DD Asia/Taipei -->`（W1 第一天、時區）。{X}")

_todo = setup_todo()
if _todo and not JSON and not CHECK:
    print()
    print(f"{B}這個專案還有 {len(_todo)} 件事沒設定{X}"
          f"{D}（剛從模板複製的話這是正常的，照著做一次就好）{X}")
    for _i, (_what, _how) in enumerate(_todo, 1):
        print(f"{Y}  {_i}. {_what}{X}")
        for _line in _how.split("。"):
            if _line.strip():
                print(f"{D}     {_line.strip()}。{X}")
    print()

if JSON:
    # **狀態只算一次，別的工具吃這一份。**
    # 網頁與 Excel 曾經各自重算過一次，三邊給出三個答案 ——
    # 那正是這份文件到處在防的「同一件事寫在兩個地方」。
    import json as _json
    # `remote_fresh` 是給下游用的。`wbs-page.sh` 與往後的 WBS 區塊都要看它 ——
    # **把從遠端推出來的狀態當成事實寫進版控，是把一個當下的東西凍成一份紀錄。**
    out = {"items": [], "groups": _groups, "affects": {},
           "milestones": _milestones, "milestones_meta": _ms_meta, "deps": _deps,
           "deps_meta": _xdep_meta, "dep_graph": _dep_graph,
           "milestone_trace": _trace, "calendar": _cal,
           "remote_fresh": REMOTE_FRESH, "remote_why": REMOTE_WHY}
    _aff = collections.defaultdict(list)
    for wid in order:
        info = wbs[wid]
        marks, reason = parse_mark(info["mark"])
        out["items"].append({
            "id": wid, "group": re.sub(r"[0-9]+$", "", wid), "name": info["name"],
            "weeks": sorted(info["weeks"], key=lambda s: int(re.findall(r"\d+", s)[0])),
            "pts": info["pts"], "blockers": sorted(info["blockers"]),
            "blocked": info["blocked"], "marks": sorted(marks), "reason": reason,
            "deadline": info["deadline"], "state": _state_of[wid], "rows": info["detail"],
            # **change 的關聯以前只存在於終端機表格。** `--json` 是網頁與
            # Excel 的唯一資料來源，那邊看不到就等於這件事沒有被算過 ——
            # 而「同一個 ID 開了兩個 change」這種事更是完全看不出來。
            # 這裡放**全部**，不是第一個。
            "changes": change_ids_for(wid),
        })
        for g in info["blockers"]:
            _aff[g].append(wid)
    out["affects"] = dict(_aff)
    out["violations"] = violations
    print(_json.dumps(out, ensure_ascii=False))
    raise SystemExit(1 if (CHECK and violations) else 0)

if not wbs:
    # 沒有工作分解表 —— 只列 change 本身。
    if not changes:
        print(f"{D}還沒有任何 OpenSpec change。{X}")
        print(f"{D}用 /opsx:propose 開第一個，或看 prompts/01-discovery.md。{X}")
    else:
        print(f"{B}{'change':<34} {'狀態':<10} {'tasks'}{X}")
        print("─" * 60)
        for cid in sorted(changes):
            c = changes[cid]
            br = branches.get(cid, set())
            prog = c.get("prog")
            bar = f"{prog[0]}/{prog[1]}" if prog and prog[1] else "—"
            if c["state"] == "archived":
                st, colour = "已封存", G
            elif "feat" in br or "fix" in br:
                st, colour = "實作中", Y
            elif "spec" in br:
                st, colour = "規格審查中", Y
            else:
                st, colour = "規格已合併", Y
            print(f"{colour}{cid:<34} {st:<10} {bar}{X}")
        print()
elif rows:
    print(f"{B}{'ID':<9} {'項目':<20} {'週':<8} {'點':>3}  {'狀態':<12} {'change'}{X}")
    print("─" * 78)
    for colour, wid, name, weeks, pts, state, detail in rows:
        pad = 20 - sum(2 if ord(ch) > 0x2E80 else 1 for ch in name)
        print(f"{colour}{wid:<9} {name}{' ' * max(pad,1)}{weeks:<8} {pts:>3}  {state:<12} {detail}{X}")
    print()

# ── docs/WBS.md 的機器區塊 ─────────────────────────────────────────
#
# **人只會打開 docs/WBS.md。** 進度以前只存在終端機輸出與不進版控的
# docs/wbs.html —— 在 GitHub 上打開那份表，看不到任何完成資訊。
#
# 這一段把「哪些項目做完了」寫回表裡，但只寫**耐久狀態**：
# 從這份 tree 重建得出來的那一半。遠端分支推出來的（規格審查中／實作中）
# 不進來 —— 分支開了或刪了、repo 沒有新 commit，寫進去的東西當下就過期。
BLOCK_START = "<!-- progress:start 這一段由 `progress.sh --render` 產生，不要手改 -->"
BLOCK_END = "<!-- progress:end -->"


def _digest_of(stripped):
    """**這個區塊是從哪一份 WBS 原文產生的。不是 commit 的 SHA。**

    不放 commit SHA 的理由：區塊在 commit 裡、SHA 又要放進區塊，
    自我引用沒有不動點。

    只雜湊「拿掉區塊之後的 WBS 原文」。**change 的狀態刻意不放進來** ——
    它已經逐項寫在下面那張表裡了，再雜湊一次不會被任何東西觀察到
    （實測：把 change 那一段從雜湊裡拿掉，198 條測試全綠 —— 它是一個
    沒有讀者的成分）。這個 repo 自己的規矩是「要嘛可達，要嘛不要留」。

    `tasks.md` 的勾也不放：每打一個勾就換一次指紋的話，這個區塊會變成每個
    PR 都要重產的東西，而那個勾根本沒有顯示在區塊裡。
    """
    import hashlib
    return hashlib.sha256(stripped.encode("utf-8")).hexdigest()[:16]


def _strip_block(text):
    """把既有的區塊拿掉，回傳 `(前段, 後段)`；沒有區塊就回 None。

    **marker 各要恰好一個，而且順序正確。** 少一個、多一個、順序反了都
    直接失敗 —— 那些情況下「區塊是哪一段」沒有唯一答案，猜一個就是 fail-open。
    """
    if text.count(BLOCK_START) != 1 or text.count(BLOCK_END) != 1:
        return None
    i = text.index(BLOCK_START)
    j = text.index(BLOCK_END)
    if j < i:
        return None
    return text[:i], text[j + len(BLOCK_END):]


def _render_block(stripped):
    """區塊的內容。**只放 ID、耐久狀態、依據** —— 名稱、週次、點數不複製。

    複製過來的東西會跟上面那張表漂；而且每個 PR 都動到那幾欄，
    衝突面積會大到沒有人願意維護它。
    """
    lines = [BLOCK_START, "",
             "### 目前做到哪裡（機器產生）", "",
             "**沒有列出來的項目就是「未開始」。**"
             "「規格審查中」「實作中」不在這裡 —— 那兩個是從遠端分支推的，"
             "不是這份 tree 重建得出來的，寫進版控當下就會過期。"
             "要看那兩個狀態跑 `bash .github/scripts/progress.sh`。", "",
             # **第一欄不可以叫 `ID`。** 這個區塊住在 docs/WBS.md 裡面，
             # 而 WBS 的解析器認的表頭就是「第一欄是 ID、下一行是分隔線」——
             # 叫 `ID` 的話它會被當成另一張工作分解表，然後因為只有三欄而報錯。
             # （實測：`--check` 紅在「第 40 行是工作分解表的表頭，但只有 3 欄」。
             # 產生出來的東西要能通過這份文件自己的文法，那也是驗收的一部分。）
             "| 項目 | 狀態 | 依據 |", "|---|---|---|"]
    # **依狀態排，不依 ID 排。** 讀的人問的是「哪些做完了」——
    # 按 ID 排的話那幾項會被外部缺口埋在中間。同狀態內再按 ID，
    # 所以順序仍然是決定性的（diff 才不會亂跳）。
    _rank = {"已封存": 0, "已完成": 1, "規格已合併": 2, "常態": 3,
             "矛盾": 4, "待裁決": 5, "等外部": 6, "已取消": 7}
    n = 0
    for wid in sorted(order, key=lambda w: (_rank.get(_durable_of.get(w, ""), 9), w)):
        st = _durable_of.get(wid, "")
        if st in ("", "未開始"):
            continue
        _why = ["`" + x + "`" for x in change_ids_for(wid)]
        # 標 `Done` 的項目沒有 change 可以指 —— **要說出狀態是哪裡來的**，
        # 不然那一格是「—」，看起來像資料掉了。理由本身不複製進來：
        # 它就在同一份檔案的表格裡，抄過來只會多一份會漂的副本。
        if not _why and "Done" in parse_mark(wbs[wid].get("mark", ""))[0]:
            _why = ["標記 `Done`"]
        why = "、".join(_why) or "—"
        lines.append(f"| {wid} | {st} | {why} |")
        n += 1
    tal = collections.Counter(_durable_of[w] for w in order)
    lines += ["",
              "共 " + str(len(order)) + " 項："
              + "、".join(f"{k} {v}" for k, v in sorted(tal.items(), key=lambda kv: -kv[1])),
              "",
              "來源指紋 `" + _digest_of(stripped) + "`"
              "（這一段是從哪一份 WBS 原文產生的。不放 commit SHA —— "
              "區塊在 commit 裡、SHA 又放進區塊的話，自我引用沒有不動點）",
              "", BLOCK_END]
    return "\n".join(lines)


# **平常跑 `progress.sh` 的人最該看到「區塊過期了」。**
# 原本只在 --render／--check 算，於是唯一會看到提醒的是 CI。
if not JSON:
    _wp = pathlib.Path("docs/WBS.md")
    _txt = _wp.read_text(encoding="utf-8") if _wp.is_file() else None
    if _txt is None:
        if RENDER:
            print("✗ 沒有 docs/WBS.md，沒有東西可以產生", file=sys.stderr)
            raise SystemExit(1)
    elif BLOCK_START not in _txt and BLOCK_END not in _txt:
        # 兩個 marker 都沒有 —— 這個功能是選填的，沒開就是沒開。
        if RENDER:
            print("✗ docs/WBS.md 裡沒有這兩行，先手動加一次（放在你希望"
                  "進度出現的位置）：", file=sys.stderr)
            print("    " + BLOCK_START, file=sys.stderr)
            print("    " + BLOCK_END, file=sys.stderr)
            raise SystemExit(1)
    else:
        _parts = _strip_block(_txt)
        if _parts is None:
            violations.append(
                "docs/WBS.md 的 progress marker 壞了："
                "`progress:start` 與 `progress:end` 要各恰好一個、而且 start 在前")
            if RENDER:
                print(violations[-1], file=sys.stderr)
                raise SystemExit(1)
        else:
            _want = _parts[0] + _render_block(_parts[0] + _parts[1]) + _parts[1]
            if RENDER:
                _wp.write_text(_want, encoding="utf-8")
                print("✓ 已更新 docs/WBS.md 的進度區塊")
            elif _want != _txt and not JSON:
                # **不再是違規，只是提醒。**
                #
                # 2026-09-08 降級：那個「必須同步」的要求，讓每個加 change 或
                # archive 的 PR 都得順手重產一次區塊 —— 而那兩種分支原本不准碰
                # `docs/WBS.md`，於是逼我放寬了它們的路徑限制。**一條檢查逼出
                # 一條例外，就是規則互相牽制的開始。**（實測撞到過兩次。）
                #
                # 區塊仍然由 `--render` 產生、仍然看得到進度；它過期的時候
                # 這裡會說，但不擋任何人。
                print(f"{Y}⚠ docs/WBS.md 的進度區塊跟現在的狀態對不上{X}"
                      f"{D}（跑 `progress.sh --render` 更新它；這不是違規）{X}")

if violations:
    print()
    print(f"{R}規則違規{X}（這些是文件自己訂的規則，不是建議）：")
    for v in violations:
        print(f"{R}  ✗ {X}{v}")
    print(f"{D}  用 --check 讓它以非零結束（可以接進 CI）。{X}")

total = sum(tally.values())
if total:
    parts = [f"{k} {v}" for k, v in tally.most_common()]
    print(f"{B}WBS 共 {total} 項{X}：" + "、".join(parts))
    if len(by_group) > 1:
        for g in sorted(by_group):
            c = by_group[g]
            n = sum(c.values())
            print(f"{D}  {g:<6} {n:>3} 項：" + "、".join(f"{k} {v}" for k, v in c.most_common()) + X)
    # `--week` 之下只算落在那一週的依賴者 —— 上面的統計是篩過的，這一段不篩的話，
    # 同一個畫面兩種範圍（實測：「WBS 共 14 項」底下列出影響五十幾項）。
    _shown_blocks = {g: (ids & _week_ids if ONLY_WEEK else ids) for g, ids in blocks.items()}
    _shown_blocks = {g: ids for g, ids in _shown_blocks.items() if ids}
    if _shown_blocks:
        # 「這個缺口解掉，會解鎖幾件事」—— 這是決定先問哪一個的依據。
        print()
        print(f"{B}哪些項目依賴外部{X}（依影響範圍排序"
              + (f"，只算 {ONLY_WEEK} 的項目" if ONLY_WEEK else "") + "）：")
        for gap, ids in sorted(_shown_blocks.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            names = "、".join(sorted(ids))
            print(f"{R}  {gap:<8}{X} 影響 {len(ids)} 項：{D}{names}{X}")
        print()
    if tally.get("矛盾"):
        print(f"{R}⚠ {tally['矛盾']} 項標記與實際狀態打架{X}"
              f"（標了 Cancelled 卻已經封存）—— 兩邊只有一邊是對的，去改。")
    stuck = tally.get("等外部", 0) + tally.get("待裁決", 0)
    if stuck:
        print(f"{R}其中 {stuck} 項不在自己手上{X}（等外部或待裁決）——"
              f" 用 --blocked 看是哪些。")
        print(f"{D}把它們算進「未開始」會讓進度看起來只是慢 ——"
              f"「還沒做」跟「不由我決定」是兩件事。{X}")
    if not (SHOW_ALL or ONLY_BLOCKED) and tally.get("未開始"):
        print(f"{D}（{tally['未開始']} 項未開始沒有列出，用 --all 看全部）{X}")

# 一個工作項目拆成多個 change —— 這是正常的（WBS ID 是交付意圖，不是架構單元；
# `FE-O01 資料層` 拆成 `fe-o01-api-contract`／`fe-o01-runtime-config` 是對的）。
# 但**拆了要看得見**：以前只有 `--json` 帶完整清單，終端機只顯示聚合狀態，
# 於是「一項變兩個 change」這件事在人會看的地方是隱形的。這一段不擋任何人。
_split = [(w, changes_for(w)) for w in order if len(changes_for(w)) > 1]
if _split and not ONLY_BLOCKED:
    print()
    print(f"{B}工作拆分{X}{D}（一個 WBS ID 對應多個 change；正常，但要看得見）{X}")
    for w, cs in _split:
        print(f"    {w} → {'、'.join(cs)}")

# 對不上 WBS 的 change（上面已經算進 violations；這裡只是把它們列出來）。
if orphan:
    print()
    print(f"{R}對不上任何 WBS ID 的 change{X}（change id 要以 WBS ID 開頭，小寫）：")
    for c in orphan:
        print(f"    {c}  [{changes[c]['state']}]")
    print(f"{D}    地圖先於 change：先開 governance/ PR 把這項加進 docs/WBS.md，再開 spec。{X}")

if CHECK and violations:
    raise SystemExit(1)
PY

