'use strict'

const test = require('brittle')
const path = require('bare-path')
const { assessFit } = require('../..')
const { ensureModelPath, ensureDoctrModels, platform, createOcrGgml } = require('./utils')

const gpuBackend = platform === 'darwin' || platform === 'ios' ? 'metal' : 'vulkan'

const isVerdict = (fit) => fit.status === 'fits' || fit.status === 'does-not-fit'
const demand = (fit) => fit.devices.map((row) => [row.id, row.usedBytes])
const onGpu = (fit) => fit.devices.length > 0 && fit.devices[0].name !== 'CPU'

async function easyOcrPaths() {
  return {
    pathDetector: path.resolve(await ensureModelPath('detector_craft')),
    pathRecognizer: path.resolve(await ensureModelPath('recognizer_latin'))
  }
}

test('assessFit reads both EasyOCR model descriptions without loading an image', async (t) => {
  const { pathDetector, pathRecognizer } = await easyOcrPaths()
  const fit = await assessFit({ pathDetector, pathRecognizer, backendDevice: 'cpu' })

  t.comment(JSON.stringify(fit))
  t.ok(['fits', 'does-not-fit', 'unknown'].includes(fit.status))
  t.alike(fit.stats, {})
  if (isVerdict(fit)) {
    t.is(fit.devices.length, 1, 'a CPU load is one row')
    const [row] = fit.devices
    t.ok(row.unified, 'the CPU row is the host')
    for (const key of ['usedBytes', 'freeBytes', 'totalBytes']) {
      t.ok(Number.isSafeInteger(row[key]) && row[key] >= 0, `${key} is a non-negative safe integer`)
    }
    t.ok(row.usedBytes > 0, 'the weights were measured')
  } else {
    t.alike(fit.devices, [], 'an unknown carries no rows')
  }

  const reserved = await assessFit({
    pathDetector,
    pathRecognizer,
    backendDevice: 'cpu',
    marginBytes: Number.MAX_SAFE_INTEGER
  })
  t.is(reserved.status, 'does-not-fit', 'a margin larger than free memory leaves no room')
  t.is(reserved.devices.length, 1, 'a CPU load is one row')
  t.is(reserved.devices[0].name, 'CPU', 'the row is the host CPU')
})

test('assessFit rejects a missing recognizer', async (t) => {
  const pathDetector = path.resolve(await ensureModelPath('detector_craft'))
  await t.exception(
    assessFit({ pathDetector, pathRecognizer: path.join(pathDetector, 'missing-recognizer.gguf') }),
    /cannot read the recognizer/
  )
})

test('assessFit uses the requested gpuDevice when selecting a backend', async (t) => {
  const request = { ...(await easyOcrPaths()), backendDevice: gpuBackend }
  const automatic = await assessFit(request)
  const explicit = await assessFit({ ...request, gpuDevice: 9999 })

  t.ok(explicit.devices.length <= 1, 'out-of-range GPU index falls back to the CPU alone')
  if (onGpu(automatic) && explicit.devices.length === 1) {
    t.not(explicit.devices[0].id, automatic.devices[0].id, 'explicit GPU index changes placement')
  }
})

test('assessFit recognizes actual DocTR detector and CPU-assist placement', async (t) => {
  const models = await ensureDoctrModels()
  if (!models) {
    t.pass('DocTR models are unavailable on this device')
    return
  }
  const pathDetector = path.resolve(models.db_mobilenet_v3_large)
  const pathRecognizer = path.resolve(models.crnn_mobilenet_v3_small)
  const request = {
    pathDetector,
    pathRecognizer,
    pipelineType: 'doctr',
    backendDevice: gpuBackend,
    detectionBackendDevice: gpuBackend,
    recognizerCpuAssist: false
  }
  // A CPU load whose free memory sits between the source tensors and the upper
  // bound is unknown, so a margin that leaves no room shows it was projected.
  const singleDevice = await assessFit(request)
  const projected =
    isVerdict(singleDevice) ||
    (await assessFit({ ...request, marginBytes: Number.MAX_SAFE_INTEGER })).status ===
      'does-not-fit'
  t.ok(projected, 'matching detector and recognizer devices are projected')

  if (!onGpu(singleDevice)) {
    t.pass('GPU unavailable; split-device checks require a GPU')
    return
  }

  const assisted = await assessFit({ ...request, recognizerCpuAssist: true })
  t.is(assisted.status, 'unknown', 'GPU recognition with CPU assist is split')
  t.alike(assisted.devices, [])

  const splitDetector = await assessFit({
    ...request,
    backendDevice: 'cpu',
    detectionBackendDevice: gpuBackend
  })
  t.is(splitDetector.status, 'unknown', 'CPU recognition with GPU detection is split')
  t.alike(splitDetector.devices, [])
})

test('assessFit keeps the event loop responsive while fits are queued', async (t) => {
  const request = { ...(await easyOcrPaths()), backendDevice: 'cpu' }
  const expected = await assessFit(request)

  let pending = true
  let turns = 0
  const spin = () => {
    if (!pending) return
    turns++
    setImmediate(spin)
  }
  setImmediate(spin)

  const fits = await Promise.all(Array.from({ length: 32 }, () => assessFit(request)))
  pending = false

  t.comment(`${turns} loop turns before the fits settled`)
  t.ok(turns > 0, 'the loop turned while the fitter ran')
  for (const fit of fits) {
    t.alike(demand(fit), demand(expected), 'every queued fit read the same models')
  }
})

test('queued fits retain independent requests and all settle', async (t) => {
  const request = { ...(await easyOcrPaths()), backendDevice: 'cpu' }
  const first = assessFit(request)
  const missing = assessFit({
    ...request,
    pathRecognizer: path.join(request.pathDetector, 'missing-recognizer.gguf')
  })
  request.marginBytes = Number.MAX_SAFE_INTEGER
  const reserved = assessFit(request)
  const [a, b, c] = await Promise.allSettled([first, missing, reserved])

  t.is(a.status, 'fulfilled', 'the first call read both models')
  t.is(c.status, 'fulfilled', 'the later call read both models')
  t.not(a.value.status, 'does-not-fit', 'the first call owns its original margin')
  t.is(b.status, 'rejected', 'a rejection does not strand queued callers')
  t.is(c.value.status, 'does-not-fit', 'the later call owns its changed margin')
})

test('a fit settles while a loaded model unloads', async (t) => {
  const paths = await easyOcrPaths()
  const model = createOcrGgml({ ...paths, langList: ['en'], backendDevice: 'cpu' })
  try {
    await model.load()
    const pending = assessFit({ ...paths, backendDevice: 'cpu' })
    await model.unload()
    const fit = await pending
    t.ok(['fits', 'does-not-fit', 'unknown'].includes(fit.status), 'the fit settled')
  } finally {
    await model.unload()
  }
})
