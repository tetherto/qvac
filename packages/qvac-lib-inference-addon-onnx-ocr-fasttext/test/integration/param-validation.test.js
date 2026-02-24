'use strict'

const { ONNXOcr } = require('../..')
const { QvacErrorAddonOcr, ERR_CODES } = require('../..')
const test = require('brittle')
const { isMobile } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 30 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

test('load() rejects when langList is missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
      useGPU: false
    }
  })

  try {
    await onnxOcr.load()
    t.fail('Should have thrown for missing langList')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('langList'), 'Error message should mention langList')
    t.pass('Correctly rejected missing langList')
  }
})

test('load() rejects when langList is empty array after filtering', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
      langList: ['klingon', 'elvish', 'dothraki'],
      useGPU: false
    }
  })

  try {
    await onnxOcr.load()
    t.fail('Should have thrown for all-unsupported languages')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.UNSUPPORTED_LANGUAGE, 'Error code should be UNSUPPORTED_LANGUAGE')
    t.pass('Correctly rejected all-unsupported language list')
  }
})

test('load() rejects when pathDetector is missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
      langList: ['en'],
      useGPU: false
    }
  })

  try {
    await onnxOcr.load()
    t.fail('Should have thrown for missing pathDetector')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('pathDetector'), 'Error message should mention pathDetector')
    t.pass('Correctly rejected missing pathDetector')
  }
})

test('load() rejects when both pathRecognizer and pathRecognizerPrefix are missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      langList: ['en'],
      useGPU: false
    }
  })

  try {
    await onnxOcr.load()
    t.fail('Should have thrown for missing pathRecognizer and pathRecognizerPrefix')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('pathRecognizer') || err.message.includes('pathRecognizerPrefix'),
      'Error message should mention pathRecognizer or pathRecognizerPrefix')
    t.pass('Correctly rejected missing recognizer path')
  }
})

test('load() filters unsupported languages before reaching C++ layer', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
      langList: ['en', 'klingon', 'fr', 'elvish'],
      useGPU: false
    }
  })

  try {
    await onnxOcr.load()
  } catch (err) {
    // May fail at C++ layer (model files not found), but validation already ran
  }

  t.ok(onnxOcr.params.langList.includes('en'), 'Should keep supported language "en"')
  t.ok(onnxOcr.params.langList.includes('fr'), 'Should keep supported language "fr"')
  t.ok(!onnxOcr.params.langList.includes('klingon'), 'Should have removed unsupported "klingon"')
  t.ok(!onnxOcr.params.langList.includes('elvish'), 'Should have removed unsupported "elvish"')
  t.is(onnxOcr.params.langList.length, 2, 'Should have exactly 2 supported languages remaining')
  t.pass('Language filtering works correctly before C++ addon creation')
})

test('load() constructs recognizer path from prefix before reaching C++ layer', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      pathRecognizerPrefix: 'models/ocr/rec_dyn/recognizer_',
      langList: ['en'],
      useGPU: false
    }
  })

  try {
    await onnxOcr.load()
  } catch (err) {
    // May fail at C++ layer (model files not found), but path was constructed
  }

  t.ok(onnxOcr.params.pathRecognizer.includes('recognizer_latin'), 'Should construct recognizer path with latin model')
  t.ok(onnxOcr.params.pathRecognizer.endsWith('.onnx'), 'Constructed path should end with .onnx')
  t.pass('Path construction from prefix works correctly')
})
