// ─────────────────── harness：agy（Antigravity CLI，無頭 stream-json） ───────────────────
// 從 lib.mjs 搬來（1.15.0）：resolveAgyBin／agySettingsPath／assertSettingsAllowRegex／buildAgyArgs／buildAgyStdin／
// parseAgyRun／runAgy／runAgyAsync／isDeniedToolError／parseStreamJson；從 write.mjs 搬來 lastStepIsToolError。
// lib.mjs 與 write.mjs 仍以同名 re-export，既有 import 一律照常。
//
// 🔴 這裡集中三個【實測過】的 agy 無頭模式行為（2026-09-13，agy 1.2.x）：
//   1. `-p --mode accept-edits` 下任一工具被拒 ⇒ 整輪中止、stdout 空、**exit 0**、不會退回用別的工具。
//      ⇒ 「程序成功」≠「工作成功」。判準只能看 stream-json 的 `result.denied_actions` 與 `response` 非空。
//   2. 字面前綴 allow 規則對 `pwd; ls -la` 這種串接不匹配 ⇒ 第一個指令就死。
//      ⇒ allow 用一條 anchored regex（見 lib.mjs `buildSafeCommandRegex`），brief 再加「禁止串接」。
//   3. cwd 在 `trustedWorkspaces` 之外時，模型會去錯的目錄找檔。⇒ worktree 一律放在 repo 內 `.claude/worktrees/`。
//
// 🔴 為什麼 fail-closed：
//   事故：2026-09-13 在 web-agency-system 實測，agy 無頭模式 settings.json 的 allow regex 漂移或缺 read_file 時，
//   寫手第一個指令就被拒、stdout 空、exit 仍為 0——統整者差點把「零輸出」讀成「沒話說」。
//   失效方向：寧可整輪停機（fail-closed），不可把拒絕誤判為成功放行。
//   停止條件：若 agy 之後把被拒改成非零 exit 或明確錯誤事件，G2／G3 可降為警告。
//
// 🔴 模組載入順序：本檔與 lib.mjs 互相 import（lib.mjs re-export 這裡的函式；這裡用 lib.mjs 的 spawn／env 工具）。
//   規則：頂層只准引用 lib.mjs 的【函式宣告】（hoisted）；lib.mjs 的 const（NO_EXEC_HEADER、CLEAN_GIT_ENV…）只准在函式體內用，
//   否則從 harnesses/index.mjs 先進來的那條路徑會撞 TDZ。陽性對照 harnesses.test.mjs「兩種載入順序都成功」。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { cleanGitEnv, spawnAsync, spawnTimedOut, buildSafeCommandRegex, NO_EXEC_HEADER } from '../lib.mjs'
import { defaultWhich, classifyFailure } from './_contract.mjs'

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

export function agySettingsPath(env = process.env) {
  return env.AGY_SETTINGS || path.join(env.HOME || '', '.gemini', 'antigravity-cli', 'settings.json')
}

/** preflight 的角色：write ＝ write.mjs G2（回傳的每一條都會擋）；setup ＝ setup --check（印全部）。 */
export const PREFLIGHT_ROLES = ['write', 'setup']

/**
 * settings.json 對帳的單一實作。讀不到檔／壞 JSON ⇒ throw（呼叫端一律當「不能開工」）。
 * 回 PreflightCheck[]：command(regex)、read_file(<root>/)（有 repoRoot 才查）、trustedWorkspaces（有 repoRoot 才查）。
 * `role`（'write'|'setup'）過濾：trustedWorkspaces 只給 setup——1.14.0 的 write G2 本來就不查它，本票不加嚴；
 * 所以「write 角色拿到的每一條都是要擋的」，write.mjs 不需要（也不准有）放行分支（sol block r1 Q2）。不給 role ⇒ 全部。
 */
