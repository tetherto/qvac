'use strict'

/**
 * Batch CLI wrapper for QVAC OCR GGML addon (file-based).
 *
 * Usage:
 *   bare ocr_batch_cli.js --input <file> --output <file>
 *                         --detector <path> --recognizer <path>
 *                         [--pipeline easyocr|doctr] [--lang en]
 *
 * Input file: one image path per line
 * Output file: one JSON result per line (JSONL, same order as input)
 *
 * Stderr markers (same protocol as ocr-onnx batch CLI):
 *   BATCH_START:<N>      emitted before model load
 *   MODEL_READY:<ms>     emitted after model load
 *   PROGRESS:<i>/<N>     emitted after each image
 *   BATCH_DONE           emitted after all images written
 *   ERROR:<message>      emitted on fatal error
 */

const process = require('bare-process')
const fs = require('bare-fs')

const args = process.argv.slice(2)
let language = 'en'
let inputFile = null
let outputFile = null
let detectorPath = null
let recognizerPath = null
let pipeline = 'easyocr'

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--lang' && args[i + 1]) {
    language = args[i + 1]
    i++
  } else if (args[i] === '--input' && args[i + 1]) {
    inputFile = args[i + 1]
    i++
  } else if (args[i] === '--output' && args[i + 1]) {
    outputFile = args[i + 1]
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

if (!inputFile || !outputFile) {
  console.error('Usage: bare ocr_batch_cli.js --input <file> --output <file> --detector <path> --recognizer <path> [--pipeline easyocr|doctr] [--lang en]')
  process.exit(1)
}

if (!detectorPath || !recognizerPath) {
  console.error('Error: --detector and --recognizer are required')
  process.exit(1)
}

async function processImage (model, imagePath) {
  const startTime = Date.now()

  try {
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

    const elapsed = Date.now() - startTime

    return {
      path: imagePath,
      boxes,
      text: texts.join(' '),
      confidence: avgConfidence,
      time_ms: elapsed
    }
  } catch (err) {
    const elapsed = Date.now() - startTime
    return {
      path: imagePath,
      error: err.message,
      time_ms: elapsed
    }
  }
}

async function main () {
  let model = null

  try {
    const inputContent = fs.readFileSync(inputFile, 'utf8')
    const imagePaths = inputContent.trim().split('\n').filter(line => line.trim())

    if (imagePaths.length === 0) {
      console.error('No image paths in input file')
      process.exit(1)
    }

    console.error('BATCH_START:' + imagePaths.length)

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

    const loadStart = Date.now()
    model = new OcrGgml({
      params,
      opts: { stats: false }
    })

    await model.load()
    const loadTime = Date.now() - loadStart
    console.error('MODEL_READY:' + loadTime)

    const results = []
    for (let i = 0; i < imagePaths.length; i++) {
      const imagePath = imagePaths[i].trim()
      const result = await processImage(model, imagePath)
      results.push(JSON.stringify(result))
      console.error('PROGRESS:' + (i + 1) + '/' + imagePaths.length)
    }

    fs.writeFileSync(outputFile, results.join('\n') + '\n')
    console.error('BATCH_DONE')

    await model.unload()
    process.exit(0)
  } catch (err) {
    console.error('ERROR:' + err.message)
    if (model) {
      try {
        await model.unload()
      } catch (e) {
        // ignore cleanup errors
      }
    }
    process.exit(1)
  }
}

main()
