'use strict'

const test = require('brittle')
const { getImagePath, formatOCRPerformanceMetrics, runDoctrOCR, ensureDoctrModels } = require('./utils')

const DOCTR_TEST_TIMEOUT = 180 * 1000

let DB_MOBILENET
let CRNN_MOBILENET
let modelsAvailable = false

test('DocTR CT scan - download models', { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
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

const EXPECTED_WORDS = [
  'diagnostic', 'imaging', 'computed', 'tomography',
  'chest', 'abdomen', 'lung', 'liver', 'pancreas',
  'gallbladder', 'spleen', 'radiologist', 'allied',
  'medical', 'center', 'patient', 'heart', 'trachea',
  'vascular', 'normal'
]

const PERF_RUNS = 3

function runCtScanTest (ep, run) {
  const useGPU = ep === 'gpu'
  const tag = ep.toUpperCase()

  test(`DocTR CT scan [${tag}] run ${run} - db_mobilenet + crnn_mobilenet`, { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
    if (!modelsAvailable) { t.comment('Skipped — models unavailable'); return }
    const imagePath = getImagePath('/test/images/ct_scan_report.png')

    t.comment(`Testing DocTR on CT scan diagnostic report image [${tag}] (run ${run}/${PERF_RUNS})`)
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
    t.comment(formatOCRPerformanceMetrics(`[DocTR ct_scan_report] [${tag}]`, stats, texts, { imagePath }))

    t.ok(results.length > 0, `should detect text regions, got ${results.length}`)

    const lowerTexts = texts.map(w => w.toLowerCase())
    for (const word of EXPECTED_WORDS) {
      t.ok(
        lowerTexts.some(w => w.includes(word)),
        `should detect "${word}" in CT scan report`
      )
    }

    t.pass(`DocTR CT scan report [${tag}] run ${run} completed successfully`)
  })
}

for (let i = 1; i <= PERF_RUNS; i++) runCtScanTest('cpu', i)
for (let i = 1; i <= PERF_RUNS; i++) runCtScanTest('gpu', i)
