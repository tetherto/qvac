'use strict'

const test = require('brittle')
const path = require('bare-path')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isWindowsX64 = platform === 'win32' && arch === 'x64'
const useCpu = isDarwinX64 || isLinuxArm64

const DEFAULT_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

// ── Constants ────────────────────────────────────────────────────────────────
const N_CTX = 256
const PROMPT_TOKENS = 44 // STORY_PROMPT tokenizes to 44 tokens with Llama 3.2 1B
const FREE_SLOTS = N_CTX - PROMPT_TOKENS
const SLIDE_PREDICT = isWindowsX64 ? 256 : 512
const MANY_SLIDES_PREDICT = isWindowsX64 ? 384 : 1024

// Prompt designed to elicit long output so generation hits the context limit
const STORY_PROMPT = [
  { role: 'system', content: 'You are a storyteller. Write extremely long, detailed stories with many characters.' },
  { role: 'user', content: 'Tell a very long story about a brave knight on many adventures.' }
]

const FOLLOW_UP_MSG = { role: 'user', content: 'Continue the story with more details about the knight.' }

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTestLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

async function setupModel (t, overrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  let loggerReleased = false
  function releaseLogger () {
    if (loggerReleased) return
    loggerReleased = true
    specLogger.release()
  }

  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: String(N_CTX),
    n_predict: '512',
    temp: '0.9',
    top_p: '0.95',
    seed: '42',
    verbosity: '3'
  }

  const model = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: createTestLogger(),
    opts: { stats: true }
  }, { ...baseConfig, ...overrides })

  try {
    await model.load()
  } catch (err) {
    releaseLogger()
    await loader.close().catch(() => {})
    throw err
  }

  // Clear any late C++ log callbacks from previous tests that arrived during model setup.
  // model.load() is a long async operation that yields many times, guaranteeing all
  // pending callbacks from prior tests have been processed by this point.
  specLogger.logs.length = 0

  t.teardown(async () => {
    // Guard against model.unload() hanging after context overflow (seen on darwin-arm64 CI).
    // If unload doesn't complete within 30s, continue cleanup to avoid blocking the suite.
    const unloadDone = model.unload().catch(() => {})
    const unloadTimeout = new Promise(resolve => setTimeout(resolve, 30_000))
    await Promise.race([unloadDone, unloadTimeout])
    await loader.close().catch(() => {})
    releaseLogger()
  })

  return { model, dirPath, logs: specLogger.logs }
}

async function runAndCollect (model, prompt) {
  const response = await model.run(prompt)
  const chunks = []
  response.onUpdate(data => { chunks.push(data) })
  // Bare runtime on arm64 may not drain promise microtasks from native addon
  // (uv_async) callbacks until another macrotask fires. A periodic setInterval
  // ensures the event loop stays active and microtasks are flushed promptly,
  // preventing response.await() from hanging until the test timeout.
  const ticker = setInterval(() => {}, 50)
  try {
    await response.await()
  } finally {
    clearInterval(ticker)
  }
  // Native log callbacks (JsLogger) and output/completion callbacks (OutputCallbackJs)
  // are delivered via separate uv_async handles with no ordering guarantee. Yield to the
  // event loop so any pending log callbacks are processed before the caller reads the
  // shared logs array.
  await new Promise(resolve => setTimeout(resolve, 50))
  return { text: chunks.join(''), stats: response.stats }
}

function buildPrompt (sessionPath, messages) {
  if (!sessionPath) return messages
  return [{ role: 'session', content: sessionPath }, ...messages]
}

function countDiscardLogs (logs) {
  return logs.filter(entry =>
    entry.includes('discarded') && entry.includes('tokens after the first message')
  ).length
}

function countPrefillDiscardLogs (logs) {
  return logs.filter(entry =>
    entry.includes('Prefill step: discarded')
  ).length
}

function expectedSlides (nPredict, nDiscarded) {
  if (nDiscarded <= 0) return 0
  const extra = nPredict - FREE_SLOTS
  if (extra <= 0) return 0
  const clampedDiscard = Math.min(nDiscarded, FREE_SLOTS - 1)
  return Math.ceil(extra / clampedDiscard)
}

