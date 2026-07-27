'use strict'

// JS integration test for GR00T N1.7-3B.
//
// Loads groot.gguf via the public VlaModel surface and drives one end-to-end
// inference through VlaModel.load()/run()/unload(). This is a PLUMBING /
// finite-shape gate, not a PyTorch-parity test:
//
//   * GR00T's oracle dumps no input_ids and no reference final actions, so —
//     exactly like the C++ test_groot_infer_smoke.cpp — the returned action
//     chunk can't be compared numerically. Numerical correctness of every
//     composed stage is covered by the C++ milestone tests (test_groot_m4_*).
//   * What this DOES catch, and the C++ tests can't:
//       - the JS validator's groot branch (imageInputMode === 'patches' —
//         patchified images bypass the pixel-plane `3·w·h` length check)
//       - binding.runJob argument marshalling for a patch-format image array
//       - VlaModel lifecycle (load → run → unload) + stats/hparams surfacing
//
// Desktop: skips cleanly when the artefacts aren't on disk (so CI without the
// groot oracle still passes):
//   GROOT_TEST_GGUF            — path to groot-q8_vf16.gguf
//   GROOT_TEST_ACTIVATIONS_V4  — path to activations_v4.safetensors
// Mobile (iOS/Android): downloads the q5_vf16 GGUF from the presigned S3 URL
// bundled in groot-urls.json and drives run() with synthetic inputs (no oracle
// on-device). See the _isMobile branch below.

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const { VlaModel } = require('../..')

// ── Performance reporter (best-effort; same shape as pi05.test.js) ─────────
let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  createPerformanceReporter = function () {
    const _results = []
    return {
      record(testName, metrics, extra) {
        _results.push({ test: testName, metrics, extra })
      },
      writeReport() {},
      writeStepSummary() {},
      writeToConsole() {},
      get length() {
        return _results.length
      }
    }
  }
}

const _perfReporter = createPerformanceReporter({ addon: 'vla', addonType: 'groot' })
const _reportPath = path.resolve('.', 'test/results/performance-report-groot.json')

process.on('exit', () => {
  if (_perfReporter.length === 0) return
  try {
    _perfReporter.writeReport(_reportPath)
    _perfReporter.writeStepSummary()
    _perfReporter.writeToConsole()
  } catch (err) {
    console.log('[perf-reporter] flush failed: ' + (err && err.message))
  }
})

// ── Fixture dims (LIBERO model of record; match the libero activations_v4) ──
// LIBERO: 2 cameras × 1 frame = 2 images, 256 patches/img (→ 64 merged tokens
// each = 128 image tokens), prompt length 148. (The earlier DROID checkpoint —
// 4 images / 280 tokens — is retired: no sim, not in CI, not the demo.)
const N_IMAGES = 2 // 2 cameras × 1 frame
const PATCHES_PER_IMG = 256
const IN_FLAT = 1536
const T_TOK = 148
const IMAGE_TOKEN_ID = 151655
const STATE_DIM = 132
const N_ACT = 40
const ACT_DIM = 132
const IMAGE_SIZE = 256

// ── Asset detection ────────────────────────────────────────────────────────
//   HAVE: both env vars set AND files exist → run against local safetensors.
//   SKIP: both unset → local dev convenience.
//   FAIL: set but missing → loud (CI sets them unconditionally; a silent skip
//         would hide a broken mirror path).
const _assetsState = (function detectAssets() {
  const keys = ['GROOT_TEST_GGUF', 'GROOT_TEST_ACTIVATIONS_V4']
  const values = keys.map((k) => process.env[k])
  if (values.every((v) => !v)) return { state: 'SKIP' }
  const missing = keys.filter((k, i) => !values[i] || !fs.existsSync(values[i]))
  if (missing.length > 0) {
    return {
      state: 'FAIL',
      reason:
        'Some GROOT_TEST_* env vars point at missing files: ' +
        missing.map((k) => `${k}=${process.env[k] || '<unset>'}`).join(', ')
    }
  }
  return { state: 'HAVE' }
})()

const SKIP_REASON =
  'set GROOT_TEST_GGUF and GROOT_TEST_ACTIVATIONS_V4 to run the groot integration test'

