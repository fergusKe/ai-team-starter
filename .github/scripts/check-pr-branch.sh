#!/usr/bin/env bash
# 分支類別閘門。取代舊的 check-pr-phase.sh。
#
# 為什麼換掉舊的：舊版用路徑 allow-list 判斷「什麼是產品程式碼」
# （`^(src|app|components|lib|hooks|pages)/`）。allow-list 沒列到的路徑
# 是 fail-OPEN —— 把程式碼放進 `scripts/`、`types/`、`server/` 就整個逃逸。
# 實測過：一個「只有 src/a.ts、沒有任何 openspec 檔案」的 PR 會通過。
#
# 這一版改成：分支前綴是封閉列舉，每一類綁一個**不看檔案性質**的上界。
# 只剩兩個 deny-list（`openspec/`、`.github/`），而 deny-list 漏掉的方向
# 是 fail-CLOSED（多擋），不是逃逸。
#
# 這個檢查是決定性的：只看分支名、檔案路徑、diff 大小與 git mode，
# 不做任何語意判斷。
#
# **它保護什麼、不保護什麼，寫在 AGENTS.md〈這些閘門各自保護什麼〉。**
# 簡短版：它保證 phase ordering 與 review 面積，**不保證 diff 真的對應規格**。
# 那件事只有人做得到。

set -euo pipefail

BASE="${1:?用法: check-pr-branch.sh <base-ref> <head-ref>}"
HEAD="${2:?用法: check-pr-branch.sh <base-ref> <head-ref>}"

# chore/ 的 diff 上界（bytes）。不含 package-lock.json。
# 為什麼用 bytes 不用行數：一行幾 MB 的 minified JS、一行 base64
# 在行數上都是 1。bytes 一個上界同時涵蓋行數、單行長度與編碼把戲。
CHORE_MAX_BYTES=20000

# lockfile 另外算的上界。它不列入人類可讀行數，但**不能完全不設限** ——
# 見下面 chore/ 那段的說明。一般的套件增減遠低於這個數字。
CHORE_MAX_LOCKFILE_BYTES=1000000

fail() { echo "✗ $*" >&2; exit 1; }

# ── 0. base 一定要是 main ──────────────────────────────────────────
#
# ruleset 只保護 main。對其他分支開 PR 可以拿到綠燈，之後把 base 改成 main ——
# 而 `pull_request` 預設的 types 不含 `edited`，改 base 不會重跑，
# 舊的綠燈就掛在那個 SHA 上直接可以合併。
# 非 main 一律擋掉，這樣「別處的綠燈」根本不存在。
#
# **這一關必須排在 git diff 之前。** 放在後面的話，base 是別的分支時
# git 會先以 exit 128 炸掉（fatal: ambiguous argument），CI 一樣是紅的，
# 但錯誤訊息會讓人完全看不出真正的原因。
[ "$BASE" = "main" ] || fail "base 是 '${BASE}'，只接受 main。ruleset 只保護 main，其他分支上的綠燈帶不過來。"

