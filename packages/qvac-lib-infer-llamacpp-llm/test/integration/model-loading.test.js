'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')

const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
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

  const loader = new FilesystemDL({ dirPath })
  const config = {
    gpu_layers: '999',
    ctx_size: '1024',
    device: useCpu ? 'cpu' : 'gpu',
    n_predict: '32',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, config)

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
    await loader.close().catch(() => {})
  }
})

test('model unload is clean and idempotent', { timeout: 600_000 }, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const config = {
    gpu_layers: '512',
    ctx_size: '1024',
    device: useCpu ? 'cpu' : 'gpu',
    n_predict: '24',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, config)

  try {
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
  } finally {
    await loader.close().catch(() => {})
  }
})

// Keep event loop alive briefly to let pending async operations complete
// This prevents C++ destructors from running while async cleanup is still happening
// which can cause segfaults (exit code 139)
setImmediate(() => {
  setTimeout(() => {}, 500)
})
