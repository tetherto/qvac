'use strict'

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { cleanupIntegrationCacheFiles, ensureModel } = require('./utils')
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
    cleanupIntegrationCacheFiles(sessionName)
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

// QVAC-18298: image (vision) correctness for Gemma 4 is covered by the
// gemma4-image-*-perf.test.js files (one per image: elephant / fruit plate /
// high-res aurora), which assert the expected keyword alongside recording
// perf — so the former single-image "can describe an image" test here was
// redundant (it only checked elephant) and ran the same inference twice.

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

test('Gemma 4 remove_thinking_from_context compacts cache after channel close', {
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

  async function runOnce (runOptions) {
    const addon = new LlmLlamacpp({
      files: { model: [modelPath] },
      config: baseConfig,
      logger: createLogger(),
      opts: { stats: true }
    })
    try {
      await addon.load()
      const response = await addon.run([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France? Answer in one word.' }
      ], runOptions)
      let output = ''
      const ticker = setInterval(() => {}, 50)
      try {
        await response.onUpdate(token => { output += token }).await()
      } finally {
        clearInterval(ticker)
      }
      return { output, stats: response.stats || {} }
    } finally {
      await addon.unload().catch(() => {})
    }
  }

  const toNum = v => typeof v === 'number' ? v : Number(v || 0)

  // Opt-in — compaction enabled by passing the flag explicitly.
  const compactRun = await runOnce({
    generationParams: { remove_thinking_from_context: true }
  })
  t.comment(`compact (${compactRun.output.length} chars): ${compactRun.output.slice(0, 200)}`)
  t.comment(`compact stats: ${JSON.stringify(compactRun.stats)}`)

  // Gemma 4 emits the reasoning channel only when it deems the question
  // worth deliberating about; if the opt-in run did not engage the channel,
  // there is nothing to compact and the rest of the assertions become
  // vacuous.
  if (/<\|channel>thought/i.test(compactRun.output)) {
    t.ok(toNum(compactRun.stats.thinkingBlockDiscards) >= 1,
      `opt-in run should compact at least one channel block (got ${compactRun.stats.thinkingBlockDiscards})`)

    // Default — compaction disabled (opt-in toggle left at false).
    const disabledRun = await runOnce()
    t.comment(`disabled (${disabledRun.output.length} chars): ${disabledRun.output.slice(0, 200)}`)
    t.comment(`disabled stats: ${JSON.stringify(disabledRun.stats)}`)
    t.is(toNum(disabledRun.stats.thinkingBlockDiscards), 0,
      `disabled run should report 0 discards (got ${disabledRun.stats.thinkingBlockDiscards})`)
  } else {
    t.comment('Gemma 4 did not emit <|channel>thought — skipping compaction assertions')
    t.pass('compaction assertions skipped (channel not engaged)')
  }
})

// Multi-turn cache-growth comparison for Gemma 4's channel marker.
// Runs the same two-turn flow twice (compaction on vs off, both with
// cacheKey) and verifies that turn-2 with compaction yields a smaller
// cache and still produces coherent output.
test('Gemma 4 multi-turn with remove_thinking_from_context reduces cache growth', {
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
    verbosity: '0'
  }

  const toNum = v => typeof v === 'number' ? v : Number(v || 0)
  const systemMsg = { role: 'system', content: 'You are a helpful assistant.' }
  const userTurn1 = { role: 'user', content: 'What is the capital of France? Answer in one word.' }
  const userTurn2Text = 'And what about Germany? Answer in one word.'

  async function runTwoTurns (label, turnOptions) {
    const sessionName = path.join(dirPath, `gemma4-compact-${label}.bin`)
    cleanupIntegrationCacheFiles(sessionName)
    const addon = new LlmLlamacpp({
      files: { model: [modelPath] },
      config,
      logger: createLogger(),
      opts: { stats: true }
    })
    try {
      await addon.load()
      const turn1Prompt = [systemMsg, userTurn1]
      const r1 = await addon.run(turn1Prompt, { cacheKey: sessionName, ...turnOptions })
      const o1 = await collectResponse(r1)
      const turn2Prompt = [
        systemMsg,
        userTurn1,
        { role: 'assistant', content: o1 },
        { role: 'user', content: userTurn2Text }
      ]
      const r2 = await addon.run(turn2Prompt, { cacheKey: sessionName, ...turnOptions })
      const o2 = await collectResponse(r2)
      return {
        t1: { output: o1, stats: r1.stats || {} },
        t2: { output: o2, stats: r2.stats || {} }
      }
    } finally {
      await addon.unload().catch(() => {})
    }
  }

  const onRun = await runTwoTurns('on', {
    generationParams: { remove_thinking_from_context: true }
  })
  const offRun = await runTwoTurns('off', {})

  t.comment(`ON  t1 stats=${JSON.stringify(onRun.t1.stats)}`)
  t.comment(`ON  t2 stats=${JSON.stringify(onRun.t2.stats)}`)
  t.comment(`OFF t1 stats=${JSON.stringify(offRun.t1.stats)}`)
  t.comment(`OFF t2 stats=${JSON.stringify(offRun.t2.stats)}`)
  t.comment(`ON  t2 (${onRun.t2.output.length} chars): ${onRun.t2.output.slice(0, 200)}`)
  t.comment(`OFF t2 (${offRun.t2.output.length} chars): ${offRun.t2.output.slice(0, 200)}`)

  // Gemma 4 emits the channel only when it deems the question worth
  // deliberating about. Skip the comparison if the model did not engage
  // the channel in the ON run (compaction has nothing to do).
  if (!/<\|channel>thought/i.test(onRun.t1.output)) {
    t.comment('Gemma 4 did not engage thinking channel on turn 1 — skipping cache-delta assertions')
    t.pass('multi-turn cache assertions skipped (channel not engaged)')
    return
  }

  t.ok(toNum(onRun.t1.stats.thinkingBlockDiscards) >= 1,
    `ON turn 1 should compact at least one thinking block (got ${onRun.t1.stats.thinkingBlockDiscards})`)
  t.is(toNum(offRun.t1.stats.thinkingBlockDiscards), 0,
    `OFF turn 1 should report 0 discards (got ${offRun.t1.stats.thinkingBlockDiscards})`)

  const cacheOn2 = toNum(onRun.t2.stats.CacheTokens)
  const cacheOff2 = toNum(offRun.t2.stats.CacheTokens)
  t.ok(cacheOn2 > 0 && cacheOff2 > 0,
    `both turn-2 runs should have non-zero cache (ON=${cacheOn2}, OFF=${cacheOff2})`)
  t.ok(cacheOn2 < cacheOff2,
    `turn 2 cache with compaction ON (${cacheOn2}) should be < OFF (${cacheOff2}) — proves turn 1 thinking was dropped`)

  // Turn 2 must still be coherent — guard against the Qwen3.5-style
  // runaway where post-compaction state goes off the rails.
  t.ok(toNum(onRun.t2.stats.generatedTokens) > 0,
    'ON turn 2 should generate at least one token')
  t.ok(toNum(onRun.t2.stats.generatedTokens) < 256,
    `ON turn 2 should not hit n_predict cap (got ${onRun.t2.stats.generatedTokens})`)
})

