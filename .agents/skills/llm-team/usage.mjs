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

import { existsSync, readFileSync, writeFileSync, readdirSync, createReadStream, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { isDirectRun, loadConfig, git } from './lib.mjs'

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
export function parseLifecycleWindow(entries, { from, to } = {}) {
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
 */
export function loadOtherWindows(localDir, ticket) {
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

    const win = parseLifecycleWindow(lifecycleEntries)
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

    let cohortEntries = []
    try {
      cohortEntries = existsSync(localDir) ? readdirSync(localDir, { withFileTypes: true }) : []
    } catch (e) {
      console.error(`🔴 讀取 localDir 失敗：${e.message}`)
      return 1
    }

    const summaries = []
    for (const entry of cohortEntries) {
      if (!entry.isDirectory()) continue
      const otherSummaryFile = join(localDir, entry.name, 'summary.json')
      if (!existsSync(otherSummaryFile)) {
        console.error(`ℹ 略過 ${entry.name}：沒有 summary.json`)
        continue
      }
      let s
      try {
        s = JSON.parse(readFileSync(otherSummaryFile, 'utf8'))
      } catch (e) {
        console.error(`ℹ 略過壞 summary.json：${otherSummaryFile}（${e.message}）`)
        continue
      }
      // 缺 ticket 欄位時補目錄名，僅供印名單，不寫回檔案（summaries 只在記憶體內給 cohortReport 用）。
      // 只在 ticket／name 都是 nullish 時才補——已有 ticket:'' 之類的假值不該被目錄名蓋掉。
      if (s.ticket == null && s.name == null) s.ticket = entry.name
      summaries.push(s)
    }

    const report = cohortReport(summaries, caliber)

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

  if (harness !== 'claude') {
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
