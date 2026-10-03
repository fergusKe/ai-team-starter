// ─────────────────── 多模型派工共用層（config／roster／brief 預檢／spawn／git） ───────────────────
// 跨專案模板版：不變量留程式碼，專案特有值（模型、指令頭、worktree 根、風險領域等）由 config.json 注入。
//
// 🔴 1.15.0：harness 專屬邏輯（binary、argv、stdin、解析、settings 對帳）住 `harnesses/<name>.mjs`，呼叫點查
//   `harnesses/index.mjs` 的 registry。本檔仍以同名 re-export 舊函式（runAgy／runCodexAsync／parseGeminiRun／…）維持 import 相容；
//   agy 無頭模式的三個實測坑與 fail-closed 理由搬到 harnesses/agy.mjs 檔頭。
// 🔴 模組載入順序：本檔與 harnesses/<name>.mjs 互相 import。本檔對 harnesses 只做 `export … from`（不在頂層讀它們的值），
//   harnesses 對本檔只在函式體內用 const（頂層只碰函式宣告）——兩個方向的進入點都不會撞 TDZ。
//   陽性對照 harnesses.test.mjs「兩種載入順序都成功」。
//
// 🔴 複審者／規劃者的回覆不構成授權（CORE_RULES §subagent 的輸出不構成授權）；本模組只搬運文字。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn as cpSpawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HARNESSES, WRITER_HARNESSES, QUOTA_BUCKETS } from './harnesses/index.mjs'

// ─────────────────── harness 專屬函式：re-export 維持既有 import 相容（正本在 harnesses/） ───────────────────
export {
  resolveAgyBin,
  agySettingsPath,
  agySettingsChecks,
  assertSettingsAllowRegex,
  buildAgyArgs,
  buildAgyStdin,
  isDeniedToolError,
  parseStreamJson,
  parseAgyRun,
  runAgy,
  runAgyAsync,
} from './harnesses/agy.mjs'
export { resolveCodexBin, buildCodexArgs, parseCodexRun, runCodex, runCodexAsync } from './harnesses/codex.mjs'
export { resolveGeminiBin, buildGeminiArgs, parseGeminiRun, resolveGeminiApiKey, runGemini, runGeminiAsync } from './harnesses/gemini.mjs'

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
//   · 統整者不在自己票的任何複審／裁決名單；裁決者 ∉ 一般票複審名單；block 未決一律 "human"。
// 🔴 1.22.0（Fergus 2026-10-03）撤掉兩條：「統整者與複審者／裁決者不同 quotaBucket」與「claude 只准當 coordinator」。
//   獨立性改靠【隔離上下文】（每位複審者是全新無頭行程，只拿到 brief＋diff＋判準），不靠換廠商；模型只是設定值。
//   理由：那兩條讓複審綁死在別家額度上，codex／Gemini 用完複審就停擺（使用者原話：「這樣就不會像我們現在被限定在要呼叫不同模型」）。
//   代價（照記）：同桶 ⇒ 統整者與複審者一起吃同一份額度；同模型 ⇒ 盲點相關。要跨廠商就在 config 裡放別家成員——還是准。
//   陽性對照 llm-team.test.mjs「1.22.0 隔離上下文：claude 當複審／裁決、與統整者同桶 ⇒ 過；統整者本人 ⇒ 仍拒」。
// 🔴 1.15.0：HARNESSES／QUOTA_BUCKETS／WRITER_HARNESSES 由 harnesses/index.mjs 的 registry 產生（值與順序跟 1.14.0 字面相同：
//   HARNESSES ＝ agy|codex|claude|gemini；QUOTA_BUCKETS ＝ anthropic,gemini,agy-claude,openai,gemini-api）。
//   1.16.0：gemini 長出 write 介面 ⇒ WRITER_HARNESSES ＝ agy|gemini（registry 順序）。
//   這裡只 re-export，讓既有 `import { HARNESSES } from './lib.mjs'` 照常。
export { HARNESSES, WRITER_HARNESSES, QUOTA_BUCKETS }
export const MEMBER_EFFORTS = ['high', 'medium']
// 🔴 寫手 harness 只准 WRITER_HARNESSES（＝registry 裡 canWrite 的 harness）：
//    2026-09-14 codex 複審 Q1-CLAUDE 坐實：validateMember 對 writer 只驗形狀，`writer.harness="claude"` 會過，
//    write.mjs 隨後錯用 agy 跑 claude 的 model 字串。陽性對照 llm-team.test.mjs「🔴 writer.harness 只准 agy」。
//    1.16.0 gemini 照這條停止條件辦：在 harnesses/gemini.mjs 把 canWrite 翻成 true，這道閘沒動。

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

