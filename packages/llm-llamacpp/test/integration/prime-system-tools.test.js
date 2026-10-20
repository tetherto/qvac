'use strict'

// A prefill of only a system prompt and tools, saved and reloaded, leaves the
// first question to prefill only its user turn. Qwen3.5's template renders no
// tools without a user turn, so this covers the placeholder-user render.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModelPath, safeTest } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const QWEN35 = { modelName: 'Qwen3.5-0.8B-Q8_0.gguf' }

const CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '4096',
  n_predict: '8',
  temp: '0',
  seed: '7',
  tools: 'true',
  verbosity: '0'
}

const SYSTEM = { role: 'system', content: 'You are a weather assistant.' }
const TOOLS = [
  {
    type: 'function',
    name: 'getWeather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city']
    }
  }
]
const QUESTION = { role: 'user', content: 'What is the weather in Paris?' }

async function loadModel(t, modelPath) {
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: CONFIG,
    logger: console,
    opts: { stats: true }
  })
  await model.load()
  let unloaded = false
  const unload = async () => {
    if (unloaded) return
    unloaded = true
    await model.unload().catch(() => {})
  }
  t.teardown(unload)
  return { model, unload }
}

async function run(model, messages, runOptions) {
  const response = await model.run(messages, runOptions)
  await response.onUpdate(() => {}).await()
  const stats = response.stats || {}
  return {
    promptTokens: Number(stats.promptTokens || 0),
    cacheTokens: Number(stats.CacheTokens || 0),
    toolDefinitionsDropped: Number(stats.toolDefinitionsDropped || 0)
  }
}

safeTest(
  'prime: a saved system prompt and tools prefill leaves only the user turn to prefill',
  { timeout: 600_000 },
  async (t) => {
    const dir = path.join(os.tmpdir(), `qvac-prime-system-tools-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    t.teardown(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (_) {}
    })
    const coldKey = path.join(dir, 'cold.bin')
    const primedKey = path.join(dir, 'primed.bin')
    const modelPath = await ensureModelPath(QWEN35)

    const first = await loadModel(t, modelPath)
    const cold = await run(first.model, [SYSTEM, ...TOOLS, QUESTION], { cacheKey: coldKey })
    const primed = await run(first.model, [SYSTEM, ...TOOLS], {
      cacheKey: primedKey,
      prefill: true
    })
    await first.model.saveCache(primedKey)
    await first.unload()

    t.is(primed.toolDefinitionsDropped, 0, 'the prefill keeps the tool definitions')
    t.ok(primed.cacheTokens > 0, `the prefill cached ${primed.cacheTokens} tokens`)
    t.ok(
      primed.cacheTokens < cold.promptTokens,
      `the prefill (${primed.cacheTokens}) stops before the user turn (${cold.promptTokens})`
    )

    const second = await loadModel(t, modelPath)
    const warm = await run(second.model, [SYSTEM, ...TOOLS, QUESTION], { cacheKey: primedKey })

    t.is(warm.toolDefinitionsDropped, 0, 'the question keeps the tool definitions')
    t.is(
      warm.promptTokens,
      cold.promptTokens - primed.cacheTokens,
      `after a reload the question prefilled ${warm.promptTokens} of ${cold.promptTokens} tokens`
    )
  }
)
