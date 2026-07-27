'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const proc = require('bare-process')
const { LamAudio2Expression } = require('../../index')

// ---------------------------------------------------------------------------
// LAM audio2expression — structural invariants and wiring checks.
//
// These run against ANY `lam-audio2exp` GGUF, including the sub-megabyte
// random-weight model from `scripts/make-tiny-lam-a2e-gguf.py`. That is the
// point: none of the assertions below depend on the weights being trained, so
// this tier is cheap enough to run on every PR without hosting the 390MB
// checkpoint.
//
// What this CANNOT tell you: whether the coefficients are numerically right.
// Random weights produce well-formed nonsense. Proving the math matches the
// PyTorch reference is the parity harness in qvac-ext-stable-diffusion.cpp
// (`lam-a2e-parity`), which needs the real checkpoint and dumped activations.
//
//   python scripts/make-tiny-lam-a2e-gguf.py --out /tmp/lam-a2e-tiny.gguf
//   LAM_A2E_GGUF=/tmp/lam-a2e-tiny.gguf npm run test:integration
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000
const FPS = 30
const N_COEFFS = 52

// `lam-audio2exp.n_identity` — the engine rejects identityIndex >= this. Both
// the tiny model and the real checkpoint declare 12.
const N_IDENTITY = 12

const JOB_TIMEOUT_MS = 120_000

const MODEL_PATH = proc.env.LAM_A2E_GGUF || ''
const skipNoModel =
  MODEL_PATH && fs.existsSync(MODEL_PATH)
    ? false
    : 'no LAM-A2E GGUF; set LAM_A2E_GGUF (see scripts/make-tiny-lam-a2e-gguf.py)'

// Mirrors LamAudio2Expression::frameCount in the engine.
function expectedFrameCount(sampleCount) {
  return Math.ceil((sampleCount * FPS) / SAMPLE_RATE)
}

function tone(seconds, hz = 220) {
  const pcm = new Float32Array(Math.round(SAMPLE_RATE * seconds))
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = 0.2 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
  }
  return pcm
}

function silence(seconds) {
  return new Float32Array(Math.round(SAMPLE_RATE * seconds))
}

async function collectFrames(a2e, pcm, options) {
  const response = await a2e.run(pcm, { sampleRate: SAMPLE_RATE, ...options })
  let frames = []
  await response
    .onUpdate((data) => {
      if (typeof data !== 'string') return
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed.frames)) frames = parsed.frames
    })
    .await()
  return frames
}

// One load per test keeps failures isolated; the tiny model loads in
// milliseconds, so sharing an instance would buy little.
async function withModel(fn) {
  const a2e = new LamAudio2Expression({
    files: { model: MODEL_PATH },
    config: { identityIndex: 0 }
  })
  await a2e.load()
  try {
    return await fn(a2e)
  } finally {
    await a2e.unload()
  }
}

// ---------- Layer 2: structural invariants ----------

test(
  'LAM-A2E | frame count is ceil(samples * fps / sampleRate)',
  { skip: skipNoModel, timeout: JOB_TIMEOUT_MS },
  async (t) => {
    await withModel(async (a2e) => {
      for (const seconds of [2, 3.5]) {
        const pcm = tone(seconds)
        const frames = await collectFrames(a2e, pcm)
        t.is(
          frames.length,
          expectedFrameCount(pcm.length),
          `${seconds}s of audio yields ${expectedFrameCount(pcm.length)} frames`
        )
      }
    })
  }
)

test(
  'LAM-A2E | every frame carries exactly 52 finite coefficients',
  { skip: skipNoModel, timeout: JOB_TIMEOUT_MS },
  async (t) => {
    await withModel(async (a2e) => {
      const frames = await collectFrames(a2e, tone(2))
      t.ok(frames.length > 0, 'produced at least one frame')

      const wrongWidth = frames.findIndex((f) => f.arkit52?.length !== N_COEFFS)
      t.is(wrongWidth, -1, 'no frame has a coefficient count other than 52')

      const nonFinite = frames.findIndex((f) => f.arkit52.some((v) => !Number.isFinite(v)))
      t.is(nonFinite, -1, 'no frame contains NaN or Infinity')
    })
  }
)

