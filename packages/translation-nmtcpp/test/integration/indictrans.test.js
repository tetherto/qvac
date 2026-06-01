'use strict'

/* global Bare */

/**
 * IndicTrans Backend Integration Test
 *
 * Tests the IndicTrans2 translation backend with English to Hindi translation.
 * Uses AI4Bharat's IndicTrans2 model with IndicProcessor for language-specific preprocessing.
 *
 * IndicProcessor:
 *   - Handles language-specific tokenization and preprocessing
 *   - No manual language prefixes needed (unlike raw model access)
 *
 * Platform Behavior:
 *   - GPU devices are discovered at runtime via probe loading (cached)
 *   - Each discovered GPU device gets its own test run with an identifiable
 *     label (e.g. [GPU:0 Vulkan0], [GPU:1 OpenCL0])
 *   - CPU always runs as a separate test
 *   - Device indices beyond those discovered are automatically skipped
 *
 * Usage:
 *   bare test/integration/indictrans.test.js
 */

// Guard against Bare's default abort() on unhandled promise rejections,
// then explicitly fail the process at exit time if any rejection was
// captured.
//
// Why we catch: without this, a transient network error from bare-fetch
// during model download (e.g. CONNECTION_LOST on Device Farm) abort()s
// the process and surfaces as a SIGABRT inside libbare-kit.so —
// which killed the Samsung S25 Ultra job in CI run 1212. We need
// the process to keep running long enough to log the rejection and
// flush console output.
//
// Why we ALSO exit non-zero on `beforeExit`: the previous handler just
// logged and returned, which let Bare exit cleanly with code 0. Device
// Farm then reported PASSED, GitHub Actions marked the job green, even
// though zero translation actually happened. By exiting 1 here we make
// "model download failed → no measurement" loud at every level (Bare
// → Device Farm → GHA), so CI fails RED whenever the test couldn't run
// instead of silently lying about it. See PR #1792 / QVAC-16488 thread
// for the full debugging trail.
let _indictransUnhandledRejection = null
if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('unhandledRejection', (err) => {
    console.error('[indictrans] Unhandled rejection:', err && (err.stack || err.message || err))
    if (!_indictransUnhandledRejection) _indictransUnhandledRejection = err
  })
  Bare.on('beforeExit', () => {
    if (_indictransUnhandledRejection) {
      console.error('[indictrans] FATAL: tests had unhandled rejections, exiting with code 1')
      if (typeof Bare.exit === 'function') Bare.exit(1)
      else if (typeof process !== 'undefined' && process.exit) process.exit(1)
    }
  })
}

const fs = require('bare-fs')
const test = require('brittle')
const path = require('bare-path')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const {
  ensureIndicTransModel,
  createLogger,
  TEST_TIMEOUT,
  createPerformanceCollector,
  formatPerformanceMetrics,
  isMobile,
  platform,
  discoverGpuDevices,
  MAX_GPU_DEVICE_PROBES,
  resolveExecutionProvider,
  CPU_SENTINEL_BACKENDS
} = require('./utils')

const INDICTRANS_FIXTURE = path.resolve(__dirname, 'fixtures/indictrans.quality.json')

const TEST_SENTENCE = 'Hello, how are you?'

/**
 * Per-device-class baselines, loaded once at module init. Any run that exceeds
 * a baseline emits a warning (t.comment) — we do NOT fail CI. Hard thresholds
 * are deferred until baseline variance is well-characterized.
 */
const BASELINES = (() => {
  try {
    const baselinePath = path.resolve(__dirname, 'fixtures/perf-baselines.json')
    if (!fs.existsSync(baselinePath)) return null
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  } catch (err) {
    // Fail soft (threshold checks become no-ops) but surface the parse failure
    // so a malformed perf-baselines.json doesn't silently disable regression
    // gating in CI.
    createLogger().warn(`[indictrans.test] failed to load perf-baselines.json: ${err && err.message ? err.message : err}`)
    return null
  }
})()

