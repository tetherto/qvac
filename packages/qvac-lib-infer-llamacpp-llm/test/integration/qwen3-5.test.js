'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath } = require('./utils')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64
// Apple Silicon Metal is fine for vision on M2/M3/M4. The addon detects M1
// specifically and routes vision-with-projector to CPU on that chip; we don't
// need a blanket Darwin carve-out here. Mobile GPU backends still need the
// CPU-fallback at this layer.
const useCpuForVision = useCpu

const QWEN3_5_MODEL = {
  name: 'Qwen3.5-0.8B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}

const QWEN3_5_PROJ_MODEL = {
  name: 'mmproj-Qwen3.5-0.8B-F16.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf'
}

const BASE_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is 2+2? Answer in one word.' }
]

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

async function collectResponse (response) {
  const chunks = []
  const ticker = setInterval(() => {}, 50)
  try {
    await response.onUpdate(data => { chunks.push(data) }).await()
  } finally {
    clearInterval(ticker)
  }
  return chunks.join('').trim()
}

function parseJsonToolCall (inner) {
  try {
    return JSON.parse(inner)
  } catch (e) {
    return null
  }
}

// Parses HuggingFace function-call XML emitted by Qwen3.5's embedded template:
//   <function=NAME>
//     <parameter=KEY>VALUE</parameter>
//     ...
//   </function>
function parseXmlToolCall (inner) {
  const fnMatch = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/.exec(inner)
  if (!fnMatch) return null
  const args = {}
  const paramRegex = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g
  let pm
  while ((pm = paramRegex.exec(fnMatch[2])) !== null) {
    args[pm[1].trim()] = pm[2].trim()
  }
  return { name: fnMatch[1].trim(), arguments: args }
}

function extractToolCalls (response) {
  const toolCalls = []
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match
  while ((match = toolCallRegex.exec(response)) !== null) {
    const inner = match[1].trim()
    const parsed = parseJsonToolCall(inner) || parseXmlToolCall(inner)
    if (parsed) toolCalls.push(parsed)
  }
  return toolCalls
}

test('Qwen3.5-0.8B can run basic inference', {
  timeout: 600_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '256',
    temp: '0',
    seed: '42',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: createLogger(),
    opts: { stats: true }
  })

  try {
    const t0 = Date.now()
    await addon.load()
    console.log(`  model.load() took ${Date.now() - t0} ms`)

    const response = await addon.run(BASE_PROMPT)
    const output = await collectResponse(response)

    t.ok(output.length > 0, `inference produced output (${output.length} chars)`)
    console.log(`  output: "${output.slice(0, 200)}"`)
    const lowerOutput = output.toLowerCase()
    t.ok(/4|four/.test(lowerOutput), `output contains 4 or four: "${output.slice(0, 100)}"`)

    t.ok(response.stats, 'response has stats')
    if (response.stats) {
      t.ok(response.stats.promptTokens > 0, `prompt tokens: ${response.stats.promptTokens}`)
      t.ok(response.stats.generatedTokens > 0, `generated tokens: ${response.stats.generatedTokens}`)
    }
  } finally {
    await addon.unload().catch(() => {})
  }
})

test('Qwen3.5-0.8B supports multi-turn conversation with KV cache', {
  timeout: 600_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
    n_predict: '512',
    temp: '0',
    seed: '42',
    verbosity: '2'
  }

  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: createLogger(),
    opts: { stats: true }
  })

  try {
    await addon.load()

    const sessionName = path.join(dirPath, 'qwen3-5-multiturn-cache.bin')
    const systemMsg = { role: 'system', content: 'You are a helpful assistant. Answer concisely with just the city name.' }
    const userTurn1 = { role: 'user', content: 'What is the capital of France?' }

    const prompt1 = [
      { role: 'session', content: sessionName },
      systemMsg,
      userTurn1
    ]
    const response1 = await addon.run(prompt1)
    const output1 = await collectResponse(response1)
    t.ok(output1.length > 0, `first turn produced output (${output1.length} chars)`)
    const lowerOutput1 = output1.toLowerCase()
    t.ok(/paris/.test(lowerOutput1), `first turn mentions Paris: "${output1.slice(0, 100)}"`)

    const prompt2 = [
      { role: 'session', content: sessionName },
      systemMsg,
      userTurn1,
      { role: 'assistant', content: output1 },
      { role: 'user', content: 'And what about Germany?' }
    ]
    const response2 = await addon.run(prompt2)
    const output2 = await collectResponse(response2)
    t.ok(output2.length > 0, `second turn produced output (${output2.length} chars)`)
    const lowerOutput2 = output2.toLowerCase()
    t.ok(/berlin/.test(lowerOutput2), `second turn mentions Berlin: "${output2.slice(0, 100)}"`)
    t.ok(output2 !== output1, 'second turn produced different output from first')
  } finally {
    await addon.unload().catch(() => {})
  }
})

