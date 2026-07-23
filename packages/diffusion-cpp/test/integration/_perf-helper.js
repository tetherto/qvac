'use strict'
// Shared performance-recording helper for the diffusion-cpp addon's
// integration tests. Holds the singleton perf-reporter, the mobile-safe
// inline fallback, and the `recordPerformance()` wrapper that turns an
// addon `response.stats` (RuntimeStats / EsrganRuntimeStats / VideoRuntimeStats)
// payload into a perf row.
//
// This file intentionally does NOT end in `.test.js` so it is not
// picked up by the mobile test generator or the brittle test runner.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
let _subprocess = null
try {
  _subprocess = require('bare-subprocess')
} catch (_) {}

const platform = os.platform()
const arch = os.arch()
const platformLabel = `${platform}-${arch}`
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

function _getEnv(name) {
  if (typeof os.getEnv === 'function') {
    try {
      return os.getEnv(name) || ''
    } catch (_) {
      return ''
    }
  }
  return (process.env && process.env[name]) || ''
}

const PERF_RUNS = parseInt(_getEnv('QVAC_PERF_RUNS') || '1', 10)
const WARMUP_RUNS = parseInt(_getEnv('QVAC_PERF_WARMUP_RUNS') || '0', 10)

let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os, subprocess: _subprocess })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  const OUTPUT_CAP_CHARS = 400

  createPerformanceReporter = function (opts) {
    const _results = []
    const _startedAt = new Date().toISOString()
    const _addon = (opts && opts.addon) || 'unknown'
    const _addonType = (opts && opts.addonType) || 'generic'
    const _device = {
      name: platform,
      platform,
      os_version: '',
      arch: os.arch ? os.arch() : '',
      gpu: null,
      runner: 'device-farm'
    }

    function _trim(text) {
      if (text == null) return null
      const s = String(text)
      if (s.length <= OUTPUT_CAP_CHARS) return s
      return (
        s.substring(0, OUTPUT_CAP_CHARS) + '...[truncated ' + (s.length - OUTPUT_CAP_CHARS) + 'c]'
      )
    }

    return {
      record(testName, metrics, extra) {
        const entry = {
          test: testName,
          scenario: (extra && extra.scenario) || 'default',
          model: (extra && extra.model) || null,
          execution_provider: (extra && extra.execution_provider) || null,
          metrics: Object.assign(
            {
              model_load_ms: null,
              generation_ms: null,
              ttfb_ms: null,
              total_steps: null,
              width: null,
              height: null,
              conditioner_ms: null,
              denoise_ms: null,
              vae_ms: null,
              post_process_ms: null,
              steps_per_second: null
            },
            metrics
          ),
          input: (extra && extra.input) || null,
          output: _trim(extra && extra.output)
        }
        _results.push(entry)
      },
      toJSON() {
        return {
          schema_version: '1.0',
          addon: _addon,
          addon_type: _addonType,
          timestamp: _startedAt,
          device: _device,
          results: _results
        }
      },
      writeReport() {
        const json = JSON.stringify(this.toJSON())
        let written = false
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
            try {
              fs.mkdirSync(dirs[di], { recursive: true })
            } catch (_) {}
            const p = path.join(dirs[di], 'perf-report.json')
            fs.writeFileSync(p, json)
            console.log('[PERF_REPORT_PATH]' + p)
            written = true
          } catch (e) {
            console.log('[perf-reporter] write to ' + dirs[di] + ' failed: ' + e.message)
          }
        }
        if (!written) {
          console.log('[perf-reporter] all write locations failed')
        }
      },
      writeStepSummary() {},
      writeToConsole(consoleOpts) {
        try {
          const data = this.toJSON()
          const lightweight = consoleOpts && consoleOpts.lightweight
          const delta = consoleOpts && consoleOpts.delta
          let rows = data.results
          if (delta && rows.length > 0) rows = [rows[rows.length - 1]]
          data.results = rows.map((r) => ({
            test: r.test,
            scenario: r.scenario || 'default',
            model: r.model || null,
            execution_provider: r.execution_provider,
            metrics: r.metrics,
            output: lightweight ? null : r.output
          }))
          const json = JSON.stringify(data)
          const CHUNK = 800
          if (json.length <= CHUNK) {
            console.log('[PERF_REPORT_START]' + json + '[PERF_REPORT_END]')
          } else {
            const id = Date.now().toString(36)
            const n = Math.ceil(json.length / CHUNK)
            for (let i = 0; i < n; i++) {
              console.log(
                '[PERF_CHUNK:' +
                  id +
                  ':' +
                  i +
                  ':' +
                  n +
                  ']' +
                  json.substring(i * CHUNK, (i + 1) * CHUNK)
              )
            }
          }
        } catch (err) {
          console.log('[perf-reporter] mobile console write failed: ' + err.message)
        }
      },
      get length() {
        return _results.length
      }
    }
  }
}

