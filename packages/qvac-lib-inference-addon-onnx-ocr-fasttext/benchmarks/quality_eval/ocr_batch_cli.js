'use strict'

/**
 * Batch CLI wrapper for QVAC OCR addon (file-based).
 *
 * Usage: bare ocr_batch_cli.js --input <input_file> --output <output_file> [--lang <language>]
 *
 * Input file: one image path per line
 * Output file: one JSON result per line (same order as input)
 */

const process = require('bare-process')
const fs = require('bare-fs')

// Parse command line arguments
const args = process.argv.slice(2)
let language = 'en'
let inputFile = null
let outputFile = null
let modelDir = 'rec_dyn'

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
  } else if (args[i] === '--model-dir' && args[i + 1]) {
    modelDir = args[i + 1]
    i++
  }
}

if (!inputFile || !outputFile) {
  console.error('Usage: bare ocr_batch_cli.js --input <input_file> --output <output_file> [--lang <language>]')
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
      boxes: boxes,
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
    // Read input file
    const inputContent = fs.readFileSync(inputFile, 'utf8')
    const imagePaths = inputContent.trim().split('\n').filter(line => line.trim())

    if (imagePaths.length === 0) {
      console.error('No image paths in input file')
      process.exit(1)
    }

    console.error('BATCH_START:' + imagePaths.length)

    // Import OCR module
    const { ONNXOcr } = require('../..')

    const loadStart = Date.now()
    model = new ONNXOcr({
      params: {
        langList: [language],
        pathDetector: `./models/ocr/${modelDir}/detector_craft.onnx`,
        pathRecognizerPrefix: `./models/ocr/${modelDir}/recognizer_`,
        useGPU: false,
        // Match EasyOCR defaults for fair comparison
        magRatio: 1.0,
        defaultRotationAngles: [],
        contrastRetry: true
      },
      opts: {
        stats: false
      }
    })

    await model.load()
    const loadTime = Date.now() - loadStart
    console.error('MODEL_READY:' + loadTime)

    // Process all images
    const results = []
    for (let i = 0; i < imagePaths.length; i++) {
      const imagePath = imagePaths[i].trim()
      const result = await processImage(model, imagePath)
      results.push(JSON.stringify(result))
      console.error('PROGRESS:' + (i + 1) + '/' + imagePaths.length)
    }

    // Write output file
    fs.writeFileSync(outputFile, results.join('\n') + '\n')
    console.error('BATCH_DONE')

    // Cleanup
    await model.unload()
    process.exit(0)
  } catch (err) {
    console.error('ERROR:' + err.message)
    if (model) {
      try {
        await model.unload()
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    process.exit(1)
  }
}

main()
