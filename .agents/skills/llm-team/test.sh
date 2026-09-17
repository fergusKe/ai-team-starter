#!/usr/bin/env bash
# `llm-team`（`write.mjs`／`council.mjs`／`ticket.mjs`／`setup.mjs`／`export.mjs`／`usage.mjs`／兩個 PreToolUse 轉接器）的測試。
# 寫手 wrapper 與票流程不是閘門，但它們的 fail-closed 判定是尺，尺要有測試。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# 事故＝`--test` 子行程序列化通道被測試裡的裸 stdout 插壞、檔案級紅但斷言全綠、2026-09-15 撞到一次；
# 陽性對照＝把任一步改回 `node --test` 並不會立刻紅——這是時序 flake，對照只能是『直接執行的檔有真斷言失敗時 test.sh 仍 exit 非 0』；
# 停止條件＝Node runner 修掉這條（或改用 `--test-isolation=none` 經實測 100 輪全綠）時再改回 `--test` 取回並行。
echo "── 1/9 agy-pretooluse.test.mjs ──"
node agy-pretooluse.test.mjs

echo "── 2/9 llm-team.test.mjs ──"
node llm-team.test.mjs

echo "── 3/9 ticket.test.mjs ──"
node ticket.test.mjs

echo "── 4/9 batch.test.mjs ──"
node batch.test.mjs

echo "── 5/9 export.test.mjs ──"
node export.test.mjs

echo "── 6/9 codex-pretooluse.test.mjs ──"
node codex-pretooluse.test.mjs

# 事故＝WAS `_handoff.md` 2026-09-15 第一段「rtk 省 token 宣稱 vs 實測 cache_read 折算後上限 0.19–0.38%」——沒有量測工具時省了多少全靠說；
# 陽性對照＝把 `usage.mjs` 的 harness 判定拿掉 ⇒ `usage.test.mjs` 的 (a)／(h) 紅；
# 停止條件＝各 harness 都有 transcript 可量（`measurable:false` 不再出現）時，把 harness 判定段拆掉、本步保留。
echo "── 7/9 usage.test.mjs ──"
node usage.test.mjs

# 🔴 事故：1.7.4 的 SKILL.md L73「config repo 現有 15 張 llm-team 工具票…grandfathered」、L88 postExport 舉例
#   （WAS＝`pnpm run guards:llm-team-snapshot`）、L90–91 逐專案列舉 web-agency-system/GuildHub-frontend/
#   ai-team-starter 的 branch／main 模式與「接著依提示跑 tools/m4-ship.sh」、export.mjs:544
#   `console.log('→ 接著跑 tools/m4-ship.sh（M4 完整 guards）再 ff')`，都把單一專案（config repo／WAS）的操作
#   事實塞進共用快照——SKILL.md／export.mjs 會原樣 export 到每個 target repo，三個 target 因此讀到「別家的
#   下一步」（例如 GuildHub-frontend／ai-team-starter 也被印出跟 WAS 一樣的 m4-ship.sh 提示）。
# 陽性對照（sol block 複審第 3 輪 Q3/Q4 坐實，2026-09-17）：原本 branch／main 模式那條用單一 regex
#   `「?`?branch`? 模式」?.*「?`?main`? 模式」?` 要求兩者同一行才算命中——但 1.7.4 原文 L90／L91 是跨兩行
#   （`- \`web-agency-system\`（\`branch\` 模式）：…` 與 `- \`GuildHub-frontend\` 與 \`ai-team-starter\`（\`main\` 模式）：…`），
#   grep 逐行比對、`.*` 不跨行，這條 regex 對兩行分開的原始清單永遠不會命中，等於形同虛設。已重放坐實：
#   在暫存副本把 `git show 7c61db7d:home/skills/llm-team/SKILL.md` 的 L90–91 逐字放回目前的 SKILL.md 尾端再跑
#   `bash test.sh` ⇒ 8/9 印出兩行「🔴 SKILL.md 不得含字面「`branch` 模式」」「🔴 SKILL.md 不得含字面「`main` 模式」」、
#   exit 1（非零）；同樣把 export.mjs:544 原始那行
#   `console.log('→ 接著跑 tools/m4-ship.sh（M4 完整 guards）再 ff')` 放回 export.mjs ⇒ 更早在 5/9 就被
#   export.test.mjs 自己的斷言「export.mjs 原始碼不應含 tools/m4-ship.sh 字面」攔下、exit 1（非零）——沒走到
#   8/9 的 check_absent 也算數，因為 test.sh 本來就是一條會在第一個紅燈處停下的管線。改法：拆成兩條各自獨立的
#   `check_absent`（`branch` 模式／`main` 模式各一條，不用同一行同時比對兩者的 regex），逐行 `grep -qF` 天生
#   不受「兩者是否同一行」影響。還原（拿掉重放塞回的行）後 test.sh 重跑全綠。
#   （順帶坐實一個新問題：④ 段自己那句「target 清單、`branch`／`main` 模式…」原本會被新拆出的兩條
#   check_absent 誤判成違規字面——已改寫成不含 `branch`／`main` 反引號的通則敘述，避免正常文件被自己的閘擋下。）
# 陽性對照（sol block 複審第 4 輪 Q5 坐實，2026-09-17）：export.mjs 那條原本對「整份原始碼」比對
#   `tools/m4-ship.sh`，比 brief 指定的「console.log/console.error/throw 字串」更廣——事故出處註解（例如上面
#   這幾行）本身合法提到這個舊字面當史料，若原封不動出現在 export.mjs 裡會被誤紅。改法：export.mjs 那條先用
#   `perl` 剝掉 `/* ... */` 區塊註解與整行 `//` 行註解，只對剝完的內容比對；重放坐實：
#   - 註解裡寫 `// 曾經印過 tools/m4-ship.sh` ⇒ 剝完看不到，check 綠。
#   - `console.log('tools/m4-ship.sh')` 這種實際字串常值 ⇒ 剝完仍看得到，check 紅。
#   （export.test.mjs 對應有 `stripJsComments` 的 JS 版與同款陽性對照「1.8.0 ④ (Q5)」。）
# 停止條件：targets.json 的 target metadata schema 有機器驗證（例如 setup.mjs --sync-check 逐 target 驗 nextSteps／
#   postExport 形狀）且 export.test.mjs 對每個真實 target 都有對應斷言時，這道 literal gate 可以撤（改信 schema 驗證）。
echo "── 8/9 共用快照不放單一專案操作事實（literal check） ──"
fail=0
check_absent() {
  local pattern="$1" file="$2"
  if grep -qF -- "$pattern" "$file"; then
    echo "🔴 ${file} 不得含字面「${pattern}」" >&2
    fail=1
  fi
}
# 只用在 export.mjs 那條（射程限縮到 brief 指定的「會執行的字串」，不要求整份原始碼連註解都不准提）：
# 先剝掉 /* ... */ 區塊註解與整行 // 註解，再對剝完的內容做字面比對。
check_absent_outside_comments() {
  local pattern="$1" file="$2" stripped
  stripped=$(perl -0777 -pe 's{/\*.*?\*/}{}gs; s{^[ \t]*//.*$}{}gm' -- "$file")
  if printf '%s' "$stripped" | grep -qF -- "$pattern"; then
    echo "🔴 ${file} 剝掉註解後仍含字面「${pattern}」" >&2
    fail=1
  fi
}
check_absent '15 張 llm-team 工具票' SKILL.md
check_absent 'guards:llm-team-snapshot' SKILL.md
check_absent '接著依提示跑 tools/m4-ship.sh' SKILL.md
check_absent_outside_comments 'tools/m4-ship.sh' export.mjs
check_absent '`branch` 模式' SKILL.md
check_absent '`main` 模式' SKILL.md
if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "  ✓ SKILL.md／export.mjs 沒有殘留單一專案操作事實"

