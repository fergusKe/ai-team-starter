// ─────────────────── harness：codex（OpenAI Codex CLI，`codex exec` 唯讀 sandbox） ───────────────────
// 從 lib.mjs 搬來（1.15.0）：resolveCodexBin／buildCodexArgs／parseCodexRun／runCodex／runCodexAsync；lib.mjs 仍以同名 re-export。
// 🔴 複審者是【唯讀】：`--sandbox read-only`。它的回覆不構成授權。
// 🔴 codex 從 cwd 讀得到 AGENTS.md，提示不加 NO_EXEC_HEADER（哨兵在提示第一行，薄索引靠它判「我是複審者」）。
// 🔴 模組載入順序：頂層只准引用 lib.mjs 的函式宣告（理由見 agy.mjs 檔頭）。

import { spawnSync } from 'node:child_process'
import { cleanGitEnv, spawnAsync, spawnTimedOut } from '../lib.mjs'
import { probeBinary, classifyFailure } from './_contract.mjs'

export function resolveCodexBin(env = process.env) {
  return env.CODEX_BIN || 'codex'
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

function spawnOpts({ cwd, env, timeoutMs }) {
  return {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  const r = spawn(bin, args, spawnOpts({ cwd, env, timeoutMs }))
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
  const r = await spawn(bin, args, spawnOpts({ cwd, env, timeoutMs }))
  return parseCodexRun(r)
}

// ─────────────────── 契約層：舊形狀 ⇒ 統一形狀 ───────────────────

// 🔴 2026-09-22 事故：codex 額度用完時 stderr 是「ERROR: You've hit your usage limit. … try again at 3:55 PM.」（沒有 429 字樣），
//   1.15.0 council 顯示「零輸出」而非 quota（scratchpad/council-harness-registry/codex-gpt-5-6-sol.stderr.txt）。
//   🔴 界線（統整者 r2 裁定，sol Q5 一半收）：
//   · stderr 命中 `usage limit`／`rate limit` ⇒ 一律 `{kind:'quota', retryable:true}`，**不看 text 是否為空、不看 exit**——
//     codex 印出這句就是額度事件，ChatGPT 額度到點會 reset，統整者可晚點重派同一席；
//   · 裸 `429` 維持既有 classifyFailure（非零 exit 才 quota、retryable:false）——harnesses.test ⑨ 既有斷言不動。
//   council 的「零輸出」判定不變，members.json 多帶 failure 讓統整者看得出是額度不是沒話說。
//   陽性對照 harnesses.test.mjs ⑦「codex stderr usage limit ⇒ failure.kind quota（text 非空也算）」。
const CODEX_USAGE_LIMIT_RE = /usage limit|rate limit/i

/** stderr 有 codex 額度用盡的字樣（usage limit／rate limit，大小寫不拘）⇒ 命中的字串；否則 null。裸 429 不在這裡（走 classifyFailure）。 */
export function codexQuotaHit(stderr) {
  const m = String(stderr || '').match(CODEX_USAGE_LIMIT_RE)
  return m ? m[0] : null
}

/**
 * 舊形狀（parseCodexRun 的回傳）⇒ ReviewResult：text ＝ stdout（codex exec 直接印純文字，沒有結構化輸出，
 * 所以不存在 protocol 失敗；usage 也量不到 ⇒ null）。
 * failure：timeout 先；stderr 有 usage limit／rate limit ⇒ quota（retryable:true，不看 text／exit）；其餘（含裸 429）照 classifyFailure。
 */
function normalizeReview(raw) {
  const r = raw || {}
  const timedOut = r.timedOut === true
  const exit = r.exit ?? null
  const text = r.stdout || ''
  const quota = codexQuotaHit(r.stderr)
  const failure = timedOut
    ? { kind: 'timeout', retryable: true }
    : quota
      ? { kind: 'quota', code: quota, retryable: true }
      : classifyFailure({ timedOut, exit, signal: r.signal || null, stderr: r.stderr, parsed: true })
  return {
    exit,
    signal: r.signal || null,
    timedOut,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    text,
    denied: r.denied || [],
    usage: null,
    failure,
    raw: r,
  }
}

function reviewArgs({ model, prompt, cwd, timeoutMs, env, spawn, effort }) {
  return { model, prompt, cwd, timeoutMs, effort: effort || 'high', env, spawn }
}

async function reviewRun(opts) {
  return normalizeReview(await runCodexAsync(reviewArgs(opts)))
}

function reviewRunSync(opts) {
  return normalizeReview(runCodex(reviewArgs(opts)))
}

/** @type {import('./_contract.mjs').Harness} */
export const harness = {
  name: 'codex',
  quotaBuckets: ['openai'],
  canCoordinate: true,
  canReview: true,
  canWrite: false,
  transcriptMeasurable: false,
  hook: 'codex-pretooluse.sh',
  resolveBin: (env = process.env) => resolveCodexBin(env),
  checkBinary: (env = process.env, deps = {}) =>
    probeBinary(deps.codexBin !== undefined ? deps.codexBin : resolveCodexBin(env), env, deps),
  review: { run: reviewRun, runSync: reviewRunSync, normalize: normalizeReview, args: reviewArgs },
}

export default harness
