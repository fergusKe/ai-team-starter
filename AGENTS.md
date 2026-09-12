# AGENTS.md

本檔是此 Repository **內**對 AI Coding Agent 的唯一 normative workflow 規範。
Repository 內其他文件與本檔衝突時，以本檔為準。

**沒有任何本機機制在執行本檔。** 這裡寫的是規範，不是閘門。真正擋得住東西的
只有 GitHub 上的 required status check 與 code owner review。你可以違反本檔，
但那會在 PR 上被人看到。

本檔裡**哪幾條真的有機器在執行、哪幾條只是文字**，寫在
〈這些閘門各自保護什麼、不保護什麼〉。先讀那一節再讀其他 ——
把只是文字的規則當成閘門，比沒有規則更危險。

## 職責分界

規格的**形狀與生命週期**由 OpenSpec CLI 管，不在本檔重述：

| 誰管 | 管什麼 |
|---|---|
| OpenSpec CLI 與它的 skills | change 的 artifact、delta spec 的格式、archive 與 sync |
| `openspec/config.yaml` 的 `rules:` | 規格要寫到什麼程度 |
| **本檔** | **git、PR、CI、團隊紀律 —— OpenSpec 不管的那一半** |

**不要另外造一套規格文件。** 需求的真相只在 OpenSpec 的 artifact 裡。

## Session 啟動

```bash
git branch --show-current                  # 你在哪個 change 上
openspec list                              # 有哪些 change
openspec status --change <name>
bash .github/scripts/progress.sh           # 做到哪裡；剛複製的話還會列出待辦
```

**最後一個在新專案裡特別重要。** 剛從模板複製的 repo，它會印出還沒設定
的東西（沒有 `docs/WBS.md`、沒有〈阻塞類型〉表、`package.json` 的 script
還是佔位⋯⋯）。**先把那份清單清掉再開始寫東西** —— 那些設定沒做，
後面的閘門有一半是空轉的。

**新專案的第一步是 `prompts/00-map.md`，不是 `01`。** 先問全貌、攤成 `docs/WBS.md`、
走 `governance/` PR 進 main，**然後**才開第一個 change。地圖是交付意圖（做什麼、
什麼順序、誰擋著誰），不是架構圖（不寫系統怎麼切）。從一個功能開始、每個功能
各自規劃，最後串不起來 —— 那是這個模板要防的第一件事。

讀 `AGENTS.md` → `CONTEXT.md` → 那個 change 的 artifact。
除非使用者指定其他語言，對人類使用繁體中文。

先確認階段：**這個 change 的 specs 在 PR 上談定了嗎？** 沒有就不要寫產品程式碼。

## Source of Truth

1. `openspec/specs/`（系統現在是什麼樣子）
2. `openspec/changes/<change>/`（這次要改成什麼樣）
3. `docs/adr/`（為什麼這樣決定）
4. `CONTEXT.md`（詞彙）
5. chat / notes（最低）

規格與對話衝突時以規格為準。**對話裡講過但沒寫進規格的，等於沒有。**

## 一個 change 的順序

**一個 change 有兩個 phase，每個 phase 是自己的分支與 PR。**

```
/opsx:explore（可跳過）
      ↓
/opsx:propose             產生 artifacts 後停下來
      ↓
spec/<change-id>          規格 PR。這時還沒有任何 code
      ↓
在 PR 上談定 → 合併        規格進 main，被凍住
      ↓
/opsx:apply               才開始實作
      ↓
feat/<change-id>--<slice> 實作 PR。可以有很多個
      ↓
CI 綠 → review → 合併
      ↓
archive/<change-id>       delta 同步進 openspec/specs/
```

**為什麼規格要單獨合併，而不是同一個分支從頭走到尾**：規格留在同一個分支上，
它隨時可以被改成「已經寫出來的樣子」，而那正是下面〈你不可以做的事〉
明文禁止、卻沒有任何機制擋得住的事。規格先合併進 main，
`check-pr-branch.sh` 才有辦法用 git object database 證明實作 PR 沒有回頭改它。

**實作可以是很多個小 PR。** 一個 change 大到塞不進 400 行的時候，
用 `--` 後面的 slice 切開：`feat/<change-id>--camera`、`feat/<change-id>--realtime`。
它們共用同一個 change id，各自是一個可以被讀完的 review 單位。

## 你不可以做的事

- **不得在 specs 談定前寫產品程式碼。** spike 分兩類，只有第一類不進 PR：
  - **Disposable spike**：只為了學會某件事，成果丟掉。不進 PR，不用寫規格。
  - **Foundation spike**：有時限、有 Go/No-Go 驗收、成果**預期合併**，
    是後面幾週的地基。**它要走完整的 OpenSpec 與 PR 流程。**
    典型的踩法是：規劃文件把某個階段叫做「技術 spike」，但同一份文件
    又把它的產出當成後面幾週的地基 —— 那就是 Foundation，不是 Disposable。
    這種 change 的規格只固定**已知的 Go/No-Go 可觀察結果**，
    把還不知道的常數（threshold、係數、collider 形狀）列成
    design 的待答問題，**不要假裝它們是事前需求**。
- **不得為了讓實作順利而修改 specs。** 發現規格有問題就停下來講，
  在 PR 上改規格、讓人重新看過，不要一邊寫一邊把規格調整成已經寫出來的樣子。
