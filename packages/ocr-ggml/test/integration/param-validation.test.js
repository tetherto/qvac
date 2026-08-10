'use strict'

const fs = require('bare-fs')
const { OcrGgml } = require('../..')
const { QvacErrorAddonOcrGgml, ERR_CODES } = require('../..')
const test = require('brittle')
const { isMobile, ensureModelPath } = require('./utils')

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
    t.is(
      err.code,
      ERR_CODES.MISSING_REQUIRED_PARAMETER,
      'Error code should be MISSING_REQUIRED_PARAMETER'
    )
    t.ok(err.message.includes('langList'), 'Error message should mention langList')
    t.pass('Correctly rejected missing langList')
  }
})

// Language validation is deferred to the native pipeline (which knows the
// full language registry and the loaded recognizer's character set), so an
// all-unsupported list is rejected by the native model load with its own
// error message — not by a JS-side UNSUPPORTED_LANGUAGE gate. Needs real
// model files because the native pipeline validates during model creation.
test(
  'load() rejects unsupported languages via native validation',
  { timeout: TEST_TIMEOUT },
  async function (t) {
    const pathDetector = await ensureModelPath('detector_craft')
    const pathRecognizer = await ensureModelPath('recognizer_latin')
    if (!fs.existsSync(pathDetector) || !fs.existsSync(pathRecognizer)) {
      t.pass('Models not available - skipping native language validation test')
      return
    }

    const ocrGgml = new OcrGgml({
      params: {
        pathDetector,
        pathRecognizer,
        langList: ['klingon', 'elvish', 'dothraki']
      }
    })

    try {
      await ocrGgml.load()
      t.fail('Should have thrown for all-unsupported languages')
    } catch (err) {
      const message = String(err && err.message)
      t.ok(
        /unsupported languages/i.test(message),
        `Native error reports the unsupported languages, got: ${message}`
      )
      t.ok(message.includes('klingon'), 'Error names the offending language')
    } finally {
      await ocrGgml.unload()
    }
  }
)

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
    t.is(
      err.code,
      ERR_CODES.MISSING_REQUIRED_PARAMETER,
      'Error code should be MISSING_REQUIRED_PARAMETER'
    )
    t.ok(err.message.includes('pathDetector'), 'Error message should mention pathDetector')
    t.pass('Correctly rejected missing pathDetector')
  }
})

test(
  'load() rejects when pathRecognizer is missing',
  { timeout: TEST_TIMEOUT },
  async function (t) {
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
      t.is(
        err.code,
        ERR_CODES.MISSING_REQUIRED_PARAMETER,
        'Error code should be MISSING_REQUIRED_PARAMETER'
      )
      t.ok(err.message.includes('pathRecognizer'), 'Error message should mention pathRecognizer')
      t.pass('Correctly rejected missing recognizer path')
    }
  }
)