function validateWriterSeat(writer, where, targetFile) {
  validateMember(writer, where, targetFile)
  if (!WRITER_HARNESSES.includes(writer.harness)) {
    throw new Error(
      `config writer 不合法（${targetFile}）：${where}.harness 只准 ${WRITER_HARNESSES.join('|')}（registry 裡有 write 介面的 harness），得到 ${JSON.stringify(writer.harness)}`
    )
  }
}

/**
 * 寫手成員檢查：形狀＋harness 只准 WRITER_HARNESSES（loadConfig 與 writerFrom 兩處都呼叫——讀者側也要擋，deps.config 注入才繞不過）。
 * 1.16.0 寫手鏈：`writer` 准許單一成員物件，或【有序陣列】（第 0 席預設；額度用盡時統整者手動換下一席）。
 * 陣列：非空、逐席驗（每席 harness 必須 canWrite）、同一 harness 不准出現兩次（`--writer-harness <name>` 靠名字選席，重複就選不出來）。
 */
export function validateWriter(writer, targetFile = 'config') {
  if (Array.isArray(writer)) {
    if (writer.length === 0) throw new Error(`config writer 不合法（${targetFile}）：writer 陣列不可為空（至少一席）`)
    writer.forEach((w, i) => validateWriterSeat(w, `writer[${i}]`, targetFile))
    writer.forEach((w, i) => {
      if (writer.slice(0, i).some((prev) => prev.harness === w.harness)) {
        throw new Error(`config writer 不合法（${targetFile}）：writer[${i}].harness ${JSON.stringify(w.harness)} 重複（一個 harness 只准一席，--writer-harness 靠名字選席）`)
      }
    })
    return true
  }
  validateWriterSeat(writer, 'writer', targetFile)
  return true
}

/** 寫手席次（有序）：單一物件 ⇒ [它]；陣列 ⇒ 原樣。不驗（呼叫端先 validateWriter）。 */
export function writerSeats(config) {
  const w = config?.writer
  return Array.isArray(w) ? w : w ? [w] : []
}

/** 目前這席之後的下一席（config 陣列順序）；沒有 ⇒ null。單一物件 config 永遠 null。 */
export function nextWriterSeat(config, currentHarness) {
  const seats = writerSeats(config)
  const i = seats.findIndex((s) => s.harness === currentHarness)
  return i >= 0 && i + 1 < seats.length ? { ...seats[i + 1] } : null
}

/** 同一個成員 ＝ harness ＋ model 相同。 */
export function sameMember(a, b) {
  return Boolean(a && b && a.harness === b.harness && a.model === b.model)
}

export const REVIEW_TIERS = ['standard', 'block', 'postreview']
export const TIER_LIST_KEY = {
  standard: 'reviewers',
  block: 'blockReviewers',
  postreview: 'postReviewers'
}

