'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath, safeTest } = require('./utils')

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

const SYSTEM_MESSAGE = {
  role: 'system',
  content: 'You are a helpful assistant. Keep answers short. Use the get_weather tool when asked about weather.'
}

const IMAGE_SYSTEM_MESSAGE = {
  role: 'system',
  content: 'You are a helpful assistant. Keep answers concise.'
}

const TOOL_WEATHER = {
  type: 'function',
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' }
    },
    required: ['city']
  }
}

const SCENARIOS = [
  {
    caseId: 1,
    label: 'dynamic tools_compact with tools',
    tools: true,
    toolsCompact: true,
    withTools: true
  },
  {
    caseId: 2,
    label: 'static tools without tools_compact',
    tools: true,
    toolsCompact: false,
    withTools: true
  },
  {
    caseId: 3,
    label: 'tools_compact enabled without tools',
    tools: false,
    toolsCompact: true,
    withTools: false,
    turnFiller: `${'Add enough context pressure to force cache sliding without tool tokens. '.repeat(18)}Please keep replying briefly.`
  }
]

const MULTIMODAL_TURN_FILLER = 'Add context pressure for cache sliding while keeping the answer short. '.repeat(44)
const MULTIMODAL_MAX_SLIDE_TURNS = 6

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

function selectMessagesForTurn (history, scenario, savedCount) {
  const tools = scenario.withTools ? [TOOL_WEATHER] : []
  const dynamicTools = scenario.withTools && scenario.toolsCompact

  if (dynamicTools) {
    const lastMsg = history[history.length - 1]
    if (!lastMsg) return tools

    if (lastMsg.role === 'tool') {
      const trailingTools = []
      for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i]
        if (msg.role !== 'tool') break
        trailingTools.unshift(msg)
      }
      return trailingTools
    }

    if (lastMsg.role === 'user') {
      const prevMsg = history[history.length - 2]
      const tail = prevMsg?.role === 'assistant' ? [prevMsg, lastMsg] : [lastMsg]
      return [...tail, ...tools]
    }

    return [lastMsg, ...tools]
  }

  if (savedCount === null) {
    return [...history.filter(msg => msg.role !== 'system'), ...tools]
  }

  return [...history.slice(savedCount), ...tools]
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

async function setupModel (t, scenario) {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })

  const modelPath = path.join(dirPath, modelName)
  const cachePath = path.join(
    dirPath,
    `qwen35-sliding-context-case-${scenario.caseId}.bin`
  )
  try { fs.unlinkSync(cachePath) } catch (_) {}

  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '999',
      ctx_size: '512',
      n_discarded: '256',
      tools: scenario.tools ? 'true' : 'false',
      tools_compact: scenario.toolsCompact ? 'true' : 'false',
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

  return { model, cachePath }
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
  try { fs.unlinkSync(cachePath) } catch (_) {}

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

  for (let turn = 1; turn <= MULTIMODAL_MAX_SLIDE_TURNS; turn++) {
    history.push({
      role: 'user',
      content: `Turn ${turn}: remember the image and answer "ok". ${MULTIMODAL_TURN_FILLER}`
    })

    const turnRun = await runAndCollect(model, [history[history.length - 1]], {
      cacheKey: cachePath,
      saveCacheToDisk: true,
      generationParams: {
        reasoning_budget: 0,
        predict: 8,
        seed: 42,
        temp: 0,
        top_k: 1
      }
    })

    t.ok(turnRun.output.length > 0, `sliding turn ${turn} produced output`)
    totalSlides += turnRun.stats.contextSlides
    lastStats = turnRun.stats
    history.push({ role: 'assistant', content: turnRun.output })

    if (totalSlides > 0) {
      break
    }
  }

  t.ok(totalSlides > 0, `${options.label} session exercised context sliding`)
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

for (const scenario of SCENARIOS) {
  safeTest(`[qwen3.5-sliding-context] case ${scenario.caseId}: ${scenario.label}`, {
    timeout: 900_000
  }, async t => {
    const { model, cachePath } = await setupModel(t, scenario)
    await primeSystemCache(model, cachePath)

    const history = [SYSTEM_MESSAGE]
    let savedCount = null
    let totalSlides = 0
    let lastStats = null

    for (let turn = 1; turn <= 8; turn++) {
      const turnFiller = scenario.turnFiller || 'Please keep replying briefly.'

      history.push({
        role: 'user',
        content: `Turn ${turn}: weather in Tokyo? ${turnFiller}`
      })

      const preRunHistoryLength = history.length
      const messagesToSend = selectMessagesForTurn(history, scenario, savedCount)
      const { output, stats } = await runAndCollect(
        model,
        messagesToSend,
        {
          cacheKey: cachePath,
          saveCacheToDisk: true,
          generationParams: {
            predict: 12,
            seed: 42,
            temp: 0,
            top_k: 1
          }
        }
      )

      t.ok(output.length > 0, `case ${scenario.caseId} turn ${turn} produces output`)
      totalSlides += stats.contextSlides
      lastStats = stats

      savedCount = preRunHistoryLength + 1
      history.push({ role: 'assistant', content: output })

      if (totalSlides > 0 && turn >= 5) {
        break
      }
    }

    t.ok(totalSlides > 0, `case ${scenario.caseId} exercises M-RoPE K-shift sliding`)
    t.ok(
      lastStats.CacheTokens < 512,
      `case ${scenario.caseId} cache stays within context (${lastStats.CacheTokens})`
    )
  })
}

safeTest('[qwen3.5-sliding-context] multimodal cache survives sliding save/load', {
  timeout: 1_800_000
}, async t => {
  await runMultimodalSlidingCacheCase(t, {
    label: 'multimodal',
    cacheFileName: 'qwen3-5-multimodal-sliding-cache.bin'
  })
})

safeTest('[qwen3.5-sliding-context] q8 K-cache shifts multimodal and text tokens', {
  timeout: 1_800_000
}, async t => {
  await runMultimodalSlidingCacheCase(t, {
    label: 'q8 K-cache multimodal',
    cacheFileName: 'qwen3-5-q8-kcache-multimodal-sliding-cache.bin',
    extraConfig: {
      'cache-type-k': 'q8_0'
    }
  })
})

safeTest('[qwen3.5-sliding-context] tbq4 K-cache shifts multimodal and text tokens', {
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

safeTest('[qwen3.5-sliding-context] pq4 K-cache shifts multimodal and text tokens', {
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
