/**
 * `home/skills/llm-team/usage.mjs` 的自證測試。
 *
 * 🔴 硬規則：所有寫入都在 mkdtemp 的暫存區，清理用 rmSync；
 *    所有測試使用 node:test，不引入第三方套件。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, createReadStream, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseLifecycleWindow,
  isCoordinatorTurn,
  isNotificationTurn,
  accumulate,
  slugOf,
  findTranscript,
  findTranscriptAcross,
  findTranscriptBySession,
  findMainRepo,
  readLines,
  main as cliMain,
  loadOtherWindows,
  attributeRecord,
  cohortReport,
  measureTicketLive,
  canonicalStringify,
  buildCohortPayload,
  writeCohortJson,
  lifecycleHashOf,
  COHORT_JSON_SCHEMA_VERSION,
} from './usage.mjs'
import { MEASUREMENT_SCHEMA_VERSION } from './lib.mjs'

const TOOL_PATH = fileURLToPath(new URL('./usage.mjs', import.meta.url))
const CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url))
const BASE_CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))

const makeFixtureConfig = (root, overrides = {}) => {
  const cfg = {
    ...BASE_CONFIG,
    outDir: join(root, '.local/llm-team'),
    worktreeRoot: join(root, '.claude/worktrees'),
    ...overrides,
  }
  const cfgPath = join(root, 'llm-team.config.json')
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  return cfgPath
}

// ── fixture 暫存區管理 ────────────────────────────────────────────────────────

const tmps = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'coordinator-usage-test-'))
  tmps.push(d)
  return d
}

// 供「真源環境 readToolVersionInfo」需要 git rev-parse HEAD 成功的既有測試使用（sol 第 5 輪 Q2：
// 真源分支現在會嚴驗 sourceCommit 是 40 碼 hex、git 失敗會 fail-closed，而這些測試的 repoRoot 是
// 假的 tmp 目錄、不是真 git repo，故注入這個假 gitFn 讓它們不因為這個與測試主旨無關的分支而變紅）。
const FAKE_SOURCE_COMMIT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const fakeGit = () => FAKE_SOURCE_COMMIT

test.after(() => {
  for (const d of tmps) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 暫存區清理 */
    }
  }
})

const write = (dir, rel, content) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeFileSync(join(dir, rel), content)
}

// ── 1. parseLifecycleWindow ─────────────────────────────────────────────────

test('parseLifecycleWindow：有 accepted ⇒ windowEnd 為 accepted', () => {
  const entries = [
    { at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket: 't1' },
    { at: '2026-09-14T10:05:00.000Z', event: 'writer-done', ticket: 't1' },
    { at: '2026-09-14T10:10:00.000Z', event: 'accepted', ticket: 't1' },
  ]
  const win = parseLifecycleWindow(entries)
  assert.equal(win.from, '2026-09-14T10:00:00.000Z')
  assert.equal(win.to, '2026-09-14T10:10:00.000Z')
  assert.equal(win.windowEnd, 'accepted')
})

test('parseLifecycleWindow：沒 accepted ⇒ windowEnd 為 last-event', () => {
  const entries = [
    { at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket: 't2' },
    { at: '2026-09-14T10:05:00.000Z', event: 'writer-done', ticket: 't2' },
    { at: '2026-09-14T10:08:00.000Z', event: 'review-done', ticket: 't2' },
  ]
  const win = parseLifecycleWindow(entries)
  assert.equal(win.from, '2026-09-14T10:00:00.000Z')
  assert.equal(win.to, '2026-09-14T10:08:00.000Z')
  assert.equal(win.windowEnd, 'last-event')
})

test('parseLifecycleWindow：--from --to 覆寫 ⇒ windowEnd 為 override', () => {
  const entries = [
    { at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket: 't3' },
    { at: '2026-09-14T10:10:00.000Z', event: 'accepted', ticket: 't3' },
  ]
  const winFrom = parseLifecycleWindow(entries, { from: '2026-09-14T10:02:00.000Z' })
  assert.equal(winFrom.from, '2026-09-14T10:02:00.000Z')
  assert.equal(winFrom.to, '2026-09-14T10:10:00.000Z')
  assert.equal(winFrom.windowEnd, 'override')

  const winTo = parseLifecycleWindow(entries, { to: '2026-09-14T10:09:00.000Z' })
  assert.equal(winTo.from, '2026-09-14T10:00:00.000Z')
  assert.equal(winTo.to, '2026-09-14T10:09:00.000Z')
  assert.equal(winTo.windowEnd, 'override')

  const winBoth = parseLifecycleWindow(entries, {
    from: '2026-09-14T10:01:00.000Z',
    to: '2026-09-14T10:08:00.000Z',
  })
  assert.equal(winBoth.from, '2026-09-14T10:01:00.000Z')
  assert.equal(winBoth.to, '2026-09-14T10:08:00.000Z')
  assert.equal(winBoth.windowEnd, 'override')
})

test('parseLifecycleWindow：兩筆 accepted 夾 run-start 且無 landed ⇒ to 為第二筆 accepted、windowEnd 為 accepted', () => {
  const entries = [
    { at: '2026-09-15T06:23:49.000Z', event: 'run-start', ticket: 't-multi' },
    { at: '2026-09-15T06:46:30.000Z', event: 'accepted', ticket: 't-multi' },
    { at: '2026-09-15T06:49:40.000Z', event: 'run-start', ticket: 't-multi' },
    { at: '2026-09-15T07:08:40.000Z', event: 'accepted', ticket: 't-multi' },
  ]
  const win = parseLifecycleWindow(entries)
  assert.equal(win.from, '2026-09-15T06:23:49.000Z')
  assert.equal(win.to, '2026-09-15T07:08:40.000Z', `to 應為第二筆 accepted 的 at，實際：${win.to}`)
  assert.equal(win.windowEnd, 'accepted', `windowEnd 應為 accepted，實際：${win.windowEnd}`)
})

test('parseLifecycleWindow：同序再加 landed ⇒ to 為 landed 的 at、windowEnd 為 landed', () => {
  const entries = [
    { at: '2026-09-15T06:23:49.000Z', event: 'run-start', ticket: 't-multi' },
    { at: '2026-09-15T06:46:30.000Z', event: 'accepted', ticket: 't-multi' },
    { at: '2026-09-15T06:49:40.000Z', event: 'run-start', ticket: 't-multi' },
    { at: '2026-09-15T07:08:40.000Z', event: 'accepted', ticket: 't-multi' },
    { at: '2026-09-15T07:08:40.000Z', event: 'landed', ticket: 't-multi' },
  ]
  const win = parseLifecycleWindow(entries)
  assert.equal(win.from, '2026-09-15T06:23:49.000Z')
  assert.equal(win.to, '2026-09-15T07:08:40.000Z', `to 應為 landed 的 at，實際：${win.to}`)
  assert.equal(win.windowEnd, 'landed', `windowEnd 應為 landed，實際：${win.windowEnd}`)
})

// ── 2. isCoordinatorTurn ────────────────────────────────────────────────────

test('isCoordinatorTurn：正例 1 條（external、文字）；反例各 1 條：tool_result 區塊、isMeta:true、isSidechain:true、文字以 <task-notification> 開頭、userType 缺。斷言訊息帶那筆記錄的形狀', () => {
  // 正例
  const positive = {
    type: 'user',
    userType: 'external',
    isSidechain: false,
    isMeta: false,
    message: { content: 'Please implement ticket X' },
  }
  assert.equal(
    isCoordinatorTurn(positive),
    true,
    `正例應判定為 true，記錄形狀：${JSON.stringify(positive)}`
  )

  // 反例 1：tool_result 區塊
  const counterToolResult = {
    type: 'user',
    userType: 'external',
    isSidechain: false,
    isMeta: false,
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'command output' },
      ],
    },
  }
  assert.equal(
    isCoordinatorTurn(counterToolResult),
    false,
    `反例（含 tool_result 區塊）應為 false，記錄形狀：${JSON.stringify(counterToolResult)}`
  )

  // 反例 2：isMeta: true
  const counterMeta = {
    type: 'user',
    userType: 'external',
    isSidechain: false,
    isMeta: true,
    message: { content: 'meta info message' },
  }
  assert.equal(
    isCoordinatorTurn(counterMeta),
    false,
    `反例（isMeta:true）應為 false，記錄形狀：${JSON.stringify(counterMeta)}`
  )

  // 反例 3：isSidechain: true
  const counterSidechain = {
    type: 'user',
    userType: 'external',
    isSidechain: true,
    isMeta: false,
    message: { content: 'sidechain message' },
  }
  assert.equal(
    isCoordinatorTurn(counterSidechain),
    false,
    `反例（isSidechain:true）應為 false，記錄形狀：${JSON.stringify(counterSidechain)}`
  )

  // 反例 4：文字以 <task-notification> 開頭
  const counterTaskNotification = {
    type: 'user',
    userType: 'external',
    isSidechain: false,
    isMeta: false,
    message: { content: '<task-notification> Background task completed' },
  }
  assert.equal(
    isCoordinatorTurn(counterTaskNotification),
    false,
    `反例（<task-notification> 開頭）應為 false，記錄形狀：${JSON.stringify(counterTaskNotification)}`
  )
  assert.equal(
    isNotificationTurn(counterTaskNotification),
    true,
    `反例（<task-notification>）應計入通知排除，記錄形狀：${JSON.stringify(counterTaskNotification)}`
  )

  // 反例 5：userType 缺
  const counterMissingUserType = {
    type: 'user',
    isSidechain: false,
    isMeta: false,
    message: { content: 'hello without userType' },
  }
  assert.equal(
    isCoordinatorTurn(counterMissingUserType),
    false,
    `反例（缺 userType）應為 false，記錄形狀：${JSON.stringify(counterMissingUserType)}`
  )
})

// ── 3. accumulate ───────────────────────────────────────────────────────────

test('accumulate：寫一個 6 筆的假 transcript（2 個 user 頂層 turn、1 個 task-notification、3 個 assistant 各帶 usage、其中 1 筆在視窗外）⇒ 手算斷言與陽性對照', () => {
  const window = {
    from: '2026-09-14T10:00:00.000Z',
    to: '2026-09-14T12:00:00.000Z',
    windowEnd: 'accepted',
  }

  // 6 筆記錄：
  // 1: user 頂層 turn 1 (10:05)
  // 2: user task-notification (10:15)
  // 3: user 頂層 turn 2 (10:30)
  // 4: assistant 1 (10:10) — usage: input 100, cacheCreation 20, cacheRead 300, output 50
  // 5: assistant 2 (10:40) — usage: input 200, cacheCreation 40, cacheRead 500, output 70
  // 6: assistant 3 (13:00，視窗外) — usage: input 1000, cacheCreation 500, cacheRead 2000, output 300
  const records = [
    {
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:05:00.000Z',
      message: { content: 'turn 1' },
    },
    {
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:15:00.000Z',
      message: { content: '<task-notification> task done' },
    },
    {
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:30:00.000Z',
      message: { content: [{ type: 'text', text: 'turn 2' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-14T10:10:00.000Z',
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 50,
        },
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-14T10:40:00.000Z',
      message: {
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 500,
          output_tokens: 70,
        },
        content: [
          { type: 'tool_use', name: 'Bash' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-14T13:00:00.000Z', // 視窗外
      message: {
        usage: {
          input_tokens: 1000,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 2000,
          output_tokens: 300,
        },
        content: [{ type: 'tool_use', name: 'Write' }],
      },
    },
  ]

  // 手算數字：
  // coordinatorTurns = 2
  // notificationsExcluded = 1
  // apiCalls = 2
  // input = 100 + 200 = 300
  // cacheCreation = 20 + 40 = 60
  // cacheRead = 300 + 500 = 800
  // output = 50 + 70 = 120
  // toolCalls = { Bash: 2, Read: 1 }
  const stats = accumulate(records, window)
  assert.equal(stats.coordinatorTurns, 2, '視窗內 user turn 應為 2')
  assert.equal(stats.notificationsExcluded, 1, '排除的通知筆數應為 1')
  assert.equal(stats.apiCalls, 2, '視窗內 API 呼叫應為 2')
  assert.equal(stats.usage.input, 300, '手算 input 應為 300')
  assert.equal(stats.usage.cacheCreation, 60, '手算 cacheCreation 應為 60')
  assert.equal(stats.usage.cacheRead, 800, '手算 cacheRead 應為 800')
  assert.equal(stats.usage.output, 120, '手算 output 應為 120')
  assert.deepEqual(stats.toolCalls, { Bash: 2, Read: 1 }, '手算 toolCalls 計數相符')

  // 陽性對照：把視窗外那筆的 timestamp 改進視窗內，數字必須變
  const modifiedRecords = records.map((r, idx) => {
    if (idx === 5) return { ...r, timestamp: '2026-09-14T11:00:00.000Z' }
    return r
  })
  const statsModified = accumulate(modifiedRecords, window)
  assert.equal(statsModified.apiCalls, 3, '陽性對照：第 6 筆進視窗後 apiCalls 變為 3')
  assert.equal(statsModified.usage.input, 1300, '陽性對照：input 變為 1300')
  assert.equal(statsModified.usage.cacheCreation, 560, '陽性對照：cacheCreation 變為 560')
  assert.equal(statsModified.usage.cacheRead, 2800, '陽性對照：cacheRead 變為 2800')
  assert.equal(statsModified.usage.output, 420, '陽性對照：output 變為 420')
  assert.deepEqual(statsModified.toolCalls, { Bash: 2, Read: 1, Write: 1 }, '陽性對照：多了 Write 工具呼叫')
})

// ── 4. findTranscript ───────────────────────────────────────────────────────

test('findTranscript：兩個 jsonl 都含 ticket.mjs run --name x，一個 timestamp 晚於 from ⇒ 取早的那個；子目錄裡的 jsonl 不被掃到；壞 JSON 行不炸', async () => {
  const dir = tmp()
  const from = '2026-09-14T12:00:00.000Z'
  const ticket = 'test-ticket-xyz'

  // 檔 1：早於 from，且中間夾帶壞 JSON 行
  const fileEarly = join(dir, 'session-early.jsonl')
  const earlyContent = [
    JSON.stringify({ type: 'user', timestamp: '2026-09-14T11:00:00.000Z', message: { content: 'hello' } }),
    '{ this is a corrupted bad json line }',
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T11:30:00.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: `node .agents/skills/llm-team/ticket.mjs run --name ${ticket} --coordinator claude` },
          },
        ],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(fileEarly, earlyContent)

  // 檔 2：晚於 from
  const fileLate = join(dir, 'session-late.jsonl')
  const lateContent = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T12:30:00.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: `node ticket.mjs run --name ${ticket}` },
          },
        ],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(fileLate, lateContent)

  // 子目錄裡的 jsonl（模擬 subagent transcript，不該被掃到）
  const subagentDir = join(dir, 'subagents-dir')
  mkdirSync(subagentDir, { recursive: true })
  const fileSubagent = join(subagentDir, 'subagent.jsonl')
  const subagentContent = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T11:59:00.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: `node ticket.mjs run --name ${ticket}` },
          },
        ],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(fileSubagent, subagentContent)

  // 非空分母保護：fixture 頂層真的有 jsonl 才往下量（沒建成 ⇒ findTranscript 的空結果會被下面的
  // assert.equal 判紅，但這裡先把「母體是空的」和「母體有東西卻選錯」分成兩種紅）
  const topLevelJsonl = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  assert.ok(topLevelJsonl.length > 0, `fixture 頂層沒有任何 .jsonl：${dir} 內只有 ${JSON.stringify(readdirSync(dir))}`)
  assert.equal(topLevelJsonl.length, 2, `fixture 頂層 jsonl 應為 2 個，實際：${JSON.stringify(topLevelJsonl)}`)

  const found = await findTranscript(dir, ticket, from)
  assert.equal(found, fileEarly, '應取不晚於 from 的檔（session-early.jsonl），且略過子目錄與壞行')
})

// ── 5. --write 回填 summary.json ───────────────────────────────────────────

