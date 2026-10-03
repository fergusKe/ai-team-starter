#!/usr/bin/env node
// ─────────────────── 規劃／複審會議（依統整者 profile 派複審者） ───────────────────
// 用法（`--coordinator` 必帶，或設 env LLM_TEAM_COORDINATOR）：
//   規劃：node .agents/skills/llm-team/council.mjs plan   --coordinator <claude|agy|codex> --prompt <file> --out <dir> [--tier standard|block] [--config <file>]
//   複審：node .agents/skills/llm-team/council.mjs review --coordinator <claude|agy|codex> --worktree <abs> --base <sha> --brief <file> --out <dir> --tier standard|block|postreview [--writer-report <file>] [--review-only] [--diff-cap <字元數>] [--config <file>]（注意：postreview 必須搭配 --review-only 使用）
// 🔴 1.13.0 finding 要引用：事故 2026-09-20 cron-ledger-platform-drift sol Q3 不簽無引用；陽性對照 llm-team.test.mjs「1.13.0 council：finding 要引用；parseVerdicts 標出無引用的不簽」。
// 🔴 1.12.0 diff 不截斷（codex＋Gemini 兩輪一致選 B）：截斷的 diff 上「簽」不是整份簽核，一行警告修不了 overall=簽 的語意。
//   超過 --diff-cap（預設 120000 字元＝完整送審上限）⇒ 在呼叫複審者【之前】停：members.json 寫 []、input.json 記 diff_over_cap、回 6。
//   下一步是拆票，或確認後 --diff-cap N 重跑（N 入帳：input.json capOverridden、summary、收貨摘要都印）。
//   每次 review 都寫 review/input.json（diffLength、diffCap、capOverridden、reviewInvoked、writerReport 截斷）；舊快照沒這檔＝unknown，不是「沒截斷」。
//
// 🔴 2026-09-14 三方定案（schema v2）：
//   · 成員名單來自 config.profiles.<coordinator>：一般票 reviewers、block 票 blockReviewers（沒有 --codex 旗標、沒有 codexTier）。
//   · 統整者與每位複審者不同 quotaBucket（不變式在 lib.mjs validateProfiles）。
//   · codex 扣得快：每票最多 2 輪 ＋ 1 次釐清；超過回統整者。
// 🔴 複審者都是【唯讀】：agy `--mode plan`、codex `--sandbox read-only`。它們的回覆不構成授權。
// 🔴 M1 8 GB：預設並行但可 --sequential。
// 🔴 agy 無頭：提示以 NO_EXEC_HEADER 開頭（否則它想跑指令 ⇒ 自動拒絕 ⇒ 零輸出）；codex 讀得到檔，不加；
//   gemini 1.19.0 起也不加（plan 模式唯讀、讀檔工具可用）。這件事由各 harness 自己的 review.args 預設決定，council 不傳。
// 🔴 提示第一行是哨兵（REVIEW_PROMPT_SENTINEL／PLAN_PROMPT_SENTINEL）：codex 從 cwd 讀得到 AGENTS.md，薄索引靠它判「我是複審者」。
// 🔴 輸出除了 <成員>.txt，還有 members.json（實際跑的成員身分三元組＋結果）——ticket run／publish 只認它（2026-09-14 codex 複審 Q5）。

import fs from 'node:fs'
import path from 'node:path'
import {
  loadConfig,
  modelsFrom,
  memberFileName,
  // 1.19.0：NO_EXEC_HEADER 不再從這裡引用（runOne 不傳 noExecHeader，各 harness 用自己的預設）；常數本身仍在 lib.mjs 給 agy 用。
  REVIEW_PROMPT_SENTINEL,
  PLAN_PROMPT_SENTINEL,
  git,
  ledgerAppend,
  parseArgs,
  isDirectRun,
  REVIEW_TIERS,
  TIER_LIST_KEY,
} from './lib.mjs'
import { getHarness } from './harnesses/index.mjs'

