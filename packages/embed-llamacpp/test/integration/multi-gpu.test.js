'use strict'

const process = require('bare-process')
const GGMLBert = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const path = require('bare-path')

const MODEL = {
  name: 'embeddinggemma-300M-Q8_0.gguf'
}

const TEXT = 'The quick brown fox jumps over the lazy dog.'

function extractBufferDevices(logs) {
  const deviceNames = new Set()
  for (const line of logs) {
    const match = line.match(
      /\b((?:Vulkan|CUDA|Metal|ROCm|SYCL|OpenCL)\d*)\b\s+model buffer size\s*=/i
    )
    if (match) deviceNames.add(match[1])
  }
  return deviceNames
}

const hasMultiGpu = process.env.QVAC_HAS_MULTI_GPU === '1'

const BASE_CONFIG = {
  device: 'gpu',
  gpu_layers: '999',
  verbosity: '2'
}

// QVAC_HAS_MULTI_GPU promises two OR MORE GPUs, and a tensor-split matching
// neither the eligible nor the registered GPU count is rejected, so probe.
async function discoverDeviceCount(modelPath) {
  const specLogger = attachSpecLogger({ forwardToConsole: false })
  const addon = new GGMLBert({
    files: { model: [modelPath] },
    config: { ...BASE_CONFIG, 'split-mode': 'layer' },
    logger: null,
    opts: { stats: true }
  })

  try {
    await addon.load()
    const response = await addon.run(TEXT)
    await response.await()
    return extractBufferDevices(specLogger.logs).size
  } finally {
    specLogger.release()
    await addon.unload().catch(() => {})
  }
}

async function runMultiGpuTest(t, extraConfig, assertDevices) {
  if (!hasMultiGpu) {
    t.comment('Skipping: QVAC_HAS_MULTI_GPU is not set')
    return
  }

  const [modelName, dirPath] = await ensureModel({ modelName: MODEL.name })
  const modelPath = path.join(dirPath, modelName)
  const resolvedConfig =
    typeof extraConfig === 'function'
      ? extraConfig(await discoverDeviceCount(modelPath))
      : extraConfig
  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const addon = new GGMLBert({
    files: { model: [modelPath] },
    config: { ...BASE_CONFIG, ...resolvedConfig },
    logger: null,
    opts: { stats: true }
  })

  try {
    await addon.load()
    const response = await addon.run(TEXT)
    const embeddings = await response.await()

    t.ok(embeddings.length > 0, 'should generate embeddings')
    t.is(response.stats.backendDevice, 'gpu', 'should report gpu backend')

    const devices = extractBufferDevices(specLogger.logs)
    assertDevices(t, devices)
  } finally {
    specLogger.release()
    await addon.unload().catch(() => {})
  }
}

function assertMultiDevice(label) {
  return (t, devices) => {
    t.ok(
      devices.size >= 2,
      `${label} should be on >= 2 devices (found: ${[...devices].join(', ')})`
    )
  }
}

function assertSingleDevice(t, devices) {
  t.ok(
    devices.size <= 1,
    `layers should stay on a single device (found: ${[...devices].join(', ')})`
  )
}

safeTest(
  'multi-gpu: split-mode=layer distributes layers across GPUs',
  { timeout: 600_000 },
  async (t) => {
    await runMultiGpuTest(t, { 'split-mode': 'layer' }, assertMultiDevice('layers'))
  }
)

safeTest(
  'multi-gpu: default (no split-mode) pins layers to a single device',
  { timeout: 600_000 },
  async (t) => {
    await runMultiGpuTest(t, {}, assertSingleDevice)
  }
)

safeTest(
  'multi-gpu: split-mode=layer with tensor-split and main-gpu',
  { timeout: 900_000 },
  async (t) => {
    await runMultiGpuTest(
      t,
      (deviceCount) => ({
        'split-mode': 'layer',
        'tensor-split': Array(deviceCount).fill('1').join(','),
        'main-gpu': '0'
      }),
      assertMultiDevice('layers')
    )
  }
)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
