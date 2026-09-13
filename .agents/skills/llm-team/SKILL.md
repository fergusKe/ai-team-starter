---
name: llm-team
description: 當統整者要把一張葉子票交給便宜模型寫、兩位以上模型複審時用；觸發詞：開票、交給寫手、llm-team、ticket、複審
---

# 多模型分工票流程（llm-team）

當你（統整者）有一張目標明確、改動範圍集中（≤ 5 個檔案）且具備本機驗收指令的葉子票時，
使用本 skill 將實作交給便宜模型編寫，並由雙模型進行獨立複審。

brief 五段：①目標（含使用者真實踩到的情境）②只准動的檔案③事實（行號、既有測試怎麼 mock）④要做的事（編號）⑤驗收指令與回報格式；模板專案另有 `prompts/07-ticket.md` 長版。

## 快照與真源

真源在 fergus-claude-config `home/skills/llm-team/`，專案裡是快照，改程式回真源改、跑 `node ~/.claude/skills/llm-team/export.mjs --to <專案根>`，`setup --sync-check` 驗 manifest。

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
3. **收貨與坐實：**
   - 檢視終端印出的收貨摘要。
   - 親自開啟檔案坐實每位複審者提出的 Q6 關鍵查證事項。
4. **發布 Draft PR：**
   ```bash
   node .agents/skills/llm-team/ticket.mjs publish --name <ticket-id> [--title "<title>"]
   ```
   *注意：本流程永不自動 merge，最終合併留給人或統整者明確核准。*
