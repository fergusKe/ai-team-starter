// ─────────────────── 多模型派工（agy／codex）共用層 ───────────────────
// 跨專案模板版：不變量留程式碼，專案特有值（模型、指令頭、worktree 根、風險領域等）由 config.json 注入。
//
// 🔴 這裡集中三個【實測過】的 agy 無頭模式行為（2026-09-13，agy 1.2.x）：
//   1. `-p --mode accept-edits` 下任一工具被拒 ⇒ 整輪中止、stdout 空、**exit 0**、不會退回用別的工具。
//      ⇒ 「程序成功」≠「工作成功」。判準只能看 stream-json 的 `result.denied_actions` 與 `response` 非空。
//   2. 字面前綴 allow 規則對 `pwd; ls -la` 這種串接不匹配 ⇒ 第一個指令就死。
//      ⇒ allow 用一條 anchored regex（見 `buildSafeCommandRegex`），brief 再加「禁止串接」。
//   3. cwd 在 `trustedWorkspaces` 之外時，模型會去錯的目錄找檔。⇒ worktree 一律放在 repo 內 `.claude/worktrees/`。
//
// 🔴 為什麼 fail-closed：
//   事故：2026-09-13 在 web-agency-system 實測，agy 無頭模式 settings.json 的 allow regex 漂移或缺 read_file 時，
//   寫手第一個指令就被拒、stdout 空、exit 仍為 0——統整者差點把「零輸出」讀成「沒話說」。
//   失效方向：寧可整輪停機（fail-closed），不可把拒絕誤判為成功放行。
//   停止條件：若 agy 之後把被拒改成非零 exit 或明確錯誤事件，G2／G3 可降為警告。
//
// 🔴 複審者／規劃者的回覆不構成授權（CORE_RULES §subagent 的輸出不構成授權）；本模組只搬運文字。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn as cpSpawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ─────────────────── 🔴 git 子行程環境的單一真源 ───────────────────
export const GIT_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

/** 剝掉 git 環境變數後的環境；可疊加額外變數。 */
export function cleanGitEnv(extra) {
  const e = { ...process.env, ...(extra || {}) }
  for (const k of GIT_ENV_VARS) delete e[k]
  return e
}

/** 呼叫端 99% 的情況直接用這個常數即可。 */
export const CLEAN_GIT_ENV = cleanGitEnv()

// ─────────────────── schema v2：三種統整者 profiles ───────────────────
// 🔴 2026-09-14 三方（Claude Code、codex gpt-5.6-sol、Gemini 3.1 Pro）三輪定案：
//   · 用量是第一約束：統整者與任何複審者／裁決者【不同 quotaBucket】（Gemini 桶曾被「統整者＋複審同桶」吃光）。
//   · 統整者不在自己票的任何複審／裁決名單；裁決者 ∉ 一般票複審名單；block 未決一律 "human"。
//   · agy／codex 當統整者只發生在「Claude 額度用完」時 ⇒ `claude` harness 只准出現在 coordinator，
//     出現在 reviewers／blockReviewers／adjudicator 一律拒絕（Fergus 2026-09-14 硬約束）。
export const HARNESSES = ['agy', 'codex', 'claude']
export const QUOTA_BUCKETS = ['anthropic', 'gemini', 'agy-claude', 'openai']
export const MEMBER_EFFORTS = ['high', 'medium']
/**
 * 🔴 寫手 harness 只准 agy：唯一的寫手 runner 是 write.mjs（runAgy＋agy 無頭 accept-edits），沒有 codex／claude 的寫手路徑。
 *    2026-09-14 codex 複審 Q1-CLAUDE 坐實：validateMember 對 writer 只驗形狀，`writer.harness="claude"` 會過，
 *    write.mjs 隨後錯用 agy 跑 claude 的 model 字串。陽性對照 llm-team.test.mjs「🔴 writer.harness 只准 agy」。
 *    停止條件：write.mjs 真的長出第二種寫手 runner 那天，把它加進這張表（不是拿掉這道閘）。
 */
export const WRITER_HARNESSES = ['agy']

// ─────────────────── 1.8.0：量測與 Q6 閘門解耦（usage.mode） ───────────────────
// 🔴 2026-09-17 codex gpt-5.6-sol 兩輪審查共識（ai-team-starter docs/DECISIONS.md）：`accept --caliber` 之前無條件必填，
//   跟 SKILL.md 規則⑤「缺標的票不納入」、規則⑦「停損期不開每票要餵的台帳」打架。改法：usage.mode 預設 off，
//   --caliber 只在 mode≠off 時必填；publish／land 永遠不依賴任何 usage 產物。
export const USAGE_MODES = ['off', 'record', 'cohort']
/**
 * 量測方法版本：cohort 的 live 量測（lifecycle＋transcript）改版時遞增。
 * accept 時把當下版本蓋在 summary.measurementSchemaVersion；cohort 只收版本相符的票，
 * 避免新舊算法（例如視窗終點規則改變）混進同一批統計。
 */
export const MEASUREMENT_SCHEMA_VERSION = 1

/** 成員物件基本形狀檢查；`where` 用來指名 profile 與欄位。 */
function validateMember(m, where, targetFile) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error(`config profiles 不合法（${targetFile}）：${where} 必須是成員物件 {harness, model, quotaBucket}`)
  }
  if (!HARNESSES.includes(m.harness)) {
    throw new Error(`config profiles 不合法（${targetFile}）：${where}.harness 未知（${JSON.stringify(m.harness)}），只准 ${HARNESSES.join('|')}`)
  }
  if (typeof m.model !== 'string' || !m.model.trim()) {
    throw new Error(`config profiles 不合法（${targetFile}）：${where}.model 必須是非空字串`)
  }
  if (!QUOTA_BUCKETS.includes(m.quotaBucket)) {
    throw new Error(`config profiles 不合法（${targetFile}）：${where}.quotaBucket 未知（${JSON.stringify(m.quotaBucket)}），只准 ${QUOTA_BUCKETS.join('|')}`)
  }
  if (m.effort !== undefined && !MEMBER_EFFORTS.includes(m.effort)) {
    throw new Error(`config profiles 不合法（${targetFile}）：${where}.effort 只准 ${MEMBER_EFFORTS.join('|')}，得到 ${JSON.stringify(m.effort)}`)
  }
}