- **不得擴大範圍。** 規格沒寫的功能不要順手做。想做就先提，寫進規格。
- **不得宣稱「已完成」而沒有證據。** 貼實際的指令輸出。
- **不得手工造 `openspec/` 的目錄結構。** 用 `openspec new change` 或 `/opsx:propose`。
- **不得為了讓 `openspec validate` 過而編造 requirement。** 真的沒有 spec 變更
  （純重構、工具、文件），走 `chore/` 分支 —— 那條通道不需要 change。
  但它有 20000 bytes 的上界，而且不得碰 `openspec/` 與 `.github/`。
  **超過上界不代表它需要一份規格** —— bytes 大小證明不了有行為變更。
  超過就先拆成可以各自獨立合併、各自過檢查的小變更（只切檔案數、
  但中間版本跑不起來，不算拆分）。真的拆不開又確實沒有規格變更，
  **現行流程不支援，回來討論治理政策 —— 不要編一份 requirement 過關**。

## 寫規格的判準

**在 `openspec/config.yaml` 的 `rules:`。** 那裡才是有效力的地方 ——
`openspec instructions` 會把它餵給 agent。寫在文件裡只有人看得到。

要調整規格的品質要求，改 `config.yaml`，不要改這裡。

## 分支命名

**封閉列舉。沒列到的一律被 CI 擋下。** 分支名是 change id 的機器權威來源 ——
PR 標題和內文都不是（它們隨時可以改，而且不影響 CI 看到的東西）。

| 分支 | 能改什麼 | 機器上界 |
|---|---|---|
| `spec/<id>` | `openspec/changes/<id>/**` + `docs/adr/**` | 目錄，加 `openspec validate <id> --strict`，加 **Scenario ID 格式與唯一性** |
| `feat/<id>--<slice>` | 不限，但**不得回改**任何 change 的 proposal/design/specs | `<id>` 必須已經在 main 上 |
| `fix/<id>--<slice>` | 同上 | 同上 |
| `chore/<描述>` | 不得碰 `openspec/`、`.github/` 與 `.gitattributes` | diff ≤ **20000 bytes**（lockfile 另計 ≤ 1000000），拒絕 binary / symlink / submodule / LFS pointer |
| `archive/<id>` | 那三種 openspec 路徑 | `validate --archived --strict` **與** `validate --all --strict` 都要過 |
| `governance/<描述>` | 規則本身（CI、CODEOWNERS、AGENTS.md、config.yaml） | 只允許列舉的治理路徑；**機器不判斷那些檔案的內容是不是真的治理變更** |

`docs/WBS.md` **只有 `governance/` 能動**，進度區塊也一樣。
2026-09-08 收回了 `spec/` 與 `archive/` 的例外：那個例外是被「區塊必須跟狀態
同步」逼出來的，而那條檢查已經降級成提醒 —— **一條檢查逼出一條例外，就是
規則互相牽制的開始**。區塊過期不擋任何人，想更新就開一個 `governance/` PR。

### archive 之前先把 tasks 打勾

**archive 的閘門要求「原封不動的搬移」，而 `validate --all --strict` 要求
沒有未完成項。** 兩者只有先打勾才同時成立 —— 先 archive 再打勾，閘門會紅在
「archive 不是原封不動的搬移」（實測踩過）。

打勾走 `feat/<id>--<slice>`（`tasks.md` 在實作階段本來就可以動）。
純規格的 change 沒有程式碼要寫，也還是要有這一個 PR。

**base 一定要是 main。** 對其他分支開 PR 拿到的綠燈不算數，CI 會直接擋 ——
ruleset 只保護 main，別處的綠燈可以被帶過來。

`<id>` 只准小寫、數字、單個連字號，**不得含 `--`**。這樣 `--` 就永遠是
change id 與 slice 的分界，不需要任何消歧邏輯。

專案有工作分解表（`docs/WBS.md`）的話，**change id 要以那個工作項目 ID
開頭（小寫）**，例如 `app-c01-shell` 對應 `APP-C01`。
這不是美觀問題 —— `.github/scripts/progress.sh` 靠它把 change 對回工作項目，
**對不上任何 WBS ID 的 change 是 `--check` 的違規**（2026-09-12 起；以前只是紅字）。
`spec/<id>` 的 PR 會在規格階段就紅 —— 先開 `governance/` PR 把那項工作加進地圖，
再開 spec。沒有 WBS 的專案不驗。

**地圖會被 change 修正，那是正常的；但什麼時候要回寫，要分清楚：**

- capability 內部拆分（一項變兩個 change、兩個 capability），交付結果／順序／阻塞
  沒變 → **不改 WBS**。WBS ID 是交付意圖，不是架構單元；一個 ID 對多個 change 是正常的，
  `progress.sh` 會列在〈工作拆分〉。
- 交付結果、順序、依賴、範圍改了，或 WBS 的文字仍宣稱一個已被推翻的邊界 →
  **由該 change 的提案者開最小的 `governance/` PR 改地圖**，在 `/opsx:apply` 之前合併。
- 要開的 change 在地圖上找不到 ID → 先改地圖。**不要借用相近的 ID，不要現場發明。**

`spec/` PR 不能改 WBS 是刻意的：地圖的變動要被單獨看見，不能跟一份規格混在同一個 PR 裡。

### 開 change 之前先看它擋在哪

工作分解表有兩欄是**人寫的**，其他狀態都是 `progress.sh` 算的。
**算出來的那些狀態各自是什麼意思**，見 `README.md` 的〈它印出來的狀態是什麼意思〉：

