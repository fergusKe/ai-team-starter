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
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  CLEAN_GIT_ENV,
  loadConfig,
  validateProfiles,
  modelsFrom,
  writerFrom,
  memberName,
  memberFileName,
  nameMembers,
  reviewerNameFor,
  REVIEW_PROMPT_SENTINEL,
  PLAN_PROMPT_SENTINEL,
  buildSafeCommandRegex,
  SAFE_COMMAND_REGEX,
  isSafeCommand,
  parseStreamJson,
  isDeniedToolError,
  parseAgyRun,
  spawnTimedOut,
  buildCodexArgs,
  NO_EXEC_HEADER,
  outOfScope,
  assertSettingsAllowRegex,
  resolveAgyBin,
  runCodex,
  runCodexAsync,
  runAgy,
  runAgyAsync,
  buildAgyArgs,
  buildAgyStdin,
  buildSpawnEnv,
  WRITER_PROMPT_SENTINEL,
  parseArgs,
  spawnAsync,
  isDirectRun,
  rosterKey,
  compareRoster,
  readMembersJson,
  isRosterEntry,
  extractBriefCommands,
  briefCommandHeads,
  startsWithAllowedHead,
  preflightBriefCommands,
  writeTreeOf,
  USAGE_MODES,
  MEASUREMENT_SCHEMA_VERSION,
} from './lib.mjs'
import { main as writeMain, buildWriterPrompt } from './write.mjs'
import { main as councilMain, parseVerdicts, buildReviewPrompt } from './council.mjs'
import {
  main as setupMain,
  matcherCovers,
  guardCandidates,
  resolveGuardPath,
  claudeSettingsHasDangerousHook,
  codexPreToolUseCommands,
  codexPreToolUseEntries,
  codexMatcherCoversShell,
  harnessRoles,
} from './setup.mjs'

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ─────────────────── schema v2 測試 fixture（三種統整者 profiles） ───────────────────
// 🔴 測試一律用 v2Config() 產 config；統整者預設走 env LLM_TEAM_COORDINATOR=claude（等同 `--coordinator claude`），
//    要驗「缺 --coordinator ⇒ 拒絕」的測試自己給 deps.env = {}。
export const M = {
  agyOpus: { harness: 'agy', model: 'claude-opus-4-6-thinking', quotaBucket: 'agy-claude' },
  agyGemini: { harness: 'agy', model: 'gemini-3.1-pro-high', quotaBucket: 'gemini' },
  codexSol: { harness: 'codex', model: 'gpt-5.6-sol', quotaBucket: 'openai' },
  claudeCode: { harness: 'claude', model: 'claude-code', quotaBucket: 'anthropic' },
}

export function v2Profiles(override = {}) {
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

export function v2Config(override = {}) {
  return {
    schemaVersion: 2,
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
    fs.writeFileSync(customCfgPath, JSON.stringify(v2Config({ maxRounds: 4, custom: true })))
    // repo 根沒有 llm-team.config.json，但傳了 customCfgPath ⇒ 應成功載入
    const cfg = loadConfig(dir, customCfgPath)
    assert.equal(cfg.maxRounds, 4)
    assert.equal(cfg.custom, true)
  })

  test('schemaVersion 1（舊格式）⇒ throw 且訊息含「舊格式：models/codexTier 已廢，改成 profiles」；schemaVersion 3 ⇒ throw「不支援」', () => {
    const oldDir = tmpdir('old-schema-')
    fs.writeFileSync(
      path.join(oldDir, 'llm-team.config.json'),
      JSON.stringify({ schemaVersion: 1, models: { writer: 'w', reviewers: ['x'], codex: 'c' }, codexTier: 'all' })
    )
    assert.throws(() => loadConfig(oldDir), /舊格式：models\/codexTier 已廢，改成 profiles（見 SKILL\.md）/)

    const badSchemaDir = tmpdir('bad-schema-')
    fs.writeFileSync(path.join(badSchemaDir, 'llm-team.config.json'), JSON.stringify({ schemaVersion: 3 }))
    assert.throws(() => loadConfig(badSchemaDir), /schemaVersion 不支援.*預期 2/)
  })

  test('v2 帶著已廢欄位 models 或 codexTier ⇒ throw（不做自動轉換）', () => {
    const d1 = tmpdir('v2-stale-models-')
    fs.writeFileSync(path.join(d1, 'llm-team.config.json'), JSON.stringify(v2Config({ models: { writer: 'w' } })))
    assert.throws(() => loadConfig(d1), /已廢欄位 models\/codexTier/)
    const d2 = tmpdir('v2-stale-tier-')
    fs.writeFileSync(path.join(d2, 'llm-team.config.json'), JSON.stringify(v2Config({ codexTier: 'all' })))
    assert.throws(() => loadConfig(d2), /已廢欄位 models\/codexTier/)
  })

  test('maxRounds: 6（超過硬上限 5）⇒ throw', () => {
    const badRoundsDir = tmpdir('bad-rounds-')
    fs.writeFileSync(path.join(badRoundsDir, 'llm-team.config.json'), JSON.stringify(v2Config({ maxRounds: 6 })))
    assert.throws(() => loadConfig(badRoundsDir), /maxRounds 超過硬上限 5/)
  })

  test('branchPrefixes: "agy/" ⇒ loadConfig throw；["agy/", 1] ⇒ throw；[] ⇒ 過', () => {
    const dirString = tmpdir('bad-prefix-str-')
    fs.writeFileSync(
      path.join(dirString, 'llm-team.config.json'),
      JSON.stringify(v2Config({ branchPrefixes: 'agy/' }))
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
      JSON.stringify(v2Config({ branchPrefixes: ['agy/', 1] }))
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
      JSON.stringify(v2Config({ branchPrefixes: [] }))
    )
    const cfg = loadConfig(dirEmpty)
    assert.deepEqual(cfg.branchPrefixes, [])
  })

  test('branchPrefixes: [""] ⇒ throw；["agy/", " "] ⇒ throw；["agy/"] ⇒ 過', () => {
    const dirEmptyStr = tmpdir('bad-prefix-empty-')
    fs.writeFileSync(
      path.join(dirEmptyStr, 'llm-team.config.json'),
      JSON.stringify(v2Config({ branchPrefixes: [''] }))
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
      JSON.stringify(v2Config({ branchPrefixes: ['agy/', ' '] }))
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
      JSON.stringify(v2Config({ branchPrefixes: ['agy/'] }))
    )
    const cfg = loadConfig(dirOk)
    assert.deepEqual(cfg.branchPrefixes, ['agy/'])
  })

  test('合法 config ⇒ 成功解析回傳物件', () => {
    const okDir = tmpdir('ok-repo-')
    fs.writeFileSync(path.join(okDir, 'llm-team.config.json'), JSON.stringify(TEST_CONFIG))
    const cfg = loadConfig(okDir)
    assert.equal(cfg.schemaVersion, 2)
    assert.equal(cfg.maxRounds, 3)
  })

  describe('1.8.0 ①：usage.mode（量測與 Q6 閘門解耦）', () => {
    test('缺 usage 欄位 ⇒ loadConfig 補 { mode: "off" }（真源與 export 出去的預設都是 off）', () => {
      const d = tmpdir('usage-default-')
      fs.writeFileSync(path.join(d, 'llm-team.config.json'), JSON.stringify(v2Config()))
      const cfg = loadConfig(d)
      assert.deepEqual(cfg.usage, { mode: 'off' })
    })

    test('usage.mode 為 record／cohort ⇒ 過；未知值 ⇒ throw 指名 usage.mode', () => {
      for (const mode of ['off', 'record', 'cohort']) {
        assert.deepEqual(USAGE_MODES.includes(mode), true, `USAGE_MODES 應含 ${mode}`)
        const d = tmpdir(`usage-${mode}-`)
        fs.writeFileSync(path.join(d, 'llm-team.config.json'), JSON.stringify(v2Config({ usage: { mode } })))
        const cfg = loadConfig(d)
        assert.equal(cfg.usage.mode, mode)
      }
      const bad = tmpdir('usage-bad-')
      fs.writeFileSync(path.join(bad, 'llm-team.config.json'), JSON.stringify(v2Config({ usage: { mode: 'always' } })))
      assert.throws(() => loadConfig(bad), /usage\.mode 不支援/)
    })

    test('usage 不是物件（字串／陣列）⇒ throw 指名 usage', () => {
      const d1 = tmpdir('usage-string-')
      fs.writeFileSync(path.join(d1, 'llm-team.config.json'), JSON.stringify(v2Config({ usage: 'off' })))
      assert.throws(() => loadConfig(d1), /config usage 不合法/)
      const d2 = tmpdir('usage-array-')
      fs.writeFileSync(path.join(d2, 'llm-team.config.json'), JSON.stringify(v2Config({ usage: ['off'] })))
      assert.throws(() => loadConfig(d2), /config usage 不合法/)
    })

    test('真源模板 config.json 的 usage.mode 為 off（預設 off，不強制每票餵口徑）', () => {
      const cfg = loadConfig(null, fileURLToPath(new URL('./config.json', import.meta.url)))
      assert.equal(cfg.usage.mode, 'off')
    })

    test('MEASUREMENT_SCHEMA_VERSION 是正整數（accept 一律蓋這個版本；cohort 只收版本相符的票）', () => {
      assert.equal(Number.isInteger(MEASUREMENT_SCHEMA_VERSION), true)
      assert.ok(MEASUREMENT_SCHEMA_VERSION >= 1)
    })
  })

  test('真源模板 config.json 走 loadConfig 不 throw；三個 profile 都解得出名單', () => {
    const cfg = loadConfig(null, fileURLToPath(new URL('./config.json', import.meta.url)))
    assert.deepEqual(Object.keys(cfg.profiles), ['claude', 'agy', 'codex'])
    for (const p of ['claude', 'agy', 'codex']) {
      const m = modelsFrom(cfg, {}, p)
      assert.ok(m.reviewers.length >= 1 && m.blockReviewers.length >= 1, `${p} 名單非空`)
      assert.equal(m.coordinator.profile, p)
    }
    // 模板名單（Fergus 2026-09-14 硬約束）：agy／codex profile 不含任何 claude
    for (const p of ['agy', 'codex']) {
      const m = modelsFrom(cfg, {}, p)
      assert.ok([...m.reviewers, ...m.blockReviewers].every((x) => x.harness !== 'claude'), `${p} 名單不含 claude`)
      assert.equal(m.adjudicator, 'human')
    }
  })
})

describe('validateProfiles：config 不變式（每條各自紅、各自指名 profile 與不變式）', () => {
  function cfgWith(claudeOverride) {
    return v2Config({ profiles: v2Profiles({ claude: claudeOverride }) })
  }
  function loadOf(cfg) {
    const d = tmpdir('inv-')
    fs.writeFileSync(path.join(d, 'llm-team.config.json'), JSON.stringify(cfg))
    return () => loadConfig(d)
  }

  test('陽性對照：合法 v2Config ⇒ validateProfiles 回 true、loadConfig 不 throw', () => {
    assert.equal(validateProfiles(v2Config()), true)
    assert.doesNotThrow(loadOf(v2Config()))
  })

  test('缺 profiles ⇒ throw 含「缺 profiles」', () => {
    assert.throws(loadOf(v2Config({ profiles: undefined })), /缺 profiles/)
    assert.throws(loadOf(v2Config({ profiles: {} })), /缺 profiles/)
  })

  test('缺必要欄位（adjudicator）⇒ throw 指名 profiles.claude 缺 adjudicator', () => {
    assert.throws(loadOf(cfgWith({ adjudicator: undefined })), /profiles\.claude 缺必要欄位 adjudicator/)
  })

  test('缺 writer ⇒ throw 指名 writer', () => {
    assert.throws(loadOf(v2Config({ writer: undefined })), /writer 必須是成員物件/)
  })

  test('🔴 writer.harness 只准 agy（codex 複審 Q1-CLAUDE）：writer.harness=claude ⇒ loadConfig throw；=codex ⇒ throw；writerFrom 讀者側也 throw；陽性對照 agy ⇒ 過', () => {
    const asClaude = { harness: 'claude', model: 'claude-opus', quotaBucket: 'anthropic' }
    const asCodex = { harness: 'codex', model: 'gpt-5.6-sol', quotaBucket: 'openai' }
    assert.throws(loadOf(v2Config({ writer: asClaude })), /writer\.harness 只准 agy.*得到 "claude"/)
    assert.throws(loadOf(v2Config({ writer: asCodex })), /writer\.harness 只准 agy.*得到 "codex"/)
    // 讀者側（deps.config 注入繞過 loadConfig 時）也擋：writerFrom／modelsFrom
    assert.throws(() => writerFrom(v2Config({ writer: asClaude }), {}), /writer\.harness 只准 agy/)
    assert.throws(() => modelsFrom(v2Config({ writer: asCodex }), {}, 'claude'), /writer\.harness 只准 agy/)
    // LLM_TEAM_WRITER 只覆寫 model，蓋不掉 harness
    assert.equal(writerFrom(v2Config(), { LLM_TEAM_WRITER: 'x' }).harness, 'agy')
    // 陽性對照：同一份 config、writer 是 agy ⇒ 過
    assert.doesNotThrow(loadOf(v2Config()))
    assert.equal(writerFrom(v2Config(), {}).harness, 'agy')
  })

  test('未知 harness／quotaBucket／effort ⇒ throw 指名欄位', () => {
    assert.throws(loadOf(cfgWith({ reviewers: [{ harness: 'ollama', model: 'x', quotaBucket: 'gemini' }] })), /profiles\.claude\.reviewers\[0\]\.harness 未知/)
    assert.throws(loadOf(cfgWith({ reviewers: [{ harness: 'agy', model: 'x', quotaBucket: 'free' }] })), /profiles\.claude\.reviewers\[0\]\.quotaBucket 未知/)
    assert.throws(loadOf(cfgWith({ reviewers: [{ ...M.codexSol, effort: 'ultra' }] })), /effort 只准 high\|medium/)
  })

  test('同一名單成員重複（harness+model 相同）⇒ throw 含「重複」', () => {
    assert.throws(loadOf(cfgWith({ reviewers: [M.agyGemini, { ...M.agyGemini }] })), /reviewers\[1\] 在同一名單重複/)
  })

  test('統整者出現在 reviewers／blockReviewers／adjudicator ⇒ 各自 throw 含「統整者本人」', () => {
    const coordAsAgy = { harness: 'agy', model: 'gemini-3.1-pro-high', quotaBucket: 'gemini' }
    assert.throws(
      loadOf(cfgWith({ coordinator: coordAsAgy, reviewers: [M.codexSol, coordAsAgy], blockReviewers: [M.codexSol], adjudicator: 'human' })),
      /profiles\.claude\.reviewers\[1\] 就是統整者本人/
    )
    assert.throws(
      loadOf(cfgWith({ coordinator: coordAsAgy, reviewers: [M.codexSol], blockReviewers: [coordAsAgy], adjudicator: 'human' })),
      /profiles\.claude\.blockReviewers\[0\] 就是統整者本人/
    )
    assert.throws(
      loadOf(cfgWith({ coordinator: coordAsAgy, reviewers: [M.codexSol], blockReviewers: [M.codexSol], adjudicator: coordAsAgy })),
      /profiles\.claude\.adjudicator 就是統整者本人/
    )
  })

  test('統整者與 reviewer／blockReviewer／adjudicator 同 quotaBucket ⇒ 各自 throw 含「同 quotaBucket」', () => {
    const anthropicViaAgy = { harness: 'agy', model: 'claude-opus-4-6-thinking', quotaBucket: 'anthropic' }
    assert.throws(loadOf(cfgWith({ reviewers: [anthropicViaAgy] })), /reviewers\[0\] 與統整者同 quotaBucket=anthropic/)
    assert.throws(loadOf(cfgWith({ blockReviewers: [anthropicViaAgy] })), /blockReviewers\[0\] 與統整者同 quotaBucket=anthropic/)
    assert.throws(loadOf(cfgWith({ adjudicator: { harness: 'codex', model: 'x', quotaBucket: 'anthropic' } })), /adjudicator 與統整者同 quotaBucket=anthropic/)
  })

  test('adjudicator 出現在 reviewers ⇒ throw 含「裁決者 ∉ 一般票複審名單」；只在 blockReviewers ⇒ 過', () => {
    assert.throws(loadOf(cfgWith({ reviewers: [M.agyGemini, M.codexSol], adjudicator: M.codexSol })), /adjudicator 出現在 reviewers/)
    assert.doesNotThrow(loadOf(cfgWith({ reviewers: [M.agyGemini], blockReviewers: [M.agyGemini, M.codexSol], adjudicator: M.codexSol })))
  })

  test('adjudicator 可以是 "human"；其他字串 ⇒ throw', () => {
    assert.doesNotThrow(loadOf(cfgWith({ adjudicator: 'human' })))
    assert.throws(loadOf(cfgWith({ adjudicator: 'robot' })), /adjudicator 必須是成員物件/)
  })

  test('blockAdjudicator ≠ "human"（成員物件或別的字串）⇒ throw', () => {
    assert.throws(loadOf(cfgWith({ blockAdjudicator: M.codexSol })), /blockAdjudicator 只准 "human"/)
    assert.throws(loadOf(cfgWith({ blockAdjudicator: 'codex' })), /blockAdjudicator 只准 "human"/)
  })

  test('reviewers 或 blockReviewers 為空 ⇒ throw 含「非空陣列」', () => {
    assert.throws(loadOf(cfgWith({ reviewers: [] })), /profiles\.claude\.reviewers 必須是非空陣列/)
    assert.throws(loadOf(cfgWith({ blockReviewers: [] })), /profiles\.claude\.blockReviewers 必須是非空陣列/)
  })

  test('🔴 claude harness 只准當 coordinator：出現在 reviewers／blockReviewers／adjudicator ⇒ 各自 throw（Fergus 2026-09-14 硬約束）', () => {
    const claudeOpus = { harness: 'claude', model: 'opus', quotaBucket: 'anthropic' }
    const agyCoord = { harness: 'agy', model: 'gemini-3.1-pro-high', quotaBucket: 'gemini' }
    assert.throws(loadOf(cfgWith({ coordinator: agyCoord, reviewers: [claudeOpus], blockReviewers: [M.codexSol], adjudicator: 'human' })), /reviewers\[0\] 是 claude harness/)
    assert.throws(loadOf(cfgWith({ coordinator: agyCoord, reviewers: [M.codexSol], blockReviewers: [claudeOpus], adjudicator: 'human' })), /blockReviewers\[0\] 是 claude harness/)
    assert.throws(loadOf(cfgWith({ coordinator: agyCoord, reviewers: [M.codexSol], blockReviewers: [M.codexSol], adjudicator: claudeOpus })), /adjudicator 是 claude harness/)
    // 陽性對照：同一組但 claude 只在 coordinator ⇒ 過
    assert.doesNotThrow(loadOf(cfgWith({ coordinator: claudeOpus, reviewers: [M.agyGemini], blockReviewers: [M.codexSol], adjudicator: 'human' })))
  })
})

