'use strict'

const test = require('brittle')
const { getImagePath, formatOCRPerformanceMetrics, runDoctrOCR, ensureDoctrModels } = require('./utils')

const TEST_TIMEOUT = 180 * 1000

let DOCTR_DETECTOR
let DOCTR_RECOGNIZER
let DOCTR_PARAMS

test('DocTR basic - download models', { timeout: TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels(['db_resnet50.onnx', 'parseq.onnx'])
  DOCTR_DETECTOR = models.db_resnet50
  DOCTR_RECOGNIZER = models.parseq
  DOCTR_PARAMS = {
    pathDetector: DOCTR_DETECTOR,
    pathRecognizer: DOCTR_RECOGNIZER
  }
  t.ok(DOCTR_DETECTOR, 'db_resnet50 model available')
  t.ok(DOCTR_RECOGNIZER, 'parseq model available')
})

test('DocTR basic test - basic_test image (BMP)', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  t.comment('Testing DocTR pipeline with image: ' + imagePath)
  t.comment('Detector: ' + DOCTR_DETECTOR)
  t.comment('Recognizer: ' + DOCTR_RECOGNIZER)

  const { results, stats } = await runDoctrOCR(t, DOCTR_PARAMS, imagePath)

  const outputTexts = results.map(r => r.text)
  t.ok(results.length > 0, `should detect text regions, got ${results.length}`)
  t.comment('Detected texts: ' + JSON.stringify(outputTexts))
  t.comment('Full output: ' + JSON.stringify(results.map(r => ({
    text: r.text,
    confidence: r.confidence,
    bbox: r.bbox
  }))))

  t.comment('DocTR stats: ' + JSON.stringify(stats))
  t.comment(formatOCRPerformanceMetrics('[DocTR]', stats, outputTexts))

  const lowerTexts = outputTexts.map(t => t.toLowerCase())
  t.comment('Lowercase texts: ' + JSON.stringify(lowerTexts))

  t.pass('DocTR basic test completed successfully')
})

test('DocTR basic test - basic_test image (JPEG)', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/basic_test.jpg')

  t.comment('Testing DocTR pipeline with JPEG image: ' + imagePath)

  const { results, stats } = await runDoctrOCR(t, DOCTR_PARAMS, imagePath)

  const outputTexts = results.map(r => r.text)
  t.comment('Detected texts (JPEG): ' + JSON.stringify(outputTexts))
  t.comment(formatOCRPerformanceMetrics('[DocTR JPEG]', stats, outputTexts))
  t.pass('DocTR JPEG test completed successfully')
})

test('DocTR basic test - english image (BMP)', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')

  t.comment('Testing DocTR pipeline with English image: ' + imagePath)

  const { results, stats } = await runDoctrOCR(t, DOCTR_PARAMS, imagePath)

  const outputTexts = results.map(r => r.text)
  t.comment('Detected texts (English): ' + JSON.stringify(outputTexts))
  t.comment('Full output: ' + JSON.stringify(results.map(r => ({
    text: r.text,
    confidence: r.confidence
  }))))
  t.comment(formatOCRPerformanceMetrics('[DocTR English]', stats, outputTexts))
  t.pass('DocTR English test completed successfully')
})
