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
const { VlaModel, ERR_CODES } = require('../..')

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

// Same synthetic inputs, for an arbitrary camera count. Needed to actually
// run() an embodiment whose numCameras differs from the default: the prompt
// length is not a hparam, it follows the image count, so a 4-camera row needs
// 4 runs of mergedPerImg placeholders and a prompt long enough to hold them
// (LIBERO's 148 cannot). Values are deterministic for a given (nCameras, seed),
// so two calls with the same arguments produce byte-identical inputs — the
// failed-switch rollback check below relies on that.
function _buildSyntheticInputsForCameras(ggufPath, nCameras, seed0) {
  let seed = (seed0 || 0x9e3779b1) >>> 0
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed / 0xffffffff) * 2 - 1
  }
  const images = []
  for (let i = 0; i < nCameras; i++) {
    const buf = new Float32Array(PATCHES_PER_IMG * IN_FLAT)
    for (let j = 0; j < buf.length; j++) buf[j] = rand() * 0.1
    images.push(buf)
  }
  const state = new Float32Array(STATE_DIM)
  for (let i = 0; i < state.length; i++) state[i] = rand() * 0.1
  const noise = new Float32Array(N_ACT * ACT_DIM)
  for (let i = 0; i < noise.length; i++) noise[i] = rand()
  // One [mergedPerImg image][1 text] block per camera, then text filler. Same
  // disjoint-runs rule as _buildSyntheticInputs; only the count changes.
  const perImg = PATCHES_PER_IMG / 4
  const nTok = nCameras * (perImg + 1) + 20 // + text tail (LIBERO uses 20)
  const tokens = new Int32Array(nTok)
  let w = 0
  for (let img = 0; img < nCameras; img++) {
    for (let k = 0; k < perImg; k++) tokens[w++] = IMAGE_TOKEN_ID
    tokens[w++] = 1000 + img
  }
  for (; w < nTok; w++) tokens[w] = 1000 + w
  const mask = new Uint8Array(nTok).fill(1)
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

