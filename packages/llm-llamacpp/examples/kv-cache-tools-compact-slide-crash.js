'use strict'

/**
 * Repro: tools_compact context-slide aborts on multi-position-embedding models.
 *
 * Native crash observed when the dynamic-tools ("tools_compact") context slider
 * tries to slide the KV window during prefill on a multimodal / M-RoPE model
 * where n_pos_per_embd() > 1.
 *
 *   llama-kv-cache.cpp:403: GGML_ASSERT(
 *     hparams.n_pos_per_embd() == 1 &&
 *     "seq_add() is only supported for n_pos_per_embd() == 1") failed
 *
 * Trigger chain:
 *   multimodal model (n_pos_per_embd > 1)
 *     + tools_compact: "true"
 *     + n_discarded set
 *     + a prefill that pushes the context past ctx_size
 *   -> addon attempts a window slide -> seq_add unsupported -> GGML_ABORT.
 *
 * CASE | model                              | tools_compact | tools | expected
 * -----+------------------------------------+---------------+-------+----------------
 *  1   | Qwen3-VL-2B multimodal (M-RoPE)     | true          | yes   | CRASH (the bug)
 *  2   | Qwen3-1.7B text-only (n_pos == 1)  | true          | yes   | slides OK/error
 *  3   | Qwen3-VL-2B multimodal (M-RoPE)     | false         | yes   | isolates compact
 *  4   | Qwen3-VL-2B multimodal (M-RoPE)     | true          | no    | any-slide check
 *
 * Run from packages/llm-llamacpp:
 *   bare examples/kv-cache-tools-compact-slide-crash.js
 *   CASE=2 bare examples/kv-cache-tools-compact-slide-crash.js
 */

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const LlmLlamacpp = require('../index')
const { downloadModel } = require('./utils')
const { setLogger, releaseLogger } = require('../addonLogging')

const CASE = Number(process.env.CASE || '1')
const TURN_FILLER = 'Please keep replying briefly.'
const MAX_TURNS = 40

const MODELS = {
  qwen3VL: {
    name: 'SMOLVLM2_500M_VIDEO_INST_Q8_0',
    filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  },
  qwen317b: {
    name: 'QWEN3_1_7B_INST_Q4',
    filename: 'Qwen3-1.7B-Q4_0.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_0.gguf'
  }
}

