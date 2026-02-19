'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { getImagePath, ensureModelPath, formatOCRPerformanceMetrics, runDoctrOCR, ensureDoctrModels } = require('./utils')

const TEST_TIMEOUT = 180 * 1000

let DB_MOBILENET
let CRNN_MOBILENET

test('DocTR lab results - download models', { timeout: TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels(['db_mobilenet_v3_large.onnx', 'crnn_mobilenet_v3_small.onnx'])
  DB_MOBILENET = models.db_mobilenet_v3_large
  CRNN_MOBILENET = models.crnn_mobilenet_v3_small
  t.ok(DB_MOBILENET, 'db_mobilenet model available')
  t.ok(CRNN_MOBILENET, 'crnn_mobilenet model available')
})

test('DocTR lab results - db_mobilenet + crnn_mobilenet with straightenPages', { timeout: TEST_TIMEOUT }, async function (t) {
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

test('EasyOCR lab results - detector_craft + recognizer_latin', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/lab_results.png')

  t.comment('Testing EasyOCR on medical lab results image')
  t.comment('Detector: detector_craft, Recognizer: recognizer_latin')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    },
    opts: { stats: true }
  })

  await onnxOcr.load()
  t.pass('EasyOCR model loaded successfully')

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let outputTexts = []

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        outputTexts = output.map(o => o[1])
        t.comment('Detected texts: ' + JSON.stringify(outputTexts))
        t.comment('Full output: ' + JSON.stringify(output.map(o => ({
          text: o[1],
          confidence: o[2].toFixed(3)
        })), null, 2))
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    const stats = response.stats || {}
    t.comment(formatOCRPerformanceMetrics('[EasyOCR lab_results]', stats, outputTexts))

    t.ok(outputTexts.length > 0, `should detect text regions, got ${outputTexts.length}`)

    const lowerTexts = outputTexts.map(w => w.toLowerCase())
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

    t.pass('EasyOCR lab results test completed successfully')
  } catch (e) {
    t.fail('EasyOCR test failed: ' + e.message)
    throw e
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload() error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