// n_discarded=32, n_predict=SLIDE_PREDICT
test('Basic generation sliding', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const { model, logs } = await setupModel(t, {
    n_predict: String(SLIDE_PREDICT),
    n_discarded: '32'
  })

  const { stats } = await runAndCollect(model, STORY_PROMPT)

  t.is(stats.promptTokens, PROMPT_TOKENS, `prompt tokenizes to ${PROMPT_TOKENS} tokens`)
  t.is(stats.generatedTokens, SLIDE_PREDICT, 'model generated exactly n_predict tokens')

  const discardCount = countDiscardLogs(logs)
  t.is(
    discardCount,
    expectedSlides(SLIDE_PREDICT, 32),
    'slide count matches expected n_predict / n_discarded'
  )
})

// n_discarded=0, n_predict=SLIDE_PREDICT
test('Generation fails with context overflow when sliding disabled', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const { model, logs } = await setupModel(t, {
    n_predict: String(SLIDE_PREDICT),
    n_discarded: '0'
  })

  try {
    await runAndCollect(model, STORY_PROMPT)
    t.fail('expected context overflow error but generation completed without error')
  } catch (err) {
    const msg = err?.message || String(err)
    t.ok(
      /context|overflow/i.test(msg),
      `context overflow error surfaced: "${msg.slice(0, 120)}"`
    )
  }

  t.is(countDiscardLogs(logs), 0, 'no discard events when n_discarded=0')

  // sleep for 10 seconds to allow the model to cleanup
  await new Promise(resolve => setTimeout(resolve, 10000))
})

// n_discarded=16, n_predict=MANY_SLIDES_PREDICT
test('Many slides with small n_discarded', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const { model, logs } = await setupModel(t, {
    n_predict: String(MANY_SLIDES_PREDICT),
    n_discarded: '16'
  })

  const { stats } = await runAndCollect(model, STORY_PROMPT)

  t.is(stats.promptTokens, PROMPT_TOKENS, `prompt tokenizes to ${PROMPT_TOKENS} tokens`)
  t.is(stats.generatedTokens, MANY_SLIDES_PREDICT, 'model generated exactly n_predict tokens')

  const discardCount = countDiscardLogs(logs)
  t.is(
    discardCount,
    expectedSlides(MANY_SLIDES_PREDICT, 16),
    'slide count matches expected n_predict / n_discarded'
  )
})

// n_discarded=99999, clamped to FREE_SLOTS - 1
test('Large n_discarded is clamped to fit available context space', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const { model, logs } = await setupModel(t, {
    n_predict: String(SLIDE_PREDICT),
    n_discarded: '99999'
  })

  const { stats } = await runAndCollect(model, STORY_PROMPT)

  t.is(stats.promptTokens, PROMPT_TOKENS, `prompt tokenizes to ${PROMPT_TOKENS} tokens`)
  t.is(stats.generatedTokens, SLIDE_PREDICT, 'model generated exactly n_predict tokens')

  const discardCount = countDiscardLogs(logs)
  t.is(
    discardCount,
    expectedSlides(SLIDE_PREDICT, 99999),
    'slide count matches expected n_predict / clamped n_discarded'
  )
})

// n_discarded=1, n_predict=SLIDE_PREDICT
test('Sliding context works with minimal n_discarded of 1', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const { model, logs } = await setupModel(t, {
    n_predict: String(SLIDE_PREDICT),
    n_discarded: '1'
  })

  const { stats } = await runAndCollect(model, STORY_PROMPT)

  t.is(stats.promptTokens, PROMPT_TOKENS, `prompt tokenizes to ${PROMPT_TOKENS} tokens`)
  t.is(stats.generatedTokens, SLIDE_PREDICT, 'model generated exactly n_predict tokens')

  const discardCount = countDiscardLogs(logs)
  t.is(
    discardCount,
    expectedSlides(SLIDE_PREDICT, 1),
    'slide count matches expected n_predict / n_discarded'
  )
})

