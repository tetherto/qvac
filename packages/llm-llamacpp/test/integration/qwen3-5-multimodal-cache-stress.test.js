'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const {
  cleanupIntegrationCacheFiles,
  ensureModelPath,
  getMediaPath,
  safeTest
} = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isLinuxX64 = platform === 'linux' && arch === 'x64'
const forceStress = process.env.QVAC_RUN_QWEN35_MTMD_STRESS === '1'
const skipStress = !forceStress && !isLinuxX64
  ? 'Qwen3.5 multimodal cache stress is Linux x64 by default; set QVAC_RUN_QWEN35_MTMD_STRESS=1 to force it'
  : false

const CTX_SIZE = 8192
const N_DISCARDED = 256

const QWEN35_MODEL = {
  modelName: 'Qwen3.5-0.8B-Q8_0.gguf',
  downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}

const QWEN35_MMPROJ = {
  modelName: 'mmproj-Qwen3.5-0.8B-F16.gguf',
  downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf'
}

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

function toNumber (value) {
  return typeof value === 'number' ? value : Number(value || 0)
}

function isCancellationError (err) {
  if (!err) return false
  return /cancel|aborted|stopp?ed/i.test(err.message || String(err))
}

function repeatWord (word, count) {
  return Array.from({ length: count }, () => word).join(' ')
}

function makeImageTurn (imageBytes) {
  return [
    { role: 'system', content: 'You are a visual chat assistant. Answer plainly and keep going until the requested list is complete.' },
    { role: 'user', type: 'media', content: imageBytes },
    {
      role: 'user',
      content: 'Describe the image briefly, then list the numbers from 1 to 500 separated by commas. Do not stop early.'
    }
  ]
}

function makePrefillPressureTurn (cacheTokens) {
  const freeSlots = Math.max(0, CTX_SIZE - toNumber(cacheTokens))
  const wordCount = Math.max(512, Math.min(4600, freeSlots + Math.floor(N_DISCARDED / 2)))
  return makeLongTextTurn(wordCount)
}

function makeCancelPrefillTurn () {
  return makeLongTextTurn(96)
}

function makeLongTextTurn (wordCount) {
  return [
    {
      role: 'user',
      content: [
        'Store this long note in the cached conversation. It intentionally fills the remaining context window.',
        repeatWord('detail', wordCount),
        'End of long note.'
      ].join(' ')
    }
  ]
}

function makeShortDecodeTurn () {
  return [
    {
      role: 'user',
      content: 'Continue with a long comma-separated count from 1 to 400. Keep going.'
    }
  ]
}

async function setupModel (t) {
  const modelPath = await ensureModelPath(QWEN35_MODEL)
  const projectionModelPath = await ensureModelPath(QWEN35_MMPROJ)

  const addon = new LlmLlamacpp({
    files: { model: [modelPath], projectionModel: projectionModelPath },
    config: {
      device: 'gpu',
      gpu_layers: '98',
      ctx_size: String(CTX_SIZE),
      n_predict: '512',
      n_discarded: String(N_DISCARDED),
      temp: '0',
      seed: '42',
      'reasoning-budget': '0',
      verbosity: '2'
    },
    logger: createLogger(),
    opts: { stats: true }
  })

  await addon.load()

  t.teardown(async () => {
    await addon.unload().catch(() => {})
  })

  return addon
}

async function runAndCollect (addon, prompt, runOptions = {}) {
  const response = await addon.run(prompt, runOptions)
  const chunks = []
  let error = null

  let chain = response.onUpdate(data => {
    chunks.push(data)
  })

  if (typeof response.onError === 'function') {
    chain = chain.onError(err => {
      error = err
    })
  }

  const ticker = setInterval(() => {}, 50)
  try {
    await chain.await()
  } finally {
    clearInterval(ticker)
  }

  if (error) throw error
  return {
    response,
    text: chunks.join(''),
    stats: response.stats || {}
  }
}

async function cancelResponse (addon, response) {
  if (response && typeof response.cancel === 'function') {
    await response.cancel()
    return
  }
  await addon.cancel()
}

async function runAndCancelImmediately (addon, prompt, runOptions = {}) {
  const response = await addon.run(prompt, runOptions)
  await cancelResponse(addon, response)
  try {
    await response.await()
  } catch (err) {
    if (!isCancellationError(err)) throw err
  }
  return response.stats || {}
}

async function runAndCancelAfterFirstChunk (addon, prompt, runOptions = {}) {
  const response = await addon.run(prompt, runOptions)
  let chunkCount = 0
  let cancelPromise = null

  let chain = response.onUpdate(() => {
    chunkCount++
    if (!cancelPromise) {
      cancelPromise = cancelResponse(addon, response)
    }
  })

  if (typeof response.onError === 'function') {
    chain = chain.onError(err => {
      if (!isCancellationError(err)) throw err
    })
  }

  try {
    await chain.await()
  } catch (err) {
    if (!isCancellationError(err)) throw err
  }

  if (cancelPromise) await cancelPromise
  return {
    chunkCount,
    stats: response.stats || {}
  }
}

