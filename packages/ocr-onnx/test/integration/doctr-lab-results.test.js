'use strict'

const test = require('brittle')
const { getImagePath, formatOCRPerformanceMetrics, runDoctrOCR, ensureDoctrModels } = require('./utils')

const DOCTR_TEST_TIMEOUT = 180 * 1000

let DB_MOBILENET
let CRNN_MOBILENET

test('DocTR lab results - download models', { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels(['db_mobilenet_v3_large.onnx', 'crnn_mobilenet_v3_small.onnx'])
  DB_MOBILENET = models.db_mobilenet_v3_large
  CRNN_MOBILENET = models.crnn_mobilenet_v3_small
  t.ok(DB_MOBILENET, 'db_mobilenet model available')
  t.ok(CRNN_MOBILENET, 'crnn_mobilenet model available')
})

test('DocTR lab results - db_mobilenet + crnn_mobilenet with straightenPages', { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/lab_results.png')

  t.comment('Testing DocTR on medical lab results image')
  t.comment('Detector: db_mobilenet_v3_large, Recognizer: crnn_mobilenet_v3_small (CTC)')
  t.comment('straightenPages: true')

  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    decodingMethod: 'ctc',
    straightenPages: true
  }, imagePath)

  const texts = results.map(r => r.text)
  t.comment('Detected texts: ' + JSON.stringify(texts))
  t.comment('Full output: ' + JSON.stringify(results.map(r => ({
    text: r.text,
    confidence: r.confidence.toFixed(3)
  })), null, 2))
  t.comment(formatOCRPerformanceMetrics('[DocTR lab_results]', stats, texts))

  t.ok(results.length > 0, `should detect text regions, got ${results.length}`)

  // Verify some expected words from the lab results document
  const lowerTexts = texts.map(w => w.toLowerCase())
  t.comment('Lowercase texts: ' + JSON.stringify(lowerTexts))

  const expectedWords = [
    'parameter', 'results', 'calculated', 'direct', 'values', 'clinical', 'blood', 'patient'
  ]
  for (const word of expectedWords) {
    t.ok(
      lowerTexts.some(w => w.includes(word)),
      `should detect "${word}" in lab results`
    )
  }

  t.pass('DocTR lab results test completed successfully')
})
