#!/usr/bin/env node
/**
 * **統整者用量量測工具**：從 Claude Code transcript 量出一張 llm-team 票在 lifecycle 區間內的統整者用量。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 它宣稱什麼、不宣稱什麼
 *
 *   宣稱：① 給一張 ticket，從 lifecycle.ndjson 的 run-start → landed（或最後一筆 accepted、或 last-event）時間區間，
 *            在頂層 Claude Code transcript 統計統整者的用量（user turn 數、API 呼叫數、四類 token 用量、工具呼叫數）；
 *         ② 可用 --write 回填該票的 summary.json，更新 coordinatorTurns、coordinatorUsage、usageWindow、comparable:true 與 usage={measurable:true}；
 *         ③ 輸出純數字與路徑，不外洩對話文本內容。
 *   不宣稱：① 不保證能定位 subagent 統整者（只掃頂層 jsonl）；
 *          ② 不改動 .agents/skills/llm-team/ 或任何源碼；
 *          ③ 沒有 summary.json／config 就不量——量出來的數字沒有主詞；
 *          ④ transcript 有任何毀損行時的數字——直接 exit 1，不回填。切行只認 `\n`——Node readline 會把 U+2028／U+2029 當換行，把合法 JSON 拆碎（2026-09-15 真 transcript 第 59274 行實測）。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 用法
 *
 *   node .agents/skills/llm-team/usage.mjs --ticket <name> [--config <file>] [--projects-dir <dir>] [--transcript <file>] [--from <iso>] [--to <iso>] [--write] [--json]
 *
 * exit：0 ＝ 成功（或不可量 harness）；1 ＝ 找不到目標（lifecycle / transcript / summary 檔不存在）；2 ＝ 參數錯誤（未知旗標、缺少必填值）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, createReadStream, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isDirectRun, loadConfig, git, MEASUREMENT_SCHEMA_VERSION } from './lib.mjs'
import { isTranscriptMeasurable } from './harnesses/index.mjs'

/** ③ cohort 自證 JSON 的輸出格式版本（與 lib.mjs 的 MEASUREMENT_SCHEMA_VERSION 是兩個不同的版本欄——一個是量測方法、一個是這份 JSON 的形狀）。 */
export const COHORT_JSON_SCHEMA_VERSION = 1

// ── 工具與常數 ──────────────────────────────────────────────────────────────

const KNOWN_FLAGS = new Set([
  '--ticket',
  '--config',
  '--projects-dir',
  '--transcript',
  '--from',
  '--to',
  '--write',
  '--json',
  '--help',
  '-h',
  '--tag-caliber',
  '--cohort',
  '--grandfathered',
])

const VALUE_FLAGS = new Set([
  '--ticket',
  '--config',
  '--projects-dir',
  '--transcript',
  '--from',
  '--to',
  '--tag-caliber',
  '--cohort',
])

const CALIBERS = Object.freeze(['docs', 'tool', 'feature'])

const NOTIFICATION_PREFIXES = Object.freeze([
  '<task-notification>',
  '[SYSTEM NOTIFICATION',
  '<system-reminder>',
])

/**
 * 把路徑轉為 Claude Code projects 的 slug（每個 / 換成 -）。
 * 例：`/Users/fergus/repo` ⇒ `-Users-fergus-repo`
 */
export function slugOf(dir) {
  const abs = resolve(dir)
  return abs.replace(/\//g, '-')
}

/**
 * 當在 worktree 中執行時，找出主 checkout 的根目錄（不呼叫外部 git 指令）。
 */
export function findMainRepo(cwd = process.cwd(), config = {}) {
  const absCwd = resolve(cwd)
  const worktreeRoot = typeof config === 'string' ? config : ((config && config.worktreeRoot) || '.claude/worktrees')
  const pattern = '/' + worktreeRoot.replace(/^\.\//, '') + '/'
  const worktreeIdx = absCwd.indexOf(pattern)
  if (worktreeIdx !== -1) {
    return absCwd.slice(0, worktreeIdx)
  }
  const gitPath = join(absCwd, '.git')
  if (existsSync(gitPath)) {
    try {
      const st = statSync(gitPath)
      if (st.isFile()) {
        const raw = readFileSync(gitPath, 'utf8')
        const m = raw.match(/gitdir:\s*(.*)/)
        if (m) {
          const target = m[1].trim()
          const idx = target.indexOf('/.git/worktrees/')
          if (idx !== -1) return target.slice(0, idx)
        }
      } else if (st.isDirectory()) {
        return absCwd
      }
    } catch {
      // 忽略錯誤
    }
  }
  return null
}

// ── lifecycle 解析 ─────────────────────────────────────────────────────────

/**
 * 解析 lifecycle 視窗（run-start → landed（或最後一筆 accepted、或 last-event））：
 *   - from 預設為第一筆 run-start 的 at（若無則第一筆的 at）
 *   - to 預設為 landed 的 at（windowEnd='landed'）；若無 landed 則最後一筆 accepted 的 at（windowEnd='accepted'）；若無 accepted 則最後一筆的 at（windowEnd='last-event'）
 *   - 若外部提供 from 或 to，則覆寫且標示 windowEnd='override'
 */
export function parseLifecycleWindow(entries, { from, to, noLastEventFallback = false } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const runStart = list.find((e) => e?.event === 'run-start')
  const accepted = list.findLast((e) => e?.event === 'accepted')
  const landed = list.findLast((e) => e?.event === 'landed')
  const last = list.length > 0 ? list[list.length - 1] : null

  const defaultFrom = runStart?.at ?? (list[0]?.at ?? null)
  let defaultTo = null
  let defaultWindowEnd = 'last-event'

  if (landed) {
    defaultTo = landed.at
    defaultWindowEnd = 'landed'
  } else if (accepted) {
    defaultTo = accepted.at
    defaultWindowEnd = 'accepted'
  } else if (noLastEventFallback) {
    // 🔴 1.8.0 ②：cohort 的 live 量測視窗終點固定——有 landed 用 landed，否則 accepted，不用 last-event；
    //   兩者都沒有 ⇒ 視窗缺時間，回傳 to:null 讓呼叫端判定 measurable:false（不得補猜、不得計入 pass）。
    defaultTo = null
    defaultWindowEnd = 'incomplete'
  } else {
    defaultTo = last?.at ?? null
    defaultWindowEnd = 'last-event'
  }

  const finalFrom = from !== undefined && from !== null ? from : defaultFrom
  const finalTo = to !== undefined && to !== null ? to : defaultTo
  const isOverridden = (from !== undefined && from !== null) || (to !== undefined && to !== null)
  const windowEnd = isOverridden ? 'override' : defaultWindowEnd

  return {
    from: finalFrom,
    to: finalTo,
    windowEnd,
  }
}

// ── 統整者 Turn 判定 ───────────────────────────────────────────────────────

function extractUserText(record) {
  const content = record?.message?.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    if (content.some((b) => b?.type === 'tool_result')) {
      return null
    }
    const textBlocks = content.filter((b) => b?.type === 'text')
    if (textBlocks.length === 0) return null
    return textBlocks.map((b) => b?.text || '').join('\n')
  }
  return null
}

function isNotificationText(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trimStart()
  return NOTIFICATION_PREFIXES.some((p) => text.startsWith(p) || trimmed.startsWith(p))
}

/**
 * 判斷是否為統整者頂層真人 Turn：
 *   - type === 'user'
 *   - userType === 'external'
 *   - isSidechain !== true && isMeta !== true
 *   - message.content 是字串或含 text 區塊（不含任何 tool_result 區塊）
 *   - 文字不以 <task-notification> / [SYSTEM NOTIFICATION / <system-reminder> 開頭
 */
export function isCoordinatorTurn(record) {
  if (!record || typeof record !== 'object') return false
  if (record.type !== 'user') return false
  if (record.userType !== 'external') return false
  if (record.isSidechain === true) return false
  if (record.isMeta === true) return false
  const text = extractUserText(record)
  if (text === null) return false
  if (isNotificationText(text)) return false
  return true
}

/**
 * 判斷是否為通知 Turn（符合 external user 結構但被通知前綴排除）：
 */
export function isNotificationTurn(record) {
  if (!record || typeof record !== 'object') return false
  if (record.type !== 'user') return false
  if (record.userType !== 'external') return false
  if (record.isSidechain === true) return false
  if (record.isMeta === true) return false
  const text = extractUserText(record)
  if (text === null) return false
  return isNotificationText(text)
}

function inWindow(ts, from, to) {
  if (!ts) return false
  if (from && to && typeof ts === 'string' && typeof from === 'string' && typeof to === 'string') {
    if (ts >= from && ts <= to) return true
  }
  const t = Date.parse(ts)
  const f = from ? Date.parse(from) : -Infinity
  const e = to ? Date.parse(to) : Infinity
  return Number.isFinite(t) && t >= f && t <= e
}

/**
 * 載入指定 localDir 底下除了本票之外，其他票的 lifecycle 視窗資訊。
 * 每個票回傳 { ticket, from, to, runStartAt }。
 * 排除本票、排除沒有 lifecycle.ndjson 的目錄；缺 from 或 to 的票跳過；壞 JSON 行容錯跳過。
 *
 * 🔴 事故（sol block 複審第 2 輪 Q5，2026-09-17）：cohort 的 live 量測（measureTicketLive）呼叫這支函式時，
 *   一直沿用單票 `--ticket` 流程的預設視窗規則（landed／accepted／last-event 都收），把「一般量測的實作細節」
 *   誤當成「cohort 的固定視窗契約」；結果是只有 run-start（沒有 accepted／landed）的其他票會被 last-event
 *   補出一個視窗，可能誤把本票的 apiCalls 排他歸屬算錯（污染或漏算）。
 *   改法：`noLastEventFallback: true` 時，其他票的視窗規則跟 cohort 對「本票」的規則一致——有 landed 用
 *   landed，否則 accepted，都沒有 ⇒ 視為沒有視窗（跳過，不補、不讓它參與排他歸屬）；單票 `--ticket` 流程
 *   （呼叫時不帶這個參數）維持 1.7.4 原行為不變。
 *   陽性對照：usage.test.mjs「1.8.0 ③ (Q5-b) 兩張時間重疊的票，其中一張只有 run-start」。
 */
export function loadOtherWindows(localDir, ticket, { noLastEventFallback = false } = {}) {
  if (!localDir || !existsSync(localDir)) {
    return []
  }
  let entries = []
  try {
    entries = readdirSync(localDir, { withFileTypes: true })
  } catch {
    return []
  }

  const results = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const otherTicket = entry.name
    if (otherTicket === ticket) continue

    const lifecycleFile = join(localDir, otherTicket, 'lifecycle.ndjson')
    if (!existsSync(lifecycleFile)) continue

    let raw = ''
    try {
      raw = readFileSync(lifecycleFile, 'utf8')
    } catch {
      continue
    }

    const lines = raw.split('\n')
    const lifecycleEntries = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        lifecycleEntries.push(JSON.parse(trimmed))
      } catch {
        continue
      }
    }

    const win = parseLifecycleWindow(lifecycleEntries, { noLastEventFallback })
    if (!win.from || !win.to) {
      continue
    }

    const runStartEntry = lifecycleEntries.find((e) => e && e.event === 'run-start')
    const runStartAt = runStartEntry?.at ?? null

    results.push({
      ticket: otherTicket,
      from: win.from,
      to: win.to,
      runStartAt,
    })
  }

  return results
}

