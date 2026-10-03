#!/usr/bin/env node
// ─────────────────── llm-team 設定對帳（fail-closed；依統整者 profile） ───────────────────
// 用法：
//   node .agents/skills/llm-team/setup.mjs --check --coordinator <claude|agy|codex> [--config <file>]
//   node .agents/skills/llm-team/setup.mjs --sync-check
//
// --check 檢查什麼（2026-09-14 schema v2；1.15.0 起 harness 專屬的部分查 harnesses/ registry）：
//   共同：[config] v2 載入＋不變式；[守門] block-dangerous.sh 候選；該 profile 每個角色用到的 harness 的 binary（含統整者自己的：
//         各 harness 的 checkBinary——agy 找 cask／AGY_BIN、codex `codex --version`／CODEX_BIN、claude `claude --version`／CLAUDE_BIN、
//         gemini `gemini --version`／GEMINI_BIN）；有 auth 的 harness 的 key 可達性（gemini：GEMINI_API_KEY env／Keychain，永不印值）；
//         有 preflight 的 harness 的設定對帳（agy：settings.json 的 command regex／read_file／trustedWorkspaces——ticket run 的 G2 不分統整者都會查）。
//   agy   統整者：agy 全域 hooks.json 有載入 block-dangerous。
//   codex 統整者：$CODEX_HOME/hooks.json（預設 ~/.codex/hooks.json）有 PreToolUse 指到 codex-pretooluse.sh（絕對路徑、realpath 與快照或真源相同、可執行），
//         並真的用 deny canary（force push）跑一次轉接器。
//   claude 統整者：~/.claude/settings.json（或 CLAUDE_SETTINGS）hooks.PreToolUse 有 block-dangerous。
//
// 🔴 為什麼只對帳、不自動改使用者的 settings.json：
//   1. settings.json 是使用者的全域設定，可能包含其他專案設定或敏感資訊。
//   2. fail-closed：缺哪條就印該貼的 JSON 片段，由人或統整者確認後手動合併。
//   3. 永不讀出或印出 settings 裡任何看起來像 token 的欄位值。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  loadConfig,
  modelsFrom,
  memberName,
  git,
  isDirectRun,
  cleanGitEnv,
} from './lib.mjs'
import { getHarness } from './harnesses/index.mjs'
import { AUTH_SOURCES_OK } from './harnesses/_contract.mjs'
import { verifySnapshot } from './export.mjs'

const USAGE = [
  '用法：',
  '  node .agents/skills/llm-team/setup.mjs --check --coordinator <claude|agy|codex> [--config <file>]',
  '  node .agents/skills/llm-team/setup.mjs --sync-check',
].join('\n')

/** Codex hooks.json 路徑：env CODEX_HOME 或 ~/.codex。 */
export function codexHooksPath(env = process.env) {
  const home = env.CODEX_HOME || path.join(env.HOME || process.env.HOME || os.homedir(), '.codex')
  return path.join(home, 'hooks.json')
}

/** Claude Code 全域 settings 路徑：env CLAUDE_SETTINGS 或 ~/.claude/settings.json。 */
export function claudeSettingsPath(env = process.env) {
  return env.CLAUDE_SETTINGS || path.join(env.HOME || process.env.HOME || os.homedir(), '.claude', 'settings.json')
}

/** Claude Code settings.json 的 hooks.PreToolUse 裡有沒有任何 command 含 block-dangerous。 */
export function claudeSettingsHasDangerousHook(settings) {
  const pre = settings?.hooks?.PreToolUse
  if (!Array.isArray(pre)) return false
  return pre.some(
    (entry) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.some((h) => h?.type === 'command' && typeof h.command === 'string' && h.command.includes('block-dangerous'))
  )
}

/**
 * 從 Codex hooks.json 撈出所有 PreToolUse 的 {matcher, command}（形狀：{hooks:{PreToolUse:[{matcher,hooks:[{type:'command',command}]}]}}）。
 * matcher 是外層那一項的；缺 ⇒ undefined（視為匹配全部）。
 */
