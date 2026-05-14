'use strict'

/**
 * End-to-end smoke test: load the addon, run OCR on a real image, validate
 * the response shape. Skipped when the model GGUFs are not present locally
 * (the registry / download flow is out of scope for this scaffold).
 *
 *   OCR_GGML_DETECTOR=/abs/path/craft_mlt_25k.gguf \
 *   OCR_GGML_RECOGNIZER=/abs/path/english_g2.gguf \
 *   OCR_GGML_IMAGE=/abs/path/english.png \
 *   bare test/integration/smoke.test.js
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

const OcrGgml = require('../..').OcrGgml

function modelsPresent (paths) {
  return paths.every(p => {
    try { return fs.statSync(p).isFile() } catch { return false }
  })
}

const detector = process.env.OCR_GGML_DETECTOR
const recognizer = process.env.OCR_GGML_RECOGNIZER
const image = process.env.OCR_GGML_IMAGE || path.join(__dirname, '..', '..', 'samples', 'english.png')

const ready = detector && recognizer && modelsPresent([detector, recognizer, image])

test('end-to-end OCR run produces an array of [box, text, conf] triples', { skip: !ready }, async t => {
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
    const stats = await response.await()

    t.ok(Array.isArray(collected), 'output is an array')
    if (collected && collected.length > 0) {
      const [box, text, conf] = collected[0]
      t.is(box.length, 4, 'each row has a 4-point bounding box')
      t.is(typeof text, 'string', 'second element is the text string')
      t.is(typeof conf, 'number', 'third element is the confidence number')
    }
    if (stats) {
      t.ok(typeof stats.totalTime === 'number')
      t.ok(typeof stats.detectionTime === 'number')
      t.ok(typeof stats.recognitionTime === 'number')
    }
  } finally {
    await ocr.unload()
  }
})
