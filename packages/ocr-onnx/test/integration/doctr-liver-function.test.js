'use strict'

const test = require('brittle')
const { getImagePath, formatOCRPerformanceMetrics, runDoctrOCR, ensureDoctrModels } = require('./utils')

const DOCTR_TEST_TIMEOUT = 180 * 1000

let DB_MOBILENET
let CRNN_MOBILENET

test('DocTR liver function - download models', { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels(['db_mobilenet_v3_large.onnx', 'crnn_mobilenet_v3_small.onnx'])
  DB_MOBILENET = models.db_mobilenet_v3_large
  CRNN_MOBILENET = models.crnn_mobilenet_v3_small
  t.ok(DB_MOBILENET, 'db_mobilenet model available')
  t.ok(CRNN_MOBILENET, 'crnn_mobilenet model available')
})

test('DocTR liver function - db_mobilenet + crnn_mobilenet with straightenPages', { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/liver_function_test.png')

  t.comment('Testing DocTR on liver function test (LFT) image')
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
  t.comment(formatOCRPerformanceMetrics('[DocTR liver_function_test]', stats, texts, { imagePath }))

  t.ok(results.length > 0, `should detect text regions, got ${results.length}`)

  const lowerTexts = texts.map(w => w.toLowerCase())

  const expectedWords = [
    'bilirubin', 'sgot', 'sgpt', 'alkaline', 'phosphatase',
    'albumin', 'globulin', 'protein', 'serum', 'liver'
  ]
  for (const word of expectedWords) {
    t.ok(
      lowerTexts.some(w => w.includes(word)),
      `should detect "${word}" in liver function test report`
    )
  }

  t.pass('DocTR liver function test completed successfully')
})
