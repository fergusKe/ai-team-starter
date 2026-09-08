# 05 完成前的驗證

宣稱完成之前跑這一份。**每一條都要貼實際輸出，不要摘要。**

```bash
openspec validate <change> --strict
openspec status --change <change>
npm run lint && npm run typecheck && npm test && npm run build
```

逐條對照 `AGENTS.md` 的〈完成的定義〉：

- [ ] `openspec validate --strict` 通過
- [ ] 每條 Requirement 都有對應實作
- [ ] **每個 Scenario 都有對應測試** —— 不是說得出來就好，跑
      `bash .github/scripts/check-scenario-coverage.sh`，它會告訴你差哪幾條
- [ ] `tasks.md` 沒有殘留的 `- [ ]`
- [ ] lint / typecheck / test / build 全綠（貼輸出）
- [ ] CI 在 PR 上綠燈
- [ ] 規格沒寫的東西，你沒有順手做

**特別檢查一件事**：`npm test` 有真的跑到測試嗎？
測試檔是零個的時候，有的 runner 直接失敗、有的直接通過 ——
**兩種都不算驗證過**。要看到測試數量。

有任何一條不成立就直接說是哪一條，不要說「基本上完成了」。

### archive 之前：先把 tasks 打勾，用一個 `feat/` PR

**archive 的閘門要求「原封不動的搬移」，而 `validate --all --strict` 要求
沒有未完成項。** 兩者只有先打勾才同時成立 —— 先 archive 再打勾會紅在
「archive 不是原封不動的搬移」。純規格的 change 也一樣。

### 這個 change 的 Scenario 到這裡才會被閘門要求

覆蓋閘門只掃 `openspec/specs/`。**archive 是它第一次看見這些 Scenario 的時候**
—— 沒有測試、也沒有 `VERIFY-BY` 豁免的話，archive PR 會紅。
不用單元測試驗的，在 Scenario 底下寫豁免（種類與證據格式見 `AGENTS.md`）。

全部通過、PR 合併之後：

```
/opsx:archive
```

讓 delta 同步進 `openspec/specs/`。
**沒 archive 等於這次的成果沒有進入系統的現況描述。**
