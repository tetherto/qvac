'use strict'

const test = require('brittle')
const path = require('bare-path')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const QWEN3_5_MODEL = {
  name: 'Qwen3.5-0.8B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}

const BASE_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is 2+2? Answer in one word.' }
]

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

async function collectResponse (response) {
  const chunks = []
  const ticker = setInterval(() => {}, 50)
  try {
    await response.onUpdate(data => { chunks.push(data) }).await()
  } finally {
    clearInterval(ticker)
  }
  return chunks.join('').trim()
}

test('Qwen3.5-0.8B can run basic inference', {
  timeout: 600_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '64',
    temp: '0',
    seed: '42',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: createLogger(),
    opts: { stats: true }
  }, config)

  try {
    const t0 = Date.now()
    await addon.load()
    console.log(`  model.load() took ${Date.now() - t0} ms`)

    const response = await addon.run(BASE_PROMPT)
    const output = await collectResponse(response)

    t.ok(output.length > 0, `inference produced output (${output.length} chars)`)
    console.log(`  output: "${output.slice(0, 200)}"`)
    const lowerOutput = output.toLowerCase()
    t.ok(/4|four/.test(lowerOutput), `output contains 4 or four: "${output.slice(0, 100)}"`)

    t.ok(response.stats, 'response has stats')
    if (response.stats) {
      t.ok(response.stats.promptTokens > 0, `prompt tokens: ${response.stats.promptTokens}`)
      t.ok(response.stats.generatedTokens > 0, `generated tokens: ${response.stats.generatedTokens}`)
    }
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

test('Qwen3.5-0.8B supports multi-turn conversation with KV cache', {
  timeout: 600_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
    n_predict: '128',
    temp: '0',
    seed: '42',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: createLogger(),
    opts: { stats: true }
  }, config)

  try {
    await addon.load()

    const sessionName = path.join(dirPath, 'qwen3-5-multiturn-cache.bin')
    const systemMsg = { role: 'system', content: 'You are a helpful assistant. Answer concisely with just the city name.' }
    const userTurn1 = { role: 'user', content: 'What is the capital of France?' }

    const prompt1 = [
      { role: 'session', content: sessionName },
      systemMsg,
      userTurn1
    ]
    const response1 = await addon.run(prompt1)
    const output1 = await collectResponse(response1)
    t.ok(output1.length > 0, `first turn produced output (${output1.length} chars)`)
    const lowerOutput1 = output1.toLowerCase()
    t.ok(/paris/.test(lowerOutput1), `first turn mentions Paris: "${output1.slice(0, 100)}"`)

    const prompt2 = [
      { role: 'session', content: sessionName },
      systemMsg,
      userTurn1,
      { role: 'assistant', content: output1 },
      { role: 'user', content: 'And what about Germany?' }
    ]
    const response2 = await addon.run(prompt2)
    const output2 = await collectResponse(response2)
    t.ok(output2.length > 0, `second turn produced output (${output2.length} chars)`)
    const lowerOutput2 = output2.toLowerCase()
    t.ok(/berlin/.test(lowerOutput2), `second turn mentions Berlin: "${output2.slice(0, 100)}"`)
    t.ok(output2 !== output1, 'second turn produced different output from first')
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
