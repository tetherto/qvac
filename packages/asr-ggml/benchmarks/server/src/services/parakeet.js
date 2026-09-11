'use strict'

const { ParakeetInferenceArgsSchema } = require('../validation')
const logger = require('../utils/logger')
const fs = require('bare-fs')
const { Readable } = require('bare-stream')
const process = require('bare-process')
const path = require('bare-path')
const {
  buildStreamingOptions,
  chunkBytesForMs,
  sliceBuffer,
  containsTranscript,
  collectAppendSegments,
  joinSegments
} = require('./parakeetStreaming')

const ALLOWED_LIBS = ['@qvac/asr-ggml']

const DEFAULT_SAMPLE_RATE = 16000

const loadedModels = new Map()

const ALLOWED_INPUT_DIRS = [path.resolve('../..')]

const validateFilePath = (filePath) => {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    throw new Error('File not found')
  }
  const isAllowed = ALLOWED_INPUT_DIRS.some(
    (dir) => resolved.startsWith(dir + path.sep) || resolved === dir
  )
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

const elapsedMs = (start) => {
  const [sec, nano] = process.hrtime(start)
  return sec * 1e3 + nano / 1e6
}

const loadModelInstance = async (ASRGgml, config) => {
  const resolvedModelPath = validateFilePath(config.path)

  const parakeetConfig = config.parakeetConfig || {}

  // The addon's ParakeetConfig has no modelType key (auto-detected from
  // the GGUF), so it is not forwarded.
  const modelConfig = {
    engine: 'parakeet',
    parakeetConfig: {
      maxThreads: parakeetConfig.maxThreads || 4,
      useGPU: parakeetConfig.useGPU || false,
      sampleRate: config.sampleRate || DEFAULT_SAMPLE_RATE,
      channels: 1,
      captionEnabled: parakeetConfig.captionEnabled || false,
      timestampsEnabled: parakeetConfig.timestampsEnabled !== false,
      seed: parakeetConfig.seed ?? -1,
      language: parakeetConfig.language || ''
    }
  }

  logger.info('Creating model instance:', {
    model: resolvedModelPath,
    parakeetConfig: modelConfig.parakeetConfig,
    streaming: config.streaming || false
  })

  const modelInstance = new ASRGgml({
    files: { model: resolvedModelPath },
    config: modelConfig
  })
  await modelInstance.load()
  return modelInstance
}

// Batch mode: one run() call over the whole buffer; every emitted segment is
// final, so all of them join the transcript.
const transcribeBatch = async (modelInstance, audioBuffer) => {
  const segments = []
  const response = await modelInstance.run(Readable.from([audioBuffer]))

  await response
    .onUpdate((outputArr) => {
      const items = Array.isArray(outputArr) ? outputArr : [outputArr]
      logger.debug(
        `Segment update: ${JSON.stringify(items.map((i) => ({ text: i.text, start: i.start, end: i.end })))}`
      )
      segments.push(...items)
    })
    .await()

  const text = segments
    .map((s) => s.text || s)
    .filter((t) => t && t.trim().length > 0)
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ')

  return { text, firstPartialMs: null }
}

// Streaming mode: a duplex runStreaming() session driven by the addon's
// ms-based controls. firstPartialMs counts from just before the session
// opens to the first update carrying a transcript segment — the engine
// streams finalized per-chunk increments (a separate partial-hypothesis
// channel is not implemented), so this is the first transcript output a
// streaming consumer would see. The audio is fed as fast as the session
// accepts it, without real-time pacing.
const transcribeStreaming = async (modelInstance, audioBuffer, sampleRate, streamingOptions) => {
  const chunkBytes = chunkBytesForMs(sampleRate, streamingOptions.chunkMs)
  const audioStream = Readable.from(sliceBuffer(audioBuffer, chunkBytes))

  const transcriptSegments = []
  let firstPartialMs = null
  const streamStart = process.hrtime()

  const response = await modelInstance.runStreaming(audioStream, streamingOptions)

  await response
    .onUpdate((outputArr) => {
      const items = Array.isArray(outputArr) ? outputArr : [outputArr]
      if (firstPartialMs === null && containsTranscript(items)) {
        firstPartialMs = elapsedMs(streamStart)
      }
      collectAppendSegments(transcriptSegments, items)
    })
    .await()

  return { text: joinSegments(transcriptSegments), firstPartialMs }
}

const transcribeInputs = async (modelInstance, inputs, config) => {
  const streaming = config.streaming || false
  const sampleRate = config.sampleRate || DEFAULT_SAMPLE_RATE
  const streamingOptions = buildStreamingOptions(config)

  const outputs = []
  const firstPartialMs = []

  for (const audioFilePath of inputs) {
    const resolvedAudioPath = validateFilePath(audioFilePath)
    const audioBuffer = fs.readFileSync(resolvedAudioPath)

    if (streaming) {
      logger.info(
        `Processing ${audioFilePath} in streaming mode: ${JSON.stringify(streamingOptions)}`
      )
    }

    const result = streaming
      ? await transcribeStreaming(modelInstance, audioBuffer, sampleRate, streamingOptions)
      : await transcribeBatch(modelInstance, audioBuffer)

    logger.debug(`Transcription for ${audioFilePath}: text="${result.text.substring(0, 100)}"`)
    outputs.push(result.text)
    firstPartialMs.push(result.firstPartialMs)
  }

  return { outputs, firstPartialMs }
}

const runParakeet = async (payload) => {
  try {
    const { inputs, parakeet, config } = ParakeetInferenceArgsSchema.parse(payload)

    const { lib: parakeetLib } = parakeet

    if (!ALLOWED_LIBS.includes(parakeetLib)) {
      throw new Error(
        'Unsupported library: ' + parakeetLib + '. Allowed: ' + ALLOWED_LIBS.join(', ')
      )
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
    const language = config.parakeetConfig?.language || ''
    const useGPU = config.parakeetConfig?.useGPU || false
    const streaming = config.streaming || false

    // `streaming` joins the key so batch and streaming lanes never share a
    // model instance (or each other's native session state).
    const cacheKey = `${parakeetLib}:parakeet:model=${modelPath}:type=${modelType}:language=${language}:gpu=${useGPU}:streaming=${streaming}`

    let modelInstance = loadedModels.get(cacheKey)
    let loadModelMs = 0

    if (!modelInstance) {
      const loadStart = process.hrtime()

      if (!config.path) {
        throw new Error('Model path is required in config')
      }

      modelInstance = await loadModelInstance(ASRGgml, config)

      loadModelMs = elapsedMs(loadStart)
      loadedModels.set(cacheKey, modelInstance)
      logger.info(
        `Loaded new model: ${modelPath} (${parakeetLib}, type=${modelType}, GPU=${useGPU}, streaming=${streaming})`
      )
    } else {
      logger.debug(
        `Reusing cached model: ${modelPath} (${parakeetLib}, type=${modelType}, GPU=${useGPU}, streaming=${streaming})`
      )
    }

    const runStart = process.hrtime()
    const { outputs, firstPartialMs } = await transcribeInputs(modelInstance, inputs, config)
    const runMs = elapsedMs(runStart)

    const time = { loadModelMs, runMs }
    if (streaming) {
      time.firstPartialMs = firstPartialMs
    }

    return {
      outputs,
      parakeetVersion,
      time
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
