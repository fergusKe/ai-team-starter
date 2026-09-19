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
import { CLEAN_GIT_ENV, buildSafeCommandRegex, writeTreeOf, git, MEASUREMENT_SCHEMA_VERSION } from './lib.mjs'
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

  test('T17 --test 不受寫手 allow 限制：--test "bash home/skills/llm-team/test.sh" ⇒ run 往下走、writeMain 被呼叫（B4 已拔，2026-09-15）', async () => {
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
          't17',
          '--brief',
          briefFile,
          '--branch',
          'feat/t17--slice',
          '--allow',
          'a.txt',
          '--test',
          'bash home/skills/llm-team/test.sh',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(writeCalled, true, `writeMain 應被呼叫，實際 writeCalled 為 ${writeCalled}`)
    assert.equal(code, 0, `run 應成功執行完畢，實際 exit code 為 ${code}`)
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
      ['accept', '--name', 't25', '--caliber', 'tool', '--q6', '已確認 Q1 不影響主流程', '--disposition', 'agy/opus:Q1=rejected:"範圍縮減裁決"'],
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
      ['accept', '--name', 't33', '--caliber', 'tool', '--q6', '親自坐實', '--disposition', 'agy/opus:overall=rejected:"整體風險已控制"'],
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
    const writeOutDir = path.join(repo.dir, '.local', 'llm-team', 'p5t', 'write', 'run-1')
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

  function makeLandFixture({ name = 'tland', branch = 'feat/tland', changed = ['file.txt'] } = {}) {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', name)
    fs.mkdirSync(worktreePath, { recursive: true })
    for (const f of changed) {
      fs.mkdirSync(path.dirname(path.join(worktreePath, f)), { recursive: true })
      fs.writeFileSync(path.join(worktreePath, f), 'content')
    }

    const outDir = path.join(repo.dir, '.local', 'llm-team', name)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'brief.md'), `# Brief ${name}\n說明`)

    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: name,
      branch,
      base: 'main',
      roundStartSha: 'mock-round-start-sha',
      mergeBase: 'mock-merge-base-sha',
      targetTipSha: 'mock-target-tip-sha',
      writeExit: 0,
      rounds: 1,
      changed,
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
        reviewedTree: writeTreeOf(worktreePath),
      },
      q6Receipt: 'verified',
      coordinatorTurns: null,
      startedAt: '2026-09-13T00:00:00Z',
      finishedAt: '2026-09-13T00:05:00Z',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const msgFile = path.join(repo.dir, 'commit.msg')
    fs.writeFileSync(msgFile, `feat: ${name}\n`)

    return { repo, worktreePath, outDir, summary, msgFile }
  }

  test('T42 land (a)：主 checkout 不在 main ⇒ 2 且 git 沒有 add／merge', async () => {
    const { repo, msgFile } = makeLandFixture({ name: 't42' })
    const gitCalls = []
    const deps = {
      repoRoot: repo.dir,
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/other-branch'
        }
        return ''
      },
    }

    const code = await ticketMain(['land', '--name', 't42', '--msg-file', msgFile], deps)
    assert.equal(code, 2, `主 checkout 不在 main 時應回 2，實際為 ${code}`)
    const hasAdd = gitCalls.some((c) => c.args[0] === 'add')
    const hasMerge = gitCalls.some((c) => c.args[0] === 'merge')
    assert.equal(hasAdd, false, '不應呼叫 git add')
    assert.equal(hasMerge, false, '不應呼叫 git merge')
  })

  test('T43 land (b)：worktree 分支 ≠ summary.branch ⇒ 4 且無 add／merge', async () => {
    const { repo, worktreePath, msgFile } = makeLandFixture({ name: 't43', branch: 'feat/t43' })
    const gitCalls = []
    const deps = {
      repoRoot: repo.dir,
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/mismatched'
        }
        return ''
      },
    }

    const code = await ticketMain(['land', '--name', 't43', '--msg-file', msgFile], deps)
    assert.equal(code, 4, `worktree 分支不符時應回 4，實際為 ${code}`)
    const hasAdd = gitCalls.some((c) => c.args[0] === 'add')
    const hasMerge = gitCalls.some((c) => c.args[0] === 'merge')
    assert.equal(hasAdd, false, '不應呼叫 git add')
    assert.equal(hasMerge, false, '不應呼叫 git merge')
  })

  test('T44 land (c)：夾帶檔 ⇒ 4 且沒有 add', async () => {
    const { repo, worktreePath, msgFile } = makeLandFixture({ name: 't44', branch: 'feat/t44', changed: ['file.txt'] })
    const gitCalls = []
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt', 'decoy.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t44'
        }
        return ''
      },
    }

    const code = await ticketMain(['land', '--name', 't44', '--msg-file', msgFile], deps)
    assert.equal(code, 4, `有夾帶檔時應回 4，實際為 ${code}`)
    const hasAdd = gitCalls.some((c) => c.args[0] === 'add')
    assert.equal(hasAdd, false, '不應呼叫 git add')
  })

  test('T45 land (d)：正常路徑：add 逐檔 → commit -F → merge --ff-only → 回 0、stdout 最後一行 LANDED …、lifecycle 多一筆 landed', async () => {
    const { repo, worktreePath, outDir, msgFile } = makeLandFixture({
      name: 't45',
      branch: 'feat/t45',
      changed: ['file1.txt', 'file2.txt'],
    })
    const gitCalls = []
    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file1.txt', 'file2.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t45'
        }
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          return 'file1.txt\nfile2.txt'
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return 'new-main-sha-45'
        }
        if (args[0] === 'rev-parse' && args[1] === 'main') {
          return 'mock-target-tip-sha'
        }
        return ''
      },
    }

    let code
    try {
      code = await ticketMain(['land', '--name', 't45', '--msg-file', msgFile], deps)
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `正常落地應回 0，實際為 ${code}`)

    // 斷言呼叫了哪些 git 引數、順序
    const addCalls = gitCalls.filter((c) => c.args[0] === 'add')
    assert.equal(addCalls.length, 2, '應逐檔呼叫 add')
    assert.deepEqual(addCalls[0].args, ['add', '--', 'file1.txt'])
    assert.deepEqual(addCalls[1].args, ['add', '--', 'file2.txt'])
    assert.equal(addCalls[0].cwd, worktreePath)
    assert.equal(addCalls[1].cwd, worktreePath)

    const commitCall = gitCalls.find((c) => c.args[0] === 'commit')
    assert.ok(commitCall, '應呼叫 commit')
    assert.deepEqual(commitCall.args, ['commit', '-F', msgFile])
    assert.equal(commitCall.cwd, worktreePath)

    const mergeCall = gitCalls.find((c) => c.args[0] === 'merge')
    assert.ok(mergeCall, '應呼叫 merge')
    assert.deepEqual(mergeCall.args, ['merge', '--ff-only', 'feat/t45'])
    assert.equal(mergeCall.cwd, repo.dir)

    // 順序：add 逐檔在 commit 前，commit 在 merge 前
    const addIdx0 = gitCalls.indexOf(addCalls[0])
    const addIdx1 = gitCalls.indexOf(addCalls[1])
    const commitIdx = gitCalls.indexOf(commitCall)
    const mergeIdx = gitCalls.indexOf(mergeCall)
    assert.ok(addIdx0 < addIdx1 && addIdx1 < commitIdx && commitIdx < mergeIdx, 'git 呼叫順序應為 add -> commit -> merge')

    // 不准 push、不准刪 worktree／分支
    assert.equal(gitCalls.some((c) => c.args[0] === 'push'), false, '不准 push')
    assert.equal(gitCalls.some((c) => c.args[0] === 'branch' && c.args[1] === '-d'), false, '不准刪分支')
    assert.equal(gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove'), false, '不准 remove worktree')

    // stdout 最後一行 LANDED …
    const outText = outs.join('\n').trim()
    const outLines = outText.split('\n')
    assert.equal(outLines[outLines.length - 1], 'LANDED t45 feat/t45 new-main-sha-45')

    // lifecycle 多一筆 landed
    const lifecyclePath = path.join(outDir, 'lifecycle.ndjson')
    assert.ok(fs.existsSync(lifecyclePath), 'lifecycle.ndjson 應存在')
    const lines = fs.readFileSync(lifecyclePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const landedEntry = lines.find((e) => e.event === 'landed')
    assert.ok(landedEntry, 'lifecycle 應有 landed 事件')
    assert.equal(landedEntry.ticket, 't45')
    assert.equal(landedEntry.branch, 'feat/t45')
    assert.equal(landedEntry.sha, 'new-main-sha-45')
  })

  test('T46 land (e)：沒 staged 且 worktree HEAD＝main ⇒ 5、沒有 merge', async () => {
    const { repo, worktreePath, msgFile } = makeLandFixture({ name: 't46', branch: 'feat/t46', changed: ['file.txt'] })
    const gitCalls = []
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => [],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t46'
        }
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          return ''
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return 'same-sha'
        }
        return ''
      },
    }

    const code = await ticketMain(['land', '--name', 't46', '--msg-file', msgFile], deps)
    assert.equal(code, 5, `沒 staged 且 worktree HEAD 等於 main HEAD 時應回 5，實際為 ${code}`)
    const hasMerge = gitCalls.some((c) => c.args[0] === 'merge')
    assert.equal(hasMerge, false, '不應呼叫 git merge')
  })

  test('T47 land (f)：沒 staged 但分支領先 ⇒ 不 commit、有 merge、回 0', async () => {
    const { repo, worktreePath, outDir, msgFile } = makeLandFixture({ name: 't47', branch: 'feat/t47', changed: ['file.txt'] })
    const gitCalls = []
    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => [],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t47'
        }
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          return ''
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          if (cwd === worktreePath) return 'ahead-sha-47'
          const hasMerged = gitCalls.some((c) => c.args[0] === 'merge')
          return hasMerged ? 'ahead-sha-47' : 'behind-sha-47'
        }
        if (args[0] === 'rev-parse' && args[1] === 'main') {
          return 'mock-target-tip-sha'
        }
        return ''
      },
    }

    let code
    try {
      code = await ticketMain(['land', '--name', 't47', '--msg-file', msgFile], deps)
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `分支已領先時應回 0，實際為 ${code}`)
    const hasCommit = gitCalls.some((c) => c.args[0] === 'commit')
    assert.equal(hasCommit, false, '不應呼叫 git commit')
    const mergeCall = gitCalls.find((c) => c.args[0] === 'merge')
    assert.ok(mergeCall, '應呼叫 git merge')
    assert.deepEqual(mergeCall.args, ['merge', '--ff-only', 'feat/t47'])

    const outText = outs.join('\n').trim()
    assert.ok(outText.includes('分支已領先 main，視為已 commit 過'))
    assert.ok(outText.includes('LANDED t47 feat/t47 ahead-sha-47'))
  })

  test('T48 land (g)：ff-only 失敗 ⇒ 6 且訊息印 main 與 branch 的 sha', async () => {
    const { repo, worktreePath, msgFile } = makeLandFixture({ name: 't48', branch: 'feat/t48', changed: ['file.txt'] })
    const gitCalls = []
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t48'
        }
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          return 'file.txt'
        }
        if (args[0] === 'merge' && args[1] === '--ff-only') {
          throw new Error('fatal: Not possible to fast-forward, aborting.')
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return 'main-diverged-sha'
        }
        if (args[0] === 'rev-parse' && args[1] === 'feat/t48') {
          return 'branch-diverged-sha'
        }
        if (args[0] === 'rev-parse' && args[1] === 'main') {
          return 'mock-target-tip-sha'
        }
        return ''
      },
    }

    let code
    try {
      code = await ticketMain(['land', '--name', 't48', '--msg-file', msgFile], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 6, `ff-only 失敗時應回 6，實際為 ${code}`)
    const errText = errs.join('\n')
    assert.ok(errText.includes('main-diverged-sha'), `錯誤訊息應含 main sha，實際：${errText}`)
    assert.ok(errText.includes('branch-diverged-sha'), `錯誤訊息應含 branch sha，實際：${errText}`)
  })

  test('T49 land (h)：假 gitFn 對 diff --cached --name-only throw（訊息不含 fatal:，Error 無 status）⇒ main() reject 且無 commit／merge', async () => {
    const { repo, worktreePath, msgFile } = makeLandFixture({
      name: 't49',
      branch: 'feat/t49',
      changed: ['file.txt'],
    })
    const gitCalls = []
    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t49'
        }
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          throw new Error('error: cannot lock index file (index.lock exists)')
        }
        return ''
      },
    }

    await assert.rejects(
      async () => {
        await ticketMain(['land', '--name', 't49', '--msg-file', msgFile], deps)
      },
      (err) => {
        // 只驗「炸出來的是 mock 那顆錯」；mock 自己有沒有 status／fatal: 是 fixture 規格，不是契約（Gemini 第 2 輪 Q5）
        assert.match(err.message, /index\.lock/)
        return true
      }
    )

    const hasCommit = gitCalls.some((c) => c.args[0] === 'commit')
    const hasMerge = gitCalls.some((c) => c.args[0] === 'merge')
    assert.equal(hasCommit, false, 'git 呼叫序列裡不應有 commit')
    assert.equal(hasMerge, false, 'git 呼叫序列裡不應有 merge')
  })

  test('T50 land (i)：--name-only 回 空字串 且分支領先 ⇒ 不 commit、有 merge、回 0', async () => {
    const { repo, worktreePath, msgFile } = makeLandFixture({ name: 't50', branch: 'feat/t50', changed: ['file.txt'] })
    const gitCalls = []
    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => [],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t50'
        }
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          return ''
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          if (cwd === worktreePath) return 'ahead-sha-50'
          const hasMerged = gitCalls.some((c) => c.args[0] === 'merge')
          return hasMerged ? 'ahead-sha-50' : 'behind-sha-50'
        }
        if (args[0] === 'rev-parse' && args[1] === 'main') {
          return 'mock-target-tip-sha'
        }
        return ''
      },
    }

    let code
    try {
      code = await ticketMain(['land', '--name', 't50', '--msg-file', msgFile], deps)
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `分支已領先時應回 0，實際為 ${code}`)
    const hasCommit = gitCalls.some((c) => c.args[0] === 'commit')
    assert.equal(hasCommit, false, '不應呼叫 git commit')
    const mergeCall = gitCalls.find((c) => c.args[0] === 'merge')
    assert.ok(mergeCall, '應呼叫 git merge')
    assert.deepEqual(mergeCall.args, ['merge', '--ff-only', 'feat/t50'])
  })

  test('T57 land (j)：reviewedTree 缺（summary.review = null）⇒ 7、無 add／merge、stderr 含 reviewedTree', async () => {
    const { repo, worktreePath, outDir, msgFile } = makeLandFixture({ name: 't57', branch: 'feat/t57', changed: ['file.txt'] })
    const summaryPath = path.join(outDir, 'summary.json')
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    summary.review = null
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    const gitCalls = []
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t57'
        }
        return ''
      },
    }

    let code
    try {
      code = await ticketMain(['land', '--name', 't57', '--msg-file', msgFile], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 7, `reviewedTree 缺時應回 7，實際為 ${code}`)
    const hasAdd = gitCalls.some((c) => c.args[0] === 'add')
    assert.equal(hasAdd, false, `不應呼叫 git add，實際呼叫了: ${JSON.stringify(gitCalls.filter((c) => c.args[0] === 'add'))}`)
    const hasMerge = gitCalls.some((c) => c.args[0] === 'merge')
    assert.equal(hasMerge, false, `不應呼叫 git merge，實際呼叫了: ${JSON.stringify(gitCalls.filter((c) => c.args[0] === 'merge'))}`)
    const errText = errs.join('\n')
    assert.ok(errText.includes('reviewedTree'), `stderr 應含 reviewedTree，實際為: ${errText}`)
  })

  test('T58 land (k)：reviewedTree 不符（summary 寫假 40 hex）⇒ 7、無 merge、stderr 含兩個 tree sha', async () => {
    const { repo, worktreePath, outDir, msgFile } = makeLandFixture({ name: 't58', branch: 'feat/t58', changed: ['file.txt'] })
    const fakeTreeSha = '0123456789abcdef0123456789abcdef01234567'
    const summaryPath = path.join(outDir, 'summary.json')
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    summary.review.reviewedTree = fakeTreeSha
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    const actualTree = writeTreeOf(worktreePath)
    const gitCalls = []
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t58'
        }
        return ''
      },
    }

    let code
    try {
      code = await ticketMain(['land', '--name', 't58', '--msg-file', msgFile], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 7, `reviewedTree 不符時應回 7，實際為 ${code}`)
    const hasMerge = gitCalls.some((c) => c.args[0] === 'merge')
    assert.equal(hasMerge, false, `不應呼叫 git merge，實際呼叫了: ${JSON.stringify(gitCalls.filter((c) => c.args[0] === 'merge'))}`)
    const errText = errs.join('\n')
    assert.ok(errText.includes(fakeTreeSha), `stderr 應含假 tree sha (${fakeTreeSha})，實際為: ${errText}`)
    assert.ok(errText.includes(actualTree), `stderr 應含真實 tree sha (${actualTree})，實際為: ${errText}`)
  })

  test('T59 land (l)：target 前進且不相交 ⇒ 自動 rebase、回 0、LANDED、main HEAD 的父是前進後的 main、git diff --binary 含 bin.dat 與 new mode 100755、summary/lifecycle 記 landedAfterRebase、diff 逐字相等', async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'init a\n')
    fs.writeFileSync(path.join(repo.dir, 'run.sh'), '#!/bin/sh\necho hi\n')
    fs.chmodSync(path.join(repo.dir, 'run.sh'), 0o644)
    repo.g('add', 'a.txt', 'run.sh')
    repo.g('commit', '-m', 'init files')

    const targetTipSha = repo.g('rev-parse', 'main').trim()
    const mergeBase = targetTipSha

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't59')
    repo.g('worktree', 'add', '-b', 'feat/t59', worktreePath, 'main')

    fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ticket a content\n')
    fs.writeFileSync(path.join(worktreePath, 'bin.dat'), Buffer.from([0x00, 0x41, 0x42, 0x00, 0xff]))
    fs.chmodSync(path.join(worktreePath, 'run.sh'), 0o755)

    const changed = ['a.txt', 'bin.dat', 'run.sh']
    const reviewedTree = writeTreeOf(worktreePath)

    fs.writeFileSync(path.join(repo.dir, 'ledger.json'), '{"seen": 1}\n')
    repo.g('add', 'ledger.json')
    repo.g('commit', '-m', 'advance main: update ledger.json')
    const currentTarget = repo.g('rev-parse', 'main').trim()

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't59')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'brief.md'), '# Brief t59\n')

    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't59',
      branch: 'feat/t59',
      base: 'main',
      roundStartSha: targetTipSha,
      mergeBase,
      targetTipSha,
      writeExit: 0,
      rounds: 1,
      changed,
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
        reviewedTree,
      },
      q6Receipt: 'verified',
      coordinatorTurns: null,
      startedAt: '2026-09-13T00:00:00Z',
      finishedAt: '2026-09-13T00:05:00Z',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const msgFile = path.join(repo.dir, 'commit.msg')
    fs.writeFileSync(msgFile, 'feat: t59\n')

    const outs = []
    const errs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => outs.push(String(m))
    console.error = (m) => errs.push(String(m))

    let diffBeforeRebase = null
    let diffAfterRebase = null
    const deps = {
      repoRoot: repo.dir,
      git: (cwd, args) => {
        if (args[0] === 'rebase' && !args.includes('--abort')) {
          diffBeforeRebase = execFileSync(
            'git',
            ['-C', cwd, 'diff', '--binary', '--full-index', '--no-renames', targetTipSha, 'HEAD'],
            { env: CLEAN_GIT_ENV, encoding: 'utf8' }
          ).trim()
        }
        const res = git(cwd, args)
        if (args[0] === 'rebase' && !args.includes('--abort')) {
          diffAfterRebase = execFileSync(
            'git',
            ['-C', cwd, 'diff', '--binary', '--full-index', '--no-renames', currentTarget, 'HEAD'],
            { env: CLEAN_GIT_ENV, encoding: 'utf8' }
          ).trim()
        }
        return res
      },
    }

    let code
    try {
      code = await ticketMain(['land', '--name', 't59', '--msg-file', msgFile], deps)
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 0, `target 前進且不相交時應回 0，實際為 ${code}`)
    assert.ok(diffBeforeRebase !== null, `diffBeforeRebase 應有值，實際為 ${diffBeforeRebase}`)
    assert.ok(diffAfterRebase !== null, `diffAfterRebase 應有值，實際為 ${diffAfterRebase}`)
    assert.equal(diffBeforeRebase, diffAfterRebase, `rebase 前後 diff 應逐字相等，實際長度: ${diffBeforeRebase.length} vs ${diffAfterRebase.length}`)

    const outText = outs.join('\n')
    assert.ok(outText.includes('LANDED t59 feat/t59'), `stdout 應含 LANDED，實際為: ${outText}`)
    assert.ok(
      outText.includes(`↻ target 前進（不相交）：已 rebase ${targetTipSha}→${currentTarget}，變更逐 byte 相同`),
      `stdout 應含 rebase 成功行，實際為: ${outText}`
    )

    const mainParent = repo.g('rev-parse', 'main~1').trim()
    assert.equal(mainParent, currentTarget, `main HEAD 的父應是前進後的 main (${currentTarget})，實際為 ${mainParent}`)

    const finalDiff = repo.g('diff', '--binary', 'main~1', 'main')
    assert.ok(finalDiff.includes('bin.dat'), `git diff --binary main~1 main 應含 bin.dat，實際為: ${finalDiff}`)
    assert.ok(finalDiff.includes('new mode 100755'), `git diff --binary main~1 main 應含 new mode 100755，實際為: ${finalDiff}`)

    const diskSummary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(
      diskSummary.landedAfterRebase.targetTipAtRun,
      mergeBase,
      `landedAfterRebase.targetTipAtRun 應等於 mergeBase (${mergeBase})，實際為: ${diskSummary.landedAfterRebase?.targetTipAtRun}`
    )
    assert.deepEqual(
      diskSummary.landedAfterRebase,
      { from: targetTipSha, to: currentTarget, advancedFiles: ['ledger.json'], targetTipAtRun: mergeBase },
      `summary.json landedAfterRebase 應正確，實際為: ${JSON.stringify(diskSummary.landedAfterRebase)}`
    )

    const lifecycleLines = fs
      .readFileSync(path.join(outDir, 'lifecycle.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const landedEvent = lifecycleLines.find((e) => e.event === 'landed')
    assert.ok(landedEvent, `lifecycle 應有 landed 事件，實際事件列表: ${JSON.stringify(lifecycleLines.map((e) => e.event))}`)
    assert.deepEqual(
      landedEvent.landedAfterRebase,
      { from: targetTipSha, to: currentTarget, advancedFiles: ['ledger.json'], targetTipAtRun: mergeBase },
      `lifecycle landed 事件應含 landedAfterRebase，實際為: ${JSON.stringify(landedEvent.landedAfterRebase)}`
    )
  })

  test('T60 land (m)：target 前進且相交（main 也改 a.txt）⇒ 8、worktree HEAD 不變（沒 rebase）、無 merge、stderr 含三個 sha、含 a.txt、含 rebase', async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'init a\n')
    repo.g('add', 'a.txt')
    repo.g('commit', '-m', 'init a.txt')

    const targetTipSha = repo.g('rev-parse', 'main').trim()
    const mergeBase = targetTipSha

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't60')
    repo.g('worktree', 'add', '-b', 'feat/t60', worktreePath, 'main')

    fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ticket changed a\n')
    const reviewedTree = writeTreeOf(worktreePath)

    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'main changed a\n')
    repo.g('add', 'a.txt')
    repo.g('commit', '-m', 'main changed a')
    const currentTarget = repo.g('rev-parse', 'main').trim()

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't60')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'brief.md'), '# Brief t60\n')

    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't60',
      branch: 'feat/t60',
      base: 'main',
      roundStartSha: targetTipSha,
      mergeBase,
      targetTipSha,
      writeExit: 0,
      rounds: 1,
      changed: ['a.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
        reviewedTree,
      },
      q6Receipt: 'verified',
      coordinatorTurns: null,
      startedAt: '2026-09-13T00:00:00Z',
      finishedAt: '2026-09-13T00:05:00Z',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const msgFile = path.join(repo.dir, 'commit.msg')
    fs.writeFileSync(msgFile, 'feat: t60\n')

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))

    let code
    try {
      code = await ticketMain(['land', '--name', 't60', '--msg-file', msgFile], { repoRoot: repo.dir })
    } finally {
      console.error = origErr
    }

    assert.equal(code, 8, `相交時應回 8，實際為 ${code}`)

    const mainHeadAfter = repo.g('rev-parse', 'main').trim()
    assert.equal(mainHeadAfter, currentTarget, `main HEAD 不應被 merge，仍應為 ${currentTarget}，實際為 ${mainHeadAfter}`)

    const wtHead = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { env: CLEAN_GIT_ENV, encoding: 'utf8' }).trim()
    const wtParent = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD~1'], { env: CLEAN_GIT_ENV, encoding: 'utf8' }).trim()
    assert.equal(wtParent, targetTipSha, `worktree commit 的父仍應為 targetTipSha (${targetTipSha})，實際為 ${wtParent}`)

    const errText = errs.join('\n')
    assert.ok(errText.includes(targetTipSha), `stderr 應含 targetTipSha (${targetTipSha})，實際為: ${errText}`)
    assert.ok(errText.includes(currentTarget), `stderr 應含 currentTarget (${currentTarget})，實際為: ${errText}`)
    assert.ok(errText.includes(wtHead), `stderr 應含 ticket HEAD (${wtHead})，實際為: ${errText}`)
    assert.ok(errText.includes('a.txt'), `stderr 應含 a.txt，實際為: ${errText}`)
    assert.ok(errText.includes('rebase'), `stderr 應含 rebase，實際為: ${errText}`)
  })

  test('T61 land (n)：假 gitFn：讓 rebase 後的 diff --binary 回不同字串 ⇒ 8、無 merge、stderr 含 逐 byte', async () => {
    const { repo, worktreePath, outDir, msgFile } = makeLandFixture({
      name: 't61',
      branch: 'feat/t61',
      changed: ['a.txt'],
    })
    const targetTipSha = 'mock-target-tip-61'
    const currentTargetSha = 'mock-current-target-61'
    const mergeBase = 'mock-merge-base-61'
    const summaryPath = path.join(outDir, 'summary.json')
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    summary.targetTipSha = targetTipSha
    summary.mergeBase = mergeBase
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    const gitCalls = []
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['a.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t61'
        }
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === 'main') {
          return currentTargetSha
        }
        if (cwd === repo.dir && args[0] === 'diff' && args[1] === '--name-only') {
          return 'ledger.json'
        }
        if (cwd === worktreePath && args[0] === 'diff' && args[1] === '--name-only') {
          return 'a.txt'
        }
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          return 'a.txt'
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return 'ticket-head-61'
        }
        if (args[0] === 'rebase') {
          return ''
        }
        if (args[0] === 'diff' && args[1] === '--binary') {
          if (args[4] === targetTipSha) return 'binary-diff-before'
          if (args[4] === currentTargetSha) return 'binary-diff-after-MUTATED'
        }
        return ''
      },
    }

    let code
    try {
      code = await ticketMain(['land', '--name', 't61', '--msg-file', msgFile], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 8, `diff 不逐 byte 相等時應回 8，實際為 ${code}`)
    const hasMerge = gitCalls.some((c) => c.args[0] === 'merge')
    assert.equal(hasMerge, false, `不應呼叫 git merge，實際呼叫了: ${JSON.stringify(gitCalls.filter((c) => c.args[0] === 'merge'))}`)
    const errText = errs.join('\n')
    assert.ok(errText.includes('逐 byte'), `stderr 應含「逐 byte」，實際為: ${errText}`)
  })

  test('T62 land (o)：summary.json 寫回 landedAfterRebase 失敗 ⇒ 回 8、無 merge（main HEAD 不變）、stderr 含 寫回 landedAfterRebase 失敗', async () => {
    const { repo, worktreePath, outDir, msgFile } = makeLandFixture({
      name: 't62',
      branch: 'feat/t62',
      changed: ['a.txt'],
    })
    const mainHeadBefore = repo.g('rev-parse', 'main').trim()
    const targetTipSha = 'mock-target-tip-62'
    const currentTargetSha = 'mock-current-target-62'
    const mergeBase = 'mock-merge-base-62'
    const summaryPath = path.join(outDir, 'summary.json')
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    summary.targetTipSha = targetTipSha
    summary.mergeBase = mergeBase
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    const gitCalls = []
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['a.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t62'
        }
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === 'main') {
          return currentTargetSha
        }
        if (cwd === repo.dir && args[0] === 'diff' && args[1] === '--name-only') {
          return 'ledger.json'
        }
        if (cwd === worktreePath && args[0] === 'diff' && args[1] === '--name-only') {
          return 'a.txt'
        }
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          return 'a.txt'
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return 'ticket-head-62'
        }
        if (args[0] === 'rebase') {
          return ''
        }
        if (args[0] === 'diff' && args[1] === '--binary') {
          return 'binary-diff-identical'
        }
        return ''
      },
    }

    fs.chmodSync(summaryPath, 0o444)
    let code
    try {
      code = await ticketMain(['land', '--name', 't62', '--msg-file', msgFile], deps)
    } finally {
      try {
        fs.chmodSync(summaryPath, 0o644)
      } catch {}
      console.error = origErr
    }

    assert.equal(code, 8, `寫回失敗應回 8，實際為 ${code}`)
    const hasMerge = gitCalls.some((c) => c.args[0] === 'merge')
    assert.equal(hasMerge, false, `不應呼叫 git merge，實際呼叫了: ${JSON.stringify(gitCalls.filter((c) => c.args[0] === 'merge'))}`)
    const mainHeadAfter = repo.g('rev-parse', 'main').trim()
    assert.equal(mainHeadAfter, mainHeadBefore, `main HEAD 不應前進，仍應為 ${mainHeadBefore}`)
    const errText = errs.join('\n')
    assert.ok(errText.includes('寫回 landedAfterRebase 失敗'), `stderr 應含「寫回 landedAfterRebase 失敗」，實際為: ${errText}`)
  })

  test('T63 publish（review: null）：publish 對 review: null 的 summary 回 2 且 stderr 不含 reviewedTree，證明 review 缺的判定沒有洩進 publish', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't63')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't63')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't63',
      branch: 'feat/t63--slice',
      base: 'main',
      writeExit: 0,
      rounds: 1,
      changed: ['file.txt'],
      verifyExit: 0,
      review: null,
      q6Receipt: 'verified ok',
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
          if (args[0] === '--version') return { status: 0, stdout: 'gh version 2.0' }
          return { status: 0, stdout: 'https://github.com/org/repo/pull/63' }
        }
        return { status: 0, stdout: '' }
      },
    }

    const errs = []
    const origErr = console.error
    const origLog = console.log
    console.error = (m) => errs.push(String(m))
    console.log = () => {}
    let code
    try {
      code = await ticketMain(['publish', '--name', 't63'], deps)
    } finally {
      console.error = origErr
      console.log = origLog
    }

    assert.equal(code, 2, `publish 對 review: null 應回 2，實際為 ${code}`)
    assert.equal(ghCalled, false, 'gh 不應被呼叫')
    const errText = errs.join('\n')
    assert.equal(errText.includes('reviewedTree'), false, `stderr 不應含 reviewedTree，實際為: ${errText}`)
  })

  test('T64 land (p)：review 缺（summary.review = null）⇒ 7 且 stderr 只出現一次 reviewedTree，無 add／merge、不印 helper 法定人數訊息', async () => {
    const { repo, worktreePath, outDir, msgFile } = makeLandFixture({ name: 't64', branch: 'feat/t64', changed: ['file.txt'] })
    const summaryPath = path.join(outDir, 'summary.json')
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    summary.review = null
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    const gitCalls = []
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))

    const deps = {
      repoRoot: repo.dir,
      changedFiles: () => ['file.txt'],
      git: (cwd, args) => {
        gitCalls.push({ cwd, args })
        if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main'
        }
        if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'feat/t64'
        }
        return ''
      },
    }

    let code
    try {
      code = await ticketMain(['land', '--name', 't64', '--msg-file', msgFile], deps)
    } finally {
      console.error = origErr
    }

    assert.equal(code, 7, `review 為 null 時應回 7，實際為 ${code}`)
    const hasAdd = gitCalls.some((c) => c.args[0] === 'add')
    assert.equal(hasAdd, false, `不應呼叫 git add，實際呼叫了: ${JSON.stringify(gitCalls.filter((c) => c.args[0] === 'add'))}`)
    const hasMerge = gitCalls.some((c) => c.args[0] === 'merge')
    assert.equal(hasMerge, false, `不應呼叫 git merge，實際呼叫了: ${JSON.stringify(gitCalls.filter((c) => c.args[0] === 'merge'))}`)
    const errText = errs.join('\n')
    const occurrences = (errText.match(/reviewedTree/g) || []).length
    assert.equal(occurrences, 1, `stderr 應恰出現一次 reviewedTree，實際出現 ${occurrences} 次: ${errText}`)
    assert.equal(errText.includes('複審成員或名單為空'), false, `stderr 不應含 helper 法定人數訊息，實際為: ${errText}`)
  })

  test('T65 run 後 OUTDIR/verify.txt 存在且內容＝假 runTest 回的 out、summary.verifyLog 為 verify.txt', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試票\n`grep -e "a" a.txt`\n')

    const outDir = path.resolve(repo.dir, '.local/llm-team/t65')
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        const worktreePath = path.resolve(repo.dir, '.claude/worktrees/t65')
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ok\n')
        return 0
      },
      runTest: () => ({ exit: 1, out: 'FAKE-RED' }),
      councilMain: () => {
        const reviewOutDir = path.resolve(repo.dir, '.local/llm-team/t65/review')
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
    }

    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't65',
          '--brief',
          briefFile,
          '--branch',
          'feat/t65',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 3, `verifyExit 非 0 時 run 應回 3，實際得到 ${code}`)
    const verifyTxtPath = path.join(outDir, 'verify.txt')
    assert.ok(fs.existsSync(verifyTxtPath), 'OUTDIR/verify.txt 應存在')
    assert.equal(fs.readFileSync(verifyTxtPath, 'utf8'), 'FAKE-RED')
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(summary.verifyLog, 'verify.txt')
  })

  test('T66 假 writeMain 在 write/ 產生 round-1.response.md＋round-2.response.md（round-2 內容 REPORT-2），攔 councilMain args ⇒ 含 --writer-report 且指向 round-2 那個檔；沒有 response 檔 ⇒ args 不含 --writer-report', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試票\n`grep -e "a" a.txt`\n')

    // 1. 有 response 檔的情形
    let interceptedCouncilArgs = null
    const depsWithReports = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        const worktreePath = path.resolve(repo.dir, '.claude/worktrees/t66')
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ok\n')
        const writeDir = path.resolve(repo.dir, '.local/llm-team/t66/write/run-1')
        fs.mkdirSync(writeDir, { recursive: true })
        fs.writeFileSync(path.join(writeDir, 'round-1.response.md'), 'REPORT-1')
        fs.writeFileSync(path.join(writeDir, 'round-2.response.md'), 'REPORT-2')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: (args) => {
        interceptedCouncilArgs = args
        const reviewOutDir = path.resolve(repo.dir, '.local/llm-team/t66/review')
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
    }

    const origLog = console.log
    console.log = () => {}
    try {
      await ticketMain(
        [
          'run',
          '--name',
          't66',
          '--brief',
          briefFile,
          '--branch',
          'feat/t66',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        depsWithReports
      )
    } finally {
      console.log = origLog
    }

    assert.ok(interceptedCouncilArgs, 'councilMain 應被呼叫')
    assert.ok(interceptedCouncilArgs.includes('--writer-report'), 'councilArgs 應含 --writer-report')
    const reportIdx = interceptedCouncilArgs.indexOf('--writer-report')
    const expectedRound2Path = path.resolve(repo.dir, '.local/llm-team/t66/write/run-1/round-2.response.md')
    assert.equal(interceptedCouncilArgs[reportIdx + 1], expectedRound2Path, `應指向 round-2 那個檔，實際為: ${interceptedCouncilArgs[reportIdx + 1]}`)

    // 2. 沒有 response 檔的情形
    let interceptedCouncilArgsNoReport = null
    const depsWithoutReports = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        const worktreePath = path.resolve(repo.dir, '.claude/worktrees/t66b')
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ok\n')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: (args) => {
        interceptedCouncilArgsNoReport = args
        const reviewOutDir = path.resolve(repo.dir, '.local/llm-team/t66b/review')
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
    }

    try {
      await ticketMain(
        [
          'run',
          '--name',
          't66b',
          '--brief',
          briefFile,
          '--branch',
          'feat/t66b',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        depsWithoutReports
      )
    } finally {
      console.log = origLog
    }

    assert.ok(interceptedCouncilArgsNoReport, 'councilMain 應被呼叫')
    assert.equal(interceptedCouncilArgsNoReport.includes('--writer-report'), false, '沒有 response 檔時 councilArgs 不應含 --writer-report')
  })

  test('T67 land：多輪票事故重現（main 在 run 之前前進）⇒ 閘 B 依 mergeBase 判定 target 前進並自動 rebase、回 0、LANDED、main HEAD 的父是前進後的 main、landedAfterRebase 正確', async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'init a\n')
    repo.g('add', 'a.txt')
    repo.g('commit', '-m', 'init a')
    const mergeBase = repo.g('rev-parse', 'main').trim()

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't67')
    repo.g('worktree', 'add', '-b', 'feat/t67', worktreePath, 'main')

    // main 先前進（commit ledger.json）
    fs.writeFileSync(path.join(repo.dir, 'ledger.json'), '{"seen": 1}\n')
    repo.g('add', 'ledger.json')
    repo.g('commit', '-m', 'advance main: update ledger.json')
    const advancedMain = repo.g('rev-parse', 'main').trim()

    // 然後才跑 run
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# Brief t67\n`grep -e "a" a.txt`\n')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't67')
    const reviewOutDir = path.join(outDir, 'review')
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ticket a content\n')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: () => {
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\n',
          'agy-gemini': '整份：簽\n',
        })
        return 0
      },
    }

    const origLog = console.log
    const origErr = console.error
    const outs = []
    const errs = []
    console.log = (m) => outs.push(String(m))
    console.error = (m) => errs.push(String(m))

    let runCode
    try {
      runCode = await ticketMain(
        [
          'run',
          '--name',
          't67',
          '--brief',
          briefFile,
          '--branch',
          'feat/t67',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(runCode, 0, `run 應成功回 0，實際為 ${runCode}`)

    const runSummary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(runSummary.targetTipSha, advancedMain, `summary.targetTipSha 應為現在的 main (${advancedMain})`)
    assert.equal(runSummary.mergeBase, mergeBase, `summary.mergeBase 應為舊 main (${mergeBase})`)
    assert.ok(runSummary.review?.reviewedTree, 'summary 應有 review.reviewedTree')
    runSummary.q6Receipt = 'verified'
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(runSummary, null, 2))

    // 接著 land
    const msgFile = path.join(repo.dir, 'commit.msg')
    fs.writeFileSync(msgFile, 'feat: t67\n')

    outs.length = 0
    errs.length = 0
    console.log = (m) => outs.push(String(m))
    console.error = (m) => errs.push(String(m))

    let landCode
    try {
      landCode = await ticketMain(['land', '--name', 't67', '--msg-file', msgFile], { repoRoot: repo.dir })
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(landCode, 0, `land 應回 0，實際為 ${landCode}`)
    const outText = outs.join('\n')
    assert.ok(outText.includes('LANDED t67 feat/t67'), `stdout 應含 LANDED，實際為: ${outText}`)

    const mainParent = repo.g('rev-parse', 'main~1').trim()
    assert.equal(mainParent, advancedMain, `main HEAD 的父應是前進後的 main (${advancedMain})，實際為 ${mainParent}`)

    const diskSummary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(diskSummary.landedAfterRebase.from, mergeBase, `landedAfterRebase.from 應等於 mergeBase (${mergeBase})`)
    assert.equal(diskSummary.landedAfterRebase.to, advancedMain, `landedAfterRebase.to 應等於前進後的 main (${advancedMain})`)
    assert.equal(
      diskSummary.landedAfterRebase.targetTipAtRun,
      advancedMain,
      `landedAfterRebase.targetTipAtRun 應等於 run 當時的 main (${advancedMain})`
    )
    assert.ok(
      diskSummary.landedAfterRebase.advancedFiles.includes('ledger.json'),
      `advancedFiles 應含 ledger.json，實際為: ${JSON.stringify(diskSummary.landedAfterRebase.advancedFiles)}`
    )
  })

  test('T68 land：同 T67 但 main 前進的 commit 也改 a.txt ⇒ 8、無 merge、stderr 含 a.txt 與 merge-base 的 sha', async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'init a\n')
    repo.g('add', 'a.txt')
    repo.g('commit', '-m', 'init a')
    const mergeBase = repo.g('rev-parse', 'main').trim()

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't68')
    repo.g('worktree', 'add', '-b', 'feat/t68', worktreePath, 'main')

    // main 前進的 commit 也改 a.txt
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'main conflict in a\n')
    repo.g('add', 'a.txt')
    repo.g('commit', '-m', 'advance main: conflict in a.txt')
    const advancedMain = repo.g('rev-parse', 'main').trim()

    // 然後才跑 run
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# Brief t68\n`grep -e "a" a.txt`\n')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't68')
    const reviewOutDir = path.join(outDir, 'review')
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'ticket a content\n')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: () => {
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\n',
          'agy-gemini': '整份：簽\n',
        })
        return 0
      },
    }

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}

    let runCode
    try {
      runCode = await ticketMain(
        [
          'run',
          '--name',
          't68',
          '--brief',
          briefFile,
          '--branch',
          'feat/t68',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(runCode, 0, `run 應成功回 0，實際為 ${runCode}`)

    const runSummary68 = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    runSummary68.q6Receipt = 'verified'
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(runSummary68, null, 2))

    // 接著 land
    const msgFile = path.join(repo.dir, 'commit.msg')
    fs.writeFileSync(msgFile, 'feat: t68\n')

    const errs = []
    console.error = (m) => errs.push(String(m))

    let landCode
    try {
      landCode = await ticketMain(['land', '--name', 't68', '--msg-file', msgFile], { repoRoot: repo.dir })
    } finally {
      console.error = origErr
    }

    assert.equal(landCode, 8, `相交時 land 應回 8，實際為 ${landCode}`)

    const mainHeadAfter = repo.g('rev-parse', 'main').trim()
    assert.equal(mainHeadAfter, advancedMain, `main HEAD 不應被 merge，仍應為 ${advancedMain}，實際為 ${mainHeadAfter}`)

    const errText = errs.join('\n')
    assert.ok(errText.includes('a.txt'), `stderr 應含 a.txt，實際為: ${errText}`)
    assert.ok(errText.includes(mergeBase), `stderr 應含 merge-base sha (${mergeBase})，實際為: ${errText}`)
  })

  test('1.8.0 ⑥ (a)(b) land 真 git：分支上已 commit 刪除一檔（review-only 多輪票事故重現）＋另一檔有未 commit 修改，兩者都在 summary.changed ⇒ land 走到 ff 成功，刪除檔跳過 add、修改檔仍被 add 進 commit', async () => {
    // 🔴 事故重現：2026-09-17 WAS review-only 多輪票，寫手已經在分支上 commit 刪除整個目錄
    //   （scripts/__tests__/spec-lint-corpus.test.mjs 連同 scripts/__tests__/ 一起消失），summary.changed 仍列著它
    //   （因為它是 mergeBase..HEAD diff 的一部分）；land 對它無條件 `git add -- f` ⇒ `fatal: pathspec … did not
    //   match any files`，land 永遠卡在 exit 4，走不到「分支已領先 main，視為已 commit 過」。
    //   陽性對照：把 ticket.mjs 這次的修法整段拿掉（恢復無條件 `git add -- f`），本測試應改回 exit 4。
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'init a\n')
    fs.writeFileSync(path.join(repo.dir, 'b.txt'), 'init b\n')
    repo.g('add', 'a.txt', 'b.txt')
    repo.g('commit', '-m', 'init a+b')
    const mergeBase = repo.g('rev-parse', 'main').trim()

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't-del')
    repo.g('worktree', 'add', '-b', 'feat/t-del', worktreePath, 'main')

    // 模擬 review-only 多輪票：寫手已經在分支上「commit 刪除」b.txt（整個檔案消失，不是待 add 的 pending 刪除）
    execFileSync('git', ['-C', worktreePath, 'rm', 'b.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'chore: remove b.txt'], { env: CLEAN_GIT_ENV })

    // (b) a.txt 有未 commit 的修改（真正待 add 的檔，不該被本次修法連帶跳過）
    fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'modified a\n')

    const reviewedTree = writeTreeOf(worktreePath)

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't-del')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't-del',
      branch: 'feat/t-del',
      base: 'main',
      mergeBase,
      targetTipSha: mergeBase,
      writeExit: 0,
      rounds: 1,
      changed: ['b.txt', 'a.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
        reviewedTree,
      },
      q6Receipt: 'verified',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const msgFile = path.join(repo.dir, 'commit.msg')
    fs.writeFileSync(msgFile, 'feat: t-del\n')

    const outs = []
    const errs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => outs.push(String(m))
    console.error = (m) => errs.push(String(m))
    let landCode
    try {
      landCode = await ticketMain(['land', '--name', 't-del', '--msg-file', msgFile], { repoRoot: repo.dir })
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(landCode, 0, `land 應成功回 0（陽性對照：拿掉本次修法會回 4），實際為 ${landCode}，stderr：${errs.join('\n')}`)
    assert.ok(outs.join('\n').includes('LANDED t-del feat/t-del'), `stdout 應含 LANDED，實際：${outs.join('\n')}`)

    // main 併入後：(a) b.txt 真的不見了（刪除檔跳過 add 沒有卡住整個流程）；
    //             (b) a.txt 是修改後內容（修改檔確實仍被 add 進最後一次 commit，不是被本次修法連帶吞掉）
    assert.equal(fs.existsSync(path.join(repo.dir, 'b.txt')), false, 'main 上 b.txt 應已刪除')
    assert.equal(
      fs.readFileSync(path.join(repo.dir, 'a.txt'), 'utf8'),
      'modified a\n',
      'main 上 a.txt 應是修改後內容（證明它真的被 add 進最後一次 commit）'
    )
  })

  test('1.8.0 ⑥ (c) 陽性對照：add 真失敗（檔案仍在但被 .gitignore 擋）⇒ 仍回 4，不被本次修法吞掉', async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'init a\n')
    // .gitignore 在 main 上先 commit 好（不能算「run 之後才出現的檔」，否則會撞另一道閘而不是本次要測的路徑）
    fs.writeFileSync(path.join(repo.dir, '.gitignore'), 'ignored.txt\n')
    repo.g('add', 'a.txt', '.gitignore')
    repo.g('commit', '-m', 'init a + gitignore')
    const mergeBase = repo.g('rev-parse', 'main').trim()

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't-ignored')
    repo.g('worktree', 'add', '-b', 'feat/t-ignored', worktreePath, 'main')

    // ignored.txt 真的存在於工作樹，但被（繼承自 main 的）.gitignore 擋——git status 預設不會列出被忽略的檔，
    // 所以它不會被判成「run 之後才出現的檔」；真正卡關的是 add 本身會失敗（不是「沒東西可 add」）。
    fs.writeFileSync(path.join(worktreePath, 'ignored.txt'), 'should not be added\n')

    const reviewedTree = writeTreeOf(worktreePath)

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't-ignored')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't-ignored',
      branch: 'feat/t-ignored',
      base: 'main',
      mergeBase,
      targetTipSha: mergeBase,
      writeExit: 0,
      rounds: 1,
      changed: ['ignored.txt'],
      verifyExit: 0,
      review: {
        tier: 'standard',
        members: reviewFixture(outDir, [
          { name: 'agy/opus', overall: '簽' },
          { name: 'agy/gemini', overall: '簽' },
        ]),
        anyEmpty: false,
        reviewedTree,
      },
      q6Receipt: 'verified',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const msgFile = path.join(repo.dir, 'commit.msg')
    fs.writeFileSync(msgFile, 'feat: t-ignored\n')

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let landCode
    try {
      landCode = await ticketMain(['land', '--name', 't-ignored', '--msg-file', msgFile], { repoRoot: repo.dir })
    } finally {
      console.error = origErr
    }

    assert.equal(landCode, 4, `add 真失敗時仍應回 4，實際為 ${landCode}`)
    assert.match(errs.join('\n'), /git add 失敗（ignored\.txt）/, `stderr 應指名是 ignored.txt 的 add 失敗，實際：${errs.join('\n')}`)
    const mainHeadAfter = repo.g('rev-parse', 'main').trim()
    assert.equal(mainHeadAfter, mergeBase, 'main 不應被 merge（add 失敗要在 commit 之前就擋下）')
  })

  test('T69 run --review-only happy path：worktree 存在且領先 merge-base ⇒ 回 0、writeMain 0 次、councilMain 1 次且 --round-start 為 merge-base、summary 與 lifecycle 符合 review-only', async () => {
    const repo = makeRepo()
    const mergeBaseSha = repo.g('rev-parse', 'main').trim()

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't69')
    repo.g('worktree', 'add', '-b', 'feat/t69', worktreePath, 'main')
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello from worktree\n')
    execFileSync('git', ['-C', worktreePath, 'add', 'feature.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'feat: worktree commit'], { env: CLEAN_GIT_ENV })

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T69\n`grep -e "hello" feature.txt`\n')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't69')
    const reviewOutDir = path.join(outDir, 'review')

    let writeCount = 0
    let councilCount = 0
    let interceptedCouncilArgs = null
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCount++
        return 0
      },
      councilMain: async (args) => {
        councilCount++
        interceptedCouncilArgs = args
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\nQ6：確認 feature.txt',
          'agy-gemini': '整份：簽\nQ6：確認編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't69',
          '--brief',
          briefFile,
          '--branch',
          'feat/t69',
          '--allow',
          'feature.txt',
          '--test',
          'node --test',
          '--review-only',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 0, `run 應回 0，實際為 ${code}`)
    assert.equal(writeCount, 0, `writeMain 呼叫次數應為 0，實際為 ${writeCount}`)
    assert.equal(councilCount, 1, `councilMain 呼叫次數應為 1，實際為 ${councilCount}`)
    assert.ok(interceptedCouncilArgs, `councilMain 應被呼叫並傳入 args，實際為 ${interceptedCouncilArgs}`)
    const roundStartIdx = interceptedCouncilArgs ? interceptedCouncilArgs.indexOf('--round-start') : -1
    assert.notEqual(roundStartIdx, -1, `councilArgs 應含 --round-start，實際 args: ${JSON.stringify(interceptedCouncilArgs)}`)
    const roundStartVal = interceptedCouncilArgs[roundStartIdx + 1]
    assert.equal(roundStartVal, mergeBaseSha, `councilArgs 的 --round-start 應為 merge-base sha (${mergeBaseSha})，實際為 ${roundStartVal}`)

    const summaryPath = path.join(outDir, 'summary.json')
    assert.ok(fs.existsSync(summaryPath), `summary.json 應存在於 ${summaryPath}`)
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    assert.equal(summary.reviewOnly, true, `summary.reviewOnly 應為 true，實際為 ${summary.reviewOnly}`)
    assert.equal(summary.writeExit, null, `summary.writeExit 應為 null，實際為 ${summary.writeExit}`)
    assert.notEqual(summary.review, null, `summary.review 不應為 null，實際為 ${JSON.stringify(summary.review)}`)

    const lifecyclePath = path.join(outDir, 'lifecycle.ndjson')
    assert.ok(fs.existsSync(lifecyclePath), `lifecycle.ndjson 應存在於 ${lifecyclePath}`)
    const events = fs
      .readFileSync(lifecyclePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const runStartEvent = events.find((e) => e.event === 'run-start')
    assert.ok(runStartEvent, `lifecycle 應含 run-start 事件，實際事件為: ${JSON.stringify(events.map((e) => e.event))}`)
    assert.equal(runStartEvent.reviewOnly, true, `run-start 事件的 reviewOnly 應為 true，實際為 ${runStartEvent.reviewOnly}`)
    const hasReviewDone = events.some((e) => e.event === 'review-done')
    assert.equal(hasReviewDone, true, `lifecycle 應含 review-done 事件，實際事件為: ${JSON.stringify(events.map((e) => e.event))}`)
    const writerDoneEntries = events.filter((e) => e.event === 'writer-done')
    assert.equal(writerDoneEntries.length, 0, `lifecycle 不應有任何 writer-done 事件，實際有 ${writerDoneEntries.length} 筆`)
  })

  test('T70 run --review-only 前置檢查：(a) worktree 不存在 ⇒ 2、不建 worktree、假函式 0 次；(b) worktree 不乾淨 ⇒ 2、假函式 0 次', async () => {
    // (a) worktree 不存在
    const repoA = makeRepo()
    const worktreePathA = path.join(repoA.dir, '.claude', 'worktrees', 't70a')
    const briefFileA = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFileA, '# T70a\n`grep -e "x" a.txt`\n')

    let writeCountA = 0
    let councilCountA = 0
    const depsA = {
      repoRoot: repoA.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCountA++
        return 0
      },
      councilMain: () => {
        councilCountA++
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    const origErr = console.error
    const errsA = []
    console.log = () => {}
    console.error = (m) => errsA.push(String(m))
    let codeA
    try {
      codeA = await ticketMain(
        [
          'run',
          '--name',
          't70a',
          '--brief',
          briefFileA,
          '--branch',
          'feat/t70a',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
          '--review-only',
        ],
        depsA
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(codeA, 2, `(a) worktree 不存在時 run 應回 2，實際為 ${codeA}`)
    assert.equal(writeCountA, 0, `(a) writeMain 不應被呼叫，實際呼叫次數為 ${writeCountA}`)
    assert.equal(councilCountA, 0, `(a) councilMain 不應被呼叫，實際呼叫次數為 ${councilCountA}`)
    assert.equal(
      fs.existsSync(worktreePathA),
      false,
      `(a) worktree 目錄不應存在，實際路徑 ${worktreePathA} 存在狀態為 ${fs.existsSync(worktreePathA)}`
    )
    const errTextA = errsA.join('\n')
    assert.ok(
      errTextA.includes('--review-only 需要既有 worktree'),
      `(a) stderr 應含「--review-only 需要既有 worktree」，實際 stderr: ${errTextA}`
    )

    // (b) worktree 存在但不乾淨（寫一個未提交檔）
    const repoB = makeRepo()
    const worktreePathB = path.join(repoB.dir, '.claude', 'worktrees', 't70b')
    repoB.g('worktree', 'add', '-b', 'feat/t70b', worktreePathB, 'main')
    fs.writeFileSync(path.join(worktreePathB, 'dirty.txt'), 'dirty content\n')

    const briefFileB = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFileB, '# T70b\n`grep -e "x" a.txt`\n')

    let writeCountB = 0
    let councilCountB = 0
    const depsB = {
      repoRoot: repoB.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCountB++
        return 0
      },
      councilMain: () => {
        councilCountB++
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const errsB = []
    console.log = () => {}
    console.error = (m) => errsB.push(String(m))
    let codeB
    try {
      codeB = await ticketMain(
        [
          'run',
          '--name',
          't70b',
          '--brief',
          briefFileB,
          '--branch',
          'feat/t70b',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
          '--review-only',
        ],
        depsB
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(codeB, 2, `(b) worktree 不乾淨時 run 應回 2，實際為 ${codeB}`)
    assert.equal(writeCountB, 0, `(b) writeMain 不應被呼叫，實際呼叫次數為 ${writeCountB}`)
    assert.equal(councilCountB, 0, `(b) councilMain 不應被呼叫，實際呼叫次數為 ${councilCountB}`)
    const errTextB = errsB.join('\n')
    assert.ok(
      errTextB.includes('worktree 已存在但不乾淨'),
      `(b) stderr 應含「worktree 已存在但不乾淨」，實際 stderr: ${errTextB}`
    )
  })

  test('T71 run --review-only：HEAD 等於 merge-base（無 commit）⇒ 2、stderr 含「沒東西可審」、假函式 0 次', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't71')
    repo.g('worktree', 'add', '-b', 'feat/t71', worktreePath, 'main')

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T71\n`grep -e "x" a.txt`\n')

    let writeCount = 0
    let councilCount = 0
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCount++
        return 0
      },
      councilMain: () => {
        councilCount++
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    const origErr = console.error
    const errs = []
    console.log = () => {}
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't71',
          '--brief',
          briefFile,
          '--branch',
          'feat/t71',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
          '--review-only',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 2, `HEAD === merge-base 時 run 應回 2，實際為 ${code}`)
    assert.equal(writeCount, 0, `writeMain 不應被呼叫，實際呼叫次數為 ${writeCount}`)
    assert.equal(councilCount, 0, `councilMain 不應被呼叫，實際呼叫次數為 ${councilCount}`)
    const errText = errs.join('\n')
    assert.ok(errText.includes('沒東西可審'), `stderr 應含「沒東西可審」，實際 stderr: ${errText}`)
  })

  test('T72 run --review-only：verify 紅 ⇒ 3、不開 council、writeMain 0 次、summary.review 為 null', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't72')
    repo.g('worktree', 'add', '-b', 'feat/t72', worktreePath, 'main')
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature code\n')
    execFileSync('git', ['-C', worktreePath, 'add', 'feature.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'feat: feature commit'], { env: CLEAN_GIT_ENV })

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T72\n`grep -e "feature" feature.txt`\n')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't72')
    let writeCount = 0
    let councilCount = 0
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCount++
        return 0
      },
      councilMain: () => {
        councilCount++
        return 0
      },
      runTest: () => ({ exit: 1, out: 'boom' }),
    }

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't72',
          '--brief',
          briefFile,
          '--branch',
          'feat/t72',
          '--allow',
          'feature.txt',
          '--test',
          'node --test',
          '--review-only',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 3, `verify 紅時 run 應回 3，實際為 ${code}`)
    assert.equal(writeCount, 0, `writeMain 呼叫次數應為 0，實際為 ${writeCount}`)
    assert.equal(councilCount, 0, `councilMain 呼叫次數應為 0，實際為 ${councilCount}`)

    const summaryPath = path.join(outDir, 'summary.json')
    assert.ok(fs.existsSync(summaryPath), `summary.json 應存在於 ${summaryPath}`)
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    assert.equal(summary.review, null, `summary.review 應為 null，實際為 ${JSON.stringify(summary.review)}`)
    assert.equal(summary.reviewOnly, true, `summary.reviewOnly 應為 true，實際為 ${summary.reviewOnly}`)
    assert.equal(summary.verifyExit, 1, `summary.verifyExit 應為 1，實際為 ${summary.verifyExit}`)
  })

  test('T73 run --review-only：舊裁決作廢 ⇒ 重讀 summary 不含 q6Receipt 與 dispositions、summary.reviewOnly 為 true', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't73')
    repo.g('worktree', 'add', '-b', 'feat/t73', worktreePath, 'main')
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature content\n')
    execFileSync('git', ['-C', worktreePath, 'add', 'feature.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'feat: feature commit'], { env: CLEAN_GIT_ENV })

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't73')
    fs.mkdirSync(outDir, { recursive: true })
    const oldSummary = {
      q6Receipt: { status: 'verified', note: 'old-receipt' },
      dispositions: [{ id: 'disp-1', action: 'accept' }],
      staleField: 'stale',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(oldSummary, null, 2))

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T73\n`grep -e "feature" feature.txt`\n')

    const reviewOutDir = path.join(outDir, 'review')
    let writeCount = 0
    let councilCount = 0
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCount++
        return 0
      },
      councilMain: async () => {
        councilCount++
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\nQ6：確認 feature.txt',
          'agy-gemini': '整份：簽\nQ6：確認編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't73',
          '--brief',
          briefFile,
          '--branch',
          'feat/t73',
          '--allow',
          'feature.txt',
          '--test',
          'node --test',
          '--review-only',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 0, `run 回傳碼應為 0，實際為 ${code}`)
    assert.equal(writeCount, 0, `writeMain 呼叫次數應為 0，實際為 ${writeCount}`)
    assert.equal(councilCount, 1, `councilMain 呼叫次數應為 1，實際為 ${councilCount}`)

    const summaryPath = path.join(outDir, 'summary.json')
    assert.ok(fs.existsSync(summaryPath), `summary.json 應存在於 ${summaryPath}`)
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    assert.equal('q6Receipt' in summary, false, `'q6Receipt' 不應在重跑後的 summary 中，實際為 ${JSON.stringify(summary.q6Receipt)}`)
    assert.equal('dispositions' in summary, false, `'dispositions' 不應在重跑後的 summary 中，實際為 ${JSON.stringify(summary.dispositions)}`)
    assert.equal(summary.q6Receipt, undefined, `summary.q6Receipt 應為 undefined，實際為 ${summary.q6Receipt}`)
    assert.equal(summary.dispositions, undefined, `summary.dispositions 應為 undefined，實際為 ${summary.dispositions}`)
    assert.equal(summary.reviewOnly, true, `summary.reviewOnly 應為 true，實際為 ${summary.reviewOnly}`)
  })

  test('T74 publish 閘：summary reviewOnly: true 且 writeExit: null ⇒ 通過 writeExit 閘（stderr 不含「writeExit 為」）；陽性對照 reviewOnly: false 且 writeExit: null ⇒ 回 2 且 stderr 含「writeExit 為 null」', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't74')
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content\n')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't74')
    fs.mkdirSync(outDir, { recursive: true })
    const baseSummary = {
      schemaVersion: 2,
      coordinator: 'claude',
      reviewers: ROSTER_STANDARD,
      project: 'test-proj',
      ticket: 't74',
      branch: 'feat/t74',
      base: 'main',
      writeExit: null,
      reviewOnly: true,
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
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(baseSummary, null, 2))

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

    const origLog = console.log
    const origErr = console.error
    const errsTrue = []
    console.log = () => {}
    console.error = (m) => errsTrue.push(String(m))
    let codeTrue
    try {
      codeTrue = await ticketMain(['publish', '--name', 't74'], deps)
    } finally {
      console.log = origLog
      console.error = origErr
    }

    const errTextTrue = errsTrue.join('\n')
    assert.equal(
      errTextTrue.includes('writeExit 為'),
      false,
      `reviewOnly: true 時 stderr 不應含「writeExit 為」，實際 stderr 為: ${errTextTrue}`
    )

    // 陽性對照：同一份 summary 改為 reviewOnly: false、writeExit: null
    const falseSummary = { ...baseSummary, reviewOnly: false, writeExit: null }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(falseSummary, null, 2))

    ghCalled = false
    const errsFalse = []
    console.log = () => {}
    console.error = (m) => errsFalse.push(String(m))
    let codeFalse
    try {
      codeFalse = await ticketMain(['publish', '--name', 't74'], deps)
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(codeFalse, 2, `reviewOnly: false 且 writeExit: null 時 publish 應回 2，實際為 ${codeFalse}`)
    const errTextFalse = errsFalse.join('\n')
    assert.ok(
      errTextFalse.includes('writeExit 為 null'),
      `stderr 應含「writeExit 為 null」，實際 stderr 為: ${errTextFalse}`
    )
    assert.equal(ghCalled, false, `gh 不應被呼叫，實際 ghCalled 為 ${ghCalled}`)
  })

  test('T75 事故重現：同一票跑兩次 run（第一次逾時、第二次成功）⇒ write/run-K 隔離，第二次 summary.run===2、writeTimedOut===false，收貨摘要不含寫手逾時', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T75 測試票\n`grep -e "a" a.txt`\n')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't75')
    const outDir = path.join(repo.dir, '.local', 'llm-team', 't75')
    const reviewOutDir = path.join(outDir, 'review')

    let run1Out = null
    const deps1 = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: (args) => {
        run1Out = args[args.indexOf('--out') + 1]
        fs.mkdirSync(run1Out, { recursive: true })
        fs.writeFileSync(path.join(run1Out, 'timeout.json'), JSON.stringify({ round: 1, timeoutMs: 1500000 }))
        fs.writeFileSync(path.join(run1Out, 'round-1.response.md'), 'R1')
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'partial work from r1\n')
        return 3
      },
      councilMain: () => 0,
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let code1
    try {
      code1 = await ticketMain(
        ['run', '--name', 't75', '--brief', briefFile, '--branch', 'feat/t75', '--allow', 'a.txt', '--test', 'node --test'],
        deps1
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }
    assert.equal(code1, 3, `第一次 run 應回 3，實際為 ${code1}`)

    // 兩次之間統整者 commit 工作樹讓第二次能過乾淨檢查
    execFileSync('git', ['-C', worktreePath, 'add', 'a.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'commit r1 partial work'], { env: CLEAN_GIT_ENV })

    // 第二次 run
    let run2Out = null
    let interceptedCouncilArgs2 = null
    const deps2 = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: (args) => {
        run2Out = args[args.indexOf('--out') + 1]
        fs.mkdirSync(run2Out, { recursive: true })
        fs.writeFileSync(path.join(run2Out, 'round-1.response.md'), 'R2')
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'finished work from r2\n')
        return 0
      },
      councilMain: (args) => {
        interceptedCouncilArgs2 = args
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs2 = []
    console.log = (m) => outs2.push(String(m))
    console.error = () => {}
    let code2
    try {
      code2 = await ticketMain(
        ['run', '--name', 't75', '--brief', briefFile, '--branch', 'feat/t75', '--allow', 'a.txt', '--test', 'node --test'],
        deps2
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code2, 0, `第二次 run 應回 0，實際為 ${code2}`)

    const summary2 = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(summary2.writeTimedOut, false, `第二次 summary.writeTimedOut 應為 false，實際為 ${summary2.writeTimedOut}`)
    assert.equal(summary2.run, 2, `第二次 summary.run 應為 2，實際為 ${summary2.run}`)
    assert.equal(summary2.rounds, 1, `第二次 summary.rounds 應為 1，實際為 ${summary2.rounds}`)

    assert.ok(run1Out && run1Out.endsWith(path.join('write', 'run-1')), `第一次 --out 應以 write/run-1 結尾，實際為 ${run1Out}`)
    assert.ok(run2Out && run2Out.endsWith(path.join('write', 'run-2')), `第二次 --out 應以 write/run-2 結尾，實際為 ${run2Out}`)

    assert.ok(interceptedCouncilArgs2, `第二次 councilMain 應被呼叫，實際為 ${JSON.stringify(interceptedCouncilArgs2)}`)
    assert.ok(interceptedCouncilArgs2.includes('--writer-report'), `councilArgs 應含 --writer-report，實際 args: ${JSON.stringify(interceptedCouncilArgs2)}`)
    const reportIdx = interceptedCouncilArgs2.indexOf('--writer-report')
    const expectedReportPath = path.resolve(repo.dir, '.local', 'llm-team', 't75', 'write', 'run-2', 'round-1.response.md')
    assert.equal(interceptedCouncilArgs2[reportIdx + 1], expectedReportPath, `--writer-report 應指向 write/run-2/round-1.response.md，實際為 ${interceptedCouncilArgs2[reportIdx + 1]}`)

    const r1Timeout = path.join(outDir, 'write', 'run-1', 'timeout.json')
    assert.ok(fs.existsSync(r1Timeout), `write/run-1/timeout.json 應存在，實際路徑 ${r1Timeout}`)
    const r1Report = path.join(outDir, 'write', 'run-1', 'round-1.response.md')
    assert.ok(fs.existsSync(r1Report), `write/run-1/round-1.response.md 應存在，實際路徑 ${r1Report}`)
    const r1Content = fs.readFileSync(r1Report, 'utf8')
    assert.equal(r1Content, 'R1', `write/run-1/round-1.response.md 內容仍應為 R1，實際為 ${r1Content}`)

    const outText2 = outs2.join('\n')
    assert.ok(outText2.includes('(run 2，共 1 輪)'), `收貨摘要應含「(run 2，共 1 輪)」，實際為 ${outText2}`)
    assert.equal(outText2.includes('寫手逾時'), false, `收貨摘要不應含「寫手逾時」，實際為 ${outText2}`)

    const lifecycleContent = fs.readFileSync(path.join(outDir, 'lifecycle.ndjson'), 'utf8')
    const runStarts = lifecycleContent.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'run-start')
    assert.equal(runStarts.length, 2, `lifecycle 應有 2 筆 run-start，實際為 ${runStarts.length}`)
    assert.equal(runStarts[0].run, 1, `第 1 筆 run-start 的 run 應為 1，實際為 ${runStarts[0].run}`)
    assert.equal(runStarts[1].run, 2, `第 2 筆 run-start 的 run 應為 2，實際為 ${runStarts[1].run}`)
  })

  test('T76 K 的來源：先手寫 lifecycle.ndjson 三行 run-start（夾壞 JSON 與 writer-done），跑一次 run ⇒ --out 以 write/run-4 結尾、summary.run === 4、run-start 行 run === 4', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T76 測試票\n`grep -e "a" a.txt`\n')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't76')
    fs.mkdirSync(outDir, { recursive: true })
    const lifecycleLines = [
      JSON.stringify({ at: '2026-09-15T00:00:00.000Z', event: 'run-start', ticket: 't76', run: 1 }),
      'CORRUPTED JSON LINE {{{',
      JSON.stringify({ at: '2026-09-15T00:01:00.000Z', event: 'writer-done', ticket: 't76', writeExit: 0 }),
      JSON.stringify({ at: '2026-09-15T00:02:00.000Z', event: 'run-start', ticket: 't76', run: 2 }),
      JSON.stringify({ at: '2026-09-15T00:03:00.000Z', event: 'run-start', ticket: 't76', run: 3 }),
    ]
    fs.writeFileSync(path.join(outDir, 'lifecycle.ndjson'), lifecycleLines.join('\n') + '\n')

    let runOut = null
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't76')
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: (args) => {
        runOut = args[args.indexOf('--out') + 1]
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'done\n')
        return 0
      },
      councilMain: async () => {
        const reviewOutDir = path.join(outDir, 'review')
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    const origErr = console.error
    const errs = []
    console.log = () => {}
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(
        ['run', '--name', 't76', '--brief', briefFile, '--branch', 'feat/t76', '--allow', 'a.txt', '--test', 'node --test'],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 0, `ticketMain 應回 0，實際為 ${code}`)
    assert.ok(runOut && runOut.endsWith(path.join('write', 'run-4')), `--out 應以 write/run-4 結尾，實際為 ${runOut}`)

    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(summary.run, 4, `summary.run 應為 4，實際為 ${summary.run}`)

    const lines = fs.readFileSync(path.join(outDir, 'lifecycle.ndjson'), 'utf8').trim().split('\n')
    const runStarts = lines
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter((e) => e && e.event === 'run-start')
    assert.equal(runStarts.length, 4, `應有 4 行 run-start，實際為 ${runStarts.length}`)
    assert.equal(runStarts[3].run, 4, `新的 run-start 行 run 應為 4，實際為 ${runStarts[3].run}`)
    assert.ok(errs.some((e) => e.includes('解析 lifecycle.ndjson 行失敗')), `console.error 應警告解析失敗，實際 stderr: ${errs.join('\n')}`)
  })

  test('T77 review-only 也編號：先跑一次一般 run（K=1）、commit，再 run --review-only ⇒ summary.run === 2、lifecycle run: 2、reviewOnly: true，且 write/run-2 目錄不存在', async () => {
    const repo = makeRepo()
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't77')
    repo.g('worktree', 'add', '-b', 'feat/t77', worktreePath, 'main')
    fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'init\n')
    execFileSync('git', ['-C', worktreePath, 'add', 'a.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'feat: worktree init commit'], { env: CLEAN_GIT_ENV })

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T77 測試票\n`grep -e "a" a.txt`\n')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't77')
    const reviewOutDir = path.join(outDir, 'review')

    // 第一次 run（一般 run，K=1）
    const deps1 = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: (args) => {
        const out = args[args.indexOf('--out') + 1]
        fs.mkdirSync(out, { recursive: true })
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'run 1 change\n')
        return 0
      },
      councilMain: async () => {
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let code1
    try {
      code1 = await ticketMain(
        ['run', '--name', 't77', '--brief', briefFile, '--branch', 'feat/t77', '--allow', 'a.txt', '--test', 'node --test'],
        deps1
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }
    assert.equal(code1, 0, `第一次 run 應回 0，實際為 ${code1}`)

    // commit 讓 worktree 變乾淨且推進 HEAD
    execFileSync('git', ['-C', worktreePath, 'add', 'a.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'feat: commit after run 1'], { env: CLEAN_GIT_ENV })

    // 第二次 run（run --review-only）
    let writeCalls2 = 0
    const deps2 = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCalls2++
        return 0
      },
      councilMain: async () => {
        fakeCouncilOut(reviewOutDir, { 'agy-opus': '整份：簽\n', 'agy-gemini': '整份：簽\n' })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    let code2
    try {
      code2 = await ticketMain(
        ['run', '--name', 't77', '--brief', briefFile, '--branch', 'feat/t77', '--allow', 'a.txt', '--test', 'node --test', '--review-only'],
        deps2
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code2, 0, `第二次 run --review-only 應回 0，實際為 ${code2}`)
    assert.equal(writeCalls2, 0, `第二次 run 不應呼叫 writeMain，實際次數: ${writeCalls2}`)

    const summary2 = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(summary2.run, 2, `第二次 summary.run 應為 2，實際為 ${summary2.run}`)
    assert.equal(summary2.reviewOnly, true, `第二次 summary.reviewOnly 應為 true，實際為 ${summary2.reviewOnly}`)

    const lifecycleContent = fs.readFileSync(path.join(outDir, 'lifecycle.ndjson'), 'utf8')
    const runStarts = lifecycleContent.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'run-start')
    assert.equal(runStarts.length, 2, `應有 2 筆 run-start 事件，實際為 ${runStarts.length}`)
    assert.equal(runStarts[1].run, 2, `第 2 筆 run-start 的 run 應為 2，實際為 ${runStarts[1].run}`)
    assert.equal(runStarts[1].reviewOnly, true, `第 2 筆 run-start 的 reviewOnly 應為 true，實際為 ${runStarts[1].reviewOnly}`)

    const writeRun2Dir = path.join(outDir, 'write', 'run-2')
    assert.equal(fs.existsSync(writeRun2Dir), false, `write/run-2 目錄不應存在，實際存在於: ${writeRun2Dir}`)
  })

  test('T78 run --review-only 改動檔自 merge-base..HEAD 計算：commit 兩檔 run --review-only 回 0、summary.changed 含兩檔且 reviewOnly 為 true，接續 land 回 0 且 main HEAD 樹含該兩檔', async () => {
    const repo = makeRepo()

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't78')
    repo.g('worktree', 'add', '-b', 'feat/t78', worktreePath, 'main')
    fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'hello from a\n')
    fs.mkdirSync(path.join(worktreePath, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'sub', 'b.txt'), 'hello from sub b\n')
    execFileSync('git', ['-C', worktreePath, 'add', 'a.txt', 'sub/b.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'feat: worktree commit two files'], { env: CLEAN_GIT_ENV })

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T78\n`grep -e "hello" a.txt`\n')

    const outDir = path.join(repo.dir, '.local', 'llm-team', 't78')
    const reviewOutDir = path.join(outDir, 'review')

    let writeCount = 0
    let councilCount = 0
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCount++
        return 0
      },
      councilMain: async () => {
        councilCount++
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\nQ6：確認 a.txt 與 sub/b.txt',
          'agy-gemini': '整份：簽\nQ6：確認編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    const origErr = console.error
    const outs = []
    const errs = []
    console.log = (m) => outs.push(String(m))
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't78',
          '--brief',
          briefFile,
          '--branch',
          'feat/t78',
          '--allow',
          'a.txt',
          '--allow',
          'sub/b.txt',
          '--test',
          'node --test',
          '--review-only',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 0, `run 應回 0，實際為 ${code}`)
    assert.equal(writeCount, 0, `writeMain 呼叫次數應為 0，實際為 ${writeCount}`)
    assert.equal(councilCount, 1, `councilMain 呼叫次數應為 1，實際為 ${councilCount}`)

    const summaryPath = path.join(outDir, 'summary.json')
    assert.ok(fs.existsSync(summaryPath), `summary.json 應存在於 ${summaryPath}`)
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    assert.equal(summary.reviewOnly, true, `summary.reviewOnly 應為 true，實際為 ${summary.reviewOnly}`)
    const sortedChanged = [...(summary.changed || [])].sort()
    assert.deepEqual(
      sortedChanged,
      ['a.txt', 'sub/b.txt'],
      `summary.changed 應為 [a.txt, sub/b.txt]，實際為 ${JSON.stringify(summary.changed)}`
    )

    // 接著比照 T67 對這份 summary 跑 land
    summary.q6Receipt = 'verified'
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    const msgFile = path.join(repo.dir, 'commit.msg')
    fs.writeFileSync(msgFile, 'feat: t78\n')

    outs.length = 0
    errs.length = 0
    console.log = (m) => outs.push(String(m))
    console.error = (m) => errs.push(String(m))

    let landCode
    try {
      landCode = await ticketMain(['land', '--name', 't78', '--msg-file', msgFile], { repoRoot: repo.dir })
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(landCode, 0, `land 應回 0，實際為 ${landCode}`)
    const outText = outs.join('\n')
    assert.ok(outText.includes('LANDED'), `stdout 應含 LANDED，實際為: ${outText}`)

    const mainHeadFiles = repo.g('ls-tree', '-r', '--name-only', 'HEAD').split('\n').map((s) => s.trim()).filter(Boolean)
    assert.ok(mainHeadFiles.includes('a.txt'), `main HEAD 樹應含 a.txt，實際為: ${JSON.stringify(mainHeadFiles)}`)
    assert.ok(mainHeadFiles.includes('sub/b.txt'), `main HEAD 樹應含 sub/b.txt，實際為: ${JSON.stringify(mainHeadFiles)}`)
  })

  test('T79 run --review-only councilMain args 含 --review-only 且不含 --writer-report；一般 run 不含 --review-only', async () => {
    const repo = makeRepo()
    const worktreePathRO = path.join(repo.dir, '.claude', 'worktrees', 't78-ro')
    repo.g('worktree', 'add', '-b', 'feat/t78-ro', worktreePathRO, 'main')
    fs.writeFileSync(path.join(worktreePathRO, 'feature.txt'), 'hello ro\n')
    execFileSync('git', ['-C', worktreePathRO, 'add', 'feature.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePathRO, 'commit', '-m', 'feat: ro commit'], { env: CLEAN_GIT_ENV })

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T79\n`grep -e "hello" feature.txt`\n')

    const outDirRO = path.join(repo.dir, '.local', 'llm-team', 't78-ro')
    const reviewOutDirRO = path.join(outDirRO, 'review')

    let interceptedROArgs = null
    const depsRO = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => 0,
      councilMain: async (args) => {
        interceptedROArgs = args
        fakeCouncilOut(reviewOutDirRO, {
          'agy-opus': '整份：簽\nQ6：確認 feature.txt',
          'agy-gemini': '整份：簽\nQ6：確認編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    // 預先建好舊寫手報告讓 writerReportPath 非 null、坐實 ticket.mjs:656 的 && !reviewOnly 防呆（sol Q3）
    fs.mkdirSync(path.join(outDirRO, 'write', 'run-1'), { recursive: true })
    fs.writeFileSync(path.join(outDirRO, 'write', 'run-1', 'round-1.response.md'), 'STALE-REPORT')

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let codeRO
    try {
      codeRO = await ticketMain(
        [
          'run',
          '--name',
          't78-ro',
          '--brief',
          briefFile,
          '--branch',
          'feat/t78-ro',
          '--allow',
          'feature.txt',
          '--test',
          'node --test',
          '--review-only',
        ],
        depsRO
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(codeRO, 0, `run --review-only 應回 0，實際為 ${codeRO}`)
    assert.ok(interceptedROArgs !== null, `run --review-only 的 councilMain 應被呼叫，實際 interceptedROArgs 為 ${JSON.stringify(interceptedROArgs)}`)
    assert.ok(interceptedROArgs.includes('--review-only'), `run --review-only 的 councilMain args 應含 '--review-only'，實際 args 為 ${JSON.stringify(interceptedROArgs)}`)
    assert.ok(!interceptedROArgs.includes('--writer-report'), `run --review-only 的 councilMain args 不應含 '--writer-report'（已預建 write/run-1/round-1.response.md），實際 args 為 ${JSON.stringify(interceptedROArgs)}`)

    // 一般 run（T1 形狀）
    const worktreePathStd = path.join(repo.dir, '.claude', 'worktrees', 't78-std')
    const outDirStd = path.join(repo.dir, '.local', 'llm-team', 't78-std')
    const reviewOutDirStd = path.join(outDirStd, 'review')
    let interceptedStdArgs = null
    const depsStd = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePathStd, 'feature.txt'), 'hello std\n')
        return 0
      },
      councilMain: async (args) => {
        interceptedStdArgs = args
        fakeCouncilOut(reviewOutDirStd, {
          'agy-opus': '整份：簽\nQ6：確認 feature.txt',
          'agy-gemini': '整份：簽\nQ6：確認編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    let codeStd
    try {
      codeStd = await ticketMain(
        [
          'run',
          '--name',
          't78-std',
          '--brief',
          briefFile,
          '--branch',
          'feat/t78-std',
          '--allow',
          'feature.txt',
          '--test',
          'true',
        ],
        depsStd
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(codeStd, 0, `一般 run 應回 0，實際為 ${codeStd}`)
    assert.ok(interceptedStdArgs !== null, `一般 run 的 councilMain 應被呼叫，實際 interceptedStdArgs 為 ${JSON.stringify(interceptedStdArgs)}`)
    assert.ok(!interceptedStdArgs.includes('--review-only'), `一般 run 的 councilMain args 不應含 '--review-only'，實際 args 為 ${JSON.stringify(interceptedStdArgs)}`)
  })

  test('T80 CLI：run … --write-timeout-ms 30000 ⇒ 攔到的 writeMain args 含 \'--timeout-ms\' 且其後一個值 === \'30000\'；run 回 0', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T80\n實作\n')
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't80')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't80', 'review')

    let interceptedArgs = null
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: (args) => {
        interceptedArgs = args
        fs.writeFileSync(path.join(worktreePath, 'hello.txt'), 'hello\n')
        return 0
      },
      councilMain: (args) => {
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\nQ6：確認',
          'agy-gemini': '整份：簽\nQ6：確認',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
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
        [
          'run',
          '--name', 't80',
          '--brief', briefFile,
          '--branch', 'feat/t80',
          '--allow', 'hello.txt',
          '--test', 'true',
          '--write-timeout-ms', '30000',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 0, `ticket run exit 應為 0，實際為 ${code}`)
    assert.ok(interceptedArgs !== null, `writeMain 應被呼叫，實際 interceptedArgs 為 ${JSON.stringify(interceptedArgs)}`)
    const idx = interceptedArgs.indexOf('--timeout-ms')
    assert.ok(idx !== -1, `writeMain args 應含 '--timeout-ms'，實際 args 為 ${JSON.stringify(interceptedArgs)}`)
    assert.equal(interceptedArgs[idx + 1], '30000', `writeMain '--timeout-ms' 後一個值應為 '30000'，實際為 ${interceptedArgs[idx + 1]}`)
  })

  test('T81 config：deps.config 的 writer.timeoutMs: 45000、CLI 沒給 ⇒ args 含 \'--timeout-ms\', \'45000\'；CLI 給 30000 且 config 45000 ⇒ \'30000\'（CLI 覆蓋）', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T81\n實作\n')

    // CLI 沒給，config 有給
    const worktreePath1 = path.join(repo.dir, '.claude', 'worktrees', 't81-cfg')
    const reviewOutDir1 = path.join(repo.dir, '.local', 'llm-team', 't81-cfg', 'review')
    let interceptedArgs1 = null
    const deps1 = {
      repoRoot: repo.dir,
      config: v2Config({ writer: { ...TEST_CONFIG.writer, timeoutMs: 45000 } }),
      assertSettings: () => true,
      writeMain: (args) => {
        interceptedArgs1 = args
        fs.writeFileSync(path.join(worktreePath1, 'hello.txt'), 'hello\n')
        return 0
      },
      councilMain: (args) => {
        fakeCouncilOut(reviewOutDir1, {
          'agy-opus': '整份：簽\nQ6：確認',
          'agy-gemini': '整份：簽\nQ6：確認',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs1 = []
    const errs1 = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => outs1.push(String(m))
    console.error = (m) => errs1.push(String(m))
    let code1
    try {
      code1 = await ticketMain(
        [
          'run',
          '--name', 't81-cfg',
          '--brief', briefFile,
          '--branch', 'feat/t81-cfg',
          '--allow', 'hello.txt',
          '--test', 'true',
        ],
        deps1
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code1, 0, `ticket run exit 應為 0，實際為 ${code1}`)
    assert.ok(interceptedArgs1 !== null, `writeMain 應被呼叫，實際 interceptedArgs1 為 ${JSON.stringify(interceptedArgs1)}`)
    const idx1 = interceptedArgs1.indexOf('--timeout-ms')
    assert.ok(idx1 !== -1, `writeMain args 應含 '--timeout-ms'，實際 args 為 ${JSON.stringify(interceptedArgs1)}`)
    assert.equal(interceptedArgs1[idx1 + 1], '45000', `writeMain '--timeout-ms' 後一個值應為 '45000'，實際為 ${interceptedArgs1[idx1 + 1]}`)

    // CLI 給 30000 且 config 給 45000 ⇒ 30000
    const worktreePath2 = path.join(repo.dir, '.claude', 'worktrees', 't81-override')
    const reviewOutDir2 = path.join(repo.dir, '.local', 'llm-team', 't81-override', 'review')
    let interceptedArgs2 = null
    const deps2 = {
      repoRoot: repo.dir,
      config: v2Config({ writer: { ...TEST_CONFIG.writer, timeoutMs: 45000 } }),
      assertSettings: () => true,
      writeMain: (args) => {
        interceptedArgs2 = args
        fs.writeFileSync(path.join(worktreePath2, 'hello.txt'), 'hello\n')
        return 0
      },
      councilMain: (args) => {
        fakeCouncilOut(reviewOutDir2, {
          'agy-opus': '整份：簽\nQ6：確認',
          'agy-gemini': '整份：簽\nQ6：確認',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const outs2 = []
    const errs2 = []
    console.log = (m) => outs2.push(String(m))
    console.error = (m) => errs2.push(String(m))
    let code2
    try {
      code2 = await ticketMain(
        [
          'run',
          '--name', 't81-override',
          '--brief', briefFile,
          '--branch', 'feat/t81-override',
          '--allow', 'hello.txt',
          '--test', 'true',
          '--write-timeout-ms', '30000',
        ],
        deps2
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code2, 0, `ticket run exit 應為 0，實際為 ${code2}`)
    assert.ok(interceptedArgs2 !== null, `writeMain 應被呼叫，實際 interceptedArgs2 為 ${JSON.stringify(interceptedArgs2)}`)
    const idx2 = interceptedArgs2.indexOf('--timeout-ms')
    assert.ok(idx2 !== -1, `writeMain args 應含 '--timeout-ms'，實際 args 為 ${JSON.stringify(interceptedArgs2)}`)
    assert.equal(interceptedArgs2[idx2 + 1], '30000', `CLI 應覆蓋 config 為 '30000'，實際為 ${interceptedArgs2[idx2 + 1]}`)
  })

  test('T82 都沒給 ⇒ args 不含 \'--timeout-ms\'', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T82\n實作\n')
    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't82')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't82', 'review')

    let interceptedArgs = null
    const deps = {
      repoRoot: repo.dir,
      config: TEST_CONFIG,
      assertSettings: () => true,
      writeMain: (args) => {
        interceptedArgs = args
        fs.writeFileSync(path.join(worktreePath, 'hello.txt'), 'hello\n')
        return 0
      },
      councilMain: (args) => {
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\nQ6：確認',
          'agy-gemini': '整份：簽\nQ6：確認',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
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
        [
          'run',
          '--name', 't82',
          '--brief', briefFile,
          '--branch', 'feat/t82',
          '--allow', 'hello.txt',
          '--test', 'true',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 0, `ticket run exit 應為 0，實際為 ${code}`)
    assert.ok(interceptedArgs !== null, `writeMain 應被呼叫，實際 interceptedArgs 為 ${JSON.stringify(interceptedArgs)}`)
    assert.equal(interceptedArgs.includes('--timeout-ms'), false, `都沒給時 args 不應含 '--timeout-ms'，實際 args 為 ${JSON.stringify(interceptedArgs)}`)
  })

  test('T83 無效值：--write-timeout-ms abc、--write-timeout-ms 0、--write-timeout-ms -5、裸 --write-timeout-ms（下一個是 --tier）各 ⇒ run 回 2、stderr 含「必須是正整數」、writeMain 呼叫 0 次；config writer.timeoutMs: \'30s\' ⇒ 同樣 2', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# T83\n實作\n')

    const invalidCliCases = [
      { label: '--write-timeout-ms abc', args: ['--write-timeout-ms', 'abc'] },
      { label: '--write-timeout-ms 0', args: ['--write-timeout-ms', '0'] },
      { label: '--write-timeout-ms -5', args: ['--write-timeout-ms', '-5'] },
      { label: '裸 --write-timeout-ms（下一個是 --tier）', args: ['--write-timeout-ms', '--tier', 'standard'] },
    ]

    const origErr = console.error
    const origLog = console.log

    for (const tc of invalidCliCases) {
      let writeCalls = 0
      const deps = {
        repoRoot: repo.dir,
        assertSettings: () => true,
        writeMain: () => {
          writeCalls++
          return 0
        },
        councilMain: () => 0,
        runTest: () => ({ exit: 0, out: 'ok' }),
      }

      const errs = []
      const outs = []
      console.error = (m) => errs.push(String(m))
      console.log = (m) => outs.push(String(m))
      let code
      try {
        code = await ticketMain(
          [
            'run',
            '--name', 't83-cli',
            '--brief', briefFile,
            '--branch', 'feat/t83-cli',
            '--allow', 'hello.txt',
            '--test', 'true',
            ...tc.args,
          ],
          deps
        )
      } finally {
        console.error = origErr
        console.log = origLog
      }

      assert.equal(code, 2, `${tc.label} 時 run 應回 2，實際為 ${code}`)
      assert.equal(writeCalls, 0, `${tc.label} 時 writeMain 呼叫次數應為 0，實際為 ${writeCalls}`)
      const errText = errs.join('\n')
      assert.ok(errText.includes('必須是正整數'), `${tc.label} 時 stderr 應含「必須是正整數」，實際 stderr 為: ${errText}`)
    }

    // config writer.timeoutMs: '30s'
    {
      let writeCalls = 0
      const deps = {
        repoRoot: repo.dir,
        config: v2Config({ writer: { ...TEST_CONFIG.writer, timeoutMs: '30s' } }),
        assertSettings: () => true,
        writeMain: () => {
          writeCalls++
          return 0
        },
        councilMain: () => 0,
        runTest: () => ({ exit: 0, out: 'ok' }),
      }

      const errs = []
      const outs = []
      console.error = (m) => errs.push(String(m))
      console.log = (m) => outs.push(String(m))
      let code
      try {
        code = await ticketMain(
          [
            'run',
            '--name', 't83-cfg',
            '--brief', briefFile,
            '--branch', 'feat/t83-cfg',
            '--allow', 'hello.txt',
            '--test', 'true',
          ],
          deps
        )
      } finally {
        console.error = origErr
        console.log = origLog
      }

      assert.equal(code, 2, `config writer.timeoutMs: '30s' 時 run 應回 2，實際為 ${code}`)
      assert.equal(writeCalls, 0, `config writer.timeoutMs: '30s' 時 writeMain 呼叫次數應為 0，實際為 ${writeCalls}`)
      const errText = errs.join('\n')
      assert.ok(errText.includes('必須是正整數'), `config writer.timeoutMs: '30s' 時 stderr 應含「必須是正整數」，實際 stderr 為: ${errText}`)
    }
  })

  test('T51：brief 含 `grep -e "|| x" f` ⇒ run 回 2、writeMain 沒被呼叫、stderr 含 brief 指令預檢失敗、含 :<line>、含 |、且 worktree 目錄不存在、<outDir>/lifecycle* 不存在', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試票\n`grep -e "|| x" f`\n')

    let writeCount = 0
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCount++
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
          't51',
          '--brief',
          briefFile,
          '--branch',
          'feat/t51',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps
      )
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `brief 指令預檢失敗時 run 應回 2，實際看到：${code}`)
    assert.equal(writeCount, 0, `writeMain 不應被呼叫，實際被呼叫次數：${writeCount}`)
    const errOutput = errs.join('\n')
    assert.match(errOutput, /brief 指令預檢失敗/, `stderr 應含「brief 指令預檢失敗」，實際看到：${errOutput}`)
    assert.match(errOutput, /:2/, `stderr 應含「:2」（行號），實際看到：${errOutput}`)
    assert.match(errOutput, /\|/, `stderr 應含「|」，實際看到：${errOutput}`)

    const worktreePath = path.resolve(repo.dir, '.claude/worktrees', 't51')
    assert.equal(fs.existsSync(worktreePath), false, `worktree 目錄不應存在，實際路徑：${worktreePath}`)
    const outDir = path.resolve(repo.dir, '.local/llm-team', 't51')
    const lifecyclePath = path.join(outDir, 'lifecycle.ndjson')
    assert.equal(fs.existsSync(lifecyclePath), false, `lifecycle.ndjson 不應存在，實際路徑：${lifecyclePath}`)
  })

  test('T52：brief 含合法 `grep -e "cwd" f` ⇒ 走到 writeMain（被呼叫 1 次）', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試票\n`grep -e "cwd" f`\n')

    let writeCount = 0
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCount++
        return 0
      },
    }

    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't52',
          '--brief',
          briefFile,
          '--branch',
          'feat/t52',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(writeCount, 1, `writeMain 應被呼叫 1 次，實際看到：${writeCount}`)
    assert.equal(code, 0, `run 應成功回 0，實際看到：${code}`)
  })

  test('T53：brief 有未關閉 fence ⇒ 回 2、stderr 含 fence 沒有關閉、writeMain 0 次', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試票\n```bash\ngrep -e x f\n')

    let writeCount = 0
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        writeCount++
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
          't53',
          '--brief',
          briefFile,
          '--branch',
          'feat/t53',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps
      )
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `未關閉 fence 時 run 應回 2，實際看到：${code}`)
    assert.equal(writeCount, 0, `writeMain 不應被呼叫，實際被呼叫次數：${writeCount}`)
    const errOutput = errs.join('\n')
    assert.match(errOutput, /fence 沒有關閉/, `stderr 應含「fence 沒有關閉」，實際看到：${errOutput}`)
  })

  test('T54：假 councilMain 攔 args ⇒ 含 --round-start 且其值 ＝ run 前 worktree HEAD；summary 有 roundStartSha／mergeBase／targetTipSha（皆 40 hex）、review.reviewedTree 是 40 hex 且等於測試自己另外算的 writeTreeOf(worktree)', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 功能票\n內容\n')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't54')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't54', 'review')

    let interceptedCouncilArgs = null
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'hello\n')
        return 0
      },
      councilMain: (args) => {
        interceptedCouncilArgs = args
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\nQ6：確認 a.txt',
          'agy-gemini': '整份：簽\nQ6：確認編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't54',
          '--brief',
          briefFile,
          '--branch',
          'feat/t54',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0)
    assert.ok(interceptedCouncilArgs.includes('--round-start'), 'councilArgs 應含 --round-start')
    const roundStartIdx = interceptedCouncilArgs.indexOf('--round-start')
    const roundStartVal = interceptedCouncilArgs[roundStartIdx + 1]

    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 't54', 'summary.json')
    assert.ok(fs.existsSync(summaryFile), 'summary.json 應存在')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))

    const hex40 = /^[0-9a-f]{40}$/
    assert.match(summary.roundStartSha, hex40, 'summary.roundStartSha 應為 40 hex')
    assert.match(summary.mergeBase, hex40, 'summary.mergeBase 應為 40 hex')
    assert.match(summary.targetTipSha, hex40, 'summary.targetTipSha 應為 40 hex')
    assert.equal(roundStartVal, summary.roundStartSha, '--round-start 應等於 run 前 worktree HEAD')

    assert.match(summary.review.reviewedTree, hex40, 'review.reviewedTree 應為 40 hex')
    const expectedTree = writeTreeOf(worktreePath)
    assert.equal(summary.review.reviewedTree, expectedTree, 'review.reviewedTree 應等於測試自己另外算的 writeTreeOf(worktree)')
  })

  test('T55：write 回 2（review null）⇒ summary 沒有 review.reviewedTree 但仍有 roundStartSha', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 失敗票\n內容\n')

    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => 2,
    }

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't55',
          '--brief',
          briefFile,
          '--branch',
          'feat/t55',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 2)
    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 't55', 'summary.json')
    assert.ok(fs.existsSync(summaryFile), 'summary.json 應存在')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))

    const hex40 = /^[0-9a-f]{40}$/
    assert.match(summary.roundStartSha, hex40, 'summary.roundStartSha 應為 40 hex')
    assert.equal(summary.review, null, 'summary.review 應為 null')
    assert.equal(summary.review?.reviewedTree, undefined, 'summary 沒有 review.reviewedTree')
  })

  test('T56：第二次 run（worktree 已存在、先在 worktree commit 一筆、main 再前進一筆 foreign）⇒ --round-start 換成 worktree 新 HEAD、targetTipSha 是前進後的 main', async () => {
    const repo = makeRepo()
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 二次 run\n內容\n')

    const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 't56')
    const reviewOutDir = path.join(repo.dir, '.local', 'llm-team', 't56', 'review')

    // 第一次 run：建立 worktree 並成功結束
    const deps = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'round 1\n')
        return 0
      },
      councilMain: () => {
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\nQ6：確認 a.txt',
          'agy-gemini': '整份：簽\nQ6：確認編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't56',
          '--brief',
          briefFile,
          '--branch',
          'feat/t56',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps
      )
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)

    // 在 worktree commit 一筆（讓 worktree 變乾淨且推進 HEAD）
    execFileSync('git', ['-C', worktreePath, 'add', 'a.txt'], { env: CLEAN_GIT_ENV })
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'round 1 commit'], { env: CLEAN_GIT_ENV })
    const worktreeNewHead = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { env: CLEAN_GIT_ENV, encoding: 'utf8' }).trim()

    // main 再前進一筆 foreign
    fs.writeFileSync(path.join(repo.dir, 'foreign.txt'), 'foreign change\n')
    repo.g('add', 'foreign.txt')
    repo.g('commit', '-m', 'foreign commit')
    const mainNewHead = repo.g('rev-parse', 'main').trim()

    // 第二次 run
    let interceptedArgs2 = null
    const deps2 = {
      repoRoot: repo.dir,
      assertSettings: () => true,
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'round 2\n')
        return 0
      },
      councilMain: (args) => {
        interceptedArgs2 = args
        fakeCouncilOut(reviewOutDir, {
          'agy-opus': '整份：簽\nQ6：確認 a.txt',
          'agy-gemini': '整份：簽\nQ6：確認編碼',
        })
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    console.log = () => {}
    try {
      code = await ticketMain(
        [
          'run',
          '--name',
          't56',
          '--brief',
          briefFile,
          '--branch',
          'feat/t56',
          '--allow',
          'a.txt',
          '--test',
          'node --test',
        ],
        deps2
      )
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)

    const roundStartIdx = interceptedArgs2.indexOf('--round-start')
    const roundStartVal = interceptedArgs2[roundStartIdx + 1]
    assert.equal(roundStartVal, worktreeNewHead, '--round-start 換成 worktree 新 HEAD')

    const summaryFile = path.join(repo.dir, '.local', 'llm-team', 't56', 'summary.json')
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.roundStartSha, worktreeNewHead, 'summary.roundStartSha 換成 worktree 新 HEAD')
    assert.equal(summary.targetTipSha, mainNewHead, 'targetTipSha 是前進後的 main')
  })

  test('T84 lifecycle：deps.env 含 CLAUDE_CODE_SESSION_ID: "sess-abc" 跑一次 run ⇒ lifecycle 每一行都有 sessionId === "sess-abc"；不給 ⇒ sessionId === null', async () => {
    // 1. 有 CLAUDE_CODE_SESSION_ID
    const repo1 = makeRepo()
    const briefFile1 = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile1, '# T84 有 sessionId\n內容')

    const worktreePath1 = path.join(repo1.dir, '.claude', 'worktrees', 't84-with-sess')
    const reviewOutDir1 = path.join(repo1.dir, '.local', 'llm-team', 't84-with-sess', 'review')

    const deps1 = {
      repoRoot: repo1.dir,
      assertSettings: () => true,
      env: {
        LLM_TEAM_HARNESS: 'claude',
        LLM_TEAM_COORDINATOR: 'claude',
        CLAUDE_CODE_SESSION_ID: 'sess-abc',
      },
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath1, 'hello.txt'), 'hello\n')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: () => {
        fakeCouncilOut(reviewOutDir1, {
          'agy-opus': 'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認 hello.txt',
          'agy-gemini': 'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認檔案編碼',
        })
        return 0
      },
    }

    const origLog = console.log
    console.log = () => {}
    let code1
    try {
      code1 = await ticketMain(
        [
          'run',
          '--name',
          't84-with-sess',
          '--brief',
          briefFile1,
          '--branch',
          'feat/t84-with-sess',
          '--allow',
          'hello.txt',
          '--test',
          'true',
        ],
        deps1
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code1, 0, `ticket run exit 應為 0，實際為 ${code1}`)
    const lifecycleFile1 = path.join(repo1.dir, '.local', 'llm-team', 't84-with-sess', 'lifecycle.ndjson')
    assert.ok(fs.existsSync(lifecycleFile1), `lifecycle.ndjson 應存在: ${lifecycleFile1}`)
    const lines1 = fs
      .readFileSync(lifecycleFile1, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.ok(lines1.length >= 3, `lifecycle 應至少有 3 行，實際行數: ${lines1.length}`)
    for (let i = 0; i < lines1.length; i++) {
      assert.equal(lines1[i].sessionId, 'sess-abc', `第 ${i} 行 (${lines1[i].event}) sessionId 應為 'sess-abc'，實際為 ${lines1[i].sessionId}`)
    }

    // 2. 不給 CLAUDE_CODE_SESSION_ID
    const repo2 = makeRepo()
    const briefFile2 = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile2, '# T84 無 sessionId\n內容')

    const worktreePath2 = path.join(repo2.dir, '.claude', 'worktrees', 't84-no-sess')
    const reviewOutDir2 = path.join(repo2.dir, '.local', 'llm-team', 't84-no-sess', 'review')

    const deps2 = {
      repoRoot: repo2.dir,
      assertSettings: () => true,
      env: {
        LLM_TEAM_HARNESS: 'claude',
        LLM_TEAM_COORDINATOR: 'claude',
      },
      writeMain: () => {
        fs.writeFileSync(path.join(worktreePath2, 'hello.txt'), 'hello\n')
        return 0
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
      councilMain: () => {
        fakeCouncilOut(reviewOutDir2, {
          'agy-opus': 'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認 hello.txt',
          'agy-gemini': 'Q1：簽｜ok｜無\n整份：簽\nQ6：請確認檔案編碼',
        })
        return 0
      },
    }

    let code2
    console.log = () => {}
    try {
      code2 = await ticketMain(
        [
          'run',
          '--name',
          't84-no-sess',
          '--brief',
          briefFile2,
          '--branch',
          'feat/t84-no-sess',
          '--allow',
          'hello.txt',
          '--test',
          'true',
        ],
        deps2
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code2, 0, `ticket run exit 應為 0，實際為 ${code2}`)
    const lifecycleFile2 = path.join(repo2.dir, '.local', 'llm-team', 't84-no-sess', 'lifecycle.ndjson')
    assert.ok(fs.existsSync(lifecycleFile2), `lifecycle.ndjson 應存在: ${lifecycleFile2}`)
    const lines2 = fs
      .readFileSync(lifecycleFile2, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.ok(lines2.length >= 3, `lifecycle 應至少有 3 行，實際行數: ${lines2.length}`)
    for (let i = 0; i < lines2.length; i++) {
      assert.equal(lines2[i].sessionId, null, `第 ${i} 行 (${lines2[i].event}) sessionId 應為 null，實際為 ${lines2[i].sessionId}`)
    }
  })

  test('(h) 1.8.0：usage.mode=off（預設，config 沒帶 usage 欄位）accept 沒 --caliber ⇒ 0、summary 沒被寫入 caliber、但有 measurementSchemaVersion', async () => {
    const repo = makeRepo()
    const outDir = path.join(repo.dir, '.local', 'llm-team', 't-h')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      ticket: 't-h',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const code = await ticketMain(['accept', '--name', 't-h', '--q6', 'receipt-ok'], { repoRoot: repo.dir })

    assert.equal(code, 0, `usage.mode=off 時缺 --caliber 應 exit 0，實際：${code}`)
    const s = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(s.caliber, undefined, '未帶 --caliber 不應被寫入 caliber')
    assert.equal(s.measurementSchemaVersion, MEASUREMENT_SCHEMA_VERSION, 'accept 一律蓋 measurementSchemaVersion，與 caliber 是否必填無關')
    assert.equal(s.q6Receipt, 'receipt-ok')
  })

  test('(h2) 1.8.0 陽性對照：usage.mode=cohort 時 accept 沒 --caliber ⇒ 2、stderr 含「usage.mode=cohort 時 --caliber 必填」；帶合法 --caliber ⇒ 0', async () => {
    const repo = makeRepo({ usage: { mode: 'cohort' } })
    const outDir = path.join(repo.dir, '.local', 'llm-team', 't-h2')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify({ schemaVersion: 2, coordinator: 'claude', ticket: 't-h2' }, null, 2)
    )

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['accept', '--name', 't-h2', '--q6', 'receipt-ok'], { repoRoot: repo.dir })
    } finally {
      console.error = origErr
    }
    assert.equal(code, 2, `usage.mode=cohort 缺 --caliber 應 exit 2，實際：${code}`)
    assert.match(errs.join('\n'), /usage\.mode=cohort 時 --caliber 必填/)
    const sAfterFail = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(sAfterFail.caliber, undefined)

    const code2 = await ticketMain(
      ['accept', '--name', 't-h2', '--caliber', 'tool', '--q6', 'receipt-ok'],
      { repoRoot: repo.dir }
    )
    assert.equal(code2, 0, `usage.mode=cohort 帶合法 --caliber 應 exit 0，實際：${code2}`)
    const sAfterOk = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(sAfterOk.caliber, 'tool')
  })

  test('(h3) 1.8.0 停止條件：usage.mode=off 時 accept（不帶 --caliber）→ publish／land 都不因缺 caliber／usage 產物失敗', async () => {
    // publish 分支（沿用 T25 的 fake gh 手法）
    {
      const repo = makeRepo()
      const worktreePath = path.join(repo.dir, '.claude', 'worktrees', 'tu1')
      fs.mkdirSync(worktreePath, { recursive: true })
      fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'content')
      const outDir = path.join(repo.dir, '.local', 'llm-team', 'tu1')
      fs.mkdirSync(outDir, { recursive: true })
      const summary = {
        schemaVersion: 2,
        coordinator: 'claude',
        reviewers: ROSTER_STANDARD,
        project: 'test-proj',
        ticket: 'tu1',
        branch: 'feat/tu1--slice',
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
      }
      fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

      const deps = {
        repoRoot: repo.dir,
        changedFiles: () => ['file.txt'],
        git: () => '',
        spawn: (cmd, args) => {
          if (cmd === 'gh') {
            if (args[0] === '--version') return { status: 0, stdout: 'gh 2.50.0' }
            if (args[0] === 'pr') return { status: 0, stdout: 'https://github.com/org/repo/pull/1' }
          }
          return { status: 0, stdout: '' }
        },
      }

      const acceptCode = await ticketMain(['accept', '--name', 'tu1', '--q6', '親自坐實'], deps)
      assert.equal(acceptCode, 0, `usage.mode=off 缺 --caliber 時 accept 應回 0，實際：${acceptCode}`)
      const s = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
      assert.equal(s.caliber, undefined)
      assert.equal(s.measurementSchemaVersion, MEASUREMENT_SCHEMA_VERSION)

      let ghCalled = false
      const deps2 = {
        ...deps,
        spawn: (cmd, args) => {
          if (cmd === 'gh') {
            ghCalled = true
            if (args[0] === '--version') return { status: 0, stdout: 'gh 2.50.0' }
            if (args[0] === 'pr') return { status: 0, stdout: 'https://github.com/org/repo/pull/1' }
          }
          return { status: 0, stdout: '' }
        },
      }
      const publishCode = await ticketMain(['publish', '--name', 'tu1'], deps2)
      assert.equal(publishCode, 0, `publish 不應因缺 caliber／usage 產物失敗，實際：${publishCode}`)
      assert.equal(ghCalled, true, 'gh 應被呼叫（未被 caliber／usage 檢查擋下）')
    }

    // land 分支（沿用 makeLandFixture，但拿掉 q6Receipt，改走 accept 補上）
    {
      const { repo, worktreePath, outDir, msgFile } = makeLandFixture({ name: 'tu2', branch: 'feat/tu2' })
      const preSummary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
      delete preSummary.q6Receipt
      fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(preSummary, null, 2))

      const acceptCode = await ticketMain(['accept', '--name', 'tu2', '--q6', '親自坐實'], { repoRoot: repo.dir })
      assert.equal(acceptCode, 0, `usage.mode=off 缺 --caliber 時 accept 應回 0，實際：${acceptCode}`)

      const deps = {
        repoRoot: repo.dir,
        changedFiles: () => ['file.txt'],
        git: (cwd, args) => {
          if (cwd === repo.dir && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return 'main'
          if (cwd === worktreePath && args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return 'feat/tu2'
          if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') return 'file.txt'
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'new-main-sha-tu2'
          if (args[0] === 'rev-parse' && args[1] === 'main') return 'mock-target-tip-sha'
          return ''
        },
      }
      const code = await ticketMain(['land', '--name', 'tu2', '--msg-file', msgFile], deps)
      assert.equal(code, 0, `land 不應因缺 caliber／usage 產物失敗，實際：${code}`)
    }
  })

  test('(i) accept --caliber feature ⇒ 0、summary.caliber === "feature"、caliberBy === "coordinator"', async () => {
    const repo = makeRepo()
    const outDir = path.join(repo.dir, '.local', 'llm-team', 't-i')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      ticket: 't-i',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const code = await ticketMain(['accept', '--name', 't-i', '--caliber', 'feature', '--q6', 'receipt-ok'], { repoRoot: repo.dir })
    assert.equal(code, 0)
    const s = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(s.caliber, 'feature')
    assert.equal(s.caliberBy, 'coordinator')
  })

  test('(j) accept --caliber xyz ⇒ 2', async () => {
    const repo = makeRepo()
    const outDir = path.join(repo.dir, '.local', 'llm-team', 't-j')
    fs.mkdirSync(outDir, { recursive: true })
    const summary = {
      schemaVersion: 2,
      coordinator: 'claude',
      ticket: 't-j',
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await ticketMain(['accept', '--name', 't-j', '--caliber', 'xyz', '--q6', 'receipt-ok'], { repoRoot: repo.dir })
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2)
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
      fs.mkdirSync(path.dirname(p), { recursive: true })
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
      fs.mkdirSync(path.dirname(p), { recursive: true })
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


