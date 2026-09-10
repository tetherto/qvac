'use strict'

// Regression proof for the iOS pre-stage write-budget failure.
//
// iOS kills any app that dirties more than 4 GiB in a rolling 24h window
// ("dirtied N bytes over M sec, violating a disk writes limit of 4294967296
// bytes over 86400 seconds"). The mobile pre-stage path used to byte-copy each
// staged model into the writable model dir; on iOS the staged file is ALREADY
// in the app's own writable Documents dir, so that copy was pure waste — on
// llm's gemma shard (4.45 GB staged) it killed the app before a single test
// ran.
//
// These tests pin the fix: when source and destination share a filesystem the
// staged model is hardlinked (same inode => zero bytes written), and when it
// cannot be (Android: /data/local/tmp is a different filesystem from the app
// data dir) we still fall back to a correct byte copy.

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
    `qvac-ocr-prestage-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  const src = path.join(stagedDir, 'model.gguf')
  const dest = path.join(modelDir, 'model.gguf')
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
  const src = path.join(stagedDir, 'model.gguf')
  const dest = path.join(modelDir, 'model.gguf')
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
  const src = path.join(stagedDir, 'model.gguf')
  const dest = path.join(modelDir, 'model.gguf')
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
