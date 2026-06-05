'use strict'

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { cleanupIntegrationCacheFiles, ensureModel, safeTest } = require('./utils')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isWindowsX64 = platform === 'win32' && arch === 'x64'
const useCpu = isDarwinX64 || isLinuxArm64

// These are very slow on CI and should be skipped.
// TODO: unskip Windows once we have a new Windows runner with a GPU
const skip = isWindowsX64 || isLinuxArm64

const DEFAULT_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

// ── Constants ────────────────────────────────────────────────────────────────
// llama.cpp pads the requested ctx_size up to the next multiple of 256 via
// GGML_PAD(cparams.n_ctx, 256), so the effective n_ctx the slider sees is 512.
// PROMPT_TOKENS is the chat-template wrapper around STORY_PROMPT (Llama 3.2 1B).
const N_CTX = 512
const PROMPT_TOKENS = 64
const FREE_SLOTS = N_CTX - PROMPT_TOKENS // 448
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

  const modelPath = path.join(dirPath, modelName)

  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: String(N_CTX),
    n_predict: '512',
    temp: '0.9',
    top_p: '0.95',
    seed: '42',
    verbosity: '2'
  }

  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: { ...baseConfig, ...overrides },
    logger: createTestLogger(),
    opts: { stats: true }
  })

  await model.load()

  t.teardown(async () => {
    // Guard against model.unload() hanging after context overflow (seen on darwin-arm64 CI).
    // If unload doesn't complete within 30s, continue cleanup to avoid blocking the suite.
    const unloadDone = model.unload().catch(() => {})
    const unloadTimeout = new Promise(resolve => setTimeout(resolve, 30_000))
    await Promise.race([unloadDone, unloadTimeout])
  })

  return { model, dirPath }
}

async function runAndCollect (model, prompt, runOptions) {
  const response = await model.run(prompt, runOptions)
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
  return { text: chunks.join(''), stats: response.stats }
}

function cacheOpts (sessionPath) {
  if (!sessionPath) return undefined
  return { cacheKey: sessionPath }
}

function expectedSlides (nPredict, nDiscarded) {
  if (nDiscarded <= 0) return 0
  const extra = nPredict - FREE_SLOTS
  if (extra <= 0) return 0
  const clampedDiscard = Math.min(nDiscarded, FREE_SLOTS - 1)
  return Math.ceil(extra / clampedDiscard)
}

// n_discarded=32, n_predict=SLIDE_PREDICT
safeTest('Basic generation sliding', {
  timeout: 900_000,
  skip
}, async t => {
  const { model } = await setupModel(t, {
    n_predict: String(SLIDE_PREDICT),
    n_discarded: '32'
  })

  const { stats } = await runAndCollect(model, STORY_PROMPT)

  t.is(stats.promptTokens, PROMPT_TOKENS, `prompt tokenizes to ${PROMPT_TOKENS} tokens`)
  t.is(stats.generatedTokens, SLIDE_PREDICT, 'model generated exactly n_predict tokens')
  t.is(
    stats.contextSlides,
    expectedSlides(SLIDE_PREDICT, 32),
    'slide count matches expected n_predict / n_discarded'
  )
})

