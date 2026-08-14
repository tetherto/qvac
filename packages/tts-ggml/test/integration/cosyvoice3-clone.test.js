'use strict'

// CosyVoice3 zero-shot / cross-lingual voice-cloning integration coverage.
// Mirrors cosyvoice3.test.js (download model -> build TTSGgml -> run ->
// assert) plus the cloning add-on tier, with the assertions tied to cloning
// actually happening rather than audio merely existing: sampling is seeded,
// so with one pinned seed and one shared text the baked, zero-shot and
// cross-lingual runs are each deterministic — a wrapper that silently kept
// the baked voice would reproduce the baked waveform exactly, and a mode
// regression would collapse zero-shot and cross-lingual into one trajectory.
// Both are asserted as pairwise waveform inequality.  Fail-closed is covered
// on both layers: the JS consistency assert (no way to resolve the cloning
// GGUFs) and the native load (base model dir present, cloning GGUFs absent).
// Text is kept SHORT to bound CPU LM-decode time in CI.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

const { loadCosyvoiceTTS, runCosyvoiceTTS } = require('../utils/runCosyvoiceTTS')
const { ensureCosyvoiceModel, ensureCosyvoiceCloneModels } = require('../utils/downloadModel')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir() {
  return isMobile && global.testDir ? global.testDir : '.'
}

const MODEL_MISSING =
  'CosyVoice3 model files not available - registry fetch failed. Stage the ' +
  'cosy_voice/2026-07-23 files locally or run with registry access.'
const CLONE_MODELS_MISSING =
  'CosyVoice3 cloning GGUFs not available - registry fetch failed. Stage the ' +
  'cosy_voice/2026-08-14 s3tok + campplus files locally or run with registry access.'

// jfk.wav (11 s English) is the repo's canonical cloning reference; its
// verbatim transcript makes the zero-shot leg faithful to the contract.
const JFK_TRANSCRIPT =
  'And so my fellow Americans ask not what your country can do for you, ' +
  'ask what you can do for your country.'

// One text + one seed across the baked / zero-shot / cross-lingual runs, so
// the pairwise comparisons isolate the conditioning rather than the sampler.
const CLONE_TEXT = 'Cloning now runs fully on device.'
const CLONE_SEED = 1986

async function ensureCloneReadyModelDir(t) {
  const baseDir = getBaseDir()
  const targetDir = path.join(baseDir, 'models', 'cosyvoice3')
  const base = await ensureCosyvoiceModel({ targetDir })
  if (!base.success) {
    t.fail(MODEL_MISSING)
    return null
  }
  const clone = await ensureCosyvoiceCloneModels({ targetDir: base.modelDir })
  if (!clone.success) {
    t.fail(CLONE_MODELS_MISSING)
    return null
  }
  return clone.modelDir
}

function samplesDiffer(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true
  }
  return false
}

async function synthOnce(t, loadParams, label) {
  const model = await loadCosyvoiceTTS({ ...loadParams, seed: CLONE_SEED })
  try {
    const result = await runCosyvoiceTTS(
      model,
      { text: CLONE_TEXT },
      { minSamples: 1, minDurationMs: 1, maxDurationMs: 300000 }
    )
    console.log(result.output)
    t.ok(result.passed, `${label} synth passes expectations`)
    t.ok(result.data.sampleCount > 0, `${label} produced audio`)
    return result.data
  } finally {
    try {
      await model.unload()
    } catch (_e) {}
  }
}

// Captured by the zero-shot test, compared against by the cross-lingual test
// (brittle runs the file's tests sequentially).
let zeroShotSamples = null

test(
  'CosyVoice3 cloning (ggml): zero-shot differs from the baked voice at the same seed',
  { timeout: 900000 },
  async (t) => {
    const modelDir = await ensureCloneReadyModelDir(t)
    if (!modelDir) return

    const baked = await synthOnce(t, { cosyvoiceModelDir: modelDir }, 'baked baseline')
    const cloned = await synthOnce(
      t,
      {
        cosyvoiceModelDir: modelDir,
        referenceAudio: resolveRefWavPath({}),
        promptText: JFK_TRANSCRIPT
      },
      'zero-shot clone'
    )
    t.is(cloned.reportedSampleRate, 24000, 'clone reports 24 kHz native rate')
    t.ok(
      samplesDiffer(baked.samples, cloned.samples),
      'zero-shot clone diverges from the baked voice (same text + seed), so the ' +
        'reference conditioning demonstrably reached the engine'
    )
    zeroShotSamples = cloned.samples
  }
)

test(
  'CosyVoice3 cloning (ggml): cross-lingual differs from zero-shot at the same seed',
  { timeout: 900000 },
  async (t) => {
    const modelDir = await ensureCloneReadyModelDir(t)
    if (!modelDir) return

    const xl = await synthOnce(
      t,
      { cosyvoiceModelDir: modelDir, referenceAudio: resolveRefWavPath({}) },
      'cross-lingual clone'
    )
    if (!zeroShotSamples) {
      t.fail('zero-shot baseline unavailable (previous test did not complete)')
      return
    }
    t.ok(
      samplesDiffer(zeroShotSamples, xl.samples),
      'cross-lingual diverges from zero-shot (same text + seed + reference), so ' +
        'the transcript-selected mode demonstrably changed the LM prompt'
    )
  }
)

test(
  'CosyVoice3 cloning (ggml): referenceAudio without cloning models fails the construction',
  { timeout: 60000 },
  async (t) => {
    // No model dir and no s3tok/campplus paths: the JS-level consistency
    // assert must reject the clone request before any native work starts.
    t.exception(
      () =>
        new TTSGgml({
          engine: TTSGgml.ENGINE_COSYVOICE3,
          referenceAudio: resolveRefWavPath({}),
          files: {
            cosyvoiceLlmModel: '/nonexistent/llm.gguf',
            cosyvoiceFlowModel: '/nonexistent/flow.gguf',
            cosyvoiceHiftModel: '/nonexistent/hift.gguf'
          }
        }),
      /cosyvoiceS3tokModel/,
      'clone request without s3tok/campplus models throws with an actionable message'
    )
  }
)

test(
  'CosyVoice3 cloning (ggml): base-only model dir fails the native load, not silently',
  { timeout: 600000 },
  async (t) => {
    // The JS assert is satisfied by a model dir alone; the documented
    // fail-closed contract then belongs to the native side.  A directory
    // holding the full base set but neither cloning GGUF must reject load()
    // rather than fall back to the baked voice.
    const modelDir = await ensureCloneReadyModelDir(t)
    if (!modelDir) return

    const baseOnlyDir = path.join(getBaseDir(), 'models', 'cosyvoice3-base-only')
    fs.mkdirSync(baseOnlyDir, { recursive: true })
    const baseFiles = [
      'cosyvoice3-llm-q8_0.gguf',
      'cosyvoice3-flow-f32.gguf',
      'cosyvoice3-hift-f32.gguf',
      'voice.gguf',
      'vocab.json',
      'merges.txt'
    ]
    for (const name of baseFiles) {
      const dst = path.join(baseOnlyDir, name)
      if (!fs.existsSync(dst)) {
        // Hard links keep this free even for the multi-GB GGUFs (same volume).
        fs.linkSync(path.join(modelDir, name), dst)
      }
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_COSYVOICE3,
      files: { cosyvoiceModelDir: baseOnlyDir },
      referenceAudio: resolveRefWavPath({})
    })
    await t.exception(
      model.load(),
      /s3tok/i,
      'native load rejects a clone request when the model dir lacks the cloning GGUFs'
    )
  }
)
