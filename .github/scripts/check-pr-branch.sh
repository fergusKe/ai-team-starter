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

RANGE="origin/${BASE}...HEAD"
CHANGED="$(git diff --name-only "$RANGE")"
[ -z "$CHANGED" ] && { echo "沒有變更。"; exit 0; }

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
    if MODES="$(git diff --raw "$RANGE" | awk '$2 ~ /^(120000|160000)$/ {print $NF"  (mode "$2")"}')"; [ -n "$MODES" ]; then
      echo "✗ chore 不得新增 symlink 或 submodule：" >&2
      echo "$MODES" | sed 's/^/    /' >&2
      exit 1
    fi

    # binary：git 只印「Binary files differ」，bytes 上界看不到真實內容。
    if BIN="$(git diff --numstat "$RANGE" | awk -F'\t' '$1=="-" && $2=="-" {print $3}')"; [ -n "$BIN" ]; then
      echo "✗ chore 不得包含 binary 檔案：" >&2
      echo "$BIN" | sed 's/^/    /' >&2
      exit 1
    fi

    # diff 的 bytes 上界。lockfile 排除 —— 它是機器產生的，
    # 人不讀它；它的安全性由 CI 的 lockfile-lint 那一關管，不是由大小管。
    BYTES="$(git diff "$RANGE" -- . ':(exclude)package-lock.json' | wc -c | tr -d ' ')"
    [ "$BYTES" -le "$CHORE_MAX_BYTES" ] \
      || fail "chore 的 diff 是 ${BYTES} bytes，超過上限 ${CHORE_MAX_BYTES}（不含 lockfile）。要嘛拆小，要嘛它其實需要一份規格。"

    echo "✓ chore：${BYTES} bytes / 上限 ${CHORE_MAX_BYTES}"
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
    if MOD="$(git diff --name-status "$RANGE" -- "openspec/changes/${ID}/" | grep -v '^D' || true)"; [ -n "$MOD" ]; then
      echo "✗ archive PR 對 openspec/changes/${ID}/ 只能是刪除，不能順手改內容：" >&2
      echo "$MOD" | sed 's/^/    /' >&2
      exit 1
    fi

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
    if OUT="$(echo "$CHANGED" | grep -vE '^(\.github/|\.gitignore$|AGENTS\.md|CLAUDE\.md|README\.md|CONTEXT\.md|openspec/config\.yaml|openspec/README\.md|docs/adr/|package\.json|package-lock\.json)' || true)"; [ -n "$OUT" ]; then
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
