'use strict'

/**
 * OCR Example with Registry Model Loading
 *
 * This example demonstrates loading OCR models from the QVAC registry
 * and running text recognition on an image.
 *
 * Usage: bare examples/example.hd.js [image_path]
 *
 * Example:
 *   bare examples/example.hd.js
 *   bare examples/example.hd.js /path/to/image.jpg
 */

const { ONNXOcr } = require('..')
const process = require('bare-process')
const { ensureModels } = require('./utils')

// Parse command line arguments
const args = process.argv.slice(2)
const inputImage = args[0] || 'test/images/basic_test.bmp'

async function main () {
  console.log(`Input image: ${inputImage}`)
  console.log('')

  // Download models from registry if not cached
  const { detectorPath, recognizerPath } = await ensureModels()

  // Initialize OCR with downloaded model paths
  const model = new ONNXOcr({
    params: {
      langList: ['en'],
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      useGPU: false
    },
    opts: { stats: true }
  })

  try {
    console.log('Loading OCR model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running OCR on: ${inputImage}`)
    const response = await model.run({
      path: inputImage
    })

    console.log('Waiting for OCR results...')
    await response
      .onUpdate(data => {
        console.log('--- OCR Results ---')
        console.log('Detected text:', data.map(r => r[1]))
        console.log('')
        console.log('Full output:')
        for (const [box, text, confidence] of data) {
          console.log(`  "${text}" (confidence: ${(confidence * 100).toFixed(1)}%)`)
        }
        console.log('-------------------')
      })
      .await()

    console.log('OCR finished!')
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }

    await model.unload()
    console.log('Model unloaded.')
  } catch (err) {
    console.error('Error:', err)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
