'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const LlmLlamacpp = require('../index')
const { setLogger, releaseLogger } = require('../addonLogging')

const DEFAULT_GPU_LAYERS = 40
const DSML_TOOL_CALL_START = '<｜DSML｜tool_calls>'
const DSML_WEATHER_INVOKE = '<｜DSML｜invoke name="get_weather">'

async function main() {
  const firstShardArg = process.argv[2]
  const gpuLayers = Number(process.argv[3] || DEFAULT_GPU_LAYERS)

  if (!firstShardArg) {
    throw new Error('Usage: bare examples/deepseekV4ToolCalling.js <first-shard-path> [gpu-layers]')
  }
  if (!Number.isInteger(gpuLayers) || gpuLayers < 1) {
    throw new Error(`gpu-layers must be a positive integer, received: ${process.argv[3]}`)
  }

  installNativeLogger()

  const modelFiles = expandShardedModelFiles(path.resolve(firstShardArg))
  printModelFiles(modelFiles)

  const model = new LlmLlamacpp({
    files: { model: modelFiles },
    config: {
      device: 'gpu',
      gpu_layers: String(gpuLayers),
      ctx_size: '1024',
      predict: '64',
      temp: '0',
      reasoning_budget: '0',
      parallel: '1',
      tools: 'true',
      verbosity: '3'
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
        content: 'Call the provided tool when the user requests weather.'
      },
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: 'City name'
            }
          },
          required: ['city']
        }
      },
      {
        role: 'user',
        content: 'Call get_weather for Tokyo.'
      }
    ]

    console.log('▸ Running direct addon tool-call inference')
    const response = await model.run(prompt)
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
      fullResponse.includes(DSML_TOOL_CALL_START) && fullResponse.includes(DSML_WEATHER_INVOKE)

    console.log(`▸ Raw DSML tool call detected: ${hasDsmlCall ? 'yes' : 'no'}`)
    console.log(`▸ Inference stats: ${JSON.stringify(response.stats, null, 2)}`)

    if (!hasDsmlCall) {
      throw new Error('DeepSeek V4 did not emit the expected DSML get_weather tool call')
    }
  } finally {
    await model.unload().catch(() => {})
    releaseLogger()
  }
}

function installNativeLogger() {
  const priorityNames = {
    0: 'ERROR',
    1: 'WARN',
    2: 'INFO',
    3: 'DEBUG',
    4: 'DEBUG'
  }

  setLogger((priority, message) => {
    const timestamp = new Date().toISOString()
    const level = priorityNames[priority] || 'DEBUG'
    console.log(`[${timestamp}] [NATIVE ${level}] ${String(message).trimEnd()}`)
  })
}

function expandShardedModelFiles(firstShardPath) {
  const filename = path.basename(firstShardPath)
  const match = filename.match(/^(.+)-(\d{5})-of-(\d{5})\.gguf$/)
  if (!match) {
    throw new Error(`Expected a sharded GGUF path, received: ${firstShardPath}`)
  }

  const directory = path.dirname(firstShardPath)
  const baseFilename = match[1]
  const totalShards = Number(match[3])
  const totalLabel = String(totalShards).padStart(5, '0')
  const files = [path.join(directory, `${baseFilename}.tensors.txt`)]

  for (let index = 1; index <= totalShards; index++) {
    const shardLabel = String(index).padStart(5, '0')
    files.push(path.join(directory, `${baseFilename}-${shardLabel}-of-${totalLabel}.gguf`))
  }

  const missing = files.filter((file) => !fs.existsSync(file))
  if (missing.length > 0) {
    throw new Error(`Missing required model files:\n${missing.join('\n')}`)
  }

  return files
}

function printModelFiles(files) {
  let totalBytes = 0
  console.log('▸ Model files:')
  for (const file of files) {
    const bytes = fs.statSync(file).size
    totalBytes += bytes
    console.log(`▸   ${path.basename(file)} (${formatBytes(bytes)})`)
  }
  console.log(`▸ Total model size: ${formatBytes(totalBytes)}`)
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

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('✖', error)
    process.exit(1)
  })