describe('複審名單身分三元組（rosterKey／compareRoster／readMembersJson）', () => {
  test('rosterKey 不含 name；compareRoster 是多重集合比對：同 name 不同 model ⇒ missing＋unexpected 各一；重複三元組要兩次都到；順序無關', () => {
    const opus = { name: 'agy/opus', ...M.agyOpus }
    const gemini = { name: 'agy/gemini', ...M.agyGemini }
    const geminiLow = { name: 'agy/gemini', harness: 'agy', model: 'gemini-3.1-pro-low', quotaBucket: 'gemini' }
    assert.equal(rosterKey(gemini), 'agy/gemini-3.1-pro-high/gemini')
    assert.equal(rosterKey({ ...gemini, name: 'whatever' }), rosterKey(gemini), 'name 不進 key')
    assert.deepEqual(compareRoster([opus, gemini], [gemini, opus]), { missing: [], unexpected: [], mismatch: false })
    const d = compareRoster([opus, gemini], [opus, geminiLow])
    assert.equal(d.mismatch, true)
    assert.deepEqual(d.missing, [gemini])
    assert.deepEqual(d.unexpected, [geminiLow])
    assert.deepEqual(compareRoster([opus, gemini], [opus]).missing, [gemini])
    assert.deepEqual(compareRoster([opus], [opus, gemini]).unexpected, [gemini])
    // 同一三元組兩份（nameMembers 的 -2 只是顯示名）：實際只到一份 ⇒ missing 一份
    assert.deepEqual(compareRoster([gemini, { ...gemini, name: 'agy/gemini-2' }], [gemini]).missing, [{ ...gemini, name: 'agy/gemini-2' }])
    assert.equal(compareRoster([], []).mismatch, false)
  })

  test('readMembersJson：缺檔／壞 JSON／不是陣列／任一項缺身分欄位 ⇒ null（fail-closed）；合法 ⇒ 陣列', () => {
    const d = tmpdir('members-')
    const f = path.join(d, 'members.json')
    assert.equal(readMembersJson(f), null, '缺檔')
    fs.writeFileSync(f, '{not json')
    assert.equal(readMembersJson(f), null, '壞 JSON')
    fs.writeFileSync(f, JSON.stringify({ name: 'x' }))
    assert.equal(readMembersJson(f), null, '不是陣列')
    fs.writeFileSync(f, JSON.stringify([{ name: 'agy/gemini', harness: 'agy', model: 'gemini-3.1-pro-high' }]))
    assert.equal(readMembersJson(f), null, '缺 quotaBucket')
    fs.writeFileSync(f, JSON.stringify([{ name: 'agy/gemini', harness: 'agy', model: '', quotaBucket: 'gemini' }]))
    assert.equal(readMembersJson(f), null, 'model 空字串')
    fs.writeFileSync(f, JSON.stringify([{ name: 'agy/gemini', ...M.agyGemini, overall: '簽' }]))
    assert.deepEqual(readMembersJson(f), [{ name: 'agy/gemini', ...M.agyGemini, overall: '簽' }])
    assert.equal(isRosterEntry(null), false)
    assert.equal(isRosterEntry({ name: 'a', harness: 'agy', model: 'm', quotaBucket: 'gemini' }), true)
  })
})

