'use strict'

// Output-sample-rate selection: a requested outputSampleRate is honored
// end-to-end and reported on the output chunk. The construct-time CosyVoice3
// test needs no models; the model-backed ones are gated on the Supertonic /
// Parler GGUFs plus a tts-cpp build that supports
// EngineOptions::output_sample_rate (PR #69), and skip/fail cleanly otherwise.

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

const { ensureSupertonicModel, ensureParlerModel } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir() {
  return isMobile && global.testDir ? global.testDir : '.'
}

async function collect(model, text) {
  let samples = 0
  let sampleRate = null
  const response = await model.run({ input: text, type: 'text' })
  await response
    .onUpdate((d) => {
      if (d && d.outputArray) samples += d.outputArray.length
      if (d && d.sampleRate) sampleRate = d.sampleRate
    })
    .await()
  return { samples, sampleRate }
}

// CosyVoice3 native chunk streaming emits at its native 24 kHz, so the addon
// rejects a different outputSampleRate there unless the LavaSR enhancer is on:
// the enhancer's overlap-reprocess window resamples without leaving chunk
// seams. That decision lives in CosyvoiceModel::validateConfig; this pins the
// JS half, which must forward the combination rather than reject it up front.
test('CosyVoice3: enhancer + streaming forwards a non-native outputSampleRate', (t) => {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_COSYVOICE3,
    files: {
      cosyvoiceModelDir: './models/cosyvoice3',
      lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
    },
    streamChunkTokens: 25,
    config: { language: 'en', outputSampleRate: 16000 }
  })
  const params = model._buildTtsParams()
  t.is(params.outputSampleRate, 16000, 'requested rate forwarded')
  t.is(params.streamChunkTokens, 25, 'streaming still requested')
  t.is(
    params.lavasrEnhancerPath,
    './models/lavasr/lavasr-enhancer.gguf',
    'enhancer forwarded — it is what makes the rate valid while streaming'
  )
})

test(
  'Supertonic: outputSampleRate=16000 resamples and reports 16 kHz',
  { timeout: 600000 },
  async (t) => {
    const baseDir = getBaseDir()
    const dl = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Supertonic GGUF not available — registry fetch failed.')
      return
    }

    const text = 'Output rate selection resamples the synthesized audio.'

    const native = new TTSGgml({
      engine: TTSGgml.ENGINE_SUPERTONIC,
      files: { supertonicModel: dl.path },
      voice: 'F1',
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    await native.load()
    let nativeSamples
    try {
      const r = await collect(native, text)
      t.is(r.sampleRate, 44100, 'native Supertonic reports 44.1 kHz')
      nativeSamples = r.samples
    } finally {
      try {
        await native.unload()
      } catch (_e) {}
    }

    const resampled = new TTSGgml({
      engine: TTSGgml.ENGINE_SUPERTONIC,
      files: { supertonicModel: dl.path },
      voice: 'F1',
      config: { language: 'en', useGPU: false, outputSampleRate: 16000 },
      opts: { stats: true }
    })
    await resampled.load()
    try {
      const r = await collect(resampled, text)
      t.is(r.sampleRate, 16000, 'outputSampleRate=16000 reported on the chunk')
      t.ok(r.samples > 0, 'resampled synthesis produced audio')
      // 16 kHz is ~36% of 44.1 kHz, so the resampled stream is materially shorter.
      if (nativeSamples) {
        t.ok(
          r.samples < nativeSamples * 0.6,
          `resampled sample count (${r.samples}) well below native (${nativeSamples})`
        )
      }
    } finally {
      try {
        await resampled.unload()
      } catch (_e) {}
    }
  }
)

test(
  'Parler: outputSampleRate=16000 resamples and reports 16 kHz',
  { timeout: 600000 },
  async (t) => {
    const baseDir = getBaseDir()
    const dl = await ensureParlerModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Parler GGUF not available — registry fetch failed.')
      return
    }

    const text = 'Output rate selection resamples the synthesized audio.'

    const native = new TTSGgml({
      engine: TTSGgml.ENGINE_PARLER,
      files: { parlerModel: dl.path },
      voice: 'Laura',
      seed: 42,
      opts: { stats: true }
    })
    await native.load()
    let nativeSamples
    try {
      const r = await collect(native, text)
      t.is(r.sampleRate, 44100, 'native Parler reports 44.1 kHz')
      nativeSamples = r.samples
    } finally {
      try {
        await native.unload()
      } catch (_e) {}
    }

    const resampled = new TTSGgml({
      engine: TTSGgml.ENGINE_PARLER,
      files: { parlerModel: dl.path },
      voice: 'Laura',
      seed: 42,
      config: { outputSampleRate: 16000 },
      opts: { stats: true }
    })
    await resampled.load()
    try {
      const r = await collect(resampled, text)
      t.is(r.sampleRate, 16000, 'outputSampleRate=16000 reported on the chunk')
      t.ok(r.samples > 0, 'resampled synthesis produced audio')
      // Same fixed seed => same generation; 16 kHz is ~36% of 44.1 kHz.
      if (nativeSamples) {
        t.ok(
          r.samples < nativeSamples * 0.6,
          `resampled sample count (${r.samples}) well below native (${nativeSamples})`
        )
      }
    } finally {
      try {
        await resampled.unload()
      } catch (_e) {}
    }
  }
)
