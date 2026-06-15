'use strict'
// Performance-recording helper shared by the tts-ggml integration tests
// (Chatterbox English/MTL, Supertonic, Supertonic MTL, GPU smoke). Holds the
// singleton perf-reporter, the mobile-safe inline fallback, and
// `recordTtsStats()` which turns an addon `response.stats` payload into a perf
// row.
//
// Lives in test/utils/ (not test/integration/) so it sits next to the other
// shared runners (runChatterboxTTS.js, runSupertonicTTS.js, ...) and is never
// picked up by the mobile test generator or the brittle test runner, which
// only discover test/integration/*.test.js.
//
// Mirrors the structure of the Parakeet/LLM helpers: on desktop we require the
// shared scripts/test-utils/performance-reporter directly; on mobile that path
// lives outside the addon package and bare-pack can't bundle it, so we fall
// back to an inline lightweight reporter that emits [PERF_REPORT_START]/
// [PERF_CHUNK] markers extract-from-log.js already understands.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')

const platform = os.platform()
const arch = os.arch()
const platformLabel = `${platform}-${arch}`
const isMobile = platform === 'ios' || platform === 'android'

// Inject bare-subprocess so performance-reporter.js's _detectGpu() can shell
// out to nvidia-smi / vulkaninfo / system_profiler on desktop runners.
// Resolving from this caller file works (it lives next to the addon's
// node_modules); resolving from inside scripts/test-utils/ does not because
// require('child_process') throws under Bare. Without this, device.gpu stays
// null and the perf report shows "N/A" for the GPU. Mirrors the LLM addon's
// _perf-helper.js. Mobile doesn't need it — the inline fallback below leaves
// gpu null on Device Farm where the probes wouldn't work anyway.
let _subprocess = null
try { _subprocess = require('bare-subprocess') } catch (_) {}

let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os, subprocess: _subprocess })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  createPerformanceReporter = function (opts) {
    const _results = []
    const _startedAt = new Date().toISOString()
    const _addon = (opts && opts.addon) || 'tts-ggml'
    const _addonType = (opts && opts.addonType) || 'tts'
    const _device = {
      name: platform,
      platform,
      os_version: '',
      arch: os.arch ? os.arch() : '',
      // GPU label only filled in for desktop runners by
      // performance-reporter.js's _detectGpu(). On Device Farm we leave it
      // null and let the aggregator fall back to the device name.
      gpu: null,
      runner: 'device-farm'
    }

    return {
      record (testName, metrics, extra) {
        const entry = {
          test: testName,
          execution_provider: (extra && extra.execution_provider) || null,
          model: (extra && extra.model) || null,
          metrics: Object.assign({
            total_time_ms: null,
            tps: null,
            real_time_factor: null,
            sample_count: null,
            audio_duration_ms: null
          }, metrics),
          input: (extra && extra.input) || null,
          output: (extra && extra.output) || null
        }
        _results.push(entry)
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

const _perfReporter = createPerformanceReporter({
  addon: 'tts-ggml',
  addonType: 'tts'
})

const _reportPath = path.resolve('.', 'test/results/performance-report.json')
let _reportScheduled = false

function _flushPerfReport () {
  if (_perfReporter.length === 0) return
  try { _perfReporter.writeReport(_reportPath) } catch (_) {}
  try { _perfReporter.writeStepSummary() } catch (_) {}
  try { _perfReporter.writeToConsole() } catch (_) {}
}

function _scheduleReportWrite () {
  if (_reportScheduled) return
  _reportScheduled = true
  process.on('exit', _flushPerfReport)
}

function _num (v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Record a Chatterbox (ggml) synthesis stats row through the shared perf
 * reporter.
 *
 * @param {string} label - Test label, e.g. 'chatterbox english 1'. A leading
 *                         [CPU]/[GPU] is optional and only used as a fallback
 *                         hint — the row is tagged from the resolved backend
 *                         (stats.backendDevice) when available, and the prefix
 *                         is normalized to match.
 * @param {Object} stats - response.stats from the addon:
 *                         { realTimeFactor, audioDurationMs, totalSamples,
 *                           backendDevice, ... }
 * @param {Object} [extra] - Optional overrides:
 *                         { wallMs, sampleCount, model, output,
 *                           executionProvider }.
 */
function recordTtsStats (label, stats, extra) {
  const s = stats || {}
  const resolvedEp = s.backendDevice === 1 ? 'gpu' : s.backendDevice === 0 ? 'cpu' : null
  const epOverride = extra && extra.executionProvider
  const labelEp = /\[gpu\]/i.test(label) ? 'gpu' : /\[cpu\]/i.test(label) ? 'cpu' : null
  const ep = resolvedEp || epOverride || labelEp

  const baseLabel = label.replace(/^\s*\[(?:cpu|gpu)\]\s*/i, '')
  const finalLabel = ep ? `[${ep.toUpperCase()}] ${baseLabel}` : baseLabel

  const rtf = _num(s.realTimeFactor)
  const sampleCount = (extra && _num(extra.sampleCount)) != null
    ? _num(extra.sampleCount)
    : _num(s.totalSamples)
  const audioMs = _num(s.audioDurationMs) != null ? Math.round(_num(s.audioDurationMs)) : null
  const wallMs = (extra && _num(extra.wallMs) != null) ? Math.round(_num(extra.wallMs)) : null
  const tps = _num(s.tokensPerSecond)

  // When the addon doesn't report a positive realTimeFactor (e.g. Supertonic /
  // some GPU paths), derive it from the measured wall time and audio duration
  // — the same fallback the RTF benchmark uses — so the row still carries an
  // RTF instead of n/a. Callers that already pass a derived realTimeFactor
  // (addon.test.js) keep it untouched.
  //
  // The two bases aren't comparable (compute-RTF excludes JS/marshalling
  // overhead that wall-RTF includes), so record rtf_source per row: anyone
  // comparing numbers across rows in a single report can see which is which.
  const usingComputeRtf = rtf != null && rtf > 0
  const effRtf = usingComputeRtf
    ? rtf
    : (wallMs != null && audioMs ? wallMs / audioMs : null)
  const rtfSource = usingComputeRtf ? 'compute' : (effRtf != null ? 'wall' : null)

  _perfReporter.record(finalLabel, {
    total_time_ms: wallMs,
    tps,
    real_time_factor: effRtf,
    rtf_source: rtfSource,
    sample_count: sampleCount,
    audio_duration_ms: audioMs
  }, {
    execution_provider: ep,
    model: (extra && extra.model) || null,
    output: extra && extra.output ? String(extra.output) : null
  })
  _scheduleReportWrite()

  if (isMobile) {
    try { _perfReporter.writeReport() } catch (_) {}
    try { _perfReporter.writeToConsole() } catch (_) {}
  }

  const lines = [
    `${finalLabel} Performance Metrics (platform=${platformLabel}):`,
    `    - Wall time: ${wallMs !== null ? wallMs + 'ms' : 'n/a'}`,
    `    - RTF: ${effRtf !== null ? effRtf.toFixed(4) + ' (' + rtfSource + ')' : 'n/a'}`,
    `    - Samples: ${sampleCount !== null ? sampleCount : 'n/a'}`,
    `    - Audio: ${audioMs !== null ? audioMs + 'ms' : 'n/a'}`
  ]
  return lines.join('\n')
}

module.exports = {
  platform,
  arch,
  platformLabel,
  isMobile,
  recordTtsStats,
  flushTtsPerfReport: _flushPerfReport
}
