'use strict'

const { OcrGgml, QvacErrorAddonOcrGgml, ERR_CODES } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureDoctrModels } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 30 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

let DOCTR_DETECTOR
let DOCTR_RECOGNIZER

test('DocTR param validation - download models', { timeout: 180 * 1000 }, async function (t) {
  const models = await ensureDoctrModels()
  DOCTR_DETECTOR = models.db_mobilenet_v3_large
  DOCTR_RECOGNIZER = models.crnn_mobilenet_v3_small
  t.ok(DOCTR_DETECTOR, 'db_mobilenet model available')
  t.ok(DOCTR_RECOGNIZER, 'crnn_mobilenet model available')
})

test('DocTR load() rejects when pathRecognizer is missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: DOCTR_DETECTOR,
      langList: ['en'],
      pipelineType: 'doctr'
    }
  })

  try {
    await ocrGgml.load()
    t.fail('Should have thrown for missing pathRecognizer in doctr mode')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'Should throw QvacErrorAddonOcrGgml')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('pathRecognizer'), 'Error message should mention pathRecognizer')
    t.pass('Correctly rejected missing pathRecognizer in doctr mode')
  }
})

test('DocTR load() rejects when pathDetector is missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = new OcrGgml({
    params: {
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['en'],
      pipelineType: 'doctr'
    }
  })

  try {
    await ocrGgml.load()
    t.fail('Should have thrown for missing pathDetector in doctr mode')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'Should throw QvacErrorAddonOcrGgml')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('pathDetector'), 'Error message should mention pathDetector')
    t.pass('Correctly rejected missing pathDetector in doctr mode')
  }
})

test('DocTR run() before load() throws error', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['en'],
      pipelineType: 'doctr'
    }
  })

  try {
    await ocrGgml.run({
      path: getImagePath('/test/images/basic_test.bmp'),
      options: { paragraph: false }
    })
    t.fail('Should have thrown when running before load')
  } catch (err) {
    t.ok(err, 'Should throw an error when running before load')
    t.comment('Error: ' + err.message)
    t.pass('Correctly prevented run before load')
  }
})
