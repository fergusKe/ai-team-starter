# CLAUDE.md

Claude Code 進入此 Repository 後：

1. 先讀 `AGENTS.md`；它是唯一 normative workflow 規範。
2. 跑 `git branch --show-current` 與 `openspec list`，確認你在哪個 change 上。
3. 讀 `CONTEXT.md` 與那個 change 的 artifacts。
4. 確認規格在 PR 上談定了沒有 —— **沒有就不要寫產品程式碼**。
5. 除非使用者指定其他語言，對人類使用繁體中文。

規格的形狀與生命週期由 **OpenSpec CLI** 管（`/opsx:propose`、`/opsx:apply`、
`/opsx:archive`）。`AGENTS.md` 只管 git / PR / CI 那一半。
**不要另外造第三套規格文件。**

寫規格的品質要求在 `openspec/config.yaml` 的 `rules:`，
`openspec instructions` 會把它餵給你。

**你的分支名決定 CI 會不會擋你。** 開分支前先看 `AGENTS.md` 的〈分支命名〉——
那是一個封閉列舉，沒列到的前綴一律被擋，base 不是 `main` 也一律被擋。

| 你要做什麼 | 分支 |
|---|---|
| 寫規格 | `spec/<change-id>` |
| 寫實作（規格已在 main 上） | `feat/<change-id>--<slice>` |
| 沒有規格的小改（≤ 20000 bytes，不得碰 `openspec/` 與 `.github/`） | `chore/<描述>` |
| 把 delta 同步進 `openspec/specs/` | `archive/<change-id>` |
| 改 CI、CODEOWNERS、AGENTS.md、config.yaml | `governance/<描述>` |

**本機沒有任何 hook。** CI 擋得住的東西寫在 `AGENTS.md` 的
〈這些閘門各自保護什麼、不保護什麼〉——**先讀那一節**。
那張表沒列到的規範就是純文字，只能靠你自己守，
而你違反的地方會在 PR 上被人看到。

特別是這一條：**沒有任何機制能證明你的 diff 對應那份規格。**
引用一個 change 然後寫別的東西，CI 會全綠。所以那件事真的只能靠你。
