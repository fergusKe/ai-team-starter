# GEMINI.md

Antigravity CLI（agy）進入此 Repository 後：

**先判斷角色。** 提示第一行是哨兵 `【llm-team 寫手票】`（`.agents/skills/llm-team/write.mjs` 固定輸出的第一行）⇒ 你是**寫手**：只照票文與提示做、只准跑提示列出的指令頭、越界就停下回報，**不必**讀本檔其餘段落與 `AGENTS.md`。否則你是**統整者**，往下讀。

1. 先讀 `AGENTS.md`；它是唯一 normative workflow 規範（與 `CLAUDE.md` 指向同一份，本檔不重複它的內容）。
2. 跑 `git branch --show-current` 與 `bash .github/scripts/progress.sh`（`CLAUDE.md` 第 2 條），看現在有哪些 change、各自做到哪。
3. 派工一律用 `.agents/skills/llm-team/ticket.mjs`（流程入口 `.agents/skills/llm-team/SKILL.md`：`setup --check` → `ticket run` → 親自坐實複審 Q6 → `publish` 開 Draft PR），**不用 agy 內建 subagent 寫功能碼**；寫手是便宜模型、複審是兩位獨立模型（名單在 `llm-team.config.json`），你自己不寫功能碼。
4. 開工先跑 `node .agents/skills/llm-team/setup.mjs --check`，有紅就停。

**權限與安全**：🔴 不准用 `--dangerously-skip-permissions`。破壞性指令閘在全域 `~/.gemini/config/hooks.json`（`setup --check` 驗它有載入）；repo 隨附的 `.agents/hooks.json`（若有）只是 fallback。

**模型**：清單以 `agy models` 為準，本檔不寫死模型 ID。

**記憶**：本專案的記憶只走 repo 檔案（`openspec/changes/*/tasks.md`、`docs/DECISIONS.md`、`.local/llm-team/` 台帳）；agy 自己的對話紀錄不是真源。

**merge**：本 repo 只走 PR（GitHub ruleset 是唯一的門，本機閘可繞）；`ticket.mjs publish` 只開 Draft PR，永不自動 merge，合併由人按。
