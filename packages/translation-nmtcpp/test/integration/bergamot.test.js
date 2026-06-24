'use strict'

/* global Bare */

/**
 * Bergamot Backend Integration Test
 *
 * Tests the Bergamot (intgemm quantized) translation backend with English to Italian translation.
 * Uses Mozilla's Bergamot project models optimized for CPU inference.
 *
 * Platform Behavior:
 *   - Mobile (iOS/Android): GPU devices discovered at runtime, each gets its
 *     own test run with identifiable label (e.g. [GPU:0 Vulkan0])
 *   - Desktop: Tests CPU mode only (intgemm is CPU-optimized)
 *
 * Usage:
 *   bare test/integration/bergamot.test.js
 */

// Guard against Bare's default abort() on unhandled promise rejections.
// Without this, a transient network error during model fetch would
// SIGABRT the process (see notes in indictrans.test.js and pivot-bergamot.test.js).
// See indictrans.test.js for the full rationale on why we both catch
// and then exit non-zero on `beforeExit`. tl;dr: catch to avoid the
// Samsung SIGABRT, then propagate failure so CI doesn't lie about
// passing when no translation actually ran.
let _bergamotUnhandledRejection = null
if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('unhandledRejection', (err) => {
    console.error('[bergamot] Unhandled rejection:', err && (err.stack || err.message || err))
    if (!_bergamotUnhandledRejection) _bergamotUnhandledRejection = err
  })
  Bare.on('beforeExit', () => {
    if (_bergamotUnhandledRejection) {
      console.error('[bergamot] FATAL: tests had unhandled rejections, exiting with code 1')
      if (typeof Bare.exit === 'function') Bare.exit(1)
      else if (typeof process !== 'undefined' && process.exit) process.exit(1)
    }
  })
}

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const {
  ensureBergamotModel,
  createLogger,
  TEST_TIMEOUT,
  createPerformanceCollector,
  formatPerformanceMetrics,
  isMobile,
  platform,
  discoverGpuDevices,
  MAX_GPU_DEVICE_PROBES
} = require('./utils')

const BERGAMOT_FIXTURE = path.resolve(__dirname, 'fixtures/bergamot.quality.json')

// ---------------------------------------------------------------------------
// Per-GPU-device tests (mobile only).  On desktop only the CPU test runs.
// ---------------------------------------------------------------------------

if (isMobile) {
  for (let gpuIdx = 0; gpuIdx < MAX_GPU_DEVICE_PROBES; gpuIdx++) {
    test(`Bergamot backend [GPU device ${gpuIdx}] - English to Italian translation`, { timeout: TEST_TIMEOUT }, async function (t) {
      const modelDir = await ensureBergamotModel()
      const allFiles = fs.readdirSync(modelDir)
      const modelFile = allFiles.find(f => f.includes('.intgemm') && f.includes('.bin'))
      const vocabFile = allFiles.find(f => f.includes('.spm'))

      const devices = await discoverGpuDevices()
      const device = devices[gpuIdx]

      if (!device) {
        t.comment(`[GPU:${gpuIdx}] No unique physical GPU at slot ${gpuIdx} — skipping`)
        t.pass(`[GPU:${gpuIdx}] Skipped (device not present)`)
        return
      }

      const label = `[GPU:${device.index} ${device.name}]`
      t.ok(modelDir, `${label} Bergamot model path should be available`)
      t.comment(`${label} Model directory: ` + modelDir)
      t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
      t.comment(`${label} Testing with use_gpu: true, gpu_device: ${device.index}`)

      const fullVocabPath = path.join(modelDir, vocabFile)
      const logger = createLogger()
      const perfCollector = createPerformanceCollector()
      let model

      try {
        model = new TranslationNmtcpp({
          files: {
            model: path.join(modelDir, modelFile),
            srcVocab: fullVocabPath,
            dstVocab: fullVocabPath
          },
          params: { srcLang: 'en', dstLang: 'it' },
          config: {
            modelType: TranslationNmtcpp.ModelTypes.Bergamot,
            beamsize: 1,
            normalize: 1,
            use_gpu: true,
            gpu_device: device.index
          },
          logger,
          opts: { stats: true }
        })
        model.logger.setLevel('debug')
        await model.load()
        t.pass(`${label} Bergamot model loaded successfully`)

        const testSentence = 'Hello, how are you?'
        t.comment(`${label} Translating: "` + testSentence + '"')

        perfCollector.start()
        const response = await model.run(testSentence)
        await response
          .onUpdate(data => { perfCollector.onToken(data) })
          .await()

        const addonStats = response.stats || {}
        t.comment(`${label} Native addon stats: ` + JSON.stringify(addonStats))
        const metrics = perfCollector.getMetrics(testSentence, addonStats)
        t.comment(formatPerformanceMetrics(`[Bergamot] ${label}`, metrics, {
          fixturePath: BERGAMOT_FIXTURE,
          srcLang: 'en',
          dstLang: 'it'
        }))

        t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)
        t.pass(`${label} Bergamot translation completed successfully`)
      } catch (e) {
        t.fail(`${label} Bergamot test failed: ` + e.message)
        throw e
      } finally {
        if (model) {
          try { await model.unload() } catch (e) {
            t.comment(`${label} unload() error: ` + e.message)
          }
        }
      }
    })
  }
}

