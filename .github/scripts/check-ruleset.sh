#!/usr/bin/env bash
# 比對兩份快照與 GitHub 上實際生效的設定：
#
#   .github/ruleset.json         分支保護（branch ruleset）
#   .github/repo-settings.json   repo 自己的設定（合併後刪分支、Actions 權限）
#
# 為什麼需要這支腳本：ruleset 不在版控裡。文件描述的和實際生效的會**無聲地漂開**，
# 而漂開的方向通常是「文件說有保護、實際上沒有」——
# 這個 repo 就發生過：AGENTS.md 寫「CODEOWNERS review 擋得住東西」，
# 而實際設定是 require_code_owner_review: false，CODEOWNERS 完全沒有效力。
# 沒有任何東西會告訴你這件事。
#
# **這支腳本不是閘門**，它不在 CI 裡跑（讀 ruleset 需要 administration:read，
# 而預設的 GITHUB_TOKEN 沒有；為此擴大 CI 的權限面不划算）。
# 它是給人和 agent 手動查的：
#
#     bash .github/scripts/check-ruleset.sh
#
# 比對方式是**子集檢查**：只驗快照裡宣告的欄位。
# GitHub 回傳的其他預設值（dismissal_restriction、required_reviewers 等）不管。
#
# **repo 層級的設定為什麼也要有快照**：它們只存在於 GitHub 的網頁上。
# 實際踩過 —— `delete_branch_on_merge` 是 false，而沒有任何東西說得出這件事，
# 直到 21 個已經合併的分支堆在本機才被發現。只寫進文件是不夠的（文件會漂），
# 所以跟 ruleset 一樣：宣告在版控裡，用這支比對。

set -uo pipefail

# repo 從 git remote 推出來，不要寫死 —— 這是模板，會被複製到別的地方。
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)}"
[ -n "$REPO" ] || { echo "✗ 認不出這是哪個 repo。設 REPO=owner/name 再跑一次。" >&2; exit 2; }

# **一定要印出來。** `gh repo view` 用的是「目前目錄的 default repository」，
# 在 fork 或多 remote 的情況下可能不是你以為的那一個。
# 建立或更新 ruleset 的時候不要靠推導，明確帶 REPO=owner/name。
echo "REPO=${REPO}"
# RULESET_FILE 可以指到別份快照。用途是負向測試 ——
# 一個從來沒紅過的檢查等於沒有檢查。
FILE="${RULESET_FILE:-$(git rev-parse --show-toplevel)/.github/ruleset.json}"

command -v gh >/dev/null || { echo "需要 gh CLI。" >&2; exit 2; }
[ -f "$FILE" ] || { echo "找不到 $FILE" >&2; exit 2; }

ID="$(python3 -c "import json,io;print(json.load(io.open('$FILE',encoding='utf-8')).get('_ruleset_id') or '')")"

# **ruleset 還沒建立不可以讓整支腳本停在這裡。** `SETUP-GITHUB.md` 的順序是
# 先設 repo 層級設定（第 4 節）、再建 ruleset（第 5 節）—— 停在這裡的話，
# 新專案在最需要檢查 repo 設定的那個時間點剛好檢查不到。
# 所以記下來繼續往下走，最後一起回非零。
RULESET_RC=0

if [ -z "$ID" ]; then
  cat >&2 <<EOF
✗ $FILE 的 _ruleset_id 還是空的 —— 這個 repo 還沒有建立 ruleset。

建立（會回傳新的 id）：

    gh api -X POST repos/${REPO}/rulesets --input .github/ruleset.json --jq .id

把回傳的數字填進 .github/ruleset.json 的 _ruleset_id，然後再跑一次這支腳本。

⚠️ 建立之前先讀 SETUP-GITHUB.md 的〈Branch Ruleset〉——
   裡面有兩個一定要自己決定的欄位（integration_id 與 bypass_actors）。

（下面還是會檢查 repo 層級的設定 —— 那一部分不需要 ruleset。）
EOF
  RULESET_RC=2
