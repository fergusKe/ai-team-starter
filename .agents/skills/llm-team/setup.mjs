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
import path from 'node:path'
import crypto from 'node:crypto'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import {
  loadConfig,
  buildSafeCommandRegex,
  agySettingsPath,
  resolveAgyBin,
  resolveCodexBin,
  git,
  isDirectRun,
} from './lib.mjs'
import { verifySnapshot } from './export.mjs'

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

  const agyBin = resolveAgyBin(env)
  const agyFound = (agyBin && fs.existsSync(agyBin) ? agyBin : null) || whichFn('antigravity') || whichFn('agy')
  const codexBin = resolveCodexBin(env)
  const codexFound = whichFn(codexBin) || whichFn('codex')

  console.log(`[command(regex)] ${hasCommandRegex ? '✓ 存在' : '✗ 缺少'}`)
  console.log(`[read_file(${rootWithSlash})] ${hasReadFile ? '✓ 覆蓋' : '✗ 缺少'}`)
  console.log(`[trustedWorkspaces] ${hasTrustedWorkspace ? '✓ 覆蓋' : '✗ 缺少'}`)
  console.log(
    `[執行檔] agy: ${agyFound ? `✓ (${agyFound})` : '✗ 找不到'} | codex: ${codexFound ? `✓ (${codexFound})` : '✗ 找不到'}`
  )

  const missingAllow = []
  if (!hasCommandRegex) missingAllow.push(wantCommand)
  if (!hasReadFile) missingAllow.push(`read_file(${rootWithSlash})`)
  const missingTrusted = !hasTrustedWorkspace ? [repoRoot] : []

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
    return 1
  }

  return 0
}

if (isDirectRun(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
