'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const env = require('bare-env')
const { assessFit } = require('../../index')
const { isMobile, TEST_TIMEOUT, resolveModelPath } = require('./utils')

// Models come from the same variables and fixtures as megaloc.test.js and
// bridgedepth.test.js. A model that is absent skips its test on desktop; on
// mobile copy-mobile-test-assets.js ships every model runFit uses, so an
// absent one fails instead of passing as a skip.
// QVAC_MEGALOC_BACKEND and QVAC_BRIDGEDEPTH_BACKEND pick the device; unset
// uses automatic selection, the placement an app gets by default.

// BridgeDepth sizes for the workload test: the fixture size and twice it.
const SMALL = { width: 200, height: 100 }
const LARGE = { width: 400, height: 200 }
// The default BridgeDepth workload, and a size above the box downsampled to
// exactly it, so the graph takes the same bytes.
const DEFAULT_WORKLOAD = { width: 1280, height: 720 }
const FULL_HD = { width: 1920, height: 1080 }
// Each input view is counted as packed RGB, one byte per channel.
const RGB_BYTES_PER_PIXEL = 3

// GGUF header layout (ggml docs/gguf.md): magic "GGUF" read as a little-endian
// uint32, uint32 version, uint64 tensor count, uint64 metadata count.
const GGUF_MAGIC = 0x46554747
const GGUF_VERSION = 3
const GGUF_HEADER_BYTES = 24

