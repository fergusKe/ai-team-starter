#!/usr/bin/env node
// ─────────────────── 寫手 wrapper（fail-closed；harness 由 config.writer.harness 經 registry 決定） ───────────────────
// 用法：
//   node .agents/skills/llm-team/write.mjs --worktree <abs> --brief <file> --allow <path> [--allow <path>…]
//        [--model <model>] [--writer-harness <name>] [--max-rounds <n>] [--test "<指令>"] [--ledger <file>] [--out <dir>] [--config <file>]
//
// 每輪：跑寫手 harness 的 write.run（agy：accept-edits、stream-json；gemini：auto_edit、stream-json＋policy TOML）→ 判「工作成功」而非「程序成功」
// → 越界檔對帳 → 跑 --test → 紅就把測試輸出餵回（write.resume：agy 是 --conversation <id>、gemini 是 --resume <session_id>）再一輪；
// 到 --max-rounds 仍紅 ⇒ exit 3 回統整者。
// 🔴 1.16.0 寫手鏈：config.writer 可以是有序陣列；`--writer-harness <name>`（或 env LLM_TEAM_WRITER_HARNESS）選席、預設第 0 席。
//   本檔一次只跑一席、不自動換席；每筆台帳帶 failure（統一形狀），ticket.mjs 收貨摘要看它印「下一席」提示。
//
// 🔴 2026-09-13 三方（agy opus-4-6／Gemini 3.1 Pro／codex sol）共識的機械保護，一條都不准拿掉：
//   G0 installCommand 必須成功（exit 0）——否則寫手一輪都不准啟動。
//   G1 worktree 分支不是 main、乾淨（開跑前）——否則不准動手。
//   G2 寫手 harness 的 preflight 全過（agy：settings.json 的 allow regex 與 lib.mjs 同源，漂移 ⇒ 寫手第一個指令就死）。
//   G3 回覆正文（統一形狀 text）非空且 denied 空——否則判 FAIL（exit 0 是假的）。
//   G4 `git status --porcelain` 的每個檔都在 allowlist——越界 ⇒ FAIL，不修、不還原、回統整者。
//   G5 每輪都寫台帳（ndjson）：round、baseline sha、changed、denied、test exit。
//   G6 迴圈上限 --max-rounds（預設從 config.json 讀取，硬上限 5）。
// 🔴 不做的事：不 stash、不 `git checkout --`、不 commit、不 push——那些是統整者在 merge 閘做的。
// 🔴 測試接縫：deps.getHarness（注入假 harness 攔 write.run／resume／preflight）、deps.runTest、deps.runInstall、deps.git、deps.changedFiles。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  loadConfig,
  writerFrom,
  writerHarnessArgError,
  git,
  changedFiles,
  outOfScope,
  ledgerAppend,
  parseArgs,
  CLEAN_GIT_ENV,
  isDirectRun,
  BASE_COMMAND_HEADS,
  WRITER_PROMPT_SENTINEL,
} from './lib.mjs'
import { getHarness, WRITER_HARNESSES } from './harnesses/index.mjs'

/** agy 專屬判定搬到 harnesses/agy.mjs（write.lastStepIsToolError）；這裡 re-export 維持既有 import 相容。 */
export { lastStepIsToolError } from './harnesses/agy.mjs'

