'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const isMacCI = os.platform() === 'darwin'

// const latinLangList = ['af', 'az', 'bs', 'cs', 'cy', 'da', 'de', 'en', 'es', 'et', 'fr', 'ga', 'hr', 'hu',
//   'id', 'is', 'it', 'ku', 'la', 'lt', 'lv', 'mi', 'ms', 'mt', 'nl', 'no', 'oc', 'pi', 'pl', 'pt', 'ro', 'rs_latin',
//   'sk', 'sl', 'sq', 'sv', 'sw', 'tl', 'tr', 'uz', 'vi']
const arabicLangList = ['ar', 'fa', 'ug', 'ur']
const bengaliLangList = ['bn', 'as', 'mni']
const cyrillicLangList = ['ru', 'rs_cyrillic', 'be', 'bg', 'uk', 'mn', 'abq', 'ady', 'kbd', 'ava', 'dar', 'inh', 'che',
  'lbe', 'lez', 'tab', 'tjk']
const devanagariLangList = ['hi', 'mr', 'ne', 'bh', 'mai', 'ang', 'bho', 'mah', 'sck', 'new', 'gom', 'sa', 'bgc']
// const otherLangList = ['th', 'ch_sim', 'ch_tra', 'ja', 'ko', 'ta', 'te', 'kn']

function getRecognizerModelName (langList) {
  const langMap = {
    th: 'thai',
    ch_tra: 'zh_tra',
    ch_sim: 'zh_sim',
    ja: 'japanese',
    ko: 'korean',
    ta: 'tamil',
    te: 'telugu',
    kn: 'kannada'
  }
  for (const key in langMap) {
    if (langList.includes(key)) return langMap[key]
  }

  for (const lang of langList) {
    if (bengaliLangList.includes(lang)) {
      return 'bengali'
    }
    if (arabicLangList.includes(lang)) {
      return 'arabic'
    }
    if (devanagariLangList.includes(lang)) {
      return 'devanagari'
    }
    if (cyrillicLangList.includes(lang)) {
      return 'cyrillic'
    }
  }

  return 'latin'
}

