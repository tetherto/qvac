'use strict'

const { OcrGgml } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath } = require('./utils')

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

  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en']
    },
    opts: { stats: true }
  })

  await ocrGgml.load()
  t.pass('OCR model loaded')

  try {
    for (const testCase of testCases) {
      const imagePath = getImagePath(testCase.imagePath)
      t.comment('\n\nImage Path: ' + testCase.imagePath)

      const response = await ocrGgml.run({ path: imagePath, options: testCase.options })

      await response
        .onUpdate(output => {
          t.ok(Array.isArray(output), testCase.imagePath + ': output should be an array')
          const texts = output.map(o => o[1])
          t.comment('Detected texts: ' + JSON.stringify(texts))

          for (const expected of testCase.expectedTexts) {
            const found = texts.some(w => w.toLowerCase().includes(expected.toLowerCase()))
            t.ok(found, testCase.imagePath + `: should detect "${expected}"`)
          }
        })
        .onError(error => {
          t.fail(testCase.imagePath + ': unexpected error: ' + JSON.stringify(error))
        })
        .await()

      t.comment('OCR processing complete for ' + testCase.imagePath)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  } catch (err) {
    t.fail('Error running test suite: ' + err)
  } finally {
    try {
      await ocrGgml.unload()
      t.comment('Successfully unloaded model')
    } catch (err) {
      t.comment('unload() failed: ' + err.message)
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
})