function asset(filename, modelEnv) {
  if (env[modelEnv]) return env[modelEnv]
  if (isMobile && global.assetPaths) {
    const suffix = filename + '.bin'
    for (const key of Object.keys(global.assetPaths)) {
      if (key.endsWith('/' + suffix)) return global.assetPaths[key].replace(/^file:\/\//, '')
    }
    throw new Error(`Mobile asset not found in global.assetPaths: ${suffix}`)
  }
  const local = path.join(__dirname, '..', 'fixtures', filename)
  return fs.existsSync(local) ? local : ''
}

function mobileNetPath() {
  const configured = env.QVAC_CLASSIFICATION_MODEL_PATH || resolveModelPath()
  return configured ? path.resolve(configured) : ''
}

const models = {
  mobilenet: mobileNetPath(),
  megaloc: asset('megaloc-f16.gguf', 'QVAC_MEGALOC_F16_MODEL_PATH'),
  bridgedepth: asset('bridgedepth-vits-f32.gguf', 'QVAC_BRIDGEDEPTH_MODEL_PATH')
}

function request(modelPath, backend, extra = {}) {
  return backend ? { modelPath, backend, ...extra } : { modelPath, ...extra }
}

// The selected device first and the host CPU last; a CPU load is one row.
function checkRows(t, fit, label) {
  t.comment(`${label}: ${JSON.stringify(fit)}`)
  t.alike(fit.stats, {}, `${label}: no stats`)
  if (isMobile) {
    t.ok(['fits', 'does-not-fit'].includes(fit.status), `${label}: a measured verdict`)
  } else {
    t.is(fit.status, 'fits', `${label}: fits on this host`)
  }
  const host = fit.devices[fit.devices.length - 1]
  t.is(host.name, 'CPU', `${label}: the host CPU row is last`)
  t.ok(host.unified, `${label}: the host row is unified`)
  t.is(fit.devices.length, fit.devices[0].name === 'CPU' ? 1 : 2, `${label}: row count`)
  for (const row of fit.devices) {
    t.alike(
      Object.keys(row).sort(),
      ['freeBytes', 'id', 'name', 'totalBytes', 'unified', 'usedBytes'],
      `${label}: ${row.name} row has exactly the contract fields`
    )
    for (const key of ['usedBytes', 'freeBytes', 'totalBytes']) {
      t.ok(Number.isSafeInteger(row[key]) && row[key] >= 0, `${label}: ${row.name} ${key}`)
    }
    t.ok(row.freeBytes > 0, `${label}: ${row.name} reports free memory`)
  }
  t.ok(fit.devices[0].usedBytes > 0, `${label}: the weights were measured`)
}

test('assessFit: MobileNet is one CPU row', { skip: !models.mobilenet }, async (t) => {
  t.timeout(TEST_TIMEOUT)
  // MobileNet always loads on the CPU, whatever backend is asked for.
  const fit = await assessFit({ modelPath: models.mobilenet, backend: 'MTL0' })
  checkRows(t, fit, 'MobileNet')
  t.is(fit.devices.length, 1, 'MobileNet: a CPU load is one row')

  const reserved = await assessFit({
    modelPath: models.mobilenet,
    marginBytes: Number.MAX_SAFE_INTEGER
  })
  t.is(reserved.status, 'does-not-fit', 'a margin larger than free memory leaves no room')
  t.is(reserved.devices.length, 1, 'the rows are kept with a does-not-fit')
})

test('assessFit: MegaLoc on the selected backend', { skip: !models.megaloc }, async (t) => {
  t.timeout(TEST_TIMEOUT)
  const backend = env.QVAC_MEGALOC_BACKEND
  const fit = await assessFit(request(models.megaloc, backend))
  checkRows(t, fit, `MegaLoc ${backend || 'auto'}`)
  if (backend === 'CPU') t.is(fit.devices.length, 1, 'a CPU load is one row')

  const cpu = await assessFit(request(models.megaloc, 'CPU'))
  const total = (fit) => fit.devices.reduce((sum, row) => sum + row.usedBytes, 0)
  t.ok(total(cpu) > 0, 'the CPU load was measured')
  const threads = await assessFit(request(models.megaloc, 'CPU', { threads: 1 }))
  t.ok(threads.devices[0].usedBytes <= cpu.devices[0].usedBytes, 'fewer threads need no more')
})

test('assessFit: BridgeDepth grows with the workload', { skip: !models.bridgedepth }, async (t) => {
  t.timeout(TEST_TIMEOUT)
  const backend = env.QVAC_BRIDGEDEPTH_BACKEND
  const label = `BridgeDepth ${backend || 'auto'}`
  const fit = await assessFit(request(models.bridgedepth, backend))
  checkRows(t, fit, `${label} default workload`)

  const small = await assessFit(request(models.bridgedepth, backend, { workload: SMALL }))
  const large = await assessFit(request(models.bridgedepth, backend, { workload: LARGE }))
  checkRows(t, small, `${label} ${SMALL.width}x${SMALL.height}`)
  checkRows(t, large, `${label} ${LARGE.width}x${LARGE.height}`)
  const total = (fit) => fit.devices.reduce((sum, row) => sum + row.usedBytes, 0)
  t.ok(total(large) > total(small), 'a larger input needs more memory')
  t.ok(total(fit) > total(large), 'the default 1280x720 needs more than 400x200')
  t.alike(
    small.devices.map((row) => row.name),
    large.devices.map((row) => row.name),
    'the workload does not change the placement'
  )

  const fullHd = await assessFit(request(models.bridgedepth, backend, { workload: FULL_HD }))
  checkRows(t, fullHd, `${label} ${FULL_HD.width}x${FULL_HD.height}`)
  if (fullHd.devices.length === 2) {
    t.is(fullHd.devices[0].usedBytes, fit.devices[0].usedBytes, 'the device sizes the 1280x720 run')
  }
  // The 1280x720 graph run stays the largest host phase at both sizes (the
  // phases are pinned in test/unit/footprint_test.cpp), so the host row adds
  // only the larger raw RGB copies of the two input views held through the job.
  const fullHdPixels = FULL_HD.width * FULL_HD.height
  const hdPixels = DEFAULT_WORKLOAD.width * DEFAULT_WORKLOAD.height
  t.is(
    fullHd.devices[fullHd.devices.length - 1].usedBytes,
    fit.devices[fit.devices.length - 1].usedBytes +
      2 * RGB_BYTES_PER_PIXEL * (fullHdPixels - hdPixels),
    'the host adds the larger input copies'
  )
})

test('assessFit rejects invalid requests and files that are not models', async (t) => {
  await t.exception.all(
    assessFit({ modelPath: 'weights/model.gguf' }),
    /modelPath must be an absolute path/
  )
  if (models.bridgedepth) {
    await t.exception.all(
      assessFit({ modelPath: models.bridgedepth, workload: { width: 0 } }),
      /workload.width must be a positive safe integer/
    )
    // One pixel past the 4096 side BridgeDepth inference accepts, which it rejects.
    await t.exception(
      assessFit({ modelPath: models.bridgedepth, workload: { width: 4097, height: 4096 } }),
      /BridgeDepth: image/
    )
  }
  const missing = path.join(path.dirname(models.mobilenet || __filename), 'missing-model.gguf')
  await t.exception(assessFit({ modelPath: missing }), /cannot read GGUF metadata/)
  if (isMobile) return
  // A file that is not a GGUF at all: this test's own source.
  await t.exception(assessFit({ modelPath: path.resolve(__filename) }), /cannot read GGUF metadata/)

  // A valid GGUF of no supported model: a version 3 header with no tensors
  // and no metadata. test/results is ignored by git.
  const results = path.resolve(__dirname, '..', 'results')
  fs.mkdirSync(results, { recursive: true })
  const empty = path.join(results, 'fit-empty.gguf')
  const header = new DataView(new ArrayBuffer(GGUF_HEADER_BYTES))
  header.setUint32(0, GGUF_MAGIC, true)
  header.setUint32(4, GGUF_VERSION, true)
  // Tensor count and metadata count stay 0 (two little-endian uint64).
  fs.writeFileSync(empty, new Uint8Array(header.buffer))
  try {
    await t.exception(assessFit({ modelPath: empty }), /not a MobileNet, MegaLoc or BridgeDepth/)
  } finally {
    fs.unlinkSync(empty)
  }
})