test('--write：summary.json 原有其他欄位保留、comparable 由 false 變 true、coordinatorTurns 由 null 變數字', async () => {
  const root = tmp()
  const ticket = 'ticket-write-test'
  const localDir = join(root, '.local/llm-team')

  const lifecycleContent = [
    JSON.stringify({ at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket }),
    JSON.stringify({ at: '2026-09-14T10:15:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleContent)

  const initialSummary = {
    schemaVersion: 2,
    project: 'web-agency-system',
    ticket,
    branch: `chore/${ticket}`,
    writeExit: 0,
    coordinator: 'claude',
    roster: ['claude', 'gemini'],
    coordinatorTurns: null,
    comparable: false,
    dispositions: ['keep-intact'],
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const transcriptPath = join(root, 'session.jsonl')
  const transcriptContent = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:02:00.000Z',
      message: { content: 'start ticket' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T10:05:00.000Z',
      message: {
        usage: {
          input_tokens: 150,
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 400,
          output_tokens: 60,
        },
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(transcriptPath, transcriptContent)

  const cfgPath = makeFixtureConfig(root)

  const exitCode = await cliMain([
    '--ticket', ticket,
    '--config', cfgPath,
    '--transcript', transcriptPath,
    '--write',
  ], { cwd: root, repoRoot: root })

  assert.equal(exitCode, 0, 'CLI 應回傳 0')

  const writtenSummary = JSON.parse(readFileSync(join(localDir, `${ticket}/summary.json`), 'utf8'))
  // 原有其他欄位必須原樣保留
  assert.equal(writtenSummary.schemaVersion, 2)
  assert.equal(writtenSummary.project, 'web-agency-system')
  assert.equal(writtenSummary.branch, `chore/${ticket}`)
  assert.equal(writtenSummary.writeExit, 0)
  assert.deepEqual(writtenSummary.roster, ['claude', 'gemini'])
  assert.deepEqual(writtenSummary.dispositions, ['keep-intact'])

  // comparable 由 false 變 true
  assert.equal(writtenSummary.comparable, true)
  // coordinatorTurns 由 null 變數字
  assert.equal(writtenSummary.coordinatorTurns, 1)

  // coordinatorUsage 存在且包含正確值
  assert.ok(writtenSummary.coordinatorUsage)
  assert.equal(writtenSummary.coordinatorUsage.input, 150)
  assert.equal(writtenSummary.coordinatorUsage.cacheCreation, 25)
  assert.equal(writtenSummary.coordinatorUsage.cacheRead, 400)
  assert.equal(writtenSummary.coordinatorUsage.output, 60)
  assert.equal(writtenSummary.coordinatorUsage.apiCalls, 1)
  assert.equal(typeof writtenSummary.coordinatorUsage.apiCalls, 'number')
  assert.deepEqual(writtenSummary.coordinatorUsage.toolCalls, { Bash: 1 })

  // usage 欄位
  assert.equal(writtenSummary.usage?.measurable, true)

  // usageWindow 存在
  assert.ok(writtenSummary.usageWindow)
  assert.equal(writtenSummary.usageWindow.from, '2026-09-14T10:00:00.000Z')
  assert.equal(writtenSummary.usageWindow.to, '2026-09-14T10:15:00.000Z')
  assert.equal(writtenSummary.usageWindow.windowEnd, 'accepted')
  assert.equal(writtenSummary.usageWindow.transcript, transcriptPath)
  assert.ok(writtenSummary.usageWindow.measuredAt)
})

// ── 6. CLI 未知旗標 ─────────────────────────────────────────────────────────

test('CLI：未知旗標 exit 2 且訊息指名該未知旗標（實跑子行程）', () => {
  let code = 0
  let stderr = ''
  try {
    execFileSync(process.execPath, [TOOL_PATH, '--invalid-custom-flag'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    code = e.status
    stderr = String(e.stderr ?? '')
  }
  assert.equal(code, 2, `未知旗標應 exit 2，實際 code: ${code}`)
  assert.match(stderr, /--invalid-custom-flag/, 'stderr 應指明該未知旗標名稱')
})

test('CLI：缺少必填 --ticket 旗標 exit 2', () => {
  let code = 0
  let stderr = ''
  try {
    execFileSync(process.execPath, [TOOL_PATH], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    code = e.status
    stderr = String(e.stderr ?? '')
  }
  assert.equal(code, 2)
  assert.match(stderr, /--ticket/)
})

// ── 7. slugOf ───────────────────────────────────────────────────────────────

test('slugOf：將路徑斜線轉換為破折號', () => {
  assert.equal(
    slugOf('/Users/fergus/Desktop/workshop/fergus/web-agency-system'),
    '-Users-fergus-Desktop-workshop-fergus-web-agency-system'
  )
  assert.equal(
    slugOf('/home/user/project'),
    '-home-user-project'
  )
})

// ── 8. CLI 端對端（tmp fixture） ────────────────────────────────────────────

test('CLI 端對端（tmp）：完整流程執行，輸出 JSON 結構正確', async () => {
  const root = tmp()
  const ticket = 'e2e-ticket'
  const localDir = join(root, '.local/llm-team')

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const lifecycleContent = [
    JSON.stringify({ at: '2026-09-14T08:00:00.000Z', event: 'run-start', ticket }),
    JSON.stringify({ at: '2026-09-14T08:30:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleContent)

  const transcriptPath = join(root, 'session.jsonl')
  const transcriptContent = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T08:05:00.000Z',
      message: { content: 'do work' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T08:10:00.000Z',
      message: {
        usage: {
          input_tokens: 80,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 200,
          output_tokens: 40,
        },
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(transcriptPath, transcriptContent)

  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  const origLog = console.log
  console.log = (...args) => {
    stdoutOutput += args.join(' ') + '\n'
  }
  let exitCode
  try {
    exitCode = await cliMain([
      '--ticket', ticket,
      '--config', cfgPath,
      '--transcript', transcriptPath,
      '--json',
    ], { cwd: root, repoRoot: root })
  } finally {
    console.log = origLog
  }

  assert.equal(exitCode, 0)
  const parsed = JSON.parse(stdoutOutput.trim())
  assert.equal(parsed.ticket, ticket)
  assert.equal(parsed.transcript, transcriptPath)
  assert.equal(parsed.coordinatorTurns, 1)
  assert.equal(parsed.notificationsExcluded, 0)
  assert.equal(parsed.apiCalls, 1)
  assert.equal(parsed.usage.input, 80)
  assert.equal(parsed.usage.cacheCreation, 10)
  assert.equal(parsed.usage.cacheRead, 200)
  assert.equal(parsed.usage.output, 40)
  assert.deepEqual(parsed.toolCalls, { Bash: 1 })
  assert.equal(parsed.window.from, '2026-09-14T08:00:00.000Z')
  assert.equal(parsed.window.to, '2026-09-14T08:30:00.000Z')
  assert.equal(parsed.window.windowEnd, 'accepted')
  assert.ok(parsed.measuredAt)
})

// ── 9. harness 判定與可攜化測試 ──────────────────────────────────────────────

test('harness=agy ＋ --write ⇒ exit 0、summary.usage 為 {measurable:false, reason:"no-transcript-for-harness:agy"}、沒有 coordinatorUsage 欄、stdout 含「不可量」', async () => {
  const root = tmp()
  const ticket = 'ticket-agy-harness'
  const localDir = join(root, '.local/llm-team')

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'agy',
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  const origLog = console.log
  console.log = (...args) => {
    stdoutOutput += args.join(' ') + '\n'
  }
  let exitCode
  try {
    exitCode = await cliMain([
      '--ticket', ticket,
      '--config', cfgPath,
      '--write',
    ], { cwd: root, repoRoot: root })
  } finally {
    console.log = origLog
  }

  assert.equal(exitCode, 0, 'exit code 應為 0')
  assert.match(stdoutOutput, /不可量/, 'stdout 應含「不可量」')

  const writtenSummary = JSON.parse(readFileSync(join(localDir, `${ticket}/summary.json`), 'utf8'))
  assert.deepEqual(writtenSummary.usage, {
    measurable: false,
    reason: 'no-transcript-for-harness:agy',
  })
  assert.equal(writtenSummary.coordinatorUsage, undefined, '沒有 coordinatorUsage 欄')
})

test('harness=claude 但 lifecycle 缺 ⇒ exit 1', async () => {
  const root = tmp()
  const ticket = 'ticket-claude-no-lifecycle'
  const localDir = join(root, '.local/llm-team')

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const cfgPath = makeFixtureConfig(root)

  const exitCode = await cliMain([
    '--ticket', ticket,
    '--config', cfgPath,
    '--write',
  ], { cwd: root, repoRoot: root })

  assert.equal(exitCode, 1, 'harness 是 claude 但 lifecycle 檔找不到應 exit 1')
})

test('summary 無 coordinator 欄 ⇒ exit 0、reason coordinator-profile-unknown', async () => {
  const root = tmp()
  const ticket = 'ticket-no-coordinator-profile'
  const localDir = join(root, '.local/llm-team')

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const cfgPath = makeFixtureConfig(root)

  const exitCode = await cliMain([
    '--ticket', ticket,
    '--config', cfgPath,
    '--write',
  ], { cwd: root, repoRoot: root })

  assert.equal(exitCode, 0, 'summary 沒有 coordinator 欄應 exit 0')

  const writtenSummary = JSON.parse(readFileSync(join(localDir, `${ticket}/summary.json`), 'utf8'))
  assert.deepEqual(writtenSummary.usage, {
    measurable: false,
    reason: 'coordinator-profile-unknown',
  })
})

test('worktreeRoot 改成 wt 時 findMainRepo 對 /x/wt/t1 回 /x', () => {
  const mockConfig = { worktreeRoot: 'wt' }
  const mainRepo = findMainRepo('/x/wt/t1', mockConfig)
  assert.equal(mainRepo, '/x', 'worktreeRoot 改成 wt 時應回傳 /x')
})

test('成功 --write 後斷言 summary.usage.measurable === true 且 coordinatorUsage.apiCalls 是數字', async () => {
  const root = tmp()
  const ticket = 'ticket-write-assertions'
  const localDir = join(root, '.local/llm-team')

  const lifecycleContent = [
    JSON.stringify({ at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket }),
    JSON.stringify({ at: '2026-09-14T10:15:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleContent)

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const transcriptPath = join(root, 'session.jsonl')
  const transcriptContent = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:02:00.000Z',
      message: { content: 'start' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T10:05:00.000Z',
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 200,
          output_tokens: 50,
        },
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(transcriptPath, transcriptContent)

  const cfgPath = makeFixtureConfig(root)

  const exitCode = await cliMain([
    '--ticket', ticket,
    '--config', cfgPath,
    '--transcript', transcriptPath,
    '--write',
  ], { cwd: root, repoRoot: root })

  assert.equal(exitCode, 0)
  const writtenSummary = JSON.parse(readFileSync(join(localDir, `${ticket}/summary.json`), 'utf8'))
  assert.equal(writtenSummary.usage?.measurable, true, 'summary.usage.measurable 應為 true')
  assert.equal(typeof writtenSummary.coordinatorUsage?.apiCalls, 'number', 'coordinatorUsage.apiCalls 應為數字')
})

test('--config 指到不存在的檔 ⇒ exit 2 且 summary 未被改寫', async () => {
  const root = tmp()
  const ticket = 'ticket-nonexistent-config'
  const localDir = join(root, '.local/llm-team')

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  const summaryContent = JSON.stringify(initialSummary, null, 2) + '\n'
  write(localDir, `${ticket}/summary.json`, summaryContent)
  const summaryFile = join(localDir, `${ticket}/summary.json`)
  const statBefore = statSync(summaryFile)

  const nonExistentConfig = join(root, 'does-not-exist.json')

  const exitCode = await cliMain([
    '--ticket', ticket,
    '--config', nonExistentConfig,
    '--write',
  ], { cwd: root, repoRoot: root })

  assert.equal(exitCode, 2, 'config 不存在應 exit 2')
  const contentAfter = readFileSync(summaryFile, 'utf8')
  assert.equal(contentAfter, summaryContent, 'summary.json 內容不應被改寫')
  const statAfter = statSync(summaryFile)
  assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, 'summary.json mtime 不應被改變')
})

test('summary 不存在（無 --write）⇒ exit 1', async () => {
  const root = tmp()
  const ticket = 'ticket-no-summary'
  const cfgPath = makeFixtureConfig(root)

  const exitCode = await cliMain([
    '--ticket', ticket,
    '--config', cfgPath,
  ], { cwd: root, repoRoot: root })

  assert.equal(exitCode, 1, 'summary.json 不存在應 exit 1')
})

test('summary 有 roster 含 claude 但沒有 coordinator 欄 ⇒ reason coordinator-profile-unknown（不准猜）', async () => {
  const root = tmp()
  const ticket = 'ticket-roster-no-coordinator'
  const localDir = join(root, '.local/llm-team')

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    roster: ['claude', 'gemini'],
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const cfgPath = makeFixtureConfig(root)

  const exitCode = await cliMain([
    '--ticket', ticket,
    '--config', cfgPath,
    '--write',
  ], { cwd: root, repoRoot: root })

  assert.equal(exitCode, 0, 'exit code 應為 0')
  const writtenSummary = JSON.parse(readFileSync(join(localDir, `${ticket}/summary.json`), 'utf8'))
  assert.deepEqual(writtenSummary.usage, {
    measurable: false,
    reason: 'coordinator-profile-unknown',
  })
})

test('transcript 視窗內夾毀損行 ⇒ exit 1、stderr 含「毀損行」與行號、summary 逐位元組相同', async () => {
  const root = tmp()
  const ticket = 'ticket-corrupt-line'
  const localDir = join(root, '.local/llm-team')

  const lifecycleContent = [
    JSON.stringify({ at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket }),
    JSON.stringify({ at: '2026-09-14T10:15:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleContent)

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  const summaryFile = join(localDir, `${ticket}/summary.json`)
  const summaryContentBefore = JSON.stringify(initialSummary, null, 2) + '\n'
  write(localDir, `${ticket}/summary.json`, summaryContentBefore)
  const summaryBytesBefore = readFileSync(summaryFile)

  const transcriptPath = join(root, 'session.jsonl')
  const transcriptContent = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:02:00.000Z',
      message: { content: 'start' },
    }),
    '{"type":"assistant","message":{"content":[',
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T10:05:00.000Z',
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 200,
          output_tokens: 50,
        },
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(transcriptPath, transcriptContent)

  const cfgPath = makeFixtureConfig(root)

  let stderr = ''
  const origError = console.error
  console.error = (...args) => {
    stderr += args.join(' ') + '\n'
  }
  let exitCode
  try {
    exitCode = await cliMain([
      '--ticket', ticket,
      '--config', cfgPath,
      '--transcript', transcriptPath,
      '--write',
    ], { cwd: root, repoRoot: root })
  } finally {
    console.error = origError
  }

  assert.equal(exitCode, 1, 'transcript 夾毀損行應 exit 1')
  assert.match(stderr, /毀損行/, 'stderr 應含「毀損行」')
  assert.match(stderr, /:2/, 'stderr 應含 :<行號>')
  const summaryBytesAfter = readFileSync(summaryFile)
  assert.deepEqual(summaryBytesAfter, summaryBytesBefore, 'summary 檔內容與跑前應逐位元組相同')
})

test('陽性對照：同一份 transcript 拿掉毀損行 ⇒ exit 0 且 coordinatorUsage.apiCalls 是數字', async () => {
  const root = tmp()
  const ticket = 'ticket-clean-positive-control'
  const localDir = join(root, '.local/llm-team')

  const lifecycleContent = [
    JSON.stringify({ at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket }),
    JSON.stringify({ at: '2026-09-14T10:15:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleContent)

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const transcriptPath = join(root, 'session.jsonl')
  const transcriptContent = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:02:00.000Z',
      message: { content: 'start' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T10:05:00.000Z',
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 200,
          output_tokens: 50,
        },
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(transcriptPath, transcriptContent)

  const cfgPath = makeFixtureConfig(root)

  const exitCode = await cliMain([
    '--ticket', ticket,
    '--config', cfgPath,
    '--transcript', transcriptPath,
    '--write',
  ], { cwd: root, repoRoot: root })

  assert.equal(exitCode, 0, '同一份 transcript 拿掉毀損行應 exit 0')
  const writtenSummary = JSON.parse(readFileSync(join(localDir, `${ticket}/summary.json`), 'utf8'))
  assert.equal(typeof writtenSummary.coordinatorUsage?.apiCalls, 'number', 'coordinatorUsage.apiCalls 應為數字')
  assert.equal(writtenSummary.coordinatorUsage.apiCalls, 1, 'apiCalls 應為 1')
})

test('transcript 視窗內含 U+2028/U+2029 與 \\r\\n 記錄 ⇒ exit 0 且 apiCalls 精確計入兩筆', async () => {
  const root = tmp()
  const ticket = 'ticket-u2028-u2029'
  const localDir = join(root, '.local/llm-team')

  const lifecycleContent = [
    JSON.stringify({ at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket }),
    JSON.stringify({ at: '2026-09-14T10:15:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleContent)

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const transcriptPath = join(root, 'session.jsonl')
  const transcriptContent = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:02:00.000Z',
      message: { content: 'start' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T10:05:00.000Z',
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 200,
          output_tokens: 50,
        },
        content: [
          { type: 'text', text: 'a\u2028b\u2029c' },
          { type: 'tool_use', name: 'Bash' },
        ],
      },
    }),
  ].join('\n') + '\n' + JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-14T10:08:00.000Z',
    message: {
      usage: {
        input_tokens: 120,
        cache_creation_input_tokens: 15,
        cache_read_input_tokens: 300,
        output_tokens: 60,
      },
      content: [{ type: 'tool_use', name: 'Bash' }],
    },
  }) + '\r\n'
  writeFileSync(transcriptPath, transcriptContent)

  const cfgPath = makeFixtureConfig(root)

  const exitCode = await cliMain([
    '--ticket', ticket,
    '--config', cfgPath,
    '--transcript', transcriptPath,
    '--write',
  ], { cwd: root, repoRoot: root })

  assert.equal(exitCode, 0, 'exit code 應為 0')
  const writtenSummary = JSON.parse(readFileSync(join(localDir, `${ticket}/summary.json`), 'utf8'))
  assert.equal(typeof writtenSummary.coordinatorUsage?.apiCalls, 'number', 'coordinatorUsage.apiCalls 應為數字')
  assert.equal(writtenSummary.coordinatorUsage.apiCalls, 2, 'apiCalls 應精確為 2（兩筆 assistant 皆計入）')
  assert.equal(writtenSummary.coordinatorUsage.input, 220)
  assert.equal(writtenSummary.coordinatorUsage.cacheCreation, 25)
  assert.equal(writtenSummary.coordinatorUsage.cacheRead, 500)
  assert.equal(writtenSummary.coordinatorUsage.output, 110)
  assert.equal(writtenSummary.coordinatorTurns, 1)
})

test('陽性對照：同一份 fixture 用 node:readline 讀會得到比實際行數多的行數', async () => {
  const root = tmp()
  const transcriptPath = join(root, 'session.jsonl')
  const transcriptContent = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:02:00.000Z',
      message: { content: 'start' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T10:05:00.000Z',
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 200,
          output_tokens: 50,
        },
        content: [
          { type: 'text', text: 'a\u2028b\u2029c' },
          { type: 'tool_use', name: 'Bash' },
        ],
      },
    }),
  ].join('\n') + '\n' + JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-14T10:08:00.000Z',
    message: {
      usage: {
        input_tokens: 120,
        cache_creation_input_tokens: 15,
        cache_read_input_tokens: 300,
        output_tokens: 60,
      },
      content: [{ type: 'tool_use', name: 'Bash' }],
    },
  }) + '\r\n'
  writeFileSync(transcriptPath, transcriptContent)

  // 實際行數：用 readLines 逐行讀（以 \n 切行）
  let realCount = 0
  for await (const _ of readLines(transcriptPath)) {
    realCount++
  }

  // 對照組：在測試裡直接 import readline 數一次
  const readline = await import('node:readline')
  const rl = readline.createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let readlineCount = 0
  for await (const _ of rl) {
    readlineCount++
  }

  assert.equal(realCount, 3, '實際行數應為 3')
  // 精確值：3 行 ＋ 第 2 行裡的 U+2028、U+2029 各被 readline 多切一刀 ⇒ 5（不用下界斷言；Gemini 第 4 輪 Q2）
  assert.equal(
    readlineCount,
    5,
    `node:readline 行數 (${readlineCount}) 應恰為 5（實際 ${realCount} 行 ＋ 2 個被誤當換行的字元）`
  )
})

// ── 15. findTranscriptAcross ────────────────────────────────────────────────

test('findTranscriptAcross：projectsRoot 下三個子目錄 A/B/C，只有 C 的 jsonl 含 ticket.mjs run --name x ⇒ 回 {file: C 的檔, dir: C}；preferred: [A] 沒命中也回 C', async () => {
  const root = tmp()
  const projectsRoot = join(root, 'projects')
  const dirA = join(projectsRoot, 'proj-A')
  const dirB = join(projectsRoot, 'proj-B')
  const dirC = join(projectsRoot, 'proj-C')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  mkdirSync(dirC, { recursive: true })

  const ticket = 'test-ticket-across'
  const from = '2026-09-14T12:00:00.000Z'

  // A: jsonl 沒有 ticket.mjs run
  const fileA = join(dirA, 'session-a.jsonl')
  writeFileSync(fileA, JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-14T11:00:00.000Z',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] },
  }) + '\n')

  // B: 空 jsonl
  const fileB = join(dirB, 'session-b.jsonl')
  writeFileSync(fileB, '')

  // C: 命中（早於 from）
  const fileC = join(dirC, 'session-c.jsonl')
  writeFileSync(fileC, JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-14T11:30:00.000Z',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: `node ticket.mjs run --name ${ticket}` },
        },
      ],
    },
  }) + '\n')

  // 無 preferred
  const res1 = await findTranscriptAcross(projectsRoot, ticket, from)
  assert.deepEqual(
    res1,
    { file: fileC, dir: dirC },
    `無 preferred 時應跨專案找到 C（實際 file: ${res1?.file}，dir: ${res1?.dir}）`
  )

  // preferred: [A]（A 存在但沒命中）也回 C
  const res2 = await findTranscriptAcross(projectsRoot, ticket, from, { preferred: [dirA] })
  assert.deepEqual(
    res2,
    { file: fileC, dir: dirC },
    `preferred [A] 沒命中時應退回掃描並找到 C（實際 file: ${res2?.file}，dir: ${res2?.dir}）`
  )
})

test('findTranscriptAcross：preferred 命中優先：A 與 C 都有命中且 A 的 timestamp 較早 ⇒ preferred: [A] 回 A（不掃 C）', async () => {
  const root = tmp()
  const projectsRoot = join(root, 'projects')
  const dirA = join(projectsRoot, 'proj-A')
  const dirC = join(projectsRoot, 'proj-C')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirC, { recursive: true })

  const ticket = 'test-ticket-pref'
  const from = '2026-09-14T12:00:00.000Z'

  // A 命中，timestamp 較早 (10:00)
  const fileA = join(dirA, 'session-a.jsonl')
  writeFileSync(fileA, JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-14T10:00:00.000Z',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: `node ticket.mjs run --name ${ticket}` },
        },
      ],
    },
  }) + '\n')

  // C 命中，timestamp 較晚 (11:30，比 A 更接近 from)
  const fileC = join(dirC, 'session-c.jsonl')
  writeFileSync(fileC, JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-14T11:30:00.000Z',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: `node ticket.mjs run --name ${ticket}` },
        },
      ],
    },
  }) + '\n')

  const res = await findTranscriptAcross(projectsRoot, ticket, from, { preferred: [dirA] })
  assert.deepEqual(
    res,
    { file: fileA, dir: dirA },
    `preferred 命中優先：即使 C 較接近 from，preferred [A] 命中應回 A（實際 file: ${res?.file}，dir: ${res?.dir}）`
  )
})

