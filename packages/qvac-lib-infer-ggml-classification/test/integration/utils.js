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
let _reportScheduled = false

function _scheduleReportWrite () {
  if (_reportScheduled) return
  _reportScheduled = true
  process.on('exit', () => {
    if (_perfReporter.length > 0) {
      _perfReporter.writeReport(_reportPath)
      _perfReporter.writeStepSummary()
    }
  })
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

function loadImage (name) {
  return fs.readFileSync(path.join(IMAGE_DIR, name))
}

function recordMetric (label, totalTimeMs, input) {
  _perfReporter.record(label, {
    total_time_ms: Math.round(totalTimeMs)
  }, {
    input: input || null
  })
  _scheduleReportWrite()
}

module.exports = {
  platform,
  isMobile,
  TEST_TIMEOUT,
  IMAGE_SAMPLES,
  IMAGE_DIR,
  loadImage,
  createLogger,
  recordMetric
}
