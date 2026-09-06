#!/usr/bin/env bash
# 「現在做到哪裡」的答案。
#
#     bash .github/scripts/progress.sh            # 只看有動靜的
#     bash .github/scripts/progress.sh --all      # 連還沒開始的一起列
#     bash .github/scripts/progress.sh --week W1
#     bash .github/scripts/progress.sh --blocked  # 不在自己手上的，以及誰依賴它
#     bash .github/scripts/progress.sh --check    # 有規則違規就以非零結束
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
while [ $# -gt 0 ]; do
  case "$1" in
    --all)     SHOW_ALL=1 ;;
    --blocked) ONLY_BLOCKED=1 ;;
    --check)   CHECK=1 ;;
    --json)    JSON=1 ;;
    --week)    shift; ONLY_WEEK="${1:-}" ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;;
    *) echo "不認得的參數：$1" >&2; exit 2 ;;
  esac
  shift
done

git fetch -q origin 2>/dev/null || true

SHOW_ALL="$SHOW_ALL" ONLY_WEEK="$ONLY_WEEK" ONLY_BLOCKED="$ONLY_BLOCKED" CHECK="$CHECK" JSON="$JSON" python3 - <<'PY'
import os, re, subprocess, pathlib, collections

SHOW_ALL = os.environ.get("SHOW_ALL") == "1"
ONLY_BLOCKED = os.environ.get("ONLY_BLOCKED") == "1"
CHECK = os.environ.get("CHECK") == "1"
JSON = os.environ.get("JSON") == "1"
ONLY_WEEK = os.environ.get("ONLY_WEEK") or ""

G, Y, R, D, B, X = "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[1m", "\033[0m"

# ── 規則違規 ───────────────────────────────────────────────────────
# **這一段是重點。** 前面那些規則如果只寫在文件裡，它們就只是規範；
# 規範不會擋住任何人。這裡把它們變成看得到的違規。
# 圍籬：``` 或 ~~~，後面可以接語言名。
_FENCE = re.compile(r"^(?:`{3,}|~{3,})")

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
# **token 吃的字元集合要涵蓋右邊界擋的字元集合。** 否則回溯會生出一個
# 比較短、右邊界剛好成立的假匹配 —— 上面那兩個洞都是這樣來的。
# 這裡 token 尾巴吃 `[A-Za-z0-9]`、右邊界擋 `[A-Za-z0-9]`：貪婪吃完之後
# 右邊界必然成立，縮短只會讓它失敗，不會讓它變成另一個答案。
#
# 頭部的英數尾巴**要求至少有一個數字**。不要求的話 `SETUP-GITHUB`、
# `X-Ray`、`E-Mail` 全都變成 token，然後 parse 失敗報一堆假違規
# （實測：README 立刻多一個）。有數字才像工作項目編號。
_TOKEN = re.compile(
    r"(?<![A-Za-z0-9-])"
    r"[A-Z]+-[A-Z](?:[A-Za-z0-9]*[0-9][A-Za-z0-9]*)?"
    r"(?:[/-][A-Za-z0-9]+)*"
    r"(?![A-Za-z0-9])")

# 阻塞欄那種**只准放 ID 的欄位**用寬的 token —— `BE-GXX`、`be-g01`
# 在那裡一定是打錯，不會是英文散文。**文法是同一份，只有「哪些字拿去
# parse」不同**，因為欄位是受控的、散文不是。
_TOKEN_FIELD = re.compile(
    r"(?<![A-Za-z0-9-])[A-Za-z]+-[A-Za-z0-9]+(?:[/-][A-Za-z0-9]+)*"
    r"(?![A-Za-z0-9])")

# token 的三種合法形狀。**只有這三種**，其他一律報。
_SHAPE_GROUP = re.compile(_GRP)                                    # APP-C
_SHAPE_ITEM = re.compile("(" + _GRP + r")([0-9]{2,})"
                         r"((?:/[A-Z]?[0-9]{2,})*)")                # APP-C01/02
