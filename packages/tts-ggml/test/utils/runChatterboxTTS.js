'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../..')
const { getBaseDir, isMobile, runTTS, runTTSWithSplit } = require('./runTTS')

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

  const t3ModelPath = params.t3ModelPath || path.join(defaultModelDir, 'chatterbox-t3-turbo.gguf')
  const s3genModelPath = params.s3genModelPath || path.join(defaultModelDir, 'chatterbox-s3gen.gguf')

  const refWavPath = resolveRefWavPath(params)
  if (!fs.existsSync(refWavPath)) {
    throw new Error(`[Chatterbox] reference audio not found at ${refWavPath}`)
  }
  console.log(`[Chatterbox] using reference audio: ${refWavPath}`)

  const model = new TTSGgml({
    files: {
      modelDir: params.modelDir || defaultModelDir,
      t3Model: t3ModelPath,
      s3genModel: s3genModelPath
    },
    referenceAudio: refWavPath,
    voiceDir: params.voiceDir,
    seed: params.seed,
    threads: params.threads,
    nGpuLayers: params.nGpuLayers,
    config: {
      language: params.language || 'en',
      useGPU: params.useGPU || false
    },
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

module.exports = { loadChatterboxTTS, runChatterboxTTS, runChatterboxTTSWithSplit }
