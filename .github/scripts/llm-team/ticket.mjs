#!/usr/bin/env node
// ─────────────────── llm-team 票流程（run / publish / summary） ───────────────────
// 用法：
//   run:     node .github/scripts/llm-team/ticket.mjs run --name <n> --brief <file> --branch <prefix/name> --allow <path>… --test "<cmd>" [--tier standard|block] [--base main]
//   publish: node .github/scripts/llm-team/ticket.mjs publish --name <n> [--title "<t>"]
//   summary: node .github/scripts/llm-team/ticket.mjs summary --name <n>
//
// 🔴 2026-09-13 三方共識：
//   · P5：ticket 預設停在「已複審的 worktree＋收貨摘要」；ticket publish 才 commit、push、開 draft PR；永不自動 merge。
//   · P4：G1–G6 是寫手 wrapper 的自我約束，不是 repo 的門；門仍是 GitHub ruleset＋PR review。
//   · 統整者（Claude）一張票只花兩個回合：一回合 ticket 起跑，一回合收貨。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  loadConfig,
  modelsFrom,
  git,
  changedFiles,
  parseArgs,
  CLEAN_GIT_ENV,
  isSafeCommand,
} from './lib.mjs'
import { main as writeMain } from './write.mjs'
import { main as councilMain, parseVerdicts } from './council.mjs'

const VALID_BRANCH_PREFIXES = ['spec/', 'feat/', 'fix/', 'chore/', 'archive/', 'governance/']

