'use strict'

// JS integration test for π₀.₅.
//
// Loads pi05_base.gguf via the public VlaModel surface, feeds the same
// fixture used by the C++ parity tests, and asserts the returned action
// chunk matches the PyTorch reference `ode.actions_final`.
//
// Catches what the C++ Pi05Integration test can't:
//   * JS validator + binding.runJob argument marshalling
//   * Per-event callback wiring (Output → JobEnded sequence)
//   * VlaModel lifecycle through load() / run() / unload()
//
// Skips cleanly when the test artefacts aren't on disk (so CI without
// the pi05_base mirror still passes):
//   PI05_TEST_GGUF        — path to pi05_base.gguf
//   PI05_TEST_FIXTURE     — path to fixture.safetensors
//   PI05_TEST_ACTIVATIONS — path to activations.safetensors

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const { VlaModel, preprocessImage, padState } = require('../..')

// ── Performance reporter ────────────────────────────────────────────────
// Same shape as addon.test.js (smolvla) — a per-process singleton that
// accumulates per-test timing + quality and flushes JSON on process exit.
// Writes to a pi05-specific path so smolvla's report stays untouched; the
// CI workflow's upload-artifact step globs `performance-report*.json`
// to capture both.
let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  // Mobile bundle — minimal inline reporter (same shape as addon.test.js).
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
            prefill_compute_time_ms: null,
            prefill_total_time_ms: null,
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
            const p = path.join(d, 'perf-report-pi05.json')
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

const _perfReporter = createPerformanceReporter({ addon: 'vla', addonType: 'pi05' })
const _platform = os.platform()
const _isMobile = _platform === 'ios' || _platform === 'android'
const _reportPath = path.resolve('.', 'test/results/performance-report-pi05.json')

// Desktop flush on process exit. Mobile flushes incrementally after each
// record() (same rationale as addon.test.js — Device Farm tears down the
// process before exit handlers fire).
process.on('exit', () => {
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
})

// Tri-state asset detection (+ mobile fast path):
//   - HAVE_DESKTOP: all three env vars are set AND the files exist →
//           run against the safetensors artefacts on local disk.
//   - HAVE_MOBILE:  on iOS/Android with the small JSON fixtures + the
//           presigned-URL config bundled in testAssets/ → download the
//           GGUF at runtime, load inputs from the small JSONs.
//   - SKIP: env vars are unset *and* no mobile assets → local dev
//           convenience, skip cleanly.
//   - FAIL: env vars are set but a file is missing → loud failure.
//           CI sets the env vars unconditionally on desktop; a silent
//           skip would hide a broken S3 download or a stale asset path.
function _hasMobileAssetsBundle () {
  if (!_isMobile) return false
  if (typeof global === 'undefined' || !global.assetPaths) return false
  // We only need to confirm presence of the URL JSON here — the
  // fixture / actions-ref JSONs are verified when _loadMobileFixtureJson
  // actually reads them.
  const candidates = [
    '../../testAssets/pi05-urls.json',
    '../mobile/testAssets/pi05-urls.json',
    'testAssets/pi05-urls.json',
    '../testAssets/pi05-urls.json'
  ]
  for (const c of candidates) {
    if (global.assetPaths[c]) return true
  }
  return false
}

const _assetsState = (function detectAssets () {
  const keys = ['PI05_TEST_GGUF', 'PI05_TEST_FIXTURE', 'PI05_TEST_ACTIVATIONS']
  const values = keys.map((k) => process.env[k])
  const allUnset = values.every((v) => !v)
  if (allUnset) {
    if (_hasMobileAssetsBundle()) return { state: 'HAVE_MOBILE' }
    return { state: 'SKIP' }
  }
  const missing = keys.filter((k, i) => !values[i] || !fs.existsSync(values[i]))
  if (missing.length > 0) {
    return {
      state: 'FAIL',
      reason: 'Some PI05_TEST_* env vars point at missing files: ' +
        missing.map((k) => `${k}=${process.env[k] || '<unset>'}`).join(', ')
    }
  }
  return { state: 'HAVE_DESKTOP' }
})()

