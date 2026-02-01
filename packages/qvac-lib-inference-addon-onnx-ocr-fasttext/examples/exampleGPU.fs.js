'use strict'

const process = require('bare-process')
const path = require('bare-path')
const { ONNXOcr } = require('@qvac/ocr-onnx')

const args = process.argv.slice(2)
const [
  argImagesDir = './test/images',
  argDetectorPath = './models/ocr/detector_craft.onnx',
  argRecognizerPath = './models/ocr/recognizer_latin.onnx'
] = args

const basePath = process.cwd()

const imageDefaultPath = `${argImagesDir}/basic_test.bmp`

// Define paths relative to the example script location
const imagePath = path.join(basePath, imageDefaultPath)
const modelDetectorPath = path.join(basePath, argDetectorPath)
const modelRecognizerPath = path.join(basePath, argRecognizerPath)

async function main () {
  const args = {
    params: {
      langList: ['en'],
      pathDetector: modelDetectorPath,
      pathRecognizer: modelRecognizerPath, // explicitly providing the recognizer path
      useGPU: true // main difference from example.fs.js
    },
    // Enable stats logging
    opts: { stats: true }
  }

  const model = new ONNXOcr(args)

  try {
    console.log('Loading OCR model with useGPU=true...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running OCR on: ${imagePath}`)
    const response = await model.run({
      path: imagePath
      // options: { paragraph: true } // Optional paragraph mode
    })

    console.log('Waiting for OCR results...')
    await response
      .onUpdate(data => {
        console.log('--- OCR Update ---')
        console.log('Output: ' + JSON.stringify(data.map(o => o[1])))
        console.log('--- data ---')
        // Output structure might vary based on paragraph option and updates
        // Refer to Output Format section
        console.log(JSON.stringify(data, null, 2))
        console.log('------------------')
      })
      .await() // Wait for the final result

    console.log('OCR finished!')
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }
  } catch (err) {
    console.error('Error during OCR processing:', err)
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
  }
}

main().catch(console.error)
