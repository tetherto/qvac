'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const { getImagePath, formatOCRPerformanceMetrics, runDoctrOCR, ensureDoctrModels } = require('./utils')

const TEST_TIMEOUT = 180 * 1000

// Words reliably detected by ALL 4 model combinations on english.bmp (case-insensitive).
// english.bmp is a WHO coronavirus infographic with known text.
const ENGLISH_EXPECTED_WORDS = [
  'health', 'world', 'animals', 'farm', 'unprotected', 'wild',
  'eggs', 'meat', 'cook', 'symptoms', 'cold', 'anyone',
  'avoid', 'sneezing', 'nose', 'coughing', 'mouth', 'cover',
  'hand', 'rub', 'soap', 'water', 'hands', 'clean',
  'your', 'reduce', 'risk'
]

// Additional words that attention models (PARSeq) detect correctly
const ATTENTION_EXTRA_WORDS = ['organization']

// Model paths (set after download)
let DB_RESNET50
let PARSEQ
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
// Download all 4 models before tests
// -------------------------------------------------------------------
test('DocTR models - download all models', { timeout: TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels()
  DB_RESNET50 = models.db_resnet50
  PARSEQ = models.parseq
  DB_MOBILENET = models.db_mobilenet_v3_large
  CRNN_MOBILENET = models.crnn_mobilenet_v3_small
  t.ok(fs.existsSync(DB_RESNET50), 'db_resnet50.onnx exists')
  t.ok(fs.existsSync(PARSEQ), 'parseq.onnx exists')
  t.ok(fs.existsSync(DB_MOBILENET), 'db_mobilenet_v3_large.onnx exists')
  t.ok(fs.existsSync(CRNN_MOBILENET), 'crnn_mobilenet_v3_small.onnx exists')
  t.pass('All models available')
})

// -------------------------------------------------------------------
// 1. Default combo: db_mobilenet_v3_large + crnn_mobilenet_v3_small (CTC)
// -------------------------------------------------------------------
test('DocTR CTC - db_mobilenet + crnn_mobilenet on english.bmp', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Detector: db_mobilenet_v3_large, Recognizer: crnn_mobilenet_v3_small (CTC)')

  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    decodingMethod: 'ctc'
  }, imagePath)

  const texts = results.map(r => r.text)
  t.comment('Detected: ' + JSON.stringify(texts))
  t.comment(formatOCRPerformanceMetrics('[CTC mobilenet]', stats, texts))

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
// 2. Existing combo: db_resnet50 + parseq (attention)
// -------------------------------------------------------------------
test('DocTR attention - db_resnet50 + parseq on english.bmp', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Detector: db_resnet50, Recognizer: parseq (attention)')

  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DB_RESNET50,
    pathRecognizer: PARSEQ,
    decodingMethod: 'attention'
  }, imagePath)

  const texts = results.map(r => r.text)
  t.comment('Detected: ' + JSON.stringify(texts))
  t.comment(formatOCRPerformanceMetrics('[attention resnet+parseq]', stats, texts))

  t.ok(results.length >= 30, `should detect >= 30 text regions, got ${results.length}`)

  for (const r of results) {
    t.ok(r.confidence >= 0 && r.confidence <= 1, `confidence ${r.confidence.toFixed(3)} in [0,1]`)
  }

  // Verify expected words are detected
  assertExpectedWords(t, texts, ENGLISH_EXPECTED_WORDS, '[attention resnet+parseq]')
  // Attention models should also get "Organization" right
  assertExpectedWords(t, texts, ATTENTION_EXTRA_WORDS, '[attention resnet+parseq]')
})

// -------------------------------------------------------------------
// 3. Cross combo: db_mobilenet + parseq (attention)
// -------------------------------------------------------------------
test('DocTR cross - db_mobilenet + parseq (attention) on english.bmp', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Detector: db_mobilenet_v3_large, Recognizer: parseq (attention)')

  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: PARSEQ,
    decodingMethod: 'attention'
  }, imagePath)

  const texts = results.map(r => r.text)
  t.comment('Detected: ' + JSON.stringify(texts))
  t.comment(formatOCRPerformanceMetrics('[attention mobilenet+parseq]', stats, texts))

  t.ok(results.length >= 30, `should detect >= 30 text regions, got ${results.length}`)

  // Verify expected words are detected
  assertExpectedWords(t, texts, ENGLISH_EXPECTED_WORDS, '[cross mobilenet+parseq]')
  // Attention recognizer should also get "Organization"
  assertExpectedWords(t, texts, ATTENTION_EXTRA_WORDS, '[cross mobilenet+parseq]')
})