/**
 * Pick a baseline bucket for the current run.
 * Leaves matching up to the baseline file: we look for a bucket whose
 * { platform, execution_provider } matches. Returns null if nothing matches.
 */
function pickBaseline (baselines, ep) {
  if (!baselines || !Array.isArray(baselines.buckets)) return null
  return baselines.buckets.find(b =>
    b.platform === platform && b.execution_provider === ep) || null
}

/**
 * Compare metrics to a baseline bucket. Emits warnings via t.comment but
 * does not fail the test. This is intentionally soft.
 */
function compareToBaseline (t, label, metrics, baseline) {
  if (!baseline || !baseline.thresholds) return
  const th = baseline.thresholds
  if (typeof th.tps_min === 'number' && metrics.tps < th.tps_min) {
    t.comment(`${label} PERF WARN: tps=${metrics.tps.toFixed(2)} < baseline.tps_min=${th.tps_min}`)
  }
  if (typeof th.total_time_ms_max === 'number' &&
      metrics.totalTime > th.total_time_ms_max) {
    t.comment(`${label} PERF WARN: total_time_ms=${metrics.totalTime.toFixed(0)} > baseline.total_time_ms_max=${th.total_time_ms_max}`)
  }
}

/**
 * Shared runner that loads a model, translates TEST_SENTENCE once, records
 * perf metrics, and returns { metrics, translation, backendName }.
 *
 * The caller owns lifecycle assertions (backend presence, parity, etc.) —
 * this helper is deliberately focused on "run one sentence and collect".
 */
async function runSingleTranslation (t, { modelPath, logger, useGpu, gpuDevice, gpuBackend, label }) {
  const perfCollector = createPerformanceCollector()

  // OpenCL on Android needs a writable cache directory. If GGML_OPENCL_CACHE_DIR
  // is not set to an app-writable path, the backend's lazy kernel cache
  // falls back to a relative path that's unwritable inside the app sandbox
  // and ggml_abort()s during backend init. Pass an explicit openclCacheDir
  // whenever we exercise the Android GPU path so OpenCL initialises cleanly.
  const config = {
    modelType: TranslationNmtcpp.ModelTypes.IndicTrans,
    use_gpu: useGpu,
    // beamsize=1 for deterministic decode (parity check uses this)
    beamsize: 1
  }
  if (typeof gpuDevice === 'number') {
    config.gpu_device = gpuDevice
  }
  if (gpuBackend) {
    config.gpu_backend = gpuBackend
  }
  if (useGpu && platform === 'android') {
    const writableRoot = global.testDir || '/tmp'
    config.openclCacheDir = path.join(writableRoot, 'opencl-cache-indictrans')
    if (!fs.existsSync(config.openclCacheDir)) {
      fs.mkdirSync(config.openclCacheDir, { recursive: true })
    }
  }

  const model = new TranslationNmtcpp({
    files: { model: modelPath },
    params: {
      mode: 'full',
      srcLang: 'eng_Latn',
      dstLang: 'hin_Deva'
    },
    config,
    logger,
    opts: { stats: true }
  })
  model.logger.setLevel('debug')

  // If load() throws the freshly-constructed model is otherwise unreachable;
  // the caller's finally block won't see it because we never returned.
  // Tear it down explicitly before propagating so the native context is
  // released deterministically (Bare/mobile GC timing is non-deterministic).
  try {
    await model.load()
  } catch (err) {
    try { await model.unload() } catch (_) { /* noop */ }
    throw err
  }

  try {
    t.pass(`${label} IndicTrans model loaded successfully`)

    const backendName = model.getActiveBackendName()
    t.comment(`${label} Active backend: ${backendName}`)

    perfCollector.start()
    const response = await model.run(TEST_SENTENCE)
    await response
      .onUpdate(data => perfCollector.onToken(data))
      .await()

    const addonStats = response.stats || {}
    t.comment(`${label} Native addon stats: ` + JSON.stringify(addonStats))
    const metrics = perfCollector.getMetrics(TEST_SENTENCE, addonStats)

    return { model, metrics, backendName, translation: metrics.fullOutput }
  } catch (err) {
    try { await model.unload() } catch (_) { /* noop */ }
    throw err
  }
}