/** 寫手成員檢查：形狀＋harness 只准 WRITER_HARNESSES（loadConfig 與 writerFrom 兩處都呼叫——讀者側也要擋，deps.config 注入才繞不過）。 */
export function validateWriter(writer, targetFile = 'config') {
  validateMember(writer, 'writer', targetFile)
  if (!WRITER_HARNESSES.includes(writer.harness)) {
    throw new Error(
      `config writer 不合法（${targetFile}）：writer.harness 只准 ${WRITER_HARNESSES.join('|')}（唯一的寫手 runner 是 write.mjs 的 agy），得到 ${JSON.stringify(writer.harness)}`
    )
  }
  return true
}

/** 同一個成員 ＝ harness ＋ model 相同。 */
export function sameMember(a, b) {
  return Boolean(a && b && a.harness === b.harness && a.model === b.model)
}

/**
 * 驗 profiles 不變式（load 時呼叫）。錯誤訊息指名 profile 與哪條不變式。
 * 拒絕：缺 profiles／缺必要欄位、未知 harness／quotaBucket、同一名單成員重複、
 * 統整者出現在任何複審／裁決名單、統整者與任一複審者／裁決者同桶、adjudicator 出現在 reviewers、
 * blockAdjudicator ≠ "human"、reviewers 或 blockReviewers 為空、claude harness 出現在非 coordinator 位置。
 */
export function validateProfiles(config, targetFile = 'config') {
  const profiles = config?.profiles
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles) || Object.keys(profiles).length === 0) {
    throw new Error(`config 缺 profiles（${targetFile}）：schema v2 需要 profiles.<name>.{coordinator,reviewers,blockReviewers,adjudicator,blockAdjudicator}`)
  }
  for (const [name, p] of Object.entries(profiles)) {
    const at = `profiles.${name}`
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new Error(`config profiles 不合法（${targetFile}）：${at} 必須是物件`)
    }
    for (const k of ['coordinator', 'reviewers', 'blockReviewers', 'adjudicator', 'blockAdjudicator']) {
      if (p[k] === undefined) throw new Error(`config profiles 不合法（${targetFile}）：${at} 缺必要欄位 ${k}`)
    }
    validateMember(p.coordinator, `${at}.coordinator`, targetFile)
    const coord = p.coordinator

    for (const listKey of ['reviewers', 'blockReviewers']) {
      const list = p[listKey]
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`config profiles 不合法（${targetFile}）：${at}.${listKey} 必須是非空陣列（不變式：複審名單不可為空）`)
      }
      list.forEach((m, i) => {
        const where = `${at}.${listKey}[${i}]`
        validateMember(m, where, targetFile)
        if (m.harness === 'claude') {
          throw new Error(`config profiles 不合法（${targetFile}）：${where} 是 claude harness（不變式：claude 只准當 coordinator——agy／codex 統整只在 Claude 額度用完時）`)
        }
        if (sameMember(m, coord)) {
          throw new Error(`config profiles 不合法（${targetFile}）：${where} 就是統整者本人（不變式：統整者不在自己票的複審名單）`)
        }
        if (m.quotaBucket === coord.quotaBucket) {
          throw new Error(`config profiles 不合法（${targetFile}）：${where} 與統整者同 quotaBucket=${m.quotaBucket}（不變式：統整者與複審者不同桶）`)
        }
        if (list.slice(0, i).some((prev) => sameMember(prev, m))) {
          throw new Error(`config profiles 不合法（${targetFile}）：${where} 在同一名單重複（${m.harness}/${m.model}）`)
        }
      })
    }

    const adj = p.adjudicator
    if (adj !== 'human') {
      const where = `${at}.adjudicator`
      validateMember(adj, where, targetFile)
      if (adj.harness === 'claude') {
        throw new Error(`config profiles 不合法（${targetFile}）：${where} 是 claude harness（不變式：claude 只准當 coordinator）`)
      }
      if (sameMember(adj, coord)) {
        throw new Error(`config profiles 不合法（${targetFile}）：${where} 就是統整者本人（不變式：統整者不裁決自己的票）`)
      }
      if (adj.quotaBucket === coord.quotaBucket) {
        throw new Error(`config profiles 不合法（${targetFile}）：${where} 與統整者同 quotaBucket=${adj.quotaBucket}（不變式：統整者與裁決者不同桶）`)
      }
      if (p.reviewers.some((m) => sameMember(m, adj))) {
        throw new Error(`config profiles 不合法（${targetFile}）：${where} 出現在 reviewers（不變式：裁決者 ∉ 一般票複審名單）`)
      }
    }

    if (p.blockAdjudicator !== 'human') {
      throw new Error(`config profiles 不合法（${targetFile}）：${at}.blockAdjudicator 只准 "human"（block 未決一律交人），得到 ${JSON.stringify(p.blockAdjudicator)}`)
    }
  }
  return true
}

/**
 * 載入專案的 llm-team config.json。
 * 缺檔或 schemaVersion !== 2 ⇒ fail-closed throw（收到 1 ⇒ 指名舊格式，不做自動轉換）。
 * maxRounds 超過硬上限 5 ⇒ fail-closed throw。
 */
