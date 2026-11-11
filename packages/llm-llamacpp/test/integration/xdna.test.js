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
// Desktop only: not scheduled on mobile (see isOverrideOnly in
// scripts/lib/validate-test-groups.js).

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath, safeTest } = require('./utils')
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
// prestage-ignore: mmproj-Qwen3.5-0.8B-F16.gguf — desktop-only (Linux x64 XDNA NPU)

// Fallback smoke test model: small, cached on CI, no NPU needed.
const FALLBACK_MODEL = 'Llama-3.2-1B-Instruct-Q4_0.gguf'

// The NPU's fused decode layer accepts this quant as published: ssm_out is
// Q5_K, ffn_gate/ffn_up Q4_K and ffn_down Q4_K/Q6_K. A Q8_0 ssm_out (such as
// Qwen3.5-0.8B-Q8_0.gguf) is refused at the first decode.
const NPU_MODEL = 'Qwen3.5-0.8B-Q4_K_M.gguf'

const PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is 2+2? Answer in one word.' }
]

// The vision projector of NPU_MODEL, for the projector-placement tests.
const NPU_MMPROJ = 'mmproj-Qwen3.5-0.8B-F16.gguf'
const IMAGE_FILE = 'elephant.jpg'

function imagePrompt() {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    {
      role: 'user',
      type: 'media',
      content: new Uint8Array(fs.readFileSync(getMediaPath(IMAGE_FILE)))
    },
    { role: 'user', content: 'What animal is in the image? Answer in one word.' }
  ]
}

// The addon logs where it put the projector on every GPU or NPU load:
// "multimodal projector backend: GPU Vulkan0 (<reason>)", or "CPU (<reason>)".
// Fabric then logs "clip_ctx: CLIP using <device> backend" when it loads the
// projector, but on stderr, outside the log capture below: read it from the
// console output.
const PROJECTOR_RE = /multimodal projector backend: (?:(GPU|NPU) (\S+)|CPU) \(([^)]*)\)/

function projectorDecision(logText) {
  const match = logText.match(PROJECTOR_RE)
  if (!match) return null
  return { where: match[1] || 'CPU', device: match[2] || null, reason: match[3] }
}

// An NPU-led load puts the projector on a GPU beside the NPU, or on the CPU
// when the host has none: never on the NPU by default.
function assertProjectorDefault(t, logText) {
  const decision = projectorDecision(logText)
  t.ok(decision, 'the projector placement was logged')
  if (!decision) return null
  t.comment(`projector: ${decision.where}${decision.device ? ' ' + decision.device : ''}`)
  if (decision.where === 'GPU') {
    t.absent(/xdna/i.test(decision.device), `the projector GPU is not the NPU (${decision.device})`)
    t.is(
      decision.reason,
      'auto-default, a GPU beside the XDNA NPU',
      'projector on a GPU beside the NPU'
    )
  } else {
    t.is(decision.where, 'CPU', 'the projector does not default to the NPU')
    t.is(decision.reason, 'auto-default, XDNA NPU without a GPU', 'no GPU: projector on the CPU')
  }
  return decision
}

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

