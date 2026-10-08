#!/usr/bin/env node
// ─────────────────── 規劃／複審會議（依統整者 profile 派複審者） ───────────────────
// 用法（`--coordinator` 必帶，或設 env LLM_TEAM_COORDINATOR）：
//   規劃：node .agents/skills/llm-team/council.mjs plan   --coordinator <claude|agy|codex> --prompt <file> --out <dir> [--tier standard|block] [--config <file>]
//   複審：node .agents/skills/llm-team/council.mjs review --coordinator <claude|agy|codex> --worktree <abs> --base <sha> --brief <file> --out <dir> --tier standard|block|postreview [--writer-report <file>] [--review-only] [--diff-cap <字元數>] [--prior-out <dir>]… [--allow-prior-quote] [--include-writer-report] [--segment <i/n>] [--require-clean] [--config <file>]（注意：postreview 必須搭配 --review-only 使用）
// 🔴 1.13.0 finding 要引用：事故 2026-09-20 cron-ledger-platform-drift sol Q3 不簽無引用；陽性對照 llm-team.test.mjs「1.13.0 council：finding 要引用；parseVerdicts 標出無引用的不簽」。
// 🔴 1.12.0 diff 不截斷（codex＋Gemini 兩輪一致選 B）：截斷的 diff 上「簽」不是整份簽核，一行警告修不了 overall=簽 的語意。
//   超過 --diff-cap（預設 120000 字元＝完整送審上限）⇒ 在呼叫複審者【之前】停：members.json 寫 []、input.json 記 diff_over_cap、回 6。
//   下一步是拆票，或確認後 --diff-cap N 重跑（N 入帳：input.json capOverridden、summary、收貨摘要都印）。
//   每次 review 都寫 review/input.json（diffLength、diffCap、capOverridden、reviewInvoked、writerReport 截斷）；舊快照沒這檔＝unknown，不是「沒截斷」。
//
// 🔴 1.27.0 送審包盲化＋第 2 輪 brief 查重（《Loop × Harness》課程整合票 1；docs/consultations/2026-10-09-loop-harness/ruling.md「fable 裁定」第 5、3 點）。
//   依據：課程 p195（驗證者不該看到被驗證者的自述，否則被錨定）；GPT、Gemini 兩家諮詢各自獨立提出同一條；fable 10-09 裁定。
//   1. 盲化：review 預設【不】把 --writer-report 內容放進審查 prompt（檔案仍原文複製到 <out>/writer-report.md 給統整者 Q6 用）；
//      Q3 題文一律改用 review-only 那段（只判 diff 裡的測試量到沒、陽性對照設計對不對；沒交證據不構成不簽理由）。
//      逃生口 --include-writer-report（舊行為），入 input.json.includeWriterReport／writerReport.included。
//   2. r2 查重（r2 起只報告、不擋，exit 0、審查席照常呼叫）：本輪（--out 尾碼 -r<N>，N≥2；或明給了 --prior-out ⇒ 至少 r2）brief 的雜湊與任一【前輪】
//      input.json 的 briefSha256／briefNormSha256 相同，或 brief 沒有非空的 this_round_delta 欄位（TEMPLATES §6.1 欄位名，只認行首欄位格式）
//      ⇒ stdout 警告、input.json.briefDedup 記 sameAs／roundDeltaMissing。沒有 --allow-same-brief（不擋就不需要覆寫旗標）。
//      🔴 只比跨輪：輪次（目錄名 -r<N>，或前輪 input.json.round）≥ 本輪的目錄（同輪各 --segment 段）不比；輪次不明者照比，不因 segment.of 相同就跳過。
//      明給 --prior-out 時本輪至少 2；目錄名解析出 r0／r1 與之矛盾 ⇒ 記 roundConflict、以 ≥2 處理。
//      為什麼只報告：本 repo 目前沒有「重送同一份 brief」的真實事故，MAINTENANCE「寫不出事故就先只報告不擋」。
//      停止條件／升級條件：累積到第一次真實重送事故（r2 重送 r1 brief 造成空轉或誤簽）後，把查重與缺 delta 升為 exit 2（並補逃生旗標）。
//   3. 自述詞警告：brief 含「寫手宣稱／寫手說／作者表示／寫手回報」⇒ 只印警告、記 input.json.selfReportWarning，不擋（無事故前只報告）。
//   陽性對照（llm-team.test.mjs「1.27.0」）：拿掉盲化 ⇒ (a1) 紅；拿掉查重／缺 delta 記錄 ⇒ (b1)(b1b)(b2)(b4)(b5) 紅；應放行 (c1)–(c4)。
//   停止條件：統整者的審查 brief 改由程式產生（不再手寫）、或寫手自述改走 Q6 專用通道時，本節盲化旗標與查重可撤。
//
// 🔴 1.25.0 input.json v2：記錄「審了哪一棵樹」（WBS 4.7.31 A2 T0；fable 10-03 重判：land 合併前不驗複審證據）。
//   diff 是 `git diff <起點>` 對【工作樹】算的（含未提交與 untracked），事後無法證明審的是哪個 commit；v2 補：
//   schema:2、head、tree、base(完整 sha)、roundStart(ISO 時間)、roundStartSha、dirty(tracked 有未提交改動)、untracked(路徑；排除 gitignored、.agy-write/；--out 事先存在且含檔也算)、
//   diffSha256(送審 diff 原文＝prompt 裡那份，含 untracked 附加段、git() 已去尾端空白)、changedFiles(`git diff --name-only base`)、tier、coordinator、briefSha256、promptSha256、segment({index,of}|null；--segment i/n)。
//   舊欄位（schemaVersion:1、diffLength…）原樣保留。`--require-clean`（預設關）：dirty 或有 untracked ⇒ exit 2、不送審。members.json 每席補 head／diffSha256。
//   陽性對照 llm-team.test.mjs「1.25.0 council input.json v2」(a)–(f)；停止條件：land 改為自己對 commit 重審（不信任 input.json）時本紀錄降為提示。
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
import crypto from 'node:crypto'
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
  memberName,
  FALLBACK_FAILURE_KINDS,
  crossFamilyStatus,
} from './lib.mjs'
import { getHarness } from './harnesses/index.mjs'