function runTest(cmd, cwd) {
  const env = { ...CLEAN_GIT_ENV }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { exit: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function formatReviewerSummary(m) {
  const lines = []
  const overall = m.empty ? '🔴 零輸出' : m.overall || '?'
  lines.push(`[${m.name} (${m.model})] 整份: ${overall}`)
  if (m.empty) return lines

  const textLines = (m.text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  for (const [qn, verdict] of Object.entries(m.q || {})) {
    if (verdict === '不簽') {
      const matchLine = textLines.find((l) => l.startsWith(qn) || l.includes(qn))
      const reason = matchLine ? matchLine.slice(0, 200) : '不簽'
      lines.push(`  - ${qn} (不簽): ${reason}`)
    }
  }

  const q6Line = textLines.find((l) => /^Q6[：:]/.test(l))
  if (q6Line) {
    lines.push(`  - Q6: ${q6Line.replace(/^Q6[：:]\s*/, '').slice(0, 200)}`)
  }
  return lines
}

function buildReceiptSummaryLines(summary, reviewMembers, summaryPath) {
  const lines = [
    `=== 收貨摘要：${summary.ticket} (${summary.branch}) ===`,
    `改動檔: ${summary.changed.join(', ') || '(無)'}`,
    `write exit: ${summary.writeExit} (共 ${summary.rounds} 輪) | verify exit: ${summary.verifyExit !== null ? summary.verifyExit : '-'}`,
  ]

  if (summary.tierEscalatedBy && summary.tierEscalatedBy.length > 0) {
    lines.push(`tierEscalatedBy: ${summary.tierEscalatedBy.join(', ')}`)
  }

  if (summary.review?.exit !== undefined && summary.review?.exit !== null) {
    lines.push(`🔴 council exit=${summary.review.exit}`)
  }

  for (const m of reviewMembers) {
    lines.push(...formatReviewerSummary(m))
  }

  lines.push(`summary.json: ${summaryPath}`)
  return lines
}

export function main(argv, deps = {}) {
  const [sub, ...rest] = argv
  if (!sub || !['run', 'publish', 'summary'].includes(sub)) {
    console.error('用法：node ticket.mjs run|publish|summary ...')
    return 2
  }

  const gitFn = deps.git || git
  let repoRoot
  try {
    repoRoot = deps.repoRoot || path.resolve(gitFn(process.cwd(), ['rev-parse', '--show-toplevel']))
  } catch (e) {
    console.error(`🔴 無法取得 repoRoot：${e.message}`)
    return 2
  }

  const loadCfg = deps.loadConfig || loadConfig
  let config
  try {
    config = deps.config || loadCfg(repoRoot)
  } catch (e) {
    console.error(`🔴 config 載入失敗：${e.message}`)
    return 2
  }

  const changedFilesFn = deps.changedFiles || changedFiles
  const testFn = deps.runTest || runTest
  const spawnFn = deps.spawn || spawnSync
  const isSafeCommandFn = deps.isSafeCommand || isSafeCommand

  if (sub === 'run') {
    const a = parseArgs(rest, ['allow'])
    if (!a.name || !a.brief || !a.branch || !a.allow || a.allow.length === 0 || !a.test) {
      console.error(
        '用法：run --name <n> --brief <file> --branch <prefix/name> --allow <path>… --test "<cmd>" [--tier standard|block] [--base main]'
      )
      return 2
    }

    if (a.tier !== undefined && a.tier !== 'standard' && a.tier !== 'block') {
      console.error(
        '用法：run --name <n> --brief <file> --branch <prefix/name> --allow <path>… --test "<cmd>" [--tier standard|block] [--base main]'
      )
      return 2
    }

    if (!VALID_BRANCH_PREFIXES.some((p) => a.branch.startsWith(p))) {
      console.error(
        `🔴 分支名 '${a.branch}' 不合法，必須以前綴之一開頭：${VALID_BRANCH_PREFIXES.join(' ')}`
      )
      return 2
    }

    if (!isSafeCommandFn(a.test, config)) {
      console.error(
        `🔴 --test 不在寫手的 allow 內，寫手最後一步會被拒而整輪靜默中止：${a.test}`
      )
      console.error(
        '把指令頭加進 .github/scripts/llm-team/config.json 的 allowCommandHeads，或改用 node --test／node --check'
      )
      return 2
    }

    const startedAt = new Date().toISOString()
    const base = a.base || 'main'
    let tier = a.tier || 'standard'
    const worktreeRoot = config.worktreeRoot || '.claude/worktrees'
    const worktree = path.resolve(repoRoot, worktreeRoot, a.name)
    const outBaseDir = config.outDir || '.local/llm-team'
    const outDir = path.resolve(repoRoot, outBaseDir, a.name)
    const writeOutDir = path.join(outDir, 'write')
    const reviewOutDir = path.join(outDir, 'review')

    // a. worktree 管理
    if (fs.existsSync(worktree)) {
      let curBranch
      try {
        curBranch = gitFn(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])
      } catch (e) {
        console.error(`🔴 檢查 worktree 分支失敗：${e.message}`)
        return 2
      }
      if (curBranch !== a.branch) {
        console.error(`🔴 worktree 已存在但分支不一致：現為 ${curBranch}，預期 ${a.branch}`)
        return 2
      }
      const dirty = changedFilesFn(worktree).filter((f) => !f.startsWith('.agy-write/'))
      if (dirty.length > 0) {
        console.error(`🔴 worktree 已存在但不乾淨，先處理：\n  ${dirty.join('\n  ')}`)
        return 2
      }
    } else {
      fs.mkdirSync(path.dirname(worktree), { recursive: true })
      try {
        gitFn(repoRoot, ['worktree', 'add', worktree, '-b', a.branch, base])
      } catch (e) {
        console.error(`🔴 git worktree add 失敗：${e.message}`)
        return 2
      }
    }

    // 保存 brief 全文備份供 publish 與 PR body 使用
    fs.mkdirSync(outDir, { recursive: true })
    const briefContent = fs.readFileSync(path.resolve(a.brief), 'utf8')
    fs.writeFileSync(path.join(outDir, 'brief.md'), briefContent)

    // riskDomains 升級複審（tier => block，不直接判罪）
    const riskDomains = Array.from(
      new Set((Array.isArray(config.riskDomains) ? config.riskDomains : []).filter(Boolean))
    )
    const briefLower = briefContent.toLowerCase()
    const allowLower = (a.allow || []).map((al) => String(al).toLowerCase())
    const matchedRiskDomains = []
    for (const rd of riskDomains) {
      const rdLower = String(rd).toLowerCase()
      if (!rdLower) continue
      const hitBrief = briefLower.includes(rdLower)
      const hitAllow = allowLower.some((al) => al.includes(rdLower))
      if (hitBrief || hitAllow) {
        matchedRiskDomains.push(rd)
      }
    }

    let tierEscalatedBy = null
    if (tier !== 'block' && matchedRiskDomains.length > 0) {
      tier = 'block'
      tierEscalatedBy = matchedRiskDomains
    }

    // b. 呼叫 write.main
    const writeMainFn = deps.writeMain || writeMain
    const writeArgs = [
      '--worktree',
      worktree,
      '--brief',
      path.resolve(a.brief),
      ...a.allow.flatMap((al) => ['--allow', al]),
      '--out',
      writeOutDir,
      '--test',
      a.test,
    ]
    if (a.model) writeArgs.push('--model', a.model)

    const writeExit = writeMainFn(writeArgs, deps)

    // c. write 回 2 ⇒ 直接 exit 2 不複審
    if (writeExit === 2) {
      console.error('🔴 write 失敗（exit 2），直接退出不複審。')
      return 2
    }

    // 只要 worktree 有改動就跑 --test 一次再複審
    const changed = changedFilesFn(worktree).filter((f) => !f.startsWith('.agy-write/'))
    let verifyExit = null
    let councilExit = null

    if (changed.length > 0) {
      const t = testFn(a.test, worktree)
      verifyExit = t.exit

      fs.rmSync(reviewOutDir, { recursive: true, force: true })
      fs.mkdirSync(reviewOutDir, { recursive: true })

      const councilMainFn = deps.councilMain || councilMain
      const councilArgs = [
        'review',
        '--worktree',
        worktree,
        '--base',
        base,
        '--brief',
        path.resolve(a.brief),
        '--out',
        reviewOutDir,
        '--tier',
        tier,
      ]
      councilExit = councilMainFn(councilArgs, deps)
    }

    // 收集複審成員結果
    const models = modelsFrom(config)
    const defaultNames = ['opus', 'gemini']
    const expectedReviewers = (models.planners || []).map((m, i) => ({
      name: defaultNames[i] || `reviewer-${i + 1}`,
      model: m,
    }))
    if (tier === 'block') {
      expectedReviewers.push({ name: 'codex', model: models.codex })
    }

    const reviewMembers = []
    let anyEmpty = false

    if (changed.length > 0) {
      for (const rev of expectedReviewers) {
        const txtFile = path.join(reviewOutDir, `${rev.name}.txt`)
        let text = ''
        if (fs.existsSync(txtFile)) {
          text = fs.readFileSync(txtFile, 'utf8')
        }
        const empty = !text.trim()
        if (empty) anyEmpty = true
        const v = parseVerdicts(text)
        reviewMembers.push({
          name: rev.name,
          model: rev.model,
          overall: v.overall,
          q: v.q,
          empty,
          text,
        })
      }
      if (councilExit === 3) anyEmpty = true
    }

    // 計算 rounds
    let rounds = 1
    if (fs.existsSync(writeOutDir)) {
      const roundFiles = fs
        .readdirSync(writeOutDir)
        .filter((f) => /^round-\d+\.stdout\.ndjson$/.test(f))
      if (roundFiles.length > 0) rounds = roundFiles.length
    }

    // d. 寫 summary.json
    const reviewObj = {
      tier,
      members: reviewMembers.map(({ name, model, overall, q }) => ({ name, model, overall, q })),
      anyEmpty,
    }
    if (councilExit !== null && councilExit !== 0 && councilExit !== 3) {
      reviewObj.exit = councilExit
    }

    const summary = {
      schemaVersion: 1,
      project: path.basename(repoRoot),
      ticket: a.name,
      branch: a.branch,
      base,
      writeExit,
      rounds,
      changed,
      verifyExit,
      ...(tierEscalatedBy ? { tierEscalatedBy } : {}),
      review: reviewObj,
      coordinatorTurns: null,
      startedAt,
      finishedAt: new Date().toISOString(),
    }

    const summaryPath = path.join(outDir, 'summary.json')
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    // e. stdout 只印一張收貨摘要（≤ 25 行）
    const receiptLines = buildReceiptSummaryLines(summary, reviewMembers, summaryPath)
    console.log(receiptLines.join('\n'))

    if (councilExit !== null && councilExit !== 0 && councilExit !== 3) return councilExit
    if (anyEmpty) return 3
    return 0
  }

  if (sub === 'publish') {
    const a = parseArgs(rest)
    if (!a.name) {
      console.error('用法：publish --name <n> [--title "<t>"]')
      return 2
    }

    const worktreeRoot = config.worktreeRoot || '.claude/worktrees'
    const worktree = path.resolve(repoRoot, worktreeRoot, a.name)
    const outBaseDir = config.outDir || '.local/llm-team'
    const outDir = path.resolve(repoRoot, outBaseDir, a.name)
    const summaryPath = path.join(outDir, 'summary.json')

    if (!fs.existsSync(summaryPath)) {
      console.error(`🔴 summary.json 不存在：${summaryPath}`)
      return 2
    }

    let summary
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    } catch (e) {
      console.error(`🔴 summary.json 解析失敗：${e.message}`)
      return 2
    }

    const relOutDir = path.relative(worktree, outDir)
    const isOutDirInside = !relOutDir.startsWith('..') && !path.isAbsolute(relOutDir)
    const outDirPrefix = isOutDirInside ? (relOutDir.endsWith('/') ? relOutDir : relOutDir + '/') : null

    const isIgnored = (f) => {
      if (f === '.agy-write' || f.startsWith('.agy-write/')) return true
      if (outDirPrefix && (f === relOutDir || f.startsWith(outDirPrefix))) return true
      if (outBaseDir && (f === outBaseDir || f.startsWith(outBaseDir + '/'))) return true
      return false
    }

    const currentFiles = changedFilesFn(worktree).filter((f) => !isIgnored(f))
    if (currentFiles.length === 0) {
      console.error(`🔴 worktree 無任何改動：${worktree}`)
      return 2
    }

    const summaryChanged = Array.isArray(summary.changed) ? summary.changed : []
    const summaryChangedSet = new Set(summaryChanged)
    const unexpected = currentFiles.filter((f) => !summaryChangedSet.has(f))
    if (unexpected.length > 0) {
      console.error(`🔴 publish：worktree 有 run 之後才出現的檔，不准夾帶：${unexpected.join(', ')}`)
      return 2
    }

    let title = a.title
    const briefPath = path.join(outDir, 'brief.md')
    let briefContent = ''
    if (fs.existsSync(briefPath)) {
      briefContent = fs.readFileSync(briefPath, 'utf8')
    }

    if (!title) {
      const firstLine = briefContent
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('<!--'))
      title = firstLine ? firstLine.replace(/^#+\s*/, '').trim() : `feat: ${a.name}`
    }

    // git add -- <summary.changed 逐一>
    gitFn(worktree, ['add', '--', ...summaryChanged])
    // git commit
    gitFn(worktree, ['commit', '-m', title])
    // git push
    gitFn(worktree, ['push', '-u', 'origin', summary.branch])

    // 組 pr-body.md
    const reviewOutDir = path.join(outDir, 'review')
    const reviewMembers = (summary.review?.members || []).map((m) => {
      const txtFile = path.join(reviewOutDir, `${m.name}.txt`)
      const text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8') : ''
      return { ...m, text }
    })
    const receiptLines = buildReceiptSummaryLines(summary, reviewMembers, summaryPath)

    const prBody = [
      briefContent || '# Brief',
      '',
      '## 複審摘要',
      '```',
      receiptLines.join('\n'),
      '```',
      '',
      '## summary.json',
      '```json',
      JSON.stringify(summary, null, 2),
      '```',
      '',
    ].join('\n')

    const prBodyPath = path.join(outDir, 'pr-body.md')
    fs.writeFileSync(prBodyPath, prBody)

    // 檢查 gh CLI
    const ghCheck = spawnFn('gh', ['--version'], { encoding: 'utf8' })
    if (ghCheck.status !== 0 || ghCheck.error) {
      console.log(`✓ 已成功 push 至 origin/${summary.branch}`)
      console.log(`🟡 找不到 gh CLI，請手動建立 PR：`)
      console.log(`gh pr create --draft --title "${title}" --body-file "${prBodyPath}"`)
      return 0
    }

    const prRes = spawnFn(
      'gh',
      ['pr', 'create', '--draft', '--title', title, '--body-file', prBodyPath],
      { cwd: worktree, encoding: 'utf8', env: CLEAN_GIT_ENV }
    )

    if (prRes.status !== 0) {
      console.error(`🔴 gh pr create 失敗：${(prRes.stderr || prRes.stdout || '').trim()}`)
      return prRes.status || 1
    }

    console.log((prRes.stdout || '').trim())
    return 0
  }

  if (sub === 'summary') {
    const a = parseArgs(rest)
    if (!a.name) {
      console.error('用法：summary --name <n>')
      return 2
    }

    const outBaseDir = config.outDir || '.local/llm-team'
    const outDir = path.resolve(repoRoot, outBaseDir, a.name)
    const summaryPath = path.join(outDir, 'summary.json')
    if (!fs.existsSync(summaryPath)) {
      console.error(`🔴 summary.json 不存在：${summaryPath}`)
      return 2
    }

    let summary
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    } catch (e) {
      console.error(`🔴 summary.json 解析失敗：${e.message}`)
      return 2
    }

    const reviewOutDir = path.join(outDir, 'review')
    const reviewMembers = (summary.review?.members || []).map((m) => {
      const txtFile = path.join(reviewOutDir, `${m.name}.txt`)
      const text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8') : ''
      return { ...m, text }
    })

    const receiptLines = buildReceiptSummaryLines(summary, reviewMembers, summaryPath)
    console.log(receiptLines.join('\n'))
    return 0
  }

  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
