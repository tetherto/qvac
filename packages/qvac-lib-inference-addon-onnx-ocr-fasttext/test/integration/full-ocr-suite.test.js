'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const { isMobile } = require('./utils')

const isMacCI = os.platform() === 'darwin'

const arabicLangList = ['ar', 'fa', 'ug', 'ur']
const bengaliLangList = ['bn', 'as', 'mni']
const cyrillicLangList = ['ru', 'rs_cyrillic', 'be', 'bg', 'uk', 'mn', 'abq', 'ady', 'kbd', 'ava', 'dar', 'inh', 'che',
  'lbe', 'lez', 'tab', 'tjk']
const devanagariLangList = ['hi', 'mr', 'ne', 'bh', 'mai', 'ang', 'bho', 'mah', 'sck', 'new', 'gom', 'sa', 'bgc']

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

test('Full OCR test suite', { timeout: 40 * 60 * 1000, skip: isMobile }, async function (t) {
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
        pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
        pathRecognizer: `models/ocr/rec_dyn/recognizer_${recognizerModelName}.onnx`,
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
