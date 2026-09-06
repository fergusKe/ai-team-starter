# AI Team Starter

**規格先行的多人 AI 開發流程。** 用 OpenSpec 管規格的形狀，
用 GitHub 的 required check 當唯一的門。

## 它解決什麼

AI 寫程式會**做了你沒要求的事**，也會**沒做完就說做完了**。
多人一起開發時這兩件事會放大：你看不到隊友的 AI 做了什麼，隊友也看不到你的。

一般做法是在 `CLAUDE.md` 寫「請先跟我確認規格再實作」—— 那是一句話，
AI 讀得到，也可以說服自己這次情況特殊。**規勸不是機制。**

這個模板把規勸換成三個真的擋得住的東西。

**一、OpenSpec 管規格的形狀。** 什麼算一份完整的規格、每條需求有沒有
可驗證的 Scenario、這次的變更怎麼合併回「系統現況」—— 由 CLI 判定，
不靠團隊自己約定。`openspec validate --strict` 過不了就是過不了。

**二、分支前綴決定這個 PR 能改什麼。** `spec/` 只能動規格，`feat/` 引用的
change **必須已經在 main 上**（也就是規格 PR 已經被人批准並合併），
而且不得回頭改它。`chore/` 是唯一不需要規格的通道，代價是有大小上界。
判定只看分支名、檔案路徑、diff 大小與 git mode，**不做任何語意判斷**。

**三、GitHub 的 ruleset 是唯一的門。** 本機沒有任何 hook。
`.github/ruleset.json` 出貨的設定要求每個 PR 有一個 code owner 批准，
而 GitHub 不允許作者批准自己的 PR。

> CI/CD 就是那道不管是人還是 AI 寫的 Code，都得通過的關卡。

**每個閘門各自保護什麼、不保護什麼，逐條寫在 `AGENTS.md`。**
那張表有一格是空的 —— 先讀它再用這套東西。

## 它做不到什麼

**沒有任何機制能證明 diff 對應規格。** `feat/` 那條只保證「規格已經在
main 上、而且這個 PR 沒有回頭改它」。引用 change A 然後寫 change B 的
程式碼，全部檢查都會綠。那件事只有人做得到。

**擋不住在 PR 裡把 CI 自己改掉。** GitHub 在 `pull_request` 事件跑的是
**PR 分支上的** workflow，所以把某一步改成 `run: true`，綠燈來源完全合法。
能機械封住的 ruleset `workflows` 規則需要 org ruleset + Team/Enterprise 方案。
免費方案下，`.github/` 的防線是 CODEOWNERS + 第二個人的眼睛。

**「有人批准」不等於「那個人看了」。** 橡皮圖章偵測不出來，
approve 的簽章永遠是真的。`AGENTS.md` 的注意力預算那一節是為了這件事 ——
它是規範，不是機制。

**本機擋不住任何東西。** 沒設 GitHub 的 branch ruleset 之前，
這整套只是幾份文件。`SETUP-GITHUB.md` 那一步不是選配。

**它不管你的 stack。** `ci.yml` 是 Node 專案的預設形狀，
四個 script 是刻意會失敗的佔位，要自己填或刪掉。

## 安裝

```bash
# 1. 複製本目錄內容到你的專案（不要複製 .git），然後 git init

# 2. 裝相依（openspec 已經在 package.json 裡釘死 1.11.0）
npm ci
```

裝完就能用。日常操作一律 `npx openspec ...`，**不需要設定任何環境變數**。

**複製之後把這份 README 換掉。** 它描述的是模板，不是你的專案 ——
留著的話，第一個進來的人會以為這個 repo 是個 starter。
`SETUP-GITHUB.md` 設定完也可以刪。

**不需要跑 `openspec init`。** 模板已經附了它會產生的東西：
`openspec/config.yaml`（我們自己寫的版本）與 `.claude/` 底下 6 個 skill、
6 個 `/opsx:*` 指令。那些 skill 的 frontmatter 是 `generatedBy: "1.11.0"`，
跟 `package.json` 釘的版本是**一組的**，所以一起放進模板。

模板也附了 `package.json` 與 `package-lock.json`，裡面四個 script
（`lint` / `typecheck` / `test` / `build`）是**刻意會失敗的佔位** ——
新專案的 CI 一開始就是紅的，設好或刪掉對應的 CI 步驟才會綠。

