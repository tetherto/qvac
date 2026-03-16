'use strict'

const test = require('brittle')

let diagnostics
try { diagnostics = require('@qvac/diagnostics') } catch (e) { diagnostics = null }

// Minimal test class that replicates the ONNXOcr constructor fields and
// _getDiagnosticsJSON method without requiring native bindings.
// This mirrors the exact implementation in index.js.
class TestOCR {
  constructor ({ params }) {
    this.params = params
    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false
    }
    this._packageName = '@qvac/ocr-onnx'
    this._packageVersion = require('../../package.json').version
    this.addon = null
  }

  _getDiagnosticsJSON () {
    const jsInfo = {
      status: this.state.destroyed ? 'destroyed' : (this.state.configLoaded ? 'loaded' : 'not_loaded'),
      params: this.params
    }
    if (this.addon && typeof this.addon.getDiagnostics === 'function') {
      try {
        const cppDiag = JSON.parse(this.addon.getDiagnostics())
        return JSON.stringify({ ...jsInfo, native: cppDiag })
      } catch (e) {
        // Fall back to JS-only info
      }
    }
    return JSON.stringify(jsInfo)
  }
}

test('ONNXOcr constructor sets _packageName', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })
  t.is(ocr._packageName, '@qvac/ocr-onnx', '_packageName should be @qvac/ocr-onnx')
})

test('ONNXOcr constructor sets _packageVersion from package.json', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })
  const pkg = require('../../package.json')
  t.is(ocr._packageVersion, pkg.version, '_packageVersion should match package.json version')
  t.ok(typeof ocr._packageVersion === 'string', '_packageVersion should be a string')
  t.ok(ocr._packageVersion.length > 0, '_packageVersion should not be empty')
})

test('_getDiagnosticsJSON returns valid JSON string', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })
  const result = ocr._getDiagnosticsJSON()
  t.ok(typeof result === 'string', '_getDiagnosticsJSON should return a string')
  let parsed
  try {
    parsed = JSON.parse(result)
  } catch (e) {
    t.fail('_getDiagnosticsJSON should return valid JSON')
    return
  }
  t.ok(parsed, 'parsed JSON should be truthy')
})

test('_getDiagnosticsJSON includes expected fields', t => {
  const params = {
    langList: ['en', 'fr'],
    useGPU: true,
    pipelineMode: 'doctr',
    timeout: 60
  }
  const ocr = new TestOCR({ params })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok('status' in parsed, 'should include status field')
  t.ok('params' in parsed, 'should include params field')
  t.alike(parsed.params.langList, ['en', 'fr'], 'langList should match params')
  t.is(parsed.params.useGPU, true, 'useGPU should match params')
  t.is(parsed.params.pipelineMode, 'doctr', 'pipelineMode should match params')
  t.is(parsed.params.timeout, 60, 'timeout should match params')
})

test('_getDiagnosticsJSON status reflects state correctly', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })

  t.is(JSON.parse(ocr._getDiagnosticsJSON()).status, 'not_loaded', 'should be not_loaded initially')

  ocr.state.configLoaded = true
  t.is(JSON.parse(ocr._getDiagnosticsJSON()).status, 'loaded', 'should be loaded when configLoaded=true')

  ocr.state.destroyed = true
  t.is(JSON.parse(ocr._getDiagnosticsJSON()).status, 'destroyed', 'should be destroyed when destroyed=true')
})

test('_getDiagnosticsJSON passes through all params', t => {
  const ocr = new TestOCR({ params: { langList: ['en'], custom: 'value' } })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.alike(parsed.params.langList, ['en'], 'langList passed through')
  t.is(parsed.params.custom, 'value', 'custom params passed through')
})

test('_getDiagnosticsJSON includes native field when addon has getDiagnostics', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })

  const mockNative = {
    onnxRuntimeVersion: 21,
    availableExecutionProviders: ['CPUExecutionProvider'],
    modelPaths: { detector: '/path/to/det.onnx', recognizer: '/path/to/rec.onnx' },
    modelLoaded: true,
    useGPU: false,
    pipelineMode: 'EASYOCR',
    timeout: 120,
    sessionOptions: {
      recognizerBatchSize: 32,
      decodingMethod: 'CTC',
      magRatio: 1.5,
      contrastRetry: false,
      straightenPages: false
    },
    langList: ['en']
  }

  ocr.addon = {
    getDiagnostics: () => JSON.stringify(mockNative)
  }

  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok('native' in parsed, 'should include native field')
  t.is(parsed.native.onnxRuntimeVersion, 21, 'native should contain onnxRuntimeVersion')
  t.alike(parsed.native.availableExecutionProviders, ['CPUExecutionProvider'], 'native should contain providers')
  t.is(parsed.native.modelPaths.detector, '/path/to/det.onnx', 'native should contain detector path')
  t.is(parsed.native.pipelineMode, 'EASYOCR', 'native should contain pipelineMode')
  t.is(parsed.native.sessionOptions.recognizerBatchSize, 32, 'native should contain sessionOptions')
})

