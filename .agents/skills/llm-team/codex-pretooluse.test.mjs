/**
 * `codex-pretooluse.sh`（Codex CLI PreToolUse 轉接器）的測試。樣板照 agy-pretooluse.test.mjs。
 *
 * 🔴 契約差異（Codex 0.153.4 hooks）：擋 ⇒ stdout 印 hookSpecificOutput.permissionDecision=deny 且 exit 0；
 *    放行 ⇒ 【無輸出】exit 0（不是 {"decision":"ask"}）。所以「放行」的斷言要同時量 stdout 為空與 exit 0。
 * 🔴 不打真的 codex；守門用假 binary（LLM_TEAM_GUARD），最後一段用這台真的 block-dangerous.sh 做整合。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GIT_ENV_VARS, CLEAN_GIT_ENV } from './lib.mjs'
import { resolveGuardPath, guardCandidates } from './setup.mjs'

/** 與 agy-pretooluse.test.mjs 同一條判定（不 import 那個測試檔——import 會把它整套測試再跑一次）。 */
function shouldSkipGuardIntegration(env, guardPath) {
  if (guardPath) return false
  return env?.CI === 'true' || env?.CI === '1'
}

const ADAPTER_PATH = fileURLToPath(new URL('./codex-pretooluse.sh', import.meta.url))

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Codex PreToolUse payload（官方欄位）；toolInput 可整個覆寫以模擬非 shell 工具。 */
function makePayload(command, cwd, { toolInput, toolName = 'Bash' } = {}) {
  const tool_input = toolInput !== undefined ? toolInput : command !== undefined ? { command } : {}
  const p = {
    session_id: 'sess-1',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'call-1',
    tool_input,
  }
  if (cwd !== undefined) p.cwd = cwd
  return JSON.stringify(p)
}

function runAdapter(input, env = {}, adapterPath = ADAPTER_PATH) {
  const r = spawnSync('bash', [adapterPath], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  let json = null
  try {
    json = JSON.parse(r.stdout.trim())
  } catch {
    json = null
  }
  const decision = json?.hookSpecificOutput?.permissionDecision ?? null
  const reason = json?.hookSpecificOutput?.permissionDecisionReason ?? ''
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, decision, reason }
}

function assertAllowed(res, label) {
  assert.equal(res.status, 0, `${label}：exit 應為 0`)
  assert.equal(res.stdout, '', `${label}：放行必須無輸出，實際 stdout：${res.stdout}`)
}

function assertDenied(res, label) {
  assert.equal(res.status, 0, `${label}：deny 也要 exit 0（Codex 不依賴 exit 2）`)
  assert.equal(res.decision, 'deny', `${label}：應 deny，實際 stdout：${res.stdout}`)
  assert.equal(res.json?.hookSpecificOutput?.hookEventName, 'PreToolUse')
}

function makeFakeGuard() {
  const dir = tmpdir('fake-codex-guard-')
  const guardPath = path.join(dir, 'fake-guard.sh')
  fs.writeFileSync(
    guardPath,
    `#!/usr/bin/env bash
INPUT="$(cat)"
if [ -n "$FAKE_RECORD_FILE" ]; then
  printf '%s' "$INPUT" > "$FAKE_RECORD_FILE"
fi
if [ -n "$FAKE_ENV_RECORD" ]; then
  printf '%s\\n' "\${CLAUDE_PROJECT_DIR:-}" > "$FAKE_ENV_RECORD"
  pwd >> "$FAKE_ENV_RECORD"
  printf '%s\\n' "\${GIT_DIR:-__UNSET__}" >> "$FAKE_ENV_RECORD"
fi
if echo "$INPUT" | grep -q 'rm -rf'; then
  echo '🚫 BLOCKED by fake: rm' >&2
  exit 2
fi
if echo "$INPUT" | grep -q 'push --force'; then
  echo '🚫 BLOCKED by fake: force push' >&2
  exit 2
fi
if echo "$INPUT" | grep -q 'boom'; then
  exit 1
fi
if echo "$INPUT" | grep -q 'silent'; then
  exit 2
fi
if echo "$INPUT" | grep -q 'sleepy'; then
  sleep 5
  exit 0
fi
exit 0
`
  )
  return guardPath
}

