---
name: llm-team
description: 當統整者要把一張葉子票交給便宜模型寫、兩位以上模型複審時用；觸發詞：開票、交給寫手、llm-team、ticket、複審
---

# 多模型分工票流程（llm-team）

當你（統整者）有一張目標明確、改動範圍集中（≤ 5 個檔案）且具備本機驗收指令的葉子票時，
使用本 skill 將實作交給便宜模型編寫，並由統整者 profile 指定的複審者獨立複審。

## 隔離上下文複審（1.22.0）

🔴 **Fergus 2026-10-03 定案**：「他們『隔離上下文』也很適合我們使用／要使用哪個模型其實都可以／這樣就不會像我們現在被限定在要呼叫不同模型」。
借自 cloudflare/security-audit-skill（同日在 GuildHub 試跑：兩位全新驗證者都沒推翻候選、最終評審抓到三個狩獵者互推的兩個漏網範圍）。

複審的獨立性來自**結構**，不來自換廠商：
1. **全新上下文**：每位複審者是全新的無頭行程（`--no-session-persistence`），只拿到 council 組的 prompt——brief＋diff＋判準；看不到統整者的對話、推理與傾向。統整者也**不准**把自己的判斷寫進 brief 給複審者看。
2. **任務是推翻**：prompt 第二行固定帶 `REFUTE_SENTENCE`（「你的任務是設法推翻它……推翻不了才簽」）。
3. **封閉格式**：每題「Qn：簽／不簽｜理由｜要改什麼｜引用」，不簽必附 檔名:行號 或指令輸出；格式由 `parseVerdicts` 程式判，不靠人讀。
4. **模型只是設定值**：`claude` 也能當複審／裁決（`claude -p --model <m> --output-format json --no-session-persistence --setting-sources project --tools Read,Grep,Glob --permission-mode dontAsk`，prompt 走 stdin；不載使用者層 settings ⇒ 使用者層 hook 不會在複審者身上跑）。同桶也准。
5. **分工審查要有最後一位評審**：多位審查者**各看一塊**（不是每位都看整份）時，最後派一位全新的覆蓋率評審，只問「哪一塊沒人負責、哪些『交給別人』其實沒人接」。council 的複審者每位都看整份 diff，不需要這步；它用在稽核、規格多面向審查這類扇出。

代價（照記，不是理由回頭）：同模型的盲點相關。補法是證據欄位（引用必填）、「待驗證」可以說出口、需要時多跑一位不同模型——config 裡放別家成員仍然准。

## 三種統整者 profiles（config schema v2）

三種 harness（Claude Code／agy／codex）都能當統整者輪替；**用量是第一約束**（codex 只有 ChatGPT Plus、Gemini 桶曾被「統整者＋複審同桶」吃光）。
🔴 **agy／codex 當統整者只發生在「Claude 額度用完」時**——所以那兩個 profile 的名單只有 agy＋codex 兩桶、沒有任何 Claude 角色，一般票裁決交 Fergus（Fergus 2026-09-14 硬約束）。
2026-09-14 三方（Claude Code、codex gpt-5.6-sol、Gemini 3.1 Pro）三輪定案的名單（真源模板 `config.json`，各 repo 的 `llm-team.config.json` 由統整者手改）：

| profile | 統整者 | 寫手 | 一般票複審 | block 級複審 | 一般票裁決 | block 未決 |
|---|---|---|---|---|---|---|
| `claude`（預設） | claude / claude-code〔anthropic〕 | 寫手鏈第 0 席 agy/gemini-3.8-flash-high〔gemini〕→ 第 1 席 gemini/gemini-3.8-flash〔gemini-api〕（見下方〈寫手鏈〉） | claude/claude-opus-5-5〔anthropic〕（1.22.0） | claude/claude-opus-5-5 ＋ codex/gpt-5.6-sol〔openai〕 | codex/gpt-5.6-sol | human |
| `agy` | agy/gemini-3.1-pro-high〔gemini〕 | 同上 | codex/gpt-5.6-sol | codex/gpt-5.6-sol | human | human |
| `codex`（短票備用，統整 effort medium） | codex/gpt-5.6-sol〔openai〕 | 同上 | agy/gemini-3.1-pro-high | agy/gemini-3.1-pro-high | human | human |

