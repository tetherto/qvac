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
  collectAudioGenResponse,
  NO_GPU,
  INTEGRATION_TIMEOUT_MS
} = require('../utils/runAudioGen')
const { AudioGen, ERR_CODES, RepaintMode } = require('@qvac/audiogen-ggml')

const VARIANT = 'turbo-q4'
const COVER_SAMPLE_RATE = 48000
const COVER_CHANNELS = 2
const COVER_SECONDS = 0.25
const COVER_FREQUENCY = 220
const COVER_STEPS = 2
const COVER_SHIFT = 3
const COVER_SEED = 22886
const EDIT_SECONDS = 2
const REPAINT_CASES = [
  {
    label: 'conservative intro',
    start: 0,
    end: 0.75,
    mode: RepaintMode.Conservative,
    strength: 0
  },
  {
    label: 'balanced middle',
    start: 0.5,
    end: 1.5,
    mode: RepaintMode.Balanced,
    strength: 0.5
  },
  {
    label: 'aggressive ending',
    start: 1.25,
    end: EDIT_SECONDS,
    mode: RepaintMode.Aggressive,
    strength: 1
  }
]
const FLOW_EDIT_CASES = [
  { label: 'early window', nMin: 0, nMax: 0.5, nAvg: 1 },
  { label: 'middle window', nMin: 0.25, nMax: 0.75, nAvg: 2 },
  { label: 'late window', nMin: 0.5, nMax: 1, nAvg: 3 }
]
const FROZEN_AUDIO_CODES = new Int32Array([
  12095, 63487, 12741, 54319, 52716, 20464, 2469, 515, 22717, 2326, 62840, 61416, 18896, 55746,
  54256, 12095, 63935, 12741, 54319, 52716, 20464, 2469, 515, 22718, 2455, 10103, 12567, 27863,
  30367, 30367, 30367, 30367, 30367, 30367, 30367, 30367, 30367, 15206
])

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

