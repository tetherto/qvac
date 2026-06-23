'use strict'

// Integration coverage for the Chatterbox `speed` configuration (QVAC-21119):
// drives the real GGUF engine through the JS addon and checks that the knob
// adjusts output duration as documented while staying backward compatible
// (unset == 1.0 == raw model output, no default slowdown).

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')

const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')

function getBaseDir () {
  const platform = os.platform()
  const isMobile = platform === 'ios' || platform === 'android'
  return isMobile && global.testDir ? global.testDir : '.'
}

const TEXT = 'The quick brown fox jumps over the lazy dog near the river bank.'

const EXPECTATION = {
  minSamples: 5000,
  maxSamples: 5000000,
  minDurationMs: 200,
  maxDurationMs: 300000
}

test('Chatterbox TTS (ggml): speed config adjusts duration, preserves backward compat', { timeout: 1800000 }, async (t) => {
  const modelsDir = path.join(getBaseDir(), 'models')

  const download = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!download.success) {
    t.fail('Chatterbox GGUFs not available - run `npm run download-models:registry -- --group chatterbox`.')
    return
  }
  const modelDir = download.targetDir

  // Synthesize the same text at a given speed and return the sample count.
  // A fixed seed (engine default) makes the un-stretched base deterministic
  // across loads, so the only difference between runs is the speed knob.
  async function sampleCountAt (speed) {
    const label = speed === undefined ? 'default' : String(speed)
    const model = await loadChatterboxTTS({ modelDir, language: 'en', speed })
    try {
      const r = await runChatterboxTTS(model, { text: TEXT }, EXPECTATION)
      t.ok(r.passed, `speed=${label}: passes synthesis expectations`)
      t.ok(r.data.sampleCount > 0, `speed=${label}: produces audio samples`)
      t.is(r.data.reportedSampleRate, 24000, `speed=${label}: native 24 kHz`)
      return r.data.sampleCount
    } finally {
      await model.unload()
    }
  }

  // Backward compatibility: omitting `speed` must equal speed:1.0 (the raw
  // model output) — the addon applies no default slowdown.
  const defaultSamples = await sampleCountAt(undefined)
  const rawSamples = await sampleCountAt(1.0)
  t.is(defaultSamples, rawSamples, 'omitting speed == speed:1.0 (no default rate change)')

  // speed < 1 slows speech down -> proportionally longer audio (~1/speed).
  const slowSamples = await sampleCountAt(0.5)
  const ratio = slowSamples / rawSamples
  t.comment(`speed 0.5 / 1.0 sample-count ratio = ${ratio.toFixed(3)} (expect ~2.0)`)
  t.ok(ratio > 1.8 && ratio < 2.2, `speed 0.5 yields ~2x the samples of 1.0 (got ${ratio.toFixed(3)})`)

  // speed > 1 speeds speech up -> shorter audio.
  const fastSamples = await sampleCountAt(1.5)
  t.ok(fastSamples < rawSamples, `speed 1.5 yields fewer samples than 1.0 (${fastSamples} < ${rawSamples})`)
})

test('Chatterbox TTS (ggml): out-of-range speed is rejected', { timeout: 600000 }, async (t) => {
  const modelsDir = path.join(getBaseDir(), 'models')
  const download = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!download.success) {
    t.fail('Chatterbox GGUFs not available.')
    return
  }

  // `speed` is bounded to [0.25, 4.0] by ChatterboxModel::validateConfig,
  // which runs at load time and surfaces as a rejected load.
  await t.exception(
    loadChatterboxTTS({ modelDir: download.targetDir, language: 'en', speed: 5 }),
    'speed=5 (> 4.0) is rejected at load'
  )
})
