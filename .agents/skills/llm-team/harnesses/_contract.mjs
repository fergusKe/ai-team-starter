// ─────────────────── harness 介面（契約說明＋驗證） ───────────────────
// 🔴 1.15.0（Fergus 2026-09-22：「應該要可以統一一個地方管理」）：以前每個呼叫點自己認 harness 名字——
//   lib.mjs 三套平行 runAgy／runCodex／runGemini、council.mjs 四處 `if (harness === …)`、write.mjs 整檔只認 agy、
//   setup.mjs 三處（binary 怎麼找、GEMINI_API_KEY 閘、agy settings 對帳）。加一個 harness 要動 4–5 個檔。
//   現在 harness 專屬邏輯各自住 `harnesses/<name>.mjs`，呼叫點只透過 `harnesses/index.mjs` 的 registry 查介面；
//   測試接縫只有一個：`deps.getHarness`（注入假 harness），不再有 deps.runAgyAsync 這類逐 harness 的別名。
// 🔴 這是行為不變的重構：每個 harness 對外的 argv、stdin、env、輸出檔、台帳欄位一字不變。
// 🔴 拿掉任何一個 harness 的必填欄位 ⇒ index.mjs 載入時 assertHarnessContract 就 throw（fail-closed，不是等到派工才死）。
//   陽性對照 harnesses.test.mjs「① registry 每個成員通過 assertHarnessContract；缺欄位的假 harness 被拒且訊息列出缺的欄」。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { cleanGitEnv } from '../lib.mjs'

/**
 * @typedef {object} Failure 一次呼叫失敗的分類（統整者／台帳用；null ＝ 沒有可辨識的失敗）。
 * @property {'auth'|'quota'|'policy'|'timeout'|'process'|'protocol'} kind
 *   timeout ＝ 逾時被殺；auth ＝ 缺 API key（沒 spawn）；policy ＝ 工具被拒（agy denied 非空）；
 *   quota ＝ stderr 出現 429／RESOURCE_EXHAUSTED（2026-09-21 agy 訂閱額度用盡的形狀）；1.16.0 另加：codex stderr
 *   「You've hit your usage limit」／rate limit（09-22 事故，以前顯示零輸出）、gemini 寫手 result.error 含 Quota／429／RESOURCE_EXHAUSTED；
 *   process ＝ 非零 exit（或被 signal 殺）且無法歸到上面任何一類；protocol ＝ 程序成功但 stdout 解析不出預期形狀
 *   （1.16.0 r3 gemini 寫手：code 'stream:unparsed_line'｜'stream:unpaired_tool'（tool_use 沒有同 tool_id 的 tool_result）｜'stream:no_result'；
 *   write.mjs G3 對 kind protocol 一律 FAIL，就算正文非空——sol Q3）。
 * @property {string} [code]          可辨識的錯誤碼（例 'RESOURCE_EXHAUSTED'、'429'、'usage limit'、gemini 的 error.type）
 * @property {boolean} retryable      timeout 是 true；codex 的 usage limit／rate limit 也是 true（額度到點會 reset，可晚點重派同一席）；
 *                                    其餘都要人（或設定）介入，fail-closed 不自動重試。
 *   🔴 寫手鏈（1.16.0）：`failure.kind==='quota'` 是 ticket.mjs 收貨摘要印「下一席」提示的唯一觸發條件；
 *   統整者自己決定要不要 `--writer-harness <next>` 重跑，工具不自動連跑下一席（council 09-22 第 4 題定案）。
 */

/**
 * @typedef {object} ReviewResult 複審（唯讀）一次呼叫的統一形狀。
 * @property {number|null} exit        子行程 exit code（逾時／被殺／沒 spawn ⇒ null）
 * @property {string|null} signal
 * @property {boolean} timedOut
 * @property {string} stdout           原始 stdout（agy 是 stream-json 全文；gemini 是 JSON 全文）
 * @property {string} stderr
 * @property {string} text             複審者的回覆正文（codex ⇒ stdout；agy ⇒ result.response；gemini ⇒ response）
 * @property {Array<object>} denied    被拒的工具清單（只有 agy 會非空）
 * @property {object|null} usage       用量（agy ⇒ result.usage；gemini ⇒ stats；codex ⇒ null）
 * @property {Failure|null} failure
 * @property {object} raw              原本 harness 專屬的解析結果（agy 的 {result, steps, …}、codex 的 parseCodexRun、
 *                                     gemini 的 {response, stats, keyMissing}）——舊讀者要的欄位都在這裡，統一層不重複（例：keyMissing 只住 raw）
 */

