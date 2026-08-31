# AI Team Starter

**規格先行的多人 AI 開發流程。** 用 OpenSpec 管規格的形狀，
用 GitHub 的 required check 當唯一的門。

## 它解決什麼

AI 寫程式會**做了你沒要求的事**，也會**沒做完就說做完了**。
多人一起開發時這兩件事會放大：你看不到隊友的 AI 做了什麼，隊友也看不到你的。

一般做法是在 `CLAUDE.md` 寫「請先跟我確認規格再實作」—— 那是一句話，
AI 讀得到，也可以說服自己這次情況特殊。**規勸不是機制。**

這個模板把規勸換成兩個真的擋得住的東西。

**一、OpenSpec 管規格的形狀。** 什麼算一份完整的規格、每條需求有沒有
可驗證的 Scenario、這次的變更怎麼合併回「系統現況」—— 由 CLI 判定，
不靠團隊自己約定。`openspec validate --strict` 過不了就是過不了，
而它是 CI 的第一關。

**二、GitHub 的 required check 是唯一的門。** 本機沒有任何 hook。

> CI/CD 就是那道不管是人還是 AI 寫的 Code，都得通過的關卡。

## 它做不到什麼

**沒有人類批准的閘門。** 沒有任何機制強制「規格被人看過才能開始寫 code」——
那條規則寫在 `AGENTS.md` 裡，靠團隊自律加 PR review 落實。
你需要機器強制批准的話，這個模板不適合。

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

```
   訪談需求          prompts/01-discovery.md
        ↓
/opsx:propose        產生 proposal → specs → design → tasks，產完就停
        ↓
   開 draft PR       讓隊友先看規格，這時還沒有任何 code
        ↓
   規格審查          prompts/03-spec-review.md + openspec validate --strict
        ↓
/opsx:apply          談定之後才實作
        ↓
   驗證              prompts/05-verify.md
        ↓
   CI 綠 + review → 合併
        ↓
/opsx:archive        delta 同步進 openspec/specs/
```

**開 draft PR 那一步是重點。** 規格先給人看，讓討論發生在寫 code 之前 ——
這是「規格先行」在沒有閘門時唯一能落實的方式。

**最後 archive 那一步也不要省。** 沒 archive，`openspec/specs/`
就不會知道這次做了什麼，半年後「這系統現在做得到什麼」沒有人答得出來。

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
| `prompts/` | 每個階段貼給 AI 的提示 |

## 規則只有幾條

- 規格沒寫的功能不要做
- 發現規格有問題 → **在 PR 上改規格**，不要一邊寫一邊把規格調成已經寫出來的樣子
- 說「做完了」要貼實際的指令輸出
- CI 紅了不要重跑賭它變綠
- 要調整規格的品質要求，改 `openspec/config.yaml` 的 `rules:` ——
  寫在 README 只有人看得到，寫在那裡 agent 才收得到
