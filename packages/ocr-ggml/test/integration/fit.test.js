'use strict'

const test = require('brittle')
const path = require('bare-path')
const { assessFit } = require('../..')
const { ensureModelPath, ensureDoctrModels, platform, createOcrGgml } = require('./utils')

const gpuBackend = platform === 'darwin' || platform === 'ios' ? 'metal' : 'vulkan'

async function easyOcrPaths() {
  return {
    pathDetector: path.resolve(await ensureModelPath('detector_craft')),
    pathRecognizer: path.resolve(await ensureModelPath('recognizer_latin'))
  }
}

test('assessFit reads both EasyOCR model descriptions without loading an image', async (t) => {
  const { pathDetector, pathRecognizer } = await easyOcrPaths()
  const fit = await assessFit({ pathDetector, pathRecognizer, backendDevice: 'cpu' })

  t.ok(['fits', 'does-not-fit', 'error'].includes(fit.status))
  t.is(fit.deviceName, 'CPU')
  t.ok(fit.weightsBytes > 0)
  t.is(fit.hostBytes, fit.weightsBytes)
  t.is(fit.deviceBytes, 0)
  for (const key of [
    'weightsBytes',
    'hostBytes',
    'deviceBytes',
    'deviceFreeBytes',
    'deviceTotalBytes'
  ]) {
    t.ok(Number.isSafeInteger(fit[key]) && fit[key] >= 0, `${key} is a non-negative safe integer`)
  }
  t.ok(fit.report.includes('excludes image and inference-graph memory'))
  if (fit.status === 'fits') t.is(fit.reason, 'weights-fit')
  else if (fit.status === 'does-not-fit') t.is(fit.reason, 'source-weights-exceed-memory')
  else t.ok(['uncertain', 'device-memory-unavailable'].includes(fit.reason))

  const reserved = await assessFit({
    pathDetector,
    pathRecognizer,
    backendDevice: 'cpu',
    marginBytes: Number.MAX_SAFE_INTEGER
  })
  t.is(reserved.status, 'error', 'an unusably large margin cannot produce a fit verdict')
  t.ok(['uncertain', 'device-memory-unavailable'].includes(reserved.reason))
})

test('assessFit returns model-unreadable for a missing recognizer', async (t) => {
  const pathDetector = path.resolve(await ensureModelPath('detector_craft'))
  const fit = await assessFit({
    pathDetector,
    pathRecognizer: path.join(pathDetector, 'missing-recognizer.gguf')
  })
  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('assessFit uses the requested gpuDevice when selecting a backend', async (t) => {
  const request = { ...(await easyOcrPaths()), backendDevice: gpuBackend }
  const automatic = await assessFit(request)
  const explicit = await assessFit({ ...request, gpuDevice: 9999 })

  t.is(explicit.deviceName, 'CPU', 'out-of-range GPU index falls back to CPU')
  t.is(explicit.deviceBytes, 0)
  if (automatic.deviceName !== 'CPU') {
    t.ok(explicit.deviceName !== automatic.deviceName, 'explicit GPU index changes placement')
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
  const singleDevice = await assessFit(request)
  t.ok(singleDevice.weightsBytes > 0, 'DocTR model metadata was read')
  t.ok(singleDevice.deviceName, 'DocTR backend was selected')
  t.ok(
    singleDevice.reason !== 'unsupported-config',
    'matching detector and recognizer devices are supported'
  )

  if (singleDevice.deviceName === 'CPU') {
    t.pass('GPU unavailable; split-device checks require a GPU')
    return
  }

  const assisted = await assessFit({ ...request, recognizerCpuAssist: true })
  t.is(assisted.status, 'error')
  t.is(assisted.reason, 'unsupported-config', 'GPU recognition with CPU assist is split')

  const splitDetector = await assessFit({
    ...request,
    backendDevice: 'cpu',
    detectionBackendDevice: gpuBackend
  })
  t.is(splitDetector.status, 'error')
  t.is(splitDetector.reason, 'unsupported-config', 'CPU recognition with GPU detection is split')
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
    t.is(fit.weightsBytes, expected.weightsBytes, 'every queued fit read the same models')
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
  const [a, b, c] = await Promise.all([first, missing, reserved])

  t.ok(a.weightsBytes > 0, 'the first call read both models')
  if (a.reason !== 'device-memory-unavailable') {
    t.ok(a.report.includes('margin=0 '), 'the first call owns its original margin')
  }
  t.is(b.reason, 'model-unreadable', 'an error outcome does not strand queued callers')
  t.is(c.status, 'error', 'the later call owns its changed margin')
  t.ok(['uncertain', 'device-memory-unavailable'].includes(c.reason))
})

test('a fit settles while a loaded model unloads', async (t) => {
  const paths = await easyOcrPaths()
  const model = createOcrGgml({ ...paths, langList: ['en'], backendDevice: 'cpu' })
  try {
    await model.load()
    const pending = assessFit({ ...paths, backendDevice: 'cpu' })
    await model.unload()
    const fit = await pending
    t.ok(fit.weightsBytes > 0, 'unloading the model did not invalidate the fit backend')
    t.is(fit.deviceName, 'CPU')
  } finally {
    await model.unload()
  }
})
