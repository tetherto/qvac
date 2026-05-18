'use strict'

/**
 * End-to-end integration test for the EasyOCR pipeline (default).
 *
 * Soft-skips when the required model files are absent so the suite stays
 * green on developer machines without weights.
 *
 * Env vars:
 *   OCR_GGML_DETECTOR    CRAFT detector GGUF (required)
 *   OCR_GGML_RECOGNIZER  CRNN gen-2 recognizer GGUF (e.g. latin_g2.gguf or
 *                        english_g2.gguf; CI uses latin_g2.gguf)
 *   OCR_GGML_IMAGE       optional override for the sample image
 *
 * Local one-liner:
 *   OCR_GGML_DETECTOR=models/craft_mlt_25k.gguf \
 *   OCR_GGML_RECOGNIZER=models/latin_g2.gguf \
 *   bare test/integration/easyocr.test.js
 */

const test = require('brittle')
const process = require('bare-process')

const OcrGgml = require('../..').OcrGgml
const {
  modelsPresent,
  assertRowShape,
  assertStatsShape,
  defaultSampleImage
} = require('./helpers')

const TEST_TIMEOUT = 120 * 1000

const detector = process.env.OCR_GGML_DETECTOR
const recognizer = process.env.OCR_GGML_RECOGNIZER
const image = process.env.OCR_GGML_IMAGE || defaultSampleImage()

const ready = detector && recognizer && modelsPresent([detector, recognizer, image])

test('easyocr pipeline produces an array of [box, text, conf] triples',
  { timeout: TEST_TIMEOUT, skip: !ready }, async t => {
    const ocr = new OcrGgml({
      params: {
        pathDetector: detector,
        pathRecognizer: recognizer,
        langList: ['en']
      },
      opts: { stats: true }
    })

    await ocr.load()
    try {
      const response = await ocr.run({ path: image })

      let collected = null
      response.onUpdate(rows => { collected = rows })
      // `response.await()` resolves with the final output (the rows array).
      // Timing stats live on the response object, populated by `updateStats()`
      // before `ended()` is called — read them via `response.stats`.
      await response.await()

      assertRowShape(t, collected)
      assertStatsShape(t, response.stats)
    } finally {
      await ocr.unload()
    }
  }
)
