'use strict'

// Sampling is seeded, so one pinned seed and one shared text make the baked,
// zero-shot and cross-lingual runs individually deterministic: all three
// waveforms must differ pairwise, which no silently-ignored reference or
// collapsed mode can satisfy.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

const { loadCosyvoiceTTS, runCosyvoiceTTS } = require('../utils/runCosyvoiceTTS')
const {
  ensureCosyvoiceModel,
  ensureCosyvoiceCloneModels,
  cosyvoiceBaseFileNames
} = require('../utils/downloadModel')
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

const JFK_TRANSCRIPT =
  'And so my fellow Americans ask not what your country can do for you, ' +
  'ask what you can do for your country.'

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

test(
  'CosyVoice3 cloning (ggml): baked, zero-shot and cross-lingual all differ at one seed',
  { timeout: 1800000 },
  async (t) => {
    const modelDir = await ensureCloneReadyModelDir(t)
    if (!modelDir) return

    const refWav = resolveRefWavPath({})
    const baked = await synthOnce(t, { cosyvoiceModelDir: modelDir }, 'baked baseline')
    const zeroShot = await synthOnce(
      t,
      { cosyvoiceModelDir: modelDir, referenceAudio: refWav, promptText: JFK_TRANSCRIPT },
      'zero-shot clone'
    )
    const crossLingual = await synthOnce(
      t,
      { cosyvoiceModelDir: modelDir, referenceAudio: refWav },
      'cross-lingual clone'
    )

    t.is(zeroShot.reportedSampleRate, 24000, 'clone reports 24 kHz native rate')
    t.ok(
      samplesDiffer(baked.samples, zeroShot.samples),
      'zero-shot differs from the baked voice, so its reference conditioning reached the engine'
    )
    t.ok(
      samplesDiffer(baked.samples, crossLingual.samples),
      'cross-lingual differs from the baked voice, so its reference conditioning reached the engine'
    )
    t.ok(
      samplesDiffer(zeroShot.samples, crossLingual.samples),
      'zero-shot differs from cross-lingual, so the transcript selected a different LM prompt'
    )
  }
)

test(
  'CosyVoice3 cloning (ggml): referenceAudio without cloning models fails the construction',
  { timeout: 60000 },
  async (t) => {
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
    const modelDir = await ensureCloneReadyModelDir(t)
    if (!modelDir) return

    const baseOnlyDir = path.join(getBaseDir(), 'models', 'cosyvoice3-base-only')
    fs.mkdirSync(baseOnlyDir, { recursive: true })
    for (const name of cosyvoiceBaseFileNames()) {
      const src = path.join(modelDir, name)
      const dst = path.join(baseOnlyDir, name)
      if (fs.existsSync(dst)) continue
      if (!fs.existsSync(src)) {
        t.fail(`staged model dir is missing ${name}`)
        return
      }
      try {
        // Free for the multi-GB GGUFs, but only within one filesystem.
        fs.linkSync(src, dst)
      } catch (_e) {
        fs.copyFileSync(src, dst)
      }
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_COSYVOICE3,
      files: { cosyvoiceModelDir: baseOnlyDir },
      referenceAudio: resolveRefWavPath({})
    })
    try {
      await t.exception(
        model.load(),
        /s3tok/i,
        'native load rejects a clone request when the model dir lacks the cloning GGUFs'
      )
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)