// TODO: break this into smaller tests and remove timeout
test('OCR tests', { timeout: 40 * 60 * 1000 }, async function (t) { // 40 minutes
  const rootPath = path.resolve('.')
  const testCaseList = JSON.parse(fs.readFileSync(rootPath + '/test/test_cases.json', 'utf8'))

  for (const testCase of testCaseList) {
    const recognizerModelName = getRecognizerModelName(testCase.langList)
    t.comment('\n\nImage Path: ' + testCase.imagePath)
    t.comment('Language List: ' + testCase.langList)
    t.comment('Recognizer Model Name: ' + recognizerModelName)
    const defaultTimeout = isMacCI ? 300 : 120
    const timeout = testCase.timeout ?? defaultTimeout
    t.comment('Timeout: ' + timeout)

    const onnxOcr = new ONNXOcr({
      params: {
        pathDetector: 'models/ocr/detector_craft.onnx',
        pathRecognizer: `models/ocr/recognizer_${recognizerModelName}.onnx`,
        langList: testCase.langList,
        useGPU: false,
        timeout
      },
      opts: { stats: true }
    })
    await onnxOcr.load()

    try {
      for (const test of testCase.tests) {
        const prefixStr = `[${testCase.imagePath}] `
        // Use platform-specific expected output if available
        const expectedOutput = (isMacCI && test.expectedOutputMacOS) ? test.expectedOutputMacOS : test.expectedOutput
        t.comment('Options: ' + JSON.stringify(test.options))
        t.comment('Expected Output: ' + JSON.stringify(expectedOutput))
        t.comment('Sending OCR job...')
        const response = await onnxOcr.run({ path: rootPath + testCase.imagePath, options: test.options })
        t.comment('Job sent, waiting for results...')
        await response
          .onUpdate(output => {
            t.ok(Array.isArray(output), prefixStr + 'output should be an array')
            t.comment('Actual output: ' + JSON.stringify(output.map(o => o[1])))
            t.comment('Actual output length: ' + output.length + ', Expected length: ' + expectedOutput.length)
            t.ok(output.length === expectedOutput.length, prefixStr + 'output length should match')

            for (let i = 0; i < output.length; i++) {
              if (i < expectedOutput.length && expectedOutput[i].length > 0) {
                t.ok(output[i][1] === expectedOutput[i], prefixStr + `output at index ${i} should match expected`)
              }
            }
          })
          .onError(error => {
            if (test.expectedOutput === 'error') {
              t.pass(prefixStr + 'successfully logged expected error')
            } else {
              t.fail(prefixStr + 'received unexpected error: ' + JSON.stringify(error))
            }
          })
          .await()
        t.comment('OCR processing complete')
        // Wait between tests to prevent pipeline from batching multiple requests
        // which can cause results to be returned to the wrong caller
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    } catch (err) {
      t.fail(`Error sending job: ${err}`)
    } finally {
      try {
        if (isMacCI && onnxOcr && onnxOcr.addon) {
          await onnxOcr.addon.stop()
          await new Promise(resolve => setTimeout(resolve, 2000))
          t.comment('OCR Stop complete')
        }
        await onnxOcr.unload()
        t.comment('Successfully unloaded model')
      } catch (err) {
        t.comment(`unload() failed: ${err.message}`)
      }
      if (isMacCI) { await new Promise(resolve => setTimeout(resolve, 20000)) } else { await new Promise(resolve => setTimeout(resolve, 2000)) }

      if (global.gc) {
        global.gc()
      }
    }
  }
})

test('Test for a fix of missing end of job event', { timeout: 60 * 1000 }, async function (t) {
  const rootPath = path.resolve('.')

  // test that the pipeline doesn't hang with unrecognizable text (ROI fix)
  const testImagePath = '/test/images/unrecognizable_text.bmp'

  t.comment('Testing with image: ' + testImagePath)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/detector_craft.onnx',
      pathRecognizer: 'models/ocr/recognizer_latin.onnx',
      langList: ['en']
    },
    opts: { stats: true }
  })

  await onnxOcr.load()

  try {
    let errorReceived = false
    let responseCompleted = false

    const response = await onnxOcr.run({
      path: rootPath + testImagePath,
      options: { paragraph: false }
    })

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
      })
      .onError(error => {
        errorReceived = true
        t.fail('Unexpected error received: ' + JSON.stringify(error))
      })
      .await() // it returns a Promise that resolves when the JobEnded event is received from the addon
      .then(() => {
        responseCompleted = true
        t.pass('Response completed successfully - JobEnded event was received')
      })

    // Check that we received an "end of job" event
    t.ok(!errorReceived, 'No error should be received')
    t.ok(responseCompleted, 'Response should complete - JobEnded event was received')
    t.pass('Pipeline completed successfully without hanging')
  } catch (err) {
    t.fail(`Error in test: ${err}`)
  } finally {
    await onnxOcr.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

/**
 * Tests for image format support (BMP, JPEG, PNG).
 * Verifies that the OCR addon can process images in different formats.
 */
const IMAGE_FORMAT_EXPECTED_TEXTS = ['tilted', 'normal', 'vertical']

test('OCR processes JPEG images correctly', { timeout: 60 * 1000 }, async function (t) {
  const rootPath = path.resolve('.')
  const imagePath = rootPath + '/test/images/basic_test.jpg'

  t.comment('Testing JPEG format with image: ' + imagePath)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/detector_craft.onnx',
      pathRecognizer: 'models/ocr/recognizer_latin.onnx',
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

test('OCR processes PNG images correctly', { timeout: 60 * 1000 }, async function (t) {
  const rootPath = path.resolve('.')
  const imagePath = rootPath + '/test/images/basic_test.png'

  t.comment('Testing PNG format with image: ' + imagePath)

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/detector_craft.onnx',
      pathRecognizer: 'models/ocr/recognizer_latin.onnx',
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

test('BMP and JPEG produce consistent results', { timeout: 120 * 1000 }, async function (t) {
  const rootPath = path.resolve('.')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/detector_craft.onnx',
      pathRecognizer: 'models/ocr/recognizer_latin.onnx',
      langList: ['en'],
      useGPU: false
    },
    opts: { stats: true }
  })

  await onnxOcr.load()

  let bmpTexts = []
  let jpegTexts = []

  try {
    // Process BMP
    const bmpResponse = await onnxOcr.run({
      path: rootPath + '/test/images/basic_test.bmp',
      options: { paragraph: false }
    })

    await bmpResponse
      .onUpdate(output => {
        bmpTexts = output.map(o => o[1]).sort()
      })
      .await()

    // Wait between tests
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Process JPEG
    const jpegResponse = await onnxOcr.run({
      path: rootPath + '/test/images/basic_test.jpg',
      options: { paragraph: false }
    })

    await jpegResponse
      .onUpdate(output => {
        jpegTexts = output.map(o => o[1]).sort()
      })
      .await()

    t.comment('BMP texts: ' + JSON.stringify(bmpTexts))
    t.comment('JPEG texts: ' + JSON.stringify(jpegTexts))

    // Both formats should detect the same texts
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
