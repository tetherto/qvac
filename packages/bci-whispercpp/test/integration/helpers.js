'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const { computeWER } = require('@qvac/bci-whispercpp/wer')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// ---------------------------------------------------------------------------
// Performance reporter — captures BCI inference stats and emits them through
// the shared QVAC perf-report pipeline (desktop) or via console markers
// extractable from Device Farm logs (mobile). Mirrors the whisper addon's
// helper so scripts/perf-report/aggregate-bci-rtf.js can consume both desktop
// rtf-benchmark-*.json and mobile performance-report.json the same way.
//
// On desktop we require the shared scripts/test-utils/performance-reporter
// directly. On mobile that path lives outside the addon package and bare-pack
// can't bundle it, so we fall back to an inline lightweight reporter that
// chunks JSON into [PERF_REPORT_START]/[PERF_CHUNK] markers — the exact format
// scripts/perf-report/extract-from-log.js already understands.
// ---------------------------------------------------------------------------
let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  createPerformanceReporter = function (opts) {
    const _results = []
    const _startedAt = new Date().toISOString()
    const _addon = (opts && opts.addon) || 'bci'
    const _addonType = (opts && opts.addonType) || 'bci'
    const _device = {
      name: platform,
      platform,
      os_version: '',
      arch: os.arch ? os.arch() : '',
      runner: 'device-farm'
    }

    return {
      record (testName, metrics, extra) {
        _results.push({
          test: testName,
          execution_provider: (extra && extra.execution_provider) || null,
          metrics: Object.assign({
            real_time_factor: null,
            wall_time_ms: null,
            tps: null,
            total_time_ms: null
          }, metrics),
          input: (extra && extra.input) || null,
          output: (extra && extra.output) || null
        })
      },
      toJSON () {
        return {
          schema_version: '1.0',
          addon: _addon,
          addon_type: _addonType,
          timestamp: _startedAt,
          device: _device,
          results: _results
        }
      },
      writeReport () {
        const json = JSON.stringify(this.toJSON())
        const dirs = []
        if (global.testDir) dirs.push(global.testDir)
        if (platform === 'android') {
          dirs.push('/sdcard/Android/data/io.tether.test.qvac/files')
          dirs.push('/storage/emulated/0/Android/data/io.tether.test.qvac/files')
          dirs.push('/data/local/tmp')
        }
        dirs.push('/tmp')
        for (let di = 0; di < dirs.length; di++) {
          try {
            try { fs.mkdirSync(dirs[di], { recursive: true }) } catch (_) {}
            const p = path.join(dirs[di], 'perf-report.json')
            fs.writeFileSync(p, json)
            console.log('[PERF_REPORT_PATH]' + p)
          } catch (e) {
            console.log('[perf-reporter] write to ' + dirs[di] + ' failed: ' + e.message)
          }
        }
      },
      writeStepSummary () {},
      writeToConsole () {
        try {
          const json = JSON.stringify(this.toJSON())
          const CHUNK = 800
          if (json.length <= CHUNK) {
            console.log('[PERF_REPORT_START]' + json + '[PERF_REPORT_END]')
          } else {
            const id = Date.now().toString(36)
            const n = Math.ceil(json.length / CHUNK)
            for (let i = 0; i < n; i++) {
              console.log('[PERF_CHUNK:' + id + ':' + i + ':' + n + ']' + json.substring(i * CHUNK, (i + 1) * CHUNK))
            }
          }
        } catch (err) {
          console.log('[perf-reporter] mobile console write failed: ' + err.message)
        }
      },
      get length () { return _results.length }
    }
  }
}

const _perfReporter = createPerformanceReporter({ addon: 'bci', addonType: 'bci' })
const _reportPath = path.resolve('.', 'test/results/performance-report.json')
let _reportScheduled = false

function _flushPerfReport () {
  if (_perfReporter.length === 0) return
  try { _perfReporter.writeReport(_reportPath) } catch (_) {}
  try { _perfReporter.writeToConsole() } catch (_) {}
}

function _scheduleReportWrite () {
  if (_reportScheduled) return
  _reportScheduled = true
  process.on('exit', _flushPerfReport)
}

/**
 * Record a BCI inference stats row through the shared perf reporter.
 *
 * @param {string} label - Test label, e.g. '[ggml-bci-windowed] [CPU] mobile-perf run 1'.
 *                         The execution-provider is auto-detected from the
 *                         label when it contains [CPU] or [GPU].
 * @param {Object} stats - response.stats from the addon: { totalTime,
 *                         tokensPerSecond, totalWallMs, realTimeFactor?, ... }.
 * @param {Object} [extra] - Optional { wallMs, output, executionProvider }.
 */