# 範圍的位數刻意放寬成 `[0-9]+`，這樣 `APP-C01`–`5` 才報得出
# 「第二端不合法」，而不是掉進最後那句籠統的訊息。
_SHAPE_RANGE = re.compile("(" + _GRP + r")([0-9]+)-"
                          "(?:(" + _GRP + r"))?([0-9]+)")           # APP-C01–APP-C05


def plain(s: str) -> str:
    """剝掉 Markdown 與 HTML 的裝飾，只留下讀者實際看到的字。

    **不要拿原始字串去比對或抽 token。** `**ID**` 跟 `ID` 在畫面上是同一個東西，
    `BE-G**O**1` 看起來就是 `BE-GO1`；只認原始字串的話，加個星號就能讓
    整段檢查失效。非 ASCII 的連字號（‑ ‒ – —）也一併正規化 ——
    它們長得跟 `-` 一樣，貼上來的文字很容易夾帶。
    """
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)   # HTML 註解
    s = re.sub(r"<[^:@\s]*?>", "", s)              # HTML tag
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)  # Markdown 連結，留文字
    s = re.sub(r"[*_`~]", "", s)                   # 強調符號
    s = s.replace("\u2010", "-").replace("\u2011", "-").replace("\u2012", "-")
    s = s.replace("\u2013", "-").replace("\u2014", "-").replace("\uff0d", "-")
    return s.strip()


def scan_ids(text, where, wide=False):
    """讀出一段字裡的工作項目與群組引用。**唯一一份 ID 文法在這裡。**

    回傳 `(項目 ID, 群組 ID, 違規訊息)` 三個 list。
    `where` 只進訊息（`docs/WBS.md 第 12 行`、`APP-M01：阻塞欄`）。
    `wide=True` 給受控欄位用，見 `_TOKEN_FIELD`。

    **parse 不完整就報，不要「交給下一條檢查」** —— 這裡就是最後一條。
    """
    ids, gids, errs = [], [], []
    for m in (_TOKEN_FIELD if wide else _TOKEN).finditer(text):
        tok = m.group(0)

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

