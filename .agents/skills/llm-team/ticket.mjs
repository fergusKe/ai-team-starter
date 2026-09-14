#!/usr/bin/env node
// ─────────────────── llm-team 票流程（run / publish / summary） ───────────────────
// 用法：
//   run:     node .agents/skills/llm-team/ticket.mjs run --coordinator <claude|agy|codex> --name <n> --brief <file> --branch <prefix/name> --allow <path>… --test "<cmd>" [--tier standard|block] [--base main] [--config <file>]
//   publish: node .agents/skills/llm-team/ticket.mjs publish --name <n> [--title "<t>"] [--config <file>]
//   summary: node .agents/skills/llm-team/ticket.mjs summary --name <n> [--config <file>]
//
// 🔴 2026-09-14 schema v2：`--coordinator`（或 env LLM_TEAM_COORDINATOR）必帶——複審名單由 config.profiles.<coordinator> 決定
//   （一般票 reviewers、block 票 blockReviewers）；summary.schemaVersion 2 帶 coordinator 與 reviewers（預期名單）。
// 🔴 Q5（2026-09-14 codex 複審）：summary.review.members ＝ council 實際跑的名單（來自 review/members.json、含 harness/model/quotaBucket）；
//   實際 ≠ 預期 ⇒ summary.rosterMismatch: true、run 回 3；publish 比對三元組並回頭讀 members.json，缺檔／不符 ⇒ 擋。
// 🔴 P5（2026-09-14）：任何 writeExit !== 0（含 2）⇒ 不跑 --test、不開 council、仍寫 summary（review = null）（以前 exit 3 會拿半成品去複審、exit 2 沒 summary）。
//
// 🔴 2026-09-13 三方共識：
//   · ticket 預設停在「已複審的 worktree＋收貨摘要」；ticket publish 才 commit、push、開 draft PR；永不自動 merge。
//   · P4：G1–G6 是寫手 wrapper 的自我約束，不是 repo 的門；門仍是 GitHub ruleset＋PR review。
//   · 統整者一張票只花兩個回合：一回合 ticket 起跑，一回合收貨。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  loadConfig,
  modelsFrom,
  memberFileName,
  git,
  changedFiles,
  parseArgs,
  CLEAN_GIT_ENV,
  isSafeCommand,
  assertSettingsAllowRegex,
  agySettingsPath,
  isDirectRun,
  readMembersJson,
  compareRoster,
  rosterLabel,
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
    `write exit: ${summary.writeExit} (共 ${summary.rounds} 輪)${summary.writeTimedOut ? '【寫手逾時】' : ''} | verify exit: ${summary.verifyExit !== null && summary.verifyExit !== undefined ? summary.verifyExit : '-'}`,
    `harness: ${harness} | coordinator: ${summary.coordinator || '-'} | q6Receipt: ${q6} | dispositions: ${dispCount}`,
  ]

  if (summary.review === null) {
    lines.push(
      summary.writeExit !== 0
        ? '🔴 未複審（write 非 0，P5：不跑 --test、不開 council）'
        : '🟡 未複審（寫手沒有改動任何檔）'
    )
  }

  if (summary.tierEscalatedBy && summary.tierEscalatedBy.length > 0) {
    lines.push(`tierEscalatedBy: ${summary.tierEscalatedBy.join(', ')}`)
  }

  if (summary.rosterMismatch === true) {
    const d = summary.rosterDiff || {}
    const missing = (d.missing || []).map(rosterLabel).join(', ') || '(無)'
    const unexpected = (d.unexpected || []).map(rosterLabel).join(', ') || '(無)'
    lines.push(`🔴 rosterMismatch：council 實際名單 ≠ profile 預期名單（缺：${missing}；多：${unexpected}${d.reason ? `；${d.reason}` : ''}）`)
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

export async function main(argv, deps = {}) {
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
    // 🔴 事故：2026-09-13 票 E `--allow a b c` 靜默只收一個；陽性對照：ticket.test.mjs「T38 run 拒絕多餘位置參數：--allow a b ⇒ exit 2 且訊息含 b；--allow a --allow b ⇒ 通過參數檢查」；停止條件：parseArgs 改成宣告式 schema（每個 flag 標 multi）那天拆掉。
    let a
    try {
      a = parseArgs(rest, ['allow'], { strictPositional: true })
    } catch (e) {
      const extraList = (e.positionals || []).join(' ')
      console.error(`🔴 多餘的位置參數（--allow 要每個檔各給一次）：${extraList}`)
      return 2
    }
    if (a._ && a._.length > 0) {
      console.error(`🔴 多餘的位置參數（--allow 要每個檔各給一次）：${a._.join(' ')}`)
      return 2
    }
    const RUN_USAGE =
      '用法：run --coordinator <claude|agy|codex> --name <n> --brief <file> --branch <prefix/name> --allow <path>… --test "<cmd>" [--tier standard|block] [--base main]'
    if (!a.name || !a.brief || !a.branch || !a.allow || a.allow.length === 0 || !a.test) {
      console.error(RUN_USAGE)
      return 2
    }

    if (a.tier !== undefined && a.tier !== 'standard' && a.tier !== 'block') {
      console.error(RUN_USAGE)
      return 2
    }

    // 🔴 --coordinator 必帶（或 env LLM_TEAM_COORDINATOR）：缺或不在 profiles ⇒ exit 2 並列出可用 profiles
    let models
    try {
      models = modelsFrom(config, env, typeof a.coordinator === 'string' ? a.coordinator : null)
    } catch (e) {
      console.error(`🔴 ${e.message}`)
      return 2
    }
    const coordinatorProfile = models.coordinator.profile

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

    // 🔴 P5：write 非 0（含 2＝守門擋下、3＝被拒／越界／逾時）⇒ 不跑 --test、不開 council；以前 exit 3 落到 changed.length > 0 就拿半成品去複審。
    //    陽性對照 ticket.test.mjs「P5 writeMain 回 3 且有改檔 ⇒ councilMain 假函式沒被呼叫、runTest 沒被呼叫、summary.review === null」；
    //    停止條件：run 流程改為事件驅動狀態機時重審。
    const writeFailed = writeExit !== 0
    const timeoutFile = path.join(writeOutDir, 'timeout.json')
    const writeTimedOut = fs.existsSync(timeoutFile)
    // 🔴 changed 一定要在清 worktree 之前量（下面 exit 2 可能把 worktree 移掉）。
    const changed = changedFilesFn(worktree).filter((f) => !f.startsWith('.agy-write/'))

    // c. write 回 2 ⇒ 若為本次新建且寫手未改動檔，清理殘骸。
    //    🔴 2026-09-14 codex 複審 Q2-SUMMARY：以前這裡直接 return 2，exit 2 就沒有 summary.json／收貨摘要，收貨稽核看不到這張票。
    //    現在照樣清殘骸，但仍往下寫 summary（review: null、writeExit: 2、writeTimedOut）並印收貨摘要，最後才回 2。
    //    陽性對照 ticket.test.mjs「Q2 writeMain 回 2 ⇒ summary.json 存在且 review null」。
    if (writeExit === 2) {
      if (createdWorktree && changed.length === 0) {
        try {
          gitFn(repoRoot, ['worktree', 'remove', worktree])
          gitFn(repoRoot, ['branch', '-d', a.branch])
          console.error(`🧹 已清掉本次建立的 worktree 與分支 ${a.name}`)
        } catch (e) {
          console.error(`⚠️ 清理 worktree 與分支失敗：${e.message}`)
        }
      }
      console.error('🔴 write 失敗（exit 2），不複審；仍寫 summary.json 供收貨稽核。')
    }
    let verifyExit = null
    let councilExit = null
    const doReview = !writeFailed && changed.length > 0

    if (doReview) {
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
        '--coordinator',
        coordinatorProfile,
      ]
      if (configFile) councilArgs.push('--config', configFile)
      councilExit = await councilMainFn(councilArgs, deps)
    }

    // 預期名單直接來自 profile（一般票 reviewers、block 票 blockReviewers）。
    // 陽性對照 ticket.test.mjs「T36 block 票收 blockReviewers（含 codex）、standard 票收 reviewers；codex 不簽則 publish 擋下」
    const expectedReviewers = (tier === 'block' ? models.blockReviewers : models.reviewers).map(
      ({ name, harness, model, quotaBucket }) => ({ name, harness, model, quotaBucket })
    )

    // 🔴 實際名單只從 council 寫的 review/members.json 取（codex 複審 Q5-IDENTITY）：不再按預期檔名讀文字、自貼預期身分。
    //    缺檔／格式不合 ⇒ 視為「無法證明誰跑過」⇒ rosterMismatch；三元組多重集合不相等（少一位／多一位／同 name 不同 model）⇒ rosterMismatch ⇒ run 回 3。
    //    陽性對照 ticket.test.mjs「Q5 run：members.json 少一位／多一位／同 name 不同 model ⇒ run 回 3 且 summary.rosterMismatch」
    const reviewMembers = []
    let anyEmpty = false
    let rosterMismatch = false
    let rosterDiff = null

    if (doReview) {
      const membersFile = path.join(reviewOutDir, 'members.json')
      const actual = readMembersJson(membersFile)
      if (!actual) {
        rosterMismatch = true
        rosterDiff = { missing: expectedReviewers, unexpected: [], reason: `缺 council 的 members.json 或格式不合法：${membersFile}` }
      } else {
        for (const m of actual) {
          const txtFile = path.join(reviewOutDir, `${memberFileName(m.name)}.txt`)
          const text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8') : ''
          const v = parseVerdicts(text)
          const empty = m.empty === true || m.timedOut === true || !text.trim()
          if (empty) anyEmpty = true
          reviewMembers.push({
            name: m.name,
            harness: m.harness,
            model: m.model,
            quotaBucket: m.quotaBucket,
            overall: m.overall !== undefined ? m.overall : v.overall,
            q: m.q && typeof m.q === 'object' ? m.q : v.q,
            empty,
            timedOut: m.timedOut === true,
            text,
          })
        }
        const diff = compareRoster(expectedReviewers, actual)
        if (diff.mismatch) {
          rosterMismatch = true
          rosterDiff = { missing: diff.missing, unexpected: diff.unexpected }
        }
      }
      if (councilExit === 3) anyEmpty = true
      appendLifecycle(outDir, { event: 'review-done', ticket: a.name, anyEmpty, rosterMismatch }, env)
    }

    // 計算 rounds
    let rounds = 1
    if (fs.existsSync(writeOutDir)) {
      const roundFiles = fs
        .readdirSync(writeOutDir)
        .filter((f) => /^round-\d+\.stdout\.ndjson$/.test(f))
      if (roundFiles.length > 0) rounds = roundFiles.length
    }

    // d. 寫 summary.json（schemaVersion 2：coordinator＝profile 名、reviewers＝該票的預期名單；write 失敗 ⇒ review: null）
    let reviewObj = null
    if (doReview) {
      reviewObj = {
        tier,
        members: reviewMembers.map(({ name, harness, model, quotaBucket, overall, q, empty, timedOut }) => ({ name, harness, model, quotaBucket, overall, q, empty, timedOut })),
        anyEmpty,
        membersSource: 'review/members.json',
      }
      if (councilExit !== null && councilExit !== 0 && councilExit !== 3) {
        reviewObj.exit = councilExit
      }
    }

    const summary = {
      schemaVersion: 2,
      project: path.basename(repoRoot),
      ticket: a.name,
      branch: a.branch,
      base,
      coordinator: coordinatorProfile,
      reviewers: expectedReviewers,
      writeExit,
      writeTimedOut,
      rounds,
      changed,
      verifyExit,
      ...(tierEscalatedBy ? { tierEscalatedBy } : {}),
      review: reviewObj,
      rosterMismatch,
      ...(rosterDiff ? { rosterDiff } : {}),
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

    // write exit 2（守門擋下、寫手沒起跑）⇒ run 也回 2，與寫手的碼一致（summary 已寫）。
    if (writeExit === 2) return 2
    // 🔴 2026-09-13 事故：寫手第 1 輪被拒（write exit 3、改動 0 檔）run 仍 exit 0 假綠；陽性對照 ticket.test.mjs「T19 writeMain 回 3、changed 空 ⇒ run 回 3（陽性對照：把第 1 點拿掉就回 0）」；停止條件：run 流程改為事件驅動狀態機且能原生傳播子程序 exit code 時重審
    if (writeExit !== 0) return 3
    // 🔴 2026-09-13 事故：模板票 verify 紅（exit 1）run 仍 exit 0 假綠；陽性對照 ticket.test.mjs「T20 changed 非空、runTest 回 exit 1 ⇒ run 回 3」；停止條件：run 流程改為事件驅動狀態機且能原生傳播驗收 exit code 時重審
    if (verifyExit !== null && verifyExit !== 0) return 3
    if (councilExit !== null && councilExit !== 0 && councilExit !== 3) return councilExit
    // 🔴 實際名單 ≠ 預期名單 ⇒ 3（陽性對照 ticket.test.mjs「Q5 run：…⇒ run 回 3」）
    if (rosterMismatch) return 3
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
    // 🔴 2026-09-14 schema v2：舊版 summary（沒有 coordinator／reviewers 名單）不准 publish；陽性對照 ticket.test.mjs「publish：summary schemaVersion 1 ⇒ 2 且 gh 假函式沒被呼叫」
    if (summary.schemaVersion !== 2) {
      console.error(`🔴 publish：summary.schemaVersion 為 ${JSON.stringify(summary.schemaVersion)}（非 2），重跑 ticket run 產新 summary`)
      return 2
    }

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

    // 🔴 2026-09-13 事故：複審成員不足法定人數（quorum 崩潰）被單方開 PR。
    //    2026-09-14 schema v2 改：法定人數＝profile 名單【全員到齊】（summary.reviewers 每一位都在 review.members），且至少 1 位——
    //    v2 一般票名單只有 1 位複審者＋裁決者，硬套「≥ 2」會把每張一般票都擋死。
    //    陽性對照 ticket.test.mjs「T31 publish：review.members 少於 summary.reviewers 名單 ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：三方仲裁協議改版時重審
    const reviewMembersList = summary.review?.members || []
    const roster = Array.isArray(summary.reviewers) ? summary.reviewers : []
    if (!Array.isArray(reviewMembersList) || reviewMembersList.length < 1 || roster.length < 1) {
      console.error(`🔴 publish：複審成員或名單為空（members ${reviewMembersList.length} 位、reviewers 名單 ${roster.length} 位），不得開 PR`)
      return 2
    }
    // 🔴 2026-09-14 codex 複審 Q5-IDENTITY：全員到齊要比【身分三元組】harness+model+quotaBucket（不比 name——同短名模型會冒充），
    //    而且要回頭讀 council 寫的 review/members.json（不只信 summary 自己貼的）：run 已記 rosterMismatch、缺檔、三元組不符 ⇒ 都擋。
    //    陽性對照 ticket.test.mjs「Q5 publish：同 name 不同 model ⇒ 2（只比 name 會放過）；少一位／多一位／缺 members.json／rosterMismatch:true ⇒ 2」
    if (summary.rosterMismatch === true) {
      console.error('🔴 publish：run 已判 rosterMismatch（council 實際名單 ≠ profile 預期名單），不得開 PR')
      return 2
    }
    const membersFile = path.join(outDir, 'review', 'members.json')
    const actualOnDisk = readMembersJson(membersFile)
    if (!actualOnDisk) {
      console.error(`🔴 publish：缺 council 的實際名單（或格式不合法）：${membersFile}，無法證明全員簽署，不得開 PR`)
      return 2
    }
    const fmtDiff = (d) =>
      `缺：${d.missing.map(rosterLabel).join(', ') || '(無)'}；多：${d.unexpected.map(rosterLabel).join(', ') || '(無)'}`
    const diskDiff = compareRoster(roster, actualOnDisk)
    if (diskDiff.mismatch) {
      console.error(`🔴 publish：複審名單未全員到齊（review/members.json 身分三元組 ≠ summary.reviewers），${fmtDiff(diskDiff)}，不得開 PR`)
      return 2
    }
    const summaryDiff = compareRoster(roster, reviewMembersList)
    if (summaryDiff.mismatch) {
      console.error(`🔴 publish：複審名單未全員到齊（summary.review.members 身分三元組 ≠ summary.reviewers），${fmtDiff(summaryDiff)}，不得開 PR`)
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
      const txtFile = path.join(reviewOutDir, `${memberFileName(m.name)}.txt`)
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
      const txtFile = path.join(reviewOutDir, `${memberFileName(m.name)}.txt`)
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

export function runCli(argv, exitFn = process.exit, errFn = console.error, deps = {}) {
  return main(argv, deps)
    .then((code) => {
      exitFn(code)
      return code
    })
    .catch((err) => {
      errFn(err)
      exitFn(1)
      return 1
    })
}

if (isDirectRun(import.meta.url)) {
  runCli(process.argv.slice(2))
}
