'use strict'

const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const path = require('bare-path')

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France? Answer in one word.' }
]

function extractBufferDevices (logs) {
  const deviceNames = new Set()
  for (const line of logs) {
    const match = line.match(/\b((?:Vulkan|CUDA|Metal|ROCm|SYCL|OpenCL)\d*)\b\s+model buffer size\s*=/i)
    if (match) deviceNames.add(match[1])
  }
  return deviceNames
}

async function collectResponse (response) {
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return chunks.join('').trim()
}

const hasMultiGpu = process.env.QVAC_HAS_MULTI_GPU === '1'

const BASE_CONFIG = {
  device: 'gpu',
  gpu_layers: '999',
  ctx_size: '1024',
  n_predict: '32',
  verbosity: '2'
}

async function runMultiGpuTest (t, extraConfig, assertDevices) {
  if (!hasMultiGpu) {
    t.comment('Skipping: QVAC_HAS_MULTI_GPU is not set')
    return
  }

  let addon = null
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  try {
    const [modelName, dirPath] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })

    const modelPath = path.join(dirPath, modelName)
    addon = new LlmLlamacpp({
      files: { model: [modelPath] },
      config: { ...BASE_CONFIG, ...extraConfig },
      logger: null,
      opts: { stats: true }
    })

    await addon.load()
    const response = await addon.run(PROMPT)
    const output = await collectResponse(response)
    const stats = response.stats || {}

    t.ok(output.length > 0, 'should generate output')
    t.is(stats.backendDevice, 'gpu', 'should report gpu backend')

    const devices = extractBufferDevices(specLogger.logs)
    assertDevices(t, devices)
  } catch (error) {
    console.error(error)
    t.fail('multi-gpu test failed: ' + error.message)
  } finally {
    specLogger.release()
    if (addon) await addon.unload().catch(() => {})
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

safeTest('multi-gpu: split-mode=layer distributes layers across GPUs', { timeout: 600_000 }, async t => {
  await runMultiGpuTest(t, { 'split-mode': 'layer' }, assertMultiDevice('layers'))
})

safeTest('multi-gpu: split-mode=row distributes tensors across GPUs', { timeout: 600_000 }, async t => {
  await runMultiGpuTest(t, { 'split-mode': 'row' }, assertMultiDevice('tensors'))
})

safeTest('multi-gpu: default (no split-mode) pins layers to a single device', { timeout: 600_000 }, async t => {
  await runMultiGpuTest(t, {}, assertSingleDevice)
})

safeTest('multi-gpu: split-mode=layer with tensor-split and main-gpu', { timeout: 600_000 }, async t => {
  await runMultiGpuTest(
    t,
    { 'split-mode': 'layer', 'tensor-split': '1,1', 'main-gpu': '0' },
    assertMultiDevice('layers')
  )
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