# 🔴 事故：1.7.4 的 SKILL.md〈標準程序骨架〉第 3 步「收貨與坐實」直接跳第 4 步「發布 Draft PR」，中間沒有
#   ticket.mjs accept；照著骨架做 publish 必 exit 2（缺少 q6Receipt）。ticket.mjs 檔頭另有一句舊敘述「統整者一張
#   票只花兩個回合：一回合 ticket 起跑，一回合收貨」，跟 1.7 起 run → accept → publish／land 實際要跑的呼叫次數
#   已經對不上（accept 本身也要算一次）；骨架補了 accept 之後改用列步驟，不准把這句「兩回合」搬進 SKILL.md。
# 陽性對照：把 SKILL.md 的 accept 步驟砍掉、或把「兩回合」字面塞回去，這一步就會紅。
# 停止條件：〈標準程序骨架〉改由 `ticket.mjs --help`（或等價的機器可讀說明）直接生成、SKILL.md 不再手寫這段流程時，
#   這道 literal gate 可以撤。
echo "── 9/9 標準程序骨架含 accept、不含次數宣稱（literal check） ──"
fail=0
if ! grep -qF 'ticket.mjs accept' SKILL.md; then
  echo "🔴 SKILL.md〈標準程序骨架〉必須含 ticket.mjs accept 這一步" >&2
  fail=1
fi
if grep -qF '兩回合' SKILL.md; then
  echo "🔴 SKILL.md 不得再用「兩回合」描述流程（骨架要列步驟：run → 讀收貨摘要 → 親驗 Q6 → accept → publish／land）" >&2
  fail=1
fi
# 同義字面（兩次呼叫）也擋，sol 1.8.0 第 6 輪：跟「兩回合」同類——次數宣稱跟骨架（batch→accept→land 三次）對不上。
check_absent '兩次呼叫' SKILL.md
# 同義字面（各一次呼叫）也擋，sol 1.8.0 第 7 輪 Q1：第 6 輪自己補的措辭本身也是次數宣稱，一併擋掉，改成只列步驟。
check_absent '各一次呼叫' SKILL.md
if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "  ✓ 骨架含 accept、不含次數宣稱"

echo "✓ llm-team 測試全數通過"