/**
 * @typedef {object} WriteResult 寫手（accept-edits）一輪的統一形狀。ReviewResult 的欄位全有，另加：
 * @property {Array<object>} steps           工具步驟（agy stream-json 的 step_update；gemini 的 tool_use＋tool_result 合成一步 {tool, id, params, status, error, denied}）
 * @property {string|null} conversationId    續輪用的對話 id（agy ＝ conversation_id → `--conversation`；gemini ＝ init 事件的 session_id → `--resume`）
 *   denied 的元素形狀：agy `{action, tool, detail?}`；gemini `{action:'policy', tool, detail}`（tool_result error.type policy_violation）。
 *   🔴 兩者被拒時 exit 都是 0——呼叫端只看 denied 非空與 text 空，不看 exit。
 */

/**
 * @typedef {object} PreflightCheck setup --check／write G2 共用的預檢項目。
 * @property {boolean} ok
 * @property {string} label            印在 `[label]` 裡的名字（例 `command(regex)`）
 * @property {string} [okText]         ✓ 後面的字（例 `存在`／`覆蓋`）
 * @property {string} [failText]       ✗ 後面的字（例 `缺少`）
 * @property {string} [message]        write G2 擋下時印的完整訊息
 * @property {string[]} [roles]        這條屬於哪些角色（'write'|'setup'）；harness 依 deps.role 過濾後才回傳，呼叫端不再看這欄
 * @property {object} [fix]            setup 印「請手動合併」片段用：{ file, allow?: string[], trustedWorkspaces?: string[] }
 */

