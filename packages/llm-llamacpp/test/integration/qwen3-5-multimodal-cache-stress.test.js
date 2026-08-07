'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const { cleanupIntegrationCacheFiles, ensureModelPath, getMediaPath, safeTest } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isLinuxX64 = platform === 'linux' && arch === 'x64'
const forceStress = process.env.QVAC_RUN_QWEN35_MTMD_STRESS === '1'
const skipStress =
  !forceStress && !isLinuxX64
    ? 'Qwen3.5 multimodal cache stress is Linux x64 by default; set QVAC_RUN_QWEN35_MTMD_STRESS=1 to force it'
    : false

const CTX_SIZE = 8192
const N_DISCARDED = 1024
const CONTROLLED_PREFILL_COARSE_WORDS = 384
const CONTROLLED_PREFILL_FINE_WORDS = 1
const MAX_CONTROLLED_PREFILLS = 96
// Cancel has to land while prefill is still running. Multimodal prefill of one
// image + a short text turn completes in well under a second on Linux x64 GPU
// (where this suite primarily runs), so a 1500ms delay let prefill finish first
// and the cancel never fired. 150ms is short enough to land mid-prefill on fast
// GPU runners and is still tiny compared to multi-second prefill on slower CPU
// or mobile hosts where this test is occasionally forced via env override.
const PREFILL_CANCEL_DELAY_MS = 150
const MIN_QWEN35_IMAGE_CACHE_TOKENS = 2880

// Model size is selectable so the EOS / generation-length behaviour can be A/B'd
// between the small and larger Qwen3.5-VL checkpoints without re-editing:
//   QVAC_QWEN35_MTMD_SIZE=0.8b (default) | 2b
// The 0.8B model stops generation early (~552 tokens) on the first "write a long
// story" turn, which under-fills the disposable-token budget the sliding
// calibration depends on; this toggle lets a larger model confirm whether that
// early-EOS behaviour is size-specific. Both models + their mmproj are pinned in
// models.manifest.json (ensureModelPath resolves the source from there; the
// downloadUrl here is cosmetic).
//
// Only the 0.8b pair is mobile pre-staged — it is the default and the weekly
// vlmPerfQwen35 shard already carries it. The 2b pair is an explicit local A/B
// opt-in and is never selected on a Device Farm shard:
// prestage-ignore: Qwen3.5-2B-Q8_0.gguf — opt-in via QVAC_QWEN35_MTMD_SIZE=2b only
// prestage-ignore: mmproj-Qwen3.5-2B-F16.gguf — opt-in via QVAC_QWEN35_MTMD_SIZE=2b only
const QWEN35_MTMD_SIZE = (process.env.QVAC_QWEN35_MTMD_SIZE || '0.8b').toLowerCase()

const QWEN35_MODELS = {
  '0.8b': {
    model: {
      modelName: 'Qwen3.5-0.8B-Q8_0.gguf',
      downloadUrl:
        'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
    },
    mmproj: {
      modelName: 'mmproj-Qwen3.5-0.8B-F16.gguf',
      downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf'
    }
  },
  '2b': {
    model: {
      modelName: 'Qwen3.5-2B-Q8_0.gguf',
      downloadUrl:
        'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q8_0.gguf'
    },
    mmproj: {
      modelName: 'mmproj-Qwen3.5-2B-F16.gguf',
      downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/mmproj-F16.gguf'
    }
  }
}

if (!QWEN35_MODELS[QWEN35_MTMD_SIZE]) {
  throw new Error(
    `QVAC_QWEN35_MTMD_SIZE must be one of ${Object.keys(QWEN35_MODELS).join(', ')} (got "${QWEN35_MTMD_SIZE}")`
  )
}

const QWEN35_MODEL = QWEN35_MODELS[QWEN35_MTMD_SIZE].model
const QWEN35_MMPROJ = QWEN35_MODELS[QWEN35_MTMD_SIZE].mmproj

const SYSTEM_PROMPT = {
  role: 'system',
  content:
    'You are a visual chat assistant. Answer plainly and keep going until the requested list is complete.'
}

