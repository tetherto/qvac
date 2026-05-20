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
const process = require('bare-process')
const { VlaModel } = require('../..')

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

  const tokens = fixture.get('fixture.tokens')           // Int32Array(200)
  const mask = fixture.get('fixture.mask')               // Uint8Array(200) (bool-packed)
  const noise = fixture.get('fixture.noise')             // Float32Array(50*32)
  const expected = activations.get('ode.actions_final')  // Float32Array(50*32)

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

  // ── Compare against PyTorch ────────────────────────────────────────────
  const cos = cosineSim(result.actions, expected)
  const diff = maxAbsDiff(result.actions, expected)
  const max = maxAbs(expected)
  const rel = diff / Math.max(max, 1e-9)
  t.comment(`actions: cos=${cos.toFixed(6)} max_abs_diff=${diff.toFixed(6)} rel_max=${rel.toFixed(6)} max_abs_expected=${max.toFixed(4)}`)

  // Plan §5 end-to-end CPU bar: cos > 0.999. Relaxed abs-diff bar (5 %
  // relative) tracks the same F16-noise-accumulation pattern the C++
  // integration test sees. Direction parity is the meaningful signal.
  t.ok(cos > 0.999, `cos sim ${cos} > 0.999`)
  t.ok(rel < 0.05, `rel max diff ${rel} < 0.05`)

  await model.unload()
})