test('findTranscriptAcross：全部沒命中 ⇒ null；projectsRoot 不存在 ⇒ null；子目錄裡的更深層 jsonl 不被掃到，且 projectsRoot 頂層的 jsonl 被忽略', async () => {
  const root = tmp()
  const projectsRoot = join(root, 'projects')
  const dirA = join(projectsRoot, 'proj-A')
  mkdirSync(dirA, { recursive: true })

  const ticket = 'test-ticket-none'
  const from = '2026-09-14T12:00:00.000Z'

  // projectsRoot 不存在 ⇒ null
  const nonExistentDir = join(root, 'non-existent-projects-dir')
  const resNonExistent = await findTranscriptAcross(nonExistentDir, ticket, from)
  assert.equal(resNonExistent, null, `projectsRoot 不存在應回 null（實際: ${resNonExistent}）`)

  // 全部沒命中 ⇒ null
  const resNoMatch = await findTranscriptAcross(projectsRoot, ticket, from)
  assert.equal(resNoMatch, null, `全部子目錄沒命中應回 null（實際: ${resNoMatch}）`)

  // 子目錄裡的更深層 jsonl（例如 subagent）不被掃到
  const subagentDir = join(dirA, 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  writeFileSync(join(subagentDir, 'deep.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-14T11:00:00.000Z',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: `node ticket.mjs run --name ${ticket}` },
        },
      ],
    },
  }) + '\n')
  const resDeep = await findTranscriptAcross(projectsRoot, ticket, from)
  assert.equal(resDeep, null, `子目錄深層 jsonl 不應被掃到（實際: ${resDeep}）`)

  // projectsRoot 頂層的 jsonl（非目錄）被忽略
  writeFileSync(join(projectsRoot, 'root-level.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-14T11:00:00.000Z',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: `node ticket.mjs run --name ${ticket}` },
        },
      ],
    },
  }) + '\n')
  const resTopFile = await findTranscriptAcross(projectsRoot, ticket, from)
  assert.equal(resTopFile, null, `projectsRoot 頂層 jsonl 檔案應被忽略（實際: ${resTopFile}）`)
})

test('main 整合：cwd slug 目錄不存在、票在別的子目錄 ⇒ exit 0 且 stderr 含「transcript 目錄：」', async () => {
  const root = tmp()
  const ticket = 'ticket-cross-main'
  const localDir = join(root, '.local/llm-team')

  const lifecycleContent = [
    JSON.stringify({ at: '2026-09-14T08:00:00.000Z', event: 'run-start', ticket }),
    JSON.stringify({ at: '2026-09-14T08:30:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleContent)

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const projectsRoot = join(root, 'claude-projects')
  const otherDir = join(projectsRoot, '-Users-fergus-Desktop-workshop-other-project')
  mkdirSync(otherDir, { recursive: true })

  const transcriptPath = join(otherDir, 'session.jsonl')
  const transcriptContent = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T08:00:00.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: `node .agents/skills/llm-team/ticket.mjs run --name ${ticket}` },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T08:05:00.000Z',
      message: { content: 'do work' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T08:10:00.000Z',
      message: {
        usage: {
          input_tokens: 80,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 200,
          output_tokens: 40,
        },
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(transcriptPath, transcriptContent)

  const cfgPath = makeFixtureConfig(root)

  let stderr = ''
  const origError = console.error
  console.error = (...args) => {
    stderr += args.join(' ') + '\n'
  }

  const origHome = process.env.HOME
  const origProjectsRoot = process.env.LLM_TEAM_PROJECTS_ROOT
  let exitCode
  try {
    process.env.HOME = root
    process.env.LLM_TEAM_PROJECTS_ROOT = projectsRoot
    exitCode = await cliMain([
      '--ticket', ticket,
      '--config', cfgPath,
      '--json',
    ], { cwd: root, repoRoot: root, projectsRoot })
  } finally {
    process.env.HOME = origHome
    if (origProjectsRoot !== undefined) {
      process.env.LLM_TEAM_PROJECTS_ROOT = origProjectsRoot
    } else {
      delete process.env.LLM_TEAM_PROJECTS_ROOT
    }
    console.error = origError
  }

  assert.equal(exitCode, 0, `cwd slug 不存在但其他子目錄有應 exit 0，實際 exitCode: ${exitCode}`)
  assert.match(stderr, /transcript 目錄：/, `stderr 應印出「transcript 目錄：」（實際 stderr: ${stderr}）`)
  assert.match(stderr, new RegExp(otherDir), `stderr 應包含命中目錄 ${otherDir}（實際 stderr: ${stderr}）`)
})

test('main 整合：全部子目錄都沒有 ⇒ exit 1 且 stderr 含「已掃 ~/.claude/projects 全部子目錄」', async () => {
  const root = tmp()
  const ticket = 'ticket-not-found-main'
  const localDir = join(root, '.local/llm-team')

  const lifecycleContent = [
    JSON.stringify({ at: '2026-09-14T08:00:00.000Z', event: 'run-start', ticket }),
    JSON.stringify({ at: '2026-09-14T08:30:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleContent)

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const projectsRoot = join(root, 'claude-projects')
  const emptyDir = join(projectsRoot, '-Users-fergus-Desktop-workshop-empty')
  mkdirSync(emptyDir, { recursive: true })

  const cfgPath = makeFixtureConfig(root)

  let stderr = ''
  const origError = console.error
  console.error = (...args) => {
    stderr += args.join(' ') + '\n'
  }

  const origHome = process.env.HOME
  const origProjectsRoot = process.env.LLM_TEAM_PROJECTS_ROOT
  let exitCode
  try {
    process.env.HOME = root
    process.env.LLM_TEAM_PROJECTS_ROOT = projectsRoot
    exitCode = await cliMain([
      '--ticket', ticket,
      '--config', cfgPath,
      '--json',
    ], { cwd: root, repoRoot: root, projectsRoot })
  } finally {
    process.env.HOME = origHome
    if (origProjectsRoot !== undefined) {
      process.env.LLM_TEAM_PROJECTS_ROOT = origProjectsRoot
    } else {
      delete process.env.LLM_TEAM_PROJECTS_ROOT
    }
    console.error = origError
  }

  assert.equal(exitCode, 1, `全部子目錄都沒命中應 exit 1，實際 exitCode: ${exitCode}`)
  assert.match(
    stderr,
    /找不到哪個 transcript 開了這張票（已掃 ~\/\.claude\/projects 全部子目錄）；用 --transcript 指定/,
    `stderr 應提示已掃全部子目錄（實際 stderr: ${stderr}）`
  )
})

test('findTranscriptBySession：projectsRoot 下 A／B 兩目錄，B 有 sess-1.jsonl ⇒ 回 {file: B/sess-1.jsonl, dir: B, via:"sessionId"}', () => {
  const root = tmp()
  const dirA = join(root, 'project-A')
  const dirB = join(root, 'project-B')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  const expectedFile = join(dirB, 'sess-1.jsonl')
  writeFileSync(expectedFile, '{"test": true}\n')

  const result = findTranscriptBySession(root, 'sess-1')
  assert.ok(result, `findTranscriptBySession 應回傳結果，實際為: ${JSON.stringify(result)}`)
  assert.equal(result.file, expectedFile, `file 應為 ${expectedFile}，實際為: ${result.file}`)
  assert.equal(result.dir, dirB, `dir 應為 ${dirB}，實際為: ${result.dir}`)
  assert.equal(result.via, 'sessionId', `via 應為 sessionId，實際為: ${result.via}`)
})

test('findTranscriptBySession：不存在 ⇒ null；sessionId 含 / 或 .. ⇒ null（不准拼路徑）', () => {
  const root = tmp()
  const dirA = join(root, 'project-A')
  mkdirSync(dirA, { recursive: true })

  // 不存在
  const resNotExist = findTranscriptBySession(root, 'sess-nonexistent')
  assert.equal(resNotExist, null, `不存在的 sessionId 應回 null，實際為: ${JSON.stringify(resNotExist)}`)

  // projectsRoot 不存在
  const resNoRoot = findTranscriptBySession(join(root, 'not-exists'), 'sess-1')
  assert.equal(resNoRoot, null, `不存在的 projectsRoot 應回 null，實際為: ${JSON.stringify(resNoRoot)}`)

  // 空字串 / null / undefined
  assert.equal(findTranscriptBySession(root, ''), null, `空字串 sessionId 應回 null，實際為: ${JSON.stringify(findTranscriptBySession(root, ''))}`)
  assert.equal(findTranscriptBySession(root, null), null, `null sessionId 應回 null，實際為: ${JSON.stringify(findTranscriptBySession(root, null))}`)
  assert.equal(findTranscriptBySession(root, undefined), null, `undefined sessionId 應回 null，實際為: ${JSON.stringify(findTranscriptBySession(root, undefined))}`)

  // sessionId 含 / 或 .. （不准拼路徑）
  const resSlash = findTranscriptBySession(root, 'project-A/sess-1')
  assert.equal(resSlash, null, `含 / 的 sessionId 應回 null，實際為: ${JSON.stringify(resSlash)}`)

  const resDotDot = findTranscriptBySession(root, '../sess-1')
  assert.equal(resDotDot, null, `含 .. 的 sessionId 應回 null，實際為: ${JSON.stringify(resDotDot)}`)

  const resDotDotSlash = findTranscriptBySession(root, '../../etc/passwd')
  assert.equal(resDotDotSlash, null, `含 ../../ 的 sessionId 應回 null，實際為: ${JSON.stringify(resDotDotSlash)}`)
})

test('main 整合：lifecycle 的 run-start 帶 sessionId: "sess-1"，該 jsonl 內容沒有 ticket.mjs run 字面 ⇒ exit 0、stderr 含「（sessionId）」、apiCalls 為數字；同一佈置把 lifecycle 的 sessionId 拿掉 ⇒ exit 1', async () => {
  const root = tmp()
  const ticket = 'ticket-sess-integration'
  const localDir = join(root, '.local/llm-team')

  const initialSummary = {
    schemaVersion: 2,
    project: 'test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')

  const projectsRoot = join(root, 'claude-projects')
  const projectDir = join(projectsRoot, '-Users-fergus-Desktop-workshop-sess-project')
  mkdirSync(projectDir, { recursive: true })

  const transcriptPath = join(projectDir, 'sess-1.jsonl')
  // 該 jsonl 沒有 ticket.mjs run 字面，只有視窗內的 assistant usage 記錄
  const transcriptContent = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T08:05:00.000Z',
      message: { content: 'bash run-ticket.sh r1 brief' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-14T08:10:00.000Z',
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 50,
        },
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    }),
  ].join('\n') + '\n'
  writeFileSync(transcriptPath, transcriptContent)

  const cfgPath = makeFixtureConfig(root)

  // 1. lifecycle 的 run-start 帶 sessionId: 'sess-1'
  const lifecycleWithSession = [
    JSON.stringify({ at: '2026-09-14T08:00:00.000Z', event: 'run-start', ticket, sessionId: 'sess-1' }),
    JSON.stringify({ at: '2026-09-14T08:30:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleWithSession)

  let stderr1 = ''
  let stdout1 = ''
  const origError = console.error
  const origLog = console.log
  console.error = (...args) => {
    stderr1 += args.join(' ') + '\n'
  }
  console.log = (...args) => {
    stdout1 += args.join(' ') + '\n'
  }

  const origHome = process.env.HOME
  const origProjectsRoot = process.env.LLM_TEAM_PROJECTS_ROOT
  let exitCode1
  try {
    process.env.HOME = root
    process.env.LLM_TEAM_PROJECTS_ROOT = projectsRoot
    exitCode1 = await cliMain([
      '--ticket', ticket,
      '--config', cfgPath,
      '--json',
    ], { cwd: root, repoRoot: root, projectsRoot })
  } finally {
    process.env.HOME = origHome
    if (origProjectsRoot !== undefined) {
      process.env.LLM_TEAM_PROJECTS_ROOT = origProjectsRoot
    } else {
      delete process.env.LLM_TEAM_PROJECTS_ROOT
    }
    console.error = origError
    console.log = origLog
  }

  assert.equal(exitCode1, 0, `有 sessionId 時應 exit 0，實際 exitCode: ${exitCode1}`)
  assert.match(stderr1, /（sessionId）/, `stderr 應含「（sessionId）」，實際 stderr: ${stderr1}`)
  const parsed = JSON.parse(stdout1.trim())
  assert.equal(typeof parsed.apiCalls, 'number', `apiCalls 應為數字，實際為: ${typeof parsed.apiCalls} (值: ${parsed.apiCalls})`)
  assert.equal(parsed.apiCalls, 1, `apiCalls 應為 1，實際為: ${parsed.apiCalls}`)

  // 2. 同一佈置把 lifecycle 的 sessionId 拿掉 ⇒ exit 1（字面掃描找不到）
  const lifecycleWithoutSession = [
    JSON.stringify({ at: '2026-09-14T08:00:00.000Z', event: 'run-start', ticket }),
    JSON.stringify({ at: '2026-09-14T08:30:00.000Z', event: 'accepted', ticket }),
  ].join('\n') + '\n'
  write(localDir, `${ticket}/lifecycle.ndjson`, lifecycleWithoutSession)

  let stderr2 = ''
  console.error = (...args) => {
    stderr2 += args.join(' ') + '\n'
  }

  let exitCode2
  try {
    process.env.HOME = root
    process.env.LLM_TEAM_PROJECTS_ROOT = projectsRoot
    exitCode2 = await cliMain([
      '--ticket', ticket,
      '--config', cfgPath,
      '--json',
    ], { cwd: root, repoRoot: root, projectsRoot })
  } finally {
    process.env.HOME = origHome
    if (origProjectsRoot !== undefined) {
      process.env.LLM_TEAM_PROJECTS_ROOT = origProjectsRoot
    } else {
      delete process.env.LLM_TEAM_PROJECTS_ROOT
    }
    console.error = origError
  }

  assert.equal(exitCode2, 1, `無 sessionId 且字面不符時應 exit 1，實際 exitCode: ${exitCode2}`)
  assert.match(stderr2, /lifecycle 的 sessionId=無/, `stderr 應含「lifecycle 的 sessionId=無」，實際 stderr: ${stderr2}`)
  assert.match(
    stderr2,
    /找不到哪個 transcript 開了這張票（已掃 ~\/\.claude\/projects 全部子目錄）；用 --transcript 指定/,
    `stderr 應提示已掃全部子目錄，實際 stderr: ${stderr2}`
  )
})

// ── 14. 排他歸屬（1.6 (h)）──────────────────────────────────────────────────

test('attributeRecord：本票 10:00–11:00、other 10:20–10:40（runStartAt 10:20）⇒ ts 10:30 回 false、ts 10:10 回 true、ts 10:50 回 true；other 的 runStartAt 早於本票（外層票）⇒ ts 10:30 回 true；並列 ⇒ null', () => {
  const self = {
    ticket: 'ticket-self',
    from: '2026-09-14T10:00:00.000Z',
    to: '2026-09-14T11:00:00.000Z',
    runStartAt: '2026-09-14T10:00:00.000Z',
  }
  const other = {
    ticket: 'ticket-other',
    from: '2026-09-14T10:20:00.000Z',
    to: '2026-09-14T10:40:00.000Z',
    runStartAt: '2026-09-14T10:20:00.000Z',
  }

  // 1. 本票 10:00–11:00、other 10:20–10:40（runStartAt 10:20）
  const res30 = attributeRecord('2026-09-14T10:30:00.000Z', self, [other])
  assert.equal(res30, false, `ts 10:30 在 other 視窗且 other runStartAt 較晚，應為 false，實際：${res30}`)

  const res10 = attributeRecord('2026-09-14T10:10:00.000Z', self, [other])
  assert.equal(res10, true, `ts 10:10 不在 other 視窗，應為 true，實際：${res10}`)

  const res50 = attributeRecord('2026-09-14T10:50:00.000Z', self, [other])
  assert.equal(res50, true, `ts 10:50 不在 other 視窗，應為 true，實際：${res50}`)

  // 2. other 的 runStartAt 早於本票（外層票）
  const selfInner = {
    ticket: 'ticket-inner',
    from: '2026-09-14T10:20:00.000Z',
    to: '2026-09-14T10:40:00.000Z',
    runStartAt: '2026-09-14T10:20:00.000Z',
  }
  const otherOuter = {
    ticket: 'ticket-outer',
    from: '2026-09-14T10:00:00.000Z',
    to: '2026-09-14T11:00:00.000Z',
    runStartAt: '2026-09-14T10:00:00.000Z',
  }
  const resOuter = attributeRecord('2026-09-14T10:30:00.000Z', selfInner, [otherOuter])
  assert.equal(resOuter, true, `other runStartAt 早於本票（外層票），應為 true，實際：${resOuter}`)

  // 3. 並列 ⇒ null
  const otherTie = {
    ticket: 'ticket-tie',
    from: '2026-09-14T10:20:00.000Z',
    to: '2026-09-14T10:40:00.000Z',
    runStartAt: '2026-09-14T10:00:00.000Z',
  }
  const resTie = attributeRecord('2026-09-14T10:30:00.000Z', self, [otherTie])
  assert.equal(resTie, null, `runStartAt 並列時應為 null，實際：${resTie}`)
})

test('accumulate 陣列路徑：5 筆 assistant 記錄（10:05、10:25、10:30、10:45、10:55），other 10:20–10:40 ⇒ gross.apiCalls 5、exclusive.apiCalls 3、overlaps[0]={ticket, overlapMs 1,200,000, excludedApiCalls 2}；沒有 others ⇒ exclusive.apiCalls 5、overlaps []', () => {
  const window = {
    from: '2026-09-14T10:00:00.000Z',
    to: '2026-09-14T11:00:00.000Z',
    windowEnd: 'accepted',
  }
  const self = {
    ticket: 'ticket-self',
    from: '2026-09-14T10:00:00.000Z',
    to: '2026-09-14T11:00:00.000Z',
    runStartAt: '2026-09-14T10:00:00.000Z',
  }
  const other = {
    ticket: 'ticket-other',
    from: '2026-09-14T10:20:00.000Z',
    to: '2026-09-14T10:40:00.000Z',
    runStartAt: '2026-09-14T10:20:00.000Z',
  }

  const makeRecord = (ts) => ({
    type: 'assistant',
    timestamp: ts,
    message: {
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 200,
        output_tokens: 50,
      },
      content: [{ type: 'tool_use', name: 'Bash' }],
    },
  })

  const records = [
    makeRecord('2026-09-14T10:05:00.000Z'),
    makeRecord('2026-09-14T10:25:00.000Z'),
    makeRecord('2026-09-14T10:30:00.000Z'),
    makeRecord('2026-09-14T10:45:00.000Z'),
    makeRecord('2026-09-14T10:55:00.000Z'),
  ]

  // 有 other
  const resWithOther = accumulate(records, window, { others: [other], self })
  assert.equal(resWithOther.apiCalls, 5, `gross.apiCalls 應為 5，實際：${resWithOther.apiCalls}`)
  assert.equal(resWithOther.exclusive.apiCalls, 3, `exclusive.apiCalls 應為 3，實際：${resWithOther.exclusive?.apiCalls}`)
  assert.equal(resWithOther.overlaps.length, 1, `overlaps 長度應為 1，實際：${resWithOther.overlaps.length}`)
  assert.equal(resWithOther.overlaps[0].ticket, 'ticket-other', `overlaps[0].ticket 應為 ticket-other，實際：${resWithOther.overlaps[0].ticket}`)
  assert.equal(resWithOther.overlaps[0].overlapMs, 1200000, `overlaps[0].overlapMs 應為 1200000，實際：${resWithOther.overlaps[0].overlapMs}`)
  assert.equal(resWithOther.overlaps[0].excludedApiCalls, 2, `overlaps[0].excludedApiCalls 應為 2，實際：${resWithOther.overlaps[0].excludedApiCalls}`)

  // 沒有 others
  const resNoOther = accumulate(records, window, { others: [], self })
  assert.equal(resNoOther.apiCalls, 5, `沒有 others 時 gross.apiCalls 應為 5，實際：${resNoOther.apiCalls}`)
  assert.equal(resNoOther.exclusive.apiCalls, 5, `沒有 others 時 exclusive.apiCalls 應為 5，實際：${resNoOther.exclusive?.apiCalls}`)
  assert.deepEqual(resNoOther.overlaps, [], `沒有 others 時 overlaps 應為空陣列，實際：${JSON.stringify(resNoOther.overlaps)}`)
})

test('accumulate 串流路徑：同一組 5 筆 assistant 資料走串流產生器 ⇒ 與陣列路徑同結果', async () => {
  const window = {
    from: '2026-09-14T10:00:00.000Z',
    to: '2026-09-14T11:00:00.000Z',
    windowEnd: 'accepted',
  }
  const self = {
    ticket: 'ticket-self',
    from: '2026-09-14T10:00:00.000Z',
    to: '2026-09-14T11:00:00.000Z',
    runStartAt: '2026-09-14T10:00:00.000Z',
  }
  const other = {
    ticket: 'ticket-other',
    from: '2026-09-14T10:20:00.000Z',
    to: '2026-09-14T10:40:00.000Z',
    runStartAt: '2026-09-14T10:20:00.000Z',
  }

  const makeRecord = (ts) => ({
    type: 'assistant',
    timestamp: ts,
    message: {
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 200,
        output_tokens: 50,
      },
      content: [{ type: 'tool_use', name: 'Bash' }],
    },
  })

  async function* streamRecords() {
    yield makeRecord('2026-09-14T10:05:00.000Z')
    yield makeRecord('2026-09-14T10:25:00.000Z')
    yield makeRecord('2026-09-14T10:30:00.000Z')
    yield makeRecord('2026-09-14T10:45:00.000Z')
    yield makeRecord('2026-09-14T10:55:00.000Z')
  }

  const resWithOther = await accumulate(streamRecords(), window, { others: [other], self })
  assert.equal(resWithOther.apiCalls, 5, `串流 gross.apiCalls 應為 5，實際：${resWithOther.apiCalls}`)
  assert.equal(resWithOther.exclusive.apiCalls, 3, `串流 exclusive.apiCalls 應為 3，實際：${resWithOther.exclusive?.apiCalls}`)
  assert.equal(resWithOther.overlaps.length, 1, `串流 overlaps 長度應為 1，實際：${resWithOther.overlaps.length}`)
  assert.equal(resWithOther.overlaps[0].ticket, 'ticket-other', `串流 overlaps[0].ticket 應為 ticket-other，實際：${resWithOther.overlaps[0].ticket}`)
  assert.equal(resWithOther.overlaps[0].overlapMs, 1200000, `串流 overlaps[0].overlapMs 應為 1200000，實際：${resWithOther.overlaps[0].overlapMs}`)
  assert.equal(resWithOther.overlaps[0].excludedApiCalls, 2, `串流 overlaps[0].excludedApiCalls 應為 2，實際：${resWithOther.overlaps[0].excludedApiCalls}`)

  async function* streamRecords2() {
    yield makeRecord('2026-09-14T10:05:00.000Z')
    yield makeRecord('2026-09-14T10:25:00.000Z')
    yield makeRecord('2026-09-14T10:30:00.000Z')
    yield makeRecord('2026-09-14T10:45:00.000Z')
    yield makeRecord('2026-09-14T10:55:00.000Z')
  }

  const resNoOther = await accumulate(streamRecords2(), window, { others: [], self })
  assert.equal(resNoOther.apiCalls, 5, `串流沒有 others 時 gross.apiCalls 應為 5，實際：${resNoOther.apiCalls}`)
  assert.equal(resNoOther.exclusive.apiCalls, 5, `串流沒有 others 時 exclusive.apiCalls 應為 5，實際：${resNoOther.exclusive?.apiCalls}`)
  assert.deepEqual(resNoOther.overlaps, [], `串流沒有 others 時 overlaps 應為空陣列，實際：${JSON.stringify(resNoOther.overlaps)}`)
})

test('事故重現（main 整合）：tmp repo 建兩張票的 lifecycle（A 10:00 run-start→11:30 landed；B 10:30 run-start→11:00 landed），假 transcript 在 A 視窗內放 8 筆 assistant（其中 3 筆落在 B 視窗）⇒ --ticket A 的 stdout JSON apiCalls 8、exclusive.apiCalls 5、overlaps 含 B；--ticket B ⇒ apiCalls 3、exclusive.apiCalls 3、overlaps []；--write 後 A 的 summary 有 coordinatorUsageExclusive.apiCalls 5 且 coordinatorUsage.apiCalls 8', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')

  const summaryA = {
    schemaVersion: 2,
    project: 'incident-proj',
    ticket: 'ticket-A',
    coordinator: 'claude',
    comparable: false,
  }
  const summaryB = {
    schemaVersion: 2,
    project: 'incident-proj',
    ticket: 'ticket-B',
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, 'ticket-A/summary.json', JSON.stringify(summaryA, null, 2) + '\n')
  write(localDir, 'ticket-B/summary.json', JSON.stringify(summaryB, null, 2) + '\n')

  const lifecycleA = [
    JSON.stringify({ at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket: 'ticket-A', sessionId: 'sess-incident' }),
    JSON.stringify({ at: '2026-09-14T11:30:00.000Z', event: 'landed', ticket: 'ticket-A' }),
  ].join('\n') + '\n'
  const lifecycleB = [
    JSON.stringify({ at: '2026-09-14T10:30:00.000Z', event: 'run-start', ticket: 'ticket-B', sessionId: 'sess-incident' }),
    JSON.stringify({ at: '2026-09-14T11:00:00.000Z', event: 'landed', ticket: 'ticket-B' }),
  ].join('\n') + '\n'
  write(localDir, 'ticket-A/lifecycle.ndjson', lifecycleA)
  write(localDir, 'ticket-B/lifecycle.ndjson', lifecycleB)

  const projectsRoot = join(root, 'claude-projects')
  const projectDir = join(projectsRoot, '-Users-fergus-Desktop-incident-project')
  mkdirSync(projectDir, { recursive: true })

  const makeAssistant = (ts) => JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 200,
        output_tokens: 50,
      },
      content: [{ type: 'tool_use', name: 'Bash' }],
    },
  })

  // 8 筆 assistant 記錄落在 A 視窗（10:00~11:30），其中 3 筆落在 B 視窗（10:30~11:00）
  const transcriptLines = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:01:00.000Z',
      message: { content: 'start working' },
    }),
    makeAssistant('2026-09-14T10:05:00.000Z'),
    makeAssistant('2026-09-14T10:15:00.000Z'),
    makeAssistant('2026-09-14T10:20:00.000Z'),
    makeAssistant('2026-09-14T10:35:00.000Z'), // in B
    makeAssistant('2026-09-14T10:45:00.000Z'), // in B
    makeAssistant('2026-09-14T10:55:00.000Z'), // in B
    makeAssistant('2026-09-14T11:05:00.000Z'),
    makeAssistant('2026-09-14T11:20:00.000Z'),
  ]
  const transcriptPath = join(projectDir, 'sess-incident.jsonl')
  writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n')

  const cfgPath = makeFixtureConfig(root)

  const origHome = process.env.HOME
  const origProjectsRoot = process.env.LLM_TEAM_PROJECTS_ROOT
  const origLog = console.log
  const origError = console.error

  try {
    process.env.HOME = root
    process.env.LLM_TEAM_PROJECTS_ROOT = projectsRoot

    // 1. 執行 --ticket ticket-A --write --json
    let stdoutA = ''
    console.log = (...args) => { stdoutA += args.join(' ') + '\n' }
    console.error = () => {}

    const exitCodeA = await cliMain([
      '--ticket', 'ticket-A',
      '--config', cfgPath,
      '--write',
      '--json',
    ], { cwd: root, repoRoot: root, projectsRoot })

    assert.equal(exitCodeA, 0, `ticket-A 執行應 exit 0，實際：${exitCodeA}`)
    const parsedA = JSON.parse(stdoutA.trim())
    assert.equal(parsedA.apiCalls, 8, `ticket-A gross apiCalls 應為 8，實際：${parsedA.apiCalls}`)
    assert.equal(parsedA.exclusive?.apiCalls, 5, `ticket-A exclusive.apiCalls 應為 5，實際：${parsedA.exclusive?.apiCalls}`)
    assert.equal(parsedA.overlaps.length, 1, `ticket-A overlaps 應含 1 個票，實際：${parsedA.overlaps.length}`)
    assert.equal(parsedA.overlaps[0].ticket, 'ticket-B', `ticket-A overlaps[0].ticket 應為 ticket-B，實際：${parsedA.overlaps[0].ticket}`)
    assert.equal(parsedA.overlaps[0].excludedApiCalls, 3, `ticket-A overlaps[0].excludedApiCalls 應為 3，實際：${parsedA.overlaps[0].excludedApiCalls}`)

    // 檢查 ticket-A summary.json 回填
    const writtenSummaryA = JSON.parse(readFileSync(join(localDir, 'ticket-A/summary.json'), 'utf8'))
    assert.equal(writtenSummaryA.coordinatorUsage.apiCalls, 8, `summary.coordinatorUsage.apiCalls 應為 8，實際：${writtenSummaryA.coordinatorUsage.apiCalls}`)
    assert.equal(writtenSummaryA.coordinatorUsageExclusive.apiCalls, 5, `summary.coordinatorUsageExclusive.apiCalls 應為 5，實際：${writtenSummaryA.coordinatorUsageExclusive.apiCalls}`)
    assert.equal(writtenSummaryA.usageOverlaps.length, 1, `summary.usageOverlaps 長度應為 1，實際：${writtenSummaryA.usageOverlaps.length}`)

    // 2. 執行 --ticket ticket-B --write --json
    let stdoutB = ''
    console.log = (...args) => { stdoutB += args.join(' ') + '\n' }

    const exitCodeB = await cliMain([
      '--ticket', 'ticket-B',
      '--config', cfgPath,
      '--write',
      '--json',
    ], { cwd: root, repoRoot: root, projectsRoot })

    assert.equal(exitCodeB, 0, `ticket-B 執行應 exit 0，實際：${exitCodeB}`)
    const parsedB = JSON.parse(stdoutB.trim())
    assert.equal(parsedB.apiCalls, 3, `ticket-B apiCalls 應為 3，實際：${parsedB.apiCalls}`)
    assert.equal(parsedB.exclusive?.apiCalls, 3, `ticket-B exclusive.apiCalls 應為 3，實際：${parsedB.exclusive?.apiCalls}`)
    assert.deepEqual(parsedB.overlaps, [], `ticket-B overlaps 應為空陣列，實際：${JSON.stringify(parsedB.overlaps)}`)
  } finally {
    process.env.HOME = origHome
    if (origProjectsRoot !== undefined) {
      process.env.LLM_TEAM_PROJECTS_ROOT = origProjectsRoot
    } else {
      delete process.env.LLM_TEAM_PROJECTS_ROOT
    }
    console.log = origLog
    console.error = origError
  }
})

