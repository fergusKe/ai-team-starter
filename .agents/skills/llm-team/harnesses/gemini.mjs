// ─────────────────── harness：gemini（Google 官方 Gemini CLI，無頭；2026-09-22 加） ───────────────────
// 🔴 Fergus 2026-09-22 定案：「不使用訂閱的額度，改成直接使用 gemini api」——複審席不再依賴 agy／Antigravity 訂閱額度，
//   改用 Gemini CLI（`gemini` 二進位）無頭跑、按量計費、走獨立的 quotaBucket `gemini-api`。
//   介面依 context7 `/google-gemini/gemini-cli` 文件（2026-09-22 查）：`-p` 強制非互動、`--approval-mode plan` 唯讀
//   （對應 agy 的 `--mode plan`）、`--output-format json` 回 `{response, stats, ...}`。
//   防禦式解析：stdout 不是 JSON 或沒有 `response` 欄就退回整段 stdout 當回覆（見 parseGeminiStdout）。
// 從 lib.mjs 搬來（1.15.0）：resolveGeminiBin／buildGeminiArgs／parseGeminiRun／resolveGeminiApiKey／runGemini／runGeminiAsync；lib.mjs 同名 re-export。
//   🔴 llm-team.test.mjs ⑬b 靜態坐實改讀【本檔】：剝註解後識別字 resolveGeminiApiKey 恰好 5 處——定義、runGemini／runGeminiAsync 兩處預設參數、
//   auth.resolve 的預設值與 deps.resolveGeminiApiKey 接縫（setup --check 用）——且「呼叫形」`resolveGeminiApiKey(` 只有定義那一處：
//   那是「resolveKey 注入後不會碰真 Keychain」證據鏈的靜態半邊——本檔不准在任何函式體內直接呼叫 resolveGeminiApiKey(env) 繞過注入。
// 🔴 模組載入順序：頂層只准引用 lib.mjs 的函式宣告（理由見 agy.mjs 檔頭）。
//
// ─── 1.16.0：gemini 當寫手（Fergus 2026-09-22 定案寫手順序「agy（訂閱）→ Gemini CLI（API）→ Claude subagent」） ───
// 🔴 【實測】Gemini CLI 0.60.0 無頭寫手模式（2026-09-22，harnesses/__fixtures__/gemini-write-*.ndjson 是真跑 stdout 原樣）：
//   1. `--output-format stream-json` 每行一個事件，欄位是 `type`（不是 agy 的 `event`）：
//      init{session_id, model}／message{role, content, delta}／tool_use{tool_name, tool_id, parameters}／
//      tool_result{tool_id, status, output?, error?{type, message}}／error{severity, message}／result{status, error?, stats}。
//      assistant 回覆是【多個 delta 片段】——`text` 要把連續 assistant 片段接起來，不能只取最後一行。
//   2. `--approval-mode auto_edit` 只自動准 write_file／replace；run_shell_command 走 policy engine，無頭時 ask_user＝deny。
//      被拒的形狀：tool_result `status:"error"`、`error.type:"policy_violation"`、message「Tool execution denied by policy.」，
//      **exit 仍是 0、result.status 仍是 success、模型還會繼續講話**——跟 agy 一樣「程序成功」≠「工作成功」，denied 非空就是 G3 失敗。
//   3. tool_result 沒有 tool_name，只有 tool_id ⇒ 解析時要用 tool_use 的 tool_id 對回工具名。
//   4. 續輪：`--resume <session_id>`（id 在 init 事件的 `session_id`）。
// 🔴 policy 檔怎麼給（context7 /google-gemini/gemini-cli policy-engine.md 2026-09-22 查）：
//   Workspace tier（專案層 policy 目錄）**目前失效**（issue #18186），落在專案裡本身不會生效；
//   0.60.0 `gemini --help` 有 `--policy <file|dir>`（載入額外 policy 檔）——所以 TOML 由 preflight（role write）寫到
//   **write.mjs 的 outDir**（`<outDir>/gemini-policy.toml`，deps.outDir 注入；絕不寫 `~/.gemini/`），write.run 再用 `--policy <那個檔>` 明確載入。
//   🔴 r2（統整者真跑 `ticket run --writer-harness gemini` 坐實 ＋ sol Q2）：r1 把它落在 worktree 底下，收貨摘要把它列成改動檔、
//   land 因 worktree 不乾淨被擋——policy 是工具產物，跟台帳／round-N 輸出一樣住 outDir，不進 worktree、不需要 G4 特例。
//   每次執行都從 config.allowCommandHeads 重產（council 09-22 第 3 題定案），不讀使用者的 policy 目錄。

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
// 1.19.0：NO_EXEC_HEADER 不再從這裡引用（review 預設不加；常數本身仍留在 lib.mjs 給 agy 與呼叫端用）。
import { cleanGitEnv, spawnAsync, spawnTimedOut, briefCommandHeads } from '../lib.mjs'
import { probeBinary, classifyFailure } from './_contract.mjs'

