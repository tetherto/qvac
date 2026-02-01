'use strict'

/**
 * OCR Example with Hyperdrive Model Loading
 *
 * This example demonstrates loading OCR models from Hyperdrive
 * and running text recognition on an image.
 *
 * Usage: bare examples/example.hd.js [image_path]
 *
 * Example:
 *   bare examples/example.hd.js
 *   bare examples/example.hd.js /path/to/image.jpg
 */

const HyperdriveDL = require('@qvac/dl-hyperdrive')
const { ONNXOcr } = require('..')
const process = require('bare-process')
const path = require('bare-path')
const fs = require('bare-fs')

// Model configuration
const MODEL_KEY = 'hd://03d712abb026bc390cfe803fb851a1b4a581c31c5b9335ef6294333bbeb60043'
const MODEL_FILES = {
  detector: 'detector_craft.onnx',
  recognizer: 'recognizer_latin.onnx'
}

// Parse command line arguments
const args = process.argv.slice(2)
const inputImage = args[0] || 'test/images/basic_test.bmp'

// Local disk path for storing downloaded models
const diskPath = './models/hd'

async function downloadModels (hdDL) {
  console.log('Downloading models from Hyperdrive...')

  // Ensure disk path exists
  if (!fs.existsSync(diskPath)) {
    fs.mkdirSync(diskPath, { recursive: true })
  }

  const detectorLocalPath = path.join(diskPath, MODEL_FILES.detector)
  const recognizerLocalPath = path.join(diskPath, MODEL_FILES.recognizer)

  // Check if models are already cached
  const detectorCached = fs.existsSync(detectorLocalPath)
  const recognizerCached = fs.existsSync(recognizerLocalPath)

  // Download detector model if not cached
  if (!detectorCached) {
    console.log(`Downloading detector: ${MODEL_FILES.detector}`)
    const detectorDownload = await hdDL.download(MODEL_FILES.detector, {
      diskPath,
      progressCallback: (data) => console.log('Detector progress:', data)
    })
    await detectorDownload.await()
    console.log('Detector downloaded.')
  } else {
    console.log('Detector already exists, skipping download.')
  }

  // Download recognizer model if not cached
  if (!recognizerCached) {
    console.log(`Downloading recognizer: ${MODEL_FILES.recognizer}`)
    const recognizerDownload = await hdDL.download(MODEL_FILES.recognizer, {
      diskPath,
      progressCallback: (data) => console.log('Recognizer progress:', data)
    })
    await recognizerDownload.await()
    console.log('Recognizer downloaded.')
  } else {
    console.log('Recognizer already exists, skipping download.')
  }

  return {
    detectorPath: detectorLocalPath,
    recognizerPath: recognizerLocalPath
  }
}

async function main () {
  console.log(`Input image: ${inputImage}`)
  console.log(`Model key: ${MODEL_KEY}`)
  console.log('')

  // Initialize Hyperdrive loader
  const hdDL = new HyperdriveDL({
    key: MODEL_KEY
  })

  try {
    // Wait for Hyperdrive to be ready
    await hdDL.ready()

    // Download models from Hyperdrive
    const { detectorPath, recognizerPath } = await downloadModels(hdDL)

    // Initialize OCR with downloaded model paths
    const ocrArgs = {
      params: {
        langList: ['en'],
        pathDetector: detectorPath,
        pathRecognizer: recognizerPath,
        useGPU: false
      },
      opts: { stats: true }
    }

    const model = new ONNXOcr(ocrArgs)

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
  } finally {
    // Close Hyperdrive connection
    await hdDL.close()
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
