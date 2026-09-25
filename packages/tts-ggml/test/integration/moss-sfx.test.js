'use strict'

const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')

const SFX_SAMPLE_RATE = 48000
const TEST_TIMEOUT_MS = 1800000
const PROMPT = 'A glass falls and shatters on a tile floor.'
const MODEL_DIR_ENV = 'QVAC_TEST_MOSS_SFX_MODEL_DIR'
const QUICK_STEPS = 2
const SHORT_SECONDS = 1.5
const LONGER_SECONDS = 2.5
const CPU_DEVICE = 0
const GPU_DEVICE = 1

const modelDir = (proc.env && proc.env[MODEL_DIR_ENV]) || ''
const skipWithoutModels = modelDir === ''
const noGpu = proc.env && proc.env.NO_GPU === 'true'

function createSfxModel(useGPU = false) {
  return new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS_SFX,
    files: { modelDir: path.resolve(modelDir) },
    config: { useGPU },
    seed: 0,
    opts: { stats: true }
  })
}

function collectChunk(result, data) {
  if (!data || !data.outputArray) return
  result.samples += data.outputArray.length
  if (data.sampleRate) result.sampleRate = data.sampleRate
}

async function generate(model, fields) {
  const response = await model.run({ input: PROMPT, type: 'text', steps: QUICK_STEPS, ...fields })
  const result = { samples: 0, sampleRate: null }
  await response.onUpdate((data) => collectChunk(result, data)).await()
  result.stats = response.stats
  return result
}

function assertClip(t, label, result, seconds) {
  t.is(result.sampleRate, SFX_SAMPLE_RATE, `${label} reports 48 kHz`)
  t.is(result.samples, Math.round(seconds * SFX_SAMPLE_RATE), `${label} lasts exactly ${seconds} s`)
  t.ok(result.stats, `${label} returns runtime stats`)
  t.is(result.stats.totalSamples, result.samples, `${label} reports the emitted samples`)
  t.ok(result.stats.totalTime > 0, `${label} reports its generation time`)
}

test(
  'MOSS-SFX integration: a prompt generates the requested duration on CPU',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels },
  async (t) => {
    const model = createSfxModel()
    await model.load()
    try {
      const result = await generate(model, { seconds: SHORT_SECONDS })
      assertClip(t, 'cpu clip', result, SHORT_SECONDS)
      t.is(result.stats.backendDevice, CPU_DEVICE, 'the clip ran on the CPU')
    } finally {
      await model.unload()
    }
  }
)

test(
  'MOSS-SFX integration: seconds and the negative prompt change per call',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels || noGpu },
  async (t) => {
    const model = createSfxModel(true)
    await model.load()
    try {
      const short = await generate(model, { seconds: SHORT_SECONDS })
      const longer = await generate(model, { seconds: LONGER_SECONDS, negativePrompt: 'music' })
      assertClip(t, 'short clip', short, SHORT_SECONDS)
      assertClip(t, 'longer clip', longer, LONGER_SECONDS)
      t.is(short.stats.backendDevice, GPU_DEVICE, 'the clips ran on the GPU')
    } finally {
      await model.unload()
    }
  }
)