export function codexPreToolUseEntries(hooksJson) {
  const pre = hooksJson?.hooks?.PreToolUse
  if (!Array.isArray(pre)) return []
  const out = []
  for (const entry of pre) {
    for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (h && h.type === 'command' && typeof h.command === 'string') out.push({ matcher: entry?.matcher, command: h.command })
    }
  }
  return out
}

/** 只要 command 字串（沿用舊介面）。 */
export function codexPreToolUseCommands(hooksJson) {
  return codexPreToolUseEntries(hooksJson).map((e) => e.command)
}

/** Codex 派 shell 時的 tool_name（Codex 官方 hooks 測試用 `^Bash$`；若 M4 實測是 `shell`，改這裡一處）。 */
export const CODEX_SHELL_TOOL_NAME = 'Bash'

/**
 * hooks.json 的 matcher 有沒有涵蓋 shell 工具：缺／null／''／'*' ⇒ 全部（true）；字串 ⇒ `new RegExp(matcher).test('Bash')`（壞 regex ⇒ false）；陣列 ⇒ 任一。
 * 🔴 2026-09-14 codex 複審 Q4-MATCHER：以前完全忽略外層 matcher，設成 `^Read$` 路徑檢查與 canary 照過，實際 Bash 永遠不觸發守門。
 *    陽性對照 llm-team.test.mjs「codex hooks.json matcher ^Read$ ⇒ 紅」。停止條件：Codex 提供「哪個 hook 會對哪個 tool 觸發」的機械回報時改讀它。
 */
export function codexMatcherCoversShell(matcher, tool = CODEX_SHELL_TOOL_NAME) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
  if (Array.isArray(matcher)) return matcher.some((m) => codexMatcherCoversShell(m, tool))
  if (typeof matcher !== 'string') return false
  try {
    return new RegExp(matcher).test(tool)
  } catch {
    return false
  }
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/**
 * profile 各角色用到的 harness ⇒ Map<harness, 角色描述[]>（統整者排第一、角色名「統整者」）。
 * 🔴 2026-09-14 codex 複審 Q6：以前刻意排除統整者（「它就是正在跑的那個」）——但 --check 可能在別的 harness 裡跑
 *    （Claude Code 裡替 codex profile 做 --check），codex profile 缺 codex binary 照樣回 0，證明不了統整者本身可執行。
 *    陽性對照 llm-team.test.mjs「codex profile 缺 codex binary ⇒ 紅並指名統整者」。
 */
export function harnessRoles(models) {
  const m = new Map()
  const add = (harness, role) => {
    if (!m.has(harness)) m.set(harness, [])
    m.get(harness).push(role)
  }
  add(models.coordinator.harness, '統整者')
  add(models.writer.harness, '寫手')
  for (const r of models.reviewers) add(r.harness, `reviewers[${r.name}]`)
  for (const r of models.blockReviewers) add(r.harness, `blockReviewers[${r.name}]`)
  for (const r of (models.postReviewers || [])) add(r.harness, `postReviewers[${r.name}]`)
  if (models.adjudicator !== 'human') add(models.adjudicator.harness, `adjudicator[${models.adjudicator.name}]`)
  return m
}

/** codex deny canary 的 payload（Codex PreToolUse 形狀；指令是 force push）。 */
export function codexCanaryPayload(repoRoot) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command: ['git', 'push', '--force', 'origin', 'main'].join(' ') }, cwd: repoRoot })
}