/**
 * 判定一筆記錄（時間戳記 ts）是否歸屬本票。
 * 回傳 true 表示歸本票；
 * false 表示不歸本票（被其他票視窗夾走）；
 * null 表示不可判（視窗缺時間、或與其他重疊票的 run-start 並列）。
 */
export function attributeRecord(ts, self, others = []) {
  if (!ts || !self || !self.from || !self.to || !self.runStartAt) {
    return null
  }
  if (!inWindow(ts, self.from, self.to)) {
    return false
  }

  const selfStart = typeof self.runStartAt === 'number' ? self.runStartAt : Date.parse(self.runStartAt)
  if (!Number.isFinite(selfStart)) {
    return null
  }

  let hasLater = false
  for (const other of (others || [])) {
    if (!other || other.ticket === self.ticket) continue
    if (inWindow(ts, other.from, other.to)) {
      if (!other.runStartAt) {
        return null
      }
      const otherStart = typeof other.runStartAt === 'number' ? other.runStartAt : Date.parse(other.runStartAt)
      if (!Number.isFinite(otherStart)) {
        return null
      }
      if (otherStart === selfStart) {
        return null
      }
      if (otherStart > selfStart) {
        hasLater = true
      }
    }
  }

  if (hasLater) {
    return false
  }
  return true
}

// ── 累加量測 ───────────────────────────────────────────────────────────────

/**
 * 累加記錄在時間視窗內的用量。支援同步 Iterable（例如 Array）及非同步 Iterable（串流產生器）。
 * 支援排他歸屬計算（exclusive 與 overlaps）。
 */
export function accumulate(records, window, { others = [], self } = {}) {
  const defaultRes = {
    coordinatorTurns: 0,
    notificationsExcluded: 0,
    apiCalls: 0,
    usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
    toolCalls: {},
    exclusive: { apiCalls: 0, usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 } },
    overlaps: [],
  }
  if (!records) {
    return defaultRes
  }

  const effectiveSelf = self || {
    ticket: 'self',
    from: window?.from,
    to: window?.to,
    runStartAt: window?.from,
  }

  const selfStart = typeof effectiveSelf.runStartAt === 'number' ? effectiveSelf.runStartAt : Date.parse(effectiveSelf.runStartAt)
  const selfFrom = typeof effectiveSelf.from === 'number' ? effectiveSelf.from : Date.parse(effectiveSelf.from)
  const selfTo = typeof effectiveSelf.to === 'number' ? effectiveSelf.to : Date.parse(effectiveSelf.to)

  const initOverlapMap = () => {
    const map = new Map()
    if (Array.isArray(others)) {
      for (const other of others) {
        if (!other || other.ticket === effectiveSelf.ticket) continue
        const otherStart = typeof other.runStartAt === 'number' ? other.runStartAt : Date.parse(other.runStartAt)
        const otherFrom = typeof other.from === 'number' ? other.from : Date.parse(other.from)
        const otherTo = typeof other.to === 'number' ? other.to : Date.parse(other.to)
        if (!Number.isFinite(otherStart) || !Number.isFinite(otherFrom) || !Number.isFinite(otherTo)) continue
        const start = Math.max(selfFrom, otherFrom)
        const end = Math.min(selfTo, otherTo)
        const overlapMs = Math.max(0, end - start)
        if (overlapMs > 0 && otherStart >= selfStart) {
          map.set(other.ticket, {
            ticket: other.ticket,
            from: other.from,
            to: other.to,
            overlapMs,
            excludedApiCalls: 0,
            runStartAt: other.runStartAt,
          })
        }
      }
    }
    return map
  }

  const finalize = ({
    coordinatorTurns,
    notificationsExcluded,
    apiCalls,
    usage,
    toolCalls,
    exclusiveApiCalls,
    exclusiveUsage,
    overlapMap,
    hasTie,
    missingTime,
  }) => {
    const overlaps = Array.from(overlapMap.values()).map(({ ticket, from, to, overlapMs, excludedApiCalls }) => ({
      ticket,
      from,
      to,
      overlapMs,
      excludedApiCalls,
    }))

    let exclusive = null
    let exclusiveReason = undefined

    if (missingTime) {
      exclusive = null
      exclusiveReason = '視窗缺時間'
    } else if (hasTie) {
      exclusive = null
      exclusiveReason = 'run-start 並列'
    } else if (!others || others.length === 0) {
      exclusive = {
        apiCalls,
        usage: { ...usage },
      }
    } else {
      exclusive = {
        apiCalls: exclusiveApiCalls,
        usage: exclusiveUsage,
      }
    }

    const result = {
      coordinatorTurns,
      notificationsExcluded,
      apiCalls,
      usage,
      toolCalls,
      exclusive,
      overlaps,
    }
    if (exclusiveReason) {
      result.exclusiveReason = exclusiveReason
    }
    return result
  }

  // 非同步串流路徑
  if (typeof records[Symbol.asyncIterator] === 'function') {
    return (async () => {
      let coordinatorTurns = 0
      let notificationsExcluded = 0
      let apiCalls = 0
      const usage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }
      const toolCalls = {}

      let exclusiveApiCalls = 0
      const exclusiveUsage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }
      let hasTie = false
      let missingTime = false
      const overlapMap = initOverlapMap()

      for await (const record of records) {
        if (!record || !record.timestamp) continue
        if (!inWindow(record.timestamp, window.from, window.to)) continue

        if (isCoordinatorTurn(record)) {
          coordinatorTurns++
        } else if (isNotificationTurn(record)) {
          notificationsExcluded++
        }

        if (record.type === 'assistant') {
          if (record.message?.usage) {
            apiCalls++
            const inp = Number(record.message.usage.input_tokens) || 0
            const cc = Number(record.message.usage.cache_creation_input_tokens) || 0
            const cr = Number(record.message.usage.cache_read_input_tokens) || 0
            const out = Number(record.message.usage.output_tokens) || 0

            usage.input += inp
            usage.cacheCreation += cc
            usage.cacheRead += cr
            usage.output += out

            const attr = attributeRecord(record.timestamp, effectiveSelf, others)
            if (attr === null) {
              if (!effectiveSelf.from || !effectiveSelf.to || !effectiveSelf.runStartAt) {
                missingTime = true
              } else {
                hasTie = true
              }
              for (const entry of overlapMap.values()) {
                if (inWindow(record.timestamp, entry.from, entry.to)) {
                  entry.excludedApiCalls++
                }
              }
            } else if (attr === true) {
              exclusiveApiCalls++
              exclusiveUsage.input += inp
              exclusiveUsage.cacheCreation += cc
              exclusiveUsage.cacheRead += cr
              exclusiveUsage.output += out
            } else {
              // attr === false: 由重疊票夾走
              let latestCandidate = null
              let latestCandidateStart = -Infinity
              for (const entry of overlapMap.values()) {
                if (inWindow(record.timestamp, entry.from, entry.to)) {
                  const st = typeof entry.runStartAt === 'number' ? entry.runStartAt : Date.parse(entry.runStartAt)
                  if (st > latestCandidateStart) {
                    latestCandidateStart = st
                    latestCandidate = entry
                  }
                }
              }
              if (latestCandidate) {
                latestCandidate.excludedApiCalls++
              }
            }
          }
          if (Array.isArray(record.message?.content)) {
            for (const block of record.message.content) {
              if (block?.type === 'tool_use' && block?.name) {
                toolCalls[block.name] = (toolCalls[block.name] || 0) + 1
              }
            }
          }
        }
      }

      return finalize({
        coordinatorTurns,
        notificationsExcluded,
        apiCalls,
        usage,
        toolCalls,
        exclusiveApiCalls,
        exclusiveUsage,
        overlapMap,
        hasTie,
        missingTime,
      })
    })()
  }

  // 同步陣列路徑
  let coordinatorTurns = 0
  let notificationsExcluded = 0
  let apiCalls = 0
  const usage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }
  const toolCalls = {}

  let exclusiveApiCalls = 0
  const exclusiveUsage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }
  let hasTie = false
  let missingTime = false
  const overlapMap = initOverlapMap()

  for (const record of records) {
    if (!record || !record.timestamp) continue
    if (!inWindow(record.timestamp, window.from, window.to)) continue

    if (isCoordinatorTurn(record)) {
      coordinatorTurns++
    } else if (isNotificationTurn(record)) {
      notificationsExcluded++
    }

    if (record.type === 'assistant') {
      if (record.message?.usage) {
        apiCalls++
        const inp = Number(record.message.usage.input_tokens) || 0
        const cc = Number(record.message.usage.cache_creation_input_tokens) || 0
        const cr = Number(record.message.usage.cache_read_input_tokens) || 0
        const out = Number(record.message.usage.output_tokens) || 0

        usage.input += inp
        usage.cacheCreation += cc
        usage.cacheRead += cr
        usage.output += out

        const attr = attributeRecord(record.timestamp, effectiveSelf, others)
        if (attr === null) {
          if (!effectiveSelf.from || !effectiveSelf.to || !effectiveSelf.runStartAt) {
            missingTime = true
          } else {
            hasTie = true
          }
          for (const entry of overlapMap.values()) {
            if (inWindow(record.timestamp, entry.from, entry.to)) {
              entry.excludedApiCalls++
            }
          }
        } else if (attr === true) {
          exclusiveApiCalls++
          exclusiveUsage.input += inp
          exclusiveUsage.cacheCreation += cc
          exclusiveUsage.cacheRead += cr
          exclusiveUsage.output += out
        } else {
          // attr === false: 由重疊票夾走
          let latestCandidate = null
          let latestCandidateStart = -Infinity
          for (const entry of overlapMap.values()) {
            if (inWindow(record.timestamp, entry.from, entry.to)) {
              const st = typeof entry.runStartAt === 'number' ? entry.runStartAt : Date.parse(entry.runStartAt)
              if (st > latestCandidateStart) {
                latestCandidateStart = st
                latestCandidate = entry
              }
            }
          }
          if (latestCandidate) {
            latestCandidate.excludedApiCalls++
          }
        }
      }
      if (Array.isArray(record.message?.content)) {
        for (const block of record.message.content) {
          if (block?.type === 'tool_use' && block?.name) {
            toolCalls[block.name] = (toolCalls[block.name] || 0) + 1
          }
        }
      }
    }
  }

  return finalize({
    coordinatorTurns,
    notificationsExcluded,
    apiCalls,
    usage,
    toolCalls,
    exclusiveApiCalls,
    exclusiveUsage,
    overlapMap,
    hasTie,
    missingTime,
  })
}

