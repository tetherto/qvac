'use strict'

const test = require('brittle')

let diagnostics
try { diagnostics = require('@qvac/diagnostics') } catch (e) { diagnostics = null }

// Minimal test class that replicates the ONNXOcr constructor fields and
// _getDiagnosticsJSON method without requiring native bindings.
// This mirrors the exact implementation in index.js, including the native
// getDiagnostics call and fallback logic.
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
    try {
      if (this.addon && this.addon._handle) {
        const nativeInfo = JSON.parse(this._getNativeDiagnostics(this.addon._handle))
        return JSON.stringify({ ...jsInfo, native: nativeInfo })
      }
    } catch (e) {
      // Fallback to JS-only info if native call fails
    }
    return JSON.stringify(jsInfo)
  }

  // Seam for native call — overridden in tests that exercise the merge path
  _getNativeDiagnostics (handle) {
    const binding = require('../../binding')
    return binding.getDiagnostics(handle)
  }
}

// Subclass that injects a mock native getDiagnostics response without loading the addon
class TestOCRWithMockNative extends TestOCR {
  constructor ({ params, nativeResponse }) {
    super({ params })
    this._nativeResponse = nativeResponse
    // Simulate a loaded addon with a handle present
    this.addon = { _handle: {} }
  }

  _getNativeDiagnostics (_handle) {
    return this._nativeResponse
  }
}

// Subclass that simulates a native call throwing an error
class TestOCRWithFailingNative extends TestOCR {
  constructor ({ params }) {
    super({ params })
    this.addon = { _handle: {} }
  }