export function guardCandidates(env = process.env, importMetaUrl = import.meta.url, cwd = process.cwd()) {
  const list = []

  // 1. env.LLM_TEAM_GUARD
  if (env?.LLM_TEAM_GUARD) {
    let g = env.LLM_TEAM_GUARD
    if (g.startsWith('~/') && env?.HOME) {
      g = path.join(env.HOME, g.slice(2))
    }
    list.push(path.resolve(g))
  }

  // 2. <repoRoot>/scripts/claude-hooks/block-dangerous.sh（repoRoot 由 git rev-parse --show-toplevel，cwd）
  let repoRoot = null
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: cwd || process.cwd(),
      env: cleanGitEnv(env || process.env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (r.status === 0 && r.stdout) {
      repoRoot = r.stdout.trim()
    }
  } catch {
    repoRoot = null
  }
  if (!repoRoot && cwd && fs.existsSync(path.join(cwd, 'scripts', 'claude-hooks', 'block-dangerous.sh'))) {
    repoRoot = cwd
  }
  const rootForScripts = repoRoot || cwd || process.cwd()
  list.push(path.resolve(rootForScripts, 'scripts', 'claude-hooks', 'block-dangerous.sh'))

  // 3. path.join(env.HOME, '.claude', 'hooks', 'block-dangerous.sh')
  const homeDir = env?.HOME || process.env.HOME || os.homedir()
  list.push(path.resolve(homeDir, '.claude', 'hooks', 'block-dangerous.sh'))

  // 4. new URL('../../hooks/block-dangerous.sh', importMetaUrl)
  if (importMetaUrl) {
    try {
      list.push(fileURLToPath(new URL('../../hooks/block-dangerous.sh', importMetaUrl)))
    } catch {
      list.push(path.resolve(cwd || process.cwd(), '../../hooks/block-dangerous.sh'))
    }
  } else {
    list.push(path.resolve(cwd || process.cwd(), '../../hooks/block-dangerous.sh'))
  }

  return list
}

export function resolveGuardPath(env = process.env, importMetaUrl = import.meta.url, cwd = process.cwd()) {
  const candidates = guardCandidates(env, importMetaUrl, cwd)
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return c
    }
  }
  return null
}


export function matcherCovers(matcher, tool = 'run_command') {
  if (Array.isArray(matcher)) {
    return matcher.some((m) => matcherCovers(m, tool))
  }
  if (matcher === '*' || matcher === '') {
    return true
  }
  if (typeof matcher === 'string') {
    try {
      return new RegExp(`^(?:${matcher})$`).test(tool)
    } catch {
      return false
    }
  }
  return false
}

export function syncCheck(repoRoot, deps = {}) {
  const snapshotDir = path.join(repoRoot, '.agents', 'skills', 'llm-team')
  const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')

  if (!fs.existsSync(snapshotDir) || !fs.existsSync(manifestPath)) {
    console.error(`🔴 快照不存在或缺少 MANIFEST.sha256：${snapshotDir}`)
    return 2
  }

  const verifySnapshotFn = deps.verifySnapshot || verifySnapshot
  const v = verifySnapshotFn(snapshotDir)

  const sourceJsonPath = path.join(snapshotDir, 'SOURCE.json')
  let version = '1'
  let commit = 'unknown'
  let dateStr = ''

  if (fs.existsSync(sourceJsonPath)) {
    try {
      const source = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'))
      if (source.version) version = source.version
      if (source.sourceCommit) commit = source.sourceCommit.slice(0, 7)
      if (source.exportedAt) dateStr = source.exportedAt.slice(0, 10)
    } catch {
      /* fallback */
    }
  } else {
    const versionPath = path.join(snapshotDir, 'VERSION')
    if (fs.existsSync(versionPath)) {
      version = fs.readFileSync(versionPath, 'utf8').trim()
    }
  }

  console.log(`VERSION ${version}（來源 commit ${commit}，${dateStr}）`)

  const driftCount = v.changed.length + v.missing.length + v.extra.length
  const driftParts = []
  if (v.changed.length > 0) driftParts.push(`changed: ${v.changed.join(', ')}`)
  if (v.missing.length > 0) driftParts.push(`missing: ${v.missing.join(', ')}`)
  if (v.extra.length > 0) driftParts.push(`extra: ${v.extra.join(', ')}`)

  if (driftCount > 0) {
    console.log(`漂移 ${driftCount} 檔（${driftParts.join('／')}）`)
    for (const f of v.changed) console.log(`≠ ${f}`)
    for (const f of v.missing) console.log(`− ${f}`)
    for (const f of v.extra) console.log(`+ ${f}`)
    return 1
  } else {
    console.log(`漂移 0 檔`)
    return 0
  }
}