| 欄 | 放什麼 |
|---|---|
| `阻塞` | 這一項被什麼擋住。可以指向另一個工作項目的 ID |
| `標記` | `TBD`／`Pending`／`Cancelled`／`Regular`（互斥）與 `Alarm`（可並存），**格式固定 `標記｜理由`** |

規則：

- **週次是排程的證據。** 沒有週次（寫 `—`）的項目就是現在做不了 ——
  不要替它開 change
- **「依賴的東西還沒有」不等於「做不了」。** 對方還在開發、只是還沒規劃到的話，
  那是**一則需求**：照樣排週次，規格裡寫清楚需要什麼合約。
  **週次同時就是對方最晚要交出來的時間**（`--check` 會驗）。
  把它標成做不了，等於自己封路，而且對方永遠不會知道你需要什麼
- **`Cancelled` 的列不刪。** 「考慮過並決定不做」跟「沒想到」是兩件事，
  刪掉之後沒有人分得出來
- 被別的項目擋著、又沒有週次的**缺口**，要寫決策期限（`決策≤Wn`）與
  fallback（`【沒答案就】…`）。**沒有 fallback 的缺口，會變成下游偷偷假設
  一個還不存在的能力**

### 改 `docs/WBS.md` 之前：這張表有文法，而且會被驗

**`progress.sh --check` 不是「大致看一下」，它是一個解析器。**
下面每一條都有測試釘住，寫錯就紅 —— 而且**是刻意讓它紅的**：
這支腳本整份的設計目標是「看不懂的東西不准靜靜跳過」。

| 欄 | 只能是 | 寫錯會怎樣 |
|---|---|---|
| **ID** | 大寫前綴 `-` 大寫字母 ＋ **至少兩位**數字 | 少一位數會被當成上一列的續行，整列內容併過去 |
| **週** | `W3`／`W13–W16`（**是 `–` en dash，不是 `-`**）／`決策≤W5`／`常態`／`—`／空 | 打成 ASCII `-` 或小寫 `w3`，那一項的排程**靜靜消失**、翻成「沒有排程」 |
| **點** | 數字／`—`／空 | 後面黏字（例如「5點」）會讓那一列的點數直接不算，總數少掉沒人發現 |
| **阻塞** | 工作項目 ID，與**〈阻塞類型〉表裡宣告過的**類型（`DEP-拒` 等），用空白／`+`／`、` 分隔 | 沒宣告過的詞、含空白的詞、跟 ID 撞名的詞，全部會紅 |
| **標記** | `Cancelled`／`Pending`／`TBD`／`Regular`／`Done`／`Alarm`，後面接 `｜` 與理由 | 沒理由會紅；互斥的處置並存會紅 |

**表格最多七欄。** 多一欄底下每一列的解讀都會跟著移位，而畫面上還是一張
正常的表 —— 所以多的欄位會紅。

### `Done`：整張表裡唯一一個人手寫的「事實」

其他狀態都是從 git 與 OpenSpec 推的，只有 `Done` 是人宣告的。會需要它是因為
**規則互斥**：改 `.github/` 只能走 `governance/` 分支，而 `governance/` 不准碰
`openspec/` —— 治理工作在結構上不可能有同名的 change，`progress.sh` 永遠算
不出它的狀態，只好一直顯示「未開始」。那是 WBS 對人說謊。

```
| APP-O10 | CI 補齊 | … | W1 | 3 | | Done｜governance PR #58，commit ae78a12c |
```

三件事要記得：

- **機器沒有驗過 `Done` 的任何東西。** 理由欄要寫出憑什麼（PR 號、commit），
  由 review 去對。這裡曾經有一整套機器驗證（第八欄「涵蓋證據」，`change:` 與
  `commit:` 兩種指標、SHA 要在 HEAD 歷史裡、23 處程式碼、10 條斷言）——
  **為一列而造**，第 3 批拆掉了，理由記在 `docs/DECISIONS.md`。
- 狀態叫**「已完成」，不是「已封存」**。借用 OpenSpec 的字會讓兩種強度不同的
  結論長得一樣：一個是 git 證明的，一個是人宣告的。
- **有 change 的項目不准標 `Done`。** 狀態算得出來，兩個來源就會漂 ——
  `progress.sh` 會報「矛盾」，不挑一邊信。

### `docs/WBS.md` 裡的進度區塊

**人只會打開 `docs/WBS.md`。** 進度以前只存在終端機輸出與不進版控的
`docs/wbs.html` —— 在 GitHub 上打開那份表，看不到任何完成資訊。

在 WBS 裡放這兩行（一次就好，放在你希望進度出現的位置）：

```
<!-- progress:start 這一段由 `progress.sh --render` 產生，不要手改 -->
<!-- progress:end -->
```

然後 `bash .github/scripts/progress.sh --render`。**區塊過期只會被提醒，不會
擋 PR**（跑 `progress.sh` 就看得到那行警告，不是只有 CI）。沒有那兩行就是沒開
這個功能，什麼都不會說。

它曾經是硬性要求 —— 那逼得每個加 change 或 archive 的 PR 都要順手重產一次區塊，
於是又逼出「讓那兩種分支能碰 `docs/WBS.md`」的路徑例外。兩條一起收掉了。

三件事刻意這樣定：

- **只放耐久狀態。**「規格審查中」「實作中」是從遠端分支推的 —— 分支開了或
  刪了、repo 沒有新 commit，寫進版控的東西當下就過期。要看那兩個跑指令。
