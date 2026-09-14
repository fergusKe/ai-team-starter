#!/usr/bin/env bash
# `llm-team`（`write.mjs`／`council.mjs`／`ticket.mjs`／`setup.mjs`／`export.mjs`／兩個 PreToolUse 轉接器）的測試。
# 寫手 wrapper 與票流程不是閘門，但它們的 fail-closed 判定是尺，尺要有測試。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "── 1/5 agy-pretooluse.test.mjs ──"
node --test agy-pretooluse.test.mjs

echo "── 2/5 llm-team.test.mjs ──"
node --test llm-team.test.mjs

echo "── 3/5 ticket.test.mjs ──"
node --test ticket.test.mjs

echo "── 4/5 export.test.mjs ──"
node --test export.test.mjs

echo "── 5/5 codex-pretooluse.test.mjs ──"
node --test codex-pretooluse.test.mjs

echo "✓ llm-team 測試全數通過"
