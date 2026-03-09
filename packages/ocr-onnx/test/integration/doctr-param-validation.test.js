'use strict'

const { ONNXOcr, QvacErrorAddonOcr, ERR_CODES } = require('../..')
const test = require('brittle')
const { isMobile, ensureDoctrModels } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 30 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

let DOCTR_DETECTOR
let DOCTR_RECOGNIZER

test('DocTR param validation - download models', { timeout: 180 * 1000 }, async function (t) {
  const models = await ensureDoctrModels(['db_resnet50.onnx', 'parseq.onnx'])
  DOCTR_DETECTOR = models.db_resnet50
  DOCTR_RECOGNIZER = models.parseq
  t.ok(DOCTR_DETECTOR, 'db_resnet50 model available')
  t.ok(DOCTR_RECOGNIZER, 'parseq model available')
})

test('DocTR load() rejects when pathRecognizer is missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'doctr'
    }
  })

  try {
    await onnxOcr.load()
    t.fail('Should have thrown for missing pathRecognizer in doctr mode')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('pathRecognizer'), 'Error message should mention pathRecognizer')
    t.pass('Correctly rejected missing pathRecognizer in doctr mode')
  }
})

test('DocTR load() rejects when pathDetector is missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'doctr'
    }
  })

  try {
    await onnxOcr.load()
    t.fail('Should have thrown for missing pathDetector in doctr mode')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('pathDetector'), 'Error message should mention pathDetector')
    t.pass('Correctly rejected missing pathDetector in doctr mode')
  }
})

test('DocTR load() defaults langList to ["en"] when omitted', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      useGPU: false,
      pipelineMode: 'doctr'
    }
  })

  try {
    await onnxOcr.load()
  } catch (err) {
    // May fail at C++ layer, but JS validation already ran
  }

  t.ok(Array.isArray(onnxOcr.params.langList), 'langList should be an array')
  t.is(onnxOcr.params.langList.length, 1, 'langList should have 1 element')
  t.is(onnxOcr.params.langList[0], 'en', 'langList should default to ["en"]')
  t.pass('DocTR correctly defaults langList to ["en"]')

  if (onnxOcr.addon) {
    try { await onnxOcr.unload() } catch (e) { /* ignore cleanup errors */ }
  }
})

test('DocTR load() does not reject unsupported languages (no filtering)', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['fr', 'klingon'],
      useGPU: false,
      pipelineMode: 'doctr'
    }
  })

  try {
    await onnxOcr.load()
  } catch (err) {
    // May fail at C++ layer, but langList should be preserved as-is
  }

  t.ok(onnxOcr.params.langList.includes('fr'), 'Should keep "fr"')
  t.ok(onnxOcr.params.langList.includes('klingon'), 'Should keep "klingon" (doctr skips language filtering)')
  t.is(onnxOcr.params.langList.length, 2, 'langList should be unchanged')
  t.pass('DocTR mode does not filter unsupported languages')

  if (onnxOcr.addon) {
    try { await onnxOcr.unload() } catch (e) { /* ignore cleanup errors */ }
  }
})

test('DocTR does not use pathRecognizerPrefix fallback', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizerPrefix: '/some/prefix/recognizer_',
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'doctr'
    }
  })

  try {
    await onnxOcr.load()
    t.fail('Should have thrown for missing pathRecognizer even with pathRecognizerPrefix')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('pathRecognizer'), 'Error should mention pathRecognizer not pathRecognizerPrefix')
    t.pass('DocTR correctly requires explicit pathRecognizer (no prefix fallback)')
  }
})

test('getModelKey returns different keys for easyocr and doctr modes', { timeout: TEST_TIMEOUT }, async function (t) {
  const easyocrKey = ONNXOcr.getModelKey({ pipelineMode: 'easyocr' })
  const doctrKey = ONNXOcr.getModelKey({ pipelineMode: 'doctr' })
  const defaultKey = ONNXOcr.getModelKey({})
  const nullKey = ONNXOcr.getModelKey(null)

  t.ok(easyocrKey.includes('easyocr'), 'EasyOCR key should contain "easyocr"')
  t.ok(doctrKey.includes('doctr'), 'DocTR key should contain "doctr"')
  t.is(defaultKey, easyocrKey, 'Default mode should produce same key as explicit easyocr')
  t.is(nullKey, easyocrKey, 'Null params should produce same key as easyocr (default)')
  t.not(easyocrKey, doctrKey, 'EasyOCR and DocTR keys must be different')
  t.pass('getModelKey correctly differentiates pipeline modes')
})
