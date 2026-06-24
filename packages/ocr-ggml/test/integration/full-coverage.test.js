'use strict'

const { OcrGgml, QvacErrorAddonOcrGgml, ERR_CODES, binding } = require('../..')
const test = require('brittle')
const { isMobile, ensureModelPath, getImagePath } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 120 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

function createMinimalOcr () {
  return new OcrGgml({
    params: {
      pathDetector: 'models/craft_mlt_25k.gguf',
      pathRecognizer: 'models/latin_g2.gguf',
      langList: ['en']
    }
  })
}

async function loadOcr () {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en']
    }
  })

  await ocrGgml.load()
  return ocrGgml
}

// =============================================
// Static methods & properties (index.js)
// =============================================

test('getModelKey returns ocr-ggml', function (t) {
  t.is(OcrGgml.getModelKey(), 'ocr-ggml')
})

test('inferenceManagerConfig.noAdditionalDownload is true', function (t) {
  t.is(OcrGgml.inferenceManagerConfig.noAdditionalDownload, true)
})

test('createJobHandler is initialized', function (t) {
  const ocrGgml = createMinimalOcr()
  t.ok(ocrGgml._job, 'should have _job handler')
  t.is(ocrGgml._job.active, null, 'no active response initially')
})

// =============================================
// _addonOutputCallback event mapping (index.js)
// =============================================

test('_addonOutputCallback routes stats object (with totalTime) to _job.end', function (t) {
  const ocrGgml = createMinimalOcr()
  ocrGgml.opts = { stats: true }

  // Start a job so there's an active response
  const response = ocrGgml._job.start()
  let ended = false
  let receivedStats = null
  response.on('stats', s => { receivedStats = s })
  response.on('end', () => { ended = true })

  const statsData = { totalTime: 1.5, detectionTime: 0.5, recognitionTime: 1.0 }
  ocrGgml._addonOutputCallback(null, 'SomeMangledType', statsData, null)

  t.ok(ended, 'response should be ended')
  t.alike(receivedStats, statsData, 'stats should be forwarded')
  t.is(ocrGgml._job.active, null, 'active response should be cleared')
})

test('_addonOutputCallback routes Error event to _job.fail', function (t) {
  const ocrGgml = createMinimalOcr()

  const response = ocrGgml._job.start()
  let receivedError = null
  response.onError(err => { receivedError = err })

  ocrGgml._addonOutputCallback(null, 'SomethingError', 'error payload', 'the error')

  t.ok(receivedError, 'error should be received')
  t.is(ocrGgml._job.active, null, 'active response should be cleared')
})

test('_addonOutputCallback routes array data to _job.output', function (t) {
  const ocrGgml = createMinimalOcr()

  const response = ocrGgml._job.start()
  let receivedData = null
  response.onUpdate(d => { receivedData = d })

  const outputData = [['box1', 'text1'], ['box2', 'text2']]
  ocrGgml._addonOutputCallback(null, 'PipelineResult', outputData, null)

  t.alike(receivedData, outputData, 'output data should be routed')
  t.ok(ocrGgml._job.active, 'active response should still exist (not ended)')
})

test('_addonOutputCallback ignores unmapped non-array non-stats events', function (t) {
  const ocrGgml = createMinimalOcr()

  const response = ocrGgml._job.start()
  let outputCalled = false
  response.onUpdate(() => { outputCalled = true })

  ocrGgml._addonOutputCallback(null, 'CustomEvent', 'string data', null)

  t.not(outputCalled, 'output should not be called for unmapped string data')
  t.ok(ocrGgml._job.active, 'active response should still exist')
})

// =============================================
// addonLogging.js coverage
// =============================================

test('addonLogging exports setLogger and releaseLogger as functions', function (t) {
  const { addonLogging: logging } = require('../..')
  t.is(typeof logging.setLogger, 'function')
  t.is(typeof logging.releaseLogger, 'function')
})

