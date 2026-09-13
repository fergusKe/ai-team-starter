#!/usr/bin/env bash
# agy PreToolUse adapter — 橋接 agy run_command payload 與 block-dangerous.sh
# 檔案可執行位元 chmod +x 由 git mode 100755 表達，由統整者 commit 時設定；測試以 bash 執行不依賴 x 位元。
#
# 契約：
# - stdin: agy PreToolUse JSON payload
# - stdout: {"decision":"ask"} 或 {"decision":"deny","reason":"..."}
# - 任何故障/異常一律 fail-closed 回 deny
set -u

if ! command -v python3 >/dev/null 2>&1; then
  printf '{"decision":"deny","reason":"agy-pretooluse：守門異常結束（exit 127，缺 python3）"}\n'
  exit 0
fi

TMPDIR="${TMPDIR:-/tmp}"
TMP_DIR="$(mktemp -d "$TMPDIR/agy-pretooluse.XXXXXX" 2>/dev/null)" && [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] || {
  printf '{"decision":"deny","reason":"agy-pretooluse：無法建立暫存目錄"}\n'
  exit 0
}
trap '[ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && rm -f -- "$TMP_DIR"/stdin.json "$TMP_DIR"/cwd.txt "$TMP_DIR"/guard_in.json "$TMP_DIR"/guard.err && rmdir -- "$TMP_DIR" 2>/dev/null || true' EXIT

cat > "$TMP_DIR/stdin.json"

VALID_OUT="$(python3 -c '
import sys, json, os

try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    print(json.dumps({"decision": "deny", "reason": "agy-pretooluse：payload 不合法（stdin 不是合法 JSON）"}, ensure_ascii=False))
    sys.exit(10)

if not isinstance(data, dict):
    print(json.dumps({"decision": "deny", "reason": "agy-pretooluse：payload 不合法（根層不是物件）"}, ensure_ascii=False))
    sys.exit(10)

tool_call = data.get("toolCall")
if not isinstance(tool_call, dict):
    print(json.dumps({"decision": "deny", "reason": "agy-pretooluse：payload 不合法（缺 toolCall）"}, ensure_ascii=False))
    sys.exit(10)

args = tool_call.get("args")
if not isinstance(args, dict):
    print(json.dumps({"decision": "deny", "reason": "agy-pretooluse：payload 不合法（缺 args）"}, ensure_ascii=False))
    sys.exit(10)

if "CommandLine" not in args:
    print(json.dumps({"decision": "deny", "reason": "agy-pretooluse：payload 不合法（缺 CommandLine）"}, ensure_ascii=False))
    sys.exit(10)

cmd = args["CommandLine"]
if not isinstance(cmd, str) or len(cmd) == 0:
    print(json.dumps({"decision": "deny", "reason": "agy-pretooluse：payload 不合法（CommandLine 不是非空字串）"}, ensure_ascii=False))
    sys.exit(10)

if "Cwd" not in args:
    print(json.dumps({"decision": "deny", "reason": "agy-pretooluse：payload 不合法（缺 Cwd）"}, ensure_ascii=False))
    sys.exit(10)

cwd = args["Cwd"]
if not isinstance(cwd, str) or not os.path.isabs(cwd):
    print(json.dumps({"decision": "deny", "reason": "agy-pretooluse：payload 不合法（Cwd 不是絕對路徑）"}, ensure_ascii=False))
    sys.exit(10)

if not os.path.isdir(cwd):
    print(json.dumps({"decision": "deny", "reason": "agy-pretooluse：payload 不合法（Cwd 目錄不存在）"}, ensure_ascii=False))
    sys.exit(10)

with open(sys.argv[2], "w", encoding="utf-8") as f:
    f.write(cwd)

with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump({"tool_input": {"command": cmd}}, f, ensure_ascii=False)
' "$TMP_DIR/stdin.json" "$TMP_DIR/cwd.txt" "$TMP_DIR/guard_in.json")"
VALID_STATUS=$?

if [ $VALID_STATUS -eq 10 ]; then
  printf '%s\n' "$VALID_OUT"
  exit 0
elif [ $VALID_STATUS -ne 0 ]; then
  python3 -c 'import sys, json; print(json.dumps({"decision": "deny", "reason": f"agy-pretooluse：守門異常結束（exit {sys.argv[1]}）"}, ensure_ascii=False))' "$VALID_STATUS"
  exit 0
fi

# 與 lib.mjs GIT_ENV_VARS 同源，漂移由測試擋
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX

GUARD="${LLM_TEAM_GUARD:-$HOME/.claude/hooks/block-dangerous.sh}"
GUARD="${GUARD/#\~/$HOME}"
if [[ "$GUARD" != /* ]]; then
  GUARD="$PWD/$GUARD"
fi

if [ ! -f "$GUARD" ] || [ ! -r "$GUARD" ]; then
  python3 -c 'import sys, json; print(json.dumps({"decision": "deny", "reason": f"agy-pretooluse：找不到守門腳本（{sys.argv[1]}）"}, ensure_ascii=False))' "$GUARD"
  exit 0
fi

CWD="$(cat "$TMP_DIR/cwd.txt")"
cd -- "$CWD" || {
  python3 -c 'import sys, json; print(json.dumps({"decision": "deny", "reason": f"agy-pretooluse：無法切換至 Cwd 目錄（{sys.argv[1]}）"}, ensure_ascii=False))' "$CWD"
  exit 0
}

CLAUDE_PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$CLAUDE_PROJECT_DIR" ]; then
  export CLAUDE_PROJECT_DIR
else
  unset CLAUDE_PROJECT_DIR
fi

bash "$GUARD" < "$TMP_DIR/guard_in.json" 2> "$TMP_DIR/guard.err"
GUARD_STATUS=$?

if [ $GUARD_STATUS -eq 0 ]; then
  printf '{"decision":"ask"}\n'
  exit 0
elif [ $GUARD_STATUS -eq 2 ]; then
  python3 -c '
import sys, json
with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as f:
    content = f.read()
reason = ""
for line in content.splitlines():
    line = line.strip()
    if line:
        reason = line
        break
if not reason:
    reason = "守門擋下但未給原因"
print(json.dumps({"decision": "deny", "reason": reason}, ensure_ascii=False))
' "$TMP_DIR/guard.err"
  exit 0
else
  python3 -c '
import sys, json
print(json.dumps({"decision": "deny", "reason": f"agy-pretooluse：守門異常結束（exit {sys.argv[1]}）"}, ensure_ascii=False))
' "$GUARD_STATUS"
  exit 0
fi
