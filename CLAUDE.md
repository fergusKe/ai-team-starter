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

**這個 repo 沒有本機閘門。** 沒有東西會擋你，所以 `AGENTS.md` 的約束要靠你自己守。
你違反的地方會在 PR 上被人看到。