// --------------------------------------------------------------------------
// Per-GPU-device tests.  We register one test slot per device index (0..MAX)
// plus a CPU-only test.  At runtime each GPU slot calls discoverGpuDevices()
// (cached) and self-skips when the probed index doesn't exist.
// --------------------------------------------------------------------------

for (let gpuIdx = 0; gpuIdx < MAX_GPU_DEVICE_PROBES; gpuIdx++) {
  test(`IndicTrans backend [GPU device ${gpuIdx}] - English to Hindi translation`, { timeout: TEST_TIMEOUT }, async function (t) {
    const modelPath = await ensureIndicTransModel()
    const devices = await discoverGpuDevices()
    const device = devices[gpuIdx]

    if (!device) {
      t.comment(`[GPU:${gpuIdx}] No unique physical GPU at slot ${gpuIdx} — skipping`)
      t.pass(`[GPU:${gpuIdx}] Skipped (device not present)`)
      return
    }

    const descTag = device.description ? ' ' + device.description : ''
    const label = `[GPU:${device.index} ${device.name}${descTag}]`
    t.ok(modelPath, `${label} IndicTrans model path should be available`)
    t.comment(`${label} Model path: ` + modelPath)
    t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
    t.comment(`${label} Testing with use_gpu: true, gpu_device: ${device.index}`)

    const logger = createLogger()
    let model

    try {
      const run = await runSingleTranslation(t, {
        modelPath,
        logger,
        useGpu: true,
        gpuDevice: device.index,
        label
      })
      model = run.model
      const { metrics, backendName } = run

      // Soft check: the per-device test is intended to exercise a real GPU
      // backend at this index, but if GGML silently falls back to a CPU
      // sentinel (loader-fix not available on this platform yet, transient
      // backend init failure, etc.) we don't want CI to go red on a
      // perf-only test. Surface it as a comment so it shows up in the test
      // log without failing the build. CPU_SENTINEL_BACKENDS keeps this in
      // sync with resolveExecutionProvider's notion of "fallback".
      if (CPU_SENTINEL_BACKENDS.has(backendName)) {
        t.comment(`${label} WARN: backend resolved to ${backendName} (silent GPU fallback)`)
      }

      const executionProvider = resolveExecutionProvider(backendName, true)

      t.comment(formatPerformanceMetrics(`[IndicTrans] ${label}`, metrics, {
        fixturePath: INDICTRANS_FIXTURE,
        srcLang: 'eng_Latn',
        dstLang: 'hin_Deva',
        execution_provider: executionProvider
      }))

      t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)

      compareToBaseline(t, label, metrics,
        pickBaseline(BASELINES, executionProvider))

      t.pass(`${label} IndicTrans translation completed successfully`)
    } catch (e) {
      t.fail(`${label} IndicTrans test failed: ` + e.message)
      throw e
    } finally {
      if (model) {
        try {
          await model.unload()
          t.pass(`${label} After model.unload().`)
        } catch (e) {
          t.comment(`${label} unload() error: ` + e.message)
        }
      }
    }
  })
}

// CPU-only test
test('IndicTrans backend [CPU] - English to Hindi translation', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const label = '[CPU]'
  t.ok(modelPath, `${label} IndicTrans model path should be available`)
  t.comment(`${label} Model path: ` + modelPath)
  t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
  t.comment(`${label} Testing with use_gpu: false`)

  const logger = createLogger()
  let model

  try {
    const run = await runSingleTranslation(t, {
      modelPath,
      logger,
      useGpu: false,
      label
    })
    model = run.model
    const { metrics, backendName } = run

    const executionProvider = resolveExecutionProvider(backendName, false)

    t.comment(formatPerformanceMetrics(`[IndicTrans] ${label}`, metrics, {
      fixturePath: INDICTRANS_FIXTURE,
      srcLang: 'eng_Latn',
      dstLang: 'hin_Deva',
      execution_provider: executionProvider
    }))

    t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)

    compareToBaseline(t, label, metrics,
      pickBaseline(BASELINES, executionProvider))

    t.pass(`${label} IndicTrans translation completed successfully`)
  } catch (e) {
    t.fail(`${label} IndicTrans test failed: ` + e.message)
    throw e
  } finally {
    if (model) {
      try {
        await model.unload()
        t.pass(`${label} After model.unload().`)
      } catch (e) {
        t.comment(`${label} unload() error: ` + e.message)
      }
    }
  }
})

