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

const _perfReporter = createPerformanceReporter({ addon: 'vla', addonType: 'vla' })
const _platform = os.platform()
const _isMobile = _platform === 'ios' || _platform === 'android'
const _reportPath = path.resolve('.', 'test/results/performance-report.json')

// ---------------------------------------------------------------------------
// Mobile model download.
// On AWS Device Farm the addon runs inside the packed test-addon-mobile app
// so we can't bake a 1-4GB GGUF into the APK. Instead CI bundles a JSON file
// with a presigned S3 URL into testAssets/ and we download on first test run.
// Mirrors the pattern used by qvac-lib-infer-nmtcpp (loadConfigFromAssets +
// ensureIndicTransModel).
// ---------------------------------------------------------------------------

function _loadUrlsConfig () {
  if (!global.assetPaths) return null
  const candidates = [
    '../../testAssets/smolvla-urls.json',
    '../mobile/testAssets/smolvla-urls.json',
    'testAssets/smolvla-urls.json',
    '../testAssets/smolvla-urls.json'
  ]
  for (const candidate of candidates) {
    const p = global.assetPaths[candidate]
    if (!p) continue
    try {
      const raw = fs.readFileSync(p.replace('file://', ''), 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      console.log(`[vla-model] failed to read ${candidate}: ${err && err.message}`)
    }
  }
  return null
}

function _streamDownload (url, destPath, maxRedirects = 5) {
  const https = require('bare-https')
  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = () => { if (!resolved) { resolved = true; resolve() } }
    const safeReject = (err) => { if (!resolved) { resolved = true; reject(err) } }

    console.log(`[vla-model] downloading: ${url.substring(0, 60)}...`)
    const file = fs.createWriteStream(destPath)
    file.on('error', (err) => {
      file.destroy()
      try { fs.unlinkSync(destPath) } catch (_) {}
      safeReject(err)
    })

    const req = https.request(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        // Drain the redirect body so bare-https can release the underlying socket.
        if (typeof res.resume === 'function') res.resume()
        file.destroy()
        try { fs.unlinkSync(destPath) } catch (_) {}
        const location = res.headers.location
        if (location && maxRedirects > 0) {
          _streamDownload(location, destPath, maxRedirects - 1).then(safeResolve, safeReject)
          return
        }
        safeReject(new Error(`HTTP ${res.statusCode}: redirect not followed`))
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        if (typeof res.resume === 'function') res.resume()
        file.destroy()
        try { fs.unlinkSync(destPath) } catch (_) {}
        safeReject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || ''}`))
        return
      }

      const contentLength = parseInt(res.headers['content-length'] || '0', 10)
      const LOG_INTERVAL_BYTES = 50 * 1024 * 1024 // log every 50 MB
      let downloadedBytes = 0
      let nextLogBytes = LOG_INTERVAL_BYTES
      res.on('data', (chunk) => {
        downloadedBytes += chunk.length
        if (downloadedBytes >= nextLogBytes) {
          const mb = downloadedBytes / (1024 * 1024)
          const pct = contentLength > 0 ? ` (${((downloadedBytes / contentLength) * 100).toFixed(1)}%)` : ''
          console.log(`[vla-model] progress: ${mb.toFixed(0)}MB${pct}`)
          nextLogBytes += LOG_INTERVAL_BYTES
        }
      })
      res.on('error', (err) => {
        file.destroy()
        try { fs.unlinkSync(destPath) } catch (_) {}
        safeReject(err)
      })
      res.pipe(file)
      file.on('close', () => {
        const mb = downloadedBytes / (1024 * 1024)
        console.log(`[vla-model] downloaded: ${path.basename(destPath)} (${mb.toFixed(1)}MB)`)
        safeResolve()
      })
    })
    req.on('error', (err) => {
      file.destroy()
      try { fs.unlinkSync(destPath) } catch (_) {}
      safeReject(err)
    })
    req.end()
  })
}

async function _downloadFile (url, destPath, maxRedirects = 5, maxRetries = 3) {
  let lastErr = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 500 * (2 ** (attempt - 1))
      console.log(`[vla-model] retry ${attempt}/${maxRetries - 1} after ${backoffMs}ms (last: ${lastErr && lastErr.message})`)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
    }
    try {
      await _streamDownload(url, destPath, maxRedirects)
      return
    } catch (err) {
      lastErr = err
      if (err && /HTTP \d{3}/.test(err.message || '')) throw err
      try { fs.unlinkSync(destPath) } catch (_) {}
    }
  }
  throw new Error(`[vla-model] download failed after ${maxRetries} attempts: ${lastErr && lastErr.message}`)
}

async function _ensureMobileModel () {
  const modelFilename = 'smolvla-libero-f32-fixed.gguf'
  const writableRoot = global.testDir || '/tmp'
  const modelsDir = path.join(writableRoot, 'vla-models')
  try { fs.mkdirSync(modelsDir, { recursive: true }) } catch (_) {}
  const destPath = path.join(modelsDir, modelFilename)

  // Cache hit: SmolVLA f32 is large (>800MB); re-downloading for every test
  // variant wastes bandwidth and flakes on Device Farm's mobile network.
  if (fs.existsSync(destPath)) {
    const cachedMB = fs.statSync(destPath).size / (1024 * 1024)
    if (cachedMB >= 100) {
      console.log(`[vla-model] reusing cached GGUF: ${destPath} (${cachedMB.toFixed(1)}MB)`)
      return destPath
    }
    console.log(`[vla-model] cached GGUF undersized (${cachedMB.toFixed(2)}MB) — re-downloading`)
  }

  const urlConfig = _loadUrlsConfig()
  if (!urlConfig || !urlConfig.modelUrl) {
    throw new Error('smolvla-urls.json not found in testAssets — cannot download GGUF on mobile')
  }

  await _downloadFile(urlConfig.modelUrl, destPath)
  const sizeMB = fs.statSync(destPath).size / (1024 * 1024)
  if (sizeMB < 100) {
    throw new Error(`downloaded SmolVLA GGUF looks corrupted (${sizeMB.toFixed(2)}MB)`)
  }
  return destPath
}

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

test('integration: VlaModel rejects missing/invalid files.model', (t) => {
  let err1 = null
  try { const m = new VlaModel({ files: { model: [] } }); t.absent(m) } catch (e) { err1 = e }
  t.ok(err1 && /non-empty array/.test(err1.message))

  let err2 = null
  try { const m = new VlaModel(); t.absent(m) } catch (e) { err2 = e }
  t.ok(err2 && /non-empty array/.test(err2.message))

  let err3 = null
  try { const m = new VlaModel({ files: { model: ['relative/path.gguf'] } }); t.absent(m) } catch (e) { err3 = e }
  t.ok(err3 && /absolute path/.test(err3.message))
})

test('integration: VlaModel.load rejects missing GGUF file', async (t) => {
  const m = new VlaModel({ files: { model: ['/definitely/does/not/exist.gguf'] } })
  let err = null
  try { await m.load() } catch (e) { err = e }
  t.ok(err, 'expected an error for missing GGUF')
})

// End-to-end smoke test.
// Desktop: skipped unless QVAC_VLA_MODEL points at a real SmolVLA GGUF.
//   QVAC_VLA_MODEL=/path/to/smolvla-libero.gguf npm run test:integration
// Mobile (iOS/Android): MUST run — the CI workflow bundles the presigned S3
// URL in testAssets/smolvla-urls.json, so the model fetch + load + inference
// + quality comparison must all succeed. Any failure is a hard test failure;
// silent skips on mobile are forbidden because they produced false-positive
// PASS results in prior runs (see QVAC-VLA mobile CI history).
//
// The test runs each backend (`auto` then `cpu`) in the same process, sharing
// one model download and one addon-install pass per runner. On a CPU-only
// runner both rows naturally collapse onto the CPU backend; the duplicate is
// kept for matrix symmetry so the perf-report has a uniform shape across
// runners. On runners with a real GPU the two rows give an apples-to-apples
// CPU-vs-accelerator delta.
async function _runEndToEnd (t, modelPath, backend) {
  // Each iteration owns its own VlaModel and explicitly `unload()`s before
  // returning so memory-constrained mobile devices don't hold two copies of
  // the weights at once. `t.teardown` would defer release to end-of-test,
  // which on Android/iOS pushes us past the device-farm OOM limit.
  const model = new VlaModel({
    files: { model: [path.resolve(modelPath)] },
    opts: { stats: true }
  })

  try {
    await model.load({ backend })

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

    const response = await model.run({
      images: [img, img],
      imgWidth: size,
      imgHeight: size,
      state,
      tokens,
      mask,
      noise
    })
    const { actions, stats } = await response.await()

    t.ok(actions instanceof Float32Array)
    t.is(actions.length, hp.chunkSize * hp.actionDim)

    // Per-component timings must be present and non-negative numbers.
    t.ok(stats && typeof stats === 'object')
    for (const key of ['vision_ms', 'smollm2_compute_ms', 'smollm2_total_ms', 'ode_ms', 'total_ms']) {
      t.is(typeof stats[key], 'number', `stats.${key} is a number`)
      t.ok(stats[key] >= 0, `stats.${key} >= 0`)
    }
    console.log(
      `[VLA TIMING ${backend}] vision=${stats.vision_ms.toFixed(0)}ms ` +
      `smollm2_compute=${stats.smollm2_compute_ms.toFixed(0)}ms ` +
      `smollm2_total=${stats.smollm2_total_ms.toFixed(0)}ms ` +
      `ode=${stats.ode_ms.toFixed(0)}ms ` +
      `total=${stats.total_ms.toFixed(0)}ms`
    )

    const ref = _loadReference()
    let quality
    if (ref && (ref.chunk_size !== hp.chunkSize || ref.action_dim !== hp.actionDim)) {
      t.fail(
        `reference shape mismatch (ref=${ref.chunk_size}x${ref.action_dim}, actual=${hp.chunkSize}x${hp.actionDim}); ` +
        'regenerate test/integration/assets/pt_actions_libero_fixed.json with matching dims'
      )
    } else if (ref) {
      const cmp = _compareActions(actions, ref.actions)
      quality = cmp
      console.log(
        `[VLA QUALITY ${backend}] vs ${ref.model}: max|Δ|=${cmp.action_max_abs_diff.toFixed(4)} ` +
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
      t.comment('skipping reference comparison: pt_actions_libero_fixed.json not found')
    }

    const ep = model.backendName || null
    console.log(`[VLA BACKEND ${backend}] execution_provider=${ep ?? 'unknown'}`)
    _perfReporter.record(`end-to-end inference (${backend})`, {
      total_time_ms: stats.total_ms,
      vision_time_ms: stats.vision_ms,
      smollm2_compute_time_ms: stats.smollm2_compute_ms,
      smollm2_total_time_ms: stats.smollm2_total_ms,
      ode_time_ms: stats.ode_ms
    }, {
      execution_provider: ep,
      ...(quality ? { quality } : {})
    })

    // Mobile: flush after every record so the perf-report markers land in
    // logcat / iOS console *before* the BareKit process exits. The
    // `process.on('exit')` handler doesn't reliably fire on Device Farm
    // (the device tears the process down before flushing), so OCR's
    // canonical mobile path writes incrementally here. Desktop keeps the
    // exit-handler flush — `_flushPerfReport` is idempotent.
    if (_isMobile) {
      try {
        _perfReporter.writeReport()
        _perfReporter.writeToConsole()
      } catch (err) {
        console.log('[perf-reporter] mobile incremental flush failed: ' + (err && err.message))
      }
    }
  } finally {
    await model.unload().catch(() => {})
  }
}

test('integration: end-to-end inference runs (needs GGUF)', { timeout: 1800000 }, async (t) => {
  let modelPath = process.env.QVAC_VLA_MODEL
  if (_isMobile) {
    try {
      modelPath = await _ensureMobileModel()
    } catch (err) {
      t.fail(`mobile model fetch failed — ${err && err.message}`)
      return
    }
    t.ok(modelPath && typeof modelPath === 'string', 'mobile: _ensureMobileModel returned a path')
    t.ok(fs.existsSync(modelPath), `mobile: GGUF exists at ${modelPath}`)
    const sizeMB = fs.statSync(modelPath).size / (1024 * 1024)
    t.ok(sizeMB >= 100, `mobile: GGUF size ${sizeMB.toFixed(1)}MB >= 100MB`)
  } else if (!modelPath || !fs.existsSync(modelPath)) {
    t.comment(`skipping: set QVAC_VLA_MODEL to a valid GGUF (got "${modelPath ?? ''}")`)
    t.pass()
    return
  }

  for (const backend of ['auto', 'cpu']) {
    await _runEndToEnd(t, modelPath, backend)
  }
})
