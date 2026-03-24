'use strict'

const { InferenceArgsSchema } = require('../validation')
const { spawn } = require('bare-subprocess')
const logger = require('../utils/logger')
const fs = require('bare-fs')
const { Readable } = require('bare-stream')
const process = require('bare-process')
const path = require('bare-path')

const loadedModels = new Map()

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

const ensurePackage = async (lib, requestedVersion) => {
  const installed = getPackageVersion(lib)

  // If package is already installed, use it (skip version check for local installs)
  if (installed) {
    if (!requestedVersion || installed === requestedVersion) {
      logger.info(`Using installed ${lib}@${installed}`)
      return installed
    }
    // Version mismatch but package is installed - use installed version with warning
    logger.warn(`Requested ${lib}@${requestedVersion} but ${installed} is installed. Using installed version.`)
    return installed
  }

  // Package not installed - try to install from npm
  const versionSpec = requestedVersion ? `@${requestedVersion}` : ''
  logger.info(`Installing ${lib}${versionSpec}...`)
  await new Promise((resolve, reject) => {
    const npm = spawn('npm', ['install', `${lib}${versionSpec}`], { stdio: 'inherit' })
    npm
      .on('exit', code => code === 0 ? resolve() : reject(new Error(`npm install ${lib}${versionSpec} failed (${code})`)))
      .on('error', reject)
  })

  // Try to get version after install, but don't fail if we can't verify
  // (Bare runtime has different module resolution than Node.js)
  const newVersion = getPackageVersion(lib)
  if (newVersion) {
    logger.info(`Installed ${lib}@${newVersion}`)
    return newVersion
  }

  // Package installed but version couldn't be verified - return 'unknown'
  logger.warn(`Installed ${lib} but couldn't verify version (Bare runtime). Proceeding anyway.`)
  return 'unknown'
}

class FakeLoader {
  async start () {}
  async stop () {}
  async ready () {
    return true
  }

  async getStream () {
    throw new Error('FakeLoader.getStream should not be called when using diskPath')
  }

  async download (filepath, destPath) {
    return {
      await: async () => ({
        success: false,
        message: 'FakeLoader does not support downloading. Model files must exist on disk at the specified path.'
      })
    }
  }

  async list () {
    return []
  }
}

const getNamedPaths = (modelType, modelDir) => {
  switch (modelType) {
    case 'ctc':
      return {
        ctcModelPath: path.join(modelDir, 'model.onnx'),
        ctcModelDataPath: path.join(modelDir, 'model.onnx_data'),
        tokenizerPath: path.join(modelDir, 'tokenizer.json')
      }
    case 'eou':
      return {
        eouEncoderPath: path.join(modelDir, 'encoder.onnx'),
        eouDecoderPath: path.join(modelDir, 'decoder_joint.onnx'),
        tokenizerPath: path.join(modelDir, 'tokenizer.json')
      }
    case 'sortformer':
      return {
        sortformerPath: path.join(modelDir, 'sortformer.onnx')
      }
    case 'tdt':
    default:
      return {
        encoderPath: path.join(modelDir, 'encoder-model.onnx'),
        encoderDataPath: path.join(modelDir, 'encoder-model.onnx.data'),
        decoderPath: path.join(modelDir, 'decoder_joint-model.onnx'),
        vocabPath: path.join(modelDir, 'vocab.txt'),
        preprocessorPath: path.join(modelDir, 'preprocessor.onnx')
      }
  }
}

const runAddon = async (payload) => {
  try {
    const { inputs, parakeet, config } =
      InferenceArgsSchema.parse(payload)

    const { lib: parakeetLib, version: parakeetVerReq } = parakeet

    const parakeetVersion = await ensurePackage(parakeetLib, parakeetVerReq)
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

      const constructorArgs = {
        loader: new FakeLoader(),
        modelName: path.basename(config.path),
        diskPath: path.dirname(config.path)
      }

      const parakeetConfig = config.parakeetConfig || {}

      const namedPaths = getNamedPaths(modelType, config.path)

      const modelConfig = {
        path: config.path,
        ...namedPaths,
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

      logger.info('Creating model instance:', {
        constructorArgs,
        parakeetConfig: modelConfig.parakeetConfig,
        streaming
      })

      modelInstance = new TranscriptionParakeet(constructorArgs, modelConfig)
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
      const audioBuffer = fs.readFileSync(audioFilePath)
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
