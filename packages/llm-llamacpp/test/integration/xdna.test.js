'use strict'

// AMD XDNA NPU (Linux x64, fabric >= 0.28.0).
//
// Two kinds of test:
//   - A fallback smoke test that runs on every desktop host without an NPU:
//     `device: 'npu'` finds no device and falls back to the GPU order, then
//     the CPU.
//   - Hardware tests that run only on a host whose accel device is bound to the
//     amdxdna driver. They also need XRT 2.25 or newer under /opt/xilinx/xrt
//     and read/write access to the /dev/accel node; without either fabric does
//     not list the NPU and these tests fail on the missing
//     `Chosen NPU Backend` line.
//
// The chosen device name and KV-cache types are not exposed to JS, so the tests
// read them from the native logs, as kv-cache-type-defaults.test.js does. The
// device class is, as stats.backendDevice.
//
// XDNA_TEST_MODELS picks the models the hardware tests run, as a comma-separated
// list of models.manifest.json names (default: the 0.8B Q4_K_M), for example
//   XDNA_TEST_MODELS=Qwen3.5-0.8B-Q4_K_M.gguf,Qwen3.5-2B-Q4_K_M.gguf,Qwen3.5-4B-Q4_K_M.gguf,Qwen3.5-9B-Q4_K_M.gguf
// Only a 1024-wide model (Qwen3.5-0.8B) reaches the fused NPU decode layer.
// A wider one (2B 2048, 4B 2560, 9B 4096) keeps the NPU for prefill and runs
// its decode on the host, and fabric warns once, naming its width.
//
// Desktop only: not scheduled on mobile (see isOverrideOnly in
// scripts/lib/validate-test-groups.js).

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const isLinuxX64 = platform === 'linux' && os.arch() === 'x64'

// True when any /sys/class/accel device is driven by amdxdna. A bare
// /dev/accel/accel0 is not enough: Intel's NPU driver uses the same node.
function hasAmdXdnaNpu() {
  if (!isLinuxX64) return false
  try {
    return fs.readdirSync('/sys/class/accel').some((entry) => {
      try {
        const driver = fs.readlinkSync(`/sys/class/accel/${entry}/device/driver`)
        return /(^|\/)amdxdna$/.test(String(driver))
      } catch (_) {
        return false
      }
    })
  } catch (_) {
    return false
  }
}

const hasNpu = hasAmdXdnaNpu()

// prestage-ignore: Llama-3.2-1B-Instruct-Q4_0.gguf — desktop-only; the test skips on mobile
// prestage-ignore: Qwen3.5-0.8B-Q4_K_M.gguf — desktop-only (Linux x64 XDNA NPU)

// Fallback smoke test model: small, cached on CI, no NPU needed.
const FALLBACK_MODEL = 'Llama-3.2-1B-Instruct-Q4_0.gguf'

// The NPU's fused decode layer accepts this quant as published: ssm_out is
// Q5_K, ffn_gate/ffn_up Q4_K and ffn_down Q4_K/Q6_K. A Q8_0 ssm_out (such as
// Qwen3.5-0.8B-Q8_0.gguf) is refused at the first decode.
const NPU_MODEL = 'Qwen3.5-0.8B-Q4_K_M.gguf'

function npuModels() {
  const fromEnv = (process.env && process.env.XDNA_TEST_MODELS) || ''
  const names = fromEnv
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return names.length > 0 ? names : [NPU_MODEL]
}

// The fused decode layer is built for one residual width, Qwen3.5-0.8B's.
function hasFusedWidth(modelName) {
  return /^Qwen3\.5-0\.8B-/i.test(modelName)
}

const PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is 2+2? Answer in one word.' }
]

const CHOSEN_NPU_RE = /Chosen NPU Backend/
const NO_NPU_RE = /No NPU device found; falling back to the GPU backend order, then CPU/
// llama.cpp names each weight buffer after its buffer type; the XDNA device's
// is XDNA_Host.
const XDNA_BUFFER_RE = /\bXDNA\w*\s+model buffer size\s*=/i
const FUSED_REFUSAL_RE = /unsupported fused weight set|needs the .*-bit activation layout/i
// Fabric falls back to the host when its kernels are missing or stale, and the
// output stays correct, so these are what show the NPU had kernels to run.
const KERNELS_FOUND_RE = /GEMM geometries: decode=gemm_/
const KERNELS_MISSING_RE = /no GEMM kernels found|not built for design tag|no fused_layer artifact/
// Fabric logs this once per process, for the first wider model.
const WIDER_MODEL_RE =
  /the fused decode layers are built for a 1024-wide residual stream, this model's is (\d+)/

// Fabric logs its kernel discovery once per process, on the first load that
// uses the NPU, so every load's native log is also kept here.
const processLogs = []

function parseKvCacheTypes(logs) {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i]
    if (!/llama_kv_cache:/.test(line)) continue
    const k = line.match(/K\s*\(([^)]+)\)/)
    const v = line.match(/V\s*\(([^)]+)\)/)
    if (k && v) return { k: k[1].trim(), v: v[1].trim() }
  }
  return null
}