/** gemini binary：`GEMINI_BIN` 覆寫，否則交給 PATH 上的 `gemini`（測試用假 binary 也走這裡）。 */
export function resolveGeminiBin(env = process.env) {
  return env.GEMINI_BIN || 'gemini'
}

/** 組裝 gemini 無頭呼叫引數（純函式，好測）。 */
export function buildGeminiArgs({ model, prompt }) {
  return ['-p', prompt, '-m', model, '--output-format', 'json', '--approval-mode', 'plan', '-e', 'none']
}

/**
 * 取得 Gemini API key：`env.GEMINI_API_KEY` 優先；否則在 darwin 上讀 macOS Keychain
 * （`security find-generic-password -s GEMINI_API_KEY -w`，trim）；都沒有 ⇒ `''`。
 * 🔴 回傳值只能放進子行程 env，不准 log、不准塞進任何回傳物件（呼叫端同守）。
 * 🔴 r2 sol block 複審 Q4 坐實：Keychain 沒有這個項目時 `security` 會把
 *   `security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.`
 *   直接印到「本行程」的 stderr（不是回傳值、`try/catch` 也擋不住），違反 setup.mjs 那條閘「只印來源或缺，永不印值」旁邊
 *   隱含的更嚴格版本——這裡連系統雜訊都不該外流。stdio 第三個位置設 `'ignore'`：子行程的 stderr 不繼承到本行程、
 *   不被捕捉、直接丟棄；stdout 仍要 `'pipe'` 才讀得到金鑰。陽性對照 llm-team.test.mjs「⑤ resolveGeminiApiKey…」
 *   斷言 exec 收到的 options.stdio[2] === 'ignore'。
 */