test('並列：B 的 run-start 與 A 相同時刻 ⇒ exclusive null、exclusiveReason 含「並列」、gross 照常', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')

  const summaryA = {
    schemaVersion: 2,
    project: 'tie-proj',
    ticket: 'ticket-A',
    coordinator: 'claude',
    comparable: false,
  }
  const summaryB = {
    schemaVersion: 2,
    project: 'tie-proj',
    ticket: 'ticket-B',
    coordinator: 'claude',
    comparable: false,
  }
  write(localDir, 'ticket-A/summary.json', JSON.stringify(summaryA, null, 2) + '\n')
  write(localDir, 'ticket-B/summary.json', JSON.stringify(summaryB, null, 2) + '\n')

  // B 的 run-start 與 A 相同時刻（10:00:00）
  const lifecycleA = [
    JSON.stringify({ at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket: 'ticket-A', sessionId: 'sess-tie' }),
    JSON.stringify({ at: '2026-09-14T11:30:00.000Z', event: 'landed', ticket: 'ticket-A' }),
  ].join('\n') + '\n'
  const lifecycleB = [
    JSON.stringify({ at: '2026-09-14T10:00:00.000Z', event: 'run-start', ticket: 'ticket-B', sessionId: 'sess-tie' }),
    JSON.stringify({ at: '2026-09-14T11:00:00.000Z', event: 'landed', ticket: 'ticket-B' }),
  ].join('\n') + '\n'
  write(localDir, 'ticket-A/lifecycle.ndjson', lifecycleA)
  write(localDir, 'ticket-B/lifecycle.ndjson', lifecycleB)

  const projectsRoot = join(root, 'claude-projects')
  const projectDir = join(projectsRoot, '-Users-fergus-Desktop-tie-project')
  mkdirSync(projectDir, { recursive: true })

  const makeAssistant = (ts) => JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 200,
        output_tokens: 50,
      },
      content: [{ type: 'tool_use', name: 'Bash' }],
    },
  })

  const transcriptLines = [
    JSON.stringify({
      type: 'user',
      userType: 'external',
      isSidechain: false,
      isMeta: false,
      timestamp: '2026-09-14T10:01:00.000Z',
      message: { content: 'work on tie' },
    }),
    makeAssistant('2026-09-14T10:05:00.000Z'),
    makeAssistant('2026-09-14T10:15:00.000Z'),
    makeAssistant('2026-09-14T10:35:00.000Z'),
  ]
  const transcriptPath = join(projectDir, 'sess-tie.jsonl')
  writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n')

  const cfgPath = makeFixtureConfig(root)

  const origHome = process.env.HOME
  const origProjectsRoot = process.env.LLM_TEAM_PROJECTS_ROOT
  const origLog = console.log
  const origError = console.error

  try {
    process.env.HOME = root
    process.env.LLM_TEAM_PROJECTS_ROOT = projectsRoot

    let stdoutA = ''
    console.log = (...args) => { stdoutA += args.join(' ') + '\n' }
    console.error = () => {}

    const exitCodeA = await cliMain([
      '--ticket', 'ticket-A',
      '--config', cfgPath,
      '--write',
      '--json',
    ], { cwd: root, repoRoot: root, projectsRoot })

    assert.equal(exitCodeA, 0, `ticket-A 執行應 exit 0，實際：${exitCodeA}`)
    const parsedA = JSON.parse(stdoutA.trim())
    assert.equal(parsedA.apiCalls, 3, `gross apiCalls 應照常為 3，實際：${parsedA.apiCalls}`)
    assert.equal(parsedA.exclusive, null, `並列時 exclusive 應為 null，實際：${parsedA.exclusive}`)
    assert.match(parsedA.exclusiveReason, /並列/, `exclusiveReason 應含「並列」，實際：${parsedA.exclusiveReason}`)

    // 檢查 summary.json 回填
    const writtenSummaryA = JSON.parse(readFileSync(join(localDir, 'ticket-A/summary.json'), 'utf8'))
    assert.equal(writtenSummaryA.coordinatorUsage.apiCalls, 3, `summary.coordinatorUsage.apiCalls 應照常為 3，實際：${writtenSummaryA.coordinatorUsage.apiCalls}`)
    assert.equal(writtenSummaryA.coordinatorUsageExclusive, null, `summary.coordinatorUsageExclusive 應為 null，實際：${writtenSummaryA.coordinatorUsageExclusive}`)
  } finally {
    process.env.HOME = origHome
    if (origProjectsRoot !== undefined) {
      process.env.LLM_TEAM_PROJECTS_ROOT = origProjectsRoot
    } else {
      delete process.env.LLM_TEAM_PROJECTS_ROOT
    }
    console.log = origLog
    console.error = origError
  }
})

// ── 16. cohortReport（1.7 (c)）──────────────────────────────────────────────

