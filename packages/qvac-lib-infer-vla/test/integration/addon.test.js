'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const { VlaModel, preprocessImage, padState } = require('../..')

// ---------------------------------------------------------------------------
// Performance reporter wiring. Mirrors the OCR addon pattern:
//   - desktop / CI: load the shared reporter from scripts/test-utils/
//   - mobile (packed bundle): fall back to a minimal inline reporter that
//     emits the [PERF_REPORT_START]...[PERF_REPORT_END] markers so the
//     Device Farm log extractor can still pick up the metrics.
// ---------------------------------------------------------------------------

let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  // Mobile bundle — minimal inline reporter.
  const _platform = os.platform()
  createPerformanceReporter = function (opts) {
    const _results = []
    const _startedAt = new Date().toISOString()
    const _addon = (opts && opts.addon) || 'unknown'
    const _addonType = (opts && opts.addonType) || 'generic'
    const _device = {
      name: _platform,
      platform: _platform,
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
            total_time_ms: null,
            vision_time_ms: null,
            smollm2_compute_time_ms: null,
            smollm2_total_time_ms: null,
            ode_time_ms: null
          }, metrics),
          quality: (extra && extra.quality) || undefined,
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
        if (_platform === 'android') {
          dirs.push('/sdcard/Android/data/io.tether.test.qvac/files')
          dirs.push('/storage/emulated/0/Android/data/io.tether.test.qvac/files')
          dirs.push('/data/local/tmp')
        }
        dirs.push('/tmp')
        for (const d of dirs) {
          try {
            try { fs.mkdirSync(d, { recursive: true }) } catch (_) {}
            const p = path.join(d, 'perf-report.json')
            fs.writeFileSync(p, json)
            console.log('[PERF_REPORT_PATH]' + p)
          } catch (_) {}
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
        } catch (_) {}
      },
      get length () { return _results.length }
    }
  }
}

const _perfReporter = createPerformanceReporter({ addon: 'qvac-lib-infer-vla', addonType: 'vla' })
const _platform = os.platform()
const _isMobile = _platform === 'ios' || _platform === 'android'
const _reportPath = path.resolve('.', 'test/results/performance-report.json')

let _reportFlushed = false
function _flushPerfReport () {
  if (_reportFlushed) return
  _reportFlushed = true
  if (_perfReporter.length === 0) return
  try {
    if (_isMobile) {
      _perfReporter.writeReport()
      _perfReporter.writeToConsole()
    } else {
      _perfReporter.writeReport(_reportPath)
      _perfReporter.writeStepSummary()
      _perfReporter.writeToConsole()
    }
  } catch (err) {
    console.log('[perf-reporter] flush failed: ' + (err && err.message))
  }
}
process.on('exit', _flushPerfReport)

// ---------------------------------------------------------------------------
// Quality: tolerance-based comparison against a PyTorch reference.
// The reference is produced by scripts/generate_reference.py on the exact
// same fixed fixture (pixel=128, BOS token, zero state, zero noise).
// ---------------------------------------------------------------------------

function _loadReference () {
  const candidates = [
    path.resolve('.', 'test/integration/assets/pt_actions_libero_fixed.json'),
    path.resolve(__dirname, 'assets/pt_actions_libero_fixed.json')
  ]
  if (global.assetPaths) {
    const p = global.assetPaths['../../testAssets/pt_actions_libero_fixed.json']
    if (p) candidates.unshift(p.replace('file://', ''))
  }
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf-8')
      return JSON.parse(raw)
    } catch (_) {}
  }
  return null
}

