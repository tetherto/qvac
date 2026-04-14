'use strict'

const logger = require('../utils/logger')
const fs = require('bare-fs')
const { Readable } = require('bare-stream')
const process = require('bare-process')
const path = require('bare-path')

const loadedModels = new Map()

const runLiveAudio = async (payload) => {
  const { audio, config } = payload

  if (!audio) {
    throw new Error('Audio data is required')
  }

  if (!config || !config.model || !config.model.path) {
    throw new Error('Model configuration with path is required')
  }

  const audioBuffer = Buffer.from(audio, 'base64')

  const modelPath = config.model.path
  const audioFormat = config.model.audio_format || 's16le'
  const sampleRate = config.model.sample_rate || 16000
  const language = config.model.language || 'en'
  const vadModelPath = config.model.vad_model_path || ''
  const vadParams = config.model.vad_params || null

  const audioDurationSeconds = audioBuffer.length / (sampleRate * 2)
  logger.info(`Processing live audio chunk: ${audioBuffer.length} bytes, ${audioDurationSeconds.toFixed(2)}s duration, VAD=${!!vadModelPath}`)

  const cacheKey = `live:${modelPath}:${language}:vad=${!!vadModelPath}`

  let modelInstance = loadedModels.get(cacheKey)

  if (!modelInstance) {
    const loadStart = process.hrtime()

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model file not found at path: ${modelPath}`)
    }

    const TranscriptionWhispercpp = require('@qvac/transcription-whispercpp')

    const resolvedModelPath = path.resolve(modelPath)
    const constructorArgs = {
      files: {
        model: resolvedModelPath
      }
    }

    if (vadModelPath) {
      constructorArgs.files.vadModel = path.resolve(vadModelPath)
    }

    const modelConfig = {
      path: modelPath,
      whisperConfig: {
        audio_format: audioFormat,
        language,
        temperature: 0.0,
        suppress_nst: true,
        no_context: false
      }
    }

    if (vadModelPath) {
      modelConfig.vadModelPath = vadModelPath
      modelConfig.whisperConfig.vad_model_path = vadModelPath
      modelConfig.whisperConfig.vad_params = vadParams || {
        threshold: 0.25,
        min_speech_duration_ms: 100,
        min_silence_duration_ms: 100,
        max_speech_duration_s: 30,
        speech_pad_ms: 400,
        samples_overlap: 0.3
      }
      logger.info('VAD enabled with params:', modelConfig.whisperConfig.vad_params)
    } else {
      logger.info('VAD disabled')
    }

    logger.info('Creating model instance for live audio:', {
      constructorArgs,
      whisperConfig: modelConfig.whisperConfig
    })

    modelInstance = new TranscriptionWhispercpp(constructorArgs, modelConfig)
    await modelInstance._load()

    const [loadSec, loadNano] = process.hrtime(loadStart)
    const loadModelMs = loadSec * 1e3 + loadNano / 1e6
    loadedModels.set(cacheKey, modelInstance)
    logger.info(`Loaded model in ${loadModelMs.toFixed(2)}ms`)
  }

  const segments = []
  const runStart = process.hrtime()

  const audioStream = Readable.from([audioBuffer])

  const response = await modelInstance.run(audioStream)

  await response
    .onUpdate(outputArr => {
      const items = Array.isArray(outputArr) ? outputArr : [outputArr]
      logger.info(`Segment update: ${items.length} items received`)
      for (const item of items) {
        logger.info(`  - text="${item.text}" start=${item.start} end=${item.end}`)
      }
      segments.push(...items)
    })
    .await()

  const [runSec, runNano] = process.hrtime(runStart)
  const runMs = runSec * 1e3 + runNano / 1e6

  const text = segments
    .map(s => s.text || s)
    .filter(t => t && t.trim().length > 0)
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ')

  if (segments.length === 0) {
    if (vadModelPath) {
      logger.warn(`No segments detected! Audio duration: ${audioDurationSeconds.toFixed(2)}s. VAD is enabled and filtering all audio. DISABLE VAD for live streaming with short chunks.`)
    } else {
      logger.warn(`No segments detected! Audio duration: ${audioDurationSeconds.toFixed(2)}s. Check audio input and model configuration.`)
    }
  } else {
    logger.info(`Live audio processed in ${runMs.toFixed(2)}ms, ${segments.length} segments, text="${text.substring(0, 50)}"`)
  }

  return {
    outputs: [{
      text,
      segments,
      duration: runMs
    }],
    time: {
      runMs
    }
  }
}

module.exports = {
  runLiveAudio
}
