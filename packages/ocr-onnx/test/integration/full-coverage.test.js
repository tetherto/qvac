'use strict'

const { ONNXOcr, QvacErrorAddonOcr, ERR_CODES, binding } = require('../..')
const test = require('brittle')
const { isMobile, ensureModelPath, getImagePath, windowsOrtParams } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 120 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

function createMinimalOcr () {
  return new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
      langList: ['en'],
      useGPU: false,
      ...windowsOrtParams
    }
  })
}

async function loadOcr () {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false,
      ...windowsOrtParams
    }
  })

  await onnxOcr.load()
  return onnxOcr
}

// =============================================
// Static methods & properties (index.js)
// =============================================

test('getModelKey returns onnx-ocr-fasttext-easyocr by default', function (t) {
  t.is(ONNXOcr.getModelKey(), 'onnx-ocr-fasttext-easyocr')
  t.is(ONNXOcr.getModelKey({ anything: true }), 'onnx-ocr-fasttext-easyocr', 'Defaults to easyocr when pipelineMode not set')
  t.is(ONNXOcr.getModelKey({ pipelineMode: 'doctr' }), 'onnx-ocr-fasttext-doctr', 'Returns doctr key when pipelineMode is doctr')
})

test('inferenceManagerConfig.noAdditionalDownload is true', function (t) {
  t.is(ONNXOcr.inferenceManagerConfig.noAdditionalDownload, true)
})

test('createJobHandler is initialized', function (t) {
  const onnxOcr = createMinimalOcr()
  t.ok(onnxOcr._job, 'should have _job handler')
  t.is(onnxOcr._job.active, null, 'no active response initially')
})

// =============================================
// _normalizePath (index.js:36-41)
// =============================================

test('_normalizePath returns path unchanged on non-win32', function (t) {
  const onnxOcr = createMinimalOcr()
  const input = '/some/path/to/image.bmp'
  const result = onnxOcr._normalizePath(input)
  const os = require('bare-os')
  if (os.platform() === 'win32') {
    t.is(result, '\\\\?\\' + input, 'Win32 should prepend long-path prefix')
  } else {
    t.is(result, input)
  }
})

test('_normalizePath handles various path formats', function (t) {
  const onnxOcr = createMinimalOcr()
  const os = require('bare-os')
  const isWin = os.platform() === 'win32'
  const prefix = isWin ? '\\\\?\\' : ''

  t.is(onnxOcr._normalizePath('relative/path.bmp'), prefix + 'relative/path.bmp')
  t.is(onnxOcr._normalizePath(''), isWin ? '\\\\?\\' : '')
  t.is(onnxOcr._normalizePath('./file.bmp'), prefix + './file.bmp')
})

// =============================================
// _addonOutputCallback event mapping (index.js:101-118)
// =============================================

test('_addonOutputCallback routes stats object (with totalTime) to _job.end', function (t) {
  const onnxOcr = createMinimalOcr()
  onnxOcr.opts = { stats: true }

  // Start a job so there's an active response
  const response = onnxOcr._job.start()
  let ended = false
  let receivedStats = null
  response.on('stats', s => { receivedStats = s })
  response.on('end', () => { ended = true })

  const statsData = { totalTime: 1.5, detectionTime: 0.5, recognitionTime: 1.0 }
  onnxOcr._addonOutputCallback(null, 'SomeMangledType', statsData, null)

  t.ok(ended, 'response should be ended')
  t.alike(receivedStats, statsData, 'stats should be forwarded')
  t.is(onnxOcr._job.active, null, 'active response should be cleared')
})

test('_addonOutputCallback routes Error event to _job.fail', function (t) {
  const onnxOcr = createMinimalOcr()

  const response = onnxOcr._job.start()
  let receivedError = null
  response.onError(err => { receivedError = err })

  onnxOcr._addonOutputCallback(null, 'SomethingError', 'error payload', 'the error')

  t.ok(receivedError, 'error should be received')
  t.is(onnxOcr._job.active, null, 'active response should be cleared')
})

test('_addonOutputCallback routes array data to _job.output', function (t) {
  const onnxOcr = createMinimalOcr()

  const response = onnxOcr._job.start()
  let receivedData = null
  response.onUpdate(d => { receivedData = d })

  const outputData = [['box1', 'text1'], ['box2', 'text2']]
  onnxOcr._addonOutputCallback(null, 'PipelineResult', outputData, null)

  t.alike(receivedData, outputData, 'output data should be routed')
  t.ok(onnxOcr._job.active, 'active response should still exist (not ended)')
})