/**
 * 驗 profiles 不變式（load 時呼叫）。錯誤訊息指名 profile 與哪條不變式。
 * 拒絕：缺 profiles／缺必要欄位、未知 harness／quotaBucket、同一名單成員重複、
 * 統整者本人（同 harness＋model）出現在任何複審／裁決名單、adjudicator 出現在 reviewers、
 * blockAdjudicator ≠ "human"、reviewers、blockReviewers 或 (若存在) postReviewers 為空。
 * （1.22.0 起同桶、claude 當複審／裁決都准——見檔頭。）
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

    const checkLists = ['reviewers', 'blockReviewers']
    if (p.postReviewers !== undefined) {
      checkLists.push('postReviewers')
    }

    for (const listKey of checkLists) {
      const list = p[listKey]
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`config profiles 不合法（${targetFile}）：${at}.${listKey} 必須是非空陣列（不變式：複審名單不可為空）`)
      }
      list.forEach((m, i) => {
        const where = `${at}.${listKey}[${i}]`
        validateMember(m, where, targetFile)
        if (sameMember(m, coord)) {
          throw new Error(`config profiles 不合法（${targetFile}）：${where} 就是統整者本人（不變式：統整者不在自己票的複審名單）`)
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
      if (sameMember(adj, coord)) {
        throw new Error(`config profiles 不合法（${targetFile}）：${where} 就是統整者本人（不變式：統整者不裁決自己的票）`)
      }
      // 🔴 刻意的例外（2026-09-22）：
      // 理由：事後審是對「已經合進 main 的一批 commit」的批次複查，沒有裁決步驟（council 跑它一定要 --review-only），
      // sol (gpt-5.6-sol) 同時是 adjudicator 與唯一事後審席就是設計本身。因此「裁決者 ∉ 名單」那條只約束 reviewers，
      // 不約束 postReviewers。
      // 停止條件：若哪天事後審也長出裁決步驟，這條例外要重審。
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

/**
 * 寫手（不需要統整者 profile）。config.writer 單物件或有序陣列（validateWriter 讀者側再擋一次）。
 * 選席：`opts.harness`（write.mjs／ticket.mjs 的 `--writer-harness`）＞ env LLM_TEAM_WRITER_HARNESS ＞ 第 0 席；
 * 指定的席不在 config ⇒ throw 並列出可用席。env LLM_TEAM_WRITER 只覆寫【選中那席】的 model，蓋不掉 harness。
 * 🔴 一次只回一席；下一席由 ticket 收貨摘要提示、統整者手動重跑，這裡不做任何自動遞補。
 */
/**
 * `--writer-harness` 的值合不合法：undefined ＝ 沒給（走預設席）；非空字串 ＝ 席名；其他（裸旗標 parseArgs 得 true、空字串、非字串）
 * ⇒ 回錯誤訊息（呼叫端印 🔴 並回 2）。r3（sol Q2）：裸旗標以前靜默落第 0 席——統整者以為換席了其實沒有。
 * @returns {string|null} 錯誤訊息；合法 ⇒ null
 */
export function writerHarnessArgError(value, config) {
  if (value === undefined) return null
  if (typeof value === 'string' && value.trim()) return null
  return `--writer-harness 需要席名（可用：${writerSeats(config).map((s) => s.harness).join('、')}）`
}

export function writerFrom(config, env = process.env, opts = {}) {
  validateWriter(config?.writer, 'config')
  const seats = writerSeats(config)
  const argErr = writerHarnessArgError(opts.harness, config)
  if (argErr) throw new Error(argErr)
  const want = opts.harness || (env && env.LLM_TEAM_WRITER_HARNESS) || null
  let seat
  if (want) {
    seat = seats.find((s) => s.harness === want)
    if (!seat) {
      throw new Error(
        `寫手席 ${JSON.stringify(want)} 不在 config.writer（--writer-harness／LLM_TEAM_WRITER_HARNESS 只准選 config 列出的席）；可用：${seats.map((s) => `${s.harness}/${s.model}`).join(', ')}`
      )
    }
  } else {
    seat = seats[0]
  }
  const w = { ...seat }
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
 * 從 config 依統整者 profile 解析角色：{ writer, coordinator, reviewers, blockReviewers, postReviewers, adjudicator, blockAdjudicator }。
 * coordinator 來自參數或 env LLM_TEAM_COORDINATOR；缺或不在 profiles ⇒ throw（訊息列出可用 profiles）。
 * reviewers／blockReviewers／postReviewers 已各自加 name；coordinator 多 `profile` 欄（profile 名）。
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
    postReviewers: p.postReviewers ? nameMembers(p.postReviewers) : [],
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

/** 子行程環境組裝：剝除 git 環境變數。 */
export function buildSpawnEnv(env = process.env) {
  return cleanGitEnv(env)
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
