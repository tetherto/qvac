'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('@qvac/tts-ggml')
const { getBaseDir, isMobile, runTTS, runTTSWithSplit } = require('./runTTS')
const { concatenatePcmChunks } = require('./pcmConcatenator')
const { createWavBuffer } = require('./wav-helper')

const CHATTERBOX_SAMPLE_RATE = 24000

/**
 * Resolve the reference-audio WAV path.  Precedence:
 *   1. params.refWavPath
 *   2. On mobile, a bundled test asset under global.assetPaths
 *   3. Fallback to test/reference-audio/jfk.wav
 *
 * Unlike the ONNX backend, we pass the path as-is to the native addon
 * (which forwards to qvac-tts-cli's --reference-audio), so no decode /
 * resample is needed on the JS side.
 */
function resolveRefWavPath (params) {
  if (params.refWavPath) return params.refWavPath
  if (isMobile && global.assetPaths) {
    const assetKey = '../../testAssets/jfk.wav'
    if (global.assetPaths[assetKey]) {
      return global.assetPaths[assetKey].replace('file://', '')
    }
  }
  return path.join(__dirname, '..', 'reference-audio', 'jfk.wav')
}

async function loadChatterboxTTS (params = {}) {
  const baseDir = getBaseDir()
  const defaultModelDir = path.resolve(path.join(baseDir, 'models'))
  const modelDir = params.modelDir || defaultModelDir

  const t3ModelPath = params.t3ModelPath || path.join(modelDir, 'chatterbox-t3-turbo.gguf')
  const s3genModelPath = params.s3genModelPath || path.join(modelDir, 'chatterbox-s3gen.gguf')

  const refWavPath = resolveRefWavPath(params)
  if (!fs.existsSync(refWavPath)) {
    throw new Error(`[Chatterbox] reference audio not found at ${refWavPath}`)
  }
  console.log(`[Chatterbox] using reference audio: ${refWavPath}`)

  const config = { language: params.language || 'en' }
  if (params.useGPU !== undefined) {
    config.useGPU = params.useGPU
  } else if (proc.env && proc.env.NO_GPU === 'true') {
    // Honour the workflow matrix's `no_gpu: 'true'` flag (which sets the
    // NO_GPU env var on the job).  Without this the addon's
    // index.js::_validateConfig defaults Chatterbox to `useGPU = true`,
    // which on runners without a Vulkan-capable driver (e.g. windows-2022,
    // ubuntu-22.04 without a discrete GPU) crashes during the addon's
    // ggml_backend_vk_init probe with `vk::createInstance:
    // ErrorIncompatibleDriver`.  Forcing CPU here keeps the no-GPU
    // matrix entries on the CPU code path that load_model_gguf actually
    // exercises with n_gpu_layers=0.
    config.useGPU = false
  }

  const model = new TTSGgml({
    files: {
      modelDir,
      t3Model: t3ModelPath,
      s3genModel: s3genModelPath
    },
    referenceAudio: refWavPath,
    voiceDir: params.voiceDir,
    seed: params.seed,
    threads: params.threads,
    nGpuLayers: params.nGpuLayers,
    config,
    opts: { stats: true }
  })
  await model.load()

  return model
}

async function runChatterboxTTS (model, params, expectation = {}) {
  return runTTS(model, params, expectation, {
    sampleRate: CHATTERBOX_SAMPLE_RATE,
    engineTag: 'Chatterbox'
  })
}

async function runChatterboxTTSWithSplit (model, params, expectation = {}) {
  return runTTSWithSplit(model, params, expectation, {
    sampleRate: CHATTERBOX_SAMPLE_RATE,
    engineTag: 'Chatterbox'
  })
}

function checkExpectations (sampleCount, durationMs, expectation) {
  if (expectation.minSamples !== undefined && sampleCount < expectation.minSamples) return false
  if (expectation.maxSamples !== undefined && sampleCount > expectation.maxSamples) return false
  if (expectation.minDurationMs !== undefined && durationMs < expectation.minDurationMs) return false
  if (expectation.maxDurationMs !== undefined && durationMs > expectation.maxDurationMs) return false
  return true
}

