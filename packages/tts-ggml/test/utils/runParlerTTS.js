'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('@qvac/tts-ggml')
const { getBaseDir, isMobile } = require('./runTTS')
const { createWavBuffer } = require('./wav-helper')

const PARLER_SAMPLE_RATE = 44100

async function loadParlerTTS(params = {}) {
  const baseDir = getBaseDir()
  const defaultModelDir = path.resolve(path.join(baseDir, 'models'))

  const parlerPath =
    params.parlerModelPath || path.join(defaultModelDir, 'parler-mini-v1-q8_0.gguf')

  const options = {
    engine: TTSGgml.ENGINE_PARLER,
    files: { parlerModel: parlerPath },
    opts: { stats: true }
  }
  // Description surface: full text or template fields (mutually exclusive).
  for (const k of [
    'description',
    'voice',
    'emotion',
    'pitch',
    'pace',
    'expressivity',
    'noise',
    'reverb',
    'quality',
    'seed',
    'threads',
    'temperature',
    'topK',
    'topP',
    'maxFrames',
    'minNewTokens',
    'normalizeNumbers'
  ]) {
    if (params[k] !== undefined) options[k] = params[k]
  }
  // Backend selection mirrors runSupertonicTTS: explicit useGPU wins, else honor
  // the NO_GPU env (on-device runner forces cpu). nGpuLayers is a top-level knob.
  const config = {}
  if (params.useGPU !== undefined) {
    config.useGPU = params.useGPU
  } else if (proc.env && proc.env.NO_GPU === 'true') {
    config.useGPU = false
  }
  if (params.outputSampleRate !== undefined) {
    config.outputSampleRate = params.outputSampleRate
  }
  if (Object.keys(config).length > 0) options.config = config
  if (params.nGpuLayers !== undefined) options.nGpuLayers = params.nGpuLayers

  const model = new TTSGgml(options)
  await model.load()
  return model
}

async function runParlerTTS(model, params = {}, expectation = {}) {
  const tag = '[Parler] '
  const sampleRate = params.expectedSampleRate || PARLER_SAMPLE_RATE

  if (!model) {
    return { output: `${tag}Error: Missing required parameter: model`, passed: false }
  }
  if (!params || typeof params.text !== 'string') {
    return { output: `${tag}Error: Missing required parameter: text`, passed: false }
  }

  try {
    let outputArray = []
    let reportedSampleRate = null
    const runInput = { input: params.text, type: 'text' }
    // Per-call description/template overrides ride on the run input.
    for (const k of [
      'description',
      'voice',
      'emotion',
      'pitch',
      'pace',
      'expressivity',
      'noise',
      'reverb',
      'quality'
    ]) {
      if (params.perCall && params.perCall[k] !== undefined) runInput[k] = params.perCall[k]
    }
    const response = await model.run(runInput)

    await response
      .onUpdate((data) => {
        if (data && data.outputArray) {
          outputArray = outputArray.concat(Array.from(data.outputArray))
        }
        if (data && data.sampleRate) reportedSampleRate = data.sampleRate
      })
      .await()

    const sampleCount = outputArray.length
    const stats = response.stats || null
    const durationMs = stats?.audioDurationMs || sampleCount / (sampleRate / 1000)

    let passed = true
    if (expectation.minSamples !== undefined && sampleCount < expectation.minSamples) passed = false
    if (expectation.maxSamples !== undefined && sampleCount > expectation.maxSamples) passed = false
    if (expectation.minDurationMs !== undefined && durationMs < expectation.minDurationMs)
      passed = false
    if (expectation.maxDurationMs !== undefined && durationMs > expectation.maxDurationMs)
      passed = false

    const wavBuffer = createWavBuffer(outputArray, sampleRate)

    if (params.saveWav === true) {
      const wavPath = params.wavOutputPath || path.join(__dirname, '../output/parler.wav')
      try {
        fs.mkdirSync(path.dirname(wavPath), { recursive: true })
      } catch (_e) {}
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
    return {
      output: `${tag}Error: ${error.message}`,
      passed: false,
      data: { error: error.message }
    }
  }
}

module.exports = {
  loadParlerTTS,
  runParlerTTS,
  PARLER_SAMPLE_RATE
}
