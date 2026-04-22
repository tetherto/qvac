'use strict'

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const QWEN3_MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const SYSTEM_MESSAGE = { role: 'system', content: 'You are a helpful assistant.' }
const SYSTEM_MESSAGE_TOKENS = 11
const CUT_PREDICT_LIMIT = '32'
/*
 * a model should produce full output during tests,
 * since the logic parses tool response blocks or ensure tool multi-turn usage
 * limited model output is tested with CUT_PREDICT_LIMIT
 */
const FULL_PREDICT_LIMIT = '2048'
const QUIET_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
}
let cachedToolsSupport = null

const BASE_CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '4096',
  n_predict: FULL_PREDICT_LIMIT,
  temp: '0',
  seed: '1',
  verbosity: '2',
  tools: 'true',
  tools_compact: 'true'
}

const TOOL_A = {
  type: 'function',
  name: 'getWeather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city']
  }
}
/**
 * manual count with a following debug:
 * printf("ToolsCompactController::onTokenize with=%zu, without=%zu\n", tokensWithTools, tokensWithoutTools);
 * $> ToolsCompactController::onTokenize with=161, without=13
 */
const TOOL_A_TOKENS = 148

const TOOL_B = {
  type: 'function',
  name: 'searchProducts',
  description: 'Search for products in catalog',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query']
  }
}

const TOOL_C = {
  type: 'function',
  name: 'sendEmail',
  description: 'Send an email message',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email' },
      body: { type: 'string', description: 'Email body' }
    },
    required: ['to', 'body']
  }
}

const toNumber = value => typeof value === 'number' ? value : Number(value || 0)

function normalizeStats (rawStats = {}) {
  return {
    CacheTokens: toNumber(rawStats?.CacheTokens),
    promptTokens: toNumber(rawStats?.promptTokens),
    generatedTokens: toNumber(rawStats?.generatedTokens)
  }
}

async function setupModel (t, overrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_MODEL.name,
    downloadUrl: QWEN3_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)

  const config = { ...BASE_CONFIG, ...overrides }
  const specLogger = attachSpecLogger({ forwardToConsole: false })
  let loggerReleased = false
  const releaseLogger = () => {
    if (loggerReleased) return
    loggerReleased = true
    specLogger.release()
  }

  const model = new LlmLlamacpp({
    files: {
      model: [modelPath]
    },
    config,
    logger: QUIET_LOGGER,
    opts: { stats: true }
  })

  try {
    await model.load()
  } catch (err) {
    releaseLogger()
    throw err
  }

  t.teardown(async () => {
    await model.unload().catch(() => {})
    releaseLogger()
  })

  return { model, dirPath, logs: specLogger.logs }
}

function modelDoesNotSupportTools (logs = []) {
  return logs.some(line => line.includes('model does not support tools'))
}

async function ensureToolsSupportOrSkip (t, model, logs) {
  if (cachedToolsSupport === false) {
    t.comment('Skipping tools_compact behavior assertions: model/template runtime does not support tools in this environment')
    t.pass('tools unsupported in runtime; assertions skipped')
    return false
  }
  if (cachedToolsSupport === true) return true

  const probePrompt = [
    { role: 'user', content: 'Use tools if needed to answer briefly.' },
    TOOL_A
  ]

  try {
    await runAndCollect(model, probePrompt)
  } catch {
    // No-op: support signal is read from native logs.
  }

  if (modelDoesNotSupportTools(logs)) {
    cachedToolsSupport = false
    t.comment('Skipping tools_compact behavior assertions: model/template runtime does not support tools in this environment')
    t.pass('tools unsupported in runtime; assertions skipped')
    return false
  }

  cachedToolsSupport = true
  return true
}

async function runAndCollect (model, prompt, runOptions) {
  const response = await model.run(prompt, runOptions)
  const chunks = []
  let chain = response.onUpdate(data => { chunks.push(data) })
  if (typeof response.onError === 'function') {
    chain = chain.onError(err => { throw err })
  }
  await chain.await()
  const output = chunks.join('')
  if (output.length >= (FULL_PREDICT_LIMIT - 1)) {
    throw new Error('Full output limit reached: consider re-run or increase limit, tests flaky')
  }

  return {
    output,
    stats: normalizeStats(response.stats)
  }
}