原則（全部是 `lib.mjs validateProfiles` 的不變式測試，config 違反 ⇒ loadConfig throw 並指名 profile 與哪條）：
- 統整者本人（同 harness＋model）不在自己票的任何複審／裁決名單。1.22.0 起**同 quotaBucket 准**（見〈隔離上下文複審〉）。
- 裁決者 ∉ 一般票複審名單；`adjudicator` 可以是成員物件或 `"human"`；`blockAdjudicator` 只准 `"human"`。
- `reviewers`／`blockReviewers` 非空、同一名單不重複（harness＋model）；兩者可以相同。
- `harness ∈ {agy, codex, claude, gemini}`；1.22.0 起 `claude` 也能當複審／裁決。codex 成員可帶 `"effort": "high|medium"`（預設 high）。
- `gemini` 成員走 Google 官方 Gemini CLI 無頭：複審 `gemini -p <prompt> -m <model> --output-format json --approval-mode plan`（唯讀）；寫手 `--output-format stream-json --approval-mode auto_edit --policy OUTDIR/write/run-K/gemini-policy.toml`（見〈寫手鏈〉）。金鑰讀 env `GEMINI_API_KEY` 或 macOS Keychain（service `GEMINI_API_KEY`），缺 key 該角色 fail-closed 停線，不落 key 值進任何輸出。
- **`writer` 只准 `WRITER_HARNESSES`（＝registry 裡有 write 介面的 harness：`agy`、`gemini`）**：`claude`／`codex` ⇒ loadConfig throw，`writerFrom` 讀者側再擋一次；`writer` 可以是單一成員或有序陣列（寫手鏈）；`LLM_TEAM_WRITER` 只覆寫選中那席的 model、蓋不掉 harness。
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

## 寫手鏈（1.16.0）

Fergus 2026-09-22 定案的寫手順序：**agy（Antigravity 訂閱）→ Gemini CLI（API 按量）→ Claude subagent**。前兩席由 `config.writer` 有序陣列描述（真源模板：`[agy/gemini-3.8-flash-high〔gemini〕, gemini/gemini-3.8-flash〔gemini-api〕]`），第三席是 CLAUDE.md §派工機制的 subagent 流程，不在 config 裡。

- **一次只跑一席**：`ticket run`／`write.mjs` 預設第 0 席；`--writer-harness <name>`（或 env `LLM_TEAM_WRITER_HARNESS`）選席，不在 config ⇒ exit 2 列出可用席。同一 harness 不准出現兩席（選席靠名字）。
- **不自動連跑**（council 09-22 第 4 題定案）：寫手最終 `failure.kind === 'quota'` 且 config 還有下一席時，收貨摘要多印一行 `🔴 寫手額度用盡：下一席 <harness>/<model>，重跑加 --writer-harness <name>`；統整者自己決定要不要重跑，工具不做任何 fallback。`summary.json` 記 `writer`（實際跑的席）、`writerFailure`、`writerNext`。
- **preflight 共同入口、各自實作**（council 09-22 第 3 題）：`ticket run` G2 與 `write.mjs` G2 都呼叫 `getHarness(writer.harness).preflight(env, config, { repoRoot, role: 'write', outDir? })`。agy ＝ settings.json 對帳（唯讀）；gemini ＝ 每次執行從 `BASE_COMMAND_HEADS ＋ config.allowCommandHeads` 重產 policy TOML——禁令（rm／git commit／push／checkout／reset／stash／clean）deny priority 100、每個准許指令頭 allow priority 50、`run_shell_command` 兜底 deny priority 10，全部只在 `autoEdit` 模式且非互動環境生效。`ticket` G2 在 worktree／outDir 建立前跑，只驗產得出來；`write.mjs` G2 才寫到 **`OUTDIR/write/run-K/gemini-policy.toml`**（preflight 唯一的副作用；跟台帳同層、**不進 worktree**、絕不寫 `~/.gemini/`），寫手用 `--policy <那個檔>` 載入——Gemini CLI 0.60.0 的 Workspace tier（專案層 policy 目錄）目前失效，所以一定要走旗標。r2 教訓（統整者真跑坐實）：policy 曾落在 worktree，收貨摘要把它列成改動檔、land 因 worktree 不乾淨被擋；工具產物一律住 outDir，G4／changed 不需要任何特例（陽性對照 ticket.test T96／T97）。
- **policy-denied 是 G3 失敗**：Gemini CLI 被 policy 拒時 exit 仍 0、`result.status` 仍 success、模型還會繼續講話；`write.mjs` 只看統一形狀的 `denied`（`tool_result.error.type === 'policy_violation'` 或訊息含 denied／not allowed／policy）非空就判 FAIL_headless，不看 exit。
- **stream 形狀不對也是 G3 失敗**（r3）：gemini 寫手 stdout 任一行不是 JSON、`tool_use` 沒有配對的 `tool_result`（串流被截斷的形狀）、沒有 `result` 事件 ⇒ `failure.kind protocol`（code `stream:unparsed_line`／`unpaired_tool`／`no_result`），`write.mjs` G3 判 FAIL，就算正文非空。`--writer-harness` 裸旗標或空字串 ⇒ `ticket run`／`write.mjs` 回 2「需要席名」，不靜默落第 0 席。
- gemini 寫手續輪 `--resume <session_id>`（第 1 輪 `init` 事件的 `session_id`）；agy 仍是 `--conversation <id>`。兩者的每筆寫手台帳都帶統一形狀 `failure`（null 不落地）。
- codex 的 `You've hit your usage limit`／rate limit stderr 現在歸 `failure.kind quota`（`retryable: true`，額度到點會 reset）；council 的「零輸出」判定不變，`review/members.json` 多帶 `failure` 欄。

