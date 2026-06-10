'use strict'

const { OcrGgml } = require('../..')
const test = require('brittle')
const { isMobile, platform, getImagePath, ensureModelPath, safeUnload, findVulkanBackendLib, PREBUILDS_DIR } = require('./utils')

// QVAC-19797: opt-in Vulkan GGML backend. Requesting `backendDevice: 'vulkan'`
// must EITHER run inference on a Vulkan device, OR report an explicit CPU
// fallback — never silently produce wrong behaviour. CPU stays the default
// (covered by the rest of the suite), so this test only exercises the Vulkan
// opt-in path.
//
// The Vulkan execution path can only be validated where a `libggml-vulkan`
// backend shared library was shipped into prebuilds/. We gate on that file so
// the test skips cleanly on hosts that never built the Vulkan backend (e.g.
// plain desktop CI) instead of failing. On a host that ships the lib but has
// no Vulkan-capable GPU, the selection falls back to CPU and we assert the
// fallback is reported explicitly.

const TEST_TIMEOUT = 120 * 1000

const vulkanBackendLib = findVulkanBackendLib(PREBUILDS_DIR)

// Skip on mobile (prebuilds layout / device provisioning differ) and on any
// host that did not ship a Vulkan backend lib.
const shouldSkip = isMobile || !vulkanBackendLib

