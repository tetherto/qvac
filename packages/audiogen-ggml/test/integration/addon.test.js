'use strict'

// End-to-end desktop integration tests for @qvac/audiogen-ggml: download the
// ACE-Step GGUFs from the registry, load the native engine, generate music, and
// assert on the streamed PCM + progress + stats. Needs the native prebuild and
// the (multi-GB) models on disk, so CI provisions both before running this;
// locally, run `npm run download-models:registry -- --output ./models` first.

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
const COVER_SAMPLE_RATE = 48000
const COVER_CHANNELS = 2
const COVER_SECONDS = 0.25
const COVER_FREQUENCY = 220
const COVER_STEPS = 2
const COVER_SHIFT = 3
const COVER_SEED = 22886
const FROZEN_AUDIO_CODES = new Int32Array([
  12095, 63487, 12741, 54319, 52716, 20464, 2469, 515, 22717, 2326, 62840, 61416, 18896, 55746,
  54256, 12095, 63935, 12741, 54319, 52716, 20464, 2469, 515, 22718, 2455, 10103, 12567, 27863,
  30367, 30367, 30367, 30367, 30367, 30367, 30367, 30367, 30367, 15206
])

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

function makeCoverPcm() {
  const frames = COVER_SAMPLE_RATE * COVER_SECONDS
  const pcm = new Float32Array(frames * COVER_CHANNELS)
  for (let frame = 0; frame < frames; frame++) {
    const sample = 0.1 * Math.sin((2 * Math.PI * COVER_FREQUENCY * frame) / COVER_SAMPLE_RATE)
    pcm[frame * COVER_CHANNELS] = sample
    pcm[frame * COVER_CHANNELS + 1] = sample
  }
  return pcm
}

function coverOptions(sourceAudio, referenceAudio, coverNoiseStrength) {
  return {
    lyrics: '[Instrumental]',
    taskType: 'cover-nofsq',
    sourceAudio,
    referenceAudio,
    audioCoverStrength: 1,
    coverNoiseStrength,
    seed: COVER_SEED
  }
}

function verifyCoverRun(t, data) {
  t.ok(data.sampleCount > 0, 'cover bridge produced audio')
  t.is(data.channels, COVER_CHANNELS, 'cover bridge produced stereo output')
  t.is(data.sampleRate, COVER_SAMPLE_RATE, 'cover bridge preserved the sample rate')
  t.ok(data.stages.includes('source'), 'native bridge encoded sourceAudio')
  t.ok(data.stages.includes('reference'), 'native bridge encoded referenceAudio')
  t.is(data.stages.includes('lm'), false, 'taskType bypassed the LM stage')
}

test(
  'AudioGen (ggml): instrumental music generation end-to-end',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail(
        'ACE-Step models unavailable — run `npm run download-models:registry -- --output ./models` (or set AUDIOGEN_GGML_LOCAL_MODELS_DIR).'
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
      opts: {
        lyrics: '[Instrumental]',
        duration: 8,
        seed: 42,
        lmTemperature: 0.8,
        lmTopP: 0.9,
        lmTopK: 64,
        lmCfgScale: 2,
        dcwEnabled: true,
        dcwScaler: 0.05,
        dcwHighScaler: 0.02
      }
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
      t.fail(
        'ACE-Step models unavailable — run `npm run download-models:registry -- --output ./models`.'
      )
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

test(
  'AudioGen (ggml): frozen semantic codes bypass LM length generation',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail(
        'ACE-Step models unavailable — run `npm run download-models:registry -- --output ./models`.'
      )
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: !NO_GPU
    })
    t.teardown(() => gen.destroy())

    const { data } = await runAudioGen(gen, {
      caption: 'upbeat pop rock with driving electric guitars and a catchy hook',
      opts: {
        lyrics: '[Instrumental]',
        duration: 30,
        seed: 42,
        bpm: 158,
        keyscale: 'C# major',
        timesignature: '4/4',
        lmPhase1: false,
        dcwEnabled: true,
        dcwScaler: 0.05,
        dcwHighScaler: 0.02,
        audioCodes: FROZEN_AUDIO_CODES
      }
    })

    t.ok(data.sampleCount > 0, 'frozen codes produced audio')
    t.is(data.channels, 2, 'stereo output')
    t.is(data.sampleRate, 48000, '48 kHz output')
    t.ok(
      data.durationMs >= 6000 && data.durationMs <= 10000,
      `38 frozen 5 Hz codes determine a short render (${Math.round(data.durationMs)} ms), not the requested 30 s`
    )
    t.ok(data.peak > 0.0001, `non-silent peak (${data.peak.toFixed(6)})`)
    t.ok(data.rms > 0.00001, `non-silent RMS (${data.rms.toFixed(6)})`)
  }
)

test(
  'AudioGen (ggml): native cover bridge maps PCM and cover controls',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail(
        'ACE-Step models unavailable — run `npm run download-models:registry -- --output ./models`.'
      )
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: !NO_GPU,
      inferenceSteps: COVER_STEPS,
      shift: COVER_SHIFT
    })
    t.teardown(() => gen.destroy())

    const sourceAudio = makeCoverPcm()
    const referenceAudio = sourceAudio.slice()
    const cover = await runAudioGen(gen, {
      caption: 'instrumental cover bridge baseline',
      opts: coverOptions(sourceAudio, referenceAudio, 0.75)
    })

    verifyCoverRun(t, cover.data)
    t.ok(cover.data.peak > 0.0001, 'cover bridge produced non-silent audio')
  }
)
