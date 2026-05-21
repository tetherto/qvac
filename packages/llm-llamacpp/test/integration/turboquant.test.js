'use strict'

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

// TurboQuant / PolarQuant KV-cache quantization (PR #133) ships Vulkan +
// CPU kernels only. On Metal and OpenCL the addon now rejects TBQ cache
// types at model-load time with a clean InvalidArgument (see
// LlamaModel::tuneConfigMap in addon/src/model-interface/LlamaModel.cpp).
// This test covers both legs:
//   - Vulkan-capable host: inference must succeed end-to-end and the
//     answer must mention Paris.
//   - Metal-only host: model.load() must throw the addon's
//     backend-not-supported error.
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

const skipReason = (isVulkanHappyPath || isMetalRejectPath)
  ? false
  : `no clear TBQ assertion on ${platform}-${arch} (LLVMpipe Vulkan or unsupported)`

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

test('Qwen3-0.6B runs inference with tbq4_0 / pq4_0 KV cache', { timeout: 600_000, skip: skipReason }, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const model = new LlmLlamacpp({
    files: { model: [path.join(dirPath, modelName)] },
    config: {
      device: 'gpu',
      gpu_layers: '999',
      ctx_size: '2048',
      n_predict: '1024',
      temp: '0',
      seed: '42',
      'cache-type-k': 'tbq4_0',
      'cache-type-v': 'pq4_0',
      'flash-attn': 'on',
      verbosity: '2'
    },
    logger: console,
    opts: { stats: true }
  })

  t.teardown(async () => {
    await model.unload().catch(() => {})
    specLogger.release()
  })

  if (isMetalRejectPath) {
    // The addon should refuse TBQ cache types on Metal before sched_reserve
    // gets a chance to abort. We assert the rejection happens at load time
    // with a recognizable message that mentions the cache-type and the
    // offending backend.
    await t.exception(
      () => model.load(),
      /(cache-type|TurboQuant|PolarQuant).*(Metal|not supported)/i,
      'model.load() rejects tbq4_0/pq4_0 on Metal with a clear backend-not-supported error'
    )
    return
  }

  await model.load()

  const response = await model.run([
    { role: 'system', content: 'You are a geography tutor. Answer briefly.' },
    { role: 'user', content: 'What is the capital of France?' }
  ])

  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  const output = chunks.join('').trim()
  const generatedTokens = Number(response.stats?.generatedTokens ?? 0)

  t.comment(`output: ${JSON.stringify(output)}`)
  t.ok(output.length > 0, `output non-empty (${output.length} chars)`)
  t.ok(generatedTokens > 0, `generated tokens > 0 (got ${generatedTokens})`)
  t.ok(/paris|france/i.test(output), `output mentions "Paris" or "France" (got ${JSON.stringify(output)})`)
})
