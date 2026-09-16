/**
 * `home/skills/llm-team/usage.mjs` 的自證測試。
 *
 * 🔴 硬規則：所有寫入都在 mkdtemp 的暫存區，清理用 rmSync；
 *    所有測試使用 node:test，不引入第三方套件。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, createReadStream } from 'node:fs'
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
} from './usage.mjs'

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

test('--cohort tool --json：對 tmp localDir（15 個子目錄各一份 summary.json）⇒ exit 0、stdout 解析後 windows[0].median===19；同 localDir --cohort docs（無合格票）⇒ exit 0、stdout 含「基線未滿 0/5」；不需要 --ticket；壞 JSON 的 summary.json 被略過且 stderr 印一行', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')

  COHORT_15_VALUES.forEach((apiCalls, i) => {
    const ticket = `ct${i + 1}`
    const summary = makeCohortSummary({
      ticket,
      apiCalls,
      run: i < 8 ? undefined : 1,
      from: isoAt(i),
    })
    write(localDir, `${ticket}/summary.json`, JSON.stringify(summary, null, 2) + '\n')
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
    ], { cwd: root, repoRoot: root })
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
    ], { cwd: root, repoRoot: root })
  } finally {
    console.log = origLog
  }
  assert.equal(exitCode2, 0, `--cohort docs（無合格票）應 exit 0，實際：${exitCode2}`)
  assert.match(stdoutOutput2, /基線未滿 0\/5/, `stdout 應含「基線未滿 0/5」，實際：${stdoutOutput2}`)

  // 壞 JSON 的 summary.json 略過且 stderr 印一行；同時證明 --cohort 不需要 --ticket（前面兩次呼叫都沒帶 --ticket 也沒觸發缺少必填的 exit 2）
  write(localDir, 'broken-ticket/summary.json', '{ 這不是合法 JSON')
  let stderrOutput = ''
  const origError = console.error
  console.error = (...args) => { stderrOutput += args.join(' ') + '\n' }
  let exitCode3
  try {
    exitCode3 = await cliMain([
      '--cohort', 'tool',
      '--config', cfgPath,
    ], { cwd: root, repoRoot: root })
  } finally {
    console.error = origError
  }
  assert.equal(exitCode3, 0, `壞 JSON 存在時 --cohort（無 --ticket）仍應 exit 0，實際：${exitCode3}`)
  assert.match(stderrOutput, /略過壞 summary\.json/, `stderr 應印略過壞 summary.json 的訊息，實際：${stderrOutput}`)
})

test('--cohort (n)：localDir 有一個空子目錄（沒有 summary.json）⇒ exit 0、stderr 含「沒有 summary.json」，且該目錄不出現在任何 tickets 名單', async () => {
  const root = tmp()
  const localDir = join(root, '.local/llm-team')

  COHORT_15_VALUES.forEach((apiCalls, i) => {
    const ticket = `nt${i + 1}`
    const summary = makeCohortSummary({
      ticket,
      apiCalls,
      run: i < 8 ? undefined : 1,
      from: isoAt(i),
    })
    write(localDir, `${ticket}/summary.json`, JSON.stringify(summary, null, 2) + '\n')
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
    ], { cwd: root, repoRoot: root })
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

  COHORT_15_VALUES.forEach((apiCalls, i) => {
    const ticket = `ct${i + 1}`
    const summary = makeCohortSummary({
      ticket,
      apiCalls,
      run: i < 8 ? undefined : 1,
      from: isoAt(i),
    })
    write(localDir, `${ticket}/summary.json`, JSON.stringify(summary, null, 2) + '\n')
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
    ], { cwd: root, repoRoot: root })
  } finally {
    console.log = origLog
  }

  assert.equal(exitCode, 0, `--cohort tool（非 --json）應 exit 0，實際：${exitCode}`)
  const expected =
    '窗 1：票 ct6,ct7,ct8,ct9,ct10,ct11,ct12,ct13,ct14,ct15；中位數 19（基線 48，降 60.4%）；重工率 0/7（3 張無 run 欄位）（基線 0/0（5 張無 run 欄位））；判定 🟡 provisional\n' +
    '重工率不可比：缺 run 欄位\n'
  assert.equal(stdoutOutput, expected, `stdout 應逐字等於預期兩行，實際：${JSON.stringify(stdoutOutput)}`)
})
