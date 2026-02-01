'use strict'

const process = require('bare-process')
const path = require('bare-path')
const { ONNXOcr } = require('@qvac/ocr-onnx')
const { setLogger, releaseLogger } = require('../addonLogging')

const args = process.argv.slice(2)
const [
  argImagesDir = './test/images',
  argDetectorPath = './models/ocr/detector_craft.onnx',
  argRecognizerPrefix = './models/ocr/recognizer_'
] = args

const basePath = process.cwd()

const imageDefaultPath = `${argImagesDir}/basic_test.bmp`

// Define paths relative to the example script location
const imagePath = path.join(basePath, imageDefaultPath)
const modelDetectorPath = path.join(basePath, argDetectorPath)
const modelRecognizerPrefix = path.join(basePath, argRecognizerPrefix)

async function main () {
  // Set C++ logger
  setLogger((level, message) => {
    // log levels are 0-3: ERROR, WARNING, INFO, DEBUG
    const levelNames = {
      0: 'ERROR',
      1: 'WARNING',
      2: 'INFO',
      3: 'DEBUG'
    }

    // logs can be formatted as needed. here we use a timestamp and the log level.
    const logLevel = levelNames[level] || 'UNKNOWN'
    const timestamp = new Date().toISOString()
    console.log(`[C++] [${timestamp}] [${logLevel}]: ${message}`)
  })

  const args = {
    params: {
      langList: ['en'],
      pathDetector: modelDetectorPath,
      pathRecognizerPrefix: modelRecognizerPrefix,
      useGPU: false
    },
    // Enable stats logging
    opts: { stats: true }
  }

  const model = new ONNXOcr(args)

  try {
    console.log('Loading OCR model...')
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

    // clean up the logger
    releaseLogger()
  }
}

main().catch(console.error)
