'use strict'

/**
 * CLI wrapper for QVAC OCR GGML addon.
 *
 * Usage:
 *   bare ocr_cli.js <image_path> --detector <path> --recognizer <path>
 *                                [--pipeline easyocr|doctr] [--lang en]
 *
 * Outputs JSON to stdout:
 * {
 *   "boxes": [[[x1,y1], [x2,y2], [x3,y3], [x4,y4]], "text", confidence],
 *   "text": "combined text",
 *   "confidence": 0.95
 * }
 */

const process = require('bare-process')

const args = process.argv.slice(2)
if (args.length < 1) {
  console.error('Usage: bare ocr_cli.js <image_path> --detector <path> --recognizer <path> [--pipeline easyocr|doctr] [--lang en]')
  process.exit(1)
}

const imagePath = args[0]
let language = 'en'
let detectorPath = null
let recognizerPath = null
let pipeline = 'easyocr'

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--lang' && args[i + 1]) {
    language = args[i + 1]
    i++
  } else if (args[i] === '--detector' && args[i + 1]) {
    detectorPath = args[i + 1]
    i++
  } else if (args[i] === '--recognizer' && args[i + 1]) {
    recognizerPath = args[i + 1]
    i++
  } else if (args[i] === '--pipeline' && args[i + 1]) {
    pipeline = args[i + 1]
    i++
  }
}

if (!detectorPath || !recognizerPath) {
  console.error('Error: --detector and --recognizer are required')
  process.exit(1)
}

async function main () {
  try {
    const { OcrGgml } = require('../..')

    const params = {
      langList: [language],
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      magRatio: 1.0,
      defaultRotationAngles: [],
      contrastRetry: true
    }
    if (pipeline !== 'easyocr') {
      params.pipelineType = pipeline
    }

    const model = new OcrGgml({
      params,
      opts: { stats: false }
    })

    await model.load()

    const response = await model.run({ path: imagePath })

    let result = []
    await response.onUpdate(data => {
      result = data
    }).await()

    const boxes = result || []
    const texts = boxes.map(item => item[1] || '')
    const confidences = boxes.map(item => item[2] || 0)
    const avgConfidence = confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0

    const output = {
      boxes: boxes,
      text: texts.join(' '),
      confidence: avgConfidence
    }

    console.log(JSON.stringify(output))

    await model.unload()
    process.exit(0)
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
}

main()