export function main(argv, deps = {}) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        check: { type: 'boolean' },
        'sync-check': { type: 'boolean' },
        config: { type: 'string' },
        coordinator: { type: 'string' },
      },
      allowPositionals: false,
    })
  } catch {
    console.error(USAGE)
    return 2
  }

  const isCheck = Boolean(parsed.values.check)
  const isSyncCheck = Boolean(parsed.values['sync-check'])

  if ((!isCheck && !isSyncCheck) || (isCheck && isSyncCheck)) {
    console.error(USAGE)
    return 2
  }

  const gitFn = deps.git || git
  let repoRoot
  try {
    repoRoot = deps.repoRoot || path.resolve(gitFn(deps.cwd || process.cwd(), ['rev-parse', '--show-toplevel']))
  } catch (e) {
    console.error(`🔴 無法取得 repoRoot：${e.message}`)
    return 2
  }

  if (isSyncCheck) {
    return syncCheck(repoRoot, deps)
  }

  const configFile = parsed.values.config || null
  const loadCfg = deps.loadConfig || loadConfig
  let config
  try {
    config = deps.config || loadCfg(repoRoot, configFile)
  } catch (e) {
    console.error(`🔴 config 載入失敗：${e.message}`)
    return 2
  }

  const env = deps.env || process.env
  const available = Object.keys(config.profiles || {})
  const coordinator = parsed.values.coordinator || env.LLM_TEAM_COORDINATOR || null
  if (!coordinator) {
    console.error(`${USAGE}\n🔴 缺 --coordinator（或 env LLM_TEAM_COORDINATOR）；可用 profiles：${available.join(', ') || '(無)'}`)
    return 2
  }
  let models
  try {
    models = modelsFrom(config, env, coordinator)
  } catch (e) {
    console.error(`${USAGE}\n🔴 ${e.message}`)
    return 2
  }
  const coord = models.coordinator
  const fmt = (m) => `${m.name || memberName(m)}〔${m.quotaBucket}〕`
  console.log(
    `[config] ✓ schema v2、profile ${coordinator}：統整者 ${memberName(coord)}〔${coord.quotaBucket}〕${coord.effort ? `（effort ${coord.effort}）` : ''}｜寫手 ${memberName(models.writer)}〔${models.writer.quotaBucket}〕｜一般票複審 ${models.reviewers.map(fmt).join('＋')}｜block 複審 ${models.blockReviewers.map(fmt).join('＋')}｜事後審 ${models.postReviewers && models.postReviewers.length > 0 ? models.postReviewers.map(fmt).join('＋') : '（未設）'}｜一般票裁決 ${models.adjudicator === 'human' ? 'human' : fmt(models.adjudicator)}｜block 未決 ${models.blockAdjudicator}`
  )

  let failed = false
  const importMetaUrl = deps.importMetaUrl !== undefined ? deps.importMetaUrl : import.meta.url

  // ── 共同：守門 ──
  const guardFn = deps.resolveGuardPath || resolveGuardPath
  const guardPath = guardFn(env, importMetaUrl, repoRoot)
  const hasGuard = Boolean(guardPath)
  console.log(`[守門] ${hasGuard ? `✓ (${guardPath})` : '✗ 缺少'}`)
  // 🔴 2026-09-13 事故：快照 export 到 web-agency-system 後 test.sh 整套紅（整合測試找不到守門）；陽性對照 llm-team.test.mjs「LLM_TEAM_GUARD 指到不存在的檔、HOME 是空 tmp ⇒ exit 1 且 stderr 含「守門」」；停止條件：真源自帶守門副本、候選縮成一項時拆掉本檢查
  if (!hasGuard) {
    failed = true
    const candidates = guardCandidates(env, importMetaUrl, repoRoot)
    console.error(
      `🔴 找不到任何守門腳本 block-dangerous.sh（這台會跑 agy／codex，沒有守門＝閘不存在；候選：${candidates.join(', ')}）`
    )
  }

  // ── 共同：各角色用到的 harness 的 binary（含統整者自己的——--check 不一定在統整者的 harness 裡跑）；怎麼找、要不要跑 --version 由各 harness 的 checkBinary 決定 ──
  //    deps.which／deps.runVersion／deps.agyBin／deps.codexBin／deps.claudeBin／deps.geminiBin 原封轉給 checkBinary（既有測試接縫）。
  const getHarnessFn = deps.getHarness || getHarness
  const modelHarnesses = harnessRoles(models)
  for (const [harness, roles] of modelHarnesses) {
    const b = getHarnessFn(harness).checkBinary(env, deps)
    if (b && !b.versionError) {
      console.log(`[執行檔 ${harness}] ✓ (${b.path}${b.version ? `，${b.version}` : ''}) — 需要它的角色：${roles.join('、')}`)
    } else {
      failed = true
      console.log(`[執行檔 ${harness}] ✗ ${b ? b.versionError : '找不到'} — 需要它的角色：${roles.join('、')}`)
      console.error(`🔴 harness ${harness} 的 binary ${b ? '不能跑（' + b.versionError + '）' : '找不到'}；${roles.join('、')} 會在第一次呼叫就死`)
    }
  }

  // ── 有 auth 的 harness（gemini：GEMINI_API_KEY，env 或 macOS Keychain）：key 可達性；🔴 永不印值，只印「來源」或「缺」 ──
  // 🔴 事故：2026-09-21 agy 訂閱額度用盡（429 RESOURCE_EXHAUSTED）⇒ 複審席零輸出 ⇒ `ticket.mjs land` 被 anyEmpty 擋
  //   （WAS 票 checkout-activation-mail）；2026-09-22 改走 Gemini CLI API key 後，同一種「用到才發現」失效換了形狀：
  //   key 缺不會在載入 config 時擋下來，而是撐到第一次 council 呼叫，那時整席（複審或裁決）零輸出、跟訂閱額度用盡
  //   長一樣的死法。`setup --check` 是唯一能在票流程開工【之前】把這件事攔下來的地方。
  // 🔴 陽性對照 llm-team.test.mjs「⑪ setup --check：GEMINI_API_KEY 缺…⇒ failed 且輸出含「✗ 缺」」／
  //   「⑫ …Keychain 取到 ⇒ 輸出含「GEMINI_API_KEY：Keychain」且不含 key 值」。
  // 🔴 停止條件：council 對 failure.kind === 'auth' 的結果會在 `members.json` 顯形並在收貨摘要印 🔴
  //   （讓缺 key 在票流程本身就顯形，不用靠 setup 提前攔）時，本閘可從「紅」降為「警告」。
  for (const [harness] of modelHarnesses) {
    const h = getHarnessFn(harness)
    if (!h.auth) continue
    // 🔴 fail-closed（sol r2 Q2）：只有 'env'／'Keychain' 算可達；'缺' 印 ✗ 缺；其他任何值（undefined、'Env'、拼錯）印 ✗ 未知來源，
    //    一律 failed——describe 壞掉不能變成放行。回傳值本身不印（避免任何路徑把 key 值印出來）。
    //    陽性對照 harnesses.test.mjs ⑦「describe 回 undefined／'Env' ⇒ exit 非 0、輸出不含 ✓ GEMINI_API_KEY」。
    const source = h.auth.describe(env, deps)
    const reachable = AUTH_SOURCES_OK.includes(source)
    const missing = source === '缺'
    console.log(`[${h.auth.envVar}] ${reachable ? `✓ ${h.auth.envVar}：${source}` : missing ? '✗ 缺' : '✗ 未知來源'}`)
    if (!reachable) {
      failed = true
      console.error(
        missing
          ? `🔴 ${h.auth.envVar} 不可達（env 與 macOS Keychain 都沒有）；${harness} harness 的角色會在第一次呼叫就死`
          : `🔴 ${h.auth.envVar} 來源判定不合法（${harness} harness 的 auth.describe 沒回 env|Keychain|缺）；當不可達處理`
      )
    }
  }

  // ── 有 preflight 的 harness（agy：settings.json 對帳——ticket run 的 G2 不分統整者都會查）──
  //    讀不到設定檔 ⇒ preflight throw ⇒ 印訊息回 2（沿用 1.14.0：agy settings 不存在／解析失敗都是 exit 2）。
  const missingAllow = []
  const missingTrusted = []
  let settingsFile = null
  for (const [harness] of modelHarnesses) {
    const h = getHarnessFn(harness)
    if (!h.preflight) continue
    let checks
    try {
      checks = h.preflight(env, config, { repoRoot, settingsFile: deps.settingsFile, role: 'setup' })
    } catch (e) {
      console.error(`🔴 ${e.message}`)
      return 2
    }
    for (const c of checks) {
      console.log(`[${c.label}] ${c.ok ? `✓ ${c.okText || '通過'}` : `✗ ${c.failText || '缺少'}`}`)
      if (c.ok) continue
      failed = true
      if (c.fix) {
        if (c.fix.file) settingsFile = c.fix.file
        if (Array.isArray(c.fix.allow)) missingAllow.push(...c.fix.allow)
        if (Array.isArray(c.fix.trustedWorkspaces)) missingTrusted.push(...c.fix.trustedWorkspaces)
      }
    }
  }

  // ── agy 統整者：全域 hooks.json 有載入 block-dangerous ──
  if (coordinator === 'agy') {
    const agyBin = (deps.agyBin !== undefined ? deps.agyBin : getHarnessFn('agy').resolveBin(env)) || null
    let hooksData = null
    if (deps.runAgyHooks) {
      const res = deps.runAgyHooks(agyBin, repoRoot, env)
      let hooksRaw = ''
      if (typeof res === 'string') {
        hooksRaw = res
      } else if (res && typeof res.stdout === 'string' && (res.exit === 0 || res.exit === undefined)) {
        hooksRaw = res.stdout
      }
      if (hooksRaw) {
        try {
          const d = JSON.parse(hooksRaw)
          hooksData = d?.command?.data?.hooks
        } catch {
          hooksData = null
        }
      }
    } else if (agyBin) {
      const r = spawnSync(agyBin, ['--output-format', 'json', '-p', '/hooks'], {
        cwd: repoRoot,
        env: cleanGitEnv(env),
        encoding: 'utf8',
        timeout: 30000,
      })
      if (r.status === 0 && r.stdout) {
        try {
          const d = JSON.parse(r.stdout)
          hooksData = d?.command?.data?.hooks
        } catch {
          hooksData = null
        }
      }
    }

    // 🔴 2026-09-13 事故：agy 側原本沒有破壞性指令閘；同日實測 workspace .agents/hooks.json 在 headless 不載入 ⇒ 檔案放對了 session 也可能沒載入。陽性對照 llm-team.test.mjs「只注入 settingsFile、不注入 runAgyHooks 且 agyBin 為 null ⇒ --check 紅且訊息含 hooks.json 沒載入」。停止條件：agy 官方讓 workspace hooks 在 headless 載入、或提供 hook 載入的機械回報時重審。
    const expectedSource = env.HOME
      ? path.join(env.HOME, '.gemini', 'config', 'hooks.json')
      : (process.env.HOME ? path.join(process.env.HOME, '.gemini', 'config', 'hooks.json') : null)

    let badSourceFound = null
    const hasDangerousHook =
      Array.isArray(hooksData) &&
      hooksData.some((h) => {
        if (!h || h.name !== 'block-dangerous' || h.enabled !== true) return false
        if (!expectedSource || h.source !== expectedSource) {
          badSourceFound = h.source || '未知'
          return false
        }
        const actions = Array.isArray(h.actions) ? h.actions : []
        return actions.some(
          (a) => a && a.event === 'PreToolUse' && matcherCovers(a.matcher, 'run_command')
        )
      })

    console.log(`[hook:block-dangerous] ${hasDangerousHook ? '✓ 已載入' : '✗ 缺少'}`)

    if (!hasDangerousHook) {
      failed = true
      const hookDetails = Array.isArray(hooksData) && hooksData.length > 0
        ? hooksData
            .map((h) => {
              const matchers = Array.isArray(h?.actions)
                ? h.actions.map((a) => (typeof a?.matcher === 'object' ? JSON.stringify(a?.matcher) : a?.matcher)).join(',')
                : (typeof h?.matcher === 'object' ? JSON.stringify(h?.matcher) : (h?.matcher ?? ''))
              return `name=${h?.name} enabled=${h?.enabled} matcher=${matchers} source=${h?.source}`
            })
            .join('; ')
        : '無'
      const reason = badSourceFound
        ? `（來源不是全域 hooks.json：${badSourceFound}）`
        : ''
      console.error(
        `🔴 agy 全域 hooks.json 沒載入 block-dangerous${reason}（跑 config repo install.sh；\`agy -p "/hooks"\` 現在列出：${hookDetails}）`
      )
    }
  }

  // ── codex 統整者：$CODEX_HOME/hooks.json ＋ deny canary ──
  if (coordinator === 'codex') {
    const hooksFile = codexHooksPath(env)
    const adapterAdjacent = safeRealpath(fileURLToPath(new URL('./codex-pretooluse.sh', importMetaUrl)))
    const adapterSource = safeRealpath(
      path.join(env.HOME || process.env.HOME || os.homedir(), '.claude', 'skills', 'llm-team', 'codex-pretooluse.sh')
    )
    const accepted = [...new Set([adapterAdjacent, adapterSource].filter(Boolean))]
    let hookOk = false
    let hookCmd = null
    let hookWhy = ''
    if (!fs.existsSync(hooksFile)) {
      hookWhy = `不存在：${hooksFile}`
    } else {
      let hooksJson = null
      try {
        hooksJson = JSON.parse(fs.readFileSync(hooksFile, 'utf8'))
      } catch (e) {
        hookWhy = `解析失敗：${e.message}`
      }
      if (hooksJson) {
        const entries = codexPreToolUseEntries(hooksJson)
        const cmds = entries.map((e) => e.command)
        if (entries.length === 0) {
          hookWhy = '沒有 hooks.PreToolUse[].hooks[].{type:"command",command}'
        } else {
          const pointingAtAdapter = entries.filter((e) => {
            if (!path.isAbsolute(e.command)) return false
            const rp = safeRealpath(path.resolve(e.command))
            return rp && accepted.includes(rp)
          })
          // 🔴 路徑對了還不夠：外層 matcher 要真的會對 shell 工具觸發（缺 matcher ＝ 全部 ＝ 放行）。
          const covering = pointingAtAdapter.find((e) => codexMatcherCoversShell(e.matcher))
          if (pointingAtAdapter.length === 0) {
            hookWhy = `PreToolUse command 不是絕對路徑或 realpath 不等於轉接器（有：${cmds.join(', ')}；接受：${accepted.join(' 或 ')}）`
          } else if (!covering) {
            hookWhy = `matcher 不涵蓋 ${CODEX_SHELL_TOOL_NAME}（有：${pointingAtAdapter.map((e) => JSON.stringify(e.matcher)).join(', ')}；shell 呼叫永遠不會派到轉接器，改成 "^${CODEX_SHELL_TOOL_NAME}$" 或拿掉 matcher）`
          } else {
            const matched = covering.command
            hookCmd = matched
            try {
              fs.accessSync(path.resolve(matched), fs.constants.X_OK)
              hookOk = true
            } catch {
              hookWhy = `轉接器不可執行（chmod +x）：${matched}`
            }
          }
        }
      }
    }
    console.log(`[codex hooks.json] ${hookOk ? `✓ (${hooksFile} → ${hookCmd})` : `✗ ${hookWhy}`}`)
    if (!hookOk) {
      failed = true
      console.error(
        `🔴 codex hooks.json 沒接上 codex-pretooluse.sh（${hookWhy}）。範例見 SKILL.md §codex hooks.json：{"hooks":{"PreToolUse":[{"matcher":"^Bash$","hooks":[{"type":"command","command":"${accepted[0] || '<絕對路徑>/codex-pretooluse.sh'}","timeout":10}]}]}}`
      )
    }

    // deny canary：真的跑一次轉接器（bash＋python3，不是 LLM 呼叫）；守門用上面找到的那份
    const canaryAdapter = hookOk ? path.resolve(hookCmd) : adapterAdjacent
    let canaryOk = false
    let canaryWhy = ''
    if (!canaryAdapter || !fs.existsSync(canaryAdapter)) {
      canaryWhy = '找不到轉接器可跑'
    } else {
      const canaryEnv = { ...cleanGitEnv(env) }
      if (guardPath) canaryEnv.LLM_TEAM_GUARD = guardPath
      const r = spawnSync('bash', [canaryAdapter], { input: codexCanaryPayload(repoRoot), encoding: 'utf8', env: canaryEnv, timeout: 20000 })
      const out = r.stdout || ''
      if (r.status === 0 && /"permissionDecision":\s*"deny"/.test(out)) {
        canaryOk = true
      } else {
        canaryWhy = `exit ${r.status}，stdout：${out.trim().slice(0, 300) || '(空)'}${r.stderr ? `，stderr：${String(r.stderr).trim().slice(0, 200)}` : ''}`
      }
    }
    console.log(`[codex canary] ${canaryOk ? '✓ force push ⇒ deny' : `✗ ${canaryWhy}`}`)
    if (!canaryOk) {
      failed = true
      console.error(`🔴 codex deny canary 失敗：轉接器對 force push 沒有回 permissionDecision=deny（${canaryWhy}）`)
    }
    console.log(
      '[提醒] codex 統整 session 要用：codex -m gpt-5.6-sol --sandbox workspace-write -c \'sandbox_workspace_write.network_access=true\' -c model_reasoning_effort="medium"（全域 config 維持 read-only）'
    )
  }

  // ── claude 統整者：~/.claude/settings.json hooks 有 block-dangerous ──
  if (coordinator === 'claude') {
    const claudeSettings = claudeSettingsPath(env)
    let ok = false
    let why = ''
    if (!fs.existsSync(claudeSettings)) {
      why = `不存在：${claudeSettings}`
    } else {
      try {
        ok = claudeSettingsHasDangerousHook(JSON.parse(fs.readFileSync(claudeSettings, 'utf8')))
        if (!ok) why = 'hooks.PreToolUse 沒有 command 含 block-dangerous 的項目'
      } catch (e) {
        why = `解析失敗：${e.message}`
      }
    }
    console.log(`[claude hooks] ${ok ? `✓ (${claudeSettings})` : `✗ ${why}`}`)
    if (!ok) {
      failed = true
      console.error(`🔴 Claude Code settings 沒接 block-dangerous PreToolUse hook（${why}）；跑 config repo install.sh`)
    }
  }

  if (missingAllow.length > 0 || missingTrusted.length > 0) {
    const snippet = {}
    if (missingAllow.length > 0) {
      snippet.permissions = { allow: missingAllow }
    }
    if (missingTrusted.length > 0) {
      snippet.trustedWorkspaces = missingTrusted
    }
    console.log(
      `\n請將以下片段手動合併進 ${settingsFile}：\n` + JSON.stringify(snippet, null, 2)
    )
  }

  // ── 快照落後偵測 ──
  const snapshotSourceJsonPath = path.join(repoRoot, '.agents', 'skills', 'llm-team', 'SOURCE.json')
  if (fs.existsSync(snapshotSourceJsonPath)) {
    let snapshotVersion = null
    try {
      const sJson = JSON.parse(fs.readFileSync(snapshotSourceJsonPath, 'utf8'))
      snapshotVersion = sJson?.version || null
    } catch {}

    let sourceVersion = deps.sourceVersion
    if (sourceVersion === undefined) {
      const home = env.HOME || process.env.HOME || os.homedir()
      const trueSourceDir =
        deps.sourceDir ?? env.LLM_TEAM_SOURCE_DIR ?? process.env.LLM_TEAM_SOURCE_DIR ?? path.join(home, '.claude', 'skills', 'llm-team')
      const sourceVersionPath = path.join(trueSourceDir, 'VERSION')
      try {
        if (fs.existsSync(sourceVersionPath)) {
          sourceVersion = fs.readFileSync(sourceVersionPath, 'utf8').trim()
        }
      } catch {}
    }

    if (!sourceVersion) {
      console.log('ℹ 真源不可讀，略過落後偵測')
    } else if (snapshotVersion !== sourceVersion) {
      failed = true
      console.error(`🔴 快照 ${snapshotVersion} 落後真源 ${sourceVersion}：在真源 repo 跑 node home/skills/llm-team/export.mjs --all`)
    }
  }

  return failed ? 1 : 0
}

if (isDirectRun(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