// --------------------------------------------------------------------------
// Synthetic platform [GPU] row — always runs on DESKTOP only (QVAC-17837)
//
// The per-device tests above self-skip when discoverGpuDevices() returns
// empty, which is the desktop reality on the 4 hosted Linux runners today
// (no GGML GPU loader bound). To make the on-PR Step Summary always show a
// GPU lane next to the CPU lane on every desktop platform, this test:
//   - always runs on desktop (no probe-based skip),
//   - requests use_gpu: true with no explicit gpu_device (lets GGML pick),
//   - records perf regardless of the resolved backend,
//   - never fails on silent CPU fallback,
//   - tags execution_provider as 'cpu (fallback)' when GPU didn't resolve,
//     and as the real backend tag (vulkan/metal/opencl/...) when it did.
//
// Once Ian's GPU loader fix lands per platform (QVAC-17640 / QVAC-17880),
// the same row's EP automatically flips from 'cpu (fallback)' to the real
// backend without further CI wiring.
//
// Mobile is intentionally excluded: the per-device probe loop above already
// produces meaningful [GPU:0 Vulkan0] / [GPU:0 Metal] rows on mobile, and a
// default-device synthetic row would just duplicate one of those.
// --------------------------------------------------------------------------

if (!isMobile) {
  test('IndicTrans backend [GPU] - English to Hindi translation (fallback-aware)',
    { timeout: TEST_TIMEOUT }, async function (t) {
      const modelPath = await ensureIndicTransModel()
      const label = '[GPU]'
      t.ok(modelPath, `${label} IndicTrans model path should be available`)
      t.comment(`${label} Model path: ${modelPath}`)
      t.comment(`Platform: ${platform}, isMobile: ${isMobile}`)
      t.comment(`${label} Testing with use_gpu: true (default device — fallback-aware)`)

      const logger = createLogger()
      let model

      try {
        const run = await runSingleTranslation(t, {
          modelPath,
          logger,
          useGpu: true,
          // No gpuDevice — let GGML pick its default. When the loader fix
          // isn't available the addon will emit a CPU sentinel and we'll
          // record it as fallback rather than failing.
          label
        })
        model = run.model
        const { metrics, backendName } = run

        const executionProvider = resolveExecutionProvider(backendName, true)
        t.comment(`${label} resolved EP: ${executionProvider} (backendName=${backendName})`)

        t.comment(formatPerformanceMetrics(`[IndicTrans] ${label}`, metrics, {
          fixturePath: INDICTRANS_FIXTURE,
          srcLang: 'eng_Latn',
          dstLang: 'hin_Deva',
          execution_provider: executionProvider
        }))

        t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)

        compareToBaseline(t, label, metrics,
          pickBaseline(BASELINES, executionProvider))

        t.pass(`${label} IndicTrans translation completed (ep=${executionProvider})`)
      } catch (e) {
        t.fail(`${label} IndicTrans test failed: ${e.message}`)
        throw e
      } finally {
        if (model) {
          try { await model.unload() } catch (e) {
            t.comment(`${label} unload() error: ${e.message}`)
          }
        }
      }
    })
}

// --------------------------------------------------------------------------
// Phase 2.2 — CPU vs GPU output parity (one test per discovered GPU device)
// --------------------------------------------------------------------------

