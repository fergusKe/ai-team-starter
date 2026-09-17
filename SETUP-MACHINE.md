# 這台機器要有什麼（每台各做一次；這份不要刪）

`SETUP-GITHUB.md` 做完會刪，這份**不會** —— 它講的是機器，換一台、新人加入，都要再走一次。
入口在 `README.md`〈安裝〉前置與 `SETUP-GITHUB.md`〈8a〉；日常對帳指令在 `AGENTS.md`〈多模型分工的票流程〉。

**順序**：先做第 1、2 節（不需要專案），再把專案 clone 下來、`cd` 進去做第 3、4 節——`setup.mjs` 在專案的 `.agents/skills/llm-team/` 裡，
在家目錄跑會 `MODULE_NOT_FOUND`。全新的 macOS 還沒有 Homebrew：下面標 macOS 的捷徑都預設你裝了（https://brew.sh ），不想用 brew 就走每一項的官方連結。

**原則：先查有沒有，沒有才裝，而且只裝一份。** 下面的安裝指令是各工具**官方文件當下的做法**，
以連結為準——套件管理器的指令會過期，文件不會替你更新。同一個工具裝了兩份（例如 `claude` 同時有 npm 與 Homebrew）
會在升級時各自漂移、PATH 先找到哪個就用哪個，官方明講要**只留一份**。

## 1. 執行檔

| 工具 | 誰用它 | 版本 | 先查 | 沒有才裝（官方做法） |
|---|---|---|---|---|
| git | 全部 | 任何近期版本 | `git --version` | 作業系統套件或 https://git-scm.com |
| Node | openspec、llm-team 腳本、CI 同版 | **24**（`ci.yml` 釘的） | `node -v` | https://nodejs.org ；用 nvm／fnm 也行，那是個人選擇，模板不指定 |
| pnpm | 全部 `pnpm` 指令 | **10.27.0**（`package.json` 的 `packageManager`，唯一真源） | `pnpm -v` | Node 自帶 corepack：`corepack enable`，之後在專案目錄跑 `pnpm` 會自動用對版；**不要**另外全域裝別的版本 |
| python3 | `progress.sh`、`check-pr-branch.sh` 等腳本的內嵌 python | 3.9 以上（macOS 內建的就夠；CI 用 ubuntu 內建的） | `python3 --version` | macOS 內建；Linux 用系統套件 |
| gh | `SETUP-GITHUB.md` 的 API 呼叫、開 PR、`archive-review.sh` | 任何近期版本 | `gh --version` | https://cli.github.com （macOS：`brew install gh`） |
| claude | Claude Code 統整者 | 跟著自動更新 | `which -a claude` **要只有一行** | 官方推薦原生安裝：`curl -fsSL https://claude.ai/install.sh \| bash`（裝到 `~/.local/bin/claude`，會自動更新）。已經有 npm `-g` 或 Homebrew 那份就**不要再裝**，或照官方 troubleshoot-install 頁移除多的，只留一份 |
| codex | codex 統整者／複審者／裁決者 | 任何近期版本（這套實測過 codex-cli 0.153–0.154） | `codex --version` | https://github.com/openai/codex （2025 年起的 Rust 版 CLI，不是 2023 停用的 Codex 模型；macOS：`brew install codex`，或 `npm i -g @openai/codex`，二選一） |
| agy | 寫手、Gemini 複審者 | 任何近期版本 | `agy --version` | https://antigravity.google/product/antigravity-cli （macOS：`brew install --cask antigravity-cli`） |

只用一種統整者的人，另外兩個 CLI 仍然要裝——`llm-team.config.json` 的每個 profile 都同時用到三家（寫手是 agy、裁決是 codex）。
`setup.mjs --check --coordinator <x>` 會逐一列出「哪個角色需要哪個執行檔」，缺哪個它會說。

## 2. 登入（每台一次，不跟 repo 走）

| 工具 | 怎麼登入 | 怎麼確認 |
|---|---|---|
| gh | `gh auth login`（對要建 ruleset 的 repo 要 admin） | `gh auth status` |
| claude | 第一次執行 `claude` 走瀏覽器登入 | `claude` 進得去、`/status` 看得到帳號 |
| codex | `codex login` | `codex login status` |
| agy | 第一次執行 `agy` 走瀏覽器登入 | `agy models` 列得出模型 |

`setup.mjs --check` **不驗登入與額度**；額度用完時 `ticket.mjs run` 會在該角色那一步失敗，不會提前警告。

## 3. 守門與 hooks（`setup.mjs --check` 對帳的就是這些）

| 項目 | 在哪 | 怎麼來 |
|---|---|---|
| `block-dangerous.sh`（破壞性指令閘：遞迴刪除、`git reset --hard`、force push⋯⋯） | `~/.claude/hooks/block-dangerous.sh`（或 `LLM_TEAM_GUARD` 指到的路徑） | **不在模板裡**，也沒有官方來源——它在維護者的 config repo，部署到每台機器的 `~/.claude/hooks/`。沒有那個 repo 的人跟維護者拿一份放到同一路徑。三家 CLI 都靠它，沒有它 `--check` 直接紅 |
| Claude 的 PreToolUse hook | `~/.claude/settings.json` 的 `hooks.PreToolUse` 有一條 command 含 `block-dangerous` | 手動加下面那段；`--check --coordinator claude` 會報有沒有 |
| agy 的指令白名單與信任目錄 | `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow`、`trustedWorkspaces`；hook 在 `~/.gemini/config/hooks.json` | `--check` 缺什麼就**印出要合併的 JSON 片段**，你手動貼進去。**只認全域**：workspace 層的 hooks 在 headless 不載入（2026-09-13 實測） |
| codex 的 hook | `~/.codex/hooks.json` 的 PreToolUse 指到 `<專案>/.agents/skills/llm-team/codex-pretooluse.sh`（絕對路徑，matcher 要涵蓋 `Bash`） | JSON 形狀照 `.agents/skills/llm-team/SKILL.md`〈codex〉那段抄（那裡是真源，這裡不重複）；之後**在互動式 codex session 信任一次**才會載入——`--check` 只直跑轉接器，證明不了互動 session 已載入。只拿 codex 當無頭複審／裁決（`codex exec`）的機器可以不設，它靠 sandbox 不靠 hook |

Claude 那一條的寫法（合併進 `~/.claude/settings.json`，已有 `hooks` 就把這個 entry 加進 `PreToolUse` 陣列）：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "$HOME/.claude/hooks/block-dangerous.sh" } ] }
    ]
  }
}
```

為什麼不把守門放進 repo：agy 與 codex 的 hooks 只認全域設定，放進 repo 也載不到；Claude 那一份放得進（專案層 `.claude/settings.json` 支援 hooks），
但全域已經有一份時會**同一條指令跑兩次守門**，而且 24KB 的腳本每個 repo 一份就是每個 repo 各自漂——跟 llm-team 快照要解的是同一個問題。
決策記錄在 `docs/DECISIONS.md`〈2026-09-17 機器層的東西不進 repo〉。

## 4. 驗收

```bash
node .agents/skills/llm-team/setup.mjs --check --coordinator claude   # 會用到的統整者各跑一次，每一行都要 ✓
which -a claude                                                        # 只能有一行
pnpm -v                                                                # 要印 10.27.0
```

全 ✓ 之後這台機器就完成了；下一個專案不用再做這一節，只做 `SETUP-GITHUB.md`。
