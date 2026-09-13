#!/usr/bin/env node
// ─────────────────── llm-team 唯讀快照導出工具 ───────────────────
// 用法：
//   node .agents/skills/llm-team/export.mjs --to <targetRepoRoot> [--force]

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CLEAN_GIT_ENV, parseArgs, isDirectRun } from './lib.mjs'

export const EXPORT_FILES = [
  'lib.mjs',
  'write.mjs',
  'council.mjs',
  'ticket.mjs',
  'setup.mjs',
  'llm-team.test.mjs',
  'ticket.test.mjs',
  'export.mjs',
  'export.test.mjs',
  'agy-pretooluse.sh',
  'agy-pretooluse.test.mjs',
  'SKILL.md',
  'test.sh',
  'VERSION',
]

export const MANIFEST_REQUIRED = [...EXPORT_FILES, 'SOURCE.json'].sort()

/**
 * 驗證快照目錄中的檔案是否與 MANIFEST.sha256 一致，並偵測額外檔案。
 * 回傳：{ ok, missing: [], changed: [], extra: [], unlisted: [], malformed: [], duplicate: [] }
 */
export function verifySnapshot(snapshotDir, options = {}) {
  const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')
  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      missing: ['MANIFEST.sha256'],
      changed: [],
      extra: [],
      unlisted: [],
      sourceNew: [],
      malformed: [],
      duplicate: [],
      manuallyDeleted: [],
      legacyNoFiles: [],
    }
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf8')
  const manifestEntries = new Map()
  const malformed = []
  const duplicate = []

  for (const rawLine of manifestContent.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (!/^[0-9a-f]{64}  \S.*$/.test(line)) {
      malformed.push(line)
      continue
    }
    const hash = line.slice(0, 64)
    const relPath = line.slice(66)
    if (manifestEntries.has(relPath)) {
      if (!duplicate.includes(relPath)) {
        duplicate.push(relPath)
      }
    } else {
      manifestEntries.set(relPath, hash)
    }
  }

  const sourceJsonPath = path.join(snapshotDir, 'SOURCE.json')
  const sourceJsonExists = fs.existsSync(sourceJsonPath)
  let sourceFiles = null
  let hasSourceFilesField = false
  if (sourceJsonExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (!malformed.includes('SOURCE.json')) malformed.push('SOURCE.json')
      } else if ('files' in parsed) {
        if (Array.isArray(parsed.files) && parsed.files.every((f) => typeof f === 'string')) {
          hasSourceFilesField = true
          sourceFiles = new Set(parsed.files)
        } else {
          if (!malformed.includes('SOURCE.json')) malformed.push('SOURCE.json')
        }
      }
    } catch {
      if (!malformed.includes('SOURCE.json')) malformed.push('SOURCE.json')
    }
  }

  const hasExplicitSource = Boolean(options.manifestRequired || options.exportFiles)
  const base =
    options.manifestRequired ||
    (options.exportFiles ? [...options.exportFiles, 'SOURCE.json'] : MANIFEST_REQUIRED)
  const manifestRequired = (hasSourceFilesField
    ? [...new Set([...base, ...sourceFiles, 'SOURCE.json'])]
    : [...new Set(base)]
  ).sort()

  const missing = []
  const changed = []
  const extra = []
  const unlisted = []
  const sourceNew = []
  const manuallyDeleted = []
  const legacyNoFiles = []

  for (const req of manifestRequired) {
    if (!manifestEntries.has(req)) {
      const fullPath = path.join(snapshotDir, req)
      if (fs.existsSync(fullPath)) {
        unlisted.push(req)
      } else if (hasSourceFilesField) {
        if (sourceFiles.has(req)) {
          missing.push(req)
          manuallyDeleted.push(req)
        } else {
          sourceNew.push(req)
        }
      } else if (hasExplicitSource) {
        missing.push(req)
        legacyNoFiles.push(req)
      } else {
        missing.push(req)
      }
    }
  }

  for (const [relPath, expectedHash] of manifestEntries.entries()) {
    if (!manifestRequired.includes(relPath)) {
      if (!extra.includes(relPath)) {
        extra.push(relPath)
      }
    }
    const fullPath = path.join(snapshotDir, relPath)
    if (!fs.existsSync(fullPath)) {
      missing.push(relPath)
    } else {
      const actualHash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(fullPath))
        .digest('hex')
      if (actualHash !== expectedHash) {
        changed.push(relPath)
      }
    }
  }

  // 🔴 事故：2026-09-13 GuildHub-frontend 快照複審 codex 指出 .json／無副檔名檔靜默放行；陽性對照：export.test.mjs「乾淨快照 + x.json ⇒ extra 含 x.json 且 --sync-check exit 1」、「乾淨快照 + 無副檔名檔 stray ⇒ extra 含 stray 且 --sync-check exit 1」；停止條件：快照改成單一 tar／簽章檔那天拆掉。
  function scan(dir) {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(full)
      } else if (entry.isFile()) {
        const rel = path.relative(snapshotDir, full)
        if (rel === 'MANIFEST.sha256') continue
        if (!manifestEntries.has(rel) && !extra.includes(rel) && !unlisted.includes(rel)) {
          extra.push(rel)
        }
      }
    }
  }
  scan(snapshotDir)

  missing.sort()
  changed.sort()
  extra.sort()
  unlisted.sort()
  sourceNew.sort()
  manuallyDeleted.sort()
  legacyNoFiles.sort()
  malformed.sort()
  duplicate.sort()

  const ok =
    missing.length === 0 &&
    changed.length === 0 &&
    extra.length === 0 &&
    unlisted.length === 0 &&
    malformed.length === 0 &&
    duplicate.length === 0

  return { ok, missing, changed, extra, unlisted, malformed, duplicate, sourceNew, manuallyDeleted, legacyNoFiles }
}