// 🔴 1.22.1：platform 可注入。1.14.0 的測試假設一定走 Keychain，只在 macOS 上綠；模板 CI（Linux）第一次跑到它就紅（ai-team-starter #48）。
export function resolveGeminiApiKey(env = process.env, exec = execFileSync, platform = os.platform()) {
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY
  if (platform !== 'darwin') return ''
  try {
    const out = exec('security', ['find-generic-password', '-s', 'GEMINI_API_KEY', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return String(out || '').trim()
  } catch {
    return ''
  }
}

/** stdout ⇒ { response, stats, parsed }：合法 JSON 且有字串 response ⇒ parsed:true；否則退回整段 stdout、stats null、parsed:false。 */
export function parseGeminiStdout(stdout) {
  const text = stdout || ''
  try {
    const j = JSON.parse(text)
    if (j && typeof j.response === 'string') {
      return { response: j.response, stats: j.stats !== undefined ? j.stats : null, parsed: true }
    }
  } catch {
    /* stdout 不是 JSON ⇒ 退回整段 stdout 當回覆 */
  }
  return { response: text, stats: null, parsed: false }
}

/** 解析 runGemini 或 runGeminiAsync 之 spawn 結果物件（舊形狀；沒有 parsed 欄——舊讀者不需要）。 */
export function parseGeminiRun(res) {
  const r = res || {}
  const { response, stats } = parseGeminiStdout(r.stdout)
  return {
    exit: r.status,
    signal: r.signal || null,
    timedOut: spawnTimedOut(r),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    response,
    stats,
  }
}

/** key 空字串 ⇒ fail-closed：不 spawn，直接回缺 key 的結果（訊息不含 key）。 */
function keyMissingResult() {
  return { exit: null, signal: null, timedOut: false, stdout: '', stderr: 'GEMINI_API_KEY missing (env or Keychain)', response: '', stats: null, keyMissing: true }
}

// 🔴 1.15.0 r2 真跑抓到：gemini review 在 config-repo worktree（未在 Gemini CLI 信任清單的資料夾）exit 55
//   「not running in a trusted directory」——整席零輸出，跟缺 key／額度用盡同一種死法。review 是 `--approval-mode plan` 唯讀，
//   信任只影響工具可用性，所以子行程 env 一律帶 GEMINI_CLI_TRUST_WORKSPACE=true（只進子行程，不動使用者設定）。
//   陽性對照 harnesses.test.mjs ⑦「gemini spawn 收到的 env 含 GEMINI_CLI_TRUST_WORKSPACE:'true'」。
//   停止條件：Gemini CLI 提供 headless 專用的「plan 模式不需信任」旗標，或 config 明列信任資料夾時改讀設定。
//
// 🔴 gemini-reviewer-heap：讓 gemini 複審席在 8 GB 機器上不要把自己掃到 OOM
//   1. 為什麼需要：Launcher (`@google/gemini-cli/bundle/gemini.js`) 的 getMemoryNodeArgs() 會把 V8 heap 上限設成
//      機器總記憶體的一半 (`totalMemoryMB * 0.5`)。統整者這台 8 GB 機器上只有 4096 MB。在複審任務中，由於 worktree 底下
//      裝有 1.4 GB 的 node_modules，全樹目錄掃描會超過 4 GB 限制，導致靜默 OOM（零輸出、不回應）。
//      [2026-09-23 事故量測結果]：
//        - 第一次：483 秒，timeout，零輸出
//        - 第二次：963 秒，exit=1，零輸出
//        - 第三次：577 秒，exit=1，零輸出
//        - 第四次：618 秒，exit=1，零輸出
//        - stderr 逐字報：FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
//   2. 為什麼是 6144 而不是更大：這台機器只有 8 GB，再往上會開始跟寫手／vitest 搶記憶體（本 repo 的 docs/agents/guards/machine-load.md
//      就是為 8 GB 立的）。6144 MB (6 GB) 是實測過可以順利跑過複審掃描的最小可用值，不是猜的。
//   3. 為什麼是覆寫而不是追加：NODE_OPTIONS 是直接設定而非累加。若日後需要保留呼叫端既有的 NODE_OPTIONS 需改為合併；
//      但目前刻意覆寫不做合併，因為合併會讓「上游傳了什麼」變成一個看不見的變數，而這一格失效的方向是靜默 OOM。
//   4. 停止條件：
//      ① 當 Gemini CLI 改成不做全樹掃描，或提供限制掃描範圍的 flag 時可拆；
//      ② 換到記憶體更寬裕的機器時，此設定將無實質作用（因為 totalmem * 0.5 本來就比 6144 大），屆時可拆，但切勿在 8 GB 機器的統整端拆除。
//   5. 它不是萬靈丹：複審（662 秒）仍遠慢於 codex 席（40-270 秒）。若之後更大的 diff 再次 OOM，正解是升級機器硬體（如 16 GB 讓上限自動到 8192 MB），
//      而不是無止境調大此常數。
const GEMINI_SPAWN_ENV = {
  GEMINI_CLI_TRUST_WORKSPACE: 'true',
  NODE_OPTIONS: '--max-old-space-size=6144',
}

function spawnOpts({ cwd, env, timeoutMs, key }) {
  return {
    cwd,
    env: { ...cleanGitEnv(env), ...GEMINI_SPAWN_ENV, GEMINI_API_KEY: key },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
}

/**
 * 跑一次 gemini 無頭（同步版）。
 * 🔴 r3 sol 第二輪 Q3/Q4 坐實：`resolveKey` 是跟 `spawn` 同級的測試接縫——測試若不注入它，
 *   預設值在 darwin 上會真的呼叫 Keychain，讓「模擬缺 key」的測試變得不具決定性。呼叫端與測試都必須注入。
 */
export function runGemini({
  model,
  prompt,
  cwd,
  timeoutMs = 15 * 60 * 1000,
  env = process.env,
  spawn = spawnSync,
  resolveKey = resolveGeminiApiKey,
}) {
  const key = resolveKey(env)
  if (!key) return keyMissingResult()
  const r = spawn(resolveGeminiBin(env), buildGeminiArgs({ model, prompt }), spawnOpts({ cwd, env, timeoutMs, key }))
  return parseGeminiRun(r)
}

/** 跑一次 gemini 無頭（非同步版）。key 空字串 ⇒ fail-closed（同上）。 */
export async function runGeminiAsync({
  model,
  prompt,
  cwd,
  timeoutMs = 15 * 60 * 1000,
  env = process.env,
  spawn = spawnAsync,
  resolveKey = resolveGeminiApiKey,
}) {
  const key = resolveKey(env)
  if (!key) return keyMissingResult()
  const r = await spawn(resolveGeminiBin(env), buildGeminiArgs({ model, prompt }), spawnOpts({ cwd, env, timeoutMs, key }))
  return parseGeminiRun(r)
}

// ─────────────────── 契約層：舊形狀 ⇒ 統一形狀 ───────────────────

/**
 * 舊形狀（parseGeminiRun／keyMissingResult 的回傳）⇒ ReviewResult：text ＝ response；usage ＝ stats；
 * failure：keyMissing ⇒ auth（retryable:false，沒 spawn）；exit 0 但 stdout 不是帶 response 的 JSON ⇒ protocol。
 * keyMissing 不進統一層，只留在 raw。
 */
function normalizeReview(raw) {
  const r = raw || {}
  const timedOut = r.timedOut === true
  const exit = r.exit ?? null
  const authMissing = r.keyMissing === true
  return {
    exit,
    signal: r.signal || null,
    timedOut,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    text: r.response || '',
    denied: r.denied || [],
    usage: r.stats ?? null,
    failure: classifyFailure({
      timedOut,
      exit,
      signal: r.signal || null,
      stderr: r.stderr,
      authMissing,
      parsed: authMissing ? true : parseGeminiStdout(r.stdout).parsed,
    }),
    raw: r,
  }
}

/**
 * council 的複審呼叫（`--approval-mode plan` 唯讀）。
 * 🔴 1.19.0：預設【不加】NO_EXEC_HEADER（`noExecHeader` 沒傳 ⇒ 空字串）；呼叫端仍可顯式傳入（含把 NO_EXEC_HEADER 本身傳進來）。
 *   ① 為什麼拿掉：2026-09-22 複審席從 agy 換成 gemini 時，把 agy 的 NO_EXEC_HEADER 一起抄了過來、註解寫「跟 agy 一樣」。
 *      但那句「不要執行任何指令、不要讀任何檔案」對 gemini 是自傷——`--approval-mode plan` 本來就是唯讀模式（工具可用、不能寫），
 *      子行程 env 又已帶 GEMINI_CLI_TRUST_WORKSPACE=true，它讀得到 repo；那句提示只是叫它別讀，
 *      害它兩輪 council 八題全部答不出事實（引用全指向方法論而非 repo）。
 *   ② 陽性對照（2026-09-23 統整者真跑）：同一個 harness、同一個 model，只把 `noExecHeader` 傳 `''`，
 *      問「`docs/WBS.md` 總行數」與「`## 1.8` 那段有幾列工作包」⇒ 回 `934` 與 `30`，兩個都正確。
 *      把預設改回 NO_EXEC_HEADER 就會紅在 llm-team.test.mjs「⑭ 1.19.0 gemini 複審預設不加 NO_EXEC_HEADER（agy 仍加）」。
 *   ③ agy 那條【不動】：agy 無頭模式 settings 缺 `read_file` allow 時第一個指令就被拒、stdout 空、exit 仍為 0
 *      （2026-09-13 實測，理由與事故出處在 `harnesses/agy.mjs` 檔頭）；lib.mjs 的 NO_EXEC_HEADER 常數也照舊（agy 還在用）。
 */
function reviewArgs({ model, prompt, cwd, timeoutMs, env, spawn, resolveKey, noExecHeader }) {
  const header = noExecHeader === undefined ? '' : noExecHeader
  return { model, prompt: header + prompt, cwd, timeoutMs, env, spawn, resolveKey }
}

async function reviewRun(opts) {
  return normalizeReview(await runGeminiAsync(reviewArgs(opts)))
}

function reviewRunSync(opts) {
  return normalizeReview(runGemini(reviewArgs(opts)))
}

/** setup --check 的 key 可達性：deps.resolveGeminiApiKey 是既有測試接縫（⑪⑫），沒注入就走 Keychain 讀取（同 runner 的預設值）。 */
function authResolve(env = process.env, deps = {}) {
  return (deps.resolveGeminiApiKey || resolveGeminiApiKey)(env)
}

// ─────────────────── 寫手（1.16.0）：stream-json、auto_edit、policy TOML ───────────────────

/** policy 檔名（住 write.mjs 的 outDir，跟台帳同層；絕不寫 `~/.gemini/`、不進 worktree）。 */
export const GEMINI_POLICY_FILE = 'gemini-policy.toml'

export function geminiPolicyPath(outDir) {
  return path.join(outDir, GEMINI_POLICY_FILE)
}

/**
 * 寫手 argv（純函式）：`-p <prompt> -m <model> --output-format stream-json --approval-mode auto_edit`
 * ＋ policyFile ⇒ `--policy <file>`；resumeId ⇒ `--resume <session_id>`。
 * 信任（未信任資料夾 exit 55）不走旗標，走 GEMINI_SPAWN_ENV（跟 review 同一條）。
 * 🔴 prompt 走 argv（macOS ARG_MAX 1 MiB 含 env）；寫手 brief 通常 < 30 KB，超過再改走 stdin（`-p` 會接在 stdin 後面）。
 */
export function buildGeminiWriteArgs({ model, prompt, resumeId, policyFile }) {
  return [
    '-p',
    prompt,
    '-m',
    model,
    '--output-format',
    'stream-json',
    '--approval-mode',
    'auto_edit',
    ...(policyFile ? ['--policy', policyFile] : []),
    ...(resumeId ? ['--resume', resumeId] : []),
  ]
}

/** 與 write.mjs 寫手提示第 2 條硬規則一致的禁令（policy 層再擋一次，提示只是告知）。 */
export const GEMINI_WRITE_DENY_PREFIXES = ['rm', 'git commit', 'git push', 'git checkout', 'git reset', 'git stash', 'git clean']

function tomlString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function tomlRule({ commandPrefix, decision, priority }) {
  return [
    '[[rule]]',
    'toolName = "run_shell_command"',
    ...(commandPrefix !== undefined ? [`commandPrefix = ${tomlString(commandPrefix)}`] : []),
    `decision = "${decision}"`,
    `priority = ${priority}`,
    'modes = ["autoEdit"]',
    'interactive = false',
    '',
  ].join('\n')
}

/**
 * 產 policy TOML（純函式）：禁令 deny（priority 100）＞ 每個准許指令頭一條 allow（priority 50）＞ run_shell_command 兜底 deny（priority 10）。
 * 只管 run_shell_command；write_file／replace 由 `--approval-mode auto_edit` 自動准，read 類工具本來就不用批准。
 * 只在 autoEdit 模式、非互動環境生效——這個檔被使用者的互動 session 誤載也不會改變他的預設行為。
 */
export function buildGeminiPolicyToml({ allowedHeads = [] } = {}) {
  const heads = Array.from(new Set((allowedHeads || []).map((h) => String(h).trim()).filter(Boolean)))
  const parts = [
    '# llm-team 寫手 policy（每次執行由 harnesses/gemini.mjs 從 config.allowCommandHeads 重產，不要手改）',
    '',
    ...GEMINI_WRITE_DENY_PREFIXES.map((p) => tomlRule({ commandPrefix: p, decision: 'deny', priority: 100 })),
    ...heads.map((h) => tomlRule({ commandPrefix: h, decision: 'allow', priority: 50 })),
    tomlRule({ decision: 'deny', priority: 10 }),
  ]
  return parts.join('\n')
}

const DENIED_MESSAGE_RE = /denied|not allowed|policy/i

/** tool_result 是不是「被 policy 拒」：error.type policy_violation，或訊息含 denied／not allowed／policy。 */
export function isGeminiDeniedResult(ev) {
  if (!ev || ev.status !== 'error') return false
  const err = ev.error || {}
  if (String(err.type || '') === 'policy_violation') return true
  return DENIED_MESSAGE_RE.test(String(err.message || ev.output || ''))
}

/**
 * 解析 stream-json（欄位名以 __fixtures__/gemini-write-*.ndjson 真跑為準）⇒
 *   { init, sessionId, messages: string[], text, steps: [{tool, id, params, status, error, denied}], denied: [{action, tool, detail}], result, protocol }
 * messages ＝ 每一段連續的 assistant delta 接成一則；text ＝ 最後一則。壞行不丟，記成 steps[{unparsed}]。
 * `error` 事件（severity error）也記進 steps（tool null）。
 * 🔴 r3 fail-closed（sol Q3）：`protocol` ＝ stream 不是預期形狀的第一個原因（null ＝ 正常）：
 *   'unparsed_line'（任一行 JSON.parse 失敗）＞ 'unpaired_tool'（tool_use 沒有同 tool_id 的 tool_result——被殺／串流截斷的形狀）＞
 *   'no_result'（沒有 result 事件）。normalizeWrite 把它變成 failure {kind:'protocol', code:'stream:<原因>'}，write.mjs G3 就算正文非空也判 FAIL。
 */
export function parseGeminiStream(text) {
  let init = null
  let result = null
  const messages = []
  const steps = []
  const denied = []
  const byId = new Map()
  let current = null
  const flush = () => {
    if (current !== null) {
      messages.push(current)
      current = null
    }
  }
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      steps.push({ unparsed: line.slice(0, 200) })
      continue
    }
    switch (d.type) {
      case 'init':
        init = d
        break
      case 'message':
        if (d.role === 'assistant') {
          current = (current === null ? '' : current) + String(d.content || '')
        } else {
          flush()
        }
        break
      case 'tool_use': {
        flush()
        const step = { tool: d.tool_name || null, id: d.tool_id || null, params: d.parameters || {}, status: null, error: null, denied: false }
        steps.push(step)
        if (step.id) byId.set(step.id, step)
        break
      }
      case 'tool_result': {
        flush()
        let step = d.tool_id ? byId.get(d.tool_id) : undefined
        if (!step) {
          step = { tool: null, id: d.tool_id || null, params: {}, status: null, error: null, denied: false }
          steps.push(step)
        }
        step.status = d.status || null
        step.error = d.status === 'error' ? String((d.error && d.error.message) || d.output || 'error') : null
        if (isGeminiDeniedResult(d)) {
          step.denied = true
          denied.push({ action: 'policy', tool: step.tool, detail: step.error.slice(0, 200) })
        }
        break
      }
      case 'error':
        if (d.severity === 'error') steps.push({ tool: null, event: 'error', error: String(d.message || ''), denied: false })
        break
      case 'result':
        flush()
        result = d
        break
      default:
        break
    }
  }
  flush()
  const sessionId = (init && init.session_id) || null
  const unpaired = steps.some((st) => st.tool && st.id && st.status === null)
  const protocol = steps.some((st) => st.unparsed !== undefined) ? 'unparsed_line' : unpaired ? 'unpaired_tool' : result === null ? 'no_result' : null
  return { init, sessionId, messages, text: messages.length ? messages[messages.length - 1] : '', steps, denied, result, protocol }
}

/** 解析寫手 spawn 結果（舊形狀＝ spawn 欄位＋ parseGeminiStream 的欄位攤平）。 */
export function parseGeminiWriteRun(res) {
  const r = res || {}
  const p = parseGeminiStream(r.stdout || '')
  return {
    exit: r.status,
    signal: r.signal || null,
    timedOut: spawnTimedOut(r),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    init: p.init,
    sessionId: p.sessionId,
    messages: p.messages,
    response: p.text,
    steps: p.steps,
    denied: p.denied,
    result: p.result,
    stats: (p.result && p.result.stats) || null,
    protocol: p.protocol,
  }
}

function writeKeyMissingResult() {
  return { ...keyMissingResult(), init: null, sessionId: null, messages: [], steps: [], denied: [], result: null, protocol: null }
}

/**
 * 跑一輪寫手（同步）。key 空 ⇒ 不 spawn（fail-closed，同 review）。policy 檔＝`policyFile`，沒給就 `<outDir>/gemini-policy.toml`
 * （preflight role write 寫的那個）；兩者都沒有 ⇒ throw（沒有 policy 就沒有任何 allow，寫手跑不了測試——fail-closed 不靜默）。
 * resumeId 有值 ⇒ `--resume`。resolveKey 預設走 authResolve（＝同一個 Keychain 讀取），測試一律注入。
 */
export function runGeminiWrite({
  model,
  prompt,
  cwd,
  timeoutMs = 25 * 60 * 1000,
  env = process.env,
  spawn = spawnSync,
  resolveKey = authResolve,
  resumeId = null,
  outDir,
  policyFile,
}) {
  const policy = policyFile !== undefined && policyFile !== null ? policyFile : outDir ? geminiPolicyPath(outDir) : null
  if (!policy) throw new Error('gemini write.run 需要 outDir 或 policyFile（policy TOML 由 preflight 寫在 outDir，write.mjs 要把 outDir 交給 write.run）')
  const key = resolveKey(env)
  if (!key) return writeKeyMissingResult()
  const args = buildGeminiWriteArgs({ model, prompt, resumeId, policyFile: policy })
  const r = spawn(resolveGeminiBin(env), args, spawnOpts({ cwd, env, timeoutMs, key }))
  return parseGeminiWriteRun(r)
}

const AUTH_ERROR_RE = /auth|unauthorized|forbidden|api key|permission_denied/i
const QUOTA_ERROR_RE = /quota|429|resource_exhausted|rate.?limit|usage limit/i

/**
 * 寫手 failure 分類：timeout ＞ auth（缺 key／result.error.type 含 Auth）＞ policy（denied 非空）＞ quota（result.error 含 Quota／429／RESOURCE_EXHAUSTED）
 * ＞ protocol（exit 0 但 stream 形狀不對：stream:unparsed_line／unpaired_tool／no_result；r3 sol Q3）＞ classifyFailure（非零 exit ⇒ quota／process）。
 * 非零 exit 時不套 stream 檢查——被殺的行程 stream 本來就不完整，process／quota 的碼比 protocol 有用。
 */
function classifyWriteFailure(r) {
  const timedOut = r.timedOut === true
  const exit = r.exit ?? null
  const signal = r.signal || null
  const denied = r.denied || []
  const authMissing = r.keyMissing === true
  const result = r.result || null
  const err = (result && result.status === 'error' && result.error) || null
  const errText = err ? `${err.type || ''} ${err.message || ''}` : ''
  if (timedOut) return { kind: 'timeout', retryable: true }
  if (authMissing) return { kind: 'auth', retryable: false }
  if (err && AUTH_ERROR_RE.test(errText)) return { kind: 'auth', code: err.type || undefined, retryable: false }
  if (denied.length > 0) return { kind: 'policy', retryable: false }
  if (err && QUOTA_ERROR_RE.test(errText)) return { kind: 'quota', code: err.type || undefined, retryable: false }
  // raw 沒帶 protocol（假 harness 直接餵舊形狀）⇒ 從 stdout 重算，跟 review 的 normalize 重解析 stdout 同一個原則。
  const protocol = r.protocol !== undefined ? r.protocol : parseGeminiStream(r.stdout || '').protocol
  if (exit === 0 && protocol) return { kind: 'protocol', code: `stream:${protocol}`, retryable: false }
  const base = classifyFailure({ timedOut, exit, signal, stderr: r.stderr, denied, parsed: result !== null })
  if (base) return base
  if (err) return { kind: 'process', code: `result:${err.type || 'error'}`, retryable: false }
  return null
}

/** 舊形狀（parseGeminiWriteRun／writeKeyMissingResult）⇒ WriteResult。text ＝ 最後一則 assistant 回覆；usage ＝ result.stats；conversationId ＝ session_id。 */
function normalizeWrite(raw) {
  const r = raw || {}
  return {
    exit: r.exit ?? null,
    signal: r.signal || null,
    timedOut: r.timedOut === true,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    text: r.response || '',
    denied: r.denied || [],
    usage: r.stats ?? ((r.result && r.result.stats) || null),
    failure: classifyWriteFailure(r),
    raw: r,
    steps: r.steps || [],
    conversationId: r.sessionId || (r.init && r.init.session_id) || null,
  }
}

/** 最後一個工具步驟有 error 且不是 policy 被拒 ⇒ 參數不合法那類（write.mjs 會用 resume 續同一 session 再試，上限 2 次）。 */
export function lastGeminiStepIsToolError(steps) {
  const tools = (steps || []).filter((s) => s.tool)
  const last = tools[tools.length - 1]
  return Boolean(last && last.error && !last.denied)
}

/** write.args（純函式）：run 忽略 conversationId；resume 帶 resumeId。跟 agy 的 write.args 一樣是假 harness 的接縫。 */
function writeArgs({ model, prompt, cwd, timeoutMs, env, spawn, resolveKey, conversationId, outDir, policyFile }) {
  return { model, prompt, cwd, timeoutMs, env, spawn, resolveKey, resumeId: conversationId || null, outDir, policyFile }
}

function writeRun(opts) {
  return normalizeWrite(runGeminiWrite(writeArgs({ ...opts, conversationId: undefined })))
}

function writeResume(opts) {
  if (!opts.conversationId) throw new Error('gemini write.resume 需要 conversationId（第 1 輪 stream-json init 事件的 session_id）')
  return normalizeWrite(runGeminiWrite(writeArgs(opts)))
}

const PREFLIGHT_ROLES = ['write', 'setup']

/**
 * 預檢。role 'write' ⇒ 從 config 產 policy TOML；有 deps.outDir 才落地到 `<outDir>/gemini-policy.toml`
 * （這是 preflight 唯一的副作用，且只在 outDir——工具產物目錄，跟台帳同層、不進 worktree；deps.writeFile 可注入），
 * 沒有 outDir ⇒ 只驗能不能產（ticket G2 在 worktree／outDir 建立前跑）。
 * role 'setup' ⇒ []（金鑰／binary 由 auth／checkBinary 管）。未知 role ⇒ throw。
 */
function preflight(env = process.env, config = null, deps = {}) {
  const role = deps.role ?? null
  if (role !== null && !PREFLIGHT_ROLES.includes(role)) throw new Error(`gemini preflight role 只准 ${PREFLIGHT_ROLES.join('|')}，得到 ${JSON.stringify(role)}`)
  if (role !== 'write') return []
  const toml = buildGeminiPolicyToml({ allowedHeads: briefCommandHeads(config) })
  if (!deps.outDir) {
    return [{ ok: true, label: 'policy(toml)', okText: '可產（尚未落地，write G2 會寫進 outDir）', roles: ['write'] }]
  }
  const file = geminiPolicyPath(deps.outDir)
  const writeFile = deps.writeFile || ((f, content) => {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  })
  writeFile(file, toml)
  return [{ ok: true, label: 'policy(toml)', okText: `已寫 ${file}`, roles: ['write'] }]
}

/** @type {import('./_contract.mjs').Harness} */
export const harness = {
  name: 'gemini',
  quotaBuckets: ['gemini-api'],
  canCoordinate: false,
  canReview: true,
  // 1.16.0：寫手席（Fergus 09-22 寫手順序 agy → gemini → Claude subagent 的第二席）。
  canWrite: true,
  transcriptMeasurable: false,
  resolveBin: (env = process.env) => resolveGeminiBin(env),
  checkBinary: (env = process.env, deps = {}) =>
    probeBinary(deps.geminiBin !== undefined ? deps.geminiBin : resolveGeminiBin(env), env, deps),
  // 🔴 auth.resolve 的回傳只准進子行程 env；describe 只回來源（env／Keychain／缺），永不回值。
  auth: {
    envVar: 'GEMINI_API_KEY',
    resolve: authResolve,
    describe: (env = process.env, deps = {}) => (env.GEMINI_API_KEY ? 'env' : authResolve(env, deps) ? 'Keychain' : '缺'),
  },
  preflight,
  review: { run: reviewRun, runSync: reviewRunSync, normalize: normalizeReview, args: reviewArgs },
  write: { run: writeRun, resume: writeResume, normalize: normalizeWrite, args: writeArgs, lastStepIsToolError: lastGeminiStepIsToolError },
}

export default harness
