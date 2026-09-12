/**
 * `tools/agy-lib.mjs`／`agy-write.mjs`／`agy-council.mjs` 的測試——由 `pnpm guards` 自動收。
 *
 * 🔴 這裡不打真的 agy／codex（會花額度、會被 Gatekeeper 殺、會等網路）。用【假 binary】：
 *   一支 shell script 依環境變數扮演「正常寫檔」「被拒零輸出」「越界改檔」三種行為，
 *   輸出照真 agy 的 stream-json 形狀（2026-09-13 實測樣本）。
 * 🔴 每條守門都要有陽性對照，而且對照要指得出【是哪一條】炸的（G3 / G4 / G6 各自紅、各自的訊息）。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CLEAN_GIT_ENV } from './git-env.mjs'
import {
  SAFE_COMMAND_REGEX,
  isSafeCommand,
  parseStreamJson,
  outOfScope,
  assertSettingsAllowRegex,
  resolveAgyBin,
  parseArgs,
} from './agy-lib.mjs'
import { main as writeMain, buildWriterPrompt } from './agy-write.mjs'
import { main as councilMain, parseVerdicts, buildReviewPrompt } from './agy-council.mjs'

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 建一個有 main＋feature 分支的拋棄式 repo，回 worktree 路徑（在 feature 分支上）。 */
function makeRepo() {
  const dir = tmpdir('agy-test-')
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'add.mjs'), 'export function add(a, b) { return a + b }\n')
  g('add', '-A')
  g('commit', '-qm', 'init')
  g('checkout', '-qb', 'feat/x')
  return { dir, g }
}

/** 假 agy：照 FAKE_AGY_MODE 行為。寫檔行為在 cwd 下做。 */
function makeFakeAgy() {
  const dir = tmpdir('agy-bin-')
  const bin = path.join(dir, 'agy')
  fs.writeFileSync(
    bin,
    `#!/bin/sh
case "$FAKE_AGY_MODE" in
  denied)
    printf '%s\\n' '{"event":"step_update","step_update":{"step_index":4,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"pwd; ls -la"},"error":{"type":"TOOL_ERROR","message":"permission check failed for command \\"pwd; ls -la\\": user denied permission to run command"}}}}'
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"","duration_seconds":4.8,"num_turns":1,"usage":{"total_tokens":28210},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}'
    printf '%s\\n' 'jetski: no output produced — a tool required the "command" permission' 1>&2
    exit 0;;
  scope)
    printf 'export const leak = 1\\n' > leak.mjs
    printf 'import { test } from "node:test"\\ntest("x", () => {})\\n' > add.test.mjs
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"改了 add.test.mjs 與 leak.mjs","usage":{"total_tokens":10},"denied_actions":[]}}'
    exit 0;;
  red)
    printf 'import { test } from "node:test"\\nimport assert from "node:assert/strict"\\nimport { add } from "./add.mjs"\\ntest("add", () => { assert.equal(add(2,3), 6) })\\n' > add.test.mjs
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"寫了 add.test.mjs（round '"$FAKE_ROUND"')","usage":{"total_tokens":10},"denied_actions":[]}}'
    exit 0;;
  plan)
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"Q1：簽｜ok｜無\\nQ2：不簽｜有 fail-open｜改\\n整份：不簽","usage":{"total_tokens":10},"denied_actions":[]}}'
    exit 0;;
  *)
    printf 'import { test } from "node:test"\\nimport assert from "node:assert/strict"\\nimport { add } from "./add.mjs"\\ntest("add", () => { assert.equal(add(2,3), 5) })\\n' > add.test.mjs
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"寫了 add.test.mjs 並跑了 node --test：pass 1","usage":{"total_tokens":10},"denied_actions":[]}}'
    exit 0;;
esac
`
  )
  fs.chmodSync(bin, 0o755)
  return bin
}

