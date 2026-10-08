#!/usr/bin/env node
// ─────────────────── llm-team 票流程（run / publish / summary / land） ───────────────────
// 用法：
//   run:     node .agents/skills/llm-team/ticket.mjs run --coordinator <claude|agy|codex> --name <n> --brief <file> --branch <prefix/name> --allow <path>… --test "<cmd>" [--tier standard|block] [--base main] [--config <file>]
//   publish: node .agents/skills/llm-team/ticket.mjs publish --name <n> [--title "<t>"] [--config <file>]
//   summary: node .agents/skills/llm-team/ticket.mjs summary --name <n> [--config <file>]
//   land:    node .agents/skills/llm-team/ticket.mjs land --name <n> --msg-file <path>
//
// exit code：0＝成功、2＝參數/設定/守門錯誤、3＝寫手/驗收/複審失敗、4＝land 工作樹/分支/夾帶/add失敗、5＝land 沒東西可落地/commit失敗、6＝land ff-only失敗、7＝複審綁定失敗、8＝target 前進處置失敗
//
// 🔴 2026-09-14 schema v2：`--coordinator`（或 env LLM_TEAM_COORDINATOR）必帶——複審名單由 config.profiles.<coordinator> 決定
//   （一般票 reviewers、block 票 blockReviewers）；summary.schemaVersion 2 帶 coordinator 與 reviewers（預期名單）。
// 🔴 Q5（2026-09-14 codex 複審）：summary.review.members ＝ council 實際跑的名單（來自 review/members.json、含 harness/model/quotaBucket）；
//   實際 ≠ 預期 ⇒ summary.rosterMismatch: true、run 回 3；publish 比對三元組並回頭讀 members.json，缺檔／不符 ⇒ 擋。
// 🔴 P5（2026-09-14）：任何 writeExit !== 0（含 2）⇒ 不跑 --test、不開 council、仍寫 summary（review = null）（以前 exit 3 會拿半成品去複審、exit 2 沒 summary）。
//
// 🔴 1.26.0（WBS 4.7.31 A2 T2b）：送審前先 commit、輪次目錄對齊 land。
//   · verify 通過（exit 0）後、送 council 前，ticket 先把寫手【實際改動且落在 --allow 內】的檔 commit（訊息 `<票名> r<N>: <brief 標題>（<寫手 harness/model> 寫）`）；
//     --allow 外有改動／untracked ⇒ 不 commit、不送審（沿用 write.mjs G4 越界規則：不修、不還原、回統整者）；commit 後工作樹必須乾淨，否則不送審。
//     verify 紅 ⇒ 不 commit、不送審（舊流程會對髒樹送審；--require-clean 下那只會被 council 拒審）。
//   · council 一律帶 `--require-clean`，`--base` 為 merge-base（不是 main 名稱：main 前進後 `git diff main` 會把別人的 commit 反向算進來）。
//   · 輪次目錄：當前輪直接寫 `review-r<N>`（第 1 輪＝review-r1），不再使用 `review/`；舊結構（`review/` ＋ `review-r<N>`）仍可讀、可續輪——
//     `review/` 視為最新一輪、續輪時改名成 review-r<N>。與 WAS tools/land-core.mjs roundOfDir（只認 -r<N> 結尾）對得上。
//   · summary.json 新增 `commits:[{round, sha}]`（含前幾輪）、`reviewDirs:[…]`（相對 repo 根）；收貨摘要多印一行可複製的 land 指令（只印不執行）。
//
// 🔴 2026-09-13 三方共識：
//   · ticket 預設停在「已複審的 worktree＋收貨摘要」；ticket publish 才 commit、push、開 draft PR；永不自動 merge。
//   · P4：G1–G6 是寫手 wrapper 的自我約束，不是 repo 的門；門仍是 GitHub ruleset＋PR review。
//   · 統整者一張票只花兩個回合：一回合 ticket 起跑，一回合收貨。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  loadConfig,
  modelsFrom,
  writerFrom,
  writerHarnessArgError,
  nextWriterSeat,
  memberFileName,
  git,
  changedFiles,
  outOfScope,
  parseArgs,
  CLEAN_GIT_ENV,
  agySettingsPath,
  isDirectRun,
  readMembersJson,
  compareRoster,
  rosterLabel,
  preflightBriefCommands,
  writeTreeOf,
  MEASUREMENT_SCHEMA_VERSION,
  matchRiskPaths,
  crossFamilyStatus,
} from './lib.mjs'
import { getHarness } from './harnesses/index.mjs'
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
  if (m.substitutedFor) {
    lines.push(`  ↻ 換席：原席 ${m.substitutedFor.harness}/${m.substitutedFor.model}〔${m.substitutedFor.quotaBucket}〕→ 本席（原因 ${m.substituteReason || '?'}）`)
  } else if (Array.isArray(m.attempts) && m.attempts.length > 0) {
    lines.push(`  🔴 額度／憑證用盡且 fallbacks 全失敗：${m.attempts.map((x) => `${x.harness}/${x.model}:${x.kind}`).join('、')}`)
  }
  if (m.empty) return lines

  const uncitedSet = new Set(Array.isArray(m.uncited) ? m.uncited : (parseVerdicts(m.text || '').uncited || []))
  const textLines = (m.text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  for (const [qn, verdict] of Object.entries(m.q || {})) {
    if (verdict === '不簽') {
      const matchLine = textLines.find((l) => l.startsWith(qn) || l.includes(qn))
      const reason = matchLine ? matchLine.slice(0, 200) : '不簽'
      const suffix = uncitedSet.has(qn) ? '　⚠ 無引用（不納入結論，accept 用 --disposition 記 rejected）' : ''
      lines.push(`  - ${qn} (不簽): ${reason}${suffix}`)
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
    sessionId: (env && env.CLAUDE_CODE_SESSION_ID) || null,
  }
  const full = { ...base, ...entry }
  fs.mkdirSync(outDir, { recursive: true })
  fs.appendFileSync(lifecycleFile, JSON.stringify(full) + '\n')
}

/**
 * 4.7.20：跑一次 `tools/product-wbs.mjs --status --json`（15s 逾時）並摘要成 `{generated_at, head_sha, counts}`；
 * `counts` 由 `items[].status` 現場彙總（工具本身不吐 counts）。工具不存在／spawn 失敗／非 0／JSON 壞 ⇒ `{error}`，
 * 純觀測、不擋票（run／land 呼叫端都不看這個值決定 exit code）。
 * 陽性對照 ticket.test.mjs「--status 工具不存在 ⇒ summary.wbsStatusAtRun.error 為字串、run 仍 0」。
 */
export function runWbsStatus(repoRoot, deps = {}) {
  const toolPath = path.join(repoRoot, 'tools', 'product-wbs.mjs')
  if (!fs.existsSync(toolPath)) {
    return { error: `tools/product-wbs.mjs 不存在：${toolPath}` }
  }
  const spawnFn = deps.spawn || spawnSync
  let r
  try {
    r = spawnFn(process.execPath, [toolPath, '--status', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
      env: CLEAN_GIT_ENV,
    })
  } catch (e) {
    return { error: `product-wbs.mjs --status 執行失敗：${e.message}` }
  }
  if (!r || r.error) {
    return { error: `product-wbs.mjs --status 執行失敗：${(r && r.error && r.error.message) || String(r && r.error)}` }
  }
  if (r.status !== 0) {
    return {
      error: `product-wbs.mjs --status 回 exit ${r.status}${r.signal ? `（signal ${r.signal}）` : ''}：${((r.stderr || '') + '').slice(0, 300)}`,
    }
  }
  let parsed
  try {
    parsed = JSON.parse(r.stdout || '')
  } catch (e) {
    return { error: `product-wbs.mjs --status JSON 解析失敗：${e.message}` }
  }
  // 4.7.20 第 3 輪 Q3：JSON.parse 對 "null"／"123"／"[...]"／'"str"' 都不會 throw，但都不是我們要的物件形狀；
  //   不擋在這裡的話，下面 parsed.items／parsed.generated_at 對 null 取值就直接炸整個 run。防禦寫法：非
  //   plain object（含 null、陣列）⇒ 當成失敗，純觀測不擋票，只是記不到內容。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '--status 輸出非物件' }
  }
  const counts = {}
  for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
    const key = (item && typeof item === 'object' && item.status) || 'unknown'
    counts[key] = (counts[key] || 0) + 1
  }
  return {
    generated_at: parsed.generated_at ?? null,
    head_sha: parsed.head_sha ?? null,
    counts,
  }
}

/** 從 dir 開始 realpath；不存在就往上找最近存在的祖先再 realpath（4.7.20 第 3 輪 Q2a）。連 filesystem root 都不存在時回 null（理論上不會發生，防禦性）。 */
function realpathNearestExisting(dir) {
  let d = dir
  while (true) {
    try {
      return fs.realpathSync(d)
    } catch {
      const parent = path.dirname(d)
      if (parent === d) return null
      d = parent
    }
  }
}

