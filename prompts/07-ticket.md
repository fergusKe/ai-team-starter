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
- 驗收指令：`npm test tests/runner.test.ts`
- 回報格式：改動檔案清單、測試輸出、未完成項目。
```

---

## 二、統整者指令區塊（兩回合流程）

統整者處理一張票只需兩個回合：第一回合發動票流程，第二回合讀收貨摘要並收尾。

```bash
# 0. 第一次開工前：對帳 settings.json（全對 exit 0；有缺印 JSON 片段 exit 1；不自動改設定）
node .github/scripts/llm-team/setup.mjs --check

# 1. 第一回合：起跑（建立 worktree、寫手實作、自動跑測試與多模型複審）
node .github/scripts/llm-team/ticket.mjs run \
  --name add-runner-check \
  --brief prompts/briefs/add-runner-check.md \
  --branch feat/runner-check--impl \
  --allow src/core/runner.ts --allow tests/runner.test.ts \
  --test "npm test tests/runner.test.ts" \
  --tier standard

# 2. 讀取終端印出的收貨摘要（≤ 25 行）：
#    確認 write/verify exit、每位審查者的整體簽核與逐題理由。

# 3. 統整者親自坐實每位複審者的 Q6（只准一件關鍵核實事項）。

# 4. 第二回合：確認無誤後發布 Draft PR（永不自動 merge，留給人或統整者核准）
node .github/scripts/llm-team/ticket.mjs publish \
  --name add-runner-check \
  --title "feat: handle denied permissions in runner"
```

---

## 三、「不簽」的處理原則

- **複審者可能看錯**：複審者沒有對話脈絡，只看到 diff 與 brief。其質疑的前提可能是錯的（例如將既有行為誤判為新 bug）。
- **統整者必須開檔坐實**：
  - **若坐實確有瑕疵**：不要在原地打補丁；開一張新的修正票，新 brief 明白寫上「統整者已確認」的事實與改動範圍，再交由寫手執行。
  - **若查證為誤報或審查前提不成立**：統整者可在 PR 說明中明確記錄「為何不採納複審意見」之理由，不簽不是紅燈阻斷，而是給統整者決策的情報。

---

## 四、收尾與計量

- 票流程的所有產物與 ndjson 台帳皆記錄於 `.local/llm-team/<n>/`（本機暫存，已被 gitignore）。
- 跨專案效率比較時，只比較同類葉子票的：
  1. `coordinatorTurns`（統整者花費的回合數；統整者自身 token 通常無法由腳本取得，回合數為最佳代理指標）。
  2. 寫手 `output_tokens`。
  3. 寫手修正輪數（rounds）。

---

## 五、跟模板對帳

衍生專案定期對帳模板，更新不宣稱自動同步，升級由人決定：
```bash
node .github/scripts/llm-team/setup.mjs --sync-check <starterRoot>
```
- 對帳符號：`=`（逐字相同）、`≠`（漂移）、`−`（本專案缺）、`+`（模板缺）。
- `config.json` 刻意不在母體中（專案專屬配置，不對帳）。
- 全同 exit 0，有漂移 exit 1（只報告不覆蓋，升級由人手動複製）。
