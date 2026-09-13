#!/usr/bin/env node
// ─────────────────── llm-team 票流程（run / publish / summary） ───────────────────
// 用法：
//   run:     node .agents/skills/llm-team/ticket.mjs run --name <n> --brief <file> --branch <prefix/name> --allow <path>… --test "<cmd>" [--tier standard|block] [--base main] [--config <file>]
//   publish: node .agents/skills/llm-team/ticket.mjs publish --name <n> [--title "<t>"] [--config <file>]
//   summary: node .agents/skills/llm-team/ticket.mjs summary --name <n> [--config <file>]
//
// 🔴 2026-09-13 三方共識：
//   · P5：ticket 預設停在「已複審的 worktree＋收貨摘要」；ticket publish 才 commit、push、開 draft PR；永不自動 merge。
//   · P4：G1–G6 是寫手 wrapper 的自我約束，不是 repo 的門；門仍是 GitHub ruleset＋PR review。
//   · 統整者一張票只花兩個回合：一回合 ticket 起跑，一回合收貨。

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
  assertSettingsAllowRegex,
  agySettingsPath,
  isDirectRun,
} from './lib.mjs'
import { main as writeMain } from './write.mjs'
import { main as councilMain, parseVerdicts } from './council.mjs'

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

function appendLifecycle(outDir, entry, env = process.env) {
  const lifecycleFile = path.join(outDir, 'lifecycle.ndjson')
  const base = {
    at: new Date().toISOString(),
    event: entry.event,
    ticket: entry.ticket,
    harness: (env && env.LLM_TEAM_HARNESS) || 'unknown',
    conversationId: (env && env.LLM_TEAM_CONVERSATION_ID) || null,
  }
  const full = { ...base, ...entry }
  fs.mkdirSync(outDir, { recursive: true })
  fs.appendFileSync(lifecycleFile, JSON.stringify(full) + '\n')
}

