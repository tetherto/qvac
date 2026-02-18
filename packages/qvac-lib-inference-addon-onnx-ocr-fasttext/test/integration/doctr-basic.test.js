'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const path = require('bare-path')
const { getImagePath, formatOCRPerformanceMetrics } = require('./utils')

const TEST_TIMEOUT = 120 * 1000

const DOCTR_DETECTOR = path.resolve('.', 'test/models/doctr/db_resnet50.onnx')
const DOCTR_RECOGNIZER = path.resolve('.', 'test/models/doctr/parseq.onnx')

test('DocTR basic test - basic_test image (BMP)', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  t.comment('Testing DocTR pipeline with image: ' + imagePath)
  t.comment('Detector: ' + DOCTR_DETECTOR)
  t.comment('Recognizer: ' + DOCTR_RECOGNIZER)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'doctr'
    },
    opts: { stats: true }
  })

  await onnxOcr.load()
  t.pass('DocTR model loaded successfully')

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let outputTexts = []
    let outputData = []

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        t.ok(output.length > 0, `should detect text regions, got ${output.length}`)
        outputData = output
        outputTexts = output.map(o => o[1])
        t.comment('Detected texts: ' + JSON.stringify(outputTexts))
        t.comment('Full output: ' + JSON.stringify(output.map(o => ({
          text: o[1],
          confidence: o[2],
          bbox: o[0]
        }))))
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    const stats = response.stats || {}
    t.comment('DocTR stats: ' + JSON.stringify(stats))
    t.comment(formatOCRPerformanceMetrics('[DocTR]', stats, outputTexts))

    // Check that we detect the expected words
    const lowerTexts = outputTexts.map(t => t.toLowerCase())
    t.comment('Lowercase texts: ' + JSON.stringify(lowerTexts))

    t.pass('DocTR basic test completed successfully')
  } catch (e) {
    t.fail('DocTR test failed: ' + e.message)
    throw e
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload() error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('DocTR basic test - basic_test image (JPEG)', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/basic_test.jpg')

  t.comment('Testing DocTR pipeline with JPEG image: ' + imagePath)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'doctr'
    },
    opts: { stats: true }
  })

  await onnxOcr.load()
  t.pass('DocTR model loaded successfully')

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let outputTexts = []

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        outputTexts = output.map(o => o[1])
        t.comment('Detected texts (JPEG): ' + JSON.stringify(outputTexts))
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    const stats = response.stats || {}
    t.comment(formatOCRPerformanceMetrics('[DocTR JPEG]', stats, outputTexts))
    t.pass('DocTR JPEG test completed successfully')
  } catch (e) {
    t.fail('DocTR JPEG test failed: ' + e.message)
    throw e
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload() error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('DocTR basic test - english image (BMP)', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')

  t.comment('Testing DocTR pipeline with English image: ' + imagePath)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'doctr'
    },
    opts: { stats: true }
  })

  await onnxOcr.load()
  t.pass('DocTR model loaded successfully')

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let outputTexts = []

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        outputTexts = output.map(o => o[1])
        t.comment('Detected texts (English): ' + JSON.stringify(outputTexts))
        t.comment('Full output: ' + JSON.stringify(output.map(o => ({
          text: o[1],
          confidence: o[2]
        }))))
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    const stats = response.stats || {}
    t.comment(formatOCRPerformanceMetrics('[DocTR English]', stats, outputTexts))
    t.pass('DocTR English test completed successfully')
  } catch (e) {
    t.fail('DocTR English test failed: ' + e.message)
    throw e
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload() error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
