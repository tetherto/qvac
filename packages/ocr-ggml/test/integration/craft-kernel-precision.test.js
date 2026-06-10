'use strict'

const test = require('brittle')
const os = require('bare-os')
const { isMobile, platform, getImagePath, ensureModelPath, runOcrComparison } = require('./utils')

const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop

// Guards the F32 conv-kernel fallback added in QVAC-20531. The default suite
// (ocr-basic) only exercises the F16 fast path; this test forces F32 storage
// via OCR_GGML_CRAFT_KERNEL_F32=1 and asserts the CRAFT detector still produces
// correct OCR output.
//
// The toggle is read by the native addon via getenv at model-load time, so we
// set it through bare-os (which maps to setenv) before constructing the addon
// and restore it afterwards. Desktop-only: mobile device-farm runs don't
// propagate this process env var.
test('CRAFT F32-kernel fallback (OCR_GGML_CRAFT_KERNEL_F32=1)', { timeout: DESKTOP_TIMEOUT }, async function (t) {
  if (isMobile) {
    t.pass('skipped on mobile (env toggle is a desktop-only A/B lever)')
    return
  }

  const ENV_KEY = 'OCR_GGML_CRAFT_KERNEL_F32'
  const hasGetEnv = typeof os.getEnv === 'function'
  const hasSetEnv = typeof os.setEnv === 'function'
  const prev = (hasGetEnv ? os.getEnv(ENV_KEY) : process.env[ENV_KEY]) || ''

  function setEnv (val) {
    if (hasSetEnv) os.setEnv(ENV_KEY, val)
    process.env[ENV_KEY] = val
  }

  function restoreEnv () {
    if (prev) {
      setEnv(prev)
      return
    }
    if (typeof os.unsetEnv === 'function') os.unsetEnv(ENV_KEY)
    else if (hasSetEnv) os.setEnv(ENV_KEY, '')
    delete process.env[ENV_KEY]
  }

  setEnv('1')
  try {
    const detectorPath = await ensureModelPath('detector_craft')
    const recognizerPath = await ensureModelPath('recognizer_latin')
    const imagePath = getImagePath('/test/images/basic_test.bmp')

    t.comment('Forcing F32 CRAFT kernels; image: ' + imagePath + ', platform: ' + platform)

    await runOcrComparison(t, {
      params: {
        pathDetector: detectorPath,
        pathRecognizer: recognizerPath,
        langList: ['en']
      },
      imagePath,
      runOptions: { paragraph: false },
      perfLabel: '[EasyOCR basic_test F32-kernels]',
      perfOpts: { skipReport: true },
      assertResult (output) {
        t.ok(Array.isArray(output), 'output should be an array')
        t.ok(output.length === 3, `output length should be 3, got ${output.length}`)
        const texts = output.map(o => o[1])
        t.ok(texts.includes('tilted'), 'should contain "tilted"')
        t.ok(texts.includes('normal'), 'should contain "normal"')
        t.ok(texts.includes('vertical'), 'should contain "vertical"')
      }
    })

    t.pass('F32-kernel CRAFT path produced correct OCR output')
  } finally {
    restoreEnv()
  }
})
