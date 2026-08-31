# 03 規格審查

先跑機器檢查：

```bash
openspec validate <change> --strict
openspec status --change <change>
```

`validate` 只看結構。下面這六題才是它檢查不出來的，
請你自己讀一遍 artifacts 逐條回答 —— **不要只說「看起來沒問題」**：

1. 哪些 Requirement **沒有失敗路徑的 Scenario**？
   （輸入不合法、權限不足、資源不存在、超過上限）
2. 哪些數值是留到實作才會決定的？（長度、頻率、逾時、上限）
   那些現在就該寫進 Requirement。
3. proposal 的 Non-goals 是空的嗎？空的就是範圍還沒想清楚。
4. 有沒有哪一條需求，你**想不到要怎麼寫測試證明它**？
   那條就不是可測試的需求。
5. 這次的 delta 會不會跟 `openspec/specs/` 既有的 Requirement 衝突？
6. 有沒有東西只存在我們的對話裡、沒寫進 artifacts？

有問題直接說，不要幫我合理化。

修完之後把 PR 從 draft 轉出來讓人 review 規格。
**規格談定才進 `04`。**
