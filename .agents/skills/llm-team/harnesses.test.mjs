// ─────────────────── harnesses/ registry 與各 harness 模組的測試（1.15.0） ───────────────────
// 🔴 不打任何真 binary、不碰真 Keychain：spawn／resolveKey 一律注入假的；假 key 一律用字面 'test-key'。
// 🔴 本檔第一個 import 故意是 harnesses/index.mjs（不是 lib.mjs）：lib.mjs ⇄ harnesses/<name>.mjs 互相 import，
//    兩種進入順序都要能載入（llm-team.test.mjs 先 import lib.mjs；本檔先 import index.mjs；⑩ 另用子行程各證一次）。
import { registry, getHarness, hasHarness, HARNESSES, WRITER_HARNESSES, REVIEWER_HARNESSES, COORDINATOR_HARNESSES, QUOTA_BUCKETS, isTranscriptMeasurable } from './harnesses/index.mjs'
import { assertHarnessContract, classifyFailure, probeBinary } from './harnesses/_contract.mjs'
import * as agyModule from './harnesses/agy.mjs'
import * as codexModule from './harnesses/codex.mjs'
import * as geminiModule from './harnesses/gemini.mjs'
import * as lib from './lib.mjs'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { main as councilMain } from './council.mjs'
import { main as writeMain } from './write.mjs'
import { main as setupMain } from './setup.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { CLEAN_GIT_ENV, NO_EXEC_HEADER, buildSafeCommandRegex } = lib

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ─────────────────── fixture（跟 llm-team.test.mjs 同款，這裡只留用到的） ───────────────────
const M = {
  agyGemini: { harness: 'agy', model: 'gemini-3.1-pro-high', quotaBucket: 'gemini' },
  codexSol: { harness: 'codex', model: 'gpt-5.6-sol', quotaBucket: 'openai' },
  claudeCode: { harness: 'claude', model: 'claude-code', quotaBucket: 'anthropic' },
  geminiPro: { harness: 'gemini', model: 'gemini-2.5-pro', quotaBucket: 'gemini-api' },
}

function v2Config({ reviewers = [M.agyGemini], coordinator = M.claudeCode, profileName = 'claude' } = {}) {
  return {
    schemaVersion: 2,
    writer: { harness: 'agy', model: 'gemini-3.8-flash-high', quotaBucket: 'gemini' },
    profiles: {
      [profileName]: { coordinator, reviewers, blockReviewers: reviewers, adjudicator: 'human', blockAdjudicator: 'human' },
    },
    allowCommandHeads: ['npm test'],
    worktreeRoot: '.claude/worktrees',
    installCommand: '',
    maxRounds: 3,
    riskDomains: [],
    outDir: '.local/llm-team',
  }
}

function makeRepo(cfg) {
  const dir = tmpdir('harness-test-')
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'add.mjs'), 'export function add(a, b) { return a + b }\n')
  fs.writeFileSync(path.join(dir, 'llm-team.config.json'), JSON.stringify(cfg, null, 2))
  g('add', '-A')
  g('commit', '-qm', 'init')
  g('checkout', '-qb', 'feat/x')
  return { dir, g }
}

/** 🔴 讓「假 harness 被繞過」必紅：所有 bin 指到不存在的路徑，PATH 也是空的——真 harness 一 spawn 就 ENOENT。 */
const NO_BIN_ENV = { PATH: '/nonexistent', AGY_BIN: '/nonexistent/agy', CODEX_BIN: '/nonexistent/codex', GEMINI_BIN: '/nonexistent/gemini', CLAUDE_BIN: '/nonexistent/claude', HOME: os.tmpdir() }

const UNIFIED_REVIEW_KEYS = ['exit', 'signal', 'timedOut', 'stdout', 'stderr', 'text', 'denied', 'usage', 'failure', 'raw'].sort()
const UNIFIED_WRITE_KEYS = [...UNIFIED_REVIEW_KEYS, 'steps', 'conversationId'].sort()

const agyStdout = ({ response = '整份：簽', conversationId = 'conv-1', usage = { total_tokens: 10 }, denied = [] } = {}) =>
  [
    JSON.stringify({ event: 'init', conversation_id: conversationId }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: conversationId, response, usage, denied_actions: denied } }),
  ].join('\n') + '\n'

const okSpawn = (stdout) => ({ status: 0, signal: null, timedOut: false, stdout, stderr: '' })

/** 每個 canReview harness 一組「假 spawn 回什麼 ⇒ 舊欄位在哪」的對照表（④／⑨ 共用）。 */
const REVIEW_CASES = [
  { name: 'agy', env: { AGY_BIN: '/fake/agy', PATH: '/x' }, goodStdout: agyStdout(), expectText: '整份：簽', legacyText: (raw) => raw.result.response, expectUsage: { total_tokens: 10 }, protocolStdout: 'not stream-json at all\n' },
  { name: 'codex', env: { CODEX_BIN: '/fake/codex', PATH: '/x' }, goodStdout: '整份：簽', expectText: '整份：簽', legacyText: (raw) => raw.stdout, expectUsage: null, protocolStdout: null },
  { name: 'gemini', env: { GEMINI_BIN: '/fake/gemini', PATH: '/x' }, goodStdout: JSON.stringify({ response: '整份：簽', stats: { tokens: 7 } }), expectText: '整份：簽', legacyText: (raw) => raw.response, expectUsage: { tokens: 7 }, protocolStdout: '純文字，不是 JSON' },
  // 1.22.0：claude 也是複審席（隔離上下文）。stdout 形狀取自 2026-10-03 真跑 `claude -p --output-format json`。
  { name: 'claude', env: { CLAUDE_BIN: '/fake/claude', PATH: '/x' }, goodStdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '整份：簽', usage: { output_tokens: 5 }, permission_denials: [], api_error_status: null }), expectText: '整份：簽', legacyText: (raw) => raw.json.result, expectUsage: { output_tokens: 5 }, protocolStdout: '純文字，不是 JSON' },
]

describe('① registry 每個成員通過 assertHarnessContract；缺欄位的假 harness 被拒且訊息列出缺的欄', () => {
  test('registry 四個成員都通過；名字＝registry 鍵', () => {
    for (const [name, h] of registry) {
      assert.equal(assertHarnessContract(h), true, name)
      assert.equal(h.name, name)
    }
  })
  test('陽性對照：{name:"agy"} 缺一堆 ⇒ throw，訊息點名 quotaBuckets／canReview／transcriptMeasurable／resolveBin／checkBinary', () => {
    assert.throws(() => assertHarnessContract({ name: 'agy' }), (e) => {
      for (const k of ['quotaBuckets', 'canReview', 'transcriptMeasurable', 'resolveBin', 'checkBinary']) assert.match(e.message, new RegExp(k), e.message)
      return true
    })
  })
  test('陽性對照：canReview:true 但沒 review ⇒ 拒；canWrite:true 但 write 缺 resume ⇒ 拒；canReview:false 沒 review ⇒ 過', () => {
    const base = { name: 'codex', quotaBuckets: ['openai'], canCoordinate: true, canReview: false, canWrite: false, transcriptMeasurable: false, resolveBin: () => 'x', checkBinary: () => null }
    assert.equal(assertHarnessContract(base), true)
    assert.throws(() => assertHarnessContract({ ...base, canReview: true }), /canReview 但缺 review/)
    assert.throws(
      () => assertHarnessContract({ ...base, canWrite: true, write: { run() {}, normalize() {}, lastStepIsToolError() {} } }),
      /缺 write\.resume/
    )
    assert.throws(() => assertHarnessContract({ ...base, name: 'nope' }), /name 必須是/)
    assert.throws(() => assertHarnessContract({ ...base, quotaBuckets: [] }), /quotaBuckets/)
  })
  // 🔴 1.16.0（票 llm-team-gemini-writer）：gemini 的 canWrite 由 false 翻 true——這條與 ② 的 WRITER_HARNESSES 是同一個事實
  //    （lib.mjs 那道閘的停止條件本來就寫「某個 harness 真的長出 write 介面那天，在它的模組把 canWrite 翻成 true」），
  //    所以這裡 [false, true, false, false] ⇒ [false, true, true, false] 是本票改動既有斷言的第二處（第一處 ②，統整者指名）。
  test('各 harness 的能力旗標：agy 三種都能；codex 統整＋複審；gemini 複審＋寫手（1.16.0）；claude 統整＋複審（1.22.0；且只有它 transcriptMeasurable）', () => {
    const flags = (n) => {
      const h = getHarness(n)
      return [h.canCoordinate, h.canReview, h.canWrite, h.transcriptMeasurable]
    }
    assert.deepEqual(flags('agy'), [true, true, true, false])
    assert.deepEqual(flags('codex'), [true, true, false, false])
    assert.deepEqual(flags('gemini'), [false, true, true, false])
    assert.deepEqual(flags('claude'), [true, true, false, true], '1.22.0：claude 也能複審（隔離上下文）')
    assert.deepEqual(getHarness('agy').quotaBuckets, ['gemini', 'agy-claude'])
    assert.deepEqual(getHarness('codex').quotaBuckets, ['openai'])
    assert.deepEqual(getHarness('gemini').quotaBuckets, ['gemini-api'])
    assert.deepEqual(getHarness('claude').quotaBuckets, ['anthropic'])
    assert.equal(getHarness('agy').hook, 'agy-pretooluse.sh')
    assert.equal(getHarness('codex').hook, 'codex-pretooluse.sh')
    assert.ok(fs.existsSync(path.join(HERE, getHarness('agy').hook)), 'hook 檔要真的存在')
    assert.ok(fs.existsSync(path.join(HERE, getHarness('codex').hook)), 'hook 檔要真的存在')
  })
})

describe('② HARNESSES／WRITER_HARNESSES／QUOTA_BUCKETS 精確等於重構前（1.14.0）字面；⑪ 1.16.0 WRITER_HARNESSES ＝ agy,gemini', () => {
  // 🔴 ⑪（1.16.0 票 llm-team-gemini-writer，統整者指名「本票唯一准改的既有斷言」）：WRITER_HARNESSES 由 registry 的 canWrite 推導，
  //    gemini 長出 write 介面 ⇒ ['agy'] 變 ['agy', 'gemini']（registry 插入順序，agy 仍在前＝寫手鏈預設第 0 席）。
  //    HARNESSES／QUOTA_BUCKETS／REVIEWER／COORDINATOR 四條字面不變。
  test('index.mjs 的值', () => {
    assert.deepEqual(HARNESSES, ['agy', 'codex', 'claude', 'gemini'])
    assert.deepEqual(WRITER_HARNESSES, ['agy', 'gemini'])
    assert.deepEqual(QUOTA_BUCKETS, ['anthropic', 'gemini', 'agy-claude', 'openai', 'gemini-api'])
    assert.deepEqual(REVIEWER_HARNESSES, ['agy', 'codex', 'claude', 'gemini'], '1.22.0：claude 也是複審 harness')
    assert.deepEqual(COORDINATOR_HARNESSES, ['agy', 'codex', 'claude'])
  })
  test('lib.mjs re-export 的是同一個陣列（既有 import { HARNESSES } from lib.mjs 照常）', () => {
    assert.equal(lib.HARNESSES, HARNESSES)
    assert.equal(lib.WRITER_HARNESSES, WRITER_HARNESSES)
    assert.equal(lib.QUOTA_BUCKETS, QUOTA_BUCKETS)
  })
  test('config 錯誤訊息仍印 1.14.0 的順序 agy|codex|claude|gemini', () => {
    assert.throws(
      () => lib.validateProfiles(v2Config({ reviewers: [{ harness: 'nope', model: 'm', quotaBucket: 'openai' }] })),
      /只准 agy\|codex\|claude\|gemini/
    )
  })
})

describe('③ getHarness 未知名字 ⇒ throw 含准許清單；hasHarness／isTranscriptMeasurable 不 throw', () => {
  test('getHarness("nope")', () => {
    assert.throws(() => getHarness('nope'), /未知 harness "nope"，只准 agy\|codex\|claude\|gemini/)
    assert.throws(() => getHarness(undefined), /只准 agy\|codex\|claude\|gemini/)
  })
  test('hasHarness／isTranscriptMeasurable', () => {
    assert.equal(hasHarness('agy'), true)
    assert.equal(hasHarness('nope'), false)
    assert.equal(isTranscriptMeasurable('claude'), true)
    for (const n of ['agy', 'codex', 'gemini', 'nope', undefined]) assert.equal(isTranscriptMeasurable(n), false, String(n))
  })
})

