'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath } = require('./utils')
const os = require('bare-os')
const process = require('bare-process')
// QVAC-18298: emit a Qwen3.5-VL perf row into the weekly perf-report aggregate.
const { recordPerformance } = require('./_perf-helper.js')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'

// QVAC-18298: same QVAC_PERF_RUNS / QVAC_PERF_WARMUP_RUNS knobs as the
// image-*.test.js perf rows. Default 1+1 on PRs; benchmark dispatch bumps to 3.
function _envInt (key, fallback) {
  let raw = ''
  if (typeof os.getEnv === 'function') raw = os.getEnv(key) || ''
  if (!raw && typeof process !== 'undefined' && process.env) raw = process.env[key] || ''
  const v = parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}
const PERF_RUNS = _envInt('QVAC_PERF_RUNS', 1)
const PERF_WARMUP_RUNS = _envInt('QVAC_PERF_WARMUP_RUNS', 1)
// Desktop x64-darwin and linux-arm64 hosts have no working GPU stack here
// so we drop to CPU; everywhere else (including iOS / Android device farm)
// uses the GPU backend the addon picks. Vision (mmproj) follows the same
// device routing as text generation -- no separate CPU carve-out.
const useCpu = isDarwinX64 || isLinuxArm64

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

    // Cache control is a runOption (cacheKey), NOT a `{ role: 'session' }`
    // chat message — the latter was removed in v0.15.0 and is silently dropped
    // by Jinja chat templates that have no matching elif branch.
    const prompt1 = [systemMsg, userTurn1]
    const response1 = await addon.run(prompt1, { cacheKey: sessionName })
    const output1 = await collectResponse(response1)
    t.ok(output1.length > 0, `first turn produced output (${output1.length} chars)`)
    const lowerOutput1 = output1.toLowerCase()
    t.ok(/paris/.test(lowerOutput1), `first turn mentions Paris: "${output1.slice(0, 100)}"`)
    t.ok(response1.stats?.CacheTokens > 0, `first turn populated KV cache (CacheTokens=${response1.stats?.CacheTokens})`)

    const prompt2 = [
      systemMsg,
      userTurn1,
      { role: 'assistant', content: output1 },
      { role: 'user', content: 'And what about Germany?' }
    ]
    const response2 = await addon.run(prompt2, { cacheKey: sessionName })
    const output2 = await collectResponse(response2)
    t.ok(output2.length > 0, `second turn produced output (${output2.length} chars)`)
    const lowerOutput2 = output2.toLowerCase()
    t.ok(/berlin/.test(lowerOutput2), `second turn mentions Berlin: "${output2.slice(0, 100)}"`)
    t.ok(output2 !== output1, 'second turn produced different output from first')
    t.ok(
      response2.stats?.CacheTokens > response1.stats?.CacheTokens,
      `second turn extended the KV cache from turn 1 (${response1.stats?.CacheTokens} -> ${response2.stats?.CacheTokens})`
    )
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

// QVAC-18298: VLM perf coverage matches the SmolVLM2 image-*.test.js set
// (elephant / fruit plate / high-res aurora) so a Phase-3 optimization that
// only regresses large or high-resolution inputs is still caught. Each image
// reloads the model fresh and unloads after, so peak memory stays bounded per
// image (mirrors the per-file split SmolVLM2 uses for iOS Jetsam isolation).
// ctxSize is per-image: high-detail VLMs encode a large image to thousands
// of image tokens (the 1472x1472 fruit plate → ~4k, the 3000x4000 aurora
// more), so a fixed 4096 ctx overflows mid-decode → "failed to decode next
// token". elephant (~270 tokens) keeps a small ctx so its KV cache stays
// cheap; the large images get headroom for image tokens + generation.
const QWEN35_IMAGE_CASES = [
  { name: 'elephant', imageFile: 'elephant.jpg', keywords: ['elephant', 'elephants'], ctxSize: '4096' },
  { name: 'fruit plate', imageFile: 'fruitPlate.png', keywords: ['fruit', 'fruits', 'plate', 'apple', 'banana', 'orange'], ctxSize: '8192' },
  { name: 'high-res aurora', imageFile: 'highRes3000x4000.jpg', keywords: ['aurora', 'sky', 'night', 'green', 'light', 'lights'], ctxSize: '8192' }
]