async function runExpectingInvalidPrompt (t, model, prompt, expectedReason, runOptions) {
  const response = await model.run(prompt, runOptions)

  let capturedError = null
  if (typeof response.onError === 'function') {
    response.onError(err => { capturedError = err })
  }
  // Drain output stream so response lifecycle completes.
  response.onUpdate(() => {})

  try {
    await response.await()
  } catch (err) {
    capturedError = capturedError || err
  }

  if (!capturedError) {
    t.fail(`${expectedReason}: expected prompt validation error`)
    return
  }

  const message = String(capturedError.message ? capturedError.message : capturedError)
  t.ok(
    message.includes(expectedReason),
    `error includes exact reason: ${expectedReason}`
  )
}

async function runExpectingNoPromptValidationError (t, model, prompt, runOptions, invalidReason) {
  const response = await model.run(prompt, runOptions)

  let capturedError = null
  if (typeof response.onError === 'function') {
    response.onError(err => { capturedError = err })
  }
  response.onUpdate(() => {})

  try {
    await response.await()
  } catch (err) {
    capturedError = capturedError || err
  }

  if (!capturedError) {
    t.pass('prompt accepted without validation errors')
    return
  }

  const message = String(capturedError.message ? capturedError.message : capturedError)
  t.absent(
    message.includes(invalidReason),
    `prompt should not fail validation with reason: ${invalidReason}`
  )
}

test('[tools-compact] multi-turn session with wrong tools provided', { timeout: 600_000 }, async t => {
  const { model, dirPath, logs } = await setupModel(t)
  if (!await ensureToolsSupportOrSkip(t, model, logs)) return
  const sessionName = path.join(dirPath, 'tools-compact-changing.bin')
  const opts = { cacheKey: sessionName }

  const prompt1 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Hello, what can you do?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1, opts)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.ok(r1.output.length < FULL_PREDICT_LIMIT, 'turn 1 output is within predict limit')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')
  t.ok(r1.stats.CacheTokens < TOOL_A_TOKENS, 'turn 1 has tool tokens removed')

  const prompt2 = [
    { role: 'user', content: 'Check weather in Tokyo' },
    TOOL_C
  ]
  const r2 = await runAndCollect(model, prompt2, opts)
  t.ok(r2.output.length > 0, 'turn 2 produces output')
  t.ok(r2.stats.CacheTokens > r1.stats.CacheTokens, 'turn 2 has cache tokens added')
  t.ok(r2.stats.CacheTokens < r1.stats.CacheTokens + (TOOL_A_TOKENS / 2), 'turn 2 has tools removed')

  const prompt3 = [
    { role: 'user', content: 'Find best NHL player' },
    TOOL_B
  ]
  const r3 = await runAndCollect(model, prompt3, opts)
  t.ok(r3.output.length > 0, 'turn 3 produces output')
  t.ok(r3.stats.CacheTokens > r2.stats.CacheTokens, 'turn 3 has cache tokens added')
  t.ok(r3.stats.CacheTokens < r2.stats.CacheTokens + (TOOL_A_TOKENS / 2), 'turn 3 has tools removed')

  const naiveAccumulation = r1.stats.CacheTokens + r2.stats.promptTokens + r2.stats.generatedTokens + r3.stats.promptTokens + r3.stats.generatedTokens
  t.ok(
    r3.stats.CacheTokens < naiveAccumulation,
    `CacheTokens after 3 turns (${r3.stats.CacheTokens}) should be less than naive accumulation (${naiveAccumulation}) — proves old tools are trimmed`
  )

  t.ok(
    r3.stats.CacheTokens < 2 * r1.stats.CacheTokens,
    `CacheTokens after 3 turns (${r3.stats.CacheTokens}) should be less than 2x turn 1 (${2 * r1.stats.CacheTokens}) — tools are replaced, not accumulated`
  )
})