/**
 * @typedef {object} Harness
 * @property {'agy'|'codex'|'gemini'|'claude'} name
 * @property {string[]} quotaBuckets       這個 harness 會用到的 quotaBucket（agy ＝ Antigravity 訂閱的 gemini／agy-claude 兩桶）
 * @property {boolean} canCoordinate
 * @property {boolean} canReview
 * @property {boolean} canWrite
 * @property {boolean} transcriptMeasurable  usage.mjs 量不量得到（只有 claude 有 Claude Code transcript）
 * @property {(env: object) => string|null} resolveBin           只回 bin 路徑或名字，不 spawn
 * @property {(env: object, deps: object) => ({path: string, version?: string, versionError?: string}|null)} checkBinary  setup --check 用
 * @property {{ envVar: string, resolve: (env, deps) => string, describe: (env, deps) => 'env'|'Keychain'|'缺' }} [auth]
 *   🔴 describe 的合法回傳是【封閉】的三個字串（見 AUTH_SOURCES）：setup --check 只對 'env'／'Keychain' 印 ✓；'缺' 印 ✗ 缺；
 *   其他任何值（undefined、大小寫錯、拼錯）一律 fail-closed 印 ✗ 未知來源（sol r2 Q2）——回傳值本身不印，永不印 key。
 *   🔴 resolve 的回傳值只准進子行程 env，不准 log、不准塞進任何回傳物件。
 * @property {(env: object, config: object, deps: object) => PreflightCheck[]} [preflight]  讀不到必要設定檔 ⇒ throw
 *   deps.role ∈ 'write'|'setup'：write.mjs G2 只拿「要擋」的條目（🔴 回傳的任一條 !ok 就擋，write.mjs 沒有放行分支），setup --check 拿全部。
 *   deps.repoRoot／deps.outDir：write.mjs G2 兩個都給（outDir ＝ 寫手產物目錄，跟台帳同層）；ticket.mjs G2 在 worktree／outDir 建立前跑，只給 repoRoot。
 *   🔴 preflight 是「共同入口、各自實作」（council 09-22 第 3 題）：agy ＝ 讀 settings.json 對帳（唯讀）；
 *   gemini ＝ 從 config.allowCommandHeads 產 policy TOML，有 outDir 才寫到 `<outDir>/gemini-policy.toml`
 *   （唯一准許的副作用，只在 outDir、絕不寫 `~/.gemini/`、**絕不進 worktree**——r2 統整者真跑坐實：落在 worktree 會被列成改動檔、擋 land）。
 * @property {{ run: (opts) => Promise<ReviewResult>, runSync: (opts) => ReviewResult, normalize: (raw) => ReviewResult }} [review]
 *   canReview:true ⇒ 必填。opts：{ model, prompt, cwd, timeoutMs, env?, spawn?, resolveKey?, effort?, noExecHeader? }
 * @property {{ run: (opts) => WriteResult, resume: (opts) => WriteResult, normalize: (raw) => WriteResult, lastStepIsToolError: (steps) => boolean }} [write]
 *   canWrite:true ⇒ 必填（1.16.0：agy、gemini）。opts：{ model, prompt, cwd, timeoutMs, outDir, env?, spawn?, resolveKey?, conversationId?（resume 必填） }
 *   outDir ＝ write.mjs 的產物目錄，harness 自己決定用不用（gemini 從這裡讀 preflight 寫的 policy；agy 不用）。
 *   🔴 寫手鏈：config.writer 可以是有序陣列（席次順序 ＝ 額度用盡時的建議順序）；一次只跑一席，`--writer-harness <name>`／
 *   env LLM_TEAM_WRITER_HARNESS 選席，預設第 0 席；quota 時 ticket 收貨摘要只【提示】下一席，不自動連跑。
 * @property {string} [hook]           相對本目錄上一層的 PreToolUse 轉接器檔名（例 `agy-pretooluse.sh`）
 *
 * normalize(raw)：舊形狀（run*／parse*Run 的回傳）⇒ 統一形狀。args(opts)：run／runSync 交給 runner 的引數（純函式）。
 * 兩者都是 run 的拆解，測試用假 harness 攔派工時靠它們拿到跟真派工一樣的引數、轉出一樣的形狀（見 llm-team.test.mjs fakeHarnessFrom）。
 */

const HARNESS_NAMES = ['agy', 'codex', 'gemini', 'claude']
/** auth.describe 的封閉回傳集合；前兩個是「可達」，'缺' 是「不可達」。不在集合裡 ⇒ setup 當不可達（fail-closed）。 */
export const AUTH_SOURCES = ['env', 'Keychain', '缺']
export const AUTH_SOURCES_OK = ['env', 'Keychain']
const BOOLEAN_FIELDS = ['canCoordinate', 'canReview', 'canWrite', 'transcriptMeasurable']

/**
 * 驗一個 harness 模組物件符合介面；缺欄／型別錯 ⇒ throw，訊息列出全部問題（不是只報第一個）。
 * @param {Harness} h
 * @returns {true}
 */
