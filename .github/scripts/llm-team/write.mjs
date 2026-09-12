#!/usr/bin/env node
// ─────────────────── agy 寫手 wrapper（fail-closed） ───────────────────
// 用法：
//   node tools/agy-write.mjs --worktree <abs> --brief <file> --allow <path> [--allow <path>…]
//        [--model gemini-3.8-flash-high] [--max-rounds 3] [--test "<指令>"] [--ledger <file>] [--out <dir>]
//
// 每輪：跑 agy accept-edits（stream-json）→ 判「工作成功」而非「程序成功」→ 越界檔對帳 → 跑 --test →
// 紅就把測試輸出餵回 agy（--continue）再一輪；到 --max-rounds 仍紅 ⇒ exit 3 回統整者。
//
// 🔴 2026-09-13 三方（agy opus-4-6／Gemini 3.1 Pro／codex sol）共識的機械保護，一條都不准拿掉：
//   G1 worktree 分支不是 main、乾淨（開跑前）——否則不准動手。
//   G2 settings.json 的 allow regex 與 tools/agy-lib.mjs 同源（漂移 ⇒ 寫手第一個指令就死）。
//   G3 stdout 的 result.response 非空且 denied_actions 空——否則判 FAIL（exit 0 是假的）。
//   G4 `git status --porcelain` 的每個檔都在 allowlist——越界 ⇒ FAIL，不修、不還原、回統整者。
//   G5 每輪都寫台帳（ndjson）：round、baseline sha、changed、denied、test exit。
//   G6 迴圈上限 --max-rounds（預設 3）。
// 🔴 不做的事：不 stash、不 `git checkout --`、不 commit、不 push——那些是統整者在 merge 閘做的。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  MODELS,
  runAgy,
  git,
  changedFiles,
  outOfScope,
  ledgerAppend,
  parseArgs,
  assertSettingsAllowRegex,
} from './agy-lib.mjs'
import { CLEAN_GIT_ENV } from './git-env.mjs'

export function buildWriterPrompt({ brief, worktree, allowlist, round, feedback }) {
  const head = [
    `工作目錄（絕對路徑，所有檔案操作只准在這棵樹內）：${worktree}`,
    '🔴 硬規則（違反任一條就停下來回報，不要自己變通）：',
    `  1. 只准建立或修改以下路徑：${allowlist.map((a) => `\`${a}\``).join('、')}。其他檔一律不碰（包括「順手」重構）。`,
    '  2. 每次只執行【一個】指令；禁止用 `;`、`&&`、`||`、管線串接；禁止 rm、git commit/push/checkout/reset/stash/clean、curl、pnpm install。',
    '     `node -e "…"` 裡的程式碼也不准含 `;`、`&&`、`|`、`$`、反引號（權限規則把它們當串接，整輪會被中止）；要做實驗就寫進測試檔用 node --test 跑。',
    '     不要 `ps`、不要等背景任務——所有指令都同步跑完再看結果。',
    '  3. 需要碰清單外的檔、或需要清單外的指令 ⇒ 立刻停止，在回覆裡說明「需要什麼、為什麼」。',
    '  4. 最後一段回覆要列：改了哪些檔（相對路徑）、跑了哪些指令、測試結果、還有什麼沒做。',
    '',
  ].join('\n')
  if (round === 1) return head + brief
  return (
    head +
    `這是第 ${round} 輪。上一輪的測試結果如下，請只修正讓它變綠所需的最小改動（仍受上面硬規則約束）：\n\n` +
    '```\n' +
    feedback +
    '\n```\n'
  )
}

/** 最後一個工具步驟是「參數不合法」那類 TOOL_ERROR（不是 permission）⇒ 整輪會被 agy 靜默結束。 */
export function lastStepIsToolError(steps) {
  const tools = (steps || []).filter((s) => s.tool)
  const last = tools[tools.length - 1]
  return Boolean(last && last.error && !/permission/i.test(last.error))
}

