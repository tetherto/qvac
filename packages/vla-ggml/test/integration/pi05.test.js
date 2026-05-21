'use strict'

// JS integration test for π₀.₅.
//
// Loads pi05_base.gguf via the public VlaModel surface, feeds the same
// Phase-0 fixture used by the C++ M3.x parity tests, and asserts the
// returned action chunk matches the dump's `ode.actions_final`.
//
// Catches what the C++ Pi05Integration test can't:
//   * JS validator + binding.runJob argument marshalling
//   * Per-event callback wiring (Output → JobEnded sequence)
//   * VlaModel lifecycle through load() / run() / unload()
//
// Skips cleanly when the test artefacts aren't on disk (so CI without
// the pi05_base mirror still passes):
//   PI05_TEST_GGUF        — path to pi05_base.gguf  (Phase 2 output)
//   PI05_TEST_FIXTURE     — path to fixture.safetensors  (Phase 0)
//   PI05_TEST_ACTIVATIONS — path to activations.safetensors  (Phase 0)

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

const HAS_ASSETS =
  process.env.PI05_TEST_GGUF &&
  process.env.PI05_TEST_FIXTURE &&
  process.env.PI05_TEST_ACTIVATIONS &&
  fs.existsSync(process.env.PI05_TEST_GGUF) &&
  fs.existsSync(process.env.PI05_TEST_FIXTURE) &&
  fs.existsSync(process.env.PI05_TEST_ACTIVATIONS)

const SKIP_REASON =
  'set PI05_TEST_GGUF / PI05_TEST_FIXTURE / PI05_TEST_ACTIVATIONS env vars to run'

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

