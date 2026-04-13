'use strict'

const test = require('brittle')
const { getImagePath, formatOCRPerformanceMetrics, runDoctrOCR, ensureDoctrModels } = require('./utils')

const DOCTR_TEST_TIMEOUT = 180 * 1000

let DB_MOBILENET
let CRNN_MOBILENET
let modelsAvailable = false

test('DocTR clinical chemistry - download models', { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels(['db_mobilenet_v3_large.onnx', 'crnn_mobilenet_v3_small.onnx'])
  if (!models) {
    t.comment('DocTR models unavailable (download failed) — remaining tests will be skipped')
    return
  }
  DB_MOBILENET = models.db_mobilenet_v3_large
  CRNN_MOBILENET = models.crnn_mobilenet_v3_small
  modelsAvailable = true
  t.ok(DB_MOBILENET, 'db_mobilenet model available')
  t.ok(CRNN_MOBILENET, 'crnn_mobilenet model available')
})

test('DocTR clinical chemistry - db_mobilenet + crnn_mobilenet with straightenPages', { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
  if (!modelsAvailable) { t.comment('Skipped — models unavailable'); return }
  const imagePath = getImagePath('/test/images/clinical_chemistry.png')

  t.comment('Testing DocTR on clinical chemistry lab result image')
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
  t.comment(formatOCRPerformanceMetrics('[DocTR clinical_chemistry]', stats, texts, { imagePath }))

  t.ok(results.length > 0, `should detect text regions, got ${results.length}`)

  const lowerTexts = texts.map(w => w.toLowerCase())

  const expectedWords = [
    'clinical', 'chemistry', 'alkaline', 'phosphatase',
    'hemoglobin', 'creatinine', 'cholesterol', 'triglycerides',
    'bilirubin', 'albumin', 'protein', 'lipid'
  ]
  for (const word of expectedWords) {
    t.ok(
      lowerTexts.some(w => w.includes(word)),
      `should detect "${word}" in clinical chemistry report`
    )
  }

  t.pass('DocTR clinical chemistry test completed successfully')
})
