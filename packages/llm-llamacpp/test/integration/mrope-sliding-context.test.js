'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { cleanupIntegrationCacheFiles, ensureModel, getMediaPath, safeTest } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwin = platform === 'darwin'
const isIos = platform === 'ios'
const isAndroid = platform === 'android'
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64
const skipTbqPq = isDarwin || isIos || isAndroid

const QWEN3_5_MODEL = {
  name: 'Qwen3.5-0.8B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}

const QWEN3_5_PROJ_MODEL = {
  name: 'mmproj-Qwen3.5-0.8B-F16.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf'
}

const LLAMA3_2_1B_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const LLAMA3_2_3B_MODEL = {
  name: 'llama-3.2-3b-instruct-q4_0.gguf',
  url: 'https://huggingface.co/lahirum/Llama-3.2-3B-Instruct-Q4_0-GGUF/resolve/main/llama-3.2-3b-instruct-q4_0.gguf'
}

const SYSTEM_MESSAGE = {
  role: 'system',
  content: 'You are a helpful assistant. Keep answers concise.'
}

const IMAGE_SYSTEM_MESSAGE = {
  role: 'system',
  content: 'You are a helpful assistant. Keep answers concise.'
}

const QWEN_TEXT_PREFILL_PRESSURE = ' blue'.repeat(96)
const QWEN_TEXT_PREFILL_MAX_SLIDE_TURNS = 8
const QWEN_MULTIMODAL_PREFILL_PRESSURE = ' blue'.repeat(192)
const QWEN_MULTIMODAL_PREFILL_MAX_SLIDE_TURNS = 6
const LLAMA_PREFILL_PRESSURE = ' blue'.repeat(96)
const LLAMA_PREFILL_MAX_SLIDE_TURNS = 8

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

function normalizeStats (rawStats = {}) {
  return {
    CacheTokens: Number(rawStats.CacheTokens || rawStats.cacheTokens || 0),
    contextSlides: Number(rawStats.contextSlides || 0),
    generatedTokens: Number(rawStats.generatedTokens || 0),
    promptTokens: Number(rawStats.promptTokens || 0)
  }
}

async function runAndCollect (model, prompt, runOptions) {
  const response = await model.run(prompt, runOptions)
  const chunks = []
  const ticker = setInterval(() => {}, 50)

  try {
    await response.onUpdate(data => { chunks.push(data) }).await()
  } finally {
    clearInterval(ticker)
  }

  return {
    output: chunks.join(''),
    stats: normalizeStats(response.stats)
  }
}

async function runQwenTextSlidingCacheCase (t) {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })

  const modelPath = path.join(dirPath, modelName)
  const cachePath = path.join(dirPath, 'qwen3-5-text-prefill-sliding-cache.bin')
  cleanupIntegrationCacheFiles(cachePath)

  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '999',
      ctx_size: '512',
      n_discarded: '256',
      verbosity: '2'
    },
    logger: createLogger(),
    opts: { stats: true }
  })

  await model.load()

  t.teardown(async () => {
    try { fs.unlinkSync(cachePath) } catch (_) {}
    await model.unload().catch(() => {})
  })

  await primeSystemCache(model, cachePath)

  let totalSlides = 0
  let lastStats = null

  for (let turn = 1; turn <= QWEN_TEXT_PREFILL_MAX_SLIDE_TURNS; turn++) {
    const response = await model.run([
      {
        role: 'user',
        content: `Qwen text prefill pressure turn ${turn}. ${QWEN_TEXT_PREFILL_PRESSURE}`
      }
    ], {
      cacheKey: cachePath,
      saveCacheToDisk: true,
      prefill: true
    })
    await response.await()

    const stats = normalizeStats(response.stats)
    totalSlides += stats.contextSlides
    lastStats = stats

    if (totalSlides > 0) {
      break
    }
  }

  t.ok(totalSlides > 0, 'Qwen3.5 text exercises iM-RoPE prefill K-shift sliding')
  t.ok(lastStats.CacheTokens < 512, `Qwen3.5 text cache stays within context (${lastStats.CacheTokens})`)
}

async function setupMultimodalPaths () {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })
  const [projModelName] = await ensureModel({
    modelName: QWEN3_5_PROJ_MODEL.name,
    downloadUrl: QWEN3_5_PROJ_MODEL.url
  })

  return {
    dirPath,
    modelPath: path.join(dirPath, modelName),
    projectionModelPath: path.join(dirPath, projModelName)
  }
}

function createMultimodalModel (modelPath, projectionModelPath, extraConfig = {}) {
  return new LlmLlamacpp({
    files: { model: [modelPath], projectionModel: projectionModelPath },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '98',
      ctx_size: '1024',
      n_discarded: '512',
      temp: '0',
      seed: '42',
      reasoning_budget: '0',
      verbosity: '2',
      ...extraConfig
    },
    logger: createLogger(),
    opts: { stats: true }
  })
}

