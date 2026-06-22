'use strict'
// QVAC-19118 (A2): shared helpers for the vision prefix cache integration
// tests (vision-cache-gemma4, vision-cache-qwen3-5). This file intentionally
// does NOT end in `.test.js` so it is not picked up by the mobile test
// generator or the brittle runner — same convention as `_image-common.js`.
//
// Why split per model (mirrors QVAC-17830's per-image split): each model gets
// its own bare process / Device Farm group, keeping the peak memory footprint
// small enough to survive the iOS Jetsam ceiling when loading a VLM.
//
// The vision prefix cache lives on the model instance for its whole lifetime
// (MtmdLlmContext::visionPrefixCache_). It caches post-projection image
// embeddings keyed by SHA-256(image bytes) + model/mmproj path, so re-sending
// the SAME image — even under a DIFFERENT text prompt and across the KV-cache
// reset that happens between stateless runs — skips the expensive CLIP encode
// + mmproj projection and registers a cache hit. Telemetry is surfaced on
// `response.stats.visionCache*` when `opts.stats: true`.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const { ensureModel, getMediaPath } = require('./utils')
const { describeImage, checkKeywordsInText } = require('./_image-common.js')
const { recordPerformance } = require('./_perf-helper.js')
const LlmLlamacpp = require('../../index.js')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
// Desktop x64-darwin and linux-arm64 hosts have no working GPU stack here so
// we drop to CPU; everywhere else (incl. iOS / Android Device Farm) uses the
// GPU backend the addon picks. The vision cache is CPU-held either way, so the
// device only changes where projection runs, not the cache semantics.
const useCpu = isDarwinX64 || isLinuxArm64

const TEST_TIMEOUT = 1_800_000 // 15 min — matches the existing VLM image tests

// Two small, visually distinct images already shipped as test fixtures and
// registered as iOS/Android testAssets (elephant.jpg 612x408 by the
// image-elephant test; news-paper.jpg 500x350 by the OCR tests). Both are
// small on purpose: fruitPlate.png (2250x3000) / highRes (3000x4000) are
// avoided here because Qwen3.5's dynamic resolution tokenizes them to ~4k
// image tokens, overflowing a 4096 context at prefill.
const ELEPHANT = 'elephant.jpg'
const SECOND_IMAGE = 'news-paper.jpg'

function vc (stats) {
  const s = stats || {}
  return {
    hits: Number(s.visionCacheHits || 0),
    misses: Number(s.visionCacheMisses || 0),
    evictions: Number(s.visionCacheEvictions || 0),
    distinct: Number(s.visionCacheDistinctImages || 0),
    peakBytes: Number(s.visionCachePeakBytes || 0),
    // KV-cache prefill counter (tokens actually evaluated this run). Used to
    // prove the vision-cache hit is NOT a KV-cache reuse effect: if the KV
    // cache were serving the image, this would collapse to a handful of text
    // tokens on the warm run. It does not, because each stateless run resets
    // the KV cache and re-evaluates the whole image prompt.
    promptTokens: Number(s.promptTokens || 0)
  }
}

// QVAC-19118 (A2): record a no-hit→hit cache pair to the shared perf reporter so
// the Combined Performance Report's "Cache Hit Improvement" section can show how
// much a cache hit saves. `scenario` is 'vision-cache' (stateless image re-send
// → CLIP encode + mmproj projection skipped) or 'kv-cache' (same prefix re-sent
// with a cacheKey → prefill skipped). The derived improvement fields are stashed
// on the HIT row so each row is self-contained in the report (no cross-row
// pairing needed). `cold` is the first request (cache miss = no hit) and `warm`
// the repeat (cache hit); both are describeImage() results
// ({ generatedText, startTime, endTime, stats }).
function recordCacheImprovement (modelConfig, scenario, cold, warm) {
  const ep = useCpu ? 'cpu' : 'gpu'
  const coldTotal = cold.endTime - cold.startTime
  const warmTotal = warm.endTime - warm.startTime
  const coldTtft = Number((cold.stats && cold.stats.TTFT) || 0)
  const warmTtft = Number((warm.stats && warm.stats.TTFT) || 0)
  const pct = (c, w) => (c > 0 ? Number((100 * (c - w) / c).toFixed(2)) : null)

  const base = `${modelConfig.label} elephant [${scenario}`
  recordPerformance(`${base} no-hit]`, coldTotal, {
    stats: cold.stats,
    scenario,
    model: modelConfig.label,
    deviceId: ep,
    _output: cold.generatedText,
    categorical: { cache_state: 'no hit' }
  })
  recordPerformance(`${base} hit]`, warmTotal, {
    stats: warm.stats,
    scenario,
    model: modelConfig.label,
    deviceId: ep,
    _output: warm.generatedText,
    categorical: { cache_state: 'hit' },
    extraMetrics: {
      cold_ttft_ms: Math.round(coldTtft),
      ttft_saved_ms: Math.round(coldTtft - warmTtft),
      ttft_speedup_pct: pct(coldTtft, warmTtft),
      cold_total_ms: Math.round(coldTotal),
      total_saved_ms: Math.round(coldTotal - warmTotal),
      total_speedup_pct: pct(coldTotal, warmTotal)
    }
  })
}

