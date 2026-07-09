'use strict'

// Shared performance-recording helper for the embed addon's mobile perf
// benchmark. Holds the perf-report reporter, the mobile-safe inline fallback,
// and the recordPerformance() wrapper that turns one embedding run's
// runtimeStats into a perf row. Embeddings are a single prefill-only forward
// pass, so every metric here is a prefill or end-to-end quantity: there is no
// decode phase, no TTFT, no generated-token count.
//
// This file intentionally does NOT end in `.test.js`, so it is not picked up by
// the mobile test generator or the brittle test runner.
//
// The emitted schema is { device, results[] }; the per-row metrics are
// embed-specific (pp_tps, latency_ms, cosine_similarity, plus the _std variants,
// input_tokens and sample_count), matching what render-report.js reads for
// mobile rows.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')

const platform = os.platform()
const arch = os.arch()
const platformLabel = `${platform}-${arch}`
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

// In-memory reporter that writes JSON to any writable dir and emits the
// [PERF_REPORT_START]...[PERF_REPORT_END] markers (with logcat chunking when
// the payload exceeds 800 chars) so scripts/perf-report/extract-from-log.js
// can reconstruct the artifact from Device Farm logs.
function createPerformanceReporter (opts) {
  const _results = []
  const _startedAt = new Date().toISOString()
  const _addon = (opts && opts.addon) || 'llamacpp-embed'
  const _addonType = (opts && opts.addonType) || 'embed'
  const _device = {
    name: platform,
    platform,
    os_version: '',
    arch: os.arch ? os.arch() : '',
    // Left null on Device Farm; the aggregator falls back to the device name.
    gpu: null,
    runner: 'device-farm'
  }

  return {
    record (testName, metrics, extra) {
      _results.push({
        test: testName,
        scenario: (extra && extra.scenario) || 'benchmark-perf',
        model: (extra && extra.model) || null,
        execution_provider: (extra && extra.execution_provider) || null,
        status: (extra && extra.status) || null,
        metrics: Object.assign({
          backend: null,
          platform: null,
          pp_tps: null,
          pp_tps_std: null,
          latency_ms: null,
          latency_ms_std: null,
          cosine_similarity: null,
          input_tokens: null,
          sample_count: null
        }, metrics)
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
          try { fs.mkdirSync(dirs[di], { recursive: true }) } catch (_) {}
          const p = path.join(dirs[di], 'perf-report.json')
          fs.writeFileSync(p, json)
          console.log('[PERF_REPORT_PATH]' + p)
          written = true
        } catch (e) {
          console.log('[perf-reporter] write to ' + dirs[di] + ' failed: ' + e.message)
        }
      }
      if (!written) console.log('[perf-reporter] all write locations failed')
    },
    writeToConsole (consoleOpts) {
      try {
        const data = this.toJSON()
        // `delta: true` emits ONLY the latest row instead of the full
        // cumulative results array, so each JSON.stringify stays O(1) in the
        // iteration count. extract-from-log.js --merge concatenates the rows
        // across emits and dedupes, so the reconstructed report is identical.
        const delta = consoleOpts && consoleOpts.delta
        let rows = data.results
        if (delta && rows.length > 0) rows = [rows[rows.length - 1]]
        data.results = rows.map((r) => ({
          test: r.test,
          scenario: r.scenario || 'benchmark-perf',
          model: r.model || null,
          execution_provider: r.execution_provider,
          status: r.status,
          metrics: r.metrics
        }))
        const json = JSON.stringify(data)
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

const _perfReporter = createPerformanceReporter({ addon: 'llamacpp-embed', addonType: 'embed' })

const _reportPath = path.resolve('.', 'test/results/performance-report.json')
let _exitHookInstalled = false

function _installExitHook () {
  if (_exitHookInstalled) return
  _exitHookInstalled = true
  process.on('exit', () => {
    if (_perfReporter.length > 0) {
      try { _perfReporter.writeReport(_reportPath) } catch (_) {}
    }
  })
}

function resolveBackend (device) {
  if (!device || device === 'cpu') return 'cpu'
  if (platform === 'darwin' || platform === 'ios') return 'metal'
  if (platform === 'android') {
    const override = (process.env && process.env.QVAC_GPU_BACKEND) ||
      (typeof os.getEnv === 'function' ? os.getEnv('QVAC_GPU_BACKEND') : '')
    return String(override || 'vulkan').toLowerCase()
  }
  if (platform === 'linux' || platform === 'win32') return 'vulkan'
  return 'gpu'
}

function _num (v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Records perf metrics for one embedding run onto the reporter, then (on
 * mobile) flushes that row to console so it survives in the logs if a later
 * iteration crashes. Returns a multi-line summary string for t.comment(...) so
 * the numbers also show up in the brittle TAP output.
 *
 * @param {string} label Row identifier, e.g.
 *   "[Qwen3-embedding-0.6B q=Q8_0] [gpu] [bs=512] [fa=on]".
 * @param {Object} extra
 * @param {string} [extra.deviceId]  'cpu'|'gpu' if the caller knows it.
 * @param {number} [extra.ppTps]     mean prefill tokens/sec across the config's repeats.
 * @param {number} [extra.ppTpsStd]  stddev of ppTPS across the repeats.
 * @param {number} [extra.latencyMs] mean prefill time in ms across the repeats.
 * @param {number} [extra.latencyMsStd] stddev of latency across the repeats.
 * @param {number} [extra.cosine]    cosine similarity vs the in-run baseline.
 * @param {number} [extra.inputTokens] tokens fed to the model for this config.
 * @param {number} [extra.sampleCount] repeats that produced a value.
 * @param {string} [extra.status]    'ok' | 'partial-failure' | 'crashed'.
 * @param {string} [extra.model]     short model id for this row.
 */
function recordPerformance (label, extra) {
  const labelDevice = /\[gpu\]/i.test(label) ? 'gpu' : /\[cpu\]/i.test(label) ? 'cpu' : null
  const effectiveDevice = (extra && extra.deviceId) || labelDevice
  const backend = resolveBackend(effectiveDevice)

  const ppTps = extra ? _num(extra.ppTps) : null
  const ppTpsStd = extra ? _num(extra.ppTpsStd) : null
  const latencyMs = extra ? _num(extra.latencyMs) : null
  const latencyMsStd = extra ? _num(extra.latencyMsStd) : null
  const cosine = extra ? _num(extra.cosine) : null
  const inputTokens = extra ? _num(extra.inputTokens) : null
  const sampleCount = extra ? _num(extra.sampleCount) : null

  _perfReporter.record(label, {
    backend,
    platform: platformLabel,
    pp_tps: ppTps !== null ? Number(ppTps.toFixed(3)) : null,
    pp_tps_std: ppTpsStd !== null ? Number(ppTpsStd.toFixed(3)) : null,
    latency_ms: latencyMs !== null ? Number(latencyMs.toFixed(3)) : null,
    latency_ms_std: latencyMsStd !== null ? Number(latencyMsStd.toFixed(3)) : null,
    cosine_similarity: cosine !== null ? Number(cosine.toFixed(6)) : null,
    input_tokens: inputTokens !== null ? Math.round(inputTokens) : null,
    sample_count: sampleCount !== null ? Math.round(sampleCount) : null
  }, {
    scenario: 'benchmark-perf',
    model: (extra && extra.model) || null,
    execution_provider: effectiveDevice,
    status: (extra && extra.status) || null
  })

  _installExitHook()

  // Per-run flush: emit just this iteration's row so a crash on a later run
  // still leaves the earlier ones in logcat / syslog.
  if (isMobile && typeof _perfReporter.writeToConsole === 'function') {
    _perfReporter.writeToConsole({ delta: true })
  }

  const fmtMeanStd = (m, s) => m === null
    ? 'n/a'
    : (s !== null && sampleCount !== null && sampleCount > 1 ? `${m.toFixed(2)} ± ${s.toFixed(2)}` : m.toFixed(2))
  return [
    `${label} Performance Metrics (backend=${backend}, platform=${platformLabel}, reps=${sampleCount !== null ? sampleCount : 'n/a'}):`,
    `    - ppTPS (prefill tokens/sec): ${fmtMeanStd(ppTps, ppTpsStd)}`,
    `    - Latency (prefill ms): ${fmtMeanStd(latencyMs, latencyMsStd)}`,
    `    - Cosine vs baseline: ${cosine !== null ? cosine.toFixed(4) : 'n/a'}`,
    `    - Input tokens: ${inputTokens !== null ? inputTokens : 'n/a'}`
  ].join('\n')
}

module.exports = {
  platform,
  arch,
  platformLabel,
  isDarwinX64,
  isLinuxArm64,
  isMobile,
  resolveBackend,
  recordPerformance
}