const _perfReporter = createPerformanceReporter({
  addon: 'diffusion-cpp',
  addonType: 'diffusion'
})

const _reportPath = path.resolve('.', 'test/results/performance-report.json')
let _exitHookInstalled = false

function _installExitHook() {
  if (_exitHookInstalled) return
  _exitHookInstalled = true
  process.on('exit', () => {
    if (_perfReporter.length > 0) {
      try {
        _perfReporter.writeReport(_reportPath)
      } catch (_) {}
      try {
        _perfReporter.writeStepSummary()
      } catch (_) {}
    }
  })
}

function _num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function resolveBackend(device) {
  if (!device || device === 'cpu') return 'cpu'
  if (platform === 'darwin' || platform === 'ios') return 'metal'
  if (platform === 'android') {
    const override = _getEnv('QVAC_GPU_BACKEND')
    return String(override || 'vulkan').toLowerCase()
  }
  if (platform === 'linux' || platform === 'win32') return 'vulkan'
  return 'gpu'
}

/**
 * Records perf metrics for a single diffusion generation / upscale call.
 *
 * @param {string} label    Test row identifier (e.g. "[SD2.1 Q8_0 txt2img 712x712] [GPU]").
 * @param {Object} stats    response.stats from the addon (RuntimeStats / EsrganRuntimeStats / VideoRuntimeStats).
 * @param {Object} extra
 * @param {string} [extra.scenario]            'txt2img' | 'img2img' | 'upscale' | 'txt2vid' | 'img2vid'
 * @param {string} [extra.model]               Model id (e.g. 'stable-diffusion-v2-1-Q8_0')
 * @param {string} [extra.execution_provider]  'cpu' | 'gpu'
 * @param {number} [extra.ttfbMs]              Time from run() to first onUpdate event (ms)
 */
function recordPerformance(label, stats, extra) {
  if (!stats) return '[perf] no stats available'

  const isEsrgan = stats.upscaleMs != null
  const genMs = isEsrgan ? _num(stats.upscaleMs) : _num(stats.generationMs)
  const modelLoadMs = _num(stats.modelLoadMs)
  const totalSteps = _num(stats.totalSteps)
  const w = _num(stats.width)
  const h = _num(stats.height)
  const ttfbMs = extra && extra.ttfbMs != null ? _num(extra.ttfbMs) : null

  const conditionerMs = _num(stats.conditionerMs)
  const denoiseMs = _num(stats.denoiseMs)
  const vaeMs = _num(stats.vaeMs)
  const postProcessMs = _num(stats.postProcessMs)
  const stepsPerSecond = _num(stats.stepsPerSecond)

  const labelDevice = /\[gpu\]/i.test(label) ? 'gpu' : /\[cpu\]/i.test(label) ? 'cpu' : null
  const effectiveDevice = (extra && extra.execution_provider) || labelDevice || 'gpu'
  const backend = resolveBackend(effectiveDevice)

  _perfReporter.record(
    label,
    {
      model_load_ms: modelLoadMs,
      generation_ms: genMs,
      ttfb_ms: ttfbMs,
      total_steps: totalSteps,
      width: w,
      height: h,
      conditioner_ms: conditionerMs,
      denoise_ms: denoiseMs,
      vae_ms: vaeMs,
      post_process_ms: postProcessMs,
      steps_per_second: stepsPerSecond
    },
    {
      scenario: (extra && extra.scenario) || 'default',
      model: (extra && extra.model) || null,
      execution_provider: effectiveDevice
    }
  )

  _installExitHook()

  if (isMobile) {
    if (typeof _perfReporter.writeToConsole === 'function') {
      _perfReporter.writeToConsole({ lightweight: true, delta: true })
    }
  }

  const lines = [
    `${label} Performance (backend=${backend}, platform=${platformLabel}):`,
    `    - Model load: ${modelLoadMs != null ? modelLoadMs + 'ms' : 'n/a'}`,
    `    - Generation: ${genMs != null ? genMs + 'ms' : 'n/a'}`,
    `    - TTFB: ${ttfbMs != null ? Math.round(ttfbMs) + 'ms' : 'n/a'}`,
    `    - Steps: ${totalSteps || 'n/a'}`,
    `    - Resolution: ${w || '?'}x${h || '?'}`
  ]
  if (!isEsrgan && conditionerMs != null) {
    lines.push(
      `    - Conditioner: ${conditionerMs}ms`,
      `    - Denoise: ${denoiseMs != null ? denoiseMs + 'ms' : 'n/a'}`,
      `    - VAE: ${vaeMs != null ? vaeMs + 'ms' : 'n/a'}`,
      `    - Post-process: ${postProcessMs != null ? postProcessMs + 'ms' : 'n/a'}`,
      `    - Steps/sec: ${stepsPerSecond != null ? stepsPerSecond.toFixed(2) : 'n/a'}`
    )
  }
  return lines.join('\n')
}