async function primeSystemCache (model, cachePath) {
  const response = await model.run([SYSTEM_MESSAGE], {
    cacheKey: cachePath,
    saveCacheToDisk: true,
    prefill: true
  })
  await response.await()
}

async function runMultimodalSlidingCacheCase (t, options = {}) {
  const { dirPath, modelPath, projectionModelPath } = await setupMultimodalPaths()
  const cachePath = path.join(dirPath, options.cacheFileName)
  cleanupIntegrationCacheFiles(cachePath)

  const imageFilePath = getMediaPath('elephant.jpg')
  t.ok(fs.existsSync(imageFilePath), 'elephant.jpg image file should exist')
  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

  let model = createMultimodalModel(modelPath, projectionModelPath, options.extraConfig)
  let loaded = false

  t.teardown(async () => {
    try { fs.unlinkSync(cachePath) } catch (_) {}
    if (loaded) {
      await model.unload().catch(() => {})
    }
  })

  await model.load()
  loaded = true

  const history = [
    IMAGE_SYSTEM_MESSAGE,
    { role: 'user', type: 'media', content: imageBytes },
    { role: 'user', content: 'What animal is in this image? Answer in one word.' }
  ]

  const imageRun = await runAndCollect(model, history, {
    cacheKey: cachePath,
    saveCacheToDisk: true,
    generationParams: {
      reasoning_budget: 0,
      predict: 16,
      seed: 42,
      temp: 0,
      top_k: 1
    }
  })

  t.ok(imageRun.output.length > 0, `initial image turn produced output (${imageRun.output.length} chars)`)
  t.ok(/elephant/i.test(imageRun.output), `initial image turn mentions elephant: "${imageRun.output.slice(0, 120)}"`)
  t.ok(imageRun.stats.CacheTokens > 0, `image turn populated cache (${imageRun.stats.CacheTokens} tokens)`)
  t.ok(fs.existsSync(cachePath), 'image turn wrote cache file')
  t.ok(fs.statSync(cachePath).size > 0, 'image cache file is non-empty')

  history.push({ role: 'assistant', content: imageRun.output })

  let totalSlides = 0
  let lastStats = imageRun.stats

  for (let turn = 1; turn <= QWEN_MULTIMODAL_PREFILL_MAX_SLIDE_TURNS; turn++) {
    history.push({
      role: 'user',
      content: `Qwen multimodal prefill pressure turn ${turn}. Remember the image. ${QWEN_MULTIMODAL_PREFILL_PRESSURE}`
    })

    const turnResponse = await model.run([history[history.length - 1]], {
      cacheKey: cachePath,
      saveCacheToDisk: true,
      prefill: true
    })
    await turnResponse.await()

    const turnStats = normalizeStats(turnResponse.stats)
    totalSlides += turnStats.contextSlides
    lastStats = turnStats

    if (totalSlides > 0) {
      break
    }
  }

  t.ok(totalSlides > 0, `${options.label} session exercised prefill context sliding`)
  t.ok(lastStats.CacheTokens < 1024, `shifted cache stays within context (${lastStats.CacheTokens})`)
  t.ok(fs.statSync(cachePath).size > 0, 'shifted cache file remains non-empty')

  await model.unload()
  loaded = false

  model = createMultimodalModel(modelPath, projectionModelPath, options.extraConfig)
  await model.load()
  loaded = true

  const reloadRun = await runAndCollect(model, [
    { role: 'user', content: 'After loading the saved cache, what animal was in the image? Answer in one word.' }
  ], {
    cacheKey: cachePath,
    saveCacheToDisk: true,
    generationParams: {
      reasoning_budget: 0,
      predict: 24,
      seed: 42,
      temp: 0,
      top_k: 1
    }
  })

  t.ok(reloadRun.output.length > 0, `reload continuation produced output (${reloadRun.output.length} chars)`)
  t.ok(/elephant/i.test(reloadRun.output), `reload continuation remembers elephant: "${reloadRun.output.slice(0, 120)}"`)
  t.ok(reloadRun.stats.CacheTokens > 0, `reload used restored cache (${reloadRun.stats.CacheTokens} tokens)`)
}

async function runLlamaSlidingCacheCase (t, options = {}) {
  const modelInfo = options.modelInfo || LLAMA3_2_1B_MODEL
  const [modelName, dirPath] = await ensureModel({
    modelName: modelInfo.name,
    downloadUrl: modelInfo.url
  })

  const modelPath = path.join(dirPath, modelName)
  const cachePath = path.join(dirPath, options.cacheFileName)
  cleanupIntegrationCacheFiles(cachePath)

  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '99',
      ctx_size: '512',
      n_discarded: '128',
      temp: '0',
      seed: '42',
      verbosity: '2',
      ...options.extraConfig
    },
    logger: createLogger(),
    opts: { stats: true }
  })

  t.teardown(async () => {
    try { fs.unlinkSync(cachePath) } catch (_) {}
    await model.unload().catch(() => {})
  })

  await model.load()

  let totalSlides = 0
  let lastStats = null

  for (let turn = 1; turn <= LLAMA_PREFILL_MAX_SLIDE_TURNS; turn++) {
    const prefillResponse = await model.run([
      {
        role: 'user',
        content: `Prefill pressure turn ${turn}. ${LLAMA_PREFILL_PRESSURE}`
      }
    ], {
      cacheKey: cachePath,
      saveCacheToDisk: true,
      prefill: true
    })
    await prefillResponse.await()

    const prefillStats = normalizeStats(prefillResponse.stats)
    totalSlides += prefillStats.contextSlides
    lastStats = prefillStats

    if (turn === 1) {
      t.ok(prefillStats.CacheTokens > 0, `${options.label} seeded cache`)
    }

    if (totalSlides > 0) {
      break
    }
  }

  t.ok(totalSlides > 0, `${options.label} exercised prefill context sliding`)
  t.ok(lastStats.CacheTokens < 512, `${options.label} cache stays within context (${lastStats.CacheTokens})`)
}