test('IndicTrans CPU vs GPU output parity (EN->Hindi, beam=1)', { timeout: TEST_TIMEOUT * (MAX_GPU_DEVICE_PROBES + 1) }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const devices = await discoverGpuDevices()

  if (devices.length === 0) {
    if (isMobile) {
      t.fail('Expected at least one GPU device on mobile')
    } else {
      t.comment('SOFT-SKIP: no GPU devices discovered — parity test is vacuous')
      t.pass('Skipped (no GPU devices)')
    }
    return
  }

  t.comment('Discovered GPU devices: ' +
    devices.map(d => `${d.name}${d.description ? ' (' + d.description + ')' : ''} [index ${d.index}]`).join(', '))

  const logger = createLogger()

  // Run CPU once — reuse the translation for all parity comparisons
  let cpuRun
  try {
    cpuRun = await runSingleTranslation(t, {
      modelPath,
      logger,
      useGpu: false,
      label: '[PARITY] CPU'
    })
    await cpuRun.model.unload()
    cpuRun.model = null
  } catch (e) {
    t.fail('Parity CPU leg failed: ' + e.message)
    throw e
  }

  const cpuOut = (cpuRun.translation || '').trim()
  t.comment(`[PARITY] CPU -> "${cpuOut}"`)

  for (const device of devices) {
    const parityDesc = device.description ? ' ' + device.description : ''
    const parityLabel = `[PARITY:${device.index} ${device.name}${parityDesc}]`
    let gpuRun
    try {
      gpuRun = await runSingleTranslation(t, {
        modelPath,
        logger,
        useGpu: true,
        gpuDevice: device.index,
        label: parityLabel
      })

      const gpuOut = (gpuRun.translation || '').trim()
      t.comment(`${parityLabel} -> "${gpuOut}"`)

      if (cpuOut === gpuOut) {
        t.pass(`${parityLabel} CPU and ${device.name} outputs are string-equal`)
      } else {
        let evaluateQuality
        try {
          const qmBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
          evaluateQuality = require(path.join(qmBase, 'quality-metrics')).evaluateQuality
        } catch (e) {
          t.comment(`Could not load quality-metrics: ${e.message}`)
        }

        if (evaluateQuality) {
          const q = evaluateQuality([gpuOut], { reference_text: cpuOut })
          const cer = typeof q.cer === 'number' ? q.cer : 1
          t.comment(`${parityLabel} CER = ${(cer * 100).toFixed(2)}%`)
          t.ok(cer < 0.01, `${parityLabel} outputs should match within CER<1% (got ${(cer * 100).toFixed(2)}%)`)
        } else {
          t.is(gpuOut, cpuOut, `${parityLabel} outputs must match`)
        }
      }
    } catch (e) {
      t.fail(`${parityLabel} parity test failed: ` + e.message)
    } finally {
      if (gpuRun && gpuRun.model) {
        try { await gpuRun.model.unload() } catch (_) { /* noop */ }
      }
    }
  }
})

// --------------------------------------------------------------------------
// Vulkan vs OpenCL backend comparison.
// When USE_OPENCL is enabled at build time (assuming upstream ggml fix for
// the Adreno 830 q4_0 transpose assertion), this test exercises both
// backends on the same physical GPU and compares performance.
// --------------------------------------------------------------------------

// SKIP: IndicTrans on OpenCL triggers GGML_ASSERT(M % 4 == 0) in
// ggml-opencl.cpp:3758 on Adreno 830 (Samsung S25 Ultra), causing SIGABRT.
// Disabled until the upstream ggml-opencl kernel supports non-aligned matrix
// dimensions for this model architecture.
test('IndicTrans backend comparison [Vulkan vs OpenCL]', { timeout: TEST_TIMEOUT * 4, skip: true }, async function (t) {
  // OpenCL crashes on IndicTrans (ggml-opencl M%4 assertion on Adreno 830)
  t.pass()
})

