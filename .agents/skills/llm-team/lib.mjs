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
import path from 'node:path'
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

/**
 * 載入專案的 llm-team config.json。
 * 缺檔或 schemaVersion !== 1 ⇒ fail-closed throw。
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
  if (!config || config.schemaVersion !== 1) {
    throw new Error(`config schemaVersion 不支援（${targetFile}）：預期 1，得到 ${config?.schemaVersion}`)
  }
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
  if (config.codexTier === undefined) {
    config.codexTier = 'block'
  } else if (config.codexTier !== 'block' && config.codexTier !== 'all') {
    throw new Error(`config codexTier 不支援（${targetFile}）：預期 "block" 或 "all"，得到 ${JSON.stringify(config.codexTier)}`)
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

/** 寫手提示哨兵（專案 GEMINI.md 靠它判斷「我是寫手不是統整者」）。 */
export const WRITER_PROMPT_SENTINEL = '【llm-team 寫手票】'

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
export function buildAgyArgs({ model, mode, prompt, timeoutMs = 10 * 60 * 1000, extraArgs = [] }) {
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
    ...extraArgs,
    '-p',
    prompt,
  ]
}

/**
 * 非同步 spawn 子行程，回傳 Promise<{ status, signal, stdout, stderr }>。
 * 與 spawnSync 回傳形狀一致：
 * - 支援 opts.timeout：到期自動 kill('SIGTERM')，status: null, signal: 'SIGTERM'。
 * - 支援 opts.maxBuffer：超過上限截斷並在 stderr 記一行。
 */
export function spawnAsync(bin, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
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

    let stdout = ''
    let stderr = ''
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
}

/** 解析 runAgy 或 runAgyAsync 之 spawn 結果物件。 */
export function parseAgyRun(res) {
  const r = res || {}
  const parsed = parseStreamJson(r.stdout || '')
  return {
    exit: r.status,
    signal: r.signal || null,
    timedOut: r.timedOut === true,
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
  const args = buildAgyArgs({ model, mode, prompt, timeoutMs, extraArgs })
  const r = spawn(bin, args, {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return parseAgyRun(r)
}

/**
 * 跑一次 agy headless（非同步版）。
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
  const args = buildAgyArgs({ model, mode, prompt, timeoutMs, extraArgs })
  const r = await spawn(bin, args, {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return parseAgyRun(r)
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
      if (err && /permission/i.test(err)) denied.push({ action: 'permission', tool: su.tool_name, detail: err.slice(0, 200) })
    }
  }
  const conversationId = (result && result.conversation_id) || initConversationId || null
  return { result, steps, denied, conversationId }
}

/** 組裝 codex exec 引數。 */
export function buildCodexArgs({ model, prompt, effort = 'high', cwd }) {
  if (!model) throw new Error('runCodex 需要 model（來自 config.models.codex）')
  return ['exec', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '--sandbox', 'read-only', '-C', cwd, prompt]
}

/** 解析 runCodex 或 runCodexAsync 之 spawn 結果物件。 */
export function parseCodexRun(res) {
  const r = res || {}
  return {
    exit: r.status,
    signal: r.signal || null,
    timedOut: r.timedOut === true,
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