// n_discarded=64, n_predict=200
// First run: n_past = 44 + 200 = 244, firstMsgTokens = 44
// Second run follow-up (~20 tokens):
//   n_past + nTokens = 244 + ~20 = ~264 >= 256 (outer condition)
//   leftTokens = 244 - 44 - 64 = 136 >= 0
//   n_past + nTokens - n_discarded = ~264 - 64 = ~200 < 256
// :> discards n_discarded (64) tokens after first message
test('Cached follow-up discards middle tokens to fit new message', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const cachePath = path.join(
    (await ensureModel({ modelName: DEFAULT_MODEL.name, downloadUrl: DEFAULT_MODEL.url }))[1],
    'sliding-prefill-branch1.bin'
  )

  const { model, logs } = await setupModel(t, {
    n_predict: '200',
    n_discarded: '64'
  })

  // First run: accumulate n_past with cache
  const first = await runAndCollect(model, buildPrompt(cachePath, STORY_PROMPT))
  t.is(first.stats.promptTokens, PROMPT_TOKENS, 'first run: prompt tokens match')
  t.ok(first.stats.generatedTokens > 0, 'first run: generated output')

  const generationSlides = countDiscardLogs(logs)

  // Second run: follow-up message triggers prefill discard
  const second = await runAndCollect(model, buildPrompt(cachePath, [FOLLOW_UP_MSG]))
  t.ok(second.stats.generatedTokens > 0, 'second run: generated output after prefill discard')

  const prefillDiscards = countPrefillDiscardLogs(logs)
  t.ok(prefillDiscards > 0, 'prefill discard log appeared')

  const totalDiscards = countDiscardLogs(logs)
  t.ok(totalDiscards >= generationSlides, 'total discards include prefill discard')
})

// n_discarded=250 (clamped to 211), n_predict=200
// First run: n_past = 244, firstMsgTokens = 44, n_discarded = 211
// Second run follow-up (~20 tokens):
//   leftTokens = 244 - 44 - 211 = -11 < 0
//   firstMsgTokens + nTokens = 44 + ~20 = ~64 < 256
//   n_discarded = 211 > 0
// :> removes all middle tokens from pos 44 to 244
test('Cached follow-up clears all middle tokens when discard window is exhausted', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const cachePath = path.join(
    (await ensureModel({ modelName: DEFAULT_MODEL.name, downloadUrl: DEFAULT_MODEL.url }))[1],
    'sliding-prefill-branch2.bin'
  )

  const { model, logs } = await setupModel(t, {
    n_predict: '200',
    n_discarded: '250'
  })

  // First run: accumulate n_past with cache
  const first = await runAndCollect(model, buildPrompt(cachePath, STORY_PROMPT))
  t.is(first.stats.promptTokens, PROMPT_TOKENS, 'first run: prompt tokens match')
  t.ok(first.stats.generatedTokens > 0, 'first run: generated output')

  // Second run: follow-up triggers full middle token discard
  const second = await runAndCollect(model, buildPrompt(cachePath, [FOLLOW_UP_MSG]))
  t.ok(second.stats.generatedTokens > 0, 'second run: generated output after full middle token discard')

  const prefillDiscards = countPrefillDiscardLogs(logs)
  t.ok(prefillDiscards > 0, 'prefill discard log appeared')
})

// n_discarded=0, n_predict=200
// First run: n_past = 244, firstMsgTokens = 44, n_discarded = 0
// Second run follow-up (~20 tokens):
//   n_past + nTokens = ~264 >= 256 (outer condition)
//   leftTokens = 244 - 44 - 0 = 200 >= 0
//   normal discard: n_past + nTokens - 0 = ~264 >= 256 (fails)
//   full middle discard: leftTokens >= 0 (first condition fails)
// :> no recovery possible, throws ContextOverflow
test('Cached follow-up overflows when sliding is disabled and context is full', {
  timeout: 900_000,
  skip: isWindowsX64 // TODO: unskip this once we have a new Windows runner with a GPU
}, async t => {
  const cachePath = path.join(
    (await ensureModel({ modelName: DEFAULT_MODEL.name, downloadUrl: DEFAULT_MODEL.url }))[1],
    'sliding-prefill-branch3.bin'
  )

  const { model, logs } = await setupModel(t, {
    n_predict: '200',
    n_discarded: '0'
  })

  // First run: accumulate n_past with cache (no overflow since 244 < 256)
  const first = await runAndCollect(model, buildPrompt(cachePath, STORY_PROMPT))
  t.is(first.stats.promptTokens, PROMPT_TOKENS, 'first run: prompt tokens match')
  t.ok(first.stats.generatedTokens > 0, 'first run: generated output')

  // Second run: follow-up triggers context overflow (no discard possible)
  try {
    await runAndCollect(model, buildPrompt(cachePath, [FOLLOW_UP_MSG]))
    t.fail('expected context overflow error but follow-up completed without error')
  } catch (err) {
    const msg = err?.message || String(err)
    t.ok(
      /context|overflow/i.test(msg),
      `context overflow error surfaced: "${msg.slice(0, 120)}"`
    )
  }

  t.is(countPrefillDiscardLogs(logs), 0, 'no prefill discard logs when n_discarded=0')

  // sleep for 10 seconds to allow the model to cleanup
  await new Promise(resolve => setTimeout(resolve, 10000))
})
