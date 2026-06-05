'use strict'

const { OcrGgml } = require('../..')
const test = require('brittle')
const { platform, getImagePath, ensureModelPath, safeUnload } = require('./utils')

// QVAC-19941: Android Vulkan integration test for ocr-ggml.
//
// Android is the primary Vulkan target. This test runs ONLY on Android — the
// desktop Vulkan/Metal opt-in paths are already covered by
// backend-device.test.js, and iOS has no Vulkan (Metal/MoltenVK), so it is out
// of scope and stays on the CPU default. On every non-Android host this file is
// a clean skip.
//
// The test requests `backendDevice: 'vulkan'` and asserts the contract:
//   1. The addon EITHER runs inference on a Vulkan device OR reports an explicit
//      CPU fallback — it must never silently pick a broken path.
//   2. Whichever backend is resolved, the OCR output must be CORRECT
//      (accuracy/parity gate), not merely "it executed".
//
// (2) is the important Adreno guard rail. vla-ggml found Adreno Vulkan
// numerically broken (cos-sim ~0.73 vs reference on Adreno 830 / Galaxy S25,
// while Mali/Metal/NVIDIA sit above 0.999). OcrBackendSelection therefore
// auto-skips Adreno GPUs for Vulkan and falls back to CPU, so on an Adreno
// device this test takes the explicit CPU-fallback branch (correct output);
// on Mali (e.g. Pixel 9 Pro) it runs on Vulkan. If a numerically-broken Vulkan
// device were ever selected, the accuracy assertions below would fail — which
// is exactly the signal we want.
//
// The resolved backend name/description is logged so Device Farm runs surface
// the actual GPU on the pool's devices.

const TEST_TIMEOUT = 300 * 1000
const shouldSkip = platform !== 'android'

test('android vulkan: selects Vulkan or reports CPU fallback, with correct OCR output', { timeout: TEST_TIMEOUT, skip: shouldSkip }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      backendDevice: 'vulkan'
    },
    opts: { stats: true }
  })

  await ocrGgml.load()
  t.pass('loaded with backendDevice: vulkan')

  const backendInfo = ocrGgml.getBackendInfo()
  t.ok(backendInfo, 'getBackendInfo() returns backend info after load')
  t.is(backendInfo.requested, 'vulkan', 'requested device recorded as vulkan')
  // Probe: surface the actual device GPU (name + description) in Device Farm logs.
  t.comment('Resolved backend info: ' + JSON.stringify(backendInfo))

  const vulkanSelected =
    backendInfo.backendDevice === 'GPU' || backendInfo.backendDevice === 'IGPU'

  if (vulkanSelected) {
    t.is(backendInfo.fallbackReason, '', 'no fallback reason when Vulkan is selected')
    t.ok(/vulkan/i.test(backendInfo.backendName), 'selected backend name mentions Vulkan (' + backendInfo.backendName + ')')
  } else {
    // No usable Vulkan device (none present, or rejected e.g. Adreno): the
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
      vulkanSelected ? 1 : 0,
      'backendIsGpu stat matches the resolved backend (' + backendInfo.backendDevice + ')'
    )

    // Accuracy/parity gate: whichever backend ran, the output must be correct.
    // A numerically-broken Vulkan device that was NOT rejected would produce
    // garbage here and fail — this is the Adreno safety net required by the task.
    t.ok(outputTexts.length > 0, 'inference produced text regions')
    t.ok(outputTexts.includes('normal'), 'recognized expected text "normal" (backend: ' + backendInfo.backendDevice + ')')

    t.pass('android vulkan path exercised (' + backendInfo.backendDevice + ')')
  } finally {
    await safeUnload(ocrGgml)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