// ── 串流讀行 ───────────────────────────────────────────────────────────────

/**
 * 逐行非同步讀取檔案。切行只認 '\n'，跨 chunk 殘段自動串接，最後一段若非空也 yield，行尾 '\r' 剝除。
 * 絕不將 U+2028、U+2029 等字元視為換行。
 */
export async function* readLines(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  try {
    let remainder = ''
    for await (const chunk of stream) {
      remainder += chunk
      let idx
      while ((idx = remainder.indexOf('\n')) !== -1) {
        let line = remainder.slice(0, idx)
        remainder = remainder.slice(idx + 1)
        if (line.endsWith('\r')) {
          line = line.slice(0, -1)
        }
        yield line
      }
    }
    if (remainder.length > 0) {
      let line = remainder
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      yield line
    }
  } finally {
    stream.destroy()
  }
}

// ── Transcript 搜尋 ─────────────────────────────────────────────────────────

async function findTranscriptRecord(dir, ticket, from) {
  if (!dir || !existsSync(dir)) return null
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const jsonlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name)

  const fromMs = from ? Date.parse(from) : Infinity
  const matches = []

  for (const filename of jsonlFiles) {
    const fullPath = join(dir, filename)
    try {
      for await (const line of readLines(fullPath)) {
        if (!line.includes('ticket.mjs run') || !line.includes(ticket)) continue
        let record
        try {
          record = JSON.parse(line.trim())
        } catch {
          continue
        }
        if (record?.type === 'assistant' && Array.isArray(record?.message?.content)) {
          const hasMatch = record.message.content.some((b) => {
            if (b?.type !== 'tool_use' || b?.name !== 'Bash') return false
            const cmd = b?.input?.command
            if (typeof cmd !== 'string') return false
            return cmd.includes('ticket.mjs run') && (cmd.includes(`--name ${ticket}`) || cmd.includes(`--name=${ticket}`))
          })
          if (hasMatch && record.timestamp) {
            matches.push({
              file: fullPath,
              timestamp: record.timestamp,
              ms: Date.parse(record.timestamp),
            })
          }
        }
      }
    } catch {
      continue
    }
  }

  if (matches.length === 0) return null

  // 候選記錄必須不晚於 from（ms <= fromMs）
  const valid = matches.filter((m) => Number.isFinite(m.ms) && m.ms <= fromMs)
  if (valid.length > 0) {
    // 取最接近 from 的那一筆（最大的 ms <= fromMs）
    valid.sort((a, b) => b.ms - a.ms)
    return valid[0]
  }

  return null
}

/**
 * 在 projects 目錄頂層掃描 *.jsonl，找出開了此票的 transcript。
 */
export async function findTranscript(dir, ticket, from) {
  const match = await findTranscriptRecord(dir, ticket, from)
  return match ? match.file : null
}

/**
 * 跨專案自動尋找 transcript：先依序試 preferred 目錄，若無命中則掃描 projectsRoot 底下所有子目錄。
 */
export async function findTranscriptAcross(projectsRoot, ticket, from, { preferred = [] } = {}) {
  const tried = new Set()

  for (const prefDir of (preferred || [])) {
    if (!prefDir) continue
    tried.add(resolve(prefDir))
    if (!existsSync(prefDir)) continue
    const file = await findTranscript(prefDir, ticket, from)
    if (file) {
      return { file, dir: prefDir }
    }
  }

  if (!projectsRoot || !existsSync(projectsRoot)) return null

  let entries = []
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true })
  } catch {
    return null
  }

  const matches = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const subDir = join(projectsRoot, entry.name)
    if (tried.has(resolve(subDir))) continue
    const record = await findTranscriptRecord(subDir, ticket, from)
    if (record) {
      matches.push({
        file: record.file,
        ms: record.ms,
        dir: subDir,
      })
    }
  }

  if (matches.length === 0) return null

  matches.sort((a, b) => b.ms - a.ms)
  return { file: matches[0].file, dir: matches[0].dir }
}

/**
 * 依 sessionId 尋找 transcript：在 projectsRoot 的第一層子目錄中，
 * 尋找第一個存在的 <dir>/<sessionId>.jsonl。
 */
export function findTranscriptBySession(projectsRoot, sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return null
  }
  if (!projectsRoot || !existsSync(projectsRoot)) {
    return null
  }
  let entries = []
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const subDir = join(projectsRoot, entry.name)
    const candidate = join(subDir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) {
      return { file: candidate, dir: subDir, via: 'sessionId' }
    }
  }
  return null
}

async function* streamJsonLines(filePath) {
  let lineNo = 0
  for await (const line of readLines(filePath)) {
    lineNo++
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      yield JSON.parse(trimmed)
    } catch (e) {
      throw new Error(`transcript 毀損行：${filePath}:${lineNo}（${e.message}）`)
    }
  }
}

