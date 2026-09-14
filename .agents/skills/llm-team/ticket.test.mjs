/**
 * `.agents/skills/llm-team/`（`ticket.mjs`／`setup.mjs`）的測試。
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
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { CLEAN_GIT_ENV, buildSafeCommandRegex } from './lib.mjs'
import { main as ticketMain, runCli } from './ticket.mjs'
import { main as setupMain } from './setup.mjs'
import { parseVerdicts } from './council.mjs'
import { EXPORT_FILES } from './export.mjs'

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ─────────────────── schema v2 測試 fixture（與 llm-team.test.mjs 的 v2Config 同形；測試檔不能互相 import） ───────────────────
// 統整者預設走 env LLM_TEAM_COORDINATOR=claude（等同 `--coordinator claude`）；要驗「缺 --coordinator」的測試自己給 deps.env = {}。
const M = {
  agyOpus: { harness: 'agy', model: 'claude-opus-4-6-thinking', quotaBucket: 'agy-claude' },
  agyGemini: { harness: 'agy', model: 'gemini-3.1-pro-high', quotaBucket: 'gemini' },
  codexSol: { harness: 'codex', model: 'gpt-5.6-sol', quotaBucket: 'openai' },
  claudeCode: { harness: 'claude', model: 'claude-code', quotaBucket: 'anthropic' },
}

function v2Profiles(override = {}) {
  return {
    claude: {
      coordinator: M.claudeCode,
      reviewers: [M.agyOpus, M.agyGemini],
      blockReviewers: [M.agyOpus, M.agyGemini, M.codexSol],
      adjudicator: M.codexSol,
      blockAdjudicator: 'human',
      ...(override.claude || {}),
    },
    agy: {
      coordinator: M.agyGemini,
      reviewers: [M.codexSol],
      blockReviewers: [M.codexSol],
      adjudicator: 'human',
      blockAdjudicator: 'human',
      ...(override.agy || {}),
    },
    codex: {
      coordinator: { ...M.codexSol, effort: 'medium' },
      reviewers: [M.agyGemini],
      blockReviewers: [M.agyGemini],
      adjudicator: 'human',
      blockAdjudicator: 'human',
      ...(override.codex || {}),
    },
  }
}

function v2Config(override = {}) {
  return {
    schemaVersion: 2,
    branchPrefixes: [],
    writer: { harness: 'agy', model: 'gemini-3.8-flash-high', quotaBucket: 'gemini' },
    profiles: v2Profiles(),
    allowCommandHeads: ['npm test', 'bash .github/scripts/test-'],
    worktreeRoot: '.claude/worktrees',
    installCommand: '',
    maxRounds: 3,
    riskDomains: [],
    outDir: '.local/llm-team',
    ...override,
  }
}

const TEST_CONFIG = v2Config()
process.env.LLM_TEAM_COORDINATOR = process.env.LLM_TEAM_COORDINATOR || 'claude'

/** summary.json fixture 的一般票名單（與 v2Config claude profile 的 reviewers 同）。 */
const ROSTER_STANDARD = [
  { name: 'agy/opus', ...M.agyOpus },
  { name: 'agy/gemini', ...M.agyGemini },
]

// ─────────────────── 假 council 輸出（2026-09-14 Q5：ticket 只認 review/members.json 的實際名單） ───────────────────
/** 輸出檔名 ⇒ 成員身分三元組。 */
const MEMBER_BY_FILE = {
  'agy-opus': { name: 'agy/opus', ...M.agyOpus },
  'agy-gemini': { name: 'agy/gemini', ...M.agyGemini },
  'codex-gpt-5-6-sol': { name: 'codex/gpt-5-6-sol', ...M.codexSol },
}
const MEMBER_BY_NAME = Object.fromEntries(Object.values(MEMBER_BY_FILE).map((m) => [m.name, m]))

/**
 * 假 council 的輸出：寫 <file>.txt 與 members.json（模擬 council.mjs review 寫的實際名單＋結果）。
 * files：{ 'agy-opus': '整份：簽\n', … }；members 預設＝files 每一個（身分查 MEMBER_BY_FILE）；opts.members 可整份覆寫（測名單漂移）。
 */
function fakeCouncilOut(reviewOutDir, files, opts = {}) {
  fs.mkdirSync(reviewOutDir, { recursive: true })
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(reviewOutDir, `${file}.txt`), text)
  const members =
    opts.members ||
    Object.keys(files).map((file) => {
      const m = MEMBER_BY_FILE[file]
      if (!m) throw new Error(`fakeCouncilOut：未知成員檔名 ${file}`)
      const text = files[file]
      const v = parseVerdicts(text)
      return { ...m, overall: v.overall, q: v.q, empty: !text.trim(), timedOut: false, invalid: Boolean(text.trim()) && v.overall === null, exit: 0, signal: null, ms: 1 }
    })
  fs.writeFileSync(path.join(reviewOutDir, 'members.json'), JSON.stringify(members, null, 2))
  return members
}

/** publish fixture：summary.review.members（補上三元組）＋ review/members.json 寫同一份。members：[{ name, overall, q? }]。 */
function reviewFixture(outDir, members) {
  const rows = members.map((m) => ({ ...(MEMBER_BY_NAME[m.name] || {}), ...m }))
  const reviewDir = path.join(outDir, 'review')
  fs.mkdirSync(reviewDir, { recursive: true })
  fs.writeFileSync(path.join(reviewDir, 'members.json'), JSON.stringify(rows, null, 2))
  return rows
}

function makeRepo(configOverride = {}) {
  const dir = tmpdir('ticket-test-')
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n')
  const cfg = { ...TEST_CONFIG, ...configOverride }
  fs.writeFileSync(path.join(dir, 'llm-team.config.json'), JSON.stringify(cfg, null, 2))
  g('add', '-A')
  g('commit', '-qm', 'init')
  return { dir, g }
}

