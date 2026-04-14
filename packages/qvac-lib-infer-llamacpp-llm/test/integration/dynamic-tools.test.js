'use strict'

const test = require('brittle')
const path = require('bare-path')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const QWEN3_MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const SYSTEM_MESSAGE = { role: 'system', content: 'You are a helpful assistant.' }

const BASE_CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '4096',
  n_predict: '64',
  temp: '0.1',
  seed: '1',
  verbosity: '2',
  tools: 'true',
  tools_at_end: 'true'
}

const TOOL_A = {
  type: 'function',
  name: 'getWeather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city']
  }
}

const TOOL_B = {
  type: 'function',
  name: 'searchProducts',
  description: 'Search for products in catalog',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query']
  }
}

const TOOL_C = {
  type: 'function',
  name: 'sendEmail',
  description: 'Send an email message',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email' },
      body: { type: 'string', description: 'Email body' }
    },
    required: ['to', 'body']
  }
}

const toNumber = value => typeof value === 'number' ? value : Number(value || 0)

function normalizeStats (rawStats = {}) {
  return {
    CacheTokens: toNumber(rawStats?.CacheTokens),
    promptTokens: toNumber(rawStats?.promptTokens),
    generatedTokens: toNumber(rawStats?.generatedTokens)
  }
}

async function setupModel (t, overrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_MODEL.name,
    downloadUrl: QWEN3_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const config = { ...BASE_CONFIG, ...overrides }
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  let loggerReleased = false
  const releaseLogger = () => {
    if (loggerReleased) return
    loggerReleased = true
    specLogger.release()
  }

  const model = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, config)

  try {
    await model.load()
  } catch (err) {
    releaseLogger()
    await loader.close().catch(() => {})
    throw err
  }

  t.teardown(async () => {
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
    releaseLogger()
  })

  return { model, dirPath }
}

async function runAndCollect (model, prompt, runOptions) {
  const response = await model.run(prompt, runOptions)
  const chunks = []
  let chain = response.onUpdate(data => { chunks.push(data) })
  if (typeof response.onError === 'function') {
    chain = chain.onError(err => { throw err })
  }
  await chain.await()
  return {
    output: chunks.join(''),
    stats: normalizeStats(response.stats)
  }
}

test('[dynamic-tools] multi-turn session with changing tools does not accumulate stale tokens', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t)
  const sessionName = path.join(dirPath, 'dynamic-tools-changing.bin')

  const opts = { cacheKey: sessionName }
  const prompt1 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Hello, what can you do?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1, opts)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')

  const prompt2 = [
    { role: 'user', content: 'Search for laptops' },
    TOOL_B
  ]
  const r2 = await runAndCollect(model, prompt2, opts)
  t.ok(r2.output.length > 0, 'turn 2 produces output')
  t.ok(r2.stats.CacheTokens > 0, 'turn 2 has cache tokens')

  const prompt3 = [
    { role: 'user', content: 'Send a report' },
    TOOL_C
  ]
  const r3 = await runAndCollect(model, prompt3, opts)
  t.ok(r3.output.length > 0, 'turn 3 produces output')
  t.ok(r3.stats.CacheTokens > 0, 'turn 3 has cache tokens')

  const naiveAccumulation = r1.stats.CacheTokens + r2.stats.promptTokens + r2.stats.generatedTokens + r3.stats.promptTokens + r3.stats.generatedTokens
  t.ok(
    r3.stats.CacheTokens < naiveAccumulation,
    `CacheTokens after 3 turns (${r3.stats.CacheTokens}) should be less than naive accumulation (${naiveAccumulation}) — proves old tools are trimmed`
  )

  t.ok(
    r3.stats.CacheTokens < 2 * r1.stats.CacheTokens,
    `CacheTokens after 3 turns (${r3.stats.CacheTokens}) should be less than 2x turn 1 (${2 * r1.stats.CacheTokens}) — tools are replaced, not accumulated`
  )
})

test('[dynamic-tools] multi-turn session with same tools works correctly', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t)
  const sessionName = path.join(dirPath, 'dynamic-tools-same.bin')

  const opts = { cacheKey: sessionName }
  const prompt1 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Paris?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1, opts)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')

  const prompt2 = [
    { role: 'user', content: 'What about London?' },
    TOOL_A
  ]
  const r2 = await runAndCollect(model, prompt2, opts)
  t.ok(r2.output.length > 0, 'turn 2 produces output')
  t.ok(r2.stats.CacheTokens > 0, 'turn 2 has cache tokens')
  t.ok(
    r2.stats.CacheTokens < 2 * r1.stats.CacheTokens,
    `CacheTokens after turn 2 (${r2.stats.CacheTokens}) should be less than 2x turn 1 (${2 * r1.stats.CacheTokens})`
  )
})

test('[dynamic-tools] single-shot with tools works without session', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Tokyo?' },
    TOOL_A
  ]
  const r = await runAndCollect(model, prompt)
  t.ok(r.output.length > 0, 'produces output')
  t.is(r.stats.CacheTokens, 0, 'no cache tokens without session')
  t.ok(r.stats.promptTokens > 0, 'prompt tokens tracked')
  t.ok(r.stats.generatedTokens > 0, 'generated tokens tracked')
})