// ── Cohort 判定 ────────────────────────────────────────────────────────────

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const n = sorted.length
  const mid = Math.floor(n / 2)
  if (n % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function reworkOf(group) {
  let n = 0
  let of = 0
  let unknown = 0
  for (const s of group) {
    if (typeof s.run === 'number') {
      of++
      if (s.run >= 2) n++
    } else {
      unknown++
    }
  }
  return { n, of, unknown }
}

/**
 * 事故（2026-09-15）：config repo 15 張 llm-team 工具票混口徑直接量出「中位數 48→19、−60%」，但前 8 張是 1.6.7 之前開的、
 *   summary 沒有 `run` 欄位 ⇒ 重工率不可比（sol Q3：只能 provisional）；沒有 caliber 標籤時把 docs 小票混進來也會壓低中位數——這支工具的存在理由就是讓那種數字只能印 🟡 不能印 ✅。
 *
 * 純函式：對一批票 summary 依 caliber 做同口徑 cohort 判定（A 案）。
 *   - 母體＝caliber 相符、usage.measurable===true、coordinatorUsageExclusive.apiCalls 為數字、
 *     usageWindow.from 為字串的票；依 usageWindow.from 字串升冪排序。
 *   - 基線＝前 5 張（不足 5 ⇒ 回傳 short:true、median:null、windows:[]）。
 *   - 之後不重疊每連續 10 張一窗（k 從 1 起）；最後不滿 10 張的窗 partial:true、verdict:null。
 *   - 中位數：排序後奇數取中、偶數取中間兩數平均（不四捨五入）。
 *   - dropPct = (baseline 中位數 − 窗中位數) / baseline 中位數 × 100（保留小數，印時才 toFixed(1)）。
 *   - 重工 = { n: run>=2 的張數, of: 有 run 欄位的張數, unknown: 缺 run 欄位的張數 }；重工率 = n/of。
 *   - 判定：dropPct>=40 且基線與窗 unknown 都是 0 且窗重工率 <= 基線重工率 ⇒ 'pass'；
 *          dropPct>=40 但任一組 unknown>0 ⇒ 'provisional'；
 *          其餘（dropPct<40，或都可比但窗重工率 > 基線）⇒ 'fail'。
 */
export function cohortReport(summaries, caliber) {
  const ticketName = (s) => s.ticket ?? s.name

  const list = Array.isArray(summaries) ? summaries : []
  const filtered = list.filter((s) =>
    s &&
    s.caliber === caliber &&
    s.usage?.measurable === true &&
    typeof s.coordinatorUsageExclusive?.apiCalls === 'number' &&
    typeof s.usageWindow?.from === 'string'
  )
  filtered.sort((a, b) => {
    if (a.usageWindow.from < b.usageWindow.from) return -1
    if (a.usageWindow.from > b.usageWindow.from) return 1
    return 0
  })

  if (filtered.length < 5) {
    return {
      caliber,
      baseline: { tickets: filtered.map(ticketName), median: null, rework: reworkOf(filtered), short: true },
      windows: [],
    }
  }

  const baselineGroup = filtered.slice(0, 5)
  const baselineMedian = median(baselineGroup.map((s) => s.coordinatorUsageExclusive.apiCalls))
  const baselineRework = reworkOf(baselineGroup)
  const baseline = {
    tickets: baselineGroup.map(ticketName),
    median: baselineMedian,
    rework: baselineRework,
  }

  const rest = filtered.slice(5)
  const windows = []
  let k = 1
  for (let i = 0; i < rest.length; i += 10) {
    const group = rest.slice(i, i + 10)
    const partial = group.length < 10
    const groupMedian = median(group.map((s) => s.coordinatorUsageExclusive.apiCalls))
    const groupRework = reworkOf(group)
    const dropPct = (baselineMedian - groupMedian) / baselineMedian * 100

    let verdict = null
    if (!partial) {
      const bothComparable = baselineRework.unknown === 0 && groupRework.unknown === 0
      if (dropPct >= 40 && bothComparable && (groupRework.n / groupRework.of) <= (baselineRework.n / baselineRework.of)) {
        verdict = 'pass'
      } else if (dropPct >= 40 && !bothComparable) {
        verdict = 'provisional'
      } else {
        verdict = 'fail'
      }
    }

    windows.push({
      k,
      tickets: group.map(ticketName),
      median: groupMedian,
      dropPct,
      rework: groupRework,
      verdict,
      partial,
    })
    k++
  }

  return { caliber, baseline, windows }
}

// ── ③ cohort 自證 JSON：canonical hash 與單票 live 量測 ─────────────────────

/** 遞迴排序 object key 後的穩定 JSON 字串化（陣列保持原順序，只排物件 key）；同一組資料永遠得到同一個字串。 */
export function canonicalStringify(value) {
  const sortValue = (v) => {
    if (Array.isArray(v)) return v.map(sortValue)
    if (v && typeof v === 'object') {
      // 🔴 事故（sol block 複審第 9 輪 Q2，2026-09-17）：用一般物件字面量 `{}` 重建時，JSON 自己合法帶的
      //   `__proto__` key 會被當成原型 setter 吞掉，不會成為重建物件上的自有 key——record 裡 `__proto__`
      //   欄位的值真的變了，重建後的物件卻看不出差異，canonicalStringify／recordsHash／inputHash 全部
      //   漏報。改用 `Object.create(null)` 重建（沒有原型，`__proto__` 只是一個普通 key）。
      const out = Object.create(null)
      for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(sortValue(value))
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/** 某票 lifecycle.ndjson 的原始位元組雜湊；不存在回 null。 */
export function lifecycleHashOf(localDir, ticket) {
  const f = join(localDir, ticket, 'lifecycle.ndjson')
  if (!existsSync(f)) return null
  return sha256Hex(readFileSync(f))
}

/**
 * 🔴 1.8.0 ②：cohort 專用的單票 live 量測——不依賴任何預先存在的 --write 產物，
 *   每次都從 lifecycle.ndjson 找視窗（landed／accepted，不用 last-event）、找 transcript、
 *   只累加「歸本票排他」的 assistant usage 記錄；同時收集這些記錄做 canonical 雜湊
 *   （③ 要的是「實際採計的 transcript records」的雜湊，不是整份會持續追加的 transcript 檔）。
 *
 * 回傳 { measurable:true, apiCalls, usageWindow, recordsHash, recordCount, transcript }
 *   或 { measurable:false, reason, usageWindow }（usageWindow 視進度可能為 null）。
 */
export async function measureTicketLive(ticket, localDir, config, repoRoot, deps = {}) {
  const lifecycleFile = join(localDir, ticket, 'lifecycle.ndjson')
  if (!existsSync(lifecycleFile)) {
    return { measurable: false, reason: 'no-lifecycle', usageWindow: null }
  }
  let entries = []
  try {
    entries = readFileSync(lifecycleFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return { measurable: false, reason: 'lifecycle-parse-error', usageWindow: null }
  }

  const window = parseLifecycleWindow(entries, { noLastEventFallback: true })
  if (!window.from || !window.to) {
    return { measurable: false, reason: '視窗缺時間', usageWindow: null }
  }

  const summaryFile = join(localDir, ticket, 'summary.json')
  let summary = {}
  try {
    summary = JSON.parse(readFileSync(summaryFile, 'utf8'))
  } catch {
    // 缺檔／壞檔交呼叫端處理母體資格；這裡只管量測，量不到就 measurable:false
  }

  const coordinator = typeof summary.coordinator === 'string' && summary.coordinator ? summary.coordinator : null
  const profile = coordinator ? config.profiles?.[coordinator] : null
  const harness = profile?.coordinator?.harness
  if (!coordinator || !profile) {
    return { measurable: false, reason: 'coordinator-profile-unknown', usageWindow: { from: window.from, to: window.to } }
  }
  // 只有 transcriptMeasurable 的 harness（claude）有 Claude Code transcript；其餘（含未知 harness）記 measurable:false。
  if (!isTranscriptMeasurable(harness)) {
    return { measurable: false, reason: `no-transcript-for-harness:${harness}`, usageWindow: { from: window.from, to: window.to } }
  }

  const runStartEntry = entries.find((e) => e && e.event === 'run-start')
  const sessionId = runStartEntry?.sessionId || null
  const projectsRoot = deps.projectsRoot || process.env.LLM_TEAM_PROJECTS_ROOT || join(homedir(), '.claude/projects')

  let transcriptPath = null
  if (sessionId) {
    const hit = findTranscriptBySession(projectsRoot, sessionId)
    if (hit) transcriptPath = hit.file
  }
  if (!transcriptPath) {
    const defaultProjectsDir = join(projectsRoot, slugOf(repoRoot))
    const preferred = [defaultProjectsDir]
    const mainRepo = findMainRepo(repoRoot, config)
    if (mainRepo) preferred.push(join(projectsRoot, slugOf(mainRepo)))
    const found = await findTranscriptAcross(projectsRoot, ticket, window.from, { preferred })
    if (found) transcriptPath = found.file
  }
  if (!transcriptPath) {
    return { measurable: false, reason: 'transcript-not-found', usageWindow: { from: window.from, to: window.to } }
  }

  const others = loadOtherWindows(localDir, ticket, { noLastEventFallback: true })
  const self = { ticket, from: window.from, to: window.to, runStartAt: runStartEntry?.at ?? window.from }

  // 🔴 事故（sol block 複審第 4 輪 Q3，2026-09-17）：舊版 recordsHash 只雜湊「從 record 投影出來的 usage
  //   欄位」（timestamp＋四個 token 數），改動被採計 record 的非 usage 欄位（例如 message.content）不會讓
  //   recordsHash 變，等於自證 JSON 沒有真的證明「這就是那筆 record」。改法：雜湊來源改成每一筆被採計
  //   record 的完整內容，依 timestamp 排序（同時間戳用原始檔案順序當 tie-breaker，Array.prototype.sort
  //   穩定排序天然滿足）後串接。
  // 🔴 事故（sol block 複審第 8 輪 Q5，2026-09-17）：上面那版把「完整內容」實作成整行原始 JSON 文字
  //   （trimmedLine，不重新序列化）——這把「寫入者當初序列化時的 key 順序」也當成了契約的一部分：同一筆
  //   record 的欄位值完全沒變，只要寫入者換一種 key 順序重寫（例如巢狀 usage 物件的四個欄位順序不同），
  //   recordsHash／inputHash 就會被誤判成「輸入變了」，假紅。改法：改用檔內既有的 canonicalStringify（遞迴
  //   排序 object key、陣列保持原順序）序列化每一筆已解析的 record 物件再串接雜湊——key 順序不再算數，但
  //   仍是雜湊「完整 record」（第 4 輪 Q3 的要求不變：改動非 usage 欄位一樣要讓 hash 變，canonical 化不是
  //   只挑幾個欄位投影）。record 在上面的採計迴圈裡已經 JSON.parse 過一次，這裡直接沿用解析出的物件
  //   （counted[].record），不重複 parse；canonicalStringify 對正常 JSON 值理論上不會丟例外，但仍包一層
  //   try/catch fail-closed——真的失敗就回 measurable:false 具名原因，不要吞掉讓 recordsHash 悄悄漏算。
  //   陽性對照：usage.test.mjs「1.8.0 ③ (Q3-e) 改一筆已採計 record 的非 usage 欄位 ⇒ recordsHash／inputHash
  //   都變」「改一筆視窗外（未採計）record ⇒ 不變」「(Q8-b) 同一批 record 換 key 順序 ⇒ 兩次雜湊相同」
  //   「(Q8-c) key 順序不變、值真的變 ⇒ hash 仍會變」。
  let apiCalls = 0
  const counted = [] // { timestamp, line, record }：line 是原始 JSON 行文字（僅供除錯參考，不再用來雜湊）；
                      // record 是同一行已經 JSON.parse 過的物件，canonical 雜湊直接沿用它。
  let sawTie = false
  let sawMissing = false
  try {
    let lineNo = 0
    for await (const rawLine of readLines(transcriptPath)) {
      lineNo++
      const trimmedLine = rawLine.trim()
      if (!trimmedLine) continue
      let record
      try {
        record = JSON.parse(trimmedLine)
      } catch (e) {
        throw new Error(`transcript 毀損行：${transcriptPath}:${lineNo}（${e.message}）`)
      }
      if (!record || !record.timestamp) continue
      if (!inWindow(record.timestamp, window.from, window.to)) continue
      if (record.type !== 'assistant' || !record.message?.usage) continue
      const attr = attributeRecord(record.timestamp, self, others)
      if (attr === null) {
        if (!self.from || !self.to || !self.runStartAt) sawMissing = true
        else sawTie = true
        continue
      }
      if (attr !== true) continue
      apiCalls++
      counted.push({ timestamp: record.timestamp, line: trimmedLine, record })
    }
  } catch (e) {
    return { measurable: false, reason: `transcript-corrupt:${e.message}`, usageWindow: { from: window.from, to: window.to } }
  }

  if (sawMissing || sawTie) {
    return {
      measurable: false,
      reason: sawMissing ? '視窗缺時間' : 'run-start 並列',
      usageWindow: { from: window.from, to: window.to },
    }
  }

  counted.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
  const canonicalLines = []
  for (const c of counted) {
    let canon
    try {
      canon = canonicalStringify(c.record)
    } catch (e) {
      return { measurable: false, reason: `record-canonicalize-failed:${e.message}`, usageWindow: { from: window.from, to: window.to } }
    }
    canonicalLines.push(canon)
  }
  const recordsHash = sha256Hex(canonicalLines.join('\n'))

  return {
    measurable: true,
    apiCalls,
    usageWindow: { from: window.from, to: window.to },
    recordsHash,
    recordCount: counted.length,
    transcript: transcriptPath,
  }
}

/**
 * 讀 usage.mjs 自身所在目錄的 SOURCE.json（快照）或 VERSION＋git rev-parse HEAD（真源），供 ③ JSON 的
 * toolVersion／sourceCommit／sourceKind（"snapshot" | "source-repo"）。
 *
 * 🔴 事故（sol block 複審第 4 輪 Q2，2026-09-17）：舊版對 SOURCE.json 缺失或解析失敗一律往下走、
 *   改拿 target repo 自己的 `git rev-parse HEAD` 冒充 source commit——在快照環境（`.agents/skills/llm-team/`
 *   底下本來就該有 SOURCE.json 的那種）這樣做會把「target repo 的 commit」誤標成「llm-team 工具的來源
 *   commit」，產生帶錯誤來源、卻仍可能 pass 的自證 JSON。
 *   改法：用 MANIFEST.sha256 是否存在判斷「這裡是不是快照環境」（只有 export.mjs 匯出時才會同時寫
 *   SOURCE.json 與 MANIFEST.sha256）；快照環境裡 SOURCE.json 缺失或解析失敗 ⇒ 回傳 `{ error }`，呼叫端
 *   fail-closed（--cohort exit 非 0，具名說缺／壞）；沒有 MANIFEST.sha256（真源環境，本來就不該有
 *   SOURCE.json）才落回自身 VERSION＋git HEAD，並標 `sourceKind: "source-repo"`；讀到合法 SOURCE.json
 *   則標 `sourceKind: "snapshot"`。
 *   陽性對照：usage.test.mjs「1.8.0 ③ (Q2) 快照環境刪 SOURCE.json／壞 JSON ⇒ --cohort exit 非 0」
 *            「1.8.0 ③ (Q2) 真源環境（無 MANIFEST.sha256）⇒ 正常，sourceKind=source-repo」。
 *
 * 🔴 事故（sol block 複審第 5 輪 Q2，2026-09-17）：第 4 輪只擋「SOURCE.json 缺失／解析失敗」與「快照
 *   缺 SOURCE.json」，但欄位本身缺、型別錯、格式錯（例如 `{}`、`sourceCommit: "abc"`）仍會 parse 成功、
 *   一路帶著 `null`／不合法值產出自證 JSON；真源分支的 `git rev-parse HEAD` 失敗也被 `catch` 吞成
 *   `null` 照樣放行。null／格式不對的 provenance 一樣是 fail-open——下游看不出「這是驗過的值」還是
 *   「工具舉手說不知道」。改法：`version` 一律驗非空字串（trim 後長度 >0）、`sourceCommit` 一律驗
 *   `/^[0-9a-f]{40}$/`（40 碼 hex），任一分支任一欄位不合 ⇒ 具名回 `{ error }`（說哪個欄位、哪個來源、
 *   實際拿到什麼，值截到 40 字），真源 git 失敗改回具名 error 不再 catch 吞掉。
 */
const SOURCE_COMMIT_HEX40_RE = /^[0-9a-f]{40}$/

function truncateForVersionError(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? 'undefined' : s.length > 40 ? `${s.slice(0, 40)}…` : s
}

function readToolVersionInfo(llmTeamDir, repoRoot, gitFn) {
  const sourceJsonPath = join(llmTeamDir, 'SOURCE.json')
  const manifestPath = join(llmTeamDir, 'MANIFEST.sha256')
  const looksLikeSnapshot = existsSync(manifestPath)

  if (existsSync(sourceJsonPath)) {
    let raw
    try {
      raw = readFileSync(sourceJsonPath, 'utf8')
    } catch (e) {
      return { error: `SOURCE.json 讀取失敗（${sourceJsonPath}）：${e.message}` }
    }
    let s
    try {
      s = JSON.parse(raw)
    } catch (e) {
      return { error: `SOURCE.json 解析失敗（${sourceJsonPath}）：${e.message}` }
    }
    const version = s?.version
    if (typeof version !== 'string' || version.trim().length === 0) {
      return { error: `SOURCE.json（快照，${sourceJsonPath}）的 version 欄位必須是非空字串，實際拿到 ${truncateForVersionError(version)}` }
    }
    const sourceCommit = s?.sourceCommit
    if (typeof sourceCommit !== 'string' || !SOURCE_COMMIT_HEX40_RE.test(sourceCommit)) {
      return { error: `SOURCE.json（快照，${sourceJsonPath}）的 sourceCommit 欄位必須是 40 碼 hex，實際拿到 ${truncateForVersionError(sourceCommit)}` }
    }
    return { version, sourceCommit, sourceKind: 'snapshot' }
  }

  if (looksLikeSnapshot) {
    return { error: `快照環境缺 SOURCE.json（${sourceJsonPath} 不存在，但 ${manifestPath} 存在）` }
  }

  // 真源環境：沒有 SOURCE.json 是正常狀態，用自身 VERSION＋git HEAD。
  const versionPath = join(llmTeamDir, 'VERSION')
  if (!existsSync(versionPath)) {
    return { error: `真源環境（${llmTeamDir}）缺 VERSION 檔（${versionPath}）` }
  }
  let version
  try {
    version = readFileSync(versionPath, 'utf8').trim()
  } catch (e) {
    return { error: `VERSION 檔讀取失敗（${versionPath}）：${e.message}` }
  }
  if (version.length === 0) {
    return { error: `VERSION 檔（${versionPath}）內容為空字串` }
  }
  let sourceCommit
  try {
    sourceCommit = gitFn(repoRoot, ['rev-parse', 'HEAD'])
  } catch (e) {
    return { error: `真源環境 git rev-parse HEAD 失敗（${repoRoot}）：${e.message}` }
  }
  if (typeof sourceCommit !== 'string' || !SOURCE_COMMIT_HEX40_RE.test(sourceCommit)) {
    return { error: `真源環境（${repoRoot}）git rev-parse HEAD 回傳值不是 40 碼 hex，實際拿到 ${truncateForVersionError(sourceCommit)}` }
  }
  return { version, sourceCommit, sourceKind: 'source-repo' }
}

/**
 * ③ 組出 cohort 的自證 JSON payload（不含 inputHash）；呼叫端算完 inputHash 再塞進去。
 * ticketDetails：每票 { ticket, caliber, apiCalls, run, usageWindow, lifecycleHash, recordsHash }。
 */
export function buildCohortPayload({ caliber, report, ticketDetails, toolVersion, sourceCommit, sourceKind, generatedAt }) {
  const lastNonPartial = [...report.windows].reverse().find((w) => !w.partial)
  const verdict = lastNonPartial ? lastNonPartial.verdict : null
  return {
    schemaVersion: COHORT_JSON_SCHEMA_VERSION,
    toolVersion: toolVersion ?? null,
    sourceCommit: sourceCommit ?? null,
    sourceKind: sourceKind ?? null,
    generatedAt,
    caliber,
    threshold: {
      dropPctMin: 40,
      reworkRule: '窗重工率（run>=2 張數/有 run 欄位張數）不高於基線重工率',
      baselineSize: 5,
      windowSize: 10,
    },
    baseline: {
      tickets: report.baseline.tickets,
      median: report.baseline.median,
      rework: report.baseline.rework,
      short: Boolean(report.baseline.short),
    },
    windows: report.windows.map((w) => ({
      k: w.k,
      tickets: w.tickets,
      median: w.median,
      dropPct: w.dropPct,
      rework: w.rework,
      verdict: w.verdict,
      partial: w.partial,
      ...(w.demotedReason ? { demotedReason: w.demotedReason } : {}),
    })),
    verdict,
    tickets: ticketDetails,
  }
}

/** 寫 cohort JSON 到 <localDir>/_cohort/<caliber>-<sanitizedTimestamp>.json；回傳寫入路徑。 */
export function writeCohortJson(localDir, caliber, payload) {
  const dir = join(localDir, '_cohort')
  mkdirSync(dir, { recursive: true })
  const safeTs = String(payload.generatedAt).replace(/[:.]/g, '-')
  const filePath = join(dir, `${caliber}-${safeTs}.json`)
  writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n')
  return filePath
}

// ── CLI 主流程 ─────────────────────────────────────────────────────────────

export async function main(argv, { cwd = process.cwd(), ...deps } = {}) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('-')) {
      console.error(`未知參數：${tok}`)
      return 2
    }
    const eqIdx = tok.indexOf('=')
    let key = tok
    let val = null
    if (eqIdx !== -1) {
      key = tok.slice(0, eqIdx)
      val = tok.slice(eqIdx + 1)
    }
    if (!KNOWN_FLAGS.has(key)) {
      console.error(`未知旗標：${key}`)
      return 2
    }
    if (VALUE_FLAGS.has(key)) {
      if (val === null) {
        val = argv[i + 1]
        if (val === undefined || val.startsWith('-')) {
          console.error(`旗標 ${key} 缺少值`)
          return 2
        }
        i++
      }
      flags[key] = val
    } else {
      if (val !== null) {
        console.error(`旗標 ${key} 不吃值（收到 ${val}）`)
        return 2
      }
      flags[key] = true
    }
  }

  if (flags['--help'] || flags['-h']) {
    console.log('用法：node .agents/skills/llm-team/usage.mjs --ticket <name> [--config <file>] [--projects-dir <dir>] [--transcript <file>] [--from <iso>] [--to <iso>] [--write] [--json]')
    return 0
  }

  if (flags['--tag-caliber'] !== undefined && flags['--cohort'] !== undefined) {
    console.error('🔴 --tag-caliber 與 --cohort 不可同時使用')
    return 2
  }

  const ticket = flags['--ticket']
  if (!ticket && flags['--cohort'] === undefined) {
    console.error('缺少必填旗標：--ticket')
    return 2
  }

  // 解析 repoRoot
  const gitFn = deps.git || git
  let repoRoot = deps.repoRoot ? resolve(deps.repoRoot) : null
  if (!repoRoot) {
    try {
      repoRoot = resolve(gitFn(cwd, ['rev-parse', '--show-toplevel']))
    } catch (e) {
      console.error(`🔴 無法取得 repoRoot：${e.message}`)
      return 2
    }
  }

  // 載入 config
  let config
  try {
    config = loadConfig(repoRoot, flags['--config'] || null)
  } catch (e) {
    console.error(`🔴 載入 config 失敗：${e.message}`)
    return 2
  }

  // 解析 localDir
  const localDir = resolve(repoRoot, config.outDir || '.local/llm-team')

  // --tag-caliber：只標 caliber，不找 transcript、不需要 config 以外的任何東西
  // 🔴 用旗標存在性判斷是否進入本模式（不是真假值）：`--tag-caliber ''` 也要落在這裡被判非法值，
  //   不能因為空字串是 falsy 就掉出本區塊、繼續往下跑到找 transcript 的路徑。
  if (flags['--tag-caliber'] !== undefined) {
    // 防守：互斥檢查已擋掉「--tag-caliber 加 --cohort」那條路徑，但 --tag-caliber 本身一定要有 --ticket，
    // 不靠上面那個「沒有 --cohort 才必填」的檢查繞著走——這裡直接再檢一次，缺了就不讓它掉進下面的 join(ticket) 拋錯。
    if (!ticket) {
      console.error('缺少必填旗標：--ticket')
      return 2
    }
    const caliber = flags['--tag-caliber']
    if (!CALIBERS.includes(caliber)) {
      console.error('🔴 --tag-caliber 只准 docs｜tool｜feature')
      return 2
    }
    const tagSummaryFile = join(localDir, ticket, 'summary.json')
    if (!existsSync(tagSummaryFile)) {
      console.error(`🔴 summary.json 不存在：${tagSummaryFile}`)
      return 1
    }
    let tagSummary
    try {
      tagSummary = JSON.parse(readFileSync(tagSummaryFile, 'utf8'))
    } catch (e) {
      console.error(`🔴 summary.json 解析失敗：${e.message}`)
      return 1
    }
    // 已標＝欄位存在性，不是真假值：既有 caliber:null／'' 也算已標過，不能被覆寫。
    if (Object.prototype.hasOwnProperty.call(tagSummary, 'caliber')) {
      console.error(`🔴 已標 ${JSON.stringify(tagSummary.caliber)}，不覆寫`)
      return 2
    }
    tagSummary.caliber = caliber
    tagSummary.caliberBy = 'coordinator'
    if (flags['--grandfathered']) {
      tagSummary.caliberGrandfathered = true
    }
    writeFileSync(tagSummaryFile, JSON.stringify(tagSummary, null, 2) + '\n')
    console.error(`已標 ${ticket} caliber=${caliber}`)
    return 0
  }

  // --cohort：對 localDir 底下每張票的 summary.json 做同口徑 cohort 判定，只讀檔、不找 transcript
  // 🔴 同樣用旗標存在性判斷（不是真假值），理由同 --tag-caliber。
  if (flags['--cohort'] !== undefined) {
    const caliber = flags['--cohort']
    if (!CALIBERS.includes(caliber)) {
      console.error('🔴 --cohort 只准 docs｜tool｜feature')
      return 2
    }

    // 🔴 事故（統整者 Q6 親驗 155c941，2026-09-17）：--cohort 路徑的 measureTicketLive 只看
    //   deps.projectsRoot／LLM_TEAM_PROJECTS_ROOT／~/.claude/projects，沒接到 CLI 的 `--projects-dir`；
    //   帶著這個旗標跑 --cohort 時全部 transcript-not-found（要改用 env 才對，違反旗標存在的意義）。
    //   改法：跟單票 --ticket 流程一致（見下方 `flags['--projects-dir']` 分支），--projects-dir 給了就
    //   resolve(cwd, flag) 蓋過 deps.projectsRoot／env／預設；沒給就照舊吃 deps/env/預設。
    //   陽性對照：usage.test.mjs「1.8.0 ③ (Q6) 只給 --projects-dir（不設 env）跑 --cohort」。
    const cohortDeps = flags['--projects-dir']
      ? { ...deps, projectsRoot: resolve(cwd, flags['--projects-dir']) }
      : deps

    let cohortEntries = []
    try {
      cohortEntries = existsSync(localDir) ? readdirSync(localDir, { withFileTypes: true }) : []
    } catch (e) {
      console.error(`🔴 讀取 localDir 失敗：${e.message}`)
      return 1
    }

    // 🔴 事故（sol block 複審第 1 輪 Q2，2026-09-17）：舊版對「已有 usage.measurable 欄位」的票整個跳過 live 量測、
    //   直接信任 summary 裡的舊欄位——過期的 `usage.mjs --write` 產物（甚至手改）可以在不碰 transcript、不驗
    //   measurementSchemaVersion 的情況下假 pass；同一個判斷還讓 schemaVersion 檢查只在「沒有舊 usage」時才跑，
    //   有舊 usage 的過期票反而繞過版本檢查。
    //   改法：cohort 一律重掃 lifecycle＋transcript，不管 summary 裡有沒有舊 usage 欄位；measurementSchemaVersion
    //   檢查對「同口徑的每一票」都套用，不再看有沒有舊 usage。舊欄位只留下來印一行「與 live 值矛盾」的對照訊息，
    //   不參與 verdict／JSON 的任何計算——量測值只能來自這次現場算出的 live 結果。
    //   陽性對照：usage.test.mjs「1.8.0 ②③ (b) 舊 usage 與 transcript 矛盾」「(c) 版本不符但有舊 usage 仍被排除」。
    //   停止條件：--write 這條手動診斷路徑被拔除、cohort 改成唯一權威量測入口時，這段對照訊息可以拆。
    const liveMeasured = new Map() // ticket ⇒ live 量測結果（③ JSON 要用）
    const summaries = []
    for (const entry of cohortEntries) {
      if (!entry.isDirectory()) continue
      const ticketName = entry.name
      if (ticketName === '_cohort') continue // ③ 自己的輸出目錄，不是票
      const otherSummaryFile = join(localDir, ticketName, 'summary.json')
      if (!existsSync(otherSummaryFile)) {
        console.error(`ℹ 略過 ${ticketName}：沒有 summary.json`)
        continue
      }
      let s
      try {
        s = JSON.parse(readFileSync(otherSummaryFile, 'utf8'))
      } catch (e) {
        // 🔴 事故（sol block 複審第 8 輪 Q2，2026-09-17）：舊版把「壞 summary.json（parse 失敗）」跟「沒有
        //   summary.json（進行中的票，本來就不該有）」用同一種「略過」處理——壞檔靜默消失會讓同口徑的一票
        //   直接從母體裡不見，剩下的票照樣算出 baseline／窗、照樣 exit 0、照樣產自證 JSON，等於用一份
        //   「少算一票」的假 pass 蓋過「有票壞了要人看」的事實。改法：同第 7 輪 Q2 的做法，在 cohort 邊界
        //   fail-closed——壞檔直接擋下整個 --cohort，不產出任何自證 JSON；「沒有 summary.json」那條分支不動
        //   （進行中的票本來就沒有，不是壞檔，繼續略過）。
        //   陽性對照：usage.test.mjs「1.8.0 ③ (Q8-a) 某票 summary.json 寫成非法 JSON ⇒ --cohort exit≠0」。
        console.error(`🔴 --cohort：${otherSummaryFile} 的 summary.json 解析失敗（${e.message}）——fail-closed，不產自證 JSON`)
        return 1
      }
      // 缺 ticket 欄位時補目錄名，僅供印名單，不寫回檔案（summaries 只在記憶體內給 cohortReport 用）。
      // 只在 ticket／name 都是 nullish 時才補——已有 ticket:'' 之類的假值不該被目錄名蓋掉。
      if (s.ticket == null && s.name == null) s.ticket = entry.name

      // 🔴 事故（sol block 複審第 7 輪 Q2，2026-09-17）：下游（liveMeasured.get／lifecycleHashOf）一律用
      //   summary.json 裡的 `s.ticket ?? s.name` 當 key 去查，但寫入 liveMeasured 與掃 lifecycle 檔用的卻是
      //   readdirSync 出來的**目錄名**（entry.name）。兩者只要不一致（summary.ticket 打錯、目錄手動改名、
      //   複製別票的 summary.json 沒改欄位……）就會靜默錯綁：live 量到但用錯 key 存，之後用 summary 欄位查
      //   查不到 ⇒ recordsHash 悄悄變 null；lifecycleHash 甚至讀到別的目錄的 lifecycle，自證 JSON 帶著
      //   看似正常、實則錯綁的資料，exit 仍是 0。改法：在 cohort 邊界擋下——ticket/name 必須是非空字串且
      //   逐字等於目錄名，否則直接 fail-closed，不產出任何自證 JSON。
      //   陽性對照：usage.test.mjs「1.8.0 ③ (Q7-a) summary.ticket 與目錄名不一致」「(Q7-b) ticket:''」。
      const resolvedName = s.ticket ?? s.name
      if (typeof resolvedName !== 'string' || resolvedName.trim().length === 0 || resolvedName !== ticketName) {
        console.error(
          `🔴 --cohort：${ticketName} 的 summary.json ticket/name=${JSON.stringify(resolvedName)} 與目錄名不一致（fail-closed，不產自證 JSON）`
        )
        return 1
      }

      if (s.caliber === caliber) {
        // 🔴 事故（sol block 複審第 2 輪 Q2，2026-09-17）：舊版用 hasOwnProperty 當閘——完全缺
        //   measurementSchemaVersion 欄位的舊票（連這個欄位都沒有，比「版本不符」更早期）會因為 hasOwnProperty
        //   為 false 而跳過整個檢查，預設放行混進 cohort。改法：只接受「欄位存在且恰好等於現版」的票；
        //   缺欄／版本不同一律排除，stderr 分開記錄是哪一種（缺欄 vs 版本 X≠Y），不含糊成同一句。
        //   陽性對照：usage.test.mjs「1.8.0 ②③ (Q3-b)」（版本不同）「(Q3-d)」（缺欄，且若誤採計會改變基線中位數）。
        if (s.measurementSchemaVersion !== MEASUREMENT_SCHEMA_VERSION) {
          const hasField = Object.prototype.hasOwnProperty.call(s, 'measurementSchemaVersion')
          const reason = hasField
            ? `版本 ${JSON.stringify(s.measurementSchemaVersion)}≠${MEASUREMENT_SCHEMA_VERSION}`
            : '缺欄'
          console.error(`ℹ 略過 ${ticketName}：measurementSchemaVersion 不符（${reason}），不進同一個 cohort`)
          continue
        }
        // 舊 usage 欄位（若有）先記下來，只當對照印出，不參與量測。
        const staleApiCalls =
          s.usage && typeof s.usage === 'object' && 'measurable' in s.usage
            ? s.coordinatorUsageExclusive?.apiCalls ?? null
            : undefined

        const live = await measureTicketLive(ticketName, localDir, config, repoRoot, cohortDeps)
        liveMeasured.set(ticketName, live)
        if (live.measurable) {
          if (typeof staleApiCalls === 'number' && staleApiCalls !== live.apiCalls) {
            console.error(
              `ℹ ${ticketName}：舊 usage 產物 apiCalls=${staleApiCalls} 與 live 量測 apiCalls=${live.apiCalls} 不符（僅供對照），採計 live 值`
            )
          }
          s.usage = { measurable: true }
          s.coordinatorUsageExclusive = { apiCalls: live.apiCalls }
          s.usageWindow = { from: live.usageWindow.from, to: live.usageWindow.to }
        } else {
          console.error(`ℹ ${ticketName}：live 量測不可得（${live.reason}）⇒ measurable:false`)
          s.usage = { measurable: false, reason: live.reason }
          s.coordinatorUsageExclusive = null
          s.usageWindow = live.usageWindow
        }
      }
      summaries.push(s)
    }

    // 🔴 事故（sol block 複審第 1 輪 Q5，2026-09-17）：readdirSync 回傳的檔案系統列舉順序不是任何作業系統都保證
    // 的穩定契約；直接把這個順序餵進 cohortReport／JSON payload，會讓「同一組票」在不同機器／檔案系統上排出不
    // 同的 tie-break 順序，inputHash 因此不穩定。
    // 改法：進 cohortReport 前先按票名（固定鍵）排序；cohortReport 內部對 usageWindow.from 相同的票再用
    // Array.prototype.sort 的穩定排序特性，以這裡先排好的票名順序當 tie-breaker。
    // 陽性對照：usage.test.mjs「1.8.0 ③ (Q5) 同一組票以相反順序餵入 ⇒ inputHash 相同」。
    // 停止條件：cohortReport 本身改成明確要求呼叫端傳已排序陣列並在簽章上標註時，這段排序可以搬過去、拆掉這裡的重複排序。
    summaries.sort((a, b) => {
      const an = String(a.ticket ?? a.name ?? '')
      const bn = String(b.ticket ?? b.name ?? '')
      return an < bn ? -1 : an > bn ? 1 : 0
    })

    const report = cohortReport(summaries, caliber)

    // 🔴 缺 transcript（或其他 live 量測失敗）⇒ 該票 measurable:false，cohort 不得 pass：
    //   只要這個口徑存在任一量不到的票，就把所有原本 'pass' 的窗降成 'provisional'（不做逐窗精準歸屬，
    //   寧可保守降級也不讓漏測的票被靜默排除後仍宣稱 pass）。
    const hasUnmeasurable = summaries.some((s) => s.caliber === caliber && s.usage && s.usage.measurable === false)
    if (hasUnmeasurable) {
      for (const w of report.windows) {
        if (w.verdict === 'pass') {
          w.verdict = 'provisional'
          w.demotedReason = 'unmeasurable-ticket-present'
        }
      }
    }

    // ③ 自證 JSON：不論 --json 與否都輸出一份，路徑＋inputHash 印到 stderr（機器讀的 report 仍照舊只印到 stdout）。
    const nowFn = deps.now || (() => new Date())
    const generatedAt = nowFn().toISOString()
    const llmTeamDir = deps.llmTeamDir || dirname(fileURLToPath(import.meta.url))
    const versionInfo = readToolVersionInfo(llmTeamDir, repoRoot, gitFn)
    if (versionInfo.error) {
      console.error(`🔴 --cohort：${versionInfo.error}（fail-closed，不產出自證 JSON）`)
      return 1
    }

    const eligibleTickets = summaries.filter((s) => s.caliber === caliber)
    const ticketDetails = eligibleTickets.map((s) => {
      const name = s.ticket ?? s.name
      const live = liveMeasured.get(name)
      return {
        ticket: name,
        caliber: s.caliber,
        apiCalls: s.coordinatorUsageExclusive?.apiCalls ?? null,
        run: s.run ?? null,
        usageWindow: s.usageWindow ?? null,
        lifecycleHash: lifecycleHashOf(localDir, name),
        recordsHash: live?.recordsHash ?? null,
      }
    })

    const payload = buildCohortPayload({
      caliber,
      report,
      ticketDetails,
      toolVersion: versionInfo.version,
      sourceCommit: versionInfo.sourceCommit,
      sourceKind: versionInfo.sourceKind,
      generatedAt,
    })
    payload.inputHash = sha256Hex(canonicalStringify({ ...payload, generatedAt: null }))
    const cohortJsonPath = writeCohortJson(localDir, caliber, payload)
    console.error(`已輸出 cohort JSON：${cohortJsonPath}（inputHash=${payload.inputHash}）`)

    if (flags['--json']) {
      console.log(JSON.stringify(report))
      return 0
    }

    if (report.baseline.short) {
      console.log(`基線未滿 ${report.baseline.tickets.length}/5`)
      return 0
    }

    for (const w of report.windows) {
      if (w.partial) {
        console.log(`窗 ${w.k} 未滿 ${w.tickets.length}/10（暫不判）`)
        continue
      }
      const verdictStr = w.verdict === 'pass' ? '✅ 過門檻' : (w.verdict === 'provisional' ? '🟡 provisional' : '🔴 未過')
      const baselineUnknownSuffix = report.baseline.rework.unknown > 0 ? `（${report.baseline.rework.unknown} 張無 run 欄位）` : ''
      const windowUnknownSuffix = w.rework.unknown > 0 ? `（${w.rework.unknown} 張無 run 欄位）` : ''
      console.log(
        `窗 ${w.k}：票 ${w.tickets.join(',')}；中位數 ${w.median}（基線 ${report.baseline.median}，降 ${w.dropPct.toFixed(1)}%）；` +
        `重工率 ${w.rework.n}/${w.rework.of}${windowUnknownSuffix}（基線 ${report.baseline.rework.n}/${report.baseline.rework.of}${baselineUnknownSuffix}）；` +
        `判定 ${verdictStr}`
      )
      if (w.verdict === 'provisional') {
        console.log('重工率不可比：缺 run 欄位')
      }
      if (w.demotedReason === 'unmeasurable-ticket-present') {
        console.log('判定降級：存在無法量測（缺 transcript 等）的票，不得 pass')
      }
    }
    return 0
  }

  // 讀取 summary.json 並做 harness 判定
  const summaryFile = join(localDir, ticket, 'summary.json')
  if (!existsSync(summaryFile)) {
    console.error(`🔴 summary.json 不存在：${summaryFile}`)
    return 1
  }
  let summary
  try {
    summary = JSON.parse(readFileSync(summaryFile, 'utf8'))
  } catch (e) {
    console.error(`🔴 summary.json 解析失敗：${e.message}`)
    return 1
  }

  const coordinator = typeof summary.coordinator === 'string' && summary.coordinator ? summary.coordinator : null
  const profile = coordinator ? config.profiles?.[coordinator] : null
  const harness = profile?.coordinator?.harness

  if (!coordinator || !profile) {
    console.log('ℹ 此票沒有 coordinator profile 或找不到 profile，apiCalls 不可量')
    if (flags['--write']) {
      summary.usage = { measurable: false, reason: 'coordinator-profile-unknown' }
      writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n')
      console.error(`已回填 summary.json: ${summaryFile}`)
    }
    return 0
  }

  if (!isTranscriptMeasurable(harness)) {
    console.log(`ℹ 此 harness（${harness}）沒有 Claude Code transcript，apiCalls 不可量`)
    if (flags['--write']) {
      summary.usage = {
        measurable: false,
        reason: `no-transcript-for-harness:${harness}`,
      }
      writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n')
      console.error(`已回填 summary.json: ${summaryFile}`)
    }
    return 0
  }

  const lifecycleFile = join(localDir, ticket, 'lifecycle.ndjson')
  if (!existsSync(lifecycleFile)) {
    console.error(`找不到 lifecycle.ndjson：${lifecycleFile}`)
    return 1
  }

  let lifecycleEntries = []
  try {
    const raw = readFileSync(lifecycleFile, 'utf8')
    lifecycleEntries = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch (e) {
    console.error(`讀取或解析 lifecycle.ndjson 失敗：${e.message}`)
    return 1
  }

  const window = parseLifecycleWindow(lifecycleEntries, {
    from: flags['--from'],
    to: flags['--to'],
  })

  // 找 transcript
  const runStartEntry = lifecycleEntries.find((e) => e && e.event === 'run-start')
  const sessionId = runStartEntry && runStartEntry.sessionId ? runStartEntry.sessionId : null

  let transcriptPath = null
  if (flags['--transcript']) {
    transcriptPath = resolve(cwd, flags['--transcript'])
    if (!existsSync(transcriptPath)) {
      console.error(`找不到 transcript 檔案：${transcriptPath}`)
      return 1
    }
  } else if (flags['--projects-dir']) {
    const projectsDir = resolve(cwd, flags['--projects-dir'])
    if (sessionId && typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId)) {
      const candidate = join(projectsDir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) {
        transcriptPath = candidate
      }
    }
    if (!transcriptPath) {
      transcriptPath = await findTranscript(projectsDir, ticket, window.from)
    }
    if (!transcriptPath) {
      console.error('找不到哪個 transcript 開了這張票；用 --transcript 指定')
      return 1
    }
  } else {
    const projectsRoot = deps.projectsRoot || process.env.LLM_TEAM_PROJECTS_ROOT || join(homedir(), '.claude/projects')
    if (sessionId) {
      const sessionHit = findTranscriptBySession(projectsRoot, sessionId)
      if (sessionHit) {
        transcriptPath = sessionHit.file
        console.error(`transcript 目錄：${sessionHit.dir}（sessionId）`)
      }
    }

    if (!transcriptPath) {
      const defaultProjectsDir = join(projectsRoot, slugOf(cwd))
      const preferred = [defaultProjectsDir]
      const mainRepo = findMainRepo(cwd, config)
      if (mainRepo) {
        preferred.push(join(projectsRoot, slugOf(mainRepo)))
      }

      const found = await findTranscriptAcross(projectsRoot, ticket, window.from, { preferred })
      if (found) {
        transcriptPath = found.file
        console.error(`transcript 目錄：${found.dir}`)
      }
    }

    if (!transcriptPath) {
      console.error(`lifecycle 的 sessionId=${sessionId || '無'}`)
      console.error('找不到哪個 transcript 開了這張票（已掃 ~/.claude/projects 全部子目錄）；用 --transcript 指定')
      return 1
    }
  }

  // 累加計數
  const others = loadOtherWindows(localDir, ticket)
  const self = {
    ticket,
    from: window.from,
    to: window.to,
    runStartAt: runStartEntry?.at ?? window.from,
  }

  let stats
  try {
    stats = await accumulate(streamJsonLines(transcriptPath), window, { others, self })
  } catch (e) {
    console.error(`🔴 ${e.message}；不回填（少算比沒數字更糟）`)
    return 1
  }

  const measuredAt = new Date().toISOString()
  const result = {
    ticket,
    transcript: transcriptPath,
    window,
    coordinatorTurns: stats.coordinatorTurns,
    notificationsExcluded: stats.notificationsExcluded,
    apiCalls: stats.apiCalls,
    usage: stats.usage,
    toolCalls: stats.toolCalls,
    exclusive: stats.exclusive,
    overlaps: stats.overlaps,
    ...(stats.exclusiveReason ? { exclusiveReason: stats.exclusiveReason } : {}),
    measuredAt,
    measurable: true,
  }

  if (flags['--write']) {
    summary.coordinatorTurns = stats.coordinatorTurns
    summary.coordinatorUsage = {
      ...stats.usage,
      apiCalls: stats.apiCalls,
      toolCalls: stats.toolCalls,
    }
    summary.coordinatorUsageExclusive = stats.exclusive
    summary.usageOverlaps = stats.overlaps
    summary.usageWindow = {
      ...window,
      transcript: transcriptPath,
      measuredAt,
    }
    summary.comparable = true
    summary.usage = { measurable: true }

    writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n')
    console.error(`已回填 summary.json: ${summaryFile}`)
  }

  // 人看的摘要印到 stderr
  console.error(`=== 統整者用量：${ticket} ===`)
  console.error(`Transcript: ${transcriptPath}`)
  console.error(`視窗: ${window.from} → ${window.to} (${window.windowEnd})`)
  console.error(`Turns: ${stats.coordinatorTurns} (排除通知: ${stats.notificationsExcluded})`)
  console.error(`API 呼叫: ${stats.apiCalls}`)
  if (stats.exclusive === null) {
    console.error(`API 呼叫（排他）: 無法計算（${stats.exclusiveReason || '不可判'}）`)
  } else {
    const excludedCount = stats.apiCalls - stats.exclusive.apiCalls
    if (excludedCount > 0) {
      const sources = (stats.overlaps || [])
        .filter((o) => o.excludedApiCalls > 0)
        .map((o) => o.ticket)
        .join('／')
      console.error(`API 呼叫（排他）: ${stats.exclusive.apiCalls}（扣 ${excludedCount} 筆，來自 ${sources}）`)
    } else {
      console.error(`API 呼叫（排他）: ${stats.exclusive.apiCalls}（扣 0 筆）`)
    }
  }
  if (!stats.overlaps || stats.overlaps.length === 0) {
    console.error('重疊: 無')
  } else {
    const overlapStr = stats.overlaps
      .map((o) => `${o.ticket} ${Math.round(o.overlapMs / 1000)}s`)
      .join(', ')
    console.error(`重疊: ${overlapStr}`)
  }
  console.error(`Usage: input=${stats.usage.input}, cacheCreation=${stats.usage.cacheCreation}, cacheRead=${stats.usage.cacheRead}, output=${stats.usage.output}`)
  console.error(`Tool calls: ${JSON.stringify(stats.toolCalls)}`)

  // 機器讀的 JSON 一律輸出到 stdout
  console.log(JSON.stringify(result))
  return 0
}

if (isDirectRun(import.meta.url)) {
  const code = await main(process.argv.slice(2))
  process.exit(code ?? 0)
}