// Mobile (iOS/Android, AWS Device Farm) runs the q5_vf16 build (2.7 GB, Q5_0
// non-vision) which fits the on-device budget the gallocr refactor freed up.
// The GGUF can't be baked into the APK, so CI bundles a presigned S3 URL in
// groot-urls.json and we download it on first run (see _ensureMobileModel,
// mirroring addon.test.js). The 462 MB activations_v4 oracle is NOT shipped to
// the device — this JS test is plumbing-only (finite/shape, no numeric parity;
// that's the C++ infer-parity gtest), so on mobile we drive run() with
// synthetic inputs. Numeric correctness stays covered by the desktop C++ tests.
const _platform = os.platform()
const _isMobile = _platform === 'ios' || _platform === 'android'

// ── Inline safetensors v1 parser (same as pi05.test.js) ────────────────────
function loadSafetensors(p) {
  const buf = fs.readFileSync(p)
  const headerLen = Number(buf.readBigUInt64LE(0))
  if (headerLen <= 0 || headerLen > buf.length - 8) {
    throw new Error(`safetensors: bad header length in ${p}`)
  }
  const headerJson = buf.subarray(8, 8 + headerLen).toString('utf8')
  const header = JSON.parse(headerJson)
  const blobStart = 8 + headerLen
  return {
    get(name) {
      const rec = header[name]
      if (!rec) throw new Error(`safetensors: missing tensor '${name}' in ${p}`)
      const start = blobStart + rec.data_offsets[0]
      const end = blobStart + rec.data_offsets[1]
      const slice = buf.subarray(start, end)
      switch (rec.dtype) {
        case 'F32':
          return new Float32Array(slice.buffer, slice.byteOffset, slice.byteLength / 4)
        default:
          throw new Error(`safetensors: unsupported dtype ${rec.dtype} for '${name}'`)
      }
    }
  }
}

// Build the { images[4], state, tokens, mask, noise } inputs from the oracle.
// Real patchified images + normalized state + sampled noise; a synthetic prompt
// with an image placeholder at each visual-pos-mask position. This JS gate stays
// plumbing-only (finite/shape), so it uses stand-in text ids; the C++
// infer-parity gtest is the one that feeds v4's real input_ids for numeric parity.
function _loadInputs() {
  const act = loadSafetensors(process.env.GROOT_TEST_ACTIVATIONS_V4)

  const patches = act.get('vision_input.call0.args.0')
  const perImg = PATCHES_PER_IMG * IN_FLAT
  if (patches.length !== N_IMAGES * perImg) {
    throw new Error(`patches length ${patches.length} != ${N_IMAGES}*${perImg}`)
  }
  const images = []
  for (let i = 0; i < N_IMAGES; i++) {
    images.push(patches.subarray(i * perImg, (i + 1) * perImg))
  }

  const state = act.get('state_encoder_input.call0.args.0')
  if (state.length !== STATE_DIM) throw new Error(`state length ${state.length} != ${STATE_DIM}`)
  const noise = act.get('action_encoder_input.call0.args.0')
  if (noise.length !== N_ACT * ACT_DIM)
    throw new Error(`noise length ${noise.length} != ${N_ACT * ACT_DIM}`)

  const vpm = act.get('text_model_input.call0.kwargs.visual_pos_masks')
  if (vpm.length !== T_TOK) throw new Error(`visual_pos_masks length ${vpm.length} != ${T_TOK}`)
  const tokens = new Int32Array(T_TOK)
  for (let t = 0; t < T_TOK; t++) tokens[t] = vpm[t] > 0.5 ? IMAGE_TOKEN_ID : 1000 + t
  const mask = new Uint8Array(T_TOK).fill(1)

  return {
    ggufPath: process.env.GROOT_TEST_GGUF,
    images,
    state: Float32Array.from(state),
    tokens,
    mask,
    noise: Float32Array.from(noise)
  }
}

