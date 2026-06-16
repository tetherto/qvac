'use strict'

const test = require('brittle')
const os = require('bare-os')
const process = require('bare-process')
const { isMobile, platform, getImagePath, ensureModelPath, runOcrComparison } = require('./utils')

const DESKTOP_TIMEOUT = 180 * 1000 // 3 minutes: runs the pipeline twice

// Guards the 1x1-conv -> ggml_mul_mat path added in QVAC-20532. The CRAFT
// detector's 1x1 convs can run either through ggml_conv_2d (im2col + GEMM) or a
// direct ggml_mul_mat; the addon picks per backend at load time (mul_mat on
// GPU, conv_2d on CPU). The rewrite must be numerically equivalent for
// 1x1/stride-1 convs, so this runs the SAME image on the same backend twice and
// forces each path explicitly — OCR_GGML_CONV1X1_CONV2D=1 (conv_2d) then
// OCR_GGML_CONV1X1_MULMAT=1 (mul_mat) — and asserts identical recognized
// output, plus that each pass is absolutely correct. The explicit force is
// required because the unset default is backend-dependent (it would otherwise
// run the same path twice on GPU vs CPU, making the comparison vacuous).
//
// The toggles are read by the native addon via getenv at model-load time, so we
// set them through bare-os (which maps to setenv) before constructing the addon
// and restore them afterwards. Desktop POSIX only: mobile device-farm runs
// don't propagate these process env vars, and on Windows uv_os_setenv
// (SetEnvironmentVariableW) does not update the CRT table that the addon's
// std::getenv reads — so the toggle wouldn't take effect.
const ENV_KEYS = ['OCR_GGML_CONV1X1_MULMAT', 'OCR_GGML_CONV1X1_CONV2D']

test('EasyOCR 1x1-conv mul_mat matches conv_2d (CRAFT)', { timeout: DESKTOP_TIMEOUT }, async function (t) {
  if (isMobile) {
    t.pass('skipped on mobile (env toggle is a desktop-only A/B lever)')
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

  // Force exactly one path on (key=1) and clear every other toggle, so the
  // backend-aware default never leaks into either pass.
  function forceOnly (onKey) {
    for (const key of ENV_KEYS) setEnv(key, key === onKey ? '1' : '')
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

  function assertCorrect (output, tag) {
    t.ok(Array.isArray(output), tag + ': output should be an array')
    t.is(output.length, 3, tag + `: output length should be 3, got ${output.length}`)
    const texts = output.map(o => o[1])
    t.ok(texts.includes('tilted'), tag + ': should contain "tilted"')
    t.ok(texts.includes('normal'), tag + ': should contain "normal"')
    t.ok(texts.includes('vertical'), tag + ': should contain "vertical"')
  }

  try {
    const detectorPath = await ensureModelPath('detector_craft')
    const recognizerPath = await ensureModelPath('recognizer_latin')
    const imagePath = getImagePath('/test/images/basic_test.bmp')
    const baseCfg = {
      params: { pathDetector: detectorPath, pathRecognizer: recognizerPath, langList: ['en'] },
      imagePath,
      runOptions: { paragraph: false },
      perfOpts: { skipReport: true }
    }

    t.comment('Pass A: forced conv_2d path; image: ' + imagePath + ', platform: ' + platform)
    forceOnly('OCR_GGML_CONV1X1_CONV2D')
    const resConv = await runOcrComparison(t, {
      ...baseCfg,
      perfLabel: '[EasyOCR basic_test conv2d]',
      assertResult (output) { assertCorrect(output, 'conv_2d') }
    })
    const outConv = resConv.output

    t.comment('Pass B: forced 1x1 mul_mat path')
    forceOnly('OCR_GGML_CONV1X1_MULMAT')
    const resMul = await runOcrComparison(t, {
      ...baseCfg,
      perfLabel: '[EasyOCR basic_test 1x1-mulmat]',
      assertResult (output) { assertCorrect(output, 'mul_mat') }
    })
    const outMul = resMul.output

    // Equivalence: the mul_mat rewrite must match conv_2d region-for-region.
    t.is(outMul.length, outConv.length, 'mul_mat and conv_2d produce the same number of regions')
    const n = Math.min(outMul.length, outConv.length)
    for (let i = 0; i < n; i++) {
      t.is(outMul[i][1], outConv[i][1], `region ${i}: mul_mat text matches conv_2d ("${outConv[i][1]}")`)
    }

    t.pass('1x1-conv mul_mat path matches conv_2d output')
  } finally {
    restoreEnv()
  }
})
