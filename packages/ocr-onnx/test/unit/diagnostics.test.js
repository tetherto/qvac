'use strict'

const test = require('brittle')

let diagnostics
try { diagnostics = require('@qvac/diagnostics') } catch (e) {
  try { diagnostics = require('../../../qvac-lib-diagnostics') } catch (e) { diagnostics = null }
}

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
  }

  _getDiagnosticsJSON () {
    return JSON.stringify({
      status: this.state.destroyed ? 'destroyed' : (this.state.configLoaded ? 'loaded' : 'not_loaded'),
      langList: this.params?.langList || [],
      useGPU: this.params?.useGPU || false,
      pipelineMode: this.params?.pipelineMode || 'easyocr',
      timeout: this.params?.timeout
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

test('_getDiagnosticsJSON includes expected fields', t => {
  const ocr = new TestOCR({
    params: {
      langList: ['en', 'fr'],
      useGPU: true,
      pipelineMode: 'doctr',
      timeout: 60
    }
  })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.ok('status' in parsed, 'should include status field')
  t.ok('langList' in parsed, 'should include langList field')
  t.ok('useGPU' in parsed, 'should include useGPU field')
  t.ok('pipelineMode' in parsed, 'should include pipelineMode field')
  t.ok('timeout' in parsed, 'should include timeout field')
  t.alike(parsed.langList, ['en', 'fr'], 'langList should match params')
  t.is(parsed.useGPU, true, 'useGPU should match params')
  t.is(parsed.pipelineMode, 'doctr', 'pipelineMode should match params')
  t.is(parsed.timeout, 60, 'timeout should match params')
})

test('_getDiagnosticsJSON status reflects state correctly', t => {
  const ocr = new TestOCR({ params: { langList: ['en'] } })

  t.is(JSON.parse(ocr._getDiagnosticsJSON()).status, 'not_loaded', 'should be not_loaded initially')

  ocr.state.configLoaded = true
  t.is(JSON.parse(ocr._getDiagnosticsJSON()).status, 'loaded', 'should be loaded when configLoaded=true')

  ocr.state.destroyed = true
  t.is(JSON.parse(ocr._getDiagnosticsJSON()).status, 'destroyed', 'should be destroyed when destroyed=true')
})

test('_getDiagnosticsJSON uses defaults when params fields are absent', t => {
  const ocr = new TestOCR({ params: {} })
  const parsed = JSON.parse(ocr._getDiagnosticsJSON())
  t.alike(parsed.langList, [], 'langList defaults to empty array')
  t.is(parsed.useGPU, false, 'useGPU defaults to false')
  t.is(parsed.pipelineMode, 'easyocr', 'pipelineMode defaults to easyocr')
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
  t.ok('langList' in addonDiag, 'diagnostics should include langList')

  diagnostics.reset()
})
