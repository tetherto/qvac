'use strict'

const process = require('bare-process')
const path = require('bare-path')
const { ONNXOcr } = require('@qvac/ocr-onnx')
const { setLogger, releaseLogger } = require('../addonLogging')
const { ensureModels } = require('./utils')

const args = process.argv.slice(2)
const inputImage = args[0] || './test/images/basic_test.bmp'

const basePath = process.cwd()
const imagePath = path.join(basePath, inputImage)

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

  // Download models if not present (via registry)
  const { detectorPath, recognizerPath } = await ensureModels()

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

    console.log(`Running OCR on: ${imagePath}`)
    const response = await model.run({
      path: imagePath
    })

    console.log('Waiting for OCR results...')
    await response
      .onUpdate(data => {
        console.log('--- OCR Update ---')
        console.log('Output: ' + JSON.stringify(data.map(o => o[1])))
        console.log('--- data ---')
        console.log(JSON.stringify(data, null, 2))
        console.log('------------------')
      })
      .await()

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