// ── Synthetic inputs for the mobile plumbing gate ──────────────────────────
// No oracle on Device Farm, and this test compares nothing numerically, so
// feed small deterministic pseudo-random buffers of the exact fixture shapes.
// A seeded LCG keeps runs reproducible; values are kept small so the vision
// LayerNorms/softmaxes stay well-conditioned and the output is finite.
function _buildSyntheticInputs(ggufPath) {
  let seed = 0x9e3779b1 >>> 0
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed / 0xffffffff) * 2 - 1 // [-1, 1)
  }
  const images = []
  for (let i = 0; i < N_IMAGES; i++) {
    const buf = new Float32Array(PATCHES_PER_IMG * IN_FLAT)
    for (let j = 0; j < buf.length; j++) buf[j] = rand() * 0.1
    images.push(buf)
  }
  const state = new Float32Array(STATE_DIM)
  for (let i = 0; i < state.length; i++) state[i] = rand() * 0.1
  const noise = new Float32Array(N_ACT * ACT_DIM)
  for (let i = 0; i < noise.length; i++) noise[i] = rand()
  // infer() requires N_IMAGES disjoint contiguous runs of EXACTLY mergedPerImg
  // image-placeholder tokens, one per camera, each separated by a non-image
  // token. A single 128-long run is rejected. Lay out [64 image][text][64
  // image][text ...], matching the desktop oracle's per-camera layout.
  const perImg = PATCHES_PER_IMG / 4 // merge² = 4 → mergedPerImg = 64
  const tokens = new Int32Array(T_TOK)
  let w = 0
  for (let img = 0; img < N_IMAGES; img++) {
    for (let k = 0; k < perImg; k++) tokens[w++] = IMAGE_TOKEN_ID
    tokens[w++] = 1000 + img // text separator after each image run
  }
  for (; w < T_TOK; w++) tokens[w] = 1000 + w
  const mask = new Uint8Array(T_TOK).fill(1)
  return { ggufPath, images, state, tokens, mask, noise }
}

// ── Mobile model download (mirrors addon.test.js) ──────────────────────────
// On Device Farm the addon runs inside the packed test-addon-mobile app, so
// the GGUF can't be baked into the APK. CI bundles groot-urls.json (presigned
// S3 URL) into testAssets/ and we download on first run, cache + verify it.
// Download + cache-verify helpers are shared across the VLA integration tests
// (see _vla-model-download.cjs — literal require so the mobile bundler includes
// it). Only the model-specific urls filename is bound here.
const _vlaDl = require('./_vla-model-download.cjs')
const _loadUrlsConfig = () => _vlaDl.loadUrlsConfig('groot-urls.json')
const _downloadFile = _vlaDl.downloadFile
const _verifyCachedModel = _vlaDl.verifyCachedModel

async function _ensureMobileModel() {
  const modelFilename = 'groot-q5_vf16.gguf'
  const writableRoot = global.testDir || '/tmp'
  const modelsDir = path.join(writableRoot, 'vla-models')
  try {
    fs.mkdirSync(modelsDir, { recursive: true })
  } catch (_) {}
  const destPath = path.join(modelsDir, modelFilename)

  const urlConfig = _loadUrlsConfig()
  if (!urlConfig || !urlConfig.modelUrl) {
    throw new Error('groot-urls.json not found in testAssets — cannot download GGUF on mobile')
  }

  if (fs.existsSync(destPath)) {
    const verdict = await _verifyCachedModel(destPath, urlConfig)
    if (verdict.ok) {
      const mb = fs.statSync(destPath).size / (1024 * 1024)
      console.log(`[vla-model] reusing cached GGUF: ${destPath} (${mb.toFixed(1)}MB)`)
      return destPath
    }
    console.log(`[vla-model] cached GGUF rejected (${verdict.reason}) — re-downloading`)
    try {
      fs.unlinkSync(destPath)
    } catch (_) {}
  }

  await _downloadFile(urlConfig.modelUrl, destPath)
  const verdict = await _verifyCachedModel(destPath, urlConfig)
  if (!verdict.ok) {
    throw new Error(`downloaded GR00T GGUF failed verification: ${verdict.reason}`)
  }
  return destPath
}

