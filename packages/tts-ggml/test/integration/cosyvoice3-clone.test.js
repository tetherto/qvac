'use strict'

// CosyVoice3 zero-shot / cross-lingual voice-cloning integration smoke.
// Mirrors cosyvoice3.test.js (download model -> build TTSGgml -> run ->
// assert) plus the cloning add-on tier: the reference wav is baked into the
// voice at load by the native front-end (speech_tokenizer_v3 + CAM++ +
// prompt mel), promptText selects zero-shot vs cross-lingual, and a clone
// request without the add-on GGUFs must fail the construction loudly rather
// than silently using the baked voice.  Text is kept SHORT to bound CPU
// LM-decode time in CI.

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
  'cosy_voice/2026-08-13 s3tok + campplus files locally or run with registry access.'

// jfk.wav (11 s English) is the repo's canonical cloning reference; its
// verbatim transcript makes the zero-shot leg faithful to the contract.
const JFK_TRANSCRIPT =
  'And so my fellow Americans ask not what your country can do for you, ' +
  'ask what you can do for your country.'

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

test(
  'CosyVoice3 cloning (ggml): zero-shot (reference + transcript) synthesizes',
  { timeout: 900000 },
  async (t) => {
    const modelDir = await ensureCloneReadyModelDir(t)
    if (!modelDir) return

    const model = await loadCosyvoiceTTS({
      cosyvoiceModelDir: modelDir,
      referenceAudio: resolveRefWavPath({}),
      promptText: JFK_TRANSCRIPT
    })
    try {
      const result = await runCosyvoiceTTS(
        model,
        { text: 'Cloning now runs fully on device.' },
        { minSamples: 1, minDurationMs: 1, maxDurationMs: 300000 }
      )
      console.log(result.output)

      t.ok(result.passed, 'zero-shot cloned synth passes expectations')
      t.ok(result.data.sampleCount > 0, 'zero-shot clone produced audio')
      t.is(result.data.reportedSampleRate, 24000, 'clone reports 24 kHz native rate')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'CosyVoice3 cloning (ggml): cross-lingual (reference only, no transcript) synthesizes',
  { timeout: 900000 },
  async (t) => {
    const modelDir = await ensureCloneReadyModelDir(t)
    if (!modelDir) return

    const model = await loadCosyvoiceTTS({
      cosyvoiceModelDir: modelDir,
      referenceAudio: resolveRefWavPath({})
    })
    try {
      const result = await runCosyvoiceTTS(
        model,
        { text: '今天天气真不错。' },
        { minSamples: 1, minDurationMs: 1, maxDurationMs: 300000 }
      )
      console.log(result.output)

      t.ok(result.passed, 'cross-lingual cloned synth passes expectations')
      t.ok(result.data.sampleCount > 0, 'cross-lingual clone produced audio')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
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
