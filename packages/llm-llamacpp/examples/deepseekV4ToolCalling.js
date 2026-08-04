'use strict'

const path = require('bare-path')
const process = require('bare-process')
const LlmLlamacpp = require('../index')

const DEFAULT_GPU_LAYERS = 999
const DSML_TOOL_CALL_START = '<｜DSML｜tool_calls>'
const DSML_WEATHER_INVOKE = '<｜DSML｜invoke name="get_weather">'
const DSML_LOCAL_TIME_INVOKE = '<｜DSML｜invoke name="get_local_time">'

async function main() {
  const firstShardArg = process.argv[2]
  const gpuLayers = Number(process.argv[3] || DEFAULT_GPU_LAYERS)

  if (!firstShardArg) {
    throw new Error('Usage: bare examples/deepseekV4ToolCalling.js <first-shard-path> [gpu-layers]')
  }
  if (!Number.isInteger(gpuLayers) || gpuLayers < 1) {
    throw new Error(`gpu-layers must be a positive integer, received: ${process.argv[3]}`)
  }

  const firstShardPath = path.resolve(firstShardArg)

  const model = new LlmLlamacpp({
    files: {
      model: [firstShardPath]
    },
    config: {
      device: 'gpu',
      gpu_layers: String(gpuLayers),
      ctx_size: '2048',
      n_predict: '1024',
      seed: '50',
      temp: '0',
      top_p: '1',
      tools: 'true',
      verbosity: '2'
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log(`▸ Loading DeepSeek V4 with ${gpuLayers} GPU layers`)
    await withLoadHeartbeat('Addon model load', () => model.load())
    console.log('▸ Model loaded')

    const prompt = [
      {
        role: 'system',
        content:
          'You are a helpful assistant. Call every tool needed to satisfy the request. Do not answer directly when a tool can provide the requested information.'
      },
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: 'City name.'
            },
            country: {
              type: 'string',
              description: 'Country name.'
            }
          },
          required: ['city', 'country']
        }
      },
      {
        type: 'function',
        name: 'get_local_time',
        description: 'Get the current local time for a city.',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: 'City name.'
            },
            country: {
              type: 'string',
              description: 'Country name.'
            }
          },
          required: ['city', 'country']
        }
      },
      {
        role: 'user',
        content: 'Use both get_weather and get_local_time for Paris, France. Return the two tool calls.'
      }
    ]

    console.log('▸ Running direct addon tool-call inference')
    const response = await model.run(prompt, {
      generationParams: {
        remove_thinking_from_context: false
      }
    })
    let fullResponse = ''

    await response
      .onUpdate((data) => {
        process.stdout.write(data)
        fullResponse += data
      })
      .await()

    console.log('\n\n▸ Raw model output:')
    console.log(fullResponse || '(empty)')

    const hasDsmlCall =
      fullResponse.includes(DSML_TOOL_CALL_START) &&
      fullResponse.includes(DSML_WEATHER_INVOKE) &&
      fullResponse.includes(DSML_LOCAL_TIME_INVOKE)

    const summary = {
      device: 'gpu',
      gpuLayers,
      noMmap: false,
      hasOpen: fullResponse.includes('<think>'),
      hasClose: fullResponse.includes('</think>'),
      thinkingBlockDiscards: Number(response.stats.thinkingBlockDiscards || 0),
      stopReason: response.stats.stopReason,
      responseLength: fullResponse.length,
      hasDsmlCall
    }

    console.log(`▸ Raw DSML tool call detected: ${hasDsmlCall ? 'yes' : 'no'}`)
    console.log(`▸ Inference stats: ${JSON.stringify(response.stats, null, 2)}`)
    console.log(`▸ DS4 GPU test summary: ${JSON.stringify(summary)}`)

    if (!hasDsmlCall) {
      throw new Error('DeepSeek V4 did not emit both expected DSML tool calls')
    }
  } finally {
    await model.unload().catch(() => {})
  }
}

async function withLoadHeartbeat(label, load) {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
    console.log(`▸ ${label} still running (${elapsedSeconds}s elapsed)`)
  }, 10_000)

  try {
    await load()
  } finally {
    clearInterval(timer)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('✖', error)
    process.exit(1)
  })
