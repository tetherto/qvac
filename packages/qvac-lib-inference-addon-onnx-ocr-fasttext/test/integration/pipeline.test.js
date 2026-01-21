'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 60 * 1000 // 1 minute for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

test('Test for a fix of missing end of job event', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/unrecognizable_text.bmp')

  t.comment('Testing with image: ' + imagePath)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en']
    },
    opts: { stats: true }
  })

  await onnxOcr.load()

  try {
    let errorReceived = false
    let responseCompleted = false

    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
      })
      .onError(error => {
        errorReceived = true
        t.fail('Unexpected error received: ' + JSON.stringify(error))
      })
      .await()
      .then(() => {
        responseCompleted = true
        t.pass('Response completed successfully - JobEnded event was received')
      })

    t.ok(!errorReceived, 'No error should be received')
    t.ok(responseCompleted, 'Response should complete - JobEnded event was received')
    t.pass('Pipeline completed successfully without hanging')
  } catch (err) {
    t.fail(`Error in test: ${err}`)
  } finally {
    await onnxOcr.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