// CPU test (always runs)
test('Bergamot backend [CPU] - English to Italian translation', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelDir = await ensureBergamotModel()
  const label = '[CPU]'
  t.ok(modelDir, `${label} Bergamot model path should be available`)
  t.comment(`${label} Model directory: ` + modelDir)
  t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)

  const allFiles = fs.readdirSync(modelDir)
  const modelFile = allFiles.find(f => f.includes('.intgemm') && f.includes('.bin'))
  const vocabFile = allFiles.find(f => f.includes('.spm'))

  t.ok(modelFile, `${label} model file should exist`)
  t.ok(vocabFile, `${label} vocab file should exist`)

  const fullVocabPath = path.join(modelDir, vocabFile)
  const logger = createLogger()
  const perfCollector = createPerformanceCollector()
  let model

  t.comment(`${label} Testing with use_gpu: false`)

  try {
    model = new TranslationNmtcpp({
      files: {
        model: path.join(modelDir, modelFile),
        srcVocab: fullVocabPath,
        dstVocab: fullVocabPath
      },
      params: { srcLang: 'en', dstLang: 'it' },
      config: {
        modelType: TranslationNmtcpp.ModelTypes.Bergamot,
        beamsize: 1,
        normalize: 1,
        use_gpu: false
      },
      logger,
      opts: { stats: true }
    })
    model.logger.setLevel('debug')
    await model.load()
    t.pass(`${label} Bergamot model loaded successfully`)

    const testSentence = 'Hello, how are you?'
    t.comment(`${label} Translating: "` + testSentence + '"')

    perfCollector.start()
    const response = await model.run(testSentence)
    await response
      .onUpdate(data => { perfCollector.onToken(data) })
      .await()

    const addonStats = response.stats || {}
    t.comment(`${label} Native addon stats: ` + JSON.stringify(addonStats))
    const metrics = perfCollector.getMetrics(testSentence, addonStats)
    t.comment(formatPerformanceMetrics(`[Bergamot] ${label}`, metrics, {
      fixturePath: BERGAMOT_FIXTURE,
      srcLang: 'en',
      dstLang: 'it'
    }))

    t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)
    t.pass(`${label} Bergamot translation completed successfully`)
  } catch (e) {
    t.fail(`${label} Bergamot test failed: ` + e.message)
    throw e
  } finally {
    if (model) {
      try { await model.unload() } catch (e) {
        t.comment(`${label} unload() error: ` + e.message)
      }
    }
  }
})

// ===========================================================================
// Standalone Bergamot coverage (QVAC-19836)
//
// The pivot-bergamot suite already exercises batch, lifecycle, cancel and
// use-after-unload, but only through the chained PivotTranslationModel — a
// different C++ path from a single standalone Bergamot model. These tests
// mirror that coverage on the standalone path, plus the resource-release
// checks (backend state after unload, multi-cycle stress) that no Bergamot
// test covers today.
// ===========================================================================