test('pi05 integration: VlaModel.run() matches PyTorch actions_final', { timeout: 300000 }, async (t) => {
  if (!HAS_ASSETS) {
    t.comment('skipping: ' + SKIP_REASON)
    return
  }

  // ── Load fixture inputs + expected outputs ──────────────────────────────
  const fixture = loadSafetensors(process.env.PI05_TEST_FIXTURE)
  const activations = loadSafetensors(process.env.PI05_TEST_ACTIVATIONS)

  // fixture.images is shape (3, 3, 224, 224) F32. Each per-camera slice is
  // 3*224*224 = 150528 floats, contiguous CHW. That's exactly the layout
  // VlaModel.run() expects per `input.images[i]`.
  const allImages = fixture.get('fixture.images')
  const perCam = 3 * 224 * 224
  t.is(allImages.length, 3 * perCam, 'fixture.images length')
  const images = [
    allImages.subarray(0, perCam),
    allImages.subarray(perCam, 2 * perCam),
    allImages.subarray(2 * perCam, 3 * perCam)
  ]

  const tokens = fixture.get('fixture.tokens') // Int32Array(200)
  const mask = fixture.get('fixture.mask') // Uint8Array(200) (bool-packed)
  const noise = fixture.get('fixture.noise') // Float32Array(50*32)
  const expected = activations.get('ode.actions_final') // Float32Array(50*32)

  t.is(tokens.length, 200, 'tokens length')
  t.is(mask.length, 200, 'mask length')
  t.is(noise.length, 50 * 32, 'noise length')
  t.is(expected.length, 50 * 32, 'expected actions length')

  // ── Load Pi05Model via the public VlaModel surface ─────────────────────
  const model = new VlaModel({
    files: { model: [process.env.PI05_TEST_GGUF] },
    config: { verbosity: 1 } // WARNING — quiet but surface errors
  })
  await model.load({ backend: 'cpu' })
  t.ok(model.hparams, 'hparams populated')
  t.is(model.hparams.chunkSize, 50, 'chunk_size')
  t.is(model.hparams.actionDim, 32, 'action_dim')
  t.is(model.hparams.tokenizerMaxLength, 200, 'tokenizer_max_length')
  t.is(model.hparams.visionImageSize, 224, 'vision_image_size')
  t.is(model.hparams.numCameras, 3, 'num_cameras')
  t.is(model.backendName, 'cpu', 'backend name')

  // ── Run inference ──────────────────────────────────────────────────────
  // pi05 ignores `state` (its state is tokenised into the prompt — the
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
  t.comment(`inference elapsed: ${elapsed} ms`)

  t.ok(result, 'run() returned a result object')
  t.ok(result.actions instanceof Float32Array, 'actions is Float32Array')
  t.is(result.actions.length, 50 * 32, 'actions length')

  // Per-component timings must be present and non-negative — same shape
  // as smolvla's stats (`prefill_*` are the architecture-neutral names;
  // the addon also back-fills the legacy `smollm2_*` aliases for old
  // consumers, but pi05's surface uses the neutral names).
  const stats = result.stats || {}
  for (const key of ['vision_ms', 'prefill_compute_ms', 'prefill_total_ms', 'ode_ms', 'total_ms']) {
    t.is(typeof stats[key], 'number', `stats.${key} is a number`)
    t.ok(stats[key] >= 0, `stats.${key} >= 0`)
  }
  const tag = 'pi05/cpu'
  console.log(
    `[VLA TIMING ${tag}] vision=${stats.vision_ms.toFixed(0)}ms ` +
    `prefill_compute=${stats.prefill_compute_ms.toFixed(0)}ms ` +
    `prefill_total=${stats.prefill_total_ms.toFixed(0)}ms ` +
    `ode=${stats.ode_ms.toFixed(0)}ms ` +
    `total=${stats.total_ms.toFixed(0)}ms`
  )

  // ── Compare against PyTorch ────────────────────────────────────────────
  const cos = cosineSim(result.actions, expected)
  const diff = maxAbsDiff(result.actions, expected)
  const max = maxAbs(expected)
  const rel = diff / Math.max(max, 1e-9)
  const quality = {
    model: 'lerobot/pi05_base',
    compared: expected.length,
    action_max_abs_diff: diff,
    action_mean_abs_diff: (() => {
      let s = 0
      for (let i = 0; i < expected.length; i++) s += Math.abs(result.actions[i] - expected[i])
      return s / expected.length
    })(),
    action_cos_sim: cos
  }
  console.log(
    `[VLA QUALITY ${tag}] vs ${quality.model}: ` +
    `max|Δ|=${quality.action_max_abs_diff.toFixed(4)} ` +
    `mean|Δ|=${quality.action_mean_abs_diff.toFixed(4)} ` +
    `cos=${quality.action_cos_sim.toFixed(4)} ` +
    `(${quality.compared} values)`
  )

  // Plan §5 end-to-end CPU bar: cos > 0.999. Relaxed abs-diff bar (5 %
  // relative) tracks the same F16-noise-accumulation pattern the C++
  // integration test sees. Direction parity is the meaningful signal.
  t.ok(cos > 0.999, `cos sim ${cos} > 0.999`)
  t.ok(rel < 0.05, `rel max diff ${rel} < 0.05`)

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

  // Mobile incremental flush — same rationale as addon.test.js: Device
  // Farm tears down the BareKit process before exit handlers fire, so
  // we write incrementally to make sure the perf-report markers reach
  // logcat / iOS console.
  if (_isMobile) {
    try {
      _perfReporter.writeReport()
      _perfReporter.writeToConsole()
    } catch (err) {
      console.log('[perf-reporter] mobile incremental flush failed: ' + (err && err.message))
    }
  }

  await model.unload()
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

test('pi05 integration: img-shape mismatch rejects cleanly and leaves model usable (needs GGUF)', { timeout: 300000 }, async (t) => {
  if (!HAS_ASSETS) {
    t.comment('skipping: ' + SKIP_REASON)
    return
  }

  const model = new VlaModel({
    files: { model: [path.resolve(process.env.PI05_TEST_GGUF)] },
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
    const fixture = loadSafetensors(process.env.PI05_TEST_FIXTURE)
    const allImages = fixture.get('fixture.images')
    const perCam = 3 * 224 * 224
    const goodInput = {
      images: [
        allImages.subarray(0, perCam),
        allImages.subarray(perCam, 2 * perCam),
        allImages.subarray(2 * perCam, 3 * perCam)
      ],
      imgWidth: 224,
      imgHeight: 224,
      state: new Float32Array(0),
      tokens: fixture.get('fixture.tokens'),
      mask: fixture.get('fixture.mask'),
      noise: fixture.get('fixture.noise')
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