function buildReceiptSummaryLines(summary, reviewMembers, summaryPath) {
  const harness = summary.harness || 'unknown'
  const q6 = summary.q6Receipt ? '有' : '無'
  const dispCount = Array.isArray(summary.dispositions) ? summary.dispositions.length : 0
  const lines = [
    `=== 收貨摘要：${summary.ticket} (${summary.branch}) ===`,
    `改動檔: ${summary.changed.join(', ') || '(無)'}`,
    `write exit: ${summary.writeExit} (共 ${summary.rounds} 輪) | verify exit: ${summary.verifyExit !== null ? summary.verifyExit : '-'}`,
    `harness: ${harness} | q6Receipt: ${q6} | dispositions: ${dispCount}`,
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
  const env = deps.env || process.env
  const harness = (env && env.LLM_TEAM_HARNESS) || 'unknown'
  const conversationId = (env && env.LLM_TEAM_CONVERSATION_ID) || null
  const parsedAll = parseArgs(argv, ['allow', 'disposition'])
  const sub = parsedAll._[0]
  const rest = argv.slice(argv.indexOf(sub) + 1)
  if (!sub || !['run', 'publish', 'summary', 'accept'].includes(sub)) {
    console.error('用法：node ticket.mjs run|publish|summary|accept ...')
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

  const configFile = parsedAll.config || null
  const loadCfg = deps.loadConfig || loadConfig
  let config
  try {
    config = deps.config || loadCfg(repoRoot, configFile)
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

    const branchPrefixes = config.branchPrefixes
    if (branchPrefixes.length > 0 && !branchPrefixes.some((p) => a.branch.startsWith(p))) {
      console.error(
        `🔴 分支名 '${a.branch}' 不合法，必須以前綴之一開頭：${branchPrefixes.join(' ')}`
      )
      return 2
    }

    // 🔴 B4 閘（2026-09-13 事故：brief 的驗收指令 bash -n／node .github/… 不在 allow ⇒ 寫手最後一步被拒、整輪靜默中止、exit 0）。停止條件：agy 無頭把被拒改成非零 exit 或明確錯誤事件後，這道閘可降為警告。
    if (!isSafeCommandFn(a.test, config)) {
      console.error(
        `🔴 --test 不在寫手的 allow 內，寫手最後一步會被拒而整輪靜默中止：${a.test}`
      )
      console.error(
        '把指令頭加進 repo 根 llm-team.config.json 的 allowCommandHeads，或改用 node --test／node --check'
      )
      return 2
    }

    const briefPath = path.resolve(a.brief)
    if (!fs.existsSync(briefPath)) {
      console.error(`🔴 brief 檔案不存在：${briefPath}`)
      return 2
    }
    const briefContent = fs.readFileSync(briefPath, 'utf8')

    // riskDomains 升級複審（tier => block，不直接判罪）
    const base = a.base || 'main'
    let tier = a.tier || 'standard'
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

    // G2 settings 對帳（搬到 worktree add 之前，避免漂移造成 worktree 殘留）
    // 🔴 2026-09-13 H6 複審坐實：曾寫成「注入 writeMain ⇒ 跳過 G2」，把測試捷徑當契約；G2 只能由 deps.assertSettings 覆寫。陽性對照 ticket.test.mjs「T37 G2 對帳：deps 注入 writeMain 時仍受 G2 約束（assertSettings 拋錯 ⇒ run 回 2 且未建 worktree）」
    const checkSettings = deps.assertSettings || assertSettingsAllowRegex
    try {
      checkSettings(agySettingsPath(env), repoRoot, config)
    } catch (e) {
      console.error(`🔴 G2：${e.message}`)
      return 2
    }

    const startedAt = new Date().toISOString()
    const worktreeRoot = config.worktreeRoot || '.claude/worktrees'
    const worktree = path.resolve(repoRoot, worktreeRoot, a.name)
    const outBaseDir = config.outDir || '.local/llm-team'
    const outDir = path.resolve(repoRoot, outBaseDir, a.name)
    const writeOutDir = path.join(outDir, 'write')
    const reviewOutDir = path.join(outDir, 'review')

    // a. worktree 管理
    let createdWorktree = false
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
        createdWorktree = true
      } catch (e) {
        console.error(`🔴 git worktree add 失敗：${e.message}`)
        return 2
      }
    }

    // 保存 brief 全文備份供 publish 與 PR body 使用
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'brief.md'), briefContent)
    appendLifecycle(outDir, { event: 'run-start', ticket: a.name }, env)

    // b. 呼叫 write.main
    const writeMainFn = deps.writeMain || writeMain
    const writeArgs = [
      '--worktree',
      worktree,
      '--brief',
      briefPath,
      ...a.allow.flatMap((al) => ['--allow', al]),
      '--out',
      writeOutDir,
      '--test',
      a.test,
    ]
    if (a.model) writeArgs.push('--model', a.model)
    if (configFile) writeArgs.push('--config', configFile)

    const writeExit = writeMainFn(writeArgs, deps)
    appendLifecycle(outDir, { event: 'writer-done', ticket: a.name, writeExit }, env)

    // c. write 回 2 ⇒ 若為本次新建且寫手未改動檔，清理殘骸；直接 exit 2 不複審
    if (writeExit === 2) {
      const changed = changedFilesFn(worktree).filter((f) => !f.startsWith('.agy-write/'))
      if (createdWorktree && changed.length === 0) {
        try {
          gitFn(repoRoot, ['worktree', 'remove', worktree])
          gitFn(repoRoot, ['branch', '-d', a.branch])
          console.error(`🧹 已清掉本次建立的 worktree 與分支 ${a.name}`)
        } catch (e) {
          console.error(`⚠️ 清理 worktree 與分支失敗：${e.message}`)
        }
      }
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
      if (configFile) councilArgs.push('--config', configFile)
      councilExit = councilMainFn(councilArgs, deps)
    }

    // 收集複審成員結果
    const models = modelsFrom(config)
    const defaultNames = ['opus', 'gemini']
    const expectedReviewers = (models.planners || []).map((m, i) => ({
      name: defaultNames[i] || `reviewer-${i + 1}`,
      model: m,
    }))
    // codexTier=all 時 codex 出席 standard 票（council.mjs），summary 必須收它——否則它的不簽 publish 看不見。陽性對照「T36 codexTier=all 時 standard 票收 codex 到 summary，codex 不簽則 publish 擋下」
    if (tier === 'block' || config.codexTier === 'all') {
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
      appendLifecycle(outDir, { event: 'review-done', ticket: a.name, anyEmpty }, env)
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
      harness,
      lifecycle: 'lifecycle.ndjson',
      comparable: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    }

    const summaryPath = path.join(outDir, 'summary.json')
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    // e. stdout 只印一張收貨摘要（≤ 25 行）
    const receiptLines = buildReceiptSummaryLines(summary, reviewMembers, summaryPath)
    console.log(receiptLines.join('\n'))

    // 🔴 2026-09-13 事故：寫手第 1 輪被拒（write exit 3、改動 0 檔）run 仍 exit 0 假綠；陽性對照 ticket.test.mjs「T19 writeMain 回 3、changed 空 ⇒ run 回 3（陽性對照：把第 1 點拿掉就回 0）」；停止條件：run 流程改為事件驅動狀態機且能原生傳播子程序 exit code 時重審
    if (writeExit !== 0) return 3
    // 🔴 2026-09-13 事故：模板票 verify 紅（exit 1）run 仍 exit 0 假綠；陽性對照 ticket.test.mjs「T20 changed 非空、runTest 回 exit 1 ⇒ run 回 3」；停止條件：run 流程改為事件驅動狀態機且能原生傳播驗收 exit code 時重審
    if (verifyExit !== null && verifyExit !== 0) return 3
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

    // Fail-closed 檢查
    // 🔴 2026-09-13 事故：寫手失敗（writeExit 非 0）時若帶有髒改動可能被誤開 PR；陽性對照 ticket.test.mjs「T30 publish：summary writeExit:3 ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：summary schema 改版或 publish 改為吃不可篡改之寫手證明時重審
    if (summary.writeExit !== 0) {
      console.error(`🔴 publish：writeExit 為 ${summary.writeExit}（非 0），不得開 PR`)
      return 2
    }

    // 🔴 2026-09-13 事故：verify 失敗（verifyExit 非 0 或 null）被誤開 PR 造成破壞性合入；陽性對照 ticket.test.mjs「T22 publish：summary verifyExit:1 ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：summary schema 改版或 publish 改為驗收憑據強簽名時重審
    if (summary.verifyExit === null || summary.verifyExit !== 0) {
      console.error(`🔴 publish：verifyExit 為 ${summary.verifyExit}（未通過驗收），不得開 PR`)
      return 2
    }

    // 🔴 2026-09-13 事故：複審成員被 headless 權限靜默拒絕零輸出（anyEmpty）仍被誤判通過；陽性對照 ticket.test.mjs「T23 publish：summary anyEmpty:true ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：summary schema 改版或 council 輸出改為嚴格 schema 驗證不可為空時重審
    if (summary.review?.anyEmpty === true) {
      console.error('🔴 publish：複審有成員零輸出（anyEmpty === true），不得開 PR')
      return 2
    }

    // 🔴 2026-09-13 事故：複審成員少於 2 位不足法定人數（quorum 崩潰）被單方開 PR；陽性對照 ticket.test.mjs「T31 publish：summary review.members 少於 2 位 ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：summary schema 改版或三方仲裁協議改版時重審
    const reviewMembersList = summary.review?.members || []
    if (!Array.isArray(reviewMembersList) || reviewMembersList.length < 2) {
      console.error(`🔴 publish：複審成員少於 2 位（${reviewMembersList.length} 位），不得開 PR`)
      return 2
    }

    // 🔴 2026-09-13 事故：複審成員不簽卻因 disposition 遺漏或比對漏洞被直接放行開 PR；陽性對照 ticket.test.mjs「T33 publish：整份不簽無逐題時給 q:Q3 仍回 2，給 q:overall 且 accept 寫入後 publish 通過」；停止條件：summary schema 改版或引入去中心化裁決合約時重審
    const dispositions = Array.isArray(summary.dispositions) ? summary.dispositions : []
    for (const m of reviewMembersList) {
      if (m.overall !== '簽') {
        const unsignedQs = Object.entries(m.q || {}).filter(([_, verdict]) => verdict === '不簽').map(([qn]) => qn)
        if (unsignedQs.length === 0) {
          const hasDisp = dispositions.some(
            (d) =>
              d.member === m.name &&
              d.q === 'overall' &&
              ['rejected', 'confirmed-fixed'].includes(d.disposition) &&
              d.note &&
              d.by
          )
          if (!hasDisp) {
            console.error(`🔴 publish：複審成員 ${m.name} 整份不簽且未處置，不得開 PR`)
            return 2
          }
        } else {
          for (const qn of unsignedQs) {
            const hasDisp = dispositions.some(
              (d) =>
                d.member === m.name &&
                d.q === qn &&
                ['rejected', 'confirmed-fixed'].includes(d.disposition) &&
                d.note &&
                d.by
            )
            if (!hasDisp) {
              console.error(`🔴 publish：複審成員 ${m.name} 之 ${qn} 不簽且未處置，不得開 PR`)
              return 2
            }
          }
        }
      }
    }

    // 🔴 2026-09-13 事故：統整者未親自坐實審查意見（缺少 q6Receipt）即盲目開 PR；陽性對照 ticket.test.mjs「T26 publish：沒 q6Receipt ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：summary schema 改版或 Q6 查核改為強制雙人簽章時重審
    if (!summary.q6Receipt || !String(summary.q6Receipt).trim()) {
      console.error('🔴 publish：缺少 q6Receipt（統整者親自坐實 Q6 的證據），不得開 PR')
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

    const prUrl = (prRes.stdout || '').trim()
    appendLifecycle(outDir, { event: 'published', ticket: a.name, prUrl, url: prUrl }, env)
    console.log(prUrl)
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

  if (sub === 'accept') {
    const a = parseArgs(rest, ['disposition'])
    if (!a.name) {
      console.error('用法：accept --name <n> --q6 "<receipt>" [--disposition <member>:<Qn|overall>=<rejected|confirmed-fixed>:"<note>"]...')
      return 2
    }
    if (!a.q6 || !String(a.q6).trim()) {
      console.error('🔴 accept：--q6 必填且不可為空')
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

    const now = new Date().toISOString()
    const rawDispositions = Array.isArray(a.disposition)
      ? a.disposition
      : a.disposition
      ? [a.disposition]
      : []

    const newDispositions = []
    for (const raw of rawDispositions) {
      const eqIdx = raw.indexOf('=')
      if (eqIdx === -1) {
        console.error(`🔴 disposition 格式不合法（缺少 =）：${raw}`)
        return 2
      }
      const left = raw.slice(0, eqIdx).trim()
      const right = raw.slice(eqIdx + 1).trim()
      const colonMemberQ = left.indexOf(':')
      if (colonMemberQ === -1) {
        console.error(`🔴 disposition 格式不合法（缺少 member:Qn 或 member:overall）：${raw}`)
        return 2
      }
      const member = left.slice(0, colonMemberQ).trim()
      const q = left.slice(colonMemberQ + 1).trim()

      const colonDispNote = right.indexOf(':')
      const disposition = (colonDispNote === -1 ? right : right.slice(0, colonDispNote)).trim()
      let note = (colonDispNote === -1 ? '' : right.slice(colonDispNote + 1)).trim()
      if ((note.startsWith('"') && note.endsWith('"')) || (note.startsWith("'") && note.endsWith("'"))) {
        note = note.slice(1, -1)
      }

      if (!member || !q || !['rejected', 'confirmed-fixed'].includes(disposition)) {
        console.error(`🔴 disposition 格式不合法（disposition 必須為 rejected 或 confirmed-fixed）：${raw}`)
        return 2
      }
      newDispositions.push({
        member,
        q,
        disposition,
        note,
        by: 'coordinator',
        at: now,
      })
    }

    const existingDispositions = Array.isArray(summary.dispositions) ? summary.dispositions : []
    const dispMap = new Map()
    for (const d of existingDispositions) {
      dispMap.set(`${d.member}:${d.q}`, d)
    }
    for (const d of newDispositions) {
      dispMap.set(`${d.member}:${d.q}`, d)
    }

    summary.q6Receipt = String(a.q6).trim()
    summary.dispositions = Array.from(dispMap.values())
    summary.acceptedAt = now

    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
    appendLifecycle(outDir, { event: 'accepted', ticket: a.name }, env)

    console.log(`✅ 已裁決 accept：${a.name}（q6Receipt 有，dispositions 共 ${summary.dispositions.length} 筆）`)
    return 0
  }

  return 2
}

if (isDirectRun(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
