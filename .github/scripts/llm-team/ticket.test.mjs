/**
 * `.github/scripts/llm-team/`（`ticket.mjs`／`setup.mjs`）的測試。
 *
 * 🔴 測試原則：
 *   · 零網路、零外部呼叫：以 deps 注入 writeMain／councilMain／git／spawn。
 *   · 包含陽性對照：如複審者不簽不是錯誤碼（exit 0）、缺少 regex 時 fail-closed（exit 1）。
 *   · 資訊安全：斷言 token 等敏感字串絕不出現在輸出中。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CLEAN_GIT_ENV, buildSafeCommandRegex } from './lib.mjs'
import { main as ticketMain } from './ticket.mjs'
import { main as setupMain } from './setup.mjs'

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

const TEST_CONFIG = {
  schemaVersion: 1,
  models: {
    writer: 'gemini-3.8-flash-high',
    reviewers: ['claude-opus-4-6-thinking', 'gemini-3.1-pro-high'],
    codex: 'gpt-5.6-sol',
  },
  allowCommandHeads: ['npm test', 'bash .github/scripts/test-'],
  worktreeRoot: '.claude/worktrees',
  installCommand: '',
  maxRounds: 3,
  riskDomains: [],
  outDir: '.local/llm-team',
}

function makeRepo(configOverride = {}) {
  const dir = tmpdir('ticket-test-')
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n')
  const cfgDir = path.join(dir, '.github', 'scripts', 'llm-team')
  fs.mkdirSync(cfgDir, { recursive: true })
  const cfg = { ...TEST_CONFIG, ...configOverride }
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfg, null, 2))
  g('add', '-A')
  g('commit', '-qm', 'init')
  return { dir, g }
}

describe('ticket.mjs 票流程測試', () => {
  test('T1 run：注入 writeMain 回 0 且改檔、councilMain 回 0 且簽 ⇒ exit 0、summary 兩筆「簽」、changed 含改動檔', () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 新增功能票\n實作細節')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't1')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't1', 'review')

    const deps = {
      repoRoot: repo.dir,
      writeMain: (args) => {
        fs.writeFileSync(path.join(worktreePath, 'hello.txt'), 'hello world\n')
        return 0
      },
      councilMain: (args) => {
        fs.mkdirSync(reviewOutDir, { recursive: true })
        fs.writeFileSync(
          path.join(reviewOutDir, 'opus.txt'),
          'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認 hello.txt 內容'
        )
        fs.writeFileSync(
          path.join(reviewOutDir, 'gemini.txt'),
          'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認檔案編碼'
        )
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = ticketMain(
        [
          'run',
          '--name',
          't1',
          '--brief',
          briefFile,
          '--branch',
          'feat/t1--slice',
          '--allow',
          'hello.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `ticket run exit 應為 0，實際為 ${code}`)
    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 't1', 'summary.json')
    assert.ok(fs.existsSync(summaryFile), 'summary.json 應存在')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.ticket, 't1')
    assert.equal(summary.writeExit, 0)
    assert.equal(summary.verifyExit, 0)
    assert.deepEqual(summary.changed, ['hello.txt'])
    assert.equal(summary.review.members.length, 2)
    assert.equal(summary.review.members[0].overall, '簽')
    assert.equal(summary.review.members[1].overall, '簽')
    assert.equal(summary.review.anyEmpty, false)
  })

  test('T2 run：write 回 2 ⇒ exit 2、councilMain 沒被呼叫', () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 失敗票\n內容')

    let councilCalled = false
    const deps = {
      repoRoot: repo.dir,
      writeMain: () => 2,
      councilMain: () => {
        councilCalled = true
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = ticketMain(
        [
          'run',
          '--name',
          't2',
          '--brief',
          briefFile,
          '--branch',
          'feat/t2--slice',
          '--allow',
          'a.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `writeExit=2 時 ticket run 應回 2，實際得到 ${code}`)
    assert.equal(councilCalled, false, 'councilMain 不應被呼叫')
  })

  test('T3 run：某位複審者零輸出 ⇒ exit 3、摘要含「零輸出」', () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 零輸出票\n內容')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't3')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't3', 'review')

    const deps = {
      repoRoot: repo.dir,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'content')
        return 0
      },
      councilMain: () => {
        fs.mkdirSync(reviewOutDir, { recursive: true })
        fs.writeFileSync(path.join(reviewOutDir, 'opus.txt'), '') // 零輸出
        fs.writeFileSync(path.join(reviewOutDir, 'gemini.txt'), '整份：簽\nQ6：ok')
        return 3
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = ticketMain(
        [
          'run',
          '--name',
          't3',
          '--brief',
          briefFile,
          '--branch',
          'feat/t3--slice',
          '--allow',
          'b.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 3, `複審者零輸出時應回 3，實際為 ${code}`)
    const output = outs.join('\n')
    assert.match(output, /零輸出/, `摘要應包含「零輸出」，實際：${output}`)
  })

  test('T4 陽性對照：複審者回「整份：不簽」⇒ exit 0（不是錯誤碼）且摘要含「不簽」', () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 不簽票\n內容')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't4')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't4', 'review')

    const deps = {
      repoRoot: repo.dir,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'c.txt'), 'content')
        return 0
      },
      councilMain: () => {
        fs.mkdirSync(reviewOutDir, { recursive: true })
        fs.writeFileSync(
          path.join(reviewOutDir, 'opus.txt'),
          'Q1：不簽｜改動範圍過大｜需縮減\n整份：不簽\nQ6：統整者需確認 scope'
        )
        fs.writeFileSync(path.join(reviewOutDir, 'gemini.txt'), 'Q1：簽｜ok｜無\n整份：簽\nQ6：ok')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = ticketMain(
        [
          'run',
          '--name',
          't4',
          '--brief',
          briefFile,
          '--branch',
          'feat/t4--slice',
          '--allow',
          'c.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `「不簽」不是錯誤碼，exit 應為 0，實際為 ${code}`)
    const output = outs.join('\n')
    assert.match(output, /不簽/, `摘要應包含「不簽」，實際：${output}`)
  })

  test('T5 publish：注入假的 git／gh spawn，斷言沒有呼叫任何 merge 指令、commit 訊息＝--title、gh pr create 帶 --draft', () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't5')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'edited')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't5')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'brief.md'), '# Brief T5\n說明')
    const summary = {
      schemaVersion: 1,
      project: 'test-proj',
      ticket: 't5',
      branch: 'feat/t5--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: { tier: 'standard', members: [], anyEmpty: false },
      coordinatorTurns: null,
      startedAt: '2026-09-13T00:00:00Z',
      finishedAt: '2026-09-13T00:05:00Z',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const gitCalls = []
    const spawnCalls = []

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        return ''
      },
      spawn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts })
        if (cmd === 'gh' && args[0] === '--version') return { status: 0, stdout: 'gh 2.50.0' }
        if (cmd === 'gh' && args[0] === 'pr') return { status: 0, stdout: 'https://github.com/org/repo/pull/123' }
        return { status: 0, stdout: '' }
      },
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = ticketMain(['publish', '--name', 't5', '--title', 'feat: custom title'], deps)
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `publish exit 應為 0，實際為 ${code}`)

    // 斷言沒有任何呼叫包含 merge
    for (const call of gitCalls) {
      assert.ok(
        !call.args.some((a) => a.includes('merge')),
        `git 呼叫不應包含 merge：${call.args.join(' ')}`
      )
    }
    for (const call of spawnCalls) {
      assert.ok(
        !call.args.some((a) => a.includes('merge')),
        `spawn 呼叫不應包含 merge：${call.args.join(' ')}`
      )
    }

    // 斷言 commit 訊息等於 --title
    const commitCall = gitCalls.find((c) => c.args[0] === 'commit')
    assert.ok(commitCall, '應有 git commit 呼叫')
    assert.deepEqual(commitCall.args, ['commit', '-m', 'feat: custom title'])

    // 斷言 gh pr create 帶 --draft
    const prCall = spawnCalls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create')
    assert.ok(prCall, '應有 gh pr create 呼叫')
    assert.ok(prCall.args.includes('--draft'), 'gh pr create 應帶 --draft 旗標')
    assert.ok(prCall.args.includes('--title'), 'gh pr create 應帶 --title')
    const titleIdx = prCall.args.indexOf('--title')
    assert.equal(prCall.args[titleIdx + 1], 'feat: custom title')
  })
})

describe('setup.mjs 設定對帳測試', () => {
  test('T6 setup --check：缺 regex 假設定 ⇒ exit 1、stdout 含 command(regex:；全對 ⇒ exit 0；不存在 ⇒ exit 2；且 token 永不洩漏', () => {
    const repo = makeRepo()
    const regex = buildSafeCommandRegex(TEST_CONFIG)
    const goodAllow = `command(regex:${regex})`
    const rootSlash = repo.dir.endsWith('/') ? repo.dir : repo.dir + '/'

    const tmpSettingsDir = tmpdir('setup-settings-')
    const badSettingsFile = path.join(tmpSettingsDir, 'bad-settings.json')
    fs.writeFileSync(
      badSettingsFile,
      JSON.stringify(
        {
          token: 'SHOULD-NOT-PRINT',
          permissions: {
            allow: ['read_file(' + rootSlash + ')'],
          },
          trustedWorkspaces: [repo.dir],
        },
        null,
        2
      )
    )

    const goodSettingsFile = path.join(tmpSettingsDir, 'good-settings.json')
    fs.writeFileSync(
      goodSettingsFile,
      JSON.stringify(
        {
          token: 'SHOULD-NOT-PRINT',
          permissions: {
            allow: [goodAllow, 'read_file(' + rootSlash + ')'],
          },
          trustedWorkspaces: [repo.dir],
        },
        null,
        2
      )
    )

    // 1. 缺 regex ⇒ exit 1
    const badOuts = []
    const badErrs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => badOuts.push(String(m))
    console.error = (m) => badErrs.push(String(m))
    let badCode
    try {
      badCode = setupMain(['--check'], {
        repoRoot: repo.dir,
        settingsFile: badSettingsFile,
        env: { AGY_SETTINGS: badSettingsFile },
      })
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(badCode, 1, `缺 regex 時 exit 應為 1，實際為 ${badCode}`)
    const badOutText = badOuts.join('\n')
    const badErrText = badErrs.join('\n')
    assert.match(badOutText, /command\(regex:/, `stdout 應包含 command(regex:，實際：${badOutText}`)
    assert.ok(!badOutText.includes('SHOULD-NOT-PRINT'), 'stdout 絕對不應包含 token')
    assert.ok(!badErrText.includes('SHOULD-NOT-PRINT'), 'stderr 絕對不應包含 token')

    // 2. 全對 ⇒ exit 0
    const goodOuts = []
    const goodErrs = []
    console.log = (m) => goodOuts.push(String(m))
    console.error = (m) => goodErrs.push(String(m))
    let goodCode
    try {
      goodCode = setupMain(['--check'], {
        repoRoot: repo.dir,
        settingsFile: goodSettingsFile,
        env: { AGY_SETTINGS: goodSettingsFile },
      })
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(goodCode, 0, `全對時 exit 應為 0，實際為 ${goodCode}`)
    const goodOutText = goodOuts.join('\n')
    const goodErrText = goodErrs.join('\n')
    assert.ok(!goodOutText.includes('SHOULD-NOT-PRINT'), 'stdout 絕對不應包含 token')
    assert.ok(!goodErrText.includes('SHOULD-NOT-PRINT'), 'stderr 絕對不應包含 token')

    // 3. 不存在 ⇒ exit 2
    const nonExistentFile = path.join(tmpSettingsDir, 'not-found.json')
    let missingCode
    try {
      missingCode = setupMain(['--check'], {
        repoRoot: repo.dir,
        settingsFile: nonExistentFile,
        env: { AGY_SETTINGS: nonExistentFile },
      })
    } finally {
      // noop
    }
    assert.equal(missingCode, 2, `設定檔不存在時 exit 應為 2，實際為 ${missingCode}`)
  })
})
