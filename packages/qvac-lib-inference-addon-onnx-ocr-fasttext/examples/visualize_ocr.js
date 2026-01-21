'use strict'

/**
 * OCR Visualization Example
 *
 * Runs OCR on an image and saves results to JSON for visualization.
 *
 * Usage: bare examples/visualize_ocr.js <input_image> [output_json] [--lang <language>]
 *
 * Example:
 *   bare examples/visualize_ocr.js /path/to/image.jpg
 *   bare examples/visualize_ocr.js /path/to/image.jpg results.json --lang it
 *
 * Then run: python3 examples/draw_boxes.py <input_image> <results_json> <output_image>
 */

const { ONNXOcr } = require('..')
const process = require('bare-process')
const fs = require('bare-fs')
const path = require('bare-path')

// Parse command line arguments
const args = process.argv.slice(2)
let inputImage = null
let outputJson = null
let language = 'en'

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--lang' && args[i + 1]) {
    language = args[i + 1]
    i++
  } else if (!inputImage) {
    inputImage = args[i]
  } else if (!outputJson) {
    outputJson = args[i]
  }
}

if (!inputImage) {
  console.error('Usage: bare examples/visualize_ocr.js <input_image> [output_json] [--lang <language>]')
  console.error('')
  console.error('Options:')
  console.error('  --lang <language>  Language code (default: en)')
  console.error('')
  console.error('Example:')
  console.error('  bare examples/visualize_ocr.js photo.jpg results.json --lang it')
  console.error('  python3 examples/draw_boxes.py photo.jpg results.json photo_ocr.jpg')
  process.exit(1)
}

// Default output name
if (!outputJson) {
  const ext = path.extname(inputImage)
  const base = path.basename(inputImage, ext)
  const dir = path.dirname(inputImage)
  outputJson = path.join(dir, `${base}_ocr.json`)
}

async function main () {
  console.log(`Input: ${inputImage}`)
  console.log(`Output JSON: ${outputJson}`)
  console.log(`Language: ${language}`)
  console.log('')

  // Initialize OCR with configurable parameters
  // - magRatio: 1.5 (better quality) vs 1.0 (faster, EasyOCR default)
  // - defaultRotationAngles: [] (no rotation) vs [90, 270] (try rotations)
  // - contrastRetry: false (faster) vs true (retry low confidence with adjusted contrast)
  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/detector_craft.onnx',
      pathRecognizer: 'models/ocr/recognizer_latin.onnx',
      langList: [language],
      useGPU: false,
      // Performance tuning parameters
      magRatio: 1.5,                  // Detection magnification (1.5 = better for small text)
      defaultRotationAngles: [],      // Empty = no rotation variants (EasyOCR default)
      contrastRetry: true             // Retry low confidence with adjusted contrast (EasyOCR default)
    },
    opts: { stats: false }
  })

  console.log('Loading OCR model...')
  await onnxOcr.load()

  console.log('Running OCR...')
  const startTime = Date.now()

  let results = []
  const response = await onnxOcr.run({
    path: inputImage,
    options: { paragraph: false }
  })

  await response
    .onUpdate(output => {
      results = output
    })
    .await()

  const elapsed = Date.now() - startTime
  console.log(`OCR completed in ${elapsed}ms`)
  console.log(`Found ${results.length} text regions`)
  console.log('')

  // Print results
  console.log('Detected text:')
  console.log('─'.repeat(60))
  for (let i = 0; i < results.length; i++) {
    const [box, text, confidence] = results[i]
    console.log(`[${i + 1}] "${text}" (confidence: ${(confidence * 100).toFixed(1)}%)`)
  }
  console.log('─'.repeat(60))

  // Save results to JSON
  const jsonOutput = {
    input_image: inputImage,
    language: language,
    elapsed_ms: elapsed,
    results: results.map(r => ({
      box: r[0],
      text: r[1],
      confidence: r[2]
    }))
  }

  fs.writeFileSync(outputJson, JSON.stringify(jsonOutput, null, 2))
  console.log(`\nResults saved to: ${outputJson}`)
  console.log(`\nTo visualize, run:`)
  console.log(`  python3 examples/draw_boxes.py ${inputImage} ${outputJson} output.jpg`)

  await onnxOcr.unload()
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