- **不複製名稱、週次、點數。** 複製過來的會跟上面那張表漂，而且每個 PR 都動
  到那幾欄，衝突面積會大到沒有人願意維護它。
- **指紋是 WBS 原文的，不是 commit 的。** 區塊在 commit 裡、SHA 又放進區塊，
  自我引用沒有不動點。

> **「重產之後沒有 diff」這種檢查是不夠的。** 把 renderer 改成「把現有內容
> 原樣吐回去」，那種檢查永遠是綠的 —— 它只驗了產出有沒有存檔，沒驗產出有
> 沒有反映真實狀態。這裡的測試是**改來源、不重產，然後要求那句提醒真的出現**
> （而且重產之後它要消失 —— 少了後面這半，「永遠提醒」也會讓前半通過）。

**阻塞類型的詞彙不是寫死在腳本裡的**，是從 `docs/WBS.md` 自己那張
`| 阻塞類型 | 意思 | 該做什麼 |` 表讀出來的。要用新的類型，**先去那張表宣告**。

### Scenario 缺口報告（**是報告，不是閘門**）

```bash
bash .github/scripts/check-scenario-coverage.sh
```

列出 `openspec/specs/` 裡「沒有任何通過的測試指著它」的 Scenario。**有缺口
也回 0，不接在 CI 上，不擋任何 PR。** 它的位置在 `prompts/05-verify.md` 那一
步：把清單攤開，由人對每一條說出處置。

**為什麼不是閘門。** 它證明得了的事只有「這個 ID 出現在一個通過的測試標題
裡」，證明不了那個測試真的在驗那條 Scenario 的行為。當它是閘門，唯一保證會
發生的事是「補一條標題帶 ID 的測試」—— 那比沒有閘門更糟，因為它會產生已經
驗過的**外觀**。它當閘門的那段期間，副作用是一整套豁免文法（封閉列舉的種類、
證據要含 40 位 SHA、孤兒／過期／重複豁免各一條規則），那些全部拿掉了。

**它不掃測試原始碼。** 實測踩過：一個 Scenario ID 只出現在測試檔的**一行註解**
裡，`grep` 會把它算成已覆蓋。所以看的是 `vitest --reporter=json` 的執行結果，
而且只認 `passed` 的**葉節點**標題。ID 寫在 `describe` 上也不算：那個 describe
底下每一條都會沾到它，一條 ID 就能替一整群測試背書。

**退出碼 0 只代表「量到了」，不代表「沒有缺口」。** 量不到（測試沒綠、報告產
不出來、一份規格檔都掃不到）回 **2** —— 掃不到不等於沒有缺口。

不用單元測試驗的 Scenario，可以在它底下留一行給人看的註記。**這行沒有機器
意義**：報告會把它原文印在那條缺口旁邊，讓讀報告的人知道這是刻意的。

```markdown
#### Scenario: [APP-W01-S01] 進入世界看到 3D 畫面

- **WHEN** 使用者在支援 WebGL2 的瀏覽器開啟 `/world`
- **THEN** 頁面渲染出一個 canvas 元素
- **VERIFY-BY** 人工瀏覽器｜驗證紀錄在 那個 change 的 `tasks.md`｜WebGL 像素 jsdom 證不了
```

**只掃 `openspec/specs/`，不掃還沒 archive 的 change。** 一條 Scenario 進入
現況描述的那一刻才輪到問「誰驗它」—— 那一刻就是 archive。連 active change 的
delta 一起掃的話會鎖死流程：`spec/` 分支依設計不能加測試，第一個 spec PR 就
會紅（實測過）。

### archive 前的雙模型影子審查（**是影子，不是閘門**）

```bash
bash .github/scripts/archive-review.sh <change-id>            # tasks.md 全勾之後、/opsx:archive 之前；放背景跑
bash .github/scripts/archive-review.sh <change-id> --rereview # 修完回審，只准一次
bash .github/scripts/archive-review.sh --report               # 帳本結算：升阻塞的條件成不成立
```

把一個 change 的**全部**（origin/main 上凍結的規格、WBS 那一項、DECISIONS 裡提到它的整節、
每個 slice PR 的 diff —— 排除 lockfile 與 archive 目錄，任一個拿不到就整輪不算 —— 與 PR 說明）
打成一包，平行送兩個不是寫它的模型，各自獨立審一次。
第一輪兩個模型**彼此不講話**（第二輪的 bundle 會把兩個模型的需修正一起編號給雙方回審）：
讀兩份結果、決定信哪一份、動手修的是原本那個 session。
提示在 `prompts/06-archive-review.md`；結果與帳本在 `.local/archive-review*`（gitignore）。
slice 的認定是 **PR 的分支名**（`feat/<id>--…`、`fix/<id>--…`），diff 從 PR 拿 ——
不是 commit 訊息（同一個 WBS ID 可以有多個 change，grep 會把兄弟 change 混進來），
也不是 merge commit（只有 squash 合併時它才等於整個 PR）。

**為什麼單位是 change 不是 PR。** 當每個 slice 都由同一個作者寫、逐個 PR 合併，
單一 slice 的 review 看不出跨 slice 的不一致、規格說了但沒有任何 slice 做的缺口；
而 change 比 PR 少一個量級 —— 審 change 才付得起兩個模型的等待。