// ─────────────────── 1.23.0 brief 不得內嵌前輪審查者的推理（WBS 4.7.29d） ───────────────────
// 🔴 事故：2026-10-03 統整者給 4.7.29a／29b 第二輪寫的追加段，把 codex 第一輪的不簽理由與修法摘要後附在 brief 送審——
//   第二輪審查者雖是新行程，brief 已內嵌自己上一輪的框架，等於在驗自己的建議（fable C5／Q6；
//   docs/consultations/2026-10-03-llm-trust-architecture.md §3 L2-7）。
// 做法：review 預設比對前輪輸出（--prior-out <dir> 可重複；未給＝同 --out 父目錄下去掉 `-r<N>` 尾碼同前綴的其他輪目錄）。
//   前輪各審查者 *.txt（排除 *.stderr.txt）的不簽行，取以「｜」分隔的第 2、3 欄（理由、必要修改）；
//   brief（正規化空白後）含其中任一段 ≥ PRIOR_QUOTE_MIN 字元的連續片段 ⇒ exit 2。
//   brief 只能放 finding ID＋證據 path:line＋預期的決定性檢查。--allow-prior-quote 可覆寫，但入 input.json／ledger／members.json。
// 陽性對照：llm-team.test.mjs「1.23.0 brief 不得內嵌前輪推理」(a)；停止條件：統整者改由程式（而非手寫追加段）產生第二輪 brief 時，本比對可撤。
export const PRIOR_QUOTE_MIN = 30
const sha256 = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex')
const normWs = (t) => String(t).replace(/\s+/g, ' ').trim()

/** 前輪輸出文字 ⇒ 不簽行第 2、3 欄（正規化空白、長度 ≥ PRIOR_QUOTE_MIN）的片段清單。 */
export function extractPriorFragments(text) {
  const out = []
  for (const raw of String(text).split('\n')) {
    const l = raw.trim()
    const m = l.match(/^(Q\d+|P\d+)[：:]\s*\**\s*不簽/)
    if (!m) continue
    const cols = l.split('｜')
    for (const idx of [1, 2]) {
      const f = normWs(cols[idx] || '')
      if (f.length >= PRIOR_QUOTE_MIN) out.push({ q: m[1], col: idx + 1, text: f })
    }
  }
  return out
}

/** frag 裡第一段出現在 normBrief 的連續片段（≥ min 字元，貪婪延伸到最長）；沒有 ⇒ null。 */
function sharedFragment(frag, normBrief, min = PRIOR_QUOTE_MIN) {
  for (let i = 0; i + min <= frag.length; i++) {
    if (!normBrief.includes(frag.slice(i, i + min))) continue
    let j = i + min
    while (j < frag.length && normBrief.includes(frag.slice(i, j + 1))) j++
    return frag.slice(i, j)
  }
  return null
}

