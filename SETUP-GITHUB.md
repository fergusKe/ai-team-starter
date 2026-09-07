# 一次性設定（建 repo 的人做一次）

> **做完就把這個檔案刪掉。** `progress.sh` 會一直把「`SETUP-GITHUB.md` 還在」
> 列進待辦 —— 因為檔案還在，就代表這幾步可能還沒做，而沒做的話
> GitHub 那道門是開的。刪掉它就是這一步的完成訊號。

本機沒有任何 hook，**唯一真正擋得住東西的是 GitHub 上的 required check**。
沒設它，這整套只是幾份文件。

## 0. OpenSpec CLI

**模板已經把它放進 `package.json` 的 devDependencies 並附了 lockfile**，
所以你只要裝：

```bash
npm ci
```

**不用跑 `openspec init`** —— 它會產生的 `openspec/config.yaml` 與 `.claude/`
底下 12 個檔案，模板都已經附了。

**不要全域安裝。** 版本由 `package-lock.json` 鎖住，CI 跟每個人本機跑的才是同一份。

模板釘的是 `"@fission-ai/openspec": "1.11.0"`（沒有 caret）。`npm ci` 本來就認
lockfile，但少了這個，有人跑 `npm install` 就會在 `1.x` 之內漂移然後把新的
lockfile commit 上去。

`.claude/` 底下的 6 個 skill 與 6 個 `/opsx:*` 指令**要跟著 git 走** ——
`.gitignore` 沒有擋它，隊友 clone 就有。它們的 frontmatter 是
`generatedBy: "1.11.0"`，跟 `package.json` 釘的版本綁在一起；
升級 CLI 的時候要跑 `npx openspec update` 把它們一起換掉。

### 讓 `openspec` 指到專案這一份

skill 呼叫的是**裸的 `openspec`**（frontmatter 是 `allowed-tools: Bash(openspec:*)`），
而 `node_modules/.bin` 預設不在 PATH 上。實測過：

```
$ command -v openspec
/Users/xxx/.nvm/versions/node/v24.16.0/bin/openspec    ← 全域那份，不是專案的
```

**如果有人全域裝了不同版本，skill 會安靜地用錯的版本。** 兩件事一起做：

1. **不要全域安裝 openspec。** 沒裝的話，PATH 沒設好會直接
   `command not found` —— 大聲失敗，比安靜用錯版本好。