describe('ticket.mjs 票流程測試', () => {
  test('T1 run：注入 writeMain 回 0 且改檔、councilMain 回 0 且簽 ⇒ exit 0、summary 兩筆「簽」、changed 含改動檔', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 新增功能票\n實作細節')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't1')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't1', 'review')

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: (args) => {
        fs.writeFileSync(path.join(worktreePath, 'hello.txt'), 'hello world\n')
        return 0
      },
      councilMain: (args) => {
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': 'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認 hello.txt 內容',
          'agy-gemini': 'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認檔案編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
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

  test('T2 run：write 回 2 ⇒ exit 2、councilMain 沒被呼叫', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 失敗票\n內容')

    let councilCalled = false
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
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
      code = await ticketMain(
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

  test('Q2 writeMain 回 2 ⇒ summary.json 存在且 review null、writeExit 2、writeTimedOut false、councilMain 與 runTest 沒被呼叫、收貨摘要有印、空 worktree 仍被清掉、run 回 2（陽性對照：exit 2 提早 return 就沒有 summary.json）', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# Q2 票\n內容')

    let councilCalled = false
    let testCalled = false
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => 2,
      councilMain: () => {
        councilCalled = true
        return 0
      },
      runTest: () => {
        testCalled = true
        return { exit: 0, out: 'ok' }
      },
    }

    const outs = []
    const errs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => outs.push(String(m))
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(
        ['run', '--name', 'q2', '--brief', briefFile, '--branch', 'feat/q2', '--allow', 'a.txt', '--test', 'true'],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 2, `writeExit=2 時 run 應回 2，實際 ${code}`)
    assert.equal(councilCalled, false, 'councilMain 不應被呼叫')
    assert.equal(testCalled, false, 'runTest 不應被呼叫')
    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 'q2', 'summary.json')
    assert.ok(fs.existsSync(summaryFile), 'exit 2 也要有 summary.json（收貨稽核紀錄）')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.schemaVersion, 2)
    assert.equal(summary.writeExit, 2)
    assert.equal(summary.writeTimedOut, false)
    assert.equal(summary.review, null)
    assert.equal(summary.verifyExit, null)
    assert.deepEqual(summary.changed, [])
    assert.equal(summary.coordinator, 'claude')
    // 收貨摘要照印
    const out = outs.join('\n')
    assert.match(out, /=== 收貨摘要：q2/)
    assert.match(out, /write exit: 2/)
    assert.match(out, /🔴 未複審（write 非 0/)
    // 本次新建且沒改檔 ⇒ 空 worktree 與分支照舊清掉
    assert.ok(!fs.existsSync(path.join(repo.dir, '.claude', 'worktrees', 'q2')), '空 worktree 應被清掉')
    assert.match(errs.join('\n'), /🧹 已清掉本次建立的 worktree 與分支 q2/)
    const branches = repo.g('branch', '--list', 'feat/q2').trim()
    assert.equal(branches, '', '分支應被刪掉')
    // lifecycle 只有 run-start、writer-done
    const lines = fs.readFileSync(path.join(repo.dir, '.local', 'llm-team', 'q2', 'lifecycle.ndjson'), 'utf8').trim().split('\n')
    assert.deepEqual(lines.map((l) => JSON.parse(l).event), ['run-start', 'writer-done'])
    assert.equal(JSON.parse(lines[1]).writeExit, 2)
  })

  test('T3 run：某位複審者零輸出 ⇒ exit 3、摘要含「零輸出」', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 零輸出票\n內容')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't3')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't3', 'review')

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'b.txt'), 'content')
        return 0
      },
      councilMain: () => {
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '' /* 零輸出 */, 'agy-gemini': '整份：簽\nQ6：ok' })
        return 3
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
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

  test('T4 陽性對照：複審者回「整份：不簽」⇒ exit 0（不是錯誤碼）且摘要含「不簽」', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 不簽票\n內容')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't4')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't4', 'review')

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'c.txt'), 'content')
        return 0
      },
      councilMain: () => {
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': 'Q1：不簽｜改動範圍過大｜需縮減\n整份：不簽\nQ6：統整者需確認 scope',
          'agy-gemini': 'Q1：簽｜ok｜無\n整份：簽\nQ6：ok',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
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

  test('T5 publish：注入假的 git／gh spawn，斷言沒有呼叫任何 merge 指令、commit 訊息＝--title、gh pr create 帶 --draft', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't5')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'edited')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't5')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'brief.md'), '# Brief T5\n說明')
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't5',
      branch: 'feat/t5--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
      },
      q6Receipt: 'verified',
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
      code = await ticketMain(['publish', '--name', 't5', '--title', 'feat: custom title'], deps)
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

  test('T7 publish 誘餌：worktree 有未追蹤檔 decoy.txt（不在 summary.changed）⇒ publish 回 2、注入的 git 沒收到 commit／push、stderr 含 decoy.txt', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't7')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'edited')
    fs.writeFileSync(path.join(worktreePath, 'decoy.txt'), 'decoy')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't7')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't7',
      branch: 'feat/t7--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
      },
      q6Receipt: 'verified',
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
      code = await ticketMain(['publish', '--name', 't7'], deps)
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

  test('T8 陽性對照：沒有誘餌 ⇒ publish 回 0，且注入的 git 收到的 add 引數逐字等於 summary.changed（不含 -A）', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't8')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'content1')
    fs.writeFileSync(path.join(worktreePath, 'file2.txt'), 'content2')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't8')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't8',
      branch: 'feat/t8--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file1.txt', 'file2.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
      },
      q6Receipt: 'verified',
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
      code = await ticketMain(['publish', '--name', 't8'], deps)
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

  test('T9 非法 --tier：--tier blcok ⇒ run 回 2、writeMain 沒被呼叫', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試票\n內容')

    let writeCalled = false
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
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
      code = await ticketMain(
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

  test('T10 run 清舊複審：<outDir>/review/opus.txt 預先放「整份：不簽」殘留、councilMain 這輪產「整份：簽」⇒ summary 是「簽」（證明清過）', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 清舊複審票\n內容')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't10')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't10', 'review')

    // 預先在 <outDir>/review/ 放殘留的 opus.txt（不簽）
    fs.mkdirSync(reviewOutDir, { recursive: true })
    const opusPath = path.join(reviewOutDir, 'agy-opus.txt')
    fs.writeFileSync(opusPath, 'Q1：不簽｜殘留舊資料｜需修正\n整份：不簽\nQ6：舊殘留')

    let existsBeforeCouncilMain = null

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'ok')
        return 0
      },
      councilMain: () => {
        existsBeforeCouncilMain = fs.existsSync(opusPath)
        fakeCouncilOut(reviewOutDir, { 'agy-opus': 'Q1：簽｜ok｜無\n整份：簽\nQ6：ok', 'agy-gemini': 'Q1：簽｜ok｜無\n整份：簽\nQ6：ok' })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
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
    const opus = summary.review.members.find((m) => m.name === 'agy/opus')
    assert.ok(opus, 'summary 應包含 agy/opus')
    assert.equal(opus.overall, '簽', 'opus overall 應為「簽」，證明舊的「不簽」殘留已被清除')
  })

  test('T11 riskDomains 升級：config riskDomains: [金流]、brief 含「金流」、--tier standard ⇒ councilMain 收到 --tier block、summary.tierEscalatedBy 是 [金流]；riskDomains: [] ⇒ 仍是 standard', async () => {
    // 1. riskDomains: ['金流'] ⇒ 升級 block
    const repo1 = makeRepo({ riskDomains: ['金流'] })
    const briefFile1 = path.join(tmpdir('brief1-'), 'brief.md')
    fs.writeFileSync(briefFile1, '# 涉及金流模組之修改\n包含金流交易處理')

    const worktreePath1 = path.join(repo1.dir, '.claude', 'worktrees', 't11-escalate')
    const reviewOutDir1 = path.join(repo1.dir, '.local', 'llm-team', 't11-escalate', 'review')

    let receivedCouncilArgs1 = null
    const deps1 = {
      repoRoot: repo1.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath1, 'pay.txt'), 'pay')
        return 0
      },
      councilMain: (args) => {
        receivedCouncilArgs1 = args
        fakeCouncilOut(reviewOutDir1, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n', 'codex-gpt-5-6-sol': '整份：簽\n' })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs1 = []
    const origLog = console.log
    console.log = (m) => outs1.push(String(m))
    let code1
    try {
      code1 = await ticketMain(
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
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath2, 'pay.txt'), 'pay')
        return 0
      },
      councilMain: (args) => {
        receivedCouncilArgs2 = args
        fakeCouncilOut(reviewOutDir2, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs2 = []
    console.log = (m) => outs2.push(String(m))
    let code2
    try {
      code2 = await ticketMain(
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

  test('T17 --test 不在 allow 內：--test "bash -n x.sh" ⇒ run 回 2、writeMain 沒被呼叫、stderr 含 allowCommandHeads', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試票\n內容')

    let writeCalled = false
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
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
      code = await ticketMain(
        [
          'run',
          '--name',
          't17',
          '--brief',
          briefFile,
          '--branch',
          'feat/t17--slice',
          '--allow',
          'a.txt',
          '--test',
          'bash -n x.sh',
        ],
        deps
      )
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `不安全的 --test 時 run 應回 2，實際得到 ${code}`)
    assert.equal(writeCalled, false, 'writeMain 不應被呼叫')
    const errOutput = errs.join('\n')
    assert.match(errOutput, /allowCommandHeads/, `stderr 應包含 allowCommandHeads，實際：${errOutput}`)
  })

  test('T18 陽性對照：--test "node --test x.test.mjs && node --check x.mjs" ⇒ 通過這道檢查（run 繼續往下、writeMain 被呼叫）', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試票\n內容')

    let writeCalled = false
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCalled = true
        return 0
      },
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't18',
          '--brief',
          briefFile,
          '--branch',
          'feat/t18--slice',
          '--allow',
          'a.txt',
          '--test',
          'node --test x.test.mjs && node --check x.mjs',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(writeCalled, true, 'writeMain 應被呼叫')
    assert.equal(code, 0, `run 應成功執行完畢，實際 exit code 為 ${code}`)
  })

  test('T19 writeMain 回 3、changed 空 ⇒ run 回 3（陽性對照：把第 1 點拿掉就回 0）', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T19\n內容')

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => 3,
      changedFiles: () => [],
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't19',
          '--brief',
          briefFile,
          '--branch',
          'feat/t19--slice',
          '--allow',
          'a.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 3, `writeMain 回 3 時 run 應回 3，實際得到 ${code}`)
    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 't19', 'summary.json')
    assert.ok(fs.existsSync(summaryFile), 'summary.json 應存在')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.writeExit, 3)
    assert.deepEqual(summary.changed, [])
  })

  test('T20 changed 非空、runTest 回 exit 1 ⇒ run 回 3', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T20\n內容')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't20')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't20', 'review')

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'changed')
        return 0
      },
      runTest: () => ({ exit: 1, out: 'test failed' }),
      councilMain: () => {
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't20',
          '--brief',
          briefFile,
          '--branch',
          'feat/t20--slice',
          '--allow',
          'a.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 3, `verifyExit 非零時 run 應回 3，實際得到 ${code}`)
    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 't20', 'summary.json')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.verifyExit, 1)
  })

  test('T21 全綠 ⇒ 0', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T21\n內容')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't21')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't21', 'review')

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ok')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: () => {
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't21',
          '--brief',
          briefFile,
          '--branch',
          'feat/t21--slice',
          '--allow',
          'a.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `全綠時 run 應回 0，實際得到 ${code}`)
    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 't21', 'summary.json')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.writeExit, 0)
    assert.equal(summary.verifyExit, 0)
    assert.equal(summary.review.anyEmpty, false)
  })

  test('T22 publish：summary verifyExit:1 ⇒ 2 且 gh 假函式沒被呼叫', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't22')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't22')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't22',
      branch: 'feat/t22--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 1,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
      },
      q6Receipt: 'verified',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd) => {
        if (cmd === 'gh') ghCalled = true
        return { status: 0, stdout: '' }
      },
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['publish', '--name', 't22'], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `verifyExit: 1 時 publish 應回 2，實際為 ${code}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    assert.match(errs.join('\n'), /verifyExit/)
  })

  test('T23 publish：summary anyEmpty:true ⇒ 2 且 gh 假函式沒被呼叫', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't23')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't23')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't23',
      branch: 'feat/t23--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ],
        anyEmpty: true,
      },
      q6Receipt: 'verified',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd) => {
        if (cmd === 'gh') ghCalled = true
        return { status: 0, stdout: '' }
      },
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['publish', '--name', 't23'], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `anyEmpty: true 時 publish 應回 2，實際為 ${code}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    assert.match(errs.join('\n'), /anyEmpty/)
  })

  test('T24 publish：一位 overall:\'不簽\' 且無 dispositions ⇒ 2 且 gh 假函式沒被呼叫', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't24')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't24')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't24',
      branch: 'feat/t24--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '不簽', q: { Q1: '不簽' } },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
      },
      q6Receipt: 'verified',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd) => {
        if (cmd === 'gh') ghCalled = true
        return { status: 0, stdout: '' }
      },
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['publish', '--name', 't24'], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `有不簽且無 disposition 時 publish 應回 2，實際為 ${code}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    assert.match(errs.join('\n'), /不簽/)
  })

  test('T25 同上但 accept --disposition 標了 rejected ＋ --q6 ⇒ publish 走到 gh', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't25')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't25')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't25',
      branch: 'feat/t25--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '不簽', q: { Q1: '不簽' } },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
      },
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd, args) => {
        if (cmd === 'gh') {
          ghCalled = true
          if (args[0] === '--version') return { status: 0, stdout: 'gh 2.50.0' }
          if (args[0] === 'pr') return { status: 0, stdout: 'https://github.com/org/repo/pull/456' }
        }
        return { status: 0, stdout: '' }
      },
    }

    // 1. accept 寫入 disposition 與 q6
    const acceptCode = await ticketMain(
      ['accept', '--name', 't25', '--q6', '已確認 Q1 不影響主流程', '--disposition', 'agy/opus:Q1=rejected:"範圍縮減裁決"'],
      deps
    )
    assert.equal(acceptCode, 0, `accept 應回 0，實際為 ${acceptCode}`)

    const updatedSummary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(updatedSummary.q6Receipt, '已確認 Q1 不影響主流程')
    assert.equal(updatedSummary.dispositions.length, 1)
    assert.equal(updatedSummary.dispositions[0].disposition, 'rejected')

    // 2. publish 通過
    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let publishCode
    try {
      publishCode = await ticketMain(['publish', '--name', 't25'], deps)
    } finally {
      console.log = origLog
    }

    assert.equal(publishCode, 0, `disposition 與 q6Receipt 齊全時 publish 應回 0，實際為 ${publishCode}`)
    assert.equal(ghCalled, true, 'gh 應被呼叫')
  })

  test('T26 publish：沒 q6Receipt ⇒ 2 且 gh 假函式沒被呼叫', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't26')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't26')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't26',
      branch: 'feat/t26--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
      },
      // 缺 q6Receipt
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd) => {
        if (cmd === 'gh') ghCalled = true
        return { status: 0, stdout: '' }
      },
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['publish', '--name', 't26'], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `缺少 q6Receipt 時 publish 應回 2，實際為 ${code}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    assert.match(errs.join('\n'), /q6Receipt/)
  })

  test('T27 lifecycle：跑完 run 後 lifecycle.ndjson 至少有 run-start、writer-done、review-done 三行、順序正確、每行有 harness；設 LLM_TEAM_HARNESS=agy 時 harness 為 agy', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T27\n內容')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't27')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't27', 'review')

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      env: { LLM_TEAM_HARNESS: 'agy', LLM_TEAM_COORDINATOR: 'claude' },
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ok')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: () => {
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't27',
          '--brief',
          briefFile,
          '--branch',
          'feat/t27--slice',
          '--allow',
          'a.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `run 應回 0，實際為 ${code}`)

    const lifecyclePath = path.join(repo.dir, '.local', 'llm-team', 't27', 'lifecycle.ndjson')
    assert.ok(fs.existsSync(lifecyclePath), 'lifecycle.ndjson 應存在')
    const lines = fs
      .readFileSync(lifecyclePath, 'utf8')
      .trim()
      .split('\n')

    assert.deepStrictEqual(lines.map((l) => JSON.parse(l).event), ['run-start', 'writer-done', 'review-done'])

    const parsed = lines.map((l) => JSON.parse(l))
    for (const item of parsed) {
      assert.equal(item.harness, 'agy', '每行 lifecycle 的 harness 應為 agy')
      assert.equal(item.ticket, 't27')
      assert.ok(item.at, '每行應有時間戳記 at')
    }
    assert.equal(parsed[1].writeExit, 0, 'writer-done 應包含 writeExit: 0')
    assert.equal(parsed[2].anyEmpty, false, 'review-done 應包含 anyEmpty: false')

    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 't27', 'summary.json')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.harness, 'agy')
    assert.equal(summary.lifecycle, 'lifecycle.ndjson')
    assert.equal(summary.comparable, false)
  })

  test('T28 summary --name：印出 harness、q6Receipt（有無）、dispositions 數', async () => {
    const repo = makeRepo()
    const outDir = path.join(repo.dir, '.local', 'llm-team', 't28')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't28',
      branch: 'feat/t28--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['a.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: [{ name: 'agy/opus', overall: '簽' }],
        anyEmpty: false,
      },
      harness: 'agy',
      q6Receipt: 'verified ok',
      dispositions: [{ member: 'agy/opus', q: 'Q1', disposition: 'rejected', note: 'n', by: 'c', at: '2026' }],
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(['summary', '--name', 't28'], { repoRoot: repo.dir })
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0)
    const outText = outs.join('\n')
    assert.match(outText, /harness: agy/)
    assert.match(outText, /q6Receipt: 有/)
    assert.match(outText, /dispositions: 1/)
  })

  test('T29 lifecycle：writeMain 回 3 失敗時 lifecycle 恰有 run-start 與 writer-done 兩行（無 review-done）', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T29\n內容')

    let councilCalled = false
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => 3,
      councilMain: () => {
        councilCalled = true
        return 0
      },
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't29',
          '--brief',
          briefFile,
          '--branch',
          'feat/t29--slice',
          '--allow',
          'a.txt',
          '--test',
          'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 3, `writeMain 回 3 且 changed 為空時 run 應回 3，實際為 ${code}`)
    assert.equal(councilCalled, false, 'council 不應被呼叫')

    const lifecyclePath = path.join(repo.dir, '.local', 'llm-team', 't29', 'lifecycle.ndjson')
    assert.ok(fs.existsSync(lifecyclePath), 'lifecycle.ndjson 應存在')
    const lines = fs.readFileSync(lifecyclePath, 'utf8').trim().split('\n')
    assert.deepStrictEqual(
      lines.map((l) => JSON.parse(l).event),
      ['run-start', 'writer-done']
    )
  })

  test('T30 publish：summary writeExit:3 ⇒ 2 且 gh 假函式沒被呼叫', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't30')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't30')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't30',
      branch: 'feat/t30--slice',
      base: 'main',
      writeExit: 3,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
      },
      q6Receipt: 'verified ok',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd) => {
        if (cmd === 'gh') ghCalled = true
        return { status: 0, stdout: '' }
      },
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['publish', '--name', 't30'], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `writeExit: 3 時 publish 應回 2，實際為 ${code}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    assert.match(errs.join('\n'), /writeExit 為 3/)
  })

  test('T31 publish：review.members 少於 summary.reviewers 名單（缺 agy/gemini）⇒ 2 且 gh 假函式沒被呼叫；members 空 ⇒ 2', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't31')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't31')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't31',
      branch: 'feat/t31--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [{ name: 'agy/opus', overall: '簽' }]),
        anyEmpty: false,
      },
      q6Receipt: 'verified ok',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd) => {
        if (cmd === 'gh') ghCalled = true
        return { status: 0, stdout: '' }
      },
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['publish', '--name', 't31'], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `review.members 未全員到齊時 publish 應回 2，實際為 ${code}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    assert.match(errs.join('\n'), /複審名單未全員到齊（review\/members\.json 身分三元組 ≠ summary\.reviewers），缺：agy\/gemini〔agy\/gemini-3\.1-pro-high\/gemini〕；多：\(無\)/)

    // members 空 ⇒ 2（名單非空但沒人）
    summary.review.members = []
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
    console.error = (m) => errs.push(String(m))
    let code2
    try {
      code2 = await ticketMain(['publish', '--name', 't31'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code2, 2)
    assert.equal(ghCalled, false)
    assert.match(errs.join('\n'), /複審成員或名單為空/)

    // 陽性對照：同一份但名單只有 agy/opus（1 位）且 members（summary＋members.json）有它 ⇒ 過這道閘（v2 一般票名單可以只有 1 位）
    summary.reviewers = [ROSTER_STANDARD[0]]
    summary.review.members = reviewFixture(outDir, [{ name: 'agy/opus', overall: '簽' }])
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
    const code3 = await ticketMain(['publish', '--name', 't31'], deps)
    assert.equal(code3, 0)
    assert.equal(ghCalled, true)
  })

  test('Q5 publish（codex 複審 Q5-IDENTITY）：同 name 不同 model ⇒ 2（陽性對照：只比 name 會放過）；members.json 多一位 ⇒ 2；缺 members.json ⇒ 2；summary.rosterMismatch:true ⇒ 2；summary.review.members 三元組漂移 ⇒ 2；全對 ⇒ 走到 gh', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 'q5p')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')
    const outDir = path.join(repo.dir, '.local', 'llm-team', 'q5p')
    fs.mkdirSync(outDir, { recursive: true })
    const membersFile = path.join(outDir, 'review', 'members.json')
    const baseSummary = () => ({
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 'q5p',
      branch: 'feat/q5p',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      rosterMismatch: false,
      review: { tier: 'standard', members: [], anyEmpty: false },
      q6Receipt: 'verified ok',
    })
    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd, args) => {
        if (cmd === 'gh') {
          ghCalled = true
          if (args[0] === '--version') return { status: 0, stdout: 'gh' }
          return { status: 0, stdout: 'https://x/pr/1' }
        }
        return { status: 0, stdout: '' }
      },
    }
    const run = async () => {
      const errs = []
      const origErr = console.error
      const origLog = console.log
      console.error = (m) => errs.push(String(m))
      console.log = () => {}
      let code
      try {
        code = await ticketMain(['publish', '--name', 'q5p'], deps)
      } finally {
        console.error = origErr
        console.log = origLog
      }
      return { code, errs: errs.join('\n') }
    }
    const write = (summary) => fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    // 1. 同 name 不同 model：agy/gemini 實際跑的是 gemini-3.1-pro-low（名字一樣、三元組不同）
    const impostor = { name: 'agy/gemini', harness: 'agy', model: 'gemini-3.1-pro-low', quotaBucket: 'gemini', overall: '簽' }
    let s = baseSummary()
    s.review.members = reviewFixture(outDir, [{ name: 'agy/opus', overall: '簽' }, impostor])
    write(s)
    // 陽性對照的前提：只比 name 看不出差別
    assert.deepEqual(s.review.members.map((m) => m.name), s.reviewers.map((r) => r.name))
    let r = await run()
    assert.equal(r.code, 2, '同 name 不同 model 必須擋')
    assert.equal(ghCalled, false)
    assert.match(r.errs, /複審名單未全員到齊（review\/members\.json 身分三元組 ≠ summary\.reviewers），缺：agy\/gemini〔agy\/gemini-3\.1-pro-high\/gemini〕；多：agy\/gemini〔agy\/gemini-3\.1-pro-low\/gemini〕/)

    // 2. members.json 多一位（codex 在一般票裡冒出來）
    s = baseSummary()
    s.review.members = reviewFixture(outDir, [{ name: 'agy/opus', overall: '簽' }, { name: 'agy/gemini', overall: '簽' }, { name: 'codex/gpt-5-6-sol', overall: '簽' }])
    write(s)
    r = await run()
    assert.equal(r.code, 2)
    assert.match(r.errs, /多：codex\/gpt-5-6-sol〔codex\/gpt-5\.6-sol\/openai〕/)

    // 3. 缺 members.json（summary 自己貼的名單再漂亮也不算）
    s = baseSummary()
    s.review.members = reviewFixture(outDir, [{ name: 'agy/opus', overall: '簽' }, { name: 'agy/gemini', overall: '簽' }])
    write(s)
    fs.unlinkSync(membersFile)
    r = await run()
    assert.equal(r.code, 2)
    assert.match(r.errs, /缺 council 的實際名單（或格式不合法）/)
    assert.equal(ghCalled, false)

    // 4. run 已判 rosterMismatch:true（即使檔案都對）
    s = baseSummary()
    s.review.members = reviewFixture(outDir, [{ name: 'agy/opus', overall: '簽' }, { name: 'agy/gemini', overall: '簽' }])
    s.rosterMismatch = true
    write(s)
    r = await run()
    assert.equal(r.code, 2)
    assert.match(r.errs, /run 已判 rosterMismatch/)

    // 5. members.json 對、但 summary.review.members 被改成同 name 不同 model ⇒ 也擋
    s = baseSummary()
    reviewFixture(outDir, [{ name: 'agy/opus', overall: '簽' }, { name: 'agy/gemini', overall: '簽' }])
    s.review.members = [{ ...MEMBER_BY_NAME['agy/opus'], overall: '簽' }, impostor]
    write(s)
    r = await run()
    assert.equal(r.code, 2)
    assert.match(r.errs, /summary\.review\.members 身分三元組 ≠ summary\.reviewers/)
    assert.equal(ghCalled, false)

    // 6. 陽性對照：全對 ⇒ 走到 gh
    s = baseSummary()
    s.review.members = reviewFixture(outDir, [{ name: 'agy/opus', overall: '簽' }, { name: 'agy/gemini', overall: '簽' }])
    write(s)
    r = await run()
    assert.equal(r.code, 0, r.errs)
    assert.equal(ghCalled, true)
  })

  test('Q5 run（codex 複審 Q5-IDENTITY）：ticket 只從 review/members.json 取實際名單——少一位／多一位／同 name 不同 model ⇒ run 回 3、summary.rosterMismatch true、rosterDiff 指名、收貨摘要含 rosterMismatch；缺 members.json ⇒ 3；全對 ⇒ 0 且 members 三元組來自 members.json（陽性對照）', async () => {
    const cases = [
      {
        label: '少一位',
        members: [{ ...MEMBER_BY_NAME['agy/opus'], overall: '簽', empty: false }],
        missing: ['agy/gemini〔agy/gemini-3.1-pro-high/gemini〕'],
        unexpected: [],
      },
      {
        label: '多一位',
        members: [
          { ...MEMBER_BY_NAME['agy/opus'], overall: '簽', empty: false },
          { ...MEMBER_BY_NAME['agy/gemini'], overall: '簽', empty: false },
          { ...MEMBER_BY_NAME['codex/gpt-5-6-sol'], overall: '簽', empty: false },
        ],
        missing: [],
        unexpected: ['codex/gpt-5-6-sol〔codex/gpt-5.6-sol/openai〕'],
      },
      {
        label: '同 name 不同 model',
        members: [
          { ...MEMBER_BY_NAME['agy/opus'], overall: '簽', empty: false },
          { name: 'agy/gemini', harness: 'agy', model: 'gemini-3.1-pro-low', quotaBucket: 'gemini', overall: '簽', empty: false },
        ],
        missing: ['agy/gemini〔agy/gemini-3.1-pro-high/gemini〕'],
        unexpected: ['agy/gemini〔agy/gemini-3.1-pro-low/gemini〕'],
      },
      { label: '缺 members.json', members: null, missing: ['agy/opus〔agy/claude-opus-4-6-thinking/agy-claude〕', 'agy/gemini〔agy/gemini-3.1-pro-high/gemini〕'], unexpected: [] },
    ]
    for (const c of cases) {
      const repo = makeRepo()
      const briefFile = path.join(tmpdir('brief-'), 'brief.md')
      fs.writeFileSync(briefFile, '# Q5 run\n內容')
      const name = `q5r-${cases.indexOf(c)}`
      const worktreePath = path.join(repo.dir, '.claude', 'worktrees', name)
      const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', name, 'review')
      const deps = {
        repoRoot: repo.dir,
        assertSettings: () => true,
        writeMain: () => {
          fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ok')
          return 0
        },
        runTest: () => ({ exit: 0, out: 'ok' }),
        councilMain: () => {
          // 每位都有輸出檔（含預期名單的每一位）——只有 members.json 說了算
          fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n', 'codex-gpt-5-6-sol': '整份：簽\n' }, c.members ? { members: c.members } : {})
          if (!c.members) fs.unlinkSync(path.join(reviewOutDir, 'members.json'))
          return 0
        },
      }
      const outs = []
      const origLog = console.log
      console.log = (m) => outs.push(String(m))
      let code
      try {
        code = await ticketMain(['run', '--name', name, '--brief', briefFile, '--branch', `feat/${name}`, '--allow', 'a.txt', '--test', 'true'], deps)
      } finally {
        console.log = origLog
      }
      assert.equal(code, 3, `${c.label}：run 應回 3，實際 ${code}`)
      const summary = JSON.parse(fs.readFileSync(path.join(repo.dir, '.local', 'llm-team', name, 'summary.json'), 'utf8'))
      assert.equal(summary.rosterMismatch, true, c.label)
      assert.deepEqual(summary.rosterDiff.missing.map((m) => `${m.name}〔${m.harness}/${m.model}/${m.quotaBucket}〕`), c.missing, c.label)
      assert.deepEqual(summary.rosterDiff.unexpected.map((m) => `${m.name}〔${m.harness}/${m.model}/${m.quotaBucket}〕`), c.unexpected, c.label)
      assert.equal(summary.review.anyEmpty, false, `${c.label}：不是零輸出造成的 3`)
      assert.match(outs.join('\n'), /🔴 rosterMismatch：council 實際名單 ≠ profile 預期名單/, c.label)
      if (!c.members) assert.match(summary.rosterDiff.reason, /缺 council 的 members\.json/)
      // 名單只從 members.json 來：多出來的殘留 .txt（codex）不會因為檔案存在就被撿進 members
      if (c.members) assert.deepEqual(summary.review.members.map((m) => m.name), c.members.map((m) => m.name), c.label)
      // 陽性對照的前提（同 name 不同 model）：只比 name 看不出差別
      if (c.label === '同 name 不同 model') assert.deepEqual(summary.review.members.map((m) => m.name), summary.reviewers.map((r) => r.name))
      const lifecycle = fs.readFileSync(path.join(repo.dir, '.local', 'llm-team', name, 'lifecycle.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.equal(lifecycle.find((l) => l.event === 'review-done').rosterMismatch, true, c.label)
    }

    // 陽性對照：members.json 與預期名單完全一致 ⇒ 0、rosterMismatch false、members 的三元組來自 members.json、membersSource 標明來源
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# Q5 ok\n內容')
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 'q5ok')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 'q5ok', 'review')
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ok')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: () => {
        fakeCouncilOut(reviewOutDir, { 'agy-opus': 'Q2：不簽｜x｜y\n整份：不簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
    }
    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await ticketMain(['run', '--name', 'q5ok', '--brief', briefFile, '--branch', 'feat/q5ok', '--allow', 'a.txt', '--test', 'true'], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)
    const summary = JSON.parse(fs.readFileSync(path.join(repo.dir, '.local', 'llm-team', 'q5ok', 'summary.json'), 'utf8'))
    assert.equal(summary.rosterMismatch, false)
    assert.equal(summary.rosterDiff, undefined)
    assert.equal(summary.review.membersSource, 'review/members.json')
    assert.deepEqual(
      summary.review.members.map(({ name, harness, model, quotaBucket, overall, q, empty, timedOut }) => ({ name, harness, model, quotaBucket, overall, q, empty, timedOut })),
      [
        { name: 'agy/opus', ...M.agyOpus, overall: '不簽', q: { Q2: '不簽' }, empty: false, timedOut: false },
        { name: 'agy/gemini', ...M.agyGemini, overall: '簽', q: {}, empty: false, timedOut: false },
      ]
    )
  })

  test('T32 publish：同成員兩題不簽只處置一題 ⇒ publish 回 2 且 gh 未呼叫', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't32')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't32')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: [ROSTER_STANDARD[0], { name: 'codex/gpt-5-6-sol', ...M.codexSol }],
      project: 'test-proj',
      ticket: 't32',
      branch: 'feat/t32--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'block',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'codex/gpt-5-6-sol', overall: '不簽', q: { Q1: '不簽', Q6: '不簽' } },
        ]),
        anyEmpty: false,
      },
      q6Receipt: 'verified ok',
      dispositions: [
        { member: 'codex/gpt-5-6-sol', q: 'Q1', disposition: 'rejected', note: 'Q1 裁決', by: 'coordinator', at: '2026-09-13' },
      ],
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd) => {
        if (cmd === 'gh') ghCalled = true
        return { status: 0, stdout: '' }
      },
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['publish', '--name', 't32'], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `同成員兩題不簽只處置一題時 publish 應回 2，實際為 ${code}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    assert.match(errs.join('\n'), /codex\/gpt-5-6-sol 之 Q6 不簽且未處置/)
  })

  test('T33 publish：整份不簽無逐題時給 q:Q3 仍回 2，給 q:overall 且 accept 寫入後 publish 通過', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't33')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't33')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't33',
      branch: 'feat/t33--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '不簽', q: {} },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
      },
      q6Receipt: 'verified ok',
      dispositions: [
        // 給了 Q3 disposition，但 member 只有整份不簽無逐題，只認 overall
        { member: 'agy/opus', q: 'Q3', disposition: 'rejected', note: '無效的逐題處置', by: 'coordinator', at: '2026-09-13' },
      ],
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd, args) => {
        if (cmd === 'gh') {
          ghCalled = true
          if (args[0] === '--version') return { status: 0, stdout: 'gh 2.50.0' }
          if (args[0] === 'pr') return { status: 0, stdout: 'https://github.com/org/repo/pull/789' }
        }
        return { status: 0, stdout: '' }
      },
    }

    // 1. 給了 q: 'Q3' 的 disposition ⇒ publish 仍回 2 且 gh 沒呼叫
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code1
    try {
      code1 = await ticketMain(['publish', '--name', 't33'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code1, 2, `整份不簽無逐題給了 Q3 disposition 時 publish 應回 2，實際為 ${code1}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    assert.match(errs.join('\n'), /agy\/opus 整份不簽且未處置/)

    // 2. 測試 accept --disposition opus:overall=rejected:"..." 寫入
    const acceptCode = await ticketMain(
      ['accept', '--name', 't33', '--q6', '親自坐實', '--disposition', 'agy/opus:overall=rejected:"整體風險已控制"'],
      deps
    )
    assert.equal(acceptCode, 0, `accept 應回 0，實際為 ${acceptCode}`)

    const updatedSummary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    const overallDisp = updatedSummary.dispositions.find((d) => d.member === 'agy/opus' && d.q === 'overall')
    assert.ok(overallDisp, 'summary.dispositions 應包含 q === overall 的處置')
    assert.equal(overallDisp.disposition, 'rejected')
    assert.equal(overallDisp.note, '整體風險已控制')

    // 3. 給了 q: 'overall' ⇒ publish 通過
    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code2
    try {
      code2 = await ticketMain(['publish', '--name', 't33'], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code2, 0, `處置 overall 後 publish 應回 0，實際為 ${code2}`)
    assert.equal(ghCalled, true, 'gh 應被呼叫')
  })

  test('T34 分支前綴由 config branchPrefixes 決定：["agy/"] 擋 feat/ 過 agy/；[] 全放行', async () => {
    // 1. config branchPrefixes: ['agy/']
    const repo1 = makeRepo({ branchPrefixes: ['agy/'] })
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, 'test brief')

    const deps1 = {
      repoRoot: repo1.dir,
      assertSettings: () => true,
      writeMain: () => 0,
      councilMain: () => 0,
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const errs1 = []
    const origErr = console.error
    console.error = (m) => errs1.push(String(m))
    let codeFail
    let codePass
    try {
      // feat/x 應該被擋
      codeFail = await ticketMain(
        ['run', '--name', 't34-1', '--brief', briefFile, '--branch', 'feat/x', '--allow', 'a.txt', '--test', 'true'],
        deps1
      )
      // agy/x 應該放行
      codePass = await ticketMain(
        ['run', '--name', 't34-2', '--brief', briefFile, '--branch', 'agy/x', '--allow', 'a.txt', '--test', 'true'],
        deps1
      )
    } finally {
      console.error = origErr
    }

    assert.equal(codeFail, 2, 'feat/x 不在 agy/ 前綴清單內應回 2')
    assert.match(errs1.join('\n'), /🔴 分支名 'feat\/x' 不合法，必須以前綴之一開頭：agy\//)
    assert.equal(codePass, 0, 'agy/x 在前綴清單內應通過')

    // 2. config branchPrefixes: [] 空陣列＝不檢查
    const repo2 = makeRepo({ branchPrefixes: [] })
    const deps2 = {
      repoRoot: repo2.dir,
      assertSettings: () => true,
      writeMain: () => 0,
      councilMain: () => 0,
      runTest: () => ({ exit: 0, out: 'ok' }),
    }
    const codeAny = await ticketMain(
      ['run', '--name', 't34-3', '--brief', briefFile, '--branch', 'custom-branch-without-prefix', '--allow', 'a.txt', '--test', 'true'],
      deps2
    )
    assert.equal(codeAny, 0, 'branchPrefixes 為空陣列時任何名字都應通過')
  })

  test('T35 早期失敗清理：deps 注入 install 回非零 ⇒ run 回 2 且 worktree 與 branch 被清掉；write 之後失敗 ⇒ worktree 仍在；write 回 2 但已改檔 ⇒ 絕不清理', async () => {
    // 1. deps 注入 runInstall 回非零 ⇒ run 回 2 且 worktree 目錄不存在、branch 不存在
    const repo1 = makeRepo({ installCommand: 'echo fail' })
    const briefFile1 = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile1, 'test brief')
    const worktreePath1 = path.join(repo1.dir, '.claude', 'worktrees', 't35-early-fail')

    const errs1 = []
    const origErr = console.error
    console.error = (m) => errs1.push(String(m))
    let codeFail
    try {
      codeFail = await ticketMain(
        [
          'run',
          '--name',
          't35-early-fail',
          '--brief',
          briefFile1,
          '--branch',
          'feat/t35-early-fail',
          '--allow',
          'a.txt',
          '--test',
          'true',
        ],
        {
          repoRoot: repo1.dir,
          assertSettings: () => true,
          runInstall: () => ({ exit: 1, out: 'install error' }),
        }
      )
    } finally {
      console.error = origErr
    }

    assert.equal(codeFail, 2, 'installCommand 失敗時 ticket run 應回 2')
    assert.equal(fs.existsSync(worktreePath1), false, '早期失敗時本次新建的 worktree 目錄應被清掉')
    const branches1 = repo1.g('branch', '--list', 'feat/t35-early-fail')
    assert.equal(branches1.trim(), '', '早期失敗時本次新建的分支應被刪除')
    assert.match(errs1.join('\n'), /🧹 已清掉本次建立的 worktree 與分支 t35-early-fail/)

    // 2. write 之後失敗（例如 writeMain 回 3） ⇒ worktree 仍在
    const repo2 = makeRepo()
    const briefFile2 = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile2, 'test brief')
    const worktreePath2 = path.join(repo2.dir, '.claude', 'worktrees', 't35-after-write')

    const deps2 = {
      repoRoot: repo2.dir,
      assertSettings: () => true,
      writeMain: () => 3,
      councilMain: () => 0,
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const codeWriteFail = await ticketMain(
      [
        'run',
        '--name',
        't35-after-write',
        '--brief',
        briefFile2,
        '--branch',
        'feat/t35-after-write',
        '--allow',
        'a.txt',
        '--test',
        'true',
      ],
      deps2
    )
    assert.equal(codeWriteFail, 3, 'write 失敗時回 3')
    assert.equal(fs.existsSync(worktreePath2), true, 'write 之後失敗時 worktree 應保留')
    const branches2 = repo2.g('branch', '--list', 'feat/t35-after-write')
    assert.match(branches2, /feat\/t35-after-write/, 'write 之後失敗時分支應保留')

    // 3. write 回 2 但已改檔（changedFiles 非空）⇒ 絕不清理，worktree 與分支仍在，stderr 無 🧹
    const repo3 = makeRepo()
    const briefFile3 = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile3, 'test brief')
    const worktreePath3 = path.join(repo3.dir, '.claude', 'worktrees', 't35-write2-changed')

    const deps3 = {
      repoRoot: repo3.dir,
      assertSettings: () => true,
      writeMain: () => 2,
      changedFiles: () => ['x.txt'],
    }

    const errs3 = []
    const origErr3 = console.error
    console.error = (m) => errs3.push(String(m))
    let codeWrite2Changed
    try {
      codeWrite2Changed = await ticketMain(
        [
          'run',
          '--name',
          't35-write2-changed',
          '--brief',
          briefFile3,
          '--branch',
          'feat/t35-write2-changed',
          '--allow',
          'a.txt',
          '--test',
          'true',
        ],
        deps3
      )
    } finally {
      console.error = origErr3
    }

    assert.equal(codeWrite2Changed, 2, 'write 回 2 時 run 應回 2')
    assert.equal(fs.existsSync(worktreePath3), true, 'write 回 2 但已改檔時 worktree 應保留')
    const branches3 = repo3.g('branch', '--list', 'feat/t35-write2-changed')
    assert.match(branches3, /feat\/t35-write2-changed/, 'write 回 2 但已改檔時分支應保留')
    const errText3 = errs3.join('\n')
    assert.doesNotMatch(errText3, /🧹/, 'write 回 2 但已改檔時絕不應印出 🧹 清理訊息')
  })

  test('T36 block 票收 blockReviewers（含 codex/gpt-5-6-sol）到 summary，codex 不簽則 publish 擋下；standard 票只收 reviewers（不含 codex）', async () => {
    // 1. 實驗組：--tier block ⇒ members ＝ blockReviewers（agy/opus、agy/gemini、codex/gpt-5-6-sol）
    const repo1 = makeRepo()
    const briefFile1 = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile1, '# T36 all\n內容')
    const worktreePath1 = path.join(repo1.dir, '.claude', 'worktrees', 't36-all')
    const reviewOutDir1 = path.join(repo1.dir, '.local', 'llm-team', 't36-all', 'review')

    const deps1 = {
      repoRoot: repo1.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath1, 'file.txt'), 'ok')
        return 0
      },
      councilMain: () => {
        fakeCouncilOut(reviewOutDir1, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n', 'codex-gpt-5-6-sol': '整份：不簽\n' })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs1 = []
    const origLog = console.log
    console.log = (m) => outs1.push(String(m))
    let runCode1
    try {
      runCode1 = await ticketMain(
        [
          'run',
          '--name',
          't36-all',
          '--brief',
          briefFile1,
          '--branch',
          'feat/t36-all',
          '--allow',
          'file.txt',
          '--test',
          'true',
          '--tier',
          'block',
        ],
        deps1
      )
    } finally {
      console.log = origLog
    }

    assert.equal(runCode1, 0, `run 應回 0，實際得到 ${runCode1}`)
    const summaryFile1 = path.join(repo1.dir, '.local', 'llm-team', 't36-all', 'summary.json')
    const summary1 = JSON.parse(fs.readFileSync(summaryFile1, 'utf8'))
    const codexMember = summary1.review.members.find((m) => m.name === 'codex/gpt-5-6-sol')
    assert.ok(codexMember, 'summary.review.members 應包含 codex')
    assert.equal(codexMember.overall, '不簽', 'codex overall 應為 不簽')
    assert.equal(codexMember.harness, 'codex')
    assert.equal(codexMember.quotaBucket, 'openai')
    assert.equal(summary1.schemaVersion, 2)
    assert.equal(summary1.coordinator, 'claude')
    assert.deepEqual(summary1.reviewers.map((r) => r.name), ['agy/opus', 'agy/gemini', 'codex/gpt-5-6-sol'])
    assert.equal(summary1.review.tier, 'block')

    // 接著 publish 回 2 且 gh 假函式沒被呼叫
    let ghCalled = false
    const publishDeps = {
      repoRoot: repo1.dir,
      spawn: (cmd, args) => {
        if (cmd === 'gh') {
          ghCalled = true
          if (args[0] === '--version') return { status: 0, stdout: 'gh 2.50.0' }
          if (args[0] === 'pr') return { status: 0, stdout: 'https://github.com/org/repo/pull/123' }
        }
        return { status: 0, stdout: '' }
      },
      git: () => '',
    }

    const errsPub = []
    const origErr = console.error
    console.error = (m) => errsPub.push(String(m))
    let pubCode
    try {
      pubCode = await ticketMain(['publish', '--name', 't36-all'], publishDeps)
    } finally {
      console.error = origErr
    }
    assert.equal(pubCode, 2, `codex 不簽未處置時 publish 應回 2，實際為 ${pubCode}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    assert.match(errsPub.join('\n'), /codex\/gpt-5-6-sol 整份不簽且未處置/)

    // 2. 對照組：--tier standard ⇒ members ＝ reviewers（不含 codex）；council 目錄裡多一個 codex 的殘留輸出檔（不在 members.json）不會被撿進來
    const repo2 = makeRepo()
    const briefFile2 = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile2, '# T36 block\n內容')
    const worktreePath2 = path.join(repo2.dir, '.claude', 'worktrees', 't36-block')
    const reviewOutDir2 = path.join(repo2.dir, '.local', 'llm-team', 't36-block', 'review')

    const deps2 = {
      repoRoot: repo2.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath2, 'file.txt'), 'ok')
        return 0
      },
      councilMain: () => {
        fakeCouncilOut(reviewOutDir2, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        fs.writeFileSync(path.join(reviewOutDir2, 'codex-gpt-5-6-sol.txt'), '整份：不簽\n') // 殘留檔，不在 members.json
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    let runCode2
    try {
      runCode2 = await ticketMain(
        [
          'run',
          '--name',
          't36-block',
          '--brief',
          briefFile2,
          '--branch',
          'feat/t36-block',
          '--allow',
          'file.txt',
          '--test',
          'true',
          '--tier',
          'standard',
        ],
        deps2
      )
    } finally {
      // noop
    }
    assert.equal(runCode2, 0)
    const summaryFile2 = path.join(repo2.dir, '.local', 'llm-team', 't36-block', 'summary.json')
    const summary2 = JSON.parse(fs.readFileSync(summaryFile2, 'utf8'))
    const hasCodex = summary2.review.members.some((m) => m.name === 'codex/gpt-5-6-sol')
    assert.equal(hasCodex, false, 'standard 票 members 不應含 codex')
    assert.deepEqual(summary2.reviewers.map((r) => r.name), ['agy/opus', 'agy/gemini'])
  })


  test('P5：writeMain 回 3 且【有】改檔 ⇒ councilMain 假函式沒被呼叫、runTest 沒被呼叫、run 回 3、summary.review === null、writeTimedOut false（陽性對照：把 P5 的 writeFailed 判斷拿掉就會開 council）', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# P5\n內容')
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 'p5')

    let councilCalls = 0
    let testCalls = 0
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'half.txt'), '半成品')
        return 3
      },
      councilMain: () => {
        councilCalls++
        return 0
      },
      runTest: () => {
        testCalls++
        return { exit: 0, out: 'ok' }
      },
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
        ['run', '--name', 'p5', '--brief', briefFile, '--branch', 'feat/p5', '--allow', 'half.txt', '--test', 'true'],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 3)
    assert.equal(councilCalls, 0, 'write 非 0 不准開 council')
    assert.equal(testCalls, 0, 'write 非 0 不准跑 --test')
    const summary = JSON.parse(fs.readFileSync(path.join(repo.dir, '.local', 'llm-team', 'p5', 'summary.json'), 'utf8'))
    assert.equal(summary.writeExit, 3)
    assert.deepEqual(summary.changed, ['half.txt'])
    assert.equal(summary.review, null)
    assert.equal(summary.verifyExit, null)
    assert.equal(summary.writeTimedOut, false)
    assert.equal(summary.schemaVersion, 2)
    assert.match(outs.join('\n'), /未複審（write 非 0/)

    // 陽性對照：同一組 deps 但 writeMain 回 0 ⇒ council 與 runTest 都被呼叫
    const repo2 = makeRepo()
    const worktreePath2 = path.join(repo2.dir, '.claude', 'worktrees', 'p5b')
    const reviewOutDir2 = path.join(repo2.dir, '.local', 'llm-team', 'p5b', 'review')
    const deps2 = {
      ...deps,
      repoRoot: repo2.dir,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath2, 'half.txt'), '完成')
        return 0
      },
      councilMain: (args) => {
        councilCalls++
        assert.ok(args.includes('--coordinator') && args[args.indexOf('--coordinator') + 1] === 'claude', 'council 要收到 --coordinator claude')
        fakeCouncilOut(reviewOutDir2, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
    }
    console.log = () => {}
    let code2
    try {
      code2 = await ticketMain(
        ['run', '--name', 'p5b', '--brief', briefFile, '--branch', 'feat/p5b', '--allow', 'half.txt', '--test', 'true'],
        deps2
      )
    } finally {
      console.log = origLog
    }
    assert.equal(code2, 0)
    assert.equal(councilCalls, 1)
    assert.equal(testCalls, 1)
  })

  test('P5：寫手逾時（writeMain 回 3 並在 <writeOutDir>/timeout.json 留證）⇒ summary.writeTimedOut true、收貨摘要含「寫手逾時」', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# P5 timeout\n內容')
    const writeOutDir = path.join(repo.dir, '.local', 'llm-team', 'p5t', 'write')
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: (args) => {
        const out = args[args.indexOf('--out') + 1]
        assert.equal(out, writeOutDir)
        fs.mkdirSync(out, { recursive: true })
        fs.writeFileSync(path.join(out, 'timeout.json'), JSON.stringify({ round: 1, timeoutMs: 1500000 }))
        return 3
      },
      councilMain: () => 0,
      runTest: () => ({ exit: 0, out: 'ok' }),
    }
    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(['run', '--name', 'p5t', '--brief', briefFile, '--branch', 'feat/p5t', '--allow', 'x.txt', '--test', 'true'], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code, 3)
    const summary = JSON.parse(fs.readFileSync(path.join(repo.dir, '.local', 'llm-team', 'p5t', 'summary.json'), 'utf8'))
    assert.equal(summary.writeTimedOut, true)
    assert.equal(summary.review, null)
    assert.match(outs.join('\n'), /寫手逾時/)
  })

  test('run 缺 --coordinator（deps.env 也沒有）⇒ exit 2、訊息列出可用 profiles、writeMain 沒被呼叫、沒建 worktree；--coordinator 明示 agy ⇒ council 收到 --coordinator agy 且名單是 agy profile 的', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# coord\n內容')
    let writeCalls = 0
    const deps = {
      repoRoot: repo.dir,
      env: {},
      assertSettings: () => true,
      writeMain: () => {
        writeCalls++
        return 0
      },
      councilMain: () => 0,
      runTest: () => ({ exit: 0, out: 'ok' }),
    }
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['run', '--name', 'c0', '--brief', briefFile, '--branch', 'feat/c0', '--allow', 'x.txt', '--test', 'true'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 2)
    assert.equal(writeCalls, 0)
    assert.ok(!fs.existsSync(path.join(repo.dir, '.claude', 'worktrees', 'c0')), '缺 coordinator 不准建 worktree')
    assert.match(errs.join('\n'), /統整者 profile 未指定.*可用 profiles：claude, agy, codex/)

    // 明示 --coordinator agy
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 'c1')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 'c1', 'review')
    let councilArgs = null
    const deps2 = {
      ...deps,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'x.txt'), 'ok')
        return 0
      },
      councilMain: (args) => {
        councilArgs = args
        fakeCouncilOut(reviewOutDir, { 'codex-gpt-5-6-sol': '整份：簽\n' })
        return 0
      },
    }
    const origLog = console.log
    console.log = () => {}
    let code2
    try {
      code2 = await ticketMain(['run', '--coordinator', 'agy', '--name', 'c1', '--brief', briefFile, '--branch', 'feat/c1', '--allow', 'x.txt', '--test', 'true'], deps2)
    } finally {
      console.log = origLog
    }
    assert.equal(code2, 0)
    assert.equal(councilArgs[councilArgs.indexOf('--coordinator') + 1], 'agy')
    const summary = JSON.parse(fs.readFileSync(path.join(repo.dir, '.local', 'llm-team', 'c1', 'summary.json'), 'utf8'))
    assert.equal(summary.coordinator, 'agy')
    assert.deepEqual(summary.reviewers.map((r) => r.name), ['codex/gpt-5-6-sol'])
    assert.deepEqual(summary.review.members.map((m) => [m.name, m.overall]), [['codex/gpt-5-6-sol', '簽']])
  })

  test('publish：summary schemaVersion 1（舊 summary）⇒ 2 且 gh 假函式沒被呼叫（陽性對照：同一份改成 2 ＋ reviewers 名單 ⇒ 走到 gh）', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 'sv1')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')
    const outDir = path.join(repo.dir, '.local', 'llm-team', 'sv1')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 1,
      project: 'p',
      ticket: 'sv1',
      branch: 'feat/sv1',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: { tier: 'standard', members: reviewFixture(outDir, [{ name: 'agy/opus', overall: '簽' }, { name: 'agy/gemini', overall: '簽' }]), anyEmpty: false },
      q6Receipt: 'ok',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary))
    let ghCalled = false
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: () => '',
      spawn: (cmd, args) => {
        if (cmd === 'gh') {
          ghCalled = true
          if (args[0] === '--version') return { status: 0, stdout: 'gh' }
          return { status: 0, stdout: 'https://x/pr/1' }
        }
        return { status: 0, stdout: '' }
      },
    }
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['publish', '--name', 'sv1'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 2)
    assert.equal(ghCalled, false)
    assert.match(errs.join('\n'), /summary\.schemaVersion 為 1（非 2）/)

    summary.schemaVersion = 2
    summary.coordinator = 'claude'
    summary.reviewers = ROSTER_STANDARD
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary))
    const origLog = console.log
    console.log = () => {}
    let code2
    try {
      code2 = await ticketMain(['publish', '--name', 'sv1'], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code2, 0)
    assert.equal(ghCalled, true)
  })

  test('T37 G2 對帳：deps 注入 writeMain 時仍受 G2 約束（settings 缺 regex ⇒ run 回 2、未建 worktree 且 writeMain 沒被呼叫）', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T37\n內容')
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't37')
    const rootSlash = repo.dir.endsWith('/') ? repo.dir : repo.dir + '/'

    const tmpSettingsDir = tmpdir('t37-settings-')
    const badSettingsFile = path.join(tmpSettingsDir, 'bad-settings.json')
    fs.writeFileSync(
      badSettingsFile,
      JSON.stringify(
        {
          permissions: {
            allow: ['read_file(' + rootSlash + ')'],
          },
          trustedWorkspaces: [repo.dir],
        },
        null,
        2
      )
    )

    let writeCalled = false
    const deps = {
      repoRoot: repo.dir,
      env: {
        ...process.env,
        AGY_SETTINGS: badSettingsFile,
      },
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
      code = await ticketMain(
        [
          'run',
          '--name',
          't37',
          '--brief',
          briefFile,
          '--branch',
          'feat/t37--slice',
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

    assert.equal(code, 2, `allow 缺 regex 時 run 應回 2，實際為 ${code}`)
    assert.equal(writeCalled, false, 'G2 失敗時 writeMain 不應被呼叫')
    assert.match(errs.join('\n'), /🔴 G2：/, 'stderr 應包含 G2 訊息')
    assert.match(errs.join('\n'), /permissions\.allow 缺這條/, 'stderr 應包含 permissions.allow 缺這條')
    assert.equal(fs.existsSync(worktreePath), false, 'G2 失敗時 worktree 不應被建立')
    const branches = repo.g('branch', '--list', 'feat/t37--slice')
    assert.equal(branches.trim(), '', 'G2 失敗時分支不應被建立')
  })

  test('T37b G2 對帳：deps 注入 writeMain 且 settings 含正確 regex ⇒ 過 G2 且 writeMain 被呼叫', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T37b\n內容')
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't37b')
    const rootSlash = repo.dir.endsWith('/') ? repo.dir : repo.dir + '/'
    const regex = buildSafeCommandRegex(TEST_CONFIG)
    const goodAllow = `command(regex:${regex})`

    const tmpSettingsDir = tmpdir('t37b-settings-')
    const goodSettingsFile = path.join(tmpSettingsDir, 'good-settings.json')
    fs.writeFileSync(
      goodSettingsFile,
      JSON.stringify(
        {
          permissions: {
            allow: [goodAllow, 'read_file(' + rootSlash + ')'],
          },
          trustedWorkspaces: [repo.dir],
        },
        null,
        2
      )
    )

    let writeCalled = false
    const deps = {
      repoRoot: repo.dir,
      env: {
        ...process.env,
        AGY_SETTINGS: goodSettingsFile,
      },
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
      code = await ticketMain(
        [
          'run',
          '--name',
          't37b',
          '--brief',
          briefFile,
          '--branch',
          'feat/t37b--slice',
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

    assert.equal(code, 0, `G2 通過且 write 回 0 時 run 應回 0，實際為 ${code}`)
    assert.equal(writeCalled, true, 'G2 通過時 writeMain 應被呼叫')
    assert.equal(fs.existsSync(worktreePath), true, 'G2 通過時 worktree 應被建立')
    const branches = repo.g('branch', '--list', 'feat/t37b--slice')
    assert.match(branches, /feat\/t37b--slice/, 'G2 通過時分支應被建立')
  })

  test('T38 run 拒絕多餘位置參數：--allow a b ⇒ exit 2 且訊息含 b；--allow a --allow b ⇒ 通過參數檢查', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# brief\n')
    const deps = {
      repoRoot: repo.dir,
      config: TEST_CONFIG,
      assertSettings: () => true,
      writeMain: () => 0,
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: () => 0,
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name', 't38',
          '--brief', briefFile,
          '--branch', 'feat/t38',
          '--allow', 'a', 'b',
          '--test', 'true',
        ],
        deps
      )
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, '有未預期的位置參數時 run 應回 2')
    const allErr = errs.join('\n')
    assert.match(allErr, /🔴 多餘的位置參數（--allow 要每個檔各給一次）：b/)
    assert.ok(allErr.includes('b'), `錯誤訊息應含 'b'，實際輸出：${allErr}`)

    // 陽性對照：--allow a --allow b 通過參數檢查（不因「多餘的位置參數」而報錯，且走完流程 exit 0）
    const errs2 = []
    console.error = (m) => errs2.push(String(m))
    let codePass
    try {
      codePass = await ticketMain(
        [
          'run',
          '--name', 't38',
          '--brief', briefFile,
          '--branch', 'feat/t38',
          '--allow', 'a',
          '--allow', 'b',
          '--test', 'true',
        ],
        deps
      )
    } finally {
      console.error = origErr
    }
    const allErr2 = errs2.join('\n')
    assert.doesNotMatch(allErr2, /多餘的位置參數/, `合法參數不應報多餘位置參數錯誤，實際：${allErr2}`)
    assert.equal(codePass, 0, '合法 --allow a --allow b 通過參數檢查後正常執行完畢回 0')
  })

  test('T39 councilMain 延遲 resolve（非同步 Promise）：run 仍等待其完成、summary.json 含複審結果、exit 正確', async () => {
    // 陽性對照：若 ticket.mjs 在 councilMainFn 呼叫處拿掉 await，則 summary.json 寫入時 reviewMembers 尚未產出（或 councilExit 尚未取得），這條測試會紅。
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 新增功能票\n實作細節')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't39')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't39', 'review')

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'hello.txt'), 'hello world\n')
        return 0
      },
      councilMain: async () => {
        await new Promise((res) => setTimeout(res, 30))
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': 'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認 hello.txt 內容',
          'agy-gemini': 'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認檔案編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name', 't39',
          '--brief', briefFile,
          '--branch', 'feat/t39--slice',
          '--allow', 'hello.txt',
          '--test', 'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, '非同步 councilMain 成功完成後 run 應回 0')
    const summaryPath = path.join(repo.dir, '.local', 'llm-team', 't39', 'summary.json')
    assert.ok(fs.existsSync(summaryPath), 'summary.json 應存在')
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    assert.equal(summary.review.members.length, 2, 'summary 應包含 2 位複審結果')
    assert.equal(summary.review.members[0].overall, '簽')
    assert.equal(summary.review.members[1].overall, '簽')
    assert.equal(summary.review.anyEmpty, false)
  })

  test('T40 councilMain reject ⇒ main 回傳 rejected Promise', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# brief\n')
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't40')
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'hello.txt'), 'hello\n')
        return 0
      },
      councilMain: async () => {
        throw new Error('council 內部嚴重異常')
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    await assert.rejects(
      async () => {
        await ticketMain(
          [
            'run',
            '--name', 't40',
            '--brief', briefFile,
            '--branch', 'feat/t40',
            '--allow', 'hello.txt',
            '--test', 'true',
          ],
          deps
        )
      },
      /council 內部嚴重異常/
    )
  })

  test('T41 runCli 入口測試：main resolve ⇒ exitFn(code)；main reject ⇒ errFn(err) 且 exitFn(1)', async () => {
    // 1. resolve 路徑
    let resolvedCode = null
    const exitFn1 = (code) => { resolvedCode = code }
    const errs1 = []
    const errFn1 = (err) => { errs1.push(err) }

    const retCode1 = await runCli(['--unknown-cmd'], exitFn1, errFn1)
    assert.equal(resolvedCode, 2, '未知指令時 main resolve 2，exitFn 應收到 2')
    assert.equal(retCode1, 2)
    assert.equal(errs1.length, 0, 'resolve 路徑不應呼叫 errFn')

    // 2. reject 路徑
    let rejectedCode = null
    const exitFn2 = (code) => { rejectedCode = code }
    const errs2 = []
    const errFn2 = (err) => { errs2.push(err) }

    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# brief\n')
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't41')
    const rejectDeps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'hello.txt'), 'hello\n')
        return 0
      },
      councilMain: async () => {
        throw new Error('councilMain 拋出例外')
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const retCode2 = await runCli(
      [
        'run',
        '--name', 't41',
        '--brief', briefFile,
        '--branch', 'feat/t41',
        '--allow', 'hello.txt',
        '--test', 'true',
      ],
      exitFn2,
      errFn2,
      rejectDeps
    )

    assert.equal(rejectedCode, 1, 'reject 時 exitFn 應收到 1')
    assert.equal(retCode2, 1)
    assert.equal(errs2.length, 1, 'reject 時 errFn 應收到錯誤物件')
    assert.match(errs2[0].message, /councilMain 拋出例外/)
  })
})

describe('setup.mjs 設定對帳測試', () => {
  /** 假 binary：不打真的 agy／codex／claude（連 --version 都不打）。 */
  const mockBins = {
    agyBin: '/mock/bin/antigravity',
    which: (bin) => `/mock/bin/${bin}`,
    runVersion: () => ({ exit: 0, out: 'mock 1.0' }),
  }

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

    const testHome = tmpdir('setup-home-')
    const fakeGuardDir = tmpdir('setup-guard-')
    const fakeGuardFile = path.join(fakeGuardDir, 'block-dangerous.sh')
    fs.writeFileSync(fakeGuardFile, '#!/usr/bin/env bash\n')
    const fakeHookRunner = () =>
      JSON.stringify({
        command: {
          data: {
            hooks: [
              {
                name: 'block-dangerous',
                enabled: true,
                source: path.join(testHome, '.gemini', 'config', 'hooks.json'),
                actions: [{ event: 'PreToolUse', matcher: 'run_command' }],
              },
            ],
          },
        },
      })

    // 1. 缺 regex ⇒ exit 1
    const badOuts = []
    const badErrs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => badOuts.push(String(m))
    console.error = (m) => badErrs.push(String(m))
    let badCode
    try {
      badCode = setupMain(['--check', '--coordinator', 'agy'], {
        repoRoot: repo.dir,
        settingsFile: badSettingsFile,
        env: { AGY_SETTINGS: badSettingsFile, HOME: testHome, LLM_TEAM_GUARD: fakeGuardFile },
        runAgyHooks: fakeHookRunner,
        ...mockBins,
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
      goodCode = setupMain(['--check', '--coordinator', 'agy'], {
        repoRoot: repo.dir,
        settingsFile: goodSettingsFile,
        env: { AGY_SETTINGS: goodSettingsFile, HOME: testHome, LLM_TEAM_GUARD: fakeGuardFile },
        runAgyHooks: fakeHookRunner,
        ...mockBins,
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
      missingCode = setupMain(['--check', '--coordinator', 'agy'], {
        repoRoot: repo.dir,
        settingsFile: nonExistentFile,
        env: { AGY_SETTINGS: nonExistentFile, HOME: testHome, LLM_TEAM_GUARD: fakeGuardFile },
        runAgyHooks: fakeHookRunner,
        ...mockBins,
      })
    } finally {
      // noop
    }
    assert.equal(missingCode, 2, `設定檔不存在時 exit 應為 2，實際為 ${missingCode}`)

    // 4. 負向：同一組 env 但 LLM_TEAM_GUARD 指到不存在的檔 ⇒ exit 1、stderr 含「守門」
    const badGuardOuts = []
    const badGuardErrs = []
    console.log = (m) => badGuardOuts.push(String(m))
    console.error = (m) => badGuardErrs.push(String(m))
    let badGuardCode
    try {
      badGuardCode = setupMain(['--check', '--coordinator', 'agy'], {
        repoRoot: repo.dir,
        settingsFile: goodSettingsFile,
        env: {
          AGY_SETTINGS: goodSettingsFile,
          HOME: testHome,
          LLM_TEAM_GUARD: path.join(testHome, 'nonexistent-guard.sh'),
        },
        importMetaUrl: 'file:///nonexistent/setup.mjs',
        runAgyHooks: fakeHookRunner,
        ...mockBins,
      })
    } finally {
      console.log = origLog
      console.error = origErr
    }
    assert.equal(badGuardCode, 1, `守門不存在時 exit 應為 1，實際為 ${badGuardCode}`)
    const badGuardErrText = badGuardErrs.join('\n')
    assert.match(badGuardErrText, /守門/, `stderr 應包含「守門」，實際：${badGuardErrText}`)
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

    const testHome = tmpdir('setup-home-t12-')
    const fakeHookRunner = () =>
      JSON.stringify({
        command: {
          data: {
            hooks: [
              {
                name: 'block-dangerous',
                enabled: true,
                source: path.join(testHome, '.gemini', 'config', 'hooks.json'),
                actions: [{ event: 'PreToolUse', matcher: 'run_command' }],
              },
            ],
          },
        },
      })

    // 透過 deps.env 傳入 AGY_SETTINGS（不傳 settingsFile）
    const badOuts = []
    const badErrs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => badOuts.push(String(m))
    console.error = (m) => badErrs.push(String(m))
    let badCode
    try {
      badCode = setupMain(['--check', '--coordinator', 'agy'], {
        repoRoot: repo.dir,
        env: { ...process.env, AGY_SETTINGS: badSettingsFile, HOME: testHome },
        runAgyHooks: fakeHookRunner,
        ...mockBins,
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

  test('setup --sync-check：造 tmp repo → 放快照＋manifest → 全對 exit 0', () => {
    const repo = makeRepo()
    const snapshotDir = path.join(repo.dir, '.agents', 'skills', 'llm-team')
    fs.mkdirSync(snapshotDir, { recursive: true })

    const testFiles = EXPORT_FILES
    const manifestLines = []
    for (const f of testFiles) {
      const p = path.join(snapshotDir, f)
      const content = f === 'VERSION' ? '1\n' : `export const f = "${f}"\n`
      fs.writeFileSync(p, content)
      const hash = crypto.createHash('sha256').update(content).digest('hex')
      manifestLines.push(`${hash}  ${f}`)
    }
    const sourceContent = JSON.stringify({ version: '1', sourceCommit: '12345678', exportedAt: '2026-09-13T00:00:00.000Z' }) + '\n'
    fs.writeFileSync(path.join(snapshotDir, 'SOURCE.json'), sourceContent)
    const sourceHash = crypto.createHash('sha256').update(sourceContent).digest('hex')
    manifestLines.push(`${sourceHash}  SOURCE.json`)
    manifestLines.sort()
    fs.writeFileSync(path.join(snapshotDir, 'MANIFEST.sha256'), manifestLines.join('\n') + '\n')

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = setupMain(['--sync-check'], { repoRoot: repo.dir })
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0)
    const outText = outs.join('\n')
    assert.match(outText, /VERSION 1/)
    assert.match(outText, /漂移 0 檔/)
  })

  test('setup --sync-check：改一個檔一個字元 ⇒ exit 1 且輸出含該檔名', () => {
    const repo = makeRepo()
    const snapshotDir = path.join(repo.dir, '.agents', 'skills', 'llm-team')
    fs.mkdirSync(snapshotDir, { recursive: true })

    const testFiles = EXPORT_FILES
    const manifestLines = []
    for (const f of testFiles) {
      const p = path.join(snapshotDir, f)
      const content = f === 'VERSION' ? '1\n' : `export const f = "${f}"\n`
      fs.writeFileSync(p, content)
      const hash = crypto.createHash('sha256').update(content).digest('hex')
      manifestLines.push(`${hash}  ${f}`)
    }
    const sourceContent = JSON.stringify({ version: '1', sourceCommit: '12345678', exportedAt: '2026-09-13T00:00:00.000Z' }) + '\n'
    fs.writeFileSync(path.join(snapshotDir, 'SOURCE.json'), sourceContent)
    const sourceHash = crypto.createHash('sha256').update(sourceContent).digest('hex')
    manifestLines.push(`${sourceHash}  SOURCE.json`)
    manifestLines.sort()
    fs.writeFileSync(path.join(snapshotDir, 'MANIFEST.sha256'), manifestLines.join('\n') + '\n')

    // 改一個檔一個字元
    fs.appendFileSync(path.join(snapshotDir, 'lib.mjs'), '!')

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let code
    try {
      code = setupMain(['--sync-check'], { repoRoot: repo.dir })
    } finally {
      console.log = origLog
    }

    assert.equal(code, 1)
    const outText = outs.join('\n')
    assert.match(outText, /漂移 1 檔/)
    assert.ok(outText.includes('lib.mjs'), `輸出應含 lib.mjs，實際：${outText}`)
  })

  test('setup --sync-check：刪 manifest ⇒ exit 2', () => {
    const repo = makeRepo()
    const snapshotDir = path.join(repo.dir, '.agents', 'skills', 'llm-team')
    fs.mkdirSync(snapshotDir, { recursive: true })

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--sync-check'], { repoRoot: repo.dir })
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2)
    assert.match(errs.join('\n'), /🔴 快照不存在或缺少 MANIFEST\.sha256/)
  })
})