// ===========================================================================
// Standalone IndicTrans coverage (QVAC-19836)
//
// The addon tests above cover EN->Hindi happy paths and CPU/GPU parity, but
// the reverse direction, batch path, lifecycle reload, use-after-unload,
// cancel, and resource-release checks are only proven for the pivot model.
// These tests bring the standalone IndicTrans path to parity and add the
// resource-release coverage no IndicTrans test has today.
//
// All run CPU-only: these tests exercise JS-level lifecycle/API behaviour
// that is backend-independent, so CPU keeps them deterministic and fast on
// the hosted desktop runners (the per-GPU happy-path coverage already lives
// in the tests above).
// ===========================================================================

/**
 * Builds standalone IndicTrans constructor args (CPU) for a given direction.
 */
function createStandaloneIndicArgs (modelPath, logger, srcLang, dstLang) {
  return {
    files: { model: modelPath },
    params: { mode: 'full', srcLang, dstLang },
    config: {
      modelType: TranslationNmtcpp.ModelTypes.IndicTrans,
      use_gpu: false,
      beamsize: 1
    },
    logger,
    opts: { stats: true }
  }
}

// ---------------------------------------------------------------------------
// #1 — Reverse direction: Hindi -> English
//
// WHY: Users translate both ways. Every IndicTrans test today is EN->HI, so
// a regression in the reverse direction would ship with no addon-level
// signal. Asserts type + non-empty only (Latin output, no keyword lock-in).
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - Hindi to English translation', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(
      createStandaloneIndicArgs(modelPath, logger, 'hin_Deva', 'eng_Latn')
    )
    await model.load()

    const response = await model.run('नमस्ते, आप कैसे हैं? आज मौसम बहुत अच्छा है।')
    let output = ''
    await response.onUpdate(data => { output += data }).await()

    t.ok(typeof output === 'string', 'output is a string')
    t.ok(output.length > 0, `HI->EN translation produced output: "${output}"`)
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #3 — Standalone batch translation via runBatch()
//
// WHY: runBatch() drives the native batch path, distinct from run(). Only
// pivot batch is tested today; IndicTrans batch has zero coverage.
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - standalone batch translation via runBatch()', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(
      createStandaloneIndicArgs(modelPath, logger, 'eng_Latn', 'hin_Deva')
    )
    await model.load()

    const inputs = ['Good morning', 'Thank you for your help']
    const results = await model.runBatch(inputs)

    t.ok(Array.isArray(results), 'batch results should be an array')
    t.is(results.length, inputs.length, `should return ${inputs.length} translations`)
    for (let i = 0; i < results.length; i++) {
      t.ok(typeof results[i] === 'string', `result[${i}] should be a string`)
      t.ok(results[i].length > 0, `result[${i}] should not be empty`)
      t.comment(`  "${inputs[i]}" -> "${results[i]}"`)
    }
    t.pass('Standalone IndicTrans batch translation completed')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #5 — Load -> use -> unload -> reload -> use cycle
