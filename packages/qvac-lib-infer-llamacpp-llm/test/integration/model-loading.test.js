'use strict'

const test = require('brittle')

const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const HttpDL = require('./http-loader')
const os = require('bare-os')
const path = require('bare-path')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isLinuxX64 = platform === 'linux' && arch === 'x64'
const useCpu = isDarwinX64 || isLinuxArm64

const DEFAULT_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const BASE_PROMPT = [
  {
    role: 'system',
    content: 'You are a helpful, respectful and honest assistant.'
  },
  {
    role: 'user',
    content: 'Say hello in one short sentence.'
  }
]

async function collectResponse (response) {
  const chunks = []
  await response
    .onUpdate(data => {
      chunks.push(data)
    })
    .await()
  return chunks.join('').trim()
}

test('filesystem loader can run inference end-to-end', { timeout: 600_000, skip: isDarwinX64 }, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const modelPath = path.join(dirPath, modelName)
  const config = {
    gpu_layers: '999',
    ctx_size: '1024',
    device: useCpu ? 'cpu' : 'gpu',
    n_predict: '32',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })

  try {
    await addon.load()
    const response = await addon.run(BASE_PROMPT)
    const output = await collectResponse(response)

    t.ok(output.length > 0, 'filesystem-loaded model should generate output')
  } catch (error) {
    console.error(error)
    t.fail('filesystem-loaded model should generate output', error)
  } finally {
    await addon.unload().catch(() => {})
  }
})

test('model unload is clean and idempotent', { timeout: 600_000 }, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const modelPath = path.join(dirPath, modelName)
  const config = {
    gpu_layers: '512',
    ctx_size: '1024',
    device: useCpu ? 'cpu' : 'gpu',
    n_predict: '24',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })

  await addon.load()
  const firstResponse = await addon.run(BASE_PROMPT)
  await collectResponse(firstResponse)

  await addon.unload()
  t.pass('first unload succeeded')

  await addon.load()
  const secondResponse = await addon.run(BASE_PROMPT)
  await collectResponse(secondResponse)

  await addon.unload()
  t.pass('second unload succeeded')

  await addon.unload().catch(err => {
    if (err) t.fail('unload should be idempotent', err)
  })
})

const SHARDED_MODEL = {
  name: 'Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf',
  baseUrl: 'https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ1_S-sharded/resolve/main/'
}

// This test can take longer to download and execute. To avoid blowing up testing time on all
// platforms, just use Linux for now. C++ tests already have faster coverage for each type
// of load.
test('sharded model can run inference end-to-end', { timeout: 4 * 60 * 1000, skip: !isLinuxX64 }, async t => {
  const fs = require('bare-fs')
  const modelDir = path.resolve(__dirname, '../model')
  fs.mkdirSync(modelDir, { recursive: true })

  const shardFiles = [
    'Qwen3-0.6B-UD-IQ1_S.tensors.txt',
    'Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf',
    'Qwen3-0.6B-UD-IQ1_S-00002-of-00003.gguf',
    'Qwen3-0.6B-UD-IQ1_S-00003-of-00003.gguf'
  ]

  const loader = new HttpDL({ baseUrl: SHARDED_MODEL.baseUrl })
  for (const filename of shardFiles) {
    const dest = path.join(modelDir, filename)
    if (fs.existsSync(dest)) continue
    console.log(`  Downloading shard: ${filename}`)
    const stream = await loader.getStream(filename)
    const ws = fs.createWriteStream(dest)
    for await (const chunk of stream) {
      ws.write(chunk)
    }
    ws.end()
    await new Promise(resolve => ws.on('close', resolve))
  }
  await loader.close().catch(() => {})

  const shardPaths = shardFiles.map(f => path.join(modelDir, f))
  const config = {
    gpu_layers: '999',
    ctx_size: '1024',
    device: useCpu ? 'cpu' : 'gpu',
    n_predict: '32',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    files: { model: shardPaths },
    config,
    logger: console,
    opts: { stats: true }
  })

  try {
    await addon.load()
    const response = await addon.run(BASE_PROMPT)
    const output = await collectResponse(response)
    t.ok(output.length > 0, 'sharded model should generate output')
  } finally {
    await addon.unload().catch(() => {})
  }
})

// Keep event loop alive briefly to let pending async operations complete
// This prevents C++ destructors from running while async cleanup is still happening
// which can cause segfaults (exit code 139)
setImmediate(() => {
  setTimeout(() => {}, 500)
})
