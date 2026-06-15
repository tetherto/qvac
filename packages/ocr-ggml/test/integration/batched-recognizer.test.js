'use strict'

const test = require('brittle')
const { isMobile, platform, getImagePath, ensureModelPath, runOcrComparison } = require('./utils')

// QVAC-19796: true batched CRNN compute. The EasyOCR recognizer now runs a
// whole batch of text crops through ONE ggml graph execution (input
// [W,H,1,N]) instead of one compute per crop. This focused test exercises the
// N>1 path on an image with several text boxes (english.bmp → multiple
// regions) and asserts the batched output is still correct per crop — a subtle
// batching bug (wrong state/stride) would corrupt one or more regions here.
//
// The perfLabel emits recognitionTime so the batched-vs-unbatched recognition
// cost can be compared in the perf report / step summary.

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

test('EasyOCR batched recognizer: multi-crop batch is computed correctly', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/english.bmp')

  t.comment('Testing batched recognizer with image: ' + imagePath)
  t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)

  // english.bmp has multiple text boxes, so the recognizer batches N>1 crops
  // into a single CRNN graph execution — the path this change introduces.
  const expectedWords = ['health', 'world', 'water', 'hands', 'symptoms']

  await runOcrComparison(t, {
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en']
    },
    imagePath,
    runOptions: { paragraph: false },
    perfLabel: '[EasyOCR batched english]',
    perfOpts: { imagePath },
    assertResult (output) {
      t.ok(Array.isArray(output), 'output should be an array')
      // More than one region ⇒ the recognizer ran a true N>1 batch.
      t.ok(output.length > 1, `expected a multi-crop batch (>1 region), got ${output.length}`)
      const outputTexts = output.map(o => o[1].toLowerCase())
      let hits = 0
      for (const w of expectedWords) {
        if (outputTexts.some(txt => txt.includes(w))) hits++
      }
      // Batched compute must preserve accuracy: most expected words recognized.
      t.ok(hits >= 4, `batched recognizer should recognize >=4/5 expected words, got ${hits} (texts: ${JSON.stringify(outputTexts)})`)
    }
  })

  t.pass('batched recognizer test completed successfully')
})
