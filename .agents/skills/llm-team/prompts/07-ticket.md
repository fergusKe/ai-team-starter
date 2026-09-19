# 07 · 多模型分工的葉子票流程（給統整者的操作手冊）

這份文件是給**統整者（Claude 或人）**讀的，不是給寫手讀的。
**什麼時候用**：一張「葉子票」——目標明確、改動集中在 ≤ 5 個檔案、有本機可直接執行的驗收指令。
**什麼時候不用**：需要跨模組設計判斷、涉及改動守門規則本身、或屬於金流／租戶隔離／資料庫 DDL 等高風險 block 級變更 ⇒ 統整者必須先自行規劃、甚至拆成更小的葉子票後再派工。

---

## 一、Brief 範本（五段結構）

> 標明：**五段是引導寫手專注的範例，不是機器鎖死的格式檢查。**

### ① 目標
- **為什麼要有這段**：讓寫手與複審者第一眼掌握變更動機與使用者真實踩到的情境，避免盲目修改。
- **範例**（≤ 15 行）：
```markdown
# 目標
使用者在 headless 模式呼叫指令時，若遇到權限不足會靜默中止且 exit 0，
導致統整者誤判為成功執行。本次變更需修正此判定，在被拒時明確回報非零 exit。
```

### ② 只准動的檔案
- **為什麼要有這段**：限制寫手 wrapper 的改動範圍，觸發 G4 越界防禦，阻絕順手重構。
- **範例**（≤ 15 行）：
```markdown
# 只准動的檔案
- `src/core/runner.ts`
- `tests/runner.test.ts`
```

### ③ 事實
- **為什麼要有這段**：提供不容辯駁的既有約束、關鍵行號、現有測試與 mock 模式，省去寫手摸索猜測。
- **範例**（≤ 15 行）：
```markdown
# 事實
- `src/core/runner.ts` 第 45 行目前檢查 `result.code === 0`，但漏看了 `result.denied` 陣列。
- 現有測試使用 `tests/mocks/fake-bin.sh`，依據環境變數 `MOCK_DENIED=1` 模擬被拒。
```

### ④ 要做的事
- **為什麼要有這段**：編號列出具體實作步驟與邊界條件，讓寫手依序對照執行。
- **範例**（≤ 15 行）：
```markdown
# 要做的事
1. 在 `runner.ts` 中加入判斷：若 `result.denied` 非空則拋出 `PermissionDeniedError`。
2. 在 `runner.test.ts` 新增一條測試，驗證被拒時回傳 exit 3。
```

### ⑤ 驗收與回報
- **為什麼要有這段**：定義機器可驗證的變綠標準與回報格式，讓寫手以指令輸出自我檢核。
- **範例**（≤ 15 行）：
```markdown
# 驗收與回報
- 驗收指令：`pnpm test tests/runner.test.ts`
- 回報格式：改動檔案清單、測試輸出、未完成項目。
```

---

## 二、統整者指令區塊（票流程步驟）

一張票統整者要做五步：起跑 → 讀收貨摘要 → 親驗 Q6 → `accept` 裁決 → `publish`。
**`publish` 只認 `accept` 寫進 summary.json 的 `q6Receipt`**，跳過 `accept` 直接 `publish` 會 exit 2「缺少 q6Receipt」——
這不是紅燈，是「統整者還沒親自坐實」的閘門（2026-09-13 事故：複審者不簽卻被直接放行開 PR）。

