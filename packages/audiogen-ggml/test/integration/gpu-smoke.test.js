'use strict'

// GPU / CPU backend smoke for @qvac/audiogen-ggml.
//
// LIMITATION vs tts-ggml's gpu-smoke: audiogen's native run stats expose only
// totalTimeMs / realTimeFactor / audioDurationMs — there is NO
// backendDevice / backendId field — so this suite can only assert that a
// GPU-requested run completes and produces audio, NOT which backend actually
// executed. The GPU leg is skipped under NO_GPU (CPU-only matrix entries); the
// CPU leg runs everywhere and asserts the useGPU:false path still generates.

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

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

test(
  'GPU smoke: useGPU generation produces audio',
  { timeout: INTEGRATION_TIMEOUT_MS, skip: NO_GPU },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail('ACE-Step models unavailable — run `npm run download-models:registry`.')
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: true
    })
    t.teardown(() => gen.destroy())

    const { data } = await runAudioGen(gen, {
      caption: 'cinematic orchestral, epic drums, rising strings',
      opts: { lyrics: '[Instrumental]', duration: 6, seed: 3 }
    })

    t.ok(data.sampleCount > 0, `GPU run produced ${data.sampleCount} samples`)
    t.is(data.channels, 2, 'stereo output')
  }
)

test(
  'CPU contract: useGPU:false generation produces audio',
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
      useGPU: false
    })
    t.teardown(() => gen.destroy())

    const { data } = await runAudioGen(gen, {
      caption: 'simple solo piano melody, sparse and gentle',
      opts: { lyrics: '[Instrumental]', duration: 6, seed: 4 }
    })

    t.ok(data.sampleCount > 0, `CPU run produced ${data.sampleCount} samples`)
  }
)
