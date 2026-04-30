'use strict'

const path = require('bare-path')
const ONNXTTS = require('../..')
const { getBaseDir, runTTS, checkExpectations, saveWavIfNeeded } = require('./runTTS')
const { createWavBuffer } = require('./wav-helper')
const { concatenatePcmChunks } = require('./pcmConcatenator')

const SUPERTONIC_SAMPLE_RATE = 44100

async function loadSupertonicTTS (params = {}) {
  const defaultModelDir = path.resolve(path.join(getBaseDir(), 'models', 'supertonic'))

  const model = new ONNXTTS({
    files: {
      modelDir: params.modelDir || defaultModelDir
    },
    engine: 'supertonic',
    voiceName: params.voiceName || 'F1',
    speed: params.speed != null ? params.speed : 1,
    numInferenceSteps: params.numInferenceSteps != null ? params.numInferenceSteps : 5,
    supertonicMultilingual: params.supertonicMultilingual === true,
    config: {
      language: params.language || 'en'
    },
    opts: { stats: true }
  })
  await model.load()

  return model
}

async function runSupertonicTTS (model, params, expectation = {}) {
  return runTTS(model, params, expectation, {
    sampleRate: SUPERTONIC_SAMPLE_RATE,
    engineTag: 'Supertonic'
  })
}

/**
 * Integration helper: {@link ONNXTTS#runStreaming} (streaming text in + PCM on `onUpdate`),
 * concatenating chunk PCM in chunk order.
 *
 * Uses default `runStreaming` options (`accumulateSentences` true for this async generator). Each
 * phrase should end with sentence punctuation so the stream accumulator flushes once per yield;
 * then chunk count matches `phrases.length`. Optional `params.streamingOptions` is forwarded as
 * the second argument to `runStreaming` for tests that need explicit overrides.
 */
async function runSupertonicStreaming (model, params, expectation = {}) {
  const sampleRate = SUPERTONIC_SAMPLE_RATE
  const tag = '[Supertonic] '

  if (!model) {
    return {
      output: `${tag}Error: Missing required parameter: model`,
      passed: false
    }
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
    const samples = Array.from(combined)
    const wavBuffer = createWavBuffer(samples, sampleRate)
    saveWavIfNeeded(params, wavBuffer, tag)

    const stats = response.stats || jobStats
    const roundedStats = stats
      ? {
          totalTime: stats.totalTime ? Number(stats.totalTime.toFixed(4)) : stats.totalTime,
          tokensPerSecond: stats.tokensPerSecond
            ? Number(stats.tokensPerSecond.toFixed(2))
            : stats.tokensPerSecond,
          realTimeFactor: stats.realTimeFactor
            ? Number(stats.realTimeFactor.toFixed(5))
            : stats.realTimeFactor,
          audioDurationMs: stats.audioDurationMs,
          totalSamples: stats.totalSamples
        }
      : null

    const streamChunkCount = pcmChunks.length
    const sentenceChunks = indices.map(i => textByChunk.get(i) || '')
    const statsInfo = stats
      ? `duration: ${durationMs.toFixed(0)}ms, RTF: ${stats.realTimeFactor?.toFixed(4) || 'N/A'}, chunks: ${streamChunkCount}`
      : `duration: ${durationMs.toFixed(0)}ms (calculated), chunks: ${streamChunkCount}`
    const output = `${tag}IO stream ${sampleCount} samples (${statsInfo}) from ${phrases.length} phrase(s)`

    return {
      output,
      passed,
      data: {
        samples,
        sampleCount,
        durationMs,
        sampleRate,
        wavBuffer,
        stats: roundedStats,
        streamChunkCount,
        phrases,
        sentenceChunks
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

/**
 * Integration helper: chunked **output-only** streaming — `run({ input, streamOutput: true })`
 * (same orchestrator as {@link ONNXTTS#runStream}), then `onUpdate` + `await`, concatenating PCM in chunk order.
 */
async function runSupertonicStream (model, params, expectation = {}) {
  const sampleRate = SUPERTONIC_SAMPLE_RATE
  const tag = '[Supertonic] '

  if (!model) {
    return {
      output: `${tag}Error: Missing required parameter: model`,
      passed: false
    }
  }

  if (!params || !params.text) {
    return {
      output: `${tag}Error: Missing required parameter: text`,
      passed: false
    }
  }

  try {
    const streamOpts =
      params.streamOptions && typeof params.streamOptions === 'object'
        ? params.streamOptions
        : {}

    const response = await model.run({
      input: params.text,
      streamOutput: true,
      locale: streamOpts.locale,
      maxChunkScalars: streamOpts.maxChunkScalars
    })
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
    const samples = Array.from(combined)
    const wavBuffer = createWavBuffer(samples, sampleRate)
    saveWavIfNeeded(params, wavBuffer, tag)

    const stats = response.stats || jobStats
    const roundedStats = stats
      ? {
          totalTime: stats.totalTime ? Number(stats.totalTime.toFixed(4)) : stats.totalTime,
          tokensPerSecond: stats.tokensPerSecond
            ? Number(stats.tokensPerSecond.toFixed(2))
            : stats.tokensPerSecond,
          realTimeFactor: stats.realTimeFactor
            ? Number(stats.realTimeFactor.toFixed(5))
            : stats.realTimeFactor,
          audioDurationMs: stats.audioDurationMs,
          totalSamples: stats.totalSamples
        }
      : null

    const streamChunkCount = pcmChunks.length
    const sentenceChunks = indices.map(i => textByChunk.get(i) || '')
    const statsInfo = stats
      ? `duration: ${durationMs.toFixed(0)}ms, RTF: ${stats.realTimeFactor?.toFixed(4) || 'N/A'}, chunks: ${streamChunkCount}`
      : `duration: ${durationMs.toFixed(0)}ms (calculated), chunks: ${streamChunkCount}`
    const output = `${tag}Output-only stream ${sampleCount} samples (${statsInfo}) from text: "${params.text.substring(0, 50)}${params.text.length > 50 ? '...' : ''}"`

    return {
      output,
      passed,
      data: {
        samples,
        sampleCount,
        durationMs,
        sampleRate,
        wavBuffer,
        stats: roundedStats,
        streamChunkCount,
        sentenceChunks
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
  loadSupertonicTTS,
  runSupertonicTTS,
  runSupertonicStream,
  runSupertonicStreaming
}