test('[tools-compact] multi-turn session with same tools and cut LLM output', { timeout: 600_000 }, async t => {
  if (cachedToolsSupport === false) {
    t.comment('Skipping tools_compact behavior assertions: model/template runtime does not support tools in this environment')
    t.pass('tools unsupported in runtime; assertions skipped')
    return
  }
  const { model, dirPath, logs } = await setupModel(t, { n_predict: CUT_PREDICT_LIMIT })
  if (!await ensureToolsSupportOrSkip(t, model, logs)) return
  const sessionName = path.join(dirPath, 'tools-compact-cut-output.bin')
  const opts = { cacheKey: sessionName }

  const prompt1 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Paris?' },
    TOOL_A
  ]
  const PROMPT_1_TOKENS = { USER: 12, SYSTEM: SYSTEM_MESSAGE_TOKENS }
  const r1 = await runAndCollect(model, prompt1, opts)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.is(r1.stats.CacheTokens, PROMPT_1_TOKENS.SYSTEM + PROMPT_1_TOKENS.USER, 'turn 1 has exact cache tokens prompt only - tools removed')

  const prompt2 = [
    { role: 'user', content: 'What about London?' },
    TOOL_A
  ]
  const PROMPT_2_TOKENS = { USER: 9 }
  const r2 = await runAndCollect(model, prompt2, opts)
  t.ok(r2.output.length > 0, 'turn 2 produces output')
  t.is(r2.stats.CacheTokens, r1.stats.CacheTokens + PROMPT_2_TOKENS.USER, 'turn 2 has exact prompt tokens added')
  t.end()
})

test('[tools-compact] multi-turn session with same tools works correctly', { timeout: 600_000 }, async t => {
  if (cachedToolsSupport === false) {
    t.comment('Skipping tools_compact behavior assertions: model/template runtime does not support tools in this environment')
    t.pass('tools unsupported in runtime; assertions skipped')
    return
  }
  const { model, dirPath, logs } = await setupModel(t)
  if (!await ensureToolsSupportOrSkip(t, model, logs)) return
  const sessionName = path.join(dirPath, 'tools-compact-same.bin')
  const opts = { cacheKey: sessionName }

  const prompt1 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Paris?' },
    TOOL_A
  ]
  const PROMPT_1_TOKENS = { USER: 12, TOOLS: TOOL_A_TOKENS }
  const r1 = await runAndCollect(model, prompt1, opts)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')
  t.ok(r1.stats.CacheTokens > PROMPT_1_TOKENS.TOOLS, 'turn 1 cache has tools tokens included')

  const toolResponse = [
    { role: 'assistant', content: r1.output },
    { role: 'tool', content: 'sunny in Paris' },
    TOOL_A
  ]
  const rTool = await runAndCollect(model, toolResponse, opts)
  t.ok(rTool.output.length > 0, 'turn rTool produces output')
  t.ok(rTool.stats.CacheTokens > 0, 'turn rTool has cache tokens')
  t.ok(rTool.stats.CacheTokens < r1.stats.CacheTokens, 'turn rTool has cache tokens removed')

  const prompt2 = [
    { role: 'assistant', content: rTool.output },
    { role: 'user', content: 'What about London?' },
    TOOL_A
  ]
  const PROMPT_2_TOKENS = { USER: 9, TOOLS: TOOL_A_TOKENS }
  const r2 = await runAndCollect(model, prompt2, opts)
  t.ok(r2.output.length > 0, 'turn 2 produces output')
  t.ok(r2.stats.CacheTokens > 0, 'turn 2 has cache tokens')
  t.ok(r2.stats.CacheTokens > rTool.stats.CacheTokens, 'turn 2 has cache tokens more than prev')
  t.ok(r2.stats.CacheTokens > PROMPT_2_TOKENS.TOOLS, 'turn 2 has cache tokens with tools')

  const toolResponse2 = [
    { role: 'assistant', content: r2.output },
    { role: 'tool', content: 'rainy in London' },
    TOOL_A
  ]
  const rTool2 = await runAndCollect(model, toolResponse2, opts)
  t.ok(rTool2.output.length > 0, 'turn rTool2 produces output')
  t.ok(rTool2.stats.CacheTokens > 0, 'turn rTool2 has cache tokens')
  t.ok(rTool2.stats.CacheTokens < TOOL_A_TOKENS, 'turn rTool2 has all tools removed')
  t.ok(
    r2.stats.CacheTokens < 2 * r1.stats.CacheTokens,
    `CacheTokens after turn 2 (${r2.stats.CacheTokens}) should be less than 2x turn 1 (${2 * r1.stats.CacheTokens})`
  )
})