safeTest('[qwen3.5-imrope-sliding-context] text prefill-slides tokens', {
  timeout: 900_000
}, async t => {
  await runQwenTextSlidingCacheCase(t)
})

safeTest('[qwen3.5-imrope-sliding-context] multimodal cache survives sliding save/load', {
  timeout: 1_800_000
}, async t => {
  await runMultimodalSlidingCacheCase(t, {
    label: 'multimodal',
    cacheFileName: 'qwen3-5-multimodal-sliding-cache.bin'
  })
})

safeTest('[qwen3.5-imrope-sliding-context] q8 K-cache shifts multimodal and text tokens', {
  timeout: 1_800_000,
  skip: isAndroid
}, async t => {
  await runMultimodalSlidingCacheCase(t, {
    label: 'q8 K-cache multimodal',
    cacheFileName: 'qwen3-5-q8-kcache-multimodal-sliding-cache.bin',
    extraConfig: {
      'cache-type-k': 'q8_0'
    }
  })
})

safeTest('[qwen3.5-imrope-sliding-context] tbq4 K-cache shifts multimodal and text tokens', {
  timeout: 1_800_000,
  skip: skipTbqPq
}, async t => {
  await runMultimodalSlidingCacheCase(t, {
    label: 'tbq4 K-cache multimodal',
    cacheFileName: 'qwen3-5-tbq4-kcache-multimodal-sliding-cache.bin',
    extraConfig: {
      'cache-type-k': 'tbq4_0'
    }
  })
})

safeTest('[qwen3.5-imrope-sliding-context] pq4 K-cache shifts multimodal and text tokens', {
  timeout: 1_800_000,
  skip: skipTbqPq
}, async t => {
  await runMultimodalSlidingCacheCase(t, {
    label: 'pq4 K-cache multimodal',
    cacheFileName: 'qwen3-5-pq4-kcache-multimodal-sliding-cache.bin',
    extraConfig: {
      'cache-type-k': 'pq4_0'
    }
  })
})

safeTest('[llama3.2-rope-sliding-context] 1B pq4 K-cache prefill-slides text tokens', {
  timeout: 900_000,
  skip: skipTbqPq
}, async t => {
  await runLlamaSlidingCacheCase(t, {
    label: 'llama3.2 pq4 K-cache prefill',
    cacheFileName: 'llama3-2-pq4-kcache-prefill-sliding-cache.bin',
    extraConfig: {
      'cache-type-k': 'pq4_0'
    }
  })
})

safeTest('[llama3.2-rope-sliding-context] 1B tbq4 K-cache prefill-slides text tokens', {
  timeout: 900_000,
  skip: skipTbqPq
}, async t => {
  await runLlamaSlidingCacheCase(t, {
    label: 'llama3.2 tbq4 K-cache prefill',
    cacheFileName: 'llama3-2-tbq4-kcache-prefill-sliding-cache.bin',
    extraConfig: {
      'cache-type-k': 'tbq4_0'
    }
  })
})

safeTest('[llama3.2-rope-sliding-context] 3B pq4 K-cache prefill-slides text tokens', {
  timeout: 900_000,
  skip: skipTbqPq
}, async t => {
  await runLlamaSlidingCacheCase(t, {
    modelInfo: LLAMA3_2_3B_MODEL,
    label: 'llama3.2 3B pq4 K-cache prefill',
    cacheFileName: 'llama3-2-3b-pq4-kcache-prefill-sliding-cache.bin',
    extraConfig: {
      'cache-type-k': 'pq4_0'
    }
  })
})

safeTest('[llama3.2-rope-sliding-context] 3B tbq4 K-cache prefill-slides text tokens', {
  timeout: 900_000,
  skip: skipTbqPq
}, async t => {
  await runLlamaSlidingCacheCase(t, {
    modelInfo: LLAMA3_2_3B_MODEL,
    label: 'llama3.2 3B tbq4 K-cache prefill',
    cacheFileName: 'llama3-2-3b-tbq4-kcache-prefill-sliding-cache.bin',
    extraConfig: {
      'cache-type-k': 'tbq4_0'
    }
  })
})
