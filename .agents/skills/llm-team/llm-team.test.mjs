/**
 * `.agents/skills/llm-team/`（`lib.mjs`／`write.mjs`／`council.mjs`）的測試。
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
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
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
  runAgy,
  buildAgyArgs,
  buildSpawnEnv,
  WRITER_PROMPT_SENTINEL,
  parseArgs,
  isDirectRun,
} from './lib.mjs'
import { main as writeMain, buildWriterPrompt } from './write.mjs'
import { main as councilMain, parseVerdicts, buildReviewPrompt } from './council.mjs'
import { main as setupMain, matcherCovers, guardCandidates, resolveGuardPath } from './setup.mjs'

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
  const cfg = { ...TEST_CONFIG, ...configOverride }
  fs.writeFileSync(path.join(dir, 'llm-team.config.json'), JSON.stringify(cfg, null, 2))
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
printf '%s\\n' '{"event":"init","conversation_id":"fake-conv-123","init":{"model":"fake"}}'
case "$FAKE_AGY_MODE" in
  denied)
    printf '%s\\n' '{"event":"step_update","step_update":{"step_index":4,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"pwd; ls -la"},"error":{"type":"TOOL_ERROR","message":"permission check failed for command \\"pwd; ls -la\\": user denied permission to run command"}}}}'
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","conversation_id":"fake-conv-123","response":"","duration_seconds":4.8,"num_turns":1,"usage":{"total_tokens":28210},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}'
    printf '%s\\n' 'jetski: no output produced — a tool required the "command" permission' 1>&2
    exit 0;;
  scope)
    printf 'export const leak = 1\\n' > leak.mjs
    printf 'import { test } from "node:test"\\ntest("x", () => {})\\n' > add.test.mjs
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","conversation_id":"fake-conv-123","response":"改了 add.test.mjs 與 leak.mjs","usage":{"total_tokens":10},"denied_actions":[]}}'
    exit 0;;
  red)
    printf 'import { test } from "node:test"\\nimport assert from "node:assert/strict"\\nimport { add } from "./add.mjs"\\ntest("add", () => { assert.equal(add(2,3), 6) })\\n' > add.test.mjs
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","conversation_id":"fake-conv-123","response":"寫了 add.test.mjs（round '"$FAKE_ROUND"')","usage":{"total_tokens":10},"denied_actions":[]}}'
    exit 0;;
  plan)
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","conversation_id":"fake-conv-123","response":"Q1：簽｜ok｜無\\nQ2：不簽｜有 fail-open｜改\\n整份：不簽","usage":{"total_tokens":10},"denied_actions":[]}}'
    exit 0;;
  *)
    printf 'import { test } from "node:test"\\nimport assert from "node:assert/strict"\\nimport { add } from "./add.mjs"\\ntest("add", () => { assert.equal(add(2,3), 5) })\\n' > add.test.mjs
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","conversation_id":"fake-conv-123","response":"寫了 add.test.mjs 並跑了 node --test：pass 1","usage":{"total_tokens":10},"denied_actions":[]}}'
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
    const expectedPath = path.join(emptyDir, 'llm-team.config.json')
    assert.throws(
      () => loadConfig(emptyDir),
      (err) => {
        assert.match(err.message, /config 不存在/)
        assert.ok(err.message.includes(expectedPath), `訊息應含 ${expectedPath}，得到 ${err.message}`)
        return true
      }
    )
  })

  test('--config 覆寫優先', () => {
    const dir = tmpdir('override-repo-')
    const customCfgPath = path.join(dir, 'custom.config.json')
    fs.writeFileSync(customCfgPath, JSON.stringify({ schemaVersion: 1, maxRounds: 4, custom: true }))
    // repo 根沒有 llm-team.config.json，但傳了 customCfgPath ⇒ 應成功載入
    const cfg = loadConfig(dir, customCfgPath)
    assert.equal(cfg.maxRounds, 4)
    assert.equal(cfg.custom, true)
  })

  test('schemaVersion !== 1 (例如 schemaVersion: 2) ⇒ throw', () => {
    const badSchemaDir = tmpdir('bad-schema-')
    fs.writeFileSync(path.join(badSchemaDir, 'llm-team.config.json'), JSON.stringify({ schemaVersion: 2 }))
    assert.throws(() => loadConfig(badSchemaDir), /schemaVersion 不支援/)
  })

  test('maxRounds: 6（超過硬上限 5）⇒ throw', () => {
    const badRoundsDir = tmpdir('bad-rounds-')
    fs.writeFileSync(path.join(badRoundsDir, 'llm-team.config.json'), JSON.stringify({ schemaVersion: 1, maxRounds: 6 }))
    assert.throws(() => loadConfig(badRoundsDir), /maxRounds 超過硬上限 5/)
  })

  test('branchPrefixes: "agy/" ⇒ loadConfig throw；["agy/", 1] ⇒ throw；[] ⇒ 過', () => {
    const dirString = tmpdir('bad-prefix-str-')
    fs.writeFileSync(
      path.join(dirString, 'llm-team.config.json'),
      JSON.stringify({ schemaVersion: 1, branchPrefixes: 'agy/' })
    )
    assert.throws(
      () => loadConfig(dirString),
      (err) => {
        assert.match(err.message, /branchPrefixes 不支援/)
        assert.match(err.message, /string/)
        return true
      }
    )

    const dirMixed = tmpdir('bad-prefix-mixed-')
    fs.writeFileSync(
      path.join(dirMixed, 'llm-team.config.json'),
      JSON.stringify({ schemaVersion: 1, branchPrefixes: ['agy/', 1] })
    )
    assert.throws(
      () => loadConfig(dirMixed),
      (err) => {
        assert.match(err.message, /branchPrefixes 不支援/)
        assert.match(err.message, /number/)
        return true
      }
    )

    const dirEmpty = tmpdir('prefix-empty-')
    fs.writeFileSync(
      path.join(dirEmpty, 'llm-team.config.json'),
      JSON.stringify({ schemaVersion: 1, branchPrefixes: [] })
    )
    const cfg = loadConfig(dirEmpty)
    assert.deepEqual(cfg.branchPrefixes, [])
  })

  test('branchPrefixes: [""] ⇒ throw；["agy/", " "] ⇒ throw；["agy/"] ⇒ 過', () => {
    const dirEmptyStr = tmpdir('bad-prefix-empty-')
    fs.writeFileSync(
      path.join(dirEmptyStr, 'llm-team.config.json'),
      JSON.stringify({ schemaVersion: 1, branchPrefixes: [''] })
    )
    assert.throws(
      () => loadConfig(dirEmptyStr),
      (err) => {
        assert.match(err.message, /branchPrefixes 不支援/)
        assert.match(err.message, /空前綴等於不檢查，要停用請用 \[\]/)
        return true
      }
    )

    const dirWhitespace = tmpdir('bad-prefix-ws-')
    fs.writeFileSync(
      path.join(dirWhitespace, 'llm-team.config.json'),
      JSON.stringify({ schemaVersion: 1, branchPrefixes: ['agy/', ' '] })
    )
    assert.throws(
      () => loadConfig(dirWhitespace),
      (err) => {
        assert.match(err.message, /branchPrefixes 不支援/)
        assert.match(err.message, /空前綴等於不檢查，要停用請用 \[\]/)
        return true
      }
    )

    const dirOk = tmpdir('prefix-ok-')
    fs.writeFileSync(
      path.join(dirOk, 'llm-team.config.json'),
      JSON.stringify({ schemaVersion: 1, branchPrefixes: ['agy/'] })
    )
    const cfg = loadConfig(dirOk)
    assert.deepEqual(cfg.branchPrefixes, ['agy/'])
  })

  test('合法 config ⇒ 成功解析回傳物件', () => {
    const okDir = tmpdir('ok-repo-')
    fs.writeFileSync(path.join(okDir, 'llm-team.config.json'), JSON.stringify(TEST_CONFIG))
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
  test('G6：每輪都紅 ⇒ 到 --max-rounds 停、exit 3、第 2 輪起帶 --conversation <id>', () => {
    const repo = makeRepo()
    const r = runWriteReal(repo, 'red', ['--test', 'node --test add.test.mjs', '--max-rounds', '2'])
    assert.equal(r.code, 3)
    assert.match(r.errs, /G6：2 輪仍紅/)
    const ledger = fs.readFileSync(path.join(repo.dir, '.agy-write', 'ledger.ndjson'), 'utf8').trim().split('\n')
    assert.equal(ledger.length, 2)
    assert.match(ledger[1], /"verdict":"RED"/)
    assert.match(ledger[1], /"conversationId":"fake-conv-123"/)
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
  test('buildWriterPrompt 輸出含 allowedHeads（npm test 與 node --test），且 round 2 也含', () => {
    const allowedHeads = ['pwd', 'node --test', 'npm test']
    const p1 = buildWriterPrompt({ brief: 'B', worktree: '/w', allowlist: ['a.ts'], round: 1, allowedHeads })
    assert.match(p1, /npm test/)
    assert.match(p1, /node --test/)
    assert.match(p1, /你只准跑這些指令頭：/)

    const p2 = buildWriterPrompt({ brief: 'B', worktree: '/w', allowlist: ['a.ts'], round: 2, feedback: 'FAIL', allowedHeads })
    assert.match(p2, /npm test/)
    assert.match(p2, /node --test/)
    assert.match(p2, /你只准跑這些指令頭：/)
  })
  test('main 級陽性對照：config allowCommandHeads 傳入 write.main ⇒ deps.runAgy 攔到的 prompt 含 npm test 與 node --test', () => {
    const repo = makeRepo({ allowCommandHeads: ['npm test'] })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(repo.dir, '.agy-write')

    let capturedPrompt = null
    const deps = {
      assertSettings: () => true,
      runAgy: (args) => {
        capturedPrompt = args.prompt
        fs.writeFileSync(path.join(repo.dir, 'add.test.mjs'), 'test')
        return {
          exit: 0,
          stdout: '',
          stderr: '',
          denied: [],
          result: { response: 'ok', conversation_id: 'conv-allowed-heads' },
          steps: [],
          conversationId: 'conv-allowed-heads',
        }
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
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

    assert.equal(code, 0, `main() 應回 0，實際為 ${code}`)
    assert.ok(capturedPrompt, 'deps.runAgy 應攔截到 prompt')
    assert.match(capturedPrompt, /npm test/, 'prompt 應包含自訂的 npm test 指令頭')
    assert.match(capturedPrompt, /node --test/, 'prompt 應包含內建基底的 node --test 指令頭')
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
        return {
          exit: 0,
          stdout: '',
          stderr: '',
          denied: [],
          result: { response: 'ok', conversation_id: 'conv-t2' },
          steps: [],
          conversationId: 'conv-t2',
        }
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

describe('conversation id 處理（fail-closed 與不續話）', () => {
  test('parseStreamJson 從 init 行也抓得到 id（result 沒有 conversation_id 時）', () => {
    const text = '{"event":"init","conversation_id":"init-uuid-123"}\n{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'
    const p = parseStreamJson(text)
    assert.equal(p.conversationId, 'init-uuid-123')
    assert.equal(p.result.response, 'ok')
  })

  test('deps.runAgy 第 1 輪回 result 沒有 conversation_id 且無 init ⇒ main 回 3、台帳最後一筆 verdict === "FAIL_conversation_id"（陽性對照）', () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(repo.dir, '.agy-write')

    const deps = {
      assertSettings: () => true,
      runAgy: () => ({
        exit: 0,
        stdout: '',
        stderr: '',
        denied: [],
        result: { response: 'ok' },
        steps: [],
        conversationId: null,
      }),
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

    assert.equal(code, 3)
    assert.match(errs.join('\n'), /🔴 G3 前置：拿不到 conversation id，不續話/)
    const ledgerPath = path.join(outDir, 'ledger.ndjson')
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1])
    assert.equal(lastEntry.verdict, 'FAIL_conversation_id')
    assert.equal(lastEntry.conversationId, null)
  })

  test('正常兩輪 ⇒ 第 2 輪呼叫的 extraArgs 深等於 ["--conversation", "<第 1 輪 id>"]，且所有呼叫的 extraArgs 都不含 "--continue"', () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(repo.dir, '.agy-write')

    const calls = []
    let roundCount = 0
    const deps = {
      assertSettings: () => true,
      runAgy: (args) => {
        roundCount++
        calls.push(args)
        fs.writeFileSync(path.join(repo.dir, 'add.test.mjs'), 'test')
        return {
          exit: 0,
          stdout: '',
          stderr: '',
          denied: [],
          result: { response: `round ${roundCount} ok`, conversation_id: 'conv-round-1' },
          steps: [],
          conversationId: 'conv-round-1',
        }
      },
      runTest: () => {
        return { exit: roundCount === 1 ? 1 : 0, out: roundCount === 1 ? 'red' : 'green' }
      },
    }

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let code
    try {
      code = writeMain(
        ['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir, '--test', 'echo ok', '--max-rounds', '2'],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 0)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].extraArgs, ['--conversation', 'conv-round-1'])
    for (const c of calls) {
      assert.ok(!c.extraArgs.includes('--continue'), `extraArgs 不應含 --continue：${JSON.stringify(c.extraArgs)}`)
    }
  })

  test('第 2 輪回不同 id ⇒ 回 3 且 console.error 包含「串錯對話」', () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(repo.dir, '.agy-write')

    let roundCount = 0
    const deps = {
      assertSettings: () => true,
      runAgy: (args) => {
        roundCount++
        fs.writeFileSync(path.join(repo.dir, 'add.test.mjs'), 'test')
        return {
          exit: 0,
          stdout: '',
          stderr: '',
          denied: [],
          result: { response: `round ${roundCount} ok`, conversation_id: roundCount === 1 ? 'conv-1' : 'conv-DIFFERENT' },
          steps: [],
          conversationId: roundCount === 1 ? 'conv-1' : 'conv-DIFFERENT',
        }
      },
      runTest: () => ({ exit: 1, out: 'red' }),
    }

    const origLog = console.log
    const origErr = console.error
    const errs = []
    console.log = () => {}
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = writeMain(
        ['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir, '--test', 'echo ok', '--max-rounds', '2'],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 3)
    assert.match(errs.join('\n'), /串錯對話/)
    assert.match(errs.join('\n'), /🔴 G3 前置：續輪回來的 conversation id（conv-DIFFERENT）≠ 第 1 輪（conv-1），串錯對話，停/)
    const ledgerPath = path.join(outDir, 'ledger.ndjson')
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1])
    assert.equal(lastEntry.verdict, 'FAIL_conversation_id')
    assert.equal(lastEntry.conversationId, 'conv-DIFFERENT')
  })

  test('tool-error 重試那條路徑的 extraArgs 深等於 ["--conversation", "<id>"]', () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(repo.dir, '.agy-write')

    const calls = []
    let callCount = 0
    const deps = {
      assertSettings: () => true,
      runAgy: (args) => {
        callCount++
        calls.push(args)
        if (callCount === 1) {
          return {
            exit: 0,
            stdout: '',
            stderr: '',
            denied: [],
            result: { response: '', conversation_id: 'conv-tool-err' },
            steps: [{ tool: 'grep_search', error: 'invalid type for Includes' }],
            conversationId: 'conv-tool-err',
          }
        }
        fs.writeFileSync(path.join(repo.dir, 'add.test.mjs'), 'test')
        return {
          exit: 0,
          stdout: '',
          stderr: '',
          denied: [],
          result: { response: 'fixed', conversation_id: 'conv-tool-err' },
          steps: [],
          conversationId: 'conv-tool-err',
        }
      },
      runTest: () => ({ exit: 0, out: 'pass' }),
    }

    const origLog = console.log
    const origErr = console.error
    console.log = () => {}
    console.error = () => {}
    let code
    try {
      code = writeMain(
        ['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir, '--test', 'echo ok', '--max-rounds', '1'],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 0)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].extraArgs, ['--conversation', 'conv-tool-err'])
    for (const c of calls) {
      assert.ok(!c.extraArgs.includes('--continue'), `extraArgs 不應含 --continue：${JSON.stringify(c.extraArgs)}`)
    }
  })

  test('tool-error 重試回不同 id ⇒ 回 3 且 console.error 包含「串錯對話」', () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(repo.dir, '.agy-write')

    let callCount = 0
    const deps = {
      assertSettings: () => true,
      runAgy: () => {
        callCount++
        if (callCount === 1) {
          return {
            exit: 0,
            stdout: '',
            stderr: '',
            denied: [],
            result: { response: '', conversation_id: 'conv-1' },
            steps: [{ tool: 'grep_search', error: 'invalid type for Includes' }],
            conversationId: 'conv-1',
          }
        }
        return {
          exit: 0,
          stdout: '',
          stderr: '',
          denied: [],
          result: { response: 'fixed', conversation_id: 'conv-DIFFERENT' },
          steps: [],
          conversationId: 'conv-DIFFERENT',
        }
      },
      runTest: () => ({ exit: 0, out: 'pass' }),
    }

    const origLog = console.log
    const origErr = console.error
    const errs = []
    console.log = () => {}
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = writeMain(
        ['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir, '--test', 'echo ok', '--max-rounds', '1'],
        deps
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    assert.equal(code, 3)
    assert.match(errs.join('\n'), /串錯對話/)
    const ledgerPath = path.join(outDir, 'ledger.ndjson')
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1])
    assert.equal(lastEntry.verdict, 'FAIL_conversation_id')
    assert.equal(lastEntry.conversationId, 'conv-DIFFERENT')
  })
})

describe('isDirectRun：symlink 下判斷直接執行', () => {
  test('isDirectRun 比對 realpath（含 symlink、不存在檔與 undefined）', () => {
    const tmp = tmpdir('direct-run-')
    const real = path.join(tmp, 'real.mjs')
    fs.writeFileSync(real, 'export const x = 1\n')
    const link = path.join(tmp, 'link.mjs')
    fs.symlinkSync(real, link)
    const url = pathToFileURL(real).href

    assert.equal(isDirectRun(url, link), true)
    assert.equal(isDirectRun(url, path.join(tmp, 'other.mjs')), false)
    assert.equal(isDirectRun(url, undefined), false)
  })

  test('陽性對照（真的跑子行程）：在 tmp 目錄建 symlink export-link.mjs → 真實 export.mjs', () => {
    const tmp = tmpdir('export-link-')
    const linkPath = path.join(tmp, 'export-link.mjs')
    const realExport = fileURLToPath(new URL('./export.mjs', import.meta.url))
    fs.symlinkSync(realExport, linkPath)

    const tmpTarget = tmpdir('export-target-')
    const r = spawnSync(process.execPath, [linkPath, '--to', tmpTarget], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, `子行程失敗（status=${r.status}）：stderr=${r.stderr} stdout=${r.stdout}`)
    const manifestPath = path.join(tmpTarget, '.agents', 'skills', 'llm-team', 'MANIFEST.sha256')
    assert.ok(fs.existsSync(manifestPath), `MANIFEST.sha256 必須存在：${manifestPath}`)
  })
})

describe('config 從 worktree 讀（不是主 checkout）', () => {
  test('tmp 主 repo 的 llm-team.config.json installCommand: ""，worktree 分支改 installCommand ⇒ write.main 跑的是 worktree 那份', () => {
    const repo = makeRepo({ installCommand: '' })
    const worktreeDir = path.join(repo.dir, '.claude', 'worktrees', 'wt-cfg')
    repo.g('worktree', 'add', worktreeDir, '-b', 'feat/wt-cfg', 'feat/x')
    const wtConfig = {
      ...TEST_CONFIG,
      installCommand: 'echo installed > .installed',
    }
    fs.writeFileSync(path.join(worktreeDir, 'llm-team.config.json'), JSON.stringify(wtConfig, null, 2))
    execFileSync('git', ['-C', worktreeDir, 'commit', '-am', 'update config on worktree branch'], { env: CLEAN_GIT_ENV, encoding: 'utf8' })

    let capturedInstallCmd = null
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test')
    const outDir = path.join(worktreeDir, '.agy-write')

    const deps = {
      assertSettings: () => true,
      runInstall: (cmd) => {
        capturedInstallCmd = cmd
        return { exit: 0, out: '' }
      },
      runAgy: () => ({
        exit: 0,
        stdout: '',
        stderr: '',
        denied: [],
        result: { response: 'ok', conversation_id: 'conv-wt-cfg' },
        steps: [],
        conversationId: 'conv-wt-cfg',
      }),
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const code = writeMain(
      ['--worktree', worktreeDir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir],
      deps
    )
    assert.equal(code, 0)
    assert.equal(capturedInstallCmd, 'echo installed > .installed', 'write.main 應執行 worktree 內的 installCommand 而非主 checkout 的空字串')
  })
})

describe('agy 無頭第 5 坑：--print-timeout 與 timeoutMs 傳遞', () => {
  test('buildAgyArgs 組出的 argv 含 --print-timeout 25m', () => {
    const args = buildAgyArgs({
      model: 'gemini-3.8-flash-high',
      mode: 'accept-edits',
      prompt: 'hello',
      timeoutMs: 25 * 60 * 1000,
    })
    const idx = args.indexOf('--print-timeout')
    assert.ok(idx !== -1, 'args 應含 --print-timeout')
    assert.equal(args[idx + 1], '25m')
  })

  test('write.main 每輪 runAgy 傳遞 timeoutMs＝25 分鐘', () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test')
    const outDir = path.join(repo.dir, '.agy-write')

    let capturedTimeoutMs = null
    const deps = {
      assertSettings: () => true,
      runAgy: (args) => {
        capturedTimeoutMs = args.timeoutMs
        return {
          exit: 0,
          stdout: '',
          stderr: '',
          denied: [],
          result: { response: 'ok', conversation_id: 'conv-timeout' },
          steps: [],
          conversationId: 'conv-timeout',
        }
      },
      runTest: () => ({ exit: 0, out: 'ok' }),
    }

    const code = writeMain(
      ['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir],
      deps
    )
    assert.equal(code, 0)
    assert.equal(capturedTimeoutMs, 25 * 60 * 1000, 'runAgy 呼叫參數之 timeoutMs 應為 25 分鐘（1500000 ms）')
  })
})

describe('codexTier 出席層級測試', () => {
  test('codexTier: "all" ＋ standard tier ⇒ members 含 codex', () => {
    const repo = makeRepo({ codexTier: 'all' })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(tmpdir('review-'), 'review')

    const membersCalled = []
    const deps = {
      runOne: (name, model, prompt, cwd, out) => {
        membersCalled.push(name)
        return { name, model, exit: 0, ms: 10, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }

    const code = councilMain(
      ['review', '--worktree', repo.dir, '--base', 'main', '--brief', brief, '--tier', 'standard', '--out', outDir],
      deps
    )
    assert.equal(code, 0)
    assert.ok(membersCalled.includes('codex'), `codexTier: "all" 時 standard tier 應出席 codex，實際成員：${membersCalled.join(', ')}`)
  })

  test('codexTier: "block" ＋ standard tier ⇒ members 不含 codex', () => {
    const repo = makeRepo({ codexTier: 'block' })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(tmpdir('review-'), 'review')

    const membersCalled = []
    const deps = {
      runOne: (name, model, prompt, cwd, out) => {
        membersCalled.push(name)
        return { name, model, exit: 0, ms: 10, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }

    const code = councilMain(
      ['review', '--worktree', repo.dir, '--base', 'main', '--brief', brief, '--tier', 'standard', '--out', outDir],
      deps
    )
    assert.equal(code, 0)
    assert.ok(!membersCalled.includes('codex'), `codexTier: "block" 時 standard tier 不應出席 codex，實際成員：${membersCalled.join(', ')}`)
  })

  test('codexTier 非法值 ⇒ loadConfig throw', () => {
    const repo = makeRepo({ codexTier: 'invalid-tier' })
    assert.throws(
      () => loadConfig(repo.dir),
      /config codexTier 不支援.*預期 "block" 或 "all"/
    )
  })
})

describe('git 環境剝除：cleanGitEnv 真實生效', () => {
  test('runAgy 子行程收到的 env 沒有 GIT_DIR 與 GIT_WORK_TREE 但保留其他 key', () => {
    let capturedSpawnEnv = null
    const fakeSpawn = (bin, args, opts) => {
      capturedSpawnEnv = opts.env
      return {
        status: 0,
        stdout: '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}',
        stderr: '',
      }
    }
    runAgy({
      model: 'gemini-3.8-flash-high',
      mode: 'plan',
      prompt: 'test',
      cwd: process.cwd(),
      env: { PATH: '/custom/bin', GIT_DIR: '/x', GIT_WORK_TREE: '/y' },
      spawn: fakeSpawn,
    })
    assert.ok(capturedSpawnEnv, 'spawn 應被呼叫')
    assert.equal(capturedSpawnEnv.GIT_DIR, undefined, 'GIT_DIR 應被刪除')
    assert.equal(capturedSpawnEnv.GIT_WORK_TREE, undefined, 'GIT_WORK_TREE 應被刪除')
    assert.equal(capturedSpawnEnv.PATH, '/custom/bin', 'PATH 應被保留')
  })

  test('runCodex 子行程收到的 env 沒有 GIT_DIR 與 GIT_WORK_TREE 但保留其他 key', () => {
    let capturedSpawnEnv = null
    const fakeSpawn = (bin, args, opts) => {
      capturedSpawnEnv = opts.env
      return { status: 0, stdout: 'ok', stderr: '' }
    }
    runCodex({
      model: 'gpt-5.6-sol',
      prompt: 'test',
      cwd: process.cwd(),
      env: { PATH: '/custom/bin', GIT_DIR: '/x', GIT_WORK_TREE: '/y' },
      spawn: fakeSpawn,
    })
    assert.ok(capturedSpawnEnv, 'spawn 應被呼叫')
    assert.equal(capturedSpawnEnv.GIT_DIR, undefined, 'GIT_DIR 應被刪除')
    assert.equal(capturedSpawnEnv.GIT_WORK_TREE, undefined, 'GIT_WORK_TREE 應被刪除')
    assert.equal(capturedSpawnEnv.PATH, '/custom/bin', 'PATH 應被保留')
  })
})

describe('WRITER_PROMPT_SENTINEL 寫手提示哨兵', () => {
  test('buildWriterPrompt 輸出的第一行固定為 WRITER_PROMPT_SENTINEL（round 1 與 round 2）', () => {
    const p1 = buildWriterPrompt({ brief: 'B', worktree: '/w', allowlist: ['a.ts'], round: 1 })
    assert.equal(p1.split('\n')[0], WRITER_PROMPT_SENTINEL, 'round 1 第一行必須是哨兵')

    const p2 = buildWriterPrompt({ brief: 'B', worktree: '/w', allowlist: ['a.ts'], round: 2, feedback: 'FAIL' })
    assert.equal(p2.split('\n')[0], WRITER_PROMPT_SENTINEL, 'round 2 第一行必須是哨兵')
  })
})

describe('setup.mjs --check：agy 全域 hook 載入檢查', () => {
  function makeValidSetupDeps(hooksResult) {
    const repo = makeRepo()
    const settingsFile = makeSettings(GOOD_ALLOW)
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    const rootWithSlash = repo.dir.endsWith('/') ? repo.dir : repo.dir + '/'
    s.permissions.allow.push(`read_file(${rootWithSlash})`)
    s.trustedWorkspaces = [repo.dir]
    fs.writeFileSync(settingsFile, JSON.stringify(s))
    const fakeHome = tmpdir('setup-fake-home-')
    const guardDir = path.join(fakeHome, '.claude', 'hooks')
    fs.mkdirSync(guardDir, { recursive: true })
    const guardFile = path.join(guardDir, 'block-dangerous.sh')
    fs.writeFileSync(guardFile, '#!/usr/bin/env bash\n')

    return {
      repoRoot: repo.dir,
      settingsFile,
      config: TEST_CONFIG,
      agyBin: '/mock/bin/antigravity',
      which: (bin) => `/mock/bin/${bin}`,
      env: { HOME: fakeHome, LLM_TEAM_GUARD: guardFile },
      runAgyHooks: () => hooksResult,
    }
  }

  test('列表含 ⇒ 過', () => {
    const deps = makeValidSetupDeps(null)
    const hooksPayload = {
      command: {
        name: 'hooks',
        data: {
          hooks: [
            {
              name: 'block-dangerous',
              enabled: true,
              source: path.join(deps.env.HOME, '.gemini', 'config', 'hooks.json'),
              actions: [
                {
                  event: 'PreToolUse',
                  matcher: 'run_command',
                  type: 'command',
                  command: '~/.claude/skills/llm-team/agy-pretooluse.sh',
                },
              ],
            },
          ],
        },
      },
    }
    deps.runAgyHooks = () => ({ exit: 0, stdout: JSON.stringify(hooksPayload) })
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)
    assert.match(logs.join('\n'), /\[hook:block-dangerous\] ✓ 已載入/)
  })

  test('空 ⇒ 紅且訊息含 install.sh', () => {
    const emptyPayload = {
      command: {
        name: 'hooks',
        data: {
          hooks: [],
        },
      },
    }
    const deps = makeValidSetupDeps({ exit: 0, stdout: JSON.stringify(emptyPayload) })
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 1)
    const errOutput = errs.join('\n')
    assert.match(errOutput, /install\.sh/)
    assert.match(errOutput, /🔴 agy 全域 hooks\.json 沒載入 block-dangerous/)
  })

  test('含但 enabled:false ⇒ 紅', () => {
    const deps = makeValidSetupDeps(null)
    const disabledPayload = {
      command: {
        name: 'hooks',
        data: {
          hooks: [
            {
              name: 'block-dangerous',
              enabled: false,
              source: path.join(deps.env.HOME, '.gemini', 'config', 'hooks.json'),
              actions: [{ event: 'PreToolUse', matcher: 'run_command' }],
            },
          ],
        },
      },
    }
    deps.runAgyHooks = () => ({ exit: 0, stdout: JSON.stringify(disabledPayload) })
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 1)
    assert.match(errs.join('\n'), /🔴 agy 全域 hooks\.json 沒載入 block-dangerous/)
  })

  test('agy 回非 JSON ⇒ 紅（fail-closed）', () => {
    const deps = makeValidSetupDeps({ exit: 0, stdout: 'this is not a valid json output from agy' })
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 1)
    assert.match(errs.join('\n'), /🔴 agy 全域 hooks\.json 沒載入 block-dangerous/)
  })

  test('只注入 settingsFile、不注入 runAgyHooks 且 agyBin 為 null ⇒ --check 紅且訊息含 hooks.json 沒載入', () => {
    const repo = makeRepo()
    const settingsFile = makeSettings(GOOD_ALLOW)
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    const rootWithSlash = repo.dir.endsWith('/') ? repo.dir : repo.dir + '/'
    s.permissions.allow.push(`read_file(${rootWithSlash})`)
    s.trustedWorkspaces = [repo.dir]
    fs.writeFileSync(settingsFile, JSON.stringify(s))

    const deps = {
      repoRoot: repo.dir,
      settingsFile,
      config: TEST_CONFIG,
      agyBin: null,
      which: (bin) => `/mock/bin/${bin}`,
    }
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 1)
    assert.match(errs.join('\n'), /hooks\.json 沒載入/)
  })

  test('matcherCovers：matcher 當 regex 涵蓋判定', () => {
    assert.equal(matcherCovers('run_command', 'run_command'), true)
    assert.equal(matcherCovers('run_command|view_file', 'run_command'), true)
    assert.equal(matcherCovers('*', 'run_command'), true)
    assert.equal(matcherCovers('', 'run_command'), true)
    assert.equal(matcherCovers('run_.*', 'run_command'), true)

    assert.equal(matcherCovers('view_file', 'run_command'), false)
    assert.equal(matcherCovers('run_commandx', 'run_command'), false)
    assert.equal(matcherCovers('(', 'run_command'), false)

    assert.equal(matcherCovers(['view_file', 'run_command'], 'run_command'), true)
    assert.equal(matcherCovers(['view_file', '('], 'run_command'), false)
  })

  test('matcher 為 run_command|view_file 合法 regex ⇒ --check 過', () => {
    const deps = makeValidSetupDeps(null)
    const hooksPayload = {
      command: {
        name: 'hooks',
        data: {
          hooks: [
            {
              name: 'block-dangerous',
              enabled: true,
              source: path.join(deps.env.HOME, '.gemini', 'config', 'hooks.json'),
              actions: [
                {
                  event: 'PreToolUse',
                  matcher: 'run_command|view_file',
                },
              ],
            },
          ],
        },
      },
    }
    deps.runAgyHooks = () => ({ exit: 0, stdout: JSON.stringify(hooksPayload) })
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)
    assert.match(logs.join('\n'), /\[hook:block-dangerous\] ✓ 已載入/)
  })

  test('source 指到 repo/.agents/hooks.json ⇒ 紅且訊息含「來源不是全域 hooks.json」與原始欄位清單', () => {
    const deps = makeValidSetupDeps(null)
    const workspaceHook = path.join(deps.repoRoot, '.agents', 'hooks.json')
    const hooksPayload = {
      command: {
        name: 'hooks',
        data: {
          hooks: [
            {
              name: 'block-dangerous',
              enabled: true,
              source: workspaceHook,
              actions: [{ event: 'PreToolUse', matcher: 'run_command' }],
            },
          ],
        },
      },
    }
    deps.runAgyHooks = () => ({ exit: 0, stdout: JSON.stringify(hooksPayload) })
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 1)
    const errOutput = errs.join('\n')
    assert.match(errOutput, /來源不是全域 hooks\.json：/)
    assert.ok(errOutput.includes(workspaceHook))
    assert.match(errOutput, /name=block-dangerous enabled=true matcher=run_command/)
  })

  test('deps.env 指到沒有守門的 tmp HOME＋沒有 LLM_TEAM_GUARD ⇒ 紅且訊息含「守門」', () => {
    const deps = makeValidSetupDeps(null)
    const emptyHome = tmpdir('empty-home-')
    deps.env = { HOME: emptyHome }
    delete deps.env.LLM_TEAM_GUARD
    deps.importMetaUrl = 'file:///nonexistent/setup.mjs'

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 1)
    const errOutput = errs.join('\n')
    assert.match(errOutput, /守門/)
  })

  test('LLM_TEAM_GUARD 指到不存在的檔、HOME 是空 tmp ⇒ exit 1 且 stderr 含「守門」', () => {
    const deps = makeValidSetupDeps(null)
    const emptyHome = tmpdir('empty-home-')
    deps.env = {
      HOME: emptyHome,
      LLM_TEAM_GUARD: path.join(emptyHome, 'nonexistent-guard.sh'),
    }
    deps.importMetaUrl = 'file:///nonexistent/setup.mjs'

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 1)
    const errOutput = errs.join('\n')
    assert.match(errOutput, /守門/)
  })

  test('tmp HOME 放一個檔 ⇒ 綠並印那條路徑', () => {
    const homeWithGuard = tmpdir('home-with-guard-')
    const guardDir = path.join(homeWithGuard, '.claude', 'hooks')
    fs.mkdirSync(guardDir, { recursive: true })
    const expectedGuardPath = path.join(guardDir, 'block-dangerous.sh')
    fs.writeFileSync(expectedGuardPath, '#!/usr/bin/env bash\n')

    const deps = makeValidSetupDeps(null)
    deps.env = { HOME: homeWithGuard }
    deps.importMetaUrl = 'file:///nonexistent/setup.mjs'

    const hooksPayload = {
      command: {
        name: 'hooks',
        data: {
          hooks: [
            {
              name: 'block-dangerous',
              enabled: true,
              source: path.join(deps.env.HOME, '.gemini', 'config', 'hooks.json'),
              actions: [
                {
                  event: 'PreToolUse',
                  matcher: 'run_command',
                },
              ],
            },
          ],
        },
      },
    }
    deps.runAgyHooks = () => ({ exit: 0, stdout: JSON.stringify(hooksPayload) })

    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    let code
    try {
      code = setupMain(['--check'], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)
    const logOutput = logs.join('\n')
    assert.match(logOutput, /\[守門\] ✓/)
    assert.ok(logOutput.includes(expectedGuardPath))
  })

  test('guardCandidates 候選順序逐字斷言（設了 ⇒ 四項、未設 ⇒ 三項，全部為絕對路徑）', () => {
    const fakeRepo = fs.realpathSync(tmpdir('repo-for-candidates-'))
    execFileSync('git', ['init', '-q', fakeRepo], { env: CLEAN_GIT_ENV })
    const fakeHome = fs.realpathSync(tmpdir('home-for-candidates-'))
    const fakeGuard = path.join(fs.realpathSync(tmpdir('guard-')), 'custom-guard.sh')
    const fakeMeta = pathToFileURL(path.join(fakeRepo, 'home', 'skills', 'llm-team', 'setup.mjs')).href

    // 1. 設了 LLM_TEAM_GUARD ⇒ 恰四項且全是絕對路徑
    const envSet = {
      HOME: fakeHome,
      LLM_TEAM_GUARD: fakeGuard,
    }

    const candidatesSet = guardCandidates(envSet, fakeMeta, fakeRepo)
    assert.equal(candidatesSet.length, 4, '設了 LLM_TEAM_GUARD 時候選清單應恰好為四項')

    for (const c of candidatesSet) {
      assert.equal(path.isAbsolute(c), true, `候選路徑應為絕對路徑：${c}`)
    }

    const expected = [
      path.resolve(fakeGuard),
      path.resolve(fakeRepo, 'scripts', 'claude-hooks', 'block-dangerous.sh'),
      path.resolve(fakeHome, '.claude', 'hooks', 'block-dangerous.sh'),
      fileURLToPath(new URL('../../hooks/block-dangerous.sh', fakeMeta)),
    ]
    assert.deepEqual(candidatesSet, expected)

    // 2. 未設 LLM_TEAM_GUARD ⇒ 恰三項且全是絕對路徑（不推假路徑）
    const envUnset = {
      HOME: fakeHome,
    }

    const candidatesUnset = guardCandidates(envUnset, fakeMeta, fakeRepo)
    assert.equal(candidatesUnset.length, 3, '未設 LLM_TEAM_GUARD 時候選清單應恰好為三項')

    for (const c of candidatesUnset) {
      assert.equal(path.isAbsolute(c), true, `候選路徑應為絕對路徑：${c}`)
    }

    assert.deepEqual(candidatesUnset, expected.slice(1), '未設時候選清單應為後三項真路徑')
  })

  test('resolveGuardPath 回的值必在 guardCandidates 陣列內', () => {
    const fakeRepo = tmpdir('repo-for-resolve-')
    execFileSync('git', ['init', '-q', fakeRepo], { env: CLEAN_GIT_ENV })
    const fakeHome = tmpdir('home-for-resolve-')
    const fakeMeta = pathToFileURL(path.join(fakeRepo, 'home', 'skills', 'llm-team', 'setup.mjs')).href

    // 情況 A：四個都不存在 ⇒ resolveGuardPath 回 null
    const envEmpty = { HOME: fakeHome }
    const cEmpty = guardCandidates(envEmpty, fakeMeta, fakeRepo)
    const resEmpty = resolveGuardPath(envEmpty, fakeMeta, fakeRepo)
    assert.equal(resEmpty, null)

    // 情況 B：順位 3（HOME 下）存在 ⇒ 回該路徑且在 candidates 內
    const homeGuardDir = path.join(fakeHome, '.claude', 'hooks')
    fs.mkdirSync(homeGuardDir, { recursive: true })
    const homeGuardPath = path.join(homeGuardDir, 'block-dangerous.sh')
    fs.writeFileSync(homeGuardPath, '#!/bin/sh\n')

    const cHome = guardCandidates(envEmpty, fakeMeta, fakeRepo)
    const resHome = resolveGuardPath(envEmpty, fakeMeta, fakeRepo)
    assert.equal(resHome, homeGuardPath)
    assert.ok(cHome.includes(resHome), 'resolveGuardPath 找到的值必在 candidates 陣列內')

    // 情況 C：順位 1（LLM_TEAM_GUARD）也存在 ⇒ 優先回順位 1 且在 candidates 內
    const customGuard = path.join(tmpdir('g1-'), 'g1.sh')
    fs.writeFileSync(customGuard, '#!/bin/sh\n')
    const envG1 = { HOME: fakeHome, LLM_TEAM_GUARD: customGuard }
    const cG1 = guardCandidates(envG1, fakeMeta, fakeRepo)
    const resG1 = resolveGuardPath(envG1, fakeMeta, fakeRepo)
    assert.equal(resG1, customGuard)
    assert.ok(cG1.includes(resG1), 'resolveGuardPath 找到的值必在 candidates 陣列內')
    assert.equal(resG1, cG1[0])
  })
})




