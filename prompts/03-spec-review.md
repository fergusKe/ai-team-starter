# 03 規格審查

先跑機器檢查：

```bash
pnpm exec openspec validate <change> --strict
pnpm exec openspec status --change <change>
```

`validate` 只看結構。下面這七題才是它檢查不出來的，
請你自己讀一遍 artifacts 逐條回答 —— **不要只說「看起來沒問題」**：

1. 哪些 Requirement **沒有失敗路徑的 Scenario**？
   （輸入不合法、權限不足、資源不存在、超過上限）
   有的那些：**有沒有寫出失敗之後什麼不能變**？沒寫，測試就不知道要驗什麼。
2. 哪些數值是留到實作才會決定的？（長度、頻率、逾時、上限）
   那些現在就該寫進 Requirement。
3. proposal 的 Non-goals 是空的嗎？空的就是範圍還沒想清楚。
4. 有沒有哪一條需求，你**想不到要怎麼寫測試證明它**？
   那條就不是可測試的需求。
5. 這次的 delta 會不會跟 `openspec/specs/` 既有的 Requirement 衝突？
6. 有沒有東西只存在我們的對話裡、沒寫進 artifacts？
7. 哪些**新寫的** Scenario 有不只一個動作？下面這行列出 `WHEN`＋`AND WHEN` 不只一個的；
   `THEN` 後面會改狀態的 `AND` 它抓不到，要自己讀。每一條判一次：只改壞其中一個
   結果，這條還會過嗎？會就拆（規則在 `openspec/config.yaml`）。

   ```bash
   awk 'FNR==1||/^#/{if(n>1)print FILENAME": "t"（"n" 個動作）";n=0;t=""} /^#### Scenario:/{t=substr($0,15)} /^[[:space:]]*- \*\*(AND )?WHEN\*\*/{n++} END{if(n>1)print FILENAME": "t"（"n" 個動作）"}' openspec/changes/<change>/specs/*/spec.md
   ```

有問題直接說，不要幫我合理化。

修完之後把 PR 從 draft 轉出來讓人 review 規格。

**規格 PR 合併之後**，才開實作分支：

```bash
git switch main
git pull --ff-only          # 不要產生 merge commit
git switch -c feat/<change-name>--<slice>
```

`feat/` 的閘門會去 main 上找 `openspec/changes/<change-name>/proposal.md`，
所以**這一步不能省** —— 規格還沒進 main 就開實作分支，一定被擋。
一個 change 可以有很多個 `--<slice>` 分支。

**規格合併才進 `04`。**
