'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, ensureModelPath } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 60 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

// Fields the C++ getDiagnosticsJSON() must always return
const REQUIRED_NATIVE_FIELDS = [
  'onnxRuntimeVersion',
  'executionProvider',
  'modelLoaded',
  'pipelineMode',
  'modelPaths',
  'sessionOptions'
]

test('_getDiagnosticsJSON before load returns valid JSON', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
      langList: ['en'],
      useGPU: false
    }
  })

  const result = onnxOcr._getDiagnosticsJSON()
  t.ok(typeof result === 'string', '_getDiagnosticsJSON should return a string')

  let parsed
  try {
    parsed = JSON.parse(result)
  } catch (e) {
    t.fail('_getDiagnosticsJSON should return valid JSON, got: ' + result)
    return
  }

  t.ok(parsed, 'parsed result should be truthy')
  t.pass('_getDiagnosticsJSON returns valid JSON before load')
})

test('_getDiagnosticsJSON before load has status not_loaded', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
      langList: ['en'],
      useGPU: false
    }
  })

  const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
  t.is(parsed.status, 'not_loaded', 'status should be not_loaded before load()')
})

test('_getDiagnosticsJSON before load includes params', { timeout: TEST_TIMEOUT }, async function (t) {
  const params = {
    pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
    pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
    langList: ['en'],
    useGPU: false
  }

  const onnxOcr = new ONNXOcr({ params })

  const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
  t.ok('params' in parsed, 'result should include params field')
  t.alike(parsed.params.langList, ['en'], 'params.langList should match constructor params')
  t.is(parsed.params.useGPU, false, 'params.useGPU should match constructor params')
})

test('_getDiagnosticsJSON before load has no native field (addon not yet created)', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
      langList: ['en'],
      useGPU: false
    }
  })

  const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
  t.ok(!('native' in parsed), 'native field should be absent before load() — addon not yet created')
})

test('_getDiagnosticsJSON after load returns valid JSON with native fields', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    }
  })

  await onnxOcr.load()

  try {
    const result = onnxOcr._getDiagnosticsJSON()
    t.ok(typeof result === 'string', '_getDiagnosticsJSON should return a string after load')

    let parsed
    try {
      parsed = JSON.parse(result)
    } catch (e) {
      t.fail('_getDiagnosticsJSON should return valid JSON after load, got: ' + result)
      return
    }

    t.ok('native' in parsed, 'result should include native field after load (addon created)')

    for (const field of REQUIRED_NATIVE_FIELDS) {
      t.ok(field in parsed.native, 'native should include field: ' + field)
    }
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('_getDiagnosticsJSON after load — native.modelLoaded is true', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    }
  })

  await onnxOcr.load()

  try {
    const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
    t.ok('native' in parsed, 'native field must be present')
    t.is(parsed.native.modelLoaded, true, 'native.modelLoaded should be true after load (Pipeline is constructed during _load)')
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('_getDiagnosticsJSON after load — native.pipelineMode is easyocr by default', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    }
  })

  await onnxOcr.load()

  try {
    const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
    t.ok('native' in parsed, 'native field must be present')
    t.is(parsed.native.pipelineMode, 'easyocr', 'native.pipelineMode should be easyocr when no pipelineMode param set')
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('_getDiagnosticsJSON after load — native.modelPaths reflect constructor paths', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    }
  })

  await onnxOcr.load()

  try {
    const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
    t.ok('native' in parsed, 'native field must be present')
    t.ok('modelPaths' in parsed.native, 'native.modelPaths should be present')
    t.ok(typeof parsed.native.modelPaths.detector === 'string', 'native.modelPaths.detector should be a string')
    t.ok(typeof parsed.native.modelPaths.recognizer === 'string', 'native.modelPaths.recognizer should be a string')
    t.ok(parsed.native.modelPaths.detector.length > 0, 'native.modelPaths.detector should not be empty')
    t.ok(parsed.native.modelPaths.recognizer.length > 0, 'native.modelPaths.recognizer should not be empty')
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('_getDiagnosticsJSON after load — native.sessionOptions present', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    }
  })

  await onnxOcr.load()

  try {
    const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
    t.ok('native' in parsed, 'native field must be present')
    t.ok('sessionOptions' in parsed.native, 'native.sessionOptions should be present')
    t.ok(typeof parsed.native.sessionOptions === 'object', 'native.sessionOptions should be an object')
    t.is(parsed.native.sessionOptions.useGPU, false, 'native.sessionOptions.useGPU should match constructor param')
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('_getDiagnosticsJSON after load — native.onnxRuntimeVersion is a non-empty string', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    }
  })

  await onnxOcr.load()

  try {
    const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
    t.ok('native' in parsed, 'native field must be present')
    t.ok(typeof parsed.native.onnxRuntimeVersion === 'string', 'native.onnxRuntimeVersion should be a string')
    t.ok(parsed.native.onnxRuntimeVersion.length > 0, 'native.onnxRuntimeVersion should not be empty')
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('_getDiagnosticsJSON after load — native.executionProvider has configured and available', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    }
  })

  await onnxOcr.load()

  try {
    const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
    t.ok('native' in parsed, 'native field must be present')
    t.ok('executionProvider' in parsed.native, 'native.executionProvider should be present')
    t.ok('configured' in parsed.native.executionProvider, 'executionProvider should have configured field')
    t.ok('available' in parsed.native.executionProvider, 'executionProvider should have available field')
    t.ok(Array.isArray(parsed.native.executionProvider.available), 'executionProvider.available should be an array')
    t.ok(parsed.native.executionProvider.available.length > 0, 'executionProvider.available should not be empty')
    t.ok(typeof parsed.native.executionProvider.configured === 'string', 'executionProvider.configured should be a string')
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('_getDiagnosticsJSON after load — JS status and params still present alongside native', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    }
  })

  await onnxOcr.load()

  try {
    const parsed = JSON.parse(onnxOcr._getDiagnosticsJSON())
    t.ok('status' in parsed, 'JS status field should still be present after load')
    t.ok('params' in parsed, 'JS params field should still be present after load')
    t.ok('native' in parsed, 'native field should be present after load')
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
