// ─────────────────── harness：claude（Claude Code） ───────────────────
// 🔴 1.22.0（Fergus 2026-10-03：「他們『隔離上下文』也很適合我們使用／要使用哪個模型其實都可以／
//   這樣就不會像我們現在被限定在要呼叫不同模型」）：claude 也能當複審者。
//   以前（2026-09-14 硬約束）claude 只准當 coordinator，複審的獨立性靠「換一家廠商」；codex／Gemini 額度用完時複審就停擺。
//   現在獨立性靠【隔離上下文】（借自 cloudflare/security-audit-skill，2026-10-03 在 GuildHub 試跑過）：
//   每位複審者是全新的無頭行程，只拿到 council 組的 prompt（brief＋diff＋判準），看不到統整者的對話與傾向。
//   模型只是設定值。
// 🔴 無頭姿態（每一個旗標都有理由）：
//   · `-p --output-format json`：一次回一個 JSON（result／is_error／api_error_status／permission_denials）。
//   · prompt 走 stdin：沒有命令列長度上限（同 agy 1.12.0）。
//   · `--no-session-persistence`：不留 session，下一輪複審不可能續到這一輪的上下文。
//   · `--setting-sources project`：不載入使用者層 settings ⇒ 使用者層的 hook（例：config repo 的自動 commit Stop hook）不會在複審者身上觸發。
//     不用 `--bare`：它只認 ANTHROPIC_API_KEY，訂閱登入的機器跑不起來。
//   · `--tools Read,Grep,Glob` ＋ `--permission-mode dontAsk`：唯讀；沒給的工具一律拒，不會停下來問。
//   陽性對照 harnesses.test.mjs ④「claude：argv 精確、prompt 在 stdin 不在 argv」。

import { spawnSync } from 'node:child_process'
import { cleanGitEnv, spawnAsync, spawnTimedOut } from '../lib.mjs'
import { probeBinary, classifyFailure } from './_contract.mjs'

export function resolveClaudeBin(env = process.env) {
  return env.CLAUDE_BIN || 'claude'
}

export const CLAUDE_REVIEW_TOOLS = 'Read,Grep,Glob'

/** 組裝 claude 無頭複審引數（prompt 不在這裡——走 stdin）。 */
export function buildClaudeReviewArgs({ model }) {
  if (!model) throw new Error('claude 複審需要 model（來自 profile 成員的 model）')
  return [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--tools', CLAUDE_REVIEW_TOOLS,
    '--permission-mode', 'dontAsk',
  ]
}

function spawnOpts({ cwd, env, timeoutMs, prompt }) {
  return {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    input: prompt,
  }
}

/** spawn 結果 ⇒ 舊形狀（exit／signal／timedOut／stdout／stderr）＋解析出的 JSON（解析不出 ⇒ null）。 */
export function parseClaudeRun(res) {
  const r = res || {}
  let json = null
  try {
    const parsed = JSON.parse(String(r.stdout || '').trim())
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed
  } catch {
    json = null
  }
  return {
    exit: r.status,
    signal: r.signal || null,
    timedOut: spawnTimedOut(r),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    json,
  }
}

const CLAUDE_QUOTA_RE = /usage limit|rate limit|\b429\b/i

/**
 * 舊形狀 ⇒ ReviewResult。text ＝ json.result（只有 is_error:false 才算正文）。
 * failure 順序：timeout → quota（JSON 的 429 或 is_error 帶額度字樣）→ is_error 其他 ⇒ process → 其餘照 classifyFailure（非 0 exit／解析不出 JSON ⇒ protocol）。
 * permission_denials 非空 ⇒ denied（複審者想用沒給的工具；只記，不算失敗——它仍可能交了正文）。
 */
function normalizeReview(raw) {
  const r = raw || {}
  const timedOut = r.timedOut === true
  const exit = r.exit ?? null
  const j = r.json
  const ok = Boolean(j && j.is_error === false && typeof j.result === 'string')
  const text = ok ? j.result : ''
  // 額度只認 claude 自己的結構化回報（JSON 的 api_error_status 429，或 is_error 的 result 帶額度字樣）——跟 codex 的 usage limit 同性質，retryable:true；
  // 沒有 JSON 時的 stderr 一律交給共用 classifyFailure（裸 429／RESOURCE_EXHAUSTED ⇒ quota retryable:false，跟其他 harness 同一條規則）。
  const errText = j && j.is_error === true && typeof j.result === 'string' ? j.result : ''
  const quotaHit = Boolean(j && (j.api_error_status === 429 || (j.is_error === true && CLAUDE_QUOTA_RE.test(errText))))
  let failure
  if (timedOut) failure = { kind: 'timeout', retryable: true }
  else if (quotaHit) failure = { kind: 'quota', code: j.api_error_status === 429 ? '429' : errText.match(CLAUDE_QUOTA_RE)[0], retryable: true }
  else if (j && j.is_error === true) failure = { kind: 'process', code: `claude:${j.subtype || 'error'}`, retryable: false }
  else failure = classifyFailure({ timedOut, exit, signal: r.signal || null, stderr: r.stderr, parsed: j !== null })
  return {
    exit,
    signal: r.signal || null,
    timedOut,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    text,
    denied: (j && Array.isArray(j.permission_denials)) ? j.permission_denials : [],
    usage: (j && j.usage) || null,
    failure,
    raw: r,
  }
}

function reviewArgs({ model, prompt, cwd, timeoutMs, env, spawn }) {
  return { model, prompt, cwd, timeoutMs: timeoutMs || 15 * 60 * 1000, env: env || process.env, spawn }
}

async function reviewRun(opts) {
  const a = reviewArgs(opts)
  const spawn = a.spawn || spawnAsync
  const r = await spawn(resolveClaudeBin(a.env), buildClaudeReviewArgs(a), spawnOpts(a))
  return normalizeReview(parseClaudeRun(r))
}

function reviewRunSync(opts) {
  const a = reviewArgs(opts)
  const spawn = a.spawn || spawnSync
  const r = spawn(resolveClaudeBin(a.env), buildClaudeReviewArgs(a), spawnOpts(a))
  return normalizeReview(parseClaudeRun(r))
}

/** @type {import('./_contract.mjs').Harness} */
export const harness = {
  name: 'claude',
  quotaBuckets: ['anthropic'],
  canCoordinate: true,
  canReview: true,
  canWrite: false,
  transcriptMeasurable: true,
  resolveBin: (env = process.env) => resolveClaudeBin(env),
  checkBinary: (env = process.env, deps = {}) =>
    probeBinary(deps.claudeBin !== undefined ? deps.claudeBin : resolveClaudeBin(env), env, deps),
  review: { run: reviewRun, runSync: reviewRunSync, normalize: normalizeReview, args: reviewArgs },
}

export default harness
