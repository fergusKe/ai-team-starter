#!/usr/bin/env bash
# `llm-team`（`write.mjs`／`council.mjs`／`ticket.mjs`／`setup.mjs`）的測試。
# 寫手 wrapper 與票流程不是閘門，但它們的 fail-closed 判定是尺，尺要有測試。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "── 1/2 llm-team.test.mjs ──"
node --test .github/scripts/llm-team/llm-team.test.mjs

echo "── 2/2 ticket.test.mjs ──"
node --test .github/scripts/llm-team/ticket.test.mjs

echo "✓ llm-team 測試全數通過"