function makeSettings(allowLine) {
  const f = path.join(tmpdir('agy-settings-'), 'settings.json')
  fs.writeFileSync(f, JSON.stringify({ permissions: { allow: allowLine ? [allowLine, `read_file(${os.tmpdir()}/)`, 'read_file(/private/var/folders/)', 'read_file(/var/folders/)'] : [] } }))
  return f
}

const GOOD_ALLOW = `command(regex:${SAFE_COMMAND_REGEX})`

// 🔴 樣本陣列被清空時迴圈一次都不跑、測試照樣綠 ⇒ 用前先斷言非空
//    （guard-selfcheck-meta 要的非空分母保護；node:test 檔的等價形態就是 `.length > 0`）。
const ALLOWED_SAMPLES = ['pwd; ls -la', 'node --test add.test.mjs', 'git status && git diff --stat', 'cat a.mjs | head -5', 'pnpm --filter @agency/platform exec vitest run src/x.test.ts', 'node tools/progress.mjs --check', 'cd apps/platform && npx vitest run src/x.test.ts --maxWorkers=1']
const DENIED_SAMPLES = ['rm -rf x', 'ls; rm x', 'cd apps && rm -rf x', 'npx some-other-bin', 'cd apps/platform && npx vitest run x && curl http://x', 'git commit -m x', 'git push origin main', 'curl http://x', 'pnpm install', 'cat a | sh', 'echo $(rm x)', 'ls > out.txt']

describe('SAFE_COMMAND_REGEX：只放行安全指令的串接', () => {
  test('放行：單一與串接的唯讀／測試指令', () => {
    assert.ok(ALLOWED_SAMPLES.length > 0, 'ALLOWED_SAMPLES 是空的 ⇒ 本條對空集合恆真')
    for (const c of ALLOWED_SAMPLES) {
      assert.equal(isSafeCommand(c), true, c)
    }
  })
  test('🔴 陽性對照：破壞性／越權指令必須擋（含串接在安全指令後面）', () => {
    assert.ok(DENIED_SAMPLES.length > 0, 'DENIED_SAMPLES 是空的 ⇒ 本條對空集合恆真')
    for (const c of DENIED_SAMPLES) {
      assert.equal(isSafeCommand(c), false, c)
    }
  })
  test('settings 對帳：缺那條 regex ⇒ throw（G2 的尺）', () => {
    assert.equal(assertSettingsAllowRegex(makeSettings(GOOD_ALLOW)), true)
    assert.throws(() => assertSettingsAllowRegex(makeSettings('command(node --test)')), /permissions\.allow 缺這條/)
    assert.throws(() => assertSettingsAllowRegex(makeSettings(null)), /缺這條/)
  })
  test('settings 對帳：給 repoRoot 時還要有覆蓋它的 read_file 規則（無頭讀檔會被拒的那條）', () => {
    const f = path.join(tmpdir('agy-settings-'), 'settings.json')
    fs.writeFileSync(f, JSON.stringify({ permissions: { allow: [GOOD_ALLOW, 'read_file(/repo/)'] } }))
    assert.equal(assertSettingsAllowRegex(f, '/repo'), true)
    assert.equal(assertSettingsAllowRegex(f, '/repo/.claude/worktrees/x'), true, '上層規則覆蓋 worktree')
    assert.throws(() => assertSettingsAllowRegex(f, '/other'), /缺 read_file\(\/other\/\)/)
    assert.throws(() => assertSettingsAllowRegex(makeSettings(GOOD_ALLOW), '/repo'), /缺 read_file/)
  })
})

