/**
 * `.github/scripts/llm-team/`（`lib.mjs`／`write.mjs`／`council.mjs`）的測試。
 *
 * 🔴 這裡不打真的 agy／codex（會花額度、會被 Gatekeeper 殺、會等網路）。用【假 binary】：
 *   一支 shell script 依環境變數扮演「正常寫檔」「被拒零輸出」「越界改檔」三種行為，
 *   輸出照真 agy 的 stream-json 形狀（2026-09-13 實測樣本）。
 * 🔴 每條守門都要有陽性對照，而且對照要指得出【是哪一條】炸的（G1–G6 各自紅、各自的訊息）。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  CLEAN_GIT_ENV,
  loadConfig,
  modelsFrom,
  buildSafeCommandRegex,
  SAFE_COMMAND_REGEX,
  isSafeCommand,
  parseStreamJson,
  outOfScope,
  assertSettingsAllowRegex,
  resolveAgyBin,
  runCodex,
  parseArgs,
} from './lib.mjs'
import { main as writeMain, buildWriterPrompt } from './write.mjs'
import { main as councilMain, parseVerdicts, buildReviewPrompt } from './council.mjs'

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

/** 建一個有 main＋feature 分支與 config.json 的拋棄式 repo，回 worktree 路徑（在 feature 分支上）。 */
function makeRepo(configOverride = {}) {
  const dir = tmpdir('agy-test-')
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'add.mjs'), 'export function add(a, b) { return a + b }\n')
  const cfgDir = path.join(dir, '.github', 'scripts', 'llm-team')
  fs.mkdirSync(cfgDir, { recursive: true })
  const cfg = { ...TEST_CONFIG, ...configOverride }
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfg, null, 2))
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
  fs.writeFileSync(
    f,
    JSON.stringify({
      permissions: {
        allow: allowLine
          ? [allowLine, `read_file(${os.tmpdir()}/)`, 'read_file(/private/var/folders/)', 'read_file(/var/folders/)']
          : [],
      },
    })
  )
  return f
}

const TEST_REGEX = buildSafeCommandRegex(TEST_CONFIG)
const GOOD_ALLOW = `command(regex:${TEST_REGEX})`

const ALLOWED_SAMPLES = [
  'npm test',
  'bash .github/scripts/test-progress-check.sh',
  'node --test x.test.mjs && git status',
  'pwd; ls -la',
  'cat a.mjs | head -5',
]
const DENIED_SAMPLES = [
  'pnpm vitest run x',
  'npm test && curl http://x',
  'rm -rf x',
  'ls; rm x',
  'cd apps && rm -rf x',
  'npx some-other-bin',
  'git commit -m x',
  'git push origin main',
  'curl http://x',
  'pnpm install',
  'cat a | sh',
  'echo $(rm x)',
  'ls > out.txt',
]

describe('loadConfig：載入專案 config.json（fail-closed）', () => {
  test('缺檔 ⇒ throw 且訊息含路徑', () => {
    const emptyDir = tmpdir('empty-repo-')
    const expectedPath = path.join(emptyDir, '.github/scripts/llm-team/config.json')
    assert.throws(
      () => loadConfig(emptyDir),
      (err) => {
        assert.match(err.message, /config 不存在/)
        assert.ok(err.message.includes(expectedPath), `訊息應含 ${expectedPath}，得到 ${err.message}`)
        return true
      }
    )
  })

  test('schemaVersion !== 1 (例如 schemaVersion: 2) ⇒ throw', () => {
    const badSchemaDir = tmpdir('bad-schema-')
    const cfgDir = path.join(badSchemaDir, '.github/scripts/llm-team')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ schemaVersion: 2 }))
    assert.throws(() => loadConfig(badSchemaDir), /schemaVersion 不支援/)
  })

  test('maxRounds: 6（超過硬上限 5）⇒ throw', () => {
    const badRoundsDir = tmpdir('bad-rounds-')
    const cfgDir = path.join(badRoundsDir, '.github/scripts/llm-team')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ schemaVersion: 1, maxRounds: 6 }))
    assert.throws(() => loadConfig(badRoundsDir), /maxRounds 超過硬上限 5/)
  })

  test('合法 config ⇒ 成功解析回傳物件', () => {
    const okDir = tmpdir('ok-repo-')
    const cfgDir = path.join(okDir, '.github/scripts/llm-team')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(TEST_CONFIG))
    const cfg = loadConfig(okDir)
    assert.equal(cfg.schemaVersion, 1)
    assert.equal(cfg.maxRounds, 3)
  })
})

