'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, platform, getImagePath, ensureModelPath, formatOCRPerformanceMetrics, windowsOrtParams } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

/**
 * Device configurations for testing
 * - Mobile (iOS/Android): Both CPU and GPU
 * - Desktop: CPU only
 */
const ALL_DEVICE_CONFIGS = [
  { id: 'gpu', useGpu: true },
  { id: 'cpu', useGpu: false }
]

const DEVICE_CONFIGS = isMobile
  ? ALL_DEVICE_CONFIGS
  : ALL_DEVICE_CONFIGS.filter(c => c.id === 'cpu')

for (const deviceConfig of DEVICE_CONFIGS) {
  const label = `[${deviceConfig.id.toUpperCase()}]`

  test(`OCR basic test ${label}`, { timeout: TEST_TIMEOUT }, async function (t) {
    const detectorPath = await ensureModelPath('detector_craft')
    const recognizerPath = await ensureModelPath('recognizer_latin')
    const imagePath = getImagePath('/test/images/basic_test.bmp')

    t.comment(`${label} Testing basic OCR with image: ` + imagePath)
    t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
    t.comment(`${label} Testing with useGPU: ${deviceConfig.useGpu}`)

    const onnxOcr = new ONNXOcr({
      params: {
        pathDetector: detectorPath,
        pathRecognizer: recognizerPath,
        langList: ['en'],
        useGPU: deviceConfig.useGpu,
        ...windowsOrtParams
      },
      opts: { stats: true }
    })

    await onnxOcr.load()
    t.pass(`${label} OCR model loaded successfully`)

    try {
      const response = await onnxOcr.run({
        path: imagePath,
        options: { paragraph: false }
      })

      let outputTexts = []

      await response
        .onUpdate(output => {
          t.ok(Array.isArray(output), `${label} output should be an array`)
          t.ok(output.length === 3, `${label} output length should be 3, got ${output.length}`)
          outputTexts = output.map(o => o[1])
          t.ok(outputTexts.includes('tilted'), `${label} should contain "tilted"`)
          t.ok(outputTexts.includes('normal'), `${label} should contain "normal"`)
          t.ok(outputTexts.includes('vertical'), `${label} should contain "vertical"`)
        })
        .onError(error => {
          t.fail(`${label} unexpected error: ` + JSON.stringify(error))
        })
        .await()

      // Display stats
      const stats = response.stats || {}
      t.comment(`${label} Native addon stats: ` + JSON.stringify(stats))
      t.comment(formatOCRPerformanceMetrics(`[OCR] ${label}`, stats, outputTexts, { skipReport: true }))

      t.pass(`${label} OCR basic test completed successfully`)
    } catch (e) {
      t.fail(`${label} OCR test failed: ` + e.message)
      throw e
    } finally {
      try {
        await onnxOcr.unload()
      } catch (e) {
        t.comment(`${label} unload() error: ` + e.message)
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  })
}