**為什麼不是閘門。** 它還沒證明自己抓得到東西。標「需修正」的必須指得出規格位置、
檔案位置與驗證方法，給不出就是「誤報候選」；每一條由人 `--judge`（誤報／已驗證／已修），
帳本記下來；「已修」要那個模型第二輪對那一號真的寫了「已修」。
**升成阻塞的條件只定義在腳本頂端那幾個常數**（樣本數、「已修」的發現數、
誤報率、等待 P90），`--report` 會把條件與結果一起印出來。報告不給人做數字的空間：
還有需修正沒判定就不下結論；只有兩個模型都回答的 change 才是樣本，樣本是最早的 N 個；
「答過」＝帳本 ok 且檔案有回答，答過就不重送，補跑沿用同一輪的 bundle；「只准一次」看的是兩個模型都答過第二輪，
不是 `r2/` 目錄在不在。不成立就刪這支、`prompts/06` 與帳本 ——
**不留一個大家都會跳過的空殼閘門。**

**回審只准一次。** 第三輪代表這套流程在製造等待；腳本直接拒絕，人工處理。

### 架構視圖（**推導出來的，不是維護出來的**）

```bash
bash .github/scripts/arch-view.sh                  # 邊界狀態、capability 引用圖、對不上的
bash .github/scripts/arch-view.sh --decisions 驗證  # 跨所有 change 搜設計決策
bash .github/scripts/arch-view.sh --html --open    # 同一份資料的網頁版（不進版控）
```

**沒有一份手寫的「全部架構」文件，這是刻意的。** 衍生專案的 `docs/ROADMAP.md` 曾經有兩張
總覽表，WBS 重排後沒跟著改，頂端加了警告也沒用，最後是刪掉不是修好 —— 手寫的總覽沒有機器
對它，就會漂。所以架構的三個來源各自留在原地，這支把它們**讀出來**：

| 來源 | 讀出什麼 | 它**不是**什麼 |
|---|---|---|
| `docs/adr/*.md` 的 `邊界狀態`／`證據` | 系統之間的邊界，以及**誰在擋** | — |
| `openspec/specs/*/spec.md` 的反引號 | capability **引用圖**（誰提到誰） | runtime 依賴圖。程式碼可以依賴而規格沒提 |
| `openspec/changes/**/design.md` 的 `## D<n>` | 全部設計決策，搜尋用 | 架構摘要。大多是局部實作選擇 |

接續一個 change 之前先看它的鄰域（`prompts/04-implement.md`）。**「亂掉」的實際形狀**是在
衍生專案量出來的：三個系統邊界跟 WBS 原規劃不同，決定寫在各自 change 的 proposal 與 spec 的 Purpose 裡、沒有 ADR；271 條決策
埋在 49 份帶日期前綴的 design.md 裡；`config.yaml` 寫「重大決策要留 ADR」而引用 ADR 的只有
5 處。規則沒人執行，因為沒有東西讓「沒執行」看得見。

**不是閘門，不在 CI 上。** 它的測試在 CI 上（`test-arch-view.sh`，報錯的尺比沒有尺更糟）。
退出碼 1 = 有對不上的（懸空引用、解析不出的決策標題、`Supersedes` 指到不存在的、
ADR 證據路徑不存在、標「已強制」卻沒有一條證據是測試）；2 = 量不到 —— **剛複製的模板
就是 2**，因為還沒有任何現況 spec，這是正常的。
它**抓不到**的：兩條決策語意衝突但沒寫 `Supersedes`（不推斷，人審）；證據測試其實是
`test.skip`（路徑存在只代表有交卷）。

### CI 的 workflow 檢查

```yaml
- name: Workflow lint    # actionlint，版本與 sha256 都固定在 ci.yml 裡
```

擋的是**把 `${{ }}` 直接插進 `run:`** 那一類 script injection —— git 收得下
`chore/$(...)` 這種分支名，直接插值的話那段會在閘門拿到參數之前就被執行。

這一步取代了 `test-ci-workflow.sh`（350 行手寫 YAML parser）。實測對照：同一
份 ci.yml，actionlint 抓到 `"github.head_ref" is potentially untrusted …
[expression]`，位置正確。**現成的靜態檢查器做得到的事，不要自己寫一份。**

**換掉之後少了什麼，講清楚**（見 `docs/DECISIONS.md`）：actionlint 不管
`continue-on-error`、不管 job 層的 `if:`／`defaults:`、也不管「`Lint`／
`Typecheck`／`Test`／`Build` 四步的 `run` 是不是剛好那一句」。這三類現在靠
**PR review** —— 它們只可能出現在動 `.github/` 的 `governance/` PR，而那種 PR
的 diff 上會直接寫著 `continue-on-error: true`。

### 引用 ID 的寫法

**模板預設驗兩份**：`docs/WBS.md` 與 `docs/ROADMAP.md`。權威是
`progress.sh` 開頭的 `REF_SOURCES` —— **要驗哪幾份去看那一行，不要相信文件裡的清單**
（清單會漂；這一段之前就寫成六份，那是某個衍生專案的設定）。
被驗的文件裡提到的每一個 ID 都要真的存在。**寫法只有這幾種**：

```
APP-C01                單一個
APP-C01/02/03          斜線清單（也可以重複組別字母：APP-C01/C02）
APP-C01–APP-C03          範圍。只認 – （en dash），會展開成中間每一個
APP-C                  群組（後面不接數字）
```

會紅的寫法（每一條都實際發生過，而且**曾經完全靜默**）：

