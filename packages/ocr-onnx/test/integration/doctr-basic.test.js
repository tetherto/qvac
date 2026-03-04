'use strict'

const test = require('brittle')
const { getImagePath, formatOCRPerformanceMetrics, ensureDoctrModels, runDoctrOCR } = require('./utils')

const TEST_TIMEOUT = 300 * 1000

let DOCTR_DETECTOR
let DOCTR_RECOGNIZER

test('DocTR basic - download models', { timeout: TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels(['db_resnet50.onnx', 'parseq.onnx'])
  DOCTR_DETECTOR = models.db_resnet50
  DOCTR_RECOGNIZER = models.parseq
  t.ok(DOCTR_DETECTOR, 'db_resnet50 model available')
  t.ok(DOCTR_RECOGNIZER, 'parseq model available')
})

test('DocTR basic - BMP image', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/basic_test.bmp')
  t.comment('Detector: ' + DOCTR_DETECTOR)
  t.comment('Recognizer: ' + DOCTR_RECOGNIZER)

  const params = {
    pathDetector: DOCTR_DETECTOR,
    pathRecognizer: DOCTR_RECOGNIZER,
    decodingMethod: 'attention'
  }

  const { results, stats } = await runDoctrOCR(t, params, imagePath)

  const outputTexts = results.map(r => r.text)
  t.ok(results.length > 0, `BMP: should detect text regions, got ${results.length}`)
  t.comment('BMP detected texts: ' + JSON.stringify(outputTexts))
  t.comment(formatOCRPerformanceMetrics('[DocTR BMP]', stats, outputTexts))
})

test('DocTR basic - JPEG image', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/basic_test.jpg')

  const params = {
    pathDetector: DOCTR_DETECTOR,
    pathRecognizer: DOCTR_RECOGNIZER,
    decodingMethod: 'attention'
  }

  const { results, stats } = await runDoctrOCR(t, params, imagePath)

  const outputTexts = results.map(r => r.text)
  t.ok(results.length > 0, `JPEG: should detect text regions, got ${results.length}`)
  t.comment('JPEG detected texts: ' + JSON.stringify(outputTexts))
  t.comment(formatOCRPerformanceMetrics('[DocTR JPEG]', stats, outputTexts))
})

test('DocTR basic - English image', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')

  const params = {
    pathDetector: DOCTR_DETECTOR,
    pathRecognizer: DOCTR_RECOGNIZER,
    decodingMethod: 'attention'
  }

  const { results, stats } = await runDoctrOCR(t, params, imagePath)

  const outputTexts = results.map(r => r.text)
  t.ok(results.length > 0, `English: should detect text regions, got ${results.length}`)
  t.comment('English detected texts: ' + JSON.stringify(outputTexts))
  t.comment(formatOCRPerformanceMetrics('[DocTR English]', stats, outputTexts))
})
