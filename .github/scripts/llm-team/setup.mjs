#!/usr/bin/env node
// ─────────────────── agy / llm-team 設定對帳（fail-closed） ───────────────────
// 用法：
//   node .github/scripts/llm-team/setup.mjs --check
//   node .github/scripts/llm-team/setup.mjs --sync-check <starterRoot>
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
} from './lib.mjs'

export const SYNC_FILES = [
  '.github/scripts/llm-team/lib.mjs',
  '.github/scripts/llm-team/write.mjs',
  '.github/scripts/llm-team/council.mjs',
  '.github/scripts/llm-team/ticket.mjs',
  '.github/scripts/llm-team/setup.mjs',
  '.github/scripts/llm-team/llm-team.test.mjs',
  '.github/scripts/llm-team/ticket.test.mjs',
  '.github/scripts/test-llm-team.sh',
  'prompts/07-ticket.md',
  '.claude/skills/llm-team/SKILL.md',
  '.github/scripts/llm-team/VERSION',
]

export function syncCheck(repoRoot, starterArg, deps = {}) {
  const cwd = deps.cwd || process.cwd()
  const starterRoot = path.resolve(cwd, starterArg)
  const starterVersionPath = path.join(starterRoot, '.github', 'scripts', 'llm-team', 'VERSION')

  if (!fs.existsSync(starterRoot) || !fs.existsSync(starterVersionPath)) {
    console.error(`🔴 starterRoot 不存在或缺少 .github/scripts/llm-team/VERSION：${starterRoot}`)
    return 2
  }

  let driftCount = 0

  for (const relPath of SYNC_FILES) {
    const localPath = path.join(repoRoot, relPath)
    const starterPath = path.join(starterRoot, relPath)

    const localExists = fs.existsSync(localPath)
    const starterExists = fs.existsSync(starterPath)

    if (localExists && starterExists) {
      const localBuf = fs.readFileSync(localPath)
      const starterBuf = fs.readFileSync(starterPath)
      if (localBuf.equals(starterBuf)) {
        console.log(`= ${relPath}`)
      } else {
        driftCount++
        const localHash = crypto.createHash('sha256').update(localBuf).digest('hex').slice(0, 8)
        const starterHash = crypto.createHash('sha256').update(starterBuf).digest('hex').slice(0, 8)
        console.log(`≠ ${relPath}（本專案 ${localHash} ／ 模板 ${starterHash}）`)
      }
    } else if (!localExists && starterExists) {
      driftCount++
      console.log(`− ${relPath}（本專案沒有）`)
    } else if (localExists && !starterExists) {
      driftCount++
      console.log(`+ ${relPath}（模板已無此檔）`)
    } else {
      driftCount++
      console.log(`? ${relPath}（兩邊皆無）`)
    }
  }

  const localVersionPath = path.join(repoRoot, '.github', 'scripts', 'llm-team', 'VERSION')
  const localVersion = fs.existsSync(localVersionPath) ? fs.readFileSync(localVersionPath, 'utf8').trim() : '（無）'
  const starterVersion = fs.readFileSync(starterVersionPath, 'utf8').trim()

  console.log(`VERSION：本專案 ${localVersion} ／ 模板 ${starterVersion}`)
  console.log(`漂移 ${driftCount} 檔`)
  if (driftCount > 0) {
    console.log('要升級：手動逐字複製上面 ≠／− 的檔，config.json 不動')
  }

  return driftCount === 0 ? 0 : 1
}

export function main(argv, deps = {}) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        check: { type: 'boolean' },
        'sync-check': { type: 'string' },
      },
      allowPositionals: false,
    })
  } catch {
    console.error('用法：\n  node .github/scripts/llm-team/setup.mjs --check\n  node .github/scripts/llm-team/setup.mjs --sync-check <starterRoot>')
    return 2
  }

  const isCheck = Boolean(parsed.values.check)
  const syncStarter = parsed.values['sync-check']

  if ((!isCheck && !syncStarter) || (isCheck && syncStarter)) {
    console.error('用法：\n  node .github/scripts/llm-team/setup.mjs --check\n  node .github/scripts/llm-team/setup.mjs --sync-check <starterRoot>')
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

  if (syncStarter) {
    return syncCheck(repoRoot, syncStarter, deps)
  }

  const loadCfg = deps.loadConfig || loadConfig
  let config
  try {
    config = deps.config || loadCfg(repoRoot)
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