/** brief 與前輪目錄們的輸出比對 ⇒ 命中清單 [{fragment, file, q, col}]。 */
export function findPriorQuotes(briefText, priorDirs) {
  const nb = normWs(briefText)
  const hits = []
  for (const dir of priorDirs) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.txt') || name.endsWith('.stderr.txt')) continue
      const file = path.join(dir, name)
      for (const f of extractPriorFragments(fs.readFileSync(file, 'utf8'))) {
        const frag = sharedFragment(f.text, nb)
        if (frag) hits.push({ fragment: frag, file, q: f.q, col: f.col })
      }
    }
  }
  return hits
}

/** explicit（--prior-out，可重複）優先；沒給 ⇒ 同父目錄、去掉 `-r<N>` 尾碼同前綴的其他輪目錄。explicit 不是目錄 ⇒ throw（不靜默略過）。 */
export function resolvePriorDirs(outDir, explicit) {
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit.map((d) => {
      if (typeof d !== 'string' || !fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
        throw new Error(`--prior-out 不是目錄：${d}`)
      }
      return path.resolve(d)
    })
  }
  const abs = path.resolve(outDir)
  const m = path.basename(abs).match(/^(.+)-r(\d+)$/)
  if (!m) return []
  const parent = path.dirname(abs)
  if (!fs.existsSync(parent)) return []
  const re = new RegExp('^' + m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-r\\d+$')
  return fs
    .readdirSync(parent)
    .filter((n) => re.test(n) && path.join(parent, n) !== abs && fs.statSync(path.join(parent, n)).isDirectory())
    .sort()
    .map((n) => path.join(parent, n))
}

// ─────────────────── 1.27.0：r2 brief 查重（跨輪）、this_round_delta、自述詞 ───────────────────
/** brief 正規化：統一換行成 \n、去頭尾空白（只這兩件，內文不動）。 */
export const normalizeBrief = (t) => String(t).replace(/\r\n?/g, '\n').trim()

/** 目錄名裡的輪次（`…-r<N>` 結尾，或 `…-r<N>-s1` 之類 `-r<N>` 後接分隔符）；認不出 ⇒ null。取最後一個。 */
export function roundOfDirName(dirPath) {
  const base = path.basename(path.resolve(dirPath))
  let n = null
  for (const m of base.matchAll(/-r(\d+)(?=$|[-_.])/g)) n = Number(m[1])
  return n
}

