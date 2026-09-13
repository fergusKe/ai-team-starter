#!/usr/bin/env bash
# `llm-team` 快照測試。
# 快照＝唯讀、真源在別處，這裡驗的是「快照沒被人手改」＋「快照自己的測試綠」。
# 🔴 第 3 步不准寫成 `a && b`：`set -e` 對 AND 串列的非末段失敗不觸發 errexit，symlink 被刪也會綠（2026-09-13 T2 複審坐實）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "── 1/3 快照完整性（MANIFEST.sha256） ──"
node .agents/skills/llm-team/setup.mjs --sync-check

echo "── 2/3 快照測試套件 ──"
bash .agents/skills/llm-team/test.sh

echo "── 3/3 symlink 存活檢查 ──"
if [ ! -L .claude/skills/llm-team ]; then
  echo "✗ 3/3：.claude/skills/llm-team 不是 symlink（正本在 .agents/skills/llm-team/，Claude 側靠這個 symlink 找到 skill）。修：ln -s ../../.agents/skills/llm-team .claude/skills/llm-team" >&2
  exit 1
fi
if [ ! -f .claude/skills/llm-team/SKILL.md ]; then
  echo "✗ 3/3：symlink 存在但指不到 SKILL.md（目標被刪或路徑錯）。修：檢查 .agents/skills/llm-team/SKILL.md 與 symlink 目標" >&2
  exit 1
fi

echo "✓ llm-team 測試全數通過"
