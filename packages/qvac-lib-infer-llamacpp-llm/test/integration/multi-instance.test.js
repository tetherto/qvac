'use strict'

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isWindowsX64 = platform === 'win32' && arch === 'x64'
const useCpu = isDarwinX64 || isLinuxArm64

const DEFAULT_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const BASE_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Say hello in one short sentence.' }
]

const LONG_PROMPT = [
  { role: 'system', content: 'You are a storyteller. Write detailed stories.' },
  { role: 'user', content: 'Tell a story about a knight.' }
]

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

async function createInstance (modelName, dirPath, overrides = {}) {
  const modelPath = path.join(dirPath, modelName)
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '64',
    verbosity: '2',
    openclCacheDir: dirPath,
    ...overrides
  }

  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: createLogger(),
    opts: { stats: true }
  })

  const origLoad = addon.load.bind(addon)
  addon.load = async function () {
    const t0 = Date.now()
    await origLoad()
    console.log(`  model.load() took ${Date.now() - t0} ms`)
  }

  return { addon }
}

async function collectResponse (response) {
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return chunks.join('').trim()
}

test('Two instances can run inference simultaneously', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const { addon: addon1 } = await createInstance(modelName, dirPath)
  const { addon: addon2 } = await createInstance(modelName, dirPath)

  t.teardown(async () => {
    await addon1.unload().catch(() => {})
    await addon2.unload().catch(() => {})
  })

  await addon1.load()
  await addon2.load()

  const response1 = await addon1.run(BASE_PROMPT)
  const response2 = await addon2.run(BASE_PROMPT)

  const [output1, output2] = await Promise.all([
    collectResponse(response1),
    collectResponse(response2)
  ])

  t.ok(output1.length > 0, 'first instance produced output')
  t.ok(output2.length > 0, 'second instance produced output')
})

test('Repeated load/unload cycles should remain stable', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const NUM_CYCLES = 6

  for (let i = 0; i < NUM_CYCLES; i++) {
    const { addon } = await createInstance(modelName, dirPath)

    await addon.load()
    const response = await addon.run(BASE_PROMPT)
    const output = await collectResponse(response)

    t.ok(output.length > 0, `cycle ${i + 1}: produced output`)

    await addon.unload()

    t.pass(`cycle ${i + 1}: load/unload completed`)
  }

  t.pass(`all ${NUM_CYCLES} load/unload cycles completed successfully`)
})

test('Unloading one instance does not affect another generating instance', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const { addon: addon1 } = await createInstance(modelName, dirPath, {
    n_predict: '256'
  })
  const { addon: addon2 } = await createInstance(modelName, dirPath)

  t.teardown(async () => {
    await addon1.unload().catch(() => {})
    await addon2.unload().catch(() => {})
  })

  await addon1.load()
  await addon2.load()

  const response1 = await addon1.run(LONG_PROMPT)
  const chunks = []
  let unloadedInstance2 = false
  let resolveAfterTokens
  let thresholdReached = false
  const afterTokens = new Promise(resolve => { resolveAfterTokens = resolve })

  const responsePromise = response1
    .onUpdate(data => {
      chunks.push(data)
      if (resolveAfterTokens && chunks.length >= 3) {
        thresholdReached = true
        resolveAfterTokens()
        resolveAfterTokens = null
      }
    })
    .await()
    .finally(() => {
      if (resolveAfterTokens) {
        resolveAfterTokens()
        resolveAfterTokens = null
      }
    })

  await afterTokens
  t.ok(thresholdReached, 'instance 1 produced enough tokens before unloading instance 2')
  if (!unloadedInstance2) {
    unloadedInstance2 = true
    await addon2.unload()
    t.pass('unloaded instance 2 while instance 1 is generating')
  }

  await responsePromise

  const output1 = chunks.join('').trim()
  t.ok(output1.length > 0, 'instance 1 completed generation after instance 2 was unloaded')
  t.ok(unloadedInstance2, 'instance 2 was unloaded during instance 1 generation')
})

test('Multiple load/unload cycles on one instance while another generates', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const { addon: addon1 } = await createInstance(modelName, dirPath, {
    n_predict: '512'
  })

  t.teardown(async () => {
    await addon1.unload().catch(() => {})
  })

  await addon1.load()

  const response1 = await addon1.run(LONG_PROMPT)
  const chunks = []
  let cyclesCompleted = 0
  const NUM_CYCLES = 3
  const TOKENS_PER_CYCLE = 10
  let resolveTokenTarget = null
  let tokenTarget = 0

  const waitForTokens = async (count) => {
    if (chunks.length >= count) return
    await new Promise(resolve => {
      tokenTarget = count
      resolveTokenTarget = resolve
    })
  }

  const responsePromise = response1
    .onUpdate(data => {
      chunks.push(data)
      if (resolveTokenTarget && chunks.length >= tokenTarget) {
        const resolve = resolveTokenTarget
        resolveTokenTarget = null
        resolve()
      }
    })
    .await()
    .finally(() => {
      if (resolveTokenTarget) {
        const resolve = resolveTokenTarget
        resolveTokenTarget = null
        resolve()
      }
    })

  for (let i = 0; i < NUM_CYCLES; i++) {
    const target = (i + 1) * TOKENS_PER_CYCLE
    await waitForTokens(target)
    if (chunks.length < target) {
      break
    }
    cyclesCompleted++
    const cycleNum = cyclesCompleted
    const { addon: addon2 } = await createInstance(modelName, dirPath)
    await addon2.load()
    await addon2.unload()
    t.pass(`load/unload cycle ${cycleNum} completed while instance 1 generates`)
  }

  await responsePromise

  const output1 = chunks.join('').trim()
  t.ok(output1.length > 0, 'instance 1 completed generation')
  t.ok(cyclesCompleted > 0, `completed ${cyclesCompleted} load/unload cycles during generation`)
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