# 本機跑的時候提醒一次：這個閘門看的是**已經 commit 的東西**。
# 在 git add 之後、git commit 之前跑它會拿到假綠燈 ——
# 還沒進 commit 的檔案不在 origin/main...HEAD 的範圍裡。（踩過。）
# CI 的工作區永遠是乾淨的，所以這段在 CI 不會出現。
if [ -z "${CI:-}" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "⚠️  工作區有未 commit 的變更，下面的判定不包含它們。" >&2
  echo "    這個閘門看的是 origin/${BASE}...HEAD，也就是已經 commit 的狀態。" >&2
  echo "" >&2
fi

RANGE="origin/${BASE}...HEAD"

# **`--no-renames` 不能拿掉。**
#
# git 預設會做 rename 偵測，而 `--name-only` 對 rename **只顯示新路徑**。
# 實測過的繞法：
#
#     git mv openspec/changes/<id>/specs/x/spec.md src/interpolation.ts
#
# 預設輸出只有 `src/interpolation.ts` —— 已批准的規格被搬走了，
# 而下面每一條規則都看不到它，PR 全綠。
# 加上 --no-renames 之後同一個操作會顯示成 D + A，舊路徑重新出現。
#
# `-z` 是因為 git 對含空白或控制字元的路徑會加引號跳脫，
# 那會讓下面的 grep 比對錯路徑。用 NUL 分隔取回來，再自己確認
# 沒有任何路徑含換行 —— 有的話直接擋（fail-closed，不猜）。
# （精度說明：command substitution 會剝掉結尾換行，所以「檔名以換行結尾
#  且剛好排在輸出最後一筆」這個極端情況不會造成數量不符。它不構成繞法 ——
#  剝掉之後仍然匹配 openspec/ 那些前綴 —— 但這個檢查不是「任何」都擋得到。）
NUL_N="$(git diff -z --name-only --no-renames "$RANGE" | tr -dc '\0' | wc -c | tr -d ' ')"
CHANGED="$(git diff -z --name-only --no-renames "$RANGE" | tr '\0' '\n' | sed '/^$/d')"
[ "$NUL_N" = "0" ] && { echo "沒有變更。"; exit 0; }

LINE_N="$(printf '%s\n' "$CHANGED" | sed '/^$/d' | wc -l | tr -d ' ')"
[ "$NUL_N" = "$LINE_N" ] || fail "有檔案路徑含換行字元（${NUL_N} 個路徑但只解析出 ${LINE_N} 行）。改掉檔名再送。"

has() { echo "$CHANGED" | grep -qE "$1"; }
list() { echo "$CHANGED" | grep -E "$1" | sed 's/^/    /'; }

# ── 分支類別 ──────────────────────────────────────────────────────

ID_RE='^[a-z0-9]+(-[a-z0-9]+)*$'

case "$HEAD" in

  # ── spec/<id> ── 規格階段
  spec/*)
    ID="${HEAD#spec/}"
    [[ "$ID" =~ $ID_RE ]] || fail "change id '${ID}' 格式不合。只准小寫、數字、單個連字號，且不得含 '--'。"

    # 只准動自己這個 change 的目錄，加上 ADR。
    # ADR 要放進來是因為 config.yaml 要求重大決策「同時」留一份 ADR，
    # 而 ADR 在 docs/adr/ 不在 changes/ 底下。少了這條，有 design 的 change 開不出 PR。
    if OUT="$(echo "$CHANGED" | grep -vE "^(openspec/changes/${ID}/|docs/adr/)" || true)"; [ -n "$OUT" ]; then
      echo "✗ spec/${ID} 只能修改 openspec/changes/${ID}/** 與 docs/adr/**。" >&2
      echo "$OUT" | sed 's/^/    /' >&2
      exit 1
    fi

    npx openspec validate "$ID" --strict

    # Scenario 穩定 ID。
    #
    # `openspec validate` 只驗「有沒有 Scenario」，不驗它有沒有身分。
    # 之後測試要靠這個 ID 對應回規格，而 ID 是**寫進 main 就不能改**的鍵 ——
    # 所以格式與唯一性要在規格進 main 之前就擋住，不能等有測試才補。
    # 補的時候要做 migration，那比一開始就擋貴得多。
    python3 - "$ID" <<'SCENARIO_IDS'
import sys, re, pathlib
cid = sys.argv[1]
root = pathlib.Path("openspec/changes") / cid / "specs"
if not root.is_dir():
    sys.exit(0)                       # 沒有 delta spec 的 change，交給 validate 管

ID_RE  = re.compile(r"^\[([A-Z0-9]+(?:-[A-Z0-9]+)*-S[0-9]{2})\]\s+\S")
HEAD_RE = re.compile(r"^####\s+Scenario:\s*(.*)$")

seen, bad, n = {}, [], 0
for f in sorted(root.rglob("*.md")):
    for ln, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
        m = HEAD_RE.match(line)
        if not m: continue
        n += 1
        rest = m.group(1).strip()
        im = ID_RE.match(rest)
        if not im:
            bad.append(f"{f}:{ln} 沒有 ID 或格式不合：{rest[:44]}")
            continue
        sid = im.group(1)
        if sid in seen:
            bad.append(f"{f}:{ln} ID 重複：[{sid}]，已用於 {seen[sid]}")
        else:
            seen[sid] = f"{f}:{ln}"

if bad:
    print("✗ Scenario ID 有問題：", file=sys.stderr)
    for b in bad: print("    " + b, file=sys.stderr)
    print("", file=sys.stderr)
    print("  每個 Scenario 標題要長這樣：", file=sys.stderr)
    print("      #### Scenario: [AUTH-01-S01] 首次登入建立 session", file=sys.stderr)
    print("  格式 <工作項目 ID>-S<兩位數>，同一個 change 內不重複。", file=sys.stderr)
    print("  判準寫在 openspec/config.yaml 的 rules.specs。", file=sys.stderr)
    sys.exit(1)
print(f"  ✓ {n} 個 Scenario 都有唯一 ID")
SCENARIO_IDS

    echo "✓ spec 階段：${ID}"
    ;;

  # ── feat/<id>[--<slice>] / fix/<id>[--<slice>] ── 實作階段
  feat/*|fix/*)
    REST="${HEAD#*/}"
    ID="${REST%%--*}"          # 取第一個 -- 之前；沒有 -- 就是整段
    [[ "$ID" =~ $ID_RE ]] || fail "從分支名推出的 change id '${ID}' 格式不合。命名應為 feat/<change-id>--<slice>。"

    # change 必須**已經在 main 上**。只存在於這個 PR 的不算。
    # 用 git object database，不看 working tree。
    git cat-file -e "origin/${BASE}:openspec/changes/${ID}/proposal.md" 2>/dev/null \
      || fail "main 上沒有 openspec/changes/${ID}/proposal.md。規格要先用 spec/${ID} 開 PR 談定並合併。"

    # 不得回改任何已批准的規格內容（自己的或別人的）。
    # tasks.md 可以動 —— 實作期間打勾是正常的。
    if has '^openspec/changes/[^/]+/(proposal\.md|design\.md|specs/)'; then
      echo "✗ 實作 PR 不得修改已批准的規格內容：" >&2
      list '^openspec/changes/[^/]+/(proposal\.md|design\.md|specs/)' >&2
      echo "  發現規格有問題就停下來，另開 spec/${ID} 改規格讓人重看。" >&2
      exit 1
    fi

    # archive 是獨立類別，不能夾帶。
    has '^openspec/(specs/|changes/archive/)' && fail "實作 PR 不得動 openspec/specs/ 或 changes/archive/。archive 請用 archive/${ID} 分支。"

    echo "✓ 實作階段：${ID}（規格已在 main 上）"
    ;;

  # ── chore/<desc> ── 無規格的小型維護
  chore/*)
    # 這是**唯一一條不需要 OpenSpec change 的通道**，所以它的上界要夠硬。
    # 它保護的是「review 面積」，不是「這不是功能」。
    # 一個 80 行的功能仍然可以冒充 chore —— 最後擋它的是人，
    # 所以 AGENTS.md 規定 chore PR 一律深讀、不抽查。

    has '^openspec/' && { echo "✗ chore 不得修改 openspec/：" >&2; list '^openspec/' >&2; exit 1; }
    has '^\.github/' && { echo "✗ chore 不得修改 .github/。改執法層請用 governance/ 分支，讓它單獨被看到。" >&2; list '^\.github/' >&2; exit 1; }

    # symlink(120000) 與 submodule(160000)：一行 target 可以掛進任意內容。
    if MODES="$(git diff --raw --no-renames "$RANGE" | awk '$2 ~ /^(120000|160000)$/ {print $NF"  (mode "$2")"}')"; [ -n "$MODES" ]; then
      echo "✗ chore 不得新增 symlink 或 submodule：" >&2
      echo "$MODES" | sed 's/^/    /' >&2
      exit 1
    fi

    # binary：git 只印「Binary files differ」，bytes 上界看不到真實內容。
    if BIN="$(git diff --numstat --no-renames "$RANGE" | awk -F'\t' '$1=="-" && $2=="-" {print $3}')"; [ -n "$BIN" ]; then
      echo "✗ chore 不得包含 binary 檔案：" >&2
      echo "$BIN" | sed 's/^/    /' >&2
      exit 1
    fi

    # Git LFS：pointer 檔很小，被 review 的是 pointer 不是實體內容。
    # `.gitattributes` 是啟用它的開關 —— 那不是 chore 該做的事。
    has '(^|/)\.gitattributes$' && fail "chore 不得修改 .gitattributes。它會改變 git 對檔案內容的處理方式（例如啟用 LFS，讓 review 只看得到 pointer）。請走 governance/。"
    if git diff --no-renames "$RANGE" | grep -q 'version https://git-lfs\.github\.com/spec/'; then
      fail "chore 的 diff 含 Git LFS pointer。實際內容不在這個 PR 裡，review 看不到。"
    fi

    # diff 的 bytes 上界。
    #
    # lockfile **不列入人類可讀行數**（它是機器產生的，沒有人會讀它，
    # 算進去的話任何套件更新都會被擋），**但不是完全豁免**：
    # 完全豁免的話，在 lockfile 尾端塞幾 MB 合法 JSON 空白就能把
    # 「review 面積有上界」整個破掉 —— numstat 當它是文字、raw mode
    # 是普通 100644、lockfile-lint 只驗來源不驗大小、npm ci 也接受。
    BYTES="$(git diff --no-renames "$RANGE" -- . ':(exclude)package-lock.json' | wc -c | tr -d ' ')"
    [ "$BYTES" -le "$CHORE_MAX_BYTES" ] \
      || fail "chore 的 diff 是 ${BYTES} bytes，超過上限 ${CHORE_MAX_BYTES}（不含 lockfile）。要嘛拆小，要嘛它其實需要一份規格。"

    LOCK_BYTES="$(git diff --no-renames "$RANGE" -- package-lock.json | wc -c | tr -d ' ')"
    [ "$LOCK_BYTES" -le "$CHORE_MAX_LOCKFILE_BYTES" ] \
      || fail "chore 的 lockfile diff 是 ${LOCK_BYTES} bytes，超過上限 ${CHORE_MAX_LOCKFILE_BYTES}。這個量級的相依性變動不該走 chore。"

    echo "✓ chore：${BYTES} bytes / 上限 ${CHORE_MAX_BYTES}（lockfile 另計 ${LOCK_BYTES}）"
    ;;

  # ── archive/<id> ── 把 delta 同步進 openspec/specs/
  archive/*)
    ID="${HEAD#archive/}"
    [[ "$ID" =~ $ID_RE ]] || fail "change id '${ID}' 格式不合。"

    # 沒有這個類別的話，archive PR 開不出來：
    # spec/ 超出範圍、feat/ 禁止刪 specs、chore/ 禁止碰 openspec。
    if OUT="$(echo "$CHANGED" | grep -vE "^openspec/(changes/${ID}/|changes/archive/|specs/)" || true)"; [ -n "$OUT" ]; then
      echo "✗ archive/${ID} 只能動 openspec/changes/${ID}/、changes/archive/、specs/。" >&2
      echo "$OUT" | sed 's/^/    /' >&2
      exit 1
    fi

    # 原目錄只能是刪除（archive 是搬走，不是改完再搬）。
    if MOD="$(git diff --name-status --no-renames "$RANGE" -- "openspec/changes/${ID}/" | grep -v '^D' || true)"; [ -n "$MOD" ]; then
      echo "✗ archive PR 對 openspec/changes/${ID}/ 只能是刪除，不能順手改內容：" >&2
      echo "$MOD" | sed 's/^/    /' >&2
      exit 1
    fi

    # **只看 status letter 不夠。** 上面那條成立的意思只是「原目錄被刪了」，
    # 不是「archive 裡的是同一份東西」。實際可行的繞法：
    #   1. 複製到 changes/archive/<date>-<id>/
    #   2. 改掉複製過去的 proposal / spec（只要還能通過 validate）
    #   3. 刪掉原目錄
    # git 會看成 D + A（改動夠大時 rename 偵測本來就配不起來），
    # 原目錄的 pathspec 輸出全是 D，這條就過了。
    #
    # 所以要比對**內容身分**：base 上這個 change 的每一個檔案，
    # 都必須以相同的 blob SHA 出現在 head 的 archive 目錄裡。
    python3 - "$BASE" "$ID" <<'ARCHIVE_IDENTITY'
import subprocess, sys, re
base, cid = sys.argv[1], sys.argv[2]

def tree(ref, path):
    out = subprocess.run(["git","ls-tree","-r","-z",ref,"--",path],
                         capture_output=True, text=True, check=True).stdout
    d = {}
    for e in out.split("\0"):
        if not e: continue
        meta, fp = e.split("\t", 1)
        d[fp] = meta.split()[2]
    return d

src = tree(f"origin/{base}", f"openspec/changes/{cid}/")
dst = tree("HEAD", "openspec/changes/archive/")
base_arch = tree(f"origin/{base}", "openspec/changes/archive/")

fail = []

# ① base 上這個 change 必須存在。不然 src 是空的，下面每一條都真空成立。
if not src:
    fail.append(f"main 上沒有 openspec/changes/{cid}/ —— 沒有東西可以 archive")

# ② 目的地必須**恰好一個**，而且目錄名是 <YYYY-MM-DD>-<id>。
#
# 日期前綴要錨定。寫成 `[^/]*<id>/` 的話 id `auth` 會配到 `...-unauth/`、
# id `v2` 會配到 `...-auth-v2/`，而且是**假通過**方向的：
# 一個排序在後、內容乾淨的誘餌目錄會覆蓋掉真正被竄改的那一份。
dir_re = re.compile(rf"^openspec/changes/archive/([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}-{re.escape(cid)})/(.*)$")
dirs = {m.group(1) for fp in dst if (m := dir_re.match(fp))}
if len(dirs) != 1:
    fail.append(f"應該恰好有一個 archive/<日期>-{cid}/ 目錄，實際有 {len(dirs)} 個：{sorted(dirs)}")

# ③ 不得順手動到別的 change 的 archive。
touched_other = sorted(
    fp for fp, sha in dst.items()
    if not dir_re.match(fp) and base_arch.get(fp) != sha
)
if touched_other:
    fail.append("動到了別的 change 的 archive：\n      " + "\n      ".join(touched_other[:5]))

if fail:
    print("✗ archive 的目的地不對：", file=sys.stderr)
    for f in fail: print("    " + f, file=sys.stderr)
    sys.exit(1)

adir = dirs.pop()
arch = {m.group(2): sha for fp, sha in dst.items() if (m := dir_re.match(fp)) and m.group(1) == adir}
srcmap = {fp[len(f"openspec/changes/{cid}/"):]: sha for fp, sha in src.items()}

# ④ **完全相等**，不是「每個來源檔案都找得到」。
#    子集比對不會拒絕 archive 裡多出來的檔案。
bad = []
for rel in sorted(set(srcmap) | set(arch)):
    a, b = srcmap.get(rel), arch.get(rel)
    if a is None:   bad.append(f"{rel}：archive 裡多出來的檔案，main 上沒有")
    elif b is None: bad.append(f"{rel}：archive 裡找不到")
    elif a != b:    bad.append(f"{rel}：內容被改過（{a[:8]} → {b[:8]}）")

if bad:
    print("✗ archive 不是原封不動的搬移：", file=sys.stderr)
    for b in bad: print("    " + b, file=sys.stderr)
    print("  archive 只能搬，不能順手改。要改內容請先開 spec/ 分支改規格。", file=sys.stderr)
    sys.exit(1)
print(f"  ✓ {len(srcmap)} 個檔案原封不動搬進 {adir}")
ARCHIVE_IDENTITY

    # 兩個 validate 都要過。
    # --archived 驗 tasks 有沒有全部完成（這是整個流程裡唯一驗它的地方）。
    npx openspec validate --archived --strict
    # --all 驗新生成的 main spec。archive 產生的 Purpose 是
    # 「TBD - created by archiving change <id>. Update Purpose after archive.」
    # 不改掉的話這一關會紅。**這正是要的** —— 沒有它，PR 全綠、合併後 main 才爆。
    npx openspec validate --all --strict

    echo "✓ archive：${ID}"
    ;;

  # ── governance/<desc> ── 執法層自己
  governance/*)
    # CI、CODEOWNERS、AGENTS.md、config.yaml 就是規則本身。
    # 它們要能被改，但必須單獨出現在一個 PR 裡讓人看見 ——
    # 夾在功能 PR 裡改 ci.yml 是這套設計最怕的事。
    #
    # 注意：這一關擋不住「在 PR 裡把 ci.yml 改成 run: true」。
    # 那個只有 CODEOWNERS + 第二個人的 review 擋得住。
    # 能機械擋的是 ruleset 的 workflows 規則，但那需要 org ruleset + Team 方案，
    # 這個 org 是 free。**不要以為這一關封住了它。**
    if OUT="$(echo "$CHANGED" | grep -vE '^(\.github/|\.gitignore$|AGENTS\.md|CLAUDE\.md|README\.md|CONTEXT\.md|openspec/config\.yaml|openspec/README\.md|docs/adr/|docs/DECISIONS\.md$|SETUP-GITHUB\.md$|package\.json|package-lock\.json)' || true)"; [ -n "$OUT" ]; then
      echo "✗ governance PR 只能改規則本身，不能夾帶產品程式碼或規格：" >&2
      echo "$OUT" | sed 's/^/    /' >&2
      exit 1
    fi
    has '^openspec/(changes|specs)/' && fail "governance 不得動 openspec/changes/ 或 openspec/specs/。"

    echo "✓ governance：只動了規則本身"
    ;;

  *)
    fail "分支 '${HEAD}' 不屬於任何已知類別。

  spec/<id>              規格。只動 openspec/changes/<id>/ 與 docs/adr/
  feat/<id>--<slice>     實作。<id> 必須已在 main 上
  fix/<id>--<slice>      同上
  chore/<desc>           無規格的小型維護。不得碰 openspec/ 與 .github/
  archive/<id>           把 delta 同步進 openspec/specs/
  governance/<desc>      改 CI、CODEOWNERS、AGENTS.md、config.yaml

封閉列舉是刻意的：沒列到的一律擋。"
    ;;
esac
