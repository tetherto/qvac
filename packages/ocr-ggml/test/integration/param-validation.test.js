'use strict'

const { OcrGgml } = require('../..')
const { QvacErrorAddonOcrGgml, ERR_CODES } = require('../..')
const test = require('brittle')
const { isMobile } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 30 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

test('load() rejects when langList is missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: 'models/craft_mlt_25k.gguf',
      pathRecognizer: 'models/latin_g2.gguf'
    }
  })

  try {
    await ocrGgml.load()
    t.fail('Should have thrown for missing langList')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'Should throw QvacErrorAddonOcrGgml')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('langList'), 'Error message should mention langList')
    t.pass('Correctly rejected missing langList')
  }
})

test('load() rejects when langList is empty array after filtering', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: 'models/craft_mlt_25k.gguf',
      pathRecognizer: 'models/latin_g2.gguf',
      langList: ['klingon', 'elvish', 'dothraki']
    }
  })

  try {
    await ocrGgml.load()
    t.fail('Should have thrown for all-unsupported languages')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'Should throw QvacErrorAddonOcrGgml')
    t.is(err.code, ERR_CODES.UNSUPPORTED_LANGUAGE, 'Error code should be UNSUPPORTED_LANGUAGE')
    t.pass('Correctly rejected all-unsupported language list')
  }
})

test('load() rejects when pathDetector is missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = new OcrGgml({
    params: {
      pathRecognizer: 'models/latin_g2.gguf',
      langList: ['en']
    }
  })

  try {
    await ocrGgml.load()
    t.fail('Should have thrown for missing pathDetector')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'Should throw QvacErrorAddonOcrGgml')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('pathDetector'), 'Error message should mention pathDetector')
    t.pass('Correctly rejected missing pathDetector')
  }
})

test('load() rejects when pathRecognizer is missing', { timeout: TEST_TIMEOUT }, async function (t) {
  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: 'models/craft_mlt_25k.gguf',
      langList: ['en']
    }
  })

  try {
    await ocrGgml.load()
    t.fail('Should have thrown for missing pathRecognizer')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'Should throw QvacErrorAddonOcrGgml')
    t.is(err.code, ERR_CODES.MISSING_REQUIRED_PARAMETER, 'Error code should be MISSING_REQUIRED_PARAMETER')
    t.ok(err.message.includes('pathRecognizer'), 'Error message should mention pathRecognizer')
    t.pass('Correctly rejected missing recognizer path')
  }
})