```
APP-C01–APP-C03x     範圍端點黏了字母 —— 整段曾經靜默
APP-C01--APP-C03     兩個連字號。範圍用一個 –
APP-C01〜APP-C03     波浪號不是範圍符號。〜／～／〰／゠ 四種都會報
APP-C01/           斜線後面沒東西
APP-C1             位數不足
APP-Q01a           編號後面黏英數
全形數字、U+2212 減號、零寬字元夾在中間  畫面上一模一樣，都會被折回來驗
APP⎯C01、APP−C01     中間不是連字號但長得像 —— 認形狀，不是靠字元清單
APP-С99（西里爾 С）    字母也會同形。形狀對、但有字元不是 ASCII 就報
```

**在被驗的那幾份文件的圍籬外，「大寫-大寫＋數字」是保留字。**
剛好長一樣的東西（例如某些規格代號）會被誤報 —— 這是刻意選的方向：
漏報是一個懸空 ID 躺六個月沒人發現，誤報只是被擋一次、換個寫法。
真的要寫，放進圍籬裡。

### 範例要放在圍籬或 HTML 註解裡

圍籬（三個反引號或三個 `~`）、`<!-- -->` 註解、以及 `<pre>`／`<script>`／
`<style>`／`<textarea>` 裡的內容**一律不算**，那是範例或讀者看不到的東西。
**但跳過機制自己會叫**：沒關起來的圍籬、註解或那幾個標籤都會紅，
不會讓整份文件靜靜消音。

**這支腳本只支援 Markdown 的一個子集，子集外一律報。** 這是刻意的 ——
手刻的文法追不上真的文法，所以不猜，直接說「我看不懂」：

| 寫法 | 會怎樣 |
|---|---|
| 圍籬的**閉合** | 照 CommonMark：要跟開啟同字元、長度不能更短，**而且不能帶語言名**。所以「用四個反引號包住一段三個反引號的示範」是安全的 |
| 圍籬的**開啟** | 同樣要照規範：**縮排四格以上的不是圍籬**（是程式碼區塊），反引號圍籬的**語言名不能含反引號**。認太寬跟認太窄一樣嚴重 —— 一個假圍籬可以把**真的一列藏起來** |
| 表格列縮排四格以上（**tab 也算**） | **報。** Markdown 會把它當成程式碼區塊 —— 是範例就放進圍籬，是資料就把縮排拿掉（一到三格是可以的） |
| 表格列少了開頭或結尾的 `\|` | **報。** GFM 允許省略，這支腳本不支援 —— 少打一個豎線，那一列的週次、點數、阻塞、標記會整排消失，而畫面上它還是一列表格 |
| `<?…?>`、`<!DOCTYPE …>`、`<![CDATA[…]]>` | 跟 `<pre>`／`<script>`／`<style>`／`<textarea>` 一樣**整段跳過**（瀏覽器不顯示它們），沒關起來會報 |

**敘述裡要放豎線就寫反斜線加豎線。** 這個跳脫是真的有效的
（以前不是 —— 錯誤訊息叫人這樣寫，照做了還是報同一條）。

### 改完一定要跑

```bash
bash .github/scripts/progress.sh --check         # 有違規就非零結束（CI 也在跑）
bash .github/scripts/test-progress-check.sh      # 這些規則自己的負向測試
```

**第二個是重點。** 它對每一條規則各造一次違規，斷言它真的會紅 ——
「一個從來沒紅過的檢查等於沒有檢查」。
改 `progress.sh` 之前跑一次、改完再跑一次。

```bash
bash .github/scripts/progress.sh --blocked   # 現在做不了的，以及被什麼擋住
bash .github/scripts/progress.sh --check     # 有規則違規就以非零結束
bash .github/scripts/wbs-page.sh --open      # 整份計畫的網頁版
```

**要拿工作分解表的資料去做別的東西，跟 `progress.sh --json` 要。**
不要自己再解析一次、也不要自己再算一次狀態 —— 那樣做過一次，三邊給出三個答案。

`--check` 在 CI 裡。它驗的是這張表自己訂的規則，包含**工作的週次必須嚴格
晚於它依賴的裁決期限**，以及**解析 fail-closed**（表頭壞了、表格被截斷、
欄數對不上、ID 重複或漏掉都會紅）。**改了 `docs/WBS.md` 就跑一次。**
那些規則如果只寫在文件裡，它們就只是規範。

這些分類**為什麼長這樣、拒絕過哪些替代方案**，寫在 `docs/DECISIONS.md`。
改閘門之前先讀那一份。

判定在 `.github/scripts/check-pr-branch.sh`，它的測試在旁邊：

```bash
bash .github/scripts/test-check-pr-branch.sh
bash .github/scripts/test-progress-check.sh
```

**改那支腳本之前跑一次，改完再跑一次。** 它是執法層本體，
而它壞掉的方式是安靜的 —— 不會有東西變紅，只會有本來該紅的東西變綠。

## 平行開發

一個 change = 一個目錄。一個 phase = 一個分支 = 一個 PR。
實作 phase 可以有多個 PR，共用同一個 change id。

兩個 change 會動到同一個 capability 的 spec 時，**先講**。
不要各自 archive 完才發現 `openspec/specs/` 被覆蓋 ——
那是這套流程唯一會安靜壞掉的地方。

## 注意力預算

**這套流程最終的信任錨是人的 approval，而 agent 的產出速度沒有上限。**

上面所有的閘門都在保護「人類有批准」這件事，但**沒有任何機制能保護
「人類批准的時候真的有在看」** —— approve 的簽章永遠是真的，
橡皮圖章偵測不出來。所以稀缺資源不是 CI 算力，是人的注意力。