export function buildReviewQuestions(riskDomains = []) {
  const tail = '若 diff【新增】了會變紅的閘門：有沒有引用本 repo 真實事故＋可重現的陽性對照＋停止條件？沒有 ⇒ 不簽。'
  const q4 =
    riskDomains && riskDomains.length
      ? `Q4 ${riskDomains.join('／')} 有沒有被碰到？碰到的話是不是 block 級、有沒有對應守門？${tail}`
      : `Q4 ${tail}`

  return [
    '【請逐項判，每題一行「Qn：簽／不簽｜一句理由｜要改什麼｜引用」。不簽、或指出任何問題（finding）時「引用」必填：diff 裡的 檔名:行號（工作樹行號，可多個），或你跑過的指令與輸出摘要（receipt）。沒有引用的 finding 統整者不納入結論。簽的題「引用」可留空。最後一行「整份：簽／不簽」。不要寫別的。】',
    'Q1 diff 是否只做 brief 要求的事？有沒有 brief 外的改動（順手重構、改到別的檔、改守門）？',
    'Q2 有沒有 fail-open：錯誤被吞、預設放行、空集合恆真的斷言、toBeGreaterThan 這類下界斷言？',
    'Q3 測試量的是不是「這次的變更」？有沒有陽性對照（把修法拿掉會不會紅、紅在哪一條）？',
    q4,
    'Q5 有沒有「作者以為是契約其實是實作細節」的假設（讀了實作當契約）？',
    'Q6 你認為統整者在 merge 前【必須】親自坐實的一件事是什麼？（只准一件）',
  ].join('\n')
}

export const REFUTE_SENTENCE = '你沒寫這份改動，也看不到統整者怎麼想；你的任務是設法推翻它——找出哪個輸入、哪個狀態轉移會讓它錯。推翻不了才簽。'

export function buildReviewPrompt({ brief, diff, tier, diffStat, writerModel, riskDomains = [], roundStart, cumulative, writerReport, reviewOnly = false }) {
  if (!writerModel) throw new Error('buildReviewPrompt 需要 writerModel（來自 config.writer.model）')
  let roleSentence
  if (tier === 'postreview') {
    roleSentence = `你是本 repo 的複審者（事後批次複審）。這些改動已經合進 main，你沒有作者的對話脈絡，只看下面的 brief 與 diff。本輪的產出用途是找出該開修正票或該 revert 的缺陷，不會退回原票重做。Q3 的要求與 review-only 同性質，只判 diff 裡的測試是否量到這次變更、陽性對照的設計對不對，不得以「作者沒交陽性對照證據」當不簽理由。`
  } else {
    roleSentence = `你是本 repo 的複審者（${tier === 'block' ? 'block 級' : '一般票'}）。作者是另一個模型（${writerModel}），你沒有它的對話脈絡，只看下面的 brief 與 diff。`
  }
  // 🔴 1.22.0 隔離上下文（借自 cloudflare/security-audit-skill 的驗證者）：任務是【推翻】，不是確認。
  //   複審者可能跟統整者是同一個模型——獨立性來自它看不到統整者的對話與傾向，所以要明說：預設立場是找錯，
  //   「不簽」只認具體的檔名:行號或指令輸出（下面判準本來就要求引用）。陽性對照 llm-team.test.mjs「1.22.0 prompt 含推翻句」。
  roleSentence += REFUTE_SENTENCE
  const sections = [
    REVIEW_PROMPT_SENTINEL,
    roleSentence,
    '',
    '【brief（作者拿到的原文）】',
    brief,
    '',
  ]

  if (roundStart) {
    const mb = (cumulative && cumulative.mergeBase) || ''
    const stat = (cumulative && cumulative.stat) || ''
    sections.push(
      `【本輪範圍】本輪 diff 起點 ${roundStart}（此 sha → 工作樹）。下面【累計 stat】是自 merge-base ${mb} 起整張票所有輪的檔案清單——它對應的是各輪 brief 准動清單的【聯集】，前幾輪 brief 准動而本輪 brief 沒列的檔會在裡面，不是越界；本輪 brief 的准動清單只約束本輪 diff。main 上別人的 commit 不在這兩份裡。`,
      '【累計 stat（自 merge-base）】',
      stat,
      '',
    )
  }

  sections.push(
    '【git diff --stat】',
    diffStat,
    '',
    '【git diff（可能截斷）】',
    '```diff',
    diff,
    '```',
    '',
  )

  if (reviewOnly) {
    sections.push(
      '【review-only：本輪沒有寫手、沒有寫手回報】',
      '這棵樹是統整者對已提交的分支叫的重新複審。Q3 只判 diff 裡的測試是否量到這次變更、陽性對照的設計對不對（拿掉哪段修法、哪條斷言該紅）；「作者沒交陽性對照證據」不構成不簽理由。執行證據由統整者在 Q6 親跑並入帳（accept --q6），Q6 照常要求。',
      '',
    )
  } else if (writerReport !== null && writerReport !== undefined) {
    sections.push(
      '【寫手最後回報（作者自述，不是證據）】',
      '它宣稱跑過的陽性對照（哪條測試紅在哪條斷言）只能拿來對照 diff：宣稱紅的那條斷言在不在 diff 的測試裡、拿掉的修法是不是 diff 裡的那段。對不上 ⇒ Q3 不簽並指出對不上的地方；對得上仍要求統整者 Q6 親跑。',
      writerReport || '（寫手回報為空——write.mjs 失敗分支或寫手沒交回報）',
      '',
    )
  }

  sections.push(buildReviewQuestions(riskDomains))

  return sections.join('\n')
}