describe('④ 每個 canReview harness：假 spawn 跑 review.run／runSync 回統一形狀；text 對應舊欄位', () => {
  for (const c of REVIEW_CASES) {
    test(`${c.name}：run（非同步）`, async () => {
      let captured = null
      const fakeSpawn = async (bin, args, opts) => {
        captured = { bin, args, opts }
        return okSpawn(c.goodStdout)
      }
      const h = getHarness(c.name)
      const r = await h.review.run({ model: 'm', prompt: 'P', cwd: process.cwd(), timeoutMs: 1000, env: c.env, spawn: fakeSpawn, resolveKey: () => 'test-key' })
      assert.deepEqual(Object.keys(r).sort(), UNIFIED_REVIEW_KEYS)
      assert.equal(r.text, c.expectText)
      assert.equal(r.text, c.legacyText(r.raw), 'text 要等於舊欄位（codex⇒stdout、agy⇒result.response、gemini⇒response）')
      assert.deepEqual(r.usage, c.expectUsage)
      assert.equal(r.exit, 0)
      assert.equal(r.timedOut, false)
      assert.deepEqual(r.denied, [])
      assert.equal(r.failure, null)
      assert.equal(r.stdout, c.goodStdout)
      assert.ok(!('keyMissing' in r), '統一層沒有 keyMissing 欄')
      assert.ok(captured, 'spawn 要被呼叫')
      if (c.name === 'codex') {
        assert.ok(!captured.args.at(-1).startsWith(NO_EXEC_HEADER), 'codex 不加 NO_EXEC_HEADER')
        assert.ok(captured.args.includes('model_reasoning_effort="high"'), 'effort 預設 high')
      }
      if (c.name === 'agy') {
        assert.ok(captured.args.includes('plan'), 'agy 複審走 --mode plan')
        assert.ok(captured.opts.input.includes(JSON.stringify(NO_EXEC_HEADER + 'P').slice(1, -1)), 'agy 提示以 NO_EXEC_HEADER 開頭（走 stdin）')
      }
      if (c.name === 'claude') {
        assert.deepEqual(captured.args, ['-p', '--model', 'm', '--output-format', 'json', '--no-session-persistence', '--setting-sources', 'project', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk'], 'claude：argv 精確（唯讀工具、不留 session、不載使用者層 settings/hook）')
        assert.equal(captured.opts.input, 'P', 'claude：prompt 走 stdin、逐字')
        assert.ok(!captured.args.includes('P'), 'claude：prompt 不在 argv')
        assert.equal(captured.bin, '/fake/claude')
      }
      if (c.name === 'gemini') {
        assert.ok(!captured.args[1].startsWith(NO_EXEC_HEADER), '1.19.0：gemini 複審預設不加 NO_EXEC_HEADER（plan 模式唯讀、讀檔工具可用；agy 那條照舊）')
        assert.equal(captured.args[1], 'P', '沒傳 noExecHeader ⇒ prompt 逐字等於原文')
        assert.equal(captured.opts.env.GEMINI_API_KEY, 'test-key')
        assert.equal(captured.opts.env.GEMINI_CLI_TRUST_WORKSPACE, 'true', '1.15.0 r2 真跑：未信任資料夾 exit 55，plan 唯讀所以一律信任（只進子行程 env）')
        assert.deepEqual(captured.args, ['-p', 'P', '-m', 'm', '--output-format', 'json', '--approval-mode', 'plan', '-e', 'none'])
      }
    })
    test(`${c.name}：runSync（同步）回同形狀`, () => {
      const h = getHarness(c.name)
      const r = h.review.runSync({ model: 'm', prompt: 'P', cwd: process.cwd(), timeoutMs: 1000, env: c.env, spawn: () => okSpawn(c.goodStdout), resolveKey: () => 'test-key' })
      assert.notEqual(typeof r?.then, 'function')
      assert.deepEqual(Object.keys(r).sort(), UNIFIED_REVIEW_KEYS)
      assert.equal(r.text, c.expectText)
    })
  }
  test('gemini：resolveKey 回 "" ⇒ 不 spawn、failure.kind auth（retryable:false）、keyMissing 只在 raw、stderr 不含 key', async () => {
    let spawned = false
    const r = await getHarness('gemini').review.run({ model: 'm', prompt: 'P', cwd: process.cwd(), timeoutMs: 1000, env: {}, spawn: async () => { spawned = true; return okSpawn('') }, resolveKey: () => '' })
    assert.equal(spawned, false)
    assert.deepEqual(r.failure, { kind: 'auth', retryable: false })
    assert.ok(!('keyMissing' in r))
    assert.equal(r.raw.keyMissing, true)
    assert.equal(r.text, '')
    assert.ok(!r.stderr.includes('test-key'))
  })
  test('agy：denied 非空 ⇒ failure.kind policy（exit 仍是 0——agy 第 1 坑）', async () => {
    const r = await getHarness('agy').review.run({ model: 'm', prompt: 'P', cwd: process.cwd(), timeoutMs: 1000, env: { AGY_BIN: '/fake/agy' }, spawn: async () => okSpawn(agyStdout({ response: '', denied: [{ action: 'command', display_name: 'RunCommand' }] })) })
    assert.equal(r.exit, 0)
    assert.equal(r.denied.length, 1)
    assert.deepEqual(r.failure, { kind: 'policy', retryable: false })
  })
})

describe('⑤ agy write.run／resume：假 spawn 回統一形狀、conversationId 取得到、續輪帶 --conversation', () => {
  const env = { AGY_BIN: '/fake/agy', PATH: '/x' }
  test('run ⇒ conversationId 來自 init/result；形狀多 steps／conversationId；args 不含 --conversation', () => {
    let captured = null
    const r = getHarness('agy').write.run({ model: 'm', prompt: 'do it', cwd: process.cwd(), timeoutMs: 1000, env, spawn: (bin, args, opts) => { captured = { bin, args, opts }; return okSpawn(agyStdout({ conversationId: 'conv-w1', response: 'done' })) } })
    assert.deepEqual(Object.keys(r).sort(), UNIFIED_WRITE_KEYS)
    assert.equal(r.conversationId, 'conv-w1')
    assert.equal(r.text, 'done')
    assert.deepEqual(r.steps, [])
    assert.equal(r.failure, null)
    assert.ok(captured.args.includes('accept-edits'))
    assert.ok(!captured.args.includes('--conversation'))
    assert.equal(captured.opts.input, lib.buildAgyStdin('do it'))
  })
  test('resume ⇒ args 含 --conversation <id>；缺 conversationId ⇒ throw', () => {
    let captured = null
    const r = getHarness('agy').write.resume({ model: 'm', prompt: 'fix', cwd: process.cwd(), timeoutMs: 1000, env, conversationId: 'conv-w1', spawn: (bin, args) => { captured = args; return okSpawn(agyStdout({ conversationId: 'conv-w1', response: 'fixed' })) } })
    assert.equal(r.conversationId, 'conv-w1')
    const i = captured.indexOf('--conversation')
    assert.ok(i >= 0 && captured[i + 1] === 'conv-w1', JSON.stringify(captured))
    assert.throws(() => getHarness('agy').write.resume({ model: 'm', prompt: 'fix', cwd: process.cwd(), timeoutMs: 1000, env, spawn: () => okSpawn('') }), /需要 conversationId/)
  })
  test('write.args 是純函式：run 忽略 conversationId、resume 帶；normalize 對缺欄位的舊物件也不炸', () => {
    const a = getHarness('agy').write.args({ model: 'm', prompt: 'p', cwd: '/w', timeoutMs: 5, conversationId: 'c9' })
    assert.deepEqual(a.extraArgs, ['--conversation', 'c9'])
    assert.equal(a.mode, 'accept-edits')
    const n = getHarness('agy').write.normalize({ exit: 0, stdout: '', stderr: '', result: { response: 'ok', conversation_id: 'c1' } })
    assert.equal(n.conversationId, 'c1')
    assert.deepEqual(n.steps, [])
    assert.deepEqual(n.denied, [])
    assert.equal(n.usage, null)
  })
  test('lastStepIsToolError 住 agy.write，write.mjs 仍 re-export 同一個函式', async () => {
    const w = await import('./write.mjs')
    assert.equal(w.lastStepIsToolError, getHarness('agy').write.lastStepIsToolError)
    assert.equal(w.lastStepIsToolError([{ tool: 'grep_search', error: 'invalid type' }]), true)
  })
})

describe('⑥ council runOne：三種 harness 各經 deps.getHarness 注入假 harness 仍能派到；輸出檔內容＝text（繞過假 harness 就會去 spawn 不存在的 binary ⇒ 必紅）', () => {
  for (const member of [M.agyGemini, M.codexSol, M.geminiPro]) {
    test(`${member.harness}`, async () => {
      const repo = makeRepo(v2Config({ reviewers: [member] }))
      const brief = path.join(tmpdir('brief-'), 'brief.md')
      fs.writeFileSync(brief, 'test brief')
      const outDir = path.join(tmpdir('review-'), 'review')
      const calls = []
      const real = getHarness(member.harness)
      const fake = {
        ...real,
        review: {
          ...real.review,
          run: async (opts) => {
            calls.push(opts)
            return { exit: 0, signal: null, timedOut: false, stdout: '', stderr: '', text: `整份：簽（${member.harness}）`, denied: [], usage: null, failure: null, raw: {} }
          },
        },
      }
      const deps = { env: NO_BIN_ENV, resolveGeminiApiKey: () => 'test-key', getHarness: (n) => (n === member.harness ? fake : getHarness(n)) }
      const origLog = console.log
      console.log = () => {}
      let code
      try {
        code = await councilMain(['review', '--coordinator', 'claude', '--worktree', repo.dir, '--base', 'main', '--brief', brief, '--tier', 'standard', '--out', outDir], deps)
      } finally {
        console.log = origLog
      }
      assert.equal(code, 0)
      assert.equal(calls.length, 1, '假 harness 的 review.run 要被呼叫一次')
      assert.equal(calls[0].model, member.model)
      assert.equal(calls[0].noExecHeader, undefined, '1.19.0：council 不再傳 noExecHeader——唯讀姿態交給各 harness 自己的 review.args 預設（agy 加、gemini 不加、codex 不收）')
      assert.equal(calls[0].env, NO_BIN_ENV)
      const file = lib.memberFileName(lib.memberName(member))
      assert.equal(fs.readFileSync(path.join(outDir, `${file}.txt`), 'utf8'), `整份：簽（${member.harness}）`)
      const members = JSON.parse(fs.readFileSync(path.join(outDir, 'members.json'), 'utf8'))
      assert.equal(members[0].overall, '簽')
    })
  }
  test('canReview:false 的 harness（注入一個沒有 review 介面的 claude）⇒ runOne throw「沒有 review 介面」', async () => {
    const cfg = v2Config({ reviewers: [M.claudeCode], coordinator: M.codexSol, profileName: 'codex' })
    const { review: _drop, ...noReview } = getHarness('claude')
    const fakeNoReview = { ...noReview, canReview: false }
    const repo = makeRepo(cfg)
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'x')
    const outDir = path.join(tmpdir('review-'), 'review')
    await assert.rejects(
      councilMain(['review', '--coordinator', 'codex', '--worktree', repo.dir, '--base', 'main', '--brief', brief, '--out', outDir], { env: NO_BIN_ENV, loadConfig: () => cfg, getHarness: (n) => (n === 'claude' ? fakeNoReview : getHarness(n)) }),
      /council 不派 harness=claude.*沒有 review 介面/
    )
  })
})

describe('⑥b write.mjs：deps.getHarness 注入假 harness ⇒ G2 走它的 preflight、每輪走它的 write.run；canWrite:false ⇒ exit 2', () => {
  function runWrite(fake, extraDeps = {}) {
    const repo = makeRepo(v2Config())
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'do')
    const outDir = path.join(repo.dir, '.agy-write')
    const errs = []
    const origErr = console.error
    const origLog = console.log
    console.error = (m) => errs.push(String(m))
    console.log = () => {}
    let code
    try {
      code = writeMain(['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir], { getHarness: (n) => (n === 'agy' ? fake : getHarness(n)), ...extraDeps })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    return { code, errs: errs.join('\n'), repo, outDir }
  }
  const real = getHarness('agy')
  test('preflight 回任一條 !ok ⇒ exit 2、🔴 G2：<message>——write.mjs 沒有放行分支（連標了 roles:[\'setup\'] 的也擋；過濾是 harness 依 deps.role 做的）；全 ok ⇒ 過', () => {
    const bad = { ...real, preflight: () => [{ ok: false, label: 'x', message: 'settings 壞了' }] }
    const r = runWrite(bad)
    assert.equal(r.code, 2)
    assert.match(r.errs, /🔴 G2：settings 壞了/)
    // 🔴 sol block r1 Q2 陽性對照：假 harness 硬把一條「setup 才該有」的 !ok 回給 write ⇒ 仍擋（write.mjs 不看 roles）。
    const roleCalls = []
    // 🔴 write.run 也換成假的：若 G2 放行了，不能讓它真的 spawn 本機 agy（燒額度），要立刻紅。
    const leaky = {
      ...real,
      preflight: (env, config, deps) => { roleCalls.push(deps.role); return [{ ok: false, label: 'trustedWorkspaces', message: '只是警告', roles: ['setup'] }] },
      write: { ...real.write, run: () => { throw new Error('G2 放行了：write.run 不該被叫到') } },
    }
    const r2 = runWrite(leaky)
    assert.equal(r2.code, 2, 'write.mjs 對 preflight 回傳的 !ok 一律擋，沒有放行分支')
    assert.match(r2.errs, /🔴 G2：只是警告/)
    assert.deepEqual(roleCalls, ['write'], 'write.mjs 以 role write 呼叫 preflight')
    const allOk = {
      ...real,
      preflight: () => [{ ok: true, label: 'x' }],
      write: { ...real.write, run: (o) => { fs.writeFileSync(path.join(o.cwd, 'add.test.mjs'), 't'); return { ...real.write.normalize({ exit: 0, stdout: '', stderr: '', denied: [], steps: [], result: { response: 'ok', conversation_id: 'c1' }, conversationId: 'c1' }) } } },
    }
    const r3 = runWrite(allOk)
    assert.equal(r3.code, 0, r3.errs)
  })
  test('preflight throw ⇒ exit 2、🔴 G2：<訊息>（設定檔讀不到）', () => {
    const r = runWrite({ ...real, preflight: () => { throw new Error('agy settings 不存在：/nope') } })
    assert.equal(r.code, 2)
    assert.match(r.errs, /🔴 G2：agy settings 不存在：\/nope/)
  })
  test('假 harness canWrite:false ⇒ exit 2、訊息「writer.harness 只准 agy」', () => {
    const r = runWrite({ ...real, canWrite: false, preflight: () => [] })
    assert.equal(r.code, 2)
    assert.match(r.errs, /writer\.harness 只准 agy/)
  })
  test('真 agy preflight：settings 缺 regex ⇒ G2 訊息與 1.14.0 相同「agy settings permissions.allow 缺這條」', () => {
    const f = path.join(tmpdir('settings-'), 'settings.json')
    fs.writeFileSync(f, JSON.stringify({ permissions: { allow: ['command(node --test)'] } }))
    const saved = process.env.AGY_SETTINGS
    process.env.AGY_SETTINGS = f
    let r
    try {
      r = runWrite(real)
    } finally {
      if (saved === undefined) delete process.env.AGY_SETTINGS
      else process.env.AGY_SETTINGS = saved
    }
    assert.equal(r.code, 2)
    assert.match(r.errs, /🔴 G2：agy settings permissions\.allow 缺這條/)
  })
  // 🔴 sol r2 Q1：1.14.0 的 write G2 對壞 JSON 印的是裸 `🔴 G2：<JSON.parse 原生訊息>`
  //   （c7847a36 write.mjs:158 `console.error(\`🔴 G2：${e.message}\`)`，e 來自 lib.mjs:647 裸 `JSON.parse(fs.readFileSync(settingsFile,'utf8'))`）。
  //   期望值就照那條公式算（原生訊息隨 Node 版本變，所以不把 Node 的句子寫死，只把「🔴 G2：」＋原生訊息這個形狀寫死），
  //   並斷言【不含】setup 那句包裝「解析失敗」。
  test('壞 JSON ⇒ write G2 stderr 精確等於 1.14.0 字面（🔴 G2：＋JSON.parse 原生訊息，不含「解析失敗」包裝）', () => {
    const f = path.join(tmpdir('settings-'), 'settings.json')
    const content = '{not json'
    fs.writeFileSync(f, content)
    let native
    try {
      JSON.parse(content)
    } catch (e) {
      native = e.message
    }
    const expected = `🔴 G2：${native}`
    const saved = process.env.AGY_SETTINGS
    process.env.AGY_SETTINGS = f
    let r
    try {
      r = runWrite(real)
    } finally {
      if (saved === undefined) delete process.env.AGY_SETTINGS
      else process.env.AGY_SETTINGS = saved
    }
    assert.equal(r.code, 2)
    assert.equal(r.errs, expected, '要跟 1.14.0 逐字相同：裸原生訊息')
    assert.ok(!r.errs.includes('解析失敗'), 'write 路徑不准帶 setup 的包裝句')
    assert.throws(() => lib.assertSettingsAllowRegex(f, '/repo', v2Config()), (e) => e instanceof SyntaxError && e.message === native)
  })
})

describe('⑥c agy preflight／agySettingsChecks／assertSettingsAllowRegex 單一來源', () => {
  const cfg = v2Config()
  const want = `command(regex:${buildSafeCommandRegex(cfg)})`
  function settings(obj) {
    const f = path.join(tmpdir('settings-'), 'settings.json')
    fs.writeFileSync(f, JSON.stringify(obj))
    return f
  }
  test('role setup ⇒ 三條 check（command(regex)／read_file(<root>/)／trustedWorkspaces）；role write ⇒ 只有前兩條（trustedWorkspaces 不回，1.14.0 write 本來就不查）；未知 role ⇒ throw', () => {
    const f = settings({ permissions: { allow: [want, 'read_file(/repo/)'] }, trustedWorkspaces: [] })
    const setupChecks = getHarness('agy').preflight({ AGY_SETTINGS: f }, cfg, { repoRoot: '/repo', role: 'setup' })
    assert.deepEqual(setupChecks.map((c) => [c.label, c.ok, c.roles]), [
      ['command(regex)', true, ['write', 'setup']],
      ['read_file(/repo/)', true, ['write', 'setup']],
      ['trustedWorkspaces', false, ['setup']],
    ])
    assert.deepEqual(setupChecks[2].fix, { file: f, trustedWorkspaces: ['/repo'] })
    const writeChecks = getHarness('agy').preflight({ AGY_SETTINGS: f }, cfg, { repoRoot: '/repo', role: 'write' })
    assert.deepEqual(writeChecks.map((c) => c.label), ['command(regex)', 'read_file(/repo/)'])
    assert.ok(writeChecks.every((c) => c.ok))
    assert.equal(getHarness('agy').preflight({ AGY_SETTINGS: f }, cfg, { repoRoot: '/repo' }).length, 3, '不給 role ⇒ 全部')
    assert.throws(() => getHarness('agy').preflight({ AGY_SETTINGS: f }, cfg, { repoRoot: '/repo', role: 'nope' }), /role 只准 write\|setup/)
    assert.equal(lib.assertSettingsAllowRegex(f, '/repo', cfg), true, 'trustedWorkspaces 缺不擋 write（1.14.0 既有射程）')
  })
  test('缺 regex ⇒ 第一條 !ok、assertSettingsAllowRegex 丟同一句；缺 read_file ⇒ 第二條；不給 repoRoot 只有一條', () => {
    const f = settings({ permissions: { allow: ['read_file(/repo/)'] } })
    const checks = agyModule.agySettingsChecks({ settingsFile: f, repoRoot: '/repo', config: cfg })
    assert.equal(checks[0].ok, false)
    assert.throws(() => lib.assertSettingsAllowRegex(f, '/repo', cfg), /permissions\.allow 缺這條/)
    const f2 = settings({ permissions: { allow: [want] } })
    assert.throws(() => lib.assertSettingsAllowRegex(f2, '/other', cfg), /缺 read_file\(\/other\/\)/)
    assert.equal(agyModule.agySettingsChecks({ settingsFile: f2, repoRoot: null, config: cfg }).length, 1)
  })
  test('檔不存在／壞 JSON ⇒ throw（訊息同 1.14.0 setup）', () => {
    assert.throws(() => getHarness('agy').preflight({ AGY_SETTINGS: '/nope/settings.json' }, cfg, {}), /agy settings 不存在：\/nope\/settings\.json/)
    const f = settings({})
    fs.writeFileSync(f, '{not json')
    assert.throws(() => getHarness('agy').preflight({ AGY_SETTINGS: f }, cfg, { role: 'setup' }), /agy settings 解析失敗（.*settings\.json）：/)
    assert.throws(() => getHarness('agy').preflight({ AGY_SETTINGS: f }, cfg, {}), /agy settings 解析失敗/)
    assert.throws(() => getHarness('agy').preflight({ AGY_SETTINGS: f }, cfg, { role: 'write' }), (e) => e instanceof SyntaxError && !e.message.includes('解析失敗'))
  })
})

describe('⑦ setup --check：含 gemini 的 profile 仍印 [GEMINI_API_KEY] ✓ GEMINI_API_KEY：env（且不印值）；auth 閘走 harness.auth', () => {
  function setupDeps(cfg, extraEnv) {
    const repoRoot = tmpdir('setup-repo-')
    const settingsFile = path.join(tmpdir('settings-'), 'settings.json')
    const rootWithSlash = repoRoot + '/'
    fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: [`command(regex:${buildSafeCommandRegex(cfg)})`, `read_file(${rootWithSlash})`] }, trustedWorkspaces: [repoRoot] }))
    const fakeHome = tmpdir('setup-home-')
    const guardFile = path.join(fakeHome, 'block-dangerous.sh')
    fs.writeFileSync(guardFile, '#!/usr/bin/env bash\n')
    const claudeSettings = path.join(fakeHome, 'claude-settings.json')
    fs.writeFileSync(claudeSettings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/block-dangerous.sh' }] }] } }))
    return {
      repoRoot,
      settingsFile,
      config: cfg,
      agyBin: '/mock/bin/antigravity',
      which: (bin) => `/mock/bin/${bin}`,
      runVersion: () => ({ exit: 0, out: 'mock 1.0' }),
      env: { HOME: fakeHome, LLM_TEAM_GUARD: guardFile, CLAUDE_SETTINGS: claudeSettings, ...extraEnv },
    }
  }
  function run(cfg, extraEnv, argv = ['--check', '--coordinator', 'claude'], extraDeps = {}) {
    const deps = { ...setupDeps(cfg, extraEnv), ...extraDeps }
    const logs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => logs.push(String(m))
    console.error = () => {}
    let code
    try {
      code = setupMain(argv, deps)
    } finally {
      console.log = origLog
      console.error = origErr
    }
    return { code, out: logs.join('\n') }
  }
  test('env 有 GEMINI_API_KEY ⇒ ✓ GEMINI_API_KEY：env、exit 0、輸出不含 test-key', () => {
    const r = run(v2Config({ reviewers: [M.geminiPro] }), { GEMINI_API_KEY: 'test-key' })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /\[GEMINI_API_KEY\] ✓ GEMINI_API_KEY：env/)
    assert.ok(!r.out.includes('test-key'), '🔴 不准印 key 值')
    assert.match(r.out, /\[執行檔 gemini\] ✓ \(\/mock\/bin\/gemini，mock 1\.0\)/)
    assert.match(r.out, /\[command\(regex\)\] ✓ 存在/)
    assert.match(r.out, /\[trustedWorkspaces\] ✓ 覆蓋/)
  })
  // 🔴 sol r2 Q2／Q3：describe 壞掉不能變放行——只有 'env'／'Keychain' 印 ✓，其餘一律 failed。
  for (const [label, value] of [['undefined', undefined], ["'Env'（大小寫錯）", 'Env'], ["'keychain'", 'keychain'], ["''", '']]) {
    test(`auth.describe 回 ${label} ⇒ setup --check exit 非 0、輸出不含 ✓ GEMINI_API_KEY、印 ✗ 未知來源、不印 key`, () => {
      const real = getHarness('gemini')
      const fake = { ...real, auth: { ...real.auth, describe: () => value } }
      const r = run(v2Config({ reviewers: [M.geminiPro] }), { GEMINI_API_KEY: 'test-key' }, undefined, { getHarness: (n) => (n === 'gemini' ? fake : getHarness(n)) })
      assert.notEqual(r.code, 0)
      assert.ok(!r.out.includes('✓ GEMINI_API_KEY'), r.out)
      assert.match(r.out, /\[GEMINI_API_KEY\] ✗ 未知來源/)
      assert.ok(!r.out.includes('test-key'))
    })
  }
  test('auth.describe 回 "缺" ⇒ ✗ 缺（不是未知來源）且 exit 非 0', () => {
    const real = getHarness('gemini')
    const fake = { ...real, auth: { ...real.auth, describe: () => '缺' } }
    const r = run(v2Config({ reviewers: [M.geminiPro] }), {}, undefined, { getHarness: (n) => (n === 'gemini' ? fake : getHarness(n)) })
    assert.notEqual(r.code, 0)
    assert.match(r.out, /\[GEMINI_API_KEY\] ✗ 缺/)
  })
  test('profile 沒有 gemini ⇒ 不印 [GEMINI_API_KEY]（auth 閘只對用到的 harness）', () => {
    const r = run(v2Config({ reviewers: [M.codexSol] }), {})
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /\[GEMINI_API_KEY\]/)
  })
  test('④ 真跑抓到：gemini review／runGemini 子行程 env 含 GEMINI_CLI_TRUST_WORKSPACE:"true"＋NODE_OPTIONS（未信任資料夾 exit 55 ⇒ 整席零輸出）', async () => {
    const envs = []
    const spawnA = async (b, a, o) => { envs.push(o.env); return okSpawn(JSON.stringify({ response: 'ok' })) }
    await getHarness('gemini').review.run({ model: 'm', prompt: 'P', cwd: process.cwd(), timeoutMs: 1, env: { GEMINI_BIN: '/fake/gemini' }, spawn: spawnA, resolveKey: () => 'test-key' })
    lib.runGemini({ model: 'm', prompt: 'P', cwd: process.cwd(), timeoutMs: 1, env: { GEMINI_BIN: '/fake/gemini' }, spawn: (b, a, o) => { envs.push(o.env); return okSpawn('') }, resolveKey: () => 'test-key' })
    assert.equal(envs.length, 2)
    for (const e of envs) assert.equal(e.GEMINI_CLI_TRUST_WORKSPACE, 'true')
    for (const e of envs) assert.equal(e.NODE_OPTIONS, '--max-old-space-size=6144', '紅了代表 gemini 複審席會回到 4 GB heap ⇒ 在 8 GB 機器上靜默 OOM、零輸出')
  })
  test('gemini auth.describe：env ⇒ env；env 無、注入的 resolveGeminiApiKey 回值 ⇒ Keychain；回空 ⇒ 缺（永不回值）', () => {
    const a = getHarness('gemini').auth
    assert.equal(a.envVar, 'GEMINI_API_KEY')
    assert.equal(a.describe({ GEMINI_API_KEY: 'test-key' }, {}), 'env')
    assert.equal(a.describe({}, { resolveGeminiApiKey: () => 'test-key' }), 'Keychain')
    assert.equal(a.describe({}, { resolveGeminiApiKey: () => '' }), '缺')
    assert.equal(a.resolve({}, { resolveGeminiApiKey: () => 'test-key' }), 'test-key')
  })
  test('checkBinary：deps.which／runVersion 注入；找不到 ⇒ null；--version 非 0 ⇒ versionError；agy 不跑 --version', () => {
    const deps = { which: (b) => (b === 'codex' ? null : `/mock/${b}`), runVersion: (b) => (b.endsWith('claude') ? { exit: 1, out: '' } : { exit: 0, out: 'v1' }) }
    assert.equal(getHarness('codex').checkBinary({}, deps), null)
    assert.deepEqual(getHarness('gemini').checkBinary({}, deps), { path: '/mock/gemini', version: 'v1' })
    assert.deepEqual(getHarness('claude').checkBinary({}, deps), { path: '/mock/claude', versionError: '--version exit 1' })
    let versionCalls = 0
    assert.deepEqual(getHarness('agy').checkBinary({}, { agyBin: '/nonexistent/agy', which: (b) => `/mock/${b}`, runVersion: () => { versionCalls++; return { exit: 0, out: '' } } }), { path: '/mock/antigravity' })
    assert.equal(versionCalls, 0)
    assert.equal(probeBinary(null, {}, deps), null)
  })
})

