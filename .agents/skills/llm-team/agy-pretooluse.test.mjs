import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GIT_ENV_VARS, CLEAN_GIT_ENV } from './lib.mjs'
import { resolveGuardPath, guardCandidates } from './setup.mjs'

export function shouldSkipGuardIntegration(env, guardPath) {
  if (guardPath) return false
  return env?.CI === 'true' || env?.CI === '1'
}

const ADAPTER_PATH = fileURLToPath(new URL('./agy-pretooluse.sh', import.meta.url))

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makePayload(command, cwd) {
  const args = {}
  if (command !== undefined) args.CommandLine = command
  if (cwd !== undefined) args.Cwd = cwd
  return JSON.stringify({
    conversationId: 'test-conv-123',
    workspacePaths: [],
    transcriptPath: '/tmp/transcript.jsonl',
    modelName: 'gemini-flash',
    stepIdx: 1,
    toolCall: {
      name: 'run_command',
      args,
    },
  })
}

function runAdapter(input, env = {}) {
  const r = spawnSync('bash', [ADAPTER_PATH], {
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
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

function makeFakeGuard() {
  const dir = tmpdir('fake-guard-')
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
if echo "$INPUT" | grep -q 'boom'; then
  exit 1
fi
if echo "$INPUT" | grep -q 'silent'; then
  exit 2
fi
exit 0
`
  )
  return guardPath
}

describe('agy-pretooluse.sh 轉接器測試（假守門）', () => {
  const fakeGuard = makeFakeGuard()
  const baseDir = tmpdir('pretool-cwd-')

  test('漂移檢查：腳本內 unset 變數與 lib.mjs GIT_ENV_VARS 逐一對應', () => {
    const content = fs.readFileSync(ADAPTER_PATH, 'utf8')
    assert.match(content, /與 lib\.mjs GIT_ENV_VARS 同源，漂移由測試擋/)
    for (const v of GIT_ENV_VARS) {
      assert.ok(content.includes(v), `腳本內應 unset ${v}`)
    }
  })

  test('a. rm -rf x ⇒ deny、reason 含 BLOCKED', () => {
    const payload = makePayload('rm -rf x', baseDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: fakeGuard })
    assert.equal(res.status, 0)
    assert.deepEqual(res.json?.decision, 'deny')
    assert.match(res.json?.reason || '', /BLOCKED/)
  })

  test('b. git status ⇒ {"decision":"ask"} 逐字', () => {
    const payload = makePayload('git status', baseDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: fakeGuard })
    assert.equal(res.status, 0)
    assert.equal(res.stdout.trim(), '{"decision":"ask"}')
    assert.deepEqual(res.json, { decision: 'ask' })
  })

  test('c. boom ⇒ deny 含「異常結束」', () => {
    const payload = makePayload('boom', baseDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: fakeGuard })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'deny')
    assert.match(res.json?.reason || '', /異常結束/)
  })

  test('d. silent ⇒ deny 含「未給原因」', () => {
    const payload = makePayload('silent', baseDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: fakeGuard })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'deny')
    assert.match(res.json?.reason || '', /未給原因/)
  })

  test('e. 壞 JSON stdin ⇒ deny 含「不合法」', () => {
    const res = runAdapter('not a valid json', { LLM_TEAM_GUARD: fakeGuard })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'deny')
    assert.match(res.json?.reason || '', /不合法/)
  })

  test('f. 缺 CommandLine／CommandLine 空字串／Cwd 不存在／Cwd 相對路徑 ⇒ 各 deny 且 reason 指名哪一項', () => {
    // 缺 CommandLine
    const noCmd = makePayload(undefined, baseDir)
    const resNoCmd = runAdapter(noCmd, { LLM_TEAM_GUARD: fakeGuard })
    assert.equal(resNoCmd.json?.decision, 'deny')
    assert.match(resNoCmd.json?.reason || '', /不合法/)
    assert.match(resNoCmd.json?.reason || '', /CommandLine/)

    // CommandLine 空字串
    const emptyCmd = makePayload('', baseDir)
    const resEmptyCmd = runAdapter(emptyCmd, { LLM_TEAM_GUARD: fakeGuard })
    assert.equal(resEmptyCmd.json?.decision, 'deny')
    assert.match(resEmptyCmd.json?.reason || '', /不合法/)
    assert.match(resEmptyCmd.json?.reason || '', /CommandLine/)

    // Cwd 不存在
    const nonExistentCwd = makePayload('ls', path.join(baseDir, 'non-existent-sub-dir'))
    const resNonExistent = runAdapter(nonExistentCwd, { LLM_TEAM_GUARD: fakeGuard })
    assert.equal(resNonExistent.json?.decision, 'deny')
    assert.match(resNonExistent.json?.reason || '', /不合法/)
    assert.match(resNonExistent.json?.reason || '', /Cwd/)

    // Cwd 相對路徑
    const relCwd = makePayload('ls', 'relative/path')
    const resRelCwd = runAdapter(relCwd, { LLM_TEAM_GUARD: fakeGuard })
    assert.equal(resRelCwd.json?.decision, 'deny')
    assert.match(resRelCwd.json?.reason || '', /不合法/)
    assert.match(resRelCwd.json?.reason || '', /Cwd/)
  })

  test('g. LLM_TEAM_GUARD 指到不存在 ⇒ deny 含「找不到守門」', () => {
    const payload = makePayload('ls', baseDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: '/tmp/non-existent-guard-path.sh' })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'deny')
    assert.match(res.json?.reason || '', /找不到守門/)
  })

  test('h. round-trip：CommandLine 含引號、換行、反斜線、CJK ⇒ 假守門收到的 stdin JSON 解回來逐字相等', () => {
    const complexCmd = 'echo "hello\\nworld" \'single quote\' \\ backslash 繁體中文 測試 \t tab'
    const recordFile = path.join(tmpdir('rt-'), 'stdin.json')
    const payload = makePayload(complexCmd, baseDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: fakeGuard, FAKE_RECORD_FILE: recordFile })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'ask')
    assert.ok(fs.existsSync(recordFile), '假守門應記錄 stdin')
    const recorded = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    assert.equal(recorded?.tool_input?.command, complexCmd)
  })

  test('i. Cwd 是非 git 的 tmp 目錄 ⇒ 仍走守門、回 ask（且假守門看到的 CLAUDE_PROJECT_DIR 為空）', () => {
    const nonGitDir = tmpdir('non-git-')
    const envRecord = path.join(tmpdir('env-'), 'env.txt')
    const payload = makePayload('ls', nonGitDir)
    const res = runAdapter(payload, {
      LLM_TEAM_GUARD: fakeGuard,
      FAKE_ENV_RECORD: envRecord,
      CLAUDE_PROJECT_DIR: '/some/parent/project',
    })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'ask')
    assert.ok(fs.existsSync(envRecord), '假守門應記錄環境資訊')
    const lines = fs.readFileSync(envRecord, 'utf8').split('\n')
    assert.equal(lines[0], '', '非 git 目錄下 CLAUDE_PROJECT_DIR 應被 unset 為空')
    assert.equal(fs.realpathSync(lines[1]), fs.realpathSync(nonGitDir), 'process cwd 應為 nonGitDir')
  })

  test('j. Cwd 是 git repo 的子目錄 ⇒ 假守門看到 CLAUDE_PROJECT_DIR＝repo 根、且 process cwd＝該子目錄', () => {
    const repoDir = tmpdir('git-repo-')
    execFileSync('git', ['init', '-q', repoDir], { env: CLEAN_GIT_ENV })
    const subDir = path.join(repoDir, 'sub', 'nested')
    fs.mkdirSync(subDir, { recursive: true })
    const envRecord = path.join(tmpdir('env-'), 'env.txt')
    const payload = makePayload('ls', subDir)
    const res = runAdapter(payload, {
      LLM_TEAM_GUARD: fakeGuard,
      FAKE_ENV_RECORD: envRecord,
    })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'ask')
    assert.ok(fs.existsSync(envRecord), '假守門應記錄環境資訊')
    const lines = fs.readFileSync(envRecord, 'utf8').split('\n')
    assert.equal(fs.realpathSync(lines[0]), fs.realpathSync(repoDir), 'CLAUDE_PROJECT_DIR 應為 repo 根')
    assert.equal(fs.realpathSync(lines[1]), fs.realpathSync(subDir), 'process cwd 應為子目錄')
  })

  test('k. env 帶 GIT_DIR=/x ⇒ 假守門看不到 GIT_DIR', () => {
    const envRecord = path.join(tmpdir('env-'), 'env.txt')
    const payload = makePayload('ls', baseDir)
    const res = runAdapter(payload, {
      LLM_TEAM_GUARD: fakeGuard,
      FAKE_ENV_RECORD: envRecord,
      GIT_DIR: '/x/custom/git/dir',
    })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'ask')
    assert.ok(fs.existsSync(envRecord), '假守門應記錄環境資訊')
    const lines = fs.readFileSync(envRecord, 'utf8').split('\n')
    assert.equal(lines[2], '__UNSET__', 'GIT_DIR 應被 unset 剝除')
  })

  test('l. mktemp 失敗失效安全：env TMPDIR=/nonexistent/dir ⇒ deny 含「暫存目錄」', () => {
    const payload = makePayload('ls', baseDir)
    const res = runAdapter(payload, {
      LLM_TEAM_GUARD: fakeGuard,
      TMPDIR: '/nonexistent/dir',
    })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'deny')
    assert.match(res.json?.reason || '', /暫存目錄/)
  })
})

describe('shouldSkipGuardIntegration 判定測試', () => {
  test('{ CI: "true" }, null ⇒ true', () => {
    assert.equal(shouldSkipGuardIntegration({ CI: 'true' }, null), true)
  })

  test('{ CI: "1" }, null ⇒ true', () => {
    assert.equal(shouldSkipGuardIntegration({ CI: '1' }, null), true)
  })

  test('{}, null ⇒ false（不能 skip，要 fail）', () => {
    assert.equal(shouldSkipGuardIntegration({}, null), false)
  })

  test('{ CI: "false" }, null ⇒ false（不能 skip）', () => {
    assert.equal(shouldSkipGuardIntegration({ CI: 'false' }, null), false)
  })

  test('{ CI: "0" }, null ⇒ false（不能 skip）', () => {
    assert.equal(shouldSkipGuardIntegration({ CI: '0' }, null), false)
  })

  test('{ CI: "true" }, "/x" ⇒ false', () => {
    assert.equal(shouldSkipGuardIntegration({ CI: 'true' }, '/x'), false)
  })
})

describe('agy-pretooluse.sh 真守門整合測試', () => {
  const realGuard = resolveGuardPath(process.env, import.meta.url)
  const candidates = guardCandidates(process.env, import.meta.url)
  const skipMsg = `沒有任何守門副本（CI 這種沒 agy 的環境）：${candidates.join(', ')}`
  const shouldSkip = shouldSkipGuardIntegration(process.env, realGuard)

  if (!realGuard && !shouldSkip) {
    assert.fail(`這台不是 CI 卻沒有任何守門副本：${candidates.join(', ')}`)
  }

  const baseDir = tmpdir('real-guard-cwd-')

  test('真守門整合：rm -rf /tmp/x ⇒ deny 含 BLOCKED', { skip: shouldSkip ? skipMsg : false }, (t) => {
    if (!realGuard) {
      if (shouldSkip) {
        t.skip(skipMsg)
        return
      }
      assert.fail(`這台不是 CI 卻沒有任何守門副本：${candidates.join(', ')}`)
    }
    const payload = makePayload('rm -rf /tmp/x', baseDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: realGuard })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'deny')
    assert.match(res.json?.reason || '', /BLOCKED/)
  })

  test('真守門整合：git status ⇒ ask', { skip: shouldSkip ? skipMsg : false }, (t) => {
    if (!realGuard) {
      if (shouldSkip) {
        t.skip(skipMsg)
        return
      }
      assert.fail(`這台不是 CI 卻沒有任何守門副本：${candidates.join(', ')}`)
    }
    const payload = makePayload('git status', baseDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: realGuard })
    assert.equal(res.status, 0)
    assert.deepEqual(res.json, { decision: 'ask' })
  })

  test('真守門整合：子目錄未 commit 含 rm -rf 之 x.sh ⇒ deny（驗證 cd Cwd 讓相對路徑掃描有效）', { skip: shouldSkip ? skipMsg : false }, (t) => {
    if (!realGuard) {
      if (shouldSkip) {
        t.skip(skipMsg)
        return
      }
      assert.fail(`這台不是 CI 卻沒有任何守門副本：${candidates.join(', ')}`)
    }
    const repoDir = tmpdir('real-repo-')
    execFileSync('git', ['init', '-q', repoDir], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'test'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { env: CLEAN_GIT_ENV })
    fs.writeFileSync(path.join(repoDir, '.gitkeep'), '')
    execFileSync('git', ['-C', repoDir, 'add', '.gitkeep'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', repoDir, 'commit', '-qm', 'init'], { env: CLEAN_GIT_ENV })

    const subDir = path.join(repoDir, 'sub')
    fs.mkdirSync(subDir, { recursive: true })
    const scriptPath = path.join(subDir, 'x.sh')
    fs.writeFileSync(scriptPath, '#!/bin/sh\nrm -rf /\n')

    // CommandLine 用相對路徑 'bash x.sh'，Cwd 為 subDir
    const payload = makePayload('bash x.sh', subDir)
    const res = runAdapter(payload, { LLM_TEAM_GUARD: realGuard })
    assert.equal(res.status, 0)
    assert.equal(res.json?.decision, 'deny')
    assert.match(res.json?.reason || '', /BLOCKED/)
  })
})