const makeCohortSummary = ({ ticket, apiCalls, run, caliber = 'tool', measurable = true, from }) => {
  const s = {
    ticket,
    caliber,
    usage: { measurable },
    coordinatorUsageExclusive: { apiCalls },
    usageWindow: { from },
  }
  if (run !== undefined) s.run = run
  return s
}

// 事故重現的 15 張時間序 exclusive apiCalls：前 8 張沒有 run，後 7 張 run:1
const COHORT_15_VALUES = [48, 28, 43, 102, 131, 6, 52, 76, 78, 6, 14, 24, 8, 10, 54]
const isoAt = (i) => `2026-09-01T00:${String(i).padStart(2, '0')}:00.000Z`

test('cohortReport (a)：真實事故 15 張 fixture（前 8 張無 run、後 7 張 run:1）⇒ 基線中位數 48、單一窗中位數 19、dropPct≈60.4166、provisional，rework.unknown 5/3', () => {
  const summaries = COHORT_15_VALUES.map((apiCalls, i) => makeCohortSummary({
    ticket: `t${i + 1}`,
    apiCalls,
    run: i < 8 ? undefined : 1,
    from: isoAt(i),
  }))

  const report = cohortReport(summaries, 'tool')

  assert.equal(report.baseline.median, 48, `基線中位數應為 48，實際：${report.baseline.median}`)
  assert.equal(report.windows.length, 1, `應恰好 1 個窗，實際：${report.windows.length}`)
  assert.equal(report.windows[0].median, 19, `窗中位數應為 19，實際：${report.windows[0].median}`)
  assert.ok(
    Math.abs(report.windows[0].dropPct - 60.4166) < 0.5,
    `dropPct 應約 60.4166（(48-19)/48*100），實際：${report.windows[0].dropPct}`
  )
  assert.equal(report.windows[0].verdict, 'provisional', `判定應為 provisional，實際：${report.windows[0].verdict}`)
  assert.equal(report.windows[0].partial, false, `partial 應為 false，實際：${report.windows[0].partial}`)
  assert.equal(report.baseline.rework.unknown, 5, `基線 rework.unknown 應為 5（前 5 張全在無 run 的前 8 張內），實際：${report.baseline.rework.unknown}`)
  assert.equal(report.windows[0].rework.unknown, 3, `窗 rework.unknown 應為 3（第 6-8 張仍在無 run 的前 8 張內），實際：${report.windows[0].rework.unknown}`)
})

test('cohortReport (b)：15 張全有 run（基線 1 張 run:2、窗 1 張 run:2）且窗中位數降 ≥40% ⇒ pass', () => {
  const baselineRuns = [2, 1, 1, 1, 1]
  const windowRuns = [2, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  const summaries = [
    ...baselineRuns.map((run, i) => makeCohortSummary({ ticket: `b${i + 1}`, apiCalls: 100, run, from: isoAt(i) })),
    ...windowRuns.map((run, i) => makeCohortSummary({ ticket: `w${i + 1}`, apiCalls: 50, run, from: isoAt(5 + i) })),
  ]

  const report = cohortReport(summaries, 'tool')

  assert.equal(report.baseline.median, 100, `基線中位數應為 100，實際：${report.baseline.median}`)
  assert.equal(report.windows[0].median, 50, `窗中位數應為 50，實際：${report.windows[0].median}`)
  assert.equal(report.windows[0].dropPct, 50, `dropPct 應為 50，實際：${report.windows[0].dropPct}`)
  assert.equal(report.baseline.rework.unknown, 0, `基線 rework.unknown 應為 0，實際：${report.baseline.rework.unknown}`)
  assert.equal(report.windows[0].rework.unknown, 0, `窗 rework.unknown 應為 0，實際：${report.windows[0].rework.unknown}`)
  assert.equal(report.windows[0].verdict, 'pass', `判定應為 pass（重工率 1/10=0.1 ≤ 基線 1/5=0.2），實際：${report.windows[0].verdict}`)
})

test('cohortReport (c)：降幅 ≥40% 但窗 3 張 run:2、基線 0 張 run:2 ⇒ fail', () => {
  const baselineRuns = [1, 1, 1, 1, 1]
  const windowRuns = [2, 2, 2, 1, 1, 1, 1, 1, 1, 1]
  const summaries = [
    ...baselineRuns.map((run, i) => makeCohortSummary({ ticket: `b${i + 1}`, apiCalls: 100, run, from: isoAt(i) })),
    ...windowRuns.map((run, i) => makeCohortSummary({ ticket: `w${i + 1}`, apiCalls: 50, run, from: isoAt(5 + i) })),
  ]

  const report = cohortReport(summaries, 'tool')

  assert.equal(report.windows[0].dropPct, 50, `dropPct 應為 50（≥40），實際：${report.windows[0].dropPct}`)
  assert.equal(report.baseline.rework.n, 0, `基線重工張數應為 0，實際：${report.baseline.rework.n}`)
  assert.equal(report.windows[0].rework.n, 3, `窗重工張數應為 3，實際：${report.windows[0].rework.n}`)
  assert.equal(report.windows[0].verdict, 'fail', `判定應為 fail（窗重工率 3/10 > 基線 0/5），實際：${report.windows[0].verdict}`)
})

test('cohortReport (d)：只 12 張合格票 ⇒ windows[0].partial===true、verdict===null、tickets.length===7', () => {
  const values = [48, 28, 43, 102, 131, 6, 52, 76, 78, 6, 14, 24]
  const summaries = values.map((apiCalls, i) => makeCohortSummary({
    ticket: `t${i + 1}`,
    apiCalls,
    run: 1,
    from: isoAt(i),
  }))

  const report = cohortReport(summaries, 'tool')

  assert.equal(report.windows.length, 1, `應恰好 1 個（未滿）窗，實際：${report.windows.length}`)
  assert.equal(report.windows[0].partial, true, `windows[0].partial 應為 true，實際：${report.windows[0].partial}`)
  assert.equal(report.windows[0].verdict, null, `windows[0].verdict 應為 null，實際：${report.windows[0].verdict}`)
  assert.equal(report.windows[0].tickets.length, 7, `windows[0].tickets.length 應為 7（12-5），實際：${report.windows[0].tickets.length}`)
})

test('cohortReport (e)：混入 caliber 不同 3 張、measurable:false 2 張、缺 apiCalls 1 張 ⇒ 母體計數＝基線 tickets＋各窗 tickets 總數恰等於合格張數 15', () => {
  const validSummaries = COHORT_15_VALUES.map((apiCalls, i) => makeCohortSummary({
    ticket: `v${i + 1}`,
    apiCalls,
    run: 1,
    from: isoAt(i),
  }))
  const junkSummaries = [
    makeCohortSummary({ ticket: 'junk-caliber-1', apiCalls: 10, run: 1, caliber: 'docs', from: isoAt(15) }),
    makeCohortSummary({ ticket: 'junk-caliber-2', apiCalls: 10, run: 1, caliber: 'feature', from: isoAt(16) }),
    makeCohortSummary({ ticket: 'junk-caliber-3', apiCalls: 10, run: 1, caliber: 'docs', from: isoAt(17) }),
    makeCohortSummary({ ticket: 'junk-unmeasurable-1', apiCalls: 10, run: 1, measurable: false, from: isoAt(18) }),
    makeCohortSummary({ ticket: 'junk-unmeasurable-2', apiCalls: 10, run: 1, measurable: false, from: isoAt(19) }),
    { ticket: 'junk-no-apicalls', caliber: 'tool', usage: { measurable: true }, coordinatorUsageExclusive: {}, usageWindow: { from: isoAt(20) }, run: 1 },
  ]

  const report = cohortReport([...validSummaries, ...junkSummaries], 'tool')

  const total = report.baseline.tickets.length + report.windows.reduce((sum, w) => sum + w.tickets.length, 0)
  assert.equal(total, 15, `母體計數（基線＋各窗 tickets 總數）應恰等於合格張數 15，實際：${total}`)
  assert.ok(
    report.baseline.tickets.every((t) => t.startsWith('v')) &&
    report.windows.every((w) => w.tickets.every((t) => t.startsWith('v'))),
    `所有納入的票都應是 v 開頭的合格票，實際 baseline：${JSON.stringify(report.baseline.tickets)}，windows：${JSON.stringify(report.windows.map((w) => w.tickets))}`
  )
})

test('cohortReport (k)：15 張全有 run（run 全 1），基線 apiCalls 48,28,43,102,131（中位數 48）、窗 10 張全部 40（中位數 40，dropPct≈16.67，未達 40% 門檻）⇒ fail', () => {
  const baselineValues = [48, 28, 43, 102, 131]
  const summaries = [
    ...baselineValues.map((apiCalls, i) => makeCohortSummary({ ticket: `k-b${i + 1}`, apiCalls, run: 1, from: isoAt(i) })),
    ...Array.from({ length: 10 }, (_, i) => makeCohortSummary({ ticket: `k-w${i + 1}`, apiCalls: 40, run: 1, from: isoAt(5 + i) })),
  ]

  const report = cohortReport(summaries, 'tool')

  assert.equal(report.baseline.median, 48, `基線中位數應為 48，實際：${report.baseline.median}`)
  assert.equal(report.windows[0].median, 40, `窗中位數應為 40，實際：${report.windows[0].median}`)
  assert.ok(
    Math.abs(report.windows[0].dropPct - 16.6667) < 0.5,
    `dropPct 應約 16.6667（(48-40)/48*100），實際：${report.windows[0].dropPct}`
  )
  assert.equal(report.windows[0].verdict, 'fail', `降幅未達 40% 門檻應判 fail，實際：${report.windows[0].verdict}`)
})

test('cohortReport (o)：對亂序輸入（(a) 的 15 張 fixture 陣列反轉）⇒ baseline.tickets／windows[0].tickets 仍依 usageWindow.from 升冪排序（拿掉 filtered.sort 就會紅）', () => {
  const summaries = COHORT_15_VALUES.map((apiCalls, i) => makeCohortSummary({
    ticket: `t${i + 1}`,
    apiCalls,
    run: i < 8 ? undefined : 1,
    from: isoAt(i),
  }))
  const shuffled = [...summaries].reverse()

  const report = cohortReport(shuffled, 'tool')

  const expectedBaseline = ['t1', 't2', 't3', 't4', 't5']
  const expectedWindow = ['t6', 't7', 't8', 't9', 't10', 't11', 't12', 't13', 't14', 't15']
  assert.deepEqual(
    report.baseline.tickets, expectedBaseline,
    `baseline.tickets 應仍依 usageWindow.from 升冪排序，實際：${JSON.stringify(report.baseline.tickets)}`
  )
  assert.deepEqual(
    report.windows[0].tickets, expectedWindow,
    `windows[0].tickets 應仍依 usageWindow.from 升冪排序，實際：${JSON.stringify(report.windows[0].tickets)}`
  )
  assert.equal(report.baseline.median, 48, `反轉輸入不應改變基線中位數（若排序被拿掉會算到別組），實際：${report.baseline.median}`)
  assert.equal(report.windows[0].median, 19, `反轉輸入不應改變窗中位數（若排序被拿掉會算到別組），實際：${report.windows[0].median}`)
})

// ── 17. --tag-caliber（CLI）──────────────────────────────────────────────────

// 同時攔截 stdout／stderr，回傳合併字串；訊息斷言不綁定哪一條 stream。
async function runCliCapturingBoth(args, opts) {
  let combined = ''
  const origLog = console.log
  const origError = console.error
  console.log = (...a) => { combined += a.join(' ') + '\n' }
  console.error = (...a) => { combined += a.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain(args, opts)
  } finally {
    console.log = origLog
    console.error = origError
  }
  return { exitCode, combined }
}

test('--tag-caliber：首次標記寫入 caliber/caliberBy/caliberGrandfathered 且保留其他欄位；已標記後再標 ⇒ exit 2 且檔案逐字不變；非法值 ⇒ exit 2；summary.json 不存在 ⇒ exit 1', async () => {
  const root = tmp()
  const ticket = 'tag-ticket-x'
  const localDir = join(root, '.local/llm-team')

  const initialSummary = {
    schemaVersion: 2,
    project: 'tag-test-project',
    ticket,
    coordinator: 'claude',
    comparable: false,
    dispositions: ['keep-intact'],
  }
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')
  const cfgPath = makeFixtureConfig(root)
  const summaryFile = join(localDir, `${ticket}/summary.json`)

  const first = await runCliCapturingBoth([
    '--tag-caliber', 'tool',
    '--ticket', ticket,
    '--config', cfgPath,
    '--grandfathered',
  ], { cwd: root, repoRoot: root })

  assert.equal(first.exitCode, 0, `首次標記應 exit 0，實際：${first.exitCode}`)
  assert.match(first.combined, /已標 tag-ticket-x caliber=tool/, `stdout＋stderr 應印確認訊息，實際：${first.combined}`)

  const written = JSON.parse(readFileSync(summaryFile, 'utf8'))
  assert.equal(written.caliber, 'tool', `caliber 應為 tool，實際：${written.caliber}`)
  assert.equal(written.caliberBy, 'coordinator', `caliberBy 應為 coordinator，實際：${written.caliberBy}`)
  assert.equal(written.caliberGrandfathered, true, `caliberGrandfathered 應為 true，實際：${written.caliberGrandfathered}`)
  // 其他欄位保留
  assert.equal(written.schemaVersion, 2)
  assert.equal(written.project, 'tag-test-project')
  assert.equal(written.coordinator, 'claude')
  assert.deepEqual(written.dispositions, ['keep-intact'])

  const beforeSecond = readFileSync(summaryFile, 'utf8')
  const second = await runCliCapturingBoth([
    '--tag-caliber', 'feature',
    '--ticket', ticket,
    '--config', cfgPath,
  ], { cwd: root, repoRoot: root })
  assert.equal(second.exitCode, 2, `已標記過的票再標應 exit 2，實際：${second.exitCode}`)
  assert.match(second.combined, /已標 "tool"，不覆寫/, `stdout＋stderr 應指明舊值 "tool"，實際：${second.combined}`)
  const afterSecond = readFileSync(summaryFile, 'utf8')
  assert.equal(afterSecond, beforeSecond, '再跑一次不應改動檔案內容（逐字相同）')

  const third = await runCliCapturingBoth([
    '--tag-caliber', 'xyz',
    '--ticket', ticket,
    '--config', cfgPath,
  ], { cwd: root, repoRoot: root })
  assert.equal(third.exitCode, 2, `非法 caliber 值應 exit 2，實際：${third.exitCode}`)
  assert.match(third.combined, /只准 docs｜tool｜feature/, `stdout＋stderr 應指明合法值範圍，實際：${third.combined}`)

  const fourth = await runCliCapturingBoth([
    '--tag-caliber', 'docs',
    '--ticket', 'no-such-ticket',
    '--config', cfgPath,
  ], { cwd: root, repoRoot: root })
  assert.equal(fourth.exitCode, 1, `summary.json 不存在應 exit 1，實際：${fourth.exitCode}`)
  assert.match(fourth.combined, /summary\.json 不存在/, `stdout＋stderr 應指明 summary.json 不存在，實際：${fourth.combined}`)
})

test('--tag-caliber (l)：空字串值（VALUE_FLAGS 給 --tag-caliber \'\'）⇒ exit 2、訊息含「只准 docs」、summary 檔逐字不變（不准掉進找 transcript 的路徑）', async () => {
  const root = tmp()
  const ticket = 'tag-ticket-empty'
  const localDir = join(root, '.local/llm-team')
  const initialSummary = {
    schemaVersion: 2,
    ticket,
    coordinator: 'claude',
    comparable: false,
  }
  const summaryFile = join(localDir, `${ticket}/summary.json`)
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')
  const cfgPath = makeFixtureConfig(root)
  const before = readFileSync(summaryFile, 'utf8')

  const result = await runCliCapturingBoth([
    '--tag-caliber', '',
    '--ticket', ticket,
    '--config', cfgPath,
  ], { cwd: root, repoRoot: root })

  assert.equal(result.exitCode, 2, `--tag-caliber '' 應 exit 2，實際：${result.exitCode}`)
  assert.match(result.combined, /只准 docs/, `訊息應含「只准 docs」，實際：${result.combined}`)
  const after = readFileSync(summaryFile, 'utf8')
  assert.equal(after, before, 'summary 檔案應逐字不變')
})

test('--tag-caliber (m)：既有 caliber:null 的 summary 再 --tag-caliber tool ⇒ exit 2、訊息含「不覆寫」、檔案逐字不變（已標＝欄位存在性，不是真假值）', async () => {
  const root = tmp()
  const ticket = 'tag-ticket-null-caliber'
  const localDir = join(root, '.local/llm-team')
  const initialSummary = {
    schemaVersion: 2,
    ticket,
    coordinator: 'claude',
    comparable: false,
    caliber: null,
  }
  const summaryFile = join(localDir, `${ticket}/summary.json`)
  write(localDir, `${ticket}/summary.json`, JSON.stringify(initialSummary, null, 2) + '\n')
  const cfgPath = makeFixtureConfig(root)
  const before = readFileSync(summaryFile, 'utf8')

  const result = await runCliCapturingBoth([
    '--tag-caliber', 'tool',
    '--ticket', ticket,
    '--config', cfgPath,
  ], { cwd: root, repoRoot: root })

  assert.equal(result.exitCode, 2, `caliber:null 也算已標，應 exit 2，實際：${result.exitCode}`)
  assert.match(result.combined, /不覆寫/, `訊息應含「不覆寫」，實際：${result.combined}`)
  const after = readFileSync(summaryFile, 'utf8')
  assert.equal(after, before, 'summary 檔案應逐字不變')
})

test('--tag-caliber (q)：--tag-caliber tool --cohort tool --ticket x（兩個模式旗標同時出現）⇒ exit 2 且含「不可同時使用」', async () => {
  const root = tmp()
  const cfgPath = makeFixtureConfig(root)

  const result = await runCliCapturingBoth([
    '--tag-caliber', 'tool',
    '--cohort', 'tool',
    '--ticket', 'x',
    '--config', cfgPath,
  ], { cwd: root, repoRoot: root })

  assert.equal(result.exitCode, 2, `兩個模式旗標同時出現應 exit 2，實際：${result.exitCode}`)
  assert.match(result.combined, /不可同時使用/, `訊息應含「不可同時使用」，實際：${result.combined}`)
})

// ── 18. --cohort（CLI）───────────────────────────────────────────────────────

test('--cohort tool --json：對 tmp localDir（15 個子目錄各一份真 lifecycle+transcript）⇒ exit 0、stdout 解析後 windows[0].median===19；同 localDir --cohort docs（無合格票）⇒ exit 0、stdout 含「基線未滿 0/5」；不需要 --ticket', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')

  COHORT_15_VALUES.forEach((apiCalls, i) => {
    const ticket = `ct${i + 1}`
    makeLiveTicket(root, projectsDir, { ticket, apiCalls, run: i < 8 ? null : 1, hourIndex: i })
  })
  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  const origLog = console.log
  console.log = (...args) => { stdoutOutput += args.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain([
      '--cohort', 'tool',
      '--config', cfgPath,
      '--json',
    ], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
  }

  assert.equal(exitCode, 0, `--cohort tool --json 應 exit 0，實際：${exitCode}`)
  const parsed = JSON.parse(stdoutOutput.trim())
  assert.equal(parsed.windows[0].median, 19, `windows[0].median 應為 19，實際：${parsed.windows[0].median}`)

  let stdoutOutput2 = ''
  console.log = (...args) => { stdoutOutput2 += args.join(' ') + '\n' }
  let exitCode2
  try {
    exitCode2 = await cliMain([
      '--cohort', 'docs',
      '--config', cfgPath,
    ], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
  }
  assert.equal(exitCode2, 0, `--cohort docs（無合格票）應 exit 0，實際：${exitCode2}`)
  assert.match(stdoutOutput2, /基線未滿 0\/5/, `stdout 應含「基線未滿 0/5」，實際：${stdoutOutput2}`)
  // 上面兩次呼叫都沒帶 --ticket 也沒觸發缺少必填的 exit 2，證明 --cohort 不需要 --ticket。
  // 壞 JSON 的 summary.json 現在改成 fail-closed（sol 第 8 輪 Q2），對照見「1.8.0 ③ (Q8-a)」。
})

test('--cohort (n)：localDir 有一個空子目錄（沒有 summary.json）⇒ exit 0、stderr 含「沒有 summary.json」，且該目錄不出現在任何 tickets 名單', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')
  const projectsDir = join(root, 'projects')

  COHORT_15_VALUES.forEach((apiCalls, i) => {
    const ticket = `nt${i + 1}`
    makeLiveTicket(root, projectsDir, { ticket, apiCalls, run: i < 8 ? null : 1, hourIndex: i })
  })
  // 空子目錄：沒有 summary.json
  mkdirSync(join(localDir, 'empty-no-summary'), { recursive: true })
  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  let stderrOutput = ''
  const origLog = console.log
  const origError = console.error
  console.log = (...args) => { stdoutOutput += args.join(' ') + '\n' }
  console.error = (...args) => { stderrOutput += args.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain([
      '--cohort', 'tool',
      '--config', cfgPath,
      '--json',
    ], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
    console.error = origError
  }

  assert.equal(exitCode, 0, `空子目錄存在時 --cohort tool 應 exit 0，實際：${exitCode}`)
  assert.match(stderrOutput, /略過 empty-no-summary：沒有 summary\.json/, `stderr 應含「沒有 summary.json」，實際：${stderrOutput}`)

  const parsed = JSON.parse(stdoutOutput.trim())
  const allTickets = [
    ...parsed.baseline.tickets,
    ...parsed.windows.flatMap((w) => w.tickets),
  ]
  assert.ok(
    !allTickets.includes('empty-no-summary'),
    `empty-no-summary 不應出現在任何 tickets 名單，實際名單：${JSON.stringify(allTickets)}`
  )
})

test('--cohort (p)：非 --json 的 --cohort tool 對 15 張 tmp fixture ⇒ stdout 逐字等於預期的窗行＋provisional 附注兩行', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')
  const projectsDir = join(root, 'projects')

  COHORT_15_VALUES.forEach((apiCalls, i) => {
    const ticket = `ct${i + 1}`
    makeLiveTicket(root, projectsDir, { ticket, apiCalls, run: i < 8 ? null : 1, hourIndex: i })
  })
  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  const origLog = console.log
  console.log = (...args) => { stdoutOutput += args.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain([
      '--cohort', 'tool',
      '--config', cfgPath,
    ], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
  }

  assert.equal(exitCode, 0, `--cohort tool（非 --json）應 exit 0，實際：${exitCode}`)
  const expected =
    '窗 1：票 ct6,ct7,ct8,ct9,ct10,ct11,ct12,ct13,ct14,ct15；中位數 19（基線 48，降 60.4%）；重工率 0/7（3 張無 run 欄位）（基線 0/0（5 張無 run 欄位））；判定 🟡 provisional\n' +
    '重工率不可比：缺 run 欄位\n'
  assert.equal(stdoutOutput, expected, `stdout 應逐字等於預期兩行，實際：${JSON.stringify(stdoutOutput)}`)
})

// ── 19. 1.8.0 ②③：cohort live 量測（lifecycle＋transcript，不依賴預先存在的 usage 寫入）＋自證 JSON ──

const EPOCH = Date.parse('2026-09-05T00:00:00.000Z')
/** 第 i 個「小時格」的 ISO 字串（+offsetSec 秒），讓不同票的視窗彼此不重疊，避免 exclusive 歸屬互相干擾。 */
const hourAt = (i, offsetSec = 0) => new Date(EPOCH + i * 3600_000 + offsetSec * 1000).toISOString()

/**
 * 建一張「新流程」票的 fixture：只有 lifecycle.ndjson＋summary.json（沒有 usage／coordinatorUsageExclusive／usageWindow
 * 欄位——模擬 1.8.0 ② 拿掉「accept 後跑 --write」之後的正常狀態），可選寫一份假 transcript（sessionId 對應）。
 */
function makeLiveTicket(root, projectsDir, {
  ticket,
  caliber = 'tool',
  run = 1,
  apiCalls = 0,
  hourIndex,
  withTranscript = true,
  measurementSchemaVersion = MEASUREMENT_SCHEMA_VERSION,
  coordinator = 'claude',
}) {
  const localDir = join(root, '.local/llm-team')
  const ticketDir = join(localDir, ticket)
  mkdirSync(ticketDir, { recursive: true })
  const sessionId = `sess-${ticket}`
  const runStartAt = hourAt(hourIndex)
  const acceptedAt = hourAt(hourIndex, apiCalls + 5)
  const lifecycle = [
    { at: runStartAt, event: 'run-start', ticket, run: 1, sessionId },
    { at: acceptedAt, event: 'accepted', ticket },
  ]
  writeFileSync(join(ticketDir, 'lifecycle.ndjson'), lifecycle.map((e) => JSON.stringify(e)).join('\n') + '\n')

  // run: null ⇒ 故意不寫 run 欄位（模擬舊票缺 run，重工率不可比的 fixture）。
  // measurementSchemaVersion: null ⇒ 故意不寫這個欄位（模擬連欄位都沒有的舊票）。
  const summary = { schemaVersion: 2, coordinator, ticket, caliber }
  if (run !== null) summary.run = run
  if (measurementSchemaVersion !== null) summary.measurementSchemaVersion = measurementSchemaVersion
  writeFileSync(join(ticketDir, 'summary.json'), JSON.stringify(summary, null, 2))

  if (withTranscript) {
    const records = []
    for (let i = 0; i < apiCalls; i++) {
      records.push({
        type: 'assistant',
        timestamp: hourAt(hourIndex, i + 1),
        message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
      })
    }
    const subDir = join(projectsDir, 'proj')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return { runStartAt, acceptedAt }
}

test('1.8.0 ②③ (a)：5 張全新流程票（只有 lifecycle+transcript，完全沒有 usage 欄位）⇒ --cohort 現場量出 baseline.median、產出自證 JSON，tickets[].apiCalls 與 lifecycleHash／recordsHash 都非空', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  const apiCallsList = [48, 28, 43, 102, 131]
  apiCallsList.forEach((apiCalls, i) => {
    makeLiveTicket(root, projectsDir, { ticket: `lv${i + 1}`, apiCalls, hourIndex: i })
  })
  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  let stderrOutput = ''
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => { stdoutOutput += a.join(' ') + '\n' }
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath, '--json'], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
    console.error = origErr
  }

  assert.equal(exitCode, 0, `實際：${exitCode}，stderr：${stderrOutput}`)
  const report = JSON.parse(stdoutOutput.trim())
  assert.equal(report.baseline.median, 48, `baseline.median 應為 48（現場量出，非預寫），實際：${report.baseline.median}`)
  assert.deepEqual(report.baseline.tickets, ['lv1', 'lv2', 'lv3', 'lv4', 'lv5'])

  const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=([0-9a-f]+)）/)
  assert.ok(m, `stderr 應印出 cohort JSON 路徑與 inputHash，實際：${stderrOutput}`)
  const [, jsonPath, inputHash] = m
  const payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
  assert.equal(payload.schemaVersion, COHORT_JSON_SCHEMA_VERSION)
  assert.equal(payload.caliber, 'tool')
  assert.equal(payload.inputHash, inputHash)
  assert.equal(payload.tickets.length, 5)
  for (const t of payload.tickets) {
    assert.equal(typeof t.apiCalls, 'number', `${t.ticket} 的 apiCalls 應為數字（現場量出）`)
    assert.equal(typeof t.lifecycleHash, 'string', `${t.ticket} 應有 lifecycleHash`)
    assert.equal(typeof t.recordsHash, 'string', `${t.ticket} 應有 recordsHash（實際採計的 transcript records 的 canonical 雜湊）`)
  }
  // lifecycleHash 逐字對得上真的檔案雜湊
  const expectedHash = lifecycleHashOf(join(root, '.local/llm-team'), 'lv1')
  const t1 = payload.tickets.find((t) => t.ticket === 'lv1')
  assert.equal(t1.lifecycleHash, expectedHash)
})