// 🔴 靜態閘：呼叫點不准再自己認 harness 名字。
//   事故：1.14.0 以前 council.mjs 四處 `if (harness === …)`、write.mjs 整檔只認 agy、setup.mjs 三處——09-22 加 gemini 複審席要動 5 個檔，
//     漏一處（例如 council 的 text 取法）就是整席零輸出（r1 sol Q3 那類）。
//   陽性對照：在 write.mjs 塞回一行 `if (writer.harness === 'nope') return 9` ⇒ 本 describe 的 write.mjs 那條紅（1.15.0 r1 已重放坐實）。
//   停止條件：呼叫點只剩 registry 查詢、且三個月內沒再長出任何 harness 分支時，可從紅降為警告。
describe('⑧ 靜態：council.mjs／write.mjs／setup.mjs／usage.mjs 剝掉註解後不含 harness === \'／harness !== \' 字面（塞回一條就紅）', () => {
  for (const f of ['council.mjs', 'write.mjs', 'setup.mjs', 'usage.mjs']) {
    test(f, () => {
      const src = fs.readFileSync(path.join(HERE, f), 'utf8')
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      assert.ok(!stripped.includes("harness === '"), `${f} 不得含 harness === '`)
      assert.ok(!stripped.includes("harness !== '"), `${f} 不得含 harness !== '`)
    })
  }
  test('lib.mjs 不再定義任何 run*／parse*／build*Args／resolve*（只 re-export；gemini 三個也是，sol block r1 Q5）', () => {
    const src = fs.readFileSync(path.join(HERE, 'lib.mjs'), 'utf8')
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    for (const fn of ['runAgy', 'runAgyAsync', 'runCodex', 'runCodexAsync', 'runGemini', 'runGeminiAsync', 'resolveGeminiApiKey', 'parseAgyRun', 'parseCodexRun', 'parseGeminiRun', 'parseStreamJson', 'buildAgyArgs', 'buildCodexArgs', 'buildGeminiArgs', 'resolveAgyBin', 'resolveCodexBin', 'resolveGeminiBin', 'assertSettingsAllowRegex']) {
      assert.ok(!new RegExp(`function ${fn}\\(`).test(stripped), `lib.mjs 不該再定義 ${fn}`)
      assert.equal(typeof lib[fn], 'function', `lib.mjs 仍要 export ${fn}`)
    }
    assert.equal((stripped.match(/resolveGeminiApiKey/g) || []).length, 1, 'lib.mjs 剝註解後 resolveGeminiApiKey 只在 export … from 那一行出現')
  })
  test('lib.mjs re-export 的是 harness 模組裡的同一個函式', () => {
    assert.equal(lib.runCodexAsync, codexModule.runCodexAsync)
    assert.equal(lib.runAgyAsync, agyModule.runAgyAsync)
    assert.equal(lib.parseGeminiRun, geminiModule.parseGeminiRun)
    assert.equal(lib.assertSettingsAllowRegex, agyModule.assertSettingsAllowRegex)
    assert.equal(lib.parseStreamJson, agyModule.parseStreamJson)
    assert.equal(lib.runGemini, geminiModule.runGemini)
    assert.equal(lib.runGeminiAsync, geminiModule.runGeminiAsync)
    assert.equal(lib.resolveGeminiApiKey, geminiModule.resolveGeminiApiKey)
  })
})

