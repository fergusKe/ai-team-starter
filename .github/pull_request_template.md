## 這個 PR 是哪一類

分支前綴決定的，CI 會擋。勾一個：

- [ ] `spec/<id>` —— 規格。**還沒有任何實作。**
      請直接讀 `openspec/changes/<id>/specs/` 的 Requirement 與 Scenario，
      那是這個 PR 唯一要談的東西。
- [ ] `feat/<id>--<slice>` / `fix/<id>--<slice>` —— 實作。規格已經在 main 上。
- [ ] `chore/<描述>` —— 沒有規格的小型維護。**reviewer 請逐行讀**，
      這條通道沒有規格可以對照，diff 本身就是規格。
- [ ] `archive/<id>` —— 把 delta 同步進 `openspec/specs/`。
      **請把 `openspec/specs/` 的 diff 當規格讀** —— 那是唯一看得見
      「兩個 change 互相覆蓋」的地方。
- [ ] `governance/<描述>` —— 改規則本身（CI、CODEOWNERS、AGENTS.md、config.yaml）。

## 規格在哪

<`spec/`：填 change id。
 `feat/`/`fix/`：填 change id，以及規格是在哪一則討論上談定的、改過什麼。
 `chore/`/`governance/`：寫「不適用」。>

## 驗證輸出

<貼實際指令輸出，不要只寫「測試通過」。>

```
$ 
```

## 畫面（有可見變化才填）

<UI 的變化貼截圖或錄影。**視覺的東西沒有辦法自動測** ——
 版面、動畫、互動手感這類東西，截圖或錄影是 reviewer 唯一能判斷的依據。
 CI 只驗得出「有沒有附」，驗不出「畫面對不對」。

 沒有可見變化就寫「無」。>

## 有沒有偏離規格

<沒有就寫「沒有」。有的話說明為什麼，以及規格改了沒。

 提醒：發現規格有問題要回去開 `spec/<id>` 改規格讓人重看，
 **不要在這個 PR 裡把規格調整成已經寫出來的樣子** —— CI 會擋，
 但擋不住的部分要靠你自己講。>
