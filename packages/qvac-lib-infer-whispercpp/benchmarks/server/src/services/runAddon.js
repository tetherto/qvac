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
  if (installed && (!requestedVersion || installed === requestedVersion)) {
    return installed
  }
  const versionSpec = requestedVersion ? `@${requestedVersion}` : ''
  logger.info(`Installing ${lib}${versionSpec}...`)
  await new Promise((resolve, reject) => {
    const npm = spawn('npm', ['install', `${lib}${versionSpec}`], { stdio: 'inherit' })
    npm
      .on('exit', code => code === 0 ? resolve() : reject(new Error(`npm install ${lib}${versionSpec} failed (${code})`)))
      .on('error', reject)
  })
  const newVersion = getPackageVersion(lib)
  if (!newVersion) {
    throw new Error(`Failed to verify installation of ${lib}${versionSpec}`)
  }
  return newVersion
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

const runAddon = async (payload) => {
  const { inputs, whisper, config } =
    InferenceArgsSchema.parse(payload)

  const { lib: whisperLib, version: whisperVerReq } = whisper

  const whisperVersion = await ensurePackage(whisperLib, whisperVerReq)
  const TranscriptionWhispercpp = require(whisperLib)

  logger.info(`Running addon with ${inputs.length} inputs`)

  const vadModelPath = config.whisperConfig?.vad_model_path || ''
  const streaming = config.streaming || false
  const streamingChunkSize = config.streamingChunkSize || 16384
  const modelPath = config.path || ''
  const vadEnabled = !!vadModelPath
  const cacheKey = `${whisperLib}:model=${modelPath}:vad=${vadEnabled}:vadModel=${vadModelPath}`

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

    if (vadModelPath) {
      constructorArgs.vadModelName = path.basename(vadModelPath)
    }

    const unsupportedParams = ['mode', 'output_format', 'min_seconds', 'max_seconds']
    const whisperConfig = config.whisperConfig || {}
    const filteredWhisperConfig = Object.keys(whisperConfig)
      .filter(key => !unsupportedParams.includes(key))
      .reduce((obj, key) => {
        obj[key] = whisperConfig[key]
        return obj
      }, {})

    const removedParams = Object.keys(whisperConfig).filter(key => unsupportedParams.includes(key))
    if (removedParams.length > 0) {
      logger.debug(`Filtered out unsupported params: ${removedParams.join(', ')}`)
    }

    const modelConfig = {
      path: config.path,
      whisperConfig: filteredWhisperConfig
    }

    if (vadModelPath) {
      modelConfig.vadModelPath = vadModelPath
    }

    logger.info('Creating model instance:', {
      constructorArgs,
      whisperConfig: modelConfig.whisperConfig,
      vadModelPath,
      streaming,
      hasVadModelPath: !!modelConfig.vadModelPath
    })

    modelInstance = new TranscriptionWhispercpp(constructorArgs, modelConfig)
    await modelInstance._load()

    const [loadSec, loadNano] = process.hrtime(loadStart)
    loadModelMs = loadSec * 1e3 + loadNano / 1e6
    loadedModels.set(cacheKey, modelInstance)
    logger.info(`Loaded new model: ${modelPath} (${whisperLib}, VAD=${vadEnabled})`)
  } else {
    logger.debug(`Reusing cached model: ${modelPath} (${whisperLib}, VAD=${vadEnabled})`)
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
    whisperVersion,
    time: {
      loadModelMs,
      runMs
    }
  }
}

module.exports = {
  runAddon
}
