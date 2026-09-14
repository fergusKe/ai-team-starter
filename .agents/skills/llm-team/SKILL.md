---
name: llm-team
description: 當統整者要把一張葉子票交給便宜模型寫、兩位以上模型複審時用；觸發詞：開票、交給寫手、llm-team、ticket、複審
---

# 多模型分工票流程（llm-team）

當你（統整者）有一張目標明確、改動範圍集中（≤ 5 個檔案）且具備本機驗收指令的葉子票時，
使用本 skill 將實作交給便宜模型編寫，並由統整者 profile 指定的複審者獨立複審。

## 三種統整者 profiles（config schema v2）

三種 harness（Claude Code／agy／codex）都能當統整者輪替；**用量是第一約束**（codex 只有 ChatGPT Plus、Gemini 桶曾被「統整者＋複審同桶」吃光）。
🔴 **agy／codex 當統整者只發生在「Claude 額度用完」時**——所以那兩個 profile 的名單只有 agy＋codex 兩桶、沒有任何 Claude 角色，一般票裁決交 Fergus（Fergus 2026-09-14 硬約束）。
2026-09-14 三方（Claude Code、codex gpt-5.6-sol、Gemini 3.1 Pro）三輪定案的名單（真源模板 `config.json`，各 repo 的 `llm-team.config.json` 由統整者手改）：

| profile | 統整者 | 寫手 | 一般票複審 | block 級複審 | 一般票裁決 | block 未決 |
|---|---|---|---|---|---|---|
| `claude`（預設） | claude / claude-code〔anthropic〕 | agy/gemini-3.8-flash-high〔gemini〕 | agy/gemini-3.1-pro-high〔gemini〕 | agy/gemini-3.1-pro-high ＋ codex/gpt-5.6-sol〔openai〕 | codex/gpt-5.6-sol | human |
| `agy` | agy/gemini-3.1-pro-high〔gemini〕 | 同上 | codex/gpt-5.6-sol | codex/gpt-5.6-sol | human | human |
| `codex`（短票備用，統整 effort medium） | codex/gpt-5.6-sol〔openai〕 | 同上 | agy/gemini-3.1-pro-high | agy/gemini-3.1-pro-high | human | human |

原則（全部是 `lib.mjs validateProfiles` 的不變式測試，config 違反 ⇒ loadConfig throw 並指名 profile 與哪條）：
- 統整者不在自己票的任何複審／裁決名單；**統整者與任何複審者、裁決者不同 quotaBucket**（`anthropic|gemini|agy-claude|openai`）。
- 裁決者 ∉ 一般票複審名單；`adjudicator` 可以是成員物件或 `"human"`；`blockAdjudicator` 只准 `"human"`。
- `reviewers`／`blockReviewers` 非空、同一名單不重複（harness＋model）；兩者可以相同。
- `harness ∈ {agy, codex, claude}`，**`claude` 只准出現在 `coordinator`**。codex 成員可帶 `"effort": "high|medium"`（預設 high）。
- **`writer.harness` 只准 `agy`**（唯一的寫手 runner 是 `write.mjs`）：`claude`／`codex` ⇒ loadConfig throw，`writerFrom` 讀者側再擋一次；`LLM_TEAM_WRITER` 只覆寫 model、蓋不掉 harness。
- 成員顯示名 `<harness>/<短名>`（`agy/gemini`、`codex/gpt-5-6-sol`），輸出檔名把 `/` 換成 `-`（`review/agy-gemini.txt`）。
- schemaVersion 1（`models`／`codexTier`）已廢：loadConfig 直接拒絕、不自動轉換，手改成 `writer`＋`profiles`。

`ticket run`／`council plan|review`／`setup --check` 都**必帶 `--coordinator <claude|agy|codex>`**（或設 env `LLM_TEAM_COORDINATOR`）；缺或不在 profiles ⇒ exit 2 並列出可用 profiles。
summary.json 是 `schemaVersion: 2`，帶 `coordinator`（profile 名）與 `reviewers`（該票的**預期**名單，含 harness/model/quotaBucket）。
**實際名單只認 council 寫的 `review/members.json`**（每位實際跑的成員：`{name, harness, model, quotaBucket, overall, q, empty, timedOut, invalid, exit, signal, ms}`）：`ticket run` 從它取 `review.members`（不再按預期檔名讀文字、自貼身分），
與預期名單比**身分三元組 harness+model+quotaBucket**（不比 name——`agy/gemini` 同短名可以是 pro-high 也可以是 pro-low）；少一位／多一位／同 name 不同 model ⇒ `rosterMismatch: true`（附 `rosterDiff`）、run 回 3。
publish 對舊 summary（≠ 2）直接擋，要求名單**全員到齊**（三元組多重集合相等；一般票名單只有 1 位也算齊），且回頭讀 `review/members.json`——缺檔、與 `summary.reviewers` 不符、`rosterMismatch: true` 都擋。

