'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const {
  binding,
  TranscriptionParakeet,
  setupJsLogger,
  isMobile
} = require('./helpers.js')

function makeTempDir (label) {
  const root = isMobile
    ? path.join(global.testDir || os.tmpdir(), '.parakeet-test-' + label)
    : path.join(os.tmpdir(), '.parakeet-test-' + label)
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
  return root
}

function cleanupDir (dirPath) {
  if (!fs.existsSync(dirPath)) return
  try {
    fs.rmSync(dirPath, { recursive: true, force: true })
  } catch (e) { /* ignore */ }
}

function writeBadGguf (dir, contents) {
  const p = path.join(dir, 'corrupted.gguf')
  fs.writeFileSync(p, contents)
  return p
}

async function expectLoadError (t, ggufPath) {
  const loggerBinding = setupJsLogger(binding)
  let threw = false
  let errorMessage = ''
  const model = new TranscriptionParakeet({
    files: { model: ggufPath },
    config: { parakeetConfig: { maxThreads: 4, useGPU: false } }
  })
  try {
    await model.load()
  } catch (error) {
    threw = true
    errorMessage = error?.message || String(error)
  } finally {
    try { await model.unload() } catch (e) { /* ignore */ }
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
  t.ok(threw, `load() should reject for corrupted GGUF (got "${errorMessage}")`)
}

test('Corrupted GGUF (junk bytes) should reject load()', { timeout: 60000 }, async (t) => {
  const dir = makeTempDir('corrupted-models')
  try {
    const gguf = writeBadGguf(dir,
      'This is not a valid GGUF file -- the magic number GGUF should be at offset 0')
    await expectLoadError(t, gguf)
  } finally {
    cleanupDir(dir)
  }
})

test('Empty GGUF should reject load()', { timeout: 60000 }, async (t) => {
  const dir = makeTempDir('empty-models')
  try {
    const gguf = writeBadGguf(dir, '')
    await expectLoadError(t, gguf)
  } finally {
    cleanupDir(dir)
  }
})

test('Truncated GGUF (correct magic, no data) should reject load()', { timeout: 60000 }, async (t) => {
  const dir = makeTempDir('truncated-models')
  try {
    const truncated = Buffer.from([
      0x47, 0x47, 0x55, 0x46, // "GGUF" magic
      0x03, 0x00, 0x00, 0x00, // version=3 (little-endian uint32)
      0xFF, 0xFF, 0xFF, 0xFF, // garbage tensor count
      0xFF, 0xFF, 0xFF, 0xFF
    ])
    const gguf = writeBadGguf(dir, truncated)
    await expectLoadError(t, gguf)
  } finally {
    cleanupDir(dir)
  }
})