/**
 * 導出快照至目標 repo：
 * 目的地：<targetRoot>/.agents/skills/llm-team/
 */
export function exportTo(sourceDir, targetRoot, options = {}) {
  const force = Boolean(options.force)
  const deps = options.deps || {}
  const exportFiles = options.exportFiles || deps.exportFiles || EXPORT_FILES
  const manifestRequired =
    options.manifestRequired ||
    deps.manifestRequired ||
    (options.exportFiles
      ? [...options.exportFiles, 'SOURCE.json'].sort()
      : deps.exportFiles
      ? [...deps.exportFiles, 'SOURCE.json'].sort()
      : MANIFEST_REQUIRED)

  const targetDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
  const targetManifest = path.join(targetDir, 'MANIFEST.sha256')

  let pendingNewFiles = []
  if (fs.existsSync(targetManifest)) {
    const v = verifySnapshot(targetDir, { exportFiles, manifestRequired })
    const hasDrift =
      v.changed.length > 0 ||
      v.missing.length > 0 ||
      v.extra.length > 0 ||
      v.unlisted.length > 0 ||
      v.malformed.length > 0 ||
      v.duplicate.length > 0

    if (hasDrift) {
      if (!force) {
        const parts = []
        if (v.changed.length > 0) parts.push(`changed:\n  ${v.changed.join('\n  ')}`)
        if (v.missing.length > 0) parts.push(`missing:\n  ${v.missing.join('\n  ')}`)
        if (v.extra.length > 0) parts.push(`extra:\n  ${v.extra.join('\n  ')}`)
        if (v.unlisted.length > 0) parts.push(`unlisted:\n  ${v.unlisted.join('\n  ')}`)
        if (v.malformed.length > 0) parts.push(`malformed:\n  ${v.malformed.join('\n  ')}`)
        if (v.duplicate.length > 0) parts.push(`duplicate:\n  ${v.duplicate.join('\n  ')}`)

        let deleteWarning = ''
        if (v.manuallyDeleted && v.manuallyDeleted.length > 0) {
          deleteWarning = `\n🔴 目標曾有此檔，現在連 manifest 都沒有＝手動刪除，不准靜默補回：${v.manuallyDeleted.join(', ')}`
        }

        let legacyWarning = ''
        if (v.legacyNoFiles && v.legacyNoFiles.length > 0) {
          legacyWarning = `\n🔴 舊版快照沒有 files 欄，無法分辨來源新增與目標刪檔；確認目標未手刪後用 --force 一次性升級：${v.legacyNoFiles.join(', ')}`
        }

        console.error(`🔴 快照已被修改（手動漂移），不准覆蓋：\n  ${parts.join('\n  ')}${deleteWarning}${legacyWarning}`)
        return { ok: false, status: 2, verify: v, changed: v.changed }
      }
    }

    if (v.sourceNew && v.sourceNew.length > 0) {
      pendingNewFiles = [...v.sourceNew]
    }
  }

  // 先算好 sourceCommit / sourceDirty，失敗直接 throw，不寫任何檔、不留半成品
  const gitFn =
    deps.git ||
    ((args, cwd) => {
      const r = spawnSync('git', ['-C', cwd, ...args], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失敗：${(r.stderr || '').trim()}`)
      return (r.stdout || '').trim()
    })

  const sourceCommit = gitFn(['rev-parse', 'HEAD'], sourceDir)
  const statusOut = gitFn(['status', '--porcelain', '.'], sourceDir)
  const sourceDirty = Boolean(statusOut && statusOut.trim().length > 0)

  const versionPath = path.join(sourceDir, 'VERSION')
  const version = fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : '1'
  const exportedAt = deps.now ? deps.now().toISOString() : new Date().toISOString()
  const sourceJson = {
    version,
    sourceCommit,
    sourceDirty,
    exportedAt,
    files: [...exportFiles],
  }

  fs.mkdirSync(targetDir, { recursive: true })

  // 1. 複製 EXPORT_FILES
  for (const f of exportFiles) {
    const src = path.join(sourceDir, f)
    const dst = path.join(targetDir, f)
    fs.copyFileSync(src, dst)
  }

  for (const f of pendingNewFiles) {
    console.log(`+ ${f}`)
  }

  // 2. 寫 SOURCE.json
  fs.writeFileSync(path.join(targetDir, 'SOURCE.json'), JSON.stringify(sourceJson, null, 2) + '\n')

  // 3. 寫 MANIFEST.sha256
  const manifestFiles = [...manifestRequired]
  const manifestLines = []
  for (const f of manifestFiles) {
    const full = path.join(targetDir, f)
    const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    manifestLines.push(`${hash}  ${f}`)
  }
  fs.writeFileSync(path.join(targetDir, 'MANIFEST.sha256'), manifestLines.join('\n') + '\n')

  // 4. 起始範本 config.json
  const targetConfig = path.join(targetRoot, 'llm-team.config.json')
  const templateConfig = path.join(sourceDir, 'config.json')
  if (!fs.existsSync(targetConfig) && fs.existsSync(templateConfig)) {
    fs.copyFileSync(templateConfig, targetConfig)
    console.log('已放範本，請改成專案值')
  }

  return { ok: true, status: 0, targetDir }
}

export function main(argv, deps = {}) {
  const a = parseArgs(argv)
  if (!a.to) {
    console.error('用法：node export.mjs --to <targetRepoRoot> [--force]')
    return 2
  }

  const sourceDir = path.dirname(fileURLToPath(import.meta.url))
  const targetRoot = path.resolve(a.to)
  const res = exportTo(sourceDir, targetRoot, { force: Boolean(a.force), deps })
  if (!res.ok) {
    return res.status || 2
  }
  return 0
}

if (isDirectRun(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