/**
 * 跑一位成員。派工只查 registry：`getHarness(member.harness).review.run(...)`——各 harness 自己決定唯讀姿態
 * （agy `--mode plan`＋NO_EXEC_HEADER、codex `--sandbox read-only`＋effort、gemini `--approval-mode plan`、1.19.0 起不加 NO_EXEC_HEADER）
 * 與回覆正文的取法（統一形狀的 `text`）。canReview:false 的 harness（registry 裡沒有 review 介面）⇒ throw。
 * 1.22.0 起 claude 也有 review 介面（全新無頭行程＝隔離上下文，見 harnesses/claude.mjs 檔頭）。
 * deps.getHarness 是測試接縫（注入假 harness）；deps.env／deps.spawn／deps.resolveGeminiApiKey 原封轉傳給 review.run。
 * 輸出檔名用 memberFileName（agy/gemini ⇒ agy-gemini.txt）。
 */
async function runOne(member, prompt, cwd, outDir, timeoutMs, deps = {}) {
  const started = Date.now()
  const getHarnessFn = deps.getHarness || getHarness
  const { name, model, harness } = member
  const h = getHarnessFn(harness)
  if (!h.canReview) {
    throw new Error(`council 不派 harness=${harness}（成員 ${name}）：${harness} 沒有 review 介面（canReview:false）`)
  }
  // 🔴 r3：resolveKey 一併轉傳（deps.resolveGeminiApiKey 是測試接縫；undefined 時 harness 走自己的預設值）。
  // 🔴 1.19.0：`noExecHeader` 這裡【不傳】——唯讀姿態由各 harness 自己決定，council 不替它們決定：
  //   · agy：自己的預設就是 NO_EXEC_HEADER（`harnesses/agy.mjs`；2026-09-13 實測，無頭模式工具被拒 ⇒ stdout 空、exit 仍 0）。
  //   · gemini：1.19.0 起預設是空字串（`harnesses/gemini.mjs`；`--approval-mode plan` 本來就唯讀、讀檔工具可用，
  //     2026-09-23 真跑對照：不加那句才答得出 `docs/WBS.md` 934 行、`## 1.8` 段 30 列）。
  //   · codex：不收這個參數（從 cwd 讀得到 AGENTS.md，本來就不加）。
  //   從前這裡無條件傳 NO_EXEC_HEADER，等於蓋掉每個 harness 的預設——gemini 改了預設也沒用（no-op）。
  const r = await h.review.run({
    model,
    prompt,
    cwd,
    timeoutMs,
    effort: member.effort,
    env: deps.env,
    spawn: deps.spawn,
    resolveKey: deps.resolveGeminiApiKey,
  })
  const timedOut = r.timedOut === true
  const text = timedOut ? '' : r.text || ''
  const file = memberFileName(name)
  fs.writeFileSync(path.join(outDir, `${file}.txt`), text)
  fs.writeFileSync(path.join(outDir, `${file}.stderr.txt`), r.stderr || '')
  const empty = timedOut || !text.trim()
  return {
    name,
    model,
    harness,
    quotaBucket: member.quotaBucket,
    exit: r.exit ?? null,
    signal: r.signal || null,
    timedOut,
    ms: Date.now() - started,
    empty,
    denied: r.denied || [],
    // 1.16.0：統一形狀的 failure 原樣帶出（codex 額度用盡的 stderr 以前只顯示「零輸出」）；既有欄位字面不變。
    failure: r.failure || null,
    text,
  }
}