// 40 min: on mobile this test downloads the q5 GGUF (~2.7GB, larger than
// smolvla's ~2GB at 1800000) before any inference, and a slow Device Farm S3
// link can stretch that well past 20 min (observed: a run stuck at 61% at the
// old 1200000 cap). Stays under the 60-min host WDIO/mocha cap the mobile CI
// sets via android-per-test-timeout-minutes (that extension does NOT reach this
// brittle timer — see run-mobile-integration-tests/build-mobile-app).
test(
  'groot integration: VlaModel.run() produces finite, correctly-shaped actions',
  { timeout: 2400000 },
  async (t) => {
    let inputs
    if (_isMobile) {
      // Device Farm: download the q5_vf16 GGUF, drive with synthetic inputs.
      const mobileGguf = await _ensureMobileModel()
      inputs = _buildSyntheticInputs(mobileGguf)
      t.comment('mobile: downloaded q5_vf16 GGUF + synthetic plumbing inputs')
    } else {
      if (_assetsState.state === 'SKIP') {
        t.comment('skipping: ' + SKIP_REASON)
        return
      }
      if (_assetsState.state === 'FAIL') {
        t.fail(_assetsState.reason)
        return
      }
      inputs = _loadInputs()
    }
    const { ggufPath, images, state, tokens, mask, noise } = inputs

    // Input-shape sanity (platform-agnostic).
    t.is(images.length, N_IMAGES, `${N_IMAGES} image buffers`)
    t.is(images[0].length, PATCHES_PER_IMG * IN_FLAT, 'image 0 is a patch buffer')
    t.is(state.length, STATE_DIM, 'state length')
    t.is(tokens.length, T_TOK, 'tokens length')
    t.is(mask.length, T_TOK, 'mask length')
    t.is(noise.length, N_ACT * ACT_DIM, 'noise length')

    const input = {
      images,
      imgWidth: IMAGE_SIZE,
      imgHeight: IMAGE_SIZE,
      state,
      tokens,
      mask,
      noise
    }

    // Desktop runs `auto` (GPU when present: Vulkan on the Linux runner, Metal on
    // darwin-arm64) then `cpu`, mirroring addon.test.js (smolvla) so CI captures a
    // GPU perf row for groot too. Mobile keeps a single cpu pass to bound the
    // Device Farm budget. On a CPU-only desktop runner `auto` resolves to cpu and
    // the two rows collapse. This is a plumbing gate (finite / shape / timing), so
    // every backend runs the same assertions; only the resolved backend differs.
    const backends = _isMobile ? ['cpu'] : ['auto', 'cpu']
    for (const backend of backends) {
      const model = new VlaModel({
        files: { model: [path.resolve(ggufPath)] },
        config: { verbosity: 1 }
      })
      try {
        await model.load({ backend })

        // hparams surface (backend-independent; mirrors the C++ integration test).
        t.ok(model.hparams, 'hparams populated')
        t.is(model.hparams.chunkSize, N_ACT, 'chunk_size')
        t.is(model.hparams.actionDim, ACT_DIM, 'action_dim')
        t.is(model.hparams.maxStateDim, STATE_DIM, 'max_state_dim')
        t.is(model.hparams.visionImageSize, IMAGE_SIZE, 'vision_image_size')
        t.is(model.hparams.numCameras, 2, 'num_cameras')
        t.is(model.hparams.stateInputMode, 'continuous', 'state_input_mode')
        t.is(model.hparams.imageInputMode, 'patches', 'image_input_mode (groot = patches)')
        t.ok(model.backendName, `backend name resolved (${backend})`)

        const t0 = Date.now()
        const response = await model.run(input)
        const result = await response.await()
        const ep = model.backendName || backend
        t.comment(`inference elapsed (${ep}): ${Date.now() - t0} ms`)

        t.ok(result, 'run() returned a result')
        t.ok(result.actions instanceof Float32Array, 'actions is Float32Array')
        t.is(result.actions.length, N_ACT * ACT_DIM, 'actions length == chunk_size * action_dim')

        let allFinite = true
        for (let i = 0; i < result.actions.length; i++) {
          if (!Number.isFinite(result.actions[i])) {
            allFinite = false
            break
          }
        }
        t.ok(allFinite, 'all action values are finite')

        const stats = result.stats || {}
        for (const key of [
          'vision_ms',
          'prefill_compute_ms',
          'prefill_total_ms',
          'ode_ms',
          'total_ms'
        ]) {
          t.is(typeof stats[key], 'number', `stats.${key} is a number`)
          t.ok(stats[key] >= 0, `stats.${key} >= 0`)
        }
        t.ok(stats.total_ms > 0, 'stats.total_ms > 0')
        console.log(
          `[VLA TIMING groot/${backend}] backend=${ep} ` +
            `vision=${stats.vision_ms.toFixed(0)}ms ` +
            `prefill_compute=${stats.prefill_compute_ms.toFixed(0)}ms ` +
            `prefill_total=${stats.prefill_total_ms.toFixed(0)}ms ` +
            `ode=${stats.ode_ms.toFixed(0)}ms total=${stats.total_ms.toFixed(0)}ms`
        )

        _perfReporter.record(
          `end-to-end inference (groot/${backend})`,
          {
            total_time_ms: stats.total_ms,
            vision_time_ms: stats.vision_ms,
            prefill_compute_time_ms: stats.prefill_compute_ms,
            prefill_total_time_ms: stats.prefill_total_ms,
            ode_time_ms: stats.ode_ms
          },
          { execution_provider: model.backendName || null }
        )
      } finally {
        await model.unload().catch(() => {})
      }
    }
  }
)

