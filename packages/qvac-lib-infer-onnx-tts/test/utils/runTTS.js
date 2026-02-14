'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const ONNXTTS = require('../..')
const { createWavBuffer } = require('./wav-helper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

/** Supertonic output sample rate (Hz) */
const SUPERTONIC_SAMPLE_RATE = 44100

// Returns base directory for models - uses global.testDir on mobile, current dir otherwise
function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

/**
 * Load Supertonic TTS model.
 * @param {Object} params - Model parameters
 * @param {string} [params.modelDir] - Base model directory (default: getBaseDir()/models/supertonic)
 * @param {string} [params.voiceName='F1'] - Voice name
 * @param {string} [params.language='en'] - Language code (en, ko, es, pt, fr)
 * @param {number} [params.speed=1] - Speech speed
 * @param {number} [params.numInferenceSteps=5] - Denoising steps
 * @returns {Promise<ONNXTTS>} Loaded TTS model
 */
async function loadTTS (params = {}) {
  const defaultModelDir = path.join(getBaseDir(), 'models', 'supertonic')

  const args = {
    modelDir: params.modelDir || defaultModelDir,
    voiceName: params.voiceName || 'F1',
    speed: params.speed != null ? params.speed : 1,
    numInferenceSteps: params.numInferenceSteps != null ? params.numInferenceSteps : 5,
    opts: { stats: true }
  }

  const config = {
    language: params.language || 'en'
  }

  const model = new ONNXTTS(args, config)
  await model.load()

  return model
}

async function runTTS (model, params, expectation = {}) {
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
    // Get duration from response.stats (which has audioDurationMs) or calculate from samples (Supertonic: 44.1 kHz)
    const durationMs = response.stats?.audioDurationMs || jobStats?.audioDurationMs || (sampleCount / (SUPERTONIC_SAMPLE_RATE / 1000))

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

    const wavBuffer = createWavBuffer(outputArray, SUPERTONIC_SAMPLE_RATE)

    // Save WAV file if requested
    if (params.saveWav === true) {
      const defaultWavPath = path.join(__dirname, '../output/test.wav')
      const wavPath = params.wavOutputPath || defaultWavPath

      // Ensure output directory exists
      const outputDir = path.dirname(wavPath)
      try {
        fs.mkdirSync(outputDir, { recursive: true })
      } catch (err) {
        // Directory might already exist, ignore error
      }

      fs.writeFileSync(wavPath, wavBuffer)
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
    const output = `Synthesized ${sampleCount} samples (${statsInfo}) from text: "${params.text.substring(0, 50)}${params.text.length > 50 ? '...' : ''}"`

    return {
      output,
      passed,
      data: {
        samples: outputArray,
        sampleCount,
        durationMs,
        wavBuffer,
        stats: roundedStats
      }
    }
  } catch (error) {
    return {
      output: `Error: ${error.message}`,
      passed: false,
      data: { error: error.message }
    }
  }
}

module.exports = { loadTTS, runTTS }