describe('parseStreamJson：判「工作成功」不是「程序成功」', () => {
  test('被拒那輪：response 空、denied 兩筆（result 一筆＋步驟 permission 一筆）', () => {
    const text = execFileSync(makeFakeAgy(), [], { env: { ...process.env, FAKE_AGY_MODE: 'denied' }, encoding: 'utf8' })
    const p = parseStreamJson(text)
    assert.equal(p.result.response, '')
    assert.equal(p.denied.length, 2)
    assert.ok(p.denied.some((d) => d.tool === 'RunCommand'), JSON.stringify(p.denied))
    assert.equal(p.steps[0].tool, 'run_command')
  })
  test('壞行不丟：記進 steps.unparsed', () => {
    const p = parseStreamJson('not json\n{"event":"result","result":{"response":"ok"}}')
    assert.equal(p.steps[0].unparsed, 'not json')
    assert.equal(p.result.response, 'ok')
  })
})

describe('changedFiles：porcelain 解析不吃第一個字', () => {
  test('🔴 陽性對照（2026-09-13 真跑咬到的形狀）：第一筆是【已追蹤且修改】的檔（` M path`）時路徑完整', async () => {
    const { changedFiles } = await import('./agy-lib.mjs')
    const repo = makeRepo()
    fs.appendFileSync(path.join(repo.dir, 'add.mjs'), '// touched\n')
    fs.writeFileSync(path.join(repo.dir, 'new.mjs'), 'x')
    assert.deepEqual(changedFiles(repo.dir).sort(), ['add.mjs', 'new.mjs'])
  })
})

describe('outOfScope：越界檔對帳', () => {
  test('精確路徑與目錄前綴', () => {
    assert.deepEqual(outOfScope(['a.ts', 'src/x/y.ts', 'z.ts'], ['a.ts', 'src/x/']), ['z.ts'])
  })
  test('🔴 陽性對照：目錄規則沒有尾巴 `/` 時不是前綴（`src/x` 不放行 `src/xy.ts`）', () => {
    assert.deepEqual(outOfScope(['src/xy.ts'], ['src/x']), ['src/xy.ts'])
  })
})

