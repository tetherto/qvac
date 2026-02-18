'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const path = require('bare-path')
const { getImagePath, formatOCRPerformanceMetrics } = require('./utils')

const TEST_TIMEOUT = 120 * 1000

const DOCTR_DETECTOR = path.resolve('.', 'test/models/doctr/db_resnet50.onnx')
const DOCTR_RECOGNIZER = path.resolve('.', 'test/models/doctr/parseq.onnx')

test('DocTR french test - accented characters', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/french.bmp')

  t.comment('Testing DocTR pipeline with French image (accented chars): ' + imagePath)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['fr'],
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
        t.ok(output.length > 0, `should detect text regions, got ${output.length}`)
        outputTexts = output.map(o => o[1])
        t.comment('Detected texts (French): ' + JSON.stringify(outputTexts))
        t.comment('Full output: ' + JSON.stringify(output.map(o => ({
          text: o[1],
          confidence: o[2]
        }))))

        // Check for accented characters in the output
        const hasAccent = outputTexts.some(t =>
          /[àâéèêëîïôùûüçÀÂÉÈÊËÎÏÔÙÛÜÇ]/.test(t)
        )
        t.comment('Contains accented characters: ' + hasAccent)
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    const stats = response.stats || {}
    t.comment(formatOCRPerformanceMetrics('[DocTR French]', stats, outputTexts))
    t.pass('DocTR French test completed successfully')
  } catch (e) {
    t.fail('DocTR French test failed: ' + e.message)
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
