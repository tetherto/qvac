'use strict'

const { OcrGgml } = require('../..')
const test = require('brittle')
const { platform, getImagePath, ensureModelPath, safeUnload } = require('./utils')

// QVAC-19798: Android OpenCL integration test for ocr-ggml.
//
// Android (specifically Qualcomm Adreno) is the primary OpenCL target. This
// test runs ONLY on Android — the desktop OpenCL opt-in path is covered by
// opencl-backend.test.js, and Apple has no OpenCL (deprecated; Metal instead).
// On every non-Android host this file is a clean skip.
//
// The test requests `backendDevice: 'opencl'` and asserts the contract:
//   1. The addon EITHER runs inference on an OpenCL device OR reports an
//      explicit CPU fallback — never a silent wrong path.
//   2. Whichever backend is resolved, the OCR output must be CORRECT
//      (accuracy gate), not merely "it executed".
//
// Unlike Vulkan, Adreno is NOT guarded off for OpenCL: OpenCL is Adreno's sound
// compute path (the inverse of the Vulkan Adreno guard). So on an Adreno device
// that ships libggml-opencl, this test exercises the real OpenCL GPU path; on a
// device without the OpenCL backend lib / driver it takes the explicit
// CPU-fallback branch. Either way the output must be correct — a numerically
// broken OpenCL path would fail the accuracy assertions, which is the signal we
// want. The resolved backend name/description is logged so Device Farm runs
// surface the actual GPU on the pool's devices.

const TEST_TIMEOUT = 300 * 1000
const shouldSkip = platform !== 'android'

test('android opencl: selects OpenCL or reports CPU fallback, with correct OCR output', { timeout: TEST_TIMEOUT, skip: shouldSkip }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      backendDevice: 'opencl'
    },
    opts: { stats: true }
  })

  await ocrGgml.load()
  t.pass('loaded with backendDevice: opencl')

  const backendInfo = ocrGgml.getBackendInfo()
  t.ok(backendInfo, 'getBackendInfo() returns backend info after load')
  t.is(backendInfo.requested, 'opencl', 'requested device recorded as opencl')
  // Probe: surface the actual device GPU (name + description) in Device Farm logs.
  t.comment('Resolved backend info: ' + JSON.stringify(backendInfo))

  const openclSelected =
    backendInfo.backendDevice === 'GPU' || backendInfo.backendDevice === 'IGPU'

  if (openclSelected) {
    t.is(backendInfo.fallbackReason, '', 'no fallback reason when OpenCL is selected')
    t.ok(/opencl/i.test(backendInfo.backendName), 'selected backend name mentions OpenCL (' + backendInfo.backendName + ')')
  } else {
    // No usable OpenCL device (none present, or no backend lib shipped): the
    // fallback to CPU MUST be reported explicitly.
    t.is(backendInfo.backendDevice, 'CPU', 'fell back to the CPU device')
    t.ok(backendInfo.fallbackReason.length > 0, 'explicit CPU fallback reason reported')
    t.comment('CPU fallback reason: ' + backendInfo.fallbackReason)
  }

  try {
    const response = await ocrGgml.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let outputTexts = []
    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        outputTexts = output.map(o => o[1])
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    const stats = response.stats || {}
    t.comment('Native addon stats: ' + JSON.stringify(stats))

    // The numeric `backendIsGpu` stat must agree with the resolved device.
    t.is(
      stats.backendIsGpu,
      openclSelected ? 1 : 0,
      'backendIsGpu stat matches the resolved backend (' + backendInfo.backendDevice + ')'
    )

    // Accuracy gate: whichever backend ran, the output must be correct. A
    // numerically-broken OpenCL device would produce garbage here and fail.
    t.ok(outputTexts.length > 0, 'inference produced text regions')
    t.ok(outputTexts.includes('normal'), 'recognized expected text "normal" (backend: ' + backendInfo.backendDevice + ')')

    t.pass('android opencl path exercised (' + backendInfo.backendDevice + ')')
  } finally {
    await safeUnload(ocrGgml)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