export function loadConfig(repoRoot, configFile = null) {
  const targetFile = configFile ? path.resolve(configFile) : path.join(repoRoot, 'llm-team.config.json')
  if (!fs.existsSync(targetFile)) {
    throw new Error(`config 不存在：${targetFile}`)
  }
  let config
  try {
    config = JSON.parse(fs.readFileSync(targetFile, 'utf8'))
  } catch (e) {
    throw new Error(`config 解析失敗（${targetFile}）：${e.message}`)
  }
  if (config && config.schemaVersion === 1) {
    throw new Error(`config schemaVersion 1 舊格式：models/codexTier 已廢，改成 profiles（見 SKILL.md）（${targetFile}）`)
  }
  if (!config || config.schemaVersion !== 2) {
    throw new Error(`config schemaVersion 不支援（${targetFile}）：預期 2，得到 ${config?.schemaVersion}`)
  }
  if (config.models !== undefined || config.codexTier !== undefined) {
    throw new Error(`config 含已廢欄位 models/codexTier（${targetFile}）：schema v2 改成 writer＋profiles（見 SKILL.md）`)
  }
  validateWriter(config.writer, targetFile)
  validateProfiles(config, targetFile)
  if (typeof config.maxRounds === 'number' && config.maxRounds > 5) {
    throw new Error(`config maxRounds 超過硬上限 5（${targetFile}）：${config.maxRounds}`)
  }
  if (config.branchPrefixes === undefined) {
    config.branchPrefixes = []
  } else if (!Array.isArray(config.branchPrefixes)) {
    throw new Error(`config branchPrefixes 不支援（${targetFile}）：預期全為字串的陣列，得到型別 ${typeof config.branchPrefixes}`)
  } else if (!config.branchPrefixes.every((p) => typeof p === 'string')) {
    const invalidTypes = config.branchPrefixes.filter((p) => typeof p !== 'string').map((p) => typeof p)
    throw new Error(`config branchPrefixes 不支援（${targetFile}）：預期全為字串的陣列，得到包含非字串型別 [${invalidTypes.join(', ')}]`)
  } else if (config.branchPrefixes.some((p) => p.trim() === '')) {
    throw new Error(`config branchPrefixes 不支援（${targetFile}）：空前綴等於不檢查，要停用請用 []`)
  }
  if (config.usage === undefined) {
    config.usage = { mode: 'off' }
  } else {
    if (!config.usage || typeof config.usage !== 'object' || Array.isArray(config.usage)) {
      throw new Error(`config usage 不合法（${targetFile}）：必須是物件 {mode}`)
    }
    const mode = config.usage.mode === undefined ? 'off' : config.usage.mode
    if (!USAGE_MODES.includes(mode)) {
      throw new Error(`config usage.mode 不支援（${targetFile}）：只准 ${USAGE_MODES.join('|')}，得到 ${JSON.stringify(config.usage.mode)}`)
    }
    config.usage.mode = mode
  }
  return config
}

/** 寫手（不需要統整者 profile）；env LLM_TEAM_WRITER 覆寫 writer.model。harness 不准覆寫、只准 agy（讀者側再擋一次）。 */
export function writerFrom(config, env = process.env) {
  validateWriter(config?.writer, 'config')
  const w = { ...config.writer }
  if (env && env.LLM_TEAM_WRITER) w.model = env.LLM_TEAM_WRITER
  return w
}

/**
 * 依 model 字串推導複審者成員名稱：
 * model 字串含 opus ⇒ opus、含 sonnet ⇒ sonnet、含 gemini ⇒ gemini、含 gpt-oss ⇒ gpt-oss，
 * 其他 ⇒ model 字串本身：`.` 換成 `-`（gpt-5.6-sol ⇒ gpt-5-6-sol），再去掉非 [a-z0-9-] 字元。
 */
