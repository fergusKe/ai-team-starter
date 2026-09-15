import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { isDirectRun } from './lib.mjs'

const RETAIN_REGEX = /(?:^ℹ (?:tests|pass|fail))|(?:Tests  )|(?:Test Files)|(?:^not ok)|(?:AssertionError)/

export function main(argv, deps = {}) {
  const spawnFn = deps.spawn || spawnSync
  const write = deps.stdout || ((str) => process.stdout.write(str))
  const print = (str = '') => write(str + '\n')

  let cwd = process.cwd()
  let full = false
  let cmds = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      cmds = argv.slice(i + 1)
      break
    }
    if (a === '--full') {
      full = true
      continue
    }
    if (a === '--cwd') {
      if (i + 1 >= argv.length) {
        console.error('🔴 --cwd 缺少路徑參數')
        return 2
      }
      i++
      cwd = argv[i]
      continue
    }
    if (a.startsWith('--')) {
      console.error(`🔴 未知旗標：${a}`)
      return 2
    }
    cmds = argv.slice(i)
    break
  }

  try {
    const st = fs.statSync(cwd)
    if (!st.isDirectory()) {
      console.error(`🔴 --cwd 不是目錄：${cwd}`)
      return 2
    }
  } catch (e) {
    console.error(`🔴 cd 失敗（${cwd}）：${e.message}`)
    return 2
  }

  if (cmds.length === 0) {
    console.error('🔴 沒指令')
    return 2
  }

  const exits = []

  for (let i = 0; i < cmds.length; i++) {
    const idx = i + 1
    const cmd = cmds[i]
    print(`== [${idx}] ${cmd}`)

    const res = spawnFn('bash', ['-c', cmd], { cwd, env: process.env, encoding: 'utf8' })

    let outStr = ''
    if (res.stdout || res.stderr) {
      outStr = (res.stdout || '') + (res.stderr || '')
    } else if (res.output && Array.isArray(res.output)) {
      outStr = res.output.filter(Boolean).join('')
    }

    const trimmedOut = outStr.endsWith('\n') ? outStr.slice(0, -1) : outStr
    const lines = trimmedOut ? trimmedOut.split(/\r?\n/) : []
    const totalLines = lines.length

    if (totalLines <= 40 || full) {
      for (const line of lines) {
        print(line)
      }
    } else {
      for (let j = 0; j < 8; j++) {
        print(lines[j])
      }
      print(`[… 省略 ${totalLines - 28} 行（共 ${totalLines} 行；--full 看全部）…]`)
      for (let j = totalLines - 20; j < totalLines; j++) {
        print(lines[j])
      }
      print('-- 分母／紅燈行（不截）：')
      const retained = []
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j]
        if (RETAIN_REGEX.test(line)) {
          retained.push(`${j + 1}:${line}`)
        }
      }
      for (const rLine of retained.slice(0, 30)) {
        print(rLine)
      }
    }

    let secExit = 0
    let sigName = null
    if (res.signal) {
      sigName = res.signal
      const sigNum = os.constants.signals[sigName] || (sigName === 'SIGTERM' ? 15 : 0)
      secExit = 128 + sigNum
    } else if (res.status !== null && res.status !== undefined) {
      secExit = res.status
    } else {
      secExit = 1
    }

    exits.push(secExit)

    const sigSuffix = sigName ? ` signal=${sigName}` : ''
    print(`-- [${idx}] exit=${secExit} lines=${totalLines}${sigSuffix}`)
  }

  print(`BATCH exits: ${exits.join(' ')}`)

  const firstNonZero = exits.find((code) => code !== 0) || 0
  return firstNonZero
}

export function runCli(argv, exitFn = process.exit, errFn = console.error, deps = {}) {
  try {
    const code = main(argv, deps)
    exitFn(code)
    return code
  } catch (err) {
    errFn(err)
    exitFn(1)
    return 1
  }
}

if (isDirectRun(import.meta.url)) {
  runCli(process.argv.slice(2))
}
