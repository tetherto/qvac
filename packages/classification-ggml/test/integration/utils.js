'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')

const ImageClassifier = require('../../index')

const platform = process.platform
const isMobile = platform === 'ios' || platform === 'android'

// Dynamic require via path.join — bare-pack would otherwise resolve the
// script path at mobile bundle time and fail the lookup.
let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  // No-op fallback for published-tarball runs that lack scripts/.
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
  // Final write only triggers the GitHub Step Summary; the JSON file
  // is already up to date thanks to the per-metric flush below.
  process.on('exit', () => {
    if (_perfReporter.length > 0) {
      _perfReporter.writeReport(_reportPath)
      _perfReporter.writeStepSummary()
    }
  })
}

function _flushReport () {
  if (_perfReporter.length === 0) return
  // Persist after every metric so SIGSEGV mid-suite still leaves a
  // partial report on disk.
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
// qvac-test-addon-mobile's metro.config.js whitelists asset extensions
// `so, bin, model, bundle, raw, onnx`; `.gguf` is not in the list, so
// `scripts/copy-mobile-test-assets.js` packages the weights with a
// `.gguf.bin` suffix and the device-side lookup uses that name.
const MOBILE_MODEL_FILENAME = MODEL_FILENAME + '.bin'

// Regex strips both `file://` and `file:///abs/path` correctly; a
// `.slice('file://'.length)` would leave a stray leading `/`.
function _stripFileUrlPrefix (mapped) {
  return mapped.replace(/^file:\/\//, '')
}

function _resolveMobileAsset (filename) {
  if (!isMobile || typeof global === 'undefined' || !global.assetPaths) {
    return null
  }
  const candidates = [
    `../../testAssets/${filename}`,
    `../mobile/testAssets/${filename}`,
    `testAssets/${filename}`,
    `../testAssets/${filename}`
  ]
  for (const key of candidates) {
    const mapped = global.assetPaths[key]
    if (mapped) return _stripFileUrlPrefix(mapped)
  }
  return null
}

/**
 * Desktop: returns `undefined` so the constructor uses its bundled
 * default. Mobile: throws synchronously when the asset is missing —
 * a rejected promise during load() aborts the bare worklet.
 */
function resolveModelPath () {
  if (isMobile) {
    const resolved = _resolveMobileAsset(MOBILE_MODEL_FILENAME)
    if (resolved) return resolved
    throw new Error(
      `Mobile asset not found in global.assetPaths: ${MOBILE_MODEL_FILENAME}. ` +
      "Did 'npm run mobile:copy-prebuilds' run during test setup, " +
      'and is `test/mobile/testAssets/' + MOBILE_MODEL_FILENAME + '` present?'
    )
  }

  const desktopCandidates = [
    path.resolve(__dirname, '..', 'mobile', 'testAssets', MODEL_FILENAME),
    path.resolve(__dirname, '..', 'mobile', 'testAssets', MOBILE_MODEL_FILENAME),
    path.resolve(__dirname, '..', '..', 'weights', MODEL_FILENAME)
  ]
  for (const candidate of desktopCandidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

// Mobile: throw synchronously on miss for the same reason as
// resolveModelPath() — see comment above.
function _resolveImagePath (name) {
  if (isMobile) {
    const resolved = _resolveMobileAsset(name)
    if (resolved) return resolved
    const known = (typeof global !== 'undefined' && global.assetPaths)
      ? Object.keys(global.assetPaths).slice(0, 8).join(', ')
      : '(no global.assetPaths)'
    throw new Error(
      `Mobile test image not found in global.assetPaths: ${name}. ` +
      "Did 'npm run mobile:copy-prebuilds' run during test setup, " +
      'and is `test/mobile/testAssets/' + name + '` present? ' +
      `assetPaths sample keys: [${known}]`
    )
  }
  return path.join(IMAGE_DIR, name)
}

function loadImage (name) {
  return fs.readFileSync(_resolveImagePath(name))
}

function makeClassifier (overrides) {
  const opts = {
    modelPath: resolveModelPath(),
    logger: createLogger()
  }
  if (overrides) Object.assign(opts, overrides)
  return new ImageClassifier(opts)
}

// Errors swallowed so a failing teardown can't mask the assertion
// that triggered it.
async function cleanupClassifier (classifier) {
  if (!classifier) return
  try {
    await classifier.unload()
  } catch (_) {}
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
  resolveModelPath,
  makeClassifier,
  cleanupClassifier
}