| 上限 | 值 | 為什麼 |
|---|---|---|
| 一個 PR 的 diff | **400 行**（不含 lockfile 與生成物） | 超過就沒有人會真的讀完 |
| 每人同時進行的 change | **2 個** | 平行做三件事的人，三件都不會被看仔細 |

超過上限就拆。拆不動的話，那是 change 的範圍定錯了，回去改規格。

### 人類該深讀什麼

| 深讀 | 抽查 |
|---|---|
| `specs` 的 Requirement 與 Scenario | 有規格的產品程式碼 |
| **測試的 diff** | |
| 驗證輸出的證據 | |
| **`chore/` PR 的每一行** | |

**`chore/` 一律深讀，不抽查。** 那是唯一一條不需要規格的通道，
所以它沒有「規格說它該做什麼」可以對照 —— **diff 本身就是規格**。
機器只保證它小到讀得完（20000 bytes），保證不了它不是功能。
跳過規格的代價就是有人要把每一行讀過。

理由：規格和測試是「這個系統該做什麼」的定義，錯了之後面全錯。
產品程式碼有 CI、有型別、有測試在擋，人重複做機器做得比較好的事沒有效益。

## 新增流程閘門的門檻

**新增任何流程 gate，必須先有一次真實事故作為證據。**

沒有這條規則的話，這個 repo 會長成一套沒有人違反過、卻要三個人維護的免疫系統，
而注意力會從「審規格」被抽走 —— 那正是這整套設計想保護的東西。

想加閘門時先回答：**哪一個 PR、哪一次合併，因為缺少它而出事？**
答不出來就先記在待辦，不要加。

**而且先讀 `docs/DECISIONS.md`。** 你想加的東西可能已經被提過、
評估過、拒絕過 —— 那份記的是「拒絕了什麼、為什麼」，
不是「做了什麼」。有幾條看起來像改進的東西，實際上會讓保護變弱。

**「事故」包含可重現的繞法，不限於已經污染 main 的損害。** ——
把門檻定成「必須先讓已知漏洞真的傷害 main」會產生荒謬的誘因。
這條規則要擋的是**臆測性**的閘門，不是已經被實測重現的洞。
判準是：你能不能在一個測試 repo 裡把繞法跑一次給人看。
跑得出來就算證據；跑不出來就是臆測。

## 這些閘門各自保護什麼、不保護什麼

**每一條都寫清楚邊界。** 高估一個閘門比沒有它更危險 ——
以為被擋住的地方，沒有人會再去看。

| 機制 | 真的保證 | **不**保證 |
|---|---|---|
| ruleset：1 個 approval + code owner review | 每個 PR 有第二個人簽章（作者不能批准自己） | 那個人真的看了。橡皮圖章偵測不出來。**而且 bypass 清單上的人可以繞過全部** —— 見下一節 |
| required check 綁 `integration_id` | 外部拿 write token 直接 POST 一個假 `ci: success` 會被拒 | **workflow 檔案的內容**。在 PR 裡把某一步改成 `run: true`，綠燈來源完全合法 |
| `check-pr-branch.sh` 的 `feat/` 那條 | phase ordering：規格已經在 main 上、實作沒有回頭改它（含 rename 搬走） | **diff 真的對應那份規格**。引用 change A 然後寫 change B 的程式碼會全綠 |
| `check-pr-branch.sh` 的 `spec/` 那條 | 每個 Scenario 有唯一且格式正確的 ID | ID 取得對不對、Scenario 寫得好不好 |
| `check-pr-branch.sh` 的 `archive/` 那條 | 封存的內容跟 main 上那份**逐檔 blob 相同**（不是只看檔案有沒有被刪） | `openspec/specs/` 有沒有被另一個 change 覆蓋掉 |
| `chore/` 的 bytes 上界 | review 面積小到人讀得完（lockfile 另有上界，不是無限） | 「這不是功能」。80 行的功能可以冒充 chore |
| `openspec validate --strict` | 規格的**結構**：有沒有 Scenario、Purpose 夠不夠長 | 規格的**內容**對不對 |
| `archive/` 的雙重 validate | tasks 全部完成、archive 後 main spec 不會紅 | `openspec/specs/` 有沒有被另一個 change 覆蓋掉 |

**最重要的那一格是空的：沒有任何機制能證明 diff 對應規格。**
能逼近它的是 Scenario ID ↔ 測試的對應，而那要等第一批測試存在才有意義。
在那之前，「這段程式碼是不是這份規格要的東西」只有人回答得了。

**`governance/` 只擋路徑，不擋內容。** 它保證這個 PR 只碰了列舉的治理檔案，
**不保證那些檔案裡放的是治理變更** —— `package.json` 的 inline script、
`.github/actions/` 底下的 JavaScript、workflow 裡的 shell，都是能執行的東西
而且都在允許清單內。精確的說法是：

> governance PR 只能使用列舉的治理／設定 carrier path；
> 內容是不是真的治理變更，機器不判斷。

**`.github/` 的保護是人，不是機器。** GitHub 在 `pull_request` 事件跑的是
PR 分支上的 workflow，所以 CI 保護不了 CI。能機械封住的是 ruleset 的
「Require workflows to pass」（workflow 檔從 main 取），但那需要
org ruleset + Team/Enterprise 方案，這個 org 是 free。
所以看到 file list 裡有 `.github/` 的時候，那就是要用眼睛的時候。