// ── Error-path tests (shape symmetry with pi05.test.js) ──────────────────
test('groot integration: module exports expected surface', (t) => {
  t.is(typeof VlaModel, 'function')
})

test('groot integration: VlaModel rejects missing/invalid files.model', (t) => {
  let err1 = null
  try {
    const m = new VlaModel({ files: { model: [] } })
    t.absent(m)
  } catch (e) {
    err1 = e
  }
  t.ok(err1 && /non-empty array/.test(err1.message))

  let err2 = null
  try {
    const m = new VlaModel({ files: { model: ['relative/path.gguf'] } })
    t.absent(m)
  } catch (e) {
    err2 = e
  }
  t.ok(err2 && /absolute path/.test(err2.message))
})

// GR00T's embodiment is fixed-shape (2 cameras, state.length === maxStateDim).
// The validator must fail these closed as INVALID_INPUT *before* native infer,
// since GrootModel::infer accepts nImages >= 1 and would otherwise produce
// actions for the wrong camera layout, and the shared continuous-state check
// only enforces state.length <= maxStateDim (not exact). Mirrors pi05's
// "rejects cleanly and leaves model usable" test.
test(
  'groot integration: wrong camera count / short state reject cleanly and leave model usable (needs GGUF)',
  { timeout: 600000 },
  async (t) => {
    let inputs
    if (_isMobile) {
      const mobileGguf = await _ensureMobileModel()
      inputs = _buildSyntheticInputs(mobileGguf)
    } else {
      if (_assetsState.state === 'SKIP') {
        t.comment('skipping: ' + SKIP_REASON)
        return
      }
      if (_assetsState.state === 'FAIL') {
        t.fail(_assetsState.reason)
        return
      }
      inputs = _loadInputs()
    }
    const { ggufPath, images, state, tokens, mask, noise } = inputs

    const model = new VlaModel({
      files: { model: [path.resolve(ggufPath)] },
      config: { verbosity: 1 }
    })
    try {
      await model.load({ backend: 'cpu' })

      // One camera instead of two: non-empty images, so it clears the generic
      // array check and reaches the GR00T numCameras guard.
      let camErr = null
      try {
        await model.run({
          images: [images[0]],
          imgWidth: IMAGE_SIZE,
          imgHeight: IMAGE_SIZE,
          state,
          tokens,
          mask,
          noise
        })
      } catch (e) {
        camErr = e
      }
      t.ok(camErr, 'expected run() to reject on wrong camera count')
      t.ok(
        camErr && /patch image buffers/.test(camErr.message || ''),
        `error mentions patch image buffers (got: ${camErr && camErr.message})`
      )

      // state.length maxStateDim-1: passes the loose shared check (<= maxStateDim)
      // but must fail GR00T's exact-length guard.
      let stateErr = null
      try {
        await model.run({
          images,
          imgWidth: IMAGE_SIZE,
          imgHeight: IMAGE_SIZE,
          state: state.slice(0, STATE_DIM - 1),
          tokens,
          mask,
          noise
        })
      } catch (e) {
        stateErr = e
      }
      t.ok(stateErr, 'expected run() to reject on short state')
      t.ok(
        stateErr && /state\.length === /.test(stateErr.message || ''),
        `error mentions exact state.length (got: ${stateErr && stateErr.message})`
      )

      // Model still usable after the rejections (guards against a wedged
      // _hasActiveResponse, same regression pi05/smolvla guard against).
      const response = await model.run({
        images,
        imgWidth: IMAGE_SIZE,
        imgHeight: IMAGE_SIZE,
        state,
        tokens,
        mask,
        noise
      })
      const { actions } = await response.await()
      t.ok(actions instanceof Float32Array, 'follow-up run produced actions')
      t.is(
        actions.length,
        N_ACT * ACT_DIM,
        'follow-up run actions length matches chunk_size*action_dim'
      )
    } finally {
      await model.unload().catch(() => {})
    }
  }
)