## 用量規則

- **Gemini 桶 limit ⇒ 寫手第 0 席停線**：`ticket run` 收貨摘要會印下一席（gemini/gemini-api 桶，API 按量）；統整者決定要不要 `--writer-harness gemini` 重跑；兩席都 limit ⇒ `claude` profile 改走 Claude subagent 流程（CLAUDE.md §派工機制）。
- 任一桶 429 ⇒ **該角色停線、不自動找替補**（寫手鏈只提示不重跑）；統整者把停線事實記進 `_handoff.md` 檔頭。
- 複審每票上限 **2 輪 ＋ 1 次釐清**；超過回統整者。
- 複審 finding 要附 diff `檔:行` 或 receipt；無引用的 finding 統整者不納入結論（收貨摘要印 ⚠，1.13.0）。
- 第 N 輪複審看的是「本輪起點 sha → 工作樹」的 diff；Q1 的分母是自 merge-base 的累計 stat；main 上別人的 commit 不在射程。summary 記 roundStartSha／mergeBase／targetTipSha／review.reviewedTree（land 用）。複審 prompt 附寫手最後回報（自述非證據，供對照 Q3）；verify 輸出存 OUTDIR/verify.txt；累計 stat 是各輪 brief 准動清單的聯集。
- `codex` profile 只做短票：≤ 5 檔、可逆、非風險域（`riskDomains`）。
- `agy`／`codex` profile 只在 Claude 額度用完時使用 ⇒ 名單只有 agy＋codex 兩桶，一般票裁決交 Fergus。