describe('codex-pretooluse.sh 轉接器測試（假守門）', () => {
  const fakeGuard = makeFakeGuard()
  const baseDir = tmpdir('codex-pretool-cwd-')

  test('漂移檢查：腳本內 unset 變數與 lib.mjs GIT_ENV_VARS 逐一對應', () => {
    const content = fs.readFileSync(ADAPTER_PATH, 'utf8')
    assert.match(content, /與 lib\.mjs GIT_ENV_VARS 同源，漂移由測試擋/)
    for (const v of GIT_ENV_VARS) {
      assert.ok(content.includes(v), `腳本內應 unset ${v}`)
    }
  })

  test('a. deny canary：git push --force origin main ⇒ deny、reason 含 BLOCKED；rm -rf / ⇒ deny', () => {
    const r1 = runAdapter(makePayload('git push --force origin main', baseDir), { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r1, 'force push')
    assert.match(r1.reason, /BLOCKED/)
    const r2 = runAdapter(makePayload('rm -rf /', baseDir), { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r2, 'rm -rf /')
    assert.match(r2.reason, /BLOCKED/)
  })

  test('b. 放行：git status ⇒ 無輸出、exit 0（逐字空字串）', () => {
    const res = runAdapter(makePayload('git status', baseDir), { LLM_TEAM_GUARD: fakeGuard })
    assertAllowed(res, 'git status')
    assert.equal(res.json, null)
  })

  test('c. 非 shell 工具（tool_input 有但沒有 command 欄）⇒ 放行無輸出；tool_name 隨便寫也一樣（不對 tool_name 做假設）', () => {
    const r1 = runAdapter(makePayload(undefined, baseDir, { toolInput: { path: '/x/y.ts', content: 'rm -rf /' }, toolName: 'apply_patch' }), {
      LLM_TEAM_GUARD: fakeGuard,
    })
    assertAllowed(r1, 'apply_patch')
    const r2 = runAdapter(makePayload(undefined, baseDir, { toolInput: {}, toolName: 'Bash' }), { LLM_TEAM_GUARD: fakeGuard })
    assertAllowed(r2, 'Bash 但沒 command')
  })

  test('d. 缺 tool_input／tool_input 不是物件／command 空字串／command 非字串 ⇒ 各 deny 且 reason 指名', () => {
    const noInput = JSON.stringify({ tool_name: 'Bash', cwd: baseDir })
    const r1 = runAdapter(noInput, { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r1, '缺 tool_input')
    assert.match(r1.reason, /缺 tool_input/)

    const r2 = runAdapter(makePayload(undefined, baseDir, { toolInput: 'git status' }), { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r2, 'tool_input 是字串')
    assert.match(r2.reason, /缺 tool_input 或不是物件/)

    const r3 = runAdapter(makePayload('', baseDir), { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r3, 'command 空字串')
    assert.match(r3.reason, /command 不是非空字串/)

    const r4 = runAdapter(makePayload(undefined, baseDir, { toolInput: { command: ['git', 'status'] } }), { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r4, 'command 是陣列')
    assert.match(r4.reason, /command 不是非空字串/)
  })

  test('e. 壞 JSON stdin ⇒ deny 含「不合法」；根層是陣列 ⇒ deny', () => {
    const r1 = runAdapter('not a valid json', { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r1, '壞 JSON')
    assert.match(r1.reason, /不合法/)
    const r2 = runAdapter('[1,2]', { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r2, '根層陣列')
    assert.match(r2.reason, /根層不是物件/)
  })

  test('f. 四個候選都不存在（LLM_TEAM_GUARD 指到不存在、HOME 空 tmp、cwd 非 repo、轉接器副本放在沒有 ../../hooks 的 tmp）⇒ deny 含「找不到守門」且列出候選', () => {
    // 真源目錄本身帶 ../../hooks/block-dangerous.sh（第 4 順位），要驗「找不到」得把轉接器複製到 tmp 跑
    const copyDir = path.join(tmpdir('codex-adapter-copy-'), 'a', 'b')
    fs.mkdirSync(copyDir, { recursive: true })
    const copyPath = path.join(copyDir, 'codex-pretooluse.sh')
    fs.copyFileSync(ADAPTER_PATH, copyPath)
    const emptyHome = tmpdir('codex-empty-home-')
    const res = runAdapter(makePayload('ls', baseDir), { LLM_TEAM_GUARD: '/tmp/non-existent-guard-path.sh', HOME: emptyHome }, copyPath)
    assertDenied(res, '找不到守門')
    assert.match(res.reason, /找不到守門/)
    assert.ok(res.reason.includes('/tmp/non-existent-guard-path.sh'))
    assert.ok(res.reason.includes(path.join(emptyHome, '.claude', 'hooks', 'block-dangerous.sh')))
    // 陽性對照：同一份副本、HOME 放一個會放行的守門 ⇒ 放行
    const hookDir = path.join(emptyHome, '.claude', 'hooks')
    fs.mkdirSync(hookDir, { recursive: true })
    fs.writeFileSync(path.join(hookDir, 'block-dangerous.sh'), '#!/usr/bin/env bash\nexit 0\n')
    const res2 = runAdapter(makePayload('ls', baseDir), { LLM_TEAM_GUARD: '', HOME: emptyHome }, copyPath)
    assertAllowed(res2, '對照')
  })

  test('g. guard exit 1（boom）⇒ deny 含「異常結束」；guard exit 2 無 stderr（silent）⇒ deny 含「未給原因」', () => {
    const r1 = runAdapter(makePayload('boom', baseDir), { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r1, 'boom')
    assert.match(r1.reason, /異常結束（exit 1）/)
    const r2 = runAdapter(makePayload('silent', baseDir), { LLM_TEAM_GUARD: fakeGuard })
    assertDenied(r2, 'silent')
    assert.match(r2.reason, /未給原因/)
  })

  test('h. guard 逾時（sleep 5、LLM_TEAM_GUARD_TIMEOUT_SEC=1）⇒ deny 含「守門逾時」且 2 秒內回來', () => {
    const start = Date.now()
    const res = runAdapter(makePayload('sleepy', baseDir), { LLM_TEAM_GUARD: fakeGuard, LLM_TEAM_GUARD_TIMEOUT_SEC: '1' })
    const elapsed = Date.now() - start
    assertDenied(res, 'timeout')
    assert.match(res.reason, /守門逾時/)
    assert.ok(elapsed < 3000, `應在 3 秒內回來，實際 ${elapsed}ms`)
  })

  test('i. round-trip：原 stdin 原封不動餵 guard——command 含引號、換行、反斜線、CJK ⇒ guard 收到的 JSON 逐字等於 stdin', () => {
    const complexCmd = 'echo "hello\\nworld" \'single quote\' \\ backslash 繁體中文 測試 \t tab'
    const recordFile = path.join(tmpdir('codex-rt-'), 'stdin.json')
    const payload = makePayload(complexCmd, baseDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: fakeGuard, FAKE_RECORD_FILE: recordFile })
    assertAllowed(res, 'round-trip')
    assert.ok(fs.existsSync(recordFile), '假守門應記錄 stdin')
    assert.equal(fs.readFileSync(recordFile, 'utf8'), payload, '守門收到的 stdin 必須與原 payload 逐字相等')
    assert.equal(JSON.parse(fs.readFileSync(recordFile, 'utf8')).tool_input.command, complexCmd)
  })

  test('j. cwd 是 git repo 的子目錄 ⇒ guard 看到 CLAUDE_PROJECT_DIR＝repo 根、process cwd＝該子目錄；非 git tmp ⇒ CLAUDE_PROJECT_DIR 空', () => {
    const repoDir = tmpdir('codex-git-repo-')
    execFileSync('git', ['init', '-q', repoDir], { env: CLEAN_GIT_ENV })
    const subDir = path.join(repoDir, 'sub', 'nested')
    fs.mkdirSync(subDir, { recursive: true })
    const envRecord = path.join(tmpdir('codex-env-'), 'env.txt')
    const res = runAdapter(makePayload('ls', subDir), { LLM_TEAM_GUARD: fakeGuard, FAKE_ENV_RECORD: envRecord })
    assertAllowed(res, 'git 子目錄')
    const lines = fs.readFileSync(envRecord, 'utf8').split('\n')
    assert.equal(fs.realpathSync(lines[0]), fs.realpathSync(repoDir))
    assert.equal(fs.realpathSync(lines[1]), fs.realpathSync(subDir))

    const nonGit = tmpdir('codex-non-git-')
    const envRecord2 = path.join(tmpdir('codex-env2-'), 'env.txt')
    const res2 = runAdapter(makePayload('ls', nonGit), {
      LLM_TEAM_GUARD: fakeGuard,
      FAKE_ENV_RECORD: envRecord2,
      CLAUDE_PROJECT_DIR: '/some/parent/project',
    })
    assertAllowed(res2, '非 git')
    assert.equal(fs.readFileSync(envRecord2, 'utf8').split('\n')[0], '', '非 git 目錄下 CLAUDE_PROJECT_DIR 應被 unset')
  })

  test('k. env 帶 GIT_DIR=/x ⇒ guard 看不到 GIT_DIR', () => {
    const envRecord = path.join(tmpdir('codex-env3-'), 'env.txt')
    const res = runAdapter(makePayload('ls', baseDir), { LLM_TEAM_GUARD: fakeGuard, FAKE_ENV_RECORD: envRecord, GIT_DIR: '/x/custom' })
    assertAllowed(res, 'GIT_DIR')
    assert.equal(fs.readFileSync(envRecord, 'utf8').split('\n')[2], '__UNSET__')
  })

  test('l. 守門候選順序：沒 LLM_TEAM_GUARD 時 <repo>/scripts/claude-hooks/block-dangerous.sh 優先於 $HOME/.claude/hooks', () => {
    const repoDir = tmpdir('codex-cand-repo-')
    execFileSync('git', ['init', '-q', repoDir], { env: CLEAN_GIT_ENV })
    const home = tmpdir('codex-cand-home-')
    const homeGuardDir = path.join(home, '.claude', 'hooks')
    fs.mkdirSync(homeGuardDir, { recursive: true })
    fs.writeFileSync(path.join(homeGuardDir, 'block-dangerous.sh'), '#!/usr/bin/env bash\necho HOME-GUARD >&2\nexit 2\n')
    // 只有 HOME 那份 ⇒ deny reason 來自 HOME-GUARD
    const r1 = runAdapter(makePayload('ls', repoDir), { HOME: home, LLM_TEAM_GUARD: '' })
    assertDenied(r1, 'home guard')
    assert.match(r1.reason, /HOME-GUARD/)
    // repo 那份出現 ⇒ 優先
    const repoGuardDir = path.join(repoDir, 'scripts', 'claude-hooks')
    fs.mkdirSync(repoGuardDir, { recursive: true })
    fs.writeFileSync(path.join(repoGuardDir, 'block-dangerous.sh'), '#!/usr/bin/env bash\necho REPO-GUARD >&2\nexit 2\n')
    const r2 = runAdapter(makePayload('ls', repoDir), { HOME: home, LLM_TEAM_GUARD: '' })
    assertDenied(r2, 'repo guard')
    assert.match(r2.reason, /REPO-GUARD/)
  })

  test('m. mktemp 失敗失效安全：TMPDIR=/nonexistent/dir ⇒ deny', () => {
    const res = runAdapter(makePayload('ls', baseDir), { LLM_TEAM_GUARD: fakeGuard, TMPDIR: '/nonexistent/dir' })
    assertDenied(res, 'mktemp')
    assert.match(res.reason, /temp dir/)
  })
})

describe('codex-pretooluse.sh 真守門整合測試', () => {
  const realGuard = resolveGuardPath(process.env, import.meta.url)
  const candidates = guardCandidates(process.env, import.meta.url)
  const skipMsg = `沒有任何守門副本（CI 這種沒 agy 的環境）：${candidates.join(', ')}`
  const shouldSkip = shouldSkipGuardIntegration(process.env, realGuard)

  if (!realGuard && !shouldSkip) {
    assert.fail(`這台不是 CI 卻沒有任何守門副本：${candidates.join(', ')}`)
  }

  const baseDir = tmpdir('codex-real-guard-cwd-')

  test('真守門：git push --force origin main ⇒ deny 含 BLOCKED；rm -rf /tmp/x ⇒ deny', { skip: shouldSkip ? skipMsg : false }, () => {
    const r1 = runAdapter(makePayload('git push --force origin main', baseDir), { LLM_TEAM_GUARD: realGuard })
    assertDenied(r1, '真守門 force push')
    assert.match(r1.reason, /BLOCKED/)
    const r2 = runAdapter(makePayload('rm -rf /tmp/x', baseDir), { LLM_TEAM_GUARD: realGuard })
    assertDenied(r2, '真守門 rm -rf')
    assert.match(r2.reason, /BLOCKED/)
  })

  test('真守門：git status ⇒ 放行無輸出', { skip: shouldSkip ? skipMsg : false }, () => {
    const res = runAdapter(makePayload('git status', baseDir), { LLM_TEAM_GUARD: realGuard })
    assertAllowed(res, '真守門 git status')
  })

  test('真守門：子目錄未 commit 含 rm -rf 之 x.sh ⇒ deny（驗證 cd cwd 讓相對路徑掃描有效）', { skip: shouldSkip ? skipMsg : false }, () => {
    const repoDir = tmpdir('codex-real-repo-')
    execFileSync('git', ['init', '-q', repoDir], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'test'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { env: CLEAN_GIT_ENV })
    fs.writeFileSync(path.join(repoDir, '.gitkeep'), '')
    execFileSync('git', ['-C', repoDir, 'add', '.gitkeep'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', repoDir, 'commit', '-qm', 'init'], { env: CLEAN_GIT_ENV })
    const subDir = path.join(repoDir, 'sub')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'x.sh'), '#!/bin/sh\nrm -rf /\n')
    const res = runAdapter(makePayload('bash x.sh', subDir), { LLM_TEAM_GUARD: realGuard })
    assertDenied(res, '真守門 x.sh')
    assert.match(res.reason, /BLOCKED/)
  })
})
