'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const {
  ensureModel,
  verifyModelFile,
  sha256File,
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

test('entry without pinned integrity skips verification (keeps a non-zero cached file)', async function (t) {
  const name = 'unpinned.bin'
  const manifest = {
    models: { [name]: { urls: ['https://example.invalid/x'], sha256: null, bytes: null } }
  }
  const dir = mkTmpDir()
  const spy = { calls: 0 }
  try {
    writeModel(dir, name, BAD_SAME_LEN) // any non-zero content is accepted when unpinned
    resetDownloadCount()
    await ensureModel({
      modelName: name,
      modelDir: dir,
      manifest,
      download: fakeDownloader(GOOD, spy)
    })
    t.is(spy.calls, 0, 'no download when an unpinned file already exists and is non-zero')
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

  for (const [name, entry] of Object.entries(manifest.models)) {
    const hasBytes = Number.isInteger(entry.bytes) && entry.bytes > 0
    const hasSha = typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256)
    t.ok(hasBytes || hasSha, `${name} pins bytes or sha256`)
  }
})
