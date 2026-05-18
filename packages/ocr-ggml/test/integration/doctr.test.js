'use strict'

/**
 * End-to-end integration test for the Doctr pipeline.
 *
 * Soft-skips on desktop when the required model files are absent. On mobile
 * the models are resolved from global.assetPaths (populated by the mobile
 * test framework); if an asset is missing the module throws at load time.
 *
 * Env vars (desktop only):
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
  isMobile,
  modelsPresent,
  resolveModelPath,
  ensureModelPath,
  assertRowShape,
  assertStatsShape,
  defaultSampleImage,
  formatOCRPerformanceMetrics
} = require('./helpers')

const TEST_TIMEOUT = 120 * 1000

const detector = resolveModelPath('OCR_GGML_DOCTR_DETECTOR', 'db_mobilenet_v3_large.gguf.bin')
const recognizer = resolveModelPath('OCR_GGML_DOCTR_RECOGNIZER', 'crnn_mobilenet_v3_small.gguf.bin')
const image = process.env.OCR_GGML_IMAGE || defaultSampleImage()
const ready = isMobile || (detector && recognizer && modelsPresent([detector, recognizer, image]))

test('doctr pipeline produces an array of [box, text, conf] triples',
  { timeout: TEST_TIMEOUT, skip: !ready }, async t => {
    const detectorPath = await ensureModelPath('OCR_GGML_DOCTR_DETECTOR', 'db_mobilenet_v3_large.gguf.bin')
    const recognizerPath = await ensureModelPath('OCR_GGML_DOCTR_RECOGNIZER', 'crnn_mobilenet_v3_small.gguf.bin')
    if (!detectorPath || !recognizerPath) {
      t.comment('[DocTR] model download failed — skipping')
      t.pass('model download failed on mobile')
      return
    }

    const ocr = new OcrGgml({
      params: {
        pathDetector: detectorPath,
        pathRecognizer: recognizerPath,
        pipelineType: 'doctr',
        // langList is required by the schema but ignored by the doctr
        // pipeline (it is language-agnostic over Latin script).
        langList: ['en']
      },
      opts: { stats: true }
    })

    const loadStart = Date.now()
    await ocr.load()
    t.comment(`load elapsed=${Date.now() - loadStart}ms`)
    try {
      const inferStart = Date.now()
      const response = await ocr.run({ path: image })

      let collected = null
      response.onUpdate(rows => { collected = rows })
      // See easyocr.test.js for why we read stats from `response.stats`
      // instead of the return value of `response.await()`.
      await response.await()
      t.comment(`inference elapsed=${Date.now() - inferStart}ms`)

      t.comment(formatOCRPerformanceMetrics('[DocTR]', response.stats, collected))

      assertRowShape(t, collected)
      assertStatsShape(t, response.stats)
    } finally {
      await ocr.unload()
    }
  }
)
