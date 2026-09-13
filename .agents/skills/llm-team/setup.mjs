#!/usr/bin/env node
// ─────────────────── agy / llm-team 設定對帳（fail-closed） ───────────────────
// 用法：
//   node .agents/skills/llm-team/setup.mjs --check [--config <file>]
//   node .agents/skills/llm-team/setup.mjs --sync-check
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
  buildSafeCommandRegex,
  agySettingsPath,
  resolveAgyBin,
  resolveCodexBin,
  git,
  isDirectRun,
  cleanGitEnv,
} from './lib.mjs'
import { verifySnapshot } from './export.mjs'

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
      },
      allowPositionals: false,
    })
  } catch {
    console.error('用法：\n  node .agents/skills/llm-team/setup.mjs --check\n  node .agents/skills/llm-team/setup.mjs --sync-check')
    return 2
  }

  const isCheck = Boolean(parsed.values.check)
  const isSyncCheck = Boolean(parsed.values['sync-check'])

  if ((!isCheck && !isSyncCheck) || (isCheck && isSyncCheck)) {
    console.error('用法：\n  node .agents/skills/llm-team/setup.mjs --check\n  node .agents/skills/llm-team/setup.mjs --sync-check')
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
  const settingsFile = deps.settingsFile || agySettingsPath(env)
  if (!fs.existsSync(settingsFile)) {
    console.error(`🔴 agy settings 不存在：${settingsFile}`)
    return 2
  }

  let settings
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  } catch (e) {
    console.error(`🔴 agy settings 解析失敗（${settingsFile}）：${e.message}`)
    return 2
  }

  const allow = (settings.permissions && settings.permissions.allow) || []
  const wantRegex = buildSafeCommandRegex(config)
  const wantCommand = `command(regex:${wantRegex})`
  const hasCommandRegex = allow.includes(wantCommand)

  const rootWithSlash = repoRoot.endsWith('/') ? repoRoot : repoRoot + '/'
  const hasReadFile = allow.some((a) => {
    const m = typeof a === 'string' && a.match(/^read_file\((.+)\)$/)
    if (!m) return false
    const t = m[1].endsWith('/') ? m[1] : m[1] + '/'
    return rootWithSlash.startsWith(t) || m[1] === '*'
  })

  const trusted = settings.trustedWorkspaces || []
  const hasTrustedWorkspace = trusted.some((tw) => {
    if (typeof tw !== 'string') return false
    const t = tw.endsWith('/') ? tw : tw + '/'
    return rootWithSlash.startsWith(t)
  })

  const whichFn =
    deps.which ||
    ((cmd) => {
      const r = spawnSync('which', [cmd], { encoding: 'utf8' })
      return r.status === 0 ? r.stdout.trim() : null
    })

  const agyBin = (deps.agyBin !== undefined ? deps.agyBin : resolveAgyBin(env)) || null
  const agyFound = (agyBin && fs.existsSync(agyBin) ? agyBin : null) || whichFn('antigravity') || whichFn('agy')
  const codexBin = deps.codexBin !== undefined ? deps.codexBin : resolveCodexBin(env)
  const codexFound = (codexBin && whichFn(codexBin)) || whichFn('codex')

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

  let missingHook = false
  if (!hasDangerousHook) {
    missingHook = true
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

  console.log(`[command(regex)] ${hasCommandRegex ? '✓ 存在' : '✗ 缺少'}`)
  console.log(`[read_file(${rootWithSlash})] ${hasReadFile ? '✓ 覆蓋' : '✗ 缺少'}`)
  console.log(`[trustedWorkspaces] ${hasTrustedWorkspace ? '✓ 覆蓋' : '✗ 缺少'}`)

  const importMetaUrl = deps.importMetaUrl !== undefined ? deps.importMetaUrl : import.meta.url

  const guardFn = deps.resolveGuardPath || resolveGuardPath
  const guardPath = guardFn(env, importMetaUrl, repoRoot)
  const hasGuard = Boolean(guardPath)

  console.log(`[守門] ${hasGuard ? `✓ (${guardPath})` : '✗ 缺少'}`)

  // 🔴 2026-09-13 事故：快照 export 到 web-agency-system 後 test.sh 整套紅（整合測試找不到守門）；陽性對照 llm-team.test.mjs「LLM_TEAM_GUARD 指到不存在的檔、HOME 是空 tmp ⇒ exit 1 且 stderr 含「守門」」；停止條件：真源自帶守門副本、候選縮成一項時拆掉本檢查
  let missingGuard = false
  if (!hasGuard) {
    missingGuard = true
    const candidates = guardCandidates(env, importMetaUrl, repoRoot)
    console.error(
      `🔴 找不到任何守門腳本 block-dangerous.sh（這台會跑 agy，沒有守門＝閘不存在；候選：${candidates.join(', ')}）`
    )
  }

  console.log(
    `[執行檔] agy: ${agyFound ? `✓ (${agyFound})` : '✗ 找不到'} | codex: ${codexFound ? `✓ (${codexFound})` : '✗ 找不到'}`
  )

  const missingAllow = []
  if (!hasCommandRegex) missingAllow.push(wantCommand)
  if (!hasReadFile) missingAllow.push(`read_file(${rootWithSlash})`)
  const missingTrusted = !hasTrustedWorkspace ? [repoRoot] : []

  if (missingAllow.length > 0 || missingTrusted.length > 0 || missingHook || missingGuard) {
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
    return 1
  }

  return 0
}

if (isDirectRun(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
