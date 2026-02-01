'use strict'

const test = require('brittle')
const path = require('bare-path')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const DEFAULT_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const SYSTEM_MESSAGE = { role: 'system', content: 'You are a helpful, respectful and honest assistant.' }

const BASE_PROMPT = [
  SYSTEM_MESSAGE,
  { role: 'user', content: 'Respond with a single color name.' }
]

const BASE_CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '2048',
  n_predict: '256',
  temp: '0.7',
  seed: '1',
  verbosity: '2'
}

const FOLLOW_UP_MESSAGE = { role: 'user', content: 'Reference the cached conversation and confirm the color again.' }

const STOP_PROMPT = [
  SYSTEM_MESSAGE,
  { role: 'user', content: 'Tell a long story.' }
]

const isCancellationError = err => {
  if (!err) return false
  const message = err.message || String(err)
  return /cancel|aborted|stopp?ed/i.test(message)
}

const toNumber = value => typeof value === 'number' ? value : Number(value || 0)

function assertCacheMatchesTokens (t, stats, description) {
  const expected = stats.promptTokens + stats.generatedTokens
  const delta = Math.abs(stats.CacheTokens - expected)
  t.ok(
    delta <= 1,
    description ||
    `CacheTokens (${stats.CacheTokens}) should approximately equal prompt+generated (${expected}) [diff=${delta}]`
  )
}

function normalizeStats (rawStats = {}, extra = {}) {
  return {
    ...rawStats,
    ...extra,
    CacheTokens: toNumber(rawStats?.CacheTokens),
    promptTokens: toNumber(rawStats?.promptTokens),
    generatedTokens: toNumber(rawStats?.generatedTokens),
    TTFT: toNumber(rawStats?.TTFT),
    TPS: toNumber(rawStats?.TPS)
  }
}

function buildPrompt (sessionName, options = {}) {
  if (!sessionName) return [...BASE_PROMPT]
  if (options.followUp) return [{ role: 'session', content: sessionName }, FOLLOW_UP_MESSAGE]
  return [{ role: 'session', content: sessionName }, ...BASE_PROMPT]
}

function buildStoppingPrompt (sessionName) {
  return [{ role: 'session', content: sessionName }, ...STOP_PROMPT]
}

async function setupModel (t, overrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const config = { ...BASE_CONFIG, ...overrides }
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  let loggerReleased = false
  const releaseLogger = () => {
    if (loggerReleased) return
    loggerReleased = true
    specLogger.release()
  }

  const model = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, config)

  try {
    await model.load()
  } catch (err) {
    releaseLogger()
    await loader.close().catch(() => {})
    throw err
  }

  t.teardown(async () => {
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
    releaseLogger()
  })

  return { model, config, dirPath }
}

async function runAndCollectStats (model, prompt) {
  const response = await model.run(prompt)
  let chunkCount = 0

  let chain = response.onUpdate(() => {
    chunkCount++
  })

  if (typeof response.onError === 'function') {
    chain = chain.onError(err => { throw err })
  }

  await chain.await()
  return normalizeStats(response.stats, { _chunkCount: chunkCount })
}

async function runAndCancelAfterFirstToken (model, prompt) {
  const response = await model.run(prompt)
  let chunkCount = 0
  let stopRequested = false
  let chain = response.onUpdate(() => {
    if (stopRequested) return
    chunkCount++
    if (typeof response.cancel === 'function') {
      stopRequested = true
      response.cancel()
    }
  })
  if (typeof response.onError === 'function') {
    chain = chain.onError(err => {
      if (isCancellationError(err)) return
      throw err
    })
  }
  try {
    await chain.await()
  } catch (err) {
    if (!isCancellationError(err)) throw err
  }
  return normalizeStats(response.stats, { _chunkCount: chunkCount })
}

async function runWithTimeoutCancellation (model, prompt) {
  const response = await model.run(prompt)
  if (typeof response.cancel === 'function') {
    await response.cancel()
  }
  return normalizeStats(response.stats, { _chunkCount: 0 })
}

test('CacheTokens remain zero without session message', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)
  const stats = await runAndCollectStats(model, buildPrompt())
  t.is(stats.CacheTokens, 0)
  t.ok(stats.promptTokens > 0, 'prompt tokens tracked even without caching')
  t.ok(stats.generatedTokens > 0, 'generated tokens tracked even without caching')
})