brief 五段：①目標（含使用者真實踩到的情境）②只准動的檔案③事實（行號、既有測試怎麼 mock）④要做的事（編號）⑤驗收指令與回報格式；長版在快照 `prompts/07-ticket.md`（統整者操作手冊）。**陽性對照由統整者 Q6 親跑，brief 不要求寫手做**（2026-09-16 council：三次逾時都死在寫手做陽性對照那一步、暫改沒還原）；brief 要寫的是『拿掉哪段修法、哪條斷言該紅』讓複審者能對照 diff。
🔴 brief 裡給寫手的指令一律放 inline code span 或 bash fence——`ticket.mjs run` 會用 allow regex 預檢這兩處（只檢以准許指令頭開頭的），不合規 ⇒ exit 2 不派工；規則同寫手執行期：引數不准含 ; & | < > ` $（引號內也算），管線只准接在准許指令頭之間。統整者自己要跑的指令（pnpm、bash…）不以准許頭開頭，不在射程；要舉不合規的反例，span 內前面加「反例：」讓它不以指令頭開頭。占位符不要寫尖括號（會被當成 < >），寫 FILE。

## 統整者呼叫預算

- **為什麼**：統整者每次工具呼叫＝一次帶完整 context 的 API 呼叫（實測 100–170k token／次）；省的是**次數**，不是每次的字。
- **規則**（票內的 context 節食五條在快照 `prompts/07-ticket.md`〈六〉，這裡不重複）：
  - ⓪ **複審者到底看了什麼，收貨摘要會講**（1.12.0）：diff 超過完整送審上限（預設 120000 字元）⇒ council 不呼叫複審者、回 6、摘要印「🔴 沒有複審」——拆票，或確認後 `ticket run --diff-cap N`（N 入帳、摘要印 ⚠）。diff 不再截斷：截斷的 diff 上「簽」不是整份簽核。agy 的 prompt 走 stream-json stdin，沒有命令列長度上限。
  - ① **不輪詢**：長任務背景跑、用通知或 until-loop 一次等完。
  - ② **收貨固定步驟**：`node .agents/skills/llm-team/batch.mjs '<驗收 1>' '<驗收 2>' …`（一次跑完所有 Q6 親驗）→ `node .agents/skills/llm-team/ticket.mjs accept --name <票> --caliber <口徑> --q6 "<收據>"` → `node .agents/skills/llm-team/ticket.mjs land --name <票> --msg-file <檔>`（land 做 add→commit→ff-only；land 前先驗 review.reviewedTree（複審後又改 ⇒ exit 7）；main 前進時不相交 ⇒ 自動 rebase 並以 git diff --binary 逐 byte 相等證明後才 ff（summary 記 landedAfterRebase），相交 ⇒ exit 8 印三個 sha 與人工指令。）。**accept 不需要跑 usage.mjs**（見下方「量測（usage.mode）」）。
  - ③ **merge 點一次呼叫**：各專案自訂：guards＋收據＋push 合成一支腳本，llm-team 不提供。
  - ④ **假省清單**：砍複審輪數、跳過親驗、把 guards 改成只跑子集、關掉截斷保留行——這些讓數字變小但票變差，不算省；把大票拆成很多小票灌低單票中位數（要看專案總呼叫數有沒有反而漲）；難票錯標／漏標口徑（漏標＝不納，等於把難票藏起來）。
  - ⑤ **修尺停損（尺預算；2026-09-16 WAS 實證後三專案共用）**：「尺」＝量 repo 自己一不一致的守門／台帳／登記表（產物 vs 台帳、env 有沒有登記、產生區塊有沒有重產、文件引用有沒有指到）。實證：WAS 一個 session 37 次 merge 點 ship 紅 8 次，**8 次全是尺的自我維護、0 次產品缺陷**；每把尺都要一本台帳、每張功能票都要餵一次，尺壞了再造一把尺是補不完的洞。規則（各專案在自己的 DISPATCH／AGENTS 寫到期日與覆寫）：
    - **S1 尺凍結**：停損期內不開任何「新尺／新守門／新台帳／新規則／記憶整理」票；尺壞了**不修**，在 handoff 記一行（哪把尺、怎麼壞、用什麼直接量法代替），用直接量法（跑真的、開瀏覽器、唯讀查 production）把手上的功能票做完。
    - **S2 唯一例外**：壞尺會讓手上功能票的**核心接受條件假綠**才票內修；≤30 分鐘、不新增測試檔、不新增台帳或通用規則；超時改用最接近實物且安全的直接證據，production 只准唯讀；無法安全直接驗證就標「未驗證」交人裁決，不得宣稱通過。
    - **S3 ship 紅燈**：只要求 regen／台帳同步／登記表更新的紅，只做最小修正、不強化那把尺；同一斷言連續 5 次 ship 內 ≥2 次純自我維護紅且都沒指出產品行為／部署安全／權限隔離／資料完整性缺陷 ⇒ 降成警告並記 handoff，到期由人決定恢復／保留／刪。
    - **S4 記憶整理**：停損期內不複核保鮮閘、不清幽靈；只有人的新裁決才寫記憶。
    - **S5 到期回報**：同一把尺（commit 路徑占比分別列、不相加；ship 總數與紅燈成分；完成的縱切數），不為回報新增工具。
    - **哪些尺留**：能在**事故前**擋部署可行性、租戶／權限隔離、資料完整性、重試冪等的產品契約尺留著；狀態盤點、台帳同步、文件一致性、一次性驗收類不再新增。
    - 票選擇：停損期內只開「改變使用者畫面、或 production 一個數字」的票；治理類只列不開，要人點頭。複審：只有五類（平台強制原語／金流／租戶隔離・認證・密鑰／Schema-DDL／改守門本身）走 block，其餘單簽一輪、不開 council。

## 量測（usage.mode）

🔴 **1.8.0：量測與 Q6 閘門解耦**——之前 `accept --caliber` 無條件必填，跟規則⑤「缺標的票不納入」、規則⑤修尺停損「停損期不開每票要餵的台帳」互相打架。改法：

- config schema 新增 `usage.mode: "off" | "record" | "cohort"`，**預設 `off`**（真源 `config.json` 與 export 出去的預設都是 off）。`--q6` 永遠必填；`--caliber` 只在 `mode ≠ off` 時必填，`off` 時給了也接受（寫進 summary）但不強制。`publish`／`land` 永不依賴任何 usage 產物（缺 caliber／usage 不會擋 publish／land）。
- **不再要求每票量測**：拿掉「accept 後跑 `usage.mjs --ticket <票> --write`」這個流程步驟。`--write` 保留，但只當手動補登／診斷用；`--cohort <口徑>` 執行時才從各票 `lifecycle.ndjson` 的視窗現場掃 transcript，不依賴任何預先存在的每票 usage 寫入。
  - 視窗終點固定：有 `landed` 用 `landed`，否則 `accepted`（不用 last-event）；缺 transcript 或視窗缺時間 ⇒ 該票 `measurable:false`，不得補猜、不得計入 pass（只要口徑內存在任一量不到的票，原本會 pass 的窗一律降為 provisional）。
  - `accept` 一律在 summary 蓋 `measurementSchemaVersion`（與 `--caliber` 是否必填無關）；`--cohort` 只收版本相符的票，版本不符的票完全不進同一個 cohort（不算母體、不佔基線名額）。
- **cohort 輸出自證 JSON**：`--cohort` 每次都會產一份 JSON（路徑與 inputHash 印到 stderr，預設放 `.local/llm-team/_cohort/<口徑>-<時間>.json`），含 `schemaVersion`、llm-team `toolVersion`＋`sourceCommit`、`generatedAt`、口徑、門檻、`verdict`、基線／窗邊界、每票 `{ticket, caliber, apiCalls, run, usageWindow}`、每票 lifecycle 檔雜湊、實際採計的 transcript records 的 canonical 雜湊、整體 `inputHash`（同一組固定輸入跑兩次 `inputHash` 與 `verdict` 相同）。工具不強制 commit（`_cohort/` 通常在 gitignore 的 `.local/` 底下）；**handoff 宣稱 pass 時要附這份 JSON 的路徑＋inputHash**，檔案已不在的只能標 `local-only`。
- **量法門檻（A 案，`usage.mode: cohort` 時適用）**：每專案各自一組，不跨專案混；基線＝該專案該口徑最早 5 張、凍結不滾動；之後不重疊每連續 10 張一窗；判定＝`apiCalls` 中位數比基線降 ≥40% **且** 重工率（`summary.run ≥ 2` 的比例）不高於基線；缺 `run` 欄位的票只能給 🟡 provisional；**停止條件**：連續兩窗口徑稽核（統整者抽 5 張重標）誤標率 >20% ⇒ 這把尺廢止、回到只記數字不判定。
- `gross`＝牆上視窗上限（含夾票與非票工作）；`exclusive`＝排除被其他票視窗夾走的部分，**仍含非票工作**（release／compact／回答 Fergus 沒有標記），比票時看 exclusive、稽核時看 gross。
- `usage.mjs` 只在統整者 harness 是 claude 時量得到，其他 harness 記 `measurable:false`。找 transcript 的順序＝sessionId 直達（lifecycle run-start 的 `sessionId`，來自 Claude Code env `CLAUDE_CODE_SESSION_ID`；agy／codex 統整者沒有 ⇒ 走字面掃描）→ cwd slug → main repo slug → 全部子目錄（跨專案 session 開的票也找得到）；`--projects-dir` 只掃指定目錄。

## harness 介面（`harnesses/`）

harness 專屬邏輯（binary 怎麼找、argv／stdin、輸出解析、API key、settings 對帳、policy 檔、寫手續輪）各自住 `harnesses/<name>.mjs`（agy／codex／gemini／claude），介面說明與驗證在 `harnesses/_contract.mjs`，`harnesses/index.mjs` 是 registry：`getHarness(name)`、`HARNESSES`／`WRITER_HARNESSES`／`REVIEWER_HARNESSES`／`QUOTA_BUCKETS` 都由它產生。`council.mjs`（`review.run`）、`write.mjs`（`write.run`／`resume`、`preflight`）、`ticket.mjs`（G2 `preflight`）、`setup.mjs`（`checkBinary`、`auth`、`preflight`）、`usage.mjs`（`transcriptMeasurable`）只查 registry，不再各自認 harness 名字。gemini 寫手的 stream-json 真跑樣本在 `harnesses/__fixtures__/gemini-write-*.ndjson`（parser 測試吃它，不打真 API）。複審／寫手回傳統一形狀 `{ exit, signal, timedOut, stdout, stderr, text, denied, usage, failure, raw }`（寫手另加 `steps`、`conversationId`）；`failure.kind ∈ auth|quota|policy|timeout|process|protocol`。加一個 harness ＝ 新增一個模組＋registry 加一列；`lib.mjs` 仍以同名 re-export 舊函式（`runAgyAsync`、`parseGeminiRun`…）維持 import 相容。測試接縫只有 `deps.getHarness`（注入假 harness）。

## 快照與真源

真源在 fergus-claude-config `home/skills/llm-team/`，專案裡是快照，改程式回真源改、跑 `node ~/.claude/skills/llm-team/export.mjs --to <專案根>`，`setup --sync-check` 驗 manifest；真源新增檔不算漂移（export 時自動歸為 sourceNew 同步過去，只有目標目錄已存在同名檔但未入 manifest 才是手動漂移 unlisted）。

共用流程規則（例如複審規則）也是快照的一部分，正本住 `prompts/`（如 `prompts/07-ticket.md`、`prompts/08-pr-review.md`）——與專案無關的散文只在真源改一次，各專案的規則文件只留指標與各自的專案專屬對映；改規則一律回真源改再 `export`，不准在各 repo 手改快照裡的 `prompts/`。

### 版本同步（改一處全專案生效）

真源改完程式並 bump `VERSION` 後，在真源 repo 跑：
```bash
node home/skills/llm-team/export.mjs --all
```
- 🔴 **共用快照不放單一專案的操作事實**：target 清單、target 各自的同步模式、`postExport` 入口、匯出後的後續步驟，一律只住 `targets.json` 的 target metadata（`root`／`mode`／`postExport`／`nextSteps`），本檔只留通則；`targets.json` 不可手改成別的形狀，怎麼驗看下面。
- `targets.json` 是 M1 環境事實（不進快照），定義了同步的目標 repo、模式（`branch` 或 `main`）、`postExport`（target 自己維護的守門入口，在快照 `test.sh` 綠之後、`git add` 之前執行；紅時 exit 非 0 整個 `--all` 停在該 target，留分支不 commit、印還原指令）與 `nextSteps`（匯出成功後印給統整者的下一步提示；沒填就印通則）。
- 依序對各目標進行工作樹檢查（不乾淨 ⇒ 停），跑 `exportTo` 快照匯出、`setup.mjs --sync-check` 與快照 `test.sh`。
- 任一 target 不乾淨、測試紅或 commit 失敗 ⇒ 整個 `--all` 停在該 target，不繼續後續專案。
- 統整者開場跑 `setup.mjs --check` 會主動進行「快照落後偵測」，比對快照與真源版本；若快照版本落後真源版本則擋下報紅（exit 1），並印出引導指令。


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
     --test "<acceptance-command>" \
     (--wbs <id[,id...]>|--wbs-exempt "<理由>") \
     [--review-only] \
     [--write-timeout-ms <ms>] \
     [--writer-harness <agy|gemini>]
   ```
   *注意：`--allow` 每檔一次（例如 `--allow a --allow b`，不可串在同一個旗標後，多餘位置參數會報錯）。*
   *`--wbs`／`--wbs-exempt` 二擇一必填（4.7.20）：前者填本票對應的 WBS ID（逗號分隔可多個、格式 `^\d+(\.\d+)*[a-z]?$`）；
   後者給不屬任何 WBS 的票（如守門修補）用，理由必填非空。兩者都沒給 ⇒ run 拒開（exit 2）。寫進 `summary.json`
   的 `wbsIds`／`wbsExempt` 與 lifecycle 的 `run-start`／`landed` 事件；既有收據不回填。*
   *P5：寫手 exit 非 0（2＝守門擋下、3＝被拒／越界／逾時）⇒ 不跑 `--test`、不開 council，**一律寫 summary.json**（`review: null`）並印收貨摘要；exit 2 且本次新建的空 worktree 照舊清掉、run 回 2；逾時另有 `writeTimedOut: true`（來自 `OUTDIR/write/run-K/timeout.json`，只看本次 run）。1.6 (i) 起 write 產物在 `OUTDIR/write/run-K/`（K＝lifecycle 第幾個 run-start），每次 run 隔離、不覆寫；`summary.run`。*
   *`--review-only`：何時用：複審者因寫手回報空白不簽、名單覆寫後重審；前置：worktree 存在且乾淨、HEAD 領先 base；效果：不派寫手、`--round-start`＝merge-base、舊 q6Receipt／dispositions 作廢、`summary.changed`＝merge-base..HEAD 已提交改動檔，可直接 `accept`／`land`；複審 prompt 標明無寫手回報、Q3 只判設計、證據看 Q6。*
   *`--write-timeout-ms <ms>`（預設 25 分＝1,500,000；config `writer.timeoutMs`（陣列時是選中那席的）可設專案預設；CLI 覆蓋 config）。*
   *`--writer-harness <name>`：選寫手鏈的哪一席（預設第 0 席）；收貨摘要印「下一席」時才需要帶它重跑。*
