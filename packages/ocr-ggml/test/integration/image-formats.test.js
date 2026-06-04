'use strict'

const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath, createOcrGgml, runOcrComparison } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

const IMAGE_FORMAT_EXPECTED_TEXTS = ['tilted', 'normal', 'vertical']

test('OCR processes JPEG images correctly', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.jpg')

  t.comment('Testing JPEG format with image: ' + imagePath)

  await runOcrComparison(t, {
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en']
    },
    imagePath,
    runOptions: { paragraph: false },
    perfLabel: '[EasyOCR JPEG]',
    perfOpts: { imagePath },
    assertResult (output) {
      t.ok(Array.isArray(output), 'JPEG: output should be an array')
      t.ok(output.length === IMAGE_FORMAT_EXPECTED_TEXTS.length, `JPEG: output length should be ${IMAGE_FORMAT_EXPECTED_TEXTS.length}, got ${output.length}`)

      const texts = output.map(o => o[1])
      t.comment('JPEG output texts: ' + JSON.stringify(texts))

      for (let i = 0; i < IMAGE_FORMAT_EXPECTED_TEXTS.length; i++) {
        t.ok(texts.includes(IMAGE_FORMAT_EXPECTED_TEXTS[i]), `JPEG: should contain text "${IMAGE_FORMAT_EXPECTED_TEXTS[i]}"`)
      }
    }
  })

  t.pass('JPEG format processing completed successfully')
})

test('OCR processes PNG images correctly', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.png')

  t.comment('Testing PNG format with image: ' + imagePath)

  await runOcrComparison(t, {
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en']
    },
    imagePath,
    runOptions: { paragraph: false },
    perfLabel: '[EasyOCR PNG]',
    perfOpts: { imagePath },
    assertResult (output) {
      t.ok(Array.isArray(output), 'PNG: output should be an array')
      t.ok(output.length === IMAGE_FORMAT_EXPECTED_TEXTS.length, `PNG: output length should be ${IMAGE_FORMAT_EXPECTED_TEXTS.length}, got ${output.length}`)

      const texts = output.map(o => o[1])
      t.comment('PNG output texts: ' + JSON.stringify(texts))

      for (let i = 0; i < IMAGE_FORMAT_EXPECTED_TEXTS.length; i++) {
        t.ok(texts.includes(IMAGE_FORMAT_EXPECTED_TEXTS[i]), `PNG: should contain text "${IMAGE_FORMAT_EXPECTED_TEXTS[i]}"`)
      }
    }
  })

  t.pass('PNG format processing completed successfully')
})

// Cross-format consistency check: a single loaded instance runs BMP then JPEG
// and compares their outputs. This is a same-backend equality test (not a
// backend comparison), so it stays single-pass and is left unchanged.
test('BMP and JPEG produce consistent results', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const bmpPath = getImagePath('/test/images/basic_test.bmp')
  const jpgPath = getImagePath('/test/images/basic_test.jpg')

  const ocrGgml = createOcrGgml({
    pathDetector: detectorPath,
    pathRecognizer: recognizerPath,
    langList: ['en']
  }, { stats: true })

  await ocrGgml.load()

  let bmpTexts = []
  let jpegTexts = []

  try {
    const bmpResponse = await ocrGgml.run({
      path: bmpPath,
      options: { paragraph: false }
    })

    await bmpResponse
      .onUpdate(output => {
        bmpTexts = output.map(o => o[1]).sort()
      })
      .await()

    await new Promise(resolve => setTimeout(resolve, 2000))

    const jpegResponse = await ocrGgml.run({
      path: jpgPath,
      options: { paragraph: false }
    })

    await jpegResponse
      .onUpdate(output => {
        jpegTexts = output.map(o => o[1]).sort()
      })
      .await()

    t.comment('BMP texts: ' + JSON.stringify(bmpTexts))
    t.comment('JPEG texts: ' + JSON.stringify(jpegTexts))

    t.ok(bmpTexts.length === jpegTexts.length, 'BMP and JPEG should detect same number of text regions')

    for (const text of bmpTexts) {
      t.ok(jpegTexts.includes(text), `JPEG should also detect text "${text}" found in BMP`)
    }

    t.pass('BMP and JPEG produce consistent results')
  } finally {
    await ocrGgml.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
