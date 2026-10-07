'use strict'

const test = require('brittle')
const { assessFit } = require('../..')
const { ensureModelPath } = require('./utils')

test('assessFit reads both EasyOCR model descriptions without loading an image', async (t) => {
  const pathDetector = await ensureModelPath('detector_craft')
  const pathRecognizer = await ensureModelPath('recognizer_latin')
  const fit = assessFit({ pathDetector, pathRecognizer, backendDevice: 'cpu' })

  t.ok(['fits', 'does-not-fit', 'error'].includes(fit.status))
  t.ok(fit.weightsBytes > 0)
  t.ok(fit.hostBytes > 0)
  t.ok(fit.report.includes('excludes image and inference-graph memory'))
  if (fit.status === 'error') {
    t.ok(['uncertain', 'device-memory-unavailable'].includes(fit.reason))
  }
})

test('assessFit returns model-unreadable for a missing recognizer', async (t) => {
  const pathDetector = await ensureModelPath('detector_craft')
  const fit = assessFit({
    pathDetector,
    pathRecognizer: '/nonexistent/recognizer.gguf'
  })
  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})
