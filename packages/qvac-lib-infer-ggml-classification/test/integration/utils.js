'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')

const platform = process.platform
const isMobile = platform === 'ios' || platform === 'android'

// Dynamic require via path.join prevents bare-pack from statically resolving
// the script path at mobile bundle time.
let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  // Fallback no-op reporter when running against a published tarball that
  // does not include the script-utils tree.
  createPerformanceReporter = function (opts) {
    return {
      record () {},
      toJSON () { return { schema_version: '1.0', addon: opts.addon, results: [] } },
      writeReport () {},
      writeStepSummary () {},
      get length () { return 0 }
    }
  }
}

const _perfReporter = createPerformanceReporter({
  addon: 'ggml-classification',
  addonType: 'generic'
})

const _reportPath = path.resolve(__dirname, '../../test/results/performance-report.json')
let _exitHookInstalled = false

function _installExitHook () {
  if (_exitHookInstalled) return
  _exitHookInstalled = true
  // Final flush on clean exit. We additionally write after every metric
  // so partial reports survive crashes (SIGSEGV, abort) — the on-exit
  // hook only guarantees the GitHub Step Summary write, since the JSON
  // file has already been written incrementally.
  process.on('exit', () => {
    if (_perfReporter.length > 0) {
      _perfReporter.writeReport(_reportPath)
      _perfReporter.writeStepSummary()
    }
  })
}

function _flushReport () {
  if (_perfReporter.length === 0) return
  // Crash-survivable: every recorded metric immediately persists to
  // disk so even SIGSEGV mid-test leaves us with a partial latency
  // picture for the metrics that completed.
  _perfReporter.writeReport(_reportPath)
}

const DESKTOP_TIMEOUT = 120 * 1000
const MOBILE_TIMEOUT = 600 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

function createLogger () {
  return {
    error: (msg) => console.log('[C++ ERROR]:', msg),
    warn: (msg) => console.log('[C++ WARN]:', msg),
    info: (msg) => console.log('[C++ INFO]:', msg),
    debug: (msg) => console.log('[C++ DEBUG]:', msg),
    getLevel: () => 'debug'
  }
}

const IMAGE_DIR = path.resolve(__dirname, '..', 'images')

const IMAGE_SAMPLES = [
  { file: 'meal_1.jpg', expected: 'food' },
  { file: 'meal_2.jpg', expected: 'food' },
  { file: 'report_1.jpg', expected: 'report' },
  { file: 'report_2.jpg', expected: 'report' },
  { file: 'other_1.jpg', expected: 'other' },
  { file: 'other_2.jpg', expected: 'other' }
]

const MODEL_FILENAME = 'mobilenetv3_3class_v3_fp16.gguf'
// On mobile, the React Native bundler in qvac-test-addon-mobile only
// recognises a fixed set of asset extensions (`so, bin, model, bundle,
// raw, onnx` per its metro.config.js). `.gguf` is not in that list, so
// we package the weights under a `.gguf.bin` filename in
// `test/mobile/testAssets/` -- see `scripts/copy-mobile-test-assets.js`.
// Lookup on the device must therefore use the `.bin` filename.
const MOBILE_MODEL_FILENAME = MODEL_FILENAME + '.bin'

/**
 * Resolves the GGUF weights path for the integration suite.
 *
 * On desktop, returns `undefined` so `new ImageClassifier()` falls
 * back to its built-in default (the bundled `weights/` directory next
 * to `index.js`).
 *
 * On mobile (ios / android), the bare worklet runs from a packed
 * `app.bundle` whose `weights/` directory is not a real filesystem
 * path. The qvac-test-addon-mobile framework copies anything under
 * `test/mobile/testAssets/` to the device and exposes the resulting
 * on-device file:// URLs through `global.assetPaths`, keyed by
 * relative paths from the test module's perspective. We try the
 * common key formats (matching `qvac-lib-infer-nmtcpp:loadConfigFromAssets`)
 * and fall back to a desktop-style fs lookup so local non-CI builds
 * keep working too.
 *
 * If on mobile and the asset cannot be located, throw a clear error
 * up-front rather than letting `ImageClassifier.load()` fail with the
 * opaque `app.bundle/...` path -- crucially, throwing synchronously
 * here lets the caller surface it as a brittle assertion failure
 * rather than an unhandled promise rejection that aborts the bare
 * worklet (the iOS Application_Crash_Report.ips signature we hit in
 * CI runs 24891210942 and 24900278513).
 */
function resolveModelPath () {
  if (isMobile && typeof global !== 'undefined' && global.assetPaths) {
    const candidates = [
      `../../testAssets/${MOBILE_MODEL_FILENAME}`,
      `../mobile/testAssets/${MOBILE_MODEL_FILENAME}`,
      `testAssets/${MOBILE_MODEL_FILENAME}`,
      `../testAssets/${MOBILE_MODEL_FILENAME}`
    ]
    for (const key of candidates) {
      const mapped = global.assetPaths[key]
      if (mapped) {
        return mapped.startsWith('file://') ? mapped.slice('file://'.length) : mapped
      }
    }
    throw new Error(
      `Mobile asset not found in global.assetPaths: ${MOBILE_MODEL_FILENAME}. ` +
      "Did 'npm run mobile:copy-prebuilds' run during test setup, " +
      'and is `test/mobile/testAssets/' + MOBILE_MODEL_FILENAME + '` present?'
    )
  }

  // Desktop / non-mobile: prefer the bundled weights file when present
  // (matches ImageClassifier's default-path logic) so the test stays
  // self-contained and does not require an env override.
  const desktopCandidates = [
    path.resolve(__dirname, '..', 'mobile', 'testAssets', MODEL_FILENAME),
    path.resolve(__dirname, '..', 'mobile', 'testAssets', MOBILE_MODEL_FILENAME),
    path.resolve(__dirname, '..', '..', 'weights', MODEL_FILENAME)
  ]
  for (const candidate of desktopCandidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  // Let ImageClassifier fall back to its own default.
  return undefined
}

function loadImage (name) {
  return fs.readFileSync(path.join(IMAGE_DIR, name))
}

function recordMetric (label, totalTimeMs, input) {
  _perfReporter.record(label, {
    total_time_ms: Math.round(totalTimeMs)
  }, {
    input: input || null
  })
  _installExitHook()
  _flushReport()
}

/**
 * Record the cost of constructing and loading an `ImageClassifier`
 * instance. Captures the full warmup + GGML graph build + weights
 * read latency for the current platform, separate from per-image
 * classify cost.
 *
 * @param {string} label - Test name to associate the load cost with
 * @param {number} loadTimeMs - elapsed wall time in milliseconds
 */
function recordLoadTime (label, loadTimeMs) {
  _perfReporter.record(label, {
    total_time_ms: Math.round(loadTimeMs)
  }, {
    input: 'load'
  })
  _installExitHook()
  _flushReport()
}

module.exports = {
  platform,
  isMobile,
  TEST_TIMEOUT,
  IMAGE_SAMPLES,
  IMAGE_DIR,
  MODEL_FILENAME,
  loadImage,
  createLogger,
  recordMetric,
  recordLoadTime,
  resolveModelPath
}