function _compareActions (actual, reference) {
  const expected = []
  for (const row of reference) for (const v of row) expected.push(v)
  const n = Math.min(actual.length, expected.length)
  let maxAbs = 0
  let sumAbs = 0
  let dot = 0
  let normA = 0
  let normE = 0
  for (let i = 0; i < n; i++) {
    const d = actual[i] - expected[i]
    const ad = Math.abs(d)
    if (ad > maxAbs) maxAbs = ad
    sumAbs += ad
    dot += actual[i] * expected[i]
    normA += actual[i] * actual[i]
    normE += expected[i] * expected[i]
  }
  const cos = (normA > 0 && normE > 0) ? dot / (Math.sqrt(normA) * Math.sqrt(normE)) : 0
  return {
    action_max_abs_diff: maxAbs,
    action_mean_abs_diff: n > 0 ? sumAbs / n : 0,
    action_cos_sim: cos,
    compared: n
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('integration: module exports expected surface', (t) => {
  t.is(typeof VlaModel, 'function')
  t.is(typeof preprocessImage, 'function')
  t.is(typeof padState, 'function')
})

test('integration: VlaModel rejects empty path', (t) => {
  let err1 = null
  try { const m = new VlaModel(''); m.destroy() } catch (e) { err1 = e }
  t.ok(err1 && /non-empty string/.test(err1.message))

  let err2 = null
  try { const m = new VlaModel(); m.destroy() } catch (e) { err2 = e }
  t.ok(err2 && /non-empty string/.test(err2.message))
})

test('integration: VlaModel rejects missing GGUF file', (t) => {
  let err = null
  try { const m = new VlaModel('/definitely/does/not/exist.gguf'); m.destroy() } catch (e) { err = e }
  t.ok(err, 'expected an error for missing GGUF')
})

// End-to-end smoke test — skipped unless QVAC_VLA_MODEL points at a real
// SmolVLA GGUF. Run locally with:
//   QVAC_VLA_MODEL=/path/to/smolvla-libero.gguf npm run test:integration
test('integration: end-to-end inference runs (needs GGUF)', (t) => {
  const modelPath = process.env.QVAC_VLA_MODEL
  if (!modelPath || !fs.existsSync(modelPath)) {
    t.comment(`skipping: set QVAC_VLA_MODEL to a valid GGUF (got "${modelPath ?? ''}")`)
    t.pass()
    return
  }

  const model = new VlaModel(path.resolve(modelPath))
  t.teardown(() => model.destroy())

  const hp = model.hparams
  t.ok(hp.chunkSize > 0)
  t.ok(hp.actionDim > 0)

  const size = hp.visionImageSize
  const dummy = new Uint8Array(size * size * 3).fill(128)
  const img = preprocessImage(dummy, size, size, { size })

  const tokens = new Int32Array(hp.tokenizerMaxLength)
  const mask = new Uint8Array(hp.tokenizerMaxLength)
  tokens[0] = 1 // BOS-like token
  mask[0] = 1

  const state = padState([0, 0, 0, 0, 0, 0], hp.maxStateDim)
  const noise = new Float32Array(hp.chunkSize * hp.maxActionDim)
  for (let i = 0; i < noise.length; i++) noise[i] = 0

  const { actions, stats } = model.run({
    images: [img, img],
    imgWidth: size,
    imgHeight: size,
    state,
    tokens,
    mask,
    noise
  })

  t.ok(actions instanceof Float32Array)
  t.is(actions.length, hp.chunkSize * hp.actionDim)

  // Per-component timings must be present and non-negative numbers.
  t.ok(stats && typeof stats === 'object')
  for (const key of ['vision_ms', 'smollm2_compute_ms', 'smollm2_total_ms', 'ode_ms', 'total_ms']) {
    t.is(typeof stats[key], 'number', `stats.${key} is a number`)
    t.ok(stats[key] >= 0, `stats.${key} >= 0`)
  }
  console.log(
    `[VLA TIMING] vision=${stats.vision_ms.toFixed(0)}ms ` +
    `smollm2_compute=${stats.smollm2_compute_ms.toFixed(0)}ms ` +
    `smollm2_total=${stats.smollm2_total_ms.toFixed(0)}ms ` +
    `ode=${stats.ode_ms.toFixed(0)}ms ` +
    `total=${stats.total_ms.toFixed(0)}ms`
  )

  // Compare against the PyTorch reference when both:
  //   (a) the reference is available, and
  //   (b) the shape matches (chunk_size × action_dim).
  // The reference is produced by scripts/generate_reference.py.
  const ref = _loadReference()
  let quality
  if (ref && ref.chunk_size === hp.chunkSize && ref.action_dim === hp.actionDim) {
    const cmp = _compareActions(actions, ref.actions)
    quality = cmp
    console.log(
      `[VLA QUALITY] vs ${ref.model}: max|Δ|=${cmp.action_max_abs_diff.toFixed(4)} ` +
      `mean|Δ|=${cmp.action_mean_abs_diff.toFixed(4)} cos=${cmp.action_cos_sim.toFixed(4)} ` +
      `(${cmp.compared} values)`
    )
    // Tolerances: ggml uses f32 throughout but PyTorch may use a different
    // dtype on load.  With zero noise + BOS-only tokens the dynamic range is
    // small, so we keep the bar loose (0.25 absolute) and rely on cosine
    // similarity (>0.9) for a structural sanity check.
    t.ok(
      cmp.action_max_abs_diff < 0.25,
      `max |Δ| ${cmp.action_max_abs_diff.toFixed(4)} < 0.25 vs PyTorch`
    )
    t.ok(
      cmp.action_cos_sim > 0.9,
      `cosine similarity ${cmp.action_cos_sim.toFixed(4)} > 0.9 vs PyTorch`
    )
  } else {
    t.comment(
      ref
        ? `skipping reference comparison: shape mismatch (ref=${ref.chunk_size}x${ref.action_dim}, actual=${hp.chunkSize}x${hp.actionDim})`
        : 'skipping reference comparison: pt_actions_libero_fixed.json not found'
    )
  }

  _perfReporter.record('end-to-end inference (fixed fixture)', {
    total_time_ms: stats.total_ms,
    vision_time_ms: stats.vision_ms,
    smollm2_compute_time_ms: stats.smollm2_compute_ms,
    smollm2_total_time_ms: stats.smollm2_total_ms,
    ode_time_ms: stats.ode_ms
  }, quality ? { quality } : undefined)
})
