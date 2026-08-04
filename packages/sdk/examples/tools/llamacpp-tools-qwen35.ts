/**
 * Tool-calling example using the Qwen3.5 dialect.
 *
 * Qwen3.5 emits tool calls in a Pythonic-XML format:
 *   <tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>
 *
 * The dialect is auto-detected from the model name/path when the model file
 * contains "qwen3.5", "qwen3-5", "qwen3.6", or "qwen3-6". Pass
 * toolDialect: "qwen35" explicitly if auto-detection does not pick it up.
 *
 * Usage:
 *   QVAC_CONFIG_PATH=examples/tools/debug-logging.config.json \
 *     bun run bare:example dist/examples/tools/llamacpp-tools-qwen35.js <model-url>
 */
import {
  completion,
  loadModel,
  subscribeServerLogs,
  unloadModel,
  QWEN3_5_0_8B_MULTIMODAL_Q8_0,
  VERBOSITY,
  type ModelProgressUpdate,
  type ToolCall
} from '@qvac/sdk'
import { tools, mockExecute } from './shared'

const modelSrc = process.argv[2] ?? QWEN3_5_0_8B_MULTIMODAL_Q8_0

let modelId: string | undefined
let stopServerLogs: (() => void) | undefined
try {
  console.log('▸ Enabling SDK and native addon logs')
  stopServerLogs = subscribeServerLogs((log) => {
    const timestamp = new Date(log.timestamp).toISOString()
    console.log(`[${timestamp}] [${log.level.toUpperCase()}] [${log.namespace}] ${log.message}`)
  })

  console.log('▸ Loading model')
  const stopLoadHeartbeat = startLoadHeartbeat('SDK model load')
  try {
    modelId = await loadModel({
      modelSrc,
      modelType: 'llamacpp-completion',
      modelConfig: {
        ctx_size: 4096,
        tools: true,
        verbosity: VERBOSITY.DEBUG
      },
      onProgress: reportLoadProgress
    })
  } finally {
    stopLoadHeartbeat()
  }
  console.log(`▸ Model loaded: ${modelId}`)

  const history = [
    {
      role: 'system',
      content: 'You are a helpful assistant that can call tools to look up weather and horoscopes.'
    },
    {
      role: 'user',
      content: "What's the weather in Tokyo and my horoscope for Aquarius?"
    }
  ]

  const result = completion({ modelId, history, stream: true, tools })

  const tokensTask = (async () => {
    for await (const token of result.tokenStream) {
      process.stdout.write(token)
    }
  })()

  const toolsTask = (async () => {
    for await (const evt of result.toolCallStream) {
      if (evt.type === 'toolCall') {
        console.log(`\n▸ ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`)
      }
    }
  })()

  await Promise.all([tokensTask, toolsTask])

  const toolCalls: ToolCall[] = await result.toolCalls

  console.log('\n\n▸ Final tool calls:')
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      console.log(`▸ ${call.name}(${JSON.stringify(call.arguments)})`)
      const toolResult = mockExecute(call.name, call.arguments)
      console.log(`▸ result: ${toolResult}`)
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