export function buildWriterPrompt({ brief, worktree, allowlist, round, feedback, allowedHeads }) {
  const allowedLine =
    allowedHeads && allowedHeads.length
      ? [
          `     你只准跑這些指令頭：${allowedHeads.join('、')}。其他任何指令一跑整輪就被殺、你的改動作廢——需要清單外的指令就停下回報。`,
          '     引數裡不准出現 ; & | < > ` $（引號裡面也算）；管線只准接在兩個准許指令頭之間；grep 多樣式用多個 -e，不用 -E 的 (a|b)。跑到不合規指令一樣整輪被殺。',
        ]
      : []
  const head = [
    WRITER_PROMPT_SENTINEL,
    `工作目錄（絕對路徑，所有檔案操作只准在這棵樹內）：${worktree}`,
    '🔴 硬規則（違反任一條就停下來回報，不要自己變通）：',
    `  1. 只准建立或修改以下路徑：${allowlist.map((a) => `\`${a}\``).join('、')}。其他檔一律不碰（包括「順手」重構）。`,
    '  2. 每次只執行【一個】指令；禁止用 `;`、`&&`、`||`、管線串接；禁止 rm、git commit/push/checkout/reset/stash/clean、curl、安裝相依。',
    '     `node -e "…"` 裡的程式碼也不准含 `;`、`&&`、`|`、`$`、反引號（權限規則把它們當串接，整輪會被中止）；要做實驗就寫進測試檔用 node --test 跑。',
    '     不要 `ps`、不要等背景任務——所有指令都同步跑完再看結果。',
    ...allowedLine,
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
    console.error('用法：--worktree <abs> --brief <file> --allow <path>… [--model] [--writer-harness <name>] [--max-rounds] [--test "<cmd>"] [--ledger] [--out]')
    return 2
  }

  const gitFn = deps.git || git
  let repoRoot
  let config
  try {
    const commonDir = path.resolve(worktree, gitFn(worktree, ['rev-parse', '--git-common-dir']))
    repoRoot = path.dirname(commonDir)
    const worktreeRoot = path.resolve(worktree, gitFn(worktree, ['rev-parse', '--show-toplevel']))
    const loadCfg = deps.loadConfig || loadConfig
    config = loadCfg(worktreeRoot, a.config)
  } catch (e) {
    console.error(`🔴 config 載入失敗：${e.message}`)
    return 2
  }

  // 🔴 寫手 harness 只准 WRITER_HARNESSES（registry 裡 canWrite 的）：writerFrom 讀者側再驗一次，deps.config 注入也繞不過
  //    （陽性對照 llm-team.test.mjs「🔴 writer.harness 只准 agy」）。下面再對 registry 查一次 canWrite——deps.getHarness 注入假 harness 也擋。
  //    `--writer-harness <name>` 只准選 config.writer 列出的席（writerFrom 找不到就 throw 列清單）；
  //    裸旗標／空字串 ⇒ 拒絕（r3 sol Q2：以前靜默落第 0 席）。
  const harnessArgErr = writerHarnessArgError(a['writer-harness'], config)
  if (harnessArgErr) {
    console.error(`🔴 ${harnessArgErr}`)
    return 2
  }
  let writer
  try {
    writer = writerFrom(config, process.env, { harness: a['writer-harness'] })
  } catch (e) {
    console.error(`🔴 config 載入失敗：${e.message}`)
    return 2
  }
  const getHarnessFn = deps.getHarness || getHarness
  const h = getHarnessFn(writer.harness)
  if (!h.canWrite || !h.write) {
    console.error(`🔴 config 載入失敗：writer.harness 只准 ${WRITER_HARNESSES.join('|')}（有 write 介面的 harness），得到 ${JSON.stringify(writer.harness)}`)
    return 2
  }
  const model = a.model || writer.model
  const rawMaxRounds = a['max-rounds'] !== undefined ? Number(a['max-rounds']) : config.maxRounds
  const maxRounds = Number(rawMaxRounds || 3)
  if (maxRounds > 5) {
    console.error('🔴 --max-rounds 超過硬上限 5')
    return 2
  }

  const outDir = a.out
    ? path.resolve(a.out)
    : path.join(repoRoot, config.outDir, path.basename(worktree), 'write')
  const ledger = a.ledger || path.join(outDir, 'ledger.ndjson')
  const brief = fs.readFileSync(a.brief, 'utf8')
  const allowlist = a.allow
  const test = deps.runTest || runTest
  const changedFilesFn = deps.changedFiles || changedFiles

  const project = path.basename(repoRoot)
  const ticket = path.basename(worktree)

  const outRel = path.relative(worktree, outDir)
  const isOutInsideWorktree = !outRel.startsWith('..') && !path.isAbsolute(outRel)
  const outPrefix = isOutInsideWorktree ? (outRel.endsWith('/') ? outRel : outRel + '/') : null
  const isIgnored = (f) => f.startsWith('.agy-write/') || (outPrefix && f.startsWith(outPrefix))

  // G1
  const branch = gitFn(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'main') {
    console.error(`🔴 G1：worktree 在 main（${worktree}），不准動手。`)
    return 2
  }
  const dirty = changedFilesFn(worktree).filter((f) => !isIgnored(f))
  if (dirty.length) {
    console.error(`🔴 G1：worktree 不乾淨，先處理：\n  ${dirty.join('\n  ')}`)
    return 2
  }

  // G2：寫手 harness 的 preflight（role 'write'；agy ＝ settings.json 對帳；gemini ＝ 產 policy TOML 寫進 outDir；讀不到設定檔 ⇒ throw ⇒ 同樣擋）。
  //    🔴 回傳的任一條 !ok 就擋，沒有放行分支（sol block r1 Q2）——哪些條屬於寫手角色由 harness 依 role 決定
  //    （agy 的 trustedWorkspaces 只回給 setup，沿用 1.14.0 write 不查它的射程）。
  //    outDir 一併交給 harness：harness 的產物（gemini 的 policy TOML）只准落在 outDir——跟台帳同層、不進 worktree，
  //    所以 G4／ticket 的 changed 不需要任何特例（r2：r1 落在 worktree 底下被統整者真跑坐實會污染收貨摘要、擋 land）。
  try {
    const checks = h.preflight ? h.preflight(process.env, config, { repoRoot, role: 'write', outDir }) : []
    const bad = checks.find((p) => !p.ok)
    if (bad) {
      console.error(`🔴 G2：${bad.message || `${bad.label} 不通過`}`)
      return 2
    }
  } catch (e) {
    console.error(`🔴 G2：${e.message}`)
    return 2
  }

  const baseEntry = {
    schemaVersion: 1,
    project,
    ticket,
    tool: 'agy-write',
  }

  // installCommand
  let installExit = null
  if (config.installCommand && config.installCommand.trim()) {
    const runInstall = deps.runInstall || ((cmd, cwd) => {
      const r = spawnSync('sh', ['-c', cmd], {
        cwd,
        env: CLEAN_GIT_ENV,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
      return { exit: r.status, out: (r.stdout || '') + (r.stderr || '') }
    })
    const ins = runInstall(config.installCommand, worktree)
    installExit = ins.exit
    if (installExit !== 0) {
      ledgerAppend(ledger, { ...baseEntry, installExit, verdict: 'FAIL_install' })
      console.error(`🔴 G0：installCommand 失敗（exit=${installExit}）：${ins.out || ''}`)
      return 2
    }
    baseEntry.installExit = installExit
  }

  fs.mkdirSync(outDir, { recursive: true })
  const baseline = gitFn(worktree, ['rev-parse', 'HEAD'])
  let feedback = ''
  let conversationId = null

  const allowedHeads = [
    ...BASE_COMMAND_HEADS,
    ...(config.allowCommandHeads || []),
  ]
  const timeoutMs = Number(a['timeout-ms'] || 25 * 60 * 1000)
  let toolErrorRetries = 0
  for (let round = 1; round <= maxRounds; round++) {
    const prompt = buildWriterPrompt({ brief, worktree, allowlist, round, feedback, allowedHeads })
    // 第 1 輪 write.run；之後 write.resume 續同一段對話（agy ⇒ --conversation <id>；gemini ⇒ --resume <session_id>）。回傳是統一形狀 WriteResult。
    // outDir 交給 harness（gemini 從這裡找 preflight 寫的 policy TOML；agy 不用）。
    let r =
      round === 1
        ? h.write.run({ model, prompt, cwd: worktree, timeoutMs, outDir })
        : h.write.resume({ model, prompt, cwd: worktree, timeoutMs, conversationId, outDir })

    // 🔴 P5（2026-09-14）：寫手逾時（spawnSync timeout ⇒ status null、signal SIGTERM）以前會落進 G3 的 FAIL_headless，
    //    ticket 分不出「被拒」與「逾時」，而且 exit 3 後仍跑 --test 再開 council（拿半成品去複審）。
    //    這裡先於 conversation id 檢查判逾時：寫 <outDir>/timeout.json 讓 ticket 讀得到 writeTimedOut，台帳 FAIL_timeout，回 3。
    //    陽性對照：llm-team.test.mjs「P5：deps.runAgy 回 timedOut ⇒ main 回 3、timeout.json 存在、台帳 FAIL_timeout」。
    if (r.timedOut === true) {
      fs.writeFileSync(path.join(outDir, `round-${round}.stdout.ndjson`), r.stdout || '')
      fs.writeFileSync(path.join(outDir, `round-${round}.stderr.txt`), r.stderr || '')
      fs.writeFileSync(
        path.join(outDir, 'timeout.json'),
        JSON.stringify({ round, timeoutMs, signal: r.signal || null, at: new Date().toISOString() }, null, 2)
      )
      ledgerAppend(ledger, {
        ...baseEntry,
        round,
        model,
        baseline,
        exit: r.exit ?? null,
        signal: r.signal || null,
        timeoutMs,
        conversationId,
        failure: r.failure || undefined,
        verdict: 'FAIL_timeout',
      })
      console.error(`🔴 第 ${round} 輪：寫手逾時（${timeoutMs} ms，signal=${r.signal || null}），不續話、回統整者。`)
      return 3
    }

    // 🔴 agy 無頭第 6 坑（2026-09-13 H1 票，統整者親自坐實）：--continue 續的是「最近一個對話」；
    //    統整者本身是 agy 互動 session 時會續到統整者的對話而不是寫手的，而且 exit 0。
    //    修法：第 1 輪抓 stream-json 的 conversation_id，之後一律 --conversation <id>。
    //    陽性對照：llm-team.test.mjs「deps.runAgy 第 1 輪回 result 沒有 conversation_id 且無 init ⇒ main 回 3、台帳最後一筆 verdict === "FAIL_conversation_id"（陽性對照）」。
    //    停止條件：拿不到或不一致 ⇒ 台帳 FAIL_conversation_id、return 3、不續話。
    const initialConvId = r.conversationId || null
    if (round === 1) {
      conversationId = initialConvId
      if (!conversationId) {
        fs.writeFileSync(path.join(outDir, `round-${round}.stdout.ndjson`), r.stdout || '')
        fs.writeFileSync(path.join(outDir, `round-${round}.stderr.txt`), r.stderr || '')
        const response = r.text || ''
        fs.writeFileSync(path.join(outDir, `round-${round}.response.md`), response)
        ledgerAppend(ledger, {
          ...baseEntry,
          round,
          model,
          baseline,
          exit: r.exit,
          responseChars: response.length,
          conversationId: null,
          // 1.16.0：額度用盡（gemini result.error Quota／429）通常連 session id 都拿不到，failure 一定要跟著進台帳，ticket 才印得出「下一席」。
          failure: r.failure || undefined,
          verdict: 'FAIL_conversation_id',
        })
        console.error(`🔴 G3 前置：拿不到 conversation id，不續話${r.failure ? `（failure=${r.failure.kind}${r.failure.code ? `:${r.failure.code}` : ''}）` : ''}`)
        return 3
      }
    } else {
      if (initialConvId !== null && initialConvId !== conversationId) {
        fs.writeFileSync(path.join(outDir, `round-${round}.stdout.ndjson`), r.stdout || '')
        fs.writeFileSync(path.join(outDir, `round-${round}.stderr.txt`), r.stderr || '')
        const response = r.text || ''
        fs.writeFileSync(path.join(outDir, `round-${round}.response.md`), response)
        ledgerAppend(ledger, {
          ...baseEntry,
          round,
          model,
          baseline,
          exit: r.exit,
          responseChars: response.length,
          conversationId: initialConvId,
          failure: r.failure || undefined,
          verdict: 'FAIL_conversation_id',
        })
        console.error(`🔴 G3 前置：續輪回來的 conversation id（${initialConvId}）≠ 第 1 輪（${conversationId}），串錯對話，停`)
        return 3
      }
    }

    // 🔴 agy 無頭第 4 坑（2026-09-13 兩票各撞一次）：任一工具呼叫【參數不合法】（TOOL_ERROR，不是 permission）
    //    ⇒ 整輪靜默結束、response 空、status 卻是 SUCCESS。這不是寫手的錯也不是權限問題，
    //    所以在 G3 之前用 --conversation 續同一段對話，上限 2 次；每次都寫台帳，超過就照 G3 判 FAIL。
    while (
      toolErrorRetries < 2 &&
      r.exit === 0 &&
      r.denied.length === 0 &&
      !(r.text || '').trim() &&
      h.write.lastStepIsToolError(r.steps)
    ) {
      toolErrorRetries++
      fs.writeFileSync(path.join(outDir, `round-${round}.toolerror-${toolErrorRetries}.stdout.ndjson`), r.stdout)
      ledgerAppend(ledger, {
        ...baseEntry,
        round,
        model,
        baseline,
        conversationId,
        verdict: 'RETRY_toolerror',
        retry: toolErrorRetries,
        lastStep: r.steps[r.steps.length - 1],
        failure: r.failure || undefined,
      })
      console.error(`🟡 第 ${round} 輪：最後一個工具呼叫參數不合法而整輪中止，續第 ${toolErrorRetries} 次`)
      r = h.write.resume({
        model,
        prompt: '上一個工具呼叫的參數不合法（見錯誤訊息），整輪被中止了。請換合法參數從那一步繼續，規則不變。',
        cwd: worktree,
        timeoutMs,
        conversationId,
        outDir,
      })

      const retryConvId = r.conversationId || null
      if (retryConvId !== null && retryConvId !== conversationId) {
        fs.writeFileSync(path.join(outDir, `round-${round}.stdout.ndjson`), r.stdout || '')
        fs.writeFileSync(path.join(outDir, `round-${round}.stderr.txt`), r.stderr || '')
        const response = r.text || ''
        fs.writeFileSync(path.join(outDir, `round-${round}.response.md`), response)
        ledgerAppend(ledger, {
          ...baseEntry,
          round,
          model,
          baseline,
          exit: r.exit,
          responseChars: response.length,
          conversationId: retryConvId,
          failure: r.failure || undefined,
          verdict: 'FAIL_conversation_id',
        })
        console.error(`🔴 G3 前置：續輪回來的 conversation id（${retryConvId}）≠ 第 1 輪（${conversationId}），串錯對話，停`)
        return 3
      }
    }
    fs.writeFileSync(path.join(outDir, `round-${round}.stdout.ndjson`), r.stdout)
    fs.writeFileSync(path.join(outDir, `round-${round}.stderr.txt`), r.stderr)
    const response = r.text || ''
    fs.writeFileSync(path.join(outDir, `round-${round}.response.md`), response)
    const changed = changedFilesFn(worktree).filter((f) => !isIgnored(f))
    const oos = outOfScope(changed, allowlist)
    const entry = {
      ...baseEntry,
      round,
      model,
      baseline,
      exit: r.exit,
      responseChars: response.length,
      conversationId,
      denied: r.denied,
      changed,
      outOfScope: oos,
      // 台帳沿用 1.14.0 形狀：沒有 usage 就不寫這個欄（統一形狀的 null 不落地）。
      usage: r.usage || undefined,
      // 1.16.0：統一形狀的 failure（auth／quota／policy／timeout／process／protocol），null 不落地；ticket 收貨摘要讀最後一筆判「額度用盡 ⇒ 下一席」。
      failure: r.failure || undefined,
    }
    // G3：exit 非 0、被拒、正文空 ⇒ FAIL；r4（sol r3 Q2）：harness 回【任何非 null 的 failure】也 FAIL——
    //    r3 只擋 protocol，漏了「exit 0、正文非空、init 有 session id、但 result.status error（quota）」這種形狀：
    //    harness 已經說這輪失敗了，write.mjs 不該再看正文替它放行。timeout 仍由上面 P5 先判（寫 timeout.json、FAIL_timeout），
    //    這裡永遠碰不到 kind timeout。訊息印 failure=<kind>:<code>，ticket 靠台帳的 failure 印下一席。
    if (r.exit !== 0 || r.denied.length || !response.trim() || r.failure) {
      ledgerAppend(ledger, { ...entry, verdict: 'FAIL_headless' })
      console.error(
        `🔴 G3 第 ${round} 輪：${writer.harness} 無頭中止（exit=${r.exit}，denied=${JSON.stringify(r.denied)}，response ${response.length} 字${r.failure ? `，failure=${r.failure.kind}${r.failure.code ? `:${r.failure.code}` : ''}` : ''}）。stderr：\n${r.stderr.slice(0, 500)}`
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

if (isDirectRun(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
