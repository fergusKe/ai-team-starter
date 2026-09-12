# 02 探索 → 規格

先對地圖。**沒有 `docs/WBS.md` 就回 `00`**，不要在這裡開 change。

- `<change-name>` 要以 WBS ID 開頭（小寫）：`<wbs-id>-<slug>`，例如 `APP-C02` → `app-c02-list`。
  這不是美觀問題 —— `progress.sh` 靠它把 change 對回工作項目；**對不上任何 WBS ID
  的 change 是 `--check` 的違規**，你的 `spec/` PR 會在規格階段就紅。
- 那個 ID 要在 main 上的 WBS 裡、要有週次。列出它已有的 change
  （`progress.sh --all`；同一個 ID 可以有多個 change，正常，但要知道）。
- 找不到合適的 ID → **先開 `governance/` PR 改 WBS，再回來**。不要借用一個相近的 ID，
  也不要現場發明一個 —— 地圖先於 change。
- 規格審查若推翻了地圖上的交付結果、順序、依賴、範圍或明寫的邊界（不是 capability
  內部怎麼拆），**由你**開最小的 `governance/` PR 改地圖，在 `/opsx:apply` 之前合併。

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
