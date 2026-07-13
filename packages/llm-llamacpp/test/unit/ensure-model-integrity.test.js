'use strict'

// Offline integrity/manifest proof for llm-llamacpp, mirroring
// diffusion-cpp/test/unit/ensure-model-integrity.test.js: ensureModel resolves
// URL + sha256/bytes from models.manifest.json, re-downloads poisoned/truncated
// caches, requires fully pinned entries, and the real manifest is well-formed.
// No network and no native addon are touched — downloads are injected.

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const {
  ensureModel,
  verifyModelFile,
  verifyModelFileOnce,
  sha256File,
  resetVerificationCache,
  copyPrestagedModel,
  loadManifest,
  resolveModelEntry,
  getDownloadCount,
  resetDownloadCount
} = require('../integration/utils.js')
const { matrix, modelFileName } = require('../integration/_benchmark-matrix.js')

const GOOD = 'qvac-integrity-fixture-GOOD-content-0123456789'
const BAD_SAME_LEN = 'qvac-integrity-fixture-BADD-content-0123456789'
const BAD_SHORT = 'too-short'

function mkTmpDir() {
  const base = (typeof os.tmpdir === 'function' && os.tmpdir()) || '/tmp'
  const dir = path.join(
    base,
    `qvac-llm-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeModel(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), content)
}

function fakeDownloader(content, spy) {
  return async function (_urls, dest) {
    spy.calls++
    fs.writeFileSync(dest, content)
  }
}

async function buildManifest(modelName) {
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

test('pinned sha256 verification fails closed when hashing cannot complete', async function (t) {
  const dir = mkTmpDir()
  try {
    const p = path.join(dir, 'x')
    fs.writeFileSync(p, GOOD)
    const entry = { sha256: '0'.repeat(64), bytes: GOOD.length }
    const missing = await verifyModelFile(p, entry, function () {
      return Promise.resolve(null)
    })
    t.absent(missing.ok, 'missing digest is a verification failure')
    const failed = await verifyModelFile(p, entry, function () {
      return Promise.reject(new Error('hash unavailable'))
    })
    t.absent(failed.ok, 'hashing error is a verification failure')
    t.ok(/hash unavailable/.test(failed.reason), 'hashing error is preserved')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('repeated verification hashes an unchanged model only once per process', async function (t) {
  const name = 'model.gguf'
  const { manifest, sha256 } = await buildManifest(name)
  const dir = mkTmpDir()
  const modelPath = path.join(dir, name)
  let hashes = 0
  try {
    writeModel(dir, name, GOOD)
    resetVerificationCache()
    const hashFile = async function () {
      hashes++
      return sha256
    }
    const first = await verifyModelFileOnce(modelPath, manifest.models[name], hashFile)
    const second = await verifyModelFileOnce(modelPath, manifest.models[name], hashFile)
    t.ok(first.ok)
    t.ok(second.ok)
    t.is(hashes, 1, 'unchanged file and pins reuse the verification result')
  } finally {
    resetVerificationCache()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pre-staged model is verified and removed on mismatch', async function (t) {
  const name = 'model.gguf'
  const { manifest } = await buildManifest(name)
  const stagedDir = mkTmpDir()
  const modelDir = mkTmpDir()
  const modelPath = path.join(modelDir, name)
  try {
    writeModel(stagedDir, name, BAD_SAME_LEN)
    await t.exception(
      copyPrestagedModel({
        stagedDir,
        modelName: name,
        modelPath,
        entry: manifest.models[name]
      }),
      /failed integrity/
    )
    t.absent(fs.existsSync(modelPath), 'mismatched pre-staged copy is removed')
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true })
    fs.rmSync(modelDir, { recursive: true, force: true })
  }
})

test('correct cached file verifies and performs NO download', async function (t) {
  const name = 'model.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, GOOD)
    resetDownloadCount()
    const [, resolvedDir] = await ensureModel({
      modelName: name,
      modelDir: dir,
      manifest,
      download: fakeDownloader(GOOD, spy)
    })
    t.is(spy.calls, 0, 'no download for a valid cached file')
    t.is(getDownloadCount(), 0, 'download counter stays 0 on a warm run')
    t.is(resolvedDir, dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('poisoned cached file (sha mismatch) is deleted and re-downloaded', async function (t) {
  const name = 'model.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SAME_LEN) // same length -> defeats size check, forces sha path
    resetDownloadCount()
    await ensureModel({
      modelName: name,
      modelDir: dir,
      manifest,
      download: fakeDownloader(GOOD, spy)
    })
    t.is(spy.calls, 1, 're-downloaded exactly once after integrity failure')
    t.is(getDownloadCount(), 1, 'download counter incremented')
    t.is(fs.readFileSync(path.join(dir, name), 'utf8'), GOOD, 'file replaced with correct content')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('truncated cached file (size mismatch) is re-downloaded', async function (t) {
  const name = 'model.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SHORT)
    await ensureModel({
      modelName: name,
      modelDir: dir,
      manifest,
      download: fakeDownloader(GOOD, spy)
    })
    t.is(spy.calls, 1, 'size mismatch triggered a re-download')
    t.is(fs.readFileSync(path.join(dir, name), 'utf8'), GOOD)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('persistent mismatch hard-fails and removes the bad file', async function (t) {
  const name = 'model.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SAME_LEN)
    await t.exception(
      ensureModel({
        modelName: name,
        modelDir: dir,
        manifest,
        download: fakeDownloader(BAD_SAME_LEN, spy)
      }),
      /failed integrity/
    )
    t.is(spy.calls, 1, 'attempted a re-download before failing')
    t.absent(fs.existsSync(path.join(dir, name)), 'bad file removed, not left in place')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('missing file downloads then verifies', async function (t) {
  const name = 'model.gguf'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    await ensureModel({
      modelName: name,
      modelDir: dir,
      manifest,
      download: fakeDownloader(GOOD, spy)
    })
    t.is(spy.calls, 1, 'downloaded the missing file')
    t.is(fs.readFileSync(path.join(dir, name), 'utf8'), GOOD)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('entry without pinned integrity is rejected before cache use', async function (t) {
  const name = 'unpinned.gguf'
  const manifest = {
    models: { [name]: { urls: ['https://example.invalid/x'], sha256: null, bytes: null } }
  }
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SAME_LEN)
    await t.exception(
      ensureModel({
        modelName: name,
        modelDir: dir,
        manifest,
        download: fakeDownloader(GOOD, spy)
      }),
      /no valid SHA-256 pin/
    )
    t.is(spy.calls, 0, 'invalid manifest fails before download or cache use')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('caller URL cannot bypass a missing manifest entry', async function (t) {
  const name = 'not-in-manifest.gguf'
  const manifest = { models: {} }
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    await t.exception(
      ensureModel({
        modelName: name,
        downloadUrl: 'https://example.invalid/fallback',
        modelDir: dir,
        manifest,
        download: fakeDownloader(GOOD, spy)
      }),
      /missing from required models\.manifest\.json/
    )
    t.is(spy.calls, 0, 'missing entry fails before fallback download')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('malformed manifest fails explicitly', function (t) {
  const dir = mkTmpDir()
  const manifestPath = path.join(dir, 'models.manifest.json')
  try {
    fs.writeFileSync(manifestPath, '{broken')
    t.exception(
      () => loadManifest(manifestPath),
      /Failed to load required model manifest/,
      'invalid JSON cannot disable integrity checks'
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

test('integration manifest is well-formed (usable url per entry, unique keys)', function (t) {
  const manifest = loadManifest()
  t.ok(manifest && manifest.models, 'models.manifest.json loads')
  t.is(
    Object.keys(manifest).sort().join(','),
    'cacheEpoch,models',
    'top level contains only cache-key-bearing fields'
  )
  t.ok(Number.isInteger(manifest.cacheEpoch) && manifest.cacheEpoch > 0, 'cacheEpoch is positive')
  const names = Object.keys(manifest.models)
  t.ok(names.length >= 20, `declares the expected model set (${names.length} entries)`)
  t.is(new Set(names).size, names.length, 'no duplicate model keys')

  for (const [name, entry] of Object.entries(manifest.models)) {
    const expectedKeys = entry.warm === undefined ? 'bytes,sha256,urls' : 'bytes,sha256,urls,warm'
    t.is(
      Object.keys(entry).sort().join(','),
      expectedKeys,
      `${name} contains only cache-key-bearing fields`
    )
    if (entry.warm !== undefined) {
      t.is(entry.warm, false, `${name} only declares warm when explicitly deferred`)
    }
    const hasUrl =
      Array.isArray(entry.urls) &&
      entry.urls.length > 0 &&
      entry.urls.every(
        (url) =>
          typeof url === 'string' &&
          /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//i.test(url)
      )
    t.ok(hasUrl, `${name} has at least one immutable Hugging Face URL`)
    t.ok(/^[0-9a-f]{64}$/i.test(entry.sha256), `${name} sha256 is pinned`)
    t.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, `${name} bytes is pinned`)
  }

  const normallyIntegratedBenchmarkModels = new Set([
    'Qwen3.5-0.8B-Q4_0.gguf',
    'Qwen3.5-0.8B-Q8_0.gguf'
  ])
  const benchmarkModelNames = [
    ...new Set(matrix().map((cell) => modelFileName(cell.size, cell.quant)))
  ]
  const expectedDeferred = benchmarkModelNames
    .filter((name) => !normallyIntegratedBenchmarkModels.has(name))
    .sort()
  const actualDeferred = benchmarkModelNames
    .filter((name) => manifest.models[name].warm === false)
    .sort()
  t.is(
    actualDeferred.join(','),
    expectedDeferred.join(','),
    'only benchmark-only models defer warming'
  )
  t.is(expectedDeferred.length, 8, 'eight benchmark-only models are deferred')
  for (const name of normallyIntegratedBenchmarkModels) {
    t.absent(manifest.models[name].warm, `${name} remains selected for ordinary desktop warming`)
  }

  // Spot-check a scattered model resolves by its LOCAL filename.
  const mmproj = resolveModelEntry('mmproj-Qwen3.5-0.8B-F16.gguf')
  t.ok(
    mmproj && mmproj.urls[0].endsWith('/mmproj-F16.gguf'),
    'local name maps to the shared remote basename'
  )
})
