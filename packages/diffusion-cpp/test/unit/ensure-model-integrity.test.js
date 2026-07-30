'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const {
  ensureModel,
  verifyLocalModelPath,
  verifyModelFile,
  verifyModelFileOnce,
  sha256File,
  resetVerificationCache,
  loadManifest,
  getDownloadCount,
  resetDownloadCount
} = require('../integration/utils.js')

const GOOD = 'qvac-integrity-fixture-GOOD-content-0123456789'
const BAD_SAME_LEN = 'qvac-integrity-fixture-BADD-content-0123456789'
const BAD_SHORT = 'too-short'

function mkTmpDir() {
  const base = (typeof os.tmpdir === 'function' && os.tmpdir()) || '/tmp'
  const dir = path.join(base, `qvac-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeModel(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), content)
}

// Returns a fake downloader that writes `content` to dest and records calls.
function fakeDownloader(content, spy) {
  return async function (_urls, dest) {
    spy.calls++
    fs.writeFileSync(dest, content)
  }
}

async function buildManifest(modelName) {
  // Compute the real sha256 of GOOD via the same helper the code uses, so the
  // manifest's pinned value is authoritative and the test exercises the real
  // hashing path.
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
  const name = 'model.bin'
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

test('correct cached file verifies and performs NO download', async function (t) {
  const name = 'model.bin'
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
    t.is(spy.calls, 0, 'no download attempted for a valid cached file')
    t.is(getDownloadCount(), 0, 'download counter stays at 0 on a warm run')
    t.is(resolvedDir, dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('poisoned cached file (sha mismatch) is deleted and re-downloaded', async function (t) {
  const name = 'model.bin'
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
      download: fakeDownloader(GOOD, spy) // "server" serves the good bytes
    })
    t.is(spy.calls, 1, 're-downloaded exactly once after integrity failure')
    t.is(getDownloadCount(), 1, 'download counter incremented')
    const after = fs.readFileSync(path.join(dir, name), 'utf8')
    t.is(after, GOOD, 'file replaced with the correct content')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('partial/truncated cached file (size mismatch) is re-downloaded', async function (t) {
  const name = 'model.bin'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SHORT)
    resetDownloadCount()
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

test('persistent mismatch (server keeps serving bad bytes) hard-fails', async function (t) {
  const name = 'model.bin'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SAME_LEN)
    resetDownloadCount()
    await t.exception(
      ensureModel({
        modelName: name,
        modelDir: dir,
        manifest,
        download: fakeDownloader(BAD_SAME_LEN, spy) // never serves good bytes
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
  const name = 'model.bin'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    resetDownloadCount()
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

test('manifest-declared local model paths must pass integrity', async function (t) {
  const name = 'model.bin'
  const { manifest } = await buildManifest(name)
  const dir = mkTmpDir()
  try {
    const modelPath = path.join(dir, name)
    writeModel(dir, name, GOOD)
    t.is(
      await verifyLocalModelPath({ modelName: name, filePath: modelPath, manifest }),
      modelPath,
      'valid local file is accepted'
    )

    fs.writeFileSync(modelPath, BAD_SAME_LEN)
    resetVerificationCache()
    await t.exception(
      verifyLocalModelPath({ modelName: name, filePath: modelPath, manifest }),
      /local file failed integrity/
    )
  } finally {
    resetVerificationCache()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('entry without pinned integrity is rejected before a cached file is used', async function (t) {
  const name = 'unpinned.bin'
  const manifest = {
    models: { [name]: { urls: ['https://example.invalid/x'], sha256: null, bytes: null } }
  }
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SAME_LEN)
    resetDownloadCount()
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

test('missing manifest model is rejected instead of using a caller URL', async function (t) {
  const dir = mkTmpDir()
  try {
    await t.exception(
      ensureModel({
        modelName: 'missing.gguf',
        downloadUrl: 'https://example.invalid/mutable.gguf',
        modelDir: dir,
        manifest: { models: {} }
      }),
      /missing from required models\.manifest\.json/
    )
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
  const name = 'model.bin'
  const { sha256 } = await buildManifest(name)
  const dir = mkTmpDir()
  try {
    const p = path.join(dir, name)
    fs.writeFileSync(p, BAD_SHORT)
    const res = await verifyModelFile(p, { sha256, bytes: GOOD.length })
    t.absent(res.ok)
    t.ok(/size/.test(res.reason), 'reason mentions size mismatch')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('integration manifest pins integrity for every model', function (t) {
  const manifestPath = path.resolve(__dirname, '../integration/models.manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  t.is(
    Object.keys(manifest).sort().join(','),
    'cacheEpoch,models',
    'top level contains only cache-key-bearing fields'
  )
  t.ok(Number.isInteger(manifest.cacheEpoch) && manifest.cacheEpoch > 0, 'cacheEpoch is positive')

  for (const [name, entry] of Object.entries(manifest.models)) {
    t.is(
      Object.keys(entry).sort().join(','),
      'bytes,group,sha256,urls',
      `${name} contains only cache-key-bearing fields`
    )
    const hasImmutableUrls =
      Array.isArray(entry.urls) &&
      entry.urls.length > 0 &&
      entry.urls.every(
        (url) =>
          /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//i.test(url) ||
          /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\//i.test(url)
      )
    const hasBytes = Number.isInteger(entry.bytes) && entry.bytes > 0
    const hasSha = typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256)
    const hasGroup = ['base', 'ideogram', 'ltx', 'wan22'].includes(entry.group)
    t.ok(hasImmutableUrls, `${name} uses immutable source URLs`)
    t.ok(hasBytes, `${name} pins bytes`)
    t.ok(hasSha, `${name} pins sha256`)
    t.ok(hasGroup, `${name} declares a supported cache group`)
    t.ok(
      entry.sourceSha256 === undefined && entry.sourceBytes === undefined,
      `${name} carries no source-mismatch exception`
    )
  }
  t.ok(
    !Object.prototype.hasOwnProperty.call(manifest.models, 'stable-diffusion-v2-1-Q4_0.gguf'),
    'the unauditable gpustack SD2.1 Q4_0 fixture has been removed'
  )
})

test('Ideogram test and download script use the manifest sources', function (t) {
  const packageDir = path.resolve(__dirname, '../..')
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'test/integration/models.manifest.json'), 'utf8')
  )
  const testSource = fs.readFileSync(
    path.join(packageDir, 'test/integration/generate-image-ideogram.test.js'),
    'utf8'
  )
  const specPattern = /name:\s*'([^']+)',\s*url:\s*'([^']+)'/g
  let specCount = 0
  let match
  while ((match = specPattern.exec(testSource)) !== null) {
    specCount++
    t.ok(
      manifest.models[match[1]] && manifest.models[match[1]].urls.includes(match[2]),
      `${match[1]} test spec uses its manifest URL`
    )
  }
  t.is(specCount, 4, 'all four Ideogram test model specs were checked')

  const scriptSource = fs.readFileSync(
    path.join(packageDir, 'scripts/download-model-ideogram.sh'),
    'utf8'
  )
  const downloadPattern = /dl "\$HF([^"]+)"\s+"\$OUT\/([^"]+)"/g
  let downloadCount = 0
  while ((match = downloadPattern.exec(scriptSource)) !== null) {
    downloadCount++
    const url = `https://huggingface.co${match[1]}`
    t.ok(
      manifest.models[match[2]] && manifest.models[match[2]].urls.includes(url),
      `${match[2]} download uses its manifest URL`
    )
  }
  t.is(downloadCount, 4, 'all four Ideogram script downloads were checked')
})

test('integration manifest covers every declared integration model', function (t) {
  const integrationDir = path.resolve(__dirname, '../integration')
  const manifest = JSON.parse(
    fs.readFileSync(path.join(integrationDir, 'models.manifest.json'), 'utf8')
  )
  const modelNames = new Set()
  const modelPattern = /name:\s*['"]([^'"]+\.(?:gguf|safetensors|pth))['"]/g

  for (const file of fs.readdirSync(integrationDir)) {
    if (!file.endsWith('.test.js')) continue
    const source = fs.readFileSync(path.join(integrationDir, file), 'utf8')
    let match
    while ((match = modelPattern.exec(source)) !== null) modelNames.add(match[1])
  }

  t.ok(modelNames.size > 0, 'found integration model declarations')
  for (const name of modelNames) {
    t.ok(manifest.models[name], `${name} is represented in models.manifest.json`)
  }
})
