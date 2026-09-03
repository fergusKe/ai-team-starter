#!/usr/bin/env bash
# 「現在做到哪裡」的答案。
#
#     bash .github/scripts/progress.sh          # 只看有動靜的
#     bash .github/scripts/progress.sh --all    # 連還沒開始的一起列
#     bash .github/scripts/progress.sh --week W1
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
#   openspec/changes/<id>/   進行中的 change 與它的 tasks.md 打勾狀態
#   openspec/changes/archive/ 已經完成並封存的
#   git branch -r            有沒有人正在某個 change 上開分支
#
# change 與 WBS 的對應靠**命名**：change id 要以 WBS ID 開頭（小寫），
# 例如 fe-c01-appshell 對應 FE-C01。這條寫在 AGENTS.md。
# 對不起來的 change 會單獨列在最後，那通常代表命名沒照規矩。
#
# **沒有 docs/WBS.md 也能用** —— 那時就只列 change 本身與它們的進度，
# 不做對應（沒有東西可以對，把每個 change 都說成「命名錯誤」是錯的訊號）。
#
# 要讓它認得你的 WBS，表格的**第一欄放工作項目 ID**、第四欄是週次、
# 第五欄是點數，ID 的格式是 `<大寫字母>-<大寫字母><數字>`（例如 FE-C01、API-W03）。
# 同一個項目的續行第一欄留空。

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

ONLY_WEEK=""
SHOW_ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --all)  SHOW_ALL=1 ;;
    --week) shift; ONLY_WEEK="${1:-}" ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "不認得的參數：$1" >&2; exit 2 ;;
  esac
  shift
done

git fetch -q origin 2>/dev/null || true

SHOW_ALL="$SHOW_ALL" ONLY_WEEK="$ONLY_WEEK" python3 - <<'PY'
import os, re, subprocess, pathlib, collections

SHOW_ALL = os.environ.get("SHOW_ALL") == "1"
ONLY_WEEK = os.environ.get("ONLY_WEEK") or ""

G, Y, R, D, B, X = "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[1m", "\033[0m"

# ── WBS：ID → (名稱, 週, 點數合計) ─────────────────────────────────
wbs, order = {}, []
wbs_path = pathlib.Path("docs/WBS.md")
if wbs_path.exists():
    cur = None
    for line in wbs_path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 5:
            continue
        wid, name, _work, week, pts = cells[0], cells[1], cells[2], cells[3], cells[4]
        if re.fullmatch(r"[A-Z]+-[A-Z][0-9]+", wid):
            cur = wid
            wbs[wid] = {"name": name, "weeks": set(), "pts": 0}
            order.append(wid)
        if cur is None:
            continue
        if re.fullmatch(r"W[0-9]+(–W[0-9]+)?", week):
            wbs[cur]["weeks"].add(week)
        if pts.isdigit():
            wbs[cur]["pts"] += int(pts)

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
    cid = change_for(wid)
    if cid is None:
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
    tally[state] += 1
    if state == "未開始" and not SHOW_ALL:
        continue
    rows.append((colour, wid, info["name"][:18], weeks, info["pts"], state, detail))

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

total = sum(tally.values())
if total:
    parts = [f"{k} {v}" for k, v in tally.most_common()]
    print(f"{B}WBS 共 {total} 項{X}：" + "、".join(parts))
    if not SHOW_ALL and tally.get("未開始"):
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
PY
