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
pnpm install --frozen-lockfile
```

**不用跑 `openspec init`** —— 它會產生的 `openspec/config.yaml` 與 `.claude/`
底下 12 個檔案，模板都已經附了。

**不要全域安裝。** 版本由 `pnpm-lock.yaml` 鎖住，CI 跟每個人本機跑的才是同一份。

模板釘的是 `"@fission-ai/openspec": "1.11.0"`（沒有 caret）。`pnpm install --frozen-lockfile` 本來就認
lockfile，但少了這個，有人跑 `pnpm install` 就會在 `1.x` 之內漂移然後把新的
lockfile commit 上去。

`.claude/` 底下的 6 個 skill 與 6 個 `/opsx:*` 指令**要跟著 git 走** ——
`.gitignore` 沒有擋它，隊友 clone 就有。它們的 frontmatter 是
`generatedBy: "1.11.0"`，跟 `package.json` 釘的版本綁在一起；
升級 CLI 的時候要跑 `pnpm exec openspec update` 把它們一起換掉。

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
> `pnpm dlx @next/codemod@canary next-lint-to-eslint-cli .`
> 另外 `create-next-app` 只會產生 `lint` 與 `build`，`typecheck` 與 `test` 要自己加。

## 3. CI

`.github/workflows/ci.yml` 是 Node 專案的預設形狀，**依你的 stack 改**
（換 setup action、換安裝指令、換 Node 版本）。

**但 `Spec` 那一關不要拿掉。** 它排在 `pnpm install --frozen-lockfile` 之後是刻意的 ——
`pnpm exec openspec` 要先有 `node_modules` 才解析得到 lockfile 鎖住的那個版本。
真的沒有 spec 變更的東西（純重構、工具、文件）**走 `chore/` 分支** ——
那條通道不需要 change，代價是 20000 bytes 的上界。

> ⚠️ **不要用 `.openspec.yaml` 的 `skip_specs: true`。** CLI 收這個旗標，
> 但 `docs/DECISIONS.md`〈不提供 `skip_specs` 之類的流程豁免〉明文拒絕它：
> 旗標一旦存在，「這算不算純工具變更」就回到語意判斷，而那正是路徑白名單
> 失敗的同一個問題。`chore/` 做同一件事，但上界是**大小**，不看內容性質。
> **`spec/` 的閘門會擋這個旗標**（連帶擋「沒有 delta spec」與「一條 Scenario
> 都沒有」）。順帶一提：CLI 自己的錯誤訊息會建議你設 `skip_specs: true` ——
> **那句建議對這個 repo 不適用**，所以閘門排在 `validate` 之前先講話。

非 Node 專案沒有 lockfile 可以鎖，就改回釘死版本的
`pnpm dlx @fission-ai/openspec@1.11.0`，並自己確保團隊裝的是同一版。

`job` 的 `name: ci` 就是 required check 的名稱，改名要同步改下面的 ruleset。

## 4. repo 層級設定（**這些只存在於 GitHub 的網頁上**）

分支保護在下一節，這一節是 repo 自己的設定。它們不在版控裡 —— 所以模板附了
一份快照 `.github/repo-settings.json`，設完用 `check-ruleset.sh` 對一次。

```bash
gh api -X PATCH repos/OWNER/REPO \
  -F delete_branch_on_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false
gh api -X PUT  repos/OWNER/REPO/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