// 55 min: on mobile this test downloads the q5 GGUF (~2.7GB, larger than
// smolvla's ~2GB at 1800000) before any inference, and a slow Device Farm S3
// link can stretch that well past 20 min (observed: a run stuck at 61% at the
// old 1200000 cap; then at the 2400000 cap an S26 Ultra lease running ~1MB/s
// against ~3.5MB/s on the two devices that passed reached only 86% before
// firing, so inference never ran). 55 min covers that lease and stays under
// the 60-min host WDIO/mocha cap the mobile CI sets via
// android-per-test-timeout-minutes (that extension does NOT reach this brittle
// timer — see run-mobile-integration-tests/build-mobile-app).
test(
  'groot integration: VlaModel.run() produces finite, correctly-shaped actions',
  { timeout: 3300000 },
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

// Multi-embodiment: selecting a non-default embodiment at load time surfaces
// that embodiment's camera count. The default (libero_sim) is 2 cameras; the
// droid embodiment is 4. This exercises the load-time selector end-to-end
// (config.embodiment -> tag -> stored row -> numCameras) through the full
// JS/addon path, on-device included. Load+select only, no run(): the other
// stored rows have no qvac camera config and can't run(), and per-embodiment
// numerical parity for all stored rows is the desktop C++ sweep gtest
// (GrootEmbodimentSweep). Skips cleanly on a single-embodiment GGUF (the
// selector rejects a non-default override), so it's a no-op until the
// multi-embodiment fixture ships.
const DROID_EMBODIMENT_TAG = 'oxe_droid_relative_eef_relative_joint'
const DROID_NUM_CAMERAS = 4

test(
  'groot integration: non-default embodiment selection surfaces its camera count (multi-embodiment GGUF)',
  { timeout: 2400000 },
  async (t) => {
    let ggufPath
    if (_isMobile) {
      ggufPath = await _ensureMobileModel()
    } else {
      if (_assetsState.state === 'SKIP') {
        t.comment('skipping: ' + SKIP_REASON)
        return
      }
      if (_assetsState.state === 'FAIL') {
        t.fail(_assetsState.reason)
        return
      }
      ggufPath = process.env.GROOT_TEST_GGUF
    }

    const model = new VlaModel({
      files: { model: [path.resolve(ggufPath)] },
      config: { verbosity: 1, embodiment: DROID_EMBODIMENT_TAG }
    })
    let loadErr = null
    try {
      await model.load({ backend: 'cpu' })
    } catch (e) {
      loadErr = e
    }
    if (loadErr) {
      // A single-embodiment GGUF rejects any non-default override — expected
      // until the multi-embodiment fixture lands. Anything else is a real bug.
      if (/single-embodiment/.test(loadErr.message || '')) {
        t.comment('skipping: GGUF is single-embodiment (no multi fixture yet)')
        return
      }
      t.fail(`unexpected load error selecting '${DROID_EMBODIMENT_TAG}': ${loadErr.message}`)
      return
    }
    try {
      t.ok(model.hparams, 'hparams populated')
      t.is(
        model.hparams.numCameras,
        DROID_NUM_CAMERAS,
        `num_cameras follows selected embodiment (${DROID_EMBODIMENT_TAG} = ${DROID_NUM_CAMERAS})`
      )
      t.is(
        model.hparams.selectedEmbodimentTag,
        DROID_EMBODIMENT_TAG,
        'selectedEmbodimentTag reports the load-time selection'
      )
      t.ok(
        Number.isInteger(model.hparams.selectedEmbodimentCatId),
        'selectedEmbodimentCatId reports the numeric form of the same selection'
      )
      t.is(model.hparams.stateInputMode, 'continuous', 'state_input_mode')
    } finally {
      await model.unload().catch(() => {})
    }
  }
)

// Find a stored row whose num_cameras the GGUF doesn't carry. The addon exposes
// no embodiment table to JS, so probe cat_ids: the resolver's messages tell
// "not in this ship set" apart from "no known num_cameras". Restores whatever
// embodiment was active on entry, since probing switches rows.
async function findUnknownCameraCatId(model, maxCatId = 31) {
  const restoreTo = model.hparams.selectedEmbodimentCatId
  let found = null
  for (let catId = 0; catId <= maxCatId && found === null; catId++) {
    try {
      await model.setEmbodiment(catId)
    } catch (e) {
      if (/no known num_cameras/.test(e.message || '')) found = catId
    }
  }
  await model.setEmbodiment(restoreTo)
  return found
}

// Multi-embodiment: one load serves any shipped embodiment. Switches the loaded
// model between embodiments through the JS API and checks the reported contract
// follows (numCameras + selectedEmbodimentTag), that an unknown tag is rejected
// without disturbing the active embodiment, and that switching back restores the
// default. Numerical equivalence of a switched model vs a fresh load of that
// embodiment is the C++ gtest
// (GrootEmbodimentSweep.SwitchEmbodimentMatchesFreshLoadOfThatEmbodiment); this
// covers the binding + wrapper plumbing, on-device included. Skips cleanly on a
// single-embodiment GGUF.
test(
  'groot integration: setEmbodiment switches embodiment on a loaded model (multi-embodiment GGUF)',
  { timeout: 2400000 },
  async (t) => {
    let ggufPath
    if (_isMobile) {
      ggufPath = await _ensureMobileModel()
    } else {
      if (_assetsState.state === 'SKIP') {
        t.comment('skipping: ' + SKIP_REASON)
        return
      }
      if (_assetsState.state === 'FAIL') {
        t.fail(_assetsState.reason)
        return
      }
      ggufPath = process.env.GROOT_TEST_GGUF
    }

    const model = new VlaModel({
      files: { model: [path.resolve(ggufPath)] },
      config: { verbosity: 1 }
    })
    await model.load({ backend: 'cpu' })
    try {
      const defaultTag = model.hparams.selectedEmbodimentTag
      const defaultCams = model.hparams.numCameras
      t.ok(defaultTag, 'default embodiment tag reported')

      let switchErr = null
      let switched = null
      try {
        switched = await model.setEmbodiment(DROID_EMBODIMENT_TAG)
      } catch (e) {
        switchErr = e
      }
      if (switchErr) {
        // Single-embodiment GGUF: nothing to switch to. Anything else is a bug.
        if (/single embodiment|single-embodiment/.test(switchErr.message || '')) {
          t.comment('skipping: GGUF is single-embodiment (no multi fixture yet)')
          return
        }
        t.fail(`unexpected setEmbodiment error: ${switchErr.message}`)
        return
      }

      t.is(switched.numCameras, DROID_NUM_CAMERAS, 'returned hparams follow the new embodiment')
      t.is(model.hparams.numCameras, DROID_NUM_CAMERAS, 'cached hparams refreshed')
      t.is(
        model.hparams.selectedEmbodimentTag,
        DROID_EMBODIMENT_TAG,
        'selectedEmbodimentTag follows the switch'
      )
      const droidCatId = model.hparams.selectedEmbodimentCatId
      t.ok(Number.isInteger(droidCatId), 'selectedEmbodimentCatId reported')

      // The same embodiment, named by its numeric id instead of its tag. Many
      // tags share one cat_id, so the reported tag is that id's canonical
      // spelling (the first in the GGUF's tag map) and need not be the alias
      // used above — the id and the camera count are what must match.
      await model.setEmbodiment(defaultTag)
      const byId = await model.setEmbodiment(droidCatId)
      t.is(byId.selectedEmbodimentCatId, droidCatId, 'cat_id selection lands on that id')
      t.ok(
        typeof byId.selectedEmbodimentTag === 'string' && byId.selectedEmbodimentTag.length > 0,
        `cat_id selection still reports a tag (${byId.selectedEmbodimentTag})`
      )
      t.is(byId.numCameras, DROID_NUM_CAMERAS, 'cat_id selection carries its camera count')

      // Every stored row is runnable: one whose num_cameras the GGUF doesn't
      // carry is rejected bare and accepted with an explicit count.
      const unknownCatId = await findUnknownCameraCatId(model)
      if (unknownCatId === null) {
        t.comment('no stored row lacks a camera count in this GGUF')
      } else {
        let noCamsErr = null
        try {
          await model.setEmbodiment(unknownCatId)
        } catch (e) {
          noCamsErr = e
        }
        t.ok(noCamsErr, `cat_id ${unknownCatId} rejected without an explicit camera count`)
        const withCams = await model.setEmbodiment({ catId: unknownCatId, numCameras: 2 })
        t.is(
          withCams.selectedEmbodimentCatId,
          unknownCatId,
          'camera override makes the row runnable'
        )
        t.is(withCams.numCameras, 2, 'explicit numCameras drives the reported contract')
        await model.setEmbodiment(droidCatId)
      }

      const activeTag = model.hparams.selectedEmbodimentTag
      const activeCams = model.hparams.numCameras

      let badErr = null
      try {
        await model.setEmbodiment('definitely-not-an-embodiment')
      } catch (e) {
        badErr = e
      }
      t.ok(badErr, 'unknown embodiment tag rejected')
      // A resolver rejection IS a bad request, so it must carry INVALID_CONFIG.
      // Real I/O faults on the same call carry FAILED_TO_LOAD_WEIGHTS instead
      // (asserted in the rollback test below) — the two must not collapse into
      // one code, or a caller cannot tell "fix your config" from "retry".
      t.is(badErr.code, ERR_CODES.INVALID_CONFIG, 'unknown tag reports INVALID_CONFIG')

      let bothErr = null
      try {
        await model.setEmbodiment({ tag: DROID_EMBODIMENT_TAG, catId: droidCatId })
      } catch (e) {
        bothErr = e
      }
      t.ok(bothErr, 'naming both a tag and a catId is rejected')

      // An id past the 0..31 id space must be an error, not a narrowing: as an
      // int32, 2**32 is 0, which would silently select a different embodiment.
      for (const hugeId of [2 ** 32, 2 ** 31, 32, 1.5, -1]) {
        let hugeErr = null
        try {
          await model.setEmbodiment(hugeId)
        } catch (e) {
          hugeErr = e
        }
        t.ok(hugeErr, `catId ${hugeId} rejected`)
      }
      t.is(
        model.hparams.selectedEmbodimentTag,
        activeTag,
        'rejected switch leaves the active embodiment in place'
      )
      t.is(model.hparams.numCameras, activeCams, 'rejected switch leaves the camera count in place')

      await model.setEmbodiment(defaultTag)
      t.is(
        model.hparams.numCameras,
        defaultCams,
        'switching back restores the default camera count'
      )
      t.is(
        model.hparams.selectedEmbodimentTag,
        defaultTag,
        'switching back restores the default embodiment'
      )

      // A switch must NOT slip between a dispatched inference and the worker
      // reaching it. run() releases the exclusive queue once the job is
      // dispatched, so without the active-response guard this switch would land
      // while the worker still had the old embodiment's validated input, and the
      // actions would come from an embodiment the caller never selected.
      const probe = _isMobile ? _buildSyntheticInputs(ggufPath) : _loadInputs()
      const response = await model.run({
        images: probe.images,
        imgWidth: IMAGE_SIZE,
        imgHeight: IMAGE_SIZE,
        state: probe.state,
        tokens: probe.tokens,
        mask: probe.mask,
        noise: probe.noise
      })
      let overlapErr = null
      try {
        await model.setEmbodiment(DROID_EMBODIMENT_TAG)
      } catch (e) {
        overlapErr = e
      }
      t.ok(overlapErr, 'switch during an un-awaited inference is rejected')
      t.is(
        model.hparams.selectedEmbodimentTag,
        defaultTag,
        'rejected overlapping switch leaves the active embodiment in place'
      )
      const overlapped = await response.await()
      t.ok(overlapped.actions.length > 0, 'the in-flight inference still completes')
      // Once it has settled the same switch is accepted.
      const after = await model.setEmbodiment(DROID_EMBODIMENT_TAG)
      t.is(after.numCameras, DROID_NUM_CAMERAS, 'switch accepted after the response settles')
      await model.setEmbodiment(defaultTag)

      // Same overlap, but straight at the binding — the guard above lives in
      // index.js, and the SDK plugin / Python bindings / any direct harness do
      // not go through it. Without a native check this switch succeeds and the
      // worker then runs DROID weights against input validated for the default
      // embodiment's camera count, returning plausible actions for an embodiment
      // nobody selected.
      const nativeBinding = require('../../binding')
      const nativeProbe = _isMobile ? _buildSyntheticInputs(ggufPath) : _loadInputs()
      const nativeResponse = await model.run({
        images: nativeProbe.images,
        imgWidth: IMAGE_SIZE,
        imgHeight: IMAGE_SIZE,
        state: nativeProbe.state,
        tokens: nativeProbe.tokens,
        mask: nativeProbe.mask,
        noise: nativeProbe.noise
      })
      let nativeErr = null
      try {
        nativeBinding.setVlaEmbodiment(model._handle, DROID_EMBODIMENT_TAG, 0)
      } catch (e) {
        nativeErr = e
      }
      t.ok(nativeErr, 'binding.setVlaEmbodiment is rejected while a job is in flight')
      t.is(
        model.hparams.selectedEmbodimentTag,
        defaultTag,
        'rejected native switch leaves the active embodiment in place'
      )
      const nativeSettled = await nativeResponse.await()
      t.ok(nativeSettled.actions.length > 0, 'the in-flight inference still completes')
      // And the native path accepts it once nothing is in flight, so the guard is
      // a real in-flight check rather than a blanket refusal.
      const nativeAfter = nativeBinding.setVlaEmbodiment(model._handle, DROID_EMBODIMENT_TAG, 0)
      t.is(
        nativeAfter.numCameras,
        DROID_NUM_CAMERAS,
        'binding.setVlaEmbodiment is accepted once no job is in flight'
      )

      // Out-of-range ids THROUGH the binding. normalizeEmbodiment rejects these
      // in JS before the binding is ever called, so the int32-narrowing defence
      // in jsBoundedInt is otherwise only covered by C++ unit tests, never on the
      // path a non-JS caller actually takes. 2**32 is the one that matters: a
      // plain narrowing cast turns it into 0, silently selecting row 0 instead of
      // failing.
      for (const badId of [2 ** 32, 2 ** 31, 32, 1.5, -1]) {
        let idErr = null
        try {
          nativeBinding.setVlaEmbodiment(model._handle, badId, 0)
        } catch (e) {
          idErr = e
        }
        t.ok(idErr, `binding.setVlaEmbodiment rejects cat_id ${badId}`)
      }
      t.is(
        nativeBinding.getVlaHparams(model._handle).selectedEmbodimentCatId,
        droidCatId,
        'rejected out-of-range ids did not narrow into a different embodiment'
      )

      // runJob resolves the instance handle itself now, for the in-flight
      // bookkeeping above, and it does so before anything else touches that
      // argument. An unknown handle must stay a catchable JS error: if that
      // resolution is ever made noexcept it becomes std::terminate instead, and
      // a direct binding caller passing a stale handle takes the whole process
      // down. This test survives only because it throws — an abort kills the run.
      let handleErr = null
      try {
        nativeBinding.runJob(
          {},
          {
            type: 'vla',
            input: {
              images: nativeProbe.images,
              imgWidth: IMAGE_SIZE,
              imgHeight: IMAGE_SIZE,
              state: nativeProbe.state,
              tokens: nativeProbe.tokens,
              mask: nativeProbe.mask,
              noise: nativeProbe.noise
            }
          }
        )
      } catch (e) {
        handleErr = e
      }
      t.ok(handleErr, 'binding.runJob with an unknown instance handle throws rather than aborting')

      await model.setEmbodiment(defaultTag)

      // Actually infer on an embodiment whose camera count differs from the
      // default. Everything above switches to DROID and back without ever
      // running it, which leaves the one path where a stale numCameras would
      // corrupt output untested end to end: infer() derives its whole token and
      // patch layout from nImages, so a switch that failed to move numCameras
      // would either be rejected here for the wrong image count or silently
      // build the wrong layout.
      await model.setEmbodiment(DROID_EMBODIMENT_TAG)
      t.is(model.hparams.numCameras, DROID_NUM_CAMERAS, 'switched to the 4-camera embodiment')
      const droidProbe = _buildSyntheticInputsForCameras(ggufPath, DROID_NUM_CAMERAS, 0x51ed2b47)
      const droidRes = await (
        await model.run({
          images: droidProbe.images,
          imgWidth: IMAGE_SIZE,
          imgHeight: IMAGE_SIZE,
          state: droidProbe.state,
          tokens: droidProbe.tokens,
          mask: droidProbe.mask,
          noise: droidProbe.noise
        })
      ).await()
      t.is(
        droidRes.actions.length,
        N_ACT * ACT_DIM,
        'run() on the switched embodiment returns a full action chunk'
      )
      t.ok(
        droidRes.actions.every((v) => Number.isFinite(v)),
        'actions from the switched embodiment are finite'
      )
      await model.setEmbodiment(defaultTag)

      // Weight-level rollback. The all-or-nothing claim is about WEIGHTS, but the
      // rejected-switch assertions above only check hparams. Force the one
      // reachable mid-switch failure — grootFillEmbodimentRow reopens the GGUF by
      // path, so renaming it out from under a loaded model makes that fopen fail
      // — then assert the model still produces bit-identical actions, i.e. the
      // previous row is intact rather than half-overwritten.
      //
      // Desktop only: on Device Farm the GGUF is a verified download cache and
      // renaming it risks poisoning it for later runs.
      if (!_isMobile) {
        const rollbackProbe = _buildSyntheticInputsForCameras(ggufPath, defaultCams, 0x2f6a1c93)
        const runProbe = async () =>
          (
            await model.run({
              images: rollbackProbe.images,
              imgWidth: IMAGE_SIZE,
              imgHeight: IMAGE_SIZE,
              state: rollbackProbe.state,
              tokens: rollbackProbe.tokens,
              mask: rollbackProbe.mask,
              noise: rollbackProbe.noise
            })
          ).await()

        const before = await runProbe()
        const resolved = path.resolve(ggufPath)
        const hidden = resolved + '.rollback-probe'
        let rollbackErr = null
        fs.renameSync(resolved, hidden)
        try {
          await model.setEmbodiment(DROID_EMBODIMENT_TAG)
        } catch (e) {
          rollbackErr = e
        } finally {
          fs.renameSync(hidden, resolved)
        }
        // Assert the REASON, not just that it threw: a switch rejected for any
        // other cause would make the rollback check below vacuous, since no row
        // read would have been attempted at all.
        t.ok(
          rollbackErr && /cannot reopen/.test(rollbackErr.message || ''),
          `switch rejected by the failed row re-read (got: ${rollbackErr && rollbackErr.message})`
        )
        // The file went missing — that is not a bad configuration, and telling
        // the caller it is would point them at the wrong problem (and invite an
        // SDK to retry a "bad config" forever).
        t.is(
          rollbackErr && rollbackErr.code,
          ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
          'an I/O failure mid-switch reports FAILED_TO_LOAD_WEIGHTS, not INVALID_CONFIG'
        )
        t.is(
          model.hparams.selectedEmbodimentTag,
          defaultTag,
          'failed switch leaves the reported embodiment unchanged'
        )
        t.is(model.hparams.numCameras, defaultCams, 'failed switch leaves numCameras unchanged')
        const after = await runProbe()
        t.is(after.actions.length, before.actions.length, 'action chunk length unchanged')
        let firstDiff = -1
        for (let i = 0; i < before.actions.length; i++) {
          if (before.actions[i] !== after.actions[i]) {
            firstDiff = i
            break
          }
        }
        t.is(
          firstDiff,
          -1,
          'actions are bit-identical after the failed switch, so the weights rolled back'
        )
      }
    } finally {
      await model.unload().catch(() => {})
    }
  }
)

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
