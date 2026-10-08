'use strict'

const test = require('brittle')
const path = require('bare-path')
const { assessFit } = require('../..')
const { ensureModelPath, ensureDoctrModels, platform } = require('./utils')

const gpuBackend = platform === 'darwin' || platform === 'ios' ? 'metal' : 'vulkan'

test('assessFit reads both EasyOCR model descriptions without loading an image', async (t) => {
  const pathDetector = path.resolve(await ensureModelPath('detector_craft'))
  const pathRecognizer = path.resolve(await ensureModelPath('recognizer_latin'))
  const fit = assessFit({ pathDetector, pathRecognizer, backendDevice: 'cpu' })

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

  const reserved = assessFit({
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
  const fit = assessFit({
    pathDetector,
    pathRecognizer: path.join(pathDetector, 'missing-recognizer.gguf')
  })
  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('assessFit uses the requested gpuDevice when selecting a backend', async (t) => {
  const pathDetector = path.resolve(await ensureModelPath('detector_craft'))
  const pathRecognizer = path.resolve(await ensureModelPath('recognizer_latin'))
  const request = { pathDetector, pathRecognizer, backendDevice: gpuBackend }
  const automatic = assessFit(request)
  const explicit = assessFit({ ...request, gpuDevice: 9999 })

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
  const singleDevice = assessFit(request)
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

  const assisted = assessFit({ ...request, recognizerCpuAssist: true })
  t.is(assisted.status, 'error')
  t.is(assisted.reason, 'unsupported-config', 'GPU recognition with CPU assist is split')

  const splitDetector = assessFit({
    ...request,
    backendDevice: 'cpu',
    detectionBackendDevice: gpuBackend
  })
  t.is(splitDetector.status, 'error')
  t.is(splitDetector.reason, 'unsupported-config', 'CPU recognition with GPU detection is split')
})