test('1.8.0 ② 陽性對照：缺 transcript 的票 measurable:false，且只要口徑內存在該票 ⇒ 原本會 pass 的窗降級為 provisional（demotedReason 標明原因）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')

  // 基線 5 張：apiCalls 100（一張 run:2），與 cohortReport (b) 的基線同構
  const baselineRuns = [2, 1, 1, 1, 1]
  baselineRuns.forEach((run, i) => {
    makeLiveTicket(root, projectsDir, { ticket: `b${i + 1}`, apiCalls: 100, run, hourIndex: i })
  })
  // 窗 10 張可量測：apiCalls 50（一張 run:2）
  const windowRuns = [2, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  windowRuns.forEach((run, i) => {
    makeLiveTicket(root, projectsDir, { ticket: `w${i + 1}`, apiCalls: 50, run, hourIndex: 5 + i })
  })
  // 額外一張同口徑但沒有 transcript ⇒ measurable:false（不進 filtered，但仍在母體裡讓 hasUnmeasurable 成立）
  makeLiveTicket(root, projectsDir, { ticket: 'x-missing-transcript', apiCalls: 999, hourIndex: 30, withTranscript: false })

  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  const origLog = console.log
  console.log = (...a) => { stdoutOutput += a.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath, '--json'], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
  }

  assert.equal(exitCode, 0, `實際：${exitCode}`)
  const report = JSON.parse(stdoutOutput.trim())
  assert.equal(report.windows.length, 1, `應恰好 1 個窗，實際：${report.windows.length}`)
  assert.equal(report.windows[0].partial, false)
  assert.equal(report.windows[0].dropPct, 50, `dropPct 應為 50，實際：${report.windows[0].dropPct}`)
  assert.equal(
    report.windows[0].verdict,
    'provisional',
    `本應 pass（降幅 50%＋重工率可比）但存在無法量測的票 ⇒ 必須降級為 provisional，不得 pass，實際：${report.windows[0].verdict}`
  )
  assert.equal(report.windows[0].demotedReason, 'unmeasurable-ticket-present')
  assert.ok(
    !report.windows[0].tickets.includes('x-missing-transcript'),
    'x-missing-transcript 本身不應出現在窗的 tickets 名單（它 measurable:false，不進 filtered 分組）'
  )

  // 陽性對照：拿掉那張缺 transcript 的票之後重跑，同樣的 15 張應該真的 pass（證明降級是因為那張票的存在，不是別的原因）
  const root2 = tmp()
  const projectsDir2 = join(root2, 'projects')
  baselineRuns.forEach((run, i) => makeLiveTicket(root2, projectsDir2, { ticket: `b${i + 1}`, apiCalls: 100, run, hourIndex: i }))
  windowRuns.forEach((run, i) => makeLiveTicket(root2, projectsDir2, { ticket: `w${i + 1}`, apiCalls: 50, run, hourIndex: 5 + i }))
  const cfgPath2 = makeFixtureConfig(root2)
  let stdoutOutput2 = ''
  console.log = (...a) => { stdoutOutput2 += a.join(' ') + '\n' }
  let exitCode2
  try {
    exitCode2 = await cliMain(['--cohort', 'tool', '--config', cfgPath2, '--json'], { cwd: root2, repoRoot: root2, projectsRoot: projectsDir2 , git: fakeGit })
  } finally {
    console.log = origLog
  }
  assert.equal(exitCode2, 0)
  const report2 = JSON.parse(stdoutOutput2.trim())
  assert.equal(report2.windows[0].verdict, 'pass', `陽性對照：沒有無法量測的票時應真的 pass，實際：${report2.windows[0].verdict}`)
})

test('1.8.0 ② 陽性對照：measurementSchemaVersion 與現版不符的票 ⇒ 完全不進同一個 cohort（不算進母體，也不佔基線名額）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  const apiCallsList = [48, 28, 43, 102, 131]
  apiCallsList.forEach((apiCalls, i) => {
    makeLiveTicket(root, projectsDir, { ticket: `v${i + 1}`, apiCalls, hourIndex: i })
  })
  // 版本不符：即使有合法 caliber 與可量測的 transcript，也要被排除
  makeLiveTicket(root, projectsDir, {
    ticket: 'mismatched-version',
    apiCalls: 10,
    hourIndex: 10,
    measurementSchemaVersion: MEASUREMENT_SCHEMA_VERSION + 1,
  })
  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  let stderrOutput = ''
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => { stdoutOutput += a.join(' ') + '\n' }
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath, '--json'], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
    console.error = origErr
  }

  assert.equal(exitCode, 0)
  const report = JSON.parse(stdoutOutput.trim())
  assert.equal(report.baseline.tickets.length, 5, `基線仍應恰好 5 張（版本不符的票不佔名額），實際：${report.baseline.tickets.length}`)
  assert.ok(!report.baseline.tickets.includes('mismatched-version'))
  assert.match(stderrOutput, /略過 mismatched-version：measurementSchemaVersion 不符/)
})

test('1.8.0 ③ 停止條件：同一組固定輸入跑兩次 --cohort ⇒ inputHash 與 verdict 相同（即使兩次呼叫時間不同）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  const apiCallsList = [48, 28, 43, 102, 131]
  apiCallsList.forEach((apiCalls, i) => {
    makeLiveTicket(root, projectsDir, { ticket: `d${i + 1}`, apiCalls, hourIndex: i })
  })
  const cfgPath = makeFixtureConfig(root)

  const runOnce = async (nowIso) => {
    let stderrOutput = ''
    const origErr = console.error
    const origLog = console.log
    console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
    console.log = () => {}
    let exitCode
    try {
      exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
        cwd: root,
        repoRoot: root,
        git: fakeGit,
        projectsRoot: projectsDir,
        now: () => new Date(nowIso),
      })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    assert.equal(exitCode, 0)
    const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=([0-9a-f]+)）/)
    assert.ok(m, `實際 stderr：${stderrOutput}`)
    return { jsonPath: m[1], inputHash: m[2] }
  }

  const first = await runOnce('2026-01-01T00:00:00.000Z')
  const second = await runOnce('2026-02-02T00:00:00.000Z')

  assert.notEqual(first.jsonPath, second.jsonPath, '兩次 generatedAt 不同 ⇒ 檔名不同，兩份都留著')
  assert.equal(first.inputHash, second.inputHash, '固定輸入跑兩次，inputHash 不應因為 generatedAt 不同而改變')

  const p1 = JSON.parse(readFileSync(first.jsonPath, 'utf8'))
  const p2 = JSON.parse(readFileSync(second.jsonPath, 'utf8'))
  assert.equal(p1.verdict, p2.verdict, '固定輸入跑兩次，verdict 應相同')
  assert.notEqual(p1.generatedAt, p2.generatedAt)
})

test('1.8.0 ③ 停止條件：改動 payload 內任一票的 apiCalls／run／usageWindow ⇒ inputHash 改變（canonicalStringify 是穩定序列化，key 順序不影響雜湊）', () => {
  const baseReport = cohortReport(
    [1, 2, 3, 4, 5].map((n) => ({
      ticket: `k${n}`,
      caliber: 'tool',
      usage: { measurable: true },
      coordinatorUsageExclusive: { apiCalls: n * 10 },
      usageWindow: { from: isoAt(n) },
      run: 1,
    })),
    'tool'
  )
  const ticketDetails = [
    { ticket: 'k1', caliber: 'tool', apiCalls: 10, run: 1, usageWindow: { from: isoAt(1), to: isoAt(1) }, lifecycleHash: 'h1', recordsHash: 'r1' },
  ]
  const base = buildCohortPayload({
    caliber: 'tool',
    report: baseReport,
    ticketDetails,
    toolVersion: '1.8.0',
    sourceCommit: 'deadbeef',
    generatedAt: '2026-01-01T00:00:00.000Z',
  })
  const canonOf = (p) => canonicalStringify({ ...p, generatedAt: null })
  const baseHash = canonOf(base)

  const mutatedApiCalls = { ...base, tickets: [{ ...ticketDetails[0], apiCalls: 999 }] }
  assert.notEqual(canonOf(mutatedApiCalls), baseHash, '改 apiCalls 應改變 canonical 序列化結果')

  const mutatedRun = { ...base, tickets: [{ ...ticketDetails[0], run: 2 }] }
  assert.notEqual(canonOf(mutatedRun), baseHash, '改 run 應改變 canonical 序列化結果')

  const mutatedWindow = { ...base, tickets: [{ ...ticketDetails[0], usageWindow: { from: isoAt(1), to: isoAt(2) } }] }
  assert.notEqual(canonOf(mutatedWindow), baseHash, '改 usageWindow 應改變 canonical 序列化結果')

  // key 順序不影響：同一份資料換個 key 插入順序，canonical 字串應逐字相同
  const reordered = JSON.parse(JSON.stringify(base))
  const swapped = { tickets: reordered.tickets, ...reordered }
  assert.equal(canonOf(swapped), baseHash, 'canonicalStringify 對 key 順序不敏感')
})

// ── 20. sol block 複審第 1 輪修法（Q2／Q3／Q5）陽性對照 ──────────────────────

