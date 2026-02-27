'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

/**
 * Test for internal image resizing.
 * Images larger than 1200px are resized internally, but bounding box
 * coordinates should be returned in original image space.
 */
test('Large images are resized internally with coordinates in original space', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  // portuguese.bmp is 1372x781 - larger than the 1200px threshold
  const imagePath = getImagePath('/test/images/portuguese.bmp')
  const originalImageWidth = 1372
  const originalImageHeight = 781

  t.comment('Testing internal resize with image: ' + imagePath + ' (' + originalImageWidth + 'x' + originalImageHeight + ')')

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
        t.ok(output.length > 0, 'should detect at least one text region')
        t.comment('Detected ' + output.length + ' text regions')

        // Check that coordinates are in original image space (can exceed 1200)
        let hasCoordBeyondResizeThreshold = false
        let maxX = 0
        let maxY = 0

        for (const item of output) {
          const coords = item[0] // [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
          for (const point of coords) {
            if (point[0] > maxX) maxX = point[0]
            if (point[1] > maxY) maxY = point[1]
            if (point[0] > 1200 || point[1] > 1200) {
              hasCoordBeyondResizeThreshold = true
            }
          }
        }

        t.comment('Max X coordinate: ' + maxX.toFixed(1) + ', Max Y coordinate: ' + maxY.toFixed(1))
        t.ok(hasCoordBeyondResizeThreshold, 'coordinates should be in original image space (some coords > 1200)')
        t.ok(maxX <= originalImageWidth, 'max X should not exceed original image width')
        t.ok(maxY <= originalImageHeight, 'max Y should not exceed original image height')
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    t.pass('Large image resize test completed successfully')
  } finally {
    await onnxOcr.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