test(
  'LAM-A2E | coefficients are sigmoid-bounded to [0, 1]',
  { skip: skipNoModel, timeout: JOB_TIMEOUT_MS },
  async (t) => {
    // The graph ends in ggml_sigmoid, so this holds for any weights at all.
    // A value outside the range means the output tensor was misread.
    await withModel(async (a2e) => {
      const frames = await collectFrames(a2e, tone(2))
      const outOfRange = frames.findIndex((f) => f.arkit52.some((v) => v < 0 || v > 1))
      t.is(outOfRange, -1, 'every coefficient lies in [0, 1]')
    })
  }
)

test(
  'LAM-A2E | timestamps start at zero and advance one frame period',
  { skip: skipNoModel, timeout: JOB_TIMEOUT_MS },
  async (t) => {
    await withModel(async (a2e) => {
      const frames = await collectFrames(a2e, tone(2))
      t.is(frames[0].timestampUs, 0, 'first frame is at t=0')

      const expectedLast = Math.floor(((frames.length - 1) * 1_000_000) / FPS)
      t.is(frames[frames.length - 1].timestampUs, expectedLast, 'last timestamp matches 30fps')

      const nonMonotonic = frames.findIndex(
        (f, i) => i > 0 && f.timestampUs <= frames[i - 1].timestampUs
      )
      t.is(nonMonotonic, -1, 'timestamps strictly increase')
    })
  }
)

test(
  'LAM-A2E | repeated runs on the same input are deterministic',
  { skip: skipNoModel, timeout: JOB_TIMEOUT_MS },
  async (t) => {
    await withModel(async (a2e) => {
      const pcm = tone(2)
      const first = await collectFrames(a2e, pcm)
      const second = await collectFrames(a2e, pcm)

      t.is(first.length, second.length, 'same frame count')
      t.alike(first[0].arkit52, second[0].arkit52, 'first frame is bit-identical')
      t.alike(
        first[first.length - 1].arkit52,
        second[second.length - 1].arkit52,
        'last frame is bit-identical'
      )
    })
  }
)

test(
  'LAM-A2E | audio shorter than two frames is rejected',
  { skip: skipNoModel, timeout: JOB_TIMEOUT_MS },
  async (t) => {
    // The engine needs at least 2 output frames and 2 conv timesteps; the
    // feature extractor decimates by 320, so a 100-sample buffer has neither.
    await withModel(async (a2e) => {
      await t.exception(
        () => collectFrames(a2e, new Float32Array(100)),
        /too short|invalid|failed/i,
        'rejects a buffer below the minimum window'
      )
    })
  }
)

// ---------- Layer 3: wiring / behaviour ----------
//
// With random weights these prove that an input is actually reaching the
// graph and changing the result — not that the result means anything. Semantic
// checks (jawOpen tracking speech energy) need the real checkpoint and belong
// with the parity tier.

test(
  'LAM-A2E | different identityIndex produces different coefficients',
  { skip: skipNoModel, timeout: JOB_TIMEOUT_MS },
  async (t) => {
    await withModel(async (a2e) => {
      const pcm = tone(2)
      const id0 = await collectFrames(a2e, pcm, { identityIndex: 0 })
      const id1 = await collectFrames(a2e, pcm, { identityIndex: 1 })

      t.is(id0.length, id1.length, 'identity does not change frame count')
      t.unlike(id0[0].arkit52, id1[0].arkit52, 'identity embedding reaches the head')
    })
  }
)

test(
  'LAM-A2E | different audio produces different coefficients',
  { skip: skipNoModel, timeout: JOB_TIMEOUT_MS },
  async (t) => {
    await withModel(async (a2e) => {
      const seconds = 2
      const withTone = await collectFrames(a2e, tone(seconds))
      const withSilence = await collectFrames(a2e, silence(seconds))

      t.is(withTone.length, withSilence.length, 'same duration yields same frame count')
      t.unlike(withTone[0].arkit52, withSilence[0].arkit52, 'audio reaches the graph')
    })
  }
)

test(
  'LAM-A2E | identityIndex beyond n_identity is rejected',
  { skip: skipNoModel, timeout: JOB_TIMEOUT_MS },
  async (t) => {
    await withModel(async (a2e) => {
      await t.exception(
        () => collectFrames(a2e, tone(2), { identityIndex: N_IDENTITY }),
        /identity|range|invalid|failed/i,
        `rejects identityIndex ${N_IDENTITY} (valid range is 0..${N_IDENTITY - 1})`
      )
    })
  }
)
