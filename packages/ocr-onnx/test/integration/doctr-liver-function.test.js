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

const EXPECTED_WORDS = [
  'bilirubin', 'sgot', 'sgpt', 'alkaline', 'phosphatase',
  'albumin', 'globulin', 'protein', 'serum', 'pathology',
  'biochemistry', 'hospital', 'conjugated', 'unconjugated',
  'ratio', 'specimen', 'investigation', 'total'
]

function runLiverFunctionTest (ep) {
  const useGPU = ep === 'gpu'
  const tag = ep.toUpperCase()

  test(`DocTR liver function [${tag}] - db_mobilenet + crnn_mobilenet`, { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
    const imagePath = getImagePath('/test/images/liver_function_test.png')

    t.comment(`Testing DocTR on liver function test (LFT) image [${tag}]`)
    t.comment('Detector: db_mobilenet_v3_large, Recognizer: crnn_mobilenet_v3_small (CTC)')
    t.comment('straightenPages: true, useGPU: ' + useGPU)

    const { results, stats } = await runDoctrOCR(t, {
      pathDetector: DB_MOBILENET,
      pathRecognizer: CRNN_MOBILENET,
      decodingMethod: 'ctc',
      straightenPages: true,
      useGPU
    }, imagePath)

    const texts = results.map(r => r.text)
    t.comment('Detected texts: ' + JSON.stringify(texts))
    t.comment(formatOCRPerformanceMetrics(`[DocTR liver_function_test] [${tag}]`, stats, texts, { imagePath }))

    t.ok(results.length > 0, `should detect text regions, got ${results.length}`)

    const lowerTexts = texts.map(w => w.toLowerCase())
    for (const word of EXPECTED_WORDS) {
      t.ok(
        lowerTexts.some(w => w.includes(word)),
        `should detect "${word}" in liver function test report`
      )
    }

    t.pass(`DocTR liver function test [${tag}] completed successfully`)
  })
}

runLiverFunctionTest('cpu')
runLiverFunctionTest('gpu')