describe('modelsFrom：依統整者 profile 解析角色與環境變數覆寫', () => {
  const cfg = v2Config()

  test('coordinator 參數指定 claude ⇒ writer／reviewers（含 name）／blockReviewers／adjudicator／blockAdjudicator', () => {
    const m = modelsFrom(cfg, {}, 'claude')
    assert.deepEqual(m.writer, { harness: 'agy', model: 'gemini-3.8-flash-high', quotaBucket: 'gemini' })
    assert.equal(m.coordinator.profile, 'claude')
    assert.equal(m.coordinator.harness, 'claude')
    assert.deepEqual(m.reviewers.map((x) => x.name), ['agy/opus', 'agy/gemini'])
    assert.deepEqual(m.blockReviewers.map((x) => x.name), ['agy/opus', 'agy/gemini', 'codex/gpt-5-6-sol'])
    assert.equal(m.adjudicator.name, 'codex/gpt-5-6-sol')
    assert.equal(m.blockAdjudicator, 'human')
  })

  test('coordinator 來自 env LLM_TEAM_COORDINATOR；參數優先於 env', () => {
    assert.equal(modelsFrom(cfg, { LLM_TEAM_COORDINATOR: 'agy' }).coordinator.profile, 'agy')
    assert.equal(modelsFrom(cfg, { LLM_TEAM_COORDINATOR: 'agy' }, 'codex').coordinator.profile, 'codex')
    assert.equal(modelsFrom(cfg, {}, 'agy').adjudicator, 'human')
  })

  test('缺 coordinator 或不在 profiles ⇒ throw 且訊息列出可用 profiles', () => {
    assert.throws(() => modelsFrom(cfg, {}), /未指定.*可用 profiles：claude, agy, codex/)
    assert.throws(() => modelsFrom(cfg, {}, 'gpt'), /不存在：gpt.*可用 profiles：claude, agy, codex/)
    assert.throws(() => modelsFrom(cfg, { LLM_TEAM_COORDINATOR: 'nope' }), /不存在：nope/)
  })

  test('LLM_TEAM_WRITER 覆寫 writer.model（不改 process.env）；LLM_TEAM_CODEX 已拿掉、不影響任何角色', () => {
    const m = modelsFrom(cfg, { LLM_TEAM_WRITER: 'my-custom-writer', LLM_TEAM_CODEX: 'my-custom-codex' }, 'claude')
    assert.equal(m.writer.model, 'my-custom-writer')
    assert.equal(m.writer.harness, 'agy')
    assert.equal(m.blockReviewers[2].model, 'gpt-5.6-sol')
    assert.equal(m.adjudicator.model, 'gpt-5.6-sol')
    assert.equal(writerFrom(cfg, {}).model, 'gemini-3.8-flash-high')
  })

  test('memberName／memberFileName／nameMembers：agy/gemini、codex/gpt-5-6-sol、同名加 -2、檔名 / ⇒ -', () => {
    assert.equal(memberName(M.agyGemini), 'agy/gemini')
    assert.equal(memberName(M.codexSol), 'codex/gpt-5-6-sol')
    assert.equal(memberName({ harness: 'claude', model: 'opus' }), 'claude/opus')
    assert.equal(memberFileName('agy/gemini'), 'agy-gemini')
    const named = nameMembers([M.agyGemini, { ...M.agyGemini, model: 'gemini-3.1-pro-low' }, M.codexSol])
    assert.deepEqual(named.map((x) => x.name), ['agy/gemini', 'agy/gemini-2', 'codex/gpt-5-6-sol'])
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

describe('extractBriefCommands／preflightBriefCommands', () => {
  test('(a) inline span `grep -e "|| x" f` ⇒ 1 條 failure、line 正確、reason 含 |', () => {
    const brief = '說明文字\n`grep -e "|| x" f`\n結尾'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 1, `應有 1 條 failure，實際看到：${JSON.stringify(failures)}`)
    assert.equal(failures[0].line, 2, `line 應為 2，實際看到：${failures[0]?.line}`)
    assert.equal(failures[0].cmd, 'grep -e "|| x" f', `cmd 應為 grep -e "|| x" f，實際看到：${failures[0]?.cmd}`)
    assert.match(failures[0].reason, /\|/, `reason 應含 |，實際看到：${failures[0]?.reason}`)
  })

  test('(b) 同一指令放在 ```bash fence 內 ⇒ 同結果，line 是 fence 內那一行', () => {
    const brief = '# 標題\n```bash\ngrep -e "|| x" f\n```\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 1, `應有 1 條 failure，實際看到：${JSON.stringify(failures)}`)
    assert.equal(failures[0].line, 3, `line 應為 fence 內那一行（3），實際看到：${failures[0]?.line}`)
    assert.equal(failures[0].cmd, 'grep -e "|| x" f', `cmd 應為 grep -e "|| x" f，實際看到：${failures[0]?.cmd}`)
    assert.match(failures[0].reason, /\|/, `reason 應含 |，實際看到：${failures[0]?.reason}`)
  })

  test('(c) 放在 ```ts fence 內 ⇒ 0 failures', () => {
    const brief = '# 標題\n```ts\ngrep -e "|| x" f\n```\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 0, `ts fence 內應為 0 failures，實際看到：${JSON.stringify(failures)}`)
  })

  test('(c2) ```bash title="x" fence 內 `date > out` ⇒ 1 failure、reason 含 >', () => {
    const brief = '# 標題\n```bash title="x"\ndate > out\n```\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 1, `bash title="x" fence 內應有 1 條 failure，實際看到：${JSON.stringify(failures)}`)
    assert.match(failures[0]?.reason ?? '', />/, `reason 應含 >，實際看到：${JSON.stringify(failures)}`)
  })

  test('(c3) ```bashx fence 內同一行 ⇒ 0 failures', () => {
    const brief = '# 標題\n```bashx\ndate > out\n```\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 0, `bashx fence 內應為 0 failures，實際看到：${JSON.stringify(failures)}`)
  })

  test('(c4) ```sh { .class } fence 內同一行 ⇒ 1 failure', () => {
    const brief = '# 標題\n```sh { .class }\ndate > out\n```\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 1, `sh { .class } fence 內應有 1 條 failure，實際看到：${JSON.stringify(failures)}`)
    assert.match(failures[0]?.reason ?? '', />/, `reason 應含 >，實際看到：${JSON.stringify(failures)}`)
  })

  test('(d) 純文字行「grep 樣式不准含 `|`」⇒ 0 failures（| 那個 span 不以指令頭開頭）', () => {
    const brief = 'grep 樣式不准含 `|`\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 0, `非准許指令頭 span 應為 0 failures，實際看到：${JSON.stringify(failures)}`)
  })

  test('(e) `grep -e x f | head -3` ⇒ 0 failures（管線接在准許頭之間）', () => {
    const brief = '`grep -e x f | head -3`\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 0, `准許指令頭間的管線應為 0 failures，實際看到：${JSON.stringify(failures)}`)
  })

  test('(f) `$(cat f)` ⇒ 0 failures（不以准許頭開頭，不在射程）而 `cat $(ls)` ⇒ 1 failure 含 $', () => {
    const brief1 = '`$(cat f)`\n'
    const res1 = preflightBriefCommands(brief1)
    assert.equal(res1.failures.length, 0, `$(cat f) 不在射程應為 0 failures，實際看到：${JSON.stringify(res1.failures)}`)

    const brief2 = '`cat $(ls)`\n'
    const res2 = preflightBriefCommands(brief2)
    assert.equal(res2.failures.length, 1, `cat $(ls) 應有 1 failure，實際看到：${JSON.stringify(res2.failures)}`)
    assert.match(res2.failures[0].reason, /\$/, `reason 應含 $，實際看到：${res2.failures[0]?.reason}`)
  })

  test('(g) `grepper -x f` ⇒ 0 failures（token boundary）', () => {
    const brief = '`grepper -x f`\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 0, `grepper 非准許頭應為 0 failures，實際看到：${JSON.stringify(failures)}`)
  })

  test('(h) config allowCommandHeads: [\'pnpm vitest run\'] 時 `pnpm vitest run a | b` ⇒ 1 failure，沒有那個 head 時 ⇒ 0（不在射程）', () => {
    const brief = '`pnpm vitest run a | b`\n'
    const resWith = preflightBriefCommands(brief, { allowCommandHeads: ['pnpm vitest run'] })
    assert.equal(resWith.failures.length, 1, `有 custom head 時應有 1 failure，實際看到：${JSON.stringify(resWith.failures)}`)

    const resWithout = preflightBriefCommands(brief, {})
    assert.equal(resWithout.failures.length, 0, `無 custom head 時應為 0 failures，實際看到：${JSON.stringify(resWithout.failures)}`)
  })

  test('(i) 未關閉 fence ⇒ throw 且訊息含行號', () => {
    const brief = '第 1 行\n第 2 行\n```bash\nls -la\n'
    assert.throws(
      () => preflightBriefCommands(brief),
      (err) => {
        assert.match(err.message, /brief 格式錯誤：第 3 行的 fence 沒有關閉/, `訊息應含行號 3，實際看到：${err.message}`)
        return true
      }
    )
  })

  test('(j) 雙 backtick span `` grep -e "a`b" f `` ⇒ 1 failure 含 `', () => {
    const brief = '`` grep -e "a`b" f ``\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 1, `雙 backtick span 應有 1 failure，實際看到：${JSON.stringify(failures)}`)
    assert.match(failures[0].reason, /`/, `reason 應含反引號 \`，實際看到：${failures[0]?.reason}`)
  })

  test('(k) list 前綴與 $ 提示都會被剝：- $ grep -e "|" f ⇒ 1 failure 且 cmd 欄是剝完的字串', () => {
    const brief = '```bash\n- $ grep -e "|" f\n```\n'
    const { failures } = preflightBriefCommands(brief)
    assert.equal(failures.length, 1, `應有 1 failure，實際看到：${JSON.stringify(failures)}`)
    assert.equal(failures[0].cmd, 'grep -e "|" f', `cmd 欄應為剝完的字串，實際看到：${failures[0]?.cmd}`)
    assert.match(failures[0].reason, /\|/, `reason 應含 |，實際看到：${failures[0]?.reason}`)
  })

  test('(l) ; & | < > ` $ 七個字元逐一表格測試：grep -e "<c>" f 各 1 failure、reason 含該字元', () => {
    const chars = [';', '&', '|', '<', '>', '`', '$']
    for (const c of chars) {
      const cmd = `grep -e "${c}" f`
      const brief = '`` ' + cmd + ' ``\n'
      const { failures } = preflightBriefCommands(brief)
      assert.equal(failures.length, 1, `字元 [${c}] 應有 1 failure，實際看到：${JSON.stringify(failures)}`)
      assert.equal(failures[0].cmd, cmd, `cmd 應為 ${cmd}，實際看到：${failures[0]?.cmd}`)
      assert.ok(failures[0].reason.includes(c), `reason 應含字元 [${c}]，實際看到：${failures[0]?.reason}`)
    }
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
  test('🔴 陽性對照（2026-09-15 票 coordinator-usage 真咬到）：ENOENT 的「declaring permissions … stat …」不是被拒；真被拒的形狀才是', () => {
    const enoent = JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: 28, state: 'ERROR', step_type: 'tool', tool_name: 'view_file',
        tool_info: { name: 'view_file', parameters: { AbsolutePath: '/repo/.local/x/lifecycle.ndjson' },
          error: { type: 'TOOL_ERROR', message: 'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) failed to read file: stat /repo/.local/x/lifecycle.ndjson: no such file or directory' } },
      },
    })
    const ok = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'c1', response: '做完了', denied_actions: [] } })
    const p = parseStreamJson(`${enoent}\n${ok}`)
    assert.equal(p.denied.length, 0, `ENOENT 被當成 denied：${JSON.stringify(p.denied)}`)
    assert.equal(p.steps[0].state, 'ERROR', '步驟錯誤仍要留在 steps 讓人看得到')
    assert.ok(isDeniedToolError('permission check failed for command "pwd; ls -la": user denied permission to run command'))
    assert.ok(!isDeniedToolError('declaring permissions: cortex tool view_file: failed to read file: stat /x: no such file or directory'))
    assert.ok(!isDeniedToolError(''))
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

describe('writeTreeOf：暫存 index 取得乾淨 tree sha', () => {
  test('(a) writeTreeOf：repo 有已 commit 檔＋一個未 commit 修改＋一個 untracked 新檔＋.agy-write/x ⇒ 回 40 hex；用 git ls-tree -r TREE --name-only 斷言含新檔、不含 .agy-write/x；呼叫前後 git diff --cached --name-only 皆空（真 index 沒被動）；暫存 index 檔已刪', () => {
    const repo = makeRepo()
    // makeRepo 已 commit add.mjs
    // 一個未 commit 修改
    fs.appendFileSync(path.join(repo.dir, 'add.mjs'), '// uncommitted\n')
    // 一個 untracked 新檔
    fs.writeFileSync(path.join(repo.dir, 'untracked.txt'), 'new file\n')
    // .agy-write/x
    fs.mkdirSync(path.join(repo.dir, '.agy-write'), { recursive: true })
    fs.writeFileSync(path.join(repo.dir, '.agy-write', 'x'), 'agy internal\n')

    assert.equal(repo.g('diff', '--cached', '--name-only').trim(), '', '呼叫前真 index cached 應為空')
    const tmpIndex = path.join(os.tmpdir(), `agy-tree-index-${process.pid}-${crypto.randomUUID()}`)

    const tree = writeTreeOf(repo.dir, tmpIndex)

    assert.match(tree, /^[0-9a-f]{40}$/, 'writeTreeOf 應回傳 40 hex SHA')
    assert.equal(repo.g('diff', '--cached', '--name-only').trim(), '', '呼叫後真 index cached 應為空')
    assert.equal(fs.existsSync(tmpIndex), false, '暫存 index 檔已刪')

    const lsTree = repo.g('ls-tree', '-r', tree, '--name-only').trim().split('\n')
    assert.ok(lsTree.includes('untracked.txt'), '含新檔')
    assert.ok(lsTree.includes('add.mjs'), '含已 commit 但修改的檔')
    assert.ok(!lsTree.includes('.agy-write/x'), '不含 .agy-write/x')

    // (a2) writeTreeOf 補斷言：對已修改檔用 git ls-tree TREE -- FILE 取 blob sha，與 git hash-object FILE（工作樹現況）相等；且與 git rev-parse HEAD:FILE（修改前）不等
    const lsTreeOut = repo.g('ls-tree', tree, '--', 'add.mjs').trim()
    const blobSha = lsTreeOut.split(/\s+/)[2]
    const workingSha = repo.g('hash-object', path.join(repo.dir, 'add.mjs')).trim()
    const headSha = repo.g('rev-parse', 'HEAD:add.mjs').trim()
    assert.equal(blobSha, workingSha, 'writeTreeOf 的已修改檔 blob sha 應等於工作樹現況 (hash-object)')
    assert.notEqual(blobSha, headSha, 'writeTreeOf 的已修改檔 blob sha 應與修改前 HEAD blob sha 不等')
  })

  test('(a2) writeTreeOf 補斷言：對已修改檔用 git ls-tree TREE -- FILE 取 blob sha，與 git hash-object FILE（工作樹現況）相等；且與 git rev-parse HEAD:FILE（修改前）不等', () => {
    const repo = makeRepo()
    // makeRepo 已 commit add.mjs
    const headSha = repo.g('rev-parse', 'HEAD:add.mjs').trim()
    // 一個未 commit 修改
    fs.appendFileSync(path.join(repo.dir, 'add.mjs'), '// uncommitted modifications\n')
    const workingSha = repo.g('hash-object', path.join(repo.dir, 'add.mjs')).trim()

    const tree = writeTreeOf(repo.dir)

    const lsTreeOut = repo.g('ls-tree', tree, '--', 'add.mjs').trim()
    const blobSha = lsTreeOut.split(/\s+/)[2]
    assert.equal(blobSha, workingSha, `blob sha (${blobSha}) 應與工作樹現況 (${workingSha}) 相等`)
    assert.notEqual(blobSha, headSha, `blob sha (${blobSha}) 應與修改前 HEAD (${headSha}) 不等`)
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

  test('🔴 writer.harness=claude 的 config ⇒ write.main 回 2、訊息含「writer.harness 只准 agy」、假 agy 沒被跑（沒寫 add.test.mjs）', () => {
    const repo = makeRepo({ writer: { harness: 'claude', model: 'claude-opus', quotaBucket: 'anthropic' } })
    const r = runWriteReal(repo, 'ok')
    assert.equal(r.code, 2)
    assert.match(r.errs, /writer\.harness 只准 agy/)
    assert.ok(!fs.existsSync(path.join(repo.dir, 'add.test.mjs')), '寫手不該被跑起來')
  })
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
  test('buildWriterPrompt 有 allowedHeads 時輸出含「引號裡面也算」，沒有 allowedHeads 時不含', () => {
    const withHeads = buildWriterPrompt({
      brief: 'B',
      worktree: '/w',
      allowlist: ['a.ts'],
      round: 1,
      allowedHeads: ['pwd', 'node --test'],
    })
    assert.match(withHeads, /引號裡面也算/, `有 allowedHeads 時應含「引號裡面也算」，實際：${withHeads}`)

    const withoutHeads = buildWriterPrompt({
      brief: 'B',
      worktree: '/w',
      allowlist: ['a.ts'],
      round: 1,
      allowedHeads: [],
    })
    assert.doesNotMatch(withoutHeads, /引號裡面也算/, `無 allowedHeads 時不應含「引號裡面也算」，實際：${withoutHeads}`)

    const noHeads = buildWriterPrompt({
      brief: 'B',
      worktree: '/w',
      allowlist: ['a.ts'],
      round: 1,
    })
    assert.doesNotMatch(noHeads, /引號裡面也算/, `未傳 allowedHeads 時不應含「引號裡面也算」，實際：${noHeads}`)
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
    assert.ok(fs.existsSync(path.join(outDir, 'round-1.response.md')), 'round-1.response.md 應存在')
    assert.equal(fs.readFileSync(path.join(outDir, 'round-1.response.md'), 'utf8'), 'ok')
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
  test('buildReviewPrompt 第一行固定是 REVIEW_PROMPT_SENTINEL，第二行才是「你是本 repo 的複審者」', () => {
    const p = buildReviewPrompt({ brief: 'B', diff: '+x', tier: 'standard', diffStat: '1 file', writerModel: 'w' })
    const lines = p.split('\n')
    assert.equal(lines[0], REVIEW_PROMPT_SENTINEL)
    assert.equal(REVIEW_PROMPT_SENTINEL, '【llm-team 複審票】')
    assert.match(lines[1], /^你是本 repo 的複審者（一般票）/)
  })
  test('council plan：prompt.md 第一行是 PLAN_PROMPT_SENTINEL、原提示內容不動；review：prompt.md 以 REVIEW_PROMPT_SENTINEL 開頭', async () => {
    const repo = makeRepo()
    const promptFile = path.join(tmpdir('plan-'), 'plan.md')
    fs.writeFileSync(promptFile, '規劃這張票\n第二行')
    const outDir = path.join(repo.dir, '.plan')
    const deps = {
      runOne: (name, model) => ({ name, model, exit: 0, ms: 1, empty: false, denied: [], text: '整份：簽' }),
    }
    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await councilMain(['plan', '--worktree', repo.dir, '--prompt', promptFile, '--out', outDir], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)
    const written = fs.readFileSync(path.join(outDir, 'prompt.md'), 'utf8')
    assert.equal(written, PLAN_PROMPT_SENTINEL + '\n規劃這張票\n第二行')
    assert.equal(PLAN_PROMPT_SENTINEL, '【llm-team 規劃】')

    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'B')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir2 = path.join(repo.dir, '.review')
    console.log = () => {}
    try {
      await councilMain(['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir2, '--tier', 'standard'], deps)
    } finally {
      console.log = origLog
    }
    assert.ok(fs.readFileSync(path.join(outDir2, 'prompt.md'), 'utf8').startsWith(REVIEW_PROMPT_SENTINEL + '\n'))
  })
  test('(b) council review 帶 --round-start：repo 先 commit A（base 起點）、分支上 commit B（改 f1）、main 上另 commit C（改 other.txt，foreign）、工作樹再改 f2 未 commit；--base main --round-start B_SHA ⇒ prompt.md 的本輪 diff 只含 f2、不含 f1、不含 other.txt；累計 stat 含 f1 與 f2、不含 other.txt；含「merge-base <A 的 sha>」。陽性對照（寫成斷言）：同一 repo 用舊法 git diff --stat main 的輸出含 other.txt', async () => {
    const repo = makeRepo()
    // 1. Commit A（base 起點，包含 f2.txt）
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'f2.txt'), 'f2 line 1\n')
    repo.g('add', 'f2.txt')
    repo.g('commit', '-m', 'commit A: base start')
    const shaA = repo.g('rev-parse', 'HEAD').trim()

    // 2. 分支切出（從 A），commit B（改 f1）
    repo.g('checkout', '-b', 'feat/branch-b', shaA)
    fs.writeFileSync(path.join(repo.dir, 'f1.txt'), 'f1 line 1\n')
    repo.g('add', 'f1.txt')
    repo.g('commit', '-m', 'commit B: f1')
    const shaB = repo.g('rev-parse', 'HEAD').trim()

    // 3. main 上另 commit C（改 other.txt，foreign）
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'other.txt'), 'other foreign\n')
    repo.g('add', 'other.txt')
    repo.g('commit', '-m', 'commit C: foreign')

    // 4. 切回分支 feat/branch-b，工作樹再改 f2 未 commit
    repo.g('checkout', 'feat/branch-b')
    fs.appendFileSync(path.join(repo.dir, 'f2.txt'), 'f2 line 2 modified\n')

    // 陽性對照（寫成斷言）：同一 repo 用舊法 git diff --stat main 的輸出含 other.txt——證明舊尺確實會把 foreign 檔算進來
    const oldDiffStat = repo.g('diff', '--stat', 'main')
    assert.ok(oldDiffStat.includes('other.txt'), '舊法 git diff --stat main 的輸出含 other.txt')

    // 5. council review 帶 --round-start
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試 brief\n內容\n')
    const outDir = path.join(repo.dir, '.review-b')
    const deps = {
      runOne: (name, model) => ({ name, model, exit: 0, ms: 1, empty: false, denied: [], text: '整份：簽' }),
    }

    const origLog = console.log
    console.log = () => {}
    try {
      await councilMain([
        'review',
        '--coordinator', 'claude',
        '--worktree', repo.dir,
        '--base', 'main',
        '--round-start', shaB,
        '--brief', briefFile,
        '--out', outDir,
        '--tier', 'standard',
      ], deps)
    } finally {
      console.log = origLog
    }

    const promptText = fs.readFileSync(path.join(outDir, 'prompt.md'), 'utf8')

    // 斷言：含「merge-base <A 的 sha>」
    assert.ok(promptText.includes(`merge-base ${shaA}`), '含「merge-base <A 的 sha>」')
    assert.ok(promptText.includes('聯集'), 'prompt 應含「聯集」一詞')
    assert.ok(!promptText.includes('Q1 對 brief 的「只准動」用累計 stat'), 'prompt 不應含「Q1 對 brief 的「只准動」用累計 stat」舊句')

    // 斷言：累計 stat 含 f1 與 f2、不含 other.txt
    const cumuStart = promptText.indexOf('【累計 stat（自 merge-base）】')
    const diffStatStart = promptText.indexOf('【git diff --stat】')
    assert.ok(cumuStart !== -1 && diffStatStart !== -1, 'prompt 應含累計 stat 與 git diff --stat 標題')
    const cumulativeStat = promptText.slice(cumuStart, diffStatStart)
    assert.ok(cumulativeStat.includes('f1.txt'), '累計 stat 含 f1')
    assert.ok(cumulativeStat.includes('f2.txt'), '累計 stat 含 f2')
    assert.ok(!cumulativeStat.includes('other.txt'), '累計 stat 不含 other.txt')

    // 斷言：本輪 diff 只含 f2、不含 f1、不含 other.txt
    const diffFenceStart = promptText.indexOf('```diff\n') + 8
    const diffFenceEnd = promptText.indexOf('\n```', diffFenceStart)
    assert.ok(diffFenceStart !== -1 && diffFenceEnd !== -1, 'prompt 應含 diff code fence')
    const roundDiff = promptText.slice(diffFenceStart, diffFenceEnd)
    assert.ok(roundDiff.includes('f2.txt'), '本輪 diff 含 f2')
    assert.ok(!roundDiff.includes('f1.txt'), '本輪 diff 不含 f1')
    assert.ok(!roundDiff.includes('other.txt'), '本輪 diff 不含 other.txt')
  })
  test('(b2) council review 帶 --round-start（untracked 新檔）：與 (b) 同構，但 f2 不 git add（純 untracked），另加 .agy-write/junk 檔 ⇒ prompt.md 的【累計 stat】段含 f2 且含「新檔（未追蹤）」、不含 .agy-write；本輪 diff 含 +++ b/f2。斷言訊息帶實際 prompt 片段。陽性對照（寫成斷言）：直接 git diff --stat MERGEBASE 的輸出不含 f2——證明沒接 untracked 的尺確實漏', async () => {
    const repo = makeRepo()
    // 1. Commit A（base 起點，不包含 f2.txt）
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'base.txt'), 'base line 1\n')
    repo.g('add', 'base.txt')
    repo.g('commit', '-m', 'commit A: base start')
    const shaA = repo.g('rev-parse', 'HEAD').trim()

    // 2. 分支切出（從 A），commit B（改 f1）
    repo.g('checkout', '-b', 'feat/branch-b2', shaA)
    fs.writeFileSync(path.join(repo.dir, 'f1.txt'), 'f1 line 1\n')
    repo.g('add', 'f1.txt')
    repo.g('commit', '-m', 'commit B: f1')
    const shaB = repo.g('rev-parse', 'HEAD').trim()

    // 3. main 上另 commit C（改 other.txt，foreign）
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'other.txt'), 'other foreign\n')
    repo.g('add', 'other.txt')
    repo.g('commit', '-m', 'commit C: foreign')

    // 4. 切回分支 feat/branch-b2，工作樹建立 f2.txt（純 untracked，不 git add！）與 .agy-write/junk 檔
    repo.g('checkout', 'feat/branch-b2')
    fs.writeFileSync(path.join(repo.dir, 'f2.txt'), 'f2 line untracked\n')
    fs.mkdirSync(path.join(repo.dir, '.agy-write'), { recursive: true })
    fs.writeFileSync(path.join(repo.dir, '.agy-write', 'junk'), 'junk internal\n')

    // 陽性對照（寫成斷言）：直接 git diff --stat MERGEBASE 的輸出不含 f2——證明沒接 untracked 的尺確實漏
    const mergeBase = repo.g('merge-base', 'main', 'HEAD').trim()
    assert.equal(mergeBase, shaA, 'mergeBase 應為 commit A')
    const rawCumulativeStat = repo.g('diff', '--stat', mergeBase)
    assert.ok(!rawCumulativeStat.includes('f2.txt'), '陽性對照：直接 git diff --stat MERGEBASE 的輸出不含 f2——證明沒接 untracked 的尺確實漏')

    // 5. council review 帶 --round-start
    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試 brief\n內容\n')
    const outDir = path.join(repo.dir, '.review-b2')
    const deps = {
      runOne: (name, model) => ({ name, model, exit: 0, ms: 1, empty: false, denied: [], text: '整份：簽' }),
    }

    const origLog = console.log
    console.log = () => {}
    try {
      await councilMain([
        'review',
        '--coordinator', 'claude',
        '--worktree', repo.dir,
        '--base', 'main',
        '--round-start', shaB,
        '--brief', briefFile,
        '--out', outDir,
        '--tier', 'standard',
      ], deps)
    } finally {
      console.log = origLog
    }

    const promptText = fs.readFileSync(path.join(outDir, 'prompt.md'), 'utf8')

    // 斷言：累計 stat 段
    const cumuStart = promptText.indexOf('【累計 stat（自 merge-base）】')
    const diffStatStart = promptText.indexOf('【git diff --stat】')
    assert.ok(cumuStart !== -1 && diffStatStart !== -1, 'prompt 應含累計 stat 與 git diff --stat 標題')
    const cumulativeStat = promptText.slice(cumuStart, diffStatStart)

    // 斷言：含 f2 且含「新檔（未追蹤）」、不含 .agy-write（斷言訊息帶實際 prompt 片段）
    assert.ok(cumulativeStat.includes('f2.txt'), `累計 stat 含 f2，實際 prompt 片段：\n${cumulativeStat}`)
    assert.ok(cumulativeStat.includes('新檔（未追蹤）'), `累計 stat 應含「新檔（未追蹤）」，實際 prompt 片段：\n${cumulativeStat}`)
    assert.ok(!cumulativeStat.includes('.agy-write'), `累計 stat 不應含 .agy-write，實際 prompt 片段：\n${cumulativeStat}`)

    // 斷言：本輪 diff 含 +++ b/f2（斷言訊息帶實際 prompt 片段）
    const diffFenceStart = promptText.indexOf('```diff\n') + 8
    const diffFenceEnd = promptText.indexOf('\n```', diffFenceStart)
    assert.ok(diffFenceStart !== -1 && diffFenceEnd !== -1, 'prompt 應含 diff code fence')
    const roundDiff = promptText.slice(diffFenceStart, diffFenceEnd)
    assert.ok(roundDiff.includes('+++ b/f2.txt'), `本輪 diff 應含 +++ b/f2，實際 prompt 片段：\n${roundDiff}`)
  })
  test('(c) 不帶 --round-start ⇒ prompt.md 不含「【本輪範圍】」，且 diff 與 git diff BASE 相同', async () => {
    const repo = makeRepo()
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'f2.txt'), 'f2 line 1\n')
    repo.g('add', 'f2.txt')
    repo.g('commit', '-m', 'commit A')
    repo.g('checkout', '-b', 'feat/branch-c')
    fs.appendFileSync(path.join(repo.dir, 'f2.txt'), 'f2 line 2\n')

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試 brief\n內容\n')
    const outDir = path.join(repo.dir, '.review-c')
    const deps = {
      runOne: (name, model) => ({ name, model, exit: 0, ms: 1, empty: false, denied: [], text: '整份：簽' }),
    }

    const origLog = console.log
    console.log = () => {}
    try {
      await councilMain([
        'review',
        '--coordinator', 'claude',
        '--worktree', repo.dir,
        '--base', 'main',
        '--brief', briefFile,
        '--out', outDir,
        '--tier', 'standard',
      ], deps)
    } finally {
      console.log = origLog
    }

    const promptText = fs.readFileSync(path.join(outDir, 'prompt.md'), 'utf8')
    assert.ok(!promptText.includes('【本輪範圍】'), 'prompt.md 不含「【本輪範圍】」')

    const diffFenceStart = promptText.indexOf('```diff\n') + 8
    const diffFenceEnd = promptText.indexOf('\n```', diffFenceStart)
    const promptDiff = promptText.slice(diffFenceStart, diffFenceEnd)
    const expectedBaseDiff = repo.g('diff', 'main').trim()
    assert.equal(promptDiff, expectedBaseDiff, 'diff 與 git diff BASE 相同')
  })
  test('council review 帶 --writer-report ⇒ prompt.md 含【寫手最後回報】、含報告內容、且該段在 ``` 結束的 diff 區塊之後；不帶 ⇒ 不含', async () => {
    const repo = makeRepo()
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'f.txt'), 'line 1\n')
    repo.g('add', 'f.txt')
    repo.g('commit', '-m', 'commit A')
    repo.g('checkout', '-b', 'feat/wr-test')
    fs.appendFileSync(path.join(repo.dir, 'f.txt'), 'line 2 modified\n')

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試 brief\n內容\n')
    const reportFile = path.join(tmpdir('report-'), 'report.md')
    fs.writeFileSync(reportFile, 'T51 紅在 ticket.test.mjs:3516 code 應為 2 實際 0')

    const outDirWithReport = tmpdir('review-with-report-')
    const deps = {
      runOne: (name, model) => ({ name, model, exit: 0, ms: 1, empty: false, denied: [], text: '整份：簽' }),
    }

    const origLog = console.log
    console.log = () => {}
    try {
      // 1. 帶 --writer-report
      await councilMain([
        'review',
        '--coordinator', 'claude',
        '--worktree', repo.dir,
        '--base', 'main',
        '--brief', briefFile,
        '--out', outDirWithReport,
        '--tier', 'standard',
        '--writer-report', reportFile,
      ], deps)

      // 2. 不帶 --writer-report
      const outDirNoReport = tmpdir('review-no-report-')
      await councilMain([
        'review',
        '--coordinator', 'claude',
        '--worktree', repo.dir,
        '--base', 'main',
        '--brief', briefFile,
        '--out', outDirNoReport,
        '--tier', 'standard',
      ], deps)

      const promptWith = fs.readFileSync(path.join(outDirWithReport, 'prompt.md'), 'utf8')
      const promptWithout = fs.readFileSync(path.join(outDirNoReport, 'prompt.md'), 'utf8')

      // 斷言：帶 report ⇒ 含【寫手最後回報】、含報告內容
      assert.ok(promptWith.includes('【寫手最後回報（作者自述，不是證據）】'), '帶 report 時 prompt 應含【寫手最後回報】')
      assert.ok(promptWith.includes('T51 紅在 ticket.test.mjs:3516 code 應為 2 實際 0'), '帶 report 時 prompt 應含報告內容')

      // 斷言：該段在 ``` 結束的 diff 區塊之後
      const diffEnd = promptWith.indexOf('```diff\n')
      assert.ok(diffEnd !== -1, 'prompt 應含 ```diff')
      const diffFenceClose = promptWith.indexOf('\n```', diffEnd)
      assert.ok(diffFenceClose !== -1, 'prompt 應含 diff 區塊結束的 ```')
      const reportHeaderIdx = promptWith.indexOf('【寫手最後回報（作者自述，不是證據）】')
      assert.ok(reportHeaderIdx > diffFenceClose, '【寫手最後回報】應在 ``` 結束的 diff 區塊之後')

      // 斷言：不帶 report ⇒ 不含
      assert.ok(!promptWithout.includes('【寫手最後回報（作者自述，不是證據）】'), '不帶 report 時 prompt 不應含【寫手最後回報】')
      assert.ok(!promptWithout.includes('T51 紅在 ticket.test.mjs:3516'), '不帶 report 時 prompt 不應含報告內容')
    } finally {
      console.log = origLog
    }
  })
  test('council review --writer-report 指向空檔 ⇒ prompt.md 含【寫手最後回報】且含「寫手回報為空」', async () => {
    const repo = makeRepo()
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'f.txt'), 'line 1\n')
    repo.g('add', 'f.txt')
    repo.g('commit', '-m', 'commit A')
    repo.g('checkout', '-b', 'feat/wr-empty')
    fs.appendFileSync(path.join(repo.dir, 'f.txt'), 'line 2 modified\n')

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試 brief\n內容\n')
    const emptyReportFile = path.join(tmpdir('report-'), 'empty-report.md')
    fs.writeFileSync(emptyReportFile, '')

    const outDir = tmpdir('review-empty-report-')
    const deps = {
      runOne: (name, model) => ({ name, model, exit: 0, ms: 1, empty: false, denied: [], text: '整份：簽' }),
    }

    const origLog = console.log
    console.log = () => {}
    try {
      await councilMain([
        'review',
        '--coordinator', 'claude',
        '--worktree', repo.dir,
        '--base', 'main',
        '--brief', briefFile,
        '--out', outDir,
        '--tier', 'standard',
        '--writer-report', emptyReportFile,
      ], deps)

      const promptText = fs.readFileSync(path.join(outDir, 'prompt.md'), 'utf8')
      assert.ok(promptText.includes('【寫手最後回報（作者自述，不是證據）】'), '空檔 report 時 prompt 應含【寫手最後回報】')
      assert.ok(promptText.includes('寫手回報為空'), '空檔 report 時 prompt 應含「寫手回報為空」')
    } finally {
      console.log = origLog
    }
  })
  test('buildReviewPrompt 純函式：writerReport: "" 含區塊標題；null 與省略參數不含且兩者字串相等', () => {
    const baseArgs = {
      brief: 'brief text',
      diff: 'diff text',
      tier: 'standard',
      diffStat: '1 file changed',
      writerModel: 'gemini-3.1-pro-high',
    }

    const promptEmpty = buildReviewPrompt({ ...baseArgs, writerReport: '' })
    const promptNull = buildReviewPrompt({ ...baseArgs, writerReport: null })
    const promptOmitted = buildReviewPrompt({ ...baseArgs })

    assert.ok(promptEmpty.includes('【寫手最後回報（作者自述，不是證據）】'), 'writerReport: "" 應含【寫手最後回報】區塊標題')
    assert.ok(promptEmpty.includes('寫手回報為空'), 'writerReport: "" 應含「寫手回報為空」')

    assert.ok(!promptNull.includes('【寫手最後回報（作者自述，不是證據）】'), 'writerReport: null 不應含【寫手最後回報】區塊標題')
    assert.ok(!promptOmitted.includes('【寫手最後回報（作者自述，不是證據）】'), '省略 writerReport 不應含【寫手最後回報】區塊標題')

    assert.equal(promptNull, promptOmitted, 'writerReport: null 與省略參數產生的 prompt 應完全相等')
  })
  test('buildReviewPrompt 純函式：reviewOnly: true ⇒ 含 review-only 區塊與「不構成不簽理由」，且不含【寫手最後回報】（即使給 writerReport）；reviewOnly: false 與省略字串相等且不含 review-only 區塊', () => {
    const baseArgs = {
      brief: 'brief text',
      diff: 'diff text',
      tier: 'standard',
      diffStat: '1 file changed',
      writerModel: 'gemini-3.1-pro-high',
    }

    const promptROWithReport = buildReviewPrompt({ ...baseArgs, reviewOnly: true, writerReport: 'X' })
    const promptFalse = buildReviewPrompt({ ...baseArgs, reviewOnly: false })
    const promptOmitted = buildReviewPrompt({ ...baseArgs })

    const roHeader = '【review-only：本輪沒有寫手、沒有寫手回報】'
    const phrase = '不構成不簽理由'
    const wrHeader = '【寫手最後回報'

    assert.ok(promptROWithReport.includes(roHeader), `reviewOnly: true 應含「${roHeader}」，實際 prompt：\n${promptROWithReport}`)
    assert.ok(promptROWithReport.includes(phrase), `reviewOnly: true 應含「${phrase}」，實際 prompt：\n${promptROWithReport}`)
    assert.ok(!promptROWithReport.includes(wrHeader), `reviewOnly: true 即使給 writerReport: 'X' 也不應含「${wrHeader}」，實際 prompt：\n${promptROWithReport}`)

    assert.ok(!promptFalse.includes(roHeader), `reviewOnly: false 不應含「${roHeader}」，實際 prompt：\n${promptFalse}`)
    assert.ok(!promptOmitted.includes(roHeader), `省略 reviewOnly 不應含「${roHeader}」，實際 prompt：\n${promptOmitted}`)
    assert.equal(promptFalse, promptOmitted, `reviewOnly: false 與省略參數產生的 prompt 應完全相等，實際 false 長度 ${promptFalse.length}，omitted 長度 ${promptOmitted.length}`)
  })
  test('council review --review-only ⇒ prompt.md 含 review-only 區塊、不含【寫手最後回報】；不帶旗標 ⇒ 不含 review-only 區塊', async () => {
    const repo = makeRepo()
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'f.txt'), 'line 1\n')
    repo.g('add', 'f.txt')
    repo.g('commit', '-m', 'commit A')
    repo.g('checkout', '-b', 'feat/ro-prompt-test')
    fs.appendFileSync(path.join(repo.dir, 'f.txt'), 'line 2 modified\n')

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試 brief\n內容\n')

    const outDirWithRO = tmpdir('review-with-ro-')
    const deps = {
      runOne: (name, model) => ({ name, model, exit: 0, ms: 1, empty: false, denied: [], text: '整份：簽' }),
    }

    const origLog = console.log
    console.log = () => {}
    try {
      // 1. 帶 --review-only
      await councilMain([
        'review',
        '--coordinator', 'claude',
        '--worktree', repo.dir,
        '--base', 'main',
        '--brief', briefFile,
        '--out', outDirWithRO,
        '--tier', 'standard',
        '--review-only',
      ], deps)

      // 2. 不帶 --review-only
      const outDirNoRO = tmpdir('review-no-ro-')
      await councilMain([
        'review',
        '--coordinator', 'claude',
        '--worktree', repo.dir,
        '--base', 'main',
        '--brief', briefFile,
        '--out', outDirNoRO,
        '--tier', 'standard',
      ], deps)

      const promptWith = fs.readFileSync(path.join(outDirWithRO, 'prompt.md'), 'utf8')
      const promptWithout = fs.readFileSync(path.join(outDirNoRO, 'prompt.md'), 'utf8')

      const roHeader = '【review-only：本輪沒有寫手、沒有寫手回報】'
      const wrHeader = '【寫手最後回報'

      assert.ok(promptWith.includes(roHeader), `帶 --review-only 時 OUT/prompt.md 應含「${roHeader}」，實際 prompt.md：\n${promptWith}`)
      assert.ok(!promptWith.includes(wrHeader), `帶 --review-only 時 OUT/prompt.md 不應含「${wrHeader}」，實際 prompt.md：\n${promptWith}`)

      assert.ok(!promptWithout.includes(roHeader), `不帶 --review-only 時 OUT/prompt.md 不應含「${roHeader}」，實際 prompt.md：\n${promptWithout}`)
    } finally {
      console.log = origLog
    }
  })
  test('council review --writer-report 超過 20000 字元 ⇒ 含「截斷」與原長', async () => {
    const repo = makeRepo()
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'f.txt'), 'line 1\n')
    repo.g('add', 'f.txt')
    repo.g('commit', '-m', 'commit A')
    repo.g('checkout', '-b', 'feat/wr-long')
    fs.appendFileSync(path.join(repo.dir, 'f.txt'), 'line 2 modified\n')

    const briefFile = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(briefFile, '# 測試 brief\n內容\n')

    const longReportFile = path.join(tmpdir('report-'), 'long-report.md')
    const longReport = 'A'.repeat(25000)
    fs.writeFileSync(longReportFile, longReport)

    const outDir = tmpdir('review-long-')
    const deps = {
      runOne: (name, model) => ({ name, model, exit: 0, ms: 1, empty: false, denied: [], text: '整份：簽' }),
    }

    const origLog = console.log
    console.log = () => {}
    try {
      await councilMain([
        'review',
        '--coordinator', 'claude',
        '--worktree', repo.dir,
        '--base', 'main',
        '--brief', briefFile,
        '--out', outDir,
        '--tier', 'standard',
        '--writer-report', longReportFile,
      ], deps)
    } finally {
      console.log = origLog
    }

    const promptText = fs.readFileSync(path.join(outDir, 'prompt.md'), 'utf8')
    assert.ok(promptText.includes('截斷'), '超過 20000 字元應含「截斷」')
    assert.ok(promptText.includes('25000'), '超過 20000 字元應註明原長 25000')
    assert.match(promptText, /截斷，原長 25000 字元/, 'prompt 應含「截斷，原長 25000 字元」')
  })
  test('review：兩位 agy（假 binary 回「不簽」）⇒ 表格印 不簽、exit 0；零輸出成員 ⇒ exit 3', async () => {
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
      code = await councilMain(['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', path.join(repo.dir, '.review'), '--tier', 'standard'])
    } finally {
      console.log = origLog
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
    assert.equal(code, 0)
    const table = logs.join('\n')
    assert.match(table, /\| agy\/opus \| claude-opus-4-6-thinking \| 0 \|[^|]*\| 不簽 \| Q1=簽 Q2=不簽/)
    assert.match(table, /\| agy\/gemini \| gemini-3.1-pro-high/)
    assert.doesNotMatch(table, /codex/, 'standard 不叫 codex（它在 blockReviewers）')
    assert.match(fs.readFileSync(path.join(repo.dir, '.review', 'prompt.md'), 'utf8'), /\+ 0 \}/)
    const ledger = fs.readFileSync(path.join(repo.dir, '.review', 'ledger.ndjson'), 'utf8')
    assert.match(ledger, /"schemaVersion":2/)
    assert.match(ledger, /"coordinator":"claude"/)
    assert.match(ledger, /"harness":"agy"/)

    // 🔴 陽性對照：假 binary 改成 denied（零輸出）⇒ exit 3、表格標「零輸出」
    const logs2 = []
    console.log = (m) => logs2.push(String(m))
    process.env.AGY_BIN = bin
    process.env.FAKE_AGY_MODE = 'denied'
    let code2
    try {
      code2 = await councilMain(['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', path.join(repo.dir, '.review2'), '--tier', 'standard'])
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

  test('T3：reviewers: [] ⇒ loadConfig 拒絕（不變式）⇒ council main() 回 2、deps.runOne 未被呼叫、stdout 不含「簽」', async () => {
    const repo = makeRepo({ profiles: v2Profiles({ claude: { reviewers: [] } }) })
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
      code = await councilMain(
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
    assert.match(allErr, /🔴 config 載入失敗：.*profiles\.claude\.reviewers 必須是非空陣列/, `stderr 應指名不變式，實際：${allErr}`)
  })

  test('T3b：缺 --coordinator（deps.env 也沒有）⇒ council main() 回 2、訊息列出可用 profiles、deps.runOne 未被呼叫；--coordinator 不存在 ⇒ 同樣 2', async () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')
    let runOneCalls = 0
    const deps = {
      env: {},
      runOne: () => {
        runOneCalls++
        return { name: 'fake', model: 'fake', exit: 0, ms: 10, empty: false, denied: [], text: '整份：簽' }
      },
    }
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    let code2
    try {
      code = await councilMain(['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'], deps)
      code2 = await councilMain(['review', '--coordinator', 'nope', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 2)
    assert.equal(code2, 2)
    assert.equal(runOneCalls, 0)
    const allErr = errs.join('\n')
    assert.match(allErr, /統整者 profile 未指定.*可用 profiles：claude, agy, codex/)
    assert.match(allErr, /統整者 profile 不存在：nope/)
  })

  test('council 複審者並行啟動：同時發起請求並按原順序寫台帳與印表', async () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')

    const events = []
    const deps = {
      runOne: async (name, model) => {
        events.push(`start:${name}`)
        await new Promise((r) => setTimeout(r, 20))
        events.push(`done:${name}`)
        return { name, model, exit: 0, ms: 20, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }
    const code = await councilMain(
      ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
      deps
    )
    assert.equal(code, 0)
    assert.equal(events[0], 'start:agy/opus')
    assert.equal(events[1], 'start:agy/gemini')

    const ledger = fs.readFileSync(path.join(outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(ledger[0].name, 'agy/opus')
    assert.equal(ledger[1].name, 'agy/gemini')
  })

  test('council --sequential 保留依序執行行為', async () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')

    const events = []
    const deps = {
      runOne: async (name, model) => {
        events.push(`start:${name}`)
        await new Promise((r) => setTimeout(r, 20))
        events.push(`done:${name}`)
        return { name, model, exit: 0, ms: 20, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }
    const code = await councilMain(
      ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard', '--sequential'],
      deps
    )
    assert.equal(code, 0)
    assert.deepEqual(events, ['start:agy/opus', 'done:agy/opus', 'start:agy/gemini', 'done:agy/gemini'])
  })

  test('council 心跳：並行等待期間每 heartbeatMs 印進度至 stderr', async () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))

    const deps = {
      heartbeatMs: 10,
      runOne: async (name, model) => {
        await new Promise((r) => setTimeout(r, 30))
        return { name, model, exit: 0, ms: 30, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }
    try {
      const code = await councilMain(
        ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
        deps
      )
      assert.equal(code, 0)
    } finally {
      console.error = origErr
    }
    const allErr = errs.join('\n')
    assert.match(allErr, /⏳ 等待中：/)
  })

  test('council timeout 預設為 8 分鐘（480000ms），--timeout-ms 可覆寫', async () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')

    let receivedTimeout = null
    const deps = {
      runOne: (name, model, prompt, cwd, out, timeoutMs) => {
        receivedTimeout = timeoutMs
        return { name, model, exit: 0, ms: 10, empty: false, denied: [], text: '整份：簽' }
      },
    }
    await councilMain(
      ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
      deps
    )
    assert.equal(receivedTimeout, 8 * 60 * 1000, '預設 timeout 應為 8 分鐘（480000ms）')

    await councilMain(
      ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard', '--timeout-ms', '12345'],
      deps
    )
    assert.equal(receivedTimeout, 12345, '--timeout-ms 應能覆寫 timeoutMs')
  })

  test('council timeout 到期：假 runOne 回 signal: SIGTERM ⇒ 表格印 不簽（timeout）、exit 非 0', async () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')

    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))

    const deps = {
      runOne: (name, model) => {
        if (name === 'agy/opus') {
          return { name, model, exit: null, signal: 'SIGTERM', timedOut: true, ms: 100, empty: true, denied: [], text: '' }
        }
        return { name, model, exit: 0, ms: 50, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }
    let code
    try {
      code = await councilMain(
        ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
        deps
      )
    } finally {
      console.log = origLog
    }
    assert.notEqual(code, 0, '有成員 timeout 時 exit 應非 0')
    assert.equal(code, 3)

    const table = logs.join('\n')
    assert.match(table, /\| agy\/opus \| .* \| null \| .* \| 不簽（timeout） \|/)
    assert.match(table, /\| agy\/gemini \| .* \| 0 \| .* \| 簽 \|/)

    const ledger = fs.readFileSync(path.join(outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
    const opusEntry = ledger.find((l) => l.name === 'agy/opus')
    assert.equal(opusEntry.exit, null)
    assert.equal(opusEntry.signal, 'SIGTERM')
    assert.equal(opusEntry.empty, true)
    assert.equal(opusEntry.overall, '不簽（timeout）')
  })

  test('council 判斷 timeout 與外部中止：假 spawn 回 timedOut: false, signal: SIGTERM ⇒ 不簽（被中止）；timedOut: true ⇒ 不簽（timeout）', async () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()

    // 1. 假 spawn 回 signal: 'SIGTERM', timedOut: false ⇒ 不簽（被中止）
    {
      const outDir = path.join(repo.dir, '.review-aborted')
      const logs = []
      const origLog = console.log
      console.log = (m) => logs.push(String(m))

      const deps = {
        spawn: async () => ({
          status: null,
          signal: 'SIGTERM',
          timedOut: false,
          stdout: '',
          stderr: 'killed by external process',
        }),
        env: { ...process.env, AGY_BIN: '/mock/bin/antigravity' },
      }
      let code
      try {
        code = await councilMain(
          ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
          deps
        )
      } finally {
        console.log = origLog
      }
      assert.notEqual(code, 0)
      const table = logs.join('\n')
      assert.match(table, /\| agy\/opus \| .* \| null \| .* \| 不簽（被中止） \|/)
      assert.doesNotMatch(table, /不簽（timeout）/)

      const ledger = fs.readFileSync(path.join(outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
      const opusEntry = ledger.find((l) => l.name === 'agy/opus')
      assert.equal(opusEntry.exit, null)
      assert.equal(opusEntry.signal, 'SIGTERM')
      assert.equal(opusEntry.overall, '不簽（被中止）')
    }

    // 2. 假 spawn 回 signal: 'SIGTERM', timedOut: true ⇒ 不簽（timeout）
    {
      const outDir = path.join(repo.dir, '.review-timeout')
      const logs = []
      const origLog = console.log
      console.log = (m) => logs.push(String(m))

      const deps = {
        spawn: async () => ({
          status: null,
          signal: 'SIGTERM',
          timedOut: true,
          stdout: '',
          stderr: '',
        }),
        env: { ...process.env, AGY_BIN: '/mock/bin/antigravity' },
      }
      let code
      try {
        code = await councilMain(
          ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
          deps
        )
      } finally {
        console.log = origLog
      }
      assert.notEqual(code, 0)
      const table = logs.join('\n')
      assert.match(table, /\| agy\/opus \| .* \| null \| .* \| 不簽（timeout） \|/)
      assert.doesNotMatch(table, /不簽（被中止）/)

      const ledger = fs.readFileSync(path.join(outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
      const opusEntry = ledger.find((l) => l.name === 'agy/opus')
      assert.equal(opusEntry.exit, null)
      assert.equal(opusEntry.signal, 'SIGTERM')
      assert.equal(opusEntry.overall, '不簽（timeout）')
    }
  })

  test('council 複審者名稱從 profile 成員推導：reviewers: [agy/gemini-3.1-pro-high] ⇒ 成員名 agy/gemini（不是 opus），輸出檔 agy-gemini.txt', async () => {
    const repo = makeRepo({ profiles: v2Profiles({ claude: { reviewers: [M.agyGemini] } }) })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')

    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))

    const deps = {
      runOne: (name, model, prompt, cwd, out) => {
        fs.writeFileSync(path.join(out, `${memberFileName(name)}.txt`), 'Q1：簽\n整份：簽\n')
        return { name, model, exit: 0, ms: 10, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }

    try {
      const code = await councilMain(
        ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
        deps
      )
      assert.equal(code, 0)
    } finally {
      console.log = origLog
    }

    assert.ok(fs.existsSync(path.join(outDir, 'agy-gemini.txt')), '輸出檔 agy-gemini.txt 應存在')
    assert.ok(!fs.existsSync(path.join(outDir, 'agy-opus.txt')), '輸出檔 agy-opus.txt 不應存在')

    const ledger = fs.readFileSync(path.join(outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(ledger[0].name, 'agy/gemini')

    const table = logs.join('\n')
    assert.match(table, /\|\s*agy\/gemini\s*\|\s*gemini-3\.1-pro-high\s*\|/)
    assert.doesNotMatch(table, /\|\s*agy\/opus\s*\|/)
  })

  test('council 複審者同名衝突：[agy/gemini-3.1-pro-high, agy/gemini-3.1-pro-low] ⇒ agy/gemini、agy/gemini-2', async () => {
    const repo = makeRepo({ profiles: v2Profiles({ claude: { reviewers: [M.agyGemini, { ...M.agyGemini, model: 'gemini-3.1-pro-low' }] } }) })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')

    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))

    const deps = {
      runOne: (name, model, prompt, cwd, out) => {
        fs.writeFileSync(path.join(out, `${memberFileName(name)}.txt`), 'Q1：簽\n整份：簽\n')
        return { name, model, exit: 0, ms: 10, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }

    try {
      const code = await councilMain(
        ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
        deps
      )
      assert.equal(code, 0)
    } finally {
      console.log = origLog
    }

    assert.ok(fs.existsSync(path.join(outDir, 'agy-gemini.txt')), '輸出檔 agy-gemini.txt 應存在')
    assert.ok(fs.existsSync(path.join(outDir, 'agy-gemini-2.txt')), '輸出檔 agy-gemini-2.txt 應存在')

    const ledger = fs.readFileSync(path.join(outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(ledger[0].name, 'agy/gemini')
    assert.equal(ledger[1].name, 'agy/gemini-2')

    const table = logs.join('\n')
    assert.match(table, /\|\s*agy\/gemini\s*\|\s*gemini-3\.1-pro-high\s*\|/)
    assert.match(table, /\|\s*agy\/gemini-2\s*\|\s*gemini-3\.1-pro-low\s*\|/)
  })

  test('council 既有行為不變：[agy/opus, agy/gemini] ⇒ agy/opus、agy/gemini', async () => {
    const repo = makeRepo({ profiles: v2Profiles({ claude: { reviewers: [M.agyOpus, M.agyGemini] } }) })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const base = repo.g('rev-parse', 'HEAD').trim()
    const outDir = path.join(repo.dir, '.review')

    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))

    const deps = {
      runOne: (name, model, prompt, cwd, out) => {
        fs.writeFileSync(path.join(out, `${memberFileName(name)}.txt`), 'Q1：簽\n整份：簽\n')
        return { name, model, exit: 0, ms: 10, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }

    try {
      const code = await councilMain(
        ['review', '--worktree', repo.dir, '--base', base, '--brief', brief, '--out', outDir, '--tier', 'standard'],
        deps
      )
      assert.equal(code, 0)
    } finally {
      console.log = origLog
    }

    assert.ok(fs.existsSync(path.join(outDir, 'agy-opus.txt')), '輸出檔 agy-opus.txt 應存在')
    assert.ok(fs.existsSync(path.join(outDir, 'agy-gemini.txt')), '輸出檔 agy-gemini.txt 應存在')

    const ledger = fs.readFileSync(path.join(outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(ledger[0].name, 'agy/opus')
    assert.equal(ledger[1].name, 'agy/gemini')

    const table = logs.join('\n')
    assert.match(table, /\|\s*agy\/opus\s*\|\s*claude-opus-4-6-thinking\s*\|/)
    assert.match(table, /\|\s*agy\/gemini\s*\|\s*gemini-3\.1-pro-high\s*\|/)
  })
})

describe('reviewerNameFor', () => {
  test('model 包含關鍵字對應特定名稱，其他過濾非 [a-z0-9-] 字元', () => {
    assert.equal(reviewerNameFor('claude-opus-4-6-thinking'), 'opus')
    assert.equal(reviewerNameFor('claude-3-5-sonnet-20241022'), 'sonnet')
    assert.equal(reviewerNameFor('gemini-3.1-pro-high'), 'gemini')
    assert.equal(reviewerNameFor('gpt-oss-preview'), 'gpt-oss')
    assert.equal(reviewerNameFor('llama-3.1-70b'), 'llama-3-1-70b')
    assert.equal(reviewerNameFor('gpt-5.6-sol'), 'gpt-5-6-sol')
    assert.equal(reviewerNameFor('custom_model@2026'), 'custommodel2026')
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

  test('strictPositional: true 遇到位置參數 throw 且帶 positionals；沒有位置參數正常過', () => {
    assert.throws(
      () => parseArgs(['--foo', 'bar', 'extra'], [], { strictPositional: true }),
      (err) => {
        assert.match(err.message, /多餘的位置參數：extra/)
        assert.deepEqual(err.positionals, ['extra'])
        return true
      }
    )
    assert.throws(
      () => parseArgs(['a', 'b'], [], { strictPositional: true }),
      (err) => {
        assert.match(err.message, /多餘的位置參數：a b/)
        assert.deepEqual(err.positionals, ['a', 'b'])
        return true
      }
    )
    const ok = parseArgs(['--foo', 'bar'], [], { strictPositional: true })
    assert.deepEqual(ok, { _: [], foo: 'bar' })
  })
})

describe('spawnAsync 非同步子行程執行', () => {
  test('spawnAsync 正常執行 exit 0 與 capture stdout', async () => {
    const r = await spawnAsync('node', ['-e', 'console.log("hello")'])
    assert.equal(r.status, 0)
    assert.equal(r.signal, null)
    assert.equal(r.timedOut, false)
    assert.equal(r.stdout.trim(), 'hello')
    assert.equal(r.stderr, '')
  })

  test('spawnAsync timeout 到期送 SIGTERM、status: null, signal: "SIGTERM"', async () => {
    const r = await spawnAsync('node', ['-e', 'setInterval(function(){}, 1000)'], { timeout: 50 })
    assert.equal(r.status, null)
    assert.equal(r.signal, 'SIGTERM')
    assert.equal(r.timedOut, true)
  })

  test('spawnAsync timeout 後忽略 SIGTERM ⇒ killGraceMs 到期升級送 SIGKILL 且 signal 為 SIGKILL', async () => {
    // timeout 不能設 100：子行程要先跑到 `process.on("SIGTERM", …)` 那行才算註冊好 handler，
    // 忙碌機器上 node 子行程啟動超過 100ms 是常態；一旦 SIGTERM 在 handler 註冊前就送達，
    // 子行程會直接被 SIGTERM 殺掉，斷言會假紅（2026-09-16 M4 loadavg 8 實測：
    // actual 'SIGTERM' expected 'SIGKILL'；同一份程式碼在 loadavg 3 時三次都綠）。
    // 這是測試本身的競態，不是 lib 的 bug：spawnAsync 的計時器從 spawn 那一刻就啟動是刻意設計，不改 lib.mjs。
    const code = [
      'process.on("SIGTERM", function(){})',
      'setInterval(function(){}, 1000)',
    ].join('\n')
    const start = Date.now()
    let watchdogTimer = null
    const pending = spawnAsync('node', ['-e', code], { timeout: 1000, killGraceMs: 100 })
    assert.ok(pending.child && typeof pending.child.kill === 'function', 'spawnAsync 的 Promise 要掛 .child')
    const race = await Promise.race([
      pending,
      new Promise(function (resolve) {
        watchdogTimer = setTimeout(function () {
          resolve('WATCHDOG')
        }, 4000)
      }),
    ])
    if (watchdogTimer) clearTimeout(watchdogTimer)
    if (race === 'WATCHDOG') {
      // T6 NIT：assert.fail 之前先把子行程殺掉，否則活著的子行程讓 runner 不自退
      try {
        pending.child.kill('SIGKILL')
      } catch {
        /* 可能已退出 */
      }
      assert.fail('spawnAsync 在 4 秒內沒有 resolve：SIGKILL 升級沒生效')
    }
    const r = race
    const elapsed = Date.now() - start
    assert.ok(elapsed < 3000, `應在 3 秒內結束，實際耗時 ${elapsed}ms`)
    assert.equal(r.status, null)
    assert.equal(r.signal, 'SIGKILL')
    assert.equal(r.timedOut, true)
  })

  test('spawnAsync maxBuffer 超過 ⇒ 截斷並記 stderr 一行', async () => {
    const r = await spawnAsync('node', ['-e', 'console.log("a".repeat(2000))'], { maxBuffer: 100 })
    assert.equal(r.status, 0)
    assert.equal(r.stdout.length, 100)
    assert.match(r.stderr, /\[spawnAsync\] stdout exceeded maxBuffer \(100 bytes\) and was truncated/)
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
  test('runCodex({ prompt: "x" }) 缺 model ⇒ throw 且訊息指出 model 來自 profile 成員', () => {
    assert.throws(
      () => runCodex({ prompt: 'x' }),
      (err) => {
        assert.match(err.message, /runCodex 需要 model（來自 profile 成員的 model）/, `錯誤訊息應指出 model 來源，實際得到：${err.message}`)
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
    assert.ok(fs.existsSync(path.join(outDir, 'round-1.response.md')), 'round-1.response.md 應存在')
    assert.equal(fs.readFileSync(path.join(outDir, 'round-1.response.md'), 'utf8'), 'ok')
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

describe('複審名單依 tier 取自 profile：block 票收 blockReviewers、standard 票收 reviewers', () => {
  async function membersFor(tier, extraArgs = []) {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(tmpdir('review-'), 'review')
    const membersCalled = []
    const deps = {
      runOne: (name, model, prompt, cwd, out, timeoutMs, member) => {
        membersCalled.push({ name, harness: member.harness, quotaBucket: member.quotaBucket })
        return { name, model, exit: 0, ms: 10, empty: false, denied: [], text: 'Q1：簽\n整份：簽' }
      },
    }
    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await councilMain(
        ['review', '--worktree', repo.dir, '--base', 'main', '--brief', brief, '--tier', tier, '--out', outDir, ...extraArgs],
        deps
      )
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)
    return membersCalled
  }

  test('block tier ⇒ members ＝ blockReviewers（含 codex/gpt-5-6-sol），runOne 拿到 member 第 7 參數含 harness／quotaBucket', async () => {
    const called = await membersFor('block')
    assert.deepEqual(called.map((m) => m.name), ['agy/opus', 'agy/gemini', 'codex/gpt-5-6-sol'])
    assert.deepEqual(called[2], { name: 'codex/gpt-5-6-sol', harness: 'codex', quotaBucket: 'openai' })
  })

  test('standard tier ⇒ members ＝ reviewers（不含 codex）', async () => {
    const called = await membersFor('standard')
    assert.deepEqual(called.map((m) => m.name), ['agy/opus', 'agy/gemini'])
  })

  test('🔴 council review 寫 members.json（codex 複審 Q5-IDENTITY）：每位實際跑的成員的身分三元組（來自 config，不是 runner 回報的字串）＋ overall／q／empty／timedOut／invalid／exit／ms；零輸出 ⇒ empty、格式不合 ⇒ invalid、逾時 ⇒ timedOut＋不簽（timeout）', async () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(tmpdir('review-'), 'review')
    const deps = {
      runOne: (name, model, prompt, cwd, out, timeoutMs, member) => {
        // 故意回報錯的 name／model：members.json 的身分必須來自 config 成員，不是 runner 回的字串
        const base = { name: 'runner-said-' + name, model: 'runner-said-' + model, exit: 0, ms: 12, denied: [] }
        if (member.harness === 'codex') return { ...base, empty: false, text: 'Q1：簽｜ok｜無\n' /* 沒有「整份」那行 ⇒ invalid */ }
        if (member.model === 'gemini-3.1-pro-high') return { ...base, exit: null, signal: 'SIGTERM', timedOut: true, empty: true, text: '' }
        return { ...base, empty: false, text: 'Q1：簽｜ok｜無\nQ2：不簽｜x｜y\n整份：不簽' }
      },
    }
    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await councilMain(['review', '--worktree', repo.dir, '--base', 'main', '--brief', brief, '--tier', 'block', '--out', outDir], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code, 3, '有零輸出成員 ⇒ 3')
    const file = path.join(outDir, 'members.json')
    assert.ok(fs.existsSync(file), 'members.json 應存在')
    const members = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(
      members.map(({ name, harness, model, quotaBucket }) => ({ name, harness, model, quotaBucket })),
      [
        { name: 'agy/opus', ...M.agyOpus },
        { name: 'agy/gemini', ...M.agyGemini },
        { name: 'codex/gpt-5-6-sol', ...M.codexSol },
      ],
      '身分三元組來自 config 成員（runner 回報的 runner-said-* 不得混進來）'
    )
    const [opus, gemini, codex] = members
    assert.deepEqual({ overall: opus.overall, q: opus.q, empty: opus.empty, timedOut: opus.timedOut, invalid: opus.invalid, exit: opus.exit, ms: opus.ms }, { overall: '不簽', q: { Q1: '簽', Q2: '不簽' }, empty: false, timedOut: false, invalid: false, exit: 0, ms: 12 })
    assert.deepEqual({ overall: gemini.overall, empty: gemini.empty, timedOut: gemini.timedOut, invalid: gemini.invalid, exit: gemini.exit, signal: gemini.signal }, { overall: '不簽（timeout）', empty: true, timedOut: true, invalid: false, exit: null, signal: 'SIGTERM' })
    assert.deepEqual({ overall: codex.overall, empty: codex.empty, timedOut: codex.timedOut, invalid: codex.invalid }, { overall: null, empty: false, timedOut: false, invalid: true })
    // 每一項都是 ticket／publish 認得的身分形狀
    for (const m of members) for (const k of ['name', 'harness', 'model', 'quotaBucket']) assert.equal(typeof m[k], 'string', `${k} 要是字串`)
  })

  test('--coordinator agy 明示旗標優先於 env（env 是 claude）⇒ standard members ＝ agy profile 的 reviewers（codex/gpt-5-6-sol）', async () => {
    const called = await membersFor('standard', ['--coordinator', 'agy'])
    assert.deepEqual(called.map((m) => m.name), ['codex/gpt-5-6-sol'])
  })

  test('runOne 依 harness 派：codex 成員走 runCodexAsync 且帶 effort（成員未設 ⇒ high；設 medium ⇒ medium）；agy 成員走 runAgyAsync 且提示以 NO_EXEC_HEADER 開頭；codex 不加', async () => {
    const repo = makeRepo({
      profiles: v2Profiles({ claude: { blockReviewers: [M.agyGemini, M.codexSol, { ...M.codexSol, model: 'gpt-5.6-mini', effort: 'medium' }] } }),
    })
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test brief')
    const outDir = path.join(tmpdir('review-'), 'review')
    const codexCalls = []
    const agyCalls = []
    const deps = {
      runCodexAsync: async (args) => {
        codexCalls.push(args)
        return { exit: 0, signal: null, timedOut: false, stdout: '整份：簽', stderr: '' }
      },
      runAgyAsync: async (args) => {
        agyCalls.push(args)
        return { exit: 0, signal: null, timedOut: false, stdout: '', stderr: '', result: { response: '整份：簽' }, denied: [] }
      },
    }
    const origLog = console.log
    console.log = () => {}
    let code
    try {
      code = await councilMain(['review', '--worktree', repo.dir, '--base', 'main', '--brief', brief, '--tier', 'block', '--out', outDir], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)
    assert.equal(agyCalls.length, 1)
    assert.equal(agyCalls[0].mode, 'plan')
    assert.ok(agyCalls[0].prompt.startsWith(NO_EXEC_HEADER), 'agy 提示要以 NO_EXEC_HEADER 開頭')
    assert.equal(codexCalls.length, 2)
    assert.equal(codexCalls[0].effort, 'high')
    assert.equal(codexCalls[1].effort, 'medium')
    assert.ok(!codexCalls[0].prompt.startsWith(NO_EXEC_HEADER), 'codex 提示不加 NO_EXEC_HEADER')
    assert.ok(codexCalls[0].prompt.startsWith(REVIEW_PROMPT_SENTINEL), 'codex 提示第一行是複審哨兵')
    // 輸出檔名：/ ⇒ -
    assert.ok(fs.existsSync(path.join(outDir, 'agy-gemini.txt')))
    assert.ok(fs.existsSync(path.join(outDir, 'codex-gpt-5-6-sol.txt')))
    assert.ok(fs.existsSync(path.join(outDir, 'codex-gpt-5-6-mini.txt')))
  })

  test('buildCodexArgs 帶 effort medium ⇒ argv 含 model_reasoning_effort="medium"', () => {
    const args = buildCodexArgs({ model: 'gpt-5.6-sol', prompt: 'p', effort: 'medium', cwd: '/w' })
    assert.ok(args.includes('model_reasoning_effort="medium"'))
    assert.ok(args.includes('read-only'))
  })
})

describe('P5：寫手逾時 ⇒ write.main 回 3、寫 timeout.json、台帳 FAIL_timeout（不續話、不跑 --test）', () => {
  test('deps.runAgy 回 timedOut: true（spawnSync 逾時形狀：exit null、signal SIGTERM）⇒ 回 3、timeout.json 含 round 與 timeoutMs、runTest 沒被呼叫', () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test')
    const outDir = path.join(repo.dir, '.agy-write')
    let testCalls = 0
    let runCalls = 0
    const deps = {
      assertSettings: () => true,
      runAgy: () => {
        runCalls++
        return { exit: null, signal: 'SIGTERM', timedOut: true, stdout: '', stderr: '', denied: [], steps: [], result: null, conversationId: null }
      },
      runTest: () => {
        testCalls++
        return { exit: 0, out: 'ok' }
      },
    }
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = writeMain(['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir, '--test', 'node --test', '--timeout-ms', '1234'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 3)
    assert.equal(runCalls, 1, '逾時後不准續話再跑一輪')
    assert.equal(testCalls, 0, '逾時後不跑 --test')
    const t = JSON.parse(fs.readFileSync(path.join(outDir, 'timeout.json'), 'utf8'))
    assert.equal(t.round, 1)
    assert.equal(t.timeoutMs, 1234)
    const ledger = fs.readFileSync(path.join(outDir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(ledger[ledger.length - 1].verdict, 'FAIL_timeout')
    assert.match(errs.join('\n'), /寫手逾時/)
  })

  test('陽性對照：同一組 deps 但 runAgy 正常回 ⇒ 回 0、沒有 timeout.json', () => {
    const repo = makeRepo()
    const brief = path.join(tmpdir('brief-'), 'brief.md')
    fs.writeFileSync(brief, 'test')
    const outDir = path.join(repo.dir, '.agy-write')
    const deps = {
      assertSettings: () => true,
      runAgy: () => ({ exit: 0, stdout: '', stderr: '', denied: [], steps: [], result: { response: 'ok', conversation_id: 'c1' }, conversationId: 'c1' }),
      runTest: () => ({ exit: 0, out: 'ok' }),
    }
    const code = writeMain(['--worktree', repo.dir, '--brief', brief, '--allow', 'add.test.mjs', '--out', outDir, '--test', 'node --test'], deps)
    assert.equal(code, 0)
    assert.ok(!fs.existsSync(path.join(outDir, 'timeout.json')))
  })

  test('spawnTimedOut：spawnSync 的 error.code ETIMEDOUT 也算逾時（parseAgyRun.timedOut 為 true）', () => {
    assert.equal(spawnTimedOut({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }), true)
    assert.equal(spawnTimedOut({ status: null, signal: 'SIGTERM' }), false)
    assert.equal(spawnTimedOut({ timedOut: true }), true)
    const parsed = parseAgyRun({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } })
    assert.equal(parsed.timedOut, true)
  })
})

describe('git 環境剝除：cleanGitEnv 真實生效', () => {
  test('runAgy 子行程收到的 env 沒有 GIT_DIR 與 GIT_WORK_TREE 但保留其他 key', async () => {
    let capturedSpawnEnv = null
    const fakeSpawn = (bin, args, opts) => {
      capturedSpawnEnv = opts.env
      return {
        status: 0,
        stdout: '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}',
        stderr: '',
      }
    }
    await runAgy({
      model: 'gemini-3.8-flash-high',
      mode: 'plan',
      prompt: 'test',
      cwd: process.cwd(),
      // AGY_BIN 走 resolveAgyBin 的覆寫路徑：spawn 是假的，binary 不會被執行，
      // 但沒有它 runAgy 會在沒裝 cask 的機器（GitHub Actions）先 throw（H9e，2026-09-14 GuildHub CI 坐實）。
      env: { PATH: '/custom/bin', GIT_DIR: '/x', GIT_WORK_TREE: '/y', AGY_BIN: '/fake/agy' },
      spawn: fakeSpawn,
    })
    assert.ok(capturedSpawnEnv, 'spawn 應被呼叫')
    assert.equal(capturedSpawnEnv.GIT_DIR, undefined, 'GIT_DIR 應被刪除')
    assert.equal(capturedSpawnEnv.GIT_WORK_TREE, undefined, 'GIT_WORK_TREE 應被刪除')
    assert.equal(capturedSpawnEnv.PATH, '/custom/bin', 'PATH 應被保留')
  })

  test('runCodex 子行程收到的 env 沒有 GIT_DIR 與 GIT_WORK_TREE 但保留其他 key', async () => {
    let capturedSpawnEnv = null
    const fakeSpawn = (bin, args, opts) => {
      capturedSpawnEnv = opts.env
      return { status: 0, stdout: 'ok', stderr: '' }
    }
    await runCodex({
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

  // 🔴 事故：2026-09-15 WAS release 被 tools/git-env-hygiene.test.mjs 擋（.agents/skills/llm-team/lib.mjs:1000 writeTreeOf 用 { env, encoding } 簡寫，字面閘看不到 env:）
  //    陽性對照：lib.mjs writeTreeOf 改回 { env, encoding } ⇒ 本測試紅列出 lib.mjs:1000；母體改成掃不到檔 ⇒ 總數 ≥ 3 紅
  //    停止條件：WAS 那道閘改成行為級（真的 spawn 並檢查子行程 env）時，本測試可退成純分母檢查
  test('靜態：本 skill 每個 git spawn 呼叫點都帶剝除過的 env 字面', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    const ENV_REGEX = /\benv\s*:\s*(?:CLEAN_GIT_ENV|CLEAN_ENV|cleanGitEnv\s*\(|\{\s*\.{3}\s*(?:CLEAN_GIT_ENV|CLEAN_ENV))/
    const CALL_REGEX = /\b(?:spawnSync|execFileSync|execSync|spawn|execFile)\s*\(\s*['"]git['"]\s*[,)]/g

    let totalGitCalls = 0
    const violations = []

    for (const file of files) {
      const fullPath = path.join(dir, file)
      const content = fs.readFileSync(fullPath, 'utf8')
      CALL_REGEX.lastIndex = 0
      let match
      while ((match = CALL_REGEX.exec(content)) !== null) {
        totalGitCalls++
        const parenIndex = content.indexOf('(', match.index)
        let depth = 1
        let closeIndex = -1
        for (let i = parenIndex + 1; i < content.length; i++) {
          const ch = content[i]
          if (ch === '(') {
            depth++
          } else if (ch === ')') {
            depth--
            if (depth === 0) {
              closeIndex = i
              break
            }
          }
        }
        const line = content.slice(0, match.index).split('\n').length
        if (depth !== 0 || closeIndex === -1) {
          throw new Error(`括號計數失敗：${file}:${line}`)
        }
        const argsText = content.slice(parenIndex + 1, closeIndex)
        if (!ENV_REGEX.test(argsText)) {
          violations.push(`${file}:${line}`)
        }
      }
    }

    assert.deepEqual(violations, [], `這些 git 子行程沒有剝除 git 環境變數(缺 env: CLEAN_GIT_ENV):\n    ${violations.join('\n    ')}`)
    assert.ok(totalGitCalls >= 3, `掃到的 git 呼叫點總數應 >= 3，實際為 ${totalGitCalls}`)
  })
})

describe('runAgy 與 runCodex 同步／非同步介面契約', () => {
  test('runAgy 與 runCodex 同步介面：回傳值非 thenable 且 stdout 立刻可讀（不 await）', () => {
    const fakeSyncAgySpawn = (bin, args, opts) => {
      return {
        status: 0,
        stdout: '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}',
        stderr: '',
      }
    }
    const agyRes = runAgy({
      model: 'gemini-3.8-flash-high',
      mode: 'plan',
      prompt: 'test prompt',
      cwd: process.cwd(),
      env: { AGY_BIN: '/mock/bin/antigravity' },
      spawn: fakeSyncAgySpawn,
    })
    assert.notEqual(typeof agyRes?.then, 'function', 'runAgy 回傳值不應為 thenable')
    assert.equal(typeof agyRes.stdout, 'string')
    assert.ok(agyRes.stdout.includes('"event":"result"'), 'runAgy 的 stdout 應立刻可讀')

    const fakeSyncCodexSpawn = (bin, args, opts) => {
      return {
        status: 0,
        stdout: 'codex sync output',
        stderr: '',
      }
    }
    const codexRes = runCodex({
      model: 'gpt-5.6-sol',
      prompt: 'test prompt',
      cwd: process.cwd(),
      env: { CODEX_BIN: '/mock/bin/codex' },
      spawn: fakeSyncCodexSpawn,
    })
    assert.notEqual(typeof codexRes?.then, 'function', 'runCodex 回傳值不應為 thenable')
    assert.equal(typeof codexRes.stdout, 'string')
    assert.equal(codexRes.stdout, 'codex sync output', 'runCodex 的 stdout 應立刻可讀')
  })

  test('runAgyAsync 回傳值為 Promise 實例（instanceof Promise）', async () => {
    const fakeAsyncSpawn = async (bin, args, opts) => {
      return {
        status: 0,
        stdout: '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}',
        stderr: '',
        timedOut: false,
      }
    }
    const agyPromise = runAgyAsync({
      model: 'gemini-3.8-flash-high',
      mode: 'plan',
      prompt: 'test prompt',
      cwd: process.cwd(),
      env: { AGY_BIN: '/mock/bin/antigravity' },
      spawn: fakeAsyncSpawn,
    })
    assert.ok(agyPromise instanceof Promise, 'runAgyAsync 應回傳 Promise 實例')
    const agyRes = await agyPromise
    assert.equal(typeof agyRes.stdout, 'string')
    assert.equal(agyRes.timedOut, false)

    const codexPromise = runCodexAsync({
      model: 'gpt-5.6-sol',
      prompt: 'test prompt',
      cwd: process.cwd(),
      env: { CODEX_BIN: '/mock/bin/codex' },
      spawn: fakeAsyncSpawn,
    })
    assert.ok(codexPromise instanceof Promise, 'runCodexAsync 應回傳 Promise 實例')
    const codexRes = await codexPromise
    assert.equal(codexRes.stdout, '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}')
    assert.equal(codexRes.timedOut, false)
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
      runVersion: () => ({ exit: 0, out: 'mock 1.0' }),
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
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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
      runVersion: () => ({ exit: 0, out: 'mock 1.0' }),
    }
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
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

  test('缺 --coordinator（deps.env 也沒有）⇒ exit 2、stderr 含用法與可用 profiles；--coordinator nope ⇒ exit 2 含「不存在」', () => {
    const deps = makeValidSetupDeps(null)
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    let code2
    try {
      code = setupMain(['--check'], deps)
      code2 = setupMain(['--check', '--coordinator', 'nope'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 2)
    assert.equal(code2, 2)
    const err = errs.join('\n')
    assert.match(err, /--check --coordinator <claude\|agy\|codex>/)
    assert.match(err, /可用 profiles：claude, agy, codex/)
    assert.match(err, /統整者 profile 不存在：nope/)
  })

  test('[config] 行印出 profile 名單；角色用到的 harness 缺 binary ⇒ 紅並指名是哪個角色需要它（agy profile：codex 找不到 ⇒ reviewers[codex/gpt-5-6-sol]）', () => {
    const deps = makeValidSetupDeps({ exit: 0, stdout: JSON.stringify({ command: { data: { hooks: [] } } }) })
    deps.which = (bin) => (bin === 'codex' ? null : `/mock/bin/${bin}`)
    const logs = []
    const errs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => logs.push(String(m))
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
    } finally {
      console.log = origLog
      console.error = origErr
    }
    assert.equal(code, 1)
    const out = logs.join('\n')
    assert.match(out, /\[config\] ✓ schema v2、profile agy：統整者 agy\/gemini〔gemini〕/)
    assert.match(out, /一般票複審 codex\/gpt-5-6-sol〔openai〕/)
    assert.match(out, /\[執行檔 agy\] ✓ .*需要它的角色：統整者、寫手/)
    assert.match(out, /\[執行檔 codex\] ✗ 找不到 — 需要它的角色：reviewers\[codex\/gpt-5-6-sol\]、blockReviewers\[codex\/gpt-5-6-sol\]/)
    assert.match(errs.join('\n'), /harness codex 的 binary 找不到；reviewers\[codex\/gpt-5-6-sol\]/)
    // agy profile 沒有任何 claude 角色 ⇒ 不印 [執行檔 claude]
    assert.doesNotMatch(out, /\[執行檔 claude\]/)
  })

  test('🔴 統整者 binary 也查（codex 複審 Q6）：codex profile 缺 codex binary、其餘全綠 ⇒ exit 1 並指名「統整者」；claude profile 缺 claude binary ⇒ exit 1 指名「統整者」（陽性對照：harnessRoles 不算統整者就回 0）', () => {
    // codex profile：hooks.json＋canary 都對，只有 codex binary 找不到
    const { deps } = makeCodexDeps({ hooksJson: hooksPointingAt(ADAPTER_REAL) })
    deps.which = (bin) => (bin === 'codex' ? null : `/mock/bin/${bin}`)
    const logs = []
    const errs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => logs.push(String(m))
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'codex'], deps)
    } finally {
      console.log = origLog
      console.error = origErr
    }
    const out = logs.join('\n')
    assert.equal(code, 1, out)
    assert.match(out, /\[codex hooks\.json\] ✓/, '其餘檢查都綠，紅的只有統整者 binary')
    assert.match(out, /\[codex canary\] ✓/)
    assert.match(out, /\[執行檔 codex\] ✗ 找不到 — 需要它的角色：統整者/)
    assert.match(errs.join('\n'), /harness codex 的 binary 找不到；統整者 會在第一次呼叫就死/)

    // claude profile：claude binary 找不到
    const base = makeValidSetupDeps(null)
    const claudeSettings = path.join(tmpdir('claude-settings-'), 'settings.json')
    fs.writeFileSync(claudeSettings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/block-dangerous.sh' }] }] } }))
    const deps2 = { ...base, env: { ...base.env, CLAUDE_SETTINGS: claudeSettings }, which: (bin) => (bin === 'claude' ? null : `/mock/bin/${bin}`) }
    const logs2 = []
    console.log = (m) => logs2.push(String(m))
    console.error = () => {}
    let code2
    try {
      code2 = setupMain(['--check', '--coordinator', 'claude'], deps2)
    } finally {
      console.log = origLog
      console.error = origErr
    }
    const out2 = logs2.join('\n')
    assert.equal(code2, 1, out2)
    assert.match(out2, /\[claude hooks\] ✓/)
    assert.match(out2, /\[執行檔 claude\] ✗ 找不到 — 需要它的角色：統整者/)
    // 陽性對照：harnessRoles 把統整者算進去（codex profile 的 codex 只有統整者一個角色）
    assert.deepEqual(harnessRoles(modelsFrom(TEST_CONFIG, {}, 'codex')).get('codex'), ['統整者'])
    assert.deepEqual(harnessRoles(modelsFrom(TEST_CONFIG, {}, 'claude')).get('claude'), ['統整者'])
    assert.deepEqual(harnessRoles(modelsFrom(TEST_CONFIG, {}, 'agy')).get('agy'), ['統整者', '寫手'])
  })

  test('claude 統整者 binary 走 env CLAUDE_BIN（真的 spawn `--version`，注入假 binary）：假 claude 印版本 ⇒ [執行檔 claude] ✓ 含路徑與版本字串；假 claude --version 回 1 ⇒ 紅', () => {
    const binDir = tmpdir('fake-bins-')
    const fakeClaude = path.join(binDir, 'claude')
    fs.writeFileSync(fakeClaude, '#!/bin/sh\necho "9.9.9 (Claude Code fake)"\n')
    fs.chmodSync(fakeClaude, 0o755)
    const fakeCodex = path.join(binDir, 'codex')
    fs.writeFileSync(fakeCodex, '#!/bin/sh\necho "codex-cli 0.0.0-fake"\n')
    fs.chmodSync(fakeCodex, 0o755)
    const brokenClaude = path.join(binDir, 'claude-broken')
    fs.writeFileSync(brokenClaude, '#!/bin/sh\nexit 1\n')
    fs.chmodSync(brokenClaude, 0o755)
    const base = makeValidSetupDeps(null)
    delete base.runVersion // 真的 spawn
    const claudeSettings = path.join(tmpdir('claude-settings-'), 'settings.json')
    fs.writeFileSync(claudeSettings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/block-dangerous.sh' }] }] } }))
    const run = (claudeBin) => {
      const deps = {
        ...base,
        env: { ...base.env, CLAUDE_SETTINGS: claudeSettings, CLAUDE_BIN: claudeBin },
        which: (bin) => (bin === 'codex' ? fakeCodex : `/mock/bin/${bin}`),
      }
      const logs = []
      const origLog = console.log
      const origErr = console.error
      console.log = (m) => logs.push(String(m))
      console.error = () => {}
      let code
      try {
        code = setupMain(['--check', '--coordinator', 'claude'], deps)
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return { code, out: logs.join('\n') }
    }
    const ok = run(fakeClaude)
    assert.equal(ok.code, 0, ok.out)
    assert.ok(ok.out.includes(`[執行檔 claude] ✓ (${fakeClaude}，9.9.9 (Claude Code fake)) — 需要它的角色：統整者`), ok.out)
    assert.ok(ok.out.includes(`[執行檔 codex] ✓ (${fakeCodex}，codex-cli 0.0.0-fake)`), ok.out)
    const bad = run(brokenClaude)
    assert.equal(bad.code, 1)
    assert.match(bad.out, /\[執行檔 claude\] ✗ --version exit 1 — 需要它的角色：統整者/)
  })

  test('--version 非 0 ⇒ 該 harness 紅（--version exit 1）', () => {
    const deps = makeValidSetupDeps({ exit: 0, stdout: JSON.stringify({ command: { data: { hooks: [] } } }) })
    deps.runVersion = () => ({ exit: 1, out: '' })
    const logs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => logs.push(String(m))
    console.error = () => {}
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'agy'], deps)
    } finally {
      console.log = origLog
      console.error = origErr
    }
    assert.equal(code, 1)
    assert.match(logs.join('\n'), /\[執行檔 codex\] ✗ --version exit 1/)
  })

  /** codex 統整者的環境：CODEX_HOME 放 hooks.json；守門用會 deny 含 --force 指令的假 guard。 */
  function makeCodexDeps({ hooksJson, guardDenies = true } = {}) {
    const repo = makeRepo()
    const settingsFile = makeSettings(GOOD_ALLOW)
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    s.permissions.allow.push(`read_file(${repo.dir}/)`)
    s.trustedWorkspaces = [repo.dir]
    fs.writeFileSync(settingsFile, JSON.stringify(s))
    const fakeHome = tmpdir('setup-codex-home-')
    const guardFile = path.join(fakeHome, 'guard.sh')
    fs.writeFileSync(
      guardFile,
      guardDenies
        ? '#!/usr/bin/env bash\nINPUT="$(cat)"\nif echo "$INPUT" | grep -q -- "--force"; then echo "BLOCKED force" >&2; exit 2; fi\nexit 0\n'
        : '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n'
    )
    const codexHome = path.join(fakeHome, '.codex')
    fs.mkdirSync(codexHome, { recursive: true })
    if (hooksJson !== undefined) {
      fs.writeFileSync(path.join(codexHome, 'hooks.json'), typeof hooksJson === 'string' ? hooksJson : JSON.stringify(hooksJson))
    }
    return {
      deps: {
        repoRoot: repo.dir,
        settingsFile,
        config: TEST_CONFIG,
        agyBin: '/mock/bin/antigravity',
        which: (bin) => `/mock/bin/${bin}`,
        runVersion: () => ({ exit: 0, out: 'mock 1.0' }),
        env: { HOME: fakeHome, CODEX_HOME: codexHome, LLM_TEAM_GUARD: guardFile },
      },
      codexHome,
      fakeHome,
    }
  }
  const ADAPTER_REAL = fileURLToPath(new URL('./codex-pretooluse.sh', import.meta.url))
  const hooksPointingAt = (cmd) => ({ hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }] } })

  test('codex 統整者綠：hooks.json 指到轉接器絕對路徑（可執行）＋ canary deny ⇒ exit 0，印 [codex hooks.json] ✓、[codex canary] ✓、[提醒] workspace-write', () => {
    const { deps } = makeCodexDeps({ hooksJson: hooksPointingAt(ADAPTER_REAL) })
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'codex'], deps)
    } finally {
      console.log = origLog
    }
    const out = logs.join('\n')
    assert.equal(code, 0, out)
    assert.match(out, /\[codex hooks\.json\] ✓/)
    assert.match(out, /\[codex canary\] ✓ force push ⇒ deny/)
    assert.match(out, /\[提醒\] codex 統整 session 要用：codex -m gpt-5\.6-sol --sandbox workspace-write -c 'sandbox_workspace_write\.network_access=true' -c model_reasoning_effort="medium"/)
    assert.match(out, /\[執行檔 agy\] ✓ .*需要它的角色：寫手、reviewers\[agy\/gemini\]/)
    assert.match(out, /\[執行檔 codex\] ✓ \(\/mock\/bin\/codex，mock 1\.0\) — 需要它的角色：統整者/, '統整者自己的 harness 也查')
    assert.doesNotMatch(out, /\[hook:block-dangerous\]/, 'agy hooks 檢查只在 agy 統整者')
  })

  test('codex 統整者紅：hooks.json 不存在／command 是相對路徑／指到別的檔／壞 JSON／沒 PreToolUse／不可執行 ⇒ 各 exit 1 且 [codex hooks.json] ✗ 指名原因', () => {
    const cases = [
      { hooksJson: undefined, why: /不存在：/ },
      { hooksJson: hooksPointingAt('./codex-pretooluse.sh'), why: /不是絕對路徑或 realpath 不等於轉接器/ },
      { hooksJson: hooksPointingAt('/usr/bin/true'), why: /realpath 不等於轉接器/ },
      { hooksJson: '{not json', why: /解析失敗/ },
      { hooksJson: { hooks: { PreToolUse: [] } }, why: /沒有 hooks\.PreToolUse/ },
    ]
    for (const c of cases) {
      const { deps } = makeCodexDeps({ hooksJson: c.hooksJson })
      const logs = []
      const origLog = console.log
      const origErr = console.error
      console.log = (m) => logs.push(String(m))
      console.error = () => {}
      let code
      try {
        code = setupMain(['--check', '--coordinator', 'codex'], deps)
      } finally {
        console.log = origLog
        console.error = origErr
      }
      assert.equal(code, 1, `case ${c.why.source} 應紅`)
      const line = logs.find((l) => l.startsWith('[codex hooks.json]'))
      assert.ok(line && line.includes('✗'), `應印 ✗：${line}`)
      assert.match(line, c.why)
    }
    // 不可執行：把轉接器複製成 0644，並讓 setup.mjs 的鄰居就是那份副本
    const { deps, fakeHome } = makeCodexDeps({ hooksJson: undefined })
    const copy = path.join(fakeHome, 'codex-pretooluse.sh')
    fs.copyFileSync(ADAPTER_REAL, copy)
    fs.chmodSync(copy, 0o644)
    fs.writeFileSync(path.join(deps.env.CODEX_HOME, 'hooks.json'), JSON.stringify(hooksPointingAt(copy)))
    deps.importMetaUrl = pathToFileURL(path.join(fakeHome, 'setup.mjs')).href
    const logs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => logs.push(String(m))
    console.error = () => {}
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'codex'], deps)
    } finally {
      console.log = origLog
      console.error = origErr
    }
    assert.equal(code, 1)
    assert.match(logs.find((l) => l.startsWith('[codex hooks.json]')), /不可執行/)
  })

  test('🔴 codex hooks.json matcher（codex 複審 Q4-MATCHER）：^Read$ ⇒ 紅 [codex hooks.json] ✗ matcher 不涵蓋 Bash、exit 1（陽性對照）；^Bash$ ⇒ 綠；無 matcher ⇒ 綠；"Bash|Read" ⇒ 綠；同檔另一項 ^Read$ 指到別的 hook 不影響', () => {
    const withMatcher = (matcher, cmd = ADAPTER_REAL) => {
      const entry = { hooks: [{ type: 'command', command: cmd, timeout: 10 }] }
      if (matcher !== undefined) entry.matcher = matcher
      return { hooks: { PreToolUse: [entry] } }
    }
    const run = (hooksJson) => {
      const { deps } = makeCodexDeps({ hooksJson })
      const logs = []
      const errs = []
      const origLog = console.log
      const origErr = console.error
      console.log = (m) => logs.push(String(m))
      console.error = (m) => errs.push(String(m))
      let code
      try {
        code = setupMain(['--check', '--coordinator', 'codex'], deps)
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return { code, line: logs.find((l) => l.startsWith('[codex hooks.json]')) || '', errs: errs.join('\n') }
    }
    // 陽性對照：路徑對、可執行、canary 也會 deny，只有 matcher 錯 ⇒ 必須紅
    const bad = run(withMatcher('^Read$'))
    assert.equal(bad.code, 1, bad.line)
    assert.match(bad.line, /^\[codex hooks\.json\] ✗ matcher 不涵蓋 Bash/)
    assert.match(bad.line, /"\^Read\$"/)
    assert.match(bad.errs, /codex hooks\.json 沒接上 codex-pretooluse\.sh（matcher 不涵蓋 Bash/)
    // 壞 regex 也紅（fail-closed）
    const broken = run(withMatcher('^Bash('))
    assert.equal(broken.code, 1)
    assert.match(broken.line, /matcher 不涵蓋 Bash/)
    // 綠：^Bash$／無 matcher／Bash|Read／*
    for (const m of ['^Bash$', undefined, 'Bash|Read', '*', '']) {
      const ok = run(withMatcher(m))
      assert.equal(ok.code, 0, `matcher ${JSON.stringify(m)} 應綠：${ok.line}`)
      assert.match(ok.line, /^\[codex hooks\.json\] ✓/)
    }
    // 同檔兩項：^Read$ 指到轉接器、^Bash$ 也指到轉接器 ⇒ 綠（找得到一項會對 Bash 觸發）
    const two = run({
      hooks: {
        PreToolUse: [
          { matcher: '^Read$', hooks: [{ type: 'command', command: ADAPTER_REAL }] },
          { matcher: '^Bash$', hooks: [{ type: 'command', command: ADAPTER_REAL }] },
        ],
      },
    })
    assert.equal(two.code, 0, two.line)
    // 只有 ^Read$ 那項指到轉接器、^Bash$ 指到別的檔 ⇒ 紅（別的檔不是轉接器；轉接器那項對 Bash 不觸發）
    const wrong = run({
      hooks: {
        PreToolUse: [
          { matcher: '^Read$', hooks: [{ type: 'command', command: ADAPTER_REAL }] },
          { matcher: '^Bash$', hooks: [{ type: 'command', command: '/usr/bin/true' }] },
        ],
      },
    })
    assert.equal(wrong.code, 1)
    assert.match(wrong.line, /matcher 不涵蓋 Bash/)
  })

  test('codexMatcherCoversShell／codexPreToolUseEntries：缺／null／""／* ⇒ true；^Read$ ⇒ false；^Bash$／Bash／Bash|Read ⇒ true；壞 regex ⇒ false；陣列任一；entries 帶外層 matcher', () => {
    assert.equal(codexMatcherCoversShell(undefined), true)
    assert.equal(codexMatcherCoversShell(null), true)
    assert.equal(codexMatcherCoversShell(''), true)
    assert.equal(codexMatcherCoversShell('*'), true)
    assert.equal(codexMatcherCoversShell('^Read$'), false)
    assert.equal(codexMatcherCoversShell('^Bash$'), true)
    assert.equal(codexMatcherCoversShell('Bash'), true)
    assert.equal(codexMatcherCoversShell('Bash|Read'), true)
    assert.equal(codexMatcherCoversShell('^Bash('), false)
    assert.equal(codexMatcherCoversShell(42), false)
    assert.equal(codexMatcherCoversShell(['^Read$', '^Bash$']), true)
    assert.equal(codexMatcherCoversShell(['^Read$', '^Edit$']), false)
    assert.deepEqual(
      codexPreToolUseEntries({ hooks: { PreToolUse: [{ matcher: '^Read$', hooks: [{ type: 'command', command: '/a' }] }, { hooks: [{ type: 'command', command: '/b' }] }] } }),
      [{ matcher: '^Read$', command: '/a' }, { matcher: undefined, command: '/b' }]
    )
  })

  test('codex canary 紅（陽性對照）：hooks.json 正確但守門對 --force 放行 ⇒ [codex canary] ✗、exit 1', () => {
    const { deps } = makeCodexDeps({ hooksJson: hooksPointingAt(ADAPTER_REAL), guardDenies: false })
    const logs = []
    const errs = []
    const origLog = console.log
    const origErr = console.error
    console.log = (m) => logs.push(String(m))
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'codex'], deps)
    } finally {
      console.log = origLog
      console.error = origErr
    }
    assert.equal(code, 1)
    assert.match(logs.join('\n'), /\[codex hooks\.json\] ✓/)
    assert.match(logs.join('\n'), /\[codex canary\] ✗/)
    assert.match(errs.join('\n'), /codex deny canary 失敗/)
  })

  test('claude 統整者：CLAUDE_SETTINGS hooks.PreToolUse 有 block-dangerous ⇒ 綠；沒有／檔不存在 ⇒ 紅 [claude hooks] ✗', () => {
    const base = makeValidSetupDeps(null)
    const good = path.join(tmpdir('claude-settings-'), 'settings.json')
    fs.writeFileSync(good, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '$HOME/.claude/hooks/block-dangerous.sh' }] }] } }))
    const bad = path.join(tmpdir('claude-settings-'), 'settings.json')
    fs.writeFileSync(bad, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/other.sh' }] }] } }))

    const run = (settingsPath) => {
      const deps = { ...base, env: { ...base.env, CLAUDE_SETTINGS: settingsPath } }
      const logs = []
      const origLog = console.log
      const origErr = console.error
      console.log = (m) => logs.push(String(m))
      console.error = () => {}
      let code
      try {
        code = setupMain(['--check', '--coordinator', 'claude'], deps)
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return { code, out: logs.join('\n') }
    }
    const g = run(good)
    assert.equal(g.code, 0, g.out)
    assert.match(g.out, /\[claude hooks\] ✓/)
    assert.match(g.out, /\[config\] ✓ schema v2、profile claude：統整者 claude\/claude-code〔anthropic〕/)
    assert.match(g.out, /\[執行檔 codex\] ✓ .*blockReviewers\[codex\/gpt-5-6-sol\]、adjudicator\[codex\/gpt-5-6-sol\]/)
    assert.match(g.out, /\[執行檔 claude\] ✓ \(\/mock\/bin\/claude，mock 1\.0\) — 需要它的角色：統整者/, '統整者自己的 harness 也查')
    assert.doesNotMatch(g.out, /\[hook:block-dangerous\]/)
    const b = run(bad)
    assert.equal(b.code, 1)
    assert.match(b.out, /\[claude hooks\] ✗ hooks\.PreToolUse 沒有 command 含 block-dangerous/)
    const m = run(path.join(tmpdir('nope-'), 'settings.json'))
    assert.equal(m.code, 1)
    assert.match(m.out, /\[claude hooks\] ✗ 不存在/)
  })

  test('claudeSettingsHasDangerousHook／codexPreToolUseCommands：形狀判定', () => {
    assert.equal(claudeSettingsHasDangerousHook({}), false)
    assert.equal(claudeSettingsHasDangerousHook({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'a/block-dangerous.sh' }] }] } }), true)
    assert.equal(claudeSettingsHasDangerousHook({ hooks: { PreToolUse: [{ hooks: [{ type: 'prompt', command: 'block-dangerous' }] }] } }), false)
    assert.deepEqual(codexPreToolUseCommands({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/a' }, { type: 'command', command: '/b' }] }] } }), ['/a', '/b'])
    assert.deepEqual(codexPreToolUseCommands({ hooks: { PostToolUse: [] } }), [])
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

  test('setup.mjs --check: 快照 SOURCE.json.version "1.6.7"、deps.sourceVersion "1.6.8" ⇒ 回 1、stderr 含「落後真源」與「export.mjs --all」', () => {
    const base = makeValidSetupDeps(null)
    const good = path.join(tmpdir('claude-settings-'), 'settings.json')
    fs.writeFileSync(good, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '$HOME/.claude/hooks/block-dangerous.sh' }] }] } }))
    const deps = { ...base, env: { ...base.env, CLAUDE_SETTINGS: good } }

    const snapshotDir = path.join(deps.repoRoot, '.agents', 'skills', 'llm-team')
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(
      path.join(snapshotDir, 'SOURCE.json'),
      JSON.stringify({ version: '1.6.7', sourceCommit: 'abcdef0', exportedAt: '2026-09-15' })
    )
    deps.sourceVersion = '1.6.8'
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'claude'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 1)
    const allErr = errs.join('\n')
    assert.ok(allErr.includes('落後真源'), `stderr 應包含「落後真源」，實際：${allErr}`)
    assert.ok(allErr.includes('export.mjs --all'), `stderr 應包含「export.mjs --all」，實際：${allErr}`)
  })

  test('setup.mjs --check: 快照 SOURCE.json.version 與 deps.sourceVersion 相等 ⇒ 不因此紅', () => {
    const base = makeValidSetupDeps(null)
    const good = path.join(tmpdir('claude-settings-'), 'settings.json')
    fs.writeFileSync(good, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '$HOME/.claude/hooks/block-dangerous.sh' }] }] } }))
    const deps = { ...base, env: { ...base.env, CLAUDE_SETTINGS: good } }

    const snapshotDir = path.join(deps.repoRoot, '.agents', 'skills', 'llm-team')
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(
      path.join(snapshotDir, 'SOURCE.json'),
      JSON.stringify({ version: '1.6.8', sourceCommit: 'abcdef0', exportedAt: '2026-09-15' })
    )
    deps.sourceVersion = '1.6.8'
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'claude'], deps)
    } finally {
      console.error = origErr
    }
    assert.equal(code, 0)
  })

  test('setup.mjs --check: 真源不可讀（deps.sourceDir 指到不存在目錄）⇒ 印「略過」不紅', () => {
    const base = makeValidSetupDeps(null)
    const good = path.join(tmpdir('claude-settings-'), 'settings.json')
    fs.writeFileSync(good, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '$HOME/.claude/hooks/block-dangerous.sh' }] }] } }))
    const deps = { ...base, env: { ...base.env, CLAUDE_SETTINGS: good } }

    const snapshotDir = path.join(deps.repoRoot, '.agents', 'skills', 'llm-team')
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(
      path.join(snapshotDir, 'SOURCE.json'),
      JSON.stringify({ version: '1.6.8', sourceCommit: 'abcdef0', exportedAt: '2026-09-15' })
    )
    deps.sourceDir = path.join(tmpdir('nonexistent-src-'), 'does-not-exist')
    delete deps.sourceVersion
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    let code
    try {
      code = setupMain(['--check', '--coordinator', 'claude'], deps)
    } finally {
      console.log = origLog
    }
    assert.equal(code, 0)
    const allLog = logs.join('\n')
    assert.ok(allLog.includes('略過'), `stdout 應包含「略過」，實際：${allLog}`)
  })

  test('setup.mjs --check: 沒有快照 ⇒ 略過', () => {
    const base = makeValidSetupDeps(null)
    const good = path.join(tmpdir('claude-settings-'), 'settings.json')
    fs.writeFileSync(good, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '$HOME/.claude/hooks/block-dangerous.sh' }] }] } }))
    const deps = { ...base, env: { ...base.env, CLAUDE_SETTINGS: good } }
    deps.sourceVersion = '1.6.8'
    const code = setupMain(['--check', '--coordinator', 'claude'], deps)
    assert.equal(code, 0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 1.12.0：agy prompt 走 stream-json stdin；council diff 不截斷、超過 cap 停在複審者之前（codex＋Gemini 兩輪一致選 B）
// 陽性對照：把 buildAgyArgs 的 '--print=' 換回 ['-p', prompt] ⇒ (a)(c) 紅；把 council 的 `return 6` 拿掉 ⇒ (f) 紅；
// 把 input.json 的 writeFileSync 拿掉 ⇒ (e)(f)(g) 紅。
// ─────────────────────────────────────────────────────────────────────────────
describe('1.12.0 agy stdin：prompt 不在 argv、走 stream-json stdin', () => {
  const NASTY = '/plan 第一行以斜線開頭\n第二行有 "雙引號" 與 \\ 反斜線\n第三行有 emoji 🚀 與中文\n\t縮排'

  test('(a) buildAgyArgs 不含 prompt、不含 -p；含 --print=、--input-format stream-json、--disable-slash-commands、--output-format stream-json', () => {
    const args = buildAgyArgs({ model: 'gemini-3.1-pro-high', mode: 'plan', timeoutMs: 60000 })
    assert.ok(!args.includes('-p'), 'argv 不得再有 -p')
    assert.ok(!args.some((x) => x.includes('第一行')), 'argv 不得含 prompt 內容')
    assert.ok(args.includes('--print='), "要有 '--print='（不是 --print=''）")
    assert.ok(!args.includes("--print=''"), "spawn 不經 shell，'--print=\\'\\'' 會把兩個單引號當內容")
    const i = args.indexOf('--input-format'); assert.ok(i !== -1 && args[i + 1] === 'stream-json')
    const o = args.indexOf('--output-format'); assert.ok(o !== -1 && args[o + 1] === 'stream-json')
    assert.ok(args.includes('--disable-slash-commands'))
    assert.equal(args[args.length - 1], '--print=', '--print= 放最後，才不會把後面的 flag 吃成 prompt')
  })

  test('(b) buildAgyStdin：一行 JSON＋換行，解析回來 event=user、role=user、content 與原文逐字相同（多行／引號／反斜線／emoji／開頭 /plan）', () => {
    const line = buildAgyStdin(NASTY)
    assert.ok(line.endsWith('\n') && line.slice(0, -1).indexOf('\n') === -1, '恰好一行、以換行結尾')
    const o = JSON.parse(line)
    assert.equal(o.event, 'user')
    assert.equal(o.message.role, 'user')
    assert.equal(o.message.content, NASTY)
  })

  test('(c) runAgy（同步）：假 spawn 收到 opts.input＝buildAgyStdin(prompt)、stdio 三個 pipe、args 不含 prompt', async () => {
    let captured = null
    const fakeSpawn = (bin, args, opts) => {
      captured = { bin, args, opts }
      return { status: 0, stdout: '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}', stderr: '' }
    }
    const r = await runAgy({ model: 'gemini-3.1-pro-high', mode: 'plan', prompt: NASTY, cwd: process.cwd(), env: { PATH: '/x', AGY_BIN: '/fake/agy' }, spawn: fakeSpawn })
    assert.equal(r.result.response, 'ok')
    assert.deepEqual(captured.opts.stdio, ['pipe', 'pipe', 'pipe'])
    assert.equal(JSON.parse(captured.opts.input).message.content, NASTY)
    assert.ok(!captured.args.includes('-p') && !captured.args.some((x) => x.includes('第一行')))
    assert.equal(captured.opts.maxBuffer, 64 * 1024 * 1024, 'maxBuffer 仍是 stdout/stderr 的上限，跟 input 無關')
  })

  test('(d) runAgyAsync：假 spawn 同樣收到 opts.input；真 spawnAsync 帶 input 會把 payload 送進子行程 stdin，子行程先退（EPIPE）不炸', async () => {
    let captured = null
    const fakeSpawn = async (bin, args, opts) => {
      captured = { args, opts }
      return { status: 0, signal: null, timedOut: false, stdout: '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}', stderr: '' }
    }
    await runAgyAsync({ model: 'gemini-3.1-pro-high', mode: 'plan', prompt: NASTY, cwd: process.cwd(), env: { PATH: '/x', AGY_BIN: '/fake/agy' }, spawn: fakeSpawn })
    assert.equal(JSON.parse(captured.opts.input).message.content, NASTY)
    assert.ok(!captured.args.includes('-p'))

    const big = 'x'.repeat(400000)
    const echo = await spawnAsync(process.execPath, ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(String(d.length))})'], { input: big, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 })
    assert.equal(echo.status, 0)
    assert.equal(echo.stdout, String(big.length), '400000 字元的 input 要完整進到子行程 stdin（argv 塞不下的量）')
    const early = await spawnAsync(process.execPath, ['-e', 'process.exit(0)'], { input: big, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 })
    assert.equal(early.status, 0, '子行程沒讀 stdin 就退 ⇒ promise 正常 resolve，不是未捕捉的 EPIPE')
  })
})

