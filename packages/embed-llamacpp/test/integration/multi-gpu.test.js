'use strict'

const test = require('brittle')
const process = require('bare-process')
const GGMLBert = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const path = require('bare-path')

const MODEL = {
  name: 'embeddinggemma-300M-Q8_0.gguf'
}

const TEXT = 'The quick brown fox jumps over the lazy dog.'

function extractBufferDevices (logs) {
  const deviceNames = new Set()
  for (const line of logs) {
    const match = line.match(/\b((?:Vulkan|CUDA|Metal|ROCm|SYCL|OpenCL)\d*)\b\s+model buffer size\s*=/i)
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

async function runMultiGpuTest (t, extraConfig, assertDevices) {
  if (!hasMultiGpu) {
    t.comment('Skipping: QVAC_HAS_MULTI_GPU is not set')
    return
  }

  const [modelName, dirPath] = await ensureModel(MODEL.name)
  const modelPath = path.join(dirPath, modelName)
  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const addon = new GGMLBert({
    files: { model: [modelPath] },
    config: { ...BASE_CONFIG, ...extraConfig },
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

function assertMultiDevice (label) {
  return (t, devices) => {
    t.ok(devices.size >= 2, `${label} should be on >= 2 devices (found: ${[...devices].join(', ')})`)
  }
}

function assertSingleDevice (t, devices) {
  t.ok(devices.size <= 1, `layers should stay on a single device (found: ${[...devices].join(', ')})`)
}

test('multi-gpu: split-mode=layer distributes layers across GPUs', { timeout: 600_000 }, async t => {
  await runMultiGpuTest(t, { 'split-mode': 'layer' }, assertMultiDevice('layers'))
})

test('multi-gpu: split-mode=row distributes tensors across GPUs', { timeout: 600_000 }, async t => {
  await runMultiGpuTest(t, { 'split-mode': 'row' }, assertMultiDevice('tensors'))
})

test('multi-gpu: default (no split-mode) pins layers to a single device', { timeout: 600_000 }, async t => {
  await runMultiGpuTest(t, {}, assertSingleDevice)
})

test('multi-gpu: split-mode=layer with tensor-split and main-gpu', { timeout: 600_000 }, async t => {
  await runMultiGpuTest(
    t,
    { 'split-mode': 'layer', 'tensor-split': '1,1', 'main-gpu': '0' },
    assertMultiDevice('layers')
  )
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