```bash
# 0. 第一次開工前：對帳 config 不變式、守門、各角色 binary、該 harness 的 hooks（全對 exit 0；有缺印修法 exit 1；不自動改設定）
#    --coordinator 必帶：你是哪個 harness 的統整者（claude／agy／codex），複審名單由 llm-team.config.json 的 profiles.<統整者> 決定
node .agents/skills/llm-team/setup.mjs --check --coordinator claude

# 1. 第一回合：起跑（建立 worktree、寫手實作、自動跑測試與多模型複審）
node .agents/skills/llm-team/ticket.mjs run \
  --coordinator claude \
  --name add-runner-check \
  --brief prompts/briefs/add-runner-check.md \
  --branch feat/runner-check--impl \
  --allow src/core/runner.ts --allow tests/runner.test.ts \
  --test "pnpm test tests/runner.test.ts" \
  --tier standard

# 2. 讀取終端印出的收貨摘要（≤ 25 行）：
#    確認 write/verify exit、每位審查者的整體簽核與逐題理由。

# 3. 統整者親自坐實每位複審者的 Q6（只准一件關鍵核實事項）。
#    要親跑的驗收指令合成一次呼叫（每次工具呼叫都帶完整 context，省的是次數）：
node .agents/skills/llm-team/batch.mjs 'pnpm test tests/runner.test.ts' 'pnpm typecheck'

# 4. 裁決：把 Q6 的證據寫進 summary.json；複審者「不簽」但查證為誤報的，用 --disposition 記下理由
#    --caliber 是票的口徑（docs｜tool｜feature），給選配的用量量測分類用；1.8.0 起只在 usage.mode≠off 時必填，
#    mode=off（預設）給了也收、不強制；要不要啟用 cohort 量測由專案政策決定（見第四節）
node .agents/skills/llm-team/ticket.mjs accept \
  --name add-runner-check \
  --caliber feature \
  --q6 "親跑 pnpm test tests/runner.test.ts：12/12 綠；denied 分支有斷言 runner.test.ts:88" \
  --disposition 'agy/gemini:Q3=rejected:"既有行為，不是本票引入；見 runner.ts:41 的 2026-08 註解"'

# 5. 發布 Draft PR（永不自動 merge，留給人或統整者核准）
node .agents/skills/llm-team/ticket.mjs publish \
  --name add-runner-check \
  --title "feat: handle denied permissions in runner"
```

不開 PR、直接落地到 main 的專案用 `land` 代替 `publish`：`ticket.mjs land --name <n> --msg-file <commit 訊息檔>`
（一樣要先 `accept`；複審後 worktree 又改過 ⇒ exit 7）。

---

## 三、「不簽」的處理原則

- **複審者可能看錯**：複審者沒有對話脈絡，只看到 diff 與 brief。其質疑的前提可能是錯的（例如將既有行為誤判為新 bug）。
- **統整者必須開檔坐實**：
  - **若坐實確有瑕疵**：不要在原地打補丁；開一張新的修正票，新 brief 明白寫上「統整者已確認」的事實與改動範圍，再交由寫手執行。
  - **若查證為誤報或審查前提不成立**：統整者可在 PR 說明中明確記錄「為何不採納複審意見」之理由，不簽不是紅燈阻斷，而是給統整者決策的情報。

---

## 四、收尾與計量

- 票流程的所有產物與 ndjson 台帳皆記錄於 `.local/llm-team/<n>/`（本機暫存，已被 gitignore；**每台機器一份，不跟著 repo 走**）。
- `summary.json` 每票都有的欄位：`rounds`（寫手修正輪數）、`writeExit`／`verifyExit`、`review.members`（每位複審者的簽核）、`caliber`（accept 時標的口徑）。
- **統整者用量是選配量測**，不是每票必做：`usage.mjs --ticket <n> --write` 從 Claude Code transcript 量出該票視窗內統整者的 API 呼叫數與 token
  （只有統整者是 Claude Code 才量得到；agy／codex 統整者記 `measurable:false`），`usage.mjs --cohort <口徑>` 拿同口徑的票做基線／窗比較。
  細節與門檻在快照 `SKILL.md`〈統整者呼叫預算〉。要不要啟用、結論怎麼留存，由專案政策決定；
  預設**不啟用**（`usage.mode` 預設 off）——量出來的數字在 gitignore 的本機目錄，別人與 CI 都拿不到，單憑它不能當團隊層級的 pass／fail。

---

## 五、跟真源對帳
 
各專案只放唯讀快照（本檔也是快照的一部分，正本在真源 `prompts/07-ticket.md`），以 manifest 驗證完整性：
```bash
node .agents/skills/llm-team/setup.mjs --sync-check
```
- 快照**不准手改**——要改程式去真源改、重新 export；`SOURCE.json` 記來源 commit。
- 全同 exit 0，有漂移 exit 1（報告漂移檔案清單，不覆蓋）。
- 若缺少快照或 MANIFEST.sha256 則 exit 2。