test('1.8.0 ②③ (Q3-a) 陽性對照：舊 summary.usage 與 transcript 故意矛盾 ⇒ JSON 採 live 值、recordsHash 非空（不信任過期 --write 產物）', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')
  const projectsDir = join(root, 'projects')

  makeLiveTicket(root, projectsDir, { ticket: 'stale-vs-live', apiCalls: 48, run: 1, hourIndex: 0 })

  // 手動注入「過期」的 usage 產物：宣稱 apiCalls=999，與 transcript 實際的 48 筆矛盾。
  const summaryFile = join(localDir, 'stale-vs-live', 'summary.json')
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'))
  summary.usage = { measurable: true }
  summary.coordinatorUsageExclusive = { apiCalls: 999 }
  summary.usageWindow = { from: isoAt(0), to: isoAt(0) }
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2))

  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  let stderrOutput = ''
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => { stdoutOutput += a.join(' ') + '\n' }
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
    console.error = origErr
  }
  assert.equal(exitCode, 0, `實際：${exitCode}，stderr：${stderrOutput}`)

  assert.match(
    stderrOutput,
    /舊 usage 產物 apiCalls=999 與 live 量測 apiCalls=48 不符（僅供對照），採計 live 值/,
    `stderr 應印出矛盾對照訊息，實際：${stderrOutput}`
  )

  const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=/)
  assert.ok(m, `實際 stderr：${stderrOutput}`)
  const payload = JSON.parse(readFileSync(m[1], 'utf8'))
  const entry = payload.tickets.find((t) => t.ticket === 'stale-vs-live')
  assert.ok(entry, `payload.tickets 應含 stale-vs-live，實際：${JSON.stringify(payload.tickets)}`)
  assert.equal(entry.apiCalls, 48, `JSON 的 apiCalls 應採 live 量測值 48（不是過期的 999），實際：${entry.apiCalls}`)
  assert.equal(typeof entry.recordsHash, 'string', 'recordsHash 應非空（live 量測真的跑過 transcript）')
})

test('1.8.0 ②③ (Q3-b) 陽性對照：measurementSchemaVersion 不符但「已有舊 usage 欄位」的票，仍不得進同一個 cohort（版本檢查不能被舊 usage 繞過）', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')
  const projectsDir = join(root, 'projects')

  const apiCallsList = [48, 28, 43, 102, 131]
  apiCallsList.forEach((apiCalls, i) => {
    makeLiveTicket(root, projectsDir, { ticket: `v${i + 1}`, apiCalls, hourIndex: i })
  })

  // 版本不符，但額外帶著一份完整、看起來合法的舊 usage 產物——舊版程式碼會因為「已有 usage」就跳過版本檢查。
  makeLiveTicket(root, projectsDir, {
    ticket: 'mismatched-with-stale-usage',
    apiCalls: 10,
    hourIndex: 10,
    measurementSchemaVersion: MEASUREMENT_SCHEMA_VERSION + 1,
  })
  const badSummaryFile = join(localDir, 'mismatched-with-stale-usage', 'summary.json')
  const badSummary = JSON.parse(readFileSync(badSummaryFile, 'utf8'))
  badSummary.usage = { measurable: true }
  badSummary.coordinatorUsageExclusive = { apiCalls: 10 }
  badSummary.usageWindow = { from: isoAt(10), to: isoAt(10) }
  writeFileSync(badSummaryFile, JSON.stringify(badSummary, null, 2))

  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  let stderrOutput = ''
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => { stdoutOutput += a.join(' ') + '\n' }
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath, '--json'], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
    console.error = origErr
  }
  assert.equal(exitCode, 0)
  const report = JSON.parse(stdoutOutput.trim())
  assert.equal(report.baseline.tickets.length, 5, `基線仍應恰好 5 張，實際：${report.baseline.tickets.length}`)
  assert.ok(!report.baseline.tickets.includes('mismatched-with-stale-usage'))
  assert.match(stderrOutput, /略過 mismatched-with-stale-usage：measurementSchemaVersion 不符/)
})

test('1.8.0 ②③ (Q3-d) 陽性對照：measurementSchemaVersion 欄位整個缺失（連欄位都沒有，不是版本不同）⇒ 不進 baseline／windows／JSON tickets，stderr 記「缺欄」', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')
  const projectsDir = join(root, 'projects')

  // 5 張合格票排在 hourIndex 1..5（時間序在缺欄票之後），若缺欄票被誤採計，會排進基線最前面把中位數往下拉。
  const apiCallsList = [48, 28, 43, 102, 131]
  apiCallsList.forEach((apiCalls, i) => {
    makeLiveTicket(root, projectsDir, { ticket: `q3d-v${i + 1}`, apiCalls, hourIndex: i + 1 })
  })
  // 缺欄票：排在最早（hourIndex 0），lifecycle＋transcript 都完整，apiCalls 極端值（5），
  // 若誤採計會把基線中位數從 48 拉低（且會佔掉基線 5 個名額之一）。
  makeLiveTicket(root, projectsDir, {
    ticket: 'q3d-missing-version',
    apiCalls: 5,
    hourIndex: 0,
    measurementSchemaVersion: null,
  })

  const cfgPath = makeFixtureConfig(root)

  let stdoutOutput = ''
  let stderrOutput = ''
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => { stdoutOutput += a.join(' ') + '\n' }
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath, '--json'], { cwd: root, repoRoot: root, projectsRoot: projectsDir , git: fakeGit })
  } finally {
    console.log = origLog
    console.error = origErr
  }
  assert.equal(exitCode, 0, `實際：${exitCode}，stderr：${stderrOutput}`)

  const report = JSON.parse(stdoutOutput.trim())
  assert.equal(report.baseline.tickets.length, 5, `基線仍應恰好 5 張（缺欄票不佔名額），實際：${report.baseline.tickets.length}`)
  assert.equal(report.baseline.median, 48, `基線中位數應維持 48（缺欄票的極端值 5 沒有混進去），實際：${report.baseline.median}`)
  assert.ok(!report.baseline.tickets.includes('q3d-missing-version'), '缺欄票不應出現在 baseline.tickets')
  const allWindowTickets = report.windows.flatMap((w) => w.tickets)
  assert.ok(!allWindowTickets.includes('q3d-missing-version'), '缺欄票不應出現在任何 windows.tickets')

  assert.match(
    stderrOutput,
    /ℹ 略過 q3d-missing-version：measurementSchemaVersion 不符（缺欄），不進同一個 cohort/,
    `stderr 應記錄「缺欄」而不是含糊帶過，實際：${stderrOutput}`
  )

  const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=/)
  assert.ok(m, `實際 stderr：${stderrOutput}`)
  const payload = JSON.parse(readFileSync(m[1], 'utf8'))
  assert.ok(
    !payload.tickets.some((t) => t.ticket === 'q3d-missing-version'),
    `JSON 的 tickets 不應含缺欄票，實際：${JSON.stringify(payload.tickets.map((t) => t.ticket))}`
  )
})

test('1.8.0 ③ (Q3-c) 停止條件：走真的 --cohort production 路徑（main()，不是只比 canonicalStringify）——改動一張票底層資料（transcript 多一筆）後重跑 ⇒ inputHash 真的改變', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')
  const projectsDir = join(root, 'projects')

  const apiCallsList = [48, 28, 43, 102, 131]
  apiCallsList.forEach((apiCalls, i) => {
    makeLiveTicket(root, projectsDir, { ticket: `pc${i + 1}`, apiCalls, hourIndex: i })
  })
  const cfgPath = makeFixtureConfig(root)

  const runOnce = async (nowIso) => {
    let stderrOutput = ''
    const origErr = console.error
    const origLog = console.log
    console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
    console.log = () => {}
    let exitCode
    try {
      exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
        cwd: root,
        repoRoot: root,
        git: fakeGit,
        projectsRoot: projectsDir,
        now: () => new Date(nowIso),
      })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    assert.equal(exitCode, 0)
    const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=([0-9a-f]+)）/)
    assert.ok(m, `實際 stderr：${stderrOutput}`)
    return { jsonPath: m[1], inputHash: m[2] }
  }

  const before = await runOnce('2026-03-01T00:00:00.000Z')

  // 真的改動底層資料：對 pc1 的 transcript 多加一筆 assistant usage 記錄（在視窗內），live apiCalls 因此 +1。
  const pc1SessionId = 'sess-pc1'
  const transcriptPath = join(projectsDir, 'proj', `${pc1SessionId}.jsonl`)
  const extraRecord = {
    type: 'assistant',
    timestamp: hourAt(0, apiCallsList[0] + 1),
    message: { usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } },
  }
  const acceptedAtPc1 = hourAt(0, apiCallsList[0] + 5)
  assert.ok(Date.parse(extraRecord.timestamp) < Date.parse(acceptedAtPc1), '額外記錄要落在視窗內才會被算進去')
  const fs2 = readFileSync(transcriptPath, 'utf8')
  writeFileSync(transcriptPath, fs2 + JSON.stringify(extraRecord) + '\n')

  const after = await runOnce('2026-04-01T00:00:00.000Z')

  assert.notEqual(before.jsonPath, after.jsonPath)
  assert.notEqual(
    before.inputHash,
    after.inputHash,
    '底層 transcript 真的變了（apiCalls +1），走真的 production --cohort 路徑算出的 inputHash 應該不同'
  )

  const beforePayload = JSON.parse(readFileSync(before.jsonPath, 'utf8'))
  const afterPayload = JSON.parse(readFileSync(after.jsonPath, 'utf8'))
  const beforePc1 = beforePayload.tickets.find((t) => t.ticket === 'pc1')
  const afterPc1 = afterPayload.tickets.find((t) => t.ticket === 'pc1')
  assert.equal(afterPc1.apiCalls, beforePc1.apiCalls + 1, `pc1 的 apiCalls 應該從 ${beforePc1.apiCalls} 變成 ${beforePc1.apiCalls + 1}，實際：${afterPc1.apiCalls}`)
})

test('1.8.0 ③ (Q5) 陽性對照：readdirSync 的檔案系統列舉順序不是穩定契約——同一組票以相反的目錄建立順序餵入 ⇒ inputHash 相同；payload.tickets 一律依票名排序', async () => {
  const ticketDefs = [0, 1, 2, 3, 4].map((i) => ({ ticket: `tie${i + 1}`, apiCalls: [48, 28, 43, 102, 131][i], hourIndex: i }))

  const buildAndRun = async (defs) => {
    const root = tmp()
    const projectsDir = join(root, 'projects')
    for (const def of defs) {
      makeLiveTicket(root, projectsDir, def)
    }
    const cfgPath = makeFixtureConfig(root)
    let stderrOutput = ''
    const origErr = console.error
    const origLog = console.log
    console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
    console.log = () => {}
    let exitCode
    try {
      exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
        cwd: root,
        repoRoot: root,
        git: fakeGit,
        projectsRoot: projectsDir,
        now: () => new Date('2026-05-01T00:00:00.000Z'),
      })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    assert.equal(exitCode, 0)
    const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=([0-9a-f]+)）/)
    assert.ok(m, `實際 stderr：${stderrOutput}`)
    return { payload: JSON.parse(readFileSync(m[1], 'utf8')), inputHash: m[2] }
  }

  const forward = await buildAndRun(ticketDefs)
  const reversed = await buildAndRun([...ticketDefs].reverse())

  assert.equal(forward.inputHash, reversed.inputHash, '目錄建立順序相反，inputHash 仍應相同')
  assert.deepEqual(
    forward.payload.tickets.map((t) => t.ticket),
    ['tie1', 'tie2', 'tie3', 'tie4', 'tie5'],
    'payload.tickets 一律依票名排序，不受目錄列舉順序影響'
  )
  assert.deepEqual(
    reversed.payload.tickets.map((t) => t.ticket),
    ['tie1', 'tie2', 'tie3', 'tie4', 'tie5']
  )
})

test('1.8.0 ③ (Q5-b) 回歸：其他票只有 run-start（沒有 accepted／landed）⇒ 它的視窗不能被 last-event 補出來，不得污染重疊票的 apiCalls', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')
  const projectsDir = join(root, 'projects')

  // A：正常票，20 筆 assistant 記錄落在 hourIndex 0 的視窗內（run-start → accepted）
  makeLiveTicket(root, projectsDir, { ticket: 'qA', apiCalls: 20, hourIndex: 0 })

  // B：只有 run-start，沒有 accepted／landed（還在跑、還沒收尾的票）；run-start 落在 A 的視窗內，
  //   之後還有一個非 accepted/landed 的事件——舊版 loadOtherWindows 用 last-event 補視窗，
  //   會在 [B run-start, B 那個後續事件] 之間生出一個跟 A 重疊的假視窗，把 A 落在那段時間的
  //   assistant 記錄誤判成「被 B 夾走」（因為 B 的 runStartAt 比 A 晚）。
  const bDir = join(localDir, 'qB')
  mkdirSync(bDir, { recursive: true })
  const bRunStart = hourAt(0, 5)
  const bOtherEvent = hourAt(0, 15)
  const bLifecycle = [
    { at: bRunStart, event: 'run-start', ticket: 'qB', run: 1, sessionId: 'sess-qB' },
    { at: bOtherEvent, event: 'write-done', ticket: 'qB' },
  ]
  writeFileSync(join(bDir, 'lifecycle.ndjson'), bLifecycle.map((e) => JSON.stringify(e)).join('\n') + '\n')

  const config = JSON.parse(JSON.stringify(BASE_CONFIG))
  const live = await measureTicketLive('qA', localDir, config, root, { projectsRoot: projectsDir })

  assert.equal(live.measurable, true, `A 應可量測，實際：${JSON.stringify(live)}`)
  assert.equal(
    live.apiCalls,
    20,
    `A 的 apiCalls 不應被「只有 run-start」的 B 用 last-event 補出來的假視窗污染，實際：${live.apiCalls}`
  )
})

test('1.8.0 ③ (Q6) 陽性對照：--cohort 只帶 CLI 旗標 --projects-dir（不設 env、不注入 deps.projectsRoot）⇒ 量得到 apiCalls，不是 transcript-not-found', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q6-flag', apiCalls: 7, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  const savedEnv = process.env.LLM_TEAM_PROJECTS_ROOT
  delete process.env.LLM_TEAM_PROJECTS_ROOT

  let stdoutOutput = ''
  let stderrOutput = ''
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => { stdoutOutput += a.join(' ') + '\n' }
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain([
      '--cohort', 'tool',
      '--config', cfgPath,
      '--projects-dir', projectsDir,
      '--json',
    ], { cwd: root, repoRoot: root , git: fakeGit })
  } finally {
    console.log = origLog
    console.error = origErr
    if (savedEnv === undefined) delete process.env.LLM_TEAM_PROJECTS_ROOT
    else process.env.LLM_TEAM_PROJECTS_ROOT = savedEnv
  }

  assert.equal(exitCode, 0, `實際：${exitCode}，stderr：${stderrOutput}`)
  assert.ok(
    !stderrOutput.includes('transcript-not-found'),
    `不應出現 transcript-not-found（代表 --projects-dir 沒接到），實際 stderr：${stderrOutput}`
  )

  const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=/)
  assert.ok(m, `實際 stderr：${stderrOutput}`)
  const payload = JSON.parse(readFileSync(m[1], 'utf8'))
  const entry = payload.tickets.find((t) => t.ticket === 'q6-flag')
  assert.ok(entry, `payload.tickets 應含 q6-flag，實際：${JSON.stringify(payload.tickets)}`)
  assert.equal(entry.apiCalls, 7, `--projects-dir 應該讓 live 量測找到 transcript 並算出 apiCalls=7，實際：${entry.apiCalls}`)
})

// ── 21. sol block 複審第 4 輪修法（Q2／Q3）陽性對照 ──────────────────────────

test('1.8.0 ③ (Q2-a) 陽性對照：快照環境（有 MANIFEST.sha256）缺 SOURCE.json ⇒ --cohort fail-closed（exit 非 0，具名說缺 SOURCE.json）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q2a', apiCalls: 5, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  const fakeLlmTeamDir = tmp()
  writeFileSync(join(fakeLlmTeamDir, 'MANIFEST.sha256'), 'deadbeef  ticket.mjs\n')
  // 故意不寫 SOURCE.json

  let stderrOutput = ''
  const origErr = console.error
  const origLog = console.log
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  console.log = () => {}
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
      cwd: root,
      repoRoot: root,
      projectsRoot: projectsDir,
      llmTeamDir: fakeLlmTeamDir,
    })
  } finally {
    console.error = origErr
    console.log = origLog
  }

  assert.notEqual(exitCode, 0, `快照環境缺 SOURCE.json 應該 fail-closed（exit 非 0），實際：${exitCode}`)
  assert.match(stderrOutput, /缺 SOURCE\.json/, `stderr 應具名說缺 SOURCE.json，實際：${stderrOutput}`)
})

test('1.8.0 ③ (Q2-b) 陽性對照：快照環境的 SOURCE.json 損壞（壞 JSON）⇒ --cohort fail-closed（exit 非 0，具名說解析失敗）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q2b', apiCalls: 5, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  const fakeLlmTeamDir = tmp()
  writeFileSync(join(fakeLlmTeamDir, 'MANIFEST.sha256'), 'deadbeef  ticket.mjs\n')
  writeFileSync(join(fakeLlmTeamDir, 'SOURCE.json'), '{ 這不是合法 JSON')

  let stderrOutput = ''
  const origErr = console.error
  const origLog = console.log
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  console.log = () => {}
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
      cwd: root,
      repoRoot: root,
      projectsRoot: projectsDir,
      llmTeamDir: fakeLlmTeamDir,
    })
  } finally {
    console.error = origErr
    console.log = origLog
  }

  assert.notEqual(exitCode, 0, `快照環境 SOURCE.json 壞掉應該 fail-closed（exit 非 0），實際：${exitCode}`)
  assert.match(stderrOutput, /SOURCE\.json 解析失敗/, `stderr 應具名說解析失敗，實際：${stderrOutput}`)
})

test('1.8.0 ③ (Q2-c) 陽性對照：真源環境（沒有 MANIFEST.sha256，缺 SOURCE.json 是正常狀態）⇒ --cohort 正常、payload.sourceKind === "source-repo"', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q2c', apiCalls: 5, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  const fakeLlmTeamDir = tmp() // 既沒有 MANIFEST.sha256 也沒有 SOURCE.json，模擬真源環境
  writeFileSync(join(fakeLlmTeamDir, 'VERSION'), '9.9.9\n') // 第 5 輪 Q2：真源分支現在會嚴驗 version 非空字串，得真的給一份

  let stdoutOutput = ''
  let stderrOutput = ''
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => { stdoutOutput += a.join(' ') + '\n' }
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath, '--json'], {
      cwd: root,
      repoRoot: root,
      projectsRoot: projectsDir,
      llmTeamDir: fakeLlmTeamDir,
      git: fakeGit, // 第 5 輪 Q2：真源分支現在會嚴驗 sourceCommit 是 40 碼 hex、git 失敗會 fail-closed，root 不是真 repo 得注入
    })
  } finally {
    console.log = origLog
    console.error = origErr
  }

  assert.equal(exitCode, 0, `真源環境應正常，實際：${exitCode}，stderr：${stderrOutput}`)
  const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=/)
  assert.ok(m, `實際 stderr：${stderrOutput}`)
  const payload = JSON.parse(readFileSync(m[1], 'utf8'))
  assert.equal(payload.sourceKind, 'source-repo', `真源環境的 sourceKind 應為 source-repo，實際：${payload.sourceKind}`)
  assert.equal(payload.toolVersion, '9.9.9', `真源環境的 toolVersion 應取自 VERSION 檔，實際：${payload.toolVersion}`)
  assert.equal(payload.sourceCommit, FAKE_SOURCE_COMMIT, `真源環境的 sourceCommit 應取自 gitFn，實際：${payload.sourceCommit}`)
})