  _getNativeDiagnostics (_handle) {
    throw new Error('native call failed')
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

test('_getDiagnosticsJSON fallback: returns JS-only info when no addon present', t => {
  const ocr = new TestOCR({ params: { langList: ['en'], useGPU: false } })
  // addon is null — no native handle available
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok('status' in parsed, 'fallback result should include status')
  t.ok('params' in parsed, 'fallback result should include params')
  t.absent(parsed.native, 'fallback result should not include native key')
})

test('_getDiagnosticsJSON fallback: returns JS-only info when native call throws', t => {
  const ocr = new TestOCRWithFailingNative({ params: { langList: ['en'] } })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok('status' in parsed, 'fallback result should include status on native error')
  t.ok('params' in parsed, 'fallback result should include params on native error')
  t.absent(parsed.native, 'fallback result should not include native key on native error')
})

test('_getDiagnosticsJSON merges native data under native key', t => {
  const nativeData = {
    onnxRuntimeVersion: '1.18.0',
    availableProviders: ['CPUExecutionProvider'],
    executionProvider: 'CPUExecutionProvider',
    pipelineMode: 'EasyOCR',
    detectorModelPath: '/models/detector.onnx',
    recognizerModelPath: '/models/recognizer_latin.onnx',
    modelLoaded: false,
    sessionOptions: { useGPU: false, optimization: 'EXTENDED' }
  }
  const ocr = new TestOCRWithMockNative({
    params: { langList: ['en'], useGPU: false },
    nativeResponse: JSON.stringify(nativeData)
  })

  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok('status' in parsed, 'merged result should include status')
  t.ok('params' in parsed, 'merged result should include params')
  t.ok('native' in parsed, 'merged result should include native key')
})

test('_getDiagnosticsJSON native key contains all expected native fields', t => {
  const nativeData = {
    onnxRuntimeVersion: '1.18.0',
    availableProviders: ['CPUExecutionProvider'],
    executionProvider: 'CPUExecutionProvider',
    pipelineMode: 'EasyOCR',
    detectorModelPath: '/models/detector.onnx',
    recognizerModelPath: '/models/recognizer_latin.onnx',
    modelLoaded: false,
    sessionOptions: { useGPU: false, optimization: 'EXTENDED' }
  }
  const ocr = new TestOCRWithMockNative({
    params: { langList: ['en'] },
    nativeResponse: JSON.stringify(nativeData)
  })

  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  const native = parsed.native

  t.ok('onnxRuntimeVersion' in native, 'native should include onnxRuntimeVersion')
  t.ok('availableProviders' in native, 'native should include availableProviders')
  t.ok('executionProvider' in native, 'native should include executionProvider')
  t.ok('pipelineMode' in native, 'native should include pipelineMode')
  t.ok('detectorModelPath' in native, 'native should include detectorModelPath')
  t.ok('recognizerModelPath' in native, 'native should include recognizerModelPath')
  t.ok('modelLoaded' in native, 'native should include modelLoaded')
  t.ok('sessionOptions' in native, 'native should include sessionOptions')
})

test('_getDiagnosticsJSON native sessionOptions contains useGPU and optimization', t => {
  const nativeData = {
    onnxRuntimeVersion: '1.18.0',
    availableProviders: ['CPUExecutionProvider'],
    executionProvider: 'CPUExecutionProvider',
    pipelineMode: 'EasyOCR',
    detectorModelPath: '/models/detector.onnx',
    recognizerModelPath: '/models/recognizer_latin.onnx',
    modelLoaded: false,
    sessionOptions: { useGPU: false, optimization: 'EXTENDED' }
  }
  const ocr = new TestOCRWithMockNative({
    params: { langList: ['en'] },
    nativeResponse: JSON.stringify(nativeData)
  })

  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  const sessionOpts = parsed.native.sessionOptions

  t.ok('useGPU' in sessionOpts, 'sessionOptions should include useGPU')
  t.ok('optimization' in sessionOpts, 'sessionOptions should include optimization')
})

test('_getDiagnosticsJSON native pipelineMode is EasyOCR or DocTR', t => {
  for (const mode of ['EasyOCR', 'DocTR']) {
    const nativeData = {
      onnxRuntimeVersion: '1.18.0',
      availableProviders: ['CPUExecutionProvider'],
      executionProvider: 'CPUExecutionProvider',
      pipelineMode: mode,
      detectorModelPath: '/models/detector.onnx',
      recognizerModelPath: '/models/recognizer.onnx',
      modelLoaded: false,
      sessionOptions: { useGPU: false, optimization: 'EXTENDED' }
    }
    const ocr = new TestOCRWithMockNative({
      params: { langList: ['en'] },
      nativeResponse: JSON.stringify(nativeData)
    })

    const parsed = JSON.parse(ocr._getDiagnosticsJSON())
    const pipelineMode = parsed.native.pipelineMode
    t.ok(pipelineMode === 'EasyOCR' || pipelineMode === 'DocTR',
      `pipelineMode "${pipelineMode}" should be EasyOCR or DocTR`)
  }
})

test('_getDiagnosticsJSON native modelLoaded is boolean', t => {
  for (const modelLoaded of [true, false]) {
    const nativeData = {
      onnxRuntimeVersion: '1.18.0',
      availableProviders: ['CPUExecutionProvider'],
      executionProvider: 'CPUExecutionProvider',
      pipelineMode: 'EasyOCR',
      detectorModelPath: '/models/detector.onnx',
      recognizerModelPath: '/models/recognizer.onnx',
      modelLoaded,
      sessionOptions: { useGPU: false, optimization: 'EXTENDED' }
    }
    const ocr = new TestOCRWithMockNative({
      params: { langList: ['en'] },
      nativeResponse: JSON.stringify(nativeData)
    })

    const parsed = JSON.parse(ocr._getDiagnosticsJSON())
    t.ok(typeof parsed.native.modelLoaded === 'boolean',
      `modelLoaded should be boolean, got ${typeof parsed.native.modelLoaded}`)
  }
})

test('_getDiagnosticsJSON native onnxRuntimeVersion is non-empty string', t => {
  const nativeData = {
    onnxRuntimeVersion: '1.18.0',
    availableProviders: ['CPUExecutionProvider'],
    executionProvider: 'CPUExecutionProvider',
    pipelineMode: 'EasyOCR',
    detectorModelPath: '/models/detector.onnx',
    recognizerModelPath: '/models/recognizer.onnx',
    modelLoaded: false,
    sessionOptions: { useGPU: false, optimization: 'EXTENDED' }
  }
  const ocr = new TestOCRWithMockNative({
    params: { langList: ['en'] },
    nativeResponse: JSON.stringify(nativeData)
  })

  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok(typeof parsed.native.onnxRuntimeVersion === 'string', 'onnxRuntimeVersion should be a string')
  t.ok(parsed.native.onnxRuntimeVersion.length > 0, 'onnxRuntimeVersion should not be empty')
})

test('_getDiagnosticsJSON native JS fields are not overwritten by native fields', t => {
  // status and params are JS-side fields and must not be clobbered when native data is merged
  const nativeData = {
    onnxRuntimeVersion: '1.18.0',
    availableProviders: ['CPUExecutionProvider'],
    executionProvider: 'CPUExecutionProvider',
    pipelineMode: 'EasyOCR',
    detectorModelPath: '/models/detector.onnx',
    recognizerModelPath: '/models/recognizer.onnx',
    modelLoaded: false,
    sessionOptions: { useGPU: false, optimization: 'EXTENDED' },
    // Adversarial: native payload contains a 'status' key
    status: 'native-status-should-not-win'
  }
  const ocr = new TestOCRWithMockNative({
    params: { langList: ['en'] },
    nativeResponse: JSON.stringify(nativeData)
  })
  ocr.state.configLoaded = true

  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  // JS spread is { ...jsInfo, native: nativeInfo } so status is from jsInfo
  t.is(parsed.status, 'loaded', 'JS status field should not be overwritten by native data')
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
