#!/usr/bin/env bash
# `llm-team` 快照測試。
# 快照＝唯讀、真源在別處，這裡驗的是「快照沒被人手改」＋「快照自己的測試綠」。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "── 1/3 快照完整性（MANIFEST.sha256） ──"
node .agents/skills/llm-team/setup.mjs --sync-check

echo "── 2/3 快照測試套件 ──"
bash .agents/skills/llm-team/test.sh

echo "── 3/3 symlink 存活檢查 ──"
test -L .claude/skills/llm-team && test -f .claude/skills/llm-team/SKILL.md

echo "✓ llm-team 測試全數通過"