test('1.8.0 ③ (Q3-e) 陽性對照：recordsHash 雜湊的是完整 record（canonical 化，key 順序無關），不是只投影 usage 欄位——改一筆已採計 record 的非 usage 欄位（message.content）⇒ recordsHash／inputHash 都變；改一筆視窗外（未採計）record ⇒ 不變', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q3e', apiCalls: 3, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)
  const transcriptPath = join(projectsDir, 'proj', 'sess-q3e.jsonl')

  const runOnce = async (nowIso) => {
    let stderrOutput = ''
    const origErr = console.error
    const origLog = console.log
    console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
    console.log = () => {}
    let exitCode
    try {
      exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
        cwd: root,
        repoRoot: root,
        git: fakeGit,
        projectsRoot: projectsDir,
        now: () => new Date(nowIso),
      })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    assert.equal(exitCode, 0)
    const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=([0-9a-f]+)）/)
    assert.ok(m, `實際 stderr：${stderrOutput}`)
    const payload = JSON.parse(readFileSync(m[1], 'utf8'))
    const entry = payload.tickets.find((t) => t.ticket === 'q3e')
    return { inputHash: m[2], recordsHash: entry.recordsHash }
  }

  const before = await runOnce('2026-06-01T00:00:00.000Z')

  // 改一筆「已採計」record 的非 usage 欄位（message.content）：3 筆 assistant 記錄的第 1 筆（offset 1，在視窗內）。
  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 3, `fixture 應有 3 筆記錄，實際：${lines.length}`)
  lines[0].message.content = 'mutated content, usage 數字完全沒變'
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const afterContentMutation = await runOnce('2026-06-02T00:00:00.000Z')
  assert.notEqual(
    before.recordsHash,
    afterContentMutation.recordsHash,
    'recordsHash 應該因為已採計 record 的 message.content 改變而改變（不是只雜湊 usage 投影）'
  )
  assert.notEqual(before.inputHash, afterContentMutation.inputHash, 'inputHash 也應該跟著變')

  // 改一筆「視窗外」（未採計）的 record：加一筆時間戳記遠在視窗之後的 assistant 記錄。
  const linesAfterMutation = readFileSync(transcriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  linesAfterMutation.push({
    type: 'assistant',
    timestamp: hourAt(0, 999), // 遠超出 apiCalls=3 的視窗（視窗到 hourAt(0, 3+5)=8），不會被採計
    message: { usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } },
  })
  writeFileSync(transcriptPath, linesAfterMutation.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const afterOutOfWindow = await runOnce('2026-06-03T00:00:00.000Z')
  assert.equal(
    afterOutOfWindow.recordsHash,
    afterContentMutation.recordsHash,
    '加一筆視窗外（未採計）的 record 不應改變 recordsHash'
  )
  assert.equal(afterOutOfWindow.inputHash, afterContentMutation.inputHash, '也不應改變 inputHash')
})

// ── 22. sol block 複審第 5 輪修法（Q2）陽性對照 ────────────────────────────

test('1.8.0 ③ (Q2-d) 陽性對照：快照環境 SOURCE.json 是 `{}`（合法 JSON，但 version／sourceCommit 兩個欄位都缺）⇒ --cohort fail-closed（exit 非 0，具名說 version）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q2d', apiCalls: 5, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  const fakeLlmTeamDir = tmp()
  writeFileSync(join(fakeLlmTeamDir, 'MANIFEST.sha256'), 'deadbeef  ticket.mjs\n')
  writeFileSync(join(fakeLlmTeamDir, 'SOURCE.json'), '{}\n') // 合法 JSON，但兩個欄位都缺——第 4 輪的「解析失敗」判準擋不住這種

  let stderrOutput = ''
  const origErr = console.error
  const origLog = console.log
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  console.log = () => {}
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
      cwd: root,
      repoRoot: root,
      projectsRoot: projectsDir,
      llmTeamDir: fakeLlmTeamDir,
    })
  } finally {
    console.error = origErr
    console.log = origLog
  }

  assert.notEqual(exitCode, 0, `SOURCE.json 為 {} 應該 fail-closed（exit 非 0），實際：${exitCode}`)
  assert.match(stderrOutput, /version/, `stderr 應具名說 version 欄位不合法，實際：${stderrOutput}`)
})

test('1.8.0 ③ (Q2-e) 陽性對照：快照環境 SOURCE.json 的 sourceCommit 是 "abc"（非 40 碼 hex）⇒ --cohort fail-closed（exit 非 0，具名說 sourceCommit）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q2e', apiCalls: 5, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  const fakeLlmTeamDir = tmp()
  writeFileSync(join(fakeLlmTeamDir, 'MANIFEST.sha256'), 'deadbeef  ticket.mjs\n')
  writeFileSync(join(fakeLlmTeamDir, 'SOURCE.json'), JSON.stringify({ version: '1.8.0', sourceCommit: 'abc' }) + '\n')

  let stderrOutput = ''
  const origErr = console.error
  const origLog = console.log
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  console.log = () => {}
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
      cwd: root,
      repoRoot: root,
      projectsRoot: projectsDir,
      llmTeamDir: fakeLlmTeamDir,
    })
  } finally {
    console.error = origErr
    console.log = origLog
  }

  assert.notEqual(exitCode, 0, `sourceCommit 非 40 碼 hex 應該 fail-closed（exit 非 0），實際：${exitCode}`)
  assert.match(stderrOutput, /sourceCommit/, `stderr 應具名說 sourceCommit 欄位不合法，實際：${stderrOutput}`)
})

test('1.8.0 ③ (Q2-f) 陽性對照：真源環境 gitFn（rev-parse HEAD）丟例外 ⇒ --cohort fail-closed（exit 非 0），不再被 catch 吞成 null 照樣放行', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q2f', apiCalls: 5, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  const fakeLlmTeamDir = tmp() // 沒有 MANIFEST.sha256 也沒有 SOURCE.json，模擬真源環境
  writeFileSync(join(fakeLlmTeamDir, 'VERSION'), '9.9.9\n')
  const throwingGit = () => { throw new Error('git rev-parse HEAD 失敗（模擬：不是 git repo）') }

  let stderrOutput = ''
  const origErr = console.error
  const origLog = console.log
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  console.log = () => {}
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
      cwd: root,
      repoRoot: root,
      projectsRoot: projectsDir,
      llmTeamDir: fakeLlmTeamDir,
      git: throwingGit,
    })
  } finally {
    console.error = origErr
    console.log = origLog
  }

  assert.notEqual(exitCode, 0, `git rev-parse HEAD 失敗應該 fail-closed（exit 非 0），實際：${exitCode}`)
  assert.match(stderrOutput, /git rev-parse HEAD 失敗/, `stderr 應具名說 git rev-parse HEAD 失敗，實際：${stderrOutput}`)
})

// ── 23. sol block 複審第 7 輪修法（Q2）陽性對照 ────────────────────────────

test('1.8.0 ③ (Q7-a) 陽性對照：summary.json 的 ticket 與所在目錄名不一致 ⇒ --cohort fail-closed（exit 非 0，stderr 含「不一致」，_cohort 沒有新 JSON）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q7a', apiCalls: 5, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  // 故意把 summary.json 的 ticket 欄位改成跟目錄名（q7a）不一樣的值。
  const summaryPath = join(root, '.local/llm-team', 'q7a', 'summary.json')
  const s = JSON.parse(readFileSync(summaryPath, 'utf8'))
  s.ticket = 'q7a-typo'
  writeFileSync(summaryPath, JSON.stringify(s, null, 2))

  const cohortDir = join(root, '.local/llm-team', '_cohort')
  assert.ok(!existsSync(cohortDir), '跑之前不該有 _cohort 目錄')

  let stderrOutput = ''
  const origErr = console.error
  const origLog = console.log
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  console.log = () => {}
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
      cwd: root,
      repoRoot: root,
      projectsRoot: projectsDir,
      git: fakeGit,
    })
  } finally {
    console.error = origErr
    console.log = origLog
  }

  assert.notEqual(exitCode, 0, `目錄名／ticket 不一致應該 fail-closed（exit 非 0），實際：${exitCode}`)
  assert.match(stderrOutput, /不一致/, `stderr 應具名說不一致，實際：${stderrOutput}`)
  assert.ok(!existsSync(cohortDir), '不一致時不應產出任何 _cohort JSON')
})

test('1.8.0 ③ (Q7-b) 陽性對照：summary.json 的 ticket 是空字串 ⇒ --cohort fail-closed（exit 非 0）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q7b', apiCalls: 5, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  const summaryPath = join(root, '.local/llm-team', 'q7b', 'summary.json')
  const s = JSON.parse(readFileSync(summaryPath, 'utf8'))
  s.ticket = ''
  writeFileSync(summaryPath, JSON.stringify(s, null, 2))

  const cohortDir = join(root, '.local/llm-team', '_cohort')

  let stderrOutput = ''
  const origErr = console.error
  const origLog = console.log
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  console.log = () => {}
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
      cwd: root,
      repoRoot: root,
      projectsRoot: projectsDir,
      git: fakeGit,
    })
  } finally {
    console.error = origErr
    console.log = origLog
  }

  assert.notEqual(exitCode, 0, `ticket 為空字串應該 fail-closed（exit 非 0），實際：${exitCode}`)
  assert.match(stderrOutput, /不一致/, `stderr 應具名說不一致，實際：${stderrOutput}`)
  assert.ok(!existsSync(cohortDir), '空字串 ticket 時不應產出任何 _cohort JSON')
})

// ── 24. sol block 複審第 8 輪修法（Q2／Q3／Q5）陽性對照 ────────────────────

test('1.8.0 ③ (Q8-a) 陽性對照：某票 summary.json 是非法 JSON（不是缺檔，是壞檔）⇒ --cohort fail-closed（exit 非 0，stderr 含「解析失敗」，_cohort 沒有新 JSON）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q8a-ok', apiCalls: 5, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)

  // 另一票的 summary.json 寫成非法 JSON（不是「沒有 summary.json」，是「有檔但壞掉」）。
  write(join(root, '.local/llm-team'), 'q8a-broken/summary.json', '{not json')

  const cohortDir = join(root, '.local/llm-team', '_cohort')
  assert.ok(!existsSync(cohortDir), '跑之前不該有 _cohort 目錄')

  let stderrOutput = ''
  const origErr = console.error
  const origLog = console.log
  console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
  console.log = () => {}
  let exitCode
  try {
    exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
      cwd: root,
      repoRoot: root,
      projectsRoot: projectsDir,
      git: fakeGit,
    })
  } finally {
    console.error = origErr
    console.log = origLog
  }

  assert.notEqual(exitCode, 0, `壞 summary.json 應該 fail-closed（exit 非 0），實際：${exitCode}`)
  assert.match(stderrOutput, /解析失敗/, `stderr 應具名說解析失敗，實際：${stderrOutput}`)
  assert.ok(!existsSync(cohortDir), '壞 summary.json 存在時不應產出任何 _cohort JSON')
})

// 遞迴把物件的 key 順序反過來重建（值不變），用來證明 canonicalStringify 化後雜湊跟寫入者的 key 順序無關。
function shuffleKeysDeep(v) {
  if (Array.isArray(v)) return v.map(shuffleKeysDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).reverse()) out[k] = shuffleKeysDeep(v[k])
    return out
  }
  return v
}

test('1.8.0 ③ (Q8-b) 陽性對照：同一批 transcript record 的 key 順序打亂（遞迴，含巢狀 usage 物件）重寫 ⇒ recordsHash／inputHash／verdict 全部相同', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q8b', apiCalls: 3, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)
  const transcriptPath = join(projectsDir, 'proj', 'sess-q8b.jsonl')

  const runOnce = async (nowIso) => {
    let stderrOutput = ''
    const origErr = console.error
    const origLog = console.log
    console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
    console.log = () => {}
    let exitCode
    try {
      exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
        cwd: root,
        repoRoot: root,
        git: fakeGit,
        projectsRoot: projectsDir,
        now: () => new Date(nowIso),
      })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    assert.equal(exitCode, 0, `實際：${exitCode}，stderr：${stderrOutput}`)
    const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=([0-9a-f]+)）/)
    assert.ok(m, `實際 stderr：${stderrOutput}`)
    const payload = JSON.parse(readFileSync(m[1], 'utf8'))
    const entry = payload.tickets.find((t) => t.ticket === 'q8b')
    return { inputHash: m[2], recordsHash: entry.recordsHash, verdict: payload.verdict }
  }

  const before = await runOnce('2026-07-01T00:00:00.000Z')

  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 3, `fixture 應有 3 筆記錄，實際：${lines.length}`)
  const shuffled = lines.map(shuffleKeysDeep)
  writeFileSync(transcriptPath, shuffled.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const after = await runOnce('2026-07-02T00:00:00.000Z')

  assert.equal(after.recordsHash, before.recordsHash, 'key 順序打亂不應改變 recordsHash（canonical 化後 key 順序無關）')
  assert.equal(after.inputHash, before.inputHash, 'key 順序打亂不應改變 inputHash')
  assert.equal(after.verdict, before.verdict, 'key 順序打亂不應改變 verdict')
})

test('1.8.0 ③ (Q8-c) 陽性對照：key 順序不變、只改一筆已採計 record 的數值（usage.output_tokens）⇒ recordsHash／inputHash 都變（避免 canonicalize 寫成只看 key、不看值）', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q8c', apiCalls: 3, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)
  const transcriptPath = join(projectsDir, 'proj', 'sess-q8c.jsonl')

  const runOnce = async (nowIso) => {
    let stderrOutput = ''
    const origErr = console.error
    const origLog = console.log
    console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
    console.log = () => {}
    let exitCode
    try {
      exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
        cwd: root,
        repoRoot: root,
        git: fakeGit,
        projectsRoot: projectsDir,
        now: () => new Date(nowIso),
      })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    assert.equal(exitCode, 0, `實際：${exitCode}，stderr：${stderrOutput}`)
    const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=([0-9a-f]+)）/)
    assert.ok(m, `實際 stderr：${stderrOutput}`)
    const payload = JSON.parse(readFileSync(m[1], 'utf8'))
    const entry = payload.tickets.find((t) => t.ticket === 'q8c')
    return { inputHash: m[2], recordsHash: entry.recordsHash }
  }

  const before = await runOnce('2026-07-01T00:00:00.000Z')

  // 原地改值，不動 key 順序：只把第 1 筆的 usage.output_tokens 從 5 改成 6。
  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 3, `fixture 應有 3 筆記錄，實際：${lines.length}`)
  assert.equal(lines[0].message.usage.output_tokens, 5, `fixture 的 output_tokens 應為 5，實際：${lines[0].message.usage.output_tokens}`)
  lines[0].message.usage.output_tokens = 6
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const after = await runOnce('2026-07-02T00:00:00.000Z')

  assert.notEqual(after.recordsHash, before.recordsHash, 'key 順序沒變但值變了，recordsHash 應該變（不是只看 key）')
  assert.notEqual(after.inputHash, before.inputHash, 'inputHash 也應該跟著變')
})

// ── 25. sol block 複審第 9 輪修法（Q2）陽性對照 ────────────────────────────

test('1.8.0 ③ (Q9-a) 陽性對照：canonicalStringify 對合法帶 __proto__ key 的 JSON 不吞掉它（Object.create(null) 重建，避免被當成原型 setter）', () => {
  const v1 = JSON.parse('{"a":1,"__proto__":{"x":1}}')
  const s1 = canonicalStringify(v1)
  assert.match(s1, /"__proto__"/, `canonical 字串應含 "__proto__" 這個 key，實際：${s1}`)

  const v2 = JSON.parse('{"a":1,"__proto__":{"x":2}}')
  const s2 = canonicalStringify(v2)
  assert.notEqual(s2, s1, '__proto__ 底下的值改了（x:1→x:2），canonical 字串應該跟著變')
})

test('1.8.0 ③ (Q9-b) 陽性對照：走真的 --cohort production 路徑——某票 transcript 一筆已採計 record 巢狀加 __proto__（key 序不動），值再改一次 ⇒ recordsHash／inputHash 都變', async () => {
  const root = tmp()
  const projectsDir = join(root, 'projects')
  makeLiveTicket(root, projectsDir, { ticket: 'q9b', apiCalls: 3, hourIndex: 0 })
  const cfgPath = makeFixtureConfig(root)
  const transcriptPath = join(projectsDir, 'proj', 'sess-q9b.jsonl')

  const runOnce = async (nowIso) => {
    let stderrOutput = ''
    const origErr = console.error
    const origLog = console.log
    console.error = (...a) => { stderrOutput += a.join(' ') + '\n' }
    console.log = () => {}
    let exitCode
    try {
      exitCode = await cliMain(['--cohort', 'tool', '--config', cfgPath], {
        cwd: root,
        repoRoot: root,
        git: fakeGit,
        projectsRoot: projectsDir,
        now: () => new Date(nowIso),
      })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    assert.equal(exitCode, 0, `實際：${exitCode}，stderr：${stderrOutput}`)
    const m = stderrOutput.match(/已輸出 cohort JSON：(\S+)（inputHash=([0-9a-f]+)）/)
    assert.ok(m, `實際 stderr：${stderrOutput}`)
    const payload = JSON.parse(readFileSync(m[1], 'utf8'))
    const entry = payload.tickets.find((t) => t.ticket === 'q9b')
    return { inputHash: m[2], recordsHash: entry.recordsHash }
  }

  // 基準（第一次）：第 1 筆已採計 record 巢狀加一個合法的 __proto__ key（不是重排既有 key，是新加一個 key）。
  // 🔴 注意：不能用 `obj.__proto__ = {...}` 賦值——那會觸發原型 setter、真的改掉 obj 的原型，JSON.stringify
  //   根本不會把它序列化出來（跟這張票要驗的「JSON 文字裡合法帶 __proto__ key」是兩回事）。要用
  //   Object.defineProperty 建立真正的「自有屬性」，才會跟 JSON.parse 讀回真實 transcript 時的形狀一致。
  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 3, `fixture 應有 3 筆記錄，實際：${lines.length}`)
  Object.defineProperty(lines[0].message, '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true })
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const before = await runOnce('2026-08-01T00:00:00.000Z')

  // 只改 __proto__ 底下的值（x:1→x:2），key 序不動。
  const linesAgain = readFileSync(transcriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(linesAgain[0].message.__proto__, { x: 1 }, `寫回並重讀的 __proto__ 值應為 {x:1}，實際：${JSON.stringify(linesAgain[0].message.__proto__)}`)
  Object.defineProperty(linesAgain[0].message, '__proto__', { value: { x: 2 }, enumerable: true, configurable: true, writable: true })
  writeFileSync(transcriptPath, linesAgain.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const after = await runOnce('2026-08-02T00:00:00.000Z')

  assert.notEqual(after.recordsHash, before.recordsHash, '__proto__ 底下的值變了，recordsHash 應該跟著變（不是被當成原型 setter 吞掉）')
  assert.notEqual(after.inputHash, before.inputHash, 'inputHash 也應該跟著變')
})
