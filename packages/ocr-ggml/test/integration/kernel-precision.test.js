'use strict'

const test = require('brittle')
const os = require('bare-os')
const process = require('bare-process')
const { isMobile, platform, getImagePath, ensureModelPath, runOcrComparison } = require('./utils')

const DESKTOP_TIMEOUT = 120 * 1000 // 2 minutes for desktop

// Guards the F32 conv-kernel fallbacks added in QVAC-20531. The default suite
// (ocr-basic) only exercises the F16 fast path; this test forces F32 storage
// for both the CRAFT detector (OCR_GGML_CRAFT_KERNEL_F32=1) and the CRNN gen-2
// recognizer (OCR_GGML_CRNN_KERNEL_F32=1), then asserts the full EasyOCR
// pipeline still produces correct output.
//
// The toggles are read by the native addon via getenv at model-load time, so
// we set them through bare-os (which maps to setenv) before constructing the
// addon and restore them afterwards. Desktop POSIX only: mobile device-farm
// runs don't propagate these process env vars, and on Windows uv_os_setenv
// (SetEnvironmentVariableW) does not update the CRT table that the addon's
// std::getenv reads — so the toggle wouldn't take effect and the addon would
// instead use its backend-aware default, giving no coverage of the explicit
// F32 lever. The F32 override is therefore CI-verified on Linux/macOS only.
const ENV_KEYS = ['OCR_GGML_CRAFT_KERNEL_F32', 'OCR_GGML_CRNN_KERNEL_F32']

test('EasyOCR F32-kernel fallback (CRAFT + CRNN)', { timeout: DESKTOP_TIMEOUT }, async function (t) {
  if (isMobile) {
    t.pass('skipped on mobile (env toggles are a desktop-only A/B lever)')
    return
  }
  if (platform === 'win32') {
    t.pass('skipped on win32 (SetEnvironmentVariableW does not reach the addon CRT getenv)')
    return
  }

  const hasGetEnv = typeof os.getEnv === 'function'
  const hasSetEnv = typeof os.setEnv === 'function'
  const prev = new Map()
  for (const key of ENV_KEYS) {
    prev.set(key, (hasGetEnv ? os.getEnv(key) : process.env[key]) || '')
  }

  function setEnv (key, val) {
    if (hasSetEnv) os.setEnv(key, val)
    process.env[key] = val
  }

  function restoreEnv () {
    for (const key of ENV_KEYS) {
      const original = prev.get(key)
      if (original) {
        setEnv(key, original)
        continue
      }
      if (typeof os.unsetEnv === 'function') os.unsetEnv(key)
      else if (hasSetEnv) os.setEnv(key, '')
      // bare-process's env proxy rejects `delete` (TypeError under strict mode); '' is sufficient since the addon reads via std::getenv.
      process.env[key] = ''
    }
  }

  for (const key of ENV_KEYS) setEnv(key, '1')
  try {
    const detectorPath = await ensureModelPath('detector_craft')
    const recognizerPath = await ensureModelPath('recognizer_latin')
    const imagePath = getImagePath('/test/images/basic_test.bmp')

    t.comment('Forcing F32 CRAFT + CRNN kernels; image: ' + imagePath + ', platform: ' + platform)

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

    t.pass('F32-kernel CRAFT + CRNN path produced correct OCR output')
  } finally {
    restoreEnv()
  }
})