describe('agy-write：六道守門各自紅、各自的訊息', () => {
  const bin = makeFakeAgy()
  const settings = makeSettings(GOOD_ALLOW)
  const baseEnv = { AGY_BIN: bin, AGY_SETTINGS: settings }
  test('G1：在 main 上 ⇒ exit 2、訊息點名 G1', () => {
    const repo = makeRepo()
    repo.g('checkout', '-q', 'main')
    const r = runWriteReal(repo, 'ok')
    assert.equal(r.code, 2)
    assert.match(r.errs, /G1：worktree 在 main/)
  })
  test('G1：worktree 不乾淨 ⇒ exit 2、列出髒檔', () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo.dir, 'dirty.txt'), 'x')
    const r = runWriteReal(repo, 'ok')
    assert.equal(r.code, 2)
    assert.match(r.errs, /G1：worktree 不乾淨[\s\S]*dirty\.txt/)
  })
  test('G2：settings 漂移 ⇒ exit 2、點名 G2', () => {
    const repo = makeRepo()
    const r = runWriteReal(repo, 'ok', [], { AGY_SETTINGS: makeSettings('command(node --test)') })
    assert.equal(r.code, 2)
    assert.match(r.errs, /G2：agy settings permissions\.allow 缺這條/)
  })
  test('G3：無頭被拒（exit 0、stdout 空）⇒ exit 3、點名 G3 與被拒工具', () => {
    const repo = makeRepo()
    const r = runWriteReal(repo, 'denied')
    assert.equal(r.code, 3)
    assert.match(r.errs, /G3 第 1 輪[\s\S]*RunCommand/)
    // 台帳有這一筆、verdict 是 FAIL_headless
    const ledger = fs.readFileSync(path.join(repo.dir, '.agy-write', 'ledger.ndjson'), 'utf8')
    assert.match(ledger, /"verdict":"FAIL_headless"/)
  })
  test('G4：越界改檔 ⇒ exit 3、點名越界檔、不還原', () => {
    const repo = makeRepo()
    const r = runWriteReal(repo, 'scope')
    assert.equal(r.code, 3)
    assert.match(r.errs, /G4 第 1 輪[\s\S]*leak\.mjs/)
    assert.ok(fs.existsSync(path.join(repo.dir, 'leak.mjs')), '越界檔不還原（留給統整者看）')
  })
  test('綠：寫檔＋測試綠 ⇒ exit 0、台帳 PASS', () => {
    const repo = makeRepo()
    const r = runWriteReal(repo, 'ok', ['--test', 'node --test add.test.mjs'])
    assert.equal(r.code, 0, r.errs)
    assert.match(r.outs, /第 1 輪測試綠/)
    assert.match(fs.readFileSync(path.join(repo.dir, '.agy-write', 'ledger.ndjson'), 'utf8'), /"verdict":"PASS"/)
  })
  test('G6：每輪都紅 ⇒ 到 --max-rounds 停、exit 3、第 2 輪起帶 --continue', () => {
    const repo = makeRepo()
    const r = runWriteReal(repo, 'red', ['--test', 'node --test add.test.mjs', '--max-rounds', '2'])
    assert.equal(r.code, 3)
    assert.match(r.errs, /G6：2 輪仍紅/)
    const ledger = fs.readFileSync(path.join(repo.dir, '.agy-write', 'ledger.ndjson'), 'utf8').trim().split('\n')
    assert.equal(ledger.length, 2)
    assert.match(ledger[1], /"verdict":"RED"/)
  })
  test('第 2 輪提示帶上一輪測試輸出、仍帶硬規則', () => {
    const p = buildWriterPrompt({ brief: 'B', worktree: '/w', allowlist: ['a.ts'], round: 2, feedback: 'FAIL xyz' })
    assert.match(p, /第 2 輪/)
    assert.match(p, /FAIL xyz/)
    assert.match(p, /禁止用 `;`/)
    assert.doesNotMatch(p, /\nB$/)
  })

  function runWriteReal(repo, mode, extra = [], envOverride = {}) {
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, '新增 add.test.mjs 測 add(2,3)===5')
    const errs = []
    const outs = []
    const origErr = console.error
    const origLog = console.log
    console.error = (m) => errs.push(String(m))
    console.log = (m) => outs.push(String(m))
    const saved = {}
    const set = { ...baseEnv, FAKE_AGY_MODE: mode, ...envOverride }
    for (const k of Object.keys(set)) {
      saved[k] = process.env[k]
      process.env[k] = set[k]
    }
    let code
    try {
      code = writeMain(['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', path.join(repo.dir, '.agy-write'), ...extra])
    } finally {
      console.error = origErr
      console.log = origLog
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
    return { code, errs: errs.join('\n'), outs: outs.join('\n') }
  }
})

