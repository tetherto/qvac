'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const { getImagePath, formatOCRPerformanceMetrics, runDoctrOCR, ensureDoctrModels } = require('./utils')

const TEST_TIMEOUT = 180 * 1000

// Words reliably detected by db_mobilenet_v3_large + crnn_mobilenet_v3_small on english.bmp (case-insensitive).
// english.bmp is a WHO coronavirus infographic with known text.
const ENGLISH_EXPECTED_WORDS = [
  'health', 'world', 'animals', 'farm', 'unprotected', 'wild',
  'eggs', 'meat', 'cook', 'symptoms', 'cold', 'anyone',
  'avoid', 'sneezing', 'nose', 'coughing', 'mouth', 'cover',
  'hand', 'rub', 'soap', 'water', 'hands', 'clean',
  'your', 'reduce', 'risk'
]

// Model paths (set after download)
let DB_MOBILENET
let CRNN_MOBILENET

/**
 * Assert that all expected words appear in the detected texts (case-insensitive)
 */
function assertExpectedWords (t, texts, expectedWords, label) {
  const lowerTexts = texts.map(w => w.toLowerCase())
  for (const word of expectedWords) {
    t.ok(
      lowerTexts.includes(word.toLowerCase()),
      `${label} should detect "${word}" (got: ${JSON.stringify(texts)})`
    )
  }
}

// -------------------------------------------------------------------
// Download models before tests
// -------------------------------------------------------------------
test('DocTR models - download all models', { timeout: TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels()
  DB_MOBILENET = models.db_mobilenet_v3_large
  CRNN_MOBILENET = models.crnn_mobilenet_v3_small
  t.ok(fs.existsSync(DB_MOBILENET), 'db_mobilenet_v3_large exists')
  t.ok(fs.existsSync(CRNN_MOBILENET), 'crnn_mobilenet_v3_small exists')
  t.pass('All models available')
})

// -------------------------------------------------------------------
// 1. Default combo: db_mobilenet_v3_large + crnn_mobilenet_v3_small
// -------------------------------------------------------------------
test('DocTR CTC - db_mobilenet + crnn_mobilenet on english.bmp', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Detector: db_mobilenet_v3_large, Recognizer: crnn_mobilenet_v3_small')

  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET
  }, imagePath)

  const texts = results.map(r => r.text)
  t.comment('Detected: ' + JSON.stringify(texts))
  t.comment(formatOCRPerformanceMetrics('[CTC mobilenet]', stats, texts, { skipReport: true }))

  // Should detect many text regions from the infographic
  t.ok(results.length >= 30, `should detect >= 30 text regions, got ${results.length}`)

  // All confidences should be valid numbers in [0, 1]
  for (const r of results) {
    t.ok(r.confidence >= 0 && r.confidence <= 1, `confidence ${r.confidence.toFixed(3)} in [0,1]`)
  }

  // Verify expected words are detected
  assertExpectedWords(t, texts, ENGLISH_EXPECTED_WORDS, '[CTC mobilenet]')
})

// -------------------------------------------------------------------
// 2. repeated run — same image produces valid output
// -------------------------------------------------------------------
test('DocTR repeated run - should not crash and produce valid output', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Testing repeated DocTR run on english.bmp')

  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET
  }, imagePath)

  const texts = results.map(r => r.text)
  t.comment('Detected texts: ' + JSON.stringify(texts))
  t.comment(formatOCRPerformanceMetrics('[DocTR repeated]', stats, texts, { skipReport: true }))

  t.ok(results.length >= 30, `should detect >= 30 text regions, got ${results.length}`)
  assertExpectedWords(t, texts, ENGLISH_EXPECTED_WORDS, '[DocTR repeated]')
})

// -------------------------------------------------------------------
// 3. recognizerBatchSize — different batch sizes produce valid output
// -------------------------------------------------------------------
test('DocTR recognizerBatchSize - batch=1 vs batch=16 both produce valid output', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Testing recognizerBatchSize=1 vs recognizerBatchSize=16')

  const { results: resultsBatch1 } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    recognizerBatchSize: 1
  }, imagePath)

  const { results: resultsBatch16 } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    recognizerBatchSize: 16
  }, imagePath)

  const textsBatch1 = resultsBatch1.map(r => r.text)
  const textsBatch16 = resultsBatch16.map(r => r.text)
  t.comment('Batch=1 texts (' + textsBatch1.length + '): ' + JSON.stringify(textsBatch1))
  t.comment('Batch=16 texts (' + textsBatch16.length + '): ' + JSON.stringify(textsBatch16))

  t.ok(resultsBatch1.length > 0, 'Batch=1 should detect text')
  t.ok(resultsBatch16.length > 0, 'Batch=16 should detect text')
  t.is(resultsBatch1.length, resultsBatch16.length, 'Both batch sizes should detect same number of regions')

  // Texts should be identical regardless of batch size
  for (let i = 0; i < Math.min(resultsBatch1.length, resultsBatch16.length); i++) {
    t.is(resultsBatch1[i].text, resultsBatch16[i].text, 'Text at index ' + i + ' should match across batch sizes')
  }

  assertExpectedWords(t, textsBatch1, ENGLISH_EXPECTED_WORDS, '[batch=1]')
  assertExpectedWords(t, textsBatch16, ENGLISH_EXPECTED_WORDS, '[batch=16]')
  t.pass('recognizerBatchSize does not affect output accuracy')
})

