'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('@qvac/tts-ggml')
const { getBaseDir, isMobile } = require('./runTTS')
const { createWavBuffer } = require('./wav-helper')

const SUPERTONIC_SAMPLE_RATE = 44100

async function loadSupertonicTTS (params = {}) {
  const baseDir = getBaseDir()
  const defaultModelDir = path.resolve(path.join(baseDir, 'models'))

  const supertonicPath =
    params.supertonicModelPath || path.join(defaultModelDir, 'supertonic.gguf')

  const config = { language: params.language || 'en' }
  if (params.useGPU !== undefined) {
    config.useGPU = params.useGPU
  } else if (proc.env && proc.env.NO_GPU === 'true') {
    config.useGPU = false
  }

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: supertonicPath },
    voice: params.voice || 'F1',
    steps: params.steps,
    speed: params.speed,
    seed: params.seed,
    threads: params.threads,
    nGpuLayers: params.nGpuLayers,
    config,
    opts: { stats: true }
  })
  await model.load()
  return model
}

async function runSupertonicTTS (model, params = {}, expectation = {}) {
  const tag = '[Supertonic] '
  const sampleRate = SUPERTONIC_SAMPLE_RATE

  if (!model) {
    return { output: `${tag}Error: Missing required parameter: model`, passed: false }
  }
  if (!params || typeof params.text !== 'string') {
    return { output: `${tag}Error: Missing required parameter: text`, passed: false }
  }

  try {
    let outputArray = []
    let reportedSampleRate = null
    const response = await model.run({ input: params.text, type: 'text' })

    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          outputArray = outputArray.concat(Array.from(data.outputArray))
        }
        if (data && data.sampleRate) reportedSampleRate = data.sampleRate
      })
      .await()

    const sampleCount = outputArray.length
    const stats = response.stats || null
    const durationMs = stats?.audioDurationMs || (sampleCount / (sampleRate / 1000))

    let passed = true
    if (expectation.minSamples !== undefined && sampleCount < expectation.minSamples) passed = false
    if (expectation.maxSamples !== undefined && sampleCount > expectation.maxSamples) passed = false
    if (expectation.minDurationMs !== undefined && durationMs < expectation.minDurationMs) passed = false
    if (expectation.maxDurationMs !== undefined && durationMs > expectation.maxDurationMs) passed = false

    const wavBuffer = createWavBuffer(outputArray, sampleRate)

    if (params.saveWav === true) {
      const wavPath = params.wavOutputPath || path.join(__dirname, '../output/supertonic.wav')
      try { fs.mkdirSync(path.dirname(wavPath), { recursive: true }) } catch (_e) {}
      if (!isMobile || params.wavOutputPath) {
        fs.writeFileSync(wavPath, wavBuffer)
      }
    }

    const output = `${tag}Synthesized ${sampleCount} samples (duration: ${durationMs.toFixed(0)}ms, RTF: ${stats?.realTimeFactor?.toFixed(4) || 'N/A'})`

    return {
      output,
      passed,
      data: {
        samples: outputArray,
        sampleCount,
        durationMs,
        sampleRate,
        reportedSampleRate,
        wavBuffer,
        stats
      }
    }
  } catch (error) {
    return { output: `${tag}Error: ${error.message}`, passed: false, data: { error: error.message } }
  }
}

module.exports = {
  loadSupertonicTTS,
  runSupertonicTTS,
  SUPERTONIC_SAMPLE_RATE
}