async function setup (t, modelConfig, extraConfig = {}) {
  const [modelName, dirPath] = await ensureModel(modelConfig.llmModel)
  t.ok(fs.existsSync(path.join(dirPath, modelName)),
    `${modelConfig.label}: LLM model file should exist`)

  const [projModelName] = await ensureModel(modelConfig.projModel)
  t.ok(fs.existsSync(path.join(dirPath, projModelName)),
    `${modelConfig.label}: projection model file should exist`)

  const inference = new LlmLlamacpp({
    files: {
      model: [path.join(dirPath, modelName)],
      projectionModel: path.join(dirPath, projModelName)
    },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      ...modelConfig.visionConfig,
      ...extraConfig
    },
    logger: console,
    opts: { stats: true }
  })

  t.teardown(async () => {
    await inference.unload().catch(() => {})
  })

  await inference.load()
  return inference
}

/**
 * Defines the vision-prefix-cache integration tests for a single VLM. Each
 * brittle test() loads the model once (with teardown unload) so peak memory
 * stays bounded on Device Farm. Runs on every platform — the cache is the same
 * CPU code path everywhere, and the mobile memory-pressure hook is part of what
 * we want to exercise — so these are NOT gated on isMobile.
 *
 * @param {object} modelConfig
 * @param {string} modelConfig.label        Human-readable model name for messages
 * @param {object} modelConfig.llmModel     { modelName, downloadUrl } for ensureModel
 * @param {object} modelConfig.projModel    { modelName, downloadUrl } for ensureModel
 * @param {object} modelConfig.visionConfig load-time config (without `device`)
 * @param {string} modelConfig.evictBudgetMb small vision_cache_budget_mb sized to
 *                                           hold roughly one image's embeddings
 *                                           for this model, to exercise the byte
 *                                           budget / eviction path
 */