const SKIP_REASON =
  'desktop: set PI05_TEST_GGUF / PI05_TEST_FIXTURE / PI05_TEST_ACTIVATIONS env vars; ' +
  'mobile: bundle pi05-urls.json + pi05-fixture.json + pi05-actions-ref.json in testAssets/'

// ── Inline safetensors v1 parser ──────────────────────────────────────────
// Header: 8-byte LE uint64 = JSON header byte length, then the JSON header,
// then the contiguous tensor data blob. Only the slice we need: read a
// named tensor's dtype/shape/data range and return a typed array view.
function loadSafetensors (path) {
  const buf = fs.readFileSync(path)
  const headerLen = Number(buf.readBigUInt64LE(0))
  if (headerLen <= 0 || headerLen > buf.length - 8) {
    throw new Error(`safetensors: bad header length in ${path}`)
  }
  const headerJson = buf.subarray(8, 8 + headerLen).toString('utf8')
  const header = JSON.parse(headerJson)
  const blobStart = 8 + headerLen
  return {
    has (name) { return Object.prototype.hasOwnProperty.call(header, name) },
    get (name) {
      const rec = header[name]
      if (!rec) throw new Error(`safetensors: missing tensor '${name}' in ${path}`)
      const start = blobStart + rec.data_offsets[0]
      const end = blobStart + rec.data_offsets[1]
      const slice = buf.subarray(start, end)
      switch (rec.dtype) {
        case 'F32':
          return new Float32Array(slice.buffer, slice.byteOffset, slice.byteLength / 4)
        case 'I32':
          return new Int32Array(slice.buffer, slice.byteOffset, slice.byteLength / 4)
        case 'BOOL':
          return new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength)
        default:
          throw new Error(`safetensors: unsupported dtype ${rec.dtype} for '${name}'`)
      }
    },
    shape (name) {
      const rec = header[name]
      if (!rec) throw new Error(`safetensors: missing tensor '${name}' in ${path}`)
      return rec.shape
    }
  }
}

function cosineSim (a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

function maxAbsDiff (a, b) {
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m) m = d
  }
  return m
}

function maxAbs (a) {
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i])
    if (v > m) m = v
  }
  return m
}

// ── Mobile asset loading & GGUF download ──────────────────────────────────
// On AWS Device Farm the addon runs inside the test-addon-mobile APK, so we
// can't bake a ~4 GB GGUF into it. The mobile workflow bundles a presigned
// URL JSON into testAssets/ and we stream-download to writable storage on
// first run. Mirrors the pattern in addon.test.js (kept inline rather than
// shared to avoid a refactor across both tests in this change — follow-up
// could extract into test/integration/_mobile-fetch.js).

