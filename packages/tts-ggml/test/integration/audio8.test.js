'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')
const { ensureAudio8Models } = require('../utils/downloadModel')
const { recordTtsStats } = require('../utils/perf-helper')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')

const AUDIO8_SAMPLE_RATE = 44100
const AUDIO8_MAX_FRAMES = 16
const AUDIO8_QUANT = 'q8_0'
const CPU_TEST_TIMEOUT_MS = 900000
const GPU_TEST_TIMEOUT_MS = 600000
const GPU_DEVICE = 1
const CPU_DEVICE = 0
const CUDA_BACKEND = 2
const VULKAN_BACKEND = 3
const CPU_BACKEND = 0
const REFERENCE_TEXT =
  'And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.'
const SYNTHESIS_TEXT = 'The Audio eight integration test checks this generated voice.'
const platform = os.platform()
const arch = os.arch()
const isDesktopGpu = (platform === 'linux' || platform === 'win32') && arch === 'x64'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
// Runs that pin the engine's GPU cascade (opt-in ENABLE_CUDA builds carry
// CUDA and Vulkan) export TTS_CPP_GPU_BACKEND; the desktop assertion expects
// the pinned backend and defaults to Vulkan when unset.
const pinnedGpuBackend = (proc.env && proc.env.TTS_CPP_GPU_BACKEND) || ''
const expectedDesktopBackend = pinnedGpuBackend === 'cuda' ? CUDA_BACKEND : VULKAN_BACKEND
const expectedDesktopBackendName = pinnedGpuBackend === 'cuda' ? 'CUDA' : 'Vulkan'

function resolveAudio8Files(models, useModelDir) {
  if (useModelDir) return { modelDir: models.targetDir }
  return {
    audio8Lm: models.lmPath,
    audio8CodecDecoder: models.decoderPath,
    ...(models.encoderPath ? { audio8CodecEncoder: models.encoderPath } : {})
  }
}

function createAudio8Model(models, useGPU, useModelDir) {
  return new TTSGgml({
    engine: TTSGgml.ENGINE_AUDIO8,
    files: resolveAudio8Files(models, useModelDir),
    greedy: true,
    maxFrames: AUDIO8_MAX_FRAMES,
    config: { useGPU },
    opts: { stats: true }
  })
}

async function synthesize(model, text, voice = {}) {
  const response = await model.run({ input: text, type: 'text', ...voice })
  let samples = []
  let sampleRate = null
  await response
    .onUpdate((data) => {
      if (data && data.outputArray) samples = samples.concat(Array.from(data.outputArray))
      if (data && data.sampleRate) sampleRate = data.sampleRate
    })
    .await()
  return { samples, sampleRate, stats: response.stats }
}

function assertAudio(t, label, result) {
  t.ok(result.samples.length > 0, `${label} produced audio`)
  t.is(result.sampleRate, AUDIO8_SAMPLE_RATE, `${label} reports 44.1 kHz`)
  t.ok(result.stats, `${label} returns runtime stats`)
  t.is(
    result.stats.totalSamples,
    result.samples.length,
    `${label} reports the emitted sample count`
  )
  t.ok(result.stats.generatedFrames > 0, `${label} reports generated codec frames`)
  t.ok(
    result.stats.generatedFrames <= AUDIO8_MAX_FRAMES,
    `${label} respects the configured frame limit`
  )
  t.ok(result.stats.tokensPerSecond > 0, `${label} reports codec frames per second`)
  t.ok(result.stats.audioDurationMs > 0, `${label} reports audio duration`)
}

function sampleBytes(samples) {
  return Buffer.from(Int16Array.from(samples).buffer)
}

function samplesEqual(first, second) {
  return sampleBytes(first).equals(sampleBytes(second))
}

function samplesDiffer(first, second) {
  return !samplesEqual(first, second)
}

function recordAudio8(t, label, result, wallMs) {
  t.comment(
    recordTtsStats(label, result.stats, {
      wallMs,
      sampleCount: result.samples.length,
      model: 'audio8',
      output: label
    })
  )
}

async function loadAudio8Model(t, includeEncoder, useGPU, useModelDir = false) {
  const models = await ensureAudio8Models({
    targetDir: path.join('.', 'models'),
    quant: AUDIO8_QUANT,
    includeEncoder
  })
  if (!models.success) {
    t.fail(
      'Audio8 GGUFs are unavailable. Run `npm run download-models:registry -- --group audio8` or stage them locally.'
    )
    return null
  }
  const model = createAudio8Model(models, useGPU, useModelDir)
  await model.load()
  return model
}

test(
  'Audio8 TTS: text-only and per-call voice cloning synthesize through the public JS API',
  { timeout: CPU_TEST_TIMEOUT_MS, skip: !isDesktopGpu },
  async (t) => {
    const referenceAudio = resolveRefWavPath({})
    if (!fs.existsSync(referenceAudio)) {
      t.fail(`Audio8 reference audio is missing: ${referenceAudio}`)
      return
    }

    const model = await loadAudio8Model(t, true, false, true)
    if (!model) return

    try {
      const textStarted = Date.now()
      const textOnly = await synthesize(model, SYNTHESIS_TEXT)
      assertAudio(t, 'Audio8 text-only', textOnly)
      t.is(textOnly.stats.backendDevice, CPU_DEVICE, 'text-only CPU run reports a CPU device')
      t.is(textOnly.stats.backendId, CPU_BACKEND, 'text-only CPU run reports the CPU backend')
      recordAudio8(t, 'audio8 text-only', textOnly, Date.now() - textStarted)

      const cloneStarted = Date.now()
      const cloned = await synthesize(model, SYNTHESIS_TEXT, {
        referenceAudio,
        referenceText: REFERENCE_TEXT
      })
      assertAudio(t, 'Audio8 voice clone', cloned)
      t.is(cloned.stats.backendDevice, CPU_DEVICE, 'voice cloning remains on the requested CPU')
      t.ok(
        samplesDiffer(textOnly.samples, cloned.samples),
        'per-call reference audio changes the synthesized voice'
      )
      recordAudio8(t, 'audio8 voice clone', cloned, Date.now() - cloneStarted)

      const repeated = await synthesize(model, SYNTHESIS_TEXT)
      assertAudio(t, 'Audio8 repeated text-only', repeated)
      t.ok(
        samplesEqual(textOnly.samples, repeated.samples),
        'greedy text-only synthesis is deterministic after a per-call voice'
      )
    } finally {
      await model.unload()
    }
  }
)

test(
  'Audio8 TTS: useGPU=true performs synthesis on the desktop GPU backend',
  { timeout: GPU_TEST_TIMEOUT_MS, skip: !isDesktopGpu || noGpu },
  async (t) => {
    const model = await loadAudio8Model(t, false, true)
    if (!model) return

    try {
      const started = Date.now()
      const result = await synthesize(model, 'Audio eight uses the GPU on this desktop.')
      assertAudio(t, 'Audio8 GPU', result)
      t.is(result.stats.backendDevice, GPU_DEVICE, 'Audio8 GPU reports a GPU device')
      t.is(
        result.stats.backendId,
        expectedDesktopBackend,
        `Audio8 GPU reports the ${expectedDesktopBackendName} backend`
      )
      t.is(result.stats.gpuUnsupported, 0, 'Audio8 GPU does not report a GPU fallback')
      recordAudio8(t, 'audio8 gpu', result, Date.now() - started)
    } finally {
      await model.unload()
    }
  }
)
