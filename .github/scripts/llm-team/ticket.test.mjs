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
import { main as setupMain, SYNC_FILES } from './setup.mjs'

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

  test('T7 publish 誘餌：worktree 有未追蹤檔 decoy.txt（不在 summary.changed）⇒ publish 回 2、注入的 git 沒收到 commit／push、stderr 含 decoy.txt', () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't7')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'edited')
    fs.writeFileSync(path.join(worktreePath, 'decoy.txt'), 'decoy')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't7')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 1,
      project: 'test-proj',
      ticket: 't7',
      branch: 'feat/t7--slice',
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
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt', 'decoy.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        return ''
      },
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = ticketMain(['publish', '--name', 't7'], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `有未追蹤誘餌時 publish 應回 2，實際得到 ${code}`)
    assert.ok(
      !gitCalls.some((c) => c.args[0] === 'commit'),
      'git 呼叫不應包含 commit'
    )
    assert.ok(
      !gitCalls.some((c) => c.args[0] === 'push'),
      'git 呼叫不應包含 push'
    )
    const errOutput = errs.join('\n')
    assert.match(errOutput, /decoy\.txt/, `stderr 應包含 decoy.txt，實際：${errOutput}`)
  })

  test('T8 陽性對照：沒有誘餌 ⇒ publish 回 0，且注入的 git 收到的 add 引數逐字等於 summary.changed（不含 -A）', () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't8')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'content1')
    fs.writeFileSync(path.join(worktreePath, 'file2.txt'), 'content2')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't8')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 1,
      project: 'test-proj',
      ticket: 't8',
      branch: 'feat/t8--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file1.txt', 'file2.txt'],
      verifyExit: 0,
      review: { tier: 'standard', members: [], anyEmpty: false },
      coordinatorTurns: null,
      startedAt: '2026-09-13T00:00:00Z',
      finishedAt: '2026-09-13T00:05:00Z',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const gitCalls = []
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file1.txt', 'file2.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        return ''
      },
      spawn: (cmd, args) => {
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
      code = ticketMain(['publish', '--name', 't8'], deps)
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `publish exit 應為 0，實際為 ${code}`)
    const addCall = gitCalls.find((c) => c.args[0] === 'add')
    assert.ok(addCall, '應有 git add 呼叫')
    assert.ok(!addCall.args.includes('-A'), 'git add 不應包含 -A')
    assert.deepEqual(addCall.args.slice(2), summary.changed, 'add 傳入的檔案清單應逐字等於 summary.changed')
    assert.deepEqual(addCall.args, ['add', '--', ...summary.changed], 'add 引數應為 [add, --, ...summary.changed]')
  })

  test('T9 非法 --tier：--tier blcok ⇒ run 回 2、writeMain 沒被呼叫', () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試票\n內容')

    let writeCalled = false
    const deps = {
      repoRoot: repo.dir,
      writeMain: () => {
        writeCalled = true
        return 0
      },
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
          't9',
          '--brief',
          briefFile,
          '--branch',
          'feat/t9--slice',
          '--allow',
          'a.txt',
          '--test',
          'true',
          '--tier',
          'blcok',
        ],
        deps
      )
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `非法 --tier 時 run 應回 2，實際得到 ${code}`)
    assert.equal(writeCalled, false, 'writeMain 不應被呼叫')
    const errOutput = errs.join('\n')
    assert.match(errOutput, /用法：run/, `stderr 應包含用法，實際：${errOutput}`)
  })

  test('T10 run 清舊複審：<outDir>/review/opus.txt 預先放「整份：不簽」殘留、councilMain 這輪產「整份：簽」⇒ summary 是「簽」（證明清過）', () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 清舊複審票\n內容')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't10')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't10', 'review')

    // 預先在 <outDir>/review/ 放殘留的 opus.txt（不簽）
    fs.mkdirSync(reviewOutDir, { recursive: true })
    const opusPath = path.join(reviewOutDir, 'opus.txt')
    fs.writeFileSync(opusPath, 'Q1：不簽｜殘留舊資料｜需修正\n整份：不簽\nQ6：舊殘留')

    let existsBeforeCouncilMain = null

    const deps = {
      repoRoot: repo.dir,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'ok')
        return 0
      },
      councilMain: () => {
        existsBeforeCouncilMain = fs.existsSync(opusPath)
        fs.mkdirSync(reviewOutDir, { recursive: true })
        fs.writeFileSync(opusPath, 'Q1：簽｜ok｜無\n整份：簽\nQ6：ok')
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
          't10',
          '--brief',
          briefFile,
          '--branch',
          'feat/t10--slice',
          '--allow',
          'file.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `run exit 應為 0，實際為 ${code}`)
    assert.equal(existsBeforeCouncilMain, false, '呼叫 council 前舊的 opus.txt 應已被清空')
    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 't10', 'summary.json')
    assert.ok(fs.existsSync(summaryFile), 'summary.json 應存在')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    const opus = summary.review.members.find((m) => m.name === 'opus')
    assert.ok(opus, 'summary 應包含 opus')
    assert.equal(opus.overall, '簽', 'opus overall 應為「簽」，證明舊的「不簽」殘留已被清除')
  })

  test('T11 riskDomains 升級：config riskDomains: [金流]、brief 含「金流」、--tier standard ⇒ councilMain 收到 --tier block、summary.tierEscalatedBy 是 [金流]；riskDomains: [] ⇒ 仍是 standard', () => {
    // 1. riskDomains: ['金流'] ⇒ 升級 block
    const repo1 = makeRepo({ riskDomains: ['金流'] })
    const briefFile1 = path.join(tmpdir('brief1-'), 'brief.md')
    fs.writeFileSync(briefFile1, '# 涉及金流模組之修改\n包含金流交易處理')

    const worktreePath1 = path.join(repo1.dir, '.claude', 'worktrees', 't11-escalate')
    const reviewOutDir1 = path.join(repo1.dir, '.local', 'llm-team', 't11-escalate', 'review')

    let receivedCouncilArgs1 = null
    const deps1 = {
      repoRoot: repo1.dir,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath1, 'pay.txt'), 'pay')
        return 0
      },
      councilMain: (args) => {
        receivedCouncilArgs1 = args
        fs.mkdirSync(reviewOutDir1, { recursive: true })
        fs.writeFileSync(path.join(reviewOutDir1, 'opus.txt'), '整份：簽\n')
        fs.writeFileSync(path.join(reviewOutDir1, 'gemini.txt'), '整份：簽\n')
        fs.writeFileSync(path.join(reviewOutDir1, 'codex.txt'), '整份：簽\n')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs1 = []
    const origLog = console.log
    console.log = (m) => outs1.push(String(m))
    let code1
    try {
      code1 = ticketMain(
        [
          'run',
          '--name',
          't11-escalate',
          '--brief',
          briefFile1,
          '--branch',
          'feat/t11--slice',
          '--allow',
          'pay.txt',
          '--test',
          'true',
          '--tier',
          'standard',
        ],
        deps1
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code1, 0, `run exit 應為 0，實際為 ${code1}`)
    const tierIdx1 = receivedCouncilArgs1.indexOf('--tier')
    assert.notEqual(tierIdx1, -1, 'councilMain 參數應包含 --tier')
    assert.equal(receivedCouncilArgs1[tierIdx1 + 1], 'block', 'councilMain 應收到 --tier block')

    const summaryFile1 = path.join(repo1.dir, '.local', 'llm-team', 't11-escalate', 'summary.json')
    const summary1 = JSON.parse(fs.readFileSync(summaryFile1, 'utf8'))
    assert.deepEqual(summary1.tierEscalatedBy, ['金流'], 'summary.tierEscalatedBy 應為 [金流]')
    assert.equal(summary1.review.tier, 'block', 'summary.review.tier 應為 block')

    // 2. riskDomains: [] ⇒ 仍為 standard
    const repo2 = makeRepo({ riskDomains: [] })
    const briefFile2 = path.join(tmpdir('brief2-'), 'brief.md')
    fs.writeFileSync(briefFile2, '# 涉及金流模組之修改\n包含金流交易處理')

    const worktreePath2 = path.join(repo2.dir, '.claude', 'worktrees', 't11-standard')
    const reviewOutDir2 = path.join(repo2.dir, '.local', 'llm-team', 't11-standard', 'review')

    let receivedCouncilArgs2 = null
    const deps2 = {
      repoRoot: repo2.dir,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath2, 'pay.txt'), 'pay')
        return 0
      },
      councilMain: (args) => {
        receivedCouncilArgs2 = args
        fs.mkdirSync(reviewOutDir2, { recursive: true })
        fs.writeFileSync(path.join(reviewOutDir2, 'opus.txt'), '整份：簽\n')
        fs.writeFileSync(path.join(reviewOutDir2, 'gemini.txt'), '整份：簽\n')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs2 = []
    console.log = (m) => outs2.push(String(m))
    let code2
    try {
      code2 = ticketMain(
        [
          'run',
          '--name',
          't11-standard',
          '--brief',
          briefFile2,
          '--branch',
          'feat/t11-std--slice',
          '--allow',
          'pay.txt',
          '--test',
          'true',
          '--tier',
          'standard',
        ],
        deps2
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code2, 0, `run exit 應為 0，實際為 ${code2}`)
    const tierIdx2 = receivedCouncilArgs2.indexOf('--tier')
    assert.notEqual(tierIdx2, -1, 'councilMain 參數應包含 --tier')
    assert.equal(receivedCouncilArgs2[tierIdx2 + 1], 'standard', 'councilMain 應收到 --tier standard')

    const summaryFile2 = path.join(repo2.dir, '.local', 'llm-team', 't11-standard', 'summary.json')
    const summary2 = JSON.parse(fs.readFileSync(summaryFile2, 'utf8'))
    assert.equal(summary2.tierEscalatedBy, undefined, 'riskDomains: [] 時不應有 tierEscalatedBy')
    assert.equal(summary2.review.tier, 'standard', 'summary.review.tier 應維持 standard')
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

  test('T12 setup --check：透過 AGY_SETTINGS 環境變數指到 tmp 假檔（缺 regex）⇒ exit 1、stdout 含 command(regex:；且 token 永不洩漏', () => {
    const repo = makeRepo()
    const tmpSettingsDir = tmpdir('setup-settings-env-')
    const badSettingsFile = path.join(tmpSettingsDir, 'bad-settings.json')
    const rootSlash = repo.dir.endsWith('/') ? repo.dir : repo.dir + '/'
    fs.writeFileSync(
      badSettingsFile,
      JSON.stringify(
        {
          token: 'SHOULD-NOT-PRINT-T12',
          permissions: {
            allow: ['read_file(' + rootSlash + ')'],
          },
          trustedWorkspaces: [repo.dir],
        },
        null,
        2
      )
    )

    // 透過 deps.env 傳入 AGY_SETTINGS（不傳 settingsFile）
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
        env: { ...process.env, AGY_SETTINGS: badSettingsFile },
      })
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(badCode, 1, `透過 AGY_SETTINGS 缺 regex 時 exit 應為 1，實際為 ${badCode}`)
    const badOutText = badOuts.join('\n')
    const badErrText = badErrs.join('\n')
    assert.match(badOutText, /command\(regex:/, `stdout 應包含 command(regex:，實際：${badOutText}`)
    assert.ok(!badOutText.includes('SHOULD-NOT-PRINT-T12'), 'stdout 絕對不應包含 token')
    assert.ok(!badErrText.includes('SHOULD-NOT-PRINT-T12'), 'stderr 絕對不應包含 token')
  })

  function populateTree(baseDir, files = {}) {
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(baseDir, relPath)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
  }

  function makeDefaultSyncTree() {
    const files = {}
    for (const f of SYNC_FILES) {
      files[f] = f.endsWith('VERSION') ? '1\n' : `export default "${f}"\n`
    }
    return files
  }

  function makeSyncPair() {
    const dirA = tmpdir('sync-a-')
    const dirS = tmpdir('sync-s-')
    const defaultFiles = makeDefaultSyncTree()
    populateTree(dirA, defaultFiles)
    populateTree(dirS, defaultFiles)
    return { dirA, dirS, defaultFiles }
  }

  function snapshotDir(dir) {
    const files = new Map()
    function walk(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile()) {
          const rel = path.relative(dir, full)
          files.set(rel, fs.readFileSync(full))
        }
      }
    }
    walk(dir)
    return files
  }

  test('T13 setup --sync-check：母體每個相對路徑兩邊相同、各有 VERSION 1 ⇒ exit 0、stdout 含「漂移 0 檔」、不含「≠」', () => {
    const { dirA, dirS } = makeSyncPair()

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = setupMain(['--sync-check', dirS], { repoRoot: dirA })
    } finally {
      console.log = origLog
    }

    const outText = outs.join('\n')
    assert.equal(code, 0, `兩邊完全一致時 exit 應為 0，實際為 ${code}`)
    assert.ok(outText.includes('漂移 0 檔'), `stdout 應包含「漂移 0 檔」，實際：\n${outText}`)
    assert.ok(!outText.includes('≠'), `stdout 不應包含「≠」，實際：\n${outText}`)
  })

  test('T14 setup --sync-check 陽性對照：A 的 lib.mjs 多一字元 ⇒ exit 1、stdout 含 ≠ lib.mjs；只改 A 的 config.json ⇒ exit 0', () => {
    // 1. A 的 lib.mjs 多一個字元 ⇒ exit 1、stdout 含 ≠ .github/scripts/llm-team/lib.mjs
    const { dirA: dirA1, dirS: dirS1 } = makeSyncPair()
    const libPathA = path.join(dirA1, '.github/scripts/llm-team/lib.mjs')
    fs.appendFileSync(libPathA, '!')

    const outs1 = []
    const origLog = console.log
    console.log = (m) => outs1.push(String(m))
    let code1
    try {
      code1 = setupMain(['--sync-check', dirS1], { repoRoot: dirA1 })
    } finally {
      console.log = origLog
    }

    const outText1 = outs1.join('\n')
    assert.equal(code1, 1, `母體檔案有漂移時 exit 應為 1，實際為 ${code1}`)
    assert.ok(
      outText1.includes('≠ .github/scripts/llm-team/lib.mjs'),
      `stdout 應包含「≠ .github/scripts/llm-team/lib.mjs」，實際：\n${outText1}`
    )
    assert.ok(outText1.includes('漂移 1 檔'), `stdout 應包含「漂移 1 檔」，實際：\n${outText1}`)

    // 2. 另一組只改 A 的 .github/scripts/llm-team/config.json ⇒ exit 0（config 不在母體）
    const { dirA: dirA2, dirS: dirS2 } = makeSyncPair()
    const configPathA = path.join(dirA2, '.github/scripts/llm-team/config.json')
    fs.writeFileSync(configPathA, JSON.stringify({ customSettings: true }, null, 2))

    const outs2 = []
    console.log = (m) => outs2.push(String(m))
    let code2
    try {
      code2 = setupMain(['--sync-check', dirS2], { repoRoot: dirA2 })
    } finally {
      console.log = origLog
    }

    const outText2 = outs2.join('\n')
    assert.equal(code2, 0, `只改 config.json 時 exit 應為 0，實際為 ${code2}`)
    assert.ok(outText2.includes('漂移 0 檔'), `stdout 應包含「漂移 0 檔」，實際：\n${outText2}`)
    assert.ok(!outText2.includes('config.json'), `stdout 不應包含 config.json，實際：\n${outText2}`)
    assert.ok(!outText2.includes('≠'), `stdout 不應包含「≠」，實際：\n${outText2}`)
  })

  test('T15 setup --sync-check：S 沒有 VERSION ⇒ exit 2；A 少一個母體檔 ⇒ exit 1 且 stdout 含「− 」', () => {
    // 1. S 沒有 VERSION ⇒ exit 2
    const { dirA: dirA1, dirS: dirS1 } = makeSyncPair()
    const versionPathS = path.join(dirS1, '.github/scripts/llm-team/VERSION')
    fs.unlinkSync(versionPathS)

    const errs1 = []
    const origErr = console.error
    console.error = (m) => errs1.push(String(m))
    let code1
    try {
      code1 = setupMain(['--sync-check', dirS1], { repoRoot: dirA1 })
    } finally {
      console.error = origErr
    }

    assert.equal(code1, 2, `S 沒有 VERSION 時 exit 應為 2，實際為 ${code1}`)
    const errText1 = errs1.join('\n')
    assert.ok(
      errText1.includes('VERSION'),
      `stderr 應提到缺少 VERSION，實際：\n${errText1}`
    )

    // 2. A 少一個母體檔 ⇒ exit 1 且 stdout 含「− 」
    const { dirA: dirA2, dirS: dirS2 } = makeSyncPair()
    const missingFileA = path.join(dirA2, '.github/scripts/llm-team/lib.mjs')
    fs.unlinkSync(missingFileA)

    const outs2 = []
    const origLog = console.log
    console.log = (m) => outs2.push(String(m))
    let code2
    try {
      code2 = setupMain(['--sync-check', dirS2], { repoRoot: dirA2 })
    } finally {
      console.log = origLog
    }

    const outText2 = outs2.join('\n')
    assert.equal(code2, 1, `A 少母體檔時 exit 應為 1，實際為 ${code2}`)
    assert.ok(outText2.includes('− '), `stdout 應包含「− 」，實際：\n${outText2}`)
    assert.ok(
      outText2.includes('− .github/scripts/llm-team/lib.mjs'),
      `stdout 應包含「− .github/scripts/llm-team/lib.mjs」，實際：\n${outText2}`
    )
  })

  test('T16 setup --sync-check：跑完 T14 情境後，A 裡每個檔的內容與跑前逐字相同（只報告不寫檔）', () => {
    const { dirA, dirS } = makeSyncPair()
    // 建立 T14 中的情境：A 的 lib.mjs 漂移，且 A 有額外 config.json
    fs.appendFileSync(path.join(dirA, '.github/scripts/llm-team/lib.mjs'), '// drifted extra text')
    fs.writeFileSync(
      path.join(dirA, '.github/scripts/llm-team/config.json'),
      JSON.stringify({ custom: 'preserved' }, null, 2)
    )

    const beforeSnapshot = snapshotDir(dirA)
    assert.ok(beforeSnapshot.size > 0, '跑前 A 應有檔案')

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let code
    try {
      code = setupMain(['--sync-check', dirS], { repoRoot: dirA })
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 1, `有漂移時 exit code 應為 1，實際為 ${code}`)

    const afterSnapshot = snapshotDir(dirA)
    assert.equal(
      afterSnapshot.size,
      beforeSnapshot.size,
      `跑後檔案數量應與跑前一致（前：${beforeSnapshot.size}，後：${afterSnapshot.size}）`
    )

    for (const [relPath, beforeBuf] of beforeSnapshot.entries()) {
      const afterBuf = afterSnapshot.get(relPath)
      assert.ok(afterBuf !== undefined, `檔案 ${relPath} 跑後應存在`)
      assert.ok(
        beforeBuf.equals(afterBuf),
        `檔案 ${relPath} 跑後內容應與跑前逐字相同，實際發現被修改`
      )
    }
  })
})