export function reviewerNameFor(model) {
  const m = String(model || '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('gemini')) return 'gemini'
  if (m.includes('gpt-oss')) return 'gpt-oss'
  return m.replace(/\./g, '-').replace(/[^a-z0-9-]/g, '')
}

/** 成員顯示名：`<harness>/<reviewerNameFor(model)>`，例 agy/gemini、codex/gpt-5-6-sol、claude/opus。 */
export function memberName(m) {
  return `${m.harness}/${reviewerNameFor(m.model)}`
}

/** 成員顯示名轉成檔名（`/` ⇒ `-`）：agy/gemini ⇒ agy-gemini。 */
export function memberFileName(name) {
  return String(name).replace(/\//g, '-')
}

/** 給一組成員各自加 `name`（同名第二個起加 -2、-3…，沿用 H9d 的 nameCounts 邏輯）。 */
export function nameMembers(members) {
  const nameCounts = new Map()
  return (members || []).map((m) => {
    const base = memberName(m)
    const count = (nameCounts.get(base) || 0) + 1
    nameCounts.set(base, count)
    return { ...m, name: count === 1 ? base : `${base}-${count}` }
  })
}

/**
 * 從 config 依統整者 profile 解析角色：{ writer, coordinator, reviewers, blockReviewers, adjudicator, blockAdjudicator }。
 * coordinator 來自參數或 env LLM_TEAM_COORDINATOR；缺或不在 profiles ⇒ throw（訊息列出可用 profiles）。
 * reviewers／blockReviewers 已各自加 name；coordinator 多 `profile` 欄（profile 名）。
 */
export function modelsFrom(config, env = process.env, coordinator = null) {
  const profiles = config?.profiles || {}
  const available = Object.keys(profiles)
  const name = coordinator || (env && env.LLM_TEAM_COORDINATOR) || null
  if (!name || !profiles[name]) {
    throw new Error(
      `統整者 profile ${name ? `不存在：${name}` : '未指定'}（帶 --coordinator <name> 或設 env LLM_TEAM_COORDINATOR）；可用 profiles：${available.join(', ') || '(無)'}`
    )
  }
  const p = profiles[name]
  return {
    writer: writerFrom(config, env),
    coordinator: { ...p.coordinator, profile: name },
    reviewers: nameMembers(p.reviewers),
    blockReviewers: nameMembers(p.blockReviewers),
    adjudicator: p.adjudicator === 'human' ? 'human' : { ...p.adjudicator, name: memberName(p.adjudicator) },
    blockAdjudicator: p.blockAdjudicator,
  }
}

// ─────────────────── 複審名單身分三元組（council members.json ⇄ ticket summary） ───────────────────
// 🔴 2026-09-14 codex 複審 Q5-IDENTITY：ticket 以前按【預期】檔名讀文字、自己貼上預期身分，publish 又只比 name——
//    config 漂移或同短名模型（agy/gemini ＝ gemini-3.1-pro-high 也 ＝ gemini-3.1-pro-low）可讓另一模型的輸出冒充預期成員。
//    現在 council review 寫 members.json（實際跑的成員＋結果），ticket run 只從它取名單、summary 記實際三元組並與 profile 比對，
//    publish 比對三元組（不比 name）且回頭讀 members.json——缺檔或不符 ⇒ 擋。
//    陽性對照 ticket.test.mjs「Q5 …同 name 不同 model ⇒ run 回 3／publish 擋」。停止條件：council 輸出改成帶簽章的結構化 schema 時重審。

/** 身分三元組 key：harness／model／quotaBucket（不含 name——name 是短名，會撞）。 */
export function rosterKey(m) {
  return `${m?.harness}/${m?.model}/${m?.quotaBucket}`
}

/** members.json 的每一項至少要有 name／harness／model／quotaBucket 四個非空字串。 */
export function isRosterEntry(m) {
  return Boolean(
    m && typeof m === 'object' && !Array.isArray(m) &&
    ['name', 'harness', 'model', 'quotaBucket'].every((k) => typeof m[k] === 'string' && m[k].trim() !== '')
  )
}

/** 讀 council 寫的 members.json：缺檔／壞 JSON／不是陣列／任一項缺身分 ⇒ null（呼叫端一律當「無法證明」處理）。 */
export function readMembersJson(file) {
  if (!fs.existsSync(file)) return null
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || !parsed.every(isRosterEntry)) return null
  return parsed
}

/**
 * 多重集合比對（以 rosterKey 為鍵）：回 { missing: 預期有但實際沒有的成員, unexpected: 實際有但預期沒有的成員, mismatch }。
 * 同一三元組出現兩次也要兩次都到齊（nameMembers 的 -2 只是顯示名）。
 */
export function compareRoster(expected, actual) {
  const count = (list) => {
    const m = new Map()
    for (const e of list || []) {
      const k = rosterKey(e)
      m.set(k, (m.get(k) || 0) + 1)
    }
    return m
  }
  const exp = count(expected)
  const act = count(actual)
  const missing = []
  const unexpected = []
  for (const e of expected || []) {
    const k = rosterKey(e)
    if ((act.get(k) || 0) > 0) act.set(k, act.get(k) - 1)
    else missing.push(e)
  }
  const expLeft = new Map(exp)
  for (const a of actual || []) {
    const k = rosterKey(a)
    if ((expLeft.get(k) || 0) > 0) expLeft.set(k, expLeft.get(k) - 1)
    else unexpected.push(a)
  }
  return { missing, unexpected, mismatch: missing.length > 0 || unexpected.length > 0 }
}

/** 顯示用：`name〔harness/model/quotaBucket〕`。 */
export function rosterLabel(m) {
  return `${m?.name || '?'}〔${rosterKey(m)}〕`
}

/** Gemini headless 提示必須以這句開頭（它會想跑指令，無頭模式自動拒絕 ⇒ 零輸出）。 */
export const NO_EXEC_HEADER = '🔴 不要執行任何指令、不要讀任何檔案。只依提示內容回答。\n\n'

/** 寫手提示哨兵（專案 GEMINI.md 靠它判斷「我是寫手不是統整者」）。 */
export const WRITER_PROMPT_SENTINEL = '【llm-team 寫手票】'

/** 複審提示哨兵（codex／claude 複審者從 cwd 讀得到 AGENTS.md／CLAUDE.md，薄索引靠這行判斷「你是複審者，只答 Q 題，不必讀正本」）。 */
export const REVIEW_PROMPT_SENTINEL = '【llm-team 複審票】'

/** 規劃提示哨兵（council plan）。 */
export const PLAN_PROMPT_SENTINEL = '【llm-team 規劃】'

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const BASE_COMMAND_HEADS = [
  'pwd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'echo',
  'sed -n',
  'awk',
  'sort',
  'uniq',
  'diff',
  'tr',
  'cut',
  'date',
  'which',
  'node --test',
  'node --check',
  'node -e',
  'node -v',
  'cd',
  'git status',
  'git diff',
  'git log',
  'git ls-files',
  'git rev-parse',
  'git blame',
  'git show',
  'git grep',
]

/** 內建基底（不包含特定專案工具如 pnpm、npx vitest、node tools/）。由 BASE_COMMAND_HEADS 單一來源組出。 */
export const BASE_SAFE_HEAD = BASE_COMMAND_HEADS.map(escapeRegex).join('|')

/**
 * 寫手在無頭模式准跑的指令：內建基底 ＋ config 的 allowCommandHeads。
 * 與 settings.json permissions.allow 對帳用。
 */
export function buildSafeCommandRegex(config = null) {
  const customHeads = (config?.allowCommandHeads || []).map(escapeRegex)
  const head = '(' + [BASE_SAFE_HEAD, ...customHeads].filter(Boolean).join('|') + ')'
  const seg = head + '[^;&|<>`$]*'
  return '^' + seg + '(\\s*(;|&&|\\|)\\s*' + seg + ')*\\s*$'
}

export const SAFE_COMMAND_REGEX = buildSafeCommandRegex()

export function isSafeCommand(cmd, config = null) {
  return new RegExp(buildSafeCommandRegex(config)).test(cmd)
}

/** 取得 brief 指令預檢允許的指令頭：BASE_COMMAND_HEADS ＋ config.allowCommandHeads 去重 */
export function briefCommandHeads(config = null) {
  const customHeads = Array.isArray(config?.allowCommandHeads) ? config.allowCommandHeads : []
  return Array.from(new Set([...BASE_COMMAND_HEADS, ...customHeads.filter(Boolean)]))
}

/** 檢查指令是否以准許指令頭開頭，且指令頭後為字串結尾或空白（token boundary） */
export function startsWithAllowedHead(cmd, heads) {
  if (typeof cmd !== 'string' || !Array.isArray(heads)) return false
  const trimmed = cmd.trim()
  return heads.some((h) => {
    if (!h) return false
    if (trimmed === h) return true
    if (trimmed.startsWith(h) && /^\s/.test(trimmed.slice(h.length))) return true
    return false
  })
}

function normalizeBriefCmd(raw) {
  let s = raw.trim()
  // 去掉行首 Markdown list／checkbox 前綴（- 、* 、1. 、- [ ] ）
  s = s.replace(/^([-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, '')
  s = s.replace(/^\[[ xX]\]\s+/, '')
  s = s.trim()
  // 去掉可選的 $ 提示字元
  s = s.replace(/^\$\s+/, '')
  return s.trim()
}

function extractInlineSpansFromLine(line) {
  const spans = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '`') {
      const start = i
      while (i < line.length && line[i] === '`') {
        i++
      }
      const len = i - start
      let found = false
      let searchIdx = i
      while (searchIdx < line.length) {
        const nextTick = line.indexOf('`', searchIdx)
        if (nextTick === -1) break
        let closeStart = nextTick
        let closeEnd = nextTick
        while (closeEnd < line.length && line[closeEnd] === '`') {
          closeEnd++
        }
        const closeLen = closeEnd - closeStart
        if (closeLen === len) {
          spans.push(line.slice(i, closeStart))
          i = closeEnd
          found = true
          break
        } else {
          searchIdx = closeEnd
        }
      }
      if (!found) {
        // 未配對的 backtick 視為字面、不算 span
      }
    } else {
      i++
    }
  }
  return spans
}

const ALLOWED_FENCE_INFO = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'text'])

