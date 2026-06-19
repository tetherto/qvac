'use strict'

const { OcrGgml } = require('../..')
const test = require('brittle')
const os = require('bare-os')
const process = require('bare-process')
const { platform, getImagePath, ensureModelPath, safeUnload } = require('./utils')

const DESKTOP_TIMEOUT = 240 * 1000 // 4 minutes: loads + runs the pipeline twice

// Guards the backend-aware direct-conv path (QVAC-20909). EasyOCR's non-1x1
// convs run through ggml_conv_2d (im2col) by default; OCR_GGML_DIRECT_CONV=1
// forces the fused ggml_conv_2d_direct (GGML_OP_CONV_2D) path, and
// OCR_GGML_IM2COL_CONV=1 forces im2col. The two must be numerically equivalent,
// so this runs the SAME image on the SAME backend twice — im2col (forced) then
// direct (forced) — and asserts identical recognized output.
//
// Why Metal-only: ggml_conv_2d_direct's per-backend support matters here. ggml
// hard-aborts (GGML_ASSERT) when a graph contains an op the backend can't run,
// so we only force the direct path where GGML_OP_CONV_2D is known-supported.
// Apple Metal is confirmed (the DocTR doctrConv2d work, QVAC-19798, measured it
// on Metal); the real OpenCL/Adreno target is validated separately on the
// device farm by runAndroidOpenclTest. We deliberately do NOT exercise the
// linux CPU/Vulkan or Windows runners here (direct-conv support there is
// unverified) nor mobile (env toggles don't propagate to the device farm).
const ENV_KEYS = ['OCR_GGML_DIRECT_CONV', 'OCR_GGML_IM2COL_CONV']
const shouldSkip = platform !== 'darwin'

test('EasyOCR direct-conv matches im2col (Metal)', { timeout: DESKTOP_TIMEOUT, skip: shouldSkip }, async function (t) {
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

  // Force exactly one conv path on and clear the other so neither leaks.
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

  // Run the EasyOCR pipeline once on Metal and return the recognized regions.
  async function runMetalPass (tag) {
    const detectorPath = await ensureModelPath('detector_craft')
    const recognizerPath = await ensureModelPath('recognizer_latin')
    const imagePath = getImagePath('/test/images/basic_test.bmp')
    const ocrGgml = new OcrGgml({
      params: { pathDetector: detectorPath, pathRecognizer: recognizerPath, langList: ['en'], backendDevice: 'metal' },
      opts: { stats: true }
    })
    await ocrGgml.load()
    const info = typeof ocrGgml.getBackendInfo === 'function' ? ocrGgml.getBackendInfo() : null
    const isGpu = !!info && (info.backendDevice === 'GPU' || info.backendDevice === 'IGPU')
    if (!isGpu) {
      // Metal didn't resolve to a GPU (e.g. no Metal device): bail rather than
      // force the direct path onto a backend that may not implement it.
      await safeUnload(ocrGgml)
      return { skipped: true, output: [] }
    }
    let output = []
    try {
      const response = await ocrGgml.run({ path: imagePath, options: { paragraph: false } })
      await response
        .onUpdate(o => { output = o })
        .onError(error => { t.fail(tag + ': unexpected error: ' + JSON.stringify(error)) })
        .await()
      return { skipped: false, output }
    } finally {
      await safeUnload(ocrGgml)
      await new Promise(resolve => setTimeout(resolve, 1000))
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
    t.comment('Pass A: forced im2col conv (Metal); platform: ' + platform)
    forceOnly('OCR_GGML_IM2COL_CONV')
    const resImicol = await runMetalPass('im2col')
    if (resImicol.skipped) {
      t.pass('skipped: Metal GPU not available on this host')
      return
    }
    assertCorrect(resImicol.output, 'im2col')

    t.comment('Pass B: forced ggml_conv_2d_direct (Metal)')
    forceOnly('OCR_GGML_DIRECT_CONV')
    const resDirect = await runMetalPass('direct')
    if (resDirect.skipped) {
      t.pass('skipped: Metal GPU not available for the direct pass')
      return
    }
    assertCorrect(resDirect.output, 'direct')

    // Equivalence: direct must match the im2col path region-for-region.
    t.is(resDirect.output.length, resImicol.output.length, 'direct and im2col produce the same number of regions')
    const n = Math.min(resDirect.output.length, resImicol.output.length)
    for (let i = 0; i < n; i++) {
      t.is(resDirect.output[i][1], resImicol.output[i][1], `region ${i}: direct text matches im2col ("${resImicol.output[i][1]}")`)
    }

    t.pass('direct-conv path matches im2col output on Metal')
  } finally {
    restoreEnv()
  }
})