const NO_CACHE_SEPARATOR_PROMPT = [
  {
    role: 'user',
    content: 'This is an unrelated no-cache separator prompt. Reply with ok.'
  }
]

function createLogger() {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

function toNumber(value) {
  return typeof value === 'number' ? value : Number(value || 0)
}

function isCancellationError(err) {
  if (!err) return false
  return /cancel|aborted|stopp?ed/i.test(err.message || String(err))
}

function repeatWord(word, count) {
  return Array.from({ length: count }, () => word).join(' ')
}

function makeImageTurn(imageBytes) {
  return [
    { role: 'user', type: 'media', content: imageBytes },
    {
      role: 'user',
      content: 'Describe the image in one concise sentence.'
    }
  ]
}

function makeControlledPrefillTurn(wordCount) {
  return [
    {
      role: 'user',
      content: [
        'Controlled cache-pressure chunk.',
        repeatWord('detail', wordCount),
        'End of controlled chunk.'
      ].join(' ')
    }
  ]
}

function makeCancelPrefillTurn(imageBytes) {
  return [
    { role: 'user', type: 'media', content: imageBytes },
    {
      role: 'user',
      content:
        'Use this second image as part of the cached conversation, then stop if cancellation is requested.'
    }
  ]
}

function makeFixedImagePrefillTurn(imageBytes, label) {
  return [
    { role: 'user', type: 'media', content: imageBytes },
    {
      role: 'user',
      content: `Image prefill ${label}: reply with one word.`
    }
  ]
}

function makeShortDecodeTurn() {
  return [
    {
      role: 'user',
      content: 'Continue with a long comma-separated count from 1 to 400. Keep going.'
    }
  ]
}

async function setupModel(t, configOverrides = {}) {
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
      verbosity: '2',
      ...configOverrides
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

async function runAndCollect(addon, prompt, runOptions = {}) {
  const response = await addon.run(prompt, runOptions)
  const chunks = []
  let error = null

  let chain = response.onUpdate((data) => {
    chunks.push(data)
  })

  if (typeof response.onError === 'function') {
    chain = chain.onError((err) => {
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

async function measurePrefillCacheCells(t, addon, prompt, cacheKey, baselineStats, label) {
  const probeCacheKey = `${cacheKey}.${label.replace(/ /g, '-')}.probe`
  cleanupIntegrationCacheFiles(probeCacheKey)
  fs.copyFileSync(cacheKey, probeCacheKey)

  try {
    const result = await runAndCollect(addon, prompt, { cacheKey: probeCacheKey, prefill: true })
    const baselineCacheTokens = toNumber(baselineStats.CacheTokens)
    const cacheCells = toNumber(result.stats.CacheTokens) - baselineCacheTokens

    t.is(result.text, '', `${label}: cache-cell probe emits no text`)
    t.is(
      toNumber(result.stats.generatedTokens),
      0,
      `${label}: cache-cell probe reports zero generated tokens`
    )
    t.ok(
      cacheCells > 0 && cacheCells < CTX_SIZE,
      `${label}: addon measured a valid physical prompt (${cacheCells} cache cells)`
    )
    assertCachedStats(t, result.stats, `${label}: cache-cell probe`)
    await runNoCacheSeparator(t, addon, `after ${label} cache-cell probe`)

    return cacheCells
  } finally {
    try {
      fs.unlinkSync(probeCacheKey)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
}

async function applyControlledPrefillPressure(
  t,
  addon,
  cacheOpts,
  initialStats,
  targetCacheTokens,
  coarseCacheCells,
  fineCacheCells
) {
  let stats = initialStats
  let totalControlledCacheCells = 0
  let totalSlides = 0
  const chunkCacheCellCounts = []
  let runs = 0

  while (runs < MAX_CONTROLLED_PREFILLS) {
    runs++
    const cacheTokens = toNumber(stats.CacheTokens)
    if (cacheTokens >= targetCacheTokens && totalSlides > 0) break

    const needsSlide = cacheTokens >= targetCacheTokens && totalSlides === 0
    const remaining = targetCacheTokens - cacheTokens
    const useCoarseChunk = needsSlide || remaining > coarseCacheCells + fineCacheCells
    const wordCount = useCoarseChunk
      ? CONTROLLED_PREFILL_COARSE_WORDS
      : CONTROLLED_PREFILL_FINE_WORDS
    const measuredCacheCells = useCoarseChunk ? coarseCacheCells : fineCacheCells
    const result = await runAndCollect(addon, makeControlledPrefillTurn(wordCount), {
      ...cacheOpts,
      prefill: true
    })

    chunkCacheCellCounts.push(measuredCacheCells)
    totalControlledCacheCells += measuredCacheCells
    totalSlides += toNumber(result.stats.contextSlides)
    stats = result.stats
  }

  t.ok(chunkCacheCellCounts.length > 0, 'controlled prefill pressure ran at least one chunk')
  t.ok(
    chunkCacheCellCounts.every((count) => count > 0 && count < CTX_SIZE),
    `controlled prefill chunks were individually valid (${chunkCacheCellCounts.join(', ')})`
  )
  t.ok(
    totalSlides > 0,
    `controlled prefill pressure triggered context sliding (${totalSlides} slides)`
  )
  t.ok(
    toNumber(stats.CacheTokens) >= targetCacheTokens,
    'controlled prefill pressure reached the measured decode threshold ' +
      `(${stats.CacheTokens} >= ${targetCacheTokens}, controlledCacheCells=${totalControlledCacheCells})`
  )
  assertCachedStats(t, stats, 'controlled prefill pressure')

  return { stats, totalControlledCacheCells, totalSlides, chunkCacheCellCounts }
}

async function cancelResponse(addon, response) {
  if (response && typeof response.cancel === 'function') {
    await response.cancel()
    return
  }
  await addon.cancel()
}

async function runAndCancelDuringPrefill(addon, prompt, runOptions = {}) {
  const response = await addon.run(prompt, runOptions)
  let cancelFired = false
  const cancelTimer = setTimeout(() => {
    cancelFired = true
    cancelResponse(addon, response).catch((err) => {
      console.error('cancel during prefill failed:', err)
    })
  }, PREFILL_CANCEL_DELAY_MS)
  try {
    await response.await()
  } catch (err) {
    if (!isCancellationError(err)) throw err
  } finally {
    clearTimeout(cancelTimer)
  }
  return { stats: response.stats || {}, cancelFired }
}

async function runAndCancelAfterFirstChunk(addon, prompt, runOptions = {}) {
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
    chain = chain.onError((err) => {
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

function assertCachedStats(t, stats, label) {
  const cacheTokens = toNumber(stats.CacheTokens)
  t.ok(cacheTokens > 0, `${label}: CacheTokens should stay populated (${cacheTokens})`)
  t.ok(
    cacheTokens <= CTX_SIZE,
    `${label}: CacheTokens should stay within ctx (${cacheTokens} <= ${CTX_SIZE})`
  )
}

function assertCanceledPrefillRolledBack(t, beforeStats, cancelResult) {
  // Cancel = "request never happened": prefill cancel must roll the
  // cache back to the pre-request cursor, modulo any context slides
  // that fired before cancel landed. We therefore expect the cache
  // size to match the pre-cancel baseline (minus slide discards) and
  // never to exceed it.
  const { stats: afterStats, cancelFired } = cancelResult
  t.ok(cancelFired, 'cancel timer fired before prefill completed (test harness sanity check)')
  const beforeCacheTokens = toNumber(beforeStats.CacheTokens)
  const afterCacheTokens = toNumber(afterStats.CacheTokens)
  const slideDiscard = toNumber(afterStats.contextSlides) * N_DISCARDED
  const baselineAfterSlides = Math.max(beforeCacheTokens - slideDiscard, 0)

  t.ok(
    afterCacheTokens <= baselineAfterSlides + 1,
    'cancel during prefill rolls cache back to pre-request cursor ' +
      `(${beforeCacheTokens} - ${slideDiscard} -> ${afterCacheTokens}, slides=${afterStats.contextSlides || 0})`
  )
}

async function runNoCacheSeparator(t, addon, label) {
  const result = await runAndCollect(addon, NO_CACHE_SEPARATOR_PROMPT, {
    generationParams: { predict: 16 }
  })

  t.ok(result.text.length > 0, `${label}: no-cache separator generated output`)
  t.is(
    toNumber(result.stats.CacheTokens),
    0,
    `${label}: no-cache separator cleared in-memory cache`
  )
}

async function assertContextOverflow(t, action, label) {
  try {
    await action()
    t.fail(`${label}: expected context overflow`)
  } catch (err) {
    const msg = err?.message || String(err)
    t.ok(
      /context overflow/i.test(msg),
      `${label}: context overflow surfaced (${msg.slice(0, 120)})`
    )
  }
}

safeTest(
  'Qwen3.5-VL cached chat stresses sliding and cancel recovery',
  {
    timeout: 2_400_000,
    skip: skipStress
  },
  async (t) => {
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

    const systemPrefill = await runAndCollect(addon, [SYSTEM_PROMPT], {
      ...cacheOpts,
      prefill: true
    })
    t.is(systemPrefill.text, '', 'system prefill emits no text')
    t.is(
      toNumber(systemPrefill.stats.generatedTokens),
      0,
      'system prefill reports zero generated tokens'
    )
    assertCachedStats(t, systemPrefill.stats, 'system prefill')
    t.ok(fs.existsSync(cachePath), 'system prefill saved cache to disk')
    await runNoCacheSeparator(t, addon, 'after system prefill')

    const first = await runAndCollect(addon, makeImageTurn(imageBytes), {
      ...cacheOpts,
      generationParams: { predict: 64 }
    })
    t.ok(first.text.length > 0, 'first multimodal turn generated output')
    t.ok(
      toNumber(first.stats.generatedTokens) > 0 && toNumber(first.stats.generatedTokens) <= 64,
      'first multimodal turn completed a bounded normal generation ' +
        `(${first.stats.generatedTokens} tokens, stop=${first.stats.stopReason})`
    )
    t.ok(
      toNumber(first.stats.CacheTokens) > MIN_QWEN35_IMAGE_CACHE_TOKENS,
      `first turn cached Qwen3.5 image cells (${first.stats.CacheTokens})`
    )
    assertCachedStats(t, first.stats, 'first multimodal turn')
    t.ok(fs.existsSync(cachePath), 'first turn saved cache to disk')
    await runNoCacheSeparator(t, addon, 'after first multimodal turn')

    const canceledPrefillResult = await runAndCancelDuringPrefill(
      addon,
      makeCancelPrefillTurn(imageBytes),
      {
        ...cacheOpts,
        prefill: true
      }
    )
    assertCanceledPrefillRolledBack(t, first.stats, canceledPrefillResult)
    await runNoCacheSeparator(t, addon, 'after canceled prefill')

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
    await runNoCacheSeparator(t, addon, 'after prefill-cancel recovery')

    const decodePromptCacheCells = await measurePrefillCacheCells(
      t,
      addon,
      makeShortDecodeTurn(),
      cachePath,
      afterPrefillCancel.stats,
      'decode prompt'
    )
    const coarsePrefillCacheCells = await measurePrefillCacheCells(
      t,
      addon,
      makeControlledPrefillTurn(CONTROLLED_PREFILL_COARSE_WORDS),
      cachePath,
      afterPrefillCancel.stats,
      'coarse controlled prefill'
    )
    const finePrefillCacheCells = await measurePrefillCacheCells(
      t,
      addon,
      makeControlledPrefillTurn(CONTROLLED_PREFILL_FINE_WORDS),
      cachePath,
      afterPrefillCancel.stats,
      'fine controlled prefill'
    )
    const decodeSlideThreshold = CTX_SIZE - decodePromptCacheCells + 1
    const controlledPressure = await applyControlledPrefillPressure(
      t,
      addon,
      cacheOpts,
      afterPrefillCancel.stats,
      decodeSlideThreshold,
      coarsePrefillCacheCells,
      finePrefillCacheCells
    )
    await runNoCacheSeparator(t, addon, 'after controlled prefill pressure')

    const decodeSlide = await runAndCollect(addon, makeShortDecodeTurn(), {
      ...cacheOpts,
      generationParams: { predict: 64 }
    })
    t.ok(decodeSlide.text.length > 0, 'decode stress run generated output')
    t.ok(
      toNumber(decodeSlide.stats.generatedTokens) > 0 &&
        toNumber(decodeSlide.stats.generatedTokens) <= 64,
      'decode stress run completed a bounded normal generation ' +
        `(${decodeSlide.stats.generatedTokens} tokens, stop=${decodeSlide.stats.stopReason})`
    )
    t.ok(
      toNumber(decodeSlide.stats.contextSlides) > 0,
      'decode request crossed the measured prefill threshold and triggered sliding ' +
        `(${decodeSlide.stats.contextSlides} slides after ${controlledPressure.totalControlledCacheCells} controlled cache cells)`
    )
    assertCachedStats(t, decodeSlide.stats, 'decode stress run')
    await runNoCacheSeparator(t, addon, 'after decode stress run')

    const canceledDecode = await runAndCancelAfterFirstChunk(addon, makeShortDecodeTurn(), {
      ...cacheOpts,
      generationParams: { predict: 256 }
    })
    t.ok(canceledDecode.chunkCount > 0, 'cancel during decoding happened after at least one chunk')
    await runNoCacheSeparator(t, addon, 'after canceled decode')

    const afterDecodeCancel = await runAndCollect(
      addon,
      [
        {
          role: 'user',
          content: 'After the canceled decode, continue normally with a concise answer.'
        }
      ],
      {
        ...cacheOpts,
        generationParams: { predict: 64 }
      }
    )
    t.ok(afterDecodeCancel.text.length > 0, 'chat recovered after cancel during decoding')
    assertCachedStats(t, afterDecodeCancel.stats, 'after decode cancel')
  }
)

safeTest(
  'Qwen3.5-VL image cache overflows by cache tokens before positions',
  {
    timeout: 1_200_000,
    skip: skipStress
  },
  async (t) => {
    const imagePath = getMediaPath('fruitPlate.png')
    t.ok(fs.existsSync(imagePath), 'fruitPlate.png image fixture should exist')

    const imageBytes = new Uint8Array(fs.readFileSync(imagePath))
    const CTX_SIZE_OVERRIDE = '6000'

    const addon = await setupModel(t, { n_discarded: '0', ctx_size: CTX_SIZE_OVERRIDE })
    const cachePath = path.join(os.tmpdir(), `qwen35-mtmd-cache-token-overflow-${Date.now()}.bin`)
    cleanupIntegrationCacheFiles(cachePath)
    t.teardown(() => {
      try {
        fs.unlinkSync(cachePath)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    })

    const cacheOpts = { cacheKey: cachePath, saveCacheToDisk: true, prefill: true }

    const first = await runAndCollect(
      addon,
      makeFixedImagePrefillTurn(imageBytes, 'one'),
      cacheOpts
    )
    t.is(first.text, '', 'first image prefill emits no text')
    t.is(
      toNumber(first.stats.generatedTokens),
      0,
      'first image prefill reports zero generated tokens'
    )
    t.ok(
      toNumber(first.stats.CacheTokens) > MIN_QWEN35_IMAGE_CACHE_TOKENS,
      `first image prefill cached image cells (${first.stats.CacheTokens})`
    )

    const second = await runAndCollect(
      addon,
      makeFixedImagePrefillTurn(imageBytes, 'two'),
      cacheOpts
    )
    t.is(second.text, '', 'second image prefill emits no text')
    t.is(
      toNumber(second.stats.generatedTokens),
      0,
      'second image prefill reports zero generated tokens'
    )
    t.ok(
      toNumber(second.stats.CacheTokens) > CTX_SIZE_OVERRIDE - MIN_QWEN35_IMAGE_CACHE_TOKENS,
      `two image prefills nearly fill cache by physical cells (${second.stats.CacheTokens}/${CTX_SIZE_OVERRIDE})`
    )
    t.ok(
      toNumber(second.stats.CacheTokens) <= CTX_SIZE_OVERRIDE,
      'two image prefills still fit by cache tokens'
    )

    await assertContextOverflow(
      t,
      () => runAndCollect(addon, makeFixedImagePrefillTurn(imageBytes, 'three'), cacheOpts),
      'third image prefill overflows physical cache-token capacity'
    )
  }
)
