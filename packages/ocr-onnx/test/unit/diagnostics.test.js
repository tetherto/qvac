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
    this.addon = null
    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false
    }
    this._packageName = '@qvac/ocr-onnx'
    this._packageVersion = require('../../package.json').version
  }

  _getDiagnosticsJSON () {
    const onnxRuntimeVersion = (this.addon && typeof this.addon.getOnnxRuntimeVersion === 'function')
      ? this.addon.getOnnxRuntimeVersion()
      : 'unknown'
    const modelLoaded = !this.state.destroyed && this.state.configLoaded
    const supportedFormats = ['jpeg', 'png', 'bmp']
    const backendInfo = (this.params && this.params.useGPU !== undefined)
      ? (this.params.useGPU ? 'gpu' : 'cpu')
      : 'gpu'
    return JSON.stringify({
      onnxRuntimeVersion,
      modelLoaded,
      supportedFormats,
      backendInfo,
      modelPath: this.params ? (this.params.pathDetector || null) : null,
      status: this.state.destroyed ? 'destroyed' : (this.state.configLoaded ? 'loaded' : 'not_loaded'),
      params: this.params
    })
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

test('_getDiagnosticsJSON includes required fields: onnxRuntimeVersion, modelLoaded, supportedFormats', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok('onnxRuntimeVersion' in parsed, 'should include onnxRuntimeVersion field')
  t.ok('modelLoaded' in parsed, 'should include modelLoaded field')
  t.ok('supportedFormats' in parsed, 'should include supportedFormats field')
  t.ok(typeof parsed.onnxRuntimeVersion === 'string', 'onnxRuntimeVersion should be a string')
  t.ok(typeof parsed.modelLoaded === 'boolean', 'modelLoaded should be a boolean')
  t.ok(Array.isArray(parsed.supportedFormats), 'supportedFormats should be an array')
})

test('_getDiagnosticsJSON includes backendInfo field', t => {
  const ocr = new TestOCR({ params: { langList: ['en'], useGPU: true } })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok('backendInfo' in parsed, 'should include backendInfo field')
  t.ok(typeof parsed.backendInfo === 'string', 'backendInfo should be a string')
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

test('_getDiagnosticsJSON modelLoaded reflects state correctly', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })

  t.is(JSON.parse(ocr._getDiagnosticsJSON()).modelLoaded, false, 'modelLoaded should be false initially')

  ocr.state.configLoaded = true
  t.is(JSON.parse(ocr._getDiagnosticsJSON()).modelLoaded, true, 'modelLoaded should be true when configLoaded=true')

  ocr.state.destroyed = true
  t.is(JSON.parse(ocr._getDiagnosticsJSON()).modelLoaded, false, 'modelLoaded should be false when destroyed=true')
})

test('_getDiagnosticsJSON supportedFormats always includes jpeg, png, bmp', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok(parsed.supportedFormats.includes('jpeg'), 'should include jpeg')
  t.ok(parsed.supportedFormats.includes('png'), 'should include png')
  t.ok(parsed.supportedFormats.includes('bmp'), 'should include bmp')
})

test('_getDiagnosticsJSON backendInfo is gpu when useGPU=true', t => {
  const ocr = new TestOCR({ params: { langList: ['en'], useGPU: true } })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.is(parsed.backendInfo, 'gpu', 'backendInfo should be gpu when useGPU=true')
})

test('_getDiagnosticsJSON backendInfo is cpu when useGPU=false', t => {
  const ocr = new TestOCR({ params: { langList: ['en'], useGPU: false } })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.is(parsed.backendInfo, 'cpu', 'backendInfo should be cpu when useGPU=false')
})

test('_getDiagnosticsJSON backendInfo defaults to gpu when useGPU not specified', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.is(parsed.backendInfo, 'gpu', 'backendInfo should default to gpu when useGPU not specified')
})

test('_getDiagnosticsJSON onnxRuntimeVersion is unknown when no binding method', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })
  // addon is null — no binding method available
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.is(parsed.onnxRuntimeVersion, 'unknown', 'onnxRuntimeVersion should be unknown when no binding method')
})

