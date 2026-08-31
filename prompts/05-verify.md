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
- [ ] **每個 Scenario 都有對應測試** —— 說得出哪個測試對應哪個 Scenario
- [ ] `tasks.md` 沒有殘留的 `- [ ]`
- [ ] lint / typecheck / test / build 全綠（貼輸出）
- [ ] CI 在 PR 上綠燈
- [ ] 規格沒寫的東西，你沒有順手做

**特別檢查一件事**：`npm test` 有真的跑到測試嗎？
測試檔是零個的時候，有的 runner 直接失敗、有的直接通過 ——
**兩種都不算驗證過**。要看到測試數量。

有任何一條不成立就直接說是哪一條，不要說「基本上完成了」。

全部通過、PR 合併之後：

```
/opsx:archive
```

讓 delta 同步進 `openspec/specs/`。
**沒 archive 等於這次的成果沒有進入系統的現況描述。**
