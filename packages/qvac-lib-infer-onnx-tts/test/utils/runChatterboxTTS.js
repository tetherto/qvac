'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const ONNXTTS = require('../..')
const { createWavBuffer } = require('./wav-helper')
const { readWavAsFloat32 } = require('../../examples/wav-generator-helper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// Returns base directory for models - uses global.testDir on mobile, current dir otherwise
function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

/**
 * Generate synthetic reference audio for testing purposes.
 * Creates a sine wave tone that can be used as reference audio when no real audio file is available.
 * @param {number} [durationSec=1.0] - Duration in seconds
 * @param {number} [sampleRate=24000] - Sample rate (Chatterbox expects 24kHz)
 * @param {number} [frequency=440] - Frequency of sine wave in Hz (default A4 note)
 * @returns {Float32Array} Audio samples in range [-1, 1]
 */
function generateSyntheticReferenceAudio (durationSec = 1.0, sampleRate = 24000, frequency = 440) {
  const numSamples = Math.floor(sampleRate * durationSec)
  const samples = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    // Generate sine wave with amplitude 0.5 to avoid clipping
    samples[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.5
  }
  return samples
}

/**
 * Load Chatterbox TTS model
 * @param {Object} params - Model parameters
 * @param {string} params.tokenizerPath - Path to tokenizer JSON
 * @param {string} params.speechEncoderPath - Path to speech encoder ONNX
 * @param {string} params.embedTokensPath - Path to embed tokens ONNX
 * @param {string} params.conditionalDecoderPath - Path to conditional decoder ONNX
 * @param {string} params.languageModelPath - Path to language model ONNX
 * @param {string} [params.refWavPath] - Path to reference audio WAV file (optional if referenceAudio provided)
 * @param {Float32Array} [params.referenceAudio] - Reference audio samples directly (optional if refWavPath provided)
 * @param {boolean} [params.useSyntheticAudio=false] - Generate synthetic audio if no ref audio available
 * @param {string} [params.language='en'] - Language code
 * @param {boolean} [params.useGPU=false] - Whether to use GPU
 * @returns {Promise<ONNXTTS>} Loaded TTS model
 */
async function loadChatterboxTTS (params = {}) {
  const baseDir = getBaseDir()
  const defaultModelDir = path.join(baseDir, 'models', 'chatterbox')

  // Set default paths if not provided
  const tokenizerPath = params.tokenizerPath || path.join(defaultModelDir, 'tokenizer.json')
  const speechEncoderPath = params.speechEncoderPath || path.join(defaultModelDir, 'speech_encoder.onnx')
  const embedTokensPath = params.embedTokensPath || path.join(defaultModelDir, 'embed_tokens.onnx')
  const conditionalDecoderPath = params.conditionalDecoderPath || path.join(defaultModelDir, 'conditional_decoder.onnx')
  const languageModelPath = params.languageModelPath || path.join(defaultModelDir, 'language_model.onnx')

  // Load reference audio - priority: referenceAudio > refWavPath > synthetic
  let referenceAudio
  if (params.referenceAudio) {
    // Use directly provided reference audio
    referenceAudio = params.referenceAudio
    console.log(`[Chatterbox] Using provided reference audio (${referenceAudio.length} samples)`)
  } else if (params.refWavPath) {
    // Load from WAV file
    try {
      const { samples, sampleRate } = readWavAsFloat32(params.refWavPath)
      referenceAudio = samples
      console.log(`[Chatterbox] Loaded reference audio: ${params.refWavPath} (${samples.length} samples, ${sampleRate} Hz)`)
      if (sampleRate !== 24000) {
        console.log('[Chatterbox] Note: Chatterbox expects 24 kHz reference audio')
      }
    } catch (err) {
      if (!params.useSyntheticAudio) {
        throw new Error(`Failed to load reference audio from ${params.refWavPath}: ${err.message}`)
      }
      console.log(`[Chatterbox] Could not load ${params.refWavPath}, falling back to synthetic audio`)
    }
  }

  // Generate synthetic audio if needed and allowed
  if (!referenceAudio && params.useSyntheticAudio) {
    referenceAudio = generateSyntheticReferenceAudio(1.0, 24000, 440)
    console.log(`[Chatterbox] Using synthetic reference audio (${referenceAudio.length} samples, 24000 Hz)`)
  }

  if (!referenceAudio) {
    throw new Error('No reference audio provided. Provide refWavPath, referenceAudio, or set useSyntheticAudio=true')
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

/**
 * Run Chatterbox TTS synthesis
 * @param {ONNXTTS} model - Loaded TTS model
 * @param {Object} params - Synthesis parameters
 * @param {string} params.text - Text to synthesize
 * @param {boolean} [params.saveWav=false] - Whether to save output WAV
 * @param {string} [params.wavOutputPath] - Path to save WAV file
 * @param {Object} [expectation={}] - Expected output constraints
 * @returns {Promise<Object>} Synthesis result
 */
async function runChatterboxTTS (model, params, expectation = {}) {
  // Validate required parameters
  if (!model) {
    return {
      output: 'Error: Missing required parameter: model',
      passed: false
    }
  }

  if (!params || !params.text) {
    return {
      output: 'Error: Missing required parameter: text',
      passed: false
    }
  }

  try {
    // Run synthesis
    let outputArray = []
    let jobStats = null
    const response = await model.run({
      input: params.text,
      type: 'text'
    })

    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          const temp = Array.from(data.outputArray)
          outputArray = outputArray.concat(temp)
        }
        if (data.event === 'JobEnded') {
          jobStats = data
        }
      })
      .await()

    // Validate expectations if provided
    let passed = true
    const sampleCount = outputArray.length
    // Chatterbox uses 24kHz sample rate
    const sampleRate = 24000
    const durationMs = response.stats?.audioDurationMs || jobStats?.audioDurationMs || (sampleCount / (sampleRate / 1000))

    if (expectation.minSamples !== undefined && sampleCount < expectation.minSamples) {
      passed = false
    }
    if (expectation.maxSamples !== undefined && sampleCount > expectation.maxSamples) {
      passed = false
    }
    if (expectation.minDurationMs !== undefined && durationMs < expectation.minDurationMs) {
      passed = false
    }
    if (expectation.maxDurationMs !== undefined && durationMs > expectation.maxDurationMs) {
      passed = false
    }

    // Create WAV buffer from samples (Chatterbox uses 24kHz)
    const wavBuffer = createWavBuffer(outputArray, sampleRate)

    // Save WAV file if requested
    if (params.saveWav === true) {
      const defaultWavPath = path.join(__dirname, '../output/chatterbox-test.wav')
      const wavPath = params.wavOutputPath || defaultWavPath

      // Ensure output directory exists
      const outputDir = path.dirname(wavPath)
      try {
        fs.mkdirSync(outputDir, { recursive: true })
      } catch (err) {
        // Directory might already exist, ignore error
      }

      fs.writeFileSync(wavPath, wavBuffer)
      console.log(`[Chatterbox] Saved WAV to: ${wavPath}`)
    }

    // Build output message
    const stats = response.stats || jobStats

    // Round stats for readability
    const roundedStats = stats
      ? {
          totalTime: stats.totalTime ? Number(stats.totalTime.toFixed(4)) : stats.totalTime,
          tokensPerSecond: stats.tokensPerSecond ? Number(stats.tokensPerSecond.toFixed(2)) : stats.tokensPerSecond,
          realTimeFactor: stats.realTimeFactor ? Number(stats.realTimeFactor.toFixed(5)) : stats.realTimeFactor,
          audioDurationMs: stats.audioDurationMs,
          totalSamples: stats.totalSamples
        }
      : null

    const statsInfo = stats
      ? `duration: ${durationMs.toFixed(0)}ms, RTF: ${stats.realTimeFactor?.toFixed(4) || 'N/A'}`
      : `duration: ${durationMs.toFixed(0)}ms (calculated)`
    const output = `[Chatterbox] Synthesized ${sampleCount} samples (${statsInfo}) from text: "${params.text.substring(0, 50)}${params.text.length > 50 ? '...' : ''}"`

    return {
      output,
      passed,
      data: {
        samples: outputArray,
        sampleCount,
        durationMs,
        sampleRate,
        wavBuffer,
        stats: roundedStats
      }
    }
  } catch (error) {
    return {
      output: `[Chatterbox] Error: ${error.message}`,
      passed: false,
      data: { error: error.message }
    }
  }
}

module.exports = { loadChatterboxTTS, runChatterboxTTS, generateSyntheticReferenceAudio }
