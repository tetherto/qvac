'use strict'

const test = require('brittle')
const { getImagePath, formatOCRPerformanceMetrics, runDoctrOCR, ensureDoctrModels } = require('./utils')

const TEST_TIMEOUT = 180 * 1000

let DOCTR_DETECTOR
let DOCTR_RECOGNIZER

test('DocTR french - download models', { timeout: TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels(['db_resnet50.onnx', 'parseq.onnx'])
  DOCTR_DETECTOR = models.db_resnet50
  DOCTR_RECOGNIZER = models.parseq
  t.ok(DOCTR_DETECTOR, 'db_resnet50 model available')
  t.ok(DOCTR_RECOGNIZER, 'parseq model available')
})

test('DocTR french test - accented characters', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/french.bmp')

  t.comment('Testing DocTR pipeline with French image (accented chars): ' + imagePath)

  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DOCTR_DETECTOR,
    pathRecognizer: DOCTR_RECOGNIZER,
    langList: ['fr'],
    decodingMethod: 'attention'
  }, imagePath)

  const outputTexts = results.map(r => r.text)
  t.ok(results.length > 0, `should detect text regions, got ${results.length}`)
  t.comment('Detected texts (French): ' + JSON.stringify(outputTexts))
  t.comment('Full output: ' + JSON.stringify(results.map(r => ({
    text: r.text,
    confidence: r.confidence
  }))))

  // Check for accented characters in the output
  const hasAccent = outputTexts.some(t =>
    /[àâéèêëîïôùûüçÀÂÉÈÊËÎÏÔÙÛÜÇ]/.test(t)
  )
  t.comment('Contains accented characters: ' + hasAccent)

  t.comment(formatOCRPerformanceMetrics('[DocTR French]', stats, outputTexts, { skipReport: true }))
  t.pass('DocTR French test completed successfully')
})