/**
 * 掃描 brief 內文中的指令：
 * 只有兩處：(i) inline code span；(ii) info string 為空或屬 bash/sh/shell/zsh/console/text 的 fenced code block。
 * 未關閉的 fence 拋錯。
 */
export function extractBriefCommands(briefText) {
  if (typeof briefText !== 'string' || !briefText) return []
  const lines = briefText.split('\n')
  const results = []

  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  let fenceOpenLine = 0
  let scanBlock = false

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1
    const rawLine = lines[i].replace(/\r$/, '')

    if (inFence) {
      const closeRe = new RegExp(`^\\s*\\${fenceChar}{${fenceLen},}\\s*$`)
      if (closeRe.test(rawLine)) {
        inFence = false
        scanBlock = false
        continue
      }
      if (scanBlock) {
        const cmd = normalizeBriefCmd(rawLine)
        if (cmd) {
          results.push({ line: lineNum, cmd })
        }
      }
      continue
    }

    // 檢查是否為 opening fence（``` 或 ~~~，開頭長度 ≥ 3）
    const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const openChar = fenceMatch[1][0]
      const rest = fenceMatch[2]
      // 若開頭為 backtick 但同列後方仍含 backtick（或 tilde 含 tilde），非 fenced block
      if (!rest.includes(openChar)) {
        inFence = true
        fenceChar = openChar
        fenceLen = fenceMatch[1].length
        fenceOpenLine = lineNum
        // info string 只看首 token（CommonMark：首字是語言，其餘是渲染器參數）：`bash title="x"` 掃、`bashx` 不掃。失效方向：漏掃＝寫手派工後才被 allow regex 拒絕；多掃＝統整者改一行 brief。2026-09-15 兩位 block 複審者一致定案。
        const infoStr = rest.trim().split(/\s+/)[0].toLowerCase()
        scanBlock = ALLOWED_FENCE_INFO.has(infoStr)
        continue
      }
    }

    // 非 fence，掃描該行內的 inline code spans
    const spans = extractInlineSpansFromLine(rawLine)
    for (const span of spans) {
      const cmd = normalizeBriefCmd(span)
      if (cmd) {
        results.push({ line: lineNum, cmd })
      }
    }
  }

  if (inFence) {
    throw new Error(`brief 格式錯誤：第 ${fenceOpenLine} 行的 fence 沒有關閉`)
  }

  return results
}

const BRIEF_SHELL_META_CHARS = [';', '&', '|', '<', '>', '`', '$']

/**
 * 預檢 brief 內文中的指令是否符合寫手執行期 allow 規則。
 * 只檢以准許指令頭開頭的指令；不合規者回傳 failures。
 */
export function preflightBriefCommands(briefText, config = null) {
  const extracted = extractBriefCommands(briefText)
  const heads = briefCommandHeads(config)
  const failures = []

  for (const item of extracted) {
    if (!startsWithAllowedHead(item.cmd, heads)) {
      continue
    }
    if (!isSafeCommand(item.cmd, config)) {
      const found = BRIEF_SHELL_META_CHARS.filter((ch) => item.cmd.includes(ch))
      const charsStr = found.length > 0 ? found.join(' ') : '未知'
      const reason = `含 shell 元字元：${charsStr}（引號內也算；管線只准接在准許指令頭之間；多樣式用多個 -e）`
      failures.push({
        line: item.line,
        cmd: item.cmd,
        reason,
      })
    }
  }

  return { failures }
}

/** agy binary：cask 裝的不在 PATH，路徑含版本號。可用 `AGY_BIN` 覆寫（測試用假 binary 也走這裡）。 */
export function resolveAgyBin(env = process.env) {
  if (env.AGY_BIN) return env.AGY_BIN
  const root = '/opt/homebrew/Caskroom/antigravity-cli'
  if (!fs.existsSync(root)) return null
  const versions = fs.readdirSync(root).filter((d) => !d.startsWith('.')).sort()
  for (const v of versions.reverse()) {
    const p = path.join(root, v, 'antigravity')
    if (fs.existsSync(p)) return p
  }
  return null
}

export function resolveCodexBin(env = process.env) {
  return env.CODEX_BIN || 'codex'
}

export function agySettingsPath(env = process.env) {
  return env.AGY_SETTINGS || path.join(env.HOME || '', '.gemini', 'antigravity-cli', 'settings.json')
}

