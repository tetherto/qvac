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

// Guard against Bare's default abort() on unhandled promise rejections.
// Without this, a transient network error from bare-fetch during model
// download (e.g. CONNECTION_LOST on Device Farm) abort()s the process
// and surfaces as a SIGABRT inside libbare-kit.so::js_callback_s::on_call
// — which is how the Android Samsung S25 Ultra job died in CI run 1212.
// Mirrors the handler in pivot-bergamot.test.js.
if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('unhandledRejection', (err) => {
    console.error('[indictrans] Unhandled rejection:', err && (err.stack || err.message || err))
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
  MAX_GPU_DEVICE_PROBES
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
async function runSingleTranslation (t, { modelPath, logger, useGpu, gpuDevice, label }) {
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
    const device = devices.find(d => d.index === gpuIdx)

    if (!device) {
      t.comment(`[GPU:${gpuIdx}] No GPU device at index ${gpuIdx} — skipping`)
      t.pass(`[GPU:${gpuIdx}] Skipped (device not present)`)
      return
    }

    const label = `[GPU:${gpuIdx} ${device.name}]`
    t.ok(modelPath, `${label} IndicTrans model path should be available`)
    t.comment(`${label} Model path: ` + modelPath)
    t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
    t.comment(`${label} Testing with use_gpu: true, gpu_device: ${gpuIdx}`)

    const logger = createLogger()
    let model

    try {
      const run = await runSingleTranslation(t, {
        modelPath,
        logger,
        useGpu: true,
        gpuDevice: gpuIdx,
        label
      })
      model = run.model
      const { metrics, backendName } = run

      t.not(backendName, 'CPU', `${label} active backend should not be CPU`)

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

/**
 * Normalize the active-backend string into a perf-report tag.
 *
 * - Non-sentinel names map to lowercased, whitespace-stripped device names
 *   (e.g. 'Vulkan0' -> 'vulkan0', 'OpenCL' -> 'opencl').
 * - Sentinels / unavailable backends fall back to the platform-derived tag
 *   so the EP column in Step Summary is still populated.
 */
function resolveExecutionProvider (backendName, useGpu) {
  if (backendName && backendName !== 'CPU' && backendName !== 'Unloaded' &&
      backendName !== 'Bergamot-CPU') {
    return backendName.toLowerCase().replace(/\s+/g, '-').replace(/\d+$/, '')
  }
  if (!useGpu) return 'cpu'
  // Android default is Vulkan since QVAC-17790 set USE_OPENCL=OFF; explicit
  // OpenCL opt-in via config.gpu_backend='opencl' takes the non-fallback
  // branch above where backendName is the actual ggml device name.
  if (platform === 'android') return 'vulkan'
  if (platform === 'ios' || platform === 'darwin') return 'metal'
  return 'vulkan'
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
    devices.map(d => `${d.name} (index ${d.index})`).join(', '))

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
    const parityLabel = `[PARITY:${device.index} ${device.name}]`
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