## GitHub 上的設定在哪裡看

**ruleset 不在版控裡。** 它是 GitHub 上的設定，clone 這個 repo 看不到它。
所以有一份快照：

| 檔案 | 是什麼 |
|---|---|
| `.github/ruleset.json` | **分支保護**的快照，就是 API payload 本身 |
| `.github/repo-settings.json` | **repo 層級設定**的快照（合併後刪分支、Actions 權限）。那些只存在於 GitHub 的網頁上 |
| `.github/scripts/check-ruleset.sh` | 把線上設定抓下來跟這兩份比對，不一致就列出差在哪 |

```bash
bash .github/scripts/check-ruleset.sh
```

**那份快照不是執法。** 改它不會改變 GitHub 上任何東西；有人在 UI 上改了設定，
它也不會自己更新。它存在的理由是**讓漂移查得出來** ——
這個 repo 發生過：`AGENTS.md` 寫著「CODEOWNERS review 擋得住東西」，
而實際設定是 `require_code_owner_review: false`，那三行 CODEOWNERS 完全沒有效力。
**沒有任何東西會告訴你這件事。**

### 誰能繞過

`.github/ruleset.json` 的 `bypass_actors` 列出誰能繞過。**模板的預設是空的**
—— 沒有人能繞過，包含 repo admin。

清單上的人在 PR 頁面會看到一個勾選框：

> ☐ Merge without waiting for requirements to be met (bypass rules)

勾了就能直接合併，**包含 CI 紅的時候**。GitHub 的 ruleset 沒辦法只繞過 review
而保留 required status check —— bypass 是整組的。

其他協作者看不到那個勾選框。要確認自己有沒有：

```bash
gh api repos/<owner>/<repo>/rulesets/<id> --jq .current_user_can_bypass
```

`always` 就是有，`null` 就是沒有。（`<id>` 在 `.github/ruleset.json` 的 `_ruleset_id`。）

**只要 bypass 清單不是空的，上面那張閘門表的第一列對清單上的人就不成立。**
所有「一定要有第二個人看過」的推論，在他們身上都是自願的，不是機制。
**把是誰寫在這裡** —— 不寫的話，讀這份文件的人（和 agent）會以為那條防護對所有人都在。

## 測試

測試對應 **Scenario**。一個 Scenario 的 WHEN/THEN 就是一條測試該證明的事。

優先 unit / integration；E2E 只覆蓋 critical journeys。

### 測試環境隔離

> **不是叫 AI 別動共用的服務，是給它一個動了也沒關係的。**

這條規則的來源是一個真實事故：有人沒要求 AI 寫測試，AI 自作主張寫了，
測試全綠 —— 然後打開後台才發現**整個資料庫被清空，連管理者帳號都不見了**。
測試「通過」跟「沒有破壞東西」是兩件事，而前者不蘊含後者。

**「共用的服務」不只是資料庫。** 團隊共用的後端、staging 環境、
第三方 API 的沙箱、佇列 —— 只要有第二個人可能同時在用，就算。
一次壓測就能把所有人踢下線。

| 層級 | 可以碰什麼 | 絕對不可以 |
|---|---|---|
| unit / component | 什麼都不連。外部依賴一律 mock | — |
| integration | **本機起一份可拋棄的**，測完丟掉 | 團隊共用的任何一份 |
| E2E / 壓測 | loopback 或當次建立、當次銷毀的 ephemeral 實例 | 同上，而且壓測特別致命 |

三條硬規則：

1. **測試連到哪裡，由環境變數決定，不得寫死在測試檔裡。**
   寫死的位址是最常見的失控方式 —— 它在別人的機器上會指到別人的東西。
2. **CI 不提供任何服務。** 需要後端／資料庫的測試，要在 CI 裡自己起一份
   （service container 或測試前的啟動腳本）。CI 連得到共用環境本身就是問題。
3. **破壞性操作之前先證明連的是可拋棄的那一份。** 不是「相信環境變數設對了」——
   是在測試開始前實際檢查一次，不對就直接失敗。
   npm 的 `pretest` 生命週期鉤子是放這個檢查的地方。

**這一條目前沒有機器在擋**，只有規範。判斷「這個位址是不是共用的」需要
知道團隊實際怎麼部署，機器看不出來。
加閘門的觸發條件寫在 `docs/DECISIONS.md`。

## Git / CI

- 分支命名見上面〈分支命名〉那張表。**CI 會擋，不是建議**
- 一個 PR 對應一個 phase；實作 phase 可以有多個 PR
- **不得 `git commit --no-verify`**（就算本機沒有 hook，這個習慣要留著）
- **不得改 `.github/`**（CI 與 CODEOWNERS 是執法層自己，改它要獨立 PR 並讓人明確看到）
- CI 紅燈不要靠 re-run 賭它變綠，去看為什麼紅

## 完成的定義

以下全部成立才算完成：

1. `openspec validate <change> --strict` 通過
2. specs 的每一條 Requirement 都有對應實作，每個 Scenario 都有對應測試
3. `tasks.md` 沒有殘留的 `- [ ]`
4. lint / typecheck / tests / build 全綠，**貼出實際輸出**
5. CI 在 PR 上綠燈
6. CODEOWNERS review 通過

散文式的「已完成」不算證據。

合併之後才 `/opsx:archive`，讓 delta 同步進 `openspec/specs/`。
**沒 archive 的 change 等於這次的成果沒有進入系統的現況描述。**
