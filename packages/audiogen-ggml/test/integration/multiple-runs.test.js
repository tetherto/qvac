'use strict'

// Lifecycle / stability suite for @qvac/audiogen-ggml, mirroring
// tts-ggml/test/integration/multiple-runs.test.js. Three concerns:
//   1. N back-to-back run() on the SAME loaded instance (engine reuse).
//   2. A fresh instance per run (app-restart simulation).
//   3. unload() + load() between runs (reload) preserves stability.
// Durations are kept short to bound wall-clock across the CI matrix.

const test = require('brittle')
const path = require('bare-path')
const { ensureAudiogenModels, getBaseDir } = require('../utils/downloadModel')
const {
  loadAudioGen,
  runAudioGen,
  NO_GPU,
  INTEGRATION_TIMEOUT_MS
} = require('../utils/runAudioGen')

const VARIANT = 'turbo-q4'
const CAPTIONS = [
  'upbeat synthwave, driving bass, neon night drive',
  'calm acoustic guitar, soft pads, morning coffee'
]

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

function shortRun(gen, caption) {
  return runAudioGen(gen, { caption, opts: { lyrics: '[Instrumental]', duration: 6, seed: 1 } })
}

test(
  'multiple sequential runs reuse the same engine instance',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail('ACE-Step models unavailable — run `npm run download-models:registry`.')
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: !NO_GPU
    })
    t.teardown(() => gen.destroy())

    for (const caption of CAPTIONS) {
      const { data } = await shortRun(gen, caption)
      t.ok(data.sampleCount > 0, `run produced audio: "${caption}"`)
      t.ok(typeof data.stats.realTimeFactor === 'number', 'run reported stats')
    }
  }
)

test(
  'fresh instance per run (app-restart simulation)',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail('ACE-Step models unavailable — run `npm run download-models:registry`.')
      return
    }

    for (const caption of CAPTIONS) {
      const gen = await loadAudioGen({
        modelDir: download.modelDir,
        ditVariant: VARIANT,
        useGPU: !NO_GPU
      })
      try {
        const { data } = await shortRun(gen, caption)
        t.ok(data.sampleCount > 0, `fresh instance produced audio: "${caption}"`)
      } finally {
        await gen.destroy()
      }
    }
  }
)

test(
  'unload() + load() between runs preserves stability',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail('ACE-Step models unavailable — run `npm run download-models:registry`.')
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: !NO_GPU
    })
    t.teardown(() => gen.destroy())

    const first = await shortRun(gen, CAPTIONS[0])
    t.ok(first.data.sampleCount > 0, 'first run produced audio')

    await gen.unload()
    await gen.load()

    const second = await shortRun(gen, CAPTIONS[1])
    t.ok(second.data.sampleCount > 0, 'run after reload produced audio')
  }
)