const DELTA_PLACEHOLDER = /^(無|无|沒有|没有|none|n\/a|na|tbd|todo|同上|同前輪|同前一輪|\.{2,}|…+|-+)$/i
const FIELD_LINE = /^\s*(?:[-*]\s*)?\|?\s*[`*]*[a-z][a-z_]*[`*]*\s*(?:[:：|])/
// 只認行首欄位格式：「this_round_delta: 值」、表格列第一欄「| this_round_delta | 值 |」、標題「## this_round_delta」後首段內容、清單「- **this_round_delta**:」。
// 內文句子提到欄位名（例「不要填 this_round_delta，下一輪再說」）不算。
const DELTA_FIELD_LINE = /^\s*(?:[-*+]\s+)?(?:#{1,6}\s*)?(?:\|\s*)?[`*]*this_round_delta[`*]*\s*(?:[:：|]\s*(.*))?$/
/** brief 含非空的 this_round_delta 欄位 ⇒ true；值為佔位字（無／TBD／同上／-）視為空。 */
export function hasNonEmptyRoundDelta(briefText) {
  const lines = normalizeBrief(briefText).split('\n')
  const clean = (x) => x.replace(/[`*|#：:]/g, ' ').replace(/^\s*[-]\s+/, '').trim()
  const nonEmpty = (x) => {
    const v = clean(x)
    return v !== '' && !DELTA_PLACEHOLDER.test(v)
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DELTA_FIELD_LINE)
    if (!m) continue
    if (nonEmpty(m[1] || '')) return true
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (/^\s*#/.test(l) || FIELD_LINE.test(l)) break
      if (nonEmpty(l)) return true
    }
  }
  return false
}

export const SELF_REPORT_TERMS = ['寫手宣稱', '寫手說', '作者表示', '寫手回報']
export const findSelfReportTerms = (briefText) => SELF_REPORT_TERMS.filter((t) => String(briefText).includes(t))

/**
 * 跨輪查重：本輪 brief 的（原文或正規化）雜湊 ⇒ 與前輪目錄 input.json 的 briefSha256／briefNormSha256 比。
 * 前輪 input.json 沒有 briefNormSha256（1.27.0 前）時只能比原文雜湊（位元組相同才擋）。
 * 輪次 ≥ currentRound 的前輪目錄（同輪 segment 各段、後輪）不比；輪次認不出的（明給 --prior-out）視為前輪，\n * 但若兩邊都帶 --segment 且 segment.of 相同，視為同輪各段、不比。
 */
export function findSameBriefDirs(briefText, priorDirs, currentRound) {
  const raw = sha256(briefText)
  const norm = sha256(normalizeBrief(briefText))
  const same = []
  for (const dir of priorDirs) {
    let inp
    try {
      inp = JSON.parse(fs.readFileSync(path.join(dir, 'input.json'), 'utf8'))
    } catch {
      continue
    }
    // 前輪輪次：目錄名 -r<N> 優先，認不出才用該輪 input.json.round（同一次 council 呼叫寫下的 metadata）；都沒有 ⇒ 輪次不明、照比。
    const r = roundOfDirName(dir) ?? (Number.isInteger(inp && inp.round) ? inp.round : null)
    if (r !== null && currentRound !== null && r >= currentRound) continue
    if (inp && (inp.briefSha256 === raw || inp.briefSha256 === norm || inp.briefNormSha256 === norm || inp.briefNormSha256 === raw)) same.push(dir)
  }
  return same
}

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

const Q3_NO_EVIDENCE_SENTENCE = 'Q3 只判 diff 裡的測試是否量到這次變更、陽性對照的設計對不對（拿掉哪段修法、哪條斷言該紅）；「作者沒交陽性對照證據」不構成不簽理由。執行證據由統整者在 Q6 親跑並入帳（accept --q6），Q6 照常要求。'

export function buildReviewPrompt({ brief, diff, tier, diffStat, writerModel, riskDomains = [], roundStart, cumulative, writerReport, reviewOnly = false, blind = false }) {
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
      '這棵樹是統整者對已提交的分支叫的重新複審。' + Q3_NO_EVIDENCE_SENTENCE,
      '',
    )
  } else if (blind) {
    // 🔴 1.27.0 送審包盲化：prompt 不含寫手自述；Q3 題文與 review-only 同一句（陽性對照 llm-team.test.mjs「1.27.0」(a1)(a2)）。
    sections.push('【送審包盲化：本輪 prompt 不含寫手回報】', Q3_NO_EVIDENCE_SENTENCE, '')
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
  const a = parseArgs(rest, ['prior-out'])
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

  // 🔴 1.25.0 r2：review 不在這裡建 --out（--require-clean 拒審時不得留任何輸出；也讓「--out 事先存在且有檔」能被算進 untracked）。review 在寫第一個輸出檔之前才建。
  if (sub !== 'review') fs.mkdirSync(outDir, { recursive: true })
  // deps.runOne 是測試接縫：維持 (name, model, prompt, cwd, outDir, timeoutMs, member) 形狀，member 是第 7 個參數。
  const run = deps.runOne
    ? (member, prompt, cwd, outDir, timeoutMs) => deps.runOne(member.name, member.model, prompt, cwd, outDir, timeoutMs, member)
    : (member, prompt, cwd, outDir, timeoutMs) => runOne(member, prompt, cwd, outDir, timeoutMs, deps)
  // 1.24.0：--timeout-ms 要是正整數（毫秒）。以前 Number(x || 預設) 會把 "abc"（NaN）靜默帶進 spawn 逾時；與 ticket --review-timeout-ms 同一把尺。
  let timeoutMs = 8 * 60 * 1000
  if (a['timeout-ms'] !== undefined) {
    const raw = a['timeout-ms']
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`🔴 --timeout-ms 必須是正整數（毫秒），實際為 ${JSON.stringify(raw)}`)
      return 2
    }
    timeoutMs = n
  }
  let prompt
  let cwd = process.cwd()

  let priorQuote = null
  let segment = null
  let binding = null
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
    // 🔴 1.25.0 r2（codex R2-3）：--round-start 先解析成完整 sha（分支名／短 sha 都行；解析不了 ⇒ exit 2）；diff、roundStartSha、prompt 一律用解析後的 sha。
    let roundStart = null
    if (a['round-start'] !== undefined) {
      try {
        if (typeof a['round-start'] !== 'string' || a['round-start'] === '') throw new Error('缺值')
        roundStart = gitFn(cwd, ['rev-parse', '--verify', `${a['round-start']}^{commit}`])
      } catch (e) {
        console.error(`🔴 --round-start 解析不了成 commit：${JSON.stringify(a['round-start'])}（${e.message}）`)
        return 2
      }
    }
    const startPoint = roundStart || a.base
    // 🔴 1.25.0：--segment i/n（拆審第 i 段、共 n 段）；格式錯 ⇒ exit 2（在任何 git／複審者動作之前）。
    segment = null
    if (a.segment !== undefined) {
      const m = typeof a.segment === 'string' ? a.segment.match(/^(\d+)\/(\d+)$/) : null
      const index = m ? Number(m[1]) : NaN
      const of = m ? Number(m[2]) : NaN
      if (!m || !Number.isSafeInteger(index) || !Number.isSafeInteger(of) || index < 1 || of < 1 || index > of) {
        console.error(`🔴 --segment 要是 i/n（1 ≤ i ≤ n 的整數），不是 ${JSON.stringify(a.segment)}`)
        return 2
      }
      segment = { index, of }
    }
    const untracked = gitFn(cwd, ['ls-files', '--others', '--exclude-standard'])
    const untrackedFiles = untracked.split('\n').filter(Boolean).filter((f) => !f.startsWith('.agy-write/'))
    // 🔴 1.25.0 r2（codex R2-1）：不再排除 --out 子樹（可拿來藏檔）。--out 此刻尚未建立（review 不提前 mkdir），本輪將建的目錄自然不在清單；
    //   事先存在且含檔的 --out ⇒ 這些檔就是 untracked（--require-clean 下 exit 2）。
    const untrackedForRecord = untrackedFiles
    let bindHead
    let bindTree
    let bindBase
    let bindDirty
    let changedFiles
    try {
      bindHead = gitFn(cwd, ['rev-parse', 'HEAD'])
      bindTree = gitFn(cwd, ['rev-parse', 'HEAD^{tree}'])
      bindBase = gitFn(cwd, ['rev-parse', '--verify', `${a.base}^{commit}`])
      bindDirty = gitFn(cwd, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']) !== ''
      changedFiles = gitFn(cwd, ['diff', '--name-only', a.base]).split('\n').filter(Boolean)
    } catch (e) {
      console.error(`🔴 無法記錄審查對象（head／tree／base）：${e.message}`)
      return 2
    }
    // 🔴 1.25.0 --require-clean：工作樹不乾淨 ⇒ 審到的不是任何一個 commit ⇒ 在呼叫複審者之前停（exit 2）。預設關。
    if (a['require-clean'] !== undefined && a['require-clean'] !== 'false') {
      if (bindDirty || untrackedForRecord.length > 0) {
        console.error(
          `🔴 --require-clean：工作樹不乾淨（tracked 有未提交改動：${bindDirty}；untracked ${untrackedForRecord.length} 個${untrackedForRecord.length ? '：' + untrackedForRecord.slice(0, 5).join('、') : ''}）——複審者沒有被呼叫。先 commit 再審。`
        )
        return 2
      }
    }
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
    // 🔴 1.23.0：brief 不得內嵌前輪審查者的推理（見檔頭 §1.23.0）。在呼叫任何複審者之前、diff 算完後擋。
    const briefText = fs.readFileSync(a.brief, 'utf8')
    let priorDirs
    try {
      priorDirs = resolvePriorDirs(outDir, a['prior-out'])
    } catch (e) {
      console.error(`🔴 ${e.message}`)
      return 2
    }
    const priorHits = findPriorQuotes(briefText, priorDirs)
    const allowPriorQuote = a['allow-prior-quote'] !== undefined && a['allow-prior-quote'] !== 'false'
    priorQuote = { checkedDirs: priorDirs, hits: priorHits.length, allowed: allowPriorQuote }
    if (priorHits.length > 0 && !allowPriorQuote) {
      const lines = priorHits.map(
        (h) => `  · 「${h.fragment.length > 80 ? h.fragment.slice(0, 80) + '…' : h.fragment}」（${h.q} 第 ${h.col} 欄；來源 ${h.file}）`
      )
      console.error(
        `🔴 brief 內嵌了前輪審查者的推理（${priorHits.length} 處，連續 ≥ ${PRIOR_QUOTE_MIN} 字元相同）：\n${lines.join('\n')}\n` +
          `brief 只能放 finding ID＋證據 path:line＋預期的決定性檢查，不放前輪推理或建議修法。` +
          `（確要保留 ⇒ --allow-prior-quote，會入 input.json／ledger／members.json。）`
      )
      return 2
    }
    if (priorHits.length > 0) {
      console.error(`⚠️ --allow-prior-quote：brief 含前輪推理 ${priorHits.length} 處，已入帳。`)
    }
    // 🔴 1.27.0 r2 查重（只報告、不擋）＋自述詞警告（見檔頭 §1.27.0）。
    const explicitPrior = Array.isArray(a['prior-out']) && a['prior-out'].length > 0
    const parsedRound = roundOfDirName(outDir)
    let currentRound = parsedRound
    let roundConflict = null
    if (explicitPrior && (parsedRound === null || parsedRound < 2)) {
      // 明給前輪目錄 ⇒ 本輪至少是第 2 輪；目錄名解析出 r0／r1 與之矛盾 ⇒ 記錄並以 ≥2 處理。
      if (parsedRound !== null) roundConflict = { parsedFromOutDir: parsedRound, treatedAs: 2 }
      currentRound = 2
    }
    const isLaterRound = currentRound !== null && currentRound > 1
    let briefDedup = { checked: false, round: currentRound, roundConflict, sameAs: [], hasRoundDelta: null, roundDeltaMissing: false }
    if (isLaterRound) {
      const sameAs = findSameBriefDirs(briefText, priorDirs, currentRound)
      const hasRoundDelta = hasNonEmptyRoundDelta(briefText)
      briefDedup = { checked: true, round: currentRound, roundConflict, sameAs, hasRoundDelta, roundDeltaMissing: !hasRoundDelta }
      if (roundConflict) console.log(`⚠️ --prior-out 已給（本輪至少第 2 輪），但 --out 目錄名解析出 r${roundConflict.parsedFromOutDir}：以第 2 輪處理，已入帳。`)
      if (sameAs.length > 0) console.log(`⚠️ 第 ${currentRound} 輪 brief 與前輪相同（雜湊一致）：${sameAs.join('、')}。r2 起 brief 用 TEMPLATES §6.1 格式，不重送同一份。僅警告，已入 input.json.briefDedup.sameAs。`)
      if (!hasRoundDelta) console.log(`⚠️ 第 ${currentRound} 輪 brief 沒有非空的 this_round_delta 欄位（TEMPLATES §6.1）。僅警告，已入 input.json.briefDedup.roundDeltaMissing。`)
    }
    const selfReportTerms = findSelfReportTerms(briefText)
    const selfReportWarning = selfReportTerms.length > 0 ? { terms: selfReportTerms } : null
    if (selfReportWarning) {
      console.error(`⚠️ brief 含寫手自述詞（${selfReportTerms.join('、')}）：審查 brief 不該放寫手對自己修法的說明（TEMPLATES §6.2）。僅警告，不擋。`)
    }
    // 🔴 1.27.0 盲化：--writer-report 預設只複製進 --out（供統整者 Q6），不進 prompt；--include-writer-report 才進。
    const flagOn = (v) => v !== undefined && v !== 'false'
    const includeWriterReport = flagOn(a['include-writer-report'])
    let writerReport = null
    let writerReportTruncated = null
    let writerReportInfo = { provided: false, included: false, sha256: null, copiedTo: null }
    let rawReportForCopy = null
    if (a['writer-report']) {
      const rawReport = fs.readFileSync(a['writer-report'], 'utf8')
      rawReportForCopy = rawReport
      const included = includeWriterReport && !reviewOnly
      writerReportInfo = { provided: true, included, sha256: sha256(rawReport), copiedTo: 'writer-report.md' }
      const reportCap = 20000
      if (included) {
        if (rawReport.length > reportCap) {
          writerReport = rawReport.slice(0, reportCap) + `\n…（截斷，原長 ${rawReport.length} 字元）`
          writerReportTruncated = { originalLength: rawReport.length, cap: reportCap }
        } else {
          writerReport = rawReport
        }
      }
    }
    fs.mkdirSync(outDir, { recursive: true })
    if (rawReportForCopy !== null) fs.writeFileSync(path.join(outDir, 'writer-report.md'), rawReportForCopy)
    // review/input.json：複審者到底看了什麼。長度是 JS String.length（UTF-16 code unit），不是 byte 也不是嚴格字元數。
    const inputInfo = {
      // schemaVersion 是 v1 欄位（舊讀者用），保留不動；v2 的版本號是 schema:2（1.25.0）。
      schemaVersion: 1,
      schema: 2,
      head: bindHead,
      tree: bindTree,
      base: bindBase,
      roundStart: new Date().toISOString(),
      roundStartSha: roundStart || null,
      dirty: bindDirty,
      untracked: untrackedForRecord,
      diffSha256: sha256(diff),
      changedFiles,
      tier,
      coordinator: models.coordinator.profile,
      briefSha256: sha256(briefText),
      briefNormSha256: sha256(normalizeBrief(briefText)),
      promptSha256: null,
      segment,
      diffLength: diff.length,
      diffCap: cap,
      defaultDiffCap: DEFAULT_DIFF_CAP,
      capOverridden: cap !== DEFAULT_DIFF_CAP,
      reviewInvoked: diff.length <= cap,
      status: diff.length <= cap ? 'ok' : 'diff_over_cap',
      writerReportTruncated,
      priorQuote,
      includeWriterReport,
      writerReport: writerReportInfo,
      round: currentRound,
      roundDeltaMissing: briefDedup.roundDeltaMissing,
      briefDedup,
      selfReportWarning,
    }
    binding = { head: bindHead, diffSha256: inputInfo.diffSha256 }
    if (!inputInfo.reviewInvoked) {
      fs.writeFileSync(path.join(outDir, 'input.json'), JSON.stringify(inputInfo, null, 2))
      fs.writeFileSync(path.join(outDir, 'members.json'), '[]')
      console.error(
        `🔴 diff ${diff.length} 字元超過完整送審上限 ${cap}（--diff-cap）——複審者沒有被呼叫，這張票沒有複審。` +
          `下一步：拆票；或確認過內容後 --diff-cap ${diff.length} 重跑（會入帳、收貨摘要會印）。`
      )
      return 6
    }
    prompt = buildReviewPrompt({
      brief: briefText,
      diff,
      tier,
      diffStat,
      writerModel: models.writer.model,
      riskDomains: config.riskDomains || [],
      roundStart,
      cumulative,
      writerReport,
      reviewOnly,
      blind: !writerReportInfo.included && !reviewOnly,
    })
    inputInfo.promptSha256 = sha256(prompt)
    fs.writeFileSync(path.join(outDir, 'input.json'), JSON.stringify(inputInfo, null, 2))
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

  // 🔴 1.24.0 額度換席（業主 10-04：「如果某個 LLM 額度沒有了怎麼辦／這樣就不能做了，這不合理」）：
  //   某席失敗且 failure.kind ∈ {quota, auth} ⇒ 依 config 該席的 `fallbacks` 順序，各開一個全新行程、同一份 prompt 重跑；
  //   第一個不再是 quota／auth 失敗的成員就是這一席的實際成員（members.json 記 substitutedFor＝原席三元組、substituteReason＝原席 failure.kind）。
  //   全部 fallback 都 quota／auth 失敗 ⇒ 該席維持原席身分、失敗（attempts 記每次嘗試），不是靜默通過。
  //   其他失敗（逾時、被拒、格式錯、非零 exit）不換席。換席不會放寬任何簽核規則：換上來的成員照樣要整份簽、逐題引用。
  //   陽性對照 llm-team.test.mjs「1.24.0 council 換席」(a)–(e)。
  const usedNames = new Set(members.map((m) => m.name))
  const substituteName = (fb) => {
    const base = memberName(fb)
    let n = base
    let k = 1
    while (usedNames.has(n)) {
      k++
      n = `${base}-${k}`
    }
    usedNames.add(n)
    return n
  }
  // 🔴 1.24.0 r2（隔離 claude 審 R1）：已交出合法「整份：簽／不簽」判定的席【不換席】——換席只在 text 解不出 overall（零輸出、被截、格式錯）時。
  //   否則 stderr 含 rate limit 字樣的雜訊會讓「整份：不簽」的席被換成會簽的 fallback（把不簽洗成簽）。
  //   陽性對照 llm-team.test.mjs「1.24.0 council (f)」（拿掉 overall===null 條件 ⇒ fallback 被呼叫、不簽被洗掉）。
  const isSubstitutable = (r) =>
    Boolean(r && r.timedOut !== true && r.failure && FALLBACK_FAILURE_KINDS.includes(r.failure.kind) && parseVerdicts(r.text || '').overall === null)
  const runSeat = async (seat) => {
    const first = { harness: seat.harness, quotaBucket: seat.quotaBucket, ...(await run(seat, prompt, cwd, outDir, timeoutMs)) }
    const fbs = Array.isArray(seat.fallbacks) ? seat.fallbacks : []
    if (fbs.length === 0 || !isSubstitutable(first)) return { row: first, member: seat }
    const attempts = [{ harness: seat.harness, model: seat.model, quotaBucket: seat.quotaBucket, kind: first.failure.kind, code: first.failure.code ?? null }]
    for (const fb of fbs) {
      const sub = { ...fb, name: substituteName(fb) }
      delete sub.fallbacks
      const r = { harness: sub.harness, quotaBucket: sub.quotaBucket, ...(await run(sub, prompt, cwd, outDir, timeoutMs)) }
      if (!isSubstitutable(r)) {
        return {
          row: r,
          member: sub,
          substitutedFor: { harness: seat.harness, model: seat.model, quotaBucket: seat.quotaBucket },
          substituteReason: first.failure.kind,
          attempts,
        }
      }
      attempts.push({ harness: sub.harness, model: sub.model, quotaBucket: sub.quotaBucket, kind: r.failure.kind, code: r.failure.code ?? null })
    }
    return { row: first, member: seat, attempts }
  }

  let seatResults
  try {
    if (a.sequential) {
      seatResults = []
      for (let i = 0; i < members.length; i++) {
        seatResults.push(await runSeat(members[i]))
        memberStatus[i].done = true
        memberStatus[i].durationMs = Date.now() - startTime
      }
    } else {
      seatResults = await Promise.all(
        members.map(async (m, i) => {
          const r = await runSeat(m)
          memberStatus[i].done = true
          memberStatus[i].durationMs = Date.now() - startTime
          return r
        })
      )
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  }
  const rows = seatResults.map((x) => x.row)
  // 實際跑的成員（換席後是替補）：ledger／members.json 的身分都從這裡取。
  const eff = seatResults.map((x) => x.member)

  for (let i = 0; i < eff.length; i++) {
    const { name, model } = eff[i]
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
      ...(seatResults[i].substitutedFor ? { substitutedFor: seatResults[i].substitutedFor, substituteReason: seatResults[i].substituteReason } : {}),
      ...(priorQuote && priorQuote.allowed ? { allowPriorQuote: true, priorQuoteHits: priorQuote.hits } : {}),
    })
  }

  // 🔴 members.json：【實際跑的】成員（身分三元組來自 members[i]，不是 runner 回報的字串）＋結果。
  //    ticket run 只從這份取名單、publish 回頭讀這份比對三元組（codex 複審 Q5-IDENTITY；helpers 在 lib.mjs §複審名單身分三元組）。
  //    invalid ＝ 有輸出但抓不到「整份：簽／不簽」那行（格式不合、不算簽）。
  const membersOut = eff.map((m, i) => {
    const r = rows[i]
    const sr = seatResults[i]
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
      ...(binding ? { head: binding.head, diffSha256: binding.diffSha256 } : {}),
      ...(sr.substitutedFor ? { substitutedFor: sr.substitutedFor, substituteReason: sr.substituteReason } : {}),
      ...(sr.attempts ? { attempts: sr.attempts } : {}),
      ...(priorQuote && priorQuote.allowed ? { allowPriorQuote: true, priorQuoteHits: priorQuote.hits } : {}),
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
  for (const [i, sr] of seatResults.entries()) {
    if (sr.substitutedFor) {
      console.log(`↻ 換席：${sr.substitutedFor.harness}/${sr.substitutedFor.model}〔${sr.substitutedFor.quotaBucket}〕→ ${eff[i].name}〔${eff[i].quotaBucket}〕（原因 ${sr.substituteReason}）`)
    } else if (sr.attempts) {
      console.log(`🔴 ${eff[i].name} 額度／憑證用盡且 fallbacks 全失敗（${sr.attempts.map((x) => `${x.harness}/${x.model}:${x.kind}`).join('、')}），該席算失敗`)
    }
  }
  if (tier === 'block') {
    const cf = crossFamilyStatus(models.coordinator.quotaBucket, membersOut)
    if (cf.duplicateModel) console.log('⚠ duplicateModel：換席後 block 名單有兩席是同一個模型（盲點相關）')
    if (cf.status === 'degraded') {
      console.log(`⚠ crossFamily: degraded（跨家族席 ${cf.degraded.map((d) => `${d.seat.harness}/${d.seat.model}`).join('、')} 由同家族成員代跑）——待事後審`)
    }
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
