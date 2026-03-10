'use strict'

const test = require('brittle')
const { isMobile, getImagePath, formatOCRPerformanceMetrics, ensureDoctrModels, runDoctrOCR } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 180 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

let DOCTR_DETECTOR
let DOCTR_RECOGNIZER

test('DocTR scaling - download models', { timeout: TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels(['db_mobilenet_v3_large.onnx', 'crnn_mobilenet_v3_small.onnx'])
  DOCTR_DETECTOR = models.db_mobilenet_v3_large
  DOCTR_RECOGNIZER = models.crnn_mobilenet_v3_small
  t.ok(DOCTR_DETECTOR, 'db_mobilenet model available')
  t.ok(DOCTR_RECOGNIZER, 'crnn_mobilenet model available')
})

test('DocTR scaling - coordinates in original space and output structure', { timeout: TEST_TIMEOUT }, async function (t) {
  // portuguese.bmp is 1372x781 — larger than the internal resize threshold
  const imagePath = getImagePath('/test/images/portuguese.bmp')
  const originalImageWidth = 1372
  const originalImageHeight = 781

  t.comment('Testing with image: ' + imagePath + ' (' + originalImageWidth + 'x' + originalImageHeight + ')')

  const params = {
    pathDetector: DOCTR_DETECTOR,
    pathRecognizer: DOCTR_RECOGNIZER,
    decodingMethod: 'ctc'
  }

  const { results, stats } = await runDoctrOCR(t, params, imagePath)

  t.ok(results.length > 0, 'Should detect at least one text region')
  t.comment('Detected ' + results.length + ' text regions')

  let maxX = 0
  let maxY = 0

  for (const r of results) {
    // Validate output structure
    t.ok(typeof r.text === 'string', 'text should be a string')
    t.ok(r.text.length > 0, 'text should not be empty')
    t.ok(typeof r.confidence === 'number', 'confidence should be a number')
    t.ok(r.confidence >= 0 && r.confidence <= 1, 'confidence should be in [0, 1]')

    t.ok(Array.isArray(r.bbox), 'bbox should be an array')
    t.is(r.bbox.length, 4, 'bbox should have 4 points')

    for (const point of r.bbox) {
      t.ok(Array.isArray(point), 'Each bbox point should be an array')
      t.is(point.length, 2, 'Each bbox point should have 2 coordinates')
      t.ok(typeof point[0] === 'number', 'X coordinate should be a number')
      t.ok(typeof point[1] === 'number', 'Y coordinate should be a number')

      if (point[0] > maxX) maxX = point[0]
      if (point[1] > maxY) maxY = point[1]
    }
  }

  t.comment('Max X: ' + maxX.toFixed(1) + ', Max Y: ' + maxY.toFixed(1))
  t.ok(maxX <= originalImageWidth, 'Max X should not exceed original width (' + originalImageWidth + ')')
  t.ok(maxY <= originalImageHeight, 'Max Y should not exceed original height (' + originalImageHeight + ')')

  const outputTexts = results.map(r => r.text)
  t.comment(formatOCRPerformanceMetrics('[DocTR scaling]', stats, outputTexts))
  t.pass('Coordinate scaling and output structure verified')
})
