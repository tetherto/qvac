'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const getTmpDir = require('test-tmp')

const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isMobile = platform === 'ios' || platform === 'android'
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

const HYPERDRIVE_CONFIG = {
  device: 'gpu',
  gpu_layers: '999',
  ctx_size: '1024',
  n_predict: '48',
  verbosity: '2'
}

const HYPERDRIVE_MODEL = {
  hdKey: '1839dcabe1df8fdf1c83cd3d7a306c6e01e3c67e8542b0dd1e78cdfc86e75e2d',
  name: 'medgemma-4b-it-Q4_1-00001-of-00005.gguf',
  minTotalFiles: 5,
  shardRegex: /-\d{5}-of-\d{5}\.gguf$/,
  minShardHits: 3
}

test('[hyperdrive] sharded GGUF load', { timeout: 1_200_000, skip: isDarwinX64 || isMobile }, async t => {
  await runHyperdriveTest(t)
})

async function runHyperdriveTest (t) {
  const { hdKey, name: modelName } = HYPERDRIVE_MODEL

  const storePath = await getTmpDir()
  const cachePath = await getTmpDir()

  const store = new Corestore(storePath)
  const hdStore = store.namespace('hd')
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  const loggerHandle = attachSpecLogger({ forwardToConsole: true })
  const addon = new LlmLlamacpp({
    loader: hdDL,
    modelName,
    diskPath: cachePath,
    opts: { stats: true },
    logger: console
  }, HYPERDRIVE_CONFIG)

  const progressEvents = []
  const shardHits = new Set()
  const trackProgress = (report) => {
    if (!report || typeof report !== 'object') return
    progressEvents.push(report)
    if (HYPERDRIVE_MODEL.shardRegex.test(report.currentFile || '')) {
      shardHits.add(report.currentFile)
    }
  }

  await hdDL.ready()

  try {
    await addon.load(true, trackProgress)
    t.ok(progressEvents.length > 0, 'progress callback should fire at least once')
    t.ok(shardHits.size >= HYPERDRIVE_MODEL.minShardHits, `sharded downloads observed ${shardHits.size} shard files`)

    const response = await addon.run(BASE_PROMPT)
    const output = await collectResponse(response)
    const generated = response.stats?.generatedTokens || 0

    t.ok(output.length > 0 || generated > 0, 'model should produce output or emit generated tokens')
  } finally {
    await addon.unload().catch(() => {})
    await hdDL.close().catch(() => {})
    await store.close().catch(() => {})
    loggerHandle.release()
  }
}

// Keep event loop alive briefly to let pending async operations complete
// This prevents C++ destructors from running while async cleanup is still happening
// which can cause segfaults (exit code 139)
setImmediate(() => {
  setTimeout(() => {}, 500)
})
