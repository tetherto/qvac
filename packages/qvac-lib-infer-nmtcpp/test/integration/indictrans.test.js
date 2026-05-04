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