function runTest(cmd, cwd) {
  // 🔴 剝掉 node test runner 的子行程標記：在 `node --test` 底下巢狀跑 `node --test` 會被當成 child reporter、exit 0（假綠）。
  const env = { ...CLEAN_GIT_ENV }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { exit: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

export function main(argv, deps = {}) {
  const a = parseArgs(argv, ['allow'])
  const worktree = a.worktree && path.resolve(a.worktree)
  if (!worktree || !a.brief || !a.allow || a.allow.length === 0) {
    console.error('用法：--worktree <abs> --brief <file> --allow <path>… [--model] [--max-rounds] [--test "<cmd>"] [--ledger] [--out]')
    return 2
  }
  const model = a.model || MODELS.writer
  const maxRounds = Number(a['max-rounds'] || 3)
  const outDir = a.out || path.join(worktree, '.agy-write')
  const ledger = a.ledger || path.join(outDir, 'ledger.ndjson')
  const brief = fs.readFileSync(a.brief, 'utf8')
  const allowlist = a.allow
  const run = deps.runAgy || runAgy
  const test = deps.runTest || runTest
  const checkSettings = deps.assertSettings || assertSettingsAllowRegex

  // G1
  const branch = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'main') {
    console.error(`🔴 G1：worktree 在 main（${worktree}），不准動手。`)
    return 2
  }
  const dirty = changedFiles(worktree).filter((f) => !f.startsWith('.agy-write/'))
  if (dirty.length) {
    console.error(`🔴 G1：worktree 不乾淨，先處理：\n  ${dirty.join('\n  ')}`)
    return 2
  }
  // G2
  try {
    // repo 根＝worktree 的 --git-common-dir 的上一層（linked worktree 的 .git 是檔案，指回主 checkout）
    const commonDir = path.resolve(worktree, git(worktree, ['rev-parse', '--git-common-dir']))
    checkSettings(undefined, path.dirname(commonDir))
  } catch (e) {
    console.error(`🔴 G2：${e.message}`)
    return 2
  }
  fs.mkdirSync(outDir, { recursive: true })
  const baseline = git(worktree, ['rev-parse', 'HEAD'])
  let feedback = ''

  let toolErrorRetries = 0
  for (let round = 1; round <= maxRounds; round++) {
    const prompt = buildWriterPrompt({ brief, worktree, allowlist, round, feedback })
    let r = run({
      model,
      mode: 'accept-edits',
      prompt,
      cwd: worktree,
      extraArgs: round === 1 ? [] : ['--continue'],
    })
    // 🔴 agy 無頭第 4 坑（2026-09-13 兩票各撞一次）：任一工具呼叫【參數不合法】（TOOL_ERROR，不是 permission）
    //    ⇒ 整輪靜默結束、response 空、status 卻是 SUCCESS。這不是寫手的錯也不是權限問題，
    //    所以在 G3 之前用 --continue 續同一段對話，上限 2 次；每次都寫台帳，超過就照 G3 判 FAIL。
    while (
      toolErrorRetries < 2 &&
      r.exit === 0 &&
      r.denied.length === 0 &&
      !((r.result && r.result.response) || '').trim() &&
      lastStepIsToolError(r.steps)
    ) {
      toolErrorRetries++
      fs.writeFileSync(path.join(outDir, `round-${round}.toolerror-${toolErrorRetries}.stdout.ndjson`), r.stdout)
      ledgerAppend(ledger, { tool: 'agy-write', round, model, baseline, verdict: 'RETRY_toolerror', retry: toolErrorRetries, lastStep: r.steps[r.steps.length - 1] })
      console.error(`🟡 第 ${round} 輪：最後一個工具呼叫參數不合法而整輪中止，--continue 續第 ${toolErrorRetries} 次`)
      r = run({
        model,
        mode: 'accept-edits',
        prompt: '上一個工具呼叫的參數不合法（見錯誤訊息），整輪被中止了。請換合法參數從那一步繼續，規則不變。',
        cwd: worktree,
        extraArgs: ['--continue'],
      })
    }
    fs.writeFileSync(path.join(outDir, `round-${round}.stdout.ndjson`), r.stdout)
    fs.writeFileSync(path.join(outDir, `round-${round}.stderr.txt`), r.stderr)
    const response = (r.result && r.result.response) || ''
    const changed = changedFiles(worktree).filter((f) => !f.startsWith('.agy-write/'))
    const oos = outOfScope(changed, allowlist)
    const entry = {
      tool: 'agy-write',
      round,
      model,
      baseline,
      exit: r.exit,
      responseChars: response.length,
      denied: r.denied,
      changed,
      outOfScope: oos,
      usage: r.result && r.result.usage,
    }
    // G3
    if (r.exit !== 0 || r.denied.length || !response.trim()) {
      ledgerAppend(ledger, { ...entry, verdict: 'FAIL_headless' })
      console.error(
        `🔴 G3 第 ${round} 輪：agy 無頭中止（exit=${r.exit}，denied=${JSON.stringify(r.denied)}，response ${response.length} 字）。stderr：\n${r.stderr.slice(0, 500)}`
      )
      return 3
    }
    // G4
    if (oos.length) {
      ledgerAppend(ledger, { ...entry, verdict: 'FAIL_scope' })
      console.error(`🔴 G4 第 ${round} 輪：越界檔（不還原、回統整者）：\n  ${oos.join('\n  ')}`)
      return 3
    }
    if (!a.test) {
      ledgerAppend(ledger, { ...entry, verdict: 'PASS_no_test' })
      console.log(`✅ 第 ${round} 輪完成（無 --test）。改動：${changed.join(', ') || '(無)'}\n${response}`)
      return 0
    }
    const t = test(a.test, worktree)
    fs.writeFileSync(path.join(outDir, `round-${round}.test.txt`), t.out)
    ledgerAppend(ledger, { ...entry, testExit: t.exit, verdict: t.exit === 0 ? 'PASS' : 'RED' })
    if (t.exit === 0) {
      console.log(`✅ 第 ${round} 輪測試綠。改動：${changed.join(', ') || '(無)'}\n${response}`)
      return 0
    }
    console.error(`🟡 第 ${round} 輪測試紅（exit=${t.exit}）。`)
    feedback = t.out.slice(-6000)
  }
  console.error(`🔴 G6：${maxRounds} 輪仍紅，回統整者。輸出在 ${outDir}`)
  return 3
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
