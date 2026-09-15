import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { main } from './batch.mjs'

describe('batch.mjs 批次執行測試', () => {
  test('(a) 無指令 ⇒ 2', () => {
    const code = main([])
    assert.equal(code, 2)
  })

  test('(b) 未知旗標 ⇒ 2', () => {
    const code = main(['--unknown-flag'])
    assert.equal(code, 2)
  })

  test('(c) 兩段皆 0 ⇒ 0 且最後一行 BATCH exits: 0 0', () => {
    const outs = []
    const spawnCalls = []
    const deps = {
      spawn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts })
        return { status: 0, stdout: 'ok\n', signal: null }
      },
      stdout: (str) => outs.push(str),
    }

    const code = main(['echo 1', 'echo 2'], deps)
    assert.equal(code, 0)
    assert.equal(spawnCalls.length, 2)
    const outText = outs.join('')
    const lines = outText.trim().split('\n')
    assert.equal(lines[lines.length - 1], 'BATCH exits: 0 0')
  })

  test('(d) 第 1 段 3、第 2 段 0 ⇒ 第 2 段仍跑、exit 3', () => {
    const outs = []
    const spawnCalls = []
    const deps = {
      spawn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts })
        if (spawnCalls.length === 1) {
          return { status: 3, stdout: 'first failed\n', signal: null }
        }
        return { status: 0, stdout: 'second ok\n', signal: null }
      },
      stdout: (str) => outs.push(str),
    }

    const code = main(['cmd1', 'cmd2'], deps)
    assert.equal(code, 3)
    assert.equal(spawnCalls.length, 2, '第 1 段失敗後第 2 段仍應被執行')
    const outText = outs.join('')
    assert.ok(outText.includes('-- [1] exit=3 lines=1'))
    assert.ok(outText.includes('-- [2] exit=0 lines=1'))
    assert.ok(outText.includes('BATCH exits: 3 0'))
  })

  test('(e) 41 行輸出 ⇒ 印前 8＋省略行＋後 20，且 ℹ pass 3／not ok 2 - x／AssertionError 行出現在「分母／紅燈行」區', () => {
    const outs = []
    const rawLines = []
    for (let i = 1; i <= 41; i++) {
      if (i === 15) rawLines.push('ℹ pass 3')
      else if (i === 20) rawLines.push('not ok 2 - x')
      else if (i === 25) rawLines.push('AssertionError: failed')
      else rawLines.push(`line ${i}`)
    }
    const stdoutContent = rawLines.join('\n') + '\n'

    const deps = {
      spawn: () => ({ status: 0, stdout: stdoutContent, signal: null }),
      stdout: (str) => outs.push(str),
    }

    const code = main(['cmd-41'], deps)
    assert.equal(code, 0)
    const outText = outs.join('')

    // 檢查前 8 行
    for (let i = 1; i <= 8; i++) {
      assert.ok(outText.includes(`line ${i}\n`))
    }
    // 檢查省略行
    assert.ok(outText.includes('[… 省略 13 行（共 41 行；--full 看全部）…]'))
    // 檢查後 20 行
    assert.ok(outText.includes('line 41\n'))
    // 檢查分母／紅燈行區
    assert.ok(outText.includes('-- 分母／紅燈行（不截）：'))
    assert.match(outText, /15:ℹ pass 3/)
    assert.match(outText, /20:not ok 2 - x/)
    assert.match(outText, /25:AssertionError: failed/)
    assert.ok(outText.includes('-- [1] exit=0 lines=41'))
  })

  test('(f) 同輸入加 --full ⇒ 41 行全印、無省略行', () => {
    const outs = []
    const rawLines = []
    for (let i = 1; i <= 41; i++) {
      rawLines.push(`line ${i}`)
    }
    const stdoutContent = rawLines.join('\n') + '\n'

    const deps = {
      spawn: () => ({ status: 0, stdout: stdoutContent, signal: null }),
      stdout: (str) => outs.push(str),
    }

    const code = main(['--full', 'cmd-41'], deps)
    assert.equal(code, 0)
    const outText = outs.join('')
    assert.ok(!outText.includes('省略'))
    assert.ok(!outText.includes('-- 分母／紅燈行（不截）：'))
    for (let i = 1; i <= 41; i++) {
      assert.ok(outText.includes(`line ${i}\n`))
    }
  })

  test('(g) 訊號終止（status null、signal \'SIGTERM\'）⇒ 該段 exit 143、印 signal=SIGTERM', () => {
    const outs = []
    const deps = {
      spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '' }),
      stdout: (str) => outs.push(str),
    }

    const code = main(['long-cmd'], deps)
    assert.equal(code, 143)
    const outText = outs.join('')
    assert.match(outText, /exit=143/)
    assert.match(outText, /signal=SIGTERM/)
    assert.ok(outText.includes('BATCH exits: 143'))
  })

  test('(h) --cwd 不存在 ⇒ 2', () => {
    const code = main(['--cwd', '/path/that/definitely/does/not/exist/llm-team', 'echo 1'])
    assert.equal(code, 2)
  })
})