/** dir 的 realpath 是否仍在 realRepoRoot 之內（相對路徑不以 '..' 開頭、也不是絕對路徑）。 */
function isWithinRealRoot(realDir, realRepoRoot) {
  const rel = path.relative(realRepoRoot, realDir)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 4.7.20：對每個 --allow 路徑，從其所在目錄往上找最近的 `CONTEXT.md`（不超出 repoRoot），去重（同一份只回一次）。
 * 映射＝約定：每個程式區塊放一份 CONTEXT.md；--allow 給的是檔案（可能還沒建立）就從其 dirname 往上找，
 * 給的是既有目錄就從該目錄往上找。回傳去重後的路徑陣列（依 --allow 出現順序）。
 *
 * 4.7.20 第 3 輪（Q2a，gemini 複審坐實）路徑邊界：
 * - `--allow` 是絕對路徑 ⇒ 一律跳過（不猜它是不是「剛好」在 repo 內）。
 * - 起始目錄（存在就用它、不存在就用最近存在的祖先）一律 `fs.realpathSync` 解析；解析後若相對 repoRoot
 *   的路徑以 `..` 開頭或本身是絕對路徑（即跳出 repoRoot，典型形狀＝ --allow 指到一個指向 repo 外的
 *   symlink 目錄）⇒ 整個 --allow 跳過、不注入任何東西。
 * - 找到的 `CONTEXT.md` 本身也再 `realpath` 一次並做同樣的邊界檢查（防 CONTEXT.md 檔案自己是指向 repo
 *   外的 symlink）；沒通過就當作沒找到，繼續（不 fallback 到上一層，就是這個候選失效）。
 */
export function collectContextForAllow(allowPaths, repoRoot) {
  const repoRootAbs = path.resolve(repoRoot)
  let realRepoRoot
  try {
    realRepoRoot = fs.realpathSync(repoRootAbs)
  } catch {
    realRepoRoot = repoRootAbs
  }
  const seen = new Set()
  const results = []
  for (const rel of Array.isArray(allowPaths) ? allowPaths : []) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) continue
    const abs = path.resolve(repoRootAbs, rel)
    let startDir
    try {
      startDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs)
    } catch {
      startDir = path.dirname(abs)
    }
    const realStartDir = realpathNearestExisting(startDir)
    if (realStartDir === null || !isWithinRealRoot(realStartDir, realRepoRoot)) continue

    let dir = realStartDir
    let found = null
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = path.join(dir, 'CONTEXT.md')
      if (fs.existsSync(candidate)) {
        let realCandidate = null
        try {
          realCandidate = fs.realpathSync(candidate)
        } catch {
          realCandidate = null
        }
        if (realCandidate && isWithinRealRoot(realCandidate, realRepoRoot)) {
          found = candidate
        }
        break
      }
      if (path.resolve(dir) === realRepoRoot) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (found && !seen.has(found)) {
      seen.add(found)
      results.push(found)
    }
  }
  return results
}

