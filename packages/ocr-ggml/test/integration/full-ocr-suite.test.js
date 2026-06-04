'use strict'

const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath, runOcrComparison } = require('./utils')

test('Full OCR test suite', { timeout: 40 * 60 * 1000, skip: isMobile }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const testCases = [
    {
      imagePath: '/test/images/basic_test.bmp',
      expectedTexts: ['tilted', 'normal', 'vertical'],
      options: { paragraph: false }
    },
    {
      imagePath: '/test/images/basic_test.jpg',
      expectedTexts: ['tilted', 'normal', 'vertical'],
      options: { paragraph: false }
    },
    {
      imagePath: '/test/images/basic_test.png',
      expectedTexts: ['tilted', 'normal', 'vertical'],
      options: { paragraph: false }
    },
    {
      imagePath: '/test/images/english.bmp',
      expectedTexts: ['health', 'world', 'water', 'hands', 'symptoms'],
      options: { paragraph: false }
    }
  ]

  const params = {
    pathDetector: detectorPath,
    pathRecognizer: recognizerPath,
    langList: ['en']
  }

  for (const testCase of testCases) {
    const imagePath = getImagePath(testCase.imagePath)
    const baseName = testCase.imagePath.split('/').pop()
    t.comment('\n\nImage Path: ' + testCase.imagePath)

    // Per image: GPU hosts get a Vulkan + forced-CPU pass (two rows); non-GPU
    // hosts stay single CPU pass. Expectations run on each pass.
    await runOcrComparison(t, {
      params,
      imagePath,
      runOptions: testCase.options,
      perfLabel: `[EasyOCR full-suite ${baseName}]`,
      perfOpts: { imagePath },
      assertResult (output) {
        t.ok(Array.isArray(output), testCase.imagePath + ': output should be an array')
        const texts = output.map(o => o[1])
        t.comment('Detected texts: ' + JSON.stringify(texts))

        for (const expected of testCase.expectedTexts) {
          const found = texts.some(w => w.toLowerCase().includes(expected.toLowerCase()))
          t.ok(found, testCase.imagePath + `: should detect "${expected}"`)
        }
      }
    })

    t.comment('OCR processing complete for ' + testCase.imagePath)
  }
})