3. **收貨與坐實：**
   - 複審者並行、8 分鐘 timeout、心跳（每 60 秒印進度，超時以「不簽（timeout）」計）；名單＝一般票 `reviewers`、block 票 `blockReviewers`、postreview 複查 `postReviewers`（用途＝已 merge 的一批 commit 的批次複查，名單來自 `postReviewers`，一定要搭配 `--review-only` 旗標）。
   - 複審提示第一行是哨兵 `【llm-team 複審票】`（規劃是 `【llm-team 規劃】`）：codex 複審者從 cwd 讀得到 AGENTS.md，薄索引靠它判「你是複審者，只答 Q 題，不必讀正本」（GEMINI.md 對寫手用 `【llm-team 寫手票】` 同一招）。
   - 檢視終端印出的收貨摘要。
   - 用 `node .agents/skills/llm-team/batch.mjs '<驗收 1>' '<驗收 2>' …`（一次呼叫）親自坐實每位複審者提出的 Q6 關鍵查證事項。
4. **裁決（accept）：**
   ```bash
   node .agents/skills/llm-team/ticket.mjs accept \
     --name <ticket-id> \
     --q6 "<統整者親驗 Q6 的證據，一段話>" \
     [--caliber <docs|tool|feature>] \
     [--disposition <member>:<Qn|overall>=<rejected|confirmed-fixed>:"<note>"]...
   ```
   *`--q6` 永遠必填。`--caliber` 依 config 的 `usage.mode` 決定：`off`（真源預設）時選填、`record`／`cohort` 時必填（缺 ⇒ exit 2）；`--disposition` 用來處置複審者的「不簽」。accept 成功後才能 `publish`／`land`（兩者都認 `q6Receipt`，缺 ⇒ 擋）。*