// `projection` adds a vision projector; `prompt` replaces the text prompt.
async function loadAndRun(modelName, extraConfig, { projection = null, prompt = PROMPT } = {}) {
  const [name, dirPath] = await ensureModel({ modelName })
  const files = { model: [path.join(dirPath, name)] }
  if (projection) {
    const [projName, projDir] = await ensureModel({ modelName: projection })
    files.projectionModel = path.join(projDir, projName)
  }
  const specLogger = attachSpecLogger({
    forwardToConsole: true,
    onLog: (line) => processLogs.push(line)
  })

  const model = new LlmLlamacpp({
    files,
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
    const response = await model.run(prompt, { generationParams: { reasoning_budget: 0 } })
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

function assertRanOnNpu(t, { output, kvTypes, backendDevice, logText }) {
  const processText = processLogs.join('\n')
  t.is(backendDevice, 'npu', 'stats report the NPU device class')
  t.ok(KERNELS_FOUND_RE.test(processText), 'fabric found its NPU GEMM kernels')
  t.absent(KERNELS_MISSING_RE.test(processText), 'NPU kernel artifacts are present and current')
  t.absent(FUSED_REFUSAL_RE.test(logText), 'fused decode layer accepted the model weights')
  t.ok(XDNA_BUFFER_RE.test(logText), 'model weights were placed in an XDNA buffer')
  t.ok(kvTypes, 'KV-cache allocation line was logged')
  t.is(kvTypes?.k, 'f16', 'cache-type-k stays f16 on the NPU')
  t.is(kvTypes?.v, 'f16', 'cache-type-v stays f16 on the NPU')
  t.absent(/defaulting kv-cache to q8_0/i.test(logText), 'no q8_0 KV default on the NPU')
  t.ok(/4|four/i.test(output), `NPU output answers the prompt: "${output.slice(0, 100)}"`)
  assertProjectorDefault(t, logText)
}

safeTest(
  'xdna: device npu falls back to the GPU order, then the CPU, when no NPU is present',
  { timeout: 900_000, skip: isMobile || hasNpu },
  async (t) => {
    const result = await loadAndRun(FALLBACK_MODEL, { device: 'npu' })

    t.ok(result.output.length > 0, 'fallback run produced output')
    t.ok(NO_NPU_RE.test(result.logText), 'missing NPU was logged')
    t.absent(CHOSEN_NPU_RE.test(result.logText), 'the NPU was not chosen')
    // The fallback is the GPU order: a GPU when the host has an eligible one,
    // the CPU only when it has none.
    const choseGpu = /Chosen i?GPU /.test(result.logText)
    t.ok(choseGpu || /Chosen CPU/.test(result.logText), 'the fallback logged its choice')
    t.is(
      result.backendDevice,
      choseGpu ? 'gpu' : 'cpu',
      `stats report the ${choseGpu ? 'GPU' : 'CPU'} the fallback chose`
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

safeTest(
  'xdna: device npu runs the model on the NPU',
  { timeout: 900_000, skip: !hasNpu },
  async (t) => {
    const result = await loadAndRun(NPU_MODEL, { device: 'npu' })

    t.ok(
      CHOSEN_NPU_RE.test(result.logText),
      'NPU chosen through device npu (needs XRT 2.25+ under /opt/xilinx/xrt)'
    )
    assertRanOnNpu(t, result)
  }
)

safeTest(
  'xdna: devices XDNA0 selects the NPU explicitly',
  { timeout: 900_000, skip: !hasNpu },
  async (t) => {
    const result = await loadAndRun(NPU_MODEL, { devices: 'XDNA0' })

    assertRanOnNpu(t, result)
  }
)

// The projector is untested on the NPU, so a vision model on the NPU encodes
// its image on a GPU beside it, or on the CPU when there is none.
safeTest(
  'xdna: device npu encodes the image beside the NPU',
  { timeout: 900_000, skip: !hasNpu },
  async (t) => {
    const result = await loadAndRun(
      NPU_MODEL,
      { device: 'npu', ctx_size: '4096' },
      { projection: NPU_MMPROJ, prompt: imagePrompt() }
    )

    t.is(result.backendDevice, 'npu', 'stats report the NPU device class')
    t.ok(XDNA_BUFFER_RE.test(result.logText), 'model weights were placed in an XDNA buffer')
    assertProjectorDefault(t, result.logText)
    t.ok(
      /elephant/i.test(result.output),
      `the answer names the elephant: "${result.output.slice(0, 100)}"`
    )
  }
)

safeTest(
  'xdna: mmproj-use-gpu false keeps the projector on the CPU',
  { timeout: 900_000, skip: !hasNpu },
  async (t) => {
    const result = await loadAndRun(
      NPU_MODEL,
      { device: 'npu', ctx_size: '4096', 'mmproj-use-gpu': 'false' },
      { projection: NPU_MMPROJ, prompt: imagePrompt() }
    )

    const decision = projectorDecision(result.logText)
    t.is(decision?.where, 'CPU', 'the projector stays on the CPU')
    t.is(decision?.reason, 'mmproj-use-gpu override', 'the override decided it')
    t.is(result.backendDevice, 'npu', 'the model still runs on the NPU')
    t.ok(
      /elephant/i.test(result.output),
      `the answer names the elephant: "${result.output.slice(0, 100)}"`
    )
  }
)

safeTest(
  'xdna: default selection never picks the NPU',
  { timeout: 900_000, skip: !hasNpu },
  async (t) => {
    const result = await loadAndRun(NPU_MODEL, {})

    t.ok(result.output.length > 0, 'default run produced output')
    t.absent(CHOSEN_NPU_RE.test(result.logText), 'the NPU was not chosen by device gpu')
    t.absent(XDNA_BUFFER_RE.test(result.logText), 'no weights were placed in an XDNA buffer')
    t.not(result.backendDevice, 'npu', 'stats do not report the NPU')
  }
)
