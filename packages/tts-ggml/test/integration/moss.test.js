'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')
const { recordTtsStats } = require('../utils/perf-helper')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')
const { readWavAsFloat32, createWav, resampleLinear } = require('../utils/wav-helper')
const { TTS_TEST_THREADS } = require('../utils/testThreads')

const MOSS_SAMPLE_RATE = 24000
const MOSS_STREAM_FRAMES = 10
const MOSS_SAMPLES_PER_FRAME = 1920
const TEST_TIMEOUT_MS = 1800000
const SYNTHESIS_TEXT = 'The MOSS integration test checks this generated voice.'
const MODEL_DIR_ENV = 'QVAC_TEST_MOSS_MODEL_DIR'
const ENCODER_FILE = 'moss-codec-encoder-f16.gguf'
const INT16_FULL_SCALE = 32767
const CPU_DEVICE = 0
const CPU_BACKEND = 0
const GPU_DEVICE = 1

const modelDir = (proc.env && proc.env[MODEL_DIR_ENV]) || ''
const skipWithoutModels = modelDir === ''
const noGpu = proc.env && proc.env.NO_GPU === 'true'

function createMossModel(extra = {}, useGPU = false) {
  return new TTSGgml({
    threads: TTS_TEST_THREADS,
    engine: TTSGgml.ENGINE_MOSS,
    files: { modelDir: path.resolve(modelDir) },
    config: { language: 'en', useGPU },
    opts: { stats: true },
    ...extra
  })
}

function toInt16(samples) {
  return Array.from(samples, (sample) => Math.round(sample * INT16_FULL_SCALE))
}

function writeReferenceAtMossRate(sourcePath) {
  const source = readWavAsFloat32(sourcePath)
  const resampled = resampleLinear(source.samples, source.sampleRate, MOSS_SAMPLE_RATE)
  const target = path.join(os.tmpdir(), `moss-reference-${Date.now()}.wav`)
  createWav(toInt16(resampled), MOSS_SAMPLE_RATE, target)
  return target
}

function collectChunk(result, data) {
  if (!data || !data.outputArray) return
  result.chunks.push(data.outputArray.length)
  result.samples = result.samples.concat(Array.from(data.outputArray))
  if (data.sampleRate) result.sampleRate = data.sampleRate
}

async function synthesize(model, text) {
  const response = await model.run({ input: text, type: 'text' })
  const result = { samples: [], chunks: [], sampleRate: null }
  await response.onUpdate((data) => collectChunk(result, data)).await()
  result.stats = response.stats
  return result
}

function assertAudio(t, label, result) {
  t.ok(result.samples.length > 0, `${label} produced audio`)
  t.is(result.sampleRate, MOSS_SAMPLE_RATE, `${label} reports 24 kHz`)
  t.ok(result.stats, `${label} returns runtime stats`)
  t.is(result.stats.totalSamples, result.samples.length, `${label} reports the emitted samples`)
  t.ok(result.stats.generatedFrames > 0, `${label} reports generated codec frames`)
  t.ok(result.stats.tokensPerSecond > 0, `${label} reports codec frames per second`)
}

function nonEmptyChunks(result) {
  return result.chunks.filter((length) => length > 0)
}

function recordMoss(t, label, result, wallMs) {
  t.comment(
    recordTtsStats(label, result.stats, {
      wallMs,
      sampleCount: result.samples.length,
      model: 'moss',
      output: label
    })
  )
}

function assertCpuBackend(t, label, stats) {
  t.is(stats.backendDevice, CPU_DEVICE, `${label} reports a CPU device`)
  t.is(stats.backendId, CPU_BACKEND, `${label} reports the CPU backend`)
}

async function withLoadedModel(extra, body, useGPU = false) {
  const model = createMossModel(extra, useGPU)
  await model.load()
  try {
    await body(model)
  } finally {
    await model.unload()
  }
}

test(
  'MOSS TTS: batch synthesis through the public JS API',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels },
  async (t) => {
    await withLoadedModel({}, async (model) => {
      const started = Date.now()
      const result = await synthesize(model, SYNTHESIS_TEXT)
      assertAudio(t, 'MOSS batch', result)
      assertCpuBackend(t, 'MOSS batch', result.stats)
      t.is(nonEmptyChunks(result).length, 1, 'batch synthesis emits one buffer')
      recordMoss(t, 'moss batch', result, Date.now() - started)
    })
  }
)

test(
  'MOSS TTS: native chunk streaming emits frame-sized chunks',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels },
  async (t) => {
    await withLoadedModel({ streamChunkTokens: MOSS_STREAM_FRAMES }, async (model) => {
      const started = Date.now()
      const result = await synthesize(model, SYNTHESIS_TEXT)
      assertAudio(t, 'MOSS stream', result)
      const chunks = nonEmptyChunks(result)
      t.ok(chunks.length > 1, `streaming emits several chunks (got ${chunks.length})`)
      t.ok(
        chunks.every((length) => length <= MOSS_STREAM_FRAMES * MOSS_SAMPLES_PER_FRAME),
        'no chunk exceeds the configured frame count'
      )
      recordMoss(t, 'moss stream', result, Date.now() - started)
    })
  }
)

test(
  'MOSS TTS: useGPU=true synthesizes on a GPU backend',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels || noGpu },
  async (t) => {
    await withLoadedModel(
      {},
      async (model) => {
        const started = Date.now()
        const result = await synthesize(model, SYNTHESIS_TEXT)
        assertAudio(t, 'MOSS GPU', result)
        t.is(result.stats.backendDevice, GPU_DEVICE, 'MOSS GPU reports a GPU device')
        t.not(result.stats.backendId, CPU_BACKEND, 'MOSS GPU does not report the CPU backend')
        t.is(result.stats.gpuUnsupported, 0, 'MOSS GPU does not report a GPU fallback')
        recordMoss(t, 'moss gpu', result, Date.now() - started)
      },
      true
    )
  }
)

test(
  'MOSS TTS: voice cloning synthesizes from a reference recording',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels },
  async (t) => {
    const sourceAudio = resolveRefWavPath({})
    if (!fs.existsSync(path.join(modelDir, ENCODER_FILE))) {
      t.comment(`skipping: ${ENCODER_FILE} is not in ${modelDir}`)
      return
    }
    if (!fs.existsSync(sourceAudio)) {
      t.fail(`MOSS reference audio is missing: ${sourceAudio}`)
      return
    }
    const referenceAudio = writeReferenceAtMossRate(sourceAudio)
    try {
      await withLoadedModel({ referenceAudio, seed: 7 }, async (model) => {
        const started = Date.now()
        const result = await synthesize(model, SYNTHESIS_TEXT)
        assertAudio(t, 'MOSS clone', result)
        recordMoss(t, 'moss clone', result, Date.now() - started)
      })
    } finally {
      fs.unlinkSync(referenceAudio)
    }
  }
)