export function agySettingsChecks({ settingsFile, repoRoot = null, config = null, role = null }) {
  if (role !== null && !PREFLIGHT_ROLES.includes(role)) throw new Error(`agy preflight role 只准 ${PREFLIGHT_ROLES.join('|')}，得到 ${JSON.stringify(role)}`)
  if (!fs.existsSync(settingsFile)) throw new Error(`agy settings 不存在：${settingsFile}`)
  let s
  try {
    s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  } catch (e) {
    // 🔴 錯誤文字依 role：write（含 assertSettingsAllowRegex）原封拋 JSON.parse 的原生錯誤——1.14.0 write.mjs G2 印的就是裸
    //    `🔴 G2：<原生訊息>`（c7847a36 write.mjs:158 ＋ lib.mjs:647 裸 JSON.parse），本票行為不變；setup 才用包裝句（1.14.0 setup 本來就那樣）。
    //    陽性對照 harnesses.test.mjs ⑥b「壞 JSON ⇒ write G2 stderr 精確等於 1.14.0 字面」。
    if (role === 'write') throw e
    throw new Error(`agy settings 解析失敗（${settingsFile}）：${e.message}`)
  }
  const allow = (s.permissions && s.permissions.allow) || []
  const wantRegex = buildSafeCommandRegex(config)
  const wantCommand = `command(regex:${wantRegex})`
  const checks = [
    {
      ok: allow.includes(wantCommand),
      label: 'command(regex)',
      okText: '存在',
      failText: '缺少',
      message: `agy settings permissions.allow 缺這條（或與 tools/agy-lib.mjs 漂移）：\n${wantCommand}`,
      roles: ['write', 'setup'],
      fix: { file: settingsFile, allow: [wantCommand] },
    },
  ]
  // 🔴 2026-09-13 實測：無頭模式連 trustedWorkspaces 內的 read_file 都要明確 allow，否則第一次 view_file 就整輪死。
  //    規則的 target 是「repo 根（尾巴 /）」——worktree 在 .claude/worktrees/ 底下，被這條覆蓋。
  if (repoRoot) {
    const root = repoRoot.endsWith('/') ? repoRoot : repoRoot + '/'
    const hasReadFile = allow.some((a) => {
      const m = typeof a === 'string' && a.match(/^read_file\((.+)\)$/)
      if (!m) return false
      const t = m[1].endsWith('/') ? m[1] : m[1] + '/'
      return root.startsWith(t) || m[1] === '*'
    })
    checks.push({
      ok: hasReadFile,
      label: `read_file(${root})`,
      okText: '覆蓋',
      failText: '缺少',
      message: `agy settings permissions.allow 缺 read_file(${root})（無頭模式讀 worktree 檔會被拒）`,
      roles: ['write', 'setup'],
      fix: { file: settingsFile, allow: [`read_file(${root})`] },
    })
    const trusted = s.trustedWorkspaces || []
    const hasTrustedWorkspace = trusted.some((tw) => {
      if (typeof tw !== 'string') return false
      const t = tw.endsWith('/') ? tw : tw + '/'
      return root.startsWith(t)
    })
    checks.push({
      ok: hasTrustedWorkspace,
      label: 'trustedWorkspaces',
      okText: '覆蓋',
      failText: '缺少',
      message: `agy settings trustedWorkspaces 沒覆蓋 ${repoRoot}（cwd 在 trustedWorkspaces 之外時模型會去錯的目錄找檔）`,
      roles: ['setup'],
      fix: { file: settingsFile, trustedWorkspaces: [repoRoot] },
    })
  }
  return role === null ? checks : checks.filter((c) => c.roles.includes(role))
}

/**
 * 對帳：settings.json 的 `permissions.allow` 必須恰好含 lib.mjs 的 regex 那一條（＋有 repoRoot 時的 read_file）。
 * 失效方向刻意選「擋下來」——allow 漂移的失效方向是寫手第一個指令就死、stdout 空、我以為它沒話說。
 * 實作＝agySettingsChecks（role 'write'）第一個 !ok 的訊息（單一來源；ticket.mjs 仍直接呼叫本函式）。
 */
