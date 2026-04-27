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
 *   - Mobile (iOS/Android): Tests both CPU and GPU modes
 *   - Desktop (Linux/Windows/macOS): Tests both CPU and GPU (Vulkan) modes
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
  platform
} = require('./utils')

const INDICTRANS_FIXTURE = path.resolve(__dirname, 'fixtures/indictrans.quality.json')

/**
 * Device configurations for testing.
 *
 * The previous isMobile gate for GPU was removed — desktop now runs both CPU
 * and Vulkan. Runners without a usable GPU backend still exercise the code
 * path; the per-run assertion soft-skips on desktop when the GGML scheduler
 * returns CPU, and hard-fails on mobile (where GPU is required).
 */
const DEVICE_CONFIGS = [
  { id: 'gpu', useGpu: true },
  { id: 'cpu', useGpu: false }
]

const TEST_SENTENCE = 'Hello, how are you?'

/**
 * Per-device-class baselines, loaded once at module init. Any run that exceeds
 * a baseline emits a warning (t.comment) — we do NOT fail CI. Hard thresholds
 * are deferred until baseline variance is well-characterized.
 */
const BASELINES = (() => {
  try {
    const baselinePath = path.resolve(__dirname, 'perf-baselines.json')
    if (!fs.existsSync(baselinePath)) return null
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  } catch (err) {
    // Fail soft (threshold checks become no-ops) but surface the parse failure
    // so a malformed perf-baselines.json doesn't silently disable regression
    // gating in CI.
    // eslint-disable-next-line no-console
    console.warn(`[indictrans.test] failed to load perf-baselines.json: ${err && err.message ? err.message : err}`)
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
async function runSingleTranslation (t, { modelPath, logger, useGpu, label }) {
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
  await model.load()
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
}

for (const deviceConfig of DEVICE_CONFIGS) {
  const label = `[${deviceConfig.id.toUpperCase()}]`

  test(`IndicTrans backend ${label} - English to Hindi translation`, { timeout: TEST_TIMEOUT }, async function (t) {
    const modelPath = await ensureIndicTransModel()
    t.ok(modelPath, `${label} IndicTrans model path should be available`)
    t.comment(`${label} Model path: ` + modelPath)
    t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
    t.comment(`${label} Testing with use_gpu: ${deviceConfig.useGpu}`)

    const logger = createLogger()
    let model

    try {
      const run = await runSingleTranslation(t, {
        modelPath, logger, useGpu: deviceConfig.useGpu, label
      })
      model = run.model
      const { metrics, backendName } = run

      // Phase 2.1 assertion: when useGpu=true, the active backend must not be
      // the CPU fallback. On desktop, we soft-skip with a warning — runner
      // configuration (e.g. no Vulkan ICD installed) can legitimately force
      // CPU fallback and must not fail CI. On mobile we hard-fail because
      // OpenCL/Metal are a hard requirement there.
      if (deviceConfig.useGpu) {
        if (backendName === 'CPU') {
          if (isMobile) {
            t.fail(`${label} expected a GPU backend but got CPU fallback`)
          } else {
            t.comment(`${label} SOFT-SKIP: backend=CPU on desktop GPU run; likely no GPU ICD on runner`)
          }
        } else {
          t.not(backendName, 'CPU', `${label} active backend should not be CPU when useGpu=true`)
        }
      }

      // Phase 4.3: use the runtime backend name as the execution_provider
      // tag. Fallback to the platform+useGpu string when the backend name
      // looks like a sentinel, so reports stay sliceable when the assertion
      // soft-skip above fires.
      const executionProvider = resolveExecutionProvider(backendName, deviceConfig.useGpu)

      t.comment(formatPerformanceMetrics(`[IndicTrans] ${label}`, metrics, {
        fixturePath: INDICTRANS_FIXTURE,
        srcLang: 'eng_Latn',
        dstLang: 'hin_Deva',
        execution_provider: executionProvider
      }))

      t.ok(metrics.fullOutput.length > 0, `${label} translation should not be empty`)

      // Phase 4.2: compare to baseline (warn-only).
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
    return backendName.toLowerCase().replace(/\s+/g, '-')
  }
  if (!useGpu) return 'cpu'
  if (platform === 'android') return 'opencl'
  if (platform === 'ios' || platform === 'darwin') return 'metal'
  return 'vulkan'
}

// --------------------------------------------------------------------------
// Phase 2.2 — CPU vs GPU output parity
// --------------------------------------------------------------------------

test('IndicTrans CPU vs GPU output parity (EN->Hindi, beam=1)', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const modelPath = await ensureIndicTransModel()
  const logger = createLogger()

  let cpuRun, gpuRun
  try {
    cpuRun = await runSingleTranslation(t, {
      modelPath, logger, useGpu: false, label: '[PARITY-CPU]'
    })
    await cpuRun.model.unload()
    cpuRun.model = null

    gpuRun = await runSingleTranslation(t, {
      modelPath, logger, useGpu: true, label: '[PARITY-GPU]'
    })
  } catch (e) {
    t.fail('Parity test setup failed: ' + e.message)
    throw e
  }

  try {
    // Soft-skip rule: if the "GPU" leg actually ran on CPU, both legs are
    // identical by construction — parity is vacuously true and uninformative.
    if (gpuRun.backendName === 'CPU') {
      if (isMobile) {
        t.fail('Expected a GPU backend on mobile but got CPU fallback')
      } else {
        t.comment('SOFT-SKIP: GPU leg ran on CPU (no desktop GPU backend); parity is vacuous')
        return
      }
    }

    const cpuOut = (cpuRun.translation || '').trim()
    const gpuOut = (gpuRun.translation || '').trim()
    t.comment(`[PARITY-CPU] -> "${cpuOut}"`)
    t.comment(`[PARITY-GPU] -> "${gpuOut}" (backend=${gpuRun.backendName})`)

    if (cpuOut === gpuOut) {
      t.pass('CPU and GPU outputs are string-equal')
      return
    }

    // Fall back to CER < 1% — CPU and GPU kernels can diverge by a character
    // or two on numerically-sensitive inputs without being "wrong".
    let evaluateQuality
    try {
      // Dynamic require to avoid bare-pack issues on mobile bundling.
      const qmBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
      evaluateQuality = require(path.join(qmBase, 'quality-metrics')).evaluateQuality
    } catch (e) {
      t.comment(`Could not load quality-metrics: ${e.message}`)
    }

    if (evaluateQuality) {
      const q = evaluateQuality([gpuOut], { reference_text: cpuOut })
      const cer = typeof q.cer === 'number' ? q.cer : 1
      t.comment(`CPU/GPU CER = ${(cer * 100).toFixed(2)}%`)
      t.ok(cer < 0.01, `CPU/GPU outputs should match within CER<1% (got ${(cer * 100).toFixed(2)}%)`)
    } else {
      // Without CER we can't soften the check; require string equality.
      t.is(gpuOut, cpuOut, 'CPU and GPU outputs must match')
    }
  } finally {
    try { if (gpuRun && gpuRun.model) await gpuRun.model.unload() } catch (_) { /* noop */ }
    try { if (cpuRun && cpuRun.model) await cpuRun.model.unload() } catch (_) { /* noop */ }
  }
})