MARKS_EXCLUSIVE = {"TBD", "Pending", "Cancelled", "Regular"}
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
    _lines = wbs_path.read_text(encoding="utf-8").splitlines()

    def is_sep(i):
        """第 i 行（0-based）是不是 Markdown 的表頭分隔線。"""
        if i >= len(_lines):
            return False
        s = _lines[i].strip()
        return s.startswith("|") and set(s) <= set("-:| ")

    for lineno, line in enumerate(_lines, 1):
        # **不能用 line.startswith("|")** —— Markdown 允許表格列前面有空白，
        # 而那樣的一列會整個從檢查裡消失（連同它的 ID、週次、標記），
        # 不會有任何錯誤訊息。先正規化再判斷。（實測繞過過。）
        line = line.strip()
        if not line.startswith("|"):
            # 表格結束。**一定要重設** —— 否則下一張表的列會被當成這張表的。
            in_table = False
            cur = None
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        head = plain(cells[0])
        # 表頭：`| ID | 項目 | 工作 | 週 | 點 | …`
        # **用正規化後的字比對。** 只認字面上的 `ID` 的話，把表頭寫成
        # `| **ID** |` 就會讓底下整張表被當成別的表略過 —— 實測過：
        # 122 項掉到 19 項，而 --check 照樣是 0。
        # **表頭的定義是「下一行是分隔線」**，不是「第一欄剛好寫著 ID」。
        # 說明用的表格裡也會出現 `| **ID** | 工作項目編號… |` 這種資料列，
        # 只看第一欄會把它誤判成表頭。
        if head.casefold() == "id" and is_sep(lineno):
            if len(cells) < 5:
                violations.append(f"docs/WBS.md 第 {lineno} 行是工作分解表的表頭，"
                                  f"但只有 {len(cells)} 欄（要 5 欄以上）")
            in_table = len(cells) >= 5
            if in_table:
                ncols = len(cells)
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
            # **阻塞欄走同一份文法。** 這裡曾經自己寫一份
            # `[A-Z]+-[A-Z][0-9]+`：不展開斜線、不展開範圍，於是
            # `BE-G01/02` 只收到 G01、`BE-G01`–`BE-G03` 中間的 G02 消失 ——
            # 而同一個格子的敘述掃描會把它們展開去驗存在。
            # 同一個格子在同一支腳本裡兩種讀法，正是這支腳本在抓的東西。
            # 欄位是受控的，所以用寬的 token：`BE-GO1`（字母 O）、
            # `BE-GXX` 在這裡一定是打錯，原本會直接從 blockers 消失 ——
            # 既不報格式錯，後面「工作不得排在裁決之前」那條也就跟著不驗。
            found, _bgids, _berrs = scan_ids(plain(blocked),
                                             f"{cur}：阻塞欄", wide=True)
            violations.extend(_berrs)
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
        in_fence = False
        for lineno, line in enumerate(
                _src.read_text(encoding="utf-8").splitlines(), 1):
            # **結構看原始行，ID 看正規化後的字串。** plain() 會剝掉
            # 反引號與 `~`，圍籬那一行過完它就變成空字串了 ——
            # 拿正規化後的字串去認圍籬，等於整個跳過機制失效。
            raw = line.strip()
            # 圍籬裡是範例，不是引用。**先判斷再跳過** —— 圍籬本身這一行
            # 也不該被掃（``` 後面可能接語言名）。`~~~` 也是合法圍籬，
            # 不認得它就等於把裡面的範例當成真引用。
            if _FENCE.match(raw):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
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
        if in_fence:
            # 一個沒關的圍籬會讓**檔案後半段的引用全部消音**，而且是綠的。
            # 「跳過圍籬」本來是為了放過格式範例，不是給人一個萬用消音器。
            violations.append(f"{_src} 有沒關起來的程式碼圍籬"
                              f"（``` 或 ~~~ 數量是奇數）—— "
                              f"後面的引用全部不會被檢查")

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
    _mi = _text.find("## 里程碑")
    if _mi > 0:
        for line in _text[_mi:].splitlines():
            if not line.strip().startswith("| **W"):
                continue
            cc = [x.strip() for x in line.strip().strip("|").split("|")]
            if len(cc) >= 2:
                _milestones.append({"w": re.sub(r"[*]", "", cc[0]), "text": cc[1]})
    _di = _text.find("已知的跨項依賴")
    if _di > 0:
        for line in _text[_di:_di + 2000].splitlines():
            if not line.startswith("| `"):
                continue
            cc = [x.strip() for x in line.strip().strip("|").split("|")]
            if len(cc) == 2:
                _deps.append({"a": cc[0], "b": cc[1]})

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

def change_for(wid):
    pre = wid.lower()
    hits = [c for c in changes if c == pre or c.startswith(pre + "-")]
    if not hits:
        hits = [c for c in branches if c == pre or c.startswith(pre + "-")]
    return hits[0] if hits else None

