// ─────────────────── 🔴 git 子行程環境的單一真源 ───────────────────
// git 執行 hook 時會把 GIT_DIR / GIT_INDEX_FILE 等變數塞進子行程環境,而這些變數的
// 優先序【高於】`git -C <dir>`:GIT_DIR 一旦存在,`-C` 只改工作目錄,repo 的位置仍由
// GIT_DIR 決定。⇒ 任何「以為在別的目錄裡玩」的 git 呼叫,其實是在對別的 repo 動手。
//
// 2026-08-03 用拋棄式 decoy repo 實測(git 2.50.1 Apple Git-155):
//   · pre-push / pre-commit 從【主 checkout】跑    → 不設 GIT_DIR(pre-commit 只設相對的 GIT_INDEX_FILE)
//   · 任何 hook 從【linked worktree】跑            → GIT_DIR + GIT_INDEX_FILE 皆設,且是絕對路徑
// A/B 對照(同一段 `git -C <tmp> init` 掛成真 pre-push):主 checkout 推 → 零汙染;
// worktree 推 → `core.bare = true` 被寫進共用的真 .git/config,主 checkout 的
// git status / add / commit 全部失效。這正是 2026-08-03 真的發生過的災情。
//
// 洩漏後 `git ls-files` 會【完全無視 cwd】,只讀被指到的那份索引;索引空/bare 時回 0
// ⇒ 失效方向是「分母靜默歸零」,迴圈對空集合恆真、印綠燈。
//
// ⚠️ 誠實界定:目前所有呼叫點的 ROOT 與 GIT_DIR 剛好指向同一棵樹,所以這是【潛伏危害】
// 而非現行失效。本模組的作用是把「巧合」換成「設計」。
//
// 🔴 這個陣列在全 repo 只能有這一份(tools/git-env-hygiene.test.mjs 會擋第二份)。
export const GIT_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

/** 剝掉 git 環境變數後的環境;可疊加額外變數。 */
export function cleanGitEnv(extra) {
  const e = { ...process.env, ...(extra || {}) }
  for (const k of GIT_ENV_VARS) delete e[k]
  return e
}

/** 呼叫端 99% 的情況直接用這個常數即可。 */
export const CLEAN_GIT_ENV = cleanGitEnv()
