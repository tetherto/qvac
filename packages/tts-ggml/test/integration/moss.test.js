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
const { NO_GPU, GPU_ONLY_USE_GPU } = require('../utils/gpuOnly')
const { assertMossBackend } = require('../utils/mossBackend')
const {
  createMossGpuValidation,
  ENCODER_RE,
  DIALOGUE_BACKBONE_RE
} = require('../utils/mossGpuValidation')

const MOSS_SAMPLE_RATE = 24000
const MOSS_STREAM_FRAMES = 10
const MOSS_SAMPLES_PER_FRAME = 1920
const TEST_TIMEOUT_MS = 1800000
const SYNTHESIS_TEXT = 'The MOSS integration test checks this generated voice.'
const MODEL_DIR_ENV = 'QVAC_TEST_MOSS_MODEL_DIR'
const DIALOGUE_TEXT =
  '[S1] And so, my fellow Americans, [S2] ask what you can do for your country. ' +
  '[S1] Did the build finish this morning? [S2] Yes, every single test passed.'
const SPEAKER_ONE_SECONDS = [0, 3.29]
const SPEAKER_TWO_SECONDS = [7.6, 10.6]
const SHORT_DURATION_TOKENS = 25
const LONG_DURATION_TOKENS = 100
const INT16_FULL_SCALE = 32767
const PINNED_GPU_BACKEND = (proc.env && proc.env.TTS_CPP_GPU_BACKEND) || ''

const modelDir = (proc.env && proc.env[MODEL_DIR_ENV]) || ''
const skipWithoutModels = modelDir === ''
const sourceAudio = resolveRefWavPath({})
const validation = createMossGpuValidation(proc.env || {}, sourceAudio, GPU_ONLY_USE_GPU)

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

function resampleToMossRate(sourcePath) {
  const source = readWavAsFloat32(sourcePath)
  return resampleLinear(source.samples, source.sampleRate, MOSS_SAMPLE_RATE)
}

function writeMossWav(samples, tag) {
  const target = path.join(os.tmpdir(), `moss-${tag}-${Date.now()}.wav`)
  createWav(toInt16(samples), MOSS_SAMPLE_RATE, target)
  return target
}

function writeReferenceAtMossRate(sourcePath) {
  return writeMossWav(resampleToMossRate(sourcePath), 'reference')
}

function sliceSeconds(samples, [from, to]) {
  return samples.slice(Math.round(from * MOSS_SAMPLE_RATE), Math.round(to * MOSS_SAMPLE_RATE))
}

function writeSpeakerReferences(sourcePath) {
  const samples = resampleToMossRate(sourcePath)
  return [
    writeMossWav(sliceSeconds(samples, SPEAKER_ONE_SECONDS), 'speaker-1'),
    writeMossWav(sliceSeconds(samples, SPEAKER_TWO_SECONDS), 'speaker-2')
  ]
}

function removeFiles(paths) {
  for (const file of paths) fs.unlinkSync(file)
}

function modelDirHas(pattern) {
  return !skipWithoutModels && fs.readdirSync(modelDir).some((entry) => pattern.test(entry))
}

function hasEncoder() {
  return modelDirHas(ENCODER_RE)
}

function hasDialogueBackbone() {
  return modelDirHas(DIALOGUE_BACKBONE_RE)
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

function assertBackend(t, label, stats, useGPU = false) {
  assertMossBackend(t, label, stats, useGPU, PINNED_GPU_BACKEND)
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
      assertBackend(t, 'MOSS batch', result.stats)
      t.is(nonEmptyChunks(result).length, 1, 'batch synthesis emits one buffer')
      recordMoss(t, 'moss batch', result, Date.now() - started)
    })
    validation.completed('CPU batch')
  }
)

for (const useGPU of [false, true]) {
  test(
    `MOSS TTS: native chunk streaming emits frame-sized chunks (${useGPU ? 'GPU' : 'CPU'})`,
    { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels || (useGPU && NO_GPU) },
    async (t) => {
      await withLoadedModel(
        { streamChunkTokens: MOSS_STREAM_FRAMES },
        async (model) => {
          const started = Date.now()
          const result = await synthesize(model, SYNTHESIS_TEXT)
          assertAudio(t, 'MOSS stream', result)
          assertBackend(t, 'MOSS stream', result.stats, useGPU)
          const chunks = nonEmptyChunks(result)
          t.ok(chunks.length > 1, `streaming emits several chunks (got ${chunks.length})`)
          t.ok(
            chunks.every((length) => length <= MOSS_STREAM_FRAMES * MOSS_SAMPLES_PER_FRAME),
            'no chunk exceeds the configured frame count'
          )
          recordMoss(t, 'moss stream', result, Date.now() - started)
        },
        useGPU
      )
      validation.completed(`${useGPU ? 'GPU' : 'CPU'} streaming`)
    }
  )
}