2. 在專案目錄讓 shell 找得到它：

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
```

（用 direnv 的話寫進 `.envrc`。）設完確認一次：

```bash
command -v openspec     # 要指到 <專案>/node_modules/.bin/openspec
openspec --version      # 要跟 package.json 裡的版本一致
```

升級流程見 `README.md`〈更新 OpenSpec CLI〉。

## 1. CODEOWNERS

```bash
mv .github/CODEOWNERS.example .github/CODEOWNERS
```

把裡面的 `@YOUR_TEAM` 換成真的 GitHub 帳號。留著範例值等於沒設。

## 2. package.json scripts

`.github/workflows/ci.yml` 會跑這四個。**模板裡它們是刻意會失敗的佔位**：

```json
"lint": "echo '✗ lint 還沒設定。編輯 package.json 的 scripts，或刪掉 ci.yml 的 Lint 那一步。' && exit 1"
```

所以新專案的 CI 一開始是紅的。**這是刻意的** —— 一個什麼都沒檢查卻全綠的 CI，
比紅的還危險。四個都要嘛設好、要嘛把 `ci.yml` 對應那一步刪掉。

工具自己挑，CI 只認 script 名稱：

```json
{
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "next build"
  }
}
```

**用不到的關就把 `ci.yml` 裡對應那一步刪掉** —— 留一個永遠失敗的步驟，
團隊很快就會開始無視紅燈。

> **Next.js 專案注意**：16 起 `next lint` 已被移除，`lint` 要寫 `eslint .`，
> `next.config` 的 `eslint` 選項也不再需要。舊專案遷移用官方 codemod：
> `npx @next/codemod@canary next-lint-to-eslint-cli .`
> 另外 `create-next-app` 只會產生 `lint` 與 `build`，`typecheck` 與 `test` 要自己加。

## 3. CI

`.github/workflows/ci.yml` 是 Node 專案的預設形狀，**依你的 stack 改**
（換 setup action、換安裝指令、換 Node 版本）。

**但 `Spec` 那一關不要拿掉。** 它排在 `npm ci` 之後是刻意的 ——
`npx openspec` 要先有 `node_modules` 才解析得到 lockfile 鎖住的那個版本。
真的沒有 spec 變更的東西（純重構、工具、文件）**走 `chore/` 分支** ——
那條通道不需要 change，代價是 20000 bytes 的上界。

> ⚠️ **不要用 `.openspec.yaml` 的 `skip_specs: true`。** CLI 收這個旗標，
> 但 `docs/DECISIONS.md`〈不提供 `skip_specs` 之類的流程豁免〉明文拒絕它：
> 旗標一旦存在，「這算不算純工具變更」就回到語意判斷，而那正是路徑白名單
> 失敗的同一個問題。`chore/` 做同一件事，但上界是**大小**，不看內容性質。
> **這個旗標目前還沒有機器在擋 —— 那是已知缺口，見 `docs/DECISIONS.md`。**

非 Node 專案沒有 lockfile 可以鎖，就改回釘死版本的
`npx --yes @fission-ai/openspec@1.11.0`，並自己確保團隊裝的是同一版。

`job` 的 `name: ci` 就是 required check 的名稱，改名要同步改下面的 ruleset。

## 4. Branch Ruleset

**不要用 UI 一格一格點。** 模板附了 `.github/ruleset.json`，那就是 API payload 本身。

```bash
gh api -X POST repos/<owner>/<repo>/rulesets --input .github/ruleset.json --jq .id
```

回傳一個數字，填進 `.github/ruleset.json` 的 `_ruleset_id`，然後：

```bash
bash .github/scripts/check-ruleset.sh
```

它會把線上設定抓下來跟這份檔案逐欄比對。**這一步的價值不在建立，在之後** ——
ruleset 不在版控裡，有人在 UI 上改了什麼不會有任何人知道。這支腳本讓漂移查得出來。

> 免費方案需要 **Public** repository 才能設 repo ruleset；private 要付費方案。

### 設定完 stack 之後，把 `quality` 也加進 required checks

`ci.yml` 有**兩個 job**：

| job | 內容 | 模板出貨時 |
|---|---|---|
| `ci` | Branch、`npm ci`、Lockfile、Spec —— **不綁 stack** | 綠 |
| `quality` | Lint、Typecheck、Test、Build | **紅**（四個 script 是刻意失敗的佔位） |

分開是刻意的：混在同一個 job 的話，你還沒設定 stack 的期間整個 CI 都是紅的，
而 Branch / Lockfile / Spec 壞掉時沒有人會發現。**永遠紅的 CI 等於沒有 CI。**

模板附的 `ruleset.json` 只把 `ci` 設成 required。
**第 2 步設定完那四個 script 之後，把 `quality` 也加進去**：

```json
"required_status_checks": [
  { "context": "ci",      "integration_id": 15368 },
  { "context": "quality", "integration_id": 15368 }
]
```

不加的話，lint 紅了、測試紅了，照樣合併得進 main。

### 兩個一定要自己決定的欄位

**① `required_status_checks[0].integration_id`**

模板填的 `15368` 是 GitHub Actions 的 app id。留著它，只有 GitHub Actions
回報的 `ci` 才算數。**拿掉的話等於 any source** —— GitHub 文件寫得很清楚：

> Any person or integration with write permissions to a repository can set the state of any status check.

也就是任何拿到 write token 的人可以直接
`POST /repos/.../statuses/<sha>` 送一個 `context: ci, state: success`，
CI 一秒都不用跑。**建議留著。**

但它只擋外部偽造，**不保護 workflow 檔案的內容**。在 PR 裡把 `ci.yml` 的某一步
改成 `run: true` 會產生一個來源完全合法的綠燈。那個只有 CODEOWNERS +
第二個人的 review 擋得住。詳見 `AGENTS.md`〈這些閘門各自保護什麼、不保護什麼〉。

**② `bypass_actors`**

模板預設是**空的** —— 沒有人能繞過，包含 repo admin。

要讓某個角色能在緊急時硬推（一人專案通常會要），加進去：

```json
"bypass_actors": [
  {"actor_id": 1, "actor_type": "OrganizationAdmin", "bypass_mode": "always"},
  {"actor_id": 5, "actor_type": "RepositoryRole",    "bypass_mode": "always"}
]
```

⚠️ **bypass 是整組的**：它同時繞過 required status check，也就是 CI 紅的時候
一樣按得下合併。GitHub 的 ruleset 沒辦法只繞過 review 而保留 CI。

清單上的人在 PR 頁面會多一個勾選框：

> ☐ Merge without waiting for requirements to be met (bypass rules)

確認自己有沒有：

```bash
gh api repos/<owner>/<repo>/rulesets/<id> --jq .current_user_can_bypass
```

`always` 就是有，`null` 就是沒有。

**加了誰就要寫進 `AGENTS.md`。** 不寫的話，讀文件的人（和 agent）會以為
「每個 PR 都要第二個人看過」對所有人成立 —— 而對清單上的人那是自願，不是機制。

## 5. 分支命名從第一天就被擋

`.github/scripts/check-pr-branch.sh` 是**封閉列舉**，沒列到的前綴一律紅：

| 分支 | 能改什麼 | 機器上界 |
|---|---|---|
| `spec/<id>` | `openspec/changes/<id>/**` + `docs/adr/**` | 目錄 + `openspec validate <id> --strict` |
| `feat/<id>--<slice>` `fix/…` | 不限，但不得回改任何 change 的 proposal/design/specs | `<id>` 必須已在 main 上 |
| `chore/<描述>` | 不得碰 `openspec/` 與 `.github/` | diff ≤ 20000 bytes（不含 lockfile），拒絕 binary / symlink / submodule |
| `archive/<id>` | 只有三種 openspec 路徑 | `validate --archived` **與** `--all` 都要過 |
| `governance/<描述>` | 規則本身（CI、CODEOWNERS、AGENTS.md、config.yaml） | 不得夾帶產品程式碼或規格 |

base 不是 `main` 一律擋 —— ruleset 只保護 main，別處拿到的綠燈可以被帶過來。

**所以上面第 1～3 步的設定，本身就要走一個 `governance/` 分支的 PR。**
這是刻意的：改執法層的 PR 要單獨出現，讓人看得見。

`chore/` 的 20000 bytes 上界是 `check-pr-branch.sh` 開頭的 `CHORE_MAX_BYTES`，
依你們的習慣調。調的理由要寫進 `AGENTS.md` 的注意力預算那張表。

### 改閘門之前先跑測試

```bash
bash .github/scripts/test-check-pr-branch.sh
```

每一條分支規則各造一次違規，斷言它真的會擋（base 不是 main、回改規格、
symlink、submodule、binary、一行 minified、archive 沒補 Purpose、未知前綴⋯⋯）。
**案例數不寫在這裡** —— 腳本自己會印，寫死一個數字只會漂。

**改完再跑一次。** 那支腳本是執法層本體 —— 調一個上界、加一個分類、
動一條 regex，都可能在別的地方開一個洞，而**洞是安靜的**：
它不會讓任何東西變紅，只會讓本來該紅的東西變綠。

## 6. 實測 —— 這步不能跳

**沒有親眼看過閘門擋下東西，就不能宣稱這一層存在。** 四個：

**① 直接推 main**

```bash
git switch main && git commit --allow-empty -m "test" && git push
```
要看到 `GH013: Repository rule violations found` / `Changes must be made through a pull request`。

**② CI 紅的 PR 合併不了**

開一個帶著故意失敗測試的 PR，看合併按鈕變灰、`gh pr merge` 回
`the base branch policy prohibits the merge`。

按鈕還是綠的，代表 ruleset 沒 Active、target 沒涵蓋這個分支、
或 check 名稱選錯 —— 三個都要回頭查。

**③ 作者不能批准自己**

在自己的 PR 上按 Approve，GitHub 會拒絕。所以「1 個批准」實際上
等於「至少一個別人」。

**④ 亂取的分支名會紅**

```bash
git switch -c wip/whatever
```
`Branch` 那一關要紅，訊息列出五種合法前綴。

測完關掉 PR、刪分支。

---

設定完成後可以刪掉本檔。
