'use strict'

const { OcrGgml } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath, safeUnload, findOpenCLBackendLib, PREBUILDS_DIR } = require('./utils')

// QVAC-19798: opt-in OpenCL GGML backend. Requesting `backendDevice: 'opencl'`
// must EITHER run inference on an OpenCL device, OR report an explicit CPU
// fallback — never silently produce wrong behaviour. CPU stays the default
// (covered by the rest of the suite), so this test only exercises the OpenCL
// opt-in path.
//
// OpenCL is primarily an Android/Adreno path (the `opencl` vcpkg port is gated
// to Android in this and every sibling GGML package). Unlike Vulkan, Adreno is
// NOT guarded off for OpenCL — it is Adreno's sound compute path. The OpenCL
// execution path can only be validated where a `libggml-opencl` backend shared
// library was shipped into prebuilds/. We gate on that file so the test skips
// cleanly on hosts that never built the OpenCL backend (e.g. plain desktop CI)
// instead of failing. On a host that ships the lib but has no OpenCL-capable
// GPU/driver, the selection falls back to CPU and we assert the fallback is
// reported explicitly.

const TEST_TIMEOUT = 120 * 1000

const openclBackendLib = findOpenCLBackendLib(PREBUILDS_DIR)

// Skip on mobile (prebuilds layout / device provisioning differ) and on any
// host that did not ship an OpenCL backend lib.
const shouldSkip = isMobile || !openclBackendLib

test('backendDevice opencl: selects OpenCL or reports an explicit CPU fallback', { timeout: TEST_TIMEOUT, skip: shouldSkip }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  t.comment('OpenCL backend lib: ' + openclBackendLib)

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
  t.is(typeof backendInfo.deviceIndex, 'number', 'deviceIndex is a number')
  t.is(typeof backendInfo.backendDescription, 'string', 'backendDescription is a string')
  t.comment('Resolved backend info: ' + JSON.stringify(backendInfo))

  const openclSelected =
    backendInfo.backendDevice === 'GPU' || backendInfo.backendDevice === 'IGPU'

  if (openclSelected) {
    t.is(backendInfo.fallbackReason, '', 'no fallback reason when OpenCL is selected')
    t.ok(/opencl/i.test(backendInfo.backendName), 'selected backend name mentions OpenCL')
    // A selected GPU device reports its ggml device index (>= 0).
    t.ok(backendInfo.deviceIndex >= 0, 'selected GPU reports a non-negative ggml deviceIndex')
  } else {
    // No OpenCL device available: the fallback to CPU MUST be reported.
    t.is(backendInfo.backendDevice, 'CPU', 'fell back to the CPU device')
    t.ok(backendInfo.fallbackReason.length > 0, 'explicit CPU fallback reason reported')
    t.is(backendInfo.deviceIndex, -1, 'CPU fallback reports deviceIndex -1')
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

    // Inference must succeed regardless of which backend was used.
    t.ok(outputTexts.length > 0, 'inference produced text regions')
    t.ok(outputTexts.includes('normal'), 'recognized expected text "normal"')

    t.pass('backendDevice opencl path exercised (' + backendInfo.backendDevice + ')')
  } finally {
    await safeUnload(ocrGgml)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
