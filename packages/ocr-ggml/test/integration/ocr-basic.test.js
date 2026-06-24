'use strict'

const test = require('brittle')
const { isMobile, platform, getImagePath, ensureModelPath, runOcrComparison } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

test('OCR basic test', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  t.comment('Testing basic OCR with image: ' + imagePath)
  t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)

  // On a GPU host this runs a Vulkan pass and a forced-CPU pass (two perf rows);
  // on non-GPU/local it stays a single CPU pass. The assertions below run on
  // every pass, proving CPU/Vulkan parity where both execute.
  await runOcrComparison(t, {
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en']
    },
    imagePath,
    runOptions: { paragraph: false },
    perfLabel: '[EasyOCR basic_test]',
    perfOpts: { imagePath },
    assertResult (output) {
      t.ok(Array.isArray(output), 'output should be an array')
      t.ok(output.length === 3, `output length should be 3, got ${output.length}`)
      const outputTexts = output.map(o => o[1])
      t.ok(outputTexts.includes('tilted'), 'should contain "tilted"')
      t.ok(outputTexts.includes('normal'), 'should contain "normal"')
      t.ok(outputTexts.includes('vertical'), 'should contain "vertical"')
    }
  })

  t.pass('OCR basic test completed successfully')
})
