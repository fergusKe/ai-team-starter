#!/usr/bin/env bash
# `llm-team`（`write.mjs`／`council.mjs`／`ticket.mjs`／`setup.mjs`／`export.mjs`／`usage.mjs`／兩個 PreToolUse 轉接器）的測試。
# 寫手 wrapper 與票流程不是閘門，但它們的 fail-closed 判定是尺，尺要有測試。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# 事故＝`--test` 子行程序列化通道被測試裡的裸 stdout 插壞、檔案級紅但斷言全綠、2026-09-15 撞到一次；
# 陽性對照＝把任一步改回 `node --test` 並不會立刻紅——這是時序 flake，對照只能是『直接執行的檔有真斷言失敗時 test.sh 仍 exit 非 0』；
# 停止條件＝Node runner 修掉這條（或改用 `--test-isolation=none` 經實測 100 輪全綠）時再改回 `--test` 取回並行。
echo "── 1/7 agy-pretooluse.test.mjs ──"
node agy-pretooluse.test.mjs

echo "── 2/7 llm-team.test.mjs ──"
node llm-team.test.mjs

echo "── 3/7 ticket.test.mjs ──"
node ticket.test.mjs

echo "── 4/7 batch.test.mjs ──"
node batch.test.mjs

echo "── 5/7 export.test.mjs ──"
node export.test.mjs

echo "── 6/7 codex-pretooluse.test.mjs ──"
node codex-pretooluse.test.mjs

# 事故＝WAS `_handoff.md` 2026-09-15 第一段「rtk 省 token 宣稱 vs 實測 cache_read 折算後上限 0.19–0.38%」——沒有量測工具時省了多少全靠說；
# 陽性對照＝把 `usage.mjs` 的 harness 判定拿掉 ⇒ `usage.test.mjs` 的 (a)／(h) 紅；
# 停止條件＝各 harness 都有 transcript 可量（`measurable:false` 不再出現）時，把 harness 判定段拆掉、本步保留。
echo "── 7/7 usage.test.mjs ──"
node usage.test.mjs

echo "✓ llm-team 測試全數通過"