export function assertSettingsAllowRegex(settingsFile = agySettingsPath(), repoRoot = null, config = null) {
  const checks = agySettingsChecks({ settingsFile, repoRoot, config, role: 'write' })
  const bad = checks.find((c) => !c.ok)
  if (bad) throw new Error(bad.message)
  return true
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

function spawnOpts({ cwd, env, timeoutMs, prompt }) {
  return {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    input: buildAgyStdin(prompt),
    stdio: ['pipe', 'pipe', 'pipe'],
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
  const r = spawn(bin, args, spawnOpts({ cwd, env, timeoutMs, prompt }))
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
  const r = await spawn(bin, args, spawnOpts({ cwd, env, timeoutMs, prompt }))
  return parseAgyRun(r)
}

/** 最後一個工具步驟是「參數不合法」那類 TOOL_ERROR（不是 permission）⇒ 整輪會被 agy 靜默結束。 */
export function lastStepIsToolError(steps) {
  const tools = (steps || []).filter((s) => s.tool)
  const last = tools[tools.length - 1]
  return Boolean(last && last.error && !/permission/i.test(last.error))
}

// ─────────────────── 契約層：舊形狀 ⇒ 統一形狀 ───────────────────

/**
 * 舊形狀（parseAgyRun 的回傳）⇒ ReviewResult。text ＝ result.response；usage ＝ result.usage；
 * failure：denied 非空 ⇒ policy（無頭被拒 exit 仍是 0，這是 agy 第 1 坑）；exit 0 但 stream-json 沒有 result 事件 ⇒ protocol。
 */
function normalizeReview(raw) {
  const r = raw || {}
  const result = r.result || null
  const denied = r.denied || []
  const timedOut = r.timedOut === true
  const exit = r.exit ?? null
  return {
    exit,
    signal: r.signal || null,
    timedOut,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    text: (result && result.response) || '',
    denied,
    usage: (result && result.usage) || null,
    failure: classifyFailure({ timedOut, exit, signal: r.signal || null, stderr: r.stderr, denied, parsed: result !== null }),
    raw: r,
  }
}

/** 舊形狀（parseAgyRun 的回傳）⇒ WriteResult：加 steps 與 conversationId（result.conversation_id 或 init 事件）。 */
function normalizeWrite(raw) {
  const r = raw || {}
  const result = r.result || null
  return {
    ...normalizeReview(r),
    steps: r.steps || [],
    conversationId: r.conversationId || (result && result.conversation_id) || null,
  }
}

/** council 的複審呼叫（唯讀 `--mode plan`，提示以 NO_EXEC_HEADER 開頭——否則它想跑指令 ⇒ 自動拒絕 ⇒ 零輸出）。 */
function reviewArgs({ model, prompt, cwd, timeoutMs, env, spawn, noExecHeader }) {
  const header = noExecHeader === undefined ? NO_EXEC_HEADER : noExecHeader
  return { model, mode: 'plan', prompt: header + prompt, cwd, timeoutMs, env, spawn }
}

async function reviewRun(opts) {
  return normalizeReview(await runAgyAsync(reviewArgs(opts)))
}

function reviewRunSync(opts) {
  return normalizeReview(runAgy(reviewArgs(opts)))
}

/**
 * write.mjs 的寫手呼叫（`--mode accept-edits`）。有 conversationId ⇒ 續輪 `--conversation <id>`——不是 --continue
 * （agy 第 6 坑：--continue 續的是「最近一個對話」，統整者本身是 agy session 時會續錯，見 write.mjs）。
 */
function writeArgs({ model, prompt, cwd, timeoutMs, env, spawn, conversationId }) {
  const extraArgs = conversationId ? ['--conversation', conversationId] : []
  return { model, mode: 'accept-edits', prompt, cwd, extraArgs, timeoutMs, env, spawn }
}

function writeRun(opts) {
  return normalizeWrite(runAgy(writeArgs({ ...opts, conversationId: undefined })))
}

function writeResume(opts) {
  if (!opts.conversationId) throw new Error('agy write.resume 需要 conversationId（第 1 輪 stream-json 的 conversation_id）')
  return normalizeWrite(runAgy(writeArgs(opts)))
}

/** setup --check：cask 路徑（或 AGY_BIN／deps.agyBin）存在 ⇒ 用它；否則 which antigravity／agy。agy 不跑 `--version`（既有行為）。 */
function checkBinary(env = process.env, deps = {}) {
  const which = deps.which || defaultWhich
  const agyBin = (deps.agyBin !== undefined ? deps.agyBin : resolveAgyBin(env)) || null
  const found = (agyBin && fs.existsSync(agyBin) ? agyBin : null) || which('antigravity') || which('agy')
  return found ? { path: found } : null
}

/**
 * 預檢＝settings.json 對帳（write G2、setup --check 共用）。
 * deps.role（'write'|'setup'）決定回哪些條：write 只回「要擋」的（trustedWorkspaces 不回，沿用 1.14.0），setup 回全部。
 * deps.settingsFile／deps.repoRoot 對應 setup 的注入點；settingsFile 預設 agySettingsPath(env)（AGY_SETTINGS 可覆寫）。
 * 檔不存在／壞 JSON／未知 role ⇒ throw（呼叫端一律「不能開工」）。
 */
function preflight(env = process.env, config = null, deps = {}) {
  const settingsFile = deps.settingsFile || agySettingsPath(env)
  return agySettingsChecks({ settingsFile, repoRoot: deps.repoRoot ?? null, config, role: deps.role ?? null })
}

/** @type {import('./_contract.mjs').Harness} */
export const harness = {
  name: 'agy',
  // 🔴 agy 走 Antigravity 訂閱額度：gemini 桶（Gemini 模型）與 agy-claude 桶（Antigravity 裡的 Claude 模型）都是它的。
  quotaBuckets: ['gemini', 'agy-claude'],
  canCoordinate: true,
  canReview: true,
  canWrite: true,
  transcriptMeasurable: false,
  hook: 'agy-pretooluse.sh',
  resolveBin: (env = process.env) => resolveAgyBin(env),
  checkBinary,
  preflight,
  // args ＝ run／runSync 交給 runner 的引數（純函式；測試用假 harness 攔派工時靠它拿到跟真派工一樣的引數，見 llm-team.test.mjs fakeHarnessFrom）。
  review: { run: reviewRun, runSync: reviewRunSync, normalize: normalizeReview, args: reviewArgs },
  write: { run: writeRun, resume: writeResume, normalize: normalizeWrite, args: writeArgs, lastStepIsToolError },
}

export default harness