// -------------------------------------------------------------------
// 4. Cross combo: db_resnet50 + crnn_mobilenet (CTC)
// -------------------------------------------------------------------
test('DocTR cross - db_resnet50 + crnn_mobilenet (CTC) on english.bmp', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Detector: db_resnet50, Recognizer: crnn_mobilenet_v3_small (CTC)')

  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DB_RESNET50,
    pathRecognizer: CRNN_MOBILENET,
    decodingMethod: 'ctc'
  }, imagePath)

  const texts = results.map(r => r.text)
  t.comment('Detected: ' + JSON.stringify(texts))
  t.comment(formatOCRPerformanceMetrics('[CTC resnet+crnn]', stats, texts))

  t.ok(results.length >= 30, `should detect >= 30 text regions, got ${results.length}`)

  // Verify expected words are detected
  assertExpectedWords(t, texts, ENGLISH_EXPECTED_WORDS, '[cross resnet+crnn]')
})

// -------------------------------------------------------------------
// 5. basic_test.bmp — "normal" text detection
// -------------------------------------------------------------------
test('DocTR attention - db_resnet50 + parseq on basic_test.bmp', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/basic_test.bmp')
  t.comment('Detector: db_resnet50, Recognizer: parseq (attention) on basic_test.bmp')
  t.comment('Image contains: "tilted" (rotated), "normal" (horizontal), "vertical" (90deg)')

  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DB_RESNET50,
    pathRecognizer: PARSEQ,
    decodingMethod: 'attention'
  }, imagePath)

  const texts = results.map(r => r.text)
  const lowerTexts = texts.map(w => w.toLowerCase())
  t.comment('Detected: ' + JSON.stringify(texts))
  t.comment(formatOCRPerformanceMetrics('[attention basic_test]', stats, texts))

  t.ok(results.length >= 1, `should detect at least 1 text region, got ${results.length}`)
  // "normal" is the only horizontal word — should be reliably detected
  t.ok(
    lowerTexts.some(w => w.includes('normal')),
    'should detect "normal" (horizontal text): got ' + JSON.stringify(texts)
  )
})

// -------------------------------------------------------------------
// 6. straightenPages test
// -------------------------------------------------------------------
test('DocTR straightenPages - should not crash and produce valid output', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Testing straightenPages=true on english.bmp (no rotation expected)')

  // Run with straightenPages on english.bmp (already upright, so angle should be 0)
  const { results, stats } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    decodingMethod: 'ctc',
    straightenPages: true
  }, imagePath)

  const texts = results.map(r => r.text)
  t.comment('Detected with straightenPages: ' + JSON.stringify(texts))
  t.comment(formatOCRPerformanceMetrics('[straightenPages]', stats, texts))

  // An upright image should produce the same results with or without straightenPages
  t.ok(results.length >= 30, `should detect >= 30 text regions, got ${results.length}`)
  assertExpectedWords(t, texts, ENGLISH_EXPECTED_WORDS, '[straightenPages]')
})

// -------------------------------------------------------------------
// 7. recognizerBatchSize — different batch sizes produce valid output
// -------------------------------------------------------------------
test('DocTR recognizerBatchSize - batch=1 vs batch=16 both produce valid output', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Testing recognizerBatchSize=1 vs recognizerBatchSize=16')

  const { results: resultsBatch1 } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    decodingMethod: 'ctc',
    recognizerBatchSize: 1
  }, imagePath)

  const { results: resultsBatch16 } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    decodingMethod: 'ctc',
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

// -------------------------------------------------------------------
// 8. Default decoding method — should use CTC when unspecified
// -------------------------------------------------------------------
test('DocTR default decoding - should use CTC when unspecified', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  t.comment('Testing default decoding (no decodingMethod param) with CRNN model')

  // Run without specifying decodingMethod — should default to CTC
  const { results: resultsDefault } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET
    // decodingMethod intentionally omitted
  }, imagePath)

  // Run with explicit CTC
  const { results: resultsCTC } = await runDoctrOCR(t, {
    pathDetector: DB_MOBILENET,
    pathRecognizer: CRNN_MOBILENET,
    decodingMethod: 'ctc'
  }, imagePath)

  const textsDefault = resultsDefault.map(r => r.text)
  const textsCTC = resultsCTC.map(r => r.text)
  t.comment('Default: ' + JSON.stringify(textsDefault))
  t.comment('Explicit CTC: ' + JSON.stringify(textsCTC))

  t.ok(resultsDefault.length > 0, `default should detect text, got ${resultsDefault.length}`)
  t.is(resultsDefault.length, resultsCTC.length, 'default and explicit CTC should detect same number of regions')

  // Texts should be identical
  for (let i = 0; i < Math.min(resultsDefault.length, resultsCTC.length); i++) {
    t.is(resultsDefault[i].text, resultsCTC[i].text, `text at index ${i} should match`)
  }

  // Also verify expected words
  assertExpectedWords(t, textsDefault, ENGLISH_EXPECTED_WORDS, '[default CTC]')
})