fi

# 兩份 JSON 都用檔案傳給 python。
# **不要用兩個 heredoc 疊在同一個指令上** —— bash 只認最後一個 stdin 重導，
# python 會收到 JSON 而不是腳本。（踩過。）
#
# 每次一個新的暫存檔。**不要用固定可預測的路徑** ——
# 兩個 repo 同時檢查會互相覆蓋，而且固定路徑可以被預先放一個 symlink 進去。
LIVE_JSON="$(mktemp -t ruleset-live)"

if [ "$RULESET_RC" = 0 ] && ! gh api "repos/${REPO}/rulesets/${ID}" > "$LIVE_JSON" 2>/dev/null; then
  echo "✗ 讀不到 ruleset ${ID}。需要對這個 repo 有 admin 權限。" >&2
  RULESET_RC=2
fi

if [ "$RULESET_RC" = 0 ]; then
python3 - "$FILE" "$LIVE_JSON" <<'PY'
import json, sys, io

expected = json.load(io.open(sys.argv[1], encoding="utf-8"))
live = json.load(io.open(sys.argv[2], encoding="utf-8"))

bad = []
def cmp(label, want, got):
    mark = "✓" if want == got else "✗"
    print(f"  {mark} {label}")
    if want != got:
        print(f"      快照: {want}")
        print(f"      實際: {got}")
        bad.append(label)

print(f"ruleset {expected['_ruleset_id']}（{expected['name']}）")
print()

for k in ("name", "target", "enforcement"):
    cmp(k, expected[k], live.get(k))

cmp("conditions.ref_name", expected["conditions"]["ref_name"],
    live.get("conditions", {}).get("ref_name"))

# actor_id 只在 GitHub 自己回傳 null 的時候略過（OrganizationAdmin 就是這樣：
# PUT 要填 1，GET 回 null）。**其他情況一定要比** ——
# RepositoryRole 的 5 是 admin、4 是 write，型別與模式相同但 id 不同
# 是完全不同的授權範圍，全域丟棄 actor_id 會讓那種變更驗不出來。
def actors(o, live_ids):
    out = []
    for a in o.get("bypass_actors", []):
        t, m = a["actor_type"], a["bypass_mode"]
        aid = a.get("actor_id")
        if live_ids.get((t, m), "MISSING") is None:
            aid = None          # GitHub 對這一類就是回 null，兩邊都正規化掉
        out.append((t, m, aid))
    return sorted(out, key=lambda x: (x[0], x[1], str(x[2])))

live_ids = {(a["actor_type"], a["bypass_mode"]): a.get("actor_id")
            for a in live.get("bypass_actors", [])}
cmp("bypass_actors（型別、模式、id）", actors(expected, live_ids), actors(live, live_ids))

live_rules = {r["type"]: r.get("parameters") or {} for r in live.get("rules", [])}
exp_rules  = {r["type"]: r.get("parameters") or {} for r in expected.get("rules", [])}

missing = sorted(set(exp_rules) - set(live_rules))
extra   = sorted(set(live_rules) - set(exp_rules))
if missing:
    print(f"  ✗ 實際設定缺少規則: {', '.join(missing)}"); bad.append("missing rules")
if extra:
    print(f"  ✗ 實際設定多出規則: {', '.join(extra)}"); bad.append("extra rules")

for t in sorted(set(exp_rules) & set(live_rules)):
    for k, want in exp_rules[t].items():
        cmp(f"{t}.{k}", want, live_rules[t].get(k))

print()
print(f"current_user_can_bypass = {live.get('current_user_can_bypass')}")
print("  （always 代表你能勾 PR 頁面的 bypass rules 直接合併，包含 CI 紅的時候。")
print("   其他協作者看不到那個勾選框。）")
print()