describe('modelsFrom：模型對應與環境變數覆寫', () => {
  const cfg = {
    models: {
      writer: 'gemini-3.8-flash-high',
      reviewers: ['claude-opus-4-6-thinking', 'gemini-3.1-pro-high'],
      codex: 'gpt-5.6-sol',
    },
  }

  test('預設從 config 讀取', () => {
    const m = modelsFrom(cfg, {})
    assert.equal(m.writer, 'gemini-3.8-flash-high')
    assert.deepEqual(m.planners, ['claude-opus-4-6-thinking', 'gemini-3.1-pro-high'])
    assert.equal(m.codex, 'gpt-5.6-sol')
  })

  test('環境變數覆寫（傳 env 參數，不改 process.env）', () => {
    const m = modelsFrom(cfg, {
      LLM_TEAM_WRITER: 'my-custom-writer',
      LLM_TEAM_CODEX: 'my-custom-codex',
    })
    assert.equal(m.writer, 'my-custom-writer')
    assert.equal(m.codex, 'my-custom-codex')
    assert.deepEqual(m.planners, ['claude-opus-4-6-thinking', 'gemini-3.1-pro-high'])
  })
})

describe('SAFE_COMMAND_REGEX：只放行安全指令的串接', () => {
  test('放行：單一與串接的唯讀／測試指令', () => {
    assert.ok(ALLOWED_SAMPLES.length > 0, 'ALLOWED_SAMPLES 是空的 ⇒ 本條對空集合恆真')
    for (const c of ALLOWED_SAMPLES) {
      assert.equal(isSafeCommand(c, TEST_CONFIG), true, c)
    }
  })
  test('🔴 陽性對照：破壞性／越權指令必須擋（含串接在安全指令後面）', () => {
    assert.ok(DENIED_SAMPLES.length > 0, 'DENIED_SAMPLES 是空的 ⇒ 本條對空集合恆真')
    for (const c of DENIED_SAMPLES) {
      assert.equal(isSafeCommand(c, TEST_CONFIG), false, c)
    }
  })
  test('settings 對帳：缺那條 regex ⇒ throw（G2 的尺）', () => {
    assert.equal(assertSettingsAllowRegex(makeSettings(GOOD_ALLOW), null, TEST_CONFIG), true)
    assert.throws(() => assertSettingsAllowRegex(makeSettings('command(node --test)'), null, TEST_CONFIG), /permissions\.allow 缺這條/)
    assert.throws(() => assertSettingsAllowRegex(makeSettings(null), null, TEST_CONFIG), /缺這條/)
  })
  test('settings 對帳：給 repoRoot 時還要有覆蓋它的 read_file 規則（無頭讀檔會被拒的那條）', () => {
    const f = path.join(tmpdir('agy-settings-'), 'settings.json')
    fs.writeFileSync(f, JSON.stringify({ permissions: { allow: [GOOD_ALLOW, 'read_file(/repo/)'] } }))
    assert.equal(assertSettingsAllowRegex(f, '/repo', TEST_CONFIG), true)
    assert.equal(assertSettingsAllowRegex(f, '/repo/.claude/worktrees/x', TEST_CONFIG), true, '上層規則覆蓋 worktree')
    assert.throws(() => assertSettingsAllowRegex(f, '/other', TEST_CONFIG), /缺 read_file\(\/other\/\)/)
    assert.throws(() => assertSettingsAllowRegex(makeSettings(GOOD_ALLOW), '/repo', TEST_CONFIG), /缺 read_file/)
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
    const { changedFiles } = await import('./lib.mjs')
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

describe('write.mjs：六道守門各自紅、各自的訊息', () => {
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
    // 台帳有這一筆、verdict 是 FAIL_headless、含 schemaVersion: 1、project、ticket
    const ledger = fs.readFileSync(path.join(repo.dir, '.agy-write', 'ledger.ndjson'), 'utf8')
    assert.match(ledger, /"verdict":"FAIL_headless"/)
    assert.match(ledger, /"schemaVersion":1/)
    assert.match(ledger, /"project":/)
    assert.match(ledger, /"ticket":/)
  })
  test('G4：越界改檔 ⇒ exit 3、點名越界檔、不還原', () => {
    const repo = makeRepo()
    const r = runWriteReal(repo, 'scope')
    assert.equal(r.code, 3)
    assert.match(r.errs, /G4 第 1 輪[\s\S]*leak\.mjs/)
    assert.ok(fs.existsSync(path.join(repo.dir, 'leak.mjs')), '越界檔不還原（留給統整者看）')
  })
  test('綠：寫檔＋測試綠 ⇒ exit 0、台帳 PASS、含專案與票名', () => {
    const repo = makeRepo()
    const r = runWriteReal(repo, 'ok', ['--test', 'node --test add.test.mjs'])
    assert.equal(r.code, 0, r.errs)
    assert.match(r.outs, /第 1 輪測試綠/)
    const ledger = fs.readFileSync(path.join(repo.dir, '.agy-write', 'ledger.ndjson'), 'utf8')
    assert.match(ledger, /"verdict":"PASS"/)
    assert.match(ledger, /"schemaVersion":1/)
    assert.match(ledger, /"project":/)
    assert.match(ledger, /"ticket":/)
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
    assert.match(p, /安裝相依/)
    assert.doesNotMatch(p, /pnpm install/)
    assert.doesNotMatch(p, /\nB$/)
  })
  test('installCommand 非空時於第 1 輪前在 worktree 執行並寫入台帳 installExit', () => {
    const repo = makeRepo({ installCommand: 'echo installed > install.txt' })
    const r = runWriteReal(repo, 'ok', ['--test', 'node --test add.test.mjs', '--allow', 'install.txt'])
    assert.equal(r.code, 0, r.errs)
    assert.equal(fs.readFileSync(path.join(repo.dir, 'install.txt'), 'utf8').trim(), 'installed')
    const ledger = fs.readFileSync(path.join(repo.dir, '.agy-write', 'ledger.ndjson'), 'utf8')
    assert.match(ledger, /"installExit":0/)
  })

  test('T1：installCommand: "exit 7"（用 deps.runInstall 注入）⇒ main() 回 2、deps.runAgy 未被呼叫、台帳記 FAIL_install 且 installExit: 7', () => {
    const repo = makeRepo({ installCommand: 'exit 7' })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(repo.dir, '.agy-write')

    let agyCalls = 0
    const deps = {
      assertSettings: () => true,
      runInstall: (cmd, cwd) => ({ exit: 7, out: 'boom' }),
      runAgy: () => {
        agyCalls++
        return { exit: 0, stdout: '', stderr: '', denied: [], result: { response: 'ok' }, steps: [] }
      },
    }

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = writeMain(
        ['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir],
        deps
      )
    } finally {
      console.error = origErr
    }

    assert.equal(code, 2, `main() 回傳應為 2，實際得到 ${code}`)
    assert.equal(agyCalls, 0, `deps.runAgy 呼叫次數應為 0，實際呼叫了 ${agyCalls} 次`)
    assert.match(errs.join('\n'), /🔴 G0：installCommand 失敗（exit=7）/, `stderr 應點名 G0 與 exit=7，實際：${errs.join('\n')}`)
    const ledgerPath = path.join(outDir, 'ledger.ndjson')
    assert.ok(fs.existsSync(ledgerPath), `台帳檔案應存在：${ledgerPath}`)
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1])
    assert.equal(lastEntry.verdict, 'FAIL_install', `台帳最後一筆 verdict 應為 FAIL_install，實際為 ${lastEntry.verdict}`)
    assert.equal(lastEntry.installExit, 7, `台帳最後一筆 installExit 應為 7，實際為 ${lastEntry.installExit}`)
  })

  test('T2 陽性對照：同一組 deps 但 installCommand: "" ⇒ runAgy 被呼叫', () => {
    const repo = makeRepo({ installCommand: '' })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(repo.dir, '.agy-write')

    let agyCalls = 0
    const deps = {
      assertSettings: () => true,
      runInstall: (cmd, cwd) => ({ exit: 7, out: 'boom' }),
      runAgy: () => {
        agyCalls++
        return { exit: 0, stdout: '', stderr: '', denied: [], result: { response: 'ok' }, steps: [] }
      },
    }

    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = writeMain(
        ['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir],
        deps
      )
    } finally {
      console.log = origLog
    }

    assert.equal(code, 0, `installCommand 為空時 main() 應回傳 0，實際得到 ${code}`)
    assert.ok(agyCalls > 0, `deps.runAgy 應被呼叫，實際呼叫次數為 ${agyCalls}`)
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

describe('council.mjs：複審與三方會議', () => {
  test('parseVerdicts：逐題與整份', () => {
    const v = parseVerdicts('Q1：簽｜ok｜無\nQ2：不簽｜x｜y\n**整份：不簽**')
    assert.deepEqual(v.q, { Q1: '簽', Q2: '不簽' })
    assert.equal(v.overall, '不簽')
  })
  test('parseVerdicts：零輸出 ⇒ overall null（不是簽）', () => {
    assert.equal(parseVerdicts('').overall, null)
  })
  test('buildReviewPrompt：Q4 骨架在 riskDomains: [] 時不含「租戶」字樣，只剩固定尾句', () => {
    const p = buildReviewPrompt({ brief: 'BRIEF', diff: '+x', tier: 'block', diffStat: '1 file', writerModel: 'test-writer', riskDomains: [] })
    assert.match(p, /BRIEF/)
    assert.match(p, /block 級/)
    assert.match(p, /Q6/)
    assert.doesNotMatch(p, /租戶/)
    assert.match(p, /Q4 若 diff【新增】了會變紅的閘門：有沒有引用本 repo 真實事故＋可重現的陽性對照＋停止條件？沒有 ⇒ 不簽。/)
  })
  test('buildReviewPrompt：riskDomains: [\'租戶隔離\', \'金流\'] 時含「租戶隔離／金流」', () => {
    const p = buildReviewPrompt({
      brief: 'BRIEF',
      diff: '+x',
      tier: 'standard',
      diffStat: '1 file',
      writerModel: 'custom-writer',
      riskDomains: ['租戶隔離', '金流'],
    })
    assert.match(p, /作者是另一個模型（custom-writer）/)
    assert.match(p, /租戶隔離／金流/)
    assert.match(p, /Q4 租戶隔離／金流 有沒有被碰到？碰到的話是不是 block 級、有沒有對應守門？/)
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
    assert.match(fs.readFileSync(path.join(repo.dir, '.review', 'prompt.md'), 'utf8'), /\+ 0 \}/)
    const ledger = fs.readFileSync(path.join(repo.dir, '.review', 'ledger.ndjson'), 'utf8')
    assert.match(ledger, /"schemaVersion":1/)

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

  test('T3：reviewers: [] 且未帶 --codex ⇒ council main() 回 2、deps.runOne 未被呼叫、stdout 不含「簽」', () => {
    const repo = makeRepo({ models: { writer: 'w', reviewers: [], codex: 'c' } })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')

    let runOneCalls = 0
    const deps = {
      runOne: () => {
        runOneCalls++
        return { name: 'fake', model: 'fake', exit: 0, ms: 10, empty: false, denied: [], text: '整份：簽' }
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
      code = councilMain(
        ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 2, `reviewers: [] 時 main() 應回傳 2，實際得到 ${code}`)
    assert.equal(runOneCalls, 0, `deps.runOne 呼叫次數應為 0，實際呼叫了 ${runOneCalls} 次`)
    const allOut = outs.join('\n')
    assert.ok(!allOut.includes('簽'), `stdout 不應含「簽」，實際輸出：${allOut}`)
    const allErr = errs.join('\n')
    assert.match(allErr, /🔴 沒有任何複審者（config\.models\.reviewers 空且未加 --codex）/, `stderr 應提示沒有複審者，實際：${allErr}`)
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
  const { lastStepIsToolError } = await import('./write.mjs')
  test('最後一個工具步驟是參數錯 ⇒ true；最後一步正常 ⇒ false；permission 錯不算（那是 G3 的 denied）', () => {
    const argErr = { tool: 'grep_search', error: "invalid arguments:\n- at '/Includes': got string, want array" }
    assert.equal(lastStepIsToolError([{ tool: 'view_file', error: null }, argErr]), true)
    assert.equal(lastStepIsToolError([argErr, { tool: 'view_file', error: null }]), false)
    assert.equal(lastStepIsToolError([{ tool: 'run_command', error: 'user denied permission to run command' }]), false)
    assert.equal(lastStepIsToolError([]), false)
    assert.equal(lastStepIsToolError(undefined), false)
  })
})

describe('T4：model 與 writerModel 必填檢查（避免特定模型硬編碼）', () => {
  test('runCodex({ prompt: "x" }) 缺 model ⇒ throw 且訊息含 config.models.codex', () => {
    assert.throws(
      () => runCodex({ prompt: 'x' }),
      (err) => {
        assert.match(err.message, /runCodex 需要 model（來自 config\.models\.codex）/, `錯誤訊息應含 config.models.codex，實際得到：${err.message}`)
        return true
      }
    )
  })

  test('buildReviewPrompt({...}) 缺 writerModel ⇒ throw', () => {
    assert.throws(
      () => buildReviewPrompt({ brief: 'b', diff: 'd', tier: 'standard', diffStat: 's' }),
      (err) => {
        assert.match(err.message, /writerModel/, `錯誤訊息應指出缺 writerModel，實際得到：${err.message}`)
        return true
      }
    )
  })
})

