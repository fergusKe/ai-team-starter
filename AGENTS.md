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
| `archive/<id>` | 只有那三種 openspec 路徑 | `validate --archived --strict` **與** `validate --all --strict` 都要過 |
| `governance/<描述>` | 規則本身（CI、CODEOWNERS、AGENTS.md、config.yaml） | 只允許列舉的治理路徑；**機器不判斷那些檔案的內容是不是真的治理變更** |

**base 一定要是 main。** 對其他分支開 PR 拿到的綠燈不算數，CI 會直接擋 ——
ruleset 只保護 main，別處的綠燈可以被帶過來。

`<id>` 只准小寫、數字、單個連字號，**不得含 `--`**。這樣 `--` 就永遠是
change id 與 slice 的分界，不需要任何消歧邏輯。

專案有工作分解表（`docs/WBS.md`）的話，**change id 要以那個工作項目 ID
開頭（小寫）**，例如 `app-c01-shell` 對應 `APP-C01`。
這不是美觀問題 —— `.github/scripts/progress.sh` 靠它把 change 對回工作項目，
對不上的會被單獨列成紅字。

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
| **標記** | `Cancelled`／`Pending`／`TBD`／`Alarm`／`Regular`，後面接 `｜` 與理由 | 沒理由會紅；互斥的處置並存會紅 |

**阻塞類型的詞彙不是寫死在腳本裡的**，是從 `docs/WBS.md` 自己那張
`| 阻塞類型 | 意思 | 該做什麼 |` 表讀出來的。要用新的類型，**先去那張表宣告**。

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
APP⎯C01、APP┄C01     中間不是連字號但長得像 —— 認形狀，不是靠字元清單
APP-С99（西里爾 С）    字母也會同形。形狀對、但有字元不是 ASCII 就報
```

**在這六份文件的圍籬外，「大寫-大寫＋數字」是保留字。**
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
| `.github/ruleset.json` | 實際設定的快照，就是 API payload 本身 |
| `.github/scripts/check-ruleset.sh` | 把線上設定抓下來跟快照比對，不一致就列出差在哪 |

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
