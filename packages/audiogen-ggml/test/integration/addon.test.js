'use strict'

// End-to-end desktop integration tests for @qvac/audiogen-ggml: download the
// ACE-Step GGUFs from the registry, load the native engine, generate music, and
// assert on the streamed PCM + progress + stats. Needs the native prebuild and
// the (multi-GB) models on disk, so CI provisions both before running this;
// locally, run `npm run download-models:registry` first.

const test = require('brittle')
const path = require('bare-path')
const { ensureAudiogenModels, getBaseDir } = require('../utils/downloadModel')
const {
  loadAudioGen,
  runAudioGen,
  NO_GPU,
  INTEGRATION_TIMEOUT_MS
} = require('../utils/runAudioGen')
const { AudioGen } = require('@qvac/audiogen-ggml')

const VARIANT = 'turbo-q4'

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

test(
  'AudioGen (ggml): instrumental music generation end-to-end',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail(
        'ACE-Step models unavailable — run `npm run download-models:registry` (or set AUDIOGEN_GGML_LOCAL_MODELS_DIR).'
      )
      return
    }
    t.ok(download.success, 'ACE-Step models present')

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: !NO_GPU
    })
    t.teardown(() => gen.destroy())

    const { data } = await runAudioGen(gen, {
      caption: 'lo-fi hip hop, mellow piano, rainy night',
      opts: { lyrics: '[Instrumental]', duration: 8, seed: 42 }
    })

    t.ok(data.sampleCount > 0, `produced ${data.sampleCount} interleaved samples`)
    t.is(data.channels, 2, 'stereo output')
    t.is(data.sampleRate, 48000, '48 kHz output')
    t.ok(data.durationMs > 0, `non-empty audio (${Math.round(data.durationMs)} ms)`)
    t.ok(data.stages.length > 0, `streamed progress stages (${data.stages.join(', ')})`)
    t.ok(data.stats && typeof data.stats.totalTimeMs === 'number', 'stats.totalTimeMs present')
    t.ok(typeof data.stats.realTimeFactor === 'number', 'stats.realTimeFactor present')
  }
)

test(
  'AudioGen (ggml): song with lyrics + musical hints, and PCM encodes to WAV',
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

    const response = await gen.run('energetic cumbia, brass stabs, live percussion, party vibe', {
      vocalLanguage: 'es',
      bpm: 98,
      keyscale: 'A minor',
      timesignature: '4/4',
      duration: 8,
      seed: 7,
      lyrics: '[verse]\nSuena el tambor y el barrio se enciende'
    })

    const chunks = []
    let sampleRate = 0
    let channels = 0
    for await (const item of response.iterate()) {
      if (item && item.outputArray) {
        chunks.push(item.outputArray)
        sampleRate = item.sampleRate || sampleRate
        channels = item.channels || channels
      }
    }
    await response.await()

    let total = 0
    for (const chunk of chunks) total += chunk.length
    t.ok(total > 0, `produced ${total} interleaved samples`)
    t.is(channels, 2, 'stereo output')

    // Concatenate to one interleaved Int16 buffer and encode to WAV, exercising
    // the package's static encode() the same way a consumer would.
    const pcm = new Int16Array(total)
    let offset = 0
    for (const chunk of chunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    const wav = AudioGen.encode(bytes, 'wav', { sampleRate, channels })
    t.is(wav.extension, 'wav', 'encoded a WAV file')
    t.ok(wav.data && wav.data.length > 44, 'WAV has a header + payload')
  }
)