describe('agy-council', () => {
  test('parseVerdicts：逐題與整份', () => {
    const v = parseVerdicts('Q1：簽｜ok｜無\nQ2：不簽｜x｜y\n**整份：不簽**')
    assert.deepEqual(v.q, { Q1: '簽', Q2: '不簽' })
    assert.equal(v.overall, '不簽')
  })
  test('parseVerdicts：零輸出 ⇒ overall null（不是簽）', () => {
    assert.equal(parseVerdicts('').overall, null)
  })
  test('buildReviewPrompt 含 brief、diff、六題', () => {
    const p = buildReviewPrompt({ brief: 'BRIEF', diff: '+x', tier: 'block', diffStat: '1 file' })
    assert.match(p, /BRIEF/)
    assert.match(p, /block 級/)
    assert.match(p, /Q6/)
  })
  test('review：兩位 agy（假 binary 回「不簽」）⇒ 表格印 不簽、exit 0；零輸出成員 ⇒ exit 3', () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo.dir, 'add.mjs'), 'export function add(a, b) { return a + b + 0 }\n')
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'BRIEF')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const bin = makeFakeAgy()
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    let code
    const saved = { AGY_BIN: process.env.AGY_BIN, FAKE_AGY_MODE: process.env.FAKE_AGY_MODE }
    process.env.AGY_BIN = bin
    process.env.FAKE_AGY_MODE = 'plan'
    try {
      code = councilMain(['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', path.join(repo.dir, '.review'), '--tier', 'standard'])
    } finally {
      console.log = origLog
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
    assert.equal(code, 0)
    const table = logs.join('\n')
    assert.match(table, /\| opus \| claude-opus-4-6-thinking \| 0 \|[^|]*\| 不簽 \| Q1=簽 Q2=不簽/)
    assert.match(table, /\| gemini \| gemini-3.1-pro-high/)
    assert.doesNotMatch(table, /codex/, 'standard 不叫 codex')
    // prompt 以 NO_EXEC_HEADER 開頭這件事在 runOne 內；這裡驗 prompt.md 已落地含 diff
    assert.match(fs.readFileSync(path.join(repo.dir, '.review', 'prompt.md'), 'utf8'), /\+ 0 \}/)

    // 🔴 陽性對照：假 binary 改成 denied（零輸出）⇒ exit 3、表格標「零輸出」
    const logs2 = []
    console.log = (m) => logs2.push(String(m))
    process.env.AGY_BIN = bin
    process.env.FAKE_AGY_MODE = 'denied'
    let code2
    try {
      code2 = councilMain(['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', path.join(repo.dir, '.review2'), '--tier', 'standard'])
    } finally {
      console.log = origLog
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
    assert.equal(code2, 3)
    assert.match(logs2.join('\n'), /零輸出/)
  })
  test('resolveAgyBin：AGY_BIN 覆寫優先', () => {
    assert.equal(resolveAgyBin({ AGY_BIN: '/x/agy' }), '/x/agy')
  })
})

describe('parseArgs', () => {
  test('--k v 解析成 { k: "v" }；--flag 後面沒有值（或下一個是 --x）⇒ true', () => {
    assert.deepEqual(parseArgs(['--k', 'v']), { _: [], k: 'v' })
    assert.deepEqual(parseArgs(['--flag']), { _: [], flag: true })
    assert.deepEqual(parseArgs(['--flag', '--x']), { _: [], flag: true, x: true })
  })

  test('multi 清單裡的 key 重複出現會累成陣列', () => {
    const res = parseArgs(['--allow', 'a', '--allow', 'b'], ['allow'])
    assert.deepEqual(res, { _: [], allow: ['a', 'b'] })
    assert.deepEqual(parseArgs(['--allow', 'a'], ['allow']), { _: [], allow: ['a'] })
  })

  test('不以 -- 開頭的參數進 _', () => {
    const res = parseArgs(['cmd', 'subcmd', '--foo', 'bar', 'extra'])
    assert.deepEqual(res, { _: ['cmd', 'subcmd', 'extra'], foo: 'bar' })
    assert.deepEqual(parseArgs(['a', 'b']), { _: ['a', 'b'] })
  })
})

describe('lastStepIsToolError：agy 無頭第 4 坑（工具參數錯 ⇒ 整輪靜默結束）的判定', async () => {
  const { lastStepIsToolError } = await import('./agy-write.mjs')
  test('最後一個工具步驟是參數錯 ⇒ true；最後一步正常 ⇒ false；permission 錯不算（那是 G3 的 denied）', () => {
    const argErr = { tool: 'grep_search', error: "invalid arguments:\n- at '/Includes': got string, want array" }
    assert.equal(lastStepIsToolError([{ tool: 'view_file', error: null }, argErr]), true)
    assert.equal(lastStepIsToolError([argErr, { tool: 'view_file', error: null }]), false)
    assert.equal(lastStepIsToolError([{ tool: 'run_command', error: 'user denied permission to run command' }]), false)
    assert.equal(lastStepIsToolError([]), false)
    assert.equal(lastStepIsToolError(undefined), false)
  })
})
