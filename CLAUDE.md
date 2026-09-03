# CLAUDE.md

Claude Code 進入此 Repository 後：

1. 先讀 `AGENTS.md`；它是唯一 normative workflow 規範。
2. 跑 `git branch --show-current`，以及：

   ```bash
   bash .github/scripts/progress.sh      # 現在有哪些 change、各自做到哪
   ```

   **那份是算出來的，沒有人維護它**，所以它不會漂。資料來自
   `openspec/changes/` 的 `tasks.md` 打勾與遠端分支；
   如果專案有 `docs/WBS.md`，它還會告訴你**還有哪些沒開始**。
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
| 沒有規格的小改（有大小上界，不得碰 `openspec/` 與 `.github/`） | `chore/<描述>` |
| 把 delta 同步進 `openspec/specs/` | `archive/<change-id>` |
| 改 CI、CODEOWNERS、AGENTS.md、config.yaml | `governance/<描述>` |

**本機沒有任何 hook。** CI 擋得住的東西寫在 `AGENTS.md` 的
〈這些閘門各自保護什麼、不保護什麼〉——**先讀那一節**。
那張表沒列到的規範就是純文字，只能靠你自己守，
而你違反的地方會在 PR 上被人看到。

**上面那張表刻意不寫細節。** 每一類的確切上界在 `AGENTS.md`〈分支命名〉，
判定在 `.github/scripts/check-pr-branch.sh`。這裡再抄一次的話，
兩邊一定會漂 —— 而漂掉的文件比沒有文件危險。

寫規格的時候會被一條額外的規則擋：**每個 `#### Scenario:` 標題要有
`[<工作項目 ID>-S<兩位數>]` 格式的 ID，同一個 change 內不重複。**

```
#### Scenario: [AUTH-01-S01] 首次登入建立 session
```

那個 ID 是**寫進 main 之後就不要改的鍵** —— 之後測試要靠它對回規格。

特別是這一條：**沒有任何機制能證明你的 diff 對應那份規格。**
引用一個 change 然後寫別的東西，CI 會全綠。所以那件事真的只能靠你。

**想「改進」閘門之前先讀 `docs/DECISIONS.md`。** 它記的是**拒絕過什麼**
（路徑白名單、每 PR 兩輪、視覺證據當閘門⋯⋯），不是做了什麼。
有幾條看起來像改進的東西，實際上會讓保護變弱。
