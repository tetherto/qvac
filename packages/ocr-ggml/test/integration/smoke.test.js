'use strict'

/**
 * End-to-end smoke tests for @qvac/ocr-ggml.
 *
 * Each test soft-skips when the corresponding model files are absent so the
 * suite stays green on developer machines without weights. In CI the
 * integration workflow downloads the pinned EasyOCR GGUF snapshot from S3
 * and sets the env vars below.
 *
 * Env vars:
 *   OCR_GGML_DETECTOR          CRAFT GGUF (EasyOCR detector — required)
 *   OCR_GGML_RECOGNIZER        recognizer GGUF (EasyOCR; CI uses latin_g2.gguf)
 *   OCR_GGML_DOCTR_DETECTOR    DBNet GGUF      (Doctr detector — optional)
 *   OCR_GGML_DOCTR_RECOGNIZER  doctr CRNN GGUF (Doctr recognizer — optional)
 *   OCR_GGML_IMAGE             optional override for the sample image path
 *
 * Local one-liner:
 *   OCR_GGML_DETECTOR=models/craft_mlt_25k.gguf \
 *   OCR_GGML_RECOGNIZER=models/latin_g2.gguf \
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

function assertRowShape (t, rows) {
  t.ok(Array.isArray(rows), 'output is an array')
  if (rows && rows.length > 0) {
    const [box, text, conf] = rows[0]
    t.is(box.length, 4, 'each row has a 4-point bounding box')
    t.is(typeof text, 'string', 'second element is the text string')
    t.is(typeof conf, 'number', 'third element is the confidence number')
  }
}

function assertStatsShape (t, stats) {
  if (!stats) return
  t.ok(typeof stats.totalTime === 'number', 'stats.totalTime is a number')
  t.ok(typeof stats.detectionTime === 'number', 'stats.detectionTime is a number')
  t.ok(typeof stats.recognitionTime === 'number', 'stats.recognitionTime is a number')
}

const detector = process.env.OCR_GGML_DETECTOR
const recognizer = process.env.OCR_GGML_RECOGNIZER
const doctrDetector = process.env.OCR_GGML_DOCTR_DETECTOR
const doctrRecognizer = process.env.OCR_GGML_DOCTR_RECOGNIZER
const image = process.env.OCR_GGML_IMAGE || path.join(__dirname, '..', '..', 'samples', 'english.png')

const easyocrReady = detector && recognizer && modelsPresent([detector, recognizer, image])
const doctrReady = doctrDetector && doctrRecognizer && modelsPresent([doctrDetector, doctrRecognizer, image])

test('easyocr pipeline produces an array of [box, text, conf] triples',
  { skip: !easyocrReady }, async t => {
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

      assertRowShape(t, collected)
      assertStatsShape(t, stats)
    } finally {
      await ocr.unload()
    }
  }
)

test('doctr pipeline produces an array of [box, text, conf] triples',
  { skip: !doctrReady }, async t => {
    const ocr = new OcrGgml({
      params: {
        pathDetector: doctrDetector,
        pathRecognizer: doctrRecognizer,
        pipelineType: 'doctr',
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

      assertRowShape(t, collected)
      assertStatsShape(t, stats)
    } finally {
      await ocr.unload()
    }
  }
)
