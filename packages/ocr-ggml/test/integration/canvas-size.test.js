'use strict'

const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath, runOcrComparison } = require('./utils')

// 10 minutes: the dense page is heavy on slow CI runners.
const TEST_TIMEOUT = 600 * 1000

// Regression for QVAC-19340: dense high-resolution pages drove CRAFT detection
// peak memory to ~13 GB (canvas capped at the 2560 default), OOM-killing the
// host on memory-constrained Android devices. `canvasSize` caps the detection
// canvas (EasyOCR's `canvas_size`) so callers can bound peak memory. A smaller
// canvas must still configure, run, and return text on a dense page.
// Desktop-only: this regression deliberately drives a dense page through the
// detector to exercise the canvas cap. Even at canvasSize=1280 the CRAFT peak
// (~3.6 GB) exceeds iOS/Android jetsam limits on Device Farm phones, so running
// it there would re-trigger the very OOM it guards against. The cap behaviour
// is deterministic and fully validated on desktop CI.
test('canvasSize bounds the detection canvas and still recognizes a dense page', { timeout: TEST_TIMEOUT, skip: isMobile }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  // lab_results.png is a dense 1414x2000 page (~100+ text regions): the fixture
  // that triggered the original Android OOM.
  const imagePath = getImagePath('/test/images/lab_results.png')

  // Disable rotation retry: it triples recognition work on this dense page
  // (each box re-run at 90/270) without adding value to the memory-cap
  // assertion, and would otherwise blow the desktop test budget on slow CI.
  await runOcrComparison(t, {
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      canvasSize: 1280
    },
    imagePath,
    runOptions: { paragraph: false, rotationAngles: [] },
    perfLabel: '[EasyOCR canvasSize lab_results]',
    perfOpts: { imagePath },
    assertResult (output) {
      t.ok(Array.isArray(output), 'output should be an array')
      t.ok(output.length > 0, 'dense page should still produce text regions with a smaller canvas')
      const texts = output.map(o => String(o[1]).toLowerCase())
      t.comment('Detected ' + output.length + ' regions (canvasSize=1280)')

      // Recognition content varies slightly with canvas size; assert that at
      // least one stable keyword from this lab report is still recognized.
      const expected = ['medivista', 'hospital', 'clinical', 'biochemistry', 'patient']
      const matched = expected.filter(w => texts.some(line => line.includes(w)))
      t.comment('Matched keywords: ' + JSON.stringify(matched))
      t.ok(matched.length > 0, 'should still recognize at least one expected keyword with a reduced canvas')
    }
  })

  t.pass('canvasSize regression test completed successfully')
})
