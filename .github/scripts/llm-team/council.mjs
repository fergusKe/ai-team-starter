#!/usr/bin/env node
// ─────────────────── 規劃／複審三方會議（agy opus-4-6 ＋ agy Gemini 3.1 Pro ＋ codex sol） ───────────────────
// 用法：
//   規劃：node .github/scripts/llm-team/council.mjs plan   --prompt <file> --out <dir> [--codex]        （預設兩位 agy；--codex 加 sol）
//   複審：node .github/scripts/llm-team/council.mjs review --worktree <abs> --base <sha> --brief <file> --out <dir> --tier standard|block
//
// 🔴 2026-09-13 三方共識：
//   · 一般票：config.models.reviewers（預設 opus ＋ Gemini 3.1 Pro）兩位固定（作者≠審核者；n=2 對照證明互補）。
//   · block 級或指定 --codex：三位全上（加 codex sol）。
//   · codex 扣得快：每票最多 1 輪 ＋ 1 次釐清；超過回統整者。
// 🔴 三位都是【唯讀】：agy `--mode plan`、codex `--sandbox read-only`。它們的回覆不構成授權。
// 🔴 M1 8 GB：三位【依序】跑，不並行。
// 🔴 Gemini／opus 走 agy 無頭：提示以 NO_EXEC_HEADER 開頭（否則它想跑指令 ⇒ 自動拒絕 ⇒ 零輸出）；codex 讀得到檔，不加。

import fs from 'node:fs'
import path from 'node:path'
import {
  loadConfig,
  modelsFrom,
  NO_EXEC_HEADER,
  runAgy,
  runCodex,
  git,
  ledgerAppend,
  parseArgs,
} from './lib.mjs'

export function buildReviewQuestions(riskDomains = []) {
  const tail = '若 diff【新增】了會變紅的閘門：有沒有引用本 repo 真實事故＋可重現的陽性對照＋停止條件？沒有 ⇒ 不簽。'
  const q4 =
    riskDomains && riskDomains.length
      ? `Q4 ${riskDomains.join('／')} 有沒有被碰到？碰到的話是不是 block 級、有沒有對應守門？${tail}`
      : `Q4 ${tail}`

  return [
    '【請逐項判，每題一行「Qn：簽／不簽｜一句理由｜要改什麼」，最後一行「整份：簽／不簽」。不要寫別的。】',
    'Q1 diff 是否只做 brief 要求的事？有沒有 brief 外的改動（順手重構、改到別的檔、改守門）？',
    'Q2 有沒有 fail-open：錯誤被吞、預設放行、空集合恆真的斷言、toBeGreaterThan 這類下界斷言？',
    'Q3 測試量的是不是「這次的變更」？有沒有陽性對照（把修法拿掉會不會紅、紅在哪一條）？',
    q4,
    'Q5 有沒有「作者以為是契約其實是實作細節」的假設（讀了實作當契約）？',
    'Q6 你認為統整者在 merge 前【必須】親自坐實的一件事是什麼？（只准一件）',
  ].join('\n')
}

export function buildReviewPrompt({ brief, diff, tier, diffStat, writerModel = 'gemini-3.8-flash-high', riskDomains = [] }) {
  return [
    `你是本 repo 的複審者（${tier === 'block' ? 'block 級' : '一般票'}）。作者是另一個模型（${writerModel}），你沒有它的對話脈絡，只看下面的 brief 與 diff。`,
    '',
    '【brief（作者拿到的原文）】',
    brief,
    '',
    '【git diff --stat】',
    diffStat,
    '',
    '【git diff（可能截斷）】',
    '```diff',
    diff,
    '```',
    '',
    buildReviewQuestions(riskDomains),
  ].join('\n')
}

function runOne(name, model, prompt, cwd, outDir, timeoutMs) {
  const started = Date.now()
  let r
  if (name === 'codex') r = runCodex({ model, prompt, cwd, timeoutMs })
  else r = runAgy({ model, mode: 'plan', prompt: NO_EXEC_HEADER + prompt, cwd, timeoutMs })
  const text = name === 'codex' ? r.stdout : (r.result && r.result.response) || ''
  fs.writeFileSync(path.join(outDir, `${name}.txt`), text)
  fs.writeFileSync(path.join(outDir, `${name}.stderr.txt`), r.stderr || '')
  const empty = !text.trim()
  return { name, model, exit: r.exit, ms: Date.now() - started, empty, denied: r.denied || [], text }
}