test('_addonOutputCallback ignores unmapped non-array non-stats events', function (t) {
  const onnxOcr = createMinimalOcr()

  const response = onnxOcr._job.start()
  let outputCalled = false
  response.onUpdate(() => { outputCalled = true })

  onnxOcr._addonOutputCallback(null, 'CustomEvent', 'string data', null)

  t.not(outputCalled, 'output should not be called for unmapped string data')
  t.ok(onnxOcr._job.active, 'active response should still exist')
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
// (index.js:84-89 — branches not hit by existing tests)
// =============================================

test('load() accepts defaultRotationAngles and contrastRetry', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false,
      ...windowsOrtParams,
      defaultRotationAngles: [90, 180, 270],
      contrastRetry: true
    }
  })

  await onnxOcr.load()
  t.pass('Loaded with defaultRotationAngles + contrastRetry')

  try {
    const response = await onnxOcr.run({
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
    await onnxOcr.unload()
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

// =============================================
// OcrFasttextInterface catch blocks via monkey-patching
// (ocr-fasttext.js: activate, runJob, destroy, loadWeights)
// =============================================

test('activate catch wraps error as FAILED_TO_ACTIVATE', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = await loadOcr()
  const addonRef = onnxOcr.addon

  const original = binding.activate
  binding.activate = function () { throw new Error('simulated activate failure') }

  try {
    await addonRef.activate()
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Error is QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.FAILED_TO_ACTIVATE)
    t.ok(err.message.includes('simulated activate failure'))
  } finally {
    binding.activate = original
    await onnxOcr.unload()
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

test('runJob catch wraps error as FAILED_TO_RUN_JOB', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = await loadOcr()
  const addonRef = onnxOcr.addon

  const original = binding.runJob
  binding.runJob = function () { throw new Error('simulated runJob failure') }

  try {
    await addonRef.runJob({ type: 'image', input: {}, options: {} })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Error is QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.FAILED_TO_RUN_JOB)
    t.ok(err.message.includes('simulated runJob failure'))
  } finally {
    binding.runJob = original
    await onnxOcr.unload()
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

test('destroy catch wraps error as FAILED_TO_DESTROY', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = await loadOcr()
  const addonRef = onnxOcr.addon

  const original = binding.destroyInstance
  binding.destroyInstance = function () { throw new Error('simulated destroy failure') }

  try {
    await addonRef.destroy()
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Error is QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.FAILED_TO_DESTROY)
    t.ok(err.message.includes('simulated destroy failure'))
  } finally {
    binding.destroyInstance = original
    try { await addonRef.destroy() } catch (e) { /* real cleanup */ }
    onnxOcr.addon = null
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

test('loadWeights catch wraps error as FAILED_TO_LOAD_WEIGHTS', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = await loadOcr()
  const addonRef = onnxOcr.addon

  const original = binding.loadWeights
  binding.loadWeights = function () { throw new Error('simulated loadWeights failure') }

  try {
    await addonRef.loadWeights({
      filename: 'test.bin',
      contents: new Uint8Array(0),
      completed: true
    })
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Error is QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.FAILED_TO_LOAD_WEIGHTS)
    t.ok(err.message.includes('simulated loadWeights failure'))
  } finally {
    binding.loadWeights = original
    await onnxOcr.unload()
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

// =============================================
// OcrFasttextInterface.cancel and .unload delegation
// (ocr-fasttext.js:52-54, 91-93)
// =============================================

test('cancel calls binding.cancel', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = await loadOcr()
  const addonRef = onnxOcr.addon

  let cancelCalled = false
  const original = binding.cancel
  binding.cancel = function () { cancelCalled = true }

  try {
    await addonRef.cancel()
    t.ok(cancelCalled, 'binding.cancel was called')
  } finally {
    binding.cancel = original
    await onnxOcr.unload()
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})

test('OcrFasttextInterface.unload delegates to destroy', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = await loadOcr()
  const addonRef = onnxOcr.addon

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
    onnxOcr.addon = null
    await new Promise(function (resolve) { setTimeout(resolve, 1000) })
  }
})