function recordBciStats (label, stats, extra) {
  if (!stats || typeof stats !== 'object') return
  const epOverride = extra && extra.executionProvider
  const ep = epOverride || (/\[gpu\]/i.test(label) ? 'gpu' : /\[cpu\]/i.test(label) ? 'cpu' : null)

  const rtf = typeof stats.realTimeFactor === 'number' ? stats.realTimeFactor : null
  const totalTimeSec = typeof stats.totalTime === 'number' ? stats.totalTime : null
  const totalTimeMs = totalTimeSec !== null ? Math.round(totalTimeSec * 1000) : null
  const wallMs = (extra && typeof extra.wallMs === 'number')
    ? Math.round(extra.wallMs)
    : (typeof stats.totalWallMs === 'number' ? Math.round(stats.totalWallMs) : totalTimeMs)
  const tps = typeof stats.tokensPerSecond === 'number' ? stats.tokensPerSecond : null

  _perfReporter.record(label, {
    real_time_factor: rtf,
    wall_time_ms: wallMs,
    tps,
    total_time_ms: totalTimeMs
  }, {
    execution_provider: ep,
    output: extra && extra.output ? String(extra.output) : null
  })
  _scheduleReportWrite()

  if (isMobile) {
    try { _perfReporter.writeReport() } catch (_) {}
    try { _perfReporter.writeToConsole() } catch (_) {}
  }
}

// On mobile, the test framework copies test/mobile/testAssets/ into the
// app bundle and exposes the on-device asset root via global.testDir
// (writable scratch). Fall back to test/mobile/testAssets/ on disk so
// the same code paths work when these tests are exercised from the
// repo root (e.g. during local mobile dry-runs).
function getMobileAssetsDir () {
  if (typeof global !== 'undefined' && global.testDir) return global.testDir
  return path.join(__dirname, '..', 'mobile', 'testAssets')
}

function getModelPath (filename) {
  if (isMobile) return path.join(getMobileAssetsDir(), filename)
  return path.join(__dirname, '..', '..', 'models', filename)
}

// Resolve a bundled test asset (model / embedder / fixture) to a real on-device
// path. The mobile test framework copies test/mobile/testAssets/ into the app
// and exposes each file via global.assetPaths['../../testAssets/<file>'] as a
// file:// URL (under the app cache dir, NOT global.testDir). Falls back to the
// testDir-based path off-mobile or when the manifest is absent.
function getMobileAssetPath (filename) {
  if (typeof global !== 'undefined' && global.assetPaths) {
    const key = '../../testAssets/' + filename
    if (global.assetPaths[key]) return String(global.assetPaths[key]).replace('file://', '')
  }
  return path.join(getMobileAssetsDir(), filename)
}

function getTestPaths () {
  const fixturesDir = isMobile
    ? getMobileAssetsDir()
    : path.join(__dirname, '..', 'fixtures')
  const manifestPath = path.join(fixturesDir, 'manifest.json')

  let manifest = { samples: [] }
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  }

  return {
    fixturesDir,
    manifest,
    getSamplePath: (filename) => path.join(fixturesDir, filename)
  }
}

function detectPlatform () {
  const os = require('bare-os')
  const arch = os.arch()
  const platform = os.platform()
  return { arch, platform, label: `${platform}-${arch}` }
}

/**
 * Read a .bin neural signal fixture from disk as a Uint8Array view over
 * the original buffer bytes (no copy).
 */
function readSignal (samplePath) {
  const buf = fs.readFileSync(samplePath)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/**
 * Parse the [T, C] header of a neural signal buffer and return the header
 * fields alongside a view over the body bytes.
 */
function splitHeaderAndBody (signalBytes) {
  const view = new DataView(signalBytes.buffer, signalBytes.byteOffset, signalBytes.byteLength)
  const timesteps = view.getUint32(0, true)
  const channels = view.getUint32(4, true)
  const body = signalBytes.subarray(8)
  return { timesteps, channels, body }
}

/**
 * Build a fresh [T, C]-prefixed signal buffer from one or more body
 * fragments; used to synthesise longer fixtures (e.g. tile a fixture
 * body N times to force multi-window streaming).
 */
function buildSignal (channels, bodies) {
  const totalBodyBytes = bodies.reduce((sum, b) => sum + b.byteLength, 0)
  const totalTimesteps = totalBodyBytes / (channels * 4)
  const out = new Uint8Array(8 + totalBodyBytes)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, totalTimesteps, true)
  view.setUint32(4, channels, true)
  let offset = 8
  for (const b of bodies) {
    out.set(b, offset)
    offset += b.byteLength
  }
  return out
}

/**
 * Async generator that yields fixed-size slices of a Uint8Array; used by
 * streaming tests to simulate chunked input delivery.
 */
async function * chunkify (bytes, chunkSize) {
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    yield bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength))
  }
}

module.exports = {
  isMobile,
  platform,
  getMobileAssetsDir,
  getModelPath,
  getMobileAssetPath,
  getTestPaths,
  detectPlatform,
  computeWER,
  readSignal,
  splitHeaderAndBody,
  buildSignal,
  chunkify,
  recordBciStats,
  flushBciPerfReport: _flushPerfReport
}
