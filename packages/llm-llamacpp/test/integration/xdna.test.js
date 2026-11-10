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
// list (default: the 0.8B Q4_K_M). Each entry is a models.manifest.json name,
// downloaded and verified as usual, or an absolute path to a local GGUF, used
// as is (a requantized model, say). For example
//   XDNA_TEST_MODELS=Qwen3.5-0.8B-Q4_K_M.gguf,Qwen3.5-2B-Q4_K_M.gguf,/models/Qwen3.5-9B-custom.gguf
// Only a 1024-wide model (Qwen3.5-0.8B) reaches the fused NPU decode layer.
// A wider one (2B 2048, 4B 2560, 9B 4096) keeps the NPU for prefill and runs
// its decode on the host, and fabric warns once, naming its width. The tests
// read each file's width from its GGUF header, so a renamed file is classified
// by what it is.
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

// Bare has no global `process`, so read through bare-os first, as
// kv-cache-extended.test.js does.
function readEnv(key) {
  if (typeof os.getEnv === 'function') return os.getEnv(key) || ''
  if (typeof process !== 'undefined' && process.env) return process.env[key] || ''
  return ''
}

function npuModels() {
  const fromEnv = readEnv('XDNA_TEST_MODELS')
  const names = fromEnv
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return names.length > 0 ? names : [NPU_MODEL]
}

// The residual width the fused decode layer is built for, Qwen3.5-0.8B's.
const FUSED_WIDTH = 1024

// A manifest name is downloaded and verified; an absolute path is used as is.
async function resolveModel(entry) {
  if (path.isAbsolute(entry)) {
    if (!fs.existsSync(entry)) {
      throw new Error(`XDNA_TEST_MODELS: ${entry} does not exist`)
    }
    return [path.basename(entry), path.dirname(entry)]
  }
  return await ensureModel({ modelName: entry })
}

// The residual width, `<arch>.embedding_length`, from a GGUF header; null when
// the file has none. Reads in 1 MiB chunks, so the tokenizer arrays it may
// have to skip cost a few reads.
function ggufEmbeddingLength(filePath) {
  const SCALAR_BYTES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
  const GGUF_STRING = 8
  const GGUF_ARRAY = 9
  const chunk = new Uint8Array(1 << 20)
  const view = new DataView(chunk.buffer)
  let chunkStart = 0
  let chunkEnd = 0
  let pos = 0
  const fd = fs.openSync(filePath, 'r')

  const fill = (bytes) => {
    if (pos >= chunkStart && pos + bytes <= chunkEnd) return pos - chunkStart
    const read = fs.readSync(fd, chunk, 0, chunk.byteLength, pos)
    chunkStart = pos
    chunkEnd = pos + read
    if (pos + bytes > chunkEnd) throw new Error(`${filePath}: truncated GGUF header`)
    return 0
  }
  const u32 = () => {
    const value = view.getUint32(fill(4), true)
    pos += 4
    return value
  }
  const u64 = () => {
    const value = Number(view.getBigUint64(fill(8), true))
    pos += 8
    return value
  }
  const str = () => {
    const length = u64()
    const at = fill(length)
    pos += length
    return String.fromCharCode(...chunk.subarray(at, at + length))
  }
  const skip = (type) => {
    if (type === GGUF_STRING) {
      // Not `pos += u64()`: that reads pos before u64() moves it past the length.
      const length = u64()
      pos += length
    } else if (type === GGUF_ARRAY) {
      const elementType = u32()
      const count = u64()
      if (elementType in SCALAR_BYTES) {
        pos += SCALAR_BYTES[elementType] * count
      } else {
        for (let i = 0; i < count; i++) skip(elementType)
      }
    } else if (type in SCALAR_BYTES) {
      pos += SCALAR_BYTES[type]
    } else {
      throw new Error(`${filePath}: unknown GGUF value type ${type}`)
    }
  }

  try {
    const at = fill(4)
    if (String.fromCharCode(...chunk.subarray(at, at + 4)) !== 'GGUF') {
      throw new Error(`${filePath}: not a GGUF file`)
    }
    pos += 4
    u32() // version
    u64() // tensor count
    const kvCount = u64()
    for (let i = 0; i < kvCount; i++) {
      const key = str()
      const type = u32()
      if (key.endsWith('.embedding_length') && (type === 4 || type === 5)) return u32()
      if (key.endsWith('.embedding_length') && (type === 10 || type === 11)) return u64()
      skip(type)
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
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
  const [name, dirPath] = await resolveModel(modelName)
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
      modelPath: path.join(dirPath, name),
      logText
    }
  } finally {
    await model.unload().catch(() => {})
    specLogger.release()
  }
}

function assertRanOnNpu(t, { output, kvTypes, backendDevice, modelPath, logText }) {
  const processText = processLogs.join('\n')
  t.is(backendDevice, 'npu', 'stats report the NPU device class')
  t.ok(KERNELS_FOUND_RE.test(processText), 'fabric found its NPU GEMM kernels')
  t.absent(KERNELS_MISSING_RE.test(processText), 'NPU kernel artifacts are present and current')
  t.absent(FUSED_REFUSAL_RE.test(logText), 'fused decode layer accepted the model weights')
  const width = ggufEmbeddingLength(modelPath)
  t.comment(`${path.basename(modelPath)}: residual width ${width}`)
  if (width === FUSED_WIDTH) {
    t.absent(WIDER_MODEL_RE.test(logText), 'the model fits the fused decode layer')
  } else if (width !== null) {
    // Logged once per process, for the first wider model, so read the whole run.
    t.ok(WIDER_MODEL_RE.test(processText), 'fabric reported a model wider than the fused layer')
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
  const label = path.basename(modelName)

  safeTest(
    `xdna: device npu runs ${label} on the NPU`,
    { timeout: 1_800_000, skip: !hasNpu },
    async (t) => {
      const result = await loadAndRun(modelName, { device: 'npu' })

      t.ok(
        CHOSEN_NPU_RE.test(result.logText),
        'NPU chosen through device npu (needs XRT 2.25+ under /opt/xilinx/xrt)'
      )
      assertRanOnNpu(t, result)
    }
  )

  safeTest(
    `xdna: devices XDNA0 runs ${label} on the NPU`,
    { timeout: 1_800_000, skip: !hasNpu },
    async (t) => {
      const result = await loadAndRun(modelName, { devices: 'XDNA0' })

      assertRanOnNpu(t, result)
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
