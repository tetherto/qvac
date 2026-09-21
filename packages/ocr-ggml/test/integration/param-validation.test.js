'use strict'

const fs = require('bare-fs')
const process = require('bare-process')
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

test(
  'load() rejects unsupported languages via native validation',
  { timeout: TEST_TIMEOUT },
  async function (t) {
    const pathDetector = await ensureModelPath('detector_craft')
    const pathRecognizer = await ensureModelPath('recognizer_latin')
    if (!fs.existsSync(pathDetector) || !fs.existsSync(pathRecognizer)) {
      // CI provides models via OCR_GGML_DETECTOR/OCR_GGML_RECOGNIZER (and the
      // mobile harness pre-stages them): a missing file there is a harness
      // bug, and silently skipping would let the native-validation contract
      // regress unnoticed. Only local runs without models soft-skip.
      if (process.env.OCR_GGML_DETECTOR || process.env.OCR_GGML_RECOGNIZER || isMobile) {
        t.fail(`Model fixtures missing (${pathDetector}, ${pathRecognizer})`)
      } else {
        t.pass('Models not available locally - skipping native language validation test')
      }
      return
    }

    const ocrGgml = new OcrGgml({
      params: {
        pathDetector,
        pathRecognizer,
        langList: ['klingon', 'elvish', 'dothraki']
      }
    })

    let err = null
    try {
      await ocrGgml.load()
    } catch (e) {
      err = e
    } finally {
      await ocrGgml.unload()
    }

    t.ok(err, 'load() rejected for all-unsupported languages')
    t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
    t.is(
      err && err.code,
      ERR_CODES.UNSUPPORTED_LANGUAGE,
      'error.code is UNSUPPORTED_LANGUAGE (mapped from the native validation failure)'
    )
    const message = String(err && err.message)
    t.ok(
      /unsupported languages/i.test(message),
      `native message reports the unsupported languages, got: ${message}`
    )
    t.ok(message.includes('klingon'), 'error names the offending language')
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