// The four phase timings are exhaustive: conditioner + denoise + vae +
// postProcess spans the entire generation, so their sum equals generationMs.
// The ONLY expected drift is integer-millisecond rounding of those five
// values, which is bounded by timer precision and independent of how long
// generation runs. Five values each rounded to the nearest ms drift by at
// most ~2.5ms combined; 5ms leaves headroom for sub-ms scheduler jitter while
// staying far tighter than a generation-time-relative bound (a 1% bound would
// allow ~6s of unaccounted time on a 10-minute run).
const PHASE_SUM_TOLERANCE_MS = 5

// stepsPerSecond is derived from denoiseMs and may be rounded when serialized
// into response.stats, so reconstructing the step count
// (stepsPerSecond * denoiseMs / 1000) is not bit-exact. A small relative bound
// absorbs that rounding while still catching gross errors — e.g. a batch run
// that fails to count every sampler sequence, which is a ~2x miss.
const STEPS_CONSISTENCY_REL_TOLERANCE = 0.02

/**
 * Shared assertion block for the per-phase diffusion runtime stats.
 * Verifies the five phase fields are present and well-signed, that
 * stepsPerSecond is consistent with denoiseMs and the effective step count
 * (when provided), and that the four phase timings sum to generationMs within
 * timer-rounding precision.
 *
 * @param {Object} t                     brittle test handle (`t.ok`)
 * @param {Object} stats                 response.stats (RuntimeStats / VideoRuntimeStats)
 * @param {Object} [opts]
 * @param {number} [opts.expectedSteps]  effective sampler steps; when provided,
 *   also asserts stepsPerSecond is consistent with denoiseMs. Omit for img2img
 *   where the effective count depends on strength/scheduler.
 */
function assertPhaseStats(t, stats, opts) {
  const options = opts || {}

  t.ok(stats, 'stats object is populated')
  if (!stats) return

  t.ok(
    typeof stats.conditionerMs === 'number' && stats.conditionerMs > 0,
    `conditionerMs is a positive number (got ${stats.conditionerMs})`
  )
  t.ok(
    typeof stats.denoiseMs === 'number' && stats.denoiseMs > 0,
    `denoiseMs is a positive number (got ${stats.denoiseMs})`
  )
  t.ok(
    typeof stats.vaeMs === 'number' && stats.vaeMs > 0,
    `vaeMs is a positive number (got ${stats.vaeMs})`
  )
  t.ok(
    typeof stats.postProcessMs === 'number' && stats.postProcessMs >= 0,
    `postProcessMs is a non-negative number (got ${stats.postProcessMs})`
  )
  t.ok(
    typeof stats.stepsPerSecond === 'number' && stats.stepsPerSecond > 0,
    `stepsPerSecond is a positive number (got ${stats.stepsPerSecond})`
  )

  if (options.expectedSteps != null) {
    const expected = options.expectedSteps
    const reconstructed = (stats.stepsPerSecond * stats.denoiseMs) / 1000
    const tol = Math.max(STEPS_CONSISTENCY_REL_TOLERANCE * expected, 0.1)
    t.ok(
      Math.abs(reconstructed - expected) <= tol,
      `stepsPerSecond is consistent with denoiseMs and the ${expected} configured step(s): ` +
        `reconstructed ${reconstructed.toFixed(3)} \u2248 ${expected} (tol ${tol.toFixed(3)})`
    )
  }

  const totalPhaseMs = stats.conditionerMs + stats.denoiseMs + stats.vaeMs + stats.postProcessMs
  const diff = Math.abs(totalPhaseMs - stats.generationMs)
  t.ok(
    diff <= PHASE_SUM_TOLERANCE_MS,
    `Phase times sum to generation time: ${totalPhaseMs.toFixed(0)}ms \u2248 ${stats.generationMs}ms ` +
      `(diff ${diff.toFixed(0)}ms, tol ${PHASE_SUM_TOLERANCE_MS}ms)`
  )
}

module.exports = {
  platform,
  arch,
  platformLabel,
  isDarwinX64,
  isLinuxArm64,
  isMobile,
  resolveBackend,
  recordPerformance,
  assertPhaseStats,
  PHASE_SUM_TOLERANCE_MS,
  STEPS_CONSISTENCY_REL_TOLERANCE,
  PERF_RUNS,
  WARMUP_RUNS
}