各 harness 的統整者啟動姿態（一句）：
- Claude Code：互動 session（就是你現在這個）。
- agy：`agy --model gemini-3.1-pro-high`。
- codex：`codex -m gpt-5.6-sol --sandbox workspace-write -c 'sandbox_workspace_write.network_access=true' -c model_reasoning_effort="medium"`（全域 config 維持 read-only；只做短票 ≤ 5 檔、可逆、非風險域）。

## 用量規則

- **Gemini 桶 limit ⇒ 票流程全線停到 reset**（寫手在 Gemini 桶，沒有替補）；`claude` profile 可改走 Claude subagent 流程（CLAUDE.md §派工機制）。
- 任一桶 429 ⇒ **該角色停線、不找替補**；統整者把停線事實記進 `_handoff.md` 檔頭。
- 複審每票上限 **2 輪 ＋ 1 次釐清**；超過回統整者。
- `codex` profile 只做短票：≤ 5 檔、可逆、非風險域（`riskDomains`）。
- `agy`／`codex` profile 只在 Claude 額度用完時使用 ⇒ 名單只有 agy＋codex 兩桶，一般票裁決交 Fergus。

brief 五段：①目標（含使用者真實踩到的情境）②只准動的檔案③事實（行號、既有測試怎麼 mock）④要做的事（編號）⑤驗收指令與回報格式；模板專案另有 `prompts/07-ticket.md` 長版。

## 快照與真源

真源在 fergus-claude-config `home/skills/llm-team/`，專案裡是快照，改程式回真源改、跑 `node ~/.claude/skills/llm-team/export.mjs --to <專案根>`，`setup --sync-check` 驗 manifest；真源新增檔不算漂移（export 時自動歸為 sourceNew 同步過去，只有目標目錄已存在同名檔但未入 manifest 才是手動漂移 unlisted）。

## 標準程序骨架

1. **環境檢查（初次執行；依你是哪一種統整者）：**
   ```bash
   node .agents/skills/llm-team/setup.mjs --check --coordinator <claude|agy|codex>
   ```
   共同：config v2＋不變式、守門、寫手 agy settings 對帳、該 profile 各角色用到的 harness binary（**含統整者自己的**——`--check` 不一定在統整者的 harness 裡跑：agy 找 cask／`AGY_BIN`、codex `codex --version`／`CODEX_BIN`、claude `claude --version`／`CLAUDE_BIN`；缺 ⇒ 紅並指名「統整者」）。agy 統整者另查 agy 全域 hooks.json；codex 統整者另查 `$CODEX_HOME/hooks.json`（路徑＋**matcher 要涵蓋 Bash**）並真的跑一次 deny canary；claude 統整者另查 `~/.claude/settings.json` 的 block-dangerous hook。
2. **啟動票流程（起跑）：**
   ```bash
   node .agents/skills/llm-team/ticket.mjs run \
     --coordinator <claude|agy|codex> \
     --name <ticket-id> \
     --brief <brief-file> \
     --branch feat/<id>--<slice> \
     --allow <path>... \
     --test "<acceptance-command>"
   ```
   *注意：`--allow` 每檔一次（例如 `--allow a --allow b`，不可串在同一個旗標後，多餘位置參數會報錯）。*
   *P5：寫手 exit 非 0（2＝守門擋下、3＝被拒／越界／逾時）⇒ 不跑 `--test`、不開 council，**一律寫 summary.json**（`review: null`）並印收貨摘要；exit 2 且本次新建的空 worktree 照舊清掉、run 回 2；逾時另有 `writeTimedOut: true`（來自 `write/timeout.json`）。*