function assertCachedStats (t, stats, label) {
  const cacheTokens = toNumber(stats.CacheTokens)
  t.ok(cacheTokens > 0, `${label}: CacheTokens should stay populated (${cacheTokens})`)
  t.ok(cacheTokens <= CTX_SIZE, `${label}: CacheTokens should stay within ctx (${cacheTokens} <= ${CTX_SIZE})`)
}

safeTest('Qwen3.5-VL cached chat stresses sliding and cancel recovery', {
  timeout: 2_400_000,
  skip: skipStress
}, async t => {
  const imagePath = getMediaPath('fruitPlate.png')
  t.ok(fs.existsSync(imagePath), 'fruitPlate.png image fixture should exist')

  const imageBytes = new Uint8Array(fs.readFileSync(imagePath))
  const addon = await setupModel(t)
  const cachePath = path.join(os.tmpdir(), `qwen35-mtmd-cache-stress-${Date.now()}.bin`)
  cleanupIntegrationCacheFiles(cachePath)
  t.teardown(() => {
    try {
      fs.unlinkSync(cachePath)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  })

  const cacheOpts = { cacheKey: cachePath, saveCacheToDisk: true }

  const first = await runAndCollect(
    addon,
    makeImageTurn(imageBytes),
    {
      ...cacheOpts,
      generationParams: { predict: 384 }
    }
  )
  t.ok(first.text.length > 0, 'first multimodal turn generated output')
  t.ok(toNumber(first.stats.generatedTokens) > N_DISCARDED, `first turn generated enough disposable tokens (${first.stats.generatedTokens})`)
  t.ok(toNumber(first.stats.CacheTokens) > 4000, `first turn cached Qwen3.5 image cells (${first.stats.CacheTokens})`)
  assertCachedStats(t, first.stats, 'first multimodal turn')
  t.ok(fs.existsSync(cachePath), 'first turn saved cache to disk')

  const prefillSlide = await runAndCollect(
    addon,
    makePrefillPressureTurn(first.stats.CacheTokens),
    {
      ...cacheOpts,
      prefill: true
    }
  )
  t.is(prefillSlide.text, '', 'prefill stress run emits no text')
  t.is(toNumber(prefillSlide.stats.generatedTokens), 0, 'prefill stress run reports zero generated tokens')
  t.ok(toNumber(prefillSlide.stats.contextSlides) > 0, `prefill stress run triggered context sliding (${prefillSlide.stats.contextSlides})`)
  assertCachedStats(t, prefillSlide.stats, 'prefill stress run')

  const decodeSlide = await runAndCollect(
    addon,
    makeShortDecodeTurn(),
    {
      ...cacheOpts,
      generationParams: { predict: 256 }
    }
  )
  t.ok(decodeSlide.text.length > 0, 'decode stress run generated output')
  t.ok(toNumber(decodeSlide.stats.generatedTokens) > 0, 'decode stress run reports generated tokens')
  t.ok(toNumber(decodeSlide.stats.contextSlides) > 0, `decode stress run triggered generation sliding (${decodeSlide.stats.contextSlides})`)
  assertCachedStats(t, decodeSlide.stats, 'decode stress run')

  const canceledPrefillStats = await runAndCancelImmediately(
    addon,
    makeCancelPrefillTurn(),
    {
      ...cacheOpts,
      prefill: true
    }
  )
  t.ok(toNumber(canceledPrefillStats.CacheTokens) >= 0, 'cancel during prefill returned sane stats')

  const afterPrefillCancel = await runAndCollect(
    addon,
    [{ role: 'user', content: 'After the canceled prefill, answer with one short sentence.' }],
    {
      ...cacheOpts,
      generationParams: { predict: 64 }
    }
  )
  t.ok(afterPrefillCancel.text.length > 0, 'chat recovered after cancel during prefill')
  assertCachedStats(t, afterPrefillCancel.stats, 'after prefill cancel')

  const canceledDecode = await runAndCancelAfterFirstChunk(
    addon,
    makeShortDecodeTurn(),
    {
      ...cacheOpts,
      generationParams: { predict: 256 }
    }
  )
  t.ok(canceledDecode.chunkCount > 0, 'cancel during decoding happened after at least one chunk')

  const afterDecodeCancel = await runAndCollect(
    addon,
    [{ role: 'user', content: 'After the canceled decode, continue normally with a concise answer.' }],
    {
      ...cacheOpts,
      generationParams: { predict: 64 }
    }
  )
  t.ok(afterDecodeCancel.text.length > 0, 'chat recovered after cancel during decoding')
  assertCachedStats(t, afterDecodeCancel.stats, 'after decode cancel')
})
