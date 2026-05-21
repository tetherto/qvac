'use strict'

const { OcrGgml } = require('../..')
const test = require('brittle')
const { isMobile, platform, getImagePath, ensureModelPath, formatOCRPerformanceMetrics } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

test('OCR basic test', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  t.comment('Testing basic OCR with image: ' + imagePath)
  t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)

  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en']
    },
    opts: { stats: true }
  })

  await ocrGgml.load()
  t.pass('OCR model loaded successfully')

  try {
    const response = await ocrGgml.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let outputTexts = []

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        t.ok(output.length === 3, `output length should be 3, got ${output.length}`)
        outputTexts = output.map(o => o[1])
        t.ok(outputTexts.includes('tilted'), 'should contain "tilted"')
        t.ok(outputTexts.includes('normal'), 'should contain "normal"')
        t.ok(outputTexts.includes('vertical'), 'should contain "vertical"')
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    // Display stats
    const stats = response.stats || {}
    t.comment('Native addon stats: ' + JSON.stringify(stats))
    t.comment(formatOCRPerformanceMetrics('[OCR]', stats, outputTexts, { skipReport: true }))

    t.pass('OCR basic test completed successfully')
  } catch (e) {
    t.fail('OCR test failed: ' + e.message)
    throw e
  } finally {
    try {
      await ocrGgml.unload()
    } catch (e) {
      t.comment('unload() error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
