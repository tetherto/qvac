'use strict'
/* global Bare */

if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('unhandledRejection', (err) => {
    console.error('[opencl-cache] Unhandled rejection:', err && (err.stack || err.message || err))
  })
}

/**
 * OpenCL kernel cache behaviour test (Android only).
 *
 * Runs a cold load + inference, destroys the model (which tears down the
 * OpenCL context via TranslationModel's destructor — see
 * {@link ../../addon/src/model-interface/TranslationModel.cpp}), then runs a
 * warm load + inference that should reuse cached kernels written to the
 * provided openclCacheDir.
 *
 * What we verify:
 *   - Asserted: the cache directory contains ≥ 1 blob after the first run.
 *   - Logged (not asserted): second-load total_time_ms < first-load × 0.5.
 *     Cache-hit speedup is device-dependent and too noisy to gate CI on;
 *     the log line is a soft signal surfaced to the Step Summary.
 *
 * Runs only on Android — OpenCL cache env var is Android-only
 * (`GGML_OPENCL_CACHE_DIR`, see NmtLazyInitializeBackend.cpp).
 */

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const {
  ensureIndicTransModel,
  createLogger,
  TEST_TIMEOUT,
  createPerformanceCollector,
  platform
} = require('./utils')

const TEST_SENTENCE = 'Hello, how are you?'

async function loadAndTranslate (t, { modelPath, openclCacheDir, label }) {
  const logger = createLogger()
  const perfCollector = createPerformanceCollector()
  const model = new TranslationNmtcpp({
    files: { model: modelPath },
    params: {
      mode: 'full',
      srcLang: 'eng_Latn',
      dstLang: 'hin_Deva'
    },
    config: {
      modelType: TranslationNmtcpp.ModelTypes.IndicTrans,
      use_gpu: true,
      openclCacheDir,
      beamsize: 1
    },
    logger,
    opts: { stats: true }
  })
  model.logger.setLevel('debug')

  const loadStart = Date.now()
  // If load() throws, the freshly-constructed model is otherwise unreachable
  // by the caller's finally block — tear it down explicitly so the native
  // OpenCL context is released deterministically (Bare/mobile GC timing is
  // non-deterministic). Mirrors the pattern in indictrans.test.js.
  try {
    await model.load()
  } catch (err) {
    try { await model.unload() } catch (_) { /* noop */ }
    throw err
  }
  const loadMs = Date.now() - loadStart
  const backendName = model.getActiveBackendName()
  t.comment(`${label} load wall-clock: ${loadMs} ms, backend=${backendName}`)

  perfCollector.start()
  const response = await model.run(TEST_SENTENCE)
  await response.onUpdate(d => perfCollector.onToken(d)).await()

  const addonStats = response.stats || {}
  const metrics = perfCollector.getMetrics(TEST_SENTENCE, addonStats)

  return { model, backendName, loadMs, metrics }
}

function dirHasBlob (dir) {
  try {
    if (!fs.existsSync(dir)) return false
    // Recursively walk the cache dir — ggml-opencl writes cache files in a
    // subdirectory layout that varies per implementation.
    const stack = [dir]
    while (stack.length > 0) {
      const cur = stack.pop()
      const entries = fs.readdirSync(cur, { withFileTypes: true })
      for (const ent of entries) {
        const full = path.join(cur, ent.name)
        if (ent.isDirectory()) {
          stack.push(full)
        } else if (ent.isFile()) {
          const st = fs.statSync(full)
          if (st.size > 0) return true
        }
      }
    }
    return false
  } catch (_) {
    return false
  }
}

test('OpenCL kernel cache populates on first load and persists (Android)', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  if (platform !== 'android') {
    t.comment(`SKIP: OpenCL cache test is Android-only (platform=${platform})`)
    t.pass('skipped on non-Android platform')
    return
  }

  const modelPath = await ensureIndicTransModel()
  const writableRoot = global.testDir || '/tmp'
  const cacheDir = path.join(writableRoot, `opencl-cache-test-${Date.now()}`)
  fs.mkdirSync(cacheDir, { recursive: true })
  t.comment(`Using OpenCL cache dir: ${cacheDir}`)

  let first, second
  try {
    first = await loadAndTranslate(t, {
      modelPath, openclCacheDir: cacheDir, label: '[COLD]'
    })

    // Soft-skip when OpenCL is not the active backend. This test exercises
    // OpenCL-specific plumbing (GGML_OPENCL_CACHE_DIR), which only applies
    // when the OpenCL backend is selected. Under the default USE_OPENCL=OFF
    // build (QVAC-17790 Adreno 830 mitigation) the selector picks Vulkan on
    // Android and the OpenCL cache dir stays empty by design. Callers that
    // want to exercise this path can set config.gpu_backend='opencl' (opt-in
    // bypass of the guard) once the upstream ggml fix for the q4_0 transpose
    // assertion lands.
    if (!/opencl/i.test(first.backendName)) {
      t.comment(`SKIP: active backend='${first.backendName}' — OpenCL cache test only applies when OpenCL is selected (USE_OPENCL=OFF default; set config.gpu_backend='opencl' to opt in)`)
      t.pass('skipped: OpenCL not the active compute backend')
      return
    }

    await first.model.unload()
    first.model = null

    t.ok(dirHasBlob(cacheDir), 'OpenCL cache dir should contain ≥1 kernel blob after first run')

    second = await loadAndTranslate(t, {
      modelPath, openclCacheDir: cacheDir, label: '[WARM]'
    })

    // Log-only signal. A true cache hit should give >=2x speedup on load;
    // we log the comparison and any significant regression becomes visible
    // in the Step Summary without gating CI.
    const firstTotal = first.metrics.totalTime
    const secondTotal = second.metrics.totalTime
    t.comment(`[COLD] total_time_ms=${firstTotal.toFixed(0)}`)
    t.comment(`[WARM] total_time_ms=${secondTotal.toFixed(0)}`)
    if (secondTotal < firstTotal * 0.5) {
      t.comment('Cache speedup observed: warm total_time_ms < 0.5 * cold')
    } else {
      t.comment(`NOTE: warm total_time_ms=${secondTotal.toFixed(0)} is NOT < 0.5 * cold=${firstTotal.toFixed(0)}`)
    }

    t.pass('OpenCL cache load/unload/load cycle completed')
  } finally {
    try { if (first && first.model) await first.model.unload() } catch (_) { /* noop */ }
    try { if (second && second.model) await second.model.unload() } catch (_) { /* noop */ }
  }
})
