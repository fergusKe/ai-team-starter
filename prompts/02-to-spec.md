# 02 探索 → 規格

根據剛才的訪談、`CONTEXT.md` 與 ADR，跑：

```
/opsx:propose <change-name>
```

它會依 `openspec/config.yaml` 的 `rules` 產生 proposal → specs → design → tasks，
**產完就停，不會開始實作**。

規格的寫法不用我在這裡重述 —— 規則在 `config.yaml`，
`openspec instructions` 會餵給你。

artifacts 產完之後，**這一步是 OpenSpec 不管的**：開 draft PR，
讓討論發生在寫 code 之前。

```bash
git switch -c spec/<change-name>
git add openspec/changes/<change-name>
git commit -m "spec: <change-name>"
git push -u origin spec/<change-name>
gh pr create --draft --base main --title "spec: <change-name>" \
  --body "規格先行，尚未實作。請先看 openspec/changes/<change-name>/。"
```

**分支前綴一定要是 `spec/`。** `feat/` 那條要求 proposal **已經在 main 上**，
所以第一份規格用 `feat/` 開，會被閘門擋下來（`✗ main 上沒有
openspec/changes/<id>/proposal.md`）。

接著進 `03` 做規格審查。**談定之前不要跑 `/opsx:apply`。**
