'use strict'

/**
 * CLI wrapper for QVAC OCR addon.
 *
 * Usage: bare ocr_cli.js <image_path> [--lang <language>]
 *
 * Outputs JSON to stdout:
 * {
 *   "boxes": [[[x1,y1], [x2,y2], [x3,y3], [x4,y4]], "text", confidence],
 *   "text": "combined text",
 *   "confidence": 0.95
 * }
 */

const process = require('bare-process')
const path = require('bare-path')

// Parse command line arguments
const args = process.argv.slice(2)
if (args.length < 1) {
  console.error('Usage: bare ocr_cli.js <image_path> [--lang <language>]')
  process.exit(1)
}

const imagePath = args[0]
let language = 'en'

// Parse optional arguments
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--lang' && args[i + 1]) {
    language = args[i + 1]
    i++
  }
}

async function main () {
  try {
    // Import OCR module - adjust path based on where this script is run from
    const { ONNXOcr } = require('../..')

    const model = new ONNXOcr({
      params: {
        langList: [language],
        pathDetector: './models/ocr/rec_dyn/detector_craft.onnx',
        pathRecognizerPrefix: './models/ocr/rec_dyn/recognizer_',
        useGPU: false
      },
      opts: {
        stats: false
      }
    })

    await model.load()

    const response = await model.run({ path: imagePath })

    let result = []
    await response.onUpdate(data => {
      result = data
    }).await()

    // Format output
    // result is: [[[bbox], text, confidence], ...]
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