async function loadAndRun(modelName, extraConfig) {
  const [name, dirPath] = await ensureModel({ modelName })
  const specLogger = attachSpecLogger({
    forwardToConsole: true,
    onLog: (line) => processLogs.push(line)
  })

  const model = new LlmLlamacpp({
    files: { model: [path.join(dirPath, name)] },
    config: {
      device: 'gpu',
      gpu_layers: '999',
      ctx_size: '2048',
      n_predict: '64',
      temp: '0',
      seed: '42',
      verbosity: '2',
      // The q8_0 KV default needs flash attention, so turning it on is what
      // makes the f16 assertions below meaningful.
      'flash-attn': 'on',
      ...extraConfig
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    await model.load()
    const response = await model.run(PROMPT, { generationParams: { reasoning_budget: 0 } })
    const chunks = []
    await response
      .onUpdate((data) => {
        chunks.push(data)
      })
      .await()
    const logText = specLogger.logs.join('\n')
    return {
      output: chunks.join('').trim(),
      kvTypes: parseKvCacheTypes(specLogger.logs),
      backendDevice: response.stats?.backendDevice,
      logText
    }
  } finally {
    await model.unload().catch(() => {})
    specLogger.release()
  }
}

function assertRanOnNpu(t, modelName, { output, kvTypes, backendDevice, logText }) {
  const processText = processLogs.join('\n')
  t.is(backendDevice, 'npu', 'stats report the NPU device class')
  t.ok(KERNELS_FOUND_RE.test(processText), 'fabric found its NPU GEMM kernels')
  t.absent(KERNELS_MISSING_RE.test(processText), 'NPU kernel artifacts are present and current')
  t.absent(FUSED_REFUSAL_RE.test(logText), 'fused decode layer accepted the model weights')
  if (hasFusedWidth(modelName)) {
    t.absent(WIDER_MODEL_RE.test(logText), 'the model fits the fused decode layer')
  } else {
    const wider = processText.match(WIDER_MODEL_RE)
    t.ok(wider, 'fabric reported a model wider than the fused decode layer')
    if (wider) t.comment(`${modelName}: first wider residual width seen, ${wider[1]}`)
  }
  t.ok(XDNA_BUFFER_RE.test(logText), 'model weights were placed in an XDNA buffer')
  t.ok(kvTypes, 'KV-cache allocation line was logged')
  t.is(kvTypes?.k, 'f16', 'cache-type-k stays f16 on the NPU')
  t.is(kvTypes?.v, 'f16', 'cache-type-v stays f16 on the NPU')
  t.absent(/defaulting kv-cache to q8_0/i.test(logText), 'no q8_0 KV default on the NPU')
  t.ok(/4|four/i.test(output), `NPU output answers the prompt: "${output.slice(0, 100)}"`)
}

safeTest(
  'xdna: device npu falls back to the GPU order, then the CPU, when no NPU is present',
  { timeout: 900_000, skip: isMobile || hasNpu },
  async (t) => {
    const result = await loadAndRun(FALLBACK_MODEL, { device: 'npu' })

    t.ok(result.output.length > 0, 'fallback run produced output')
    t.ok(NO_NPU_RE.test(result.logText), 'missing NPU was logged')
    t.absent(CHOSEN_NPU_RE.test(result.logText), 'the NPU was not chosen')
    t.ok(
      result.backendDevice === 'gpu' || result.backendDevice === 'cpu',
      `stats report the GPU or CPU fallback (got ${result.backendDevice})`
    )
    t.absent(XDNA_BUFFER_RE.test(result.logText), 'no weights were placed in an XDNA buffer')
  }
)

safeTest(
  'xdna: backend xdna is rejected, the NPU is device npu',
  { timeout: 900_000, skip: isMobile },
  async (t) => {
    await t.exception(
      loadAndRun(FALLBACK_MODEL, { backend: 'xdna' }),
      /unknown backend 'xdna'/,
      'backend takes GPU families only'
    )
  }
)

for (const modelName of npuModels()) {
  safeTest(
    `xdna: device npu runs ${modelName} on the NPU`,
    { timeout: 1_800_000, skip: !hasNpu },
    async (t) => {
      const result = await loadAndRun(modelName, { device: 'npu' })

      t.ok(
        CHOSEN_NPU_RE.test(result.logText),
        'NPU chosen through device npu (needs XRT 2.25+ under /opt/xilinx/xrt)'
      )
      assertRanOnNpu(t, modelName, result)
    }
  )

  safeTest(
    `xdna: devices XDNA0 runs ${modelName} on the NPU`,
    { timeout: 1_800_000, skip: !hasNpu },
    async (t) => {
      const result = await loadAndRun(modelName, { devices: 'XDNA0' })

      assertRanOnNpu(t, modelName, result)
    }
  )
}

safeTest(
  'xdna: default selection never picks the NPU',
  { timeout: 900_000, skip: !hasNpu },
  async (t) => {
    const result = await loadAndRun(npuModels()[0], {})

    t.ok(result.output.length > 0, 'default run produced output')
    t.absent(CHOSEN_NPU_RE.test(result.logText), 'the NPU was not chosen by device gpu')
    t.absent(XDNA_BUFFER_RE.test(result.logText), 'no weights were placed in an XDNA buffer')
    t.not(result.backendDevice, 'npu', 'stats do not report the NPU')
  }
)
