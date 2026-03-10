'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureDoctrModels, safeUnload } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 180 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

let DOCTR_DETECTOR
let DOCTR_RECOGNIZER

test('DocTR pipeline - download models', { timeout: TEST_TIMEOUT }, async function (t) {
  // Use lighter mobilenet models to reduce memory pressure on Windows CI
  const models = await ensureDoctrModels(['db_mobilenet_v3_large.onnx', 'crnn_mobilenet_v3_small.onnx'])
  DOCTR_DETECTOR = models.db_mobilenet_v3_large
  DOCTR_RECOGNIZER = models.crnn_mobilenet_v3_small
  t.ok(DOCTR_DETECTOR, 'db_mobilenet model available')
  t.ok(DOCTR_RECOGNIZER, 'crnn_mobilenet model available')
})

test('DocTR pipeline - unrecognizable text completes without hanging', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/unrecognizable_text.bmp')
  t.comment('Testing DocTR with image: ' + imagePath)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'doctr',
      decodingMethod: 'ctc'
    },
    opts: { stats: true }
  })

  await onnxOcr.load()

  try {
    let errorReceived = false
    let responseCompleted = false

    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        t.comment('DocTR detected ' + output.length + ' regions on unrecognizable image')
      })
      .onError(error => {
        errorReceived = true
        t.fail('Unexpected error received: ' + JSON.stringify(error))
      })
      .await()
      .then(() => {
        responseCompleted = true
        t.pass('Response completed successfully - JobEnded event was received')
      })

    t.ok(!errorReceived, 'No error should be received')
    t.ok(responseCompleted, 'Response should complete - JobEnded event was received')
    t.pass('DocTR pipeline completed successfully without hanging')
  } catch (err) {
    t.fail('Error in test: ' + err.message)
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
})

test('DocTR pipeline - handles multiple sequential runs on same instance', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const imagePath1 = getImagePath('/test/images/basic_test.bmp')
  const imagePath2 = getImagePath('/test/images/english.bmp')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'doctr',
      decodingMethod: 'ctc'
    },
    opts: { stats: true }
  })

  await onnxOcr.load()

  try {
    // First run
    const response1 = await onnxOcr.run({
      path: imagePath1,
      options: { paragraph: false }
    })

    let firstResults = []
    await response1
      .onUpdate(output => {
        firstResults = output.map(o => o[1])
      })
      .onError(error => {
        t.fail('Unexpected error on first run: ' + JSON.stringify(error))
      })
      .await()

    t.ok(firstResults.length > 0, 'First run should produce output (' + firstResults.length + ' texts)')
    t.comment('First run texts: ' + JSON.stringify(firstResults))

    // Second run with a different image
    const response2 = await onnxOcr.run({
      path: imagePath2,
      options: { paragraph: false }
    })

    let secondResults = []
    await response2
      .onUpdate(output => {
        secondResults = output.map(o => o[1])
      })
      .onError(error => {
        t.fail('Unexpected error on second run: ' + JSON.stringify(error))
      })
      .await()

    t.ok(secondResults.length > 0, 'Second run should produce output (' + secondResults.length + ' texts)')
    t.comment('Second run texts: ' + JSON.stringify(secondResults))
    t.pass('DocTR sequential runs completed without issues')
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
})