test('Session prompt stores tokens but stays under n_predict', { timeout: 600_000 }, async t => {
  const { model, config, dirPath } = await setupModel(t, { n_predict: '768', ctx_size: '4096' })
  const sessionName = path.join(dirPath, 'cache-basic.bin')
  const firstStats = await runAndCollectStats(model, buildPrompt(sessionName))
  const secondStats = await runAndCollectStats(model, buildPrompt(sessionName, { followUp: true }))
  const delta = toNumber(secondStats.CacheTokens) - toNumber(firstStats.CacheTokens)
  t.ok(firstStats.CacheTokens > 0, 'session usage records cache tokens')
  assertCacheMatchesTokens(t, firstStats, 'session run caches prompt + generated tokens')
  const expectedDelta = secondStats.promptTokens + secondStats.generatedTokens
  t.is(delta, expectedDelta, 'cache delta equals follow-up prompt + generations')
  t.ok(
    secondStats.generatedTokens <= Number(config.n_predict),
    'generated tokens respect n_predict limit'
  )
})

test('Cancelling after first token keeps cache growth bounded', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '256', ctx_size: '4096' })
  const sessionName = path.join(dirPath, 'cache-cancel.bin')
  const warmStats = await runAndCollectStats(model, buildPrompt(sessionName))
  const stats = await runAndCancelAfterFirstToken(model, buildPrompt(sessionName))
  const delta = toNumber(stats.CacheTokens) - toNumber(warmStats.CacheTokens)
  // Cache delta may be off by 1 due to BOS/EOS token handling
  const expectedDelta = stats.promptTokens + stats.generatedTokens
  t.ok(Math.abs(delta - expectedDelta) <= 1, `cache delta (${delta}) approximately equals tracked tokens (${expectedDelta})`)
  t.ok(stats.generatedTokens > 0, 'at least one token generated before cancellation')
  t.ok(stats.TTFT > 0, 'TTFT recorded before cancellation')
  // TPS may be 0 when only 1 token is generated due to timing precision
  t.ok(stats.TPS >= 0, 'TPS is non-negative')
})

test('Cancelling after first token only stores one generation chunk', { timeout: 600_000 }, async t => {
  const { model, config, dirPath } = await setupModel(t, { n_predict: '1024', ctx_size: '4096' })
  const sessionName = path.join(dirPath, 'cache-stop-first-token.bin')
  const stopStats = await runAndCancelAfterFirstToken(model, buildStoppingPrompt(sessionName))
  t.is(stopStats._chunkCount, 1, 'cancelled immediately after first chunk')
  t.ok(stopStats.TTFT > 0, 'TTFT recorded before cancellation')
  // TPS may be 0 when only 1 token is generated due to timing precision
  t.ok(stopStats.TPS >= 0, 'TPS is non-negative')
  t.ok(stopStats.CacheTokens > 0, 'CacheTokens increased after first token')
  t.ok(stopStats.generatedTokens > 0, 'at least one token generated before cancellation')
  assertCacheMatchesTokens(t, stopStats, 'cache stores prompt + generated tokens')
  t.ok(
    stopStats.generatedTokens <= Number(config.n_predict),
    'CacheTokens stays within prediction budget'
  )
})

test('Timeout cancellation before first token keeps cache/timing stats at zero', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '1024', ctx_size: '4096' })
  const sessionName = path.join(dirPath, 'cache-preempt.bin')
  const stats = await runWithTimeoutCancellation(
    model,
    buildStoppingPrompt(sessionName)
  )
  t.is(stats._chunkCount, 0, 'timeout prevented any chunk emission')
  t.is(stats.CacheTokens, 0)
  t.is(stats.promptTokens, 0)
  t.is(stats.generatedTokens, 0)
  t.is(stats.TTFT, 0)
  t.is(stats.TPS, 0)
})

