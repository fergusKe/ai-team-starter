#!/usr/bin/env bash
# codex PreToolUse adapter — 橋接 Codex CLI hooks.json 的 PreToolUse payload 與 block-dangerous.sh
# 檔案可執行位元 chmod +x 由 git mode 100755 表達；測試以 bash 執行不依賴 x 位元。
#
# 契約（Codex CLI 0.153.4 官方 hooks 文件，2026-09-14 查）：
# - stdin: Codex PreToolUse JSON（session_id, cwd, hook_event_name, tool_name, tool_input, tool_use_id）
# - 只看 `tool_input.command`（不對 tool_name 做假設——實際字串 Bash／shell 待 M4 實測）：
#     · 缺 tool_input 或不是物件 ⇒ deny
#     · tool_input 有但沒有 command 欄（非 shell 工具）⇒ 放行（無輸出、exit 0）
#     · command 不是非空字串 ⇒ deny
# - 擋下的唯一可靠方式：stdout 印
#     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}} 並 exit 0
#   （不依賴 exit 2）。放行 ⇒ 無輸出、exit 0。
# - 守門候選順序與 setup.mjs guardCandidates 同：$LLM_TEAM_GUARD → <repoRoot|cwd>/scripts/claude-hooks/block-dangerous.sh
#   → $HOME/.claude/hooks/block-dangerous.sh → 真源相對路徑 ../../hooks/block-dangerous.sh
# - 原 stdin 原封不動餵給 guard（它讀 tool_input.command）；guard exit 0 ⇒ 放行、exit 2 ⇒ deny（reason＝guard stderr 前 500 字）、
#   其他 exit／逾時／缺 python3／JSON 壞／找不到 guard ⇒ 全 deny（fail-closed）。
# - 🔴 射程只到 shell 指令字串：寫檔工具、apply_patch、MCP 工具都不在射程（與 agy-pretooluse.sh 同一條欠條）。
#
# 安裝（$CODEX_HOME/hooks.json，預設 ~/.codex/hooks.json）見 SKILL.md §codex hooks.json 範例；`setup.mjs --check --coordinator codex` 會對帳。
set -u

deny_plain() {
  # 沒有 python3 時只能手刻 JSON；reason 只放 ASCII 安全字串
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

if ! command -v python3 >/dev/null 2>&1; then
  deny_plain "codex-pretooluse: guard abnormal (exit 127, python3 missing)"
fi

TMPDIR="${TMPDIR:-/tmp}"
TMP_DIR="$(mktemp -d "$TMPDIR/codex-pretooluse.XXXXXX" 2>/dev/null)" && [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] || {
  deny_plain "codex-pretooluse: cannot create temp dir"
}
trap '[ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && rm -f -- "$TMP_DIR"/stdin.json && rmdir -- "$TMP_DIR" 2>/dev/null || true' EXIT

cat > "$TMP_DIR/stdin.json"

# 與 lib.mjs GIT_ENV_VARS 同源，漂移由測試擋
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_TIMEOUT_SEC="${LLM_TEAM_GUARD_TIMEOUT_SEC:-8}"

python3 - "$TMP_DIR/stdin.json" "$SCRIPT_DIR" "$GUARD_TIMEOUT_SEC" <<'PY'
import json
import os
import subprocess
import sys

stdin_file, script_dir, timeout_sec = sys.argv[1], sys.argv[2], sys.argv[3]


def deny(reason):
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


with open(stdin_file, "rb") as f:
    raw = f.read()

try:
    data = json.loads(raw.decode("utf-8"))
except Exception:
    deny("codex-pretooluse：payload 不合法（stdin 不是合法 JSON）")

if not isinstance(data, dict):
    deny("codex-pretooluse：payload 不合法（根層不是物件）")

tool_input = data.get("tool_input")
if not isinstance(tool_input, dict):
    deny("codex-pretooluse：payload 不合法（缺 tool_input 或不是物件）")

if "command" not in tool_input:
    # 非 shell 工具：不在射程，放行（無輸出）
    sys.exit(0)

cmd = tool_input["command"]
if not isinstance(cmd, str) or len(cmd) == 0:
    deny("codex-pretooluse：payload 不合法（tool_input.command 不是非空字串）")

# cwd：合法絕對路徑且存在才切過去（相對路徑掃描要在那裡做）；否則留在目前目錄
cwd = data.get("cwd")
if isinstance(cwd, str) and os.path.isabs(cwd) and os.path.isdir(cwd):
    try:
        os.chdir(cwd)
    except Exception:
        deny(f"codex-pretooluse：無法切換至 cwd（{cwd}）")

env = dict(os.environ)
for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
          "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"):
    env.pop(k, None)

repo_root = None
try:
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, env=env, timeout=5)
    if r.returncode == 0 and r.stdout.strip():
        repo_root = r.stdout.strip()
except Exception:
    repo_root = None

if repo_root:
    env["CLAUDE_PROJECT_DIR"] = repo_root
else:
    env.pop("CLAUDE_PROJECT_DIR", None)

home = env.get("HOME", "")
candidates = []
g = env.get("LLM_TEAM_GUARD")
if g:
    if g.startswith("~/") and home:
        g = os.path.join(home, g[2:])
    candidates.append(os.path.abspath(g))
candidates.append(os.path.join(repo_root or os.getcwd(), "scripts", "claude-hooks", "block-dangerous.sh"))
if home:
    candidates.append(os.path.join(home, ".claude", "hooks", "block-dangerous.sh"))
candidates.append(os.path.normpath(os.path.join(script_dir, "..", "..", "hooks", "block-dangerous.sh")))

guard = None
for c in candidates:
    if os.path.isfile(c) and os.access(c, os.R_OK):
        guard = c
        break
if not guard:
    deny(f"codex-pretooluse：找不到守門腳本（候選：{', '.join(candidates)}）")

try:
    timeout = float(timeout_sec)
except Exception:
    timeout = 8.0

try:
    r = subprocess.run(["bash", guard], input=raw, capture_output=True, env=env, timeout=timeout)
except subprocess.TimeoutExpired:
    deny(f"codex-pretooluse：守門逾時（{timeout:g}s）")
except Exception as e:
    deny(f"codex-pretooluse：守門啟動失敗（{type(e).__name__}）")

if r.returncode == 0:
    sys.exit(0)

if r.returncode == 2:
    reason = r.stderr.decode("utf-8", errors="replace").strip()[:500]
    if not reason:
        reason = "守門擋下但未給原因"
    deny(reason)

deny(f"codex-pretooluse：守門異常結束（exit {r.returncode}）")
PY
PY_STATUS=$?
if [ $PY_STATUS -ne 0 ]; then
  deny_plain "codex-pretooluse: adapter abnormal (exit $PY_STATUS)"
fi
exit 0
