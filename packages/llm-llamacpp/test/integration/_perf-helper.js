'use strict'
// QVAC-17830: shared performance-recording helper for the LLM addon's
// integration tests (image-*, bitnet, tool-calling, ...). Holds the
// singleton perf-reporter, the mobile-safe inline fallback, and the
// `recordPerformance()` wrapper that turns an addon `response.stats`
// payload into a perf row.
//
// This file intentionally does NOT end in `.test.js` so it is not
// picked up by the mobile test generator or the brittle test runner.
//
// Why a singleton: when multiple test files load into the same bare
// process (e.g. desktop runs the full integration suite in one go),
// they share one reporter so the final perf-report.json + step
// summary cover every test. On Device Farm splits each group is its
// own process anyway, so the singleton is per-group there.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
// Follow-up to QVAC-17830 (Olya, 17 May): inject bare-subprocess so
// performance-reporter.js's _detectGpu() can shell out to nvidia-smi /
// vulkaninfo / system_profiler under Bare. Resolving from this caller
// file works (it lives next to llm-llamacpp/node_modules); resolving
// from inside scripts/test-utils/ does not because that directory has
// no node_modules walk. Mobile path doesn't need this — the inline
// fallback below leaves gpu=null on Device Farm where the probes
// wouldn't work anyway.
let _subprocess = null
try { _subprocess = require('bare-subprocess') } catch (_) {}

const platform = os.platform()
const arch = os.arch()
const platformLabel = `${platform}-${arch}`
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