describe('1.12.0 council：diff 不截斷；超過 --diff-cap 停在複審者之前並入帳', () => {
  function reviewRepo(bigBytes) {
    const repo = makeRepo()
    repo.g('checkout', 'main')
    fs.writeFileSync(path.join(repo.dir, 'f.txt'), 'line 1\n')
    repo.g('add', 'f.txt'); repo.g('commit', '-m', 'A')
    repo.g('checkout', '-b', 'feat/cap-test')
    fs.appendFileSync(path.join(repo.dir, 'f.txt'), 'y'.repeat(bigBytes) + '\n')
    const brief = path.join(tmpdir('brief-'), 'brief.md'); fs.writeFileSync(brief, '# brief\n')
    return { repo, brief }
  }
  async function run(argsExtra, repo, brief) {
    const outDir = tmpdir('review-cap-')
    let calls = 0
    const deps = { runOne: (name, model) => { calls++; return { name, model, exit: 0, ms: 1, empty: false, denied: [], text: '整份：簽' } } }
    const origLog = console.log; const origErr = console.error; const errs = []
    console.log = () => {}; console.error = (m) => errs.push(String(m))
    let code
    try {
      code = await councilMain(['review', '--coordinator', 'claude', '--worktree', repo.dir, '--base', 'main', '--brief', brief, '--out', outDir, '--tier', 'standard', ...argsExtra], deps)
    } finally { console.log = origLog; console.error = origErr }
    const input = fs.existsSync(path.join(outDir, 'input.json')) ? JSON.parse(fs.readFileSync(path.join(outDir, 'input.json'), 'utf8')) : null
    const members = fs.existsSync(path.join(outDir, 'members.json')) ? JSON.parse(fs.readFileSync(path.join(outDir, 'members.json'), 'utf8')) : null
    const prompt = fs.existsSync(path.join(outDir, 'prompt.md')) ? fs.readFileSync(path.join(outDir, 'prompt.md'), 'utf8') : ''
    return { code, calls, input, members, prompt, errs: errs.join('\n') }
  }

  test('(e) diff 未超過 cap ⇒ 複審者被呼叫、input.json 永遠寫（status ok、reviewInvoked true、capOverridden false、writerReportTruncated null）', async () => {
    const { repo, brief } = reviewRepo(1000)
    const r = await run([], repo, brief)
    assert.equal(r.code, 0); assert.equal(r.calls, 2)
    assert.equal(r.input.status, 'ok'); assert.equal(r.input.reviewInvoked, true); assert.equal(r.input.capOverridden, false)
    assert.equal(r.input.diffCap, 120000); assert.equal(r.input.defaultDiffCap, 120000)
    assert.ok(r.input.diffLength > 1000 && r.input.diffLength < 120000)
    assert.equal(r.input.writerReportTruncated, null, '新版永遠寫欄位：null＝確認沒截斷，不是缺欄位')
    assert.ok(!r.prompt.includes('截斷，原長'), 'diff 不再被截斷')
  })

  test('(f) diff 超過 cap ⇒ 回 6、複審者【沒有】被呼叫、members.json 是 []、input.json status=diff_over_cap、stderr 講下一步（拆票或 --diff-cap N）', async () => {
    const { repo, brief } = reviewRepo(130000)
    const r = await run([], repo, brief)
    assert.equal(r.code, 6, `應回 6，實際 ${r.code}`)
    assert.equal(r.calls, 0, '超過 cap 不得呼叫任何複審者')
    assert.deepEqual(r.members, [])
    assert.equal(r.input.status, 'diff_over_cap'); assert.equal(r.input.reviewInvoked, false)
    assert.ok(r.input.diffLength > 120000)
    assert.match(r.errs, /超過完整送審上限 120000/); assert.match(r.errs, /拆票/); assert.match(r.errs, new RegExp(`--diff-cap ${r.input.diffLength}`))
  })

  test('(g) --diff-cap 提高到夠大 ⇒ 複審者被呼叫、capOverridden true 入帳、diff 完整進 prompt（不截斷）；--diff-cap 非正整數 ⇒ 2', async () => {
    const { repo, brief } = reviewRepo(130000)
    const r = await run(['--diff-cap', '200000'], repo, brief)
    assert.equal(r.code, 0); assert.equal(r.calls, 2)
    assert.equal(r.input.capOverridden, true); assert.equal(r.input.diffCap, 200000); assert.equal(r.input.reviewInvoked, true)
    assert.ok(r.prompt.includes('y'.repeat(130000)), '完整 diff 要在 prompt 裡')
    const bad = await run(['--diff-cap', 'abc'], repo, brief)
    assert.equal(bad.code, 2); assert.equal(bad.calls, 0)
  })

  test('(h) diff 長度剛好等於 cap ⇒ 不算超過（reviewInvoked true）', async () => {
    const { repo, brief } = reviewRepo(500)
    const probe = await run([], repo, brief)
    const exact = await run(['--diff-cap', String(probe.input.diffLength)], repo, brief)
    assert.equal(exact.code, 0); assert.equal(exact.input.reviewInvoked, true); assert.equal(exact.input.diffLength, exact.input.diffCap)
    const under = await run(['--diff-cap', String(probe.input.diffLength - 1)], repo, brief)
    assert.equal(under.code, 6)
  })

  test('(i) --writer-report 超過 20000 字元 ⇒ input.json.writerReportTruncated 記原長與 cap（複審者仍被呼叫）', async () => {
    const { repo, brief } = reviewRepo(100)
    const report = path.join(tmpdir('report-'), 'r.md'); fs.writeFileSync(report, 'r'.repeat(25000))
    const r = await run(['--writer-report', report], repo, brief)
    assert.equal(r.code, 0); assert.equal(r.calls, 2)
    assert.deepEqual(r.input.writerReportTruncated, { originalLength: 25000, cap: 20000 })
  })
})