/**
 * 對帳：settings.json 的 `permissions.allow` 必須恰好含本檔的 regex 那一條。
 * 失效方向刻意選「擋下來」——allow 漂移的失效方向是寫手第一個指令就死、stdout 空、我以為它沒話說。
 */
export function assertSettingsAllowRegex(settingsFile = agySettingsPath(), repoRoot = null, config = null) {
  if (!fs.existsSync(settingsFile)) throw new Error(`agy settings 不存在：${settingsFile}`)
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const allow = (s.permissions && s.permissions.allow) || []
  const wantRegex = buildSafeCommandRegex(config)
  const want = `command(regex:${wantRegex})`
  if (!allow.includes(want)) {
    throw new Error(`agy settings permissions.allow 缺這條（或與 tools/agy-lib.mjs 漂移）：\n${want}`)
  }
  // 🔴 2026-09-13 實測：無頭模式連 trustedWorkspaces 內的 read_file 都要明確 allow，否則第一次 view_file 就整輪死。
  //    規則的 target 是「repo 根（尾巴 /）」——worktree 在 .claude/worktrees/ 底下，被這條覆蓋。
  if (repoRoot) {
    const root = repoRoot.endsWith('/') ? repoRoot : repoRoot + '/'
    const ok = allow.some((a) => {
      const m = a.match(/^read_file\((.+)\)$/)
      if (!m) return false
      const t = m[1].endsWith('/') ? m[1] : m[1] + '/'
      return root.startsWith(t) || m[1] === '*'
    })
    if (!ok) throw new Error(`agy settings permissions.allow 缺 read_file(${root})（無頭模式讀 worktree 檔會被拒）`)
  }
  return true
}

/** 子行程環境組裝：剝除 git 環境變數。 */
export function buildSpawnEnv(env = process.env) {
  return cleanGitEnv(env)
}

/** 組裝 agy 呼叫引數。包含 --print-timeout（避免預設 5m 超時導致 partial output 零輸出）。 */
// 🔴 1.12.0：prompt 不再放 argv（`-p <prompt>`），改走 stream-json stdin（buildAgyStdin）。
//   理由：argv 有平台上限（Linux 單一參數 128 KiB；macOS ARG_MAX 1 MiB 含 env），archive-review.sh 2026-09-19 事故就是拿 110 KB
//   上限擋 change 又不入帳。實測 384 KB prompt 走 stdin 成功（plan 模式）；accept-edits 下 stdin 與 -p 行為相同。
//   `--print=`（空值）是 agy 的要求：`--print` 沒帶值會把下一個 flag 當 prompt 吃掉；spawn 不經 shell，所以是 `--print=` 不是 `--print=''`。
//   `--disable-slash-commands`：實測 stream-json 輸入不會展開開頭的 `/plan`，加著是防禦、行為不變。
//   陽性對照 llm-team.test.mjs「1.12.0 agy stdin」：args 不含 prompt 也不含 -p；input 解析回原文。
export function buildAgyArgs({ model, mode, timeoutMs = 10 * 60 * 1000, extraArgs = [] }) {
  const printTimeout = `${Math.max(1, Math.ceil(timeoutMs / 60000))}m`
  return [
    '--model',
    model,
    '--mode',
    mode,
    '--print-timeout',
    printTimeout,
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--disable-slash-commands',
    ...extraArgs,
    '--print=',
  ]
}

/** stream-json stdin 的唯一一行：{"event":"user","message":{"role":"user","content":<prompt>}}＋換行。JSON.stringify 編碼換行、引號、反斜線。 */
export function buildAgyStdin(prompt) {
  return JSON.stringify({ event: 'user', message: { role: 'user', content: String(prompt) } }) + '\n'
}

/**
 * 非同步 spawn 子行程，回傳 Promise<{ status, signal, stdout, stderr }>。
 * 與 spawnSync 回傳形狀一致：
 * - 支援 opts.timeout：到期自動 kill('SIGTERM')，status: null, signal: 'SIGTERM'。
 * - 支援 opts.maxBuffer：超過上限截斷並在 stderr 記一行。
 * - 回傳的 Promise 物件掛 `.child`（ChildProcess）：呼叫端的 watchdog 逾時時可以自己把子行程殺掉，
 *   否則 runner 會因為還有活著的子行程而不自退（T6 NIT）。spawn 本身 throw 時 `.child` 是 null。
 */