function makeCoverPcm(seconds = COVER_SECONDS) {
  const frames = COVER_SAMPLE_RATE * seconds
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

function verifyEditRun(t, data, source, stage, label) {
  t.is(data.sampleRate, COVER_SAMPLE_RATE, `${label}: sample rate`)
  t.is(data.channels, COVER_CHANNELS, `${label}: channels`)
  t.is(data.sampleCount, source.length, `${label}: sample count`)
  t.ok(data.peak > 0.0001, `${label}: non-silent output`)
  t.ok(data.stages.includes('source'), `${label}: source encoded`)
  t.ok(data.stages.includes(stage), `${label}: ${stage} executed`)
  t.is(data.stages.includes('lm'), false, `${label}: LM bypassed`)
}

function concatInt16(chunks) {
  let sampleCount = 0
  for (const chunk of chunks) sampleCount += chunk.length
  const pcm = new Int16Array(sampleCount)
  let offset = 0
  for (const chunk of chunks) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  return pcm
}

function floatToPreservedInt16(sample) {
  const scale = sample < 0 ? 32768 : 32767
  let value = Math.round(sample * scale)
  if (value > 32767) value = 32767
  if (value < -32768) value = -32768
  return value
}

function maxPreservedDiff(output, source, startSec, endSec, sampleRate, channels) {
  const start = Math.floor(startSec * sampleRate) * channels
  const end = Math.floor(endSec * sampleRate) * channels
  let maxDiff = 0
  for (let i = start; i < end && i < output.length && i < source.length; i++) {
    const diff = Math.abs(output[i] - floatToPreservedInt16(source[i]))
    if (diff > maxDiff) maxDiff = diff
  }
  return maxDiff
}

function verifyRepaintPreserved(t, data, source, start, end, label) {
  const output = concatInt16(data.chunks)
  const duration = source.length / COVER_CHANNELS / COVER_SAMPLE_RATE
  const resolvedEnd = end < 0 ? duration : end
  // Skip two latent frames around the cut: aggressive mode bleeds past one frame.
  const margin = 2 / 25
  const beforeEnd = Math.max(0, start - margin)
  const afterStart = Math.min(duration, resolvedEnd + margin)
  // Whole-track peak-normalization would move a 0.1 sine by ~26k LSBs. Aggressive
  // DiT bleed near the cut measured ~2542; stay above that and far below rewrite.
  const preservedLimit = 4000
  if (beforeEnd > 0) {
    const beforeDiff = maxPreservedDiff(
      output,
      source,
      0,
      beforeEnd,
      COVER_SAMPLE_RATE,
      COVER_CHANNELS
    )
    t.ok(
      beforeDiff < preservedLimit,
      `${label}: samples before the repaint interval match the source (maxDiff=${beforeDiff})`
    )
  }
  if (afterStart < duration) {
    const afterDiff = maxPreservedDiff(
      output,
      source,
      afterStart,
      duration,
      COVER_SAMPLE_RATE,
      COVER_CHANNELS
    )
    t.ok(
      afterDiff < preservedLimit,
      `${label}: samples after the repaint interval match the source (maxDiff=${afterDiff})`
    )
  }
}

async function runRepaintVariants(t, gen, source) {
  for (const variant of REPAINT_CASES) {
    const response = await gen
      .edit({ pcm: source, sampleRate: COVER_SAMPLE_RATE, channels: COVER_CHANNELS })
      .repaint({
        caption: `${variant.label} analog synth`,
        lyrics: '[Instrumental]',
        start: variant.start,
        end: variant.end,
        mode: variant.mode,
        strength: variant.strength
      })
      .run({ seed: COVER_SEED })
    const { data } = await collectAudioGenResponse(response)
    verifyEditRun(t, data, source, 'repaint', variant.label)
    verifyRepaintPreserved(t, data, source, variant.start, variant.end, variant.label)
  }
}

async function runFlowEditVariants(t, gen, source) {
  for (const variant of FLOW_EDIT_CASES) {
    const response = await gen
      .edit({ pcm: source, sampleRate: COVER_SAMPLE_RATE, channels: COVER_CHANNELS })
      .flowEdit({
        from: { caption: 'plain sine tone', lyrics: '[Instrumental]' },
        to: { caption: `${variant.label} evolving synth pad`, lyrics: '[Instrumental]' },
        nMin: variant.nMin,
        nMax: variant.nMax,
        nAvg: variant.nAvg
      })
      .run({ seed: COVER_SEED })
    const { data } = await collectAudioGenResponse(response)
    verifyEditRun(t, data, source, 'flow-edit', variant.label)
  }
}

function verifyOperationOrder(t, data, first, second, label) {
  const firstIndex = data.stages.indexOf(first)
  const secondIndex = data.stages.indexOf(second)
  t.ok(firstIndex >= 0, `${label}: ${first} executed`)
  t.ok(secondIndex > firstIndex, `${label}: operation order preserved`)
}

async function runFlowThenRepaint(t, gen, source) {
  const response = await gen
    .edit({ pcm: source, sampleRate: COVER_SAMPLE_RATE, channels: COVER_CHANNELS })
    .flowEdit({
      from: { caption: 'plain sine tone', lyrics: '[Instrumental]' },
      to: { caption: 'warm evolving synth pad', lyrics: '[Instrumental]' },
      nMin: 0,
      nMax: 0.5,
      nAvg: 1
    })
    .repaint({
      caption: 'bright analog synth ending',
      lyrics: '[Instrumental]',
      start: 1,
      end: 1.5,
      mode: RepaintMode.Balanced,
      strength: 0.5
    })
    .run({ seed: COVER_SEED })
  const { data } = await collectAudioGenResponse(response)
  verifyEditRun(t, data, source, 'flow-edit', 'FlowEdit -> Repaint')
  verifyOperationOrder(t, data, 'flow-edit', 'repaint', 'FlowEdit -> Repaint')
}

async function runRepaintThenFlow(t, gen, source) {
  const response = await gen
    .edit({ pcm: source, sampleRate: COVER_SAMPLE_RATE, channels: COVER_CHANNELS })
    .repaint({
      caption: 'bright analog synth intro',
      lyrics: '[Instrumental]',
      start: 0,
      end: 0.75,
      mode: RepaintMode.Aggressive,
      strength: 1
    })
    .flowEdit({
      from: { caption: 'bright analog synth intro', lyrics: '[Instrumental]' },
      to: { caption: 'dark cinematic synthwave', lyrics: '[Instrumental]' },
      nMin: 0.5,
      nMax: 1,
      nAvg: 1
    })
    .run({ seed: COVER_SEED })
  const { data } = await collectAudioGenResponse(response)
  verifyEditRun(t, data, source, 'repaint', 'Repaint -> FlowEdit')
  verifyOperationOrder(t, data, 'repaint', 'flow-edit', 'Repaint -> FlowEdit')
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
  'AudioGen (ggml): computeQualityScore reports stats.qualityScore',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail('ACE-Step models unavailable')
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: !NO_GPU
    })
    t.teardown(() => gen.destroy())

    const scored = await runAudioGen(gen, {
      caption: 'acoustic ballad quality scoring integration test',
      opts: {
        lyrics: '[verse]\nhello quality world',
        duration: 4,
        seed: 42,
        bpm: 120,
        keyscale: 'C major',
        computeQualityScore: true
      }
    })
    t.ok(scored.data.sampleCount > 0, 'scored run produced audio')
    t.ok(scored.data.stages.includes('score'), 'streamed the score stage')
    t.ok(typeof scored.data.stats.qualityScore === 'number', 'stats.qualityScore present')
    t.ok(
      scored.data.stats.qualityScore >= 0 && scored.data.stats.qualityScore <= 1,
      `qualityScore in [0, 1] (${scored.data.stats.qualityScore})`
    )

    const unscored = await runAudioGen(gen, {
      caption: 'acoustic ballad quality scoring integration test',
      opts: { lyrics: '[Instrumental]', duration: 4, seed: 42 }
    })
    t.is(unscored.data.stats.qualityScore, undefined, 'no qualityScore without the flag')
  }
)

test(
  'AudioGen (ggml): immediate ACE-Step cancellation is terminal',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail('ACE-Step models unavailable')
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: !NO_GPU
    })
    t.teardown(() => gen.destroy())

    const response = await gen.run('A long orchestral build.', {
      duration: 30,
      seed: 17
    })
    await gen.cancel()

    try {
      await response.await()
      t.fail('ACE-Step cancellation must reject the response')
    } catch (error) {
      t.is(error.code, ERR_CODES.CANCELLED, 'ACE-Step cancellation is terminal')
    }

    const recovered = await runAudioGen(gen, {
      caption: 'A short piano recovery note.',
      opts: {
        audioCodes: FROZEN_AUDIO_CODES,
        seed: 19
      }
    })
    t.ok(recovered.data.sampleCount > 0, 'ACE-Step runs after cancellation')
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

test(
  'AudioGen (ggml): Repaint and FlowEdit variants cross the native bridge in order',
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

    const source = makeCoverPcm(EDIT_SECONDS)
    await runRepaintVariants(t, gen, source)
    await runFlowEditVariants(t, gen, source)
    await runFlowThenRepaint(t, gen, source)
    await runRepaintThenFlow(t, gen, source)
  }
)