const SCENARIOS = {
  1: {
    label: 'multimodal + dynamic/tools_compact + tools (the bug)',
    model: MODELS.qwen3VL,
    toolsCompact: true,
    withTools: true,
    expectation: 'GGML_ASSERT abort during prefill (process dies)'
  },
  2: {
    label: 'text-only (n_pos == 1) + dynamic/tools_compact + tools',
    model: MODELS.qwen317b,
    toolsCompact: true,
    withTools: true,
    expectation: 'slides OK or throws a catchable ContextOverflow error'
  },
  3: {
    label: 'multimodal + static tools',
    model: MODELS.qwen3VL,
    toolsCompact: false,
    withTools: true,
    expectation: 'if no crash, crash is specific to tools_compact'
  },
  4: {
    label: 'multimodal + dynamic/tools_compact + NO tools',
    model: MODELS.qwen3VL,
    toolsCompact: true,
    withTools: false,
    expectation: 'tells whether any multi-pos slide crashes vs tools_compact only'
  }
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

const SYSTEM_MESSAGE = {
  role: 'system',
  content: 'You are a helpful assistant. Keep answers short. Use the get_weather tool when asked about weather.'
}

function describeError (error) {
  if (error && typeof error === 'object') {
    const detail = error.message || JSON.stringify(error)
    return `${error.name || 'Error'} (code=${String(error.code)}): ${detail}`
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

function extractToolCalls (output) {
  const toolCalls = []
  const jsonToolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match

  while ((match = jsonToolCallRegex.exec(output)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      toolCalls.push({
        name: parsed.name || parsed.function?.name || 'unknown',
        arguments: parsed.arguments || parsed.function?.arguments || {}
      })
    } catch (_) {}
  }

  const qwen35ToolCallRegex = /<function=([A-Za-z0-9_]+)>([\s\S]*?)<\/function>/g
  while ((match = qwen35ToolCallRegex.exec(output)) !== null) {
    let args = {}
    try {
      args = JSON.parse(match[2].trim())
    } catch (_) {}
    toolCalls.push({ name: match[1], arguments: args })
  }

  return toolCalls
}

async function primeCache (model, cachePath, scenario) {
  const primeMessages = [SYSTEM_MESSAGE]
  if (scenario.withTools && !scenario.toolsCompact) {
    primeMessages.push(TOOL_WEATHER)
  }

  const response = await model.run(primeMessages, {
    cacheKey: cachePath,
    saveCacheToDisk: true,
    prefill: true
  })
  await response.await()
}

function selectMessagesForTurn (history, scenario, savedCount) {
  const addTools = scenario.withTools ? [TOOL_WEATHER] : []
  const dynamicTools = scenario.withTools && scenario.toolsCompact

  if (dynamicTools) {
    const lastMsg = history[history.length - 1]
    if (!lastMsg) return addTools

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
      return [...tail, ...addTools]
    }

    return [lastMsg, ...addTools]
  }

  if (savedCount === null) {
    return history.filter(msg => msg.role !== 'system')
  }

  return history.slice(savedCount)
}

async function runAndCollect (model, messages, cachePath) {
  const response = await model.run(messages, {
    cacheKey: cachePath,
    saveCacheToDisk: true,
    generationParams: {
      temp: 0,
      top_k: 1,
      seed: 42,
      predict: 12
    }
  })
  const chunks = []

  await response
    .onUpdate(data => { chunks.push(data) })
    .await()

  return { output: chunks.join(''), stats: response.stats || {} }
}

async function main () {
  const scenario = SCENARIOS[CASE]
  if (!scenario) {
    console.error(`Unknown CASE=${CASE}. Use CASE=1..4.`)
    process.exit(1)
  }

  setLogger((priority, message) => {
    const priorityNames = {
      0: 'ERROR',
      1: 'WARNING',
      2: 'INFO',
      3: 'DEBUG'
    }

    const priorityName = priorityNames[priority] || 'UNKNOWN'
    const timestamp = new Date().toISOString()

    console.log(`[${timestamp}] [C++ TEST] [${priorityName}]: ${message}`)
  })

  console.log('tools_compact slide crash repro')
  console.log(`   CASE=${CASE}: ${scenario.label}`)
  console.log(`   model:         ${scenario.model.name}`)
  console.log(`   tools_compact: ${scenario.toolsCompact ? 'true' : 'false'}`)
  console.log(`   tools:         ${scenario.withTools ? 'yes' : 'no'}`)
  console.log(`   expecting:     ${scenario.expectation}`)
  console.log('')

  const [modelName, dirPath] = await downloadModel(scenario.model.url, scenario.model.filename)
  const modelPath = path.join(dirPath, modelName)
  const cachePath = path.join(dirPath, `tools-compact-slide-crash-case-${CASE}.bin`)
  try { fs.unlinkSync(cachePath) } catch (_) {}

  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '512',
    n_discarded: '256',
    tools: scenario.withTools ? 'true' : 'false',
    tools_compact: scenario.toolsCompact ? 'true' : 'false',
    verbosity: '3'
  }

  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })

  let loaded = false
  try {
    await model.load()
    loaded = true
    console.log(`Model loaded from ${modelPath}`)
    console.log(`Cache file: ${cachePath}`)

    await primeCache(model, cachePath, scenario)
    console.log('Primed system prompt cache')

    const history = [SYSTEM_MESSAGE]
    let savedCount = null

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      history.push({
        role: 'user',
        content: `Turn ${turn}: weather in Tokyo? ${TURN_FILLER}`
      })

      const preRunHistoryLength = history.length
      const messagesToSend = selectMessagesForTurn(history, scenario, savedCount)
      console.log(`\nTurn ${turn} (messages sent=${messagesToSend.length}, cached prefix growing toward ctx=512) ...`)

      const { output, stats } = await runAndCollect(model, messagesToSend, cachePath)
      const toolCalls = extractToolCalls(output)
      const textPreview = output.slice(0, 60).replace(/\n/g, ' ')
      const cacheTokens = stats.CacheTokens ?? stats.cacheTokens ?? '?'

      console.log(
        `   ok - cacheTokens=${cacheTokens}, ` +
        `contextSlides=${stats.contextSlides ?? '?'}, ` +
        `toolCalls=${toolCalls.length}, text="${textPreview}"`
      )

      savedCount = preRunHistoryLength + 1
      history.push({ role: 'assistant', content: output })

      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          const city = call.arguments?.city || 'Tokyo'
          history.push({
            role: 'tool',
            content: `The weather in ${city} is rainy, 8C.`
          })
        }
      }
    }

    console.log('')
    console.log(`Completed all ${MAX_TURNS} turns WITHOUT crashing.`)
    console.log(`No GGML_ASSERT for CASE=${CASE}. The slide may not have triggered at this sizing, or the addon build has the fix.`)
  } catch (error) {
    console.error(`\nCaught a JS error (catchable): ${describeError(error)}`)
    process.exitCode = 1
  } finally {
    try { fs.unlinkSync(cachePath) } catch (_) {}
    if (loaded) {
      await model.unload().catch(() => {})
    }
  }
}

main().catch(error => {
  console.error('Fatal error in main function:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  })
  process.exit(1)
})