// n_discarded=0, n_predict=SLIDE_PREDICT
safeTest('Generation fails with context overflow when sliding disabled', {
  timeout: 900_000,
  skip
}, async t => {
  const { model } = await setupModel(t, {
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

  // sleep for 10 seconds to allow the model to cleanup
  await new Promise(resolve => setTimeout(resolve, 10000))
})

// n_discarded=16, n_predict=MANY_SLIDES_PREDICT
safeTest('Many slides with small n_discarded', {
  timeout: 900_000,
  skip
}, async t => {
  const { model } = await setupModel(t, {
    n_predict: String(MANY_SLIDES_PREDICT),
    n_discarded: '16'
  })

  const { stats } = await runAndCollect(model, STORY_PROMPT)

  t.is(stats.promptTokens, PROMPT_TOKENS, `prompt tokenizes to ${PROMPT_TOKENS} tokens`)
  t.is(stats.generatedTokens, MANY_SLIDES_PREDICT, 'model generated exactly n_predict tokens')
  t.is(
    stats.contextSlides,
    expectedSlides(MANY_SLIDES_PREDICT, 16),
    'slide count matches expected n_predict / n_discarded'
  )
})

// n_discarded=99999, clamped to FREE_SLOTS - 1
safeTest('Large n_discarded is clamped to fit available context space', {
  timeout: 900_000,
  skip
}, async t => {
  const { model } = await setupModel(t, {
    n_predict: String(SLIDE_PREDICT),
    n_discarded: '99999'
  })

  const { stats } = await runAndCollect(model, STORY_PROMPT)

  t.is(stats.promptTokens, PROMPT_TOKENS, `prompt tokenizes to ${PROMPT_TOKENS} tokens`)
  t.is(stats.generatedTokens, SLIDE_PREDICT, 'model generated exactly n_predict tokens')
  t.is(
    stats.contextSlides,
    expectedSlides(SLIDE_PREDICT, 99999),
    'slide count matches expected n_predict / clamped n_discarded'
  )
})

// n_discarded=1, n_predict=SLIDE_PREDICT
safeTest('Sliding context works with minimal n_discarded of 1', {
  timeout: 900_000,
  skip
}, async t => {
  const { model } = await setupModel(t, {
    n_predict: String(SLIDE_PREDICT),
    n_discarded: '1'
  })

  const { stats } = await runAndCollect(model, STORY_PROMPT)

  t.is(stats.promptTokens, PROMPT_TOKENS, `prompt tokenizes to ${PROMPT_TOKENS} tokens`)
  t.is(stats.generatedTokens, SLIDE_PREDICT, 'model generated exactly n_predict tokens')
  t.is(
    stats.contextSlides,
    expectedSlides(SLIDE_PREDICT, 1),
    'slide count matches expected n_predict / n_discarded'
  )
})

// n_discarded=64, n_predict=430 (first run), predict=10 (second run)
// First run: n_past = 64 + 430 = 494, firstMsgTokens = 64
// Second run follow-up (~20 tokens):
//   n_past + nTokens = 494 + ~20 = ~514 >= 512 (outer condition)
//   leftTokens = 494 - 64 - 64 = 366 >= 0
//   n_past + nTokens - n_discarded = ~514 - 64 = ~450 < 512
// :> discards n_discarded (64) tokens after first message
// Second run uses predict=10 via generationParams so generation can't
// reach the context limit — any contextSlides must come from prefill.
safeTest('Cached follow-up discards middle tokens to fit new message', {
  timeout: 900_000,
  skip
}, async t => {
  const cachePath = path.join(
    (await ensureModel({ modelName: DEFAULT_MODEL.name, downloadUrl: DEFAULT_MODEL.url }))[1],
    'sliding-prefill-branch1.bin'
  )
  cleanupIntegrationCacheFiles(cachePath)

  const { model } = await setupModel(t, {
    n_predict: '430',
    n_discarded: '64'
  })

  const opts = cacheOpts(cachePath)

  // First run: accumulate n_past with cache
  const first = await runAndCollect(model, STORY_PROMPT, opts)
  t.is(first.stats.promptTokens, PROMPT_TOKENS, 'first run: prompt tokens match')
  t.ok(first.stats.generatedTokens > 0, 'first run: generated output')
  t.is(first.stats.contextSlides, 0, 'first run: no slides (n_past 494 < n_ctx 512)')

  // Second run: low predict so only prefill discard can cause slides
  // After prefill discard: n_past ~430, generate 10 → ~440 < 512 (no generation sliding)
  const second = await runAndCollect(
    model,
    [FOLLOW_UP_MSG],
    { ...opts, generationParams: { predict: 10 } }
  )
  t.ok(second.stats.generatedTokens > 0, 'second run: generated output after prefill discard')
  t.is(second.stats.contextSlides, 1, 'exactly one prefill discard slide')
})

// n_discarded=450 (clamped to FREE_SLOTS-1 = 447), n_predict=430 (first run), predict=10 (second run)
// First run: n_past = 494, firstMsgTokens = 64, n_discarded = 447
// Second run follow-up (~20 tokens):
//   leftTokens = 494 - 64 - 447 = -17 < 0
//   firstMsgTokens + nTokens = 64 + ~20 = ~84 < 512
//   n_discarded = 447 > 0
// :> removes all middle tokens from pos 64 to 494
// Second run uses predict=10 so generation can't cause slides.
safeTest('Cached follow-up clears all middle tokens when discard window is exhausted', {
  timeout: 900_000,
  skip
}, async t => {
  const cachePath = path.join(
    (await ensureModel({ modelName: DEFAULT_MODEL.name, downloadUrl: DEFAULT_MODEL.url }))[1],
    'sliding-prefill-branch2.bin'
  )
  cleanupIntegrationCacheFiles(cachePath)

  const { model } = await setupModel(t, {
    n_predict: '430',
    n_discarded: '450'
  })

  const opts = cacheOpts(cachePath)

  // First run: accumulate n_past with cache
  const first = await runAndCollect(model, STORY_PROMPT, opts)
  t.is(first.stats.promptTokens, PROMPT_TOKENS, 'first run: prompt tokens match')
  t.ok(first.stats.generatedTokens > 0, 'first run: generated output')
  t.is(first.stats.contextSlides, 0, 'first run: no slides (n_past 494 < n_ctx 512)')

  // Second run: low predict so only prefill full-middle-discard can cause slides
  // After discard: n_past = 64 (firstMsgTokens), generate 10 → 74 < 512
  const second = await runAndCollect(
    model,
    [FOLLOW_UP_MSG],
    { ...opts, generationParams: { predict: 10 } }
  )
  t.ok(second.stats.generatedTokens > 0, 'second run: generated output after full middle token discard')
  t.is(second.stats.contextSlides, 1, 'exactly one full middle token discard slide')
})

// n_discarded=0, n_predict=430
// First run: n_past = 494, firstMsgTokens = 64, n_discarded = 0
// Second run follow-up (~20 tokens):
//   n_past + nTokens = ~514 >= 512 (outer condition)
//   leftTokens = 494 - 64 - 0 = 430 >= 0
//   normal discard: discard > 0 fails
//   full middle discard: leftTokens >= 0 (first condition fails)
// :> no recovery possible, throws ContextOverflow
safeTest('Cached follow-up overflows when sliding is disabled and context is full', {
  timeout: 900_000,
  skip
}, async t => {
  const cachePath = path.join(
    (await ensureModel({ modelName: DEFAULT_MODEL.name, downloadUrl: DEFAULT_MODEL.url }))[1],
    'sliding-prefill-branch3.bin'
  )
  cleanupIntegrationCacheFiles(cachePath)

  const { model } = await setupModel(t, {
    n_predict: '430',
    n_discarded: '0'
  })

  const opts = cacheOpts(cachePath)

  // First run: accumulate n_past with cache (no overflow since 494 < 512)
  const first = await runAndCollect(model, STORY_PROMPT, opts)
  t.is(first.stats.promptTokens, PROMPT_TOKENS, 'first run: prompt tokens match')
  t.ok(first.stats.generatedTokens > 0, 'first run: generated output')
  t.is(first.stats.contextSlides, 0, 'first run: no slides when n_discarded=0')

  // Second run: follow-up triggers context overflow (no discard possible)
  try {
    await runAndCollect(model, [FOLLOW_UP_MSG], opts)
    t.fail('expected context overflow error but follow-up completed without error')
  } catch (err) {
    const msg = err?.message || String(err)
    t.ok(
      /context|overflow/i.test(msg),
      `context overflow error surfaced: "${msg.slice(0, 120)}"`
    )
  }

  // sleep for 10 seconds to allow the model to cleanup
  await new Promise(resolve => setTimeout(resolve, 10000))
})