test('_getDiagnosticsJSON falls back gracefully when addon has no getDiagnostics', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })

  // addon exists but without getDiagnostics method
  ocr.addon = {}

  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.absent(parsed.native, 'should not include native field when addon lacks getDiagnostics')
  t.ok('status' in parsed, 'should still include status')
  t.ok('params' in parsed, 'should still include params')
})

test('_getDiagnosticsJSON falls back gracefully when addon.getDiagnostics throws', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })

  ocr.addon = {
    getDiagnostics: () => { throw new Error('native error') }
  }

  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.absent(parsed.native, 'should not include native field when getDiagnostics throws')
  t.ok('status' in parsed, 'should still include status')
  t.ok('params' in parsed, 'should still include params')
})

test('_getDiagnosticsJSON falls back when addon.getDiagnostics returns invalid JSON', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })

  ocr.addon = {
    getDiagnostics: () => 'not valid json{'
  }

  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.absent(parsed.native, 'should not include native field when JSON is invalid')
  t.ok('status' in parsed, 'should still include status')
})

test('native binding getDiagnostics returns valid diagnostics', t => {
  let binding
  try {
    binding = require('../../binding')
  } catch (e) {
    t.comment('Native binding not available, skipping: ' + e.message)
    return
  }

  if (typeof binding.getDiagnostics !== 'function') {
    t.comment('binding.getDiagnostics not available, skipping')
    return
  }

  // Create a minimal instance to call getDiagnostics on
  let handle
  try {
    handle = binding.createInstance(
      {},
      {
        pathDetector: '/tmp/nonexistent-det.onnx',
        pathRecognizer: '/tmp/nonexistent-rec.onnx',
        langList: ['en'],
        useGPU: false,
        timeout: 30
      },
      () => {},
      null
    )
  } catch (e) {
    t.comment('Could not create instance, skipping: ' + e.message)
    return
  }

  try {
    const result = binding.getDiagnostics(handle)
    t.ok(typeof result === 'string', 'getDiagnostics should return a string')

    const parsed = JSON.parse(result)
    t.ok(typeof parsed.onnxRuntimeVersion === 'number', 'onnxRuntimeVersion should be a number')
    t.ok(parsed.onnxRuntimeVersion > 0, 'onnxRuntimeVersion should be > 0')
    t.ok(Array.isArray(parsed.availableExecutionProviders), 'availableExecutionProviders should be an array')
    t.ok(parsed.availableExecutionProviders.length > 0, 'availableExecutionProviders should not be empty')
    t.ok('modelPaths' in parsed, 'should have modelPaths')
    t.ok('modelLoaded' in parsed, 'should have modelLoaded')
    t.ok('useGPU' in parsed, 'should have useGPU')
    t.ok('pipelineMode' in parsed, 'should have pipelineMode')
    t.ok('timeout' in parsed, 'should have timeout')
    t.ok('sessionOptions' in parsed, 'should have sessionOptions')
    t.ok('langList' in parsed, 'should have langList')
  } finally {
    try {
      binding.destroyInstance(handle)
    } catch (e) {
      // ignore cleanup errors
    }
  }
})

test('round-trip: registerAddon with OCR callback, generateReport shows addon', { skip: !diagnostics }, t => {
  diagnostics.reset()

  const ocr = new TestOCR({
    params: {
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'easyocr',
      timeout: 120
    }
  })

  diagnostics.registerAddon({
    name: ocr._packageName,
    version: ocr._packageVersion,
    getDiagnostics: () => ocr._getDiagnosticsJSON()
  })

  const report = diagnostics.generateReport({ app: { name: 'test-app', version: '1.0.0' } })

  t.is(report.addons.length, 1, 'report should have one addon')
  t.is(report.addons[0].name, '@qvac/ocr-onnx', 'addon name should be @qvac/ocr-onnx')
  t.is(report.addons[0].version, ocr._packageVersion, 'addon version should match package version')
  t.ok(typeof report.addons[0].diagnostics === 'string', 'diagnostics should be a string')

  const addonDiag = JSON.parse(report.addons[0].diagnostics)
  t.ok('status' in addonDiag, 'diagnostics should include status')
  t.ok('params' in addonDiag, 'diagnostics should include params')

  diagnostics.reset()
})
