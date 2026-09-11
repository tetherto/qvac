'use strict'

const process = require('bare-process')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const path = require('bare-path')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France? Answer in one word.' }
]

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

async function collectResponse(response) {
  const chunks = []
  await response
    .onUpdate((data) => {
      chunks.push(data)
    })
    .await()
  return chunks.join('').trim()
}

const hasMultiGpu = process.env.QVAC_HAS_MULTI_GPU === '1'
const skip = isDarwinX64

const BASE_CONFIG = {
  device: 'gpu',
  gpu_layers: '999',
  ctx_size: '1024',
  n_predict: '32',
  verbosity: '2'
}

// QVAC_HAS_MULTI_GPU promises two OR MORE GPUs, so a hardcoded share list is
// only correct on a two-device runner. A count matching neither the eligible
// device count nor the registered GPU count is now rejected outright, so
// discover the real count instead of assuming it.
//
// The probe is a plain layer split: that mode needs no share list, pins the
// eligible device set, and logs one `<Device> model buffer size` line per
// participant, which is the same signal the assertions already read.
async function discoverDeviceCount(modelPath) {
  let addon = null
  const specLogger = attachSpecLogger({ forwardToConsole: false })
  try {
    addon = new LlmLlamacpp({
      files: { model: [modelPath] },
      config: { ...BASE_CONFIG, 'split-mode': 'layer' },
      logger: null,
      opts: { stats: true }
    })
    await addon.load()
    const count = extractBufferDevices(specLogger.logs).size
    if (count < 1) {
      throw new Error('device-count probe found no GPU model buffers in the spec logs')
    }
    return count
  } finally {
    specLogger.release()
    if (addon) await addon.unload().catch(() => {})
  }
}

async function runMultiGpuTest(t, extraConfig, assertDevices) {
  if (!hasMultiGpu) {
    t.comment('Skipping: QVAC_HAS_MULTI_GPU is not set')
    return
  }

  let addon = null
  let specLogger = null
  try {
    const [modelName, dirPath] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })

    const modelPath = path.join(dirPath, modelName)
    // A config function needs the device count, which costs a probe load, so
    // only pay for it when one is supplied.
    let resolvedConfig = extraConfig
    if (typeof extraConfig === 'function') {
      const deviceCount = await discoverDeviceCount(modelPath)
      t.comment(`discovered ${deviceCount} eligible device(s)`)
      resolvedConfig = extraConfig(deviceCount)
    }

    // Attached after the probe so its logs cannot leak into the assertions.
    specLogger = attachSpecLogger({ forwardToConsole: true })
    addon = new LlmLlamacpp({
      files: { model: [modelPath] },
      config: { ...BASE_CONFIG, ...resolvedConfig },
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
    assertDevices(t, devices, specLogger.logs)
  } catch (error) {
    console.error(error)
    t.fail('multi-gpu test failed: ' + error.message)
  } finally {
    if (specLogger) specLogger.release()
    if (addon) await addon.unload().catch(() => {})
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
  { timeout: 600_000, skip },
  async (t) => {
    await runMultiGpuTest(t, { 'split-mode': 'layer' }, assertMultiDevice('layers'))
  }
)

// 'row' needs split buffers, which only SYCL provides and SYCL is outside the
// addon's allowlist, so the mode never took effect here; it is rejected rather
// than silently run as 'layer'.
safeTest('multi-gpu: split-mode=row is rejected', { timeout: 600_000, skip }, async (t) => {
  if (!hasMultiGpu) {
    t.comment('Skipping: QVAC_HAS_MULTI_GPU is not set')
    return
  }

  let addon = null
  try {
    const [modelName, dirPath] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })

    addon = new LlmLlamacpp({
      files: { model: [path.join(dirPath, modelName)] },
      config: { ...BASE_CONFIG, 'split-mode': 'row' },
      logger: null,
      opts: { stats: true }
    })

    await addon.load()
    t.fail("load should reject split-mode 'row'")
  } catch (error) {
    t.ok(
      /split-mode 'row' is no longer accepted/.test(error.message) &&
        /'layer' or 'tensor'/.test(error.message),
      "error should reject 'row' and point at 'layer' or 'tensor', got: " + error.message
    )
  } finally {
    if (addon) await addon.unload().catch(() => {})
  }
})