function _loadMobileUrlsConfig () {
  if (typeof global === 'undefined' || !global.assetPaths) return null
  const candidates = [
    '../../testAssets/pi05-urls.json',
    '../mobile/testAssets/pi05-urls.json',
    'testAssets/pi05-urls.json',
    '../testAssets/pi05-urls.json'
  ]
  for (const candidate of candidates) {
    const p = global.assetPaths[candidate]
    if (!p) continue
    try {
      const raw = fs.readFileSync(p.replace('file://', ''), 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      console.log(`[pi05-mobile] failed to read ${candidate}: ${err && err.message}`)
    }
  }
  return null
}

function _loadMobileFixtureJson () {
  if (typeof global === 'undefined' || !global.assetPaths) return null
  const fixCandidates = [
    '../../testAssets/pi05-fixture.json',
    '../mobile/testAssets/pi05-fixture.json',
    'testAssets/pi05-fixture.json',
    '../testAssets/pi05-fixture.json'
  ]
  const refCandidates = [
    '../../testAssets/pi05-actions-ref.json',
    '../mobile/testAssets/pi05-actions-ref.json',
    'testAssets/pi05-actions-ref.json',
    '../testAssets/pi05-actions-ref.json'
  ]
  function _readFirst (candidates, label) {
    for (const c of candidates) {
      const p = global.assetPaths[c]
      if (!p) continue
      try {
        return JSON.parse(fs.readFileSync(p.replace('file://', ''), 'utf8'))
      } catch (err) {
        console.log(`[pi05-mobile] failed to read ${label} ${c}: ${err && err.message}`)
      }
    }
    return null
  }
  const fixture = _readFirst(fixCandidates, 'fixture')
  const ref = _readFirst(refCandidates, 'actions-ref')
  if (!fixture || !ref) return null

  // Decode the base64-packed images_chw_f32 back into a Float32Array.
  // 3 cams × 3*224*224 = 451584 floats per camera; total payload is
  // 3 * 3*224*224 * 4 = 1806336 raw bytes (≈ 2.4 MB base64-encoded).
  if (!fixture.images_chw_f32_b64) {
    throw new Error('pi05-fixture.json missing images_chw_f32_b64')
  }
  const imageBytes = Buffer.from(fixture.images_chw_f32_b64, 'base64')
  const images = new Float32Array(
    imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength / 4
  )
  const tokens = Int32Array.from(fixture.tokens)
  const mask = Uint8Array.from(fixture.mask)
  const noise = Float32Array.from(fixture.noise)

  const refRows = ref['ode.actions_final']
  if (!Array.isArray(refRows) || refRows.length !== 50) {
    throw new Error('pi05-actions-ref.json: bad ode.actions_final shape')
  }
  const expected = new Float32Array(50 * 32)
  for (let i = 0; i < 50; i++) {
    for (let j = 0; j < 32; j++) expected[i * 32 + j] = refRows[i][j]
  }
  return { images, tokens, mask, noise, expected }
}

function _streamDownload (url, destPath, maxRedirects = 5) {
  const https = require('bare-https')
  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = () => { if (!resolved) { resolved = true; resolve() } }
    const safeReject = (err) => { if (!resolved) { resolved = true; reject(err) } }
    console.log(`[pi05-mobile] downloading: ${url.substring(0, 60)}...`)
    const file = fs.createWriteStream(destPath)
    file.on('error', (err) => {
      file.destroy()
      try { fs.unlinkSync(destPath) } catch (_) {}
      safeReject(err)
    })
    const req = https.request(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
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
      const LOG_INTERVAL_BYTES = 50 * 1024 * 1024
      let downloadedBytes = 0
      let nextLogBytes = LOG_INTERVAL_BYTES
      let responseEnded = false
      res.on('data', (chunk) => {
        downloadedBytes += chunk.length
        if (downloadedBytes >= nextLogBytes) {
          const mb = downloadedBytes / (1024 * 1024)
          const pct = contentLength > 0 ? ` (${((downloadedBytes / contentLength) * 100).toFixed(1)}%)` : ''
          console.log(`[pi05-mobile] progress: ${mb.toFixed(0)}MB${pct}`)
          nextLogBytes += LOG_INTERVAL_BYTES
        }
      })
      res.on('end', () => { responseEnded = true })
      res.on('error', (err) => {
        file.destroy()
        try { fs.unlinkSync(destPath) } catch (_) {}
        safeReject(err)
      })
      res.pipe(file)
      // The HF CDN (cas-bridge.xethub.hf.co) sometimes drops the TLS
      // connection mid-stream on Device Farm. bare-https closes the
      // file silently in that case — we'd resolve as success with a
      // truncated GGUF. Cross-check downloadedBytes vs Content-Length
      // (and require 'end' fired on the response) so a partial stream
      // surfaces as a real error and the retry loop kicks in.
      file.on('close', () => {
        const mb = downloadedBytes / (1024 * 1024)
        if (contentLength > 0 && downloadedBytes !== contentLength) {
          try { fs.unlinkSync(destPath) } catch (_) {}
          safeReject(new Error(
            `incomplete stream: got ${downloadedBytes} of ${contentLength} bytes ` +
            `(${mb.toFixed(1)} MB), responseEnded=${responseEnded}`
          ))
          return
        }
        if (!responseEnded) {
          try { fs.unlinkSync(destPath) } catch (_) {}
          safeReject(new Error(
            `incomplete stream: response ended early at ${downloadedBytes} bytes ` +
            `(${mb.toFixed(1)} MB; no Content-Length to cross-check)`
          ))
          return
        }
        console.log(`[pi05-mobile] downloaded: ${path.basename(destPath)} (${mb.toFixed(1)}MB)`)
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

async function _downloadFile (url, destPath, maxRedirects = 5, maxRetries = 5) {
  // Longer backoff than the default exponential, because the failure
  // mode we hit on Device Farm (cas-bridge.xethub.hf.co — the HF LFS
  // CDN backing host that resolve/main redirects to) is bare-dns
  // returning "no address" after a TLS stream drop. The resolver's
  // negative cache takes a few seconds to clear; the previous 500 ms
  // base backoff retried before DNS was ready and tripped the same
  // error each time. 2 s / 4 s / 8 s / 16 s gives ~30 s total of
  // wait time, well inside the wdio polling window.
  let lastErr = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 2000 * (2 ** (attempt - 1))
      console.log(`[pi05-mobile] retry ${attempt}/${maxRetries - 1} after ${backoffMs}ms (last: ${lastErr && lastErr.message})`)
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
  throw new Error(`[pi05-mobile] download failed after ${maxRetries} attempts: ${lastErr && lastErr.message}`)
}

async function _sha256File (filePath) {
  let crypto
  try { crypto = require('bare-crypto') } catch (_) { return null }
  return await new Promise((resolve, reject) => {
    let hash
    try { hash = crypto.createHash('sha256') } catch (_) { return resolve(null) }
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()))
  })
}

async function _verifyCachedModel (filePath, urlConfig) {
  const stat = fs.statSync(filePath)
  if (urlConfig && Number.isInteger(urlConfig.sizeBytes)) {
    if (stat.size !== urlConfig.sizeBytes) {
      return { ok: false, reason: `size ${stat.size} != expected ${urlConfig.sizeBytes}` }
    }
  } else {
    const cachedMB = stat.size / (1024 * 1024)
    if (cachedMB < 100) {
      return { ok: false, reason: `size ${cachedMB.toFixed(2)}MB < 100MB floor` }
    }
  }
  if (urlConfig && typeof urlConfig.sha256 === 'string' && urlConfig.sha256.length === 64) {
    const got = await _sha256File(filePath)
    if (got === null) {
      return { ok: false, reason: 'sha256 configured but bare-crypto unavailable — cannot verify integrity' }
    }
    if (got !== urlConfig.sha256.toLowerCase()) {
      return { ok: false, reason: `sha256 ${got} != expected ${urlConfig.sha256}` }
    }
    console.log(`[pi05-mobile] sha256 verified: ${got.slice(0, 12)}…`)
  }
  return { ok: true }
}

async function _ensureMobilePi05Model () {
  const modelFilename = 'pi05-base-q-aggressive.gguf'
  const writableRoot = global.testDir || '/tmp'
  const modelsDir = path.join(writableRoot, 'vla-models')
  try { fs.mkdirSync(modelsDir, { recursive: true }) } catch (_) {}
  const destPath = path.join(modelsDir, modelFilename)

  const urlConfig = _loadMobileUrlsConfig()
  if (!urlConfig || !urlConfig.modelUrl) {
    throw new Error('pi05-urls.json not found in testAssets — cannot download GGUF on mobile')
  }

  if (fs.existsSync(destPath)) {
    const verdict = await _verifyCachedModel(destPath, urlConfig)
    if (verdict.ok) {
      const mb = fs.statSync(destPath).size / (1024 * 1024)
      console.log(`[pi05-mobile] reusing cached GGUF: ${destPath} (${mb.toFixed(1)}MB)`)
      return destPath
    }
    console.log(`[pi05-mobile] cached GGUF rejected (${verdict.reason}) — re-downloading`)
    try { fs.unlinkSync(destPath) } catch (_) {}
  }

  await _downloadFile(urlConfig.modelUrl, destPath)
  const verdict = await _verifyCachedModel(destPath, urlConfig)
  if (!verdict.ok) {
    throw new Error(`downloaded pi05 GGUF failed verification: ${verdict.reason}`)
  }
  return destPath
}

// Unified input loader. Returns the same { ggufPath, images[3], tokens,
// mask, noise, expected } shape regardless of which side has assets, so
// the test body doesn't have to branch on platform.
async function _loadTestInputs () {
  const perCam = 3 * 224 * 224
  if (_assetsState.state === 'HAVE_DESKTOP') {
    const fixture = loadSafetensors(process.env.PI05_TEST_FIXTURE)
    const activations = loadSafetensors(process.env.PI05_TEST_ACTIVATIONS)
    const allImages = fixture.get('fixture.images')
    if (allImages.length !== 3 * perCam) {
      throw new Error(`fixture.images length ${allImages.length} != 3*${perCam}`)
    }
    return {
      ggufPath: process.env.PI05_TEST_GGUF,
      images: [
        allImages.subarray(0, perCam),
        allImages.subarray(perCam, 2 * perCam),
        allImages.subarray(2 * perCam, 3 * perCam)
      ],
      tokens: fixture.get('fixture.tokens'),
      mask: fixture.get('fixture.mask'),
      noise: fixture.get('fixture.noise'),
      expected: activations.get('ode.actions_final')
    }
  }
  if (_assetsState.state === 'HAVE_MOBILE') {
    const mobile = _loadMobileFixtureJson()
    if (!mobile) {
      throw new Error('mobile fixture/actions-ref JSON not found in testAssets')
    }
    const ggufPath = await _ensureMobilePi05Model()
    const allImages = mobile.images
    if (allImages.length !== 3 * perCam) {
      throw new Error(`mobile images length ${allImages.length} != 3*${perCam}`)
    }
    return {
      ggufPath,
      images: [
        allImages.subarray(0, perCam),
        allImages.subarray(perCam, 2 * perCam),
        allImages.subarray(2 * perCam, 3 * perCam)
      ],
      tokens: mobile.tokens,
      mask: mobile.mask,
      noise: mobile.noise,
      expected: mobile.expected
    }
  }
  return null
}

// Parse the quant variant from a GGUF basename so the perf-table test
// names carry which model is being benchmarked. Falls back to
// `unknown-quant` when the filename doesn't match the convention.
function _quantFromGgufPath (ggufPath) {
  const base = path.basename(ggufPath || '', '.gguf')
  // Conventional naming: `pi05-base-<quant>.gguf` (the S3 / CI form,
  // hyphen-separated) or `pi05_base_<quant>.gguf` (the converter's
  // default underscore form). Strip whichever prefix is present; if
  // neither matches, drop a leading `pi05[_-]` if there is one.
  let q = base.replace(/^pi05[_-]base[_-]/, '').replace(/^pi05[_-]/, '')
  if (!q || q === base) q = 'unknown-quant'
  return q
}

// One end-to-end pass: load on `backend`, run inference, compare against
// PyTorch reference, record perf. Returns the resolved backend name
// (e.g. 'cpu', 'metal', 'vulkan') so the caller can dedupe when `auto`
// falls through to cpu. Throws on assertion failures via the `t`
// brittle context.
async function _runPi05EndToEnd (t, ggufPath, inputs, backend, quant) {
  const { images, tokens, mask, noise, expected } = inputs
  const tag = `pi05-${quant}/${backend}`

  const model = new VlaModel({
    files: { model: [ggufPath] },
    config: { verbosity: 1 }
  })
  try {
    await model.load({ backend })
    t.ok(model.hparams, `[${tag}] hparams populated`)
    t.is(model.hparams.chunkSize, 50, `[${tag}] chunk_size`)
    t.is(model.hparams.actionDim, 32, `[${tag}] action_dim`)
    t.is(model.hparams.tokenizerMaxLength, 200, `[${tag}] tokenizer_max_length`)
    t.is(model.hparams.visionImageSize, 224, `[${tag}] vision_image_size`)
    t.is(model.hparams.numCameras, 3, `[${tag}] num_cameras`)
    if (backend === 'cpu') {
      // Explicit-cpu request must resolve to cpu. `auto` may legitimately
      // pick anything else, so we only log the resolved backendName below.
      t.is(model.backendName.toLowerCase(), 'cpu', `[${tag}] backend name (cpu)`)
    }

    // pi05 ignores `state` (its state is tokenised into the prompt —
    // discrete-state path). Pass an empty Float32Array to satisfy the
    // validator without sending real data.
    const input = {
      images,
      imgWidth: 224,
      imgHeight: 224,
      state: new Float32Array(0),
      tokens,
      mask,
      noise
    }

    const t0 = Date.now()
    const response = await model.run(input)
    const result = await response.await()
    const elapsed = Date.now() - t0
    t.comment(`[${tag}] inference elapsed: ${elapsed} ms`)

    t.ok(result, `[${tag}] run() returned a result`)
    t.ok(result.actions instanceof Float32Array, `[${tag}] actions is Float32Array`)
    t.is(result.actions.length, 50 * 32, `[${tag}] actions length`)

    const stats = result.stats || {}
    for (const key of ['vision_ms', 'prefill_compute_ms', 'prefill_total_ms', 'ode_ms', 'total_ms']) {
      t.is(typeof stats[key], 'number', `[${tag}] stats.${key} is a number`)
      t.ok(stats[key] >= 0, `[${tag}] stats.${key} >= 0`)
    }
    console.log(
      `[VLA TIMING ${tag}] vision=${stats.vision_ms.toFixed(0)}ms ` +
      `prefill_compute=${stats.prefill_compute_ms.toFixed(0)}ms ` +
      `prefill_total=${stats.prefill_total_ms.toFixed(0)}ms ` +
      `ode=${stats.ode_ms.toFixed(0)}ms ` +
      `total=${stats.total_ms.toFixed(0)}ms`
    )

    const cos = cosineSim(result.actions, expected)
    const diff = maxAbsDiff(result.actions, expected)
    const max = maxAbs(expected)
    const rel = diff / Math.max(max, 1e-9)
    let meanAbsDiff = 0
    for (let i = 0; i < expected.length; i++) meanAbsDiff += Math.abs(result.actions[i] - expected[i])
    meanAbsDiff /= expected.length
    const quality = {
      model: 'lerobot/pi05_base',
      compared: expected.length,
      action_max_abs_diff: diff,
      action_mean_abs_diff: meanAbsDiff,
      action_cos_sim: cos
    }
    console.log(
      `[VLA QUALITY ${tag}] vs ${quality.model}: ` +
      `max|Δ|=${quality.action_max_abs_diff.toFixed(4)} ` +
      `mean|Δ|=${quality.action_mean_abs_diff.toFixed(4)} ` +
      `cos=${quality.action_cos_sim.toFixed(4)} ` +
      `(${quality.compared} values)`
    )

    // Plan §5 bars: CPU end-to-end cos > 0.999, rel_max < 0.05;
    // GPU-class backends relaxed to cos > 0.99, rel_max < 0.20.
    // The looser GPU rel_max bar absorbs shader-side rounding on
    // Adreno/Metal/Vulkan — empirically a single element of the 50×32
    // action chunk can hit ~10–15 % relative error while the mean
    // stays at ~0.3 %, so cos (direction parity) is the main signal.
    // Matches the spirit of smolvla's per-backend tolerances in
    // addon.test.js (which uses absolute max-abs < 0.6 on Vulkan).
    const isCpu = (model.backendName.toLowerCase() === 'cpu')
    const cosBar = isCpu ? 0.999 : 0.99
    // The most-aggressive quant on the CPU path lands ~0.053 rel_max on
    // linux-x64 under GGML_BACKEND_DL (GGML_CPU_ALL_VARIANTS + repack kernels),
    // but a single element of the 50×32 action chunk rounds differently across
    // CPU ISAs — ~0.063 on arm64 (NEON) and ~0.067 on win32 (x86 repack) — so
    // the tight bar only held on the architecture it was calibrated on. This is
    // the same per-backend rounding spread the GPU bar already absorbs at 0.20;
    // CPU is not pi05's primary route (GPU is) and cos still clears > 0.999
    // everywhere, so the aggressive quant gets a cross-arch rel_max of 0.08 with
    // cos as the real correctness gate. Every other quant keeps the 0.05 CPU bar.
    const isAggressive = /aggressive/i.test(quant)
    const relBar = isCpu ? (isAggressive ? 0.08 : 0.05) : 0.20
    t.ok(cos > cosBar, `[${tag}] cos sim ${cos} > ${cosBar} (${isCpu ? 'CPU' : 'GPU-class'} bar)`)
    t.ok(rel < relBar, `[${tag}] rel max diff ${rel} < ${relBar}`)

    const ep = model.backendName || null
    console.log(`[VLA BACKEND ${tag}] execution_provider=${ep ?? 'unknown'}`)

    _perfReporter.record(`end-to-end inference (${tag})`, {
      total_time_ms: stats.total_ms,
      vision_time_ms: stats.vision_ms,
      prefill_compute_time_ms: stats.prefill_compute_ms,
      prefill_total_time_ms: stats.prefill_total_ms,
      ode_time_ms: stats.ode_ms
    }, {
      execution_provider: ep,
      quality
    })

    if (_isMobile) {
      // Device Farm tears down the BareKit process before exit handlers
      // fire — flush incrementally so the perf marker reaches logcat /
      // iOS console even if the next backend's run() throws.
      try {
        _perfReporter.writeReport()
        _perfReporter.writeToConsole()
      } catch (err) {
        console.log('[perf-reporter] mobile incremental flush failed: ' + (err && err.message))
      }
    }

    return model.backendName || null
  } finally {
    await model.unload().catch(() => {})
  }
}

// Mobile skip rationale:
//
// iOS: pi05's q_aggressive GGUF is 3.93 GB. iOS jetsam kills foreground
// apps that exceed the per-process memory limit on 8 GB iPhones (iPhone
// 16/17), which lands at ~3 GB resident — and inference touches the
// full weight set so we can't stay under that cap regardless of mmap vs
// heap, CPU vs Metal. Confirmed in run 26305222976 syslog:
//
//   ReportSystemMemory: Process QvacAddonTester [541] killed by
//   jetsam reason per-process-limit
//
// Android: technically fits on Pixel 9 Pro / Galaxy S25/S26 (12-16 GB
// RAM), but mobile coverage is deferred until the 4 GB GGUF lives on a
// project-owned CDN-fronted mirror. AWS Device Farm runs in us-west-2
// and the existing S3 bucket in eu-central-1 caps cross-region
// throughput at ~0.5-3 MB/s through the NAT gateway, well past the
// wdio polling window. Tracking the CDN-fronted mirror provisioning
// as a follow-up; desktop pi05 e2e (CPU + Vulkan + Metal + Windows)
// still runs against the S3 oracle directly.
//
// Follow-up paths to lift the iOS skip specifically: ship a smaller
// iOS-specific quant variant (~1.5 GB target) OR sign the test app
// with com.apple.developer.kernel.increased-memory-limit.
const _skipMobilePi05 = _isMobile

test('pi05 integration: VlaModel.run() matches PyTorch actions_final', { timeout: 1200000, skip: _skipMobilePi05 }, async (t) => {
  if (_assetsState.state === 'SKIP') {
    t.comment('skipping: ' + SKIP_REASON)
    return
  }
  if (_assetsState.state === 'FAIL') {
    t.fail(_assetsState.reason)
    return
  }

  // ── Load inputs + expected (desktop safetensors OR mobile JSON) ────────
  const inputs = await _loadTestInputs()
  if (!inputs) {
    t.fail('_loadTestInputs returned null despite asset state ' + _assetsState.state)
    return
  }
  const { ggufPath, images, tokens, mask, noise, expected } = inputs
  const quant = _quantFromGgufPath(ggufPath)

  // Shared sanity checks (don't repeat per backend — input shape is
  // platform-agnostic and the addon's hparams contract is identical
  // regardless of backend).
  const perCam = 3 * 224 * 224
  t.is(images.length, 3, 'three camera buffers')
  t.is(images[0].length, perCam, 'camera 0 length')
  t.is(images[1].length, perCam, 'camera 1 length')
  t.is(images[2].length, perCam, 'camera 2 length')
  t.is(tokens.length, 200, 'tokens length')
  t.is(mask.length, 200, 'mask length')
  t.is(noise.length, 50 * 32, 'noise length')
  t.is(expected.length, 50 * 32, 'expected actions length')

  // Run each backend in the same Bare process so the GGUF stays mmap'd
  // and the prebuilt addon only loads once. Mirrors the smolvla pattern
  // (addon.test.js loops auto + cpu). `auto` picks Metal/Vulkan/etc.
  // when available; `cpu` forces the baseline. The dual perf-report
  // rows let CI compare backends without scheduling two runs.
  //
  // On runners with no GPU device, `auto` falls through to cpu and the
  // two rows naturally collapse (same numbers) — we still emit both for
  // schema consistency.
  for (const backend of ['auto', 'cpu']) {
    await _runPi05EndToEnd(t, ggufPath, inputs, backend, quant)
  }
})

// ── Error-path tests (architecture-neutral but kept here for shape
//    symmetry with addon.test.js — see plan §5 "integration parity"). ──

test('pi05 integration: module exports expected surface', (t) => {
  t.is(typeof VlaModel, 'function')
  t.is(typeof preprocessImage, 'function')
  t.is(typeof padState, 'function')
})

test('pi05 integration: VlaModel rejects missing/invalid files.model', (t) => {
  // Same shell as the smolvla equivalent — VlaModel's validator lives
  // above the architecture dispatch so its behaviour is identical for
  // pi05 callers. Re-asserted here so the pi05 suite reads stand-alone.
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

test('pi05 integration: VlaModel.load rejects missing GGUF file', async (t) => {
  const m = new VlaModel({ files: { model: ['/definitely/does/not/exist/pi05.gguf'] } })
  let err = null
  try { await m.load() } catch (e) { err = e }
  t.ok(err, 'expected an error for missing GGUF')
})

test('pi05 integration: img-shape mismatch rejects cleanly and leaves model usable (needs GGUF)', { timeout: 600000, skip: _skipMobilePi05 }, async (t) => {
  if (_assetsState.state === 'SKIP') {
    t.comment('skipping: ' + SKIP_REASON)
    return
  }
  if (_assetsState.state === 'FAIL') {
    t.fail(_assetsState.reason)
    return
  }

  const inputs = await _loadTestInputs()
  if (!inputs) {
    t.fail('_loadTestInputs returned null despite asset state ' + _assetsState.state)
    return
  }

  const model = new VlaModel({
    files: { model: [path.resolve(inputs.ggufPath)] },
    config: { verbosity: 1 }
  })
  try {
    await model.load({ backend: 'cpu' })
    const hp = model.hparams
    const size = hp.visionImageSize
    // pi05_base lives at 224 → pick 256 as the "wrong" size; pi05 ignores
    // anything other than 224 and the validator should catch it before any
    // C++ inference runs.
    const wrongSize = size === 224 ? 256 : 224

    // Pixel buffer sized for the (wrong) imgWidth/Height so we don't trip
    // the upstream "pixel.length === 3*imgW*imgH" check first.
    const dummyPixels = new Float32Array(3 * wrongSize * wrongSize)
    const tokens = new Int32Array(hp.tokenizerMaxLength)
    const mask = new Uint8Array(hp.tokenizerMaxLength)
    tokens[0] = 1
    mask[0] = 1
    const badInput = {
      images: [dummyPixels, dummyPixels, dummyPixels],
      imgWidth: wrongSize,
      imgHeight: wrongSize,
      state: new Float32Array(0), // pi05 ignores `state`
      tokens,
      mask
    }

    let rejectErr = null
    try { await model.run(badInput) } catch (e) { rejectErr = e }
    t.ok(rejectErr, 'expected run() to reject on img-shape mismatch')
    t.ok(
      rejectErr && /imgWidth.*imgHeight|visionImageSize/i.test(rejectErr.message || ''),
      `error mentions imgWidth/imgHeight/visionImageSize (got: ${rejectErr && rejectErr.message})`
    )

    // Verify the model is still usable after rejection. If the rejection
    // had wedged `_hasActiveResponse`, the next run() would immediately
    // throw JOB_ALREADY_RUNNING — same regression smolvla's equivalent
    // test guards against.
    const goodInput = {
      images: inputs.images,
      imgWidth: 224,
      imgHeight: 224,
      state: new Float32Array(0),
      tokens: inputs.tokens,
      mask: inputs.mask,
      noise: inputs.noise
    }
    const response = await model.run(goodInput)
    const { actions } = await response.await()
    t.ok(actions instanceof Float32Array, 'follow-up run produced actions')
    t.is(
      actions.length,
      hp.chunkSize * hp.actionDim,
      'follow-up run actions length matches chunk_size*action_dim'
    )
  } finally {
    await model.unload().catch(() => {})
  }
})
