'use strict'

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

// TurboQuant / PolarQuant KV-cache quantization) ships Vulkan
// kernels only on the GPU side. Skip on Metal (darwin/iOS) and on platforms
// where CI's GPU backend is OpenCL or LLVMpipe software Vulkan.
const platform = os.platform()
const arch = os.arch()
const isVulkanPlatform =
  (platform === 'linux' && arch === 'x64') ||
  (platform === 'android' && arch === 'arm64') ||
  platform === 'win32'

const skipReason = isVulkanPlatform
  ? false
  : `Vulkan-only test; ${platform}-${arch} uses Metal/OpenCL/LLVMpipe`

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
      ctx_size: '1024',
      n_predict: '32',
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

  await model.load()

  const response = await model.run([
    { role: 'system', content: 'You are a geography tutor. Answer in one short sentence. /no_think' },
    { role: 'user', content: 'What is the capital of France?' }
  ])

  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  const output = chunks.join('').trim()
  const generatedTokens = Number(response.stats?.generatedTokens ?? 0)

  t.comment(`output: ${JSON.stringify(output)}`)
  t.ok(output.length > 0, `output non-empty (${output.length} chars)`)
  t.ok(generatedTokens > 0, `generated tokens > 0 (got ${generatedTokens})`)
  t.ok(/paris/i.test(output), `output mentions "Paris" (got ${JSON.stringify(output)})`)
})