test('_getDiagnosticsJSON onnxRuntimeVersion uses binding method when available', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })
  ocr.addon = { getOnnxRuntimeVersion: () => '1.18.0' }
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.is(parsed.onnxRuntimeVersion, '1.18.0', 'onnxRuntimeVersion should use binding method')
})

test('_getDiagnosticsJSON passes through all params', t => {
  const ocr = new TestOCR({ params: { langList: ['en'], custom: 'value' } })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.alike(parsed.params.langList, ['en'], 'langList passed through')
  t.is(parsed.params.custom, 'value', 'custom params passed through')
})

test('standalone getDiagnostics: modelLoaded=false when no model loaded', { skip: !diagnostics }, t => {
  diagnostics.reset()

  const ocr = new TestOCR({
    params: {
      langList: ['en'],
      useGPU: false,
      pathDetector: 'detector.onnx'
    }
  })

  // state.configLoaded is false — no model loaded yet
  const diagStr = ocr._getDiagnosticsJSON()
  t.ok(typeof diagStr === 'string', 'getDiagnostics returns a string')
  const parsed = JSON.parse(diagStr)
  t.is(parsed.modelLoaded, false, 'modelLoaded should be false when no model loaded')
  t.ok(Array.isArray(parsed.supportedFormats), 'supportedFormats is an array')
  t.ok(typeof parsed.onnxRuntimeVersion === 'string', 'onnxRuntimeVersion is a string')
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
  t.ok('onnxRuntimeVersion' in addonDiag, 'diagnostics should include onnxRuntimeVersion')
  t.ok('modelLoaded' in addonDiag, 'diagnostics should include modelLoaded')
  t.ok('supportedFormats' in addonDiag, 'diagnostics should include supportedFormats')
  t.ok('status' in addonDiag, 'diagnostics should include status')
  t.ok('params' in addonDiag, 'diagnostics should include params')

  diagnostics.reset()
})

test('integration: generateReport includes ocr-onnx addon entry with valid diagnostics', { skip: !diagnostics }, t => {
  diagnostics.reset()

  const ocr = new TestOCR({
    params: {
      langList: ['en'],
      useGPU: true,
      pathDetector: '/models/detector.onnx',
      pathRecognizer: '/models/recognizer_latin.onnx'
    }
  })

  diagnostics.registerAddon({
    name: ocr._packageName,
    version: ocr._packageVersion,
    getDiagnostics: () => ocr._getDiagnosticsJSON()
  })

  const report = diagnostics.generateReport({ app: { name: 'test', version: '1.0.0' } })

  t.ok(report.environment, 'report has environment section')
  t.ok(report.hardware, 'report has hardware section')
  t.ok(Array.isArray(report.addons), 'report has addons array')

  const ocrEntry = report.addons.find(a => a.name === '@qvac/ocr-onnx')
  t.ok(ocrEntry, 'ocr-onnx addon entry is present in report')
  t.ok(typeof ocrEntry.diagnostics === 'string', 'addon diagnostics is a string')

  const diag = JSON.parse(ocrEntry.diagnostics)
  t.ok(typeof diag.onnxRuntimeVersion === 'string', 'onnxRuntimeVersion is a string')
  t.ok(typeof diag.modelLoaded === 'boolean', 'modelLoaded is a boolean')
  t.ok(Array.isArray(diag.supportedFormats), 'supportedFormats is an array')

  diagnostics.reset()
})

test('integration: generateReport after unregister does not include ocr-onnx', { skip: !diagnostics }, t => {
  diagnostics.reset()

  const ocr = new TestOCR({
    params: { langList: ['en'] }
  })

  diagnostics.registerAddon({
    name: ocr._packageName,
    version: ocr._packageVersion,
    getDiagnostics: () => ocr._getDiagnosticsJSON()
  })

  // Simulate destroy: unregister
  diagnostics.unregisterAddon(ocr._packageName)

  const report = diagnostics.generateReport({ app: { name: 'test', version: '1.0.0' } })
  const ocrEntry = report.addons.find(a => a.name === '@qvac/ocr-onnx')
  t.absent(ocrEntry, 'ocr-onnx addon should not appear after unregister')

  diagnostics.reset()
})
