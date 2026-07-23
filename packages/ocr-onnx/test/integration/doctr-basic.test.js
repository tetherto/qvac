'use strict'

const test = require('brittle')
const { getImagePath, formatOCRPerformanceMetrics, ensureDoctrModels, runDoctrOCR } = require('./utils')

const TEST_TIMEOUT = 300 * 1000

// Words from english.bmp (WHO coronavirus infographic). At least 7 of 10 must be recognized
// to catch OCR accuracy regressions without being overly strict.
const ENGLISH_RECOGNITION_WORDS = [
  'health', 'world', 'cook', 'soap', 'water', 'hands', 'reduce', 'risk', 'avoid', 'symptoms'
]

/**
 * Assert at least minMatch of expectedWords appear in recognition results (substring match).
 * Catches accuracy regressions while tolerating minor OCR variation.
 */
function assertRecognitionAccuracy (t, texts, expectedWords, minMatch, label) {
  const lowerTexts = texts.map(w => w.toLowerCase())
  const found = expectedWords.filter(word =>
    lowerTexts.some(txt => txt.includes(word.toLowerCase()))
  )
  t.ok(
    found.length >= minMatch,
    `${label}: at least ${minMatch}/${expectedWords.length} words recognized (got ${found.length}: ${JSON.stringify(found)})`
  )
}

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
  // DocTR on basic_test: only "normal" (horizontal) is reliably detected across CI (Linux, Windows, macOS);
  // tilted/vertical vary by platform and DocTR lacks per-crop rotation handling (unlike EasyOCR).
  t.ok(outputTexts.some(w => w.toLowerCase().includes('normal')), 'BMP should detect "normal"')
  t.comment('BMP detected texts: ' + JSON.stringify(outputTexts))
  t.comment(formatOCRPerformanceMetrics('[DocTR BMP]', stats, outputTexts, { skipReport: true }))
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
  t.ok(outputTexts.some(w => w.toLowerCase().includes('normal')), 'JPEG should detect "normal"')
  t.comment('JPEG detected texts: ' + JSON.stringify(outputTexts))
  t.comment(formatOCRPerformanceMetrics('[DocTR JPEG]', stats, outputTexts, { skipReport: true }))
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
  t.ok(outputTexts.some(w => w.toLowerCase().includes('normal')), 'PNG should detect "normal"')
  t.comment('PNG detected texts: ' + JSON.stringify(outputTexts))
  t.comment(formatOCRPerformanceMetrics('[DocTR PNG]', stats, outputTexts, { skipReport: true }))
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

  // Recognition accuracy: at least 7 of 10 expected words to catch OCR regressions
  assertRecognitionAccuracy(t, outputTexts, ENGLISH_RECOGNITION_WORDS, 7, 'English')

  // english.bmp is 905x480 — verify coordinates are in original image space
  let coordsInBounds = true
  for (const r of results) {
    for (const point of r.bbox) {
      if (point[0] < 0 || point[0] > 905 || point[1] < 0 || point[1] > 480) {
        coordsInBounds = false
      }
    }
  }
  t.ok(coordsInBounds, 'All bbox coordinates within image bounds (905x480)')

  t.comment('English detected texts: ' + JSON.stringify(outputTexts))
  t.comment(formatOCRPerformanceMetrics('[DocTR English]', stats, outputTexts, { skipReport: true }))
})
