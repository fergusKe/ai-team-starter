# 04 實作

先確認：**這個 change 的 specs 已經在 PR 上談定了嗎？** 沒有就回 `03`。

```
/opsx:apply
```

它會照 `tasks.md` 實作。`config.yaml` 的 `operations.apply.guidance` 已經寫了
「先寫測試再寫實作，測試對應 Scenario」，不用我在這裡重複。

**這幾條是 `AGENTS.md` 的紀律，OpenSpec 不管**：

- 規格沒寫的不要做。想做就先提，回去改規格。
- 途中發現規格有問題 —— **停下來告訴我**，我們在 PR 上改規格。
  不要一邊寫一邊把規格調整成已經寫出來的樣子。
- 不得 `git commit --no-verify`。
- 不得改 `.github/`。

做完進 `05`。
