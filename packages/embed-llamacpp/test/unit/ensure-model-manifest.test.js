'use strict'

// Offline proof for the models.manifest.json wiring (QVAC-21937): ensureModel
// resolves URLs + integrity from the manifest, re-downloads poisoned/truncated
// caches, falls back to MODEL_CONFIGS when the manifest lacks an entry, and the
// real integration manifest is well-formed. No network and no native addon are
// touched — downloads are injected.

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const {
  ensureModel,
  verifyModelFile,
  sha256File,
  loadManifest,
  resolveModelEntry,
  getDownloadCount,
  resetDownloadCount,
  MODEL_CONFIGS
} = require('../integration/utils.js')

const GOOD = 'qvac-integrity-fixture-GOOD-content-0123456789'
const BAD_SAME_LEN = 'qvac-integrity-fixture-BADD-content-0123456789'
const BAD_SHORT = 'too-short'

function mkTmpDir () {
  const base = (typeof os.tmpdir === 'function' && os.tmpdir()) || '/tmp'
  const dir = path.join(base, `qvac-embed-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeModel (dir, name, content) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), content)
}

function fakeDownloader (content, spy) {
  return async function (_urls, dest) {
    spy.calls++
    fs.writeFileSync(dest, content)
  }
}

async function buildManifest (modelName) {
  const dir = mkTmpDir()
  const p = path.join(dir, '_probe')
  fs.writeFileSync(p, GOOD)
  const sha256 = await sha256File(p)
  fs.rmSync(dir, { recursive: true, force: true })
  return {
    sha256,
    manifest: {
      models: {
        [modelName]: { urls: ['https://example.invalid/model'], sha256, bytes: GOOD.length }
      }
    }
  }
}

test('bare-crypto sha256 is available in this runtime', async function (t) {
  const dir = mkTmpDir()
  try {
    const p = path.join(dir, 'x')
    fs.writeFileSync(p, GOOD)
    const sha = await sha256File(p)
    t.ok(sha && sha.length === 64, 'sha256File returns a 64-char hex digest')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('correct cached file verifies and performs NO download', async function (t) {
  const name = 'gte-large_fp16.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, GOOD)
    resetDownloadCount()
    const [, resolvedDir] = await ensureModel(name, { modelDir: dir, manifest, download: fakeDownloader(GOOD, spy) })
    t.is(spy.calls, 0, 'no download for a valid cached file')
    t.is(getDownloadCount(), 0, 'download counter stays 0 on a warm run')
    t.is(resolvedDir, dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('poisoned cached file (sha mismatch) is deleted and re-downloaded', async function (t) {
  const name = 'gte-large_fp16.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SAME_LEN)
    resetDownloadCount()
    await ensureModel(name, { modelDir: dir, manifest, download: fakeDownloader(GOOD, spy) })
    t.is(spy.calls, 1, 're-downloaded exactly once after integrity failure')
    t.is(getDownloadCount(), 1, 'download counter incremented')
    t.is(fs.readFileSync(path.join(dir, name), 'utf8'), GOOD)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('truncated cached file (size mismatch) is re-downloaded', async function (t) {
  const name = 'gte-large_fp16.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SHORT)
    await ensureModel(name, { modelDir: dir, manifest, download: fakeDownloader(GOOD, spy) })
    t.is(spy.calls, 1, 'size mismatch triggered a re-download')
    t.is(fs.readFileSync(path.join(dir, name), 'utf8'), GOOD)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('persistent mismatch hard-fails and removes the bad file', async function (t) {
  const name = 'gte-large_fp16.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SAME_LEN)
    await t.exception(
      ensureModel(name, { modelDir: dir, manifest, download: fakeDownloader(BAD_SAME_LEN, spy) }),
      /failed integrity/
    )
    t.is(spy.calls, 1, 'attempted a re-download before failing')
    t.absent(fs.existsSync(path.join(dir, name)), 'bad file removed, not left in place')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('missing file downloads then verifies', async function (t) {
  const name = 'gte-large_fp16.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    await ensureModel(name, { modelDir: dir, manifest, download: fakeDownloader(GOOD, spy) })
    t.is(spy.calls, 1, 'downloaded the missing file')
    t.is(fs.readFileSync(path.join(dir, name), 'utf8'), GOOD)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('MODEL_CONFIGS is used as a fallback when the manifest has no entry', async function (t) {
  const name = 'gte-large_fp16.gguf' // known in MODEL_CONFIGS
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    t.ok(MODEL_CONFIGS[name], 'model is declared in MODEL_CONFIGS')
    await ensureModel(name, { modelDir: dir, manifest: { models: {} }, download: fakeDownloader(GOOD, spy) })
    t.is(spy.calls, 1, 'downloaded via the MODEL_CONFIGS fallback url')
    t.is(fs.readFileSync(path.join(dir, name), 'utf8'), GOOD)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('truly unknown model (no config, no manifest entry) throws', async function (t) {
  const dir = mkTmpDir()
  try {
    await t.exception(
      ensureModel('nope.gguf', { modelDir: dir, manifest: { models: {} } }),
      /Unknown model/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyModelFile flags size before hashing (fail-fast)', async function (t) {
  const { sha256 } = await buildManifest('probe')
  const dir = mkTmpDir()
  try {
    const p = path.join(dir, 'model.gguf')
    fs.writeFileSync(p, BAD_SHORT)
    const res = await verifyModelFile(p, { sha256, bytes: GOOD.length })
    t.absent(res.ok)
    t.ok(/size/.test(res.reason), 'reason mentions size mismatch')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real integration manifest is well-formed and matches MODEL_CONFIGS', function (t) {
  const manifest = loadManifest()
  t.ok(manifest && manifest.models, 'models.manifest.json loads')
  const names = Object.keys(manifest.models)
  t.is(new Set(names).size, names.length, 'no duplicate model keys')
  for (const [name, entry] of Object.entries(manifest.models)) {
    const hasUrl = Array.isArray(entry.urls) && entry.urls.length > 0 &&
      entry.urls.every(u => typeof u === 'string' && u.startsWith('https://'))
    t.ok(hasUrl, `${name} has at least one https url`)
  }
  // Every MODEL_CONFIGS model must be represented in the manifest so warm covers it.
  for (const name of Object.keys(MODEL_CONFIGS)) {
    t.ok(resolveModelEntry(name), `${name} present in manifest`)
  }
})
