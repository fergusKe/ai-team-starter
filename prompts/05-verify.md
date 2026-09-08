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
- [ ] **每個 Scenario 都有對應測試** —— 跑
      `bash .github/scripts/check-scenario-coverage.sh`，**把它印出來的缺口清單
      原文貼上**，然後對每一條說出處置：補測試／改成人工驗證並把紀錄寫進
      `tasks.md`／說明它為什麼不需要自動測試。
      **沒有缺口也要貼**「0 條沒有」那一行 —— 沒有貼就是沒有跑。
      那支回 `2` 代表**量不到**（測試沒綠、報告產不出來），不是沒有缺口。
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

### 這個 change 的 Scenario 要到 archive 之後才會出現在缺口報告裡

缺口報告只掃 `openspec/specs/`，而 archive 才會把 delta 折進去。所以**在
archive PR 之後再跑一次**，把新出現的缺口一起處置掉 —— 沒有任何閘門會替你
記得這件事。

### 合併的時候順手把分支收掉

```bash
git worktree remove <那個 worktree>          # 有用 worktree 才需要
gh pr merge <PR> --squash --delete-branch
```

`--delete-branch` **遠端與本機一起刪**。少了它，本機那個分支之後就很難刪 ——
squash 合併產生的是一個全新的 commit，原分支的 tip 不是 `main` 的祖先，於是
git 永遠判定「還沒合併」而拒絕刪除，只能一個個確認內容真的在 main 上之後強制
刪掉（實際發生過，一次堆了 21 個）。

worktree 佔著分支的時候 `--delete-branch` 會失敗，所以順序是先移除 worktree。

全部通過、PR 合併之後：

```
/opsx:archive
```

讓 delta 同步進 `openspec/specs/`。
**沒 archive 等於這次的成果沒有進入系統的現況描述。**
