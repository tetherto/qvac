'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isWindowsX64 = platform === 'win32' && arch === 'x64'
const useCpu = isDarwinX64 || isLinuxArm64
const skip = isWindowsX64 || isLinuxArm64

const QWEN3_5_MODEL = {
  name: 'Qwen3.5-0.8B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}

const SYSTEM_MESSAGE = {
  role: 'system',
  content: 'You are a helpful assistant. Keep answers short. Use the get_weather tool when asked about weather.'
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

async function primeSystemCache (model, cachePath) {
  const response = await model.run([SYSTEM_MESSAGE], {
    cacheKey: cachePath,
    saveCacheToDisk: true,
    prefill: true
  })
  await response.await()
}

for (const scenario of SCENARIOS) {
  safeTest(`[qwen3.5-sliding-context] case ${scenario.caseId}: ${scenario.label}`, {
    timeout: 900_000,
    skip
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
