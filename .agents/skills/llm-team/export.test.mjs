import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXPORT_FILES, exportTo, verifySnapshot, main as exportMain } from './export.mjs'

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeSourceDir() {
  const dir = tmpdir('source-llm-team-')
  for (const f of EXPORT_FILES) {
    const full = path.join(dir, f)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    if (f === 'VERSION') {
      fs.writeFileSync(full, '1\n')
    } else {
      fs.writeFileSync(full, `// ${f}\nexport default 1\n`)
    }
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ schemaVersion: 1, template: true }, null, 2) + '\n')
  return dir
}

const fakeGit = (args) => (args[0] === 'rev-parse' ? 'abcdef0123456789' : '')

describe('export.mjs 快照導出與驗證測試', () => {
  test('export 後 manifest 行數＝EXPORT_FILES 數＋1、verifySnapshot ok', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')

    const res = exportTo(sourceDir, targetRoot, {
      deps: {
        git: (args) => (args[0] === 'rev-parse' ? 'abcdef0123456789' : ''),
      },
    })
    assert.equal(res.ok, true)
    assert.equal(res.status, 0)

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')
    assert.ok(fs.existsSync(manifestPath), 'MANIFEST.sha256 應存在')

    const manifestLines = fs
      .readFileSync(manifestPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    assert.equal(manifestLines.length, EXPORT_FILES.length + 1, 'manifest 行數應為 EXPORT_FILES 數＋1')

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, true, '快照驗證應為 ok')
    assert.deepEqual(v.missing, [])
    assert.deepEqual(v.changed, [])
    assert.deepEqual(v.extra, [])
    assert.deepEqual(v.unlisted, [])
    assert.deepEqual(v.malformed, [])
    assert.deepEqual(v.duplicate, [])

    const sourceJson = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'SOURCE.json'), 'utf8'))
    assert.equal(sourceJson.version, '1')
    assert.equal(sourceJson.sourceCommit, 'abcdef0123456789')
    assert.equal(sourceJson.sourceDirty, false)
    assert.ok(sourceJson.exportedAt)
  })

  test('改一檔 ⇒ changed 含它', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const targetFile = path.join(snapshotDir, 'lib.mjs')
    fs.appendFileSync(targetFile, '// drifted\n')

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.changed.includes('lib.mjs'), `changed 應包含 lib.mjs，實際：${JSON.stringify(v.changed)}`)
  })

  test('多放一個 x.mjs ⇒ extra 含它', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    fs.writeFileSync(path.join(snapshotDir, 'x.mjs'), '// extra\n')

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.extra.includes('x.mjs'), `extra 應包含 x.mjs，實際：${JSON.stringify(v.extra)}`)
  })

  test('再 export 不帶 --force ⇒ 回 2；帶 --force ⇒ 覆蓋且 ok', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    fs.appendFileSync(path.join(snapshotDir, 'lib.mjs'), '// drift\n')

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let resNoForce
    try {
      resNoForce = exportTo(sourceDir, targetRoot, { force: false, deps: { git: fakeGit } })
    } finally {
      console.error = origErr
    }

    assert.equal(resNoForce.ok, false)
    assert.equal(resNoForce.status, 2)
    assert.ok(resNoForce.changed.includes('lib.mjs'))
    assert.match(errs.join('\n'), /🔴 快照已被修改/)

    // 帶 --force
    const resForce = exportTo(sourceDir, targetRoot, { force: true, deps: { git: fakeGit } })
    assert.equal(resForce.ok, true)
    assert.equal(resForce.status, 0)

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, true, 'force 覆蓋後快照驗證應為 ok')
    assert.deepEqual(v.changed, [])
  })

  test('目標沒有 llm-team.config.json ⇒ 被放範本，已有 ⇒ 不被覆蓋', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    const configPath = path.join(targetRoot, 'llm-team.config.json')

    // 1. 目標沒有 ⇒ 被放範本
    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    try {
      exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })
    } finally {
      console.log = origLog
    }

    assert.ok(fs.existsSync(configPath), 'llm-team.config.json 應被建立')
    assert.match(outs.join('\n'), /已放範本，請改成專案值/)
    const cfg1 = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(cfg1.template, true)

    // 2. 目標已有自訂內容 ⇒ 不被覆蓋
    fs.writeFileSync(configPath, JSON.stringify({ custom: 'user-defined' }, null, 2))
    const outs2 = []
    console.log = (m) => outs2.push(String(m))
    try {
      exportTo(sourceDir, targetRoot, { force: true, deps: { git: fakeGit } })
    } finally {
      console.log = origLog
    }

    const cfg2 = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(cfg2.custom, 'user-defined', '既有 config.json 不應被覆蓋')
    assert.ok(!outs2.join('\n').includes('已放範本'), '已有 config 時不應印已放範本')
  })

  test('exportMain CLI：缺 --to 回 2，正常回 0', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let codeBad
    try {
      codeBad = exportMain([])
    } finally {
      console.error = origErr
    }
    assert.equal(codeBad, 2)

    const origLog = console.log
    console.log = () => {}
    let codeGood
    try {
      codeGood = exportMain(['--to', targetRoot], { git: fakeGit })
    } finally {
      console.log = origLog
    }
    assert.equal(codeGood, 0)
  })

  test('manifest 少一行（把 lib.mjs 那行刪掉）⇒ unlisted 含 lib.mjs、ok=false', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')
    const lines = fs
      .readFileSync(manifestPath, 'utf8')
      .split('\n')
      .filter((l) => !l.includes('lib.mjs'))
    fs.writeFileSync(manifestPath, lines.join('\n') + '\n')

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.unlisted.includes('lib.mjs'), `unlisted 應包含 lib.mjs，實際：${JSON.stringify(v.unlisted)}`)
  })

  test('manifest 多一行假路徑 ⇒ extra 含它', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')
    const dummyHash = 'a'.repeat(64)
    fs.appendFileSync(manifestPath, `${dummyHash}  fake-extra.mjs\n`)

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.extra.includes('fake-extra.mjs'), `extra 應包含 fake-extra.mjs，實際：${JSON.stringify(v.extra)}`)
  })

  test('一行格式壞（hash 只有 10 字）⇒ malformed 含它', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')
    fs.appendFileSync(manifestPath, '1234567890  bad-format.mjs\n')

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(
      v.malformed.includes('1234567890  bad-format.mjs'),
      `malformed 應包含格式壞的行，實際：${JSON.stringify(v.malformed)}`
    )
  })

  test('同一路徑兩行 ⇒ duplicate 含它', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')
    const dummyHash = 'b'.repeat(64)
    fs.appendFileSync(manifestPath, `${dummyHash}  lib.mjs\n`)

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.duplicate.includes('lib.mjs'), `duplicate 應包含 lib.mjs，實際：${JSON.stringify(v.duplicate)}`)
  })

  test('快照刪一個檔 ⇒ missing 含它且 exportTo 不帶 force 回 status 2', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const targetFile = path.join(snapshotDir, 'lib.mjs')
    fs.unlinkSync(targetFile)

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.missing.includes('lib.mjs'), `missing 應包含 lib.mjs，實際：${JSON.stringify(v.missing)}`)

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let resNoForce
    try {
      resNoForce = exportTo(sourceDir, targetRoot, { force: false, deps: { git: fakeGit } })
    } finally {
      console.error = origErr
    }

    assert.equal(resNoForce.ok, false)
    assert.equal(resNoForce.status, 2)
    assert.ok(resNoForce.verify.missing.includes('lib.mjs'))
  })

  test('假 git 對 rev-parse throw ⇒ exportTo throw、目的地目錄不存在（沒留半成品）', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    const badGit = (args) => {
      if (args[0] === 'rev-parse') throw new Error('git rev-parse HEAD 失敗：simulated error')
      return ''
    }

    assert.throws(
      () => {
        exportTo(sourceDir, targetRoot, { deps: { git: badGit } })
      },
      /git rev-parse HEAD 失敗/
    )

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    assert.equal(fs.existsSync(snapshotDir), false, '目的地目錄不應存在（沒留半成品）')
  })

  test('真源新增檔不是目標漂移：來源加新檔重 export 成功且目標多該檔與 MANIFEST 含它；對照目標先手放同名檔仍拒絕 unlisted', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')

    // 1. 先 export 一版
    const res1 = exportTo(sourceDir, targetRoot, {
      deps: { git: fakeGit },
      exportFiles: [...EXPORT_FILES],
    })
    assert.equal(res1.ok, true)
    assert.equal(res1.status, 0)

    // 2. 把來源加一個新檔（tmp 造）重 export，不帶 --force ⇒ 成功且目標多那個檔、MANIFEST 含它
    const newFile = 'new-source-file.mjs'
    fs.writeFileSync(path.join(sourceDir, newFile), '// newly added in source\nexport default 999\n')
    const newExportFiles = [...EXPORT_FILES, newFile]

    const outs = []
    const origLog = console.log
    console.log = (m) => outs.push(String(m))
    let res2
    try {
      res2 = exportTo(sourceDir, targetRoot, {
        deps: { git: fakeGit },
        exportFiles: newExportFiles,
        force: false,
      })
    } finally {
      console.log = origLog
    }

    assert.equal(res2.ok, true, '真源新增檔不應被當作漂移拒絕')
    assert.equal(res2.status, 0)
    assert.match(outs.join('\n'), /\+ new-source-file\.mjs/, '應印出 + <檔名>')

    const targetSnapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const newTargetFilePath = path.join(targetSnapshotDir, newFile)
    assert.ok(fs.existsSync(newTargetFilePath), '目標目錄應多出該新檔')

    const manifestContent = fs.readFileSync(path.join(targetSnapshotDir, 'MANIFEST.sha256'), 'utf8')
    assert.match(manifestContent, /new-source-file\.mjs/, 'MANIFEST 應包含該新檔')

    // 3. 對照：目標先手放一個同名檔 ⇒ 仍拒絕 unlisted
    const targetRootControl = tmpdir('target-repo-control-')
    exportTo(sourceDir, targetRootControl, {
      deps: { git: fakeGit },
      exportFiles: [...EXPORT_FILES],
    })

    const driftFile = 'drift-file.mjs'
    fs.writeFileSync(path.join(sourceDir, driftFile), '// in source\n')
    const targetControlSnapshotDir = path.join(targetRootControl, '.agents', 'skills', 'llm-team')
    fs.writeFileSync(path.join(targetControlSnapshotDir, driftFile), '// manually placed in target\n')

    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let resControl
    try {
      resControl = exportTo(sourceDir, targetRootControl, {
        deps: { git: fakeGit },
        exportFiles: [...EXPORT_FILES, driftFile],
        force: false,
      })
    } finally {
      console.error = origErr
    }

    assert.equal(resControl.ok, false)
    assert.equal(resControl.status, 2)
    assert.ok(resControl.verify.unlisted.includes(driftFile), `unlisted 應包含手放同名檔 ${driftFile}`)
    assert.match(errs.join('\n'), /🔴 快照已被修改（手動漂移），不准覆蓋/)
    assert.match(errs.join('\n'), /unlisted:/)
  })
})