if bad:
    print(f"✗ {len(bad)} 項不一致。")
    print()
    print("要嘛 GitHub 上被人改過（去看 Settings → Rules 的變更），")
    print("要嘛快照過期了。決定哪一邊是對的，然後：")
    print("  快照對 → gh api -X PUT repos/${REPO}/rulesets/${ID} --input .github/ruleset.json")
    print("  實際對 → 更新 .github/ruleset.json，走 governance/ 分支開 PR")
    sys.exit(1)

print("✓ ruleset 快照與實際設定一致。")
PY
RULESET_RC=$?
fi
RC_RULESET="$RULESET_RC"

# ── repo 層級的設定 ──────────────────────────────────────────────────
#
# 跟上面**分開讀**：ruleset 走 /rulesets/<id>，repo 設定走 /repos/<owner>/<repo>
# 與 /actions/permissions/workflow —— 三個不同的 endpoint。
RS_FILE="${REPO_SETTINGS_FILE:-$(git rev-parse --show-toplevel)/.github/repo-settings.json}"
RC_REPO=0
if [ -f "$RS_FILE" ]; then
  REPO_JSON="$(mktemp -t repo-live)"
  PERM_JSON="$(mktemp -t perm-live)"
  gh api "repos/${REPO}" > "$REPO_JSON" 2>/dev/null || : > "$REPO_JSON"
  gh api "repos/${REPO}/actions/permissions/workflow" > "$PERM_JSON" 2>/dev/null || : > "$PERM_JSON"

  python3 - "$RS_FILE" "$REPO_JSON" "$PERM_JSON" <<'PY2'
import json, sys, io

exp = json.load(io.open(sys.argv[1], encoding="utf-8"))

G, R, X = "\033[32m", "\033[31m", "\033[0m"


def load(path):
    """讀不到就回 None。**不可以回空字典** —— 那樣每一項都會變成
    「實際=沒有這個欄位」而被報成不一致，看起來像設定被改壞了，
    其實是權限不足抓不到。兩者的處置完全不同。"""
    try:
        d = json.load(io.open(path, encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except Exception:
        return None


live = {"repo": load(sys.argv[2]),
        "actions_workflow_permissions": load(sys.argv[3])}

print()
print("── repo 層級設定 ──")
bad, unreadable = [], []
for section in ("repo", "actions_workflow_permissions"):
    want_all = exp.get(section) or {}
    got_all = live[section]
    if want_all and got_all is None:
        unreadable.append(section)
        print(f"  ? {section}：讀不到（需要 admin 權限）"
              f" —— **讀不到不等於設定正確**")
        continue
    for k, want in want_all.items():
        got = got_all.get(k, "（沒有這個欄位）")
        j = lambda v: json.dumps(v, ensure_ascii=False)
        if got == want:
            print(f"  {G}✓{X} {section}.{k} = {j(want)}")
        else:
            print(f"  {R}✗{X} {section}.{k}：快照 {j(want)}，實際 {j(got)}")
            bad.append(f"{section}.{k}")

if unreadable:
    raise SystemExit(2)
if bad:
    print()
    print(f"✗ repo 設定有 {len(bad)} 項不一致。")
    print("  實際的對 → 更新 .github/repo-settings.json，走 governance/ 分支開 PR")
    print("  快照的對 → 照 SETUP-GITHUB.md 那一節把 GitHub 上的設定改回來")
    raise SystemExit(1)
print("✓ repo 設定與快照一致。")
PY2
  RC_REPO=$?
  rm -f "$REPO_JSON" "$PERM_JSON"
else
  echo
  echo "（沒有 .github/repo-settings.json，跳過 repo 層級設定的比對）"
fi

# **退出碼要分得出「不一致」與「查不到」。** 1 = 快照跟實際對不上（去改一邊）；
# 2 = 根本沒查到（沒建 ruleset、沒有 admin 權限）——「查不到」不等於「沒問題」，
# 但它跟「查到了而且不對」的處置完全不同。
if [ "$RC_RULESET" = 2 ] || [ "$RC_REPO" = 2 ]; then exit 2; fi
if [ "$RC_RULESET" != 0 ] || [ "$RC_REPO" != 0 ]; then exit 1; fi
exit 0