test('[tools-compact] single-shot with tools works without session', { timeout: 600_000 }, async t => {
  if (cachedToolsSupport === false) {
    t.comment('Skipping tools_compact behavior assertions: model/template runtime does not support tools in this environment')
    t.pass('tools unsupported in runtime; assertions skipped')
    return
  }
  const { model, logs } = await setupModel(t)
  if (!await ensureToolsSupportOrSkip(t, model, logs)) return

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Tokyo?' },
    TOOL_A
  ]
  const r = await runAndCollect(model, prompt)
  t.ok(r.output.length > 0, 'produces output')
  t.is(r.stats.CacheTokens, 0, 'no cache tokens without session')
  t.ok(r.stats.promptTokens > 0, 'prompt tokens tracked')
  t.ok(r.stats.generatedTokens > 0, 'generated tokens tracked')
})

test('[tools-compact] rejects invalid prompt shapes', { timeout: 600_000 }, async t => {
  if (cachedToolsSupport === false) {
    t.comment('Skipping strict tools_compact invalid-shape assertions: model/template runtime does not support tools in this environment')
    t.pass('tools unsupported in runtime; assertions skipped')
    return
  }
  const { model: probeModel, logs } = await setupModel(t)
  if (!await ensureToolsSupportOrSkip(t, probeModel, logs)) return
  const { model, dirPath } = await setupModel(t)

  const noCacheOpts = { cacheKey: path.join(dirPath, 'tools-compact-invalid-user-tail.bin') }

  await runExpectingInvalidPrompt(
    t,
    model,
    [
      { role: 'user', content: 'Hello without tools' }
    ],
    'tools_compact requires non-empty tools for this prompt shape',
    noCacheOpts
  )
})

test('[tools-compact] cache-aware empty-tools contract', { timeout: 600_000 }, async t => {
  if (cachedToolsSupport === false) {
    t.comment('Skipping strict tools_compact invalid-shape assertions: model/template runtime does not support tools in this environment')
    t.pass('tools unsupported in runtime; assertions skipped')
    return
  }
  const { model: probeModel, logs } = await setupModel(t)
  if (!await ensureToolsSupportOrSkip(t, probeModel, logs)) return
  const { model, dirPath } = await setupModel(t)

  const invalidReason = 'tools_compact requires non-empty tools for this prompt shape'

  // no-cache: assistant marker tail must include tools
  await runExpectingInvalidPrompt(
    t,
    model,
    [
      SYSTEM_MESSAGE,
      { role: 'user', content: 'Need weather update' },
      { role: 'assistant', content: '<tool_call>{"name":"getWeather","arguments":{"city":"Tokyo"}}</tool_call>' }
    ],
    invalidReason
  )

  // no-cache: assistant without marker can omit tools
  await runExpectingNoPromptValidationError(
    t,
    model,
    [
      SYSTEM_MESSAGE,
      { role: 'user', content: 'Need weather update' },
      { role: 'assistant', content: 'Tokyo is sunny right now.' }
    ],
    { prefill: true },
    invalidReason
  )

  // with cache: marker/tool tails can omit tools.
  // No-cache marker/tool strictness is covered deterministically in
  // test/unit/test_tools_compact_controller.cpp.
  const sessionName = path.join(dirPath, 'tools-compact-cache-aware-contract.bin')
  const opts = { cacheKey: sessionName }

  await runExpectingNoPromptValidationError(
    t,
    model,
    [
      SYSTEM_MESSAGE,
      { role: 'user', content: 'Start session with available tools.' },
      TOOL_A
    ],
    { ...opts, prefill: true },
    invalidReason
  )

  await runExpectingNoPromptValidationError(
    t,
    model,
    [
      { role: 'assistant', content: '<tool_call>{"name":"getWeather","arguments":{"city":"London"}}</tool_call>' }
    ],
    { ...opts, prefill: true },
    invalidReason
  )

  await runExpectingNoPromptValidationError(
    t,
    model,
    [
      { role: 'assistant', content: 'Calling tool now.' },
      { role: 'tool', content: '{"city":"London","weather":"rainy"}' }
    ],
    { ...opts, prefill: true },
    invalidReason
  )
})
