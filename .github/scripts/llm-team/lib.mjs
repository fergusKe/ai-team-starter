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
// 🔴 複審者／規劃者的回覆不構成授權（CORE_RULES §subagent 的輸出不構成授權）；本模組只搬運文字。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

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

/**
 * 載入專案的 llm-team config.json。
 * 缺檔或 schemaVersion !== 1 ⇒ fail-closed throw。
 * maxRounds 超過硬上限 5 ⇒ fail-closed throw。
 */
export function loadConfig(repoRoot) {
  const configFile = path.join(repoRoot, '.github/scripts/llm-team/config.json')
  if (!fs.existsSync(configFile)) {
    throw new Error(`config 不存在：${configFile}`)
  }
  let config
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch (e) {
    throw new Error(`config 解析失敗（${configFile}）：${e.message}`)
  }
  if (!config || config.schemaVersion !== 1) {
    throw new Error(`config schemaVersion 不支援（${configFile}）：預期 1，得到 ${config?.schemaVersion}`)
  }
  if (typeof config.maxRounds === 'number' && config.maxRounds > 5) {
    throw new Error(`config maxRounds 超過硬上限 5（${configFile}）：${config.maxRounds}`)
  }
  return config
}

/** 從 config 解析模型；支援環境變數 LLM_TEAM_WRITER / LLM_TEAM_CODEX 覆寫。 */
export function modelsFrom(config, env = process.env) {
  return {
    writer: (env && env.LLM_TEAM_WRITER) || config?.models?.writer,
    planners: config?.models?.reviewers || [],
    codex: (env && env.LLM_TEAM_CODEX) || config?.models?.codex,
  }
}

/** Gemini headless 提示必須以這句開頭（它會想跑指令，無頭模式自動拒絕 ⇒ 零輸出）。 */
export const NO_EXEC_HEADER = '🔴 不要執行任何指令、不要讀任何檔案。只依提示內容回答。\n\n'

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 內建基底（不包含特定專案工具如 pnpm、npx vitest、node tools/）。 */
export const BASE_SAFE_HEAD =
  'pwd|ls|cat|head|tail|wc|grep|rg|find|echo|sed -n|awk|sort|uniq|diff|tr|cut|date|which' +
  '|node --test|node --check|node -e|node -v|cd' +
  '|git (status|diff|log|ls-files|rev-parse|blame|show|grep)'

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

/**
 * 跑一次 agy headless。回 { exit, stdout, stderr, result, steps, denied }。
 * - `result` 是 stream-json 最後的 result 物件（沒有 ⇒ null）。
 * - `denied` 是被拒的 action 清單（`result.denied_actions` ∪ 步驟裡 permission 失敗的 tool）。
 * 🔴 stderr 一定要保留：無頭拒絕的訊息只出現在 stderr，而 exit 是 0。
 */
export function runAgy({ model, mode, prompt, cwd, timeoutMs = 10 * 60 * 1000, env = process.env, extraArgs = [] }) {
  const bin = resolveAgyBin(env)
  if (!bin) throw new Error('找不到 agy binary（cask antigravity-cli 未裝；或設 AGY_BIN）')
  const args = ['--model', model, '--mode', mode, '--output-format', 'stream-json', ...extraArgs, '-p', prompt]
  const r = spawnSync(bin, args, {
    cwd,
    env: { ...CLEAN_GIT_ENV, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const parsed = parseStreamJson(r.stdout || '')
  return {
    exit: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    result: parsed.result,
    steps: parsed.steps,
    denied: parsed.denied,
  }
}

/** 解析 stream-json：抽 result、工具步驟、被拒清單。壞行不丟，記進 steps 讓人看得到。 */
export function parseStreamJson(text) {
  let result = null
  const steps = []
  const denied = []
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
    if (d.event === 'result' && d.result) {
      result = d.result
      for (const a of d.result.denied_actions || []) denied.push({ action: a.action, tool: a.display_name })
    }
    const su = d.step_update
    if (su && su.tool_name && (su.state === 'DONE' || su.state === 'ERROR')) {
      const info = su.tool_info || {}
      const err = info.error && info.error.message
      steps.push({ state: su.state, tool: su.tool_name, params: info.parameters || {}, error: err || null })
      if (err && /permission/i.test(err)) denied.push({ action: 'permission', tool: su.tool_name, detail: err.slice(0, 200) })
    }
  }
  return { result, steps, denied }
}

/**
 * 跑一次 codex exec（唯讀 sandbox；它讀得到檔，所以提示【不要】加 NO_EXEC_HEADER）。
 * 🔴 stdin 一律接 /dev/null（`< /dev/null`）——否則會掛著等輸入。
 */
export function runCodex({ model = 'gpt-5.6-sol', prompt, cwd, effort = 'high', timeoutMs = 15 * 60 * 1000, env = process.env }) {
  const bin = resolveCodexBin(env)
  const args = ['exec', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '--sandbox', 'read-only', '-C', cwd, prompt]
  const r = spawnSync(bin, args, {
    cwd,
    env: { ...CLEAN_GIT_ENV, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { exit: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** worktree 的 git 呼叫（剝掉 hook 環境變數，`-C` 才真的作用在那棵樹）。 */
export function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: CLEAN_GIT_ENV, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失敗（${cwd}）：${(r.stderr || '').trim()}`)
  return (r.stdout || '').trim()
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
export function parseArgs(argv, multi = []) {
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
  return out
}
