/**
 * DeepSeek V4 tool-calling compatibility test with reduced VRAM usage.
 *
 * Partial GPU offload avoids the full-model VRAM pressure of the SDK defaults.
 * The small context, single tool, and short generation limit further reduce
 * memory usage.
 *
 * Usage:
 *   npm run bare:example -- dist/examples/tools/llamacpp-tools-deepseek-v4-low-vram.js [model-url-or-path] [gpu-layers]
 */
import { completion, loadModel, unloadModel, type CompletionEvent, type ToolInput } from '@qvac/sdk'
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
try {
  if (!Number.isInteger(gpuLayers) || gpuLayers < 1) {
    throw new Error(`gpu-layers must be a positive integer, received: ${process.argv[3]}`)
  }

  console.log(`▸ Loading DeepSeek V4 with ${gpuLayers} GPU layers`)
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
      tools: true
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })
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
    tools
  })

  for await (const event of run.events) {
    handleEvent(event)
  }

  const final = await run.final

  console.log('\n\n▸ Raw model output:')
  console.log(final.raw.fullText || '(empty)')

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
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  if (modelId) await unloadModel({ modelId, clearStorage: false }).catch(() => {})
  process.exit(1)
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