describe('⑨ failure 分類：每個 canReview harness 模擬 timeout／非零 exit／stdout 非 JSON', () => {
  for (const c of REVIEW_CASES) {
    const h = getHarness(c.name)
    const run = (spawnResult) => h.review.run({ model: 'm', prompt: 'P', cwd: process.cwd(), timeoutMs: 1, env: c.env, spawn: async () => spawnResult, resolveKey: () => 'test-key' })
    test(`${c.name}：timeout ⇒ kind timeout（retryable:true）`, async () => {
      const r = await run({ status: null, signal: 'SIGTERM', timedOut: true, stdout: '', stderr: '' })
      assert.equal(r.timedOut, true)
      assert.deepEqual(r.failure, { kind: 'timeout', retryable: true })
    })
    test(`${c.name}：非零 exit ⇒ kind process（code exit:1）；stderr 有 RESOURCE_EXHAUSTED ⇒ quota`, async () => {
      const r = await run({ status: 1, signal: null, stdout: '', stderr: 'boom' })
      assert.deepEqual(r.failure, { kind: 'process', code: 'exit:1', retryable: false })
      const q = await run({ status: 1, signal: null, stdout: '', stderr: '429 RESOURCE_EXHAUSTED' })
      assert.equal(q.failure.kind, 'quota')
      assert.equal(q.failure.retryable, false)
    })
    test(`${c.name}：exit 0 但 stdout 不是預期形狀 ⇒ ${c.protocolStdout === null ? 'codex 純文字是正常輸出，failure null' : 'kind protocol'}`, async () => {
      const r = await run(okSpawn(c.protocolStdout ?? '純文字'))
      if (c.protocolStdout === null) {
        assert.equal(r.failure, null)
        assert.equal(r.text, '純文字')
      } else {
        assert.deepEqual(r.failure, { kind: 'protocol', retryable: false })
        if (c.name === 'gemini') assert.equal(r.text, c.protocolStdout, 'gemini 仍退回整段 stdout 當回覆（1.14.0 既有行為）')
      }
    })
  }
  test('1.22.0 claude：JSON api_error_status 429 ⇒ quota retryable:true（text 空）；is_error 帶 usage limit ⇒ quota；is_error 其他 ⇒ process claude:<subtype>；permission_denials 記進 denied 但不算失敗', async () => {
    const h = getHarness('claude')
    const run = (obj) => h.review.run({ model: 'm', prompt: 'P', cwd: process.cwd(), timeoutMs: 1, env: { CLAUDE_BIN: '/fake/claude' }, spawn: async () => okSpawn(JSON.stringify(obj)) })
    const q = await run({ is_error: true, subtype: 'error', result: 'API Error', api_error_status: 429 })
    assert.deepEqual(q.failure, { kind: 'quota', code: '429', retryable: true })
    assert.equal(q.text, '', 'is_error 的 result 不是正文')
    const u = await run({ is_error: true, subtype: 'error', result: "You've hit your usage limit", api_error_status: null })
    assert.equal(u.failure.kind, 'quota')
    const p = await run({ is_error: true, subtype: 'error_max_turns', result: 'x', api_error_status: null })
    assert.deepEqual(p.failure, { kind: 'process', code: 'claude:error_max_turns', retryable: false })
    const d = await run({ is_error: false, subtype: 'success', result: '整份：簽', permission_denials: [{ tool_name: 'Bash' }] })
    assert.equal(d.failure, null)
    assert.equal(d.text, '整份：簽')
    assert.deepEqual(d.denied, [{ tool_name: 'Bash' }])
    // 陽性對照：正文裡提到 429 不是額度事件（只認 is_error／api_error_status）
    const ok429 = await run({ is_error: false, subtype: 'success', result: 'Q2：不簽｜回 429 時被吞', api_error_status: null })
    assert.equal(ok429.failure, null)
  })
  test('classifyFailure 順序：timeout > auth > policy > (quota|process) > protocol > null', () => {
    assert.equal(classifyFailure({ timedOut: true, authMissing: true }).kind, 'timeout')
    assert.equal(classifyFailure({ authMissing: true, denied: [{}] }).kind, 'auth')
    assert.equal(classifyFailure({ denied: [{}], exit: 1 }).kind, 'policy')
    assert.equal(classifyFailure({ exit: 1, stderr: 'RESOURCE_EXHAUSTED' }).kind, 'quota')
    assert.equal(classifyFailure({ exit: null, signal: 'SIGKILL' }).code, 'signal:SIGKILL')
    assert.equal(classifyFailure({ exit: 0, parsed: false }).kind, 'protocol')
    assert.equal(classifyFailure({ exit: 0, parsed: true }), null)
  })
})