async function runQwen35ImagePerf (t, imageCase) {
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

  // reasoning-budget 0 suppresses Qwen3.5's <think> trace so a one-sentence
  // image answer doesn't eat the ctx budget; ctx_size is per-image (see
  // QWEN35_IMAGE_CASES) so large images don't overflow mid-decode.
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '98',
    ctx_size: imageCase.ctxSize,
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '2'
  }

  const inference = new LlmLlamacpp({
    files: { model: [modelPath], projectionModel: projectionModelPath },
    config,
    // QVAC-18298: stats:true so response.stats (TTFT / TPS / tokens) is
    // populated for the perf row.
    logger: createLogger(),
    opts: { stats: true }
  })

  // QVAC-18298: [image] [model] [backend] so the GitHub summary Test column
  // shows the image under test, matching the [elephant] [GPU] image rows.
  const backendTag = useCpu ? 'CPU' : 'GPU'
  const perfLabel = `[${imageCase.name}] [qwen3.5-vl] [${backendTag}]`

  async function runImageInference (imageBytes) {
    const messages = [
      { role: 'user', type: 'media', content: imageBytes },
      { role: 'user', content: 'Describe the image briefly in one sentence.' }
    ]
    const startTime = Date.now()
    const response = await inference.run(messages)
    const chunks = []
    let error = null
    response.onUpdate(data => { chunks.push(data) })
      .onError(err => { error = err })
    await response.await()
    if (error) throw new Error('Inference error: ' + error)
    return {
      output: chunks.join(''),
      totalTime: Date.now() - startTime,
      stats: response.stats || null
    }
  }

  try {
    const t0 = Date.now()
    await inference.load()
    console.log(`  ${perfLabel} model.load() took ${Date.now() - t0} ms`)

    const imageFilePath = getMediaPath(imageCase.imageFile)
    t.ok(fs.existsSync(imageFilePath), `${imageCase.imageFile} image file should exist`)

    const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

    // QVAC-18298: warmup pass(es) absorb one-shot shader-compile / buffer
    // allocation costs and are not recorded.
    for (let w = 1; w <= PERF_WARMUP_RUNS; w++) {
      const warmup = await runImageInference(imageBytes)
      t.comment(`${perfLabel} warmup ${w}/${PERF_WARMUP_RUNS} (${warmup.totalTime}ms, ${warmup.output.length} chars) - perf NOT recorded`)
    }

    // QVAC-18298: PERF_RUNS counted rows under the same label → mean ± std.
    let lastOutput = ''
    for (let run = 1; run <= PERF_RUNS; run++) {
      const { output, totalTime, stats } = await runImageInference(imageBytes)
      lastOutput = output
      t.comment(`${perfLabel} run ${run}/${PERF_RUNS} output: "${output.slice(0, 200)}"`)
      t.comment(recordPerformance(perfLabel, totalTime, {
        _output: output,
        stats,
        deviceId: useCpu ? 'cpu' : 'gpu',
        scenario: 'image',
        model: modelName.replace(/\.gguf$/i, '')
      }))
    }

    t.ok(lastOutput.length > 0, `${perfLabel} image inference produced output (${lastOutput.length} chars)`)

    const lowerOutput = lastOutput.toLowerCase()
    const matched = imageCase.keywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(lowerOutput))
    t.ok(matched,
      `${perfLabel} output should mention one of ${imageCase.keywords.join(', ')}: "${lastOutput.slice(0, 150)}"`)
  } finally {
    await inference.unload().catch(() => {})
  }
}

for (const imageCase of QWEN35_IMAGE_CASES) {
  test(`Qwen3.5-0.8B can describe an image [${imageCase.name}]`, {
    timeout: 1_800_000
  }, async t => {
    await runQwen35ImagePerf(t, imageCase)
  })
}

