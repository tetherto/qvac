'use strict'

const test = require('brittle')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')

const platform = os.platform()
const arch = os.arch()

const isDesktopGpu = (platform === 'linux' || platform === 'win32') &&
  arch === 'x64'
const isAndroid = platform === 'android'
const skipReason = !(isDesktopGpu || isAndroid)
  ? 'TurboQuant KV cache tests require Vulkan GPU on Linux, Windows, or Android'
  : false

const MODELS = [
  {
    id: 'Llama-3.2-3B',
    name: 'llama-3.2-3b-instruct-q4_0.gguf',
    url: 'https://huggingface.co/lahirum/Llama-3.2-3B-Instruct-Q4_0-GGUF/resolve/main/llama-3.2-3b-instruct-q4_0.gguf',
    headDim: 128
  },
  {
    id: 'Llama-3.2-1B',
    name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf',
    headDim: 64
  }
]

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
  { role: 'system', content: 'You are a concise assistant. Answer in one sentence.' },
  { role: 'user', content: 'What is the capital of France?' }
]

async function setupModel (t, model, kvTypes) {
  const [modelName, dirPath] = await ensureModel({
    modelName: model.name,
    downloadUrl: model.url
  })

  const loader = new FilesystemDL({ dirPath })
  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '512',
    n_predict: '48',
    temp: '0',
    seed: '42',
    verbosity: '2',
    'cache-type-k': kvTypes.k,
    'cache-type-v': kvTypes.v
  }

  const inference = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    projectionPath: '',
    opts: { stats: true }
  }, config)

  await inference.load()

  t.teardown(async () => {
    try {
      specLogger.release()
      if (loader) await loader.close()
      if (inference) await inference.unload()
    } catch (err) {
      // Ignore cleanup errors
    }
  })

  return inference
}

async function collectResponse (response) {
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return chunks.join('').trim()
}

for (const model of MODELS) {
  const combos = KV_COMBOS

  for (const kv of combos) {
    const label = `turboquant: ${model.id} K=${kv.k} V=${kv.v}`

    test(label, { skip: skipReason, timeout: 600_000 }, async t => {
      t.comment(`head_dim=${model.headDim}  cache-type-k=${kv.k}  cache-type-v=${kv.v}`)

      const inference = await setupModel(t, model, kv)
      const response = await inference.run(PROMPT)
      const output = await collectResponse(response)

      t.ok(output.length > 0, `produced output (length=${output.length})`)
      t.comment(`${model.id} output: ${output.slice(0, 200)}`)
      const mentionsParis = /paris/i.test(output)
      t.ok(mentionsParis, 'output mentions Paris')
    })
  }
}
