/**
 * DeepSeek V4 tool-calling compatibility test with reduced VRAM usage.
 *
 * Partial GPU offload avoids the full-model VRAM pressure of the SDK defaults.
 * The small context, single tool, and short generation limit further reduce
 * memory usage.
 *
 * Usage:
 *   QVAC_CONFIG_PATH=examples/tools/debug-logging.config.json \
 *     npm run bare:example -- dist/examples/tools/llamacpp-tools-deepseek-v4-low-vram.js [model-url-or-path] [gpu-layers]
 */
import {
  completion,
  loadModel,
  subscribeServerLogs,
  unloadModel,
  VERBOSITY,
  type CompletionEvent,
  type ModelProgressUpdate,
  type ToolInput
} from '@qvac/sdk'
import { weatherSchema, mockExecute } from './shared'

const DEEPSEEK_V4_UD_IQ2_M =
  'https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF/resolve/109848da2469efe1f1aab9e11acea08a065ccd4f/UD-IQ2_M/DeepSeek-V4-Flash-0731-UD-IQ2_M-00001-of-00003.gguf'
const DEFAULT_GPU_LAYERS = 40

const modelSrc = process.argv[2] ?? DEEPSEEK_V4_UD_IQ2_M
const gpuLayers = Number(process.argv[3] ?? DEFAULT_GPU_LAYERS)
const tools: ToolInput[] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: weatherSchema
  }
]

let modelId: string | undefined
let stopServerLogs: (() => void) | undefined
try {
  if (!Number.isInteger(gpuLayers) || gpuLayers < 1) {
    throw new Error(`gpu-layers must be a positive integer, received: ${process.argv[3]}`)
  }

  console.log('▸ Enabling SDK and native addon logs')
  stopServerLogs = subscribeServerLogs((log) => {
    const timestamp = new Date(log.timestamp).toISOString()
    console.log(`[${timestamp}] [${log.level.toUpperCase()}] [${log.namespace}] ${log.message}`)
  })

  console.log(`▸ Loading DeepSeek V4 with ${gpuLayers} GPU layers`)
  const stopLoadHeartbeat = startLoadHeartbeat('SDK model load')
  try {
    modelId = await loadModel({
      modelSrc,
      modelType: 'llamacpp-completion',
      modelConfig: {
        device: 'gpu',
        gpu_layers: gpuLayers,
        ctx_size: 1024,
        predict: 64,
        temp: 0,
        reasoning_budget: 0,
        parallel: 1,
        tools: true,
        verbosity: VERBOSITY.DEBUG
      },
      onProgress: reportLoadProgress
    })
  } finally {
    stopLoadHeartbeat()
  }
  console.log(`▸ Model loaded: ${modelId}`)

  const run = completion({
    modelId,
    history: [
      {
        role: 'system',
        content: 'Call the provided tool when the user requests weather.'
      },
      {
        role: 'user',
        content: 'Call get_weather for Tokyo.'
      }
    ],
    stream: true,
    tools,
    generationParams: {
      remove_thinking_from_context: false
    }
  })

  for await (const event of run.events) {
    handleEvent(event)
  }

  const final = await run.final

  console.log('\n\n▸ Raw model output:')
  console.log(final.raw.fullText || '(empty)')
  console.log(
    `▸ Raw DSML tool call detected: ${final.raw.fullText.includes('<｜DSML｜tool_calls>') ? 'yes' : 'no'}`
  )

  console.log('\n▸ Parsed tool calls:')
  if (final.toolCalls.length > 0) {
    for (const call of final.toolCalls) {
      console.log(`▸ ${call.name}(${JSON.stringify(call.arguments)})`)
      console.log(`▸ result: ${mockExecute(call.name, call.arguments)}`)
    }
  } else {
    console.log('▸ (none)')
  }

  await unloadModel({ modelId, clearStorage: false })
  stopServerLogs()
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  if (modelId) await unloadModel({ modelId, clearStorage: false }).catch(() => {})
  stopServerLogs?.()
  process.exit(1)
}

function reportLoadProgress(progress: ModelProgressUpdate) {
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
  if (progress.shardInfo) {
    const shard = progress.shardInfo
    console.log(
      `▸ Downloading shard ${shard.currentShard}/${shard.totalShards}: ` +
        `${progress.percentage.toFixed(1)}% (${mb(progress.downloaded)}/${mb(progress.total)} MiB), ` +
        `overall ${shard.overallPercentage.toFixed(1)}% (${mb(shard.overallDownloaded)}/${mb(shard.overallTotal)} MiB)`
    )
    return
  }

  console.log(
    `▸ Downloading: ${progress.percentage.toFixed(1)}% ` +
      `(${mb(progress.downloaded)}/${mb(progress.total)} MiB)`
  )
}

function startLoadHeartbeat(label: string) {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
    console.log(`▸ ${label} still running (${elapsedSeconds}s elapsed)`)
  }, 10_000)

  return () => clearInterval(timer)
}

function handleEvent(event: CompletionEvent) {
  if (event.type === 'contentDelta') {
    process.stdout.write(event.text)
  } else if (event.type === 'thinkingDelta') {
    process.stdout.write(event.text)
  } else if (event.type === 'toolCall') {
    console.log(`\n▸ Tool call: ${event.call.name}(${JSON.stringify(event.call.arguments)})`)
  } else if (event.type === 'toolError') {
    console.log(`\n✖ Tool error [${event.error.code}]: ${event.error.message}`)
  }
}