3. **收貨與坐實：**
   - 複審者並行、8 分鐘 timeout、心跳（每 60 秒印進度，超時以「不簽（timeout）」計）；名單＝一般票 `reviewers`、block 票 `blockReviewers`。
   - 複審提示第一行是哨兵 `【llm-team 複審票】`（規劃是 `【llm-team 規劃】`）：codex 複審者從 cwd 讀得到 AGENTS.md，薄索引靠它判「你是複審者，只答 Q 題，不必讀正本」（GEMINI.md 對寫手用 `【llm-team 寫手票】` 同一招）。
   - 檢視終端印出的收貨摘要。
   - 親自開啟檔案坐實每位複審者提出的 Q6 關鍵查證事項。
4. **發布 Draft PR：**
   ```bash
   node .agents/skills/llm-team/ticket.mjs publish --name <ticket-id> [--title "<title>"]
   ```
   *注意：本流程永不自動 merge，最終合併留給人或統整者明確核准。*

## codex 破壞性指令閘（codex 當統整者時）

`$CODEX_HOME/hooks.json`（預設 `~/.codex/hooks.json`）→ `codex-pretooluse.sh` → `block-dangerous.sh`。擋下的唯一可靠方式是 stdout 印 `hookSpecificOutput.permissionDecision=deny` 並 exit 0（不依賴 exit 2）；放行＝無輸出。轉接器只看 `tool_input.command`（不對 tool_name 做假設），沒有 command 欄的工具（寫檔、apply_patch、MCP）不在射程。守門候選順序與 agy 版相同；找不到 guard、JSON 壞、guard 逾時／異常、缺 python3 ⇒ 全 deny。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": "/Users/<you>/.claude/skills/llm-team/codex-pretooluse.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
```

`command` 必須是絕對路徑、可執行、realpath 等於快照或真源的 `codex-pretooluse.sh`；外層 `matcher` **必須至少匹配 `Bash`**（`new RegExp(matcher).test('Bash')`；缺 matcher 視為匹配全部＝放行；`^Read$` 這種路徑對了但 shell 永遠不觸發 ⇒ `[codex hooks.json] ✗ matcher 不涵蓋 Bash`）。`setup.mjs --check --coordinator codex` 會對帳並用 force push canary 真的跑一次。**M4 實測（2026-09-14，codex-cli 0.154.0）**：tool_name 就是 `Bash`、`tool_input` 只有 `command`（payload 另含 session_id／turn_id／cwd／model／permission_mode／transcript_path／tool_use_id）；每條指令 PreToolUse 觸發兩次（無害）；`git push --force` 經本轉接器 ⇒ codex 回「Command blocked by PreToolUse hook: 🚫 BLOCKED by …」，指令沒有執行。
🔴 **hooks 要「持久化信任」才會跑**：`codex features list` 的 `hooks` 預設開，但 hooks.json 未經信任時**靜默不載入、不報錯**——`codex exec` 三次（`-c hooks.PreToolUse=…`、專案 `.codex/hooks.json`、`~/.codex/hooks.json`）都是這樣沒觸發，加 `--dangerously-bypass-hook-trust` 才跑。互動 session 第一次看到 hooks.json 會問要不要信任（回是，之後持久）；`setup --check` 量不到信任狀態 ⇒ 統整者開工第一步要在 session 內做一次 canary（在可拋棄目錄叫它跑 `git push --force origin main`，必須看到「Command blocked by PreToolUse hook」）；`codex exec` 無頭（寫手／複審跑的 `codex exec --sandbox read-only`）不依賴 hook，靠 sandbox。

## agy 破壞性指令閘

全域 `hooks.json` → `agy-pretooluse.sh` → `block-dangerous.sh`；放行值 `ask`；射程只到 `run_command` 的指令字串——`manage_task send_input`、`call_mcp_tool`、寫檔工具改 package.json 再跑 allow 內指令、`node --test` 內的 fs API 都不在射程（下一票 path guard）。
守門候選順序：`$LLM_TEAM_GUARD` → `<repoRoot>/scripts/claude-hooks/block-dangerous.sh` → `$HOME/.claude/hooks/block-dangerous.sh` → `../../hooks/block-dangerous.sh`（真源相對路徑）。
事故記錄：2026-09-13 快照 export 到 web-agency-system 後 test.sh 因整合測試找不到守門而整套紅，證明「守門在哪」在專案位置是未定義的，setup --check 找不到任何候選即報紅閘；停止條件為真源自帶守門副本（單一來源）、候選縮成一項時拆掉本檢查。
出處：2026-09-13 三方定案（config repo commit 64be3f4；WAS docs/agents/DISPATCH.md §agy）。
