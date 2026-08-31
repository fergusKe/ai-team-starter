# openspec

規格由 **OpenSpec CLI** 管理。這個目錄的形狀由它決定，不要手工造。

```
openspec/
  config.yaml   ← 本專案的寫作規則（context + rules），我們唯一手改的檔案
  specs/        ← 系統「現在是什麼樣子」。archive 時自動同步進來
  changes/      ← 提案中的變更；每個是一份 delta，不是完整規格
    archive/    ← 完成的 change，前面加日期
```

## `specs/` 跟 `changes/` 的差別

這是 OpenSpec 最重要的一個概念，也是最容易搞錯的：

| | 內容 | 誰寫 |
|---|---|---|
| `changes/<name>/specs/<capability>/spec.md` | **差異**（`## ADDED / MODIFIED / REMOVED Requirements`） | 提案時寫 |
| `specs/<capability>/spec.md` | **現況**（完整的 requirement 清單） | archive 時由 delta 合併產生 |

半年後有人問「這個系統現在做得到什麼」，答案在 `specs/`，不是去翻二十個 change 目錄考古。

## 一個 change 的生命週期

```
/opsx:explore    想清楚要做什麼（可跳過）
/opsx:propose    產生 proposal → specs → design → tasks
      ↓          artifacts 產完就停，不會開始寫程式
   開 draft PR   讓人先看規格
      ↓
/opsx:apply      規格談定後才實作
      ↓
/opsx:archive    合併後封存，delta 同步進 specs/
```

`design` 是選用的；`specs` 只有在 `.openspec.yaml` 標了 `skip_specs: true`
（純重構、工具、文件變更）時才能跳過。

## 手動指令

```bash
openspec list                    # 目前有哪些 change
openspec status --change <name>  # 這個 change 的 artifact 完成度
openspec validate <name>         # 結構檢查
openspec validate --all --strict # CI 跑的那一條
openspec view                    # 互動式儀表板
```

## 寫規格的規則在哪

**在 `config.yaml` 的 `rules:`，不在這份 README。**

`openspec instructions` 會把那些規則餵給 agent，所以寫在那裡才有效力；
寫在 README 只有人看得到。要調整規格的品質要求，改 `config.yaml`。

## 已知的坑

**`## Purpose` 的 50 字元下限，中文很容易踩到。**

`validate --strict` 對 **main spec** 要求 `## Purpose` 至少 50 字元。
英文 50 字元約 8 個單字，中文 50 個字是兩三句話 —— 一句話寫完的 Purpose 會不夠。

麻煩的是時機：

```
change 階段  openspec validate <change> --strict   → 綠（不檢查 Purpose 長度）
archive 之後 openspec validate --all --strict      → 紅
```

**PR 上全綠，合併 archive 之後 main 才紅。** `config.yaml` 的 `rules.specs`
已經放了一條提醒 agent 寫夠長。`openspec archive` 自己也會警告，看到就當場修，
不要留到 CI。

**剛建好、還沒填內容的 change 會讓 CI 紅。**

`openspec new change` 只產生 `.openspec.yaml` 與 `README.md`，
`validate --all --strict` 會判它不完整而失敗。**這是對的** ——
半成品的規格本來就不該能合併。它在你的分支上紅，不是在 main 上紅。

在 draft PR 期間看到 `Spec` 那關是紅的，代表 artifacts 還沒寫完，不是設定壞了。

## 平行開發

一個 change = 一個目錄 = 一個分支 = 一個 PR。彼此獨立，可以同時很多個。

兩個 change 會動到同一個 capability 的 spec 時，**先講**，
不要各自 archive 完才發現 `specs/` 被覆蓋。
