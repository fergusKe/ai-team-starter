#!/usr/bin/env bash
# 把 docs/WBS.md 產成一頁可以點開收合的網頁。
#
#     bash .github/scripts/wbs-page.sh          # 產生 docs/wbs.html
#     bash .github/scripts/wbs-page.sh --open   # 產生並開啟
#
# **產物不進版控。** 一份「從 WBS.md 產出來、卻自己存在版控裡」的 HTML
# 會漂 —— 有人改了 WBS 但忘了重產，那一頁就開始說謊，而且沒有人會發現。
# 它在 .gitignore 裡，要看就重跑一次。
#
# **狀態不是這裡算的。** 資料與狀態都跟 `progress.sh --json` 要 ——
# 曾經三個地方各算一次，給出三個不同的答案。現在只有一份實作。
#
# 這一頁跟 progress.sh 的差別：
#
#   progress.sh   現在做到哪裡（狀態、被什麼擋住、規則違規）。**每天用的**
#   這一頁         整份計畫長什麼樣（每一項的細節、每週負荷、跨項依賴）。**要review 時用的**
#
# 模板在 .github/scripts/wbs-page/ 底下，改樣式改那裡。

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

OPEN=0
[ "${1:-}" = "--open" ] && OPEN=1

SRC="docs/WBS.md"
DIR=".github/scripts/wbs-page"
OUT="docs/wbs.html"

[ -f "$DIR/template.html" ] || { echo "找不到 $DIR/template.html" >&2; exit 2; }

# **資料與狀態都跟 progress.sh 要，不要自己再解析一次。**
# 這一頁、progress.sh、Excel 曾經各自算過一次狀態，三邊給出三個答案 ——
# 那正是這個 repo 到處在防的「同一件事寫在兩個地方」。現在只有一份實作。
DATA="$(bash .github/scripts/progress.sh --json)" || {
  echo "✗ progress.sh --json 失敗" >&2; exit 1; }

DATA="$DATA" python3 - "$DIR" "$OUT" <<'PY'
import os, json, sys, pathlib

data = json.loads(os.environ["DATA"])
tpl_dir, out_path = pathlib.Path(sys.argv[1]), sys.argv[2]

if not data["items"]:
    print("這個專案還沒有 docs/WBS.md（或裡面沒有工作項目）——", file=sys.stderr)
    print("先把工作分解表放進去，格式見 progress.sh 開頭的註解。", file=sys.stderr)
    raise SystemExit(2)

blob = json.dumps(data, ensure_ascii=False).replace("</script>", "<\\/script>")
tpl = (tpl_dir / "template.html").read_text(encoding="utf-8")
head, body = tpl.split("</style>", 1)
html = ("<!doctype html>\n<html lang=\"zh-Hant\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
        + head + "</style>\n</head>\n<body>\n" + body
        + "\n<script type=\"application/json\" id=\"wbs-data\">" + blob + "</script>\n"
        + "<script>\n" + (tpl_dir / "app.js").read_text(encoding="utf-8") + "\n</script>\n"
        + "</body>\n</html>\n")
pathlib.Path(out_path).write_text(html, encoding="utf-8")

# 銜接清單是哪一組用算的，不要寫死組名 —— 見 app.js 的同一段
_gap = {i["group"] for i in data["items"] if data["affects"].get(i["id"])}
fe = [i for i in data["items"] if i["group"] not in _gap]
print("✓ " + out_path)
print("  " + str(len(data["items"])) + " 項（" + str(len(fe)) + " 項在前端手上、"
      + str(len(data["items"]) - len(fe)) + " 項待銜接）、"
      + str(sum(i["pts"] for i in fe)) + " 點、" + str(len(data["milestones"])) + " 個里程碑")
PY

rc=$?
[ $rc -eq 0 ] || exit $rc

if [ "$OPEN" = "1" ]; then
  case "$(uname)" in
    Darwin) open "$OUT" ;;
    *) command -v xdg-open >/dev/null && xdg-open "$OUT" || echo "自己開 $OUT" ;;
  esac
fi