# ── 輸出 ───────────────────────────────────────────────────────────
rows, tally = [], collections.Counter()
# 分組統計。**不同前綴是不同性質的東西** —— 例如「後端能力缺口」跟前端工作
# 混在同一個總數裡，會讓「還有多少沒做」看起來像是我們排得動的。
by_group = collections.defaultdict(collections.Counter)
# 缺口 → 它擋住哪些項目。從各項目的「阻塞」欄反推，沒有人維護。
blocks = collections.defaultdict(set)
_state_of = {}
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
    if ONLY_WEEK and not any(covers(t, ONLY_WEEK) for t in wk):
        continue

    # 人為決定 —— 機器算不出來的那些。理由寫在同一格，用 ｜ 隔開。
    # 標記可以複合：`Alarm+Pending｜理由`。Alarm 是風險訊號，**跟其他標記並存**，
    # 不取代它們；TBD / Pending / Cancelled / Regular 之間才互斥。
    mark = info.get("mark", "")
    marks, mark_reason = parse_mark(mark)
    exclusive = marks & MARKS_EXCLUSIVE
    # 互斥值同時出現已經在上面報成違規了，這裡只是不要當掉。
    mark_word = sorted(exclusive)[0] if exclusive else ""
    blocked = info.get("blocked", "") or "、".join(sorted(info.get("blockers", ())))

    cid = change_for(wid)

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
        if cid and changes.get(cid, {}).get("state") == "archived":
            # 標成不做，卻有 change 已經封存了 —— 兩個真實來源打架。
            # **不要挑一個信**，把矛盾攤出來讓人去改。
            state, detail, colour = "矛盾", f"標 Cancelled 但 {cid} 已封存", R
        else:
            state, detail, colour = "已取消", reason, D
    elif cid is None and not schedulable and (blocked or mark_word in ("Pending", "TBD")):
        state = "待裁決" if mark_word == "TBD" else "等外部"
        detail, colour = blocked or mark, R
    elif cid is None:
        state, detail, colour = "未開始", "", D
    else:
        c = changes.get(cid, {})
        br = branches.get(cid, set())
        prog = c.get("prog")
        bar = ""
        if prog and prog[1]:
            bar = f"{prog[0]}/{prog[1]}"
        if c.get("state") == "archived":
            state, detail, colour = "已封存", f"{cid}", G
        elif "feat" in br or "fix" in br:
            state, detail, colour = "實作中", f"{cid} {bar}".strip(), Y
        elif c.get("state") == "active":
            state, detail, colour = "規格已合併", f"{cid} {bar}".strip(), Y
        elif "spec" in br:
            state, detail, colour = "規格審查中", f"{cid}", Y
        else:
            state, detail, colour = "有分支", f"{cid}", Y
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

    tally[state] += 1
    _state_of[wid] = state
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

if JSON:
    # **狀態只算一次，別的工具吃這一份。**
    # 網頁與 Excel 曾經各自重算過一次，三邊給出三個答案 ——
    # 那正是這份文件到處在防的「同一件事寫在兩個地方」。
    import json as _json
    out = {"items": [], "groups": _groups, "affects": {},
           "milestones": _milestones, "deps": _deps}
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
        print(f"{D}（沒有 docs/WBS.md，所以沒有「還有哪些沒做」的視角。{X}")
        print(f"{D} 有工作分解表的話把它放在 docs/WBS.md，格式見這支腳本的開頭註解。）{X}")
elif rows:
    print(f"{B}{'ID':<9} {'項目':<20} {'週':<8} {'點':>3}  {'狀態':<12} {'change'}{X}")
    print("─" * 78)
    for colour, wid, name, weeks, pts, state, detail in rows:
        pad = 20 - sum(2 if ord(ch) > 0x2E80 else 1 for ch in name)
        print(f"{colour}{wid:<9} {name}{' ' * max(pad,1)}{weeks:<8} {pts:>3}  {state:<12} {detail}{X}")
    print()

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
    if blocks:
        # 「這個缺口解掉，會解鎖幾件事」—— 這是決定先問哪一個的依據。
        print()
        print(f"{B}哪些項目依賴外部{X}（依影響範圍排序）：")
        for gap, ids in sorted(blocks.items(), key=lambda kv: (-len(kv[1]), kv[0])):
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

# 對不上 WBS 的 change：命名沒照規矩。
# **沒有 WBS 的時候不做這件事** —— 沒有東西可以對，
# 把每個 change 都說成「命名錯誤」是錯的訊號。
matched = {change_for(w) for w in order} - {None}
orphan = sorted(set(changes) - matched) if wbs else []
if orphan:
    print()
    print(f"{R}對不上任何 WBS ID 的 change{X}（change id 要以 WBS ID 開頭，小寫）：")
    for c in orphan:
        print(f"    {c}  [{changes[c]['state']}]")

if CHECK and violations:
    raise SystemExit(1)
PY

