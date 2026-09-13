---
name: llm-team
description: 當統整者要把一張葉子票交給便宜模型寫、兩位以上模型複審時用；觸發詞：開票、交給寫手、llm-team、ticket、複審
---

# 多模型分工票流程（llm-team）

當你（統整者）有一張目標明確、改動範圍集中（≤ 5 個檔案）且具備本機驗收指令的葉子票時，
使用本 skill 將實作交給便宜模型編寫，並由雙模型進行獨立複審。

brief 五段：①目標（含使用者真實踩到的情境）②只准動的檔案③事實（行號、既有測試怎麼 mock）④要做的事（編號）⑤驗收指令與回報格式；模板專案另有 `prompts/07-ticket.md` 長版。

## 快照與真源

真源在 fergus-claude-config `home/skills/llm-team/`，專案裡是快照，改程式回真源改、跑 `node ~/.claude/skills/llm-team/export.mjs --to <專案根>`，`setup --sync-check` 驗 manifest；真源新增檔不算漂移（export 時自動歸為 sourceNew 同步過去，只有目標目錄已存在同名檔但未入 manifest 才是手動漂移 unlisted）。

## 標準程序骨架

1. **環境檢查（初次執行）：**
   ```bash
   node .agents/skills/llm-team/setup.mjs --check
   ```
2. **啟動票流程（起跑）：**
   ```bash
   node .agents/skills/llm-team/ticket.mjs run \
     --name <ticket-id> \
     --brief <brief-file> \
     --branch feat/<id>--<slice> \
     --allow <path>... \
     --test "<acceptance-command>"
   ```
   *注意：`--allow` 每檔一次（例如 `--allow a --allow b`，不可串在同一個旗標後，多餘位置參數會報錯）。*
3. **收貨與坐實：**
   - 複審者並行、8 分鐘 timeout、心跳（每 60 秒印進度，超時以「不簽（timeout）」計）。
   - 檢視終端印出的收貨摘要。
   - 親自開啟檔案坐實每位複審者提出的 Q6 關鍵查證事項。
4. **發布 Draft PR：**
   ```bash
   node .agents/skills/llm-team/ticket.mjs publish --name <ticket-id> [--title "<title>"]
   ```
   *注意：本流程永不自動 merge，最終合併留給人或統整者明確核准。*

## agy 破壞性指令閘

全域 `hooks.json` → `agy-pretooluse.sh` → `block-dangerous.sh`；放行值 `ask`；射程只到 `run_command` 的指令字串——`manage_task send_input`、`call_mcp_tool`、寫檔工具改 package.json 再跑 allow 內指令、`node --test` 內的 fs API 都不在射程（下一票 path guard）。
守門候選順序：`$LLM_TEAM_GUARD` → `<repoRoot>/scripts/claude-hooks/block-dangerous.sh` → `$HOME/.claude/hooks/block-dangerous.sh` → `../../hooks/block-dangerous.sh`（真源相對路徑）。
事故記錄：2026-09-13 快照 export 到 web-agency-system 後 test.sh 因整合測試找不到守門而整套紅，證明「守門在哪」在專案位置是未定義的，setup --check 找不到任何候選即報紅閘；停止條件為真源自帶守門副本（單一來源）、候選縮成一項時拆掉本檢查。
出處：2026-09-13 三方定案（config repo commit 64be3f4；WAS docs/agents/DISPATCH.md §agy）。