test('backendDevice vulkan: selects Vulkan or reports an explicit CPU fallback', { timeout: TEST_TIMEOUT, skip: shouldSkip }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  t.comment('Vulkan backend lib: ' + vulkanBackendLib)

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
  t.is(typeof backendInfo.deviceIndex, 'number', 'deviceIndex is a number')
  t.is(typeof backendInfo.backendDescription, 'string', 'backendDescription is a string')
  t.comment('Resolved backend info: ' + JSON.stringify(backendInfo))

  const vulkanSelected =
    backendInfo.backendDevice === 'GPU' || backendInfo.backendDevice === 'IGPU'

  if (vulkanSelected) {
    t.is(backendInfo.fallbackReason, '', 'no fallback reason when Vulkan is selected')
    t.ok(/vulkan/i.test(backendInfo.backendName), 'selected backend name mentions Vulkan')
    // A selected GPU device reports its ggml device index (>= 0).
    t.ok(backendInfo.deviceIndex >= 0, 'selected GPU reports a non-negative ggml deviceIndex')
  } else {
    // No Vulkan device available: the fallback to CPU MUST be reported.
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
      vulkanSelected ? 1 : 0,
      'backendIsGpu stat matches the resolved backend (' + backendInfo.backendDevice + ')'
    )

    // Inference must succeed regardless of which backend was used.
    t.ok(outputTexts.length > 0, 'inference produced text regions')
    t.ok(outputTexts.includes('normal'), 'recognized expected text "normal"')

    t.pass('backendDevice vulkan path exercised (' + backendInfo.backendDevice + ')')
  } finally {
    await safeUnload(ocrGgml)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

// QVAC-19986: explicit GPU device selection. Requesting the Vulkan backend with
// an out-of-range `gpuDevice` index MUST fall back to CPU and report an
// explicit reason (never select a wrong device or crash). Gated on the same
// Vulkan-lib presence as the test above so it skips cleanly on hosts that never
// built the Vulkan backend. This holds regardless of how many Vulkan devices
// the host has (0 → no matching device; N → index 99 is still out of range), so
// it is verifiable here and on the GPU runner alike.
test('backendDevice vulkan: out-of-range gpuDevice falls back to CPU with a reason', { timeout: TEST_TIMEOUT, skip: shouldSkip }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')

  const OUT_OF_RANGE_INDEX = 99
  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      backendDevice: 'vulkan',
      gpuDevice: OUT_OF_RANGE_INDEX
    }
  })

  try {
    await ocrGgml.load()
    t.pass('loaded with backendDevice: vulkan, gpuDevice: ' + OUT_OF_RANGE_INDEX)

    const backendInfo = ocrGgml.getBackendInfo()
    t.ok(backendInfo, 'getBackendInfo() returns backend info after load')
    t.is(backendInfo.requested, 'vulkan', 'requested device recorded as vulkan')
    t.comment('Resolved backend info: ' + JSON.stringify(backendInfo))

    // An out-of-range device index must never silently pick a device.
    t.is(backendInfo.backendDevice, 'CPU', 'out-of-range gpuDevice falls back to the CPU device')
    t.is(backendInfo.deviceIndex, -1, 'CPU fallback reports deviceIndex -1')
    t.ok(backendInfo.fallbackReason.length > 0, 'explicit CPU fallback reason reported')
    t.ok(
      backendInfo.fallbackReason.includes(String(OUT_OF_RANGE_INDEX)),
      'fallback reason names the requested gpuDevice index'
    )
  } finally {
    await safeUnload(ocrGgml)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

// QVAC-19797 (Metal follow-up): opt-in Metal GGML backend on Apple. Requesting
// `backendDevice: 'metal'` must EITHER run inference on a Metal device, OR
// report an explicit CPU fallback — never silently produce wrong behaviour.
//
// Unlike Vulkan (a separate libggml-vulkan shared library), the Metal backend
// is compiled into the addon when ggml is built with the qvac-fabric
// `gpu-backends` feature (default on Apple). There is therefore no backend lib
// file to probe; we gate on the host platform instead. This runs on every
// Apple platform — desktop `darwin` AND iOS (whose device-farm devices have
// real Metal GPUs) — and skips elsewhere. On an Apple target whose ggml was
// built CPU-only, or with no Metal device present, the selection falls back to
// CPU and we assert the fallback is reported explicitly.
const shouldSkipMetal = platform !== 'darwin' && platform !== 'ios'

test('backendDevice metal: selects Metal or reports an explicit CPU fallback', { timeout: TEST_TIMEOUT, skip: shouldSkipMetal }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const ocrGgml = new OcrGgml({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      backendDevice: 'metal'
    },
    opts: { stats: true }
  })

  await ocrGgml.load()
  t.pass('loaded with backendDevice: metal')

  const backendInfo = ocrGgml.getBackendInfo()
  t.ok(backendInfo, 'getBackendInfo() returns backend info after load')
  t.is(backendInfo.requested, 'metal', 'requested device recorded as metal')
  t.is(typeof backendInfo.deviceIndex, 'number', 'deviceIndex is a number')
  t.is(typeof backendInfo.backendDescription, 'string', 'backendDescription is a string')
  t.comment('Resolved backend info: ' + JSON.stringify(backendInfo))

  const metalSelected =
    backendInfo.backendDevice === 'GPU' || backendInfo.backendDevice === 'IGPU'

  if (metalSelected) {
    t.is(backendInfo.fallbackReason, '', 'no fallback reason when Metal is selected')
    // ggml names Metal devices "MTL0"/"MTL1" (the backing registration is
    // "Metal"); accept either form.
    t.ok(/metal|mtl/i.test(backendInfo.backendName), 'selected backend name is a Metal device (' + backendInfo.backendName + ')')
    // A selected GPU device reports its ggml device index (>= 0).
    t.ok(backendInfo.deviceIndex >= 0, 'selected GPU reports a non-negative ggml deviceIndex')
  } else {
    // No Metal device available: the fallback to CPU MUST be reported.
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
      metalSelected ? 1 : 0,
      'backendIsGpu stat matches the resolved backend (' + backendInfo.backendDevice + ')'
    )

    // Inference must succeed regardless of which backend was used.
    t.ok(outputTexts.length > 0, 'inference produced text regions')
    t.ok(outputTexts.includes('normal'), 'recognized expected text "normal"')

    t.pass('backendDevice metal path exercised (' + backendInfo.backendDevice + ')')
  } finally {
    await safeUnload(ocrGgml)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