export function spawnAsync(bin, args = [], opts = {}) {
  let childRef = null
  const promise = new Promise((resolve, reject) => {
    const encoding = opts.encoding || 'utf8'
    const timeout = opts.timeout || 0
    const killGraceMs = opts.killGraceMs !== undefined ? opts.killGraceMs : 5000
    const maxBuffer = opts.maxBuffer || 64 * 1024 * 1024
    const stdio = opts.stdio || ['ignore', 'pipe', 'pipe']
    const cwd = opts.cwd
    const env = opts.env

    let child
    try {
      child = cpSpawn(bin, args, { cwd, env, stdio })
    } catch (err) {
      return reject(err)
    }
    childRef = child

    let stdout = ''
    let stderr = ''
    // opts.input：一次 end(payload) 餵 stdin（1.12.0 agy prompt 走 stdin）。子行程先退 ⇒ EPIPE 只記一行 stderr，不變成未捕捉例外。
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', (err) => {
        stderr += `\n[spawnAsync] stdin error: ${err && err.code ? err.code : err}\n`
      })
      child.stdin.end(opts.input)
    }
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let timer = null
    let killTimer = null
    let effectiveSignal = null

    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        effectiveSignal = 'SIGTERM'
        try {
          child.kill('SIGTERM')
        } catch {
          /* 忽略可能已退出的錯誤 */
        }
        if (killGraceMs > 0) {
          killTimer = setTimeout(() => {
            effectiveSignal = 'SIGKILL'
            try {
              child.kill('SIGKILL')
            } catch {
              /* 忽略可能已退出的錯誤 */
            }
          }, killGraceMs)
          if (killTimer.unref) killTimer.unref()
        }
      }, timeout)
      if (timer.unref) timer.unref()
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString(encoding)
        if (stdout.length + str.length > maxBuffer) {
          if (!stdoutTruncated) {
            stdout += str.slice(0, Math.max(0, maxBuffer - stdout.length))
            stdoutTruncated = true
          }
        } else {
          stdout += str
        }
      })
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString(encoding)
        if (stderr.length + str.length > maxBuffer) {
          if (!stderrTruncated) {
            stderr += str.slice(0, Math.max(0, maxBuffer - stderr.length))
            stderrTruncated = true
          }
        } else {
          stderr += str
        }
      })
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      reject(err)
    })

    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (stdoutTruncated) {
        stderr += `\n[spawnAsync] stdout exceeded maxBuffer (${maxBuffer} bytes) and was truncated\n`
      }
      if (stderrTruncated) {
        stderr += `\n[spawnAsync] stderr exceeded maxBuffer (${maxBuffer} bytes) and was truncated\n`
      }
      const reportedSignal = timedOut
        ? (sig === 'SIGKILL' || effectiveSignal === 'SIGKILL' ? 'SIGKILL' : (sig || effectiveSignal || 'SIGTERM'))
        : (sig || null)
      resolve({
        status: timedOut ? null : (code !== null ? code : null),
        signal: reportedSignal,
        timedOut,
        stdout,
        stderr,
      })
    })
  })
  promise.child = childRef
  return promise
}

/**
 * spawn 結果是否為逾時：spawnAsync 給 `timedOut: true`；spawnSync 的 `timeout` 到期則是 `error.code === 'ETIMEDOUT'`
 * （status null、signal SIGTERM）——write.mjs 走 spawnSync，P5 要靠這條分辨「寫手逾時」與「寫手被拒」。
 */
export function spawnTimedOut(res) {
  const r = res || {}
  return r.timedOut === true || Boolean(r.error && r.error.code === 'ETIMEDOUT')
}

/** 解析 runAgy 或 runAgyAsync 之 spawn 結果物件。 */
export function parseAgyRun(res) {
  const r = res || {}
  const parsed = parseStreamJson(r.stdout || '')
  return {
    exit: r.status,
    signal: r.signal || null,
    timedOut: spawnTimedOut(r),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    result: parsed.result,
    steps: parsed.steps,
    denied: parsed.denied,
    conversationId: parsed.conversationId,
  }
}

/**
 * 跑一次 agy headless（同步版）。回 { exit, signal, stdout, stderr, result, steps, denied, conversationId }。
 * - `result` 是 stream-json 最後的 result 物件（沒有 ⇒ null）。
 * - `denied` 是被拒的 action 清單（`result.denied_actions` ∪ 步驟裡 permission 失敗的 tool）。
 * 🔴 stderr 一定要保留：無頭拒絕的訊息只出現在 stderr，而 exit 是 0。
 */
