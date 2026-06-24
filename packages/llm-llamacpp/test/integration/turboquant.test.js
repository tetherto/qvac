'use strict'

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

// TurboQuant / PolarQuant KV-cache quantization (PR #133 / qvac PR #1564)
// ships Vulkan + CPU kernels only. On Metal and OpenCL the addon rejects
// TBQ cache types at model-load time with a clean InvalidArgument (see
// LlamaModel::tuneConfigMap in addon/src/model-interface/LlamaModel.cpp).
//
// This file has two parallel concerns:
//   1. Metal/iOS reject path (single test): model.load() must throw the
//      addon's backend-not-supported error with a recognizable message,
//      regardless of which TBQ KV-type the user requested.
//   2. Vulkan happy path (parameterized over MODEL x KV_COMBOS): the
//      model must load and produce a topically coherent answer for every
//      supported (K, V) cache-type pair. Llama-3.2-1B exercises
//      head_dim=64, which on the runtime maps to the internal `_64` TBQ
//      types. The heavier Llama-3.2-3B/head_dim=128 path is covered by
//      quantized-kvcache.test.js.
//
// linux-arm64 in CI runs on LLVMpipe software Vulkan, which is neither
// the Vulkan happy path (too slow / partial feature coverage) nor the
// Metal/OpenCL reject path — skip it entirely.
const platform = os.platform()
const arch = os.arch()
const isVulkanHappyPath =
  (platform === 'linux' && arch === 'x64') ||
  (platform === 'android' && arch === 'arm64') ||
  platform === 'win32'
const isMetalRejectPath = platform === 'darwin' || platform === 'ios'
const isAndroid = platform === 'android'

const skipReason = (isVulkanHappyPath || isMetalRejectPath)
  ? false
  : `no clear TBQ assertion on ${platform}-${arch} (LLVMpipe Vulkan or unsupported)`

// Keep this functional sweep on the smaller head_dim=64 model; the larger
// head_dim=128 benchmark path is covered by quantized-kvcache.test.js.
const MODEL = {
  id: 'Llama-3.2-1B',
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf',
  headDim: 64
}

// (K, V) combinations to sweep. Covers the four homogeneous TBQ/PQ
// configurations plus three mixed pairings (TBQ on K + a different
// quant on V) so the codepath for "K and V cache-types differ" gets
// exercised too.
const KV_COMBOS = [
  { k: 'tbq3_0', v: 'pq3_0' },
  { k: 'pq3_0', v: 'pq3_0' },
  { k: 'pq4_0', v: 'pq4_0' },
  { k: 'tbq4_0', v: 'pq4_0' },
  { k: 'tbq4_0', v: 'pq3_0' },
  { k: 'tbq4_0', v: 'q4_0' },
  { k: 'tbq3_0', v: 'q4_0' }
]

const PROMPT = [
  { role: 'system', content: 'You are a geography tutor. Answer briefly.' },
  { role: 'user', content: 'What is the capital of France?' }
]

function makeConfig (kv) {
  return {
    device: 'gpu',
    gpu_layers: '999',
    // ctx_size=512 / n_predict=128 keeps the Mali-G715 (Pixel 9 Pro)
    // Vulkan compute buffer under the threshold where the driver
    // returns ErrorDeviceLost mid-inference. Larger budgets crashed the
    // GPU in prior runs.
    ctx_size: '512',
    n_predict: '128',
    temp: '0',
    seed: '42',
    'cache-type-k': kv.k,
    'cache-type-v': kv.v,
    'flash-attn': 'on',
    verbosity: '2'
  }
}

async function collectResponse (response) {
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return chunks.join('').trim()
}

// Metal / iOS reject path — single test, uses the first KV combo since
// the addon guard is independent of which TBQ KV-type was requested.
test(
  'Metal/iOS rejects TBQ cache types at model.load()',
  { skip: !isMetalRejectPath, timeout: 60_000 },
  async t => {
    const kv = KV_COMBOS[0]
    const [modelName, dirPath] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })

    const specLogger = attachSpecLogger({ forwardToConsole: true })
    const model = new LlmLlamacpp({
      files: { model: [path.join(dirPath, modelName)] },
      config: makeConfig(kv),
      logger: console,
      opts: { stats: true }
    })

    t.teardown(async () => {
      await model.unload().catch(() => {})
      specLogger.release()
    })

    await t.exception(
      () => model.load(),
      /(cache-type|TurboQuant|PolarQuant).*(Metal|not supported)/i,
      'model.load() rejects TBQ on Metal with a clear backend-not-supported error'
    )
  }
)

// Vulkan / Android GPU happy path — parameterized over KV_COMBOS.
for (const kv of KV_COMBOS) {
  const label = `TBQ inference: ${MODEL.id} (head_dim=${MODEL.headDim}) K=${kv.k} V=${kv.v}`

  test(
    label,
    { skip: skipReason || isMetalRejectPath, timeout: 600_000 },
    async t => {
      const [modelName, dirPath] = await ensureModel({
        modelName: MODEL.name,
        downloadUrl: MODEL.url
      })

      const specLogger = attachSpecLogger({ forwardToConsole: true })
      const llm = new LlmLlamacpp({
        files: { model: [path.join(dirPath, modelName)] },
        config: makeConfig(kv),
        logger: console,
        opts: { stats: true }
      })

      t.teardown(async () => {
        await llm.unload().catch(() => {})
        specLogger.release()
      })

      try {
        await llm.load()
      } catch (err) {
        // Android GPU drivers that don't expose Vulkan as the chosen
        // backend (e.g. Adreno 830 preferring OpenCL) will hit the
        // addon's TBQ guard. Treat that as a clean skip rather than
        // a test failure — the guard itself is exercised on the
        // Metal/iOS path above.
        if (isAndroid && /TurboQuant.*not supported/i.test(err.message)) {
          t.comment(`Android backend does not support TBQ: ${err.message}`)
          t.pass('addon rejected TBQ on this Android backend (likely OpenCL)')
          return
        }
        t.fail(`unexpected load error: ${err.message}`)
        return
      }

      const response = await llm.run(PROMPT)
      const output = await collectResponse(response)
      const generatedTokens = Number(response.stats?.generatedTokens ?? 0)

      t.comment(`output: ${JSON.stringify(output.slice(0, 200))}`)
      t.ok(output.length > 0, `output non-empty (${output.length} chars)`)
      t.ok(generatedTokens > 0, `generated tokens > 0 (got ${generatedTokens})`)
      // Llama 3.2 Instruct does not enter a <think> CoT preamble like
      // Qwen3, but the relaxed regex still tolerates models that say
      // "France" repeatedly before converging on "Paris".
      t.ok(
        /paris|france/i.test(output),
        `output mentions "Paris" or "France" (got ${JSON.stringify(output.slice(0, 200))})`
      )
    }
  )
}
