'use strict'

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'List three random animals.' }
]

async function setupModel (t, configOverrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const modelPath = path.join(dirPath, modelName)
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '64',
    temp: '1.0',
    verbosity: '2',
    ...configOverrides
  }

  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })

  await model.load()

  t.teardown(async () => {
    await model.unload().catch(() => {})
    specLogger.release()
  })

  return { model }
}

async function collectResponse (response) {
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return chunks.join('')
}

test('generationParams | predict controls output length', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { seed: '42' })

  const responseShort = await model.run(PROMPT, {
    generationParams: { predict: 8 }
  })
  const outputShort = await collectResponse(responseShort)
  const shortTokens = Number(responseShort?.stats?.generatedTokens || 0)

  const responseLong = await model.run(PROMPT, {
    generationParams: { predict: 48 }
  })
  const outputLong = await collectResponse(responseLong)
  const longTokens = Number(responseLong?.stats?.generatedTokens || 0)

  t.ok(shortTokens > 0, `predict=8 generated ${shortTokens} tokens`)
  t.ok(longTokens > 0, `predict=48 generated ${longTokens} tokens`)
  t.ok(shortTokens <= 8, `predict=8 respects limit (got ${shortTokens})`)
  t.ok(longTokens > shortTokens, `predict=48 (${longTokens} tokens) > predict=8 (${shortTokens} tokens)`)
  t.ok(outputLong.length > outputShort.length, 'longer predict produces longer text output')
})

test('generationParams | load-time defaults restored after override', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '32', seed: '42' })

  const responseOverride = await model.run(PROMPT, {
    generationParams: { predict: 5 }
  })
  await collectResponse(responseOverride)
  const overrideTokens = Number(responseOverride?.stats?.generatedTokens || 0)

  const responseDefault = await model.run(PROMPT)
  await collectResponse(responseDefault)
  const defaultTokens = Number(responseDefault?.stats?.generatedTokens || 0)

  t.ok(overrideTokens <= 5, `override predict=5 respected (got ${overrideTokens})`)
  t.ok(defaultTokens > overrideTokens, `default run (${defaultTokens} tokens) exceeds overridden run (${overrideTokens} tokens)`)
  t.is(defaultTokens, 32, `default run tokens (${defaultTokens}) should be 32`)
})
