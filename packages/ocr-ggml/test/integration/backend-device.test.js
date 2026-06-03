'use strict'

const { OcrGgml } = require('../..')
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { isMobile, getImagePath, ensureModelPath, safeUnload } = require('./utils')

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

// Recursively search prebuilds/ for a ggml Vulkan backend shared library.
function findVulkanBackendLib (dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch (_) {
    return null
  }
  for (const name of entries) {
    const full = path.join(dir, name)
    let st
    try {
      st = fs.statSync(full)
    } catch (_) {
      continue
    }
    if (st.isDirectory()) {
      const nested = findVulkanBackendLib(full)
      if (nested) return nested
    } else if (/ggml-vulkan/i.test(name) && /\.(so|dll|dylib)$/i.test(name)) {
      return full
    }
  }
  return null
}

const PREBUILDS_DIR = path.join(__dirname, '..', '..', 'prebuilds')
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
  t.comment('Resolved backend info: ' + JSON.stringify(backendInfo))

  const vulkanSelected =
    backendInfo.backendDevice === 'GPU' || backendInfo.backendDevice === 'IGPU'

  if (vulkanSelected) {
    t.is(backendInfo.fallbackReason, '', 'no fallback reason when Vulkan is selected')
    t.ok(/vulkan/i.test(backendInfo.backendName), 'selected backend name mentions Vulkan')
  } else {
    // No Vulkan device available: the fallback to CPU MUST be reported.
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

    // Inference must succeed regardless of which backend was used.
    t.ok(outputTexts.length > 0, 'inference produced text regions')
    t.ok(outputTexts.includes('normal'), 'recognized expected text "normal"')

    t.pass('backendDevice vulkan path exercised (' + backendInfo.backendDevice + ')')
  } finally {
    await safeUnload(ocrGgml)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
