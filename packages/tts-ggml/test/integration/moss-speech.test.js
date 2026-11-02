'use strict'

const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')
const { readWavAsFloat32 } = require('../utils/wav-helper')
const { TTS_TEST_THREADS } = require('../utils/testThreads')
const { assertMossBackend } = require('../utils/mossBackend')
const { createMossGpuValidation } = require('../utils/mossGpuValidation')
const { GPU_ONLY_USE_GPU } = require('../utils/gpuOnly')

const SPEECH_SAMPLE_RATE = 24000
const TEST_TIMEOUT_MS = 1800000
const MODEL_DIR_ENV = 'QVAC_TEST_MOSS_SPEECH_MODEL_DIR'
const MAX_NEW_TOKENS = 120
const CUT_SECONDS = 2
const CUT_MARGIN_SECONDS = 0.5
const PINNED_GPU_BACKEND = (proc.env && proc.env.TTS_CPP_GPU_BACKEND) || ''

const modelDir = (proc.env && proc.env[MODEL_DIR_ENV]) || ''
const skipWithoutModels = modelDir === ''
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const sourceAudio = resolveRefWavPath({})
const validation = createMossGpuValidation(proc.env || {}, sourceAudio, GPU_ONLY_USE_GPU)

function createSpeechModel(useGPU = false) {
  return new TTSGgml({
    threads: TTS_TEST_THREADS,
    engine: TTSGgml.ENGINE_MOSS_SPEECH,
    files: { modelDir: path.resolve(modelDir) },
    config: { useGPU },
    seed: 0,
    opts: { stats: true }
  })
}

function spokenQuestion() {
  const wav = readWavAsFloat32(sourceAudio)
  return { audio: wav.samples, sampleRate: wav.sampleRate }
}

function collectReply(result, data) {
  if (!data || !data.outputArray) return
  result.samples += data.outputArray.length
  if (data.sampleRate) result.sampleRate = data.sampleRate
  if (typeof data.text === 'string') result.text += data.text
}

async function respond(model, fields) {
  const response = await model.run({
    type: 'text',
    input: '',
    maxNewTokens: MAX_NEW_TOKENS,
    ...fields
  })
  const result = { samples: 0, sampleRate: null, text: '' }
  await response.onUpdate((data) => collectReply(result, data)).await()
  result.stats = response.stats
  return result
}

function assertSpokenReply(t, label, result) {
  t.is(result.sampleRate, SPEECH_SAMPLE_RATE, `${label} reports 24 kHz`)
  t.ok(result.samples > 0, `${label} carries speech`)
  t.ok(result.stats, `${label} returns runtime stats`)
  t.is(result.stats.totalSamples, result.samples, `${label} reports the emitted samples`)
  t.ok(result.stats.promptTokens > 0, `${label} reports its prompt length`)
}

test(
  'MOSS-Speech integration: a spoken question gets a spoken answer on CPU',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels },
  async (t) => {
    const model = createSpeechModel()
    await model.load()
    try {
      const result = await respond(model, spokenQuestion())
      assertSpokenReply(t, 'cpu reply', result)
      assertMossBackend(t, 'cpu reply', result.stats, false, PINNED_GPU_BACKEND)
    } finally {
      await model.unload()
    }
    validation.completed('CPU spoken reply')
  }
)

test(
  'MOSS-Speech integration: text replies, reply cuts and a text turn on the GPU',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels || noGpu },
  async (t) => {
    const model = createSpeechModel(true)
    await model.load()
    try {
      const textReply = await respond(model, { ...spokenQuestion(), textReply: true })
      t.is(textReply.samples, 0, 'a text reply carries no audio')
      t.ok(textReply.text.trim().length > 0, 'a text reply carries the answer')
      assertMossBackend(t, 'text reply', textReply.stats, true, PINNED_GPU_BACKEND)

      const cut = await respond(model, { ...spokenQuestion(), maxReplySeconds: CUT_SECONDS })
      assertSpokenReply(t, 'cut reply', cut)
      t.ok(
        cut.samples <= (CUT_SECONDS + CUT_MARGIN_SECONDS) * SPEECH_SAMPLE_RATE,
        'maxReplySeconds bounds the spoken reply'
      )
      assertMossBackend(t, 'cut reply', cut.stats, true, PINNED_GPU_BACKEND)

      const typed = await respond(model, { input: 'What is the capital of France?' })
      assertSpokenReply(t, 'reply to a typed question', typed)
      assertMossBackend(t, 'typed reply', typed.stats, true, PINNED_GPU_BACKEND)
    } finally {
      await model.unload()
    }
    validation.completed('GPU text/audio replies and reply cuts')
  }
)

if (validation.enabled) {
  test('MOSS-Speech: full GPU validation completed every required case', (t) => {
    validation.assertComplete(t, ['CPU spoken reply', 'GPU text/audio replies and reply cuts'])
  })
}
