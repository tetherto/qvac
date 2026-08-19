'use strict'

// CosyVoice3 engine integration smoke: real synthesis in the desktop
// `run-integration-tests` lane.  Mirrors parler.test.js (download model → build
// TTSGgml → run → assert) but for the directory-consuming CosyVoice3 engine
// (Qwen2 speech LM + DiT flow + CausalHiFT vocoder; native 24 kHz, CPU-only).
// Text is kept SHORT to bound CPU LM-decode time in CI.

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const { loadCosyvoiceTTS, runCosyvoiceTTS } = require('../utils/runCosyvoiceTTS')
const { ensureCosyvoiceModel } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir() {
  return isMobile && global.testDir ? global.testDir : '.'
}

const MODEL_MISSING =
  'CosyVoice3 model files not available - registry fetch failed. Stage the ' +
  'cosy_voice/2026-07-23 files locally or run with registry access.'

test(
  'CosyVoice3 TTS (ggml): short synthesis returns 24 kHz audio + duration',
  { timeout: 600000 },
  async (t) => {
    const baseDir = getBaseDir()
    const download = await ensureCosyvoiceModel({
      targetDir: path.join(baseDir, 'models', 'cosyvoice3')
    })
    if (!download.success) {
      t.fail(MODEL_MISSING)
      return
    }

    const model = await loadCosyvoiceTTS({ cosyvoiceModelDir: download.modelDir })
    try {
      const text = 'Hello from CosyVoice.'
      const result = await runCosyvoiceTTS(
        model,
        { text },
        { minSamples: 1, minDurationMs: 1, maxDurationMs: 300000 }
      )
      console.log(result.output)

      t.ok(result.passed, 'cosyvoice synth passes expectations')
      t.ok(result.data.sampleCount > 0, 'cosyvoice produced audio (outputArray length > 0)')
      t.is(result.data.reportedSampleRate, 24000, 'cosyvoice reports 24 kHz native sample rate')
      t.ok(result.data.durationMs > 0, 'cosyvoice audio duration is > 0 ms')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'CosyVoice3 TTS (ggml): outputSampleRate=16000 resamples and reports 16 kHz',
  { timeout: 600000 },
  async (t) => {
    const baseDir = getBaseDir()
    const download = await ensureCosyvoiceModel({
      targetDir: path.join(baseDir, 'models', 'cosyvoice3')
    })
    if (!download.success) {
      t.fail(MODEL_MISSING)
      return
    }

    // Second model with outputSampleRate wired through the config surface, so the
    // whole resample path (engine → addon → reported chunk) is exercised end-to-end.
    const model = await loadCosyvoiceTTS({
      cosyvoiceModelDir: download.modelDir,
      outputSampleRate: 16000
    })
    try {
      const text = 'Hello from CosyVoice.'
      const result = await runCosyvoiceTTS(model, { text }, { minSamples: 1 })
      console.log(result.output)

      t.is(result.data.reportedSampleRate, 16000, 'outputSampleRate=16000 reported on the chunk')
      t.ok(result.data.sampleCount > 0, 'resampled synthesis produced audio')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

function samplesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

test(
  'CosyVoice3 TTS (ggml): emotion changes the audio; per-call switch needs no reload',
  { timeout: 900000 },
  async (t) => {
    const baseDir = getBaseDir()
    const download = await ensureCosyvoiceModel({
      targetDir: path.join(baseDir, 'models', 'cosyvoice3')
    })
    if (!download.success) {
      t.fail(MODEL_MISSING)
      return
    }

    // A fixed seed is what makes two runs comparable: the LM is chaotic in the
    // logits, and cosyvoice reseeds per synthesis, so pinning it is the
    // difference between measuring the conditioning and measuring the sampler.
    const model = await loadCosyvoiceTTS({
      cosyvoiceModelDir: download.modelDir,
      seed: 42
    })
    try {
      const text = 'Hello from CosyVoice.'
      const happy = await runCosyvoiceTTS(
        model,
        { text, perCallEmotion: 'happy' },
        { minSamples: 1 }
      )
      const sad = await runCosyvoiceTTS(model, { text, perCallEmotion: 'sad' }, { minSamples: 1 })
      t.ok(happy.passed && sad.passed, 'both per-call emotions synthesize')
      t.ok(
        !samplesEqual(happy.data.samples, sad.data.samples),
        'happy and sad produce different audio without a reload'
      )

      // Every cosyvoice emotion engages the instruct path, neutral included: it
      // carries its own "normal, flat tone" instruction rather than meaning
      // "unconditioned". Only pace moderate resolves to no instruction.
      const plain = await runCosyvoiceTTS(model, { text }, { minSamples: 1 })
      const neutral = await runCosyvoiceTTS(
        model,
        { text, perCallEmotion: 'neutral' },
        { minSamples: 1 }
      )
      t.ok(
        !samplesEqual(neutral.data.samples, plain.data.samples),
        'neutral engages the instruct path rather than falling through to zero-shot'
      )

      const moderate = await runCosyvoiceTTS(
        model,
        { text, perCallPace: 'moderate' },
        { minSamples: 1 }
      )
      t.ok(
        samplesEqual(moderate.data.samples, plain.data.samples),
        'pace moderate engages nothing, so it is the unconditioned zero-shot path'
      )

      const bad = await runCosyvoiceTTS(
        model,
        { text, perCallEmotion: 'surprise' },
        { minSamples: 1 }
      )
      t.absent(bad.passed, 'an emotion cosyvoice was not trained on is rejected')
      t.ok(
        /not supported by the cosyvoice3 engine/.test(bad.output),
        `the rejection names the engine set (got: ${bad.output})`
      )
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'CosyVoice3 TTS (ggml): instruct conditioning produces audio',
  { timeout: 600000 },
  async (t) => {
    const baseDir = getBaseDir()
    const download = await ensureCosyvoiceModel({
      targetDir: path.join(baseDir, 'models', 'cosyvoice3')
    })
    if (!download.success) {
      t.fail(MODEL_MISSING)
      return
    }

    const model = await loadCosyvoiceTTS({
      cosyvoiceModelDir: download.modelDir,
      emotion: 'happy'
    })
    try {
      const text = 'Hello from CosyVoice.'
      const result = await runCosyvoiceTTS(model, { text }, { minSamples: 1 })
      console.log(result.output)

      t.ok(result.passed, 'cosyvoice instruct synth passes expectations')
      t.ok(result.data.sampleCount > 0, 'cosyvoice instruct produced audio')
      t.is(result.data.reportedSampleRate, 24000, 'cosyvoice instruct reports 24 kHz')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)