/**
 * Builds standalone Bergamot constructor args for the EN->IT model on disk.
 * Centralises the model/vocab file discovery the per-test bodies share.
 */
function createStandaloneBergamotArgs (modelDir, logger, extraConfig = {}) {
  const allFiles = fs.readdirSync(modelDir)
  const modelFile = allFiles.find(f => f.includes('.intgemm') && f.includes('.bin'))
  const vocabFile = allFiles.find(f => f.includes('.spm'))
  const fullVocabPath = path.join(modelDir, vocabFile)

  return {
    files: {
      model: path.join(modelDir, modelFile),
      srcVocab: fullVocabPath,
      dstVocab: fullVocabPath
    },
    params: { srcLang: 'en', dstLang: 'it' },
    config: {
      modelType: TranslationNmtcpp.ModelTypes.Bergamot,
      beamsize: 1,
      normalize: 1,
      use_gpu: false,
      ...extraConfig
    },
    logger,
    opts: { stats: true }
  }
}

// ---------------------------------------------------------------------------
// #2 — Standalone batch translation via runBatch()
//
// WHY: runBatch() drives the native processBatch path, distinct from run().
// Apps batch-wrap inputs in production pipelines; only pivot batch is tested
// today, so a standalone-batch regression would ship uncaught.
// ---------------------------------------------------------------------------

