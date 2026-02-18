'use strict'

const process = require('bare-process')
const path = require('bare-path')
const { ONNXOcr } = require('@qvac/ocr-onnx')
const { ensureModels } = require('./utils')

const args = process.argv.slice(2)
const inputImage = args[0] || './test/images/basic_test.bmp'

const basePath = process.cwd()
const imagePath = path.join(basePath, inputImage)

async function main () {
  // Download models if not present (via Hyperdrive)
  const { detectorPath, recognizerPath } = await ensureModels()

  const model = new ONNXOcr({
    params: {
      langList: ['en'],
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      useGPU: true // main difference from example.fs.js
    },
    opts: { stats: true }
  })

  try {
    console.log('Loading OCR model with useGPU=true...')
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
  }
}

main().catch(console.error)