// Multimodal compaction: loads Gemma 4 with the projection model
// (forcing the multimodal context path) and verifies the same opt-in
// toggle drops the reasoning block from the KV cache when the channel
// is engaged. Text-only prompt is sufficient; we are not testing
// vision here, only that the multimodal context honours the toggle.
test('Gemma 4 multimodal honours remove_thinking_from_context', {
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)
  const [projModelName] = await ensureModel(GEMMA4_MODEL.projModel)
  const modelPath = path.join(dirPath, modelName)
  const projectionModelPath = path.join(dirPath, projModelName)

  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
    n_predict: '256',
    temp: '0',
    seed: '42',
    verbosity: '0'
  }

  async function runOnce (runOptions) {
    const addon = new LlmLlamacpp({
      files: { model: [modelPath], projectionModel: projectionModelPath },
      config: baseConfig,
      logger: createLogger(),
      opts: { stats: true }
    })
    try {
      await addon.load()
      const response = await addon.run([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France? Answer in one word.' }
      ], runOptions)
      let output = ''
      const ticker = setInterval(() => {}, 50)
      try {
        await response.onUpdate(token => { output += token }).await()
      } finally {
        clearInterval(ticker)
      }
      return { output, stats: response.stats || {} }
    } finally {
      await addon.unload().catch(() => {})
    }
  }

  const toNum = v => typeof v === 'number' ? v : Number(v || 0)

  const compactRun = await runOnce({
    generationParams: { remove_thinking_from_context: true }
  })
  t.comment(`multimodal compact (${compactRun.output.length} chars): ${compactRun.output.slice(0, 200)}`)
  t.comment(`multimodal compact stats: ${JSON.stringify(compactRun.stats)}`)

  // Gemma 4 emits the reasoning channel only when it deems the question
  // worth deliberating about; skip the assertions if the channel did
  // not engage so the multimodal path is exercised but the test does
  // not become flaky on prompt-dependent behaviour.
  if (/<\|channel>thought/i.test(compactRun.output)) {
    t.ok(toNum(compactRun.stats.thinkingBlockDiscards) >= 1,
      `multimodal opt-in should compact at least one channel block (got ${compactRun.stats.thinkingBlockDiscards})`)

    const defaultRun = await runOnce()
    t.comment(`multimodal default (${defaultRun.output.length} chars): ${defaultRun.output.slice(0, 200)}`)
    t.comment(`multimodal default stats: ${JSON.stringify(defaultRun.stats)}`)
    t.is(toNum(defaultRun.stats.thinkingBlockDiscards), 0,
      `multimodal default (no opt-in) should report 0 discards (got ${defaultRun.stats.thinkingBlockDiscards})`)
  } else {
    t.comment('Gemma 4 multimodal did not emit <|channel>thought - skipping compaction assertions')
    t.pass('multimodal compaction assertions skipped (channel not engaged)')
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
