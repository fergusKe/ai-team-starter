#!/usr/bin/env node
// ─────────────────── llm-team 唯讀快照導出工具 ───────────────────
// 用法：
//   node .agents/skills/llm-team/export.mjs --to <targetRepoRoot> [--force]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CLEAN_GIT_ENV, parseArgs, isDirectRun } from './lib.mjs'

/**
 * 剝除 `//` 行註解與 `/* ... *\/` 區塊註解，供防回歸 literal check 用（例如「export.mjs 不得含
 * tools/m4-ship.sh 字面」）——事故出處註解可以提到單一專案的舊指令當史料，不該被這類 gate 誤判成
 * 「還在用」；但同一個字面出現在 console.log/console.error/throw 等實際會執行的字串裡，仍要照樣抓到。
 * 🔴 不是完整的 JS 剖析器：只依「整行以 // 開頭（前面只有空白）」與「/* ... *\/ 跨行區塊」剝除；
 *   字串常值裡剛好含 `//` 或 `/*` 的極端情況不處理——這支工具目前的原始碼沒有這種字面。
 *   陽性對照：export.test.mjs「Q5：stripJsComments」。
 */
export function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

export const EXPORT_FILES = [
  'lib.mjs',
  'write.mjs',
  'council.mjs',
  'ticket.mjs',
  'setup.mjs',
  'llm-team.test.mjs',
  'ticket.test.mjs',
  'batch.mjs',
  'batch.test.mjs',
  'usage.mjs',
  'usage.test.mjs',
  'export.mjs',
  'export.test.mjs',
  'agy-pretooluse.sh',
  'agy-pretooluse.test.mjs',
  'codex-pretooluse.sh',
  'codex-pretooluse.test.mjs',
  'SKILL.md',
  'test.sh',
  'VERSION',
  'config.json',
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
      let reqStat
      try {
        reqStat = fs.lstatSync(fullPath)
      } catch {
        reqStat = null
      }
      if (reqStat) {
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

  // 🔴 事故：2026-09-14 GuildHub-frontend 快照複審第 2 輪 codex Q2 指出 manifest 內檔案被同內容 symlink 取代會被 readFileSync 跟隨放行；陽性對照：export.test.mjs「manifest 檔被換成同內容 symlink ⇒ ok 為 false 且 changed 含該檔」；停止條件：快照改成單一 tar／簽章檔那天拆掉。
  for (const [relPath, expectedHash] of manifestEntries.entries()) {
    if (!manifestRequired.includes(relPath)) {
      if (!extra.includes(relPath)) {
        extra.push(relPath)
      }
    }
    const fullPath = path.join(snapshotDir, relPath)
    let stat
    try {
      stat = fs.lstatSync(fullPath)
    } catch {
      stat = null
    }
    if (!stat) {
      missing.push(relPath)
    } else if (!stat.isFile()) {
      changed.push(relPath)
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

  // 🔴 事故：2026-09-13 GuildHub-frontend 快照複審 codex 指出 .json／無副檔名檔靜默放行；2026-09-14 第 2 輪 codex Q2 指出 symlink／特殊檔靜默略過未計入 extra；陽性對照：export.test.mjs「乾淨快照 + x.json ⇒ extra 含 x.json 且 --sync-check exit 1」、「乾淨快照 + 無副檔名檔 stray ⇒ extra 含 stray 且 --sync-check exit 1」、「乾淨快照 + symlink ⇒ extra 含它 且 --sync-check exit 1」；停止條件：快照改成單一 tar／簽章檔那天拆掉。
  function scan(dir) {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(full)
      } else {
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

/**
 * 依 targets.json 對所有專案 repo 匯出快照＋各自 commit
 */
export function exportAll(sourceDir, targets, { force = false, deps = {}, git, spawn } = {}) {
  const targetList = Array.isArray(targets) ? targets : (targets?.targets || [])
  const effectiveDeps = { ...deps }
  if (git) effectiveDeps.git = effectiveDeps.git || git

  const versionPath = path.join(sourceDir, 'VERSION')
  const version = fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : '1'

  let sourceCommit = ''
  if (effectiveDeps.git) {
    try {
      sourceCommit = effectiveDeps.git(['rev-parse', 'HEAD'], sourceDir)
    } catch {}
  }
  if (!sourceCommit) {
    const rCommit = spawnSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
    if (rCommit.status === 0) {
      sourceCommit = (rCommit.stdout || '').trim()
    }
  }

  const completed = []

  for (const target of targetList) {
    const { name, root, mode } = target

    // (a) root 不存在 ⇒ console.error('⏭ <name>：目錄不存在（不是這台機器），跳過')，繼續下一個
    if (!fs.existsSync(root)) {
      console.error(`⏭ ${name}：目錄不存在（不是這台機器），跳過`)
      continue
    }

    // (b) git status --porcelain 非空 ⇒ 🔴 印 `<name> 工作樹不乾淨` 並 return 3，停止後續 target
    const rStatus = spawnSync('git', ['status', '--porcelain'], { cwd: root, env: CLEAN_GIT_ENV, encoding: 'utf8' })
    if ((rStatus.stdout || '').trim().length > 0) {
      console.error(`🔴 ${name} 工作樹不乾淨`)
      const doneStr = completed.map((c) => c.name).join('、') || '(無)'
      console.error(`已完成的 target：${doneStr}；停在：${name}`)
      return 3
    }

    // (c) mode==='branch'：git switch -c chore/llm-team-<VERSION>（分支已存在 ⇒ 🔴 停）；mode==='main'：git branch --show-current 必須是 main（不是 ⇒ 🔴 停）
    const branchName = `chore/llm-team-${version}`
    if (mode === 'branch') {
      const rCheckBranch = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], { cwd: root, env: CLEAN_GIT_ENV, encoding: 'utf8' })
      if (rCheckBranch.status === 0) {
        console.error(`🔴 ${name} 分支已存在：${branchName}`)
        const doneStr = completed.map((c) => c.name).join('、') || '(無)'
        console.error(`已完成的 target：${doneStr}；停在：${name}`)
        return 3
      }
      const rSwitch = spawnSync('git', ['switch', '-c', branchName], { cwd: root, env: CLEAN_GIT_ENV, encoding: 'utf8' })
      if (rSwitch.status !== 0) {
        console.error(`🔴 ${name} 切換分支失敗：${(rSwitch.stderr || rSwitch.stdout || '').trim()}`)
        const doneStr = completed.map((c) => c.name).join('、') || '(無)'
        console.error(`已完成的 target：${doneStr}；停在：${name}`)
        return 3
      }
    } else if (mode === 'main') {
      const rBranch = spawnSync('git', ['branch', '--show-current'], { cwd: root, env: CLEAN_GIT_ENV, encoding: 'utf8' })
      const currBranch = (rBranch.stdout || '').trim()
      if (currBranch !== 'main') {
        console.error(`🔴 ${name} 當前分支不是 main（目前在 ${currBranch || 'detached HEAD'}）`)
        const doneStr = completed.map((c) => c.name).join('、') || '(無)'
        console.error(`已完成的 target：${doneStr}；停在：${name}`)
        return 3
      }
    }

    // (d) exportTo(sourceDir, root, {force:true})；接著 node <root>/.agents/skills/llm-team/setup.mjs --sync-check；接著 bash <root>/.agents/skills/llm-team/test.sh
    const expRes = exportTo(sourceDir, root, { force: true, deps: effectiveDeps })
    if (!expRes.ok) {
      console.error(`🔴 ${name} exportTo 失敗`)
      const doneStr = completed.map((c) => c.name).join('、') || '(無)'
      console.error(`已完成的 target：${doneStr}；停在：${name}`)
      return 3
    }

    let syncCode
    if (effectiveDeps.runSyncCheck) {
      syncCode = effectiveDeps.runSyncCheck(root)
    } else {
      const setupScript = path.join(root, '.agents', 'skills', 'llm-team', 'setup.mjs')
      const rSync = spawnSync(process.execPath, [setupScript, '--sync-check'], { cwd: root, env: CLEAN_GIT_ENV, encoding: 'utf8' })
      syncCode = rSync.status
    }
    if (syncCode !== 0) {
      console.error(`🔴 ${name} setup.mjs --sync-check 失敗（exit ${syncCode}）`)
      const doneStr = completed.map((c) => c.name).join('、') || '(無)'
      console.error(`已完成的 target：${doneStr}；停在：${name}`)
      return 3
    }

    let testCode
    if (effectiveDeps.runSnapshotTests) {
      testCode = effectiveDeps.runSnapshotTests(root)
    } else {
      const testScript = path.join(root, '.agents', 'skills', 'llm-team', 'test.sh')
      const rTest = spawnSync('bash', [testScript], { cwd: root, env: CLEAN_GIT_ENV, encoding: 'utf8' })
      testCode = rTest.status
    }
    if (testCode !== 0) {
      console.error(`🔴 ${name} 快照 test.sh 失敗（exit ${testCode}）`)
      const doneStr = completed.map((c) => c.name).join('、') || '(無)'
      console.error(`已完成的 target：${doneStr}；停在：${name}`)
      return 3
    }

    // (d′) postExport：快照 test.sh 綠之後、git add 之前跑 target 專案自己維護的守門入口
    // 事故：1.7.0 快照進 WAS d019b3627 時 --all 全綠、M4 完整 guards 才紅（git-env-hygiene 台帳），補票 f21cb3652 才過——快照自己的 test.sh 量不到 target 守門怎麼看它，所以這裡跑 target 自己的入口。
    const postExport = Array.isArray(target.postExport) ? target.postExport : null
    if (postExport && postExport.length > 0) {
      if (postExport.some((x) => typeof x !== 'string')) {
        console.error(`🔴 ${name} postExport 必須是字串陣列`)
        const doneStr = completed.map((c) => c.name).join('、') || '(無)'
        console.error(`已完成的 target：${doneStr}；停在：${name}`)
        return 3
      }

      console.log(`▶ ${name} postExport：${postExport.join(' ')}`)

      let postCode = 0
      let postErrMsg = ''
      if (effectiveDeps.runPostExport) {
        const res = effectiveDeps.runPostExport(root, postExport)
        if (typeof res === 'number') {
          postCode = res
        } else if (res && typeof res === 'object' && typeof res.status === 'number') {
          postCode = res.status
          if (res.error?.message) postErrMsg = res.error.message
        } else {
          postCode = null
          postErrMsg = 'runPostExport 回傳值不是數字'
        }
      } else {
        const rPost = spawnSync(postExport[0], postExport.slice(1), {
          cwd: root,
          env: CLEAN_GIT_ENV,
          encoding: 'utf8',
          stdio: 'inherit',
        })
        if (rPost.status === null || rPost.status === undefined) {
          postCode = null
          postErrMsg = rPost.error?.message || ''
        } else {
          postCode = rPost.status
          if (rPost.error?.message) {
            postErrMsg = rPost.error.message
          }
        }
      }

      if (postCode !== 0) {
        const exitInfo = postErrMsg ? `${postCode ?? 'null'}: ${postErrMsg}` : `${postCode ?? 'null'}`
        const branch = mode === 'branch' ? branchName : 'main'
        let restoreHint = `cd ${root} && git restore --staged --worktree .agents/skills/llm-team`
        if (mode === 'branch') {
          restoreHint += ` && git switch main && git branch -d ${branchName}`
        }
        console.error(
          `🔴 ${name} postExport 失敗（exit ${exitInfo}）：快照已寫入、未 commit，留在分支 ${branch} 讓人看 diff；修好後重跑 --all 前先還原：${restoreHint}，未追蹤的新檔以 git status --porcelain .agents/skills/llm-team 列出後手動處理`,
        )
        const doneStr = completed.map((c) => c.name).join('、') || '(無)'
        console.error(`已完成的 target：${doneStr}；停在：${name}`)
        return 3
      }
    }

    // (e) git add .agents/skills/llm-team（第一次匯出放了 llm-team.config.json 範本也一起 add）；git commit -F FILE
    const toAdd = ['.agents/skills/llm-team']
    if (fs.existsSync(path.join(root, 'llm-team.config.json'))) {
      toAdd.push('llm-team.config.json')
    }
    const rAdd = spawnSync('git', ['add', ...toAdd], { cwd: root, env: CLEAN_GIT_ENV, encoding: 'utf8' })
    if (rAdd.status !== 0) {
      console.error(`🔴 ${name} git add 失敗：${(rAdd.stderr || rAdd.stdout || '').trim()}`)
      const doneStr = completed.map((c) => c.name).join('、') || '(無)'
      console.error(`已完成的 target：${doneStr}；停在：${name}`)
      return 3
    }

    const shortSourceCommit = sourceCommit ? sourceCommit.slice(0, 7) : 'unknown'
    const commitMsg = `llm-team ${version} 快照（來源 ${shortSourceCommit}；sync-check 漂移 0；快照 test.sh 綠）\n`
    const msgFile = path.join(os.tmpdir(), `commit-msg-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    fs.writeFileSync(msgFile, commitMsg, 'utf8')
    const rCommit = spawnSync('git', ['commit', '-F', msgFile], { cwd: root, env: CLEAN_GIT_ENV, encoding: 'utf8' })
    try { fs.unlinkSync(msgFile) } catch {}
    if (rCommit.status !== 0) {
      console.error(`🔴 ${name} git commit 失敗：${(rCommit.stderr || rCommit.stdout || '').trim()}`)
      const doneStr = completed.map((c) => c.name).join('、') || '(無)'
      console.error(`已完成的 target：${doneStr}；停在：${name}`)
      return 3
    }

    // (f) 印一行結果：✅ <name> <mode> <branch> <sha>；後續步驟一律讀 target.nextSteps（target 自己的操作事實，
    //    不准在這裡硬寫死任何專案名／指令），沒有就印通則。main 模式維持既有通則文字（多數 main target 不需要 nextSteps）。
    const rSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, env: CLEAN_GIT_ENV, encoding: 'utf8' })
    const sha = (rSha.stdout || '').trim()
    const branch = mode === 'branch' ? branchName : 'main'
    console.log(`✅ ${name} ${mode} ${branch} ${sha}`)
    const nextSteps = typeof target.nextSteps === 'string' && target.nextSteps.trim() ? target.nextSteps.trim() : null
    if (mode === 'branch') {
      console.log(nextSteps ? `→ ${nextSteps}` : '→ 本機分支已 commit，依專案自己的守門流程驗證後再 ff（見 targets.json 的 nextSteps／postExport）')
    } else {
      console.log(nextSteps || '本機 main 已 commit，push 由統整者決定')
    }
    completed.push({ name, mode, branch, sha })
  }

  console.log('\n--- 匯出總表 ---')
  for (const c of completed) {
    console.log(`✅ ${c.name} (${c.mode} ${c.branch} ${c.sha})`)
  }
  return 0
}

export function main(argv, deps = {}) {
  const a = parseArgs(argv)
  const sourceDir = deps.sourceDir || path.dirname(fileURLToPath(import.meta.url))

  if (a.all) {
    const targetsFile = path.resolve(a.targets || path.join(sourceDir, 'targets.json'))
    if (!fs.existsSync(targetsFile)) {
      console.error(`🔴 targets 檔不存在：${targetsFile}`)
      return 2
    }
    let targetsData
    try {
      targetsData = JSON.parse(fs.readFileSync(targetsFile, 'utf8'))
    } catch (e) {
      console.error(`🔴 targets 檔解析失敗：${e.message}`)
      return 2
    }
    const targets = Array.isArray(targetsData) ? targetsData : (targetsData.targets || [])
    return exportAll(sourceDir, targets, { force: Boolean(a.force), deps })
  }

  if (a.to) {
    const targetRoot = path.resolve(a.to)
    const res = exportTo(sourceDir, targetRoot, { force: Boolean(a.force), deps })
    if (!res.ok) {
      return res.status || 2
    }
    return 0
  }

  console.error('用法：\n  node export.mjs --to <targetRepoRoot> [--force]\n  node export.mjs --all [--targets FILE] [--force]')
  return 2
}

if (isDirectRun(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
