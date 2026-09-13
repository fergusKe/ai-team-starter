import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EXPORT_FILES, exportTo, verifySnapshot, main as exportMain } from './export.mjs'
import { main as setupMain } from './setup.mjs'

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
    assert.deepEqual(sourceJson.files, EXPORT_FILES)
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

  test('乾淨快照對照 ⇒ extra 空且 --sync-check exit 0', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, true)
    assert.deepEqual(v.extra, [])

    const code = setupMain(['--sync-check'], { repoRoot: targetRoot })
    assert.equal(code, 0)
  })

  test('乾淨快照 + x.json ⇒ extra 含 x.json 且 --sync-check exit 1', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    fs.writeFileSync(path.join(snapshotDir, 'x.json'), '{"extra":true}\n')

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.extra.includes('x.json'), `extra 應包含 x.json，實際：${JSON.stringify(v.extra)}`)

    const code = setupMain(['--sync-check'], { repoRoot: targetRoot })
    assert.equal(code, 1)
  })

  test('乾淨快照 + 無副檔名檔 stray ⇒ extra 含 stray 且 --sync-check exit 1', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    fs.writeFileSync(path.join(snapshotDir, 'stray'), 'stray content\n')

    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.extra.includes('stray'), `extra 應包含 stray，實際：${JSON.stringify(v.extra)}`)

    const code = setupMain(['--sync-check'], { repoRoot: targetRoot })
    assert.equal(code, 1)
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

  test('目標同時刪檔與 manifest 行（SOURCE.json 不動）⇒ 判定為 missing 拒絕；來源真新增檔 ⇒ 成功且 files 含它；verifySnapshot 不強求 files 欄', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-deletion-')

    // 1. export 一版
    const res1 = exportTo(sourceDir, targetRoot, {
      deps: { git: fakeGit },
      exportFiles: [...EXPORT_FILES],
    })
    assert.equal(res1.ok, true)
    assert.equal(res1.status, 0)

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const sourceJson1 = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'SOURCE.json'), 'utf8'))
    assert.deepEqual(sourceJson1.files, EXPORT_FILES)

    // 2. 目標刪掉某檔（例如 lib.mjs）並從 MANIFEST 拿掉那行（SOURCE.json 不動）
    const deleteFile = 'lib.mjs'
    fs.unlinkSync(path.join(snapshotDir, deleteFile))

    const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')
    const lines = fs
      .readFileSync(manifestPath, 'utf8')
      .split('\n')
      .filter((l) => !l.includes(deleteFile))
    fs.writeFileSync(manifestPath, lines.join('\n') + '\n')

    // 3. 再 export 不帶 --force ⇒ 拒絕且訊息含該檔名
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let resNoForce
    try {
      resNoForce = exportTo(sourceDir, targetRoot, {
        deps: { git: fakeGit },
        exportFiles: [...EXPORT_FILES],
        force: false,
      })
    } finally {
      console.error = origErr
    }

    assert.equal(resNoForce.ok, false)
    assert.equal(resNoForce.status, 2)
    assert.ok(resNoForce.verify.missing.includes(deleteFile), `missing 應包含手動刪除檔 ${deleteFile}`)
    const errOutput = errs.join('\n')
    assert.match(errOutput, /目標曾有此檔，現在連 manifest 都沒有＝手動刪除，不准靜默補回/)
    assert.match(errOutput, /missing:/, '錯誤訊息應包含 missing')
    assert.ok(errOutput.includes(deleteFile), `錯誤訊息應包含刪除檔名 ${deleteFile}`)

    // 4. 對照：來源真的新增檔 ⇒ 成功、SOURCE.json.files 含它
    const targetRootNew = tmpdir('target-repo-newfile-')
    exportTo(sourceDir, targetRootNew, {
      deps: { git: fakeGit },
      exportFiles: [...EXPORT_FILES],
    })

    const newFile = 'new-feature.mjs'
    fs.writeFileSync(path.join(sourceDir, newFile), '// newly added\nexport default 100\n')
    const newExportFiles = [...EXPORT_FILES, newFile]

    const resNew = exportTo(sourceDir, targetRootNew, {
      deps: { git: fakeGit },
      exportFiles: newExportFiles,
      force: false,
    })
    assert.equal(resNew.ok, true)
    assert.equal(resNew.status, 0)
    const newSnapshotDir = path.join(targetRootNew, '.agents', 'skills', 'llm-team')
    const sourceJsonNew = JSON.parse(fs.readFileSync(path.join(newSnapshotDir, 'SOURCE.json'), 'utf8'))
    assert.deepEqual(sourceJsonNew.files, newExportFiles)
    assert.ok(sourceJsonNew.files.includes(newFile))

    // 5. verifySnapshot 對 files 欄的存在不另加要求（MANIFEST 才是完整性的尺）
    const sourceJsonNoFiles = {
      version: '1',
      sourceCommit: 'abcdef0123456789',
      sourceDirty: false,
      exportedAt: new Date().toISOString(),
    }
    const sourceJsonNoFilesPath = path.join(newSnapshotDir, 'SOURCE.json')
    fs.writeFileSync(sourceJsonNoFilesPath, JSON.stringify(sourceJsonNoFiles, null, 2) + '\n')
    const newHash = crypto.createHash('sha256').update(fs.readFileSync(sourceJsonNoFilesPath)).digest('hex')
    const manifestUpdatedLines = fs
      .readFileSync(path.join(newSnapshotDir, 'MANIFEST.sha256'), 'utf8')
      .split('\n')
      .map((l) => (l.endsWith('  SOURCE.json') ? `${newHash}  SOURCE.json` : l))
    fs.writeFileSync(path.join(newSnapshotDir, 'MANIFEST.sha256'), manifestUpdatedLines.join('\n') + '\n')

    const vWithoutFiles = verifySnapshot(newSnapshotDir, { exportFiles: newExportFiles })
    assert.equal(vWithoutFiles.ok, true, '即使 SOURCE.json 無 files 欄，只要 MANIFEST 一致，verifySnapshot 仍為 ok')
  })

  test('verifySnapshot 的 ok 不准含 sourceNew：目標乾淨、來源多一檔 ⇒ verifySnapshot(...).ok === true 且 sourceNew 含該檔', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-sourcenew-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const newFile = 'new-source-file.mjs'
    const v = verifySnapshot(snapshotDir, {
      exportFiles: [...EXPORT_FILES, newFile],
    })

    assert.equal(v.ok, true, '目標乾淨、來源多一檔時 verifySnapshot ok 應為 true')
    assert.deepEqual(v.missing, [])
    assert.deepEqual(v.changed, [])
    assert.deepEqual(v.extra, [])
    assert.deepEqual(v.unlisted, [])
    assert.deepEqual(v.malformed, [])
    assert.deepEqual(v.duplicate, [])
    assert.ok(v.sourceNew.includes(newFile), `sourceNew 應包含該新檔，實際：${JSON.stringify(v.sourceNew)}`)
  })

  test('SOURCE.json 壞掉不准吞：寫壞 JSON ⇒ export 拒絕且訊息含 SOURCE.json；files 存在但非字串陣列 ⇒ 歸入 malformed', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-bad-source-json-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const sourceJsonPath = path.join(snapshotDir, 'SOURCE.json')

    // 1. 寫壞 JSON
    fs.writeFileSync(sourceJsonPath, '{"broken": json\n')

    const v1 = verifySnapshot(snapshotDir)
    assert.equal(v1.ok, false)
    assert.ok(v1.malformed.includes('SOURCE.json'), `malformed 應包含 SOURCE.json，實際：${JSON.stringify(v1.malformed)}`)

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
    assert.match(errs.join('\n'), /SOURCE\.json/)
    assert.match(errs.join('\n'), /malformed/)

    // 2. files 存在但不是字串陣列 ⇒ malformed
    fs.writeFileSync(sourceJsonPath, JSON.stringify({ version: '1', files: [123, null] }, null, 2) + '\n')
    const v2 = verifySnapshot(snapshotDir)
    assert.equal(v2.ok, false)
    assert.ok(v2.malformed.includes('SOURCE.json'), `files 包含非字串時應歸入 malformed，實際：${JSON.stringify(v2.malformed)}`)
  })

  test('舊快照沒有 files 欄 ⇒ 保守判 missing：來源新檔 ⇒ 拒絕；--force ⇒ 成功且新 SOURCE.json 有 files', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-legacy-source-json-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const sourceJsonPath = path.join(snapshotDir, 'SOURCE.json')

    // 拿掉 files 欄位模擬舊版快照，更新 MANIFEST.sha256 讓快照無其他漂移
    const oldSourceJson = {
      version: '1',
      sourceCommit: 'abcdef0123456789',
      sourceDirty: false,
      exportedAt: new Date().toISOString(),
    }
    fs.writeFileSync(sourceJsonPath, JSON.stringify(oldSourceJson, null, 2) + '\n')
    const oldHash = crypto.createHash('sha256').update(fs.readFileSync(sourceJsonPath)).digest('hex')
    const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')
    const lines = fs
      .readFileSync(manifestPath, 'utf8')
      .split('\n')
      .map((l) => (l.endsWith('  SOURCE.json') ? `${oldHash}  SOURCE.json` : l))
    fs.writeFileSync(manifestPath, lines.join('\n') + '\n')

    // 來源增加新檔
    const newFile = 'new-file-for-legacy.mjs'
    fs.writeFileSync(path.join(sourceDir, newFile), '// legacy test\n')
    const newExportFiles = [...EXPORT_FILES, newFile]

    // verifySnapshot 檢查：missing 與 legacyNoFiles 包含該新檔
    const v = verifySnapshot(snapshotDir, { exportFiles: newExportFiles })
    assert.equal(v.ok, false)
    assert.ok(v.missing.includes(newFile), `舊快照無 files 欄時來源新檔應判為 missing`)
    assert.ok(v.legacyNoFiles.includes(newFile), `legacyNoFiles 應包含該新檔`)

    // exportTo 不帶 --force ⇒ 拒絕且印出保守判 missing 訊息
    const errs = []
    const origErr = console.error
    console.error = (m) => errs.push(String(m))
    let resNoForce
    try {
      resNoForce = exportTo(sourceDir, targetRoot, {
        force: false,
        exportFiles: newExportFiles,
        deps: { git: fakeGit },
      })
    } finally {
      console.error = origErr
    }

    assert.equal(resNoForce.ok, false)
    assert.equal(resNoForce.status, 2)
    const errText = errs.join('\n')
    assert.match(errText, /舊版快照沒有 files 欄，無法分辨來源新增與目標刪檔；確認目標未手刪後用 --force 一次性升級/)
    assert.ok(errText.includes(newFile))

    // 帶 --force ⇒ 成功且新 SOURCE.json 有 files 欄
    const resForce = exportTo(sourceDir, targetRoot, {
      force: true,
      exportFiles: newExportFiles,
      deps: { git: fakeGit },
    })
    assert.equal(resForce.ok, true)
    assert.equal(resForce.status, 0)

    const updatedSourceJson = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'))
    assert.ok(Array.isArray(updatedSourceJson.files), '新 SOURCE.json 應有 files 陣列')
    assert.deepEqual(updatedSourceJson.files, newExportFiles)
    assert.ok(updatedSourceJson.files.includes(newFile))
  })

  test('C1g-a: 老式快照（SOURCE.json 無 files、manifest 的 SOURCE.json 雜湊一致）刪 ticket.test.mjs 與 manifest 行 ⇒ verifySnapshot(dir) ok===false 且 missing 含 ticket.test.mjs', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-c1g-a-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const sourceJsonPath = path.join(snapshotDir, 'SOURCE.json')
    const oldSourceJson = {
      version: '1',
      sourceCommit: 'abcdef0123456789',
      sourceDirty: false,
      exportedAt: new Date().toISOString(),
    }
    fs.writeFileSync(sourceJsonPath, JSON.stringify(oldSourceJson, null, 2) + '\n')
    const oldHash = crypto.createHash('sha256').update(fs.readFileSync(sourceJsonPath)).digest('hex')
    const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')

    // 刪 ticket.test.mjs 與其 manifest 行，同時更新 SOURCE.json 的 hash 保持一致
    const deleteFile = 'ticket.test.mjs'
    fs.unlinkSync(path.join(snapshotDir, deleteFile))

    const lines = fs
      .readFileSync(manifestPath, 'utf8')
      .split('\n')
      .filter((l) => !l.includes(deleteFile))
      .map((l) => (l.endsWith('  SOURCE.json') ? `${oldHash}  SOURCE.json` : l))
    fs.writeFileSync(manifestPath, lines.join('\n') + '\n')

    // 驗證：不帶 options，verifySnapshot 仍應回報 ok === false 且 missing 含 ticket.test.mjs
    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.missing.includes(deleteFile), `missing 應包含 ${deleteFile}，實際：${JSON.stringify(v.missing)}`)
  })

  test('C1g-b: 新式快照（SOURCE.json 含 files）刪 ticket.test.mjs 與 manifest 行 ⇒ verifySnapshot(dir) ok===false 且 missing 含 ticket.test.mjs', () => {
    const sourceDir = makeSourceDir()
    const targetRoot = tmpdir('target-repo-c1g-b-')
    exportTo(sourceDir, targetRoot, { deps: { git: fakeGit } })

    const snapshotDir = path.join(targetRoot, '.agents', 'skills', 'llm-team')
    const deleteFile = 'ticket.test.mjs'
    fs.unlinkSync(path.join(snapshotDir, deleteFile))

    const manifestPath = path.join(snapshotDir, 'MANIFEST.sha256')
    const lines = fs
      .readFileSync(manifestPath, 'utf8')
      .split('\n')
      .filter((l) => !l.includes(deleteFile))
    fs.writeFileSync(manifestPath, lines.join('\n') + '\n')

    // 驗證：不帶 options，verifySnapshot 仍應回報 ok === false 且 missing 含 ticket.test.mjs
    const v = verifySnapshot(snapshotDir)
    assert.equal(v.ok, false)
    assert.ok(v.missing.includes(deleteFile), `missing 應包含 ${deleteFile}，實際：${JSON.stringify(v.missing)}`)
    assert.ok(v.manuallyDeleted.includes(deleteFile), `manuallyDeleted 應包含 ${deleteFile}`)
  })

  test('C1g-c: 乾淨快照（新式有 files／老式無 files 各一）不帶 options ⇒ verifySnapshot(dir) ok===true', () => {
    // 1. 新式乾淨快照（含 files）
    const sourceDir1 = makeSourceDir()
    const targetRoot1 = tmpdir('target-repo-c1g-c-new-')
    exportTo(sourceDir1, targetRoot1, { deps: { git: fakeGit } })

    const snapshotDir1 = path.join(targetRoot1, '.agents', 'skills', 'llm-team')
    const vNew = verifySnapshot(snapshotDir1)
    assert.equal(vNew.ok, true, '新式乾淨快照 verifySnapshot 應為 ok')
    assert.deepEqual(vNew.missing, [])
    assert.deepEqual(vNew.changed, [])
    assert.deepEqual(vNew.extra, [])

    // 2. 老式乾淨快照（無 files，但 manifest 的 SOURCE.json hash 一致）
    const sourceDir2 = makeSourceDir()
    const targetRoot2 = tmpdir('target-repo-c1g-c-old-')
    exportTo(sourceDir2, targetRoot2, { deps: { git: fakeGit } })

    const snapshotDir2 = path.join(targetRoot2, '.agents', 'skills', 'llm-team')
    const sourceJsonPath2 = path.join(snapshotDir2, 'SOURCE.json')
    const oldSourceJson = {
      version: '1',
      sourceCommit: 'abcdef0123456789',
      sourceDirty: false,
      exportedAt: new Date().toISOString(),
    }
    fs.writeFileSync(sourceJsonPath2, JSON.stringify(oldSourceJson, null, 2) + '\n')
    const oldHash = crypto.createHash('sha256').update(fs.readFileSync(sourceJsonPath2)).digest('hex')
    const manifestPath2 = path.join(snapshotDir2, 'MANIFEST.sha256')
    const lines2 = fs
      .readFileSync(manifestPath2, 'utf8')
      .split('\n')
      .map((l) => (l.endsWith('  SOURCE.json') ? `${oldHash}  SOURCE.json` : l))
    fs.writeFileSync(manifestPath2, lines2.join('\n') + '\n')

    const vOld = verifySnapshot(snapshotDir2)
    assert.equal(vOld.ok, true, '老式乾淨快照 verifySnapshot 應為 ok')
    assert.deepEqual(vOld.missing, [])
    assert.deepEqual(vOld.changed, [])
    assert.deepEqual(vOld.extra, [])
  })
})

