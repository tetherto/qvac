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
// Desktop x64-darwin and linux-arm64 hosts have no working GPU stack here
// so we drop to CPU; everywhere else (including iOS / Android device farm)
// uses the GPU backend the addon picks. Vision (mmproj) follows the same
// device routing as text generation -- bartowski's mmproj is what we ship
// as the fixture and we want CI to actually validate the GPU code path on
// real Adreno/Mali/Metal devices.
const useCpu = isDarwinX64 || isLinuxArm64

// Use bartowski's GGUF rather than unsloth's: bartowski's pack tags <eos> as
// the EOG token (matching the base google/gemma-4-E2B-it tokenizer), so the
// addon's generation loop terminates on the first <eos> the model emits.
// unsloth's pack instead tags <turn|> as EOG and leaves <eos> classified as a
// regular text token; in that pack Gemma 4's training-baked post-content
// <eos> trail is not a stop signal, so generation continues to spit ~9
// extra <eos> tokens before the loop sees <turn|>. Same vocab, different
// tokenizer.ggml.eos_token_id metadata, ~30% shorter completions for us.
const GEMMA4_MODEL = {
  llmModel: {
    modelName: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_K_M.gguf'
  },
  projModel: {
    modelName: 'mmproj-google_gemma-4-E2B-it-bf16.gguf',
    downloadUrl: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/mmproj-google_gemma-4-E2B-it-bf16.gguf'
  }
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

// Gemma 4 emits tool calls in its own dialect, NOT as <tool_call>{json}</tool_call>:
//   <|tool_call>call:NAME{key:<|"|>val<|"|>,key2:val2,...}<tool_call|>
// Strings are wrapped in <|"|>...<|"|> instead of "...". Keys are bare. The
// closing tag is <tool_call|> (trailing pipe, no slash). This parser extracts
// each native call and returns { name, argsRaw } so tests can assert on the
// raw args body (substring checks are sufficient for our purposes; a full
// dialect-to-JSON converter lives upstream in fabric's gemma4_args_to_json).
function extractToolCalls (response) {
  const toolCalls = []
  // [^{]+? avoids spilling across braces; [\s\S]*? is non-greedy across newlines.
  const toolCallRegex = /<\|tool_call>call:([^{]+?)\{([\s\S]*?)\}<tool_call\|>/g
  let match
  while ((match = toolCallRegex.exec(response)) !== null) {
    toolCalls.push({
      name: match[1].trim(),
      argsRaw: match[2].trim()
    })
  }
  return toolCalls
}

// Helper: did the Gemma 4 args body contain a quoted string equal to value?
// String literal in Gemma 4 dialect is <|"|>VALUE<|"|>. Returns true if any
// occurrence of <|"|>VALUE<|"|> appears in the args body (case-insensitive).
function argsContainStringValue (argsRaw, value) {
  const re = new RegExp(`<\\|"\\|>${value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}<\\|"\\|>`, 'i')
  return re.test(argsRaw)
}

test('Gemma 4 can run basic text inference', {
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
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

test('Gemma 4 supports multi-turn conversation with KV cache', {
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
    n_predict: '128',
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

    const sessionName = path.join(dirPath, 'gemma4-multiturn-cache.bin')
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

test('Gemma 4 can describe an image', {
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)
  const [projModelName] = await ensureModel(GEMMA4_MODEL.projModel)
  const modelPath = path.join(dirPath, modelName)
  const projectionModelPath = path.join(dirPath, projModelName)

  // ctx_size: a single elephant.jpg encodes to ~260 mtmd image tokens; the
  // system turn, user message and the answer fit comfortably even at 4096
  // (~15x headroom over the ~275 tokens actually used). 8192 was originally
  // chosen to leave room for Gemma 4's CoT preamble, but reasoning-budget=0
  // below already suppresses CoT, so the extra 4k cells were dead KV cache
  // weight ridden by jetsam on iPhone 16 -- which has a tighter per-process
  // memory ceiling than iPhone 17 and was timing out at 20 min on test 3.
  // Halving the KV cache cuts ~75 MB on the GPU side without affecting any
  // image-token, prompt or answer fit.
  // reasoning-budget: 0 -- we ask the model for a one-word answer and don't
  // need the <|channel>thought ...<channel|> preamble. Without this, Gemma 4
  // happily generates 8k+ tokens of CoT for a vision question and the
  // generation loop overflows ctx_size before reaching <eos>.
  // ubatch-size: 320 -- the LLM's Metal compute buffer is sized by n_ubatch
  // (default 512), and at default it lands around 830 MiB for Gemma 4.
  // Together with the ~1 GB base model and ~941 MB bf16 mmproj that pushes
  // iPhone 17 over its per-process jetsam ceiling and the app hangs. Lowering
  // ubatch shrinks the compute buffer proportionally. CLIP's vision encoder
  // uses non-causal attention which asserts n_ubatch >= n_tokens_per_call,
  // and elephant.jpg encodes to ~260 mtmd image tokens, so 320 is the
  // smallest 64-aligned value that still fits the image in one call while
  // saving ~40% of the compute buffer vs the default 512.
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '98',
    ctx_size: '4096',
    'ubatch-size': '320',
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
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

test('Gemma 4 supports tool calling', {
  timeout: 600_000
}, async t => {
  const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)
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
    console.log(`  output: "${output.slice(0, 400)}"`)

    const toolCalls = extractToolCalls(output)
    t.ok(toolCalls.length > 0, `extracted at least one Gemma 4 native tool call (got ${toolCalls.length})`)

    const weatherCall = toolCalls.find(tc => tc.name === 'get_weather')
    t.ok(weatherCall, 'model called get_weather tool')
    t.ok(weatherCall?.argsRaw && weatherCall.argsRaw.length > 0, 'tool call has args body')
    t.ok(
      argsContainStringValue(weatherCall?.argsRaw || '', 'Paris'),
      `args body contains city=<|"|>Paris<|"|>: "${weatherCall?.argsRaw}"`
    )
  } finally {
    await addon.unload().catch(() => {})
  }
})

test('Gemma 4 reasoning-budget=0 disables thinking', {
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)
  const modelPath = path.join(dirPath, modelName)

  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
    n_predict: '256',
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

  // Gemma 4's reasoning channel is model-emitted: the model decides per-prompt
  // whether to engage it, and may skip reasoning for trivial questions. Only
  // assert reasoning-marker behavior when the baseline actually engaged it.
  if (/<\|channel>thought/i.test(baseline)) {
    t.ok(baseline.includes('<channel|>'),
      `baseline should contain <channel|> closing marker: "${baseline.slice(-100)}"`)
    t.ok(baseline.search(/<\|channel>thought/i) < baseline.indexOf('<channel|>'),
      'baseline opening marker must precede closing marker')

    t.absent(/<\|channel>thought/i.test(disabled),
      `disabled output should not contain channel-thought marker: "${disabled.slice(0, 200)}"`)
    t.absent(/<channel\|>/.test(disabled),
      `disabled output should not contain <channel|>: "${disabled.slice(0, 200)}"`)
    t.absent(/Thinking Process/i.test(disabled),
      `disabled output should not contain "Thinking Process": "${disabled.slice(0, 200)}"`)
    t.ok(disabled.length < baseline.length / 4,
      `disabled (${disabled.length}) should be substantially shorter than baseline (${baseline.length})`)
  } else {
    t.comment('baseline did not emit <|channel>thought — skipping reasoning-marker assertions')
  }
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
