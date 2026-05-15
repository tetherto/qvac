'use strict'

/**
 * End-to-end integration test for the Doctr pipeline.
 *
 * Soft-skips when the required model files are absent. The Doctr GGUFs are
 * not yet distributed via S3, so this test is expected to skip in CI today.
 *
 * Env vars:
 *   OCR_GGML_DOCTR_DETECTOR    DBNet detector GGUF (required)
 *   OCR_GGML_DOCTR_RECOGNIZER  doctr CRNN recognizer GGUF (required)
 *   OCR_GGML_IMAGE             optional override for the sample image
 *
 * Local one-liner:
 *   OCR_GGML_DOCTR_DETECTOR=models/db_mobilenet_v3_large.gguf \
 *   OCR_GGML_DOCTR_RECOGNIZER=models/crnn_mobilenet_v3_small.gguf \
 *   bare test/integration/doctr.test.js
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

const detector = process.env.OCR_GGML_DOCTR_DETECTOR
const recognizer = process.env.OCR_GGML_DOCTR_RECOGNIZER
const image = process.env.OCR_GGML_IMAGE || defaultSampleImage()

const ready = detector && recognizer && modelsPresent([detector, recognizer, image])

test('doctr pipeline produces an array of [box, text, conf] triples',
  { skip: !ready }, async t => {
    const ocr = new OcrGgml({
      params: {
        pathDetector: detector,
        pathRecognizer: recognizer,
        pipelineType: 'doctr',
        // langList is required by the schema but ignored by the doctr
        // pipeline (it is language-agnostic over Latin script).
        langList: ['en']
      },
      opts: { stats: true }
    })

    await ocr.load()
    try {
      const response = await ocr.run({ path: image })

      let collected = null
      response.onUpdate(rows => { collected = rows })
      // See easyocr.test.js for why we read stats from `response.stats`
      // instead of the return value of `response.await()`.
      await response.await()

      assertRowShape(t, collected)
      assertStatsShape(t, response.stats)
    } finally {
      await ocr.unload()
    }
  }
)
