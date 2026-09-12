# 04 實作

先確認：**這個 change 的規格 PR 已經合併進 main 了嗎？** 沒有就回 `03`。
（只是「在 PR 上談定」不夠 —— `feat/` 的閘門是去 main 上找 proposal。）

**接續一個已經動工的 change 之前，先對一次**：

```bash
bash .github/scripts/arch-view.sh        # 這個 capability 引用誰、被誰引用；邊界的狀態
```

把該 change 的 `design.md` 每一條 `D<n>` 對照現在的程式碼。**對不上的先報再做** ——
接手的人在過期的 design 上繼續寫，是衍生專案實際發生過的漂移方式
（三個系統邊界在 change 裡決定了、跟 WBS 原規劃不同，而 WBS 與 ADR 都沒跟上）。

```
/opsx:apply
```

它會照 `tasks.md` 實作。`config.yaml` 的 `operations.apply.guidance` 已經寫了
「先寫測試再寫實作，測試對應 Scenario」，不用我在這裡重複。

**這幾條是 `AGENTS.md` 的紀律，OpenSpec 不管**：

- 規格沒寫的不要做。想做就先提，回去改規格。
- 途中發現規格有問題 —— **停下來告訴我**，我們在 PR 上改規格。
  不要一邊寫一邊把規格調整成已經寫出來的樣子。
- 實作跟 `design.md` 不一樣了？判準**不是改動大小**，是**有沒有改到已批准的行為或邊界**：
  - 純局部實作細節（換個資料結構、函式怎麼切）→ 寫進 `feat/` PR 描述就好。
  - 改到任何 Requirement、Scenario、capability 之間的邊界 → **回 `spec/` PR**。
    是系統之間的邊界就同時開一份 ADR，標 `邊界狀態`（見 `docs/adr/README.md`）。
  「很小」的一個 escape hatch 就是沒記錄的架構決定 —— 衍生專案有一條 raw-string 的
  出口後來得補一份標「已知缺口」的 ADR，就是這樣來的。
- 不得 `git commit --no-verify`。
- 不得改 `.github/`。

做完進 `05`。