5. **發布 Draft PR 或落地：**
   ```bash
   node .agents/skills/llm-team/ticket.mjs publish --name <ticket-id> [--title "<title>"]
   ```
   或（統整者自己 land）：
   ```bash
   node .agents/skills/llm-team/ticket.mjs land --name <ticket-id> --msg-file <commit-msg-file>
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

## 版本沿革

- **1.19.0**：`gemini` 複審席的提示**不再加** `NO_EXEC_HEADER`：`council.mjs` `runOne` 不再無條件傳 `noExecHeader`（唯讀姿態交給各 harness 自己的 `review.args` 預設決定），`harnesses/gemini.mjs` 的預設改成空字串（呼叫端仍可顯式傳入）——`--approval-mode plan` 本來就是唯讀、讀檔工具可用，那句「不要讀任何檔案」是 2026-09-22 從 agy 誤抄過來的，害複審席答不出 repo 事實（2026-09-23 真跑對照：拿掉後正確回報 `docs/WBS.md` 934 行、`## 1.8` 段 30 列）；`agy` 那條照舊（無頭模式工具被拒 ⇒ 零輸出、exit 仍 0，實測出處在 `harnesses/agy.mjs` 檔頭）。
- **1.19.1**：`gemini` 複審席的 `buildGeminiArgs` 明確停用 extensions：複審 argv 補上 `'-e', 'none'` 旗標（依 Gemini CLI 官方文件，不帶 `-e` 會載入所有 extensions，可能受執行機環境干擾）。
  - **事故出處**：2026-09-23 1.19.0 讓 gemini 複審席開始真的讀檔之後，sol 的 block 複審指出 review argv 沒關 extensions。統整者用 canary extension 實測（canary 掛一個 MCP server，被啟動就寫標記檔；全程在隔離的 `HOME=/tmp/gm-home`，未觸碰 `~/.gemini`）：
    | 案例 | exit | 標記檔 |
    |---|---|---|
    | 預設（不帶 `-e`） | 0 | **有** ⇒ extensions 真的被載入 |
    | `-e none` | 0 | **無** |
    🔴 同時記下量測紀律：建立這組對照之前量過兩次，兩次標記檔都不存在、兩次都是假陰性（`exit=127` ＝ `timeout` 在 macOS 不存在、gemini 沒被執行；`exit=55` ＝ 隔離 HOME 後資料夾未信任）。⇒ **每格都要同時記 exit code 與標記檔，exit≠0 一律作廢重量。**
  - **陽性對照**：拿掉 `'-e', 'none'` ⇒ `bash test.sh` 在第 2 步 `llm-team.test.mjs` ① 紅並停止；④ 在第 3 步，要單跑 `node harnesses.test.mjs` 才看得到它也紅（`test.sh` 是 `set -e` 序列管線，第一個紅燈之後的步驟不會執行）。
  - **停止條件**：Gemini CLI 提供「預設不載入 extensions」的無頭模式旗標或設定，或 `buildGeminiArgs` 改由 CLI 官方契約測試（而非本 repo 的 deepEqual）驗證時，本旗標可撤。