test('addonLogging setLogger and releaseLogger execute without error', function (t) {
  const { addonLogging: logging } = require('../..')
  logging.setLogger(function () {})
  t.pass('setLogger accepted a callback')
  logging.releaseLogger()
  t.pass('releaseLogger completed')
})

// =============================================
// Optional performance params: defaultRotationAngles, contrastRetry
// =============================================

test('load() accepts defaultRotationAngles and contrastRetry', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      defaultRotationAngles: [90, 180, 270],
      contrastRetry: true
    }
  })

  await ocrGgml.load()
  t.pass('Loaded with defaultRotationAngles + contrastRetry')

  try {
    const response = await ocrGgml.run({
      path: imagePath,
      options: { paragraph: false }
    })

    await response
      .onUpdate(function (output) {
        t.ok(Array.isArray(output), 'Output should be an array')
      })
      .onError(function (error) {
        t.fail('Unexpected error: ' + JSON.stringify(error))
      })
      .await()

    t.pass('Inference completed with extra params')
  } finally {
    await ocrGgml.unload()
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

// =============================================
// OcrGgmlInterface catch blocks via monkey-patching
// (ocr-ggml.js: activate, runJob, destroy)
// =============================================

test('activate catch wraps error as FAILED_TO_ACTIVATE', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = await loadOcr()
  const addonRef = ocrGgml.addon

  const original = binding.activate
  binding.activate = function () { throw new Error('simulated activate failure') }

  try {
    await addonRef.activate()
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'Error is QvacErrorAddonOcrGgml')
    t.is(err.code, ERR_CODES.FAILED_TO_ACTIVATE)
    t.ok(err.message.includes('simulated activate failure'))
  } finally {
    binding.activate = original
    await ocrGgml.unload()
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

test('runJob catch wraps error as FAILED_TO_RUN_JOB', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = await loadOcr()
  const addonRef = ocrGgml.addon

  const original = binding.runJob
  binding.runJob = function () { throw new Error('simulated runJob failure') }

  try {
    await addonRef.runJob({ type: 'image', input: {}, options: {} })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'Error is QvacErrorAddonOcrGgml')
    t.is(err.code, ERR_CODES.FAILED_TO_RUN_JOB)
    t.ok(err.message.includes('simulated runJob failure'))
  } finally {
    binding.runJob = original
    await ocrGgml.unload()
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

test('destroy catch wraps error as FAILED_TO_DESTROY', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = await loadOcr()
  const addonRef = ocrGgml.addon

  const original = binding.destroyInstance
  binding.destroyInstance = function () { throw new Error('simulated destroy failure') }

  try {
    await addonRef.destroy()
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'Error is QvacErrorAddonOcrGgml')
    t.is(err.code, ERR_CODES.FAILED_TO_DESTROY)
    t.ok(err.message.includes('simulated destroy failure'))
  } finally {
    binding.destroyInstance = original
    try { await addonRef.destroy() } catch (e) { /* real cleanup */ }
    ocrGgml.addon = null
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

// =============================================
// OcrGgmlInterface.cancel and .unload delegation
// (ocr-ggml.js)
// =============================================

test('cancel calls binding.cancel', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = await loadOcr()
  const addonRef = ocrGgml.addon

  let cancelCalled = false
  const original = binding.cancel
  binding.cancel = function () { cancelCalled = true }

  try {
    await addonRef.cancel()
    t.ok(cancelCalled, 'binding.cancel was called')
  } finally {
    binding.cancel = original
    await ocrGgml.unload()
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

test('OcrGgmlInterface.unload delegates to destroy', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = await loadOcr()
  const addonRef = ocrGgml.addon

  let destroyCalled = false
  const original = binding.destroyInstance
  binding.destroyInstance = function (handle) {
    destroyCalled = true
    return original(handle)
  }

  try {
    await addonRef.unload()
    t.ok(destroyCalled, 'unload delegated to destroy')
    t.is(addonRef._handle, null, 'Handle set to null after unload')
  } finally {
    binding.destroyInstance = original
    ocrGgml.addon = null
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})
