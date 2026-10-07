'use strict'

const test = require('brittle')
const path = require('bare-path')
const { assessFit } = require('../..')
const { ensureModelPath } = require('./utils')

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