export function assertHarnessContract(h) {
  const problems = []
  if (!h || typeof h !== 'object') throw new Error('harness 契約不符：不是物件')
  if (!HARNESS_NAMES.includes(h.name)) problems.push(`name 必須是 ${HARNESS_NAMES.join('|')}，得到 ${JSON.stringify(h.name)}`)
  if (!Array.isArray(h.quotaBuckets) || h.quotaBuckets.length === 0 || !h.quotaBuckets.every((b) => typeof b === 'string' && b)) {
    problems.push('缺 quotaBuckets（非空字串陣列）')
  }
  for (const k of BOOLEAN_FIELDS) {
    if (typeof h[k] !== 'boolean') problems.push(`缺 ${k}（boolean）`)
  }
  if (typeof h.resolveBin !== 'function') problems.push('缺 resolveBin(env)')
  if (typeof h.checkBinary !== 'function') problems.push('缺 checkBinary(env, deps)')
  if (h.auth !== undefined) {
    if (!h.auth || typeof h.auth !== 'object') problems.push('auth 必須是物件')
    else {
      if (typeof h.auth.envVar !== 'string' || !h.auth.envVar) problems.push('auth.envVar 必須是非空字串')
      if (typeof h.auth.resolve !== 'function') problems.push('缺 auth.resolve(env, deps)')
      if (typeof h.auth.describe !== 'function') problems.push('缺 auth.describe(env, deps)')
    }
  }
  if (h.preflight !== undefined && typeof h.preflight !== 'function') problems.push('preflight 必須是函式')
  if (h.canReview === true) {
    if (!h.review || typeof h.review !== 'object') problems.push('canReview 但缺 review')
    else {
      for (const k of ['run', 'runSync', 'normalize']) {
        if (typeof h.review[k] !== 'function') problems.push(`缺 review.${k}`)
      }
    }
  }
  if (h.canWrite === true) {
    if (!h.write || typeof h.write !== 'object') problems.push('canWrite 但缺 write')
    else {
      for (const k of ['run', 'resume', 'normalize', 'lastStepIsToolError']) {
        if (typeof h.write[k] !== 'function') problems.push(`缺 write.${k}`)
      }
    }
  }
  if (h.hook !== undefined && (typeof h.hook !== 'string' || !h.hook)) problems.push('hook 必須是非空字串（相對檔名）')
  if (problems.length) {
    throw new Error(`harness ${JSON.stringify(h.name)} 契約不符：\n  - ${problems.join('\n  - ')}`)
  }
  return true
}

const QUOTA_STDERR_RE = /RESOURCE_EXHAUSTED|\b429\b/

/**
 * 失敗分類（各 harness 的 normalize 共用；第一個命中的類別勝出）：
 *   timedOut ⇒ timeout（retryable）；authMissing ⇒ auth；denied 非空 ⇒ policy；
 *   非零 exit／被 signal 殺：stderr 有 429／RESOURCE_EXHAUSTED ⇒ quota，否則 process；
 *   exit 0 但 parsed:false（stdout 解析不出預期形狀）⇒ protocol；其餘 null。
 * @returns {Failure|null}
 */
export function classifyFailure({ timedOut = false, exit = null, signal = null, stderr = '', authMissing = false, denied = [], parsed = true }) {
  if (timedOut) return { kind: 'timeout', retryable: true }
  if (authMissing) return { kind: 'auth', retryable: false }
  if (Array.isArray(denied) && denied.length > 0) return { kind: 'policy', retryable: false }
  if (exit !== 0) {
    const m = String(stderr || '').match(QUOTA_STDERR_RE)
    if (m) return { kind: 'quota', code: m[0], retryable: false }
    return { kind: 'process', code: signal ? `signal:${signal}` : `exit:${exit}`, retryable: false }
  }
  if (!parsed) return { kind: 'protocol', retryable: false }
  return null
}

/** which(cmd)：PATH 上找得到 ⇒ 絕對路徑；否則 null。deps.which 可注入。 */
export function defaultWhich(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/** runVersion(bin)：跑 `<bin> --version`，回 { exit, out(第一行) }。deps.runVersion 可注入。 */
export function defaultRunVersion(bin, env = process.env) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, env: cleanGitEnv(env) })
  return { exit: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] || '' }
}

/**
 * checkBinary 的共用實作（codex／claude／gemini 共用；agy 走 cask 搜尋另寫）：
 * bin 是絕對路徑且存在 ⇒ 直接用；否則 which(bin)；找不到 ⇒ null；找到就跑 `--version`，
 * 非 0 ⇒ { path, versionError }，0 ⇒ { path, version }。
 */
export function probeBinary(bin, env = process.env, deps = {}) {
  const which = deps.which || defaultWhich
  const runVersion = deps.runVersion || ((b) => defaultRunVersion(b, env))
  const found = (bin && (path.isAbsolute(bin) && fs.existsSync(bin) ? bin : which(bin))) || null
  if (!found) return null
  const v = runVersion(found)
  if (v.exit !== 0) return { path: found, versionError: `--version exit ${v.exit}` }
  return { path: found, version: v.out }
}