// Dynamic require via path.join prevents bare-pack from statically
// resolving the path during mobile bundling (the script lives outside
// the addon package). Desktop: loads the full reporter. Mobile: falls
// through to the inline fallback below, which MIRRORS OCR's
// implementation — it records in-memory, writes JSON to any writable
// dir, and emits the [PERF_REPORT_START]...[PERF_REPORT_END] markers
// to console (with logcat chunking when payload exceeds ~800 chars)
// so scripts/perf-report/extract-from-log.js can reconstruct the
// artifact from Device Farm logs.
let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os, subprocess: _subprocess })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  // Hard cap on how much of the model's text output we keep in-memory
  // per record on mobile. The per-test flush (writeReport + console
  // emit) stringifies the cumulative results; unbounded text for a
  // verbose VLM response (+ 10MB fruit plate image + Metal compiler
  // service memory) has been observed to exhaust V8's Zone allocator
  // on iOS, producing a SIGTRAP from FatalProcessOutOfMemory inside
  // Builtin_JsonStringify. Disk + console extractors only use metrics
  // + test name, so the output is already purely diagnostic.
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
      // QVAC-17830: GPU label only filled in for desktop runners by
      // performance-reporter.js's _detectGpu(). On Device Farm we
      // leave it null and let the aggregator fall back to the device
      // name (e.g. "iPhone 17 Pro") which implies the chipset.
      gpu: null,
      runner: 'device-farm'
    }

    function _trim (text) {
      if (text == null) return null
      const s = String(text)
      if (s.length <= OUTPUT_CAP_CHARS) return s
      return s.substring(0, OUTPUT_CAP_CHARS) + '...[truncated ' +
        (s.length - OUTPUT_CAP_CHARS) + 'c]'
    }

    return {
      record (testName, metrics, extra) {
        const entry = {
          test: testName,
          // QVAC-17830: scenario is a top-level group key (e.g.
          // 'image', 'bitnet', 'tool-calling'). Tests opt into a
          // scenario so the report can split rows by implementation
          // when multiple test families share the same device column.
          scenario: (extra && extra.scenario) || 'default',
          // Follow-up to QVAC-17830: optional model id so per-row
          // breakdowns show which weights produced the timings.
          // Renderer falls back to '-' if null, so mobile rows that
          // forget to pass it still produce valid output.
          model: (extra && extra.model) || null,
          execution_provider: (extra && extra.execution_provider) || null,
          metrics: Object.assign({
            backend: null,
            platform: null,
            total_time_ms: null,
            prefill_time_ms: null,
            decode_time_ms: null,
            vision_encode_time_ms: null,
            ttft_ms: null,
            generated_tokens: null,
            prompt_tokens: null,
            tps: null
          }, metrics),
          input: (extra && extra.input) || null,
          output: _trim(extra && extra.output)
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
        if (!written) {
          console.log('[perf-reporter] all write locations failed')
        }
      },
      writeStepSummary () {},
      writeToConsole (consoleOpts) {
        try {
          const data = this.toJSON()
          const lightweight = consoleOpts && consoleOpts.lightweight
          // `delta: true` emits ONLY the latest row instead of the full
          // cumulative results array. Each JSON.stringify then stays
          // O(1) in the iteration count, which is essential on iOS
          // where V8's Zone allocator caps out fast under multimodal
          // memory pressure. extract-from-log.js --merge concatenates
          // the rows across all emits and dedupes on (test, metrics)
          // so the reconstructed report is identical to cumulative.
          const delta = consoleOpts && consoleOpts.delta
          let rows = data.results
          if (delta && rows.length > 0) rows = [rows[rows.length - 1]]
          data.results = rows.map(r => ({
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

// Singleton — shared across every test file loaded into the same
// bare process. addonType=vision keeps the existing GITHUB_STEP_SUMMARY
// columns (Total / TTFT / Gen Tokens / Prompt Tokens / TPS) and the
// existing per-device detail-table layout. Non-VLM tests will simply
// leave vision_encode_time_ms as null, same as VLM tests do today
// until the native runtimeStats wires it up
// (https://app.asana.com/1/45238840754660/project/1212638335655990/task/1214371583877702).
const _perfReporter = createPerformanceReporter({
  addon: 'llamacpp-llm',
  addonType: 'vision'
})

const _reportPath = path.resolve('.', 'test/results/performance-report.json')
let _exitHookInstalled = false

function _installExitHook () {
  if (_exitHookInstalled) return
  _exitHookInstalled = true
  process.on('exit', () => {
    if (_perfReporter.length > 0) {
      try { _perfReporter.writeReport(_reportPath) } catch (_) {}
      try { _perfReporter.writeStepSummary() } catch (_) {}
      // No extra cumulative console emit on mobile: the per-test
      // delta emits already carry every row, and extract-from-log.js
      // --merge reassembles them. Emitting a large cumulative payload
      // here risks a final Zone OOM in V8 on iOS right at the moment
      // we most need the previous deltas to survive.
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
 * Records perf metrics for a single LLM/VLM inference call onto the
 * shared singleton reporter, then (on mobile) flushes an incremental
 * snapshot to console / disk so data is preserved if a later
 * iteration crashes (e.g. iOS Jetsam OOM on the high-res image).
 *
 * Returns a multi-line human-readable summary string suitable for
 * `t.comment(...)` so the perf numbers also show up in the brittle
 * TAP output.
 *
 * @param {string} label    Test row identifier (e.g. "[fruit plate] [CPU]").
 * @param {number} totalTime End-to-end ms from JS run() to last token.
 * @param {Object} extra
 * @param {Object} [extra.stats]    response.stats from the addon (TTFT/TPS/...).
 * @param {string} [extra.deviceId] 'cpu'|'gpu' if the caller knows it.
 * @param {string} [extra.scenario] Implementation group: 'image',
 *                                  'bitnet', 'tool-calling', ... .
 *                                  Defaults to 'default' so every row
 *                                  is groupable in the detail table.
 * @param {string} [extra.model]    Short model id for this row (e.g.
 *                                  'SmolVLM2-500M-Q8_0',
 *                                  'Qwen3-1.7B-Q4_0'). Surfaces as the
 *                                  Model column in the perf renderer.
 * @param {string} [extra._output]  Generated text (will be capped for mobile).
 */
function recordPerformance (label, totalTime, extra) {
  const stats = (extra && extra.stats) || null
  const totalSeconds = (totalTime / 1000).toFixed(2)

  const ttftMs = stats ? _num(stats.TTFT) : null
  const tps = stats ? _num(stats.TPS) : null
  const generatedTokens = stats ? _num(stats.generatedTokens) : null
  const promptTokens = stats ? _num(stats.promptTokens) : null

  const reportedDevice = stats && (stats.backendDevice === 'cpu' || stats.backendDevice === 'gpu')
    ? stats.backendDevice
    : null

  const labelDevice = /\[gpu\]/i.test(label) ? 'gpu' : /\[cpu\]/i.test(label) ? 'cpu' : null
  const effectiveDevice = reportedDevice || (extra && extra.deviceId) || labelDevice
  const backend = resolveBackend(effectiveDevice)

  let decodeMs = null
  if (ttftMs !== null && totalTime > ttftMs) {
    decodeMs = Math.round(totalTime - ttftMs)
  } else if (generatedTokens !== null && tps !== null && tps > 0) {
    decodeMs = Math.round((generatedTokens / tps) * 1000)
  }

  _perfReporter.record(label, {
    backend,
    platform: platformLabel,
    total_time_ms: Math.round(totalTime),
    prefill_time_ms: ttftMs !== null ? Math.round(ttftMs) : null,
    decode_time_ms: decodeMs,
    // mmproj / vision-encoder time. Native side wiring tracked under
    // https://app.asana.com/1/45238840754660/project/1212638335655990/task/1214371583877702
    // — until then this stays null and the column in the detail
    // table renders as `-`.
    vision_encode_time_ms: null,
    ttft_ms: ttftMs !== null ? Math.round(ttftMs) : null,
    generated_tokens: generatedTokens,
    prompt_tokens: promptTokens,
    tps: tps !== null ? Number(tps.toFixed(2)) : null
  }, {
    scenario: (extra && extra.scenario) || 'default',
    model: (extra && extra.model) || null,
    execution_provider: effectiveDevice,
    output: (extra && extra._output) || null
  })

  _installExitHook()

  // Per-test flush: emit just this iteration's row to the console so
  // a crash on run N still leaves runs 1..N-1 in logcat / syslog.
  // extract-from-log.js --merge concatenates the deltas across emits.
  //
  // Deliberately NO writeReport() on disk per-record: (a) rewriting
  // the whole JSON on every iteration is expensive, and (b) the
  // stringify of the cumulative results array (plus model output
  // text) has been observed to exhaust V8's Zone allocator on iOS,
  // producing a SIGTRAP from FatalProcessOutOfMemory. The exit hook
  // below still performs one final writeReport for the on-device
  // artifact copy.
  if (isMobile) {
    if (typeof _perfReporter.writeToConsole === 'function') {
      _perfReporter.writeToConsole({ lightweight: true, delta: true })
    }
  }

  const lines = [
    `${label} Performance Metrics (backend=${backend}, platform=${platformLabel}):`,
    `    - Total time: ${totalTime}ms (${totalSeconds}s)`,
    `    - Prefill / TTFT: ${ttftMs !== null ? Math.round(ttftMs) + 'ms' : 'n/a'}`,
    `    - Decode: ${decodeMs !== null ? decodeMs + 'ms' : 'n/a'}`,
    `    - TPS: ${tps !== null ? tps.toFixed(2) : 'n/a'}`,
    `    - Tokens: ${generatedTokens !== null ? generatedTokens : 'n/a'} gen / ${promptTokens !== null ? promptTokens : 'n/a'} prompt`
  ]
  return lines.join('\n')
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