safeTest(
  'multi-gpu: default (no split-mode) pins layers to a single device',
  { timeout: 600_000, skip },
  async (t) => {
    await runMultiGpuTest(t, {}, assertSingleDevice)
  }
)

// One equal share per eligible device, derived rather than hardcoded: '1,1'
// only matched a two-device runner and would be rejected on a runner with
// three or more eligible devices. Timeout is doubled because the derivation
// adds a probe load.
safeTest(
  'multi-gpu: split-mode=layer with tensor-split and main-gpu',
  { timeout: 1_200_000, skip },
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

// QVAC-24253. A device count alone cannot tell tensor mode from layer mode —
// both put buffers on >= 2 devices. The meta backend names itself
// "Meta(<dev0>,<dev1>,...)" (ggml-backend-meta.cpp), so that string in the logs
// is the positive proof LLAMA_SPLIT_MODE_TENSOR actually engaged rather than
// being quietly degraded or ignored.
// Device names must be parsed out of the Meta(...) buffer name, NOT from
// `devices`. extractBufferDevices requires `<Device> model buffer size`, but
// under tensor mode the buffer is the composed meta buffer, so the line reads
// `Meta(Vulkan0,Vulkan1) model buffer size = ...` — the token is followed by
// `,` or `)`, never whitespace, so that set is always empty here.
function extractMetaDevices(logs) {
  for (const line of logs) {
    const match = line.match(/\bMeta\(([^)]*)\)\s+model buffer size\s*=/i)
    if (match) {
      return match[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    }
  }
  return []
}

function assertMetaDeviceEngaged(t, devices, logs) {
  const metaDevices = extractMetaDevices(logs)
  t.ok(metaDevices.length > 0, 'should report a Meta(...) buffer, proving the meta backend engaged')
  t.ok(
    metaDevices.length >= 2,
    `weights and KV should span >= 2 devices (found: ${metaDevices.join(', ')})`
  )
  // Deliberately NOT asserting "no integrated GPU participates" from these
  // tokens. The Meta(...) name is built from ggml_backend_buft_name, which
  // yields backend name + index (`Vulkan0`, `CUDA1`, `ROCm0`) and never
  // encodes the device type — so a /igpu/ test would be vacuous and pass on a
  // host where the iGPU had in fact been recruited. Whether the iGPU is
  // excluded is pinned by the unit tests over getSplitDeviceNames, which
  // can see the device type. A real end-to-end check would have to match the
  // known iGPU description against fabric's `using device ...` INFO lines,
  // which is CI-host-specific.
  t.comment(`tensor-mode devices: ${metaDevices.join(', ')}`)
}

safeTest(
  'multi-gpu: split-mode=tensor distributes weights and KV across GPUs',
  { timeout: 600_000, skip },
  async (t) => {
    // ctx_size is pinned by BASE_CONFIG, which matters here: tensor mode
    // disables auto-fit, so an unset ctx_size would default to the model's full
    // trained context.
    await runMultiGpuTest(t, { 'split-mode': 'tensor' }, assertMetaDeviceEngaged)
  }
)

safeTest(
  'multi-gpu: split-mode=tensor rejects flash-attn off',
  { timeout: 600_000, skip },
  async (t) => {
    if (!hasMultiGpu) {
      t.comment('Skipping: QVAC_HAS_MULTI_GPU is not set')
      return
    }

    let addon = null
    try {
      const [modelName, dirPath] = await ensureModel({
        modelName: MODEL.name,
        downloadUrl: MODEL.url
      })

      addon = new LlmLlamacpp({
        files: { model: [path.join(dirPath, modelName)] },
        config: { ...BASE_CONFIG, 'split-mode': 'tensor', 'flash-attn': 'off' },
        logger: null,
        opts: { stats: true }
      })

      await addon.load()
      t.fail('load should reject when tensor split is combined with flash-attn=off')
    } catch (error) {
      t.ok(
        /flash attention/i.test(error.message),
        'error should name the flash-attention requirement, got: ' + error.message
      )
    } finally {
      if (addon) await addon.unload().catch(() => {})
    }
  }
)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
