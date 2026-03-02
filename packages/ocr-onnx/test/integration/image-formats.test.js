'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000 // 10 minutes for mobile
const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

const IMAGE_FORMAT_EXPECTED_TEXTS = ['tilted', 'normal', 'vertical']

test('OCR processes JPEG images correctly', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.jpg')

  t.comment('Testing JPEG format with image: ' + imagePath)

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
        t.ok(Array.isArray(output), 'JPEG: output should be an array')
        t.ok(output.length === IMAGE_FORMAT_EXPECTED_TEXTS.length, `JPEG: output length should be ${IMAGE_FORMAT_EXPECTED_TEXTS.length}, got ${output.length}`)

        const texts = output.map(o => o[1])
        t.comment('JPEG output texts: ' + JSON.stringify(texts))

        for (let i = 0; i < IMAGE_FORMAT_EXPECTED_TEXTS.length; i++) {
          t.ok(texts.includes(IMAGE_FORMAT_EXPECTED_TEXTS[i]), `JPEG: should contain text "${IMAGE_FORMAT_EXPECTED_TEXTS[i]}"`)
        }
      })
      .onError(error => {
        t.fail('JPEG: unexpected error: ' + JSON.stringify(error))
      })
      .await()

    t.pass('JPEG format processing completed successfully')
  } finally {
    await onnxOcr.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('OCR processes PNG images correctly', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.png')

  t.comment('Testing PNG format with image: ' + imagePath)

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
        t.ok(Array.isArray(output), 'PNG: output should be an array')
        t.ok(output.length === IMAGE_FORMAT_EXPECTED_TEXTS.length, `PNG: output length should be ${IMAGE_FORMAT_EXPECTED_TEXTS.length}, got ${output.length}`)

        const texts = output.map(o => o[1])
        t.comment('PNG output texts: ' + JSON.stringify(texts))

        for (let i = 0; i < IMAGE_FORMAT_EXPECTED_TEXTS.length; i++) {
          t.ok(texts.includes(IMAGE_FORMAT_EXPECTED_TEXTS[i]), `PNG: should contain text "${IMAGE_FORMAT_EXPECTED_TEXTS[i]}"`)
        }
      })
      .onError(error => {
        t.fail('PNG: unexpected error: ' + JSON.stringify(error))
      })
      .await()

    t.pass('PNG format processing completed successfully')
  } finally {
    await onnxOcr.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('BMP and JPEG produce consistent results', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const bmpPath = getImagePath('/test/images/basic_test.bmp')
  const jpgPath = getImagePath('/test/images/basic_test.jpg')

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

  let bmpTexts = []
  let jpegTexts = []

  try {
    const bmpResponse = await onnxOcr.run({
      path: bmpPath,
      options: { paragraph: false }
    })

    await bmpResponse
      .onUpdate(output => {
        bmpTexts = output.map(o => o[1]).sort()
      })
      .await()

    await new Promise(resolve => setTimeout(resolve, 2000))

    const jpegResponse = await onnxOcr.run({
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
    await onnxOcr.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