//
// WHY: IndicTrans uses a different native loader from Bergamot. Reload is
// only proven for the pivot model, so a reload regression specific to the
// IndicTrans GGML path would go uncaught.
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - load, unload, reload cycle', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(
      createStandaloneIndicArgs(modelPath, logger, 'eng_Latn', 'hin_Deva')
    )

    await model.load()
    const r1 = await model.run('Where is the nearest hospital?')
    let out1 = ''
    await r1.onUpdate(data => { out1 += data }).await()
    t.ok(out1.length > 0, `First translation produced output: "${out1}"`)

    await model.unload()
    t.pass('Unload succeeded')

    await model.load()
    const r2 = await model.run('I need to book a flight.')
    let out2 = ''
    await r2.onUpdate(data => { out2 += data }).await()
    t.ok(out2.length > 0, `Second translation after reload produced output: "${out2}"`)

    t.pass('Load -> unload -> reload cycle completed successfully')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #6 — run() after unload() must throw, not crash
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - run after unload throws', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(
      createStandaloneIndicArgs(modelPath, logger, 'eng_Latn', 'hin_Deva')
    )
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
// #7 — Cancel mid-inference, then prove the model is still usable
//
// WHY: Cancelling a translation must not corrupt the model's internal state.
// If it does, the user has to restart the whole process. Only pivot cancel
// is tested today, and it does not verify reusability after cancel.
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - cancel mid-inference leaves model reusable', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(
      createStandaloneIndicArgs(modelPath, logger, 'eng_Latn', 'hin_Deva')
    )
    await model.load()

    const longText = 'This is a deliberately long sentence intended to give the ' +
      'translation process enough work to still be running when we cancel it, ' +
      'so that the cancel path is exercised mid-inference rather than after ' +
      'the job has already completed on its own.'

    const response = await model.run(longText)
    await response.cancel()
    t.pass('cancel() during translation did not crash')

    // Let the cancelled job fully settle before the next run. IndicTrans
    // cancel is best-effort (the native job may run to completion), and the
    // addon routes addon output to whichever response is currently active.
    // Without draining the first response, its trailing output would bleed
    // into the second run and we'd assert on the wrong text. await() resolves
    // on the cancelled response's terminal settle (end or cancel-driven
    // error); we ignore the outcome and only use it as a barrier.
    try { await response.await() } catch (_) { /* cancelled job may settle as error */ }

    // Prove the model is still usable after a cancel — use a distinct input
    // whose translation is short, so a non-empty result genuinely reflects
    // the second request rather than leftover output from the first.
    const r2 = await model.run('Thank you')
    let out2 = ''
    await r2.onUpdate(data => { out2 += data }).await()
    t.ok(out2.length > 0, `model still translates after cancel: "${out2}"`)
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})

// ---------------------------------------------------------------------------
// #8 — backend introspection reports 'Unloaded'/'' after unload
//
// Checks both public backend-introspection getters reset on teardown:
// getActiveBackendName() is the resource-release proof; getActiveBackendDescription()
// is verified alongside so the cosmetic GPU-name getter can't silently retain
// a stale device string after unload.
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - backend reports Unloaded after unload', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(
      createStandaloneIndicArgs(modelPath, logger, 'eng_Latn', 'hin_Deva')
    )
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
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - streaming onUpdate fires at least once', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(
      createStandaloneIndicArgs(modelPath, logger, 'eng_Latn', 'hin_Deva')
    )
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
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - stats object has expected shape', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(
      createStandaloneIndicArgs(modelPath, logger, 'eng_Latn', 'hin_Deva')
    )
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
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - multi-cycle load/unload stress', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  const CYCLES = 6

  for (let i = 1; i <= CYCLES; i++) {
    let model
    const started = Date.now()
    try {
      model = new TranslationNmtcpp(
        createStandaloneIndicArgs(modelPath, logger, 'eng_Latn', 'hin_Deva')
      )
      await model.load()

      const response = await model.run('Thank you')
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
    if (isMobile) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  t.pass(`Completed ${CYCLES} load/unload cycles without failure`)
})

// ---------------------------------------------------------------------------
// #15 — Cancel then immediate destroy (race condition)
//
// WHY: The most dangerous teardown race — cancel's async resolution can
// overlap the destroy thread-join. If they collide, you get a use-after-free
// crash. This test sequences them back-to-back without awaiting cancel.
// ---------------------------------------------------------------------------

test('IndicTrans [CPU] - cancel then immediate destroy does not crash', { timeout: TEST_TIMEOUT }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()
  let model

  try {
    model = new TranslationNmtcpp(
      createStandaloneIndicArgs(modelPath, logger, 'eng_Latn', 'hin_Deva')
    )
    await model.load()

    const longText = 'This is a long sentence that should keep the translation ' +
      'busy for long enough that destroying the model immediately after cancel ' +
      'exercises the teardown race rather than a clean post-completion destroy.'

    const response = await model.run(longText)
    response.cancel()
    await model.destroy()

    t.pass('cancel() then destroy() did not crash')
    t.ok(model.getState().destroyed === true, 'model state marked destroyed')
  } finally {
    if (model) {
      try { await model.destroy() } catch (_) {}
    }
  }
})
