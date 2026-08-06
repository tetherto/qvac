'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('@qvac/tts-ggml')
const { getBaseDir, isMobile } = require('./runTTS')
const { createWavBuffer } = require('./wav-helper')

// CosyVoice3 is native 24 kHz (Qwen2 speech LM + DiT flow + CausalHiFT vocoder).
const COSYVOICE_SAMPLE_RATE = 24000

async function loadCosyvoiceTTS(params = {}) {
  const baseDir = getBaseDir()
  const defaultModelDir = path.resolve(path.join(baseDir, 'models', 'cosyvoice3'))
  const cosyvoiceModelDir = params.cosyvoiceModelDir || defaultModelDir

  // Backend selection mirrors runParlerTTS: explicit useGPU wins, else honor the
  // NO_GPU env (on-device runner forces cpu). CosyVoice3 is CPU-only today, but
  // keep the same config surface so the helper reads identically to its siblings.
  const config = { language: params.language || 'en' }
  if (params.useGPU !== undefined) {
    config.useGPU = params.useGPU
  } else if (proc.env && proc.env.NO_GPU === 'true') {
    config.useGPU = false
  }
  if (params.outputSampleRate !== undefined) {
    config.outputSampleRate = params.outputSampleRate
  }

  const options = {
    engine: TTSGgml.ENGINE_COSYVOICE3,
    files: { cosyvoiceModelDir },
    config,
    opts: { stats: true }
  }
  // instruct2 control (emotion / dialect / speed / volume / style / raw string)
  // is a constructor-level option: the engine renders it once at construction.
  if (params.instruct !== undefined) options.instruct = params.instruct

  const model = new TTSGgml(options)
  await model.load()
  return model
}

async function runCosyvoiceTTS(model, params = {}, expectation = {}) {
  const tag = '[CosyVoice] '
  const sampleRate = params.expectedSampleRate || COSYVOICE_SAMPLE_RATE

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
      .onUpdate((data) => {
        if (data && data.outputArray) {
          outputArray = outputArray.concat(Array.from(data.outputArray))
        }
        if (data && data.sampleRate) reportedSampleRate = data.sampleRate
      })
      .await()

    const sampleCount = outputArray.length
    const stats = response.stats || null
    const effectiveRate = reportedSampleRate || sampleRate
    const durationMs = stats?.audioDurationMs || sampleCount / (effectiveRate / 1000)

    let passed = true
    if (expectation.minSamples !== undefined && sampleCount < expectation.minSamples) passed = false
    if (expectation.maxSamples !== undefined && sampleCount > expectation.maxSamples) passed = false
    if (expectation.minDurationMs !== undefined && durationMs < expectation.minDurationMs)
      passed = false
    if (expectation.maxDurationMs !== undefined && durationMs > expectation.maxDurationMs)
      passed = false

    const wavBuffer = createWavBuffer(outputArray, effectiveRate)

    if (params.saveWav === true) {
      const wavPath = params.wavOutputPath || path.join(__dirname, '../output/cosyvoice.wav')
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
  loadCosyvoiceTTS,
  runCosyvoiceTTS,
  COSYVOICE_SAMPLE_RATE
}