test('Bergamot [CPU] - standalone batch translation via runBatch()', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelDir = await ensureBergamotModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(createStandaloneBergamotArgs(modelDir, logger))
    await model.load()

    const inputs = ['Hello, how are you?', 'The weather is beautiful today.']
    const results = await model.runBatch(inputs)

    t.ok(Array.isArray(results), 'batch results should be an array')
    t.is(results.length, inputs.length, `should return ${inputs.length} translations`)
    for (let i = 0; i < results.length; i++) {
      t.ok(typeof results[i] === 'string', `result[${i}] should be a string`)
      t.ok(results[i].length > 0, `result[${i}] should not be empty`)
      t.comment(`  "${inputs[i]}" -> "${results[i]}"`)
    }
    t.pass('Standalone Bergamot batch translation completed')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #4 — Load -> use -> unload -> reload -> use cycle
//
// WHY: Apps that swap models or recover from errors rely on reload working.
// If unload corrupts internal state, the second translation breaks with no
// clear error. Only the pivot model proves this today.
// ---------------------------------------------------------------------------

test('Bergamot [CPU] - load, unload, reload cycle', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelDir = await ensureBergamotModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(createStandaloneBergamotArgs(modelDir, logger))

    await model.load()
    t.pass('First load succeeded')

    const response1 = await model.run('The meeting starts at 10 AM.')
    let output1 = ''
    await response1.onUpdate(data => { output1 += data }).await()
    t.ok(output1.length > 0, `First translation produced output: "${output1}"`)

    await model.unload()
    t.pass('Unload succeeded')

    await model.load()
    t.pass('Reload succeeded')

    const response2 = await model.run('Please pass the salt.')
    let output2 = ''
    await response2.onUpdate(data => { output2 += data }).await()
    t.ok(output2.length > 0, `Second translation after reload produced output: "${output2}"`)

    t.pass('Load -> unload -> reload cycle completed successfully')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #6 — run() after unload() must throw, not crash
//
// WHY: Use-after-teardown is a common integrator mistake. It must surface a
// clear error rather than a segfault that takes down the whole app.
// ---------------------------------------------------------------------------

test('Bergamot [CPU] - run after unload throws', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelDir = await ensureBergamotModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(createStandaloneBergamotArgs(modelDir, logger))
    await model.load()
    await model.unload()

    try {
      await model.run('Hello')
      t.fail('Expected run() after unload to throw')
    } catch (e) {
      t.ok(e, 'run() after unload threw an error')
      t.comment('Error message: ' + e.message)
      t.pass('Unloaded model correctly rejects run()')
    }
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #8 — backend introspection reports 'Unloaded'/'' after unload
//
// WHY: This is the cheapest probe that the native backend was actually
// released (not just a JS flag flipped). If getActiveBackendName() still
// reports a live backend after unload, GPU/native resources are leaking.
// getActiveBackendDescription() is checked alongside it so both public
// backend-introspection getters are proven to reset on teardown.
// ---------------------------------------------------------------------------

test('Bergamot [CPU] - backend reports Unloaded after unload', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelDir = await ensureBergamotModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(createStandaloneBergamotArgs(modelDir, logger))
    await model.load()

    const loadedBackend = model.getActiveBackendName()
    t.comment(`Backend while loaded: ${loadedBackend}`)
    t.comment(`Backend description while loaded: "${model.getActiveBackendDescription()}"`)
    t.not(loadedBackend, 'Unloaded', 'backend should not report Unloaded while loaded')

    await model.unload()

    t.is(model.getActiveBackendName(), 'Unloaded', 'backend reports Unloaded after unload')
    t.is(model.getActiveBackendDescription(), '', 'backend description is empty after unload')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #9 — Streaming onUpdate fires at least once
//
// WHY: The SDK asserts >=1 streamed token; the addon only checks non-empty.
// A broken streaming pipe would ship green here and break any UI that shows
// incremental progress (typing indicator).
// ---------------------------------------------------------------------------

test('Bergamot [CPU] - streaming onUpdate fires at least once', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelDir = await ensureBergamotModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(createStandaloneBergamotArgs(modelDir, logger))
    await model.load()

    let updateCount = 0
    let output = ''
    const response = await model.run('Good morning, how are you?')
    await response.onUpdate(data => { updateCount++; output += data }).await()

    t.ok(updateCount >= 1, `onUpdate fired ${updateCount} time(s) (expected >= 1)`)
    t.ok(output.length > 0, 'streamed output is not empty')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #10 — Stats object has the expected shape
//
// WHY: The SDK reads stats.totalTokens and a timing field. The addon only
// logs stats today; a shape regression would break SDK consumers that parse
// it. We assert shape only — never specific values (hardware varies).
// ---------------------------------------------------------------------------

test('Bergamot [CPU] - stats object has expected shape', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelDir = await ensureBergamotModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(createStandaloneBergamotArgs(modelDir, logger))
    await model.load()

    const response = await model.run('Hello world')
    await response.onUpdate(() => {}).await()

    const stats = response.stats
    t.ok(stats && typeof stats === 'object', 'stats is an object')
    t.comment('Stats keys: ' + Object.keys(stats || {}).join(', '))
    t.ok(typeof stats.totalTokens === 'number', 'stats.totalTokens is a number')
    const hasTiming = typeof stats.totalTime === 'number' ||
      typeof stats.decodeTime === 'number' ||
      Object.keys(stats).some(k => k.endsWith('TPS'))
    t.ok(hasTiming, 'stats has a timing field (totalTime/decodeTime/TPS)')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #14 — Multi-cycle load/unload stress (accumulation leak catcher)
//
// WHY: A small per-unload leak passes a single cycle but crashes mobile on a
// later load (pool exhaustion). The existing C++ test does 2 cycles; this
// does enough to surface accumulation. On mobile we add a short settle wait
// so the allocator can reclaim pages before the next load.
// ---------------------------------------------------------------------------

test('Bergamot [CPU] - multi-cycle load/unload stress', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const modelDir = await ensureBergamotModel()
  const logger = createLogger()
  const CYCLES = 6

  for (let i = 1; i <= CYCLES; i++) {
    let model
    const started = Date.now()
    try {
      model = new TranslationNmtcpp(createStandaloneBergamotArgs(modelDir, logger))
      await model.load()

      const response = await model.run('Thank you very much')
      let output = ''
      await response.onUpdate(data => { output += data }).await()
      t.ok(output.length > 0, `cycle ${i}/${CYCLES} produced output`)
    } finally {
      if (model) {
        try { await model.unload() } catch (e) {
          t.comment(`cycle ${i} unload error: ${e.message}`)
        }
      }
    }
    t.comment(`cycle ${i}/${CYCLES} completed in ${Date.now() - started}ms`)

    // Mobile allocators (Android Scudo) need a moment to reclaim pages
    // before the next load, otherwise a fresh allocation can abort.
    if (isMobile) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  t.pass(`Completed ${CYCLES} load/unload cycles without failure`)
})