test('Qwen3.5-0.8B reasoning-budget=0 disables thinking', {
  timeout: 600_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)

  // Qwen3.5 thinking traces, can run past 1k
  // tokens before emitting </think>, budget needs to be large enough that
  // the closing tag isn't cut off, otherwise the baseline assertions fail.
  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    n_predict: '3072',
    temp: '0',
    seed: '42',
    verbosity: '0'
  }

  async function runOnce (extra) {
    const addon = new LlmLlamacpp({
      files: { model: [modelPath] },
      config: { ...baseConfig, ...extra },
      logger: createLogger()
    })
    try {
      await addon.load()
      const response = await addon.run([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France? Answer in one word.' }
      ])
      return await collectResponse(response)
    } finally {
      await addon.unload().catch(() => {})
    }
  }

  const baseline = await runOnce({})
  const disabled = await runOnce({ 'reasoning-budget': '0' })
  const disabledUnderscore = await runOnce({ reasoning_budget: '0' })

  t.comment(`baseline (${baseline.length} chars): "${baseline.slice(0, 200)}"`)
  t.comment(`disabled (${disabled.length} chars): "${disabled.slice(0, 200)}"`)

  t.ok(/paris/i.test(baseline), `baseline mentions Paris: "${baseline.slice(0, 80)}"`)
  t.ok(/paris/i.test(disabled), `disabled mentions Paris: "${disabled.slice(0, 80)}"`)
  t.ok(/paris/i.test(disabledUnderscore), 'underscore variant also accepted and mentions Paris')

  t.ok(baseline.includes('<think>'),
    `baseline should contain <think> opening tag: "${baseline.slice(0, 100)}"`)
  if (isLinuxArm64) {
    // CPU greedy on ARM64 routinely exhausts n_predict mid-thought, so only assert
    // clean closure when the baseline actually emitted </think>. Same pattern as
    // gemma4.test.js's reasoning-marker gate.
    if (baseline.includes('</think>')) {
      t.ok(baseline.indexOf('<think>') < baseline.indexOf('</think>'),
        'baseline opening tag must precede closing tag')
    } else {
      t.comment(`baseline opened <think> but did not close it within n_predict (${baseline.length} chars) — skipping closing-tag assertion`)
    }
  } else {
    t.ok(baseline.includes('</think>'),
      `baseline should contain </think> closing tag: "${baseline.slice(-100)}"`)
    t.ok(baseline.indexOf('<think>') < baseline.indexOf('</think>'),
      'baseline opening tag must precede closing tag')
  }

  t.absent(/Thinking Process/i.test(disabled),
    `disabled output should not contain "Thinking Process": "${disabled.slice(0, 200)}"`)
  t.absent(/<think>/.test(disabled),
    `disabled output should not contain <think>: "${disabled.slice(0, 200)}"`)
  t.absent(/<\/think>/.test(disabled),
    `disabled output should not contain </think>: "${disabled.slice(0, 200)}"`)
  t.ok(disabled.length < baseline.length / 4,
    `disabled (${disabled.length}) should be substantially shorter than baseline (${baseline.length})`)
})

test('Qwen3.5-0.8B per-request generationParams.reasoning_budget overrides load-time default', {
  timeout: 600_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_5_MODEL.name,
    downloadUrl: QWEN3_5_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)

  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '999',
      ctx_size: '4096',
      n_predict: '3072',
      temp: '0',
      seed: '42',
      verbosity: '0'
    },
    logger: createLogger()
  })

  try {
    await addon.load()

    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the capital of France? Answer in one word.' }
    ]

    const overrideResponse = await addon.run(messages, {
      generationParams: { reasoning_budget: 0 }
    })
    const overrideOutput = await collectResponse(overrideResponse)

    const defaultResponse = await addon.run(messages)
    const defaultOutput = await collectResponse(defaultResponse)

    t.comment(`override (${overrideOutput.length} chars): "${overrideOutput.slice(0, 200)}"`)
    t.comment(`default  (${defaultOutput.length} chars): "${defaultOutput.slice(0, 200)}"`)

    t.absent(/<think>/.test(overrideOutput),
      `per-request override should suppress <think>: "${overrideOutput.slice(0, 200)}"`)
    t.absent(/<\/think>/.test(overrideOutput),
      `per-request override should suppress </think>: "${overrideOutput.slice(0, 200)}"`)

    t.ok(defaultOutput.includes('<think>'),
      `subsequent default run should restore <think>: "${defaultOutput.slice(0, 200)}"`)
    if (isLinuxArm64) {
      // CPU greedy on ARM64 may exhaust n_predict before emitting </think>;
      // accept that as a valid restore so long as <think> reappeared.
      if (defaultOutput.includes('</think>')) {
        t.ok(defaultOutput.indexOf('<think>') < defaultOutput.indexOf('</think>'),
          'subsequent default opening tag must precede closing tag')
      } else {
        t.comment(`subsequent default run opened <think> but did not close it within n_predict (${defaultOutput.length} chars) — skipping closing-tag assertion`)
      }
    } else {
      t.ok(defaultOutput.includes('</think>'),
        `subsequent default run should restore </think>: "${defaultOutput.slice(-200)}"`)
      t.ok(defaultOutput.indexOf('<think>') < defaultOutput.indexOf('</think>'),
        'subsequent default opening tag must precede closing tag')
    }
  } finally {
    await addon.unload().catch(() => {})
  }
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
