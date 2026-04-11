'use strict'

const { InferenceArgsSchema } = require('../validation')
const logger = require('../utils/logger')
const fs = require('bare-fs')
const { Readable } = require('bare-stream')
const process = require('bare-process')
const path = require('bare-path')

const ALLOWED_LIBS = [
  '@qvac/transcription-parakeet'
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

const getFilesMap = (modelType, modelDir) => {
  switch (modelType) {
    case 'ctc':
      return {
        model: path.join(modelDir, 'model.onnx'),
        modelData: path.join(modelDir, 'model.onnx_data'),
        tokenizer: path.join(modelDir, 'tokenizer.json')
      }
    case 'eou':
      return {
        eouEncoder: path.join(modelDir, 'encoder.onnx'),
        eouDecoder: path.join(modelDir, 'decoder_joint.onnx'),
        tokenizer: path.join(modelDir, 'tokenizer.json')
      }
    case 'sortformer':
      return {
        sortformer: path.join(modelDir, 'sortformer.onnx')
      }
    case 'tdt':
    default:
      return {
        encoder: path.join(modelDir, 'encoder-model.onnx'),
        encoderData: path.join(modelDir, 'encoder-model.onnx.data'),
        decoder: path.join(modelDir, 'decoder_joint-model.onnx'),
        vocab: path.join(modelDir, 'vocab.txt'),
        preprocessor: path.join(modelDir, 'preprocessor.onnx')
      }
  }
}

const runAddon = async (payload) => {
  try {
    const { inputs, parakeet, config } =
      InferenceArgsSchema.parse(payload)

    const { lib: parakeetLib } = parakeet

    if (!ALLOWED_LIBS.includes(parakeetLib)) {
      throw new Error('Unsupported library: ' + parakeetLib + '. Allowed: ' + ALLOWED_LIBS.join(', '))
    }

    const parakeetVersion = getPackageVersion(parakeetLib) || 'unknown'
    logger.info(`Loading addon: ${parakeetLib}`)
    const TranscriptionParakeet = require(parakeetLib)
    logger.info('Addon loaded successfully')

    logger.info(`Running addon with ${inputs.length} inputs`)

    const modelPath = config.path || ''
    const modelType = config.parakeetConfig?.modelType || 'tdt'
    const useGPU = config.parakeetConfig?.useGPU || false
    const streaming = config.streaming || false
    const streamingChunkSize = config.streamingChunkSize || 16384

    const cacheKey = `${parakeetLib}:model=${modelPath}:type=${modelType}:gpu=${useGPU}`

    let modelInstance = loadedModels.get(cacheKey)
    let loadModelMs = 0

    if (!modelInstance) {
      const loadStart = process.hrtime()

      if (!config.path) {
        throw new Error('Model path is required in config')
      }
      validateFilePath(config.path)

      const parakeetConfig = config.parakeetConfig || {}
      const files = getFilesMap(modelType, config.path)

      logger.info('Creating model instance:', {
        files,
        parakeetConfig,
        streaming
      })

      modelInstance = new TranscriptionParakeet({
        files,
        config: {
          parakeetConfig: {
            modelType: parakeetConfig.modelType || 'tdt',
            maxThreads: parakeetConfig.maxThreads || 4,
            useGPU: parakeetConfig.useGPU || false,
            sampleRate: config.sampleRate || 16000,
            channels: 1,
            captionEnabled: parakeetConfig.captionEnabled || false,
            timestampsEnabled: parakeetConfig.timestampsEnabled !== false,
            seed: parakeetConfig.seed ?? -1
          }
        }
      })
      await modelInstance._load()

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
    logger.error(`runAddon error: ${error.message}`)
    logger.error(`Stack: ${error.stack}`)
    throw error
  }
}

module.exports = {
  runAddon
}
