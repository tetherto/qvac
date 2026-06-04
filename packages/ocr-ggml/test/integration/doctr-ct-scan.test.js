'use strict'

const test = require('brittle')
const { getImagePath, runDoctrComparison, ensureDoctrModels, PERF_RUNS } = require('./utils')

const DOCTR_TEST_TIMEOUT = 180 * 1000

let DB_MOBILENET
let CRNN_MOBILENET
let modelsAvailable = false

test('DocTR CT scan - download models', { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels()
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

function runCtScanTest (device, run) {
  const tag = device.toUpperCase()

  test(`DocTR CT scan [${tag}] run ${run} - db_mobilenet + crnn_mobilenet`, { timeout: DOCTR_TEST_TIMEOUT }, async function (t) {
    if (!modelsAvailable) { t.comment('Skipped — models unavailable'); return }
    const imagePath = getImagePath('/test/images/ct_scan_report.png')

    t.comment(`Testing DocTR on CT scan diagnostic report image [${tag}] (run ${run}/${PERF_RUNS})`)
    t.comment('Detector: db_mobilenet_v3_large, Recognizer: crnn_mobilenet_v3_small (CTC)')

    // On a GPU host this records a Vulkan ([GPU]) and a forced-CPU ([CPU]) row
    // for the same test; on non-GPU/local it stays a single CPU pass. The
    // assertions run on each pass. The `[${tag}]` token (always CPU here) is
    // normalized to the actual backend by formatOCRPerformanceMetrics.
    await runDoctrComparison(t, {
      params: {
        pathDetector: DB_MOBILENET,
        pathRecognizer: CRNN_MOBILENET
      },
      imagePath,
      perfLabel: `[DocTR ct_scan_report] [${tag}]`,
      perfOpts: { imagePath },
      assertResult (results) {
        const texts = results.map(r => r.text)
        t.comment('Detected texts: ' + JSON.stringify(texts))

        t.ok(results.length > 0, `should detect text regions, got ${results.length}`)

        const lowerTexts = texts.map(w => w.toLowerCase())
        for (const word of EXPECTED_WORDS) {
          t.ok(
            lowerTexts.some(w => w.includes(word)),
            `should detect "${word}" in CT scan report`
          )
        }
      }
    })

    t.pass(`DocTR CT scan report [${tag}] run ${run} completed successfully`)
  })
}

for (let i = 1; i <= PERF_RUNS; i++) runCtScanTest('cpu', i)