接著是 GitHub 那一半，見 `SETUP-GITHUB.md`：CODEOWNERS、package.json scripts、Branch Ruleset，
以及**必做的實測** —— 開一個故意失敗的 PR，親眼看到合併按鈕變灰。
沒看過按鈕變灰，就不能宣稱這一層存在。

## `openspec` 這個指令怎麼呼叫

**日常用 `npx openspec ...`。** 它解析到 `node_modules/.bin`，也就是
`package-lock.json` 鎖住的那一份，不用設定任何東西。

只有一個例外：`/opsx:*` 那些 skill 呼叫的是**裸的 `openspec`**
（`allowed-tools: Bash(openspec:*)`）。那些是 OpenSpec 自己產生的檔案，
我們不改它。如果 Claude Code 回 `command not found`，在那個終端機跑一次：

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
```

用 direnv 的話寫進 `.envrc`，就不用每次打。

**不要全域安裝 openspec。** 全域版本跟專案釘的版本不一致時**不會有任何警告** ——
skill 會安靜地用錯的版本。沒裝全域的話，PATH 沒設好會直接 `command not found`，
大聲失敗比安靜錯誤好。

## 更新 OpenSpec CLI

**版本由 `package-lock.json` 鎖住。** CI 跑 `npx openspec`（不帶套件名），
解析到的就是 lockfile 裡那一份 —— 所以 CI 跟每個人本機跑的是同一個版本。

> ⚠️ **CI 不要寫 `npx @fission-ai/openspec@x.y.z`。**
> 帶套件名會去抓網路上的版本，繞過 lockfile，等於沒鎖。

還有一個地方會不一致：**skill 呼叫的是裸的 `openspec`**，
而 `node_modules/.bin` 預設不在 PATH 上。實測過它會解析到**全域**那份：

```
$ command -v openspec
/Users/xxx/.nvm/versions/node/v24.16.0/bin/openspec    ← 不是專案的
```

所以**不要全域安裝** —— 沒裝的話 PATH 沒設好會直接 `command not found`，
大聲失敗，比安靜用錯版本好。

升級當成一次獨立的 change 做：

```bash
# 1. 升級 devDependency（lockfile 跟著變，這就是要 review 的東西）
npm install -D --save-exact @fission-ai/openspec@<新版本>

# 2. 更新 .claude/ 底下由 CLI 產生的 skill 與指令
#    它們的 frontmatter 有 generatedBy，跟 CLI 版本綁定
npx openspec update

# 3. 確認既有規格還是驗得過（這一步是重點）
npx openspec validate --all --strict

# 4. package.json / package-lock.json / .claude/ 一起進同一個 PR
```

第 3 步失敗的話**先不要合併** —— 那表示既有規格要跟著改，
那是另一件事，分開做。

## 開發流程

每個功能一個 change，各自獨立，可以平行。

**一個 change 兩個 phase，各自是一個分支與一個 PR。**

```
   訪談需求               prompts/01-discovery.md
        ↓
/opsx:propose             產生 proposal → specs → design → tasks，產完就停
        ↓
   spec/<change-id>       規格 PR。這時還沒有任何 code
        ↓
   規格審查                prompts/03-spec-review.md
        ↓
   合併                    規格進 main，被凍住
        ↓
/opsx:apply               談定之後才實作
        ↓
   feat/<id>--<slice>     實作 PR，可以有很多個
        ↓
   驗證                    prompts/05-verify.md
        ↓
   CI 綠 + review → 合併
        ↓
   archive/<change-id>    delta 同步進 openspec/specs/