test(
  'MOSS TTS: useGPU=true synthesizes on a GPU backend',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels || NO_GPU },
  async (t) => {
    await withLoadedModel(
      {},
      async (model) => {
        const started = Date.now()
        const result = await synthesize(model, SYNTHESIS_TEXT)
        assertAudio(t, 'MOSS GPU', result)
        assertBackend(t, 'MOSS GPU', result.stats, true)
        recordMoss(t, 'moss gpu', result, Date.now() - started)
      },
      true
    )
    validation.completed('GPU batch')
  }
)

for (const useGPU of [false, true]) {
  test(
    `MOSS TTS: voice cloning synthesizes from a reference recording (${useGPU ? 'GPU' : 'CPU'})`,
    { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels || (useGPU && NO_GPU) },
    async (t) => {
      if (!hasEncoder()) {
        t.comment(`skipping: no moss-codec-encoder GGUF in ${modelDir}`)
        return
      }
      if (!fs.existsSync(sourceAudio)) {
        t.fail(`MOSS reference audio is missing: ${sourceAudio}`)
        return
      }
      const referenceAudio = writeReferenceAtMossRate(sourceAudio)
      try {
        await withLoadedModel(
          { referenceAudio, seed: 7 },
          async (model) => {
            const started = Date.now()
            const result = await synthesize(model, SYNTHESIS_TEXT)
            assertAudio(t, 'MOSS clone', result)
            assertBackend(t, 'MOSS clone', result.stats, useGPU)
            recordMoss(t, 'moss clone', result, Date.now() - started)
          },
          useGPU
        )
      } finally {
        fs.unlinkSync(referenceAudio)
      }
      validation.completed(`${useGPU ? 'GPU' : 'CPU'} cloning`)
    }
  )
}

test(
  'MOSS TTS: durationTokens steers the length of the synthesized speech',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels || NO_GPU },
  async (t) => {
    await withLoadedModel(
      { durationTokens: SHORT_DURATION_TOKENS, seed: 7 },
      async (model) => {
        const short = await synthesize(model, SYNTHESIS_TEXT)
        assertAudio(t, 'MOSS short target', short)
        assertBackend(t, 'MOSS short target', short.stats, GPU_ONLY_USE_GPU)
        await model.reload({ durationTokens: LONG_DURATION_TOKENS })
        const long = await synthesize(model, SYNTHESIS_TEXT)
        assertAudio(t, 'MOSS long target', long)
        assertBackend(t, 'MOSS long target', long.stats, GPU_ONLY_USE_GPU)
        t.ok(
          long.samples.length > short.samples.length,
          `a longer target yields longer speech (${short.samples.length} -> ${long.samples.length} samples)`
        )
      },
      GPU_ONLY_USE_GPU
    )
    validation.completed('GPU duration/reload')
  }
)

test(
  'MOSS TTS: dialogue synthesis clones one reference per speaker',
  { timeout: TEST_TIMEOUT_MS, skip: skipWithoutModels || NO_GPU },
  async (t) => {
    if (!hasDialogueBackbone() || !hasEncoder()) {
      t.comment(`skipping: the TTSD backbone or the codec encoder is not in ${modelDir}`)
      return
    }
    if (!fs.existsSync(sourceAudio)) {
      t.fail(`MOSS reference audio is missing: ${sourceAudio}`)
      return
    }
    const references = writeSpeakerReferences(sourceAudio)
    try {
      await withLoadedModel(
        { dialogueReferences: references, seed: 7, files: { modelDir: path.resolve(modelDir) } },
        async (model) => {
          t.ok(
            DIALOGUE_BACKBONE_RE.test(path.basename(model._setup.paths.mossBackbonePath)),
            'dialogue picks the TTSD backbone'
          )
          const started = Date.now()
          const result = await synthesize(model, DIALOGUE_TEXT)
          assertAudio(t, 'MOSS dialogue', result)
          assertBackend(t, 'MOSS dialogue', result.stats, GPU_ONLY_USE_GPU)
          recordMoss(t, 'moss dialogue', result, Date.now() - started)
        },
        GPU_ONLY_USE_GPU
      )
    } finally {
      removeFiles(references)
    }
    validation.completed('GPU TTSD dialogue')
  }
)

if (validation.enabled) {
  test('MOSS TTS: full GPU validation completed every required case', (t) => {
    validation.assertComplete(t, [
      'CPU batch',
      'CPU streaming',
      'GPU streaming',
      'GPU batch',
      'CPU cloning',
      'GPU cloning',
      'GPU duration/reload',
      'GPU TTSD dialogue'
    ])
  })
}