/** 找出 content 中最長一串連續反引號的長度；fence 長度取 max(3, 最長串+1)，確保 fence 不會被內容自己的反引號提早關閉（4.7.20 第 3 輪 Q2b）。 */
export function backtickFence(content) {
  // 🔴 1.26.1：不用 regex 字面值——mutation-receipt 的註解掃描器不認 regex 字面值，`+ 會讓它把其後整檔判成「不確定」（所有錨點 invalid）。
  const runs = content.match(new RegExp('`+', 'g')) || []
  const longest = runs.reduce((m, run) => Math.max(m, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * 寫手最後一筆台帳的 failure（write.mjs 1.16.0 起每筆都帶統一形狀 failure；沒有／讀不到 ⇒ null）。
 * 只讀 `<writeOutDir>/ledger.ndjson`（write.mjs 收到 --out 時的預設台帳位置）；壞行跳過，取最後一筆合法的。
 */
export function lastWriterFailure(writeOutDir) {
  const file = path.join(writeOutDir, 'ledger.ndjson')
  if (!fs.existsSync(file)) return null
  let last = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      last = JSON.parse(t)
    } catch {
      /* 壞行跳過 */
    }
  }
  return last && last.failure && typeof last.failure === 'object' ? last.failure : null
}

/** 收貨摘要的「下一席」那一行：只在寫手 failure.kind==='quota' 且 config 還有下一席時才印；不自動重跑。 */
export function writerQuotaHintLine(summary) {
  const f = summary.writerFailure
  const next = summary.writerNext
  if (!f || f.kind !== 'quota' || !next) return null
  return `🔴 寫手額度用盡：下一席 ${next.harness}/${next.model}，重跑加 --writer-harness ${next.harness}`
}

// ─────────────────── 1.26.0：複審輪次目錄（review-r<N>）、送審前 commit、land 指令 ───────────────────

/**
 * 列出 <outDir> 下的複審輪次目錄，輪次升冪：`review-r<N>`（N＝輪次）＋舊結構的 `review/`（若存在且是目錄）。
 * 舊結構的 `review/` 一律視為「最新一輪」（舊流程把當前輪放在 review/、前輪改名成 review-r<N>），輪次記為 max(N)+1、legacy:true。
 * 回 [{ name, round, path, legacy }]。
 */
export function listReviewDirs(outDir) {
  let names = []
  try {
    names = fs.readdirSync(outDir)
  } catch {
    return []
  }
  const dirs = []
  for (const name of names) {
    const m = name.match(/^review-r(\d+)$/)
    if (!m) continue
    try {
      if (!fs.statSync(path.join(outDir, name)).isDirectory()) continue
    } catch {
      continue
    }
    dirs.push({ name, round: Number(m[1]), path: path.join(outDir, name), legacy: false })
  }
  dirs.sort((x, y) => x.round - y.round)
  const legacyPath = path.join(outDir, 'review')
  try {
    if (fs.statSync(legacyPath).isDirectory()) {
      const max = dirs.length ? dirs[dirs.length - 1].round : 0
      dirs.push({ name: 'review', round: max + 1, path: legacyPath, legacy: true })
    }
  } catch {
    /* 沒有舊結構 */
  }
  return dirs
}

/** 最新一輪的複審目錄（絕對路徑）；一輪都沒有 ⇒ null。讀 members.json／各席 txt 的地方都走這支（相容舊結構）。 */
/**
 * 🔴 1.26.2（T2b-v2 r2，codex R1）：新一輪開始、commit 之前，先把上一份 summary.json 的「acceptance」原子清掉（寫暫存檔再 rename）。
 * 事故情境：新一輪在重寫 summary 前中斷（council 之後、summary 寫入之前拋錯）⇒ 磁碟上留著舊輪「已 accept」的 summary
 * （q6Receipt／dispositions／acceptedAt），publish 會拿舊輪的 verdict／Q6 配最新 review-r<N> 的 input／members，把新 commit 推出去。
 * 清掉後 summary 不再是「已 accept」，且 reviewDir／reviewedHead 歸 null（publish 的 generation 綁定會直接拒）。
 * 陽性對照 ticket.test.mjs「1.26.2 R1」。停止條件：publish 退役（land.mjs 成為唯一推送入口）時一併移除（見 SKILL.md 1.26.1 節）。
 */
export function invalidatePriorAcceptance(summaryPath, now = () => new Date().toISOString()) {
  if (!fs.existsSync(summaryPath)) return
  let next
  try {
    const prior = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    // eslint-disable-next-line no-unused-vars
    const { acceptedAt, q6Receipt, dispositions, caliber, caliberBy, measurementSchemaVersion, reviewDir, reviewedHead, ...rest } = prior
    next = { ...rest, reviewDir: null, reviewedHead: null, acceptanceClearedAt: now() }
  } catch {
    next = { schemaVersion: 2, invalid: true, reviewDir: null, reviewedHead: null, acceptanceClearedAt: now() }
  }
  const tmp = `${summaryPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, summaryPath)
}

export function latestReviewDir(outDir) {
  const dirs = listReviewDirs(outDir)
  return dirs.length ? dirs[dirs.length - 1].path : null
}

const toPosix = (p) => String(p).split(path.sep).join('/')

/** shell 單引號保護：只含安全字元就原樣，否則包單引號。 */
function shellQuote(s) {
  const t = String(s)
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`
}

/**
 * 收貨摘要的 land 指令（只印、不執行）。條件：summary 有複審（review 非 null）且 reviewDirs 非空。
 * `--review` 一個旗標只收一個目錄（land parseArgs 的 val()），所以每輪各帶一次。msg-file 給固定位置（reviewDirs 同層的 land-msg.txt）。
 * 本行不含任何驗證宣稱字樣（land 會拒絕含「全綠」等字眼的訊息；這裡也不示範）。
 */
export function landCommandLine(summary) {
  if (!summary || !summary.review) return null
  const dirs = Array.isArray(summary.reviewDirs) ? summary.reviewDirs.filter((d) => typeof d === 'string' && d) : []
  if (dirs.length === 0 || !summary.branch || !summary.ticket || !summary.coordinator) return null
  const msgFile = path.posix.join(path.posix.dirname(dirs[0]), 'land-msg.txt')
  return [
    'node tools/land.mjs',
    '--branch',
    shellQuote(summary.branch),
    '--name',
    shellQuote(summary.ticket),
    '--msg-file',
    shellQuote(msgFile),
    ...dirs.flatMap((d) => ['--review', shellQuote(d)]),
    '--coordinator',
    shellQuote(summary.coordinator),
  ].join(' ')
}

/** brief 的標題（第一行非空、非 HTML 註解，去掉開頭 #）；沒有 ⇒ null。 */
function briefTitle(briefContent) {
  const first = String(briefContent || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('<!--'))
  const t = first ? first.replace(/^#+\s*/, '').trim() : ''
  return t || null
}

const sha256OfFile = (file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 寫手跑之前，記下「--allow 內、被 .gitignore 擋掉、且是單一檔案」的路徑的內容 sha256（不存在 ⇒ null）。
 * 這種檔不會出現在 `git status`，要 commit 只能 `add -f`；跑完比對 sha 才知道是不是寫手實際動過。
 * allow 的目錄項（以 / 結尾）不處理：`add -f <目錄>` 會把整棵被忽略的東西（node_modules…）一起加進去。
 * check-ignore 失敗（含假 git）⇒ 視為沒被忽略。
 */
function snapshotIgnoredAllow(worktree, allow, gitFn) {
  const snap = new Map()
  for (const f of allow) {
    if (typeof f !== 'string' || !f || f.endsWith('/') || path.isAbsolute(f) || f.split('/').includes('..')) continue
    let ignored = false
    try {
      gitFn(worktree, ['check-ignore', '-q', '--', f])
      ignored = true
    } catch {
      ignored = false
    }
    if (ignored) snap.set(f, sha256OfFile(path.join(worktree, f)))
  }
  return snap
}

/**
 * 送審前 commit：只 add `changed`（呼叫端已確認都在 --allow 內）＋寫手實際動過的 gitignored allow 檔（`add -f`）。
 * 回 { ok:true, sha } 或 { ok:false, reason }。失敗不留半截 index（reset -q）。
 */
function commitBeforeReview({ worktree, changed, allow, ignoredTouched, message, gitFn, changedFilesFn }) {
  try {
    if (changed.length > 0) gitFn(worktree, ['add', '-A', '--', ...changed])
    for (const f of ignoredTouched) gitFn(worktree, ['add', '-f', '--', f])
    const staged = gitFn(worktree, ['diff', '--cached', '--name-only', '--no-renames']).split('\n').map((x) => x.trim()).filter(Boolean)
    if (staged.length === 0) {
      return { ok: false, reason: '沒有任何可 commit 的改動（add 之後 index 為空）' }
    }
    const strays = outOfScope(staged, allow)
    if (strays.length > 0) {
      try {
        gitFn(worktree, ['reset', '-q'])
      } catch {
        /* 盡力還原 index */
      }
      return { ok: false, reason: `index 內有 --allow 外的檔，不 commit：${strays.join(', ')}` }
    }
    const preHead = gitFn(worktree, ['rev-parse', 'HEAD'])
    gitFn(worktree, ['commit', '-q', '-m', message])
    // 🔴 1.26.0 r2（codex R1）：commit 之後重驗【commit 實際範圍】。pre-commit hook 可能在執行期間 stage 了 allow 外的檔，
    //   上面的 staged 檢查看不到；`--name-status --no-renames` 讓 rename 兩端都列出。有任何檔在 --allow 外 ⇒ 撤回這個 commit
    //   （reset --soft 回 commit 前的 HEAD、再把 index 還原），HEAD 不前進。這個 commit 還沒送審，撤回不是複審後 rebase。
    //   陽性對照 ticket.test.mjs「1.26.0 r2 R1」（拿掉本段 ⇒ hook 塞進去的檔被 commit、council 被呼叫）。
    const committed = gitFn(worktree, ['diff', '--name-status', '--no-renames', preHead, 'HEAD'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split('\t').slice(1).join('\t'))
    const committedStrays = outOfScope(committed, allow)
    if (committedStrays.length > 0) {
      gitFn(worktree, ['reset', '-q', '--soft', preHead])
      gitFn(worktree, ['reset', '-q'])
      return { ok: false, reason: `commit 實際範圍含 --allow 外的檔，已撤回 commit：${committedStrays.join(', ')}`, strays: committedStrays }
    }
    const left = changedFilesFn(worktree).filter((f) => !f.startsWith('.agy-write/'))
    if (left.length > 0) {
      return { ok: false, reason: `commit 後工作樹仍不乾淨：${left.join(', ')}` }
    }
    return { ok: true, sha: gitFn(worktree, ['rev-parse', 'HEAD']) }
  } catch (e) {
    // commit 失敗（hook 拒絕等）：index 還原成 HEAD，不留半截 staged（工作樹內容不動，統整者可看到寫手改了什麼）。
    try {
      gitFn(worktree, ['reset', '-q'])
    } catch {
      /* 盡力還原 index */
    }
    return { ok: false, reason: e.message }
  }
}

function buildReceiptSummaryLines(summary, reviewMembers, summaryPath) {
  const harness = summary.harness || 'unknown'
  const q6 = summary.q6Receipt ? '有' : '無'
  const dispCount = Array.isArray(summary.dispositions) ? summary.dispositions.length : 0
  const outDir = summaryPath ? path.dirname(summaryPath) : ''
  const verifyOutSuffix =
    summary.verifyExit !== null && summary.verifyExit !== undefined && summary.verifyExit !== 0
      ? `（輸出：${path.join(outDir, summary.verifyLog || 'verify.txt')}）`
      : ''
  const run = summary.run !== undefined && summary.run !== null ? summary.run : '?'
  const writePart = summary.reviewOnly
    ? 'write exit: -（review-only）'
    : `write exit: ${summary.writeExit} (run ${run}，共 ${summary.rounds} 輪)${summary.writeTimedOut ? '【寫手逾時】' : ''}`
  const lines = [
    `=== 收貨摘要：${summary.ticket} (${summary.branch}) ===`,
    `改動檔: ${summary.changed.join(', ') || '(無)'}`,
    `${writePart} | verify exit: ${summary.verifyExit !== null && summary.verifyExit !== undefined ? summary.verifyExit : '-'}${verifyOutSuffix}`,
    `harness: ${harness} | coordinator: ${summary.coordinator || '-'} | q6Receipt: ${q6} | dispositions: ${dispCount}`,
  ]

  if (summary.review === null) {
    if (summary.reviewOnly) {
      lines.push('🔴 未複審（review-only：verify 紅）')
    } else {
      if (summary.writeExit !== 0) {
        lines.push('🔴 未複審（write 非 0，P5：不跑 --test、不開 council）')
      } else if (Array.isArray(summary.outOfScope) && summary.outOfScope.length > 0) {
        lines.push(`🔴 未複審（--allow 外有改動／untracked，不 commit、不送審：${summary.outOfScope.join(', ')}）`)
      } else if (summary.commitFailure) {
        lines.push(`🔴 未複審（送審前 commit 失敗：${summary.commitFailure}）`)
      } else if (summary.verifyExit !== null && summary.verifyExit !== undefined && summary.verifyExit !== 0) {
        lines.push('🔴 未複審（verify 紅：未 commit、未送審）')
      } else {
        lines.push('🟡 未複審（寫手沒有改動任何檔）')
      }
    }
  }
  // 1.16.0 寫手鏈：額度用盡只【提示】下一席（統整者自己決定要不要重跑；council 09-22 第 4 題：fallback 不自動）。
  const quotaHint = writerQuotaHintLine(summary)
  if (quotaHint) lines.push(quotaHint)

  if (summary.tierEscalatedBy && summary.tierEscalatedBy.length > 0) {
    lines.push(`tierEscalatedBy: ${summary.tierEscalatedBy.join(', ')}`)
  }

  if (Array.isArray(summary.tierEscalatedByPaths) && summary.tierEscalatedByPaths.length > 0) {
    lines.push(`tierEscalatedByPaths: ${summary.tierEscalatedByPaths.map((h) => `${h.file}（${h.glob}）`).join(', ')}`)
  }
  if (summary.review?.duplicateModel === true) {
    lines.push('⚠ duplicateModel：換席後 block 名單有兩席是同一個模型（盲點相關，不算兩位獨立複審者）')
  }
  if (summary.review?.crossFamily === 'degraded') {
    lines.push('⚠ crossFamily: degraded（block 跨家族席因 quota／auth 換成同家族成員）——待事後審')
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
  // 1.12.0：複審者到底看了什麼——沒被呼叫要講、cap 被提高要講、writer-report 被截要講；舊 summary 沒有 input 就不印（unknown）。
  const inp = summary.review?.input
  if (inp && typeof inp === 'object') {
    if (inp.reviewInvoked === false) {
      lines.push(`🔴 沒有複審：diff ${inp.diffLength} 字元 > 完整送審上限 ${inp.diffCap}，複審者沒有被呼叫。拆票，或確認後 ticket run --diff-cap ${inp.diffLength} 重跑`)
    } else if (inp.capOverridden === true) {
      lines.push(`⚠ 本票 diff cap 由 ${inp.defaultDiffCap} 提高至 ${inp.diffCap}；完整送審 ${inp.diffLength} 字元`)
    }
    if (inp.writerReportTruncated) {
      lines.push(`⚠ writer-report 截斷 ${inp.writerReportTruncated.cap}/${inp.writerReportTruncated.originalLength} 字元（複審者沒看完寫手回報）`)
    }
  }

  for (const m of reviewMembers) {
    lines.push(...formatReviewerSummary(m))
  }

  const landLine = landCommandLine(summary)
  if (landLine) lines.push(landLine)

  lines.push(`summary.json: ${summaryPath}`)
  return lines
}

function loadAndGateSummary({
  sub,
  worktree,
  outDir,
  summaryPath,
  allowNoChanges = false,
  changedFilesFn = changedFiles,
  outBaseDir = '.local/llm-team',
  gitFn = git,
}) {
  if (!fs.existsSync(summaryPath)) {
    console.error(`🔴 summary.json 不存在：${summaryPath}`)
    return { ok: false, code: 2 }
  }

  let summary
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  } catch (e) {
    console.error(`🔴 summary.json 解析失敗：${e.message}`)
    return { ok: false, code: 2 }
  }

  const action = sub === 'land' ? '落地' : '開 PR'

  if (sub === 'land') {
    if (!summary.branch || typeof summary.branch !== 'string' || !summary.branch.trim() || !Array.isArray(summary.changed) || summary.changed.length === 0) {
      console.error('🔴 land：summary.json 缺少 branch 或 changed 為空')
      return { ok: false, code: 2 }
    }
    if (!fs.existsSync(worktree)) {
      console.error(`🔴 land：worktree 不存在：${worktree}`)
      return { ok: false, code: 4 }
    }
    // 🔴 事故：無事故；先例＝WAS tools/ticket-land.sh 2026-09-15 同一條 exit 4（worktree 指到別條分支時 add 的是別票的檔）
    //    陽性對照：測試 (b)
    //    停止條件：summary 改為記 worktree HEAD sha 並比對 sha 時可拆
    try {
      const wtBranch = gitFn(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (wtBranch !== summary.branch) {
        console.error(`🔴 land：worktree 分支（${wtBranch}）與 summary.branch（${summary.branch}）不符`)
        return { ok: false, code: 4 }
      }
    } catch (e) {
      console.error(`🔴 land：無法取得 worktree 分支：${e.message}`)
      return { ok: false, code: 4 }
    }
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
  // 1.26.0：run 已在送審前 commit（summary.commits 非空）⇒ 工作樹乾淨是預期狀態，不算「無任何改動」。
  const alreadyCommitted = Array.isArray(summary.commits) && summary.commits.length > 0
  if (currentFiles.length === 0 && !allowNoChanges && !alreadyCommitted) {
    console.error(`🔴 worktree 無任何改動：${worktree}`)
    return { ok: false, code: 2 }
  }

  const summaryChanged = Array.isArray(summary.changed) ? summary.changed : []
  const summaryChangedSet = new Set(summaryChanged)
  const unexpected = currentFiles.filter((f) => !summaryChangedSet.has(f))
  // 🔴 事故：2026-09-14 WAS：agy 統整者的 commit 19f26773f 夾帶了未追蹤的 tools/run-playwright.mjs（第二次名單覆寫時發現，該 commit 被換掉）
  //    陽性對照：測試 (c)
  //    停止條件：changedFiles 改為 land 時重算 summary.changed 並要求人簽時可拆
  if (unexpected.length > 0) {
    console.error(`🔴 ${sub}：worktree 有 run 之後才出現的檔，不准夾帶：${unexpected.join(', ')}`)
    return { ok: false, code: sub === 'land' ? 4 : 2 }
  }

  // Fail-closed 檢查
  // 🔴 2026-09-14 schema v2：舊版 summary（沒有 coordinator／reviewers 名單）不准 publish；陽性對照 ticket.test.mjs「publish：summary schemaVersion 1 ⇒ 2 且 gh 假函式沒被呼叫」
  if (summary.schemaVersion !== 2) {
    console.error(`🔴 ${sub}：summary.schemaVersion 為 ${JSON.stringify(summary.schemaVersion)}（非 2），重跑 ticket run 產新 summary`)
    return { ok: false, code: 2 }
  }

  // 🔴 2026-09-13 事故：寫手失敗（writeExit 非 0）時若帶有髒改動可能被誤開 PR；陽性對照 ticket.test.mjs「T30 publish：summary writeExit:3 ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：summary schema 改版或 publish 改為吃不可篡改之寫手證明時重審
  //    2026-09-15 (f)：review-only 的 summary 以 writeExit null＋reviewOnly true 放行；陽性對照 T74
  const writeOk = summary.reviewOnly === true && summary.writeExit === null
  if (!writeOk && summary.writeExit !== 0) {
    console.error(`🔴 ${sub}：writeExit 為 ${summary.writeExit}（非 0），不得${action}`)
    return { ok: false, code: 2 }
  }

  // 🔴 2026-09-13 事故：verify 失敗（verifyExit 非 0 或 null）被誤開 PR 造成破壞性合入；陽性對照 ticket.test.mjs「T22 publish：summary verifyExit:1 ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：summary schema 改版或 publish 改為驗收憑據強簽名時重審
  if (summary.verifyExit === null || summary.verifyExit !== 0) {
    console.error(`🔴 ${sub}：verifyExit 為 ${summary.verifyExit}（未通過驗收），不得${action}`)
    return { ok: false, code: 2 }
  }

  // 🔴 2026-09-13 事故：複審成員被 headless 權限靜默拒絕零輸出（anyEmpty）仍被誤判通過；陽性對照 ticket.test.mjs「T23 publish：summary anyEmpty:true ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：summary schema 改版或 council 輸出改為嚴格 schema 驗證不可為空時重審
  if (summary.review?.anyEmpty === true) {
    console.error(`🔴 ${sub}：複審有成員零輸出（anyEmpty === true），不得${action}`)
    return { ok: false, code: 2 }
  }

  // 🔴 2026-09-13 事故：複審成員不足法定人數（quorum 崩潰）被單方開 PR。
  //    2026-09-14 schema v2 改：法定人數＝profile 名單【全員到齊】（summary.reviewers 每一位都在 review.members），且至少 1 位——
  //    v2 一般票名單只有 1 位複審者＋裁決者，硬套「≥ 2」會把每張一般票都擋死。
  //    陽性對照 ticket.test.mjs「T31 publish：review.members 少於 summary.reviewers 名單 ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：三方仲裁協議改版時重審
  const reviewMembersList = summary.review?.members || []
  const roster = Array.isArray(summary.reviewers) ? summary.reviewers : []
  if (!Array.isArray(reviewMembersList) || reviewMembersList.length < 1 || roster.length < 1) {
    console.error(`🔴 ${sub}：複審成員或名單為空（members ${reviewMembersList.length} 位、reviewers 名單 ${roster.length} 位），不得${action}`)
    return { ok: false, code: 2 }
  }
  // 🔴 2026-09-14 codex 複審 Q5-IDENTITY：全員到齊要比【身分三元組】harness+model+quotaBucket（不比 name——同短名模型會冒充），
  //    而且要回頭讀 council 寫的 review/members.json（不只信 summary 自己貼的）：run 已記 rosterMismatch、缺檔、三元組不符 ⇒ 都擋。
  //    陽性對照 ticket.test.mjs「Q5 publish：同 name 不同 model ⇒ 2（只比 name 會放過）；少一位／多一位／缺 members.json／rosterMismatch:true ⇒ 2」
  if (summary.rosterMismatch === true) {
    console.error(`🔴 ${sub}：run 已判 rosterMismatch（council 實際名單 ≠ profile 預期名單），不得${action}`)
    return { ok: false, code: 2 }
  }
  const membersFile = path.join(latestReviewDir(outDir) || path.join(outDir, 'review'), 'members.json')
  const actualOnDisk = readMembersJson(membersFile)
  if (!actualOnDisk) {
    console.error(`🔴 ${sub}：缺 council 的實際名單（或格式不合法）：${membersFile}，無法證明全員簽署，不得${action}`)
    return { ok: false, code: 2 }
  }
  const fmtDiff = (d) =>
    `缺：${d.missing.map(rosterLabel).join(', ') || '(無)'}；多：${d.unexpected.map(rosterLabel).join(', ') || '(無)'}`
  const diskDiff = compareRoster(roster, actualOnDisk)
  if (diskDiff.mismatch) {
    console.error(`🔴 ${sub}：複審名單未全員到齊（review/members.json 身分三元組 ≠ summary.reviewers），${fmtDiff(diskDiff)}，不得${action}`)
    return { ok: false, code: 2 }
  }
  const summaryDiff = compareRoster(roster, reviewMembersList)
  if (summaryDiff.mismatch) {
    console.error(`🔴 ${sub}：複審名單未全員到齊（summary.review.members 身分三元組 ≠ summary.reviewers），${fmtDiff(summaryDiff)}，不得${action}`)
    return { ok: false, code: 2 }
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
          console.error(`🔴 ${sub}：複審成員 ${m.name} 整份不簽且未處置，不得${action}`)
          return { ok: false, code: 2 }
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
            console.error(`🔴 ${sub}：複審成員 ${m.name} 之 ${qn} 不簽且未處置，不得${action}`)
            return { ok: false, code: 2 }
          }
        }
      }
    }
  }

  // 🔴 2026-09-13 事故：統整者未親自坐實審查意見（缺少 q6Receipt）即盲目開 PR；陽性對照 ticket.test.mjs「T26 publish：沒 q6Receipt ⇒ 2 且 gh 假函式沒被呼叫」；停止條件：summary schema 改版或 Q6 查核改為強制雙人簽章時重審
  if (!summary.q6Receipt || !String(summary.q6Receipt).trim()) {
    console.error(`🔴 ${sub}：缺少 q6Receipt（統整者親自坐實 Q6 的證據），不得${action}`)
    return { ok: false, code: 2 }
  }

  return { ok: true, summary, summaryChanged, currentFiles }
}

export async function main(argv, deps = {}) {
  const env = deps.env || process.env
  const harness = (env && env.LLM_TEAM_HARNESS) || 'unknown'
  const conversationId = (env && env.LLM_TEAM_CONVERSATION_ID) || null
  const parsedAll = parseArgs(argv, ['allow', 'disposition'])
  const sub = parsedAll._[0]
  const rest = argv.slice(argv.indexOf(sub) + 1)
  if (!sub || !['run', 'publish', 'summary', 'accept', 'land'].includes(sub)) {
    console.error('用法：node ticket.mjs run|publish|summary|accept|land ...')
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
  const writeTreeOfFn = deps.writeTreeOf || writeTreeOf

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
      '用法：run --coordinator <claude|agy|codex> --name <n> --brief <file> --branch <prefix/name> --allow <path>… --test "<cmd>" (--wbs <id[,id...]>|--wbs-exempt "<理由>") [--tier standard|block] [--base main] [--review-only] [--write-timeout-ms <ms>] [--review-timeout-ms <ms>] [--writer-harness <name>]'
    if (!a.name || !a.brief || !a.branch || !a.allow || a.allow.length === 0 || !a.test) {
      console.error(RUN_USAGE)
      return 2
    }
    const reviewOnly = a['review-only'] === true

    if (a.tier !== undefined && a.tier !== 'standard' && a.tier !== 'block') {
      console.error(RUN_USAGE)
      return 2
    }

    // 🔴 1.16.0 寫手鏈：一次只跑一席。`--writer-harness <name>`（或 env LLM_TEAM_WRITER_HARNESS）選 config.writer 陣列裡的席，
    //    預設第 0 席；不在 config ⇒ exit 2 列出可用席。timeoutMs 也是選中那席的。
    //    裸旗標（parseArgs 得 true）／空字串 ⇒ 拒絕、不准靜默落第 0 席（r3 sol Q2）。
    const harnessArgErr = writerHarnessArgError(a['writer-harness'], config)
    if (harnessArgErr) {
      console.error(`🔴 ${harnessArgErr}`)
      return 2
    }
    const writerHarnessArg = a['writer-harness']
    let writer
    try {
      writer = writerFrom(config, env, { harness: writerHarnessArg })
    } catch (e) {
      console.error(`🔴 ${e.message}`)
      return 2
    }

    const writeTimeoutRaw = a['write-timeout-ms'] !== undefined ? a['write-timeout-ms'] : writer.timeoutMs
    let writeTimeoutMs = null
    if (writeTimeoutRaw !== undefined) {
      let n = NaN
      if (typeof writeTimeoutRaw === 'number') {
        n = writeTimeoutRaw
      } else if (typeof writeTimeoutRaw === 'string' && writeTimeoutRaw.trim() !== '') {
        n = Number(writeTimeoutRaw)
      }
      // 🔴 2026-09-16 事故：五張票三張 r1 寫手 25 分逾時（模型每回合 25–30 s × 40–53 回合），write.mjs 有 --timeout-ms 但 ticket 沒 passthrough，統整者無法依票大小調；無效值若放行會被 write.mjs 的 Number(x || 預設) 靜默吃成預設值（"abc" ⇒ NaN ⇒ 25 分）。
      //    陽性對照 ticket.test.mjs「T83 無效值（abc／0／-5／裸旗標／config "30s"）⇒ run 回 2、stderr 含「必須是正整數」、writeMain 0 次」（拿掉這個 if ⇒ T83 紅在 code 應為 2）；T80–T82 量 passthrough／優先序／預設不傳。
      //    停止條件：write.mjs 自己驗 --timeout-ms 並 fail-closed 時，這道閘可拆。
      if (!Number.isInteger(n) || n <= 0) {
        console.error('🔴 --write-timeout-ms／config.writer.timeoutMs 必須是正整數（毫秒），實際為 ' + JSON.stringify(writeTimeoutRaw))
        return 2
      }
      writeTimeoutMs = n
    }

    // 🔴 1.24.0：--review-timeout-ms passthrough 給 council（council 預設 8 分鐘；block 票／大 diff 的複審者可能要更久）。
    //   驗法與 --write-timeout-ms 相同（正整數、fail-closed）：無效值若放行，council 以前會把 NaN 靜默帶進 spawn 逾時。
    //   陽性對照 ticket.test.mjs「1.24.0 --review-timeout-ms」（abc／0／-5／裸旗標 ⇒ 回 2 且 writeMain 0 次；合法值 ⇒ councilArgs 帶 --timeout-ms）。
    //   停止條件：council 自己驗 --timeout-ms（1.24.0 已驗）且 ticket 不再需要在開 worktree 前就擋時，可拆本段。
    let reviewTimeoutMs = null
    if (a['review-timeout-ms'] !== undefined) {
      const raw = a['review-timeout-ms']
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
      if (!Number.isInteger(n) || n <= 0) {
        console.error('🔴 --review-timeout-ms 必須是正整數（毫秒），實際為 ' + JSON.stringify(raw))
        return 2
      }
      reviewTimeoutMs = n
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

    // 🔴 事故：2026-09-15：B4 逼 ticket 的 --test 走 node --test，node:test 父子行程 v8 序列化通道 flake（Unable to deserialize cloned data、檔案級紅斷言全綠）讓寫手誤開修復輪；--test 由 write.mjs runTest 與 ticket testFn 在沙箱外執行、不進寫手 prompt，B4 量錯了信任邊界（sol＋Gemini 一題定案刪除）
    // 陽性對照：ticket.test.mjs T17：--test 為 bash 開頭仍往下走、writeMain 被呼叫
    // 停止條件：若有一天 --test 改由寫手（agy）自己執行，或 --test 可由統整者以外的來源注入，這道閘要復活

    const briefPath = path.resolve(a.brief)
    if (!fs.existsSync(briefPath)) {
      console.error(`🔴 brief 檔案不存在：${briefPath}`)
      return 2
    }
    const briefContent = fs.readFileSync(briefPath, 'utf8')

    let preflight
    try {
      preflight = (deps.preflightBriefCommands || preflightBriefCommands)(briefContent, config)
    } catch (e) {
      console.error('🔴 ' + e.message)
      return 2
    }
    if (preflight.failures && preflight.failures.length > 0) {
      for (const f of preflight.failures) {
        console.error(`🔴 brief 指令預檢失敗：${briefPath}:${f.line}`)
        console.error(`   ${f.cmd}`)
        console.error(`   ${f.reason}`)
      }
      console.error('寫手跑到這條會被 allow regex 拒絕而整輪作廢；改 brief 再派。')
      return 2
    }

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

    // G2 寫手 harness 的 preflight（搬到 worktree add 之前，避免漂移造成 worktree 殘留）
    // 🔴 2026-09-13 H6 複審坐實：曾寫成「注入 writeMain ⇒ 跳過 G2」，把測試捷徑當契約；G2 只能由 deps 覆寫。陽性對照 ticket.test.mjs「T37 G2 對帳：deps 注入 writeMain 時仍受 G2 約束（assertSettings 拋錯 ⇒ run 回 2 且未建 worktree）」
    // 🔴 1.16.0：改走 registry 的 `getHarness(writer.harness).preflight(env, config, { repoRoot, role: 'write' })`——不認 harness 名字
    //    （agy ＝ settings.json 對帳；gemini ＝ 驗 policy TOML 產得出來，這裡不給 outDir 所以不落地，落地在 write.mjs G2 的 outDir——
    //    不進 worktree，changed 不需要特例；陽性對照 ticket.test.mjs T96/T97）。
    //    任一條 !ok 或 throw ⇒ exit 2。`deps.assertSettings` 相容保留：有注入就當它是這一席 preflight 的實作（舊簽名 (settingsFile, repoRoot, config)）。
    const getHarnessFn = deps.getHarness || getHarness
    const runPreflight = deps.assertSettings
      ? () => deps.assertSettings(agySettingsPath(env), repoRoot, config)
      : () => {
          const h = getHarnessFn(writer.harness)
          const checks = h.preflight ? h.preflight(env, config, { repoRoot, role: 'write' }) : []
          const bad = checks.find((c) => !c.ok)
          if (bad) throw new Error(bad.message || `${bad.label} 不通過`)
        }
    try {
      runPreflight()
    } catch (e) {
      console.error(`🔴 G2：${e.message}`)
      return 2
    }

    // 🔴 4.7.20（2026-09-28 業主核准）：開票必填 WBS 對照——`--wbs <id[,id...]>` 或 `--wbs-exempt "<理由>"` 至少擇一；
    //   兩者都沒給 ⇒ 拒開；exempt 理由必填非空；`--wbs` 的每個 ID 須符合 `^\d+(\.\d+)*[a-z]?$`。
    //   陽性對照 ticket.test.mjs「缺 --wbs 且無 exempt ⇒ run 回 2」「exempt 理由空 ⇒ run 回 2」「非法 ID ⇒ run 回 2」。
    const wbsProvided = a.wbs !== undefined
    const wbsExemptProvided = a['wbs-exempt'] !== undefined
    if (!wbsProvided && !wbsExemptProvided) {
      console.error(
        '🔴 開票必填 --wbs <id[,id...]> 或 --wbs-exempt "<理由>"：前者填本票對應的 WBS ID（逗號分隔可多個），後者給不屬任何 WBS 的票（如守門修補）用，理由必填非空'
      )
      return 2
    }
    // 🔴 4.7.20 第 2 輪（2026-09-28）：--wbs 與 --wbs-exempt 語意互斥（有 WBS 對照 vs. 明確豁免），同時給代表統整者
    //   自己也搞不清這張票算哪一種 ⇒ 不猜、直接拒開。陽性對照 ticket.test.mjs「同時給 --wbs 與 --wbs-exempt ⇒ run 回 2」。
    if (wbsProvided && wbsExemptProvided) {
      console.error('🔴 --wbs 與 --wbs-exempt 擇一：不可同時給，本票要嘛有 WBS 對照、要嘛明確豁免')
      return 2
    }
    let wbsIds = []
    let wbsExempt = null
    if (wbsProvided) {
      const wbsRaw = typeof a.wbs === 'string' ? a.wbs : ''
      wbsIds = wbsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (wbsIds.length === 0) {
        console.error('🔴 --wbs 不可為空；至少給一個 WBS ID（或改用 --wbs-exempt）')
        return 2
      }
      const WBS_ID_RE = /^\d+(\.\d+)*[a-z]?$/
      const invalidWbsIds = wbsIds.filter((id) => !WBS_ID_RE.test(id))
      if (invalidWbsIds.length > 0) {
        console.error(`🔴 --wbs 含不合法的 WBS ID（格式須為 數字(.數字)*字母?，例 1.13.2）：${invalidWbsIds.join(', ')}`)
        return 2
      }
    } else {
      const wbsExemptRaw = typeof a['wbs-exempt'] === 'string' ? a['wbs-exempt'].trim() : ''
      if (!wbsExemptRaw) {
        console.error('🔴 --wbs-exempt 理由必填非空')
        return 2
      }
      wbsExempt = wbsExemptRaw
    }

    // 🔴 4.7.20：run 開始跑一次 `tools/product-wbs.mjs --status --json`（觀測，不擋票；工具不存在／失敗 ⇒ 記 error）。
    const wbsStatusAtRun = (deps.runWbsStatus || runWbsStatus)(repoRoot, deps)

    const startedAt = new Date().toISOString()
    const worktreeRoot = config.worktreeRoot || '.claude/worktrees'
    const worktree = path.resolve(repoRoot, worktreeRoot, a.name)
    const outBaseDir = config.outDir || '.local/llm-team'
    const outDir = path.resolve(repoRoot, outBaseDir, a.name)

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
      if (reviewOnly) {
        console.error(`🔴 --review-only 需要既有 worktree：${worktree}`)
        return 2
      }
      fs.mkdirSync(path.dirname(worktree), { recursive: true })
      try {
        gitFn(repoRoot, ['worktree', 'add', worktree, '-b', a.branch, base])
        createdWorktree = true
      } catch (e) {
        console.error(`🔴 git worktree add 失敗：${e.message}`)
        return 2
      }
    }
    const roundStartSha = gitFn(worktree, ['rev-parse', 'HEAD'])
    const mergeBase = gitFn(worktree, ['merge-base', base, 'HEAD'])
    const targetTipSha = gitFn(repoRoot, ['rev-parse', base])

    if (reviewOnly && mergeBase === roundStartSha) {
      console.error(`🔴 --review-only：分支沒有領先 ${base}（HEAD=merge-base=${roundStartSha}），沒東西可審`)
      return 2
    }

    // 保存 brief 全文備份供 publish 與 PR body 使用
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'brief.md'), briefContent)

    // 🔴 4.7.20：CONTEXT.md 注入——對每個 --allow 路徑，往上找最近的 CONTEXT.md（不超出 repoRoot），去重；
    //   附到送寫手／複審的 brief 尾端。順序限制：必須在 riskDomains 比對與 preflightBriefCommands（都在上面、只看原始
    //   briefContent）**之後**才拼接，注入內容才不會誤觸兩者。找不到任何 CONTEXT.md ⇒ 不附加、effectiveBriefContent＝原文。
    //   陽性對照 ticket.test.mjs「CONTEXT.md 含『金流』『權限』字樣不因注入而升級 tier」「CONTEXT.md 含 pnpm --filter 不觸發 preflight 失敗」。
    const contextFiles = (deps.collectContextForAllow || collectContextForAllow)(a.allow, repoRoot)
    let effectiveBriefContent = briefContent
    if (contextFiles.length > 0) {
      // 4.7.20 第 3 輪 Q2b：每份 CONTEXT.md 內容包在 fenced code block 內（並標檔案相對路徑），避免其內文的
      //   Markdown 語法（標題、既有 fence）跟外層 brief 的結構混在一起；fence 長度依內容自動加長，
      //   內容含 ` ``` ` 時改用更長的 fence（見 backtickFence），段首標題字串不變。
      // relDir 標籤用 realpath 過的 repoRoot 當基準（collectContextForAllow 回的 f 也是 realpath 過的）：
      //   macOS `/var` -> `/private/var` 這類 symlink 會讓「原始 repoRoot」與「realpath 過的 f」前綴不一致，
      //   兩邊基準沒對齊時 path.relative 會算出一長串 `../` 而不是乾淨的 areaA 這種相對路徑。
      let realRepoRootForLabel = repoRoot
      try {
        realRepoRootForLabel = fs.realpathSync(repoRoot)
      } catch {
        /* repoRoot 讀不到 realpath 時退回原始值，僅影響標籤顯示 */
      }
      const blocks = contextFiles
        .map((f) => {
          const relDir = path.relative(realRepoRootForLabel, path.dirname(f)) || '.'
          const raw = fs.readFileSync(f, 'utf8').trim()
          const fence = backtickFence(raw)
          return `### ${relDir}/CONTEXT.md\n\n${fence}text\n${raw}\n${fence}`
        })
        .join('\n\n---\n\n')
      effectiveBriefContent =
        briefContent +
        '\n\n---\n\n【區塊環境說明（自動附加；③驗收指令為統整者 --test 用，非寫手白名單，寫手不准跑）】\n\n' +
        blocks +
        '\n'
    }
    const effectiveBriefPath = path.join(outDir, 'brief.effective.md')
    fs.writeFileSync(effectiveBriefPath, effectiveBriefContent)

    let runStartCount = 0
    const lifecycleFile = path.join(outDir, 'lifecycle.ndjson')
    if (fs.existsSync(lifecycleFile)) {
      const content = fs.readFileSync(lifecycleFile, 'utf8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed && parsed.event === 'run-start') {
            runStartCount++
          }
        } catch (e) {
          console.error(`⚠️ 解析 lifecycle.ndjson 行失敗：${trimmed} (${e.message})`)
        }
      }
    }
    const run = runStartCount + 1
    const writeOutDir = path.join(outDir, 'write', 'run-' + run)

    appendLifecycle(
      outDir,
      {
        event: 'run-start',
        ticket: a.name,
        run,
        wbsIds,
        ...(wbsExempt ? { wbsExempt } : {}),
        ...(reviewOnly ? { reviewOnly: true } : {}),
      },
      env
    )

    // b. 呼叫 write.main
    let writeExit = null
    let writeTimedOut = false
    let changed = []
    let ignoredSnapshot = new Map()

    if (reviewOnly) {
      // 🔴 2026-09-16 事故：review-only 在乾淨樹上 changed=[] ⇒ land :169 擋；改為 mergeBase..HEAD 已提交改動檔，與複審 --round-start 範圍一致；陽性對照 T78
      changed = gitFn(worktree, ['diff', '--name-only', mergeBase, 'HEAD']).split('\n').map((s) => s.trim()).filter(Boolean)
    } else {
      // 1.26.0：先記下 --allow 內被 .gitignore 擋掉的單檔內容（寫手後比對，才知道要不要 add -f）。
      ignoredSnapshot = snapshotIgnoredAllow(worktree, a.allow, gitFn)
      const writeMainFn = deps.writeMain || writeMain
      const writeArgs = [
        '--worktree',
        worktree,
        '--brief',
        effectiveBriefPath,
        ...a.allow.flatMap((al) => ['--allow', al]),
        '--out',
        writeOutDir,
        '--test',
        a.test,
      ]
      if (writeTimeoutMs !== null) writeArgs.push('--timeout-ms', String(writeTimeoutMs))
      if (a.model) writeArgs.push('--model', a.model)
      if (writerHarnessArg) writeArgs.push('--writer-harness', writerHarnessArg)
      if (configFile) writeArgs.push('--config', configFile)

      writeExit = writeMainFn(writeArgs, deps)
      appendLifecycle(outDir, { event: 'writer-done', ticket: a.name, writeExit, writerHarness: writer.harness }, env)

      // 🔴 P5：write 非 0（含 2＝守門擋下、3＝被拒／越界／逾時）⇒ 不跑 --test、不開 council；以前 exit 3 落到 changed.length > 0 就拿半成品去複審。
      //    陽性對照 ticket.test.mjs「P5 writeMain 回 3 且有改檔 ⇒ councilMain 假函式沒被呼叫、runTest 沒被呼叫、summary.review === null」；
      //    停止條件：run 流程改為事件驅動狀態機時重審。
      const writeFailed = writeExit !== 0
      const timeoutFile = path.join(writeOutDir, 'timeout.json')
      writeTimedOut = fs.existsSync(timeoutFile)
      // 🔴 changed 一定要在清 worktree 之前量（下面 exit 2 可能把 worktree 移掉）。
      changed = changedFilesFn(worktree).filter((f) => !f.startsWith('.agy-write/'))

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
    }

    // 🔴 1.24.0 路徑命中升 block（fable 10-03 重判 a-①）：diff 檔案命中 config.riskPaths 任一 glob ⇒ 票升 block，
    //   與 riskDomains 關鍵字並存。riskDomains 只看 brief／--allow 文字，寫手實際改到 trust-root（llm-team 快照、收據、land、hooks）
    //   而 brief 沒提時抓不到；這裡看的是【實際 diff 檔案】（寫手路徑 ＝ 本輪 changed；review-only ＝ merge-base..HEAD）。
    //   陽性對照 ticket.test.mjs「1.24.0 riskPaths 命中 ⇒ block」（拿掉本段 ⇒ councilArgs 的 --tier 仍是 standard、summary.reviewers 不含 block 名單）。
    //   停止條件：riskPaths 改由 CODEOWNERS／ruleset 在合併點強制時，本段可降為提示。
    let tierEscalatedByPaths = null
    //   🔴 rename：`changedFiles`（git status --porcelain）與 `git diff --name-only`（預設偵測 rename）都只回【新路徑】，
    //   風險路徑檔 rename 到安全路徑會躲過比對。所以再加一份 `git diff --name-only --no-renames <merge-base>`（舊路徑以刪除列出、
    //   新路徑以新增列出；工作樹對 merge-base，涵蓋已 commit、已 stage、未 stage 與前幾輪累計），與 changed 取聯集再比。
    //   git 失敗 ⇒ fail-closed 升 block（不是當作沒命中）。只在 config.riskPaths 非空時才多跑這一次 git。
    //   陽性對照 ticket.test.mjs「1.24.0 riskPaths rename」（只看新路徑 ⇒ 寫手路徑與 review-only 兩條都紅）。
    const riskGlobs = Array.isArray(config.riskPaths) ? config.riskPaths : []
    let riskCandidates = changed
    let riskGitFailed = false
    if (riskGlobs.length > 0) {
      try {
        const names = gitFn(worktree, ['diff', '--name-only', '--no-renames', mergeBase]).split('\n').map((s) => s.trim()).filter(Boolean)
        riskCandidates = Array.from(new Set([...changed, ...names]))
      } catch (e) {
        riskGitFailed = true
        console.error(`⚠️ riskPaths：git diff 失敗（${e.message}），fail-closed 升 block`)
      }
    }
    const riskPathHits = riskGitFailed
      ? [{ file: '(git diff 失敗)', glob: '*' }]
      : matchRiskPaths(riskCandidates, riskGlobs)
    if (riskPathHits.length > 0) {
      tierEscalatedByPaths = riskPathHits
      if (tier !== 'block') tier = 'block'
    }

    let verifyExit = null
    let councilExit = null
    let reviewOutDir = null
    let commitRecord = null
    let commitFailure = null
    let outOfScopeFiles = []
    if (reviewOnly) {
      const t = testFn(a.test, worktree)
      verifyExit = t.exit
      fs.writeFileSync(path.join(outDir, 'verify.txt'), t.out || '')
    }
    const writeFailed = writeExit !== 0
    if (!reviewOnly && !writeFailed && changed.length > 0) {
      const t = testFn(a.test, worktree)
      verifyExit = t.exit
      fs.writeFileSync(path.join(outDir, 'verify.txt'), t.out || '')
    }
    // 🔴 1.26.0：verify 紅 ⇒ 不 commit、不送審（--require-clean 下髒樹只會被 council 拒審；紅樹也不可能當 land 證據）。
    let doReview = reviewOnly ? verifyExit === 0 : !writeFailed && changed.length > 0 && verifyExit === 0

    // 🔴 1.26.2：要開新一輪（會有新 commit／新 review-r<N>）⇒ 先清舊 acceptance（commit 之前、council 之前）。
    if (doReview) invalidatePriorAcceptance(path.join(outDir, 'summary.json'))

    // 本輪輪次號：現有輪次目錄（含舊結構 review/ ＝最新一輪）之後的下一號。commit 訊息的 r<N> 與複審目錄 review-r<N> 同號。
    const existingReviewDirs = listReviewDirs(outDir)
    const reviewRound = existingReviewDirs.length ? existingReviewDirs[existingReviewDirs.length - 1].round + 1 : 1

    // 🔴 1.26.0（WBS 4.7.31 A2 T2b）：verify 通過後、送 council 前先 commit。
    //   事故：2026-10-04 p4733sa2fp 用 ticket 的 review 目錄跑 land ⇒ exit 2（[binding]／[dirty]／[diff-sha]）——ticket 對【未提交工作樹】送審，
    //   land 只收 dirty=false、untracked=[]、範圍正好是 mergeBase..branchHead 的輪次，經 ticket 審過的分支一律過不了 land。
    //   只 add 寫手實際改動且在 --allow 內的檔；--allow 外有改動 ⇒ 不 commit、不送審（G4 越界規則）；commit 後工作樹必須乾淨。
    //   陽性對照 ticket.test.mjs「1.26.0 ticket 送審前 commit」(a)（拿掉本段 ⇒ council 收到 dirty 樹、HEAD 仍是 roundStartSha）、(b)（拿掉越界判定 ⇒ councilMain 被呼叫）。
    //   停止條件：council 改為自己對 commit 重審（不信任 ticket 的 commit）時可拆。
    if (doReview && !reviewOnly) {
      const stray = outOfScope(changed, a.allow)
      if (stray.length > 0) {
        outOfScopeFiles = stray
        doReview = false
        console.error(`🔴 --allow 外有改動／untracked，不 commit、不送審：${stray.join(', ')}`)
      } else {
        const ignoredTouched = []
        for (const [f, before] of ignoredSnapshot) {
          if (sha256OfFile(path.join(worktree, f)) !== before && !changed.includes(f)) ignoredTouched.push(f)
        }
        const title = briefTitle(briefContent) || a.name
        const writerLabel = `${writer.harness}/${a.model || writer.model}`
        const c = commitBeforeReview({
          worktree,
          changed,
          allow: a.allow,
          ignoredTouched,
          message: `${a.name} r${reviewRound}: ${title}（${writerLabel} 寫）`,
          gitFn,
          changedFilesFn,
        })
        if (c.ok) {
          commitRecord = { round: reviewRound, sha: c.sha }
        } else {
          doReview = false
          if (c.strays) {
            outOfScopeFiles = c.strays
            console.error(`🔴 ${c.reason}`)
          } else {
            commitFailure = c.reason
            console.error(`🔴 送審前 commit 失敗：${c.reason}`)
          }
        }
      }
    }

    if (doReview) {
      // 🔴 1.26.0：當前輪直接寫 review-r<N>（第 1 輪＝review-r1），與 land-core roundOfDir（只認 -r<N> 結尾）對齊。
      //   舊結構的 review/（舊流程的當前輪）改名成 review-r<它的輪次> 保存，讓舊票可以續輪。
      //   council 的「brief 不得內嵌前輪推理」比對靠前輪輸出：下面逐一用 --prior-out 傳入（1.23.0，不依賴 council 的命名推導）。
      //   陽性對照 ticket.test.mjs「1.26.0 ticket 輪次目錄」「1.23.0 ticket 連跑兩輪」。
      for (const d of existingReviewDirs) {
        if (d.legacy) fs.renameSync(d.path, path.join(outDir, `review-r${d.round}`))
      }
      reviewOutDir = path.join(outDir, `review-r${reviewRound}`)
      fs.mkdirSync(reviewOutDir, { recursive: true })
      const priorReviewDirs = listReviewDirs(outDir)
        .filter((d) => d.path !== reviewOutDir)
        .map((d) => d.path)

      let writerReportPath = null
      if (fs.existsSync(writeOutDir)) {
        const responseFiles = fs
          .readdirSync(writeOutDir)
          .map((f) => {
            const m = f.match(/^round-(\d+)\.response\.md$/)
            return m ? { file: f, round: Number(m[1]) } : null
          })
          .filter(Boolean)
          .sort((a, b) => b.round - a.round)
        if (responseFiles.length > 0) {
          writerReportPath = path.join(writeOutDir, responseFiles[0].file)
        }
      }

      const councilMainFn = deps.councilMain || councilMain
      const councilArgs = [
        'review',
        '--worktree',
        worktree,
        '--base',
        mergeBase,
        '--round-start',
        reviewOnly ? mergeBase : roundStartSha,
        '--brief',
        effectiveBriefPath,
        '--out',
        reviewOutDir,
        '--tier',
        tier,
        '--coordinator',
        coordinatorProfile,
        '--require-clean',
      ]
      if (reviewOnly) councilArgs.push('--review-only')
      for (const d of priorReviewDirs) councilArgs.push('--prior-out', d)
      if (writerReportPath && !reviewOnly) councilArgs.push('--writer-report', writerReportPath)
      if (configFile) councilArgs.push('--config', configFile)
      if (a['diff-cap'] !== undefined) councilArgs.push('--diff-cap', String(a['diff-cap']))
      if (reviewTimeoutMs !== null) councilArgs.push('--timeout-ms', String(reviewTimeoutMs))
      councilExit = await councilMainFn(councilArgs, deps)
    }

    // 預期名單直接來自 profile（一般票 reviewers、block 票 blockReviewers）。
    // 陽性對照 ticket.test.mjs「T36 block 票收 blockReviewers（含 codex）、standard 票收 reviewers；codex 不簽則 publish 擋下」
    //   1.24.0：席位帶 fallbacks（三元組）進 summary.reviewers，compareRoster 才認得「宣告過的換席」。
    const expectedReviewers = (tier === 'block' ? models.blockReviewers : models.reviewers).map(
      ({ name, harness, model, quotaBucket, fallbacks }) => ({
        name,
        harness,
        model,
        quotaBucket,
        ...(Array.isArray(fallbacks) && fallbacks.length > 0
          ? { fallbacks: fallbacks.map((f) => ({ harness: f.harness, model: f.model, quotaBucket: f.quotaBucket })) }
          : {}),
      })
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
          const uncited = Array.isArray(m.uncited) ? m.uncited : (v.uncited || [])
          reviewMembers.push({
            name: m.name,
            harness: m.harness,
            model: m.model,
            quotaBucket: m.quotaBucket,
            ...(m.substitutedFor ? { substitutedFor: m.substitutedFor, substituteReason: m.substituteReason } : {}),
            ...(Array.isArray(m.attempts) ? { attempts: m.attempts } : {}),
            overall: m.overall !== undefined ? m.overall : v.overall,
            q: m.q && typeof m.q === 'object' ? m.q : v.q,
            uncited,
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

    // 1.16.0 寫手鏈：寫手最終 failure（write.mjs 台帳最後一筆）＋ config 的下一席。只在 write 非 0 時看；提示由收貨摘要印，這裡不重跑。
    //    陽性對照 ticket.test.mjs「T90 假寫手台帳 failure quota ⇒ 摘要含「下一席 gemini」；非 quota ⇒ 不含」。
    const writerFailure = !reviewOnly && writeExit !== 0 ? lastWriterFailure(writeOutDir) : null
    const writerNext = writerFailure && writerFailure.kind === 'quota' ? nextWriterSeat(config, writer.harness) : null

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
        members: reviewMembers.map(({ text, ...rest }) => rest),
        anyEmpty,
        membersSource: `${path.basename(reviewOutDir)}/members.json`,
        reviewedTree: writeTreeOfFn(worktree),
      }
      // 🔴 1.24.0 block 跨家族席降級：原本與統整者不同 quotaBucket 的席因 quota／auth 換成同家族成員 ⇒ crossFamily:'degraded'，
      //   並標 postReviewPending（收貨摘要印「待事後審」；本 repo 沒有事後審佇列檔，補審由統整者手動跑
      //   `council review --tier postreview --review-only`，名單來自 profile 的 postReviewers）。不擋 publish——降級是額度事實，不是簽核失敗。
      //   陽性對照 ticket.test.mjs「1.24.0 block 票跨家族席換成同家族 ⇒ summary.review.crossFamily degraded」。
      if (tier === 'block') {
        const cf = crossFamilyStatus(models.coordinator.quotaBucket, reviewMembers)
        reviewObj.crossFamily = cf.status
        if (cf.duplicateModel) reviewObj.duplicateModel = true
        if (cf.status === 'degraded') {
          reviewObj.postReviewPending = true
          reviewObj.crossFamilyDegraded = cf.degraded
        }
      }
      if (councilExit !== null && councilExit !== 0 && councilExit !== 3) {
        reviewObj.exit = councilExit
      }
      // 1.12.0：council 的 review/input.json（diff 長度／cap／有沒有真的呼叫複審者／writer-report 截斷）。
      // 缺檔（舊 council）⇒ null＝unknown；有檔就原樣帶，收貨摘要照它印。
      const inputFile = path.join(reviewOutDir, 'input.json')
      reviewObj.input = null
      if (fs.existsSync(inputFile)) {
        try {
          reviewObj.input = JSON.parse(fs.readFileSync(inputFile, 'utf8'))
        } catch {
          reviewObj.input = null
        }
      }
    }

    // 1.26.0：commits 帶前幾輪（讀上一份 summary.json，同分支才採信），reviewDirs＝所有輪次目錄（相對 repo 根、輪次升冪，含舊結構 review/）。
    const summaryPath = path.join(outDir, 'summary.json')
    let priorCommits = []
    if (fs.existsSync(summaryPath)) {
      try {
        const prior = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
        if (prior && prior.branch === a.branch && Array.isArray(prior.commits)) {
          priorCommits = prior.commits.filter((c) => c && Number.isInteger(c.round) && typeof c.sha === 'string' && c.sha)
        }
      } catch {
        /* 上一份壞掉 ⇒ 不帶前輪 commits */
      }
    }
    const commits = commitRecord ? [...priorCommits.filter((c) => c.round !== commitRecord.round), commitRecord] : priorCommits
    const reviewDirs = listReviewDirs(outDir).map((d) => toPosix(path.relative(repoRoot, d.path)))

    const summary = {
      schemaVersion: 2,
      project: path.basename(repoRoot),
      ticket: a.name,
      run,
      branch: a.branch,
      base,
      roundStartSha,
      mergeBase,
      targetTipSha,
      coordinator: coordinatorProfile,
      reviewers: expectedReviewers,
      wbsIds,
      ...(wbsExempt ? { wbsExempt } : {}),
      wbsStatusAtRun,
      reviewOnly,
      writeExit,
      writeTimedOut,
      // 1.16.0：實際跑的寫手席＋最終 failure＋（只在 quota 時）下一席；不自動重跑。
      writer: { harness: writer.harness, model: a.model || writer.model, quotaBucket: writer.quotaBucket },
      writerFailure,
      writerNext: writerNext ? { harness: writerNext.harness, model: writerNext.model } : null,
      rounds,
      changed,
      verifyExit,
      verifyLog: 'verify.txt',
      ...(tierEscalatedBy ? { tierEscalatedBy } : {}),
      ...(tierEscalatedByPaths ? { tierEscalatedByPaths } : {}),
      review: reviewObj,
      commits,
      reviewDirs,
      // 🔴 1.26.2：summary、複審目錄、受審 head 綁成同一代（generation）；publish 只認「summary.reviewDir＝最新 review-r<N>、summary.reviewedHead＝該目錄 input.json.head」。
      reviewDir: doReview ? toPosix(path.relative(repoRoot, reviewOutDir)) : null,
      reviewedHead: doReview ? (reviewObj?.input?.head ?? null) : null,
      ...(commitFailure ? { commitFailure } : {}),
      ...(outOfScopeFiles.length > 0 ? { outOfScope: outOfScopeFiles } : {}),
      rosterMismatch,
      ...(rosterDiff ? { rosterDiff } : {}),
      coordinatorTurns: null,
      harness,
      lifecycle: 'lifecycle.ndjson',
      comparable: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    }

    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    // e. stdout 只印一張收貨摘要（≤ 25 行）
    const receiptLines = buildReceiptSummaryLines(summary, reviewMembers, summaryPath)
    console.log(receiptLines.join('\n'))

    // write exit 2（守門擋下、寫手沒起跑）⇒ run 也回 2，與寫手的碼一致（summary 已寫）。
    if (!reviewOnly) {
      if (writeExit === 2) return 2
      // 🔴 2026-09-13 事故：寫手第 1 輪被拒（write exit 3、改動 0 檔）run 仍 exit 0 假綠；陽性對照 ticket.test.mjs「T19 writeMain 回 3、changed 空 ⇒ run 回 3（陽性對照：把第 1 點拿掉就回 0）」；停止條件：run 流程改為事件驅動狀態機且能原生傳播子程序 exit code 時重審
      if (writeExit !== 0) return 3
    }
    // 🔴 2026-09-13 事故：模板票 verify 紅（exit 1）run 仍 exit 0 假綠；陽性對照 ticket.test.mjs「T20 changed 非空、runTest 回 exit 1 ⇒ run 回 3」；停止條件：run 流程改為事件驅動狀態機且能原生傳播驗收 exit code 時重審
    if (verifyExit !== null && verifyExit !== 0) return 3
    // 1.26.0：越界檔／送審前 commit 失敗 ⇒ 沒有複審、也不能 land ⇒ 3（陽性對照 ticket.test.mjs「1.26.0 ticket 送審前 commit」(b)）。
    if (outOfScopeFiles.length > 0 || commitFailure) return 3
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

    const gate = loadAndGateSummary({
      sub: 'publish',
      worktree,
      outDir,
      summaryPath,
      allowNoChanges: false,
      changedFilesFn,
      outBaseDir,
      gitFn,
    })
    if (!gate.ok) return gate.code

    const summary = gate.summary
    const summaryChanged = gate.summaryChanged

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

    // 🔴 1.26.0 r2（codex R2／agy R3）：新流程（summary.commits 非空，run 已在送審前 commit）publish 綁定受審的 SHA——
    //   工作樹必須乾淨、目前 HEAD 必須等於最新一輪複審 input.json 的 head，任一不符 ⇒ 拒絕（exit 2）、不 add／commit／push。
    //   （以前用 currentFiles.length > 0 判斷走舊流程，新流程工作樹髒了會默默 commit 未審內容；amend／reset 後再 commit 也會被當成已審。）
    //   舊流程（summary 無 commits）照舊：publish 自己 add／commit。
    //   陽性對照 ticket.test.mjs「1.26.0 r2 R2／R3」（拿掉 ⇒ amend 後、弄髒後 publish 仍走到 push／commit）。
    const newFlow = Array.isArray(summary.commits) && summary.commits.length > 0
    if (newFlow) {
      if (gate.currentFiles.length > 0) {
        console.error(`🔴 publish：送審後工作樹不乾淨，拒絕（不 commit、不 push）：${gate.currentFiles.join(', ')}`)
        return 2
      }
      const latest = latestReviewDir(outDir)
      let reviewedHead = null
      try {
        reviewedHead = latest ? JSON.parse(fs.readFileSync(path.join(latest, 'input.json'), 'utf8')).head : null
      } catch {
        reviewedHead = null
      }
      let curHead = null
      try {
        curHead = gitFn(worktree, ['rev-parse', 'HEAD'])
      } catch {
        curHead = null
      }
      if (!reviewedHead || !curHead || curHead !== reviewedHead) {
        console.error(`🔴 publish：HEAD（${curHead}）≠ 最新一輪複審的 input.json.head（${reviewedHead}），拒絕（受審之後被 amend／reset／再 commit？）`)
        return 2
      }
      // 🔴 1.26.1（T2b-v2，codex r2）：HEAD 對了還不夠——受審後可以在分支上再 commit 一個未審的 U，再 detached checkout 回受審的 R，
      //   HEAD 檢查會過，但 `git push origin <branch>` 推的是指向 U 的分支 ref。所以同時要求【分支 ref】等於受審 head；推送也只推 HEAD（見下）。
      //   陽性對照 ticket.test.mjs「1.26.1 R2」（拿掉本段 ⇒ 分支指向 U、HEAD 在 R 時 publish 仍會往下走）。
      let branchSha = null
      try {
        branchSha = gitFn(worktree, ['rev-parse', `refs/heads/${summary.branch}`])
      } catch {
        branchSha = null
      }
      if (!branchSha || branchSha !== reviewedHead) {
        console.error(`🔴 publish：分支 refs/heads/${summary.branch}（${branchSha}）≠ 最新一輪複審的 input.json.head（${reviewedHead}），拒絕（受審之後分支被推進／改指？）`)
        return 2
      }
      // 🔴 1.26.2（T2b-v2 r2，codex R1）：summary 必須和最新一輪複審是【同一代】——summary.reviewDir＝最新 review-r<N>、summary.reviewedHead＝該目錄 input.json.head。
      //   （新一輪在重寫 summary 前中斷時，磁碟上的 summary 是舊輪的：舊 verdict／Q6／dispositions 不得配新輪的 input／members 推出新 commit。）
      //   陽性對照 ticket.test.mjs「1.26.2 R1」（拿掉本段 ⇒ 手放回舊輪已 accept 的 summary 時 publish 仍往下走）。
      const latestRel = latest ? toPosix(path.relative(repoRoot, latest)) : null
      if (!summary.reviewDir || summary.reviewDir !== latestRel || !summary.reviewedHead || summary.reviewedHead !== reviewedHead) {
        console.error(`🔴 publish：summary 不是最新一輪複審的同一代（summary.reviewDir=${summary.reviewDir ?? 'null'}、最新=${latestRel}；summary.reviewedHead=${summary.reviewedHead ?? 'null'}、input.json.head=${reviewedHead}），拒絕（上一輪被中斷？重跑 run 並重新 accept）`)
        return 2
      }
    }
    if (!newFlow) {
      // git add -- <summary.changed 逐一>
      gitFn(worktree, ['add', '--', ...summaryChanged])
      // git commit
      gitFn(worktree, ['commit', '-m', title])
    }
    // git push
    // 🔴 1.26.1：明確的 refspec——只推 HEAD（新流程已驗 HEAD＝分支 ref＝受審 head），不依賴「分支名」去解析成哪個 commit。
    gitFn(worktree, ['push', '-u', 'origin', `HEAD:refs/heads/${summary.branch}`])

    // 組 pr-body.md
    const reviewOutDir = latestReviewDir(outDir) || path.join(outDir, 'review')
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

  if (sub === 'land') {
    // 🔴 1.24.0（fable 10-03 重判 N2）：合併只剩一個入口。以前 ticket land 自己 add／commit／rebase／merge --ff-only，
    //   與 WAS 的 tools/land.mjs（唯一合併口，帶收據與環境守門）並存兩條路，繞過後者的檢查只要選這條。
    //   現在 land 一律 exit 2、不碰任何 git（main 不動）；要合併走 `node tools/land.mjs --branch … --name … --msg-file …`。
    //   陽性對照 ticket.test.mjs「1.24.0 land ⇒ 2、main HEAD 不變、無任何 git 寫入」（把這段換回舊實作 ⇒ 該測試紅）。
    //   停止條件：沒有 tools/land.mjs 的專案（無唯一合併口）若要用 ticket 自行合併，需另開票設計，不是恢復這段。
    console.error(
      '🔴 ticket.mjs land 已停用（llm-team 1.24.0）：合併唯一入口＝在 main 執行 node tools/land.mjs --branch <分支> --name <票名> --msg-file <commit 訊息檔>；ticket 不再自行 merge。'
    )
    return 2
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

    const reviewOutDir = latestReviewDir(outDir) || path.join(outDir, 'review')
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
      console.error('用法：accept --name <n> --q6 "<receipt>" [--caliber <docs|tool|feature>]（usage.mode≠off 時必填）[--disposition <member>:<Qn|overall>=<rejected|confirmed-fixed>:"<note>"]...')
      return 2
    }
    if (!a.q6 || !String(a.q6).trim()) {
      console.error('🔴 accept：--q6 必填且不可為空')
      return 2
    }
    // 🔴 1.8.0：量測與 Q6 閘門解耦——usage.mode 預設 off，--caliber 只在 mode≠off 時必填；
    //   off 時給了也接受（寫進 summary）但不強制。陽性對照 ticket.test.mjs「(h) mode=off 缺 caliber ⇒ 0」「(h2) mode=cohort 缺 caliber ⇒ 2」。
    const validCalibers = ['docs', 'tool', 'feature']
    const usageMode = (config.usage && config.usage.mode) || 'off'
    let caliberValue = null
    if (a.caliber !== undefined) {
      caliberValue = String(a.caliber).trim()
      if (!validCalibers.includes(caliberValue)) {
        console.error('🔴 accept：--caliber 只准 docs｜tool｜feature')
        return 2
      }
    }
    if (usageMode !== 'off' && !caliberValue) {
      console.error(`🔴 accept：usage.mode=${usageMode} 時 --caliber 必填（docs｜tool｜feature）`)
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

    if (caliberValue) {
      summary.caliber = caliberValue
      summary.caliberBy = 'coordinator'
    }
    // 🔴 1.8.0 ②：measurementSchemaVersion 蓋當下量測方法版本（與 --caliber 是否必填無關）；
    //   cohort 只收版本相符的票，避免視窗規則改版後新舊算法混在同一批統計裡。
    summary.measurementSchemaVersion = MEASUREMENT_SCHEMA_VERSION
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