test('Qwen3.5-0.8B supports tool calling', {
  timeout: 600_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    n_predict: '512',
    temp: '0.1',
    seed: '42',
    verbosity: '2',
    tools: 'true'
  }

  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: createLogger(),
    opts: { stats: true }
  })

  try {
    await addon.load()

    const prompt = [
      { role: 'system', content: 'You are a helpful assistant that uses tools when appropriate.' },
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'Name of the city' },
            unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature unit' }
          },
          required: ['city']
        }
      },
      { role: 'user', content: 'What is the weather in Paris in celsius?' }
    ]

    const response = await addon.run(prompt)
    const output = await collectResponse(response)

    t.ok(output.length > 0, `tool calling produced output (${output.length} chars)`)
    console.log(`  output: "${output.slice(0, 300)}"`)

    const toolCalls = extractToolCalls(output)
    t.ok(toolCalls.length > 0, `extracted at least one tool call (got ${toolCalls.length})`)

    const weatherCall = toolCalls.find(tc => tc.name === 'get_weather')
    t.ok(weatherCall, 'model called get_weather tool')
    t.ok(weatherCall?.arguments, 'tool call has arguments')
    const city = weatherCall?.arguments?.city?.toLowerCase() || ''
    t.ok(/paris/.test(city), `tool call city argument mentions Paris: "${city}"`)
  } finally {
    await addon.unload().catch(() => {})
  }
})

test('Qwen3.5-0.8B can describe an image', {
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })
  const [projModelName] = await ensureModel({
    modelName: QWEN3_5_PROJ_MODEL.name,
    downloadUrl: QWEN3_5_PROJ_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)
  const projectionModelPath = path.join(dirPath, projModelName)

  const config = {
    device: useCpuForVision ? 'cpu' : 'gpu',
    gpu_layers: '98',
    ctx_size: '4096',
    temp: '0',
    seed: '42',
    verbosity: '2'
  }

  const inference = new LlmLlamacpp({
    files: { model: [modelPath], projectionModel: projectionModelPath },
    config,
    logger: createLogger()
  })

  try {
    const t0 = Date.now()
    await inference.load()
    console.log(`  model.load() took ${Date.now() - t0} ms`)

    const imageFilePath = getMediaPath('elephant.jpg')
    t.ok(fs.existsSync(imageFilePath), 'elephant.jpg image file should exist')

    const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))
    const messages = [
      { role: 'user', type: 'media', content: imageBytes },
      { role: 'user', content: 'What animal is in this image? Answer in one word.' }
    ]

    const response = await inference.run(messages)
    const generatedText = []
    let error = null

    response.onUpdate(data => { generatedText.push(data) })
      .onError(err => { error = err })

    await response.await()

    if (error) {
      throw new Error('Inference error: ' + error)
    }

    const output = generatedText.join('')
    t.ok(output.length > 0, `image inference produced output (${output.length} chars)`)
    console.log(`  output: "${output.slice(0, 200)}"`)

    const lowerOutput = output.toLowerCase()
    t.ok(/elephant/.test(lowerOutput), `output mentions elephant: "${output.slice(0, 100)}"`)
  } finally {
    await inference.unload().catch(() => {})
  }
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
