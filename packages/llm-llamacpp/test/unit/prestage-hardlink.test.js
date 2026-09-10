'use strict'

// Pre-staged models must be hardlinked, never byte-copied: iOS kills an app
// that dirties more than 4 GiB in 24h, and the gemma shard's 4.45 GB of copying
// tripped it mid-test ("0 tests executed"). nlink/ino are the direct proof that
// no bytes were written; the EXDEV case pins Android's fallback copy.

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const {
  linkOrCopySync,
  copyPrestagedModel,
  sha256File,
  resetVerificationCache
} = require('../integration/utils.js')

const CONTENT = 'qvac-prestage-fixture-content-0123456789'

function mkTmpDir() {
  const base = (typeof os.tmpdir === 'function' && os.tmpdir()) || '/tmp'
  const dir = path.join(
    base,
    `qvac-llm-prestage-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

test('staged model is hardlinked, not copied, when it can be', async function (t) {
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

test('an existing destination is replaced rather than failing EEXIST', async function (t) {
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

test('falls back to a byte copy when hardlinking is impossible (Android EXDEV)', async function (t) {
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

test('copyPrestagedModel hardlinks and still verifies integrity', async function (t) {
  const stagedDir = mkTmpDir()
  const modelDir = mkTmpDir()
  const modelName = 'model.gguf'
  const src = path.join(stagedDir, modelName)
  const modelPath = path.join(modelDir, modelName)
  try {
    fs.writeFileSync(src, CONTENT)
    const entry = { sha256: await sha256File(src), bytes: fs.statSync(src).size }

    const how = await copyPrestagedModel({ stagedDir, modelName, modelPath, entry })

    t.is(how, 'link', 'pickup path writes no bytes on a same-filesystem stage')
    t.is(fs.statSync(modelPath).ino, fs.statSync(src).ino)
  } finally {
    resetVerificationCache()
    fs.rmSync(stagedDir, { recursive: true, force: true })
    fs.rmSync(modelDir, { recursive: true, force: true })
  }
})

test('a corrupt staged model is still rejected and unlinked', async function (t) {
  const stagedDir = mkTmpDir()
  const modelDir = mkTmpDir()
  const modelName = 'model.gguf'
  const src = path.join(stagedDir, modelName)
  const modelPath = path.join(modelDir, modelName)
  try {
    fs.writeFileSync(src, CONTENT)
    const entry = { sha256: await sha256File(src), bytes: fs.statSync(src).size }
    // Same length, different bytes: passes the size check, fails the digest.
    fs.writeFileSync(src, CONTENT.replace('fixture', 'FIXTURE'))

    await t.exception(
      copyPrestagedModel({ stagedDir, modelName, modelPath, entry }),
      /failed integrity/
    )
    t.absent(fs.existsSync(modelPath), 'rejected link is removed from modelDir')
    t.ok(fs.existsSync(src), 'unlinking the link leaves the staged file intact')
  } finally {
    resetVerificationCache()
    fs.rmSync(stagedDir, { recursive: true, force: true })
    fs.rmSync(modelDir, { recursive: true, force: true })
  }
})
