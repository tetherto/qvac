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

test('DocTR basic - PNG image', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/basic_test.png')

  const params = {
    pathDetector: DOCTR_DETECTOR,
    pathRecognizer: DOCTR_RECOGNIZER,
    decodingMethod: 'attention'
  }

  const { results, stats } = await runDoctrOCR(t, params, imagePath)

  const outputTexts = results.map(r => r.text)
  t.ok(results.length > 0, `PNG: should detect text regions, got ${results.length}`)
  t.comment('PNG detected texts: ' + JSON.stringify(outputTexts))
  t.comment(formatOCRPerformanceMetrics('[DocTR PNG]', stats, outputTexts))
})

test('DocTR basic - cross-format consistency (BMP vs JPEG vs PNG)', { timeout: TEST_TIMEOUT * 3 }, async function (t) {
  const params = {
    pathDetector: DOCTR_DETECTOR,
    pathRecognizer: DOCTR_RECOGNIZER,
    decodingMethod: 'attention'
  }

  const bmpPath = getImagePath('/test/images/basic_test.bmp')
  const jpegPath = getImagePath('/test/images/basic_test.jpg')
  const pngPath = getImagePath('/test/images/basic_test.png')

  const { results: bmpResults } = await runDoctrOCR(t, params, bmpPath)
  const { results: jpegResults } = await runDoctrOCR(t, params, jpegPath)
  const { results: pngResults } = await runDoctrOCR(t, params, pngPath)

  const bmpTexts = bmpResults.map(r => r.text.toLowerCase())
  const jpegTexts = jpegResults.map(r => r.text.toLowerCase())
  const pngTexts = pngResults.map(r => r.text.toLowerCase())

  t.comment('BMP texts: ' + JSON.stringify(bmpTexts))
  t.comment('JPEG texts: ' + JSON.stringify(jpegTexts))
  t.comment('PNG texts: ' + JSON.stringify(pngTexts))

  t.ok(bmpResults.length > 0, 'BMP should detect text')
  t.ok(jpegResults.length > 0, 'JPEG should detect text')
  t.ok(pngResults.length > 0, 'PNG should detect text')

  // All formats should detect "normal" (the horizontal text in basic_test)
  t.ok(bmpTexts.some(w => w.includes('normal')), 'BMP should detect "normal"')
  t.ok(jpegTexts.some(w => w.includes('normal')), 'JPEG should detect "normal"')
  t.ok(pngTexts.some(w => w.includes('normal')), 'PNG should detect "normal"')

  t.pass('Cross-format consistency verified')
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