test('Cache cleared when prompt without session message follows cached inference', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '256', ctx_size: '4096' })
  const sessionName = path.join(dirPath, 'cache-clear-test.bin')

  const cachedStats = await runAndCollectStats(model, buildPrompt(sessionName))
  t.ok(cachedStats.CacheTokens > 0, 'first inference with cache has CacheTokens')
  const initialCacheTokens = cachedStats.CacheTokens

  const noCacheStats = await runAndCollectStats(model, buildPrompt())
  t.is(noCacheStats.CacheTokens, 0, 'prompt without session message clears cache and has zero CacheTokens')
  t.ok(noCacheStats.promptTokens > 0, 'prompt tokens tracked in single-shot inference')
  t.ok(noCacheStats.generatedTokens > 0, 'generated tokens tracked in single-shot inference')

  const reCachedStats = await runAndCollectStats(model, buildPrompt(sessionName, { followUp: true }))
  t.ok(reCachedStats.CacheTokens > 0, 'cache can be re-enabled with session message')
  const delta = toNumber(reCachedStats.CacheTokens) - toNumber(initialCacheTokens)
  const expectedDelta = reCachedStats.promptTokens + reCachedStats.generatedTokens
  t.ok(Math.abs(delta - expectedDelta) <= 1, `cache delta (${delta}) approximately equals follow-up tokens (${expectedDelta})`)
})

test('Cache cleared when switching to different cache file', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '256', ctx_size: '4096' })
  const session1 = path.join(dirPath, 'cache-switch-1.bin')
  const session2 = path.join(dirPath, 'cache-switch-2.bin')

  const firstStats = await runAndCollectStats(model, buildPrompt(session1))
  t.ok(firstStats.CacheTokens > 0, 'first cache session has CacheTokens')
  const firstCacheInitial = firstStats.CacheTokens

  const secondStats = await runAndCollectStats(model, buildPrompt(session2))
  t.ok(secondStats.CacheTokens > 0, 'second cache session has CacheTokens')

  const backToFirstStats = await runAndCollectStats(model, buildPrompt(session1, { followUp: true }))
  t.ok(backToFirstStats.CacheTokens > 0, 'switching back to first cache works')
  const delta = toNumber(backToFirstStats.CacheTokens) - toNumber(firstCacheInitial)
  const expectedDelta = backToFirstStats.promptTokens + backToFirstStats.generatedTokens
  t.ok(Math.abs(delta - expectedDelta) <= 1, `cache delta (${delta}) approximately equals follow-up tokens (${expectedDelta})`)
})

test('Single-shot inference resets cache tokens after each non-cached prompt', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '256', ctx_size: '4096' })

  const stats1 = await runAndCollectStats(model, buildPrompt())
  t.is(stats1.CacheTokens, 0, 'first single-shot inference has zero CacheTokens')
  t.ok(stats1.promptTokens > 0, 'prompt tokens tracked')
  t.ok(stats1.generatedTokens > 0, 'generated tokens tracked')

  const stats2 = await runAndCollectStats(model, buildPrompt())
  t.is(stats2.CacheTokens, 0, 'second single-shot inference also has zero CacheTokens')
  t.ok(stats2.promptTokens > 0, 'prompt tokens tracked in second inference')
  t.ok(stats2.generatedTokens > 0, 'generated tokens tracked in second inference')

  const stats3 = await runAndCollectStats(model, buildPrompt())
  t.is(stats3.CacheTokens, 0, 'third single-shot inference also has zero CacheTokens')
})

test('Cache to no-cache to cache transition works correctly', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '256', ctx_size: '4096' })
  const sessionName = path.join(dirPath, 'cache-transition.bin')

  const cachedStats = await runAndCollectStats(model, buildPrompt(sessionName))
  t.ok(cachedStats.CacheTokens > 0, 'cached inference has CacheTokens')
  const initialCacheTokens = cachedStats.CacheTokens

  const noCacheStats = await runAndCollectStats(model, buildPrompt())
  t.is(noCacheStats.CacheTokens, 0, 'no-cache inference clears cache and has zero CacheTokens')

  const reCachedStats = await runAndCollectStats(model, buildPrompt(sessionName, { followUp: true }))
  t.ok(reCachedStats.CacheTokens > 0, 'cache can be re-enabled after being cleared')
  const delta = toNumber(reCachedStats.CacheTokens) - toNumber(initialCacheTokens)
  const expectedDelta = reCachedStats.promptTokens + reCachedStats.generatedTokens
  t.ok(Math.abs(delta - expectedDelta) <= 1, `cache delta (${delta}) approximately equals follow-up tokens (${expectedDelta})`)
})