bash .github/scripts/check-ruleset.sh      # 兩份快照一起對，要全部 ✓
```

| 設定 | 值 | 為什麼 |
|---|---|---|
| `delete_branch_on_merge` | `true` | 見〈分支不會自己消失〉 |
| `allow_merge_commit` | `false` | 見〈只准 squash〉 |
| `allow_rebase_merge` | `false` | 同上 |
| `allow_squash_merge` | `true` | 同上 |
| `squash_merge_commit_title` | `COMMIT_OR_PR_TITLE` | 單一 commit 的 PR 直接沿用那個 commit 的標題 |
| `squash_merge_commit_message` | `COMMIT_MESSAGES` | 多個 commit 的 PR 會把每一段訊息都留下來（實測過） |
| Actions `default_workflow_permissions` | `read` | workflow 拿到的 `GITHUB_TOKEN` 預設唯讀。要寫入的 job 自己在 `permissions:` 裡明寫，範圍才看得見 |
| Actions `can_approve_pull_request_reviews` | `false` | 不讓 workflow 自己 approve PR —— 那會讓 review 這一層形同虛設 |

### 只准 squash

合併方式**鎖成只有 squash**，兩層都鎖：上表的三個 `allow_*` 讓另外兩顆按鈕
消失，`ruleset.json` 的 `allowed_merge_methods: ["squash"]` 才是真的擋著的那
一層（repo 設定只是藏按鈕，ruleset 才對受保護分支有效力）。

**為什麼**：這套流程把說明寫在 commit 訊息裡 —— 為什麼這樣改、放棄了什麼、
實測數字。squash 之後**一個 PR 對應 `main` 上一個 commit**，`git log --oneline`
本身就是可讀的變更史。走 merge commit 的話，中間會夾雜 `tmp`、`修錯字` 這種
過程 commit，那些既不獨立可建置也不獨立可測試。

**代價講清楚**：失去 PR 內部的 commit 粒度，`git bisect` 只能定位到 PR 而不是
PR 裡的某一步。這套流程本來就把 PR 切得小（`chore/` 有 20000 bytes 上界、實作
用 `feat/<id>--<slice>` 分片），所以定位到 PR 通常夠用。**只有在團隊刻意維持
「每個內部 commit 都可獨立建置與測試」的時候，保留粒度才划算** —— 不是的話，
保留下來的是雜訊不是精度。

沒有任何閘門受影響（查過）：`check-pr-branch.sh` 看的是 `origin/main...HEAD`，
那是**合併之前**在 PR 分支上算的；`progress.sh` 從分支與目錄推狀態；archive 比
的是逐檔 blob。三種合併方式改變的是 commit 拓撲，不是合併後的檔案內容。

### 分支不會自己消失

squash 產生的是一個全新的 commit —— 原分支的 tip 不是 `main` 的祖先，於是本機
刪分支的指令**永遠**判定「還沒合併」而拒絕動手，必須改用強制刪除。實際發生
過：21 個已經合併的分支堆在本機，一般的刪除一個都不肯做，只能逐一確認內容真
的在 main 上之後強制刪掉。

> **squash 的另一個地雷**：不要在已經合併過的分支上繼續開發。git 看不出那些
> 改動已經進 main，下一個 PR 會把它們整批再送一次。上面的
> `delete_branch_on_merge` 就是在防這件事 —— 分支合併後就消失，沒得重用。

三層各自要處理，缺一層就會堆：

| 層 | 做法 |
|---|---|
| **遠端分支** | 上面那個設定，合併後 GitHub 自己刪 |
| **本機的遠端追蹤分支**（`origin/xxx`） | `git config fetch.prune true`，`git fetch` 時自己清 |
| **本機分支** | 合併時用 `gh pr merge <PR> --squash --delete-branch`，它會連本機一起刪 |

最後一層要注意：**分支被 worktree 佔著的時候刪不掉**（訊息是
`cannot delete branch 'x' used by worktree at ...`）。先 `git worktree remove`
再合併，或者事後補刪。在 worktree 裡開分支是這個流程的預設做法，
所以這件事會常常遇到。

## 5. Branch Ruleset

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
| `ci` | Branch、`pnpm install --frozen-lockfile`、Lockfile、Spec —— **不綁 stack** | 綠 |
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

## 6. 分支命名從第一天就被擋

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

## 7. 實測 —— 這步不能跳

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

## 8. 不在版控裡的那一半（機器、plugin、真源、secrets）

前面七步是 GitHub 那一半。複製模板拿到的是 **repo 裡的檔案**；下面這些不在 repo 裡，
`progress.sh` 也看不到，只有「`SETUP-GITHUB.md` 還在」這個訊號替它們佔位。
**這份刪掉之後**，8a 的內容留在 `SETUP-MACHINE.md`（不刪）與 `AGENTS.md`〈多模型分工的票流程〉那段（`setup.mjs --check` 那一行）——
新機器、新接手的人從那裡開始；8b／8c 是專案一次性的事，做完就不用再找。

### 8a. 這台機器：`setup.mjs --check`（每台機器各做一次）

要裝什麼、從哪裝、登入怎麼確認、守門與 hooks 從哪來——在 `SETUP-MACHINE.md`（那份**不刪**，下一台機器還要用）。這裡只講對帳：

```bash
node .agents/skills/llm-team/setup.mjs --check --coordinator claude   # 會用到的統整者各跑一次（claude／agy／codex）
```

它對帳的是**複製範圍外的狀態**：`claude`／`agy`／`codex` 執行檔（走 PATH）、守門腳本、
`~/.claude/settings.json` 的 hooks、agy 的 `settings.json` 指令白名單 regex、codex 的 `~/.codex/hooks.json`，
以及快照版本跟真源**一不一致**（真源在本機可讀時才比，不一致就 exit 1；不可讀就印 ℹ 略過）。
**它會診斷，不會替你改**：能產片段的項目（agy 白名單、trustedWorkspaces）印片段讓你手動合併；執行檔缺就是缺，自己裝。
它**不驗**各 CLI 的登入狀態與額度。
codex 當統整者還有一件它量不到的：`~/.codex/hooks.json` 要在**互動式** session 信任過一次才會載入（每台機器一次）；
`--check` 只直跑轉接器，證明不了互動 session 真的載入了 hook。之後每個 codex 統整 session 開工的 deny canary 是 `AGENTS.md`〈codex 當統整者〉的事，不是本節。
`llm-team.config.json` 是 repo 裡唯一該改的：模型 ID 要對得上你有的額度。

### 8b. `.claude/settings.json`：plugin 名單照這個專案重判

模板出貨的 `enabledPlugins` 關了 10 個 plugin，那是**模板自己**的判斷（它不碰任何雲服務、不跑瀏覽器）。
複製過來的專案要重判一次，依據是**這個專案已經決定的工作流程與驗收方式**：`CLAUDE.md` 要求的驗收
（要真實瀏覽器驗收就要 playwright／chrome-devtools-mcp）、`package.json` 的依賴與部署平台（用 Neon 就要 neon、部署在 Vercel 就要 vercel）、
CI／部署設定、`docs/WBS.md` 已排的工作。dependency 看不出來的（例如下季才接的服務）由人拍板，不要從清單猜。

要開的 plugin **明確設成 `true`**，不要只刪那一行——刪掉只是「專案不表態」，結果會落回使用者層的設定與安裝狀態：

```bash
claude plugin list                                   # 這台機器裝了什麼、哪些 disabled
claude plugin install playwright@claude-plugins-official --scope project   # 第一次納入專案用 install：寫 true 進 .claude/settings.json，clone 的人也拿到
claude plugin enable  playwright@claude-plugins-official --scope project   # 只用在「已裝、被關掉」要重開
claude plugin details vercel@claude-plugins-official  # 元件清單與預估 always-on 成本（它不算 hook 注入的內容；有 hook 注入的實際會更高）
```

`--scope project` 之後 plugin 的安裝狀態跟著 repo 走；**不跟著走的是每台機器的登入**——
MCP 那一類（neon、vercel、stripe⋯⋯）每台都要各自授權一次。
名單只能省 session 的固定前綴，關錯了會少功能。量法與數字在 `docs/DECISIONS.md`〈2026-09-17 每個 repo 只開它用得到的 plugin〉；
改 `.claude/settings.json` 走 `governance/` 分支（白名單已含這個檔）。
`.claude/settings.local.json` 是個人本機設定，已在 `.gitignore`。

### 8c. 真源的 `targets.json`：登記了，`export --all` 才會配送

`.agents/skills/llm-team/` 是唯讀快照（`SOURCE.json` 記來源版本與 commit）。它的更新方式是**維護者在真源跑
`export.mjs --all`，逐一寫進 `targets.json` 列出的每個 repo**；不在清單裡的專案不會被自動配送
（維護者仍可 `export.mjs --to <repo 路徑>` 單次匯出一份到那個 repo 的 working tree——不 commit、不 push，而且要有人記得）。
不一致的偵測只有一處：8a 的 `setup.mjs --check` 在真源可讀的機器上會比版本，不一致就 🔴 exit 1；
`--sync-check` 只驗快照有沒有被手改，**不驗新舊**。真源不可讀的機器（沒有維護者 config repo 的）不會有任何紅燈。

登記只有維護者做得到：把新專案加進真源（維護者私人 config repo `home/skills/llm-team/targets.json`）。
`mode` 兩種，都只動本機、都不 push、都不開 PR：`branch` 在該 repo 開 `chore/llm-team-<版本>` 分支並 commit（分支已存在就停），
你再自己推、開 PR；`main` 要求該 repo 當下在 main，直接 commit 本機 main——目前的清單只有模板自己用 `main`。
不打算跟著真源走的專案不用登記，但要知道它從此是一份分叉。

### 8d. GitHub Actions 的 secrets／variables／environments

不在版控裡。模板的 `ci.yml` **一個 secret 都不需要**（只跑 install、閘門、openspec validate、四個 script）；
你的 stack 需要的（部署 token、測試用資料庫 URL⋯⋯）自己盤點一次，設在 repo settings，並在 `AGENTS.md` 或 CI 註解寫哪一步用到哪一個。沒有就明確記「無」。

### 8e. `.envrc`

§0 說可以把 `export PATH="$PWD/node_modules/.bin:$PATH"` 寫進 `.envrc`。它不會自動存在。
只放那一行的話可以進版控（沒有秘密、沒有本機路徑）；每個 checkout／worktree 第一次都要 `direnv allow`。
一旦要放秘密就改進 `.env.local`（已在 `.gitignore`），`.envrc` 維持只有 PATH。

---

設定完成後可以刪掉本檔。
