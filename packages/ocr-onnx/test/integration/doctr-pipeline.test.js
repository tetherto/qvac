'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, formatOCRPerformanceMetrics, ensureDoctrModels, safeUnload } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 180 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

let DOCTR_DETECTOR
let DOCTR_RECOGNIZER
let sharedOcr

test('DocTR pipeline - download models', { timeout: TEST_TIMEOUT }, async function (t) {
  const models = await ensureDoctrModels(['db_mobilenet_v3_large.onnx', 'crnn_mobilenet_v3_small.onnx'])
  DOCTR_DETECTOR = models.db_mobilenet_v3_large
  DOCTR_RECOGNIZER = models.crnn_mobilenet_v3_small
  t.ok(DOCTR_DETECTOR, 'db_mobilenet model available')
  t.ok(DOCTR_RECOGNIZER, 'crnn_mobilenet model available')
})

test('DocTR pipeline - load shared instance', { timeout: TEST_TIMEOUT }, async function (t) {
  sharedOcr = new ONNXOcr({
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

  await sharedOcr.load()
  t.pass('Shared mobilenet instance loaded')
})

test('DocTR pipeline - sequential runs on same instance', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const imagePath1 = getImagePath('/test/images/basic_test.bmp')
  const imagePath2 = getImagePath('/test/images/english.bmp')

  const response1 = await sharedOcr.run({
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

  const response2 = await sharedOcr.run({
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
  t.pass('Sequential runs completed without issues')
})

test('DocTR pipeline - coordinate scaling in original image space', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  const originalImageWidth = 905
  const originalImageHeight = 480

  t.comment('Testing coordinate scaling with ' + originalImageWidth + 'x' + originalImageHeight + ' image')

  const response = await sharedOcr.run({
    path: imagePath,
    options: { paragraph: false }
  })

  let results = []
  await response
    .onUpdate(output => {
      t.ok(Array.isArray(output), 'output should be an array')
      results = output.map(o => ({ text: o[1], confidence: o[2], bbox: o[0] }))
    })
    .onError(error => {
      t.fail('unexpected error: ' + JSON.stringify(error))
    })
    .await()

  t.ok(results.length > 0, 'Should detect at least one text region')

  let maxX = 0
  let maxY = 0

  for (const r of results) {
    t.ok(typeof r.text === 'string', 'text should be a string')
    t.ok(r.text.length > 0, 'text should not be empty')
    t.ok(typeof r.confidence === 'number', 'confidence should be a number')
    t.ok(r.confidence >= 0 && r.confidence <= 1, 'confidence should be in [0, 1]')

    t.ok(Array.isArray(r.bbox), 'bbox should be an array')
    t.is(r.bbox.length, 4, 'bbox should have 4 points')

    for (const point of r.bbox) {
      t.ok(Array.isArray(point), 'Each bbox point should be an array')
      t.is(point.length, 2, 'Each bbox point should have 2 coordinates')
      t.ok(typeof point[0] === 'number', 'X coordinate should be a number')
      t.ok(typeof point[1] === 'number', 'Y coordinate should be a number')

      if (point[0] > maxX) maxX = point[0]
      if (point[1] > maxY) maxY = point[1]
    }
  }

  t.comment('Max X: ' + maxX.toFixed(1) + ', Max Y: ' + maxY.toFixed(1))
  t.ok(maxX <= originalImageWidth, 'Max X should not exceed original width (' + originalImageWidth + ')')
  t.ok(maxY <= originalImageHeight, 'Max Y should not exceed original height (' + originalImageHeight + ')')

  const outputTexts = results.map(r => r.text)
  t.comment(formatOCRPerformanceMetrics('[DocTR scaling]', {}, outputTexts))
  t.pass('Coordinate scaling and output structure verified')
})

test('DocTR pipeline - unrecognizable text completes without hanging', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/unrecognizable_text.bmp')

  const response = await sharedOcr.run({
    path: imagePath,
    options: { paragraph: false }
  })

  let errorReceived = false

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

  t.ok(!errorReceived, 'No error should be received')
  t.pass('Pipeline completed on unrecognizable text without hanging')
})

test('DocTR pipeline - teardown with lifecycle edge cases', { timeout: TEST_TIMEOUT }, async function (t) {
  await safeUnload(sharedOcr)
  t.pass('Unload successful')

  try {
    await sharedOcr.run({
      path: getImagePath('/test/images/basic_test.bmp'),
      options: { paragraph: false }
    })
    t.fail('Should have thrown when running after unload')
  } catch (err) {
    t.ok(err, 'Correctly throws error when running after unload')
    t.comment('Error: ' + err.message)
  }

  try {
    await sharedOcr.unload()
    t.pass('Second unload did not throw')
  } catch (err) {
    t.comment('Second unload threw: ' + err.message)
    t.pass('Second unload threw an error (acceptable behavior)')
  }

  await new Promise(resolve => setTimeout(resolve, 2000))
})