describe('⑩ 模組載入順序：lib.mjs 先進、harnesses/index.mjs 先進，兩條路都不撞 TDZ（子行程各跑一次）', () => {
  for (const entry of ['./lib.mjs', './harnesses/index.mjs', './council.mjs', './write.mjs', './setup.mjs', './usage.mjs']) {
    test(`先 import ${entry}`, () => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import('${entry}').then((m) => { if (!m) throw new Error('empty') ; console.log('ok') })`], {
        cwd: HERE,
        env: { ...CLEAN_GIT_ENV, NODE_TEST_CONTEXT: '' },
        encoding: 'utf8',
      })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /ok/)
    })
  }
})

describe('⑪ lib.mjs re-export 的 gemini 三個函式行為（舊形狀、resolveKey 注入）', () => {
  test('runGeminiAsync 走 resolveKey 注入、回舊形狀含 keyMissing', async () => {
    const r = await lib.runGeminiAsync({ model: 'm', prompt: 'p', cwd: process.cwd(), env: {}, spawn: async () => okSpawn(''), resolveKey: () => '' })
    assert.equal(r.keyMissing, true)
    assert.equal(r.exit, null)
    let captured = null
    const r2 = await lib.runGeminiAsync({ model: 'm', prompt: 'p', cwd: process.cwd(), env: { GIT_DIR: '/x' }, spawn: async (b, a, o) => { captured = o; return okSpawn(JSON.stringify({ response: 'ok', stats: null })) }, resolveKey: () => 'test-key' })
    assert.equal(r2.response, 'ok')
    assert.equal(captured.env.GEMINI_API_KEY, 'test-key')
    assert.equal(captured.env.GIT_DIR, undefined)
    assert.ok(!('parsed' in r2), '舊形狀不多 parsed 欄')
  })
  test('resolveGeminiApiKey：env 優先、exec stdio[2]==="ignore"、throw ⇒ ""', () => {
    let opts = null
    assert.equal(lib.resolveGeminiApiKey({ GEMINI_API_KEY: 'test-key' }, () => { throw new Error('no') }), 'test-key')
    assert.equal(lib.resolveGeminiApiKey({}, (b, a, o) => { opts = o; return 'test-key\n' }), os.platform() === 'darwin' ? 'test-key' : '')
    if (os.platform() === 'darwin') assert.equal(opts.stdio[2], 'ignore')
    assert.equal(lib.resolveGeminiApiKey({}, () => { throw new Error('no') }), '')
  })
})

// ═══════════════════ 1.16.0：gemini 當寫手（票 llm-team-gemini-writer） ═══════════════════
// 🔴 不打真 Gemini API：parser 用 harnesses/__fixtures__/gemini-write-*.ndjson（2026-09-22 真跑一次的 stdout 原樣，內含 session id、無 key）；
//    write.run／resume 一律注入假 spawn＋resolveKey。
const FIXTURE_DIR = path.join(HERE, 'harnesses', '__fixtures__')
const readFixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')
const STREAM_FIXTURE = 'gemini-write-stream.ndjson'
const DENIED_FIXTURE = 'gemini-write-denied.ndjson'
const STREAM_SESSION = 'fd29775d-08ac-4643-9223-23c9e355d68c'
const DENIED_SESSION = 'c2b6a05c-f955-4da1-9ec9-eff9682ccb9c'

describe('⑫ gemini 寫手 ①②：buildGeminiWriteArgs／buildGeminiPolicyToml 純函式', () => {
  const { buildGeminiWriteArgs, buildGeminiPolicyToml, GEMINI_WRITE_DENY_PREFIXES, GEMINI_POLICY_FILE, geminiPolicyPath } = geminiModule
  test('① run：-p <prompt> -m <model> --output-format stream-json --approval-mode auto_edit；resume 另加 --resume <id>；policyFile 另加 --policy', () => {
    assert.deepEqual(buildGeminiWriteArgs({ model: 'gemini-3.8-flash', prompt: 'P' }), ['-p', 'P', '-m', 'gemini-3.8-flash', '--output-format', 'stream-json', '--approval-mode', 'auto_edit'])
    assert.deepEqual(buildGeminiWriteArgs({ model: 'm', prompt: 'P', resumeId: 'sess-1' }), ['-p', 'P', '-m', 'm', '--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--resume', 'sess-1'])
    assert.deepEqual(buildGeminiWriteArgs({ model: 'm', prompt: 'P', policyFile: '/out/gemini-policy.toml', resumeId: 'sess-1' }), ['-p', 'P', '-m', 'm', '--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--policy', '/out/gemini-policy.toml', '--resume', 'sess-1'])
    assert.ok(!buildGeminiWriteArgs({ model: 'm', prompt: 'P' }).includes('plan'), '寫手不是 plan 模式')
    assert.equal(GEMINI_POLICY_FILE, 'gemini-policy.toml')
    assert.equal(geminiPolicyPath('/out'), '/out/gemini-policy.toml', 'policy 住 outDir，不是 worktree')
  })
  test('② policy TOML 內容精確：禁令 deny priority 100（rm／git commit／push／checkout／reset／stash／clean）→ 每個 head allow priority 50 → run_shell_command 兜底 deny priority 10；全部 modes=["autoEdit"] interactive=false', () => {
    const toml = buildGeminiPolicyToml({ allowedHeads: ['ls', 'sed -n', 'pnpm test', 'bash .github/scripts/test-'] })
    const rules = toml.split('[[rule]]').slice(1).map((s) => s.trim())
    assert.deepEqual(GEMINI_WRITE_DENY_PREFIXES, ['rm', 'git commit', 'git push', 'git checkout', 'git reset', 'git stash', 'git clean'])
    assert.equal(rules.length, GEMINI_WRITE_DENY_PREFIXES.length + 4 + 1)
    const expectRule = ({ commandPrefix, decision, priority }) =>
      [
        'toolName = "run_shell_command"',
        ...(commandPrefix !== undefined ? [`commandPrefix = "${commandPrefix}"`] : []),
        `decision = "${decision}"`,
        `priority = ${priority}`,
        'modes = ["autoEdit"]',
        'interactive = false',
      ].join('\n')
    GEMINI_WRITE_DENY_PREFIXES.forEach((p, i) => assert.equal(rules[i], expectRule({ commandPrefix: p, decision: 'deny', priority: 100 }), `禁令 ${p}`))
    const heads = ['ls', 'sed -n', 'pnpm test', 'bash .github/scripts/test-']
    heads.forEach((h, i) => assert.equal(rules[GEMINI_WRITE_DENY_PREFIXES.length + i], expectRule({ commandPrefix: h, decision: 'allow', priority: 50 }), `allow ${h}`))
    assert.equal(rules.at(-1), expectRule({ decision: 'deny', priority: 10 }), '兜底 deny 沒有 commandPrefix')
    assert.ok(!toml.includes('"plan"') && !toml.includes('"yolo"') && !toml.includes('"default"'), '只在 autoEdit 生效')
    assert.equal(rules.at(-1).split('\n').filter((l) => l.startsWith('commandPrefix')).length, 0)
    // 引號與反斜線要跳脫；重複 head 去重；空白 head 丟掉
    const t2 = buildGeminiPolicyToml({ allowedHeads: ['a"b', 'x\\y', 'ls', 'ls', ' ', ''] })
    assert.ok(t2.includes('commandPrefix = "a\\"b"'))
    assert.ok(t2.includes('commandPrefix = "x\\\\y"'))
    assert.equal((t2.match(/commandPrefix = "ls"/g) || []).length, 1)
    assert.equal(buildGeminiPolicyToml().split('[[rule]]').length - 1, GEMINI_WRITE_DENY_PREFIXES.length + 1, '沒有 head ⇒ 只有禁令＋兜底')
  })
})

describe('⑫ gemini 寫手 ③：parseGeminiStream 用兩個真 fixture（欄位名以真跑為準）', () => {
  const { parseGeminiStream, isGeminiDeniedResult, lastGeminiStepIsToolError } = geminiModule
  test('fixture 存在且不含 key 字串（AIza）', () => {
    for (const f of [STREAM_FIXTURE, DENIED_FIXTURE]) {
      const t = readFixture(f)
      assert.ok(t.trim().length > 0, f)
      assert.ok(!t.includes('AIza'), `${f} 不准含 key 前綴`)
      assert.ok(!t.includes('test-key'))
    }
  })
  test('正常寫檔 fixture：sessionId 來自 init.session_id、steps 有 write_file（status success）、denied 空、text ＝ 接起來的 assistant delta、result.stats 是 usage', () => {
    const p = parseGeminiStream(readFixture(STREAM_FIXTURE))
    assert.equal(p.sessionId, STREAM_SESSION)
    assert.equal(p.init.model, 'gemini-3.8-flash')
    assert.deepEqual(p.steps.map((s) => [s.tool, s.status, s.denied]), [['write_file', 'success', false]])
    assert.deepEqual(p.steps[0].params, { file_path: 'hello.txt', content: 'hi\n' })
    assert.deepEqual(p.denied, [])
    assert.equal(p.messages.length, 1, 'assistant 的兩個 delta 片段接成一則')
    assert.ok(p.text.startsWith('我已建立 `hello.txt` 檔案，內容為 `hi`。'), p.text)
    assert.ok(p.text.trim().endsWith('done'))
    assert.equal(p.result.status, 'success')
    assert.equal(p.result.stats.tool_calls, 1)
    assert.equal(lastGeminiStepIsToolError(p.steps), false)
  })
  test('policy denied fixture：run_shell_command 的 tool_result status error／error.type policy_violation ⇒ denied 非空（tool 用 tool_id 對回）；list_directory 那步不算；exit 層看不出來（result.status 仍 success）', () => {
    const p = parseGeminiStream(readFixture(DENIED_FIXTURE))
    assert.equal(p.sessionId, DENIED_SESSION)
    assert.deepEqual(p.steps.map((s) => [s.tool, s.status, s.denied]), [['list_directory', 'success', false], ['run_shell_command', 'error', true]])
    assert.equal(p.denied.length, 1)
    assert.deepEqual(p.denied[0], { action: 'policy', tool: 'run_shell_command', detail: 'Tool execution denied by policy.' })
    assert.equal(p.steps[1].params.command, 'pnpm test')
    assert.equal(p.result.status, 'success', '🔴 被 policy 拒時 result 仍是 success——G3 只能看 denied')
    assert.ok(p.text.includes('Tool execution denied by policy'), '模型還會繼續講話，text 非空')
    assert.equal(lastGeminiStepIsToolError(p.steps), false, '被拒不是「參數不合法」那類 tool error，不該觸發 resume 重試')
  })
  test('陽性對照：同一份 denied fixture 把 error.type 改掉且訊息改成中性 ⇒ denied 空（判定確實吃 policy_violation／denied 字樣）；只留訊息「denied by policy」也算', () => {
    const neutral = readFixture(DENIED_FIXTURE).replace('"error":{"type":"policy_violation","message":"Tool execution denied by policy."}', '"error":{"type":"other","message":"boom"}').replace('"output":"Tool execution denied by policy."', '"output":"boom"')
    const p = parseGeminiStream(neutral)
    assert.deepEqual(p.denied, [])
    assert.equal(p.steps[1].error, 'boom')
    assert.equal(lastGeminiStepIsToolError(p.steps), true, '非 denied 的 tool error ⇒ 可以 resume 重試')
    const msgOnly = readFixture(DENIED_FIXTURE).replace('"type":"policy_violation"', '"type":"other"')
    assert.equal(parseGeminiStream(msgOnly).denied.length, 1)
    assert.equal(isGeminiDeniedResult({ status: 'error', error: { type: 'x', message: 'command not allowed here' } }), true)
    assert.equal(isGeminiDeniedResult({ status: 'success', error: { type: 'policy_violation' } }), false)
  })
  test('壞行不丟（steps[{unparsed}]）；error 事件 severity error 記進 steps（tool null）、warning 不記；沒有 init ⇒ sessionId null；空字串 ⇒ 全空', () => {
    const p = parseGeminiStream('not json\n{"type":"error","severity":"error","message":"x"}\n{"type":"error","severity":"warning","message":"w"}\n')
    assert.deepEqual(p.steps, [{ unparsed: 'not json' }, { tool: null, event: 'error', error: 'x', denied: false }])
    assert.equal(p.sessionId, null)
    assert.equal(p.text, '')
    const e = parseGeminiStream('')
    assert.deepEqual([e.init, e.sessionId, e.messages, e.steps, e.denied, e.result, e.text], [null, null, [], [], [], null, ''])
  })
})

describe('⑫ gemini 寫手 ④⑤⑥：write.run／resume 假 spawn 回統一形狀；缺 key 不 spawn；failure 分類', () => {
  const env = { GEMINI_BIN: '/fake/gemini', PATH: '/x', GIT_DIR: '/leak' }
  const h = getHarness('gemini')
  test('④ run：統一形狀（多 steps／conversationId）、env 含 GEMINI_API_KEY 與 GEMINI_CLI_TRUST_WORKSPACE、GIT_DIR 被剝、args 由 builder 產（含 --policy <outDir>/gemini-policy.toml、不含 --resume）；缺 outDir 與 policyFile ⇒ throw、不 spawn', () => {
    let captured = null
    assert.throws(() => h.write.run({ model: 'm', prompt: 'P', cwd: '/w', timeoutMs: 1, env, spawn: () => { throw new Error('不該 spawn') }, resolveKey: () => 'test-key' }), /需要 outDir 或 policyFile/)
    const r = h.write.run({ model: 'gemini-3.8-flash', prompt: 'do it', cwd: '/w', outDir: '/out', timeoutMs: 1000, env, spawn: (bin, args, opts) => { captured = { bin, args, opts }; return okSpawn(readFixture(STREAM_FIXTURE)) }, resolveKey: () => 'test-key' })
    assert.deepEqual(Object.keys(r).sort(), UNIFIED_WRITE_KEYS)
    assert.equal(captured.bin, '/fake/gemini')
    assert.deepEqual(captured.args, geminiModule.buildGeminiWriteArgs({ model: 'gemini-3.8-flash', prompt: 'do it', policyFile: '/out/gemini-policy.toml' }))
    assert.ok(!captured.args.includes('--resume'))
    assert.ok(!captured.args.some((a) => a.includes('/w/')), 'policy 不在 worktree（cwd）底下')
    assert.equal(captured.opts.env.GEMINI_API_KEY, 'test-key')
    assert.equal(captured.opts.env.GEMINI_CLI_TRUST_WORKSPACE, 'true')
    assert.equal(captured.opts.env.GIT_DIR, undefined)
    assert.equal(captured.opts.cwd, '/w')
    assert.equal(captured.opts.timeout, 1000)
    assert.equal(r.conversationId, STREAM_SESSION)
    assert.ok(r.text.endsWith('done'))
    assert.deepEqual(r.denied, [])
    assert.equal(r.steps.length, 1)
    assert.equal(r.usage.tool_calls, 1)
    assert.equal(r.failure, null)
    assert.equal(r.exit, 0)
    assert.ok(!('keyMissing' in r))
    assert.ok(!JSON.stringify(r).includes('test-key'), '🔴 統一形狀不准帶 key')
  })
  test('④ resume：args 含 --resume <conversationId>；缺 conversationId ⇒ throw；policyFile 可注入', () => {
    let captured = null
    const r = h.write.resume({ model: 'm', prompt: 'fix', cwd: '/w', outDir: '/out', timeoutMs: 1, env, conversationId: STREAM_SESSION, policyFile: '/p.toml', spawn: (b, args) => { captured = args; return okSpawn(readFixture(STREAM_FIXTURE)) }, resolveKey: () => 'test-key' })
    const i = captured.indexOf('--resume')
    assert.ok(i >= 0 && captured[i + 1] === STREAM_SESSION, JSON.stringify(captured))
    const j = captured.indexOf('--policy')
    assert.ok(j >= 0 && captured[j + 1] === '/p.toml', 'policyFile 明給時優先於 outDir 推導')
    assert.equal(r.conversationId, STREAM_SESSION)
    assert.throws(() => h.write.resume({ model: 'm', prompt: 'fix', cwd: '/w', outDir: '/out', timeoutMs: 1, env, spawn: () => okSpawn(''), resolveKey: () => 'test-key' }), /需要 conversationId/)
  })
  test('④ write.args 純函式：run 忽略 conversationId、resume 帶 resumeId；normalize 對缺欄位的舊物件不炸', () => {
    assert.equal(h.write.args({ model: 'm', prompt: 'p', cwd: '/w', outDir: '/o', timeoutMs: 5, conversationId: 's9' }).resumeId, 's9')
    assert.equal(h.write.args({ model: 'm', prompt: 'p', cwd: '/w', outDir: '/o', timeoutMs: 5 }).outDir, '/o', 'outDir 原樣透傳給 runner')
    const n = h.write.normalize({ exit: 0, stdout: '', stderr: '' })
    assert.deepEqual([n.text, n.denied, n.steps, n.conversationId, n.usage], ['', [], [], null, null])
    assert.deepEqual(n.failure, { kind: 'protocol', code: 'stream:no_result', retryable: false }, 'exit 0 但沒有 result 事件 ⇒ protocol（r3：帶 stream:no_result 碼）')
  })
  test('⑤ resolveKey 回 "" ⇒ 不 spawn、failure auth、keyMissing 只在 raw、輸出不含 key', () => {
    let spawned = false
    const r = h.write.run({ model: 'm', prompt: 'P', cwd: '/w', outDir: '/out', timeoutMs: 1, env, spawn: () => { spawned = true; return okSpawn('') }, resolveKey: () => '' })
    assert.equal(spawned, false)
    assert.deepEqual(r.failure, { kind: 'auth', retryable: false })
    assert.equal(r.raw.keyMissing, true)
    assert.ok(!('keyMissing' in r))
    assert.deepEqual([r.text, r.denied, r.steps, r.conversationId], ['', [], [], null])
    assert.deepEqual(Object.keys(r).sort(), UNIFIED_WRITE_KEYS)
  })
  const resultErr = (type, message, exit = 1) => ({ status: exit, signal: null, stdout: `{"type":"init","session_id":"s1","model":"m"}\n{"type":"result","status":"error","error":{"type":"${type}","message":"${message}"},"stats":{"total_tokens":0}}\n`, stderr: '' })
  const run = (spawnResult) => h.write.run({ model: 'm', prompt: 'P', cwd: '/w', outDir: '/out', timeoutMs: 1, env, spawn: () => spawnResult, resolveKey: () => 'test-key' })
  test('⑥ result.status error：type 含 Auth ⇒ auth（code＝type）；type 含 Quota／訊息含 429／RESOURCE_EXHAUSTED ⇒ quota；其他 ⇒ process（code result:<type>）', () => {
    assert.deepEqual(run(resultErr('FatalAuthenticationError', 'bad key', 41)).failure, { kind: 'auth', code: 'FatalAuthenticationError', retryable: false })
    assert.deepEqual(run(resultErr('QuotaExceededError', 'quota', 1)).failure, { kind: 'quota', code: 'QuotaExceededError', retryable: false })
    assert.equal(run(resultErr('ApiError', 'status 429 RESOURCE_EXHAUSTED', 1)).failure.kind, 'quota')
    assert.equal(run(resultErr('ApiError', 'rate limit exceeded', 0)).failure.kind, 'quota', 'exit 0 也認 result.error')
    assert.deepEqual(run(resultErr('WeirdError', 'boom', 0)).failure, { kind: 'process', code: 'result:WeirdError', retryable: false })
    assert.deepEqual(run(resultErr('WeirdError', 'boom', 1)).failure, { kind: 'process', code: 'exit:1', retryable: false })
    const q = run(resultErr('QuotaExceededError', 'quota', 1))
    assert.equal(q.conversationId, 's1', 'session id 拿得到也不改變 failure')
  })
  test('⑥ denied 非空 ⇒ policy（exit 0、result success）；timeout 先於一切；stderr 429 非零 exit ⇒ quota（classifyFailure）', () => {
    const d = run(okSpawn(readFixture(DENIED_FIXTURE)))
    assert.equal(d.exit, 0)
    assert.deepEqual(d.failure, { kind: 'policy', retryable: false })
    assert.equal(d.denied.length, 1)
    const t = run({ status: null, signal: 'SIGTERM', timedOut: true, stdout: readFixture(DENIED_FIXTURE), stderr: '' })
    assert.deepEqual(t.failure, { kind: 'timeout', retryable: true })
    assert.equal(run({ status: 1, signal: null, stdout: '', stderr: '429 RESOURCE_EXHAUSTED' }).failure.kind, 'quota')
    assert.equal(run({ status: 1, signal: null, stdout: '', stderr: 'boom' }).failure.kind, 'process')
  })
  test('⑥ lastStepIsToolError：最後一個 tool 步有 error 且不是 denied ⇒ true；denied ⇒ false；沒 tool 步 ⇒ false', () => {
    const f = h.write.lastStepIsToolError
    assert.equal(f([{ tool: 'replace', error: 'invalid params', denied: false }]), true)
    assert.equal(f([{ tool: 'run_shell_command', error: 'Tool execution denied by policy.', denied: true }]), false)
    assert.equal(f([{ tool: 'write_file', error: null, denied: false }, { unparsed: 'x' }]), false)
    assert.equal(f([]), false)
    assert.equal(f(undefined), false)
  })
  test('gemini preflight：role write 無 outDir ⇒ [{ok:true,label:policy(toml)}] 不寫檔；有 outDir ⇒ deps.writeFile 收到 <outDir>/gemini-policy.toml 與 config heads 的 TOML；role setup ⇒ []；未知 role ⇒ throw；deps.worktree 不再是接縫', () => {
    const cfg = v2Config()
    const noOut = h.preflight({}, cfg, { repoRoot: '/repo', role: 'write' })
    assert.deepEqual(noOut.map((c) => [c.ok, c.label]), [[true, 'policy(toml)']])
    const writes = []
    const wt = h.preflight({}, cfg, { repoRoot: '/repo', role: 'write', outDir: '/repo/.local/llm-team/t/write/run-1', writeFile: (f, c) => writes.push([f, c]) })
    assert.deepEqual(wt.map((c) => [c.ok, c.label]), [[true, 'policy(toml)']])
    assert.equal(writes.length, 1)
    assert.equal(writes[0][0], '/repo/.local/llm-team/t/write/run-1/gemini-policy.toml')
    assert.equal(writes[0][1], geminiModule.buildGeminiPolicyToml({ allowedHeads: lib.briefCommandHeads(cfg) }))
    assert.ok(writes[0][1].includes('commandPrefix = "npm test"'), 'config.allowCommandHeads 進 policy')
    assert.ok(writes[0][1].includes('commandPrefix = "node --test"'), 'BASE_COMMAND_HEADS 進 policy')
    assert.ok(!writes[0][0].startsWith(os.homedir() + '/.gemini'), '🔴 絕不寫 ~/.gemini/')
    // r2：worktree 不是接縫——只給 worktree 不給 outDir ⇒ 不寫任何檔
    const w2 = []
    h.preflight({}, cfg, { repoRoot: '/repo', role: 'write', worktree: '/repo/.claude/worktrees/t', writeFile: (f, c) => w2.push(f) })
    assert.deepEqual(w2, [], '只給 worktree 不落地（policy 不進 worktree）')
    assert.deepEqual(h.preflight({}, cfg, { role: 'setup', outDir: '/x' }), [])
    assert.deepEqual(h.preflight({}, cfg, {}), [])
    assert.throws(() => h.preflight({}, cfg, { role: 'nope' }), /role 只准 write\|setup/)
    // 真落地（暫存目錄）：mkdir -p 也做
    const tmp = path.join(tmpdir('gemini-out-'), 'write', 'run-1')
    h.preflight({}, cfg, { role: 'write', outDir: tmp })
    assert.ok(fs.existsSync(path.join(tmp, 'gemini-policy.toml')))
  })
})

describe('⑫ gemini 寫手 r3（sol Q3）：parseGeminiStream fail-closed——壞行／tool_use 沒配對／沒 result ⇒ failure protocol，write.mjs G3 判 FAIL 即使正文非空', () => {
  const { parseGeminiStream } = geminiModule
  const h = getHarness('gemini')
  const env = { GEMINI_BIN: '/fake/gemini', PATH: '/x' }
  const run = (stdout) => h.write.run({ model: 'm', prompt: 'P', cwd: '/w', outDir: '/out', timeoutMs: 1, env, spawn: () => okSpawn(stdout), resolveKey: () => 'test-key' })
  test('(a) 任一行 JSON.parse 失敗 ⇒ protocol stream:unparsed_line（steps 仍記 unparsed；正文仍解析得到）', () => {
    const stdout = readFixture(STREAM_FIXTURE).replace('{"type":"tool_result"', '{"type":"tool_result",,,')
    const p = parseGeminiStream(stdout)
    assert.equal(p.protocol, 'unparsed_line')
    assert.ok(p.steps.some((st) => st.unparsed))
    const r = run(stdout)
    assert.deepEqual(r.failure, { kind: 'protocol', code: 'stream:unparsed_line', retryable: false })
    assert.ok(r.text.endsWith('done'), '正文非空——只靠 text 判不出來，所以 G3 要看 failure')
    assert.equal(r.exit, 0)
  })
  test('(b) sol receipt：denied fixture 拿掉 run_shell_command 的 tool_result ⇒ 以前 failure null，現在 protocol stream:unpaired_tool；denied 也空（沒有 tool_result 就沒有被拒證據）', () => {
    const lines = readFixture(DENIED_FIXTURE).split('\n')
    const stripped = lines.filter((l) => !l.includes('"type":"tool_result"') || !l.includes('run_shell_command__call_')).join('\n')
    assert.equal(stripped.split('\n').filter((l) => l.includes('"type":"tool_result"')).length, 1, '只剩 list_directory 那個 tool_result')
    const p = parseGeminiStream(stripped)
    assert.equal(p.protocol, 'unpaired_tool')
    assert.deepEqual(p.denied, [])
    assert.deepEqual(p.steps.filter((st) => st.tool).map((st) => [st.tool, st.status]), [['list_directory', 'success'], ['run_shell_command', null]])
    const r = run(stripped)
    assert.deepEqual(r.failure, { kind: 'protocol', code: 'stream:unpaired_tool', retryable: false })
    assert.ok(r.text.trim(), '正文非空、exit 0、denied 空——r2 以前這會被 G3 放行')
    // 對照：完整 denied fixture 是 policy 不是 protocol；完整 stream fixture 是 null
    assert.equal(run(readFixture(DENIED_FIXTURE)).failure.kind, 'policy')
    assert.equal(run(readFixture(STREAM_FIXTURE)).failure, null)
    assert.equal(parseGeminiStream(readFixture(STREAM_FIXTURE)).protocol, null)
  })
  test('(c) 沒有 result 事件 ⇒ protocol stream:no_result；優先序 unparsed_line ＞ unpaired_tool ＞ no_result；非零 exit 不套 stream 檢查（process／quota 碼更有用）；timeout／auth／policy 仍先', () => {
    const noResult = readFixture(STREAM_FIXTURE).split('\n').filter((l) => !l.includes('"type":"result"')).join('\n')
    assert.equal(parseGeminiStream(noResult).protocol, 'no_result')
    assert.deepEqual(run(noResult).failure, { kind: 'protocol', code: 'stream:no_result', retryable: false })
    const both = noResult.split('\n').filter((l) => !l.includes('"type":"tool_result"')).join('\n')
    assert.equal(parseGeminiStream(both).protocol, 'unpaired_tool', 'unpaired 先於 no_result')
    assert.equal(parseGeminiStream(both + '\nnot json').protocol, 'unparsed_line', 'unparsed 先於一切')
    assert.equal(parseGeminiStream('').protocol, 'no_result')
    const killed = h.write.run({ model: 'm', prompt: 'P', cwd: '/w', outDir: '/out', timeoutMs: 1, env, spawn: () => ({ status: 137, signal: null, stdout: both, stderr: '' }), resolveKey: () => 'test-key' })
    assert.deepEqual(killed.failure, { kind: 'process', code: 'exit:137', retryable: false })
    const t = h.write.run({ model: 'm', prompt: 'P', cwd: '/w', outDir: '/out', timeoutMs: 1, env, spawn: () => ({ status: null, signal: 'SIGTERM', timedOut: true, stdout: both, stderr: '' }), resolveKey: () => 'test-key' })
    assert.equal(t.failure.kind, 'timeout')
    const deniedNoResult = readFixture(DENIED_FIXTURE).split('\n').filter((l) => !l.includes('"type":"result"')).join('\n')
    assert.equal(run(deniedNoResult).failure.kind, 'policy', 'policy 先於 protocol')
  })
})

describe('⑫ gemini 寫手 ⑦：codex stderr usage limit／rate limit ⇒ failure quota（09-22 事故：以前只顯示零輸出）', () => {
  const h = getHarness('codex')
  const env = { CODEX_BIN: '/fake/codex', PATH: '/x' }
  const run = (spawnResult) => h.review.run({ model: 'm', prompt: 'P', cwd: process.cwd(), timeoutMs: 1, env, spawn: async () => spawnResult })
  test('stderr「You\'ve hit your usage limit」⇒ quota（retryable:true；exit 0／1、text 空／非空都算——統整者 r2 裁定）；rate limit 同；裸 429 走既有 classifyFailure', async () => {
    const stderr = "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:55 PM."
    const a = await run({ status: 1, signal: null, stdout: '', stderr })
    assert.deepEqual(a.failure, { kind: 'quota', code: 'usage limit', retryable: true })
    const b = await run({ status: 0, signal: null, stdout: '', stderr })
    assert.deepEqual(b.failure, { kind: 'quota', code: 'usage limit', retryable: true }, 'exit 0 零輸出＋usage limit 也是 quota')
    const c = await run({ status: 0, signal: null, stdout: '', stderr: 'Rate limit reached, retry later' })
    assert.equal(c.failure.kind, 'quota')
    const d = await run({ status: 0, signal: null, stdout: '整份：簽', stderr })
    assert.deepEqual(d.failure, { kind: 'quota', code: 'usage limit', retryable: true }, 'sol Q5／統整者 r2：命中字樣就是額度事件，不看 text')
    assert.equal(codexModule.codexQuotaHit('nothing'), null)
    assert.equal(codexModule.codexQuotaHit('HTTP 429'), null, '裸 429 不歸這裡')
    assert.equal((await run({ status: 0, signal: null, stdout: '', stderr: 'HTTP 429' })).failure, null, '裸 429＋exit 0 ⇒ classifyFailure 既有行為（null）')
    // 既有 ⑨ 的字面不變：非零 exit＋429 RESOURCE_EXHAUSTED ⇒ quota、retryable:false
    const e = await run({ status: 1, signal: null, stdout: '', stderr: '429 RESOURCE_EXHAUSTED' })
    assert.equal(e.failure.kind, 'quota')
    assert.equal(e.failure.retryable, false)
    assert.equal((await run({ status: 1, signal: null, stdout: '', stderr: 'boom' })).failure.kind, 'process')
  })
  test('陽性對照：council runOne 把 failure 帶進 members.json（codex 額度用盡 ⇒ empty:true 且 failure.kind quota）', async () => {
    const repo = makeRepo(v2Config({ reviewers: [M.codexSol] }))
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'b')
    const outDir = path.join(tmpdir('review-'), 'review')
    const real = getHarness('codex')
    const fake = { ...real, review: { ...real.review, run: async (opts) => real.review.normalize({ exit: 1, signal: null, timedOut: false, stdout: '', stderr: "ERROR: You've hit your usage limit." }) } }
    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await councilMain(['review', '--coordinator', 'claude', '--worktree', repo.dir, '--base', 'main', '--brief', brief, '--tier', 'standard', '--out', outDir], { env: NO_BIN_ENV, getHarness: (n) => (n === 'codex' ? fake : getHarness(n)) })
    } finally {
      console.log = origLog
    }
    assert.equal(code, 3, '零輸出判定不變 ⇒ 3')
    const members = JSON.parse(fs.readFileSync(path.join(outDir, 'members.json'), 'utf8'))
    assert.equal(members[0].empty, true)
    assert.deepEqual(members[0].failure, { kind: 'quota', code: 'usage limit', retryable: true })
  })
})

describe('⑫ gemini 寫手 ⑧：config.writer 陣列——validateWriter 逐席驗、writerFrom 選席', () => {
  const seats = [
    { harness: 'agy', model: 'gemini-3.8-flash-high', quotaBucket: 'gemini' },
    { harness: 'gemini', model: 'gemini-3.8-flash', quotaBucket: 'gemini-api' },
  ]
  const cfg = ({ ...v2Config(), writer: seats })
  test('預設第 0 席；env LLM_TEAM_WRITER_HARNESS 選席；opts.harness（--writer-harness）優先於 env；LLM_TEAM_WRITER 只覆寫選中那席的 model', () => {
    assert.deepEqual(lib.writerFrom(cfg, {}), seats[0])
    assert.deepEqual(lib.writerFrom(cfg, { LLM_TEAM_WRITER_HARNESS: 'gemini' }), seats[1])
    assert.deepEqual(lib.writerFrom(cfg, { LLM_TEAM_WRITER_HARNESS: 'gemini' }, { harness: 'agy' }), seats[0])
    assert.deepEqual(lib.writerFrom(cfg, { LLM_TEAM_WRITER: 'x' }, { harness: 'gemini' }), { ...seats[1], model: 'x' })
    assert.equal(lib.writerFrom(cfg, { LLM_TEAM_WRITER: 'x' }).harness, 'agy')
    assert.notEqual(lib.writerFrom(cfg, {}), seats[0], '回的是副本')
    // 單物件 config 行為不變
    assert.deepEqual(lib.writerFrom(v2Config(), {}), v2Config().writer)
    assert.deepEqual(lib.writerSeats(v2Config()), [v2Config().writer])
    assert.deepEqual(lib.writerSeats(cfg), seats)
    assert.deepEqual(lib.writerFrom(cfg, {}).timeoutMs, undefined)
    assert.equal(lib.writerFrom(({ ...v2Config(), writer: [{ ...seats[0], timeoutMs: 7 }, seats[1]] }), {}).timeoutMs, 7, '選中那席的 timeoutMs 跟著出來')
  })
  test('未知席 ⇒ throw 列清單（--writer-harness／env 都一樣）；modelsFrom 也走同一條', () => {
    assert.throws(() => lib.writerFrom(cfg, {}, { harness: 'codex' }), /寫手席 "codex" 不在 config\.writer.*可用：agy\/gemini-3\.8-flash-high, gemini\/gemini-3\.8-flash/)
    assert.throws(() => lib.writerFrom(cfg, { LLM_TEAM_WRITER_HARNESS: 'nope' }), /寫手席 "nope" 不在 config\.writer/)
    assert.equal(lib.modelsFrom(cfg, { LLM_TEAM_WRITER_HARNESS: 'gemini' }, 'claude').writer.harness, 'gemini')
    assert.throws(() => lib.modelsFrom(cfg, { LLM_TEAM_WRITER_HARNESS: 'nope' }, 'claude'), /寫手席 "nope"/)
    // 單物件 config 指定一個不是它的席 ⇒ 一樣 throw（不會靜默退回）
    assert.throws(() => lib.writerFrom(v2Config(), {}, { harness: 'gemini' }), /寫手席 "gemini" 不在 config\.writer.*可用：agy\/gemini-3\.8-flash-high/)
  })
  test('validateWriter：非 canWrite 席（codex／claude）被拒並指名 writer[i]；空陣列拒；同 harness 兩席拒；loadConfig 對陣列 config 也過', () => {
    assert.equal(lib.validateWriter(seats), true)
    assert.throws(() => lib.validateWriter([seats[0], M.codexSol]), /writer\[1\]\.harness 只准 agy\|gemini.*得到 "codex"/)
    assert.throws(() => lib.validateWriter([M.claudeCode]), /writer\[0\]\.harness 只准 agy\|gemini/)
    assert.throws(() => lib.validateWriter([]), /writer 陣列不可為空/)
    assert.throws(() => lib.validateWriter([seats[0], { ...seats[0], model: 'other' }]), /writer\[1\]\.harness "agy" 重複/)
    assert.throws(() => lib.validateWriter([seats[0], { harness: 'gemini', model: 'm', quotaBucket: 'nope' }]), /writer\[1\]\.quotaBucket 未知/)
    assert.throws(() => lib.validateWriter([seats[0], 'gemini']), /writer\[1\] 必須是成員物件/)
    const repo = makeRepo(cfg)
    const loaded = lib.loadConfig(repo.dir)
    assert.deepEqual(loaded.writer, seats)
    assert.throws(() => lib.writerFrom({ writer: [seats[0], M.codexSol] }, {}), /writer\[1\]\.harness 只准/)
  })
  test('真源 config.json 的 writer 就是 [agy/gemini-3.8-flash-high〔gemini〕, gemini/gemini-3.8-flash〔gemini-api〕] 且過 validateWriter', () => {
    const tpl = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'))
    assert.deepEqual(tpl.writer, seats)
    assert.equal(lib.validateWriter(tpl.writer), true)
    assert.deepEqual(lib.nextWriterSeat(tpl, 'agy'), seats[1])
    assert.equal(lib.nextWriterSeat(tpl, 'gemini'), null)
    assert.equal(lib.nextWriterSeat(v2Config(), 'agy'), null)
    assert.equal(lib.nextWriterSeat(tpl, 'codex'), null)
  })
})

describe('⑫ gemini 寫手 ⑨：write.mjs 用假 gemini harness 走完 G0–G6；policy TOML 被 G4 忽略；續輪帶 session id', () => {
  const seats = [
    { harness: 'agy', model: 'gemini-3.8-flash-high', quotaBucket: 'gemini' },
    { harness: 'gemini', model: 'gemini-3.8-flash', quotaBucket: 'gemini-api' },
  ]
  function runWrite({ fake, args = [], extraDeps = {}, cfg = ({ ...v2Config(), writer: seats }) }) {
    const repo = makeRepo(cfg)
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'do')
    const outDir = path.join(tmpdir('out-'), 'write')
    const errs = []
    const logs = []
    const origErr = console.error
    const origLog = console.log
    console.error = (m) => errs.push(String(m))
    console.log = (m) => logs.push(String(m))
    let code
    try {
      code = writeMain(['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir, ...args], { getHarness: (n) => (n === 'gemini' && fake ? fake : getHarness(n)), ...extraDeps })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    return { code, errs: errs.join('\n'), logs: logs.join('\n'), repo, outDir }
  }
  const real = getHarness('gemini')
  /** 假 write：走真 preflight（落地 TOML）、真 normalize（吃 fixture）；只有 spawn 是假的。 */
  function fakeWithSpawn(spawnImpl) {
    const calls = []
    const fake = {
      ...real,
      write: {
        ...real.write,
        run: (o) => { calls.push({ kind: 'run', ...o }); return real.write.run({ ...o, spawn: (b, a, opts) => spawnImpl('run', o, a, opts), resolveKey: () => 'test-key', env: { GEMINI_BIN: '/fake/gemini', PATH: '/x' } }) },
        resume: (o) => { calls.push({ kind: 'resume', ...o }); return real.write.run === undefined ? null : real.write.resume({ ...o, spawn: (b, a, opts) => spawnImpl('resume', o, a, opts), resolveKey: () => 'test-key', env: { GEMINI_BIN: '/fake/gemini', PATH: '/x' } }) },
      },
    }
    return { fake, calls }
  }
  test('--writer-harness gemini ⇒ G2 把 policy 寫到 <outDir>/gemini-policy.toml（不進 worktree）、寫手改 add.test.mjs ⇒ exit 0；worktree git status 只有 add.test.mjs；台帳 changed 只有 add.test.mjs、tool 欄不變、failure 不落地；write.run 收到 outDir', () => {
    const { fake, calls } = fakeWithSpawn((kind, o, args, opts) => {
      fs.writeFileSync(path.join(o.cwd, 'add.test.mjs'), 't')
      return okSpawn(readFixture(STREAM_FIXTURE))
    })
    const r = runWrite({ fake, args: ['--writer-harness', 'gemini'] })
    assert.equal(r.code, 0, r.errs)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].kind, 'run')
    assert.equal(calls[0].model, 'gemini-3.8-flash', '選中 gemini 席的 model')
    assert.equal(calls[0].cwd, r.repo.dir)
    assert.equal(calls[0].outDir, r.outDir, 'write.mjs 把 outDir 交給 write.run')
    assert.ok(calls[0].prompt.startsWith(lib.WRITER_PROMPT_SENTINEL))
    const toml = path.join(r.outDir, 'gemini-policy.toml')
    assert.ok(fs.existsSync(toml), 'G2 要把 policy 寫進 outDir')
    assert.ok(fs.readFileSync(toml, 'utf8').includes('commandPrefix = "npm test"'))
    assert.equal(fs.existsSync(path.join(r.repo.dir, '.gemini')), false, '🔴 worktree 裡不准出現 .gemini（r2：落在 worktree 會污染 changed、擋 land）')
    const status = r.repo.g('status', '--porcelain').trim().split('\n').filter(Boolean)
    assert.deepEqual(status.map((l) => l.slice(3)), ['add.test.mjs'], 'worktree 只多寫手改的那個檔')
    const ledger = fs.readFileSync(path.join(r.outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(ledger.at(-1).verdict, 'PASS_no_test')
    assert.deepEqual(ledger.at(-1).changed, ['add.test.mjs'])
    assert.deepEqual(ledger.at(-1).outOfScope, [])
    assert.equal(ledger.at(-1).conversationId, STREAM_SESSION)
    assert.equal(ledger.at(-1).tool, 'agy-write', '台帳 tool 欄字面不變')
    assert.ok(!('failure' in ledger.at(-1)), 'failure null 不落地')
    assert.equal(ledger.at(-1).usage.tool_calls, 1)
    assert.ok(fs.existsSync(path.join(r.outDir, 'round-1.stdout.ndjson')))
  })
  test('陽性對照（r2）：假 preflight 把 policy 改寫進 worktree ⇒ G4 越界 FAIL_scope、exit 3——證明 G4 對 policy 沒有特例、只有 outDir 這條路是乾淨的', () => {
    const { fake } = fakeWithSpawn((kind, o) => { fs.writeFileSync(path.join(o.cwd, 'add.test.mjs'), 't'); return okSpawn(readFixture(STREAM_FIXTURE)) })
    const leaky = { ...fake, preflight: (env, config, d) => real.preflight(env, config, { ...d, outDir: path.join(d.repoRoot, '.claude') }) }
    // repoRoot ＝ worktree（makeRepo 的 feat/x 分支就在主 checkout），所以 policy 會落在 worktree 的 .claude/ 底下
    const r = runWrite({ fake: leaky, args: ['--writer-harness', 'gemini'] })
    assert.equal(r.code, 3)
    assert.match(r.errs, /🔴 G4 第 1 輪：越界檔/)
    assert.match(r.errs, /\.claude\/gemini-policy\.toml/)
  })
  test('--test 第 1 輪紅 ⇒ resume 帶 conversationId＝fixture 的 session_id、args 含 --resume；第 2 輪綠 ⇒ exit 0、台帳兩筆', () => {
    let round = 0
    const { fake, calls } = fakeWithSpawn((kind, o, args) => {
      fs.writeFileSync(path.join(o.cwd, 'add.test.mjs'), `round${++round}`)
      return okSpawn(readFixture(STREAM_FIXTURE))
    })
    let tests = 0
    const r = runWrite({ fake, args: ['--writer-harness', 'gemini', '--test', 'x'], extraDeps: { runTest: () => (++tests === 1 ? { exit: 1, out: 'red' } : { exit: 0, out: 'green' }) } })
    assert.equal(r.code, 0, r.errs)
    assert.deepEqual(calls.map((c) => c.kind), ['run', 'resume'])
    assert.equal(calls[1].conversationId, STREAM_SESSION)
    assert.match(calls[1].prompt, /第 2 輪/)
    const ledger = fs.readFileSync(path.join(r.outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(ledger.map((e) => e.verdict), ['RED', 'PASS'])
  })
  test('policy denied fixture ⇒ G3 FAIL_headless、exit 3、台帳 failure.kind policy、stderr 印 failure=policy（exit 0 也算失敗）', () => {
    const { fake } = fakeWithSpawn(() => okSpawn(readFixture(DENIED_FIXTURE)))
    const r = runWrite({ fake, args: ['--writer-harness', 'gemini'] })
    assert.equal(r.code, 3)
    assert.match(r.errs, /🔴 G3 第 1 輪：gemini 無頭中止（exit=0，denied=\[\{"action":"policy","tool":"run_shell_command"/)
    assert.match(r.errs, /failure=policy/)
    const last = JSON.parse(fs.readFileSync(path.join(r.outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').at(-1))
    assert.equal(last.verdict, 'FAIL_headless')
    assert.deepEqual(last.failure, { kind: 'policy', retryable: false })
  })
  test('額度用盡（result.error Quota、沒 init）⇒ FAIL_conversation_id、exit 3、台帳 failure.kind quota（ticket 靠這筆印下一席）', () => {
    const { fake } = fakeWithSpawn(() => ({ status: 1, signal: null, stdout: '{"type":"result","status":"error","error":{"type":"QuotaExceededError","message":"429 RESOURCE_EXHAUSTED"}}\n', stderr: '' }))
    const r = runWrite({ fake, args: ['--writer-harness', 'gemini'] })
    assert.equal(r.code, 3)
    assert.match(r.errs, /拿不到 conversation id.*failure=quota:QuotaExceededError/)
    const last = JSON.parse(fs.readFileSync(path.join(r.outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').at(-1))
    assert.equal(last.verdict, 'FAIL_conversation_id')
    assert.equal(last.failure.kind, 'quota')
  })
  test('沒給 --writer-harness ⇒ 第 0 席 agy（真 agy preflight 讀 AGY_SETTINGS 不存在 ⇒ G2 擋）；--writer-harness nope ⇒ exit 2 列清單；env LLM_TEAM_WRITER_HARNESS=gemini ⇒ 走 gemini 席', () => {
    const { fake, calls } = fakeWithSpawn((k, o) => { fs.writeFileSync(path.join(o.cwd, 'add.test.mjs'), 't'); return okSpawn(readFixture(STREAM_FIXTURE)) })
    const saved = { AGY_SETTINGS: process.env.AGY_SETTINGS, W: process.env.LLM_TEAM_WRITER_HARNESS }
    process.env.AGY_SETTINGS = '/nope/settings.json'
    delete process.env.LLM_TEAM_WRITER_HARNESS
    try {
      const a = runWrite({ fake })
      assert.equal(a.code, 2)
      assert.match(a.errs, /🔴 G2：agy settings 不存在：\/nope\/settings\.json/)
      assert.equal(calls.length, 0)
      const b = runWrite({ fake, args: ['--writer-harness', 'nope'] })
      assert.equal(b.code, 2)
      assert.match(b.errs, /寫手席 "nope" 不在 config\.writer.*可用：agy\/gemini-3\.8-flash-high, gemini\/gemini-3\.8-flash/)
      process.env.LLM_TEAM_WRITER_HARNESS = 'gemini'
      const c = runWrite({ fake })
      assert.equal(c.code, 0, c.errs)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].model, 'gemini-3.8-flash')
    } finally {
      if (saved.AGY_SETTINGS === undefined) delete process.env.AGY_SETTINGS
      else process.env.AGY_SETTINGS = saved.AGY_SETTINGS
      if (saved.W === undefined) delete process.env.LLM_TEAM_WRITER_HARNESS
      else process.env.LLM_TEAM_WRITER_HARNESS = saved.W
    }
  })
  test('r3 (b)：假 spawn 回「拿掉 tool_result 的 denied fixture」（exit 0、正文非空、denied 空）⇒ G3 FAIL_headless、exit 3、stderr 印 failure=protocol:stream:unpaired_tool、台帳 failure', () => {
    const stripped = readFixture(DENIED_FIXTURE).split('\n').filter((l) => !l.includes('"type":"tool_result"') || !l.includes('run_shell_command__call_')).join('\n')
    const { fake } = fakeWithSpawn((k, o) => { fs.writeFileSync(path.join(o.cwd, 'add.test.mjs'), 't'); return okSpawn(stripped) })
    const r = runWrite({ fake, args: ['--writer-harness', 'gemini'] })
    assert.equal(r.code, 3)
    assert.match(r.errs, /🔴 G3 第 1 輪：gemini 無頭中止（exit=0，denied=\[\]，response \d+ 字，failure=protocol:stream:unpaired_tool）/)
    const last = JSON.parse(fs.readFileSync(path.join(r.outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').at(-1))
    assert.equal(last.verdict, 'FAIL_headless')
    assert.deepEqual(last.failure, { kind: 'protocol', code: 'stream:unpaired_tool', retryable: false })
  })
  test('r3 sol Q2：裸 --writer-harness／--writer-harness "" ⇒ exit 2「🔴 --writer-harness 需要席名（可用：agy、gemini）」、不落第 0 席、write.run 0 次；writerFrom 對 true／"" 也 throw', () => {
    const { fake, calls } = fakeWithSpawn(() => okSpawn(readFixture(STREAM_FIXTURE)))
    const a = runWrite({ fake, args: ['--writer-harness'] })
    assert.equal(a.code, 2)
    assert.match(a.errs, /^🔴 --writer-harness 需要席名（可用：agy、gemini）$/m)
    const b = runWrite({ fake, args: ['--writer-harness', ''] })
    assert.equal(b.code, 2)
    assert.match(b.errs, /--writer-harness 需要席名/)
    assert.equal(calls.length, 0)
    assert.throws(() => lib.writerFrom({ ...v2Config(), writer: seats }, {}, { harness: true }), /--writer-harness 需要席名（可用：agy、gemini）/)
    assert.throws(() => lib.writerFrom({ ...v2Config(), writer: seats }, {}, { harness: '' }), /--writer-harness 需要席名/)
    assert.throws(() => lib.writerFrom({ ...v2Config(), writer: seats }, {}, { harness: '  ' }), /--writer-harness 需要席名/)
    assert.equal(lib.writerHarnessArgError(undefined, v2Config()), null)
    assert.equal(lib.writerHarnessArgError('gemini', v2Config()), null, '席名合法性由 writerFrom 查 config，這裡只驗「有沒有給」')
    assert.equal(lib.writerHarnessArgError(true, v2Config()), '--writer-harness 需要席名（可用：agy）')
    assert.equal(lib.writerFrom({ ...v2Config(), writer: seats }, { LLM_TEAM_WRITER_HARNESS: '' }).harness, 'agy', 'env 空字串 ＝ 沒設（不是 CLI 旗標，不拒）')
  })
  test('r4（sol r3 Q2）完整寫手流程：假 spawn 回 init（session id）＋assistant 正文非空＋exit 0＋result.status error（quota）⇒ 過 conversation-id 檢查後 G3 FAIL_headless、exit 3、stderr failure=quota:QuotaExceededError、台帳 failure quota（不是只擋 protocol）', () => {
    const stdout = [
      '{"type":"init","session_id":"sess-quota","model":"m"}',
      '{"type":"message","role":"assistant","content":"我改好了 add.test.mjs","delta":true}',
      '{"type":"result","status":"error","error":{"type":"QuotaExceededError","message":"Resource has been exhausted (e.g. check quota)."},"stats":{"total_tokens":1}}',
    ].join('\n') + '\n'
    const { fake } = fakeWithSpawn((k, o) => { fs.writeFileSync(path.join(o.cwd, 'add.test.mjs'), 't'); return okSpawn(stdout) })
    const r = runWrite({ fake, args: ['--writer-harness', 'gemini'] })
    assert.equal(r.code, 3)
    assert.match(r.errs, /🔴 G3 第 1 輪：gemini 無頭中止（exit=0，denied=\[\]，response \d+ 字，failure=quota:QuotaExceededError）/)
    const ledger = fs.readFileSync(path.join(r.outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].verdict, 'FAIL_headless')
    assert.equal(ledger[0].conversationId, 'sess-quota', '有 session id，所以是走到 G3 而不是 FAIL_conversation_id')
    assert.deepEqual(ledger[0].failure, { kind: 'quota', code: 'QuotaExceededError', retryable: false })
    assert.equal(ledger[0].responseChars > 0, true, '正文非空——r3 的 G3 會放行這種形狀')
  })
  test('假 gemini harness canWrite:false ⇒ exit 2「writer.harness 只准 agy|gemini」（registry 再驗一次）', () => {
    const r = runWrite({ fake: { ...real, canWrite: false }, args: ['--writer-harness', 'gemini'] })
    assert.equal(r.code, 2)
    assert.match(r.errs, /writer\.harness 只准 agy\|gemini/)
  })
})

describe('⑫ gemini 寫手 ⑫：靜態——ticket.mjs 也不准認 harness 名字；write.mjs/ticket.mjs 都不 import agy 專屬的 assertSettingsAllowRegex', () => {
  test('ticket.mjs 剝註解後不含 harness === \'／harness !== \'；不再 import assertSettingsAllowRegex', () => {
    const src = fs.readFileSync(path.join(HERE, 'ticket.mjs'), 'utf8')
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    assert.ok(!stripped.includes("harness === '"))
    assert.ok(!stripped.includes("harness !== '"))
    assert.ok(!stripped.includes('assertSettingsAllowRegex'), 'G2 走 registry preflight，不直接叫 agy 的對帳函式')
    assert.ok(stripped.includes("getHarness(writer.harness)") || stripped.includes('getHarnessFn(writer.harness)'), 'G2 用 writer.harness 查 registry')
  })
  test('r2 靜態：write.mjs／ticket.mjs／gemini.mjs 剝註解後都不含 `.gemini/policies`、write.mjs isIgnored 沒有 .gemini 特例、write.run／resume／preflight 都收到 outDir', () => {
    const strip = (f) => fs.readFileSync(path.join(HERE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    for (const f of ['write.mjs', 'ticket.mjs', 'harnesses/gemini.mjs']) {
      assert.ok(!strip(f).includes('.gemini/policies'), `${f} 不得再提 .gemini/policies（policy 住 outDir）`)
      assert.ok(!strip(f).includes("'.gemini'"), `${f} 不得再拼 .gemini 路徑`)
    }
    const w = strip('write.mjs')
    assert.ok(!w.includes(".gemini"), 'G4 isIgnored 沒有 .gemini 特例')
    assert.match(w, /role: 'write', outDir \}/, 'preflight 收到 outDir')
    assert.match(w, /h\.write\.run\(\{ model, prompt, cwd: worktree, timeoutMs, outDir \}\)/)
    assert.match(w, /h\.write\.resume\(\{ model, prompt, cwd: worktree, timeoutMs, conversationId, outDir \}\)/)
    const g = strip('harnesses/gemini.mjs')
    assert.ok(!/homedir\(\)/.test(g))
    assert.ok(!/env\.HOME/.test(g))
    assert.ok(g.includes("export const GEMINI_POLICY_FILE = 'gemini-policy.toml'"))
  })
})
