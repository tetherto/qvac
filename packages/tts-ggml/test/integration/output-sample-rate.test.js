'use strict'

// Output-sample-rate selection: a requested outputSampleRate is honored
// end-to-end and reported on the output chunk. Gated on the Supertonic GGUF +
// a tts-cpp build that supports EngineOptions::output_sample_rate (PR #69);
// skips/fails cleanly otherwise.

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

const { ensureSupertonicModel } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

async function collect (model, text) {
  let samples = 0
  let sampleRate = null
  const response = await model.run({ input: text, type: 'text' })
  await response
    .onUpdate(d => {
      if (d && d.outputArray) samples += d.outputArray.length
      if (d && d.sampleRate) sampleRate = d.sampleRate
    })
    .await()
  return { samples, sampleRate }
}

test('Supertonic: outputSampleRate=16000 resamples and reports 16 kHz', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const dl = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!dl.success) { t.fail('Supertonic GGUF not available — registry fetch failed.'); return }

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
  } finally { try { await native.unload() } catch (_e) {} }

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
      t.ok(r.samples < nativeSamples * 0.6,
        `resampled sample count (${r.samples}) well below native (${nativeSamples})`)
    }
  } finally { try { await resampled.unload() } catch (_e) {} }
})
