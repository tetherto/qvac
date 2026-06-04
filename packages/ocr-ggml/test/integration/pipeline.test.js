'use strict'

const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath, runOcrComparison } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 60 * 1000 // 1 minute for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

test('Test for a fix of missing end of job event', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/unrecognizable_text.bmp')

  t.comment('Testing with image: ' + imagePath)

  // runOcrComparison resolves only once `await()` completes (the JobEnded event
  // fired) and fails the test on any error event — so a clean return proves the
  // pipeline finished without hanging. On a GPU host this also exercises the
  // Vulkan and forced-CPU passes.
  await runOcrComparison(t, {
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en']
    },
    imagePath,
    runOptions: { paragraph: false },
    perfLabel: '[EasyOCR pipeline unrecognizable_text]',
    perfOpts: { imagePath },
    assertResult (output) {
      t.ok(Array.isArray(output), 'output should be an array')
      t.pass('Response completed successfully - JobEnded event was received')
    }
  })

  t.pass('Pipeline completed successfully without hanging')
})