```

**為什麼規格要單獨合併，而不是同一個分支從頭走到尾**：規格留在同一個
分支上，它隨時可以被改成「已經寫出來的樣子」，而那正是 `AGENTS.md`
明文禁止、卻沒有任何機制擋得住的事。規格先進 main，閘門才有辦法用
git object database 證明實作 PR 沒有回頭改它。

**archive 也是獨立的一個 PR。** 沒有那個分類它開不出來 ——
`spec/` 超出範圍、`feat/` 禁止刪 specs、`chore/` 禁止碰 openspec。

**最後 archive 那一步也不要省。** 沒 archive，`openspec/specs/`
就不會知道這次做了什麼，半年後「這系統現在做得到什麼」沒有人答得出來。

## `progress.sh --check` 在守什麼

CI 每次都跑它。它讀 `docs/WBS.md`，有違規就讓 build 紅。守的東西分四類：

| 類 | 例子 |
|---|---|
| **表格自己的形式** | 標記要附理由；互斥的處置（`Cancelled`／`Pending`／`TBD`／`Regular`）不得並存；缺口要有決策期限與 fallback；**工作的週次必須晚於它依賴的裁決期限** |
| **欄位的文法** | ID、週、點、阻塞四欄都有明確文法。打錯一個字元不會被當成「沒填」，會紅 |
| **引用不懸空** | 六份指定文件裡提到的每一個工作項目 ID 與群組 ID 都要真的存在。範圍會展開成中間每一個 |
| **解析本身 fail-closed** | 表頭畸形、表格被截斷、欄數對不上、ID 重複、沒關起來的圍籬或註解 —— **一律報，不會安靜跳過** |

**它不驗內容對不對。** `Pending｜等後端` 格式完全合法，但那句理由等於沒說。

### 為什麼會長成這樣

這支腳本被七輪對抗審查打過（兩個不同的模型各自獨立審）。每一輪都在修同一種病：

> **它看不懂的東西，會靜靜跳過，而且是綠燈。**

實際抓到過的（都不是假設）：文件裡寫 `X01`–`X03` 而中間那個早就被刪掉；
用全形數字打的 ID 整個消失；把示範表格用圍籬包起來當範例、裡面的假項目
卻被算進總數；阻塞欄一個錯字讓那條相依性不見。

判準因此不是「測試全綠」，是 **「把防禦拿掉，測試要變紅」**：

```bash
bash .github/scripts/test-progress-check.sh   # 117 條負向測試
```

每一條都對一條規則各造一次違規、斷言它真的會紅。
**改 `progress.sh` 之前跑一次，改完再跑一次。**
決策過程與拒絕掉的替代方案在 `docs/DECISIONS.md`。

### 複製這個模板之後要做的一件事

阻塞欄的「類型」詞彙**不是寫死在腳本裡**的，是從 `docs/WBS.md` 裡一張
`| 阻塞類型 | 意思 | 該做什麼 |` 的表讀出來的。新專案要自己建那張表，
宣告你這個專案的詞彙（`待銜接`、`待裁決`⋯⋯隨你）。沒宣告過的詞會紅，
而錯誤訊息會告訴你去哪裡加。

## 怎麼看「現在做到哪裡」

```bash
bash .github/scripts/progress.sh            # 有哪些 change、各自做到哪
bash .github/scripts/progress.sh --all      # 連還沒開始的一起列（需要 docs/WBS.md）
bash .github/scripts/progress.sh --week W1
bash .github/scripts/progress.sh --blocked  # 現在做不了的，以及被什麼擋住
bash .github/scripts/progress.sh --check    # 有規則違規就以非零結束（CI 在跑）
bash .github/scripts/progress.sh --json     # 解析結果 ＋ 算好的狀態，給別的工具吃
bash .github/scripts/wbs-page.sh --open     # 整份計畫的網頁版（要 review 時用）
```

### 狀態只算一次

`--json` 存在的理由：**別的工具不要自己再算一次。**

這一條是被實測逼出來的 —— 在一個真實專案裡，指令、網頁、Excel 匯出
三個地方各自實作了同一套狀態判定，**同一份 WBS 給出三個不同的答案**。
原因是各自對「標記要不要看續行」「阻塞欄要不要看原文」做了不同假設。

> **同一件事寫在兩個地方一定會漂。**
> 解法不是「寫個文件提醒兩邊要同步」，是**讓它只有一份**。

`wbs-page.sh` 就是這樣做的：它不解析 `WBS.md`，它吃 `--json`。
產物 `docs/wbs.html` **不進版控** —— 從來源產，就沒有第二份要對齊的東西。

**它是算出來的，沒有人維護。** 資料來自 `openspec/changes/` 的 `tasks.md`
打勾狀態與遠端分支 —— 也就是說**它不會漂**。

> 刻意不做一份手動維護的 `STATUS.md`。手寫的狀態一定會過期，
> 而**過期的狀態文件比沒有更危險** —— 讀的人會相信它。

想看「還剩哪些沒做」的話，把工作分解表放進 `docs/WBS.md`：

```markdown
| ID | 項目 | 工作 | 週 | 點 | 阻塞 | 標記 |
|---|---|---|---|---|---|---|
| APP-C01 | 應用骨架 | 專案骨架與路由 | W1 | 3 | | |
| | | 全域 Layout 與 Provider | W1 | 2 | | |
| APP-P03 | 清單元件 | 列表與翻頁 | W2 | 5 | | |
| | | 搜尋與篩選 | — | — | DEP-G01 | Pending｜對方還沒提供 |
| DEP-G01 | 外部服務沒有搜尋 | 去問。**【沒答案就】**介面誠實地叫「瀏覽」 | 決策≤W1 | — | 對方待規劃 | Alarm｜這是核心價值 |
```

前五欄是必要的：**ID、名稱、工作、週、點**。同一項目的續行第一欄留空。
然後**把 change 命名成以那個 ID 開頭**（`app-c01-shell`），對應就自動成立。

第六、七欄是選用的，但**一旦用了就會被 CI 驗**：

| 欄 | 放什麼 |
|---|---|
| `阻塞` | 這一項被什麼擋住。可以指向另一個工作項目的 ID |
| `標記` | 機器算不出來的人為決定，格式固定 **`標記｜理由`** |

**「還沒有」跟「不做」要分開寫。** 依賴的另一個團隊還沒規劃到，那是**一則需求**，
不是牆 —— 這種項目**照樣排週次**，而週次同時就是對方最晚什麼時候要交出來。
把它標成「做不了」，等於自己封路，而且對方永遠不會知道你需要什麼。

更進一步：**別等。** 自己先蓋一個真的、可拋棄的後端（Route Handlers ＋
一個丟掉也沒關係的資料庫），功能做完再銜接。做法與那三條不能少的規則寫在
`docs/DECISIONS.md`〈依賴的服務還沒好，就自己先做一個可拋棄的〉。

真正的牆是「對方明文決定不做」。那種東西你在本地做得出來，但**上不了線** ——
要收斂成三者之一：**刪需求／自己降級（不可以假裝是原本那個）／重新裁決**。

`標記` 只有五個值。前四個互斥，`Alarm` 可以跟它們並存（`Alarm＋Pending｜理由`）：

| 標記 | 什麼時候用 |
|---|---|
| `TBD` | **要不要做**還沒決定 |
| `Pending` | 決定要做，但在等一件具體的事 |
| `Cancelled` | 決定不做。**那一列不要刪** —— 「考慮過並決定不做」跟「沒想到」是兩件事 |
| `Regular` | 常態性工作，沒有完成點 |
| `Alarm` | 有風險、或會擋住別的東西。它不是處置 |

### 它印出來的狀態是什麼意思

**這些字沒有人寫，全部是算出來的。**

| 狀態 | 意思 | 怎麼算的 |
|---|---|---|
| `未開始` | 有排週次，還沒有人動 | 找不到對應的 change，也沒有分支 |
| `規格審查中` | 規格 PR 開著 | 有 `spec/<id>` 遠端分支 |
| `規格已合併` | 規格進 main 了 | `openspec/changes/<id>/` 存在 |
| `實作中` | 有人正在寫 | 有 `feat/` 或 `fix/` 遠端分支 |
| `已封存` | 做完並 archive 了 | 在 `openspec/changes/archive/` 裡 |
| `等外部` | **不在自己手上** | 沒有週次 ＋ 標記 `Pending` 或有 `阻塞` |
| `待裁決` | **還沒決定要不要做** | 沒有週次 ＋ 標記 `TBD` |
| `已取消` | 決定不做，或被別的項目取代 | 標記 `Cancelled` |
| `常態` | 沒有完成點的持續性工作 | 標記 `Regular` |
| `矛盾` | 標了不做、卻有 change 已經封存 | 兩份紀錄打架，**腳本不挑一邊信** |

前五個是**事實**，後五個來自**人寫的標記**。
分野就在這裡：可以算的不要讓人寫，算不出來的才由人寫。

### 現在做不了的事，要跟「還沒排到」分開

一個**沒有週次**（寫 `—`）的項目，代表它現在做不了。它不算進「未開始」，
另外列 —— 把卡住的東西算進「還沒做」，進度看起來只是慢，其實是卡住。

被別的項目擋著、又沒有週次的「缺口」，必須寫清楚兩件事：

```
週欄    決策≤W2          最晚哪一週要有答案（是決策期限，不是交付估時）
敘述欄  【沒答案就】…      期限到了還沒答案要怎麼辦
```

**沒有 fallback 的缺口，會變成下游偷偷假設一個還不存在的能力。**

`progress.sh` 會反推「這個缺口解掉會解鎖幾項」並排序 —— 那是決定先問哪一個的依據。

### 這些規則是 CI 在驗的，不是建議

`--check` 會紅的情況：標記沒附理由、互斥的處置並存、缺口少了決策期限或
fallback、**工作的週次沒有嚴格晚於它依賴的裁決期限**、依賴指向不存在的 ID。

解析本身也 fail-closed：找不到表、表頭壞了、表格被空行截斷、欄數對不上、
第一筆漏了 ID、ID 重複 —— 全部會紅，**不會安靜地跳過**。

**引用也不准懸空。** `docs/WBS.md` 與 `docs/ROADMAP.md` 裡提到的每一個
工作項目 ID **與群組 ID** 都要真的存在 —— 重整群組之後「由 XXX 取代」
那種引用最容易斷，而且沒有任何東西會發現。圍籬程式碼區塊裡的是範例，跳過；
〈舊 ID 去哪了〉那一節也跳過，它的工作就是提舊 ID。

要多驗幾份文件（例如你的 `AGENTS.md` 會直接點名哪一組負責什麼），
改 `progress.sh` 開頭的 `REF_SOURCES`。判準是**圍籬外有沒有範例 ID** ——
圍籬（``` 或 ~~~）裡的範例會被跳過，圍籬外的照樣要驗。