- **1.20.0**：`harnesses/gemini.mjs` 的 `GEMINI_SPAWN_ENV` 加 `NODE_OPTIONS: '--max-old-space-size=6144'`。
  - **事故出處**：2026-09-23 gemini 複審席在 web-agency-system 連續四次零輸出——483 秒 timeout、963 秒 exit=1、577 秒 exit=1、618 秒 exit=1；stderr 逐字 `FATAL ERROR: Ineffective mark-compacts near heap limit`，堆疊每次停在 `node::fs::AfterScanDir`。
  - **根因**：Gemini CLI launcher 的 `getMemoryNodeArgs()` 把 V8 heap 上限設成 `Math.floor(totalMemoryMB * 0.5)` ⇒ 8 GB 機器只有 4096 MB（與觀測到的 4174 MB 天花板吻合），而複審任務中的目錄掃描超過它（每個 worktree 有 1.4 GB `node_modules`）。
  - **排除過的假設**：①ripgrep 未安裝——裝了 15.2.0 之後 fallback 警告消失但照樣 OOM；②`fileFiltering.enableRecursiveFileSearch`——用 `.gemini/settings.json` 關掉後照樣 OOM（該設定已撤回，不留在 repo）。
  - **對照組**：同 repo 一句最小 prompt ⇒ exit 0／6.9 秒／正常回覆 ⇒ CLI 本身沒壞。
  - **陽性對照**：`NODE_OPTIONS=--max-old-space-size=6144` 跑**同一份 diff** ⇒ exit 0／662 秒／Q1–Q6 全簽／749 字真回覆／零 OOM（且在寫手併跑的情況下）。
  - **代價**：662 秒仍遠慢於 codex 席（40–270 秒）；6 GB 在 8 GB 機器上是吃緊的。
  - **停止條件**：CLI 不再做全樹掃描、或提供限制掃描範圍的旗標時可拆；換到記憶體更大的機器時它自然失效（`totalmem * 0.5` 會比 6144 大）。若更大的 diff 再 OOM，正解是換機器（16 GB ⇒ 上限自動 8192 MB），不是無止境調大這個數字。
  - **名詞辨析**：`agy/gemini`（antigravity CLI）不受此影響，本條只講 `gemini` harness。
- **1.21.0**（4.7.20，2026-09-28 業主核准）：`ticket.mjs run` 新增必填 `--wbs <id[,id...]>` 或 `--wbs-exempt "<理由>"`（二擇一，都沒給 ⇒ exit 2）；
  ID 格式 `^\d+(\.\d+)*[a-z]?$`；寫入 `summary.json` 的 `wbsIds`／`wbsExempt` 與 lifecycle `run-start`／`landed` 事件。
  run 開始與 land 前各跑一次 `tools/product-wbs.mjs --status --json`（15s 逾時），摘要 `{generated_at, head_sha, counts}`
  寫進 `summary.json` 的 `wbsStatusAtRun`／`wbsStatusAtLand`；工具不存在或失敗只記 `{error}`，純觀測不擋票。
  對每個 `--allow` 路徑往上找最近的 `CONTEXT.md`（不超出專案根、去重）附到送寫手／複審 brief 的尾端，
  段首標「【區塊環境說明（自動附加；③驗收指令為統整者 --test 用，非寫手白名單，寫手不准跑）】」；拼接發生在 riskDomains 比對與 preflightBriefCommands **之後**，
  兩者只看原始 brief、不受注入內容影響。既有收據不回填。