export function parseVerdicts(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const q = {}
  let overall = null
  for (const l of lines) {
    const m = l.match(/^(Q\d+|P\d+)[：:]\s*(簽|不簽)/)
    if (m) q[m[1]] = m[2]
    const o = l.match(/整份[：:]\s*\**\s*(簽|不簽)/)
    if (o) overall = o[1]
  }
  return { q, overall }
}

export function main(argv, deps = {}) {
  const [sub, ...rest] = argv
  const a = parseArgs(rest)
  const outDir = a.out
  if (!sub || !outDir) {
    console.error('用法見檔頭。')
    return 2
  }

  const gitFn = deps.git || git
  const targetDir = a.worktree ? path.resolve(a.worktree) : process.cwd()
  let repoRoot
  let config
  try {
    const commonDir = path.resolve(targetDir, gitFn(targetDir, ['rev-parse', '--git-common-dir']))
    repoRoot = path.dirname(commonDir)
    const loadCfg = deps.loadConfig || loadConfig
    config = loadCfg(repoRoot)
  } catch (e) {
    console.error(`🔴 config 載入失敗：${e.message}`)
    return 2
  }

  fs.mkdirSync(outDir, { recursive: true })
  const run = deps.runOne || runOne
  const timeoutMs = Number(a['timeout-ms'] || 15 * 60 * 1000)
  const models = modelsFrom(config)
  let prompt
  let cwd = process.cwd()
  const defaultNames = ['opus', 'gemini']
  let members = (models.planners || []).map((m, i) => [defaultNames[i] || `reviewer-${i + 1}`, m])

  if (sub === 'plan') {
    if (!a.prompt) return usage()
    prompt = fs.readFileSync(a.prompt, 'utf8')
    if (a.codex) members.push(['codex', models.codex])
  } else if (sub === 'review') {
    if (!a.worktree || !a.base || !a.brief) return usage()
    cwd = path.resolve(a.worktree)
    const tier = a.tier === 'block' ? 'block' : 'standard'
    const diffStat = gitFn(cwd, ['diff', '--stat', a.base])
    let diff = gitFn(cwd, ['diff', a.base])
    const untracked = gitFn(cwd, ['ls-files', '--others', '--exclude-standard'])
    for (const f of untracked.split('\n').filter(Boolean)) {
      if (f.startsWith('.agy-write/')) continue
      diff += `\n--- /dev/null\n+++ b/${f}\n` + fs.readFileSync(path.join(cwd, f), 'utf8').split('\n').map((l) => '+' + l).join('\n')
    }
    const cap = Number(a['diff-cap'] || 120000)
    if (diff.length > cap) diff = diff.slice(0, cap) + `\n…（截斷，原長 ${diff.length} 字元）`
    prompt = buildReviewPrompt({
      brief: fs.readFileSync(a.brief, 'utf8'),
      diff,
      tier,
      diffStat,
      writerModel: models.writer,
      riskDomains: config.riskDomains || [],
    })
    if (tier === 'block' || a.codex) members.push(['codex', models.codex])
  } else return usage()

  fs.writeFileSync(path.join(outDir, 'prompt.md'), prompt)
  const rows = []
  for (const [name, model] of members) {
    const r = run(name, model, prompt, cwd, outDir, timeoutMs)
    const v = parseVerdicts(r.text)
    rows.push({ ...r, verdicts: v })
    ledgerAppend(path.join(outDir, 'ledger.ndjson'), {
      schemaVersion: 1,
      tool: 'agy-council',
      sub,
      name,
      model,
      exit: r.exit,
      ms: r.ms,
      empty: r.empty,
      denied: r.denied,
      overall: v.overall,
    })
  }
  // 摘要表：空輸出要顯眼——「沒話說」與「被拒」同形，都不算簽。
  console.log(`| 成員 | model | exit | 秒 | 整份 | 逐題 |`)
  console.log(`|---|---|---|---|---|---|`)
  let anyEmpty = false
  for (const r of rows) {
    anyEmpty ||= r.empty
    const per = Object.entries(r.verdicts.q)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(`| ${r.name} | ${r.model} | ${r.exit} | ${Math.round(r.ms / 1000)} | ${r.empty ? '🔴 零輸出' : r.verdicts.overall || '?'} | ${per} |`)
  }
  console.log(`\n輸出：${outDir}/{${rows.map((r) => r.name).join(',')}}.txt`)
  return anyEmpty ? 3 : 0
}

function usage() {
  console.error('用法見檔頭。')
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