負向測試在 `.github/scripts/test-progress-check.sh`，每一條都是**先實測繞過成功**
才補起來的。**沒有 `docs/WBS.md` 的專案不受影響**，`--check` 直接通過。

`tasks.md` 的打勾由 `/opsx:apply` 邊做邊更新，而
`openspec validate --archived --strict` 會擋住「還有 `- [ ]` 就 archive」——
所以打勾不是裝飾，它是 archive 的前提。

## 目錄

| | |
|---|---|
| `AGENTS.md` | 給 AI 的規範。**只管 git / PR / CI 那一半**，規格的形狀交給 OpenSpec |
| `CONTEXT.md` | 專案的 domain 詞彙，穩定後才寫進來 |
| `package.json` | openspec 的版本釘在這裡。四個 script 是**會失敗的佔位**，要自己設 |
| `.claude/` | OpenSpec 的 6 個 skill 與 6 個 `/opsx:*` 指令。**跟著 git 走**，隊友 clone 就有 |
| `openspec/config.yaml` | **規格要寫到什麼程度。**唯一該手改的 openspec 檔案 |
| `openspec/specs/` | 系統現在是什麼樣子（archive 時自動同步） |
| `openspec/changes/` | 提案中的變更（`openspec new change` 產生，不要手工造） |
| `docs/adr/` | 難逆轉的決策。change 會被 archive，ADR 不會 |
| `docs/DECISIONS.md` | **這套閘門為什麼長這樣、拒絕過哪些替代方案。** 想「改進」閘門之前先讀 |
| `docs/WBS.md` | **選用。** 工作分解表。有的話 `progress.sh` 會告訴你還剩哪些沒做、哪些被擋住。**週次只放這裡** |
| `docs/ROADMAP.md` | **選用。** 產品意圖：場景、功能地圖、不做的事。**不要放週次** —— 用 ID 指向 `WBS.md`，`--check` 會驗那些 ID |
| `prompts/` | 每個階段貼給 AI 的提示 |
| `.github/scripts/progress.sh` | **「現在做到哪裡」。算出來的，沒有人維護** |
| `.github/scripts/check-pr-branch.sh` | 分支類別閘門本體。**改它之前先跑旁邊的測試** |
| `.github/scripts/test-check-pr-branch.sh` | 分支閘門的負向測試。閘門壞掉的方式是安靜的 |
| `.github/scripts/wbs-page.sh` | 把工作分解表產成一頁可以點開收合的網頁。**產物不進版控** |
| `.github/scripts/test-progress-check.sh` | 工作分解表閘門的負向測試 |
| `.github/ruleset.json` | GitHub ruleset 的快照兼 API payload。ruleset 不在版控裡，這份讓它看得見 |
| `.github/scripts/check-ruleset.sh` | 偵測線上設定與快照的漂移 |

## 規則只有幾條

- 規格沒寫的功能不要做
- 發現規格有問題 → **在 PR 上改規格**，不要一邊寫一邊把規格調成已經寫出來的樣子
- 說「做完了」要貼實際的指令輸出
- CI 紅了不要重跑賭它變綠
- 要調整規格的品質要求，改 `openspec/config.yaml` 的 `rules:` ——
  寫在 README 只有人看得到，寫在那裡 agent 才收得到