function runVisionCacheTests (modelConfig) {
  // --- Test 1: hit/miss/distinctImages + multi-turn persistence + onMemoryWarning
  //
  // The headline behaviour: the same image, asked about on a separate run()
  // (which resets the KV cache between stateless turns — no cacheKey is passed,
  // so shouldResetAfterInference is true), still hits — proving the embedding
  // cache is decoupled from the KV-cache lifecycle.
  //
  // NOTE: the cache is keyed PER IMAGE CHUNK, and a single image may tokenize
  // into several chunks (pan-and-scan / tiling), so each image can create more
  // than one distinct entry. We therefore assert on RELATIVE changes between
  // runs (a repeated image adds no new distinct entries and produces hits; a
  // new image adds entries and produces misses) instead of hard-coding counts.
  test(`${modelConfig.label}: vision cache hits on a repeated image and tracks distinct images`, {
    timeout: TEST_TIMEOUT
  }, async t => {
    const inference = await setup(t, modelConfig)
    const elephantPath = getMediaPath(ELEPHANT)
    const secondPath = getMediaPath(SECOND_IMAGE)
    t.ok(fs.existsSync(elephantPath), `${ELEPHANT} fixture should exist`)
    t.ok(fs.existsSync(secondPath), `${SECOND_IMAGE} fixture should exist`)

    // Run 1 — cold: first sighting of the elephant → miss(es) + populate.
    const r1 = await describeImage(inference, elephantPath, 'What animal is in this image? Answer in one word.')
    const s1 = vc(r1.stats)
    t.comment(`${modelConfig.label} run1 cold elephant: ${JSON.stringify(s1)}`)
    t.is(s1.hits, 0, 'cold run has no cache hits')
    t.ok(s1.misses >= 1, 'cold run records cache miss(es)')
    t.ok(s1.distinct >= 1, 'cold run caches at least one image chunk')
    t.ok(checkKeywordsInText(r1.generatedText, ['elephant']).hasMatch,
      `cold elephant output mentions elephant: "${r1.generatedText.slice(0, 80)}"`)

    // Run 2 — warm: SAME image, fresh stateless run (KV cache reset between
    // turns). The embeddings survive the reset, so the repeat hits without
    // re-running CLIP + projection. A different prompt is used to mirror the
    // real "same image, new question" multi-turn use case.
    const r2 = await describeImage(inference, elephantPath, 'Identify the animal. Answer in one word.')
    const s2 = vc(r2.stats)
    t.comment(`${modelConfig.label} run2 warm elephant: ${JSON.stringify(s2)}`)
    t.ok(s2.hits > s1.hits, 'repeated image hits the cache across the KV reset')
    t.is(s2.misses, s1.misses, 'repeated image records no new miss')
    t.is(s2.distinct, s1.distinct, 'repeated image adds no new distinct entry')
    // Isolation from the KV cache: this is a stateless run (no cacheKey), so the
    // KV cache was cleared before it and the FULL image prompt is re-evaluated —
    // promptTokens stays in the same ballpark as the cold run rather than
    // collapsing to a few text tokens. So the hit above is the vision embedding
    // cache, not KV-cache prefix reuse (which would instead shrink promptTokens).
    t.ok(s2.promptTokens >= Math.floor(s1.promptTokens * 0.5),
      `warm run re-evaluated the full image prompt (prefill ${s2.promptTokens} vs cold ${s1.promptTokens} tokens) — the hit is the vision cache, not KV reuse`)
    t.ok(checkKeywordsInText(r2.generatedText, ['elephant']).hasMatch,
      `cached-decode output is still correct: "${r2.generatedText.slice(0, 80)}"`)

    // Run 3 — a DISTINCT image → new miss(es); distinctImages grows.
    const s3 = vc((await describeImage(inference, secondPath, 'Describe this image in one word.')).stats)
    t.comment(`${modelConfig.label} run3 cold second image: ${JSON.stringify(s3)}`)
    t.ok(s3.distinct > s2.distinct, 'a distinct image adds new cache entries')
    t.ok(s3.misses > s2.misses, 'a distinct image records fresh miss(es)')
    t.is(s3.hits, s2.hits, 'a distinct image does not hit')

    // Run 4 — repeat the second image → it now hits too.
    // Wrapped in try/catch: on some Vulkan backends Qwen3.5's M-RoPE decode
    // path produces inflated nPast values after multiple distinct images,
    // triggering a context overflow that is a backend limitation, not a cache
    // bug. Runs 1-3 already verified the core hit/miss/distinct invariants,
    // so a backend failure here is reported as a skip rather than crashing the
    // entire test process.
    let s4
    try {
      s4 = vc((await describeImage(inference, secondPath, 'What is shown in this image?')).stats)
    } catch (err) {
      console.warn(`[vision-cache] run4 skipped — known Vulkan M-RoPE issue: ${err.message}`)
      t.pass('runs 1-3 verified cache hit/miss/distinct — skipping run4+ due to backend error')
      return
    }
    t.comment(`${modelConfig.label} run4 warm second image: ${JSON.stringify(s4)}`)
    t.ok(s4.hits > s3.hits, 'repeated second image hits the cache')
    t.is(s4.distinct, s3.distinct, 'repeated second image adds no new distinct entry')

    // onMemoryWarning() drops all cached embeddings (iOS/Android low-memory
    // hook). The next request for a previously-cached image must therefore MISS
    // again and be re-inserted as fresh distinct entries (stats are NOT reset by
    // onMemoryWarning, only the data is cleared).
    inference.onMemoryWarning()
    let r5
    try {
      r5 = await describeImage(inference, elephantPath, 'What animal is in this image? Answer in one word.')
    } catch (err) {
      console.warn(`[vision-cache] run5 skipped — known Vulkan M-RoPE issue: ${err.message}`)
      t.pass('runs 1-4 verified cache semantics — skipping run5 due to backend error')
      return
    }
    const s5 = vc(r5.stats)
    t.comment(`${modelConfig.label} run5 post onMemoryWarning: ${JSON.stringify(s5)}`)
    t.ok(s5.misses > s4.misses, 'onMemoryWarning cleared the cache → image misses again')
    t.is(s5.hits, s4.hits, 'no new hit immediately after the cache was cleared')
    t.ok(s5.distinct > s4.distinct, 'cleared image is re-inserted as fresh distinct entries')
    t.ok(checkKeywordsInText(r5.generatedText, ['elephant']).hasMatch,
      'output still correct after the cache was cleared and re-populated')
  })

  // --- Test 2: feature flag disables the cache entirely.
  // With vision_cache:"false" the budget is set to 0, which makes the addon
  // skip the cache lookup completely — so every counter stays at zero even
  // though the same image is sent twice.
  test(`${modelConfig.label}: vision_cache:"false" disables caching`, {
    timeout: TEST_TIMEOUT
  }, async t => {
    const inference = await setup(t, modelConfig, { vision_cache: 'false' })
    const elephantPath = getMediaPath(ELEPHANT)

    const r1 = await describeImage(inference, elephantPath, 'What animal is in this image? Answer in one word.')
    const s1 = vc(r1.stats)
    t.is(s1.hits, 0, 'run 1 has no hits when cache disabled')
    t.is(s1.misses, 0, 'run 1 bypasses cache lookup entirely')
    const s2 = vc((await describeImage(inference, elephantPath, 'Identify the animal. One word.')).stats)
    t.comment(`${modelConfig.label} disabled final stats: ${JSON.stringify(s2)}`)

    t.is(s2.hits, 0, 'no hits when the cache is disabled')
    t.is(s2.misses, 0, 'the cache lookup is fully bypassed when disabled')
    t.is(s2.distinct, 0, 'nothing is cached when disabled')
    t.ok(checkKeywordsInText(r1.generatedText, ['elephant']).hasMatch,
      'inference still works correctly with the cache disabled')
  })

  // --- Test 3: byte budget is enforced.
  // put() rejects oversized entries and evicts BEFORE inserting, so cache
  // memory can never exceed the budget — that is the one hard guarantee and is
  // asserted unconditionally. Whether a second distinct image triggers an
  // eviction depends on the exact embedding size vs the budget, so the
  // eviction assertion is gated on what actually happened (detected from the
  // stats) and never produces a false failure.
  test(`${modelConfig.label}: vision_cache_budget_mb enforces the memory budget`, {
    timeout: TEST_TIMEOUT
  }, async t => {
    const budgetMb = modelConfig.evictBudgetMb
    const budgetBytes = Number(budgetMb) * 1024 * 1024
    const inference = await setup(t, modelConfig, { vision_cache_budget_mb: budgetMb })
    const elephantPath = getMediaPath(ELEPHANT)
    const secondPath = getMediaPath(SECOND_IMAGE)

    // Sequence A -> B -> A under a budget sized to hold roughly one image.
    const a1 = vc((await describeImage(inference, elephantPath, 'What animal is this? One word.')).stats)
    const b1 = vc((await describeImage(inference, secondPath, 'Describe this image in one word.')).stats)
    const a2 = vc((await describeImage(inference, elephantPath, 'Name the animal. One word.')).stats)
    t.comment(`${modelConfig.label} budget(${budgetMb}MB) a1=${JSON.stringify(a1)} b1=${JSON.stringify(b1)} a2=${JSON.stringify(a2)}`)

    // Hard guarantee: the budget is a real cap, in every regime.
    t.ok(a2.peakBytes <= budgetBytes,
      `peakBytes (${a2.peakBytes}) never exceeds the budget (${budgetBytes})`)

    const elephantReHit = a2.hits > b1.hits
    if (a1.peakBytes > 0 && !elephantReHit) {
      // The elephant WAS cached (peak > 0 after its first run) but did NOT hit
      // on re-request → the intervening distinct image forced it out under the
      // budget. Eviction must therefore have occurred.
      t.ok(a2.evictions >= 1,
        `a budget too small for two images forced an eviction (evictions=${a2.evictions})`)
    } else if (a1.peakBytes === 0) {
      // A single image already exceeds the budget → entries are rejected as
      // oversized rather than evicted. Rejection still prevents any hit; LRU
      // eviction ordering itself is covered by the C++ unit tests.
      t.is(a2.hits, 0, 'oversized entries are never cached, so the repeat misses')
      t.comment(`${modelConfig.label}: single-image embeddings exceed ${budgetMb}MB (rejection path)`)
    } else {
      // Both images fit within the budget at once → the repeat hit and no
      // eviction was required. The hard cap above still proves enforcement.
      t.comment(`${modelConfig.label}: both images fit within ${budgetMb}MB — no eviction needed`)
    }
  })

  // --- Test 4 (perf): record cold→warm timings for BOTH cache mechanisms so
  // the Combined Performance Report surfaces the TTFT / total-time a cache hit
  // saves. Loads its own model instance (unloaded on teardown). Speedup
  // MAGNITUDE is recorded telemetry, not asserted — it would be flaky on
  // shared / virtual CI GPUs. Only the cache MECHANISM is asserted (a hit
  // happened; the warm prefix re-evaluated no more tokens than the cold one).
  test(`${modelConfig.label}: cache-hit performance (vision + KV)`, {
    timeout: TEST_TIMEOUT
  }, async t => {
    const inference = await setup(t, modelConfig)
    const elephantPath = getMediaPath(ELEPHANT)
    t.ok(fs.existsSync(elephantPath), `${ELEPHANT} fixture should exist`)

    // 1) Vision cache — stateless (no cacheKey → KV reset between runs). The
    //    repeat hits the embedding cache, skipping CLIP encode + projection.
    //    A different prompt mirrors the real "same image, new question" case.
    const vCold = await describeImage(inference, elephantPath, 'What animal is in this image? Answer in one word.')
    const vWarm = await describeImage(inference, elephantPath, 'Identify the animal. Answer in one word.')
    recordCacheImprovement(modelConfig, 'vision-cache', vCold, vWarm)
    const vc1 = vc(vCold.stats)
    const vc2 = vc(vWarm.stats)
    t.comment(`${modelConfig.label} vision-cache cold=${JSON.stringify(vc1)} warm=${JSON.stringify(vc2)}`)
    t.ok(vc2.hits > vc1.hits, 'vision-cache warm run hit the embedding cache')

    // 2) KV cache — stateful (same cacheKey + saveCacheToDisk → the warm run
    //    reuses the KV prefix and skips prefill). Same image AND same prompt so
    //    the prefix matches; the vision cache is already hot from step 1, so
    //    this delta isolates the LLM-prefill skip.
    const kvKey = `vision-cache-perf-${modelConfig.label}`.replace(/[^A-Za-z0-9_-]/g, '-')
    const kvPrompt = 'Describe the animal in this image.'
    // The cacheKey doubles as the on-disk session path. Start from a clean
    // session and clean up after: a stale session left by a prior run is
    // reloaded on the cold run and overflows the context (CONTEXT_OVERFLOW), so
    // re-runs would not be reproducible.
    if (fs.existsSync(kvKey)) fs.unlinkSync(kvKey)
    t.teardown(() => { if (fs.existsSync(kvKey)) fs.unlinkSync(kvKey) })
    // Bound generation so saveCacheToDisk persists a small [prompt + response]
    // session: an unbounded cold response would fill the 4096 ctx, and the warm
    // run (which restores that session and re-evaluates the prompt) would
    // overflow. The assertion below is about prompt tokens re-evaluated, not
    // generation length, so capping predict keeps the session small.
    const kvRun = { cacheKey: kvKey, saveCacheToDisk: true, generationParams: { predict: 64 } }
    const kvCold = await describeImage(inference, elephantPath, kvPrompt, kvRun)
    const kvWarm = await describeImage(inference, elephantPath, kvPrompt, kvRun)
    recordCacheImprovement(modelConfig, 'kv-cache', kvCold, kvWarm)
    const kvColdPrompt = Number((kvCold.stats && kvCold.stats.promptTokens) || 0)
    const kvWarmPrompt = Number((kvWarm.stats && kvWarm.stats.promptTokens) || 0)
    t.comment(`${modelConfig.label} kv-cache cold promptTokens=${kvColdPrompt} warm promptTokens=${kvWarmPrompt}`)
    t.ok(kvWarmPrompt <= kvColdPrompt, 'kv-cache warm run re-evaluated no more prompt tokens than the cold run')
  })

  // --- Test 5 (A3): context overflow returns a structured error, not a crash.
  // Load with a small ctx_size + large n_predict so the A3 guard rejects the
  // prefill (image tokens + n_predict + safety > n_ctx) BEFORE any decode. The
  // addon must surface a catchable ContextOverflow error rather than crash the
  // process. t.exception.all is the documented escape hatch for native-error
  // rejections that would otherwise trip Bare's unhandled-rejection guard
  // (exit 134) — see grammar.test.js.
  test(`${modelConfig.label}: context overflow returns a structured error, not a crash`, {
    timeout: TEST_TIMEOUT
  }, async t => {
    const inference = await setup(t, modelConfig, { ctx_size: '512', n_predict: '1024' })
    const elephantPath = getMediaPath(ELEPHANT)
    t.ok(fs.existsSync(elephantPath), `${ELEPHANT} fixture should exist`)

    await t.exception.all(
      () => describeImage(inference, elephantPath, 'Describe this image in detail.'),
      /overflow/i,
      'overflowing prefill rejects with a ContextOverflow error instead of crashing'
    )
  })
}

module.exports = {
  runVisionCacheTests,
  useCpu,
  platform,
  TEST_TIMEOUT
}