function saveWavIfNeeded (params, wavBuffer, tag) {
  if (params.saveWav !== true) return
  if (isMobile && !params.wavOutputPath) {
    console.log(`${tag}Skipping WAV save on mobile (no writable path provided)`)
    return
  }
  const defaultWavPath = path.join(__dirname, '../output/chatterbox-stream.wav')
  const wavPath = params.wavOutputPath || defaultWavPath
  const outputDir = path.dirname(wavPath)
  try { fs.mkdirSync(outputDir, { recursive: true }) } catch (err) {}
  fs.writeFileSync(wavPath, wavBuffer)
  console.log(`${tag}Saved WAV to: ${wavPath}`)
}

/**
 * Run `model.runStreaming()` over an async iterator of `phrases` and
 * collect PCM per chunk.  Mirrors `runSupertonicStreaming` in
 * @qvac/tts-onnx so downstream test shape stays consistent.
 */
async function runChatterboxStreaming (model, params, expectation = {}) {
  const sampleRate = CHATTERBOX_SAMPLE_RATE
  const tag = '[Chatterbox] '

  if (!model) {
    return { output: `${tag}Error: Missing required parameter: model`, passed: false }
  }
  const phrases = params && Array.isArray(params.phrases) ? params.phrases : null
  if (!phrases || phrases.length === 0) {
    return {
      output: `${tag}Error: Missing required parameter: phrases (non-empty string array)`,
      passed: false
    }
  }

  try {
    async function * textStream () {
      for (let i = 0; i < phrases.length; i++) {
        yield phrases[i]
      }
    }

    const streamingOptions =
      params.streamingOptions && typeof params.streamingOptions === 'object'
        ? params.streamingOptions
        : undefined
    const response = streamingOptions
      ? await model.runStreaming(textStream(), streamingOptions)
      : await model.runStreaming(textStream())

    const pcmByChunk = new Map()
    const textByChunk = new Map()
    let jobStats = null

    response.onUpdate(data => {
      if (data && data.outputArray != null && data.chunkIndex !== undefined) {
        pcmByChunk.set(data.chunkIndex, Int16Array.from(data.outputArray))
        if (typeof data.sentenceChunk === 'string') {
          textByChunk.set(data.chunkIndex, data.sentenceChunk)
        }
      }
      if (data && data.event === 'JobEnded') {
        jobStats = data
      }
    })

    await response.await()

    const indices = [...pcmByChunk.keys()].sort((a, b) => a - b)
    const pcmChunks = indices.map(i => pcmByChunk.get(i))
    const sentenceChunks = indices.map(i => textByChunk.get(i) || '')
    const combined = concatenatePcmChunks(pcmChunks, {
      crossfadeSamples: 0,
      silenceGapSamples: 0
    })
    const sampleCount = combined.length
    const durationMs =
      response.stats?.audioDurationMs ||
      jobStats?.audioDurationMs ||
      (sampleCount / (sampleRate / 1000))

    const passed = checkExpectations(sampleCount, durationMs, expectation)
    const wavBuffer = createWavBuffer(Array.from(combined), sampleRate)
    saveWavIfNeeded(params, wavBuffer, tag)

    const stats = response.stats || jobStats
    const output = `${tag}Streamed ${indices.length} chunk(s), ${sampleCount} samples (duration: ${durationMs.toFixed(0)}ms, RTF: ${stats?.realTimeFactor?.toFixed(4) || 'N/A'})`

    return {
      output,
      passed,
      data: {
        samples: Array.from(combined),
        sampleCount,
        durationMs,
        sampleRate,
        reportedSampleRate: sampleRate,
        wavBuffer,
        streamChunkCount: indices.length,
        sentenceChunks,
        stats
      }
    }
  } catch (error) {
    return {
      output: `${tag}Error: ${error.message}`,
      passed: false,
      data: { error: error.message }
    }
  }
}

module.exports = {
  loadChatterboxTTS,
  runChatterboxTTS,
  runChatterboxTTSWithSplit,
  runChatterboxStreaming
}