export function runAgy({
  model,
  mode,
  prompt,
  cwd,
  timeoutMs = 10 * 60 * 1000,
  env = process.env,
  extraArgs = [],
  spawn = spawnSync,
}) {
  const bin = resolveAgyBin(env)
  if (!bin) throw new Error('找不到 agy binary（cask antigravity-cli 未裝；或設 AGY_BIN）')
  const args = buildAgyArgs({ model, mode, timeoutMs, extraArgs })
  const r = spawn(bin, args, {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    input: buildAgyStdin(prompt),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return parseAgyRun(r)
}

/**
 * 跑一次 agy headless（非同步版）。prompt 走 stdin（spawnAsync 的 opts.input：一次 end(payload)，EPIPE 記進 stderr 不炸）。
 */
export async function runAgyAsync({
  model,
  mode,
  prompt,
  cwd,
  timeoutMs = 10 * 60 * 1000,
  env = process.env,
  extraArgs = [],
  spawn = spawnAsync,
}) {
  const bin = resolveAgyBin(env)
  if (!bin) throw new Error('找不到 agy binary（cask antigravity-cli 未裝；或設 AGY_BIN）')
  const args = buildAgyArgs({ model, mode, timeoutMs, extraArgs })
  const r = await spawn(bin, args, {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    input: buildAgyStdin(prompt),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return parseAgyRun(r)
}

/**
 * agy 無頭「工具被拒」的訊息形狀（實測 2026-09-13，run_command）：
 *   `permission check failed for command "…": user denied permission to run command`
 * 判準是這兩段字，不是訊息裡有沒有 permission 這個詞——`declaring permissions: … stat …`（ENOENT）不算。
 */
export function isDeniedToolError(message) {
  const m = String(message || '')
  return /permission check failed/i.test(m) || /denied permission/i.test(m)
}

/** 解析 stream-json：抽 result、工具步驟、被拒清單、conversationId。壞行不丟，記進 steps 讓人看得到。 */
export function parseStreamJson(text) {
  let result = null
  const steps = []
  const denied = []
  let initConversationId = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      steps.push({ unparsed: line.slice(0, 200) })
      continue
    }
    if (d.event === 'init' && d.conversation_id) {
      initConversationId = d.conversation_id
    }
    if (d.event === 'result' && d.result) {
      result = d.result
      for (const a of d.result.denied_actions || []) denied.push({ action: a.action, tool: a.display_name })
    }
    const su = d.step_update
    if (su && su.tool_name && (su.state === 'DONE' || su.state === 'ERROR')) {
      const info = su.tool_info || {}
      const err = info.error && info.error.message
      steps.push({ state: su.state, tool: su.tool_name, params: info.parameters || {}, error: err || null })
      // 🔴 只認 agy 真正「被拒」的形狀（permission check failed … user denied permission）。
      //    2026-09-15 票 coordinator-usage：ENOENT 的訊息是「declaring permissions: cortex tool view_file: … failed to read file: stat …」，
      //    以前用 /permission/i 一咬就把它當 denied ⇒ ticket run 回 3、P5 不開 council，而寫手其實 SUCCESS、檔都寫好了
      //    （偵測「壞了」的字串咬到「在談論壞掉」）。陽性對照 llm-team.test.mjs「ENOENT 不是被拒」。
      if (err && isDeniedToolError(err)) denied.push({ action: 'permission', tool: su.tool_name, detail: err.slice(0, 200) })
    }
  }
  const conversationId = (result && result.conversation_id) || initConversationId || null
  return { result, steps, denied, conversationId }
}

/** 組裝 codex exec 引數（effort 來自成員的 `effort`，預設 high）。 */
export function buildCodexArgs({ model, prompt, effort = 'high', cwd }) {
  if (!model) throw new Error('runCodex 需要 model（來自 profile 成員的 model）')
  return ['exec', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '--sandbox', 'read-only', '-C', cwd, prompt]
}

/** 解析 runCodex 或 runCodexAsync 之 spawn 結果物件。 */
export function parseCodexRun(res) {
  const r = res || {}
  return {
    exit: r.status,
    signal: r.signal || null,
    timedOut: spawnTimedOut(r),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  }
}

/**
 * 跑一次 codex exec（唯讀 sandbox，同步版）。
 * 🔴 stdin 一律接 /dev/null（`< /dev/null`）——否則會掛著等輸入。
 */
export function runCodex({
  model,
  prompt,
  cwd,
  effort = 'high',
  timeoutMs = 15 * 60 * 1000,
  env = process.env,
  spawn = spawnSync,
}) {
  const bin = resolveCodexBin(env)
  const args = buildCodexArgs({ model, prompt, effort, cwd })
  const r = spawn(bin, args, {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return parseCodexRun(r)
}

/**
 * 跑一次 codex exec（唯讀 sandbox，非同步版）。
 */
export async function runCodexAsync({
  model,
  prompt,
  cwd,
  effort = 'high',
  timeoutMs = 15 * 60 * 1000,
  env = process.env,
  spawn = spawnAsync,
}) {
  const bin = resolveCodexBin(env)
  const args = buildCodexArgs({ model, prompt, effort, cwd })
  const r = await spawn(bin, args, {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return parseCodexRun(r)
}


/** worktree 的 git 呼叫（剝掉 hook 環境變數，`-C` 才真的作用在那棵樹）。 */
export function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失敗（${cwd}）：${(r.stderr || '').trim()}`)
  return (r.stdout || '').trim()
}

/**
 * 取得 worktree 當前狀態的 git tree SHA（40 hex）。
 * 用獨立暫存 index，不碰工作樹真 index、不 stash，略過 .agy-write/。
 */
export function writeTreeOf(worktree, tmpIndex = path.join(os.tmpdir(), `agy-tree-index-${process.pid}-${crypto.randomUUID()}`)) {
  const runGit = (args) => {
    const r = spawnSync('git', ['-C', worktree, ...args], { env: { ...CLEAN_GIT_ENV, GIT_INDEX_FILE: tmpIndex }, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失敗（${worktree}）：${(r.stderr || '').trim()}`)
    return (r.stdout || '').trim()
  }
  try {
    runGit(['read-tree', 'HEAD'])
    runGit(['add', '-A', '--', '.', ':(exclude).agy-write'])
    return runGit(['write-tree'])
  } finally {
    fs.rmSync(tmpIndex, { force: true })
  }
}

/** 已改／新增／刪除的檔（相對 worktree 根），含 untracked。 */
export function changedFiles(cwd) {
  // 🔴 不能走 git()（它 trim 整段 stdout）：porcelain 第一行 ` M path` 的前導空白會被吃掉 ⇒ `slice(3)` 切掉路徑第一個字
  //    （2026-09-13 真跑第一次就咬到：`tools/x` 變 `ools/x`，被 G4 判成越界）。用 -z 逐筆切，不看空白。
  const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=all'], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git status 失敗（${cwd}）：${(r.stderr || '').trim()}`)
  const files = []
  const entries = (r.stdout || '').split('\0')
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]
    if (!line) continue
    const xy = line.slice(0, 2)
    let p = line.slice(3)
    // rename/copy：-z 模式下「新路徑 NUL 舊路徑」，舊路徑是下一個 entry，要跳過
    if (xy[0] === 'R' || xy[0] === 'C') i++
    files.push(p)
  }
  return files
}

/** 越界檔＝改了但不在 allowlist。allowlist 是相對 worktree 根的路徑；目錄尾巴 `/` 代表整棵。 */
export function outOfScope(changed, allowlist) {
  const dirs = allowlist.filter((a) => a.endsWith('/'))
  const exact = new Set(allowlist.filter((a) => !a.endsWith('/')))
  return changed.filter((f) => !(exact.has(f) || dirs.some((d) => f.startsWith(d))))
}

/** 一行 ndjson 台帳（append-only；永不 throw——台帳壞掉不能把主流程拖死）。 */
export function ledgerAppend(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    /* 只記錄不擋 */
  }
}

/** 極簡 argv 解析：`--k v` / `--flag`；重複的 `--allow` 會累成陣列。 */
export function parseArgs(argv, multi = [], { strictPositional = false } = {}) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const k = a.slice(2)
    const next = argv[i + 1]
    const v = next === undefined || next.startsWith('--') ? true : (i++, next)
    if (multi.includes(k)) (out[k] ||= []).push(v)
    else out[k] = v
  }
  if (strictPositional && out._.length > 0) {
    const err = new Error(`多餘的位置參數：${out._.join(' ')}`)
    err.positionals = [...out._]
    throw err
  }
  return out
}

/** 是否「被直接執行」：symlink 兩邊都 realpath 後再比，否則經 ~/.claude/skills symlink 呼叫時 main() 靜默不跑、exit 0。 */
export function isDirectRun(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return fs.realpathSync(fileURLToPath(importMetaUrl)) === fs.realpathSync(argv1)
  } catch {
    return false
  }
}
