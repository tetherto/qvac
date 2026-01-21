'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

test('OCR basic test', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  t.comment('Testing basic OCR with image: ' + imagePath)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    },
    opts: { stats: true }
  })

  await onnxOcr.load()

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        t.ok(output.length === 3, `output length should be 3, got ${output.length}`)
        const texts = output.map(o => o[1])
        t.comment('Output texts: ' + JSON.stringify(texts))
        t.ok(texts.includes('tilted'), 'should contain "tilted"')
        t.ok(texts.includes('normal'), 'should contain "normal"')
        t.ok(texts.includes('vertical'), 'should contain "vertical"')
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    t.pass('OCR basic test completed successfully')
  } finally {
    await onnxOcr.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