export const CITATION_RE = /[^\s「」()（）]+\.[A-Za-z0-9]{1,6}:\d+|`[^`]*[^`\s][^`]*`/

export function parseVerdicts(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const q = {}
  const uncited = []
  let overall = null
  for (const l of lines) {
    const m = l.match(/^(Q\d+|P\d+)[：:]\s*(簽|不簽)/)
    if (m) {
      q[m[1]] = m[2]
      if (m[2] === '不簽' && !CITATION_RE.test(l)) {
        uncited.push(m[1])
      }
    }
    const o = l.match(/整份[：:]\s*\**\s*(簽|不簽)/)
    if (o) overall = o[1]
  }
  return { q, overall, uncited }
}

export async function main(argv, deps = {}) {
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
    const worktreeRoot = path.resolve(targetDir, gitFn(targetDir, ['rev-parse', '--show-toplevel']))
    const loadCfg = deps.loadConfig || loadConfig
    config = loadCfg(worktreeRoot, a.config)
  } catch (e) {
    console.error(`🔴 config 載入失敗：${e.message}`)
    return 2
  }

  // 🔴 --coordinator 必帶（或 env LLM_TEAM_COORDINATOR）：名單由 profile 決定，缺 ⇒ exit 2 並列出可用 profiles。
  const env = deps.env || process.env
  let models
  try {
    models = modelsFrom(config, env, typeof a.coordinator === 'string' ? a.coordinator : null)
  } catch (e) {
    console.error(`🔴 ${e.message}`)
    return 2
  }

  fs.mkdirSync(outDir, { recursive: true })
  // deps.runOne 是測試接縫：維持 (name, model, prompt, cwd, outDir, timeoutMs, member) 形狀，member 是第 7 個參數。
  const run = deps.runOne
    ? (member, prompt, cwd, outDir, timeoutMs) => deps.runOne(member.name, member.model, prompt, cwd, outDir, timeoutMs, member)
    : (member, prompt, cwd, outDir, timeoutMs) => runOne(member, prompt, cwd, outDir, timeoutMs, deps)
  const timeoutMs = Number(a['timeout-ms'] || 8 * 60 * 1000)
  let prompt
  let cwd = process.cwd()

  let tier = 'standard'
  if (a.tier !== undefined) {
    if (!REVIEW_TIERS.includes(a.tier)) {
      console.error(`🔴 --tier "${a.tier}" 不支援，可用值：${REVIEW_TIERS.join('、')}`)
      return 2
    }
    tier = a.tier
  }

  if (sub !== 'review' && tier === 'postreview') {
    console.error(`🔴 --tier postreview 只准用在 review 子指令`)
    return 2
  }

  if (tier === 'postreview' && a['review-only'] !== true) {
    console.error(`🔴 --tier postreview 必須與 --review-only 一起使用（事後審沒有寫手、沒有回審迴圈）`)
    return 2
  }

  const members = models[TIER_LIST_KEY[tier]]

  if (sub === 'plan') {
    if (!a.prompt) return usage()
    prompt = PLAN_PROMPT_SENTINEL + '\n' + fs.readFileSync(a.prompt, 'utf8')
  } else if (sub === 'review') {
    if (!a.worktree || !a.base || !a.brief) return usage()
    cwd = path.resolve(a.worktree)
    const reviewOnly = a['review-only'] === true
    const roundStart = a['round-start'] || null
    const startPoint = roundStart || a.base
    const untracked = gitFn(cwd, ['ls-files', '--others', '--exclude-standard'])
    const untrackedFiles = untracked.split('\n').filter(Boolean).filter((f) => !f.startsWith('.agy-write/'))
    let cumulative = null
    if (roundStart) {
      const mergeBase = gitFn(cwd, ['merge-base', a.base, 'HEAD'])
      let cumulativeStat = gitFn(cwd, ['diff', '--stat', mergeBase])
      // 🔴 2026-09-15 lt15-round-diff r1 複審（sol Q2）：累計 stat 若只用 git diff --stat，寫手新增的越界 untracked 檔對 Q1 隱形（fail-open）；本輪 diff 早就接了 untracked，累計也要。
      const untrackedLines = untrackedFiles.map((f) => ` ${f} | 新檔（未追蹤）`)
      if (untrackedLines.length > 0) {
        cumulativeStat = (cumulativeStat ? cumulativeStat + '\n' : '') + untrackedLines.join('\n')
      }
      cumulative = { mergeBase, stat: cumulativeStat }
    }
    const diffStat = gitFn(cwd, ['diff', '--stat', startPoint])
    let diff = gitFn(cwd, ['diff', startPoint])
    for (const f of untrackedFiles) {
      diff += `\n--- /dev/null\n+++ b/${f}\n` + fs.readFileSync(path.join(cwd, f), 'utf8').split('\n').map((l) => '+' + l).join('\n')
    }
    const DEFAULT_DIFF_CAP = 120000
    const cap = Number(a['diff-cap'] || DEFAULT_DIFF_CAP)
    if (!Number.isInteger(cap) || cap <= 0) {
      console.error(`🔴 --diff-cap 要是正整數字元數，不是「${a['diff-cap']}」`)
      return 2
    }
    let writerReport = null
    let writerReportTruncated = null
    if (a['writer-report']) {
      const rawReport = fs.readFileSync(a['writer-report'], 'utf8')
      const reportCap = 20000
      if (rawReport.length > reportCap) {
        writerReport = rawReport.slice(0, reportCap) + `\n…（截斷，原長 ${rawReport.length} 字元）`
        writerReportTruncated = { originalLength: rawReport.length, cap: reportCap }
      } else {
        writerReport = rawReport
      }
    }
    // review/input.json：複審者到底看了什麼。長度是 JS String.length（UTF-16 code unit），不是 byte 也不是嚴格字元數。
    const inputInfo = {
      schemaVersion: 1,
      diffLength: diff.length,
      diffCap: cap,
      defaultDiffCap: DEFAULT_DIFF_CAP,
      capOverridden: cap !== DEFAULT_DIFF_CAP,
      reviewInvoked: diff.length <= cap,
      status: diff.length <= cap ? 'ok' : 'diff_over_cap',
      writerReportTruncated,
    }
    fs.writeFileSync(path.join(outDir, 'input.json'), JSON.stringify(inputInfo, null, 2))
    if (!inputInfo.reviewInvoked) {
      fs.writeFileSync(path.join(outDir, 'members.json'), '[]')
      console.error(
        `🔴 diff ${diff.length} 字元超過完整送審上限 ${cap}（--diff-cap）——複審者沒有被呼叫，這張票沒有複審。` +
          `下一步：拆票；或確認過內容後 --diff-cap ${diff.length} 重跑（會入帳、收貨摘要會印）。`
      )
      return 6
    }
    prompt = buildReviewPrompt({
      brief: fs.readFileSync(a.brief, 'utf8'),
      diff,
      tier,
      diffStat,
      writerModel: models.writer.model,
      riskDomains: config.riskDomains || [],
      roundStart,
      cumulative,
      writerReport,
      reviewOnly,
    })
  } else return usage()

  if (members.length === 0) {
    let extraMsg = ''
    if (tier === 'postreview') {
      extraMsg = `（在 llm-team.config.json 的 profiles.${models.coordinator.profile} 加 postReviewers）`
    }
    console.error(`🔴 沒有任何複審者（profile ${models.coordinator.profile} 的 ${TIER_LIST_KEY[tier]} 空）${extraMsg}`)
    return 2
  }

  fs.writeFileSync(path.join(outDir, 'prompt.md'), prompt)

  const heartbeatMs = deps.heartbeatMs || (a['heartbeat-ms'] ? Number(a['heartbeat-ms']) : 60 * 1000)
  const startTime = Date.now()
  const memberStatus = members.map(({ name }) => ({
    name,
    done: false,
    durationMs: 0,
  }))

  let heartbeatTimer = null
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      const now = Date.now()
      const parts = memberStatus.map((s) => {
        if (s.done) {
          return `${s.name} 已完成 ${Math.round(s.durationMs / 1000)}s`
        } else {
          return `${s.name} ${Math.round((now - startTime) / 1000)}s`
        }
      })
      console.error(`⏳ 等待中：${parts.join('｜')}`)
    }, heartbeatMs)
    if (heartbeatTimer.unref) heartbeatTimer.unref()
  }

  let rows
  try {
    if (a.sequential) {
      rows = []
      for (let i = 0; i < members.length; i++) {
        const m = members[i]
        const r = { harness: m.harness, quotaBucket: m.quotaBucket, ...(await run(m, prompt, cwd, outDir, timeoutMs)) }
        memberStatus[i].done = true
        memberStatus[i].durationMs = Date.now() - startTime
        rows.push(r)
      }
    } else {
      const promises = members.map(async (m, i) => {
        const r = { harness: m.harness, quotaBucket: m.quotaBucket, ...(await run(m, prompt, cwd, outDir, timeoutMs)) }
        memberStatus[i].done = true
        memberStatus[i].durationMs = Date.now() - startTime
        return r
      })
      rows = await Promise.all(promises)
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  }

  for (let i = 0; i < members.length; i++) {
    const { name, model } = members[i]
    const r = rows[i]
    // 🔴 事故：2026-09-13 票 E 第 4 輪 opus 785 秒、串行等 15 分無輸出；陽性對照：llm-team.test.mjs「council timeout 到期：假 runOne 回 signal: SIGTERM ⇒ 表格印 不簽（timeout）、exit 非 0」；停止條件：agy 自己回報「模型忙碌」事件、能立即失敗那天，本判定改成讀該事件。
    const isTimeout = r.timedOut === true
    const isAborted = !isTimeout && Boolean(r.signal)
    const v = isTimeout
      ? { q: {}, overall: '不簽（timeout）', uncited: [] }
      : (isAborted
        ? { q: {}, overall: '不簽（被中止）', uncited: [] }
        : parseVerdicts(r.text || ''))
    r.verdicts = v
    if (isTimeout || isAborted) {
      r.empty = true
      r.exit = null
    }
    ledgerAppend(path.join(outDir, 'ledger.ndjson'), {
      schemaVersion: 2,
      tool: 'llm-team-council',
      sub,
      coordinator: models.coordinator.profile,
      tier,
      name,
      model,
      harness: r.harness,
      quotaBucket: r.quotaBucket,
      exit: r.exit,
      signal: r.signal,
      ms: r.ms,
      empty: r.empty,
      denied: r.denied,
      overall: v.overall,
    })
  }

  // 🔴 members.json：【實際跑的】成員（身分三元組來自 members[i]，不是 runner 回報的字串）＋結果。
  //    ticket run 只從這份取名單、publish 回頭讀這份比對三元組（codex 複審 Q5-IDENTITY；helpers 在 lib.mjs §複審名單身分三元組）。
  //    invalid ＝ 有輸出但抓不到「整份：簽／不簽」那行（格式不合、不算簽）。
  const membersOut = members.map((m, i) => {
    const r = rows[i]
    return {
      name: m.name,
      harness: m.harness,
      model: m.model,
      quotaBucket: m.quotaBucket,
      overall: r.verdicts.overall,
      q: r.verdicts.q,
      uncited: r.empty === true || r.timedOut === true ? [] : (r.verdicts.uncited || []),
      empty: r.empty === true,
      timedOut: r.timedOut === true,
      invalid: r.empty !== true && r.verdicts.overall === null,
      exit: r.exit ?? null,
      signal: r.signal || null,
      ms: r.ms ?? null,
      failure: r.failure || null,
    }
  })
  fs.writeFileSync(path.join(outDir, 'members.json'), JSON.stringify(membersOut, null, 2))

  // 摘要表：空輸出要顯眼——「沒話說」與「被拒」同形，都不算簽。
  console.log(`| 成員 | model | exit | 秒 | 整份 | 逐題 |`)
  console.log(`|---|---|---|---|---|---|`)
  let anyEmpty = false
  for (const r of rows) {
    anyEmpty ||= r.empty
    const per = Object.entries(r.verdicts.q)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    const overallDisplay = r.timedOut === true
      ? '不簽（timeout）'
      : (r.signal
        ? '不簽（被中止）'
        : (r.empty ? '🔴 零輸出' : r.verdicts.overall || '?'))
    console.log(`| ${r.name} | ${r.model} | ${r.exit} | ${Math.round(r.ms / 1000)} | ${overallDisplay} | ${per} |`)
  }
  console.log(`\n輸出：${outDir}/{${rows.map((r) => memberFileName(r.name)).join(',')}}.txt＋members.json`)
  return anyEmpty ? 3 : 0
}

function usage() {
  console.error('用法見檔頭。')
  return 2
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
