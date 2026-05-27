'use strict'

const test = require('brittle')
const OcrGgml = require('../..').OcrGgml
const { ERR_CODES, QvacErrorAddonOcrGgml } = require('../..')

async function captureRejection (fn) {
  try {
    await fn()
  } catch (err) {
    return err
  }
  return null
}

test('OcrGgml constructor exposes initial state', t => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      langList: ['en']
    }
  })

  t.alike(ocr.getState(), {
    configLoaded: false,
    weightsLoaded: false,
    destroyed: false
  })
})

test('OcrGgml.load rejects when pathDetector is missing', async t => {
  const ocr = new OcrGgml({
    params: {
      pathRecognizer: '/tmp/recognizer.gguf',
      langList: ['en']
    }
  })

  const err = await captureRejection(() => ocr.load())
  t.ok(err, 'load() rejected')
  t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
  t.is(err && err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'error.code is MISSING_REQUIRED_PARAMETER')
})

test('OcrGgml.load rejects when pathRecognizer is missing', async t => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: '/tmp/detector.gguf',
      langList: ['en']
    }
  })

  const err = await captureRejection(() => ocr.load())
  t.ok(err, 'load() rejected')
  t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
  t.is(err && err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'error.code is MISSING_REQUIRED_PARAMETER')
})

test('OcrGgml.load rejects when langList is empty', async t => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: '/tmp/detector.gguf',
      pathRecognizer: '/tmp/recognizer.gguf',
      langList: []
    }
  })

  const err = await captureRejection(() => ocr.load())
  t.ok(err, 'load() rejected')
  t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
  t.is(err && err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'error.code is MISSING_REQUIRED_PARAMETER')
})

test('OcrGgml.getModelKey returns deterministic key', t => {
  t.is(OcrGgml.getModelKey(), 'ocr-ggml')
})
