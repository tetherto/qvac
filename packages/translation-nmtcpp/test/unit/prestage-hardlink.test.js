'use strict'

// Pre-staged models must be hardlinked, never byte-copied: iOS kills an app
// that dirties more than 4 GiB in 24h, and the gemma shard's 4.45 GB of copying
// tripped it mid-test ("0 tests executed"). nlink/ino are the direct proof that
// no bytes were written; the EXDEV case pins Android's fallback copy.

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const { linkOrCopySync } = require('../integration/utils.js')

const CONTENT = 'qvac-prestage-fixture-content-0123456789'

function mkTmpDir() {
  const base = (typeof os.tmpdir === 'function' && os.tmpdir()) || '/tmp'
  const dir = path.join(
    base,
    `qvac-nmt-prestage-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function exdev() {
  return function () {
    const err = new Error('cross-device link not permitted')
    err.code = 'EXDEV'
    throw err
  }
}

test('staged model is hardlinked, not copied, when it can be', function (t) {
  const stagedDir = mkTmpDir()
  const modelDir = mkTmpDir()
  const src = path.join(stagedDir, 'model.bin')
  const dest = path.join(modelDir, 'model.bin')
  try {
    fs.writeFileSync(src, CONTENT)

    t.is(linkOrCopySync({ src, dest }), 'link', 'same-filesystem staging hardlinks')

    const srcStat = fs.statSync(src)
    const destStat = fs.statSync(dest)
    t.is(destStat.ino, srcStat.ino, 'destination is the same inode — zero bytes written')
    t.is(destStat.dev, srcStat.dev)
    t.is(srcStat.nlink, 2, 'staged file now has two links')
    t.is(fs.readFileSync(dest, 'utf8'), CONTENT)
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true })
    fs.rmSync(modelDir, { recursive: true, force: true })
  }
})

test('an existing destination is replaced rather than failing EEXIST', function (t) {
  const stagedDir = mkTmpDir()
  const modelDir = mkTmpDir()
  const src = path.join(stagedDir, 'model.bin')
  const dest = path.join(modelDir, 'model.bin')
  try {
    fs.writeFileSync(src, CONTENT)
    fs.writeFileSync(dest, 'stale-partial-download')

    t.is(linkOrCopySync({ src, dest }), 'link')
    t.is(fs.statSync(dest).ino, fs.statSync(src).ino)
    t.is(fs.readFileSync(dest, 'utf8'), CONTENT, 'stale destination is gone')
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true })
    fs.rmSync(modelDir, { recursive: true, force: true })
  }
})

test('falls back to a byte copy when hardlinking is impossible (Android EXDEV)', function (t) {
  const stagedDir = mkTmpDir()
  const modelDir = mkTmpDir()
  const src = path.join(stagedDir, 'model.bin')
  const dest = path.join(modelDir, 'model.bin')
  try {
    fs.writeFileSync(src, CONTENT)

    t.is(linkOrCopySync({ src, dest, link: exdev() }), 'copy', 'EXDEV falls back to a copy')
    t.not(fs.statSync(dest).ino, fs.statSync(src).ino, 'copy is a distinct inode')
    t.is(fs.readFileSync(dest, 'utf8'), CONTENT, 'copied bytes are intact')
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true })
    fs.rmSync(modelDir, { recursive: true, force: true })
  }
})
