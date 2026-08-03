'use strict'

const { ParakeetInferenceArgsSchema } = require('../validation')
const logger = require('../utils/logger')
const fs = require('bare-fs')
const { Readable } = require('bare-stream')
const process = require('bare-process')
const path = require('bare-path')

const ALLOWED_LIBS = [
  '@qvac/asr-ggml'
]

const loadedModels = new Map()

const ALLOWED_AUDIO_DIRS = [
  path.resolve('.'),
  path.resolve('./models'),
  path.resolve('./examples')
]

const validateFilePath = (filePath) => {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    throw new Error('File not found')
  }
  const isAllowed = ALLOWED_AUDIO_DIRS.some(dir => resolved.startsWith(dir + path.sep) || resolved === dir)
  if (!isAllowed) {
    throw new Error('File path is outside allowed directories')
  }
  return resolved
}

const getPackageVersion = (lib) => {
  try {
    const packagePath = require.resolve(`${lib}/package`)
    const pkg = require(packagePath)
    return pkg.version
  } catch (err) {
    logger.debug(`Could not resolve version for ${lib}: ${err?.message || err}`)
    return null
  }
}

const runParakeet = async (payload) => {
  try {
    const { inputs, parakeet, config } =
      ParakeetInferenceArgsSchema.parse(payload)

    const { lib: parakeetLib } = parakeet

    if (!ALLOWED_LIBS.includes(parakeetLib)) {
      throw new Error('Unsupported library: ' + parakeetLib + '. Allowed: ' + ALLOWED_LIBS.join(', '))
    }

    const parakeetVersion = getPackageVersion(parakeetLib) || 'unknown'
    logger.info(`Loading addon: ${parakeetLib}`)
    const ASRGgml = require(parakeetLib)
    logger.info('Addon loaded successfully')

    logger.info(`Running parakeet addon with ${inputs.length} inputs`)

    // config.path points at a single .gguf checkpoint (the GGML backend
    // auto-detects the model type from the GGUF metadata; modelType is kept
    // in the payload only for cache keys / logging).
    const modelPath = config.path || ''
    const modelType = config.parakeetConfig?.modelType || 'tdt'
    const useGPU = config.parakeetConfig?.useGPU || false
    const streaming = config.streaming || false
    const streamingChunkSize = config.streamingChunkSize || 16384

    const cacheKey = `${parakeetLib}:parakeet:model=${modelPath}:type=${modelType}:gpu=${useGPU}`

    let modelInstance = loadedModels.get(cacheKey)
    let loadModelMs = 0

    if (!modelInstance) {
      const loadStart = process.hrtime()

      if (!config.path) {
        throw new Error('Model path is required in config')
      }
      const resolvedModelPath = validateFilePath(config.path)

      const parakeetConfig = config.parakeetConfig || {}

      // The addon's ParakeetConfig has no modelType key (auto-detected from
      // the GGUF), so it is not forwarded.
      const modelConfig = {
        engine: 'parakeet',
        parakeetConfig: {
          maxThreads: parakeetConfig.maxThreads || 4,
          useGPU: parakeetConfig.useGPU || false,
          sampleRate: config.sampleRate || 16000,
          channels: 1,
          captionEnabled: parakeetConfig.captionEnabled || false,
          timestampsEnabled: parakeetConfig.timestampsEnabled !== false,
          seed: parakeetConfig.seed ?? -1
        }
      }

      logger.info('Creating model instance:', {
        model: resolvedModelPath,
        parakeetConfig: modelConfig.parakeetConfig,
        streaming
      })

      modelInstance = new ASRGgml({
        files: { model: resolvedModelPath },
        config: modelConfig
      })
      await modelInstance.load()

      const [loadSec, loadNano] = process.hrtime(loadStart)
      loadModelMs = loadSec * 1e3 + loadNano / 1e6
      loadedModels.set(cacheKey, modelInstance)
      logger.info(`Loaded new model: ${modelPath} (${parakeetLib}, type=${modelType}, GPU=${useGPU})`)
    } else {
      logger.debug(`Reusing cached model: ${modelPath} (${parakeetLib}, type=${modelType}, GPU=${useGPU})`)
    }

    const outputs = []
    const runStart = process.hrtime()

    for (const audioFilePath of inputs) {
      const resolvedAudioPath = validateFilePath(audioFilePath)
      const audioBuffer = fs.readFileSync(resolvedAudioPath)
      const segments = []

      let audioStream
      if (streaming) {
        logger.info(`Processing ${audioFilePath} in streaming mode with chunk size ${streamingChunkSize}`)

        async function * streamChunks (buffer) {
          let offset = 0
          while (offset < buffer.length) {
            const end = Math.min(offset + streamingChunkSize, buffer.length)
            yield buffer.slice(offset, end)
            offset = end
          }
        }

        audioStream = Readable.from(streamChunks(audioBuffer))
      } else {
        audioStream = Readable.from([audioBuffer])
      }

      const response = await modelInstance.run(audioStream)

      await response
        .onUpdate(outputArr => {
          const items = Array.isArray(outputArr) ? outputArr : [outputArr]
          logger.debug(`Segment update: ${JSON.stringify(items.map(i => ({ text: i.text, start: i.start, end: i.end })))}`)
          segments.push(...items)
        })
        .await()

      const text = segments
        .map(s => s.text || s)
        .filter(t => t && t.trim().length > 0)
        .join(' ')
        .trim()
        .replace(/\s+/g, ' ')

      logger.debug(`Transcription for ${audioFilePath}: segments=${segments.length}, text="${text.substring(0, 100)}"`)
      outputs.push(text)
    }

    const [runSec, runNano] = process.hrtime(runStart)
    const runMs = runSec * 1e3 + runNano / 1e6

    return {
      outputs,
      parakeetVersion,
      time: {
        loadModelMs,
        runMs
      }
    }
  } catch (error) {
    logger.error(`runParakeet error: ${error.message}`)
    logger.error(`Stack: ${error.stack}`)
    throw error
  }
}

module.exports = {
  runParakeet
}
