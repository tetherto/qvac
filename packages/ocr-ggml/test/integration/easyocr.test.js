'use strict'

/**
 * End-to-end integration test for the EasyOCR pipeline (default).
 *
 * Soft-skips on desktop when the required model files are absent so the suite
 * stays green on developer machines without weights. On mobile the models are
 * resolved from global.assetPaths (populated by the mobile test framework);
 * if an asset is missing the module throws at load time.
 *
 * Env vars (desktop only):
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
  isMobile,
  modelsPresent,
  resolveModelPath,
  ensureModelPath,
  assertRowShape,
  assertStatsShape,
  defaultSampleImage,
  formatOCRPerformanceMetrics
} = require('./helpers')

const TEST_TIMEOUT = 300 * 1000

const detector = resolveModelPath('OCR_GGML_DETECTOR', 'craft_mlt_25k.gguf.bin')
const recognizer = resolveModelPath('OCR_GGML_RECOGNIZER', 'latin_g2.gguf.bin')
const image = process.env.OCR_GGML_IMAGE || defaultSampleImage()
const ready = isMobile || (detector && recognizer && modelsPresent([detector, recognizer, image]))

test('easyocr pipeline produces an array of [box, text, conf] triples',
  { timeout: TEST_TIMEOUT, skip: !ready }, async t => {
    const detectorPath = await ensureModelPath('OCR_GGML_DETECTOR', 'craft_mlt_25k.gguf.bin')
    const recognizerPath = await ensureModelPath('OCR_GGML_RECOGNIZER', 'latin_g2.gguf.bin')
    if (!detectorPath || !recognizerPath) {
      t.comment('[EasyOCR] model download failed — skipping')
      t.pass('model download failed on mobile')
      return
    }

    const ocr = new OcrGgml({
      params: {
        pathDetector: detectorPath,
        pathRecognizer: recognizerPath,
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
      // `response.await()` resolves with the final output (the rows array).
      // Timing stats live on the response object, populated by `updateStats()`
      // before `ended()` is called — read them via `response.stats`.
      await response.await()
      t.comment(`inference elapsed=${Date.now() - inferStart}ms`)

      t.comment(formatOCRPerformanceMetrics('[EasyOCR]', response.stats, collected))

      assertRowShape(t, collected)
      assertStatsShape(t, response.stats)
    } finally {
      await ocr.unload()
    }
  }
)
