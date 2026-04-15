'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath } = require('./utils')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const GEMMA4_MODEL = {
  llmModel: {
    modelName: 'gemma-4-E2B-it-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf'
  },
  projModel: {
    modelName: 'mmproj-gemma-4-E2B-it-BF16.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/mmproj-BF16.gguf'
  }
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

test('Gemma 4 can run basic text inference', {
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)

  const loader = new FilesystemDL({ dirPath })
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
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

test('Gemma 4 can describe an image', {
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)
  const [projModelName] = await ensureModel(GEMMA4_MODEL.projModel)

  const loader = new FilesystemDL({ dirPath })
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '98',
    ctx_size: '2048',
    temp: '0',
    seed: '42',
    verbosity: '2'
  }

  const inference = new LlmLlamacpp({
    modelName,
    loader,
    logger: createLogger(),
    diskPath: dirPath,
    projectionModel: projModelName
  }, config)

  try {
    const t0 = Date.now()
    await inference.load()
    console.log(`  model.load() took ${Date.now() - t0} ms`)

    const imageFilePath = getMediaPath('elephant.jpg')
    t.ok(fs.existsSync(imageFilePath), 'elephant.jpg image file should exist')

    const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))
    const messages = [
      { role: 'user', type: 'media', content: imageBytes },
      { role: 'user', content: 'What animal is in this image? Answer in one word.' }
    ]

    const response = await inference.run(messages)
    const generatedText = []
    let error = null

    response.onUpdate(data => { generatedText.push(data) })
      .onError(err => { error = err })

    await response.await()

    if (error) {
      throw new Error('Inference error: ' + error)
    }

    const output = generatedText.join('')
    t.ok(output.length > 0, `image inference produced output (${output.length} chars)`)
    console.log(`  output: "${output.slice(0, 200)}"`)

    const lowerOutput = output.toLowerCase()
    t.ok(/elephant/.test(lowerOutput), `output mentions elephant: "${output.slice(0, 100)}"`)
  } finally {
    await inference.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
