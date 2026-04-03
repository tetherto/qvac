'use strict'

const path = require('bare-path')
const ONNXTTS = require('../..')
const { readWavAsFloat32, resampleLinear } = require('./wav-helper')
const { getBaseDir, isMobile, runTTS, runTTSWithSplit } = require('./runTTS')

const CHATTERBOX_SAMPLE_RATE = 24000

async function loadChatterboxTTS (params = {}) {
  const baseDir = getBaseDir()
  const defaultModelDir = path.join(baseDir, 'models', 'chatterbox')

  const tokenizerPath = params.tokenizerPath || path.join(defaultModelDir, 'tokenizer.json')
  const speechEncoderPath = params.speechEncoderPath || path.join(defaultModelDir, 'speech_encoder.onnx')
  const embedTokensPath = params.embedTokensPath || path.join(defaultModelDir, 'embed_tokens.onnx')
  const conditionalDecoderPath = params.conditionalDecoderPath || path.join(defaultModelDir, 'conditional_decoder.onnx')
  const languageModelPath = params.languageModelPath || path.join(defaultModelDir, 'language_model.onnx')

  let referenceAudio
  if (params.referenceAudio) {
    referenceAudio = params.referenceAudio
    console.log(`[Chatterbox] Using provided reference audio (${referenceAudio.length} samples)`)
  } else if (params.refWavPath) {
    try {
      const { samples, sampleRate } = readWavAsFloat32(params.refWavPath)
      referenceAudio = samples
      console.log(`[Chatterbox] Loaded reference audio: ${params.refWavPath} (${samples.length} samples, ${sampleRate} Hz)`)
      if (sampleRate !== CHATTERBOX_SAMPLE_RATE) {
        console.log(`[Chatterbox] Note: Chatterbox expects ${CHATTERBOX_SAMPLE_RATE} Hz reference audio`)
      }
    } catch (err) {
      if (!params.useSyntheticAudio) {
        throw new Error(`Failed to load reference audio from ${params.refWavPath}: ${err.message}`)
      }
      console.log(`[Chatterbox] Could not load ${params.refWavPath}, falling back to synthetic audio`)
    }
  }

  if (!referenceAudio) {
    let defaultRefPath = params.refWavPath
    if (!defaultRefPath) {
      if (isMobile && global.assetPaths) {
        const assetKey = '../../testAssets/jfk.wav'
        if (global.assetPaths[assetKey]) {
          defaultRefPath = global.assetPaths[assetKey].replace('file://', '')
        }
      }
      if (!defaultRefPath) {
        defaultRefPath = path.join(__dirname, '..', 'reference-audio', 'jfk.wav')
      }
    }
    const { samples, sampleRate: refRate } = readWavAsFloat32(defaultRefPath)
    if (refRate !== CHATTERBOX_SAMPLE_RATE) {
      console.log(`[Chatterbox] Resampling reference audio from ${refRate}Hz to ${CHATTERBOX_SAMPLE_RATE}Hz`)
      referenceAudio = resampleLinear(samples, refRate, CHATTERBOX_SAMPLE_RATE)
    } else {
      referenceAudio = samples
    }
    console.log(`[Chatterbox] Using reference audio: ${defaultRefPath} (${referenceAudio.length} samples @ ${CHATTERBOX_SAMPLE_RATE / 1000}kHz)`)
  }

  const args = {
    tokenizerPath,
    speechEncoderPath,
    embedTokensPath,
    conditionalDecoderPath,
    languageModelPath,
    referenceAudio,
    opts: { stats: true }
  }

  const config = {
    language: params.language || 'en',
    useGPU: params.useGPU || false
  }

  const model = new ONNXTTS(args, config)
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
