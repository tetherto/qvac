'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')

const { ParakeetInterface } = require('./parakeet')
const { QvacErrorAddonParakeet, ERR_CODES, END_OF_INPUT } = require('./lib/error')

/**
 * Required model files for TDT model
 */
const TDT_MODEL_FILES = [
  'encoder-model.onnx',
  'encoder-model.onnx.data',
  'decoder_joint-model.onnx',
  'vocab.txt',
  'preprocessor.onnx'
]

/**
 * Required model files for CTC model
 */
const CTC_MODEL_FILES = [
  'model.onnx',
  'model.onnx_data',
  'tokenizer.json'
]

/**
 * Required model files for EOU model
 */
const EOU_MODEL_FILES = [
  'encoder.onnx',
  'decoder_joint.onnx',
  'tokenizer.json'
]

/**
 * Required model files for Sortformer model
 */
const SORTFORMER_MODEL_FILES = [
  'sortformer.onnx'
]

/**
 * Get required model files based on model type
 * @param {string} modelType - 'tdt', 'ctc', 'eou', or 'sortformer'
 * @returns {string[]} - array of required file names
 */
function getRequiredModelFiles (modelType) {
  switch (modelType) {
    case 'ctc':
      return CTC_MODEL_FILES
    case 'eou':
      return EOU_MODEL_FILES
    case 'sortformer':
      return SORTFORMER_MODEL_FILES
    case 'tdt':
    default:
      return TDT_MODEL_FILES
  }
}

/**
 * ONNX Runtime client implementation for the Parakeet speech-to-text model.
 * Supports NVIDIA Parakeet ASR models in ONNX format.
 */
class TranscriptionParakeet extends BaseInference {
  /**
   * Creates an instance of TranscriptionParakeet.
   * @constructor
   * @param {Object} args - arguments for inference setup
   * @param {Object} args.loader - External loader instance for weight streaming
   * @param {Object} [args.logger=null] - Optional structured logger
   * @param {string} args.modelName - Name of the model directory
   * @param {string} [args.diskPath=''] - Disk directory where model files are stored
   * @param {boolean} [args.exclusiveRun=true] - Whether to run exclusively
   * @param {Object} config - environment-specific inference setup configuration
   * @param {string} [config.path] - Direct path to model (alternative to diskPath + modelName)
   * @param {string} [config.encoderPath] - Absolute path to encoder ONNX graph file
   * @param {string} [config.encoderDataPath] - Absolute path to encoder ONNX weights file
   * @param {string} [config.decoderPath] - Absolute path to decoder-joint ONNX file
   * @param {string} [config.vocabPath] - Absolute path to vocabulary file
   * @param {string} [config.preprocessorPath] - Absolute path to preprocessor ONNX file
   * @param {string} [config.ctcModelPath] - Absolute path to CTC model.onnx file
   * @param {string} [config.ctcModelDataPath] - Absolute path to CTC model.onnx_data file
   * @param {string} [config.tokenizerPath] - Absolute path to tokenizer.json file (CTC/EOU)
   * @param {string} [config.eouEncoderPath] - Absolute path to EOU encoder.onnx file
   * @param {string} [config.eouDecoderPath] - Absolute path to EOU decoder_joint.onnx file
   * @param {string} [config.sortformerPath] - Absolute path to sortformer.onnx file
   * @param {Object} config.parakeetConfig - Parakeet-specific configuration
   * @param {string} [config.parakeetConfig.modelType='tdt'] - Model type: 'tdt', 'ctc', 'eou', or 'sortformer'
   * @param {number} [config.parakeetConfig.maxThreads=4] - Max CPU threads for inference
   * @param {boolean} [config.parakeetConfig.useGPU=false] - Enable GPU acceleration
   * @param {boolean} [config.parakeetConfig.captionEnabled=false] - Enable caption/subtitle mode
   * @param {boolean} [config.parakeetConfig.timestampsEnabled=true] - Include timestamps in output
   * @param {number} [config.parakeetConfig.seed=-1] - Random seed (-1 for random)
   */
  constructor (
    { loader, logger = null, modelName, diskPath = '', exclusiveRun = true, ...args },
    config
  ) {
    super({ logger, loader, exclusiveRun, ...args })

    this._diskPath = diskPath
    this._modelName = modelName
    this._config = config
    this.weightsProvider = new WeightsProvider(loader, this.logger)

    this.params = config.parakeetConfig || {}
    this._hasActiveResponse = false

    this.logger.debug('TranscriptionParakeet constructor called', {
      params: this.params,
      config: this._config,
      diskPath: this._diskPath
    })

    this.validateModelFiles()
  }

  /**
   * Validate that required model files exist
   * @throws {QvacErrorAddonParakeet} if required files are missing
   */
  validateModelFiles () {
    const modelPath = this._config.path || this._getModelFilePath()

    // When using named path overrides, skip directory-level validation
    if (this._hasNamedPaths()) {
      const modelType = this.params.modelType || 'tdt'
      const requiredFiles = getRequiredModelFiles(modelType)
      for (const file of requiredFiles) {
        const filePath = this._resolveFilePath(modelPath, file)
        if (!fs.existsSync(filePath)) {
          this.logger.warn(`Model file not found: ${file} (${filePath})`)
        }
      }
      return
    }

    if (!modelPath) {
      return // Skip validation if no path specified yet
    }

    if (!fs.existsSync(modelPath)) {
      throw new QvacErrorAddonParakeet({
        code: ERR_CODES.MODEL_NOT_FOUND,
        adds: modelPath
      })
    }

    // Check for required files based on model type
    const modelType = this.params.modelType || 'tdt'
    const requiredFiles = getRequiredModelFiles(modelType)

    for (const file of requiredFiles) {
      const filePath = path.join(modelPath, file)
      if (!fs.existsSync(filePath)) {
        this.logger.warn(`Model file not found: ${file}`)
      }
    }
  }

  /**
   * Get the model file path
   * @returns {string} - path to the model directory
   * @private
   */
  _getModelFilePath () {
    if (!this._modelName) {
      return ''
    }
    return path.join(this._diskPath, this._modelName)
  }

  /**
   * Resolve the absolute path for a model file.
   * Uses named config path if available, otherwise falls back to
   * path.join(modelPath, filename).
   * @param {string} modelPath - base model directory path
   * @param {string} filename - model file name (e.g. 'encoder-model.onnx')
   * @returns {string} - absolute path to the file
   * @private
   */
  _resolveFilePath (modelPath, filename) {
    const namedPaths = {
      // TDT
      'encoder-model.onnx': this._config.encoderPath,
      'encoder-model.onnx.data': this._config.encoderDataPath,
      'decoder_joint-model.onnx': this._config.decoderPath,
      'vocab.txt': this._config.vocabPath,
      'preprocessor.onnx': this._config.preprocessorPath,
      // CTC
      'model.onnx': this._config.ctcModelPath,
      'model.onnx_data': this._config.ctcModelDataPath,
      // CTC / EOU shared
      'tokenizer.json': this._config.tokenizerPath,
      // EOU
      'encoder.onnx': this._config.eouEncoderPath,
      'decoder_joint.onnx': this._config.eouDecoderPath,
      // Sortformer
      'sortformer.onnx': this._config.sortformerPath
    }
    if (namedPaths[filename]) {
      return namedPaths[filename]
    }
    return path.join(modelPath, filename)
  }

  /**
   * Whether individual file paths have been provided for any model type.
   * When true, C++ loads directly from these paths (skip JS weight loading).
   * @returns {boolean}
   * @private
   */
  _hasNamedPaths () {
    return !!(
      this._config.encoderPath || this._config.encoderDataPath ||
      this._config.decoderPath || this._config.vocabPath || this._config.preprocessorPath ||
      this._config.ctcModelPath || this._config.ctcModelDataPath || this._config.tokenizerPath ||
      this._config.eouEncoderPath || this._config.eouDecoderPath ||
      this._config.sortformerPath
    )
  }

  /**
   * Load model, weights, and activate addon.
   * @param {boolean} [closeLoader=false] - Close loader when done.
   * @param {Function} [reportProgressCallback] - Hook for progress updates.
   */
  async _load (closeLoader = false, reportProgressCallback) {
    this.logger.debug('Loader ready')

    await this.downloadWeights(reportProgressCallback, { closeLoader })

    const modelPath = this._config.path || this._getModelFilePath()
    const modelType = this.params.modelType || 'tdt'

    const configurationParams = {
      modelPath,
      modelType,
      maxThreads: this.params.maxThreads || 4,
      useGPU: this.params.useGPU || false,
      sampleRate: this.params.sampleRate || 16000,
      channels: this.params.channels || 1,
      captionEnabled: this.params.captionEnabled || false,
      timestampsEnabled: this.params.timestampsEnabled !== false, // default true
      seed: this.params.seed ?? -1
    }

    // Pass individual file paths to C++ which loads directly from disk
    if (this._hasNamedPaths()) {
      // TDT
      if (this._config.encoderPath) configurationParams.encoderPath = this._config.encoderPath
      if (this._config.encoderDataPath) configurationParams.encoderDataPath = this._config.encoderDataPath
      if (this._config.decoderPath) configurationParams.decoderPath = this._config.decoderPath
      if (this._config.vocabPath) configurationParams.vocabPath = this._config.vocabPath
      if (this._config.preprocessorPath) configurationParams.preprocessorPath = this._config.preprocessorPath
      // CTC
      if (this._config.ctcModelPath) configurationParams.ctcModelPath = this._config.ctcModelPath
      if (this._config.ctcModelDataPath) configurationParams.ctcModelDataPath = this._config.ctcModelDataPath
      if (this._config.tokenizerPath) configurationParams.tokenizerPath = this._config.tokenizerPath
      // EOU
      if (this._config.eouEncoderPath) configurationParams.eouEncoderPath = this._config.eouEncoderPath
      if (this._config.eouDecoderPath) configurationParams.eouDecoderPath = this._config.eouDecoderPath
      // Sortformer
      if (this._config.sortformerPath) configurationParams.sortformerPath = this._config.sortformerPath
    }

    this.logger.info('Creating Parakeet addon with configuration:', configurationParams)
    this.addon = this._createAddon(configurationParams)

    // Activate the model
    await this.addon.activate()
    this.logger.debug('Addon activated')
  }

  /**
   * Load model weight files into the addon using streams
   * Uses streaming to handle large files (>2GB) that exceed bare-fs readFileSync limits
   * @param {string} modelPath - path to model directory
   * @param {string} modelType - model type
   * @private
   */
  async _loadModelWeights (modelPath, modelType) {
    const requiredFiles = getRequiredModelFiles(modelType)

    for (const file of requiredFiles) {
      const filePath = this._resolveFilePath(modelPath, file)
      if (fs.existsSync(filePath)) {
        this.logger.debug(`Loading ${file}...`)

        try {
          const buffer = await this._readFileAsStream(filePath)
          const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

          await this.addon.loadWeights({
            filename: file,
            chunk,
            completed: true
          })
          this.logger.debug(`Loaded ${file} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`)
        } catch (err) {
          this.logger.error(`Failed to load ${file}: ${err.message}`)
          throw err
        }
      } else {
        this.logger.warn(`Skipping ${file} - not found`)
      }
    }
  }

  /**
   * Read a file using streams to handle large files (>2GB)
   * bare-fs readFileSync has a 2GB limit, so we use streams instead
   * @param {string} filePath - path to the file
   * @returns {Promise<Buffer>} - file contents as a Buffer
   * @private
   */
  async _readFileAsStream (filePath) {
    return new Promise((resolve, reject) => {
      const chunks = []
      const stream = fs.createReadStream(filePath)

      stream.on('data', (chunk) => {
        chunks.push(chunk)
      })

      stream.on('end', () => {
        const buffer = Buffer.concat(chunks)
        resolve(buffer)
      })

      stream.on('error', (err) => {
        reject(err)
      })
    })
  }

  /**
   * Run transcription on an audio stream
   * @param {AsyncIterable<Buffer>} audioStream - Stream of audio data (16kHz mono, Float32 or s16le)
   * @returns {Promise<QvacResponse>} - Response object for tracking the transcription job
   */
  async _runInternal (audioStream) {
    if (this.exclusiveRun && this._hasActiveResponse) {
      throw new QvacErrorAddonParakeet({
        code: ERR_CODES.JOB_ALREADY_RUNNING
      })
    }

    const jobId = await this.addon.append({
      type: 'audio',
      data: new Float32Array(0).buffer
    })

    const response = this._createResponse(jobId)
    this._hasActiveResponse = true
    const finalized = response.await().finally(() => { this._hasActiveResponse = false })
    finalized.catch(() => {})
    response.await = () => finalized

    const normalizedAudioStream = this._normalizeAudioStream(audioStream)
    this._handleAudioStream(normalizedAudioStream).catch((error) => {
      response.failed(error)
      this._deleteJobMapping(jobId)
    })
    return response
  }

  /**
   * Handle incoming audio stream
   * @param {AsyncIterable<Buffer>} audioStream - Audio data stream
   * @private
   */
  async _handleAudioStream (audioStream) {
    this.logger.debug('Start handling audio stream')
    for await (const chunk of audioStream) {
      this.logger.debug('Appending audio chunk', { chunkLength: chunk.length })

      // Convert chunk to Float32Array if needed
      let audioData
      if (chunk instanceof Float32Array) {
        audioData = chunk
      } else {
        // Assume s16le format, convert to float32
        const int16Data = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2)
        audioData = new Float32Array(int16Data.length)
        for (let i = 0; i < int16Data.length; i++) {
          audioData[i] = int16Data[i] / 32768.0
        }
      }

      await this.addon.append({
        type: 'audio',
        data: audioData.buffer
      })
    }
    this.logger.debug('Sending end-of-input signal')
    await this.addon.append({ type: END_OF_INPUT })
  }

  _normalizeAudioStream (audioStream) {
    if (!audioStream) {
      throw new Error('audioStream is required')
    }

    if (typeof audioStream[Symbol.asyncIterator] === 'function') {
      return audioStream
    }

    if (audioStream instanceof Uint8Array || audioStream instanceof Float32Array) {
      return [audioStream]
    }

    if (Array.isArray(audioStream)) {
      return audioStream
    }

    if (typeof audioStream[Symbol.iterator] === 'function') {
      return [Uint8Array.from(audioStream)]
    }

    throw new Error('Unsupported audio input. Expected stream, TypedArray, or chunk array.')
  }

  /**
   * Reload the model with new configuration parameters.
   * Useful for changing settings without destroying the instance.
   * @param {Object} [newConfig={}] - New configuration parameters
   * @param {Object} [newConfig.parakeetConfig] - Parakeet-specific settings
   */
  async reload (newConfig = {}) {
    return await this._withExclusiveRun(async () => {
      this.logger.debug('Reloading addon with new configuration', newConfig)

      // Merge new config with existing params
      if (newConfig.parakeetConfig) {
        this.params = { ...this.params, ...newConfig.parakeetConfig }
      }

      const modelPath = this._config.path || this._getModelFilePath()
      const modelType = this.params.modelType || 'tdt'

      const configurationParams = {
        modelPath,
        modelType,
        maxThreads: this.params.maxThreads || 4,
        useGPU: this.params.useGPU || false,
        sampleRate: this.params.sampleRate || 16000,
        channels: this.params.channels || 1,
        captionEnabled: this.params.captionEnabled || false,
        timestampsEnabled: this.params.timestampsEnabled !== false, // default true
        seed: this.params.seed ?? -1
      }

      await this.cancel()
      this._failAndClearActiveResponse('Model was reloaded')
      await this.addon.reload(configurationParams)
      await this._loadModelWeights(modelPath, modelType)
      await this.addon.activate()

      this.logger.debug('Addon reloaded and activated successfully')
    })
  }

  /**
   * Download model weights from loader
   * @param {Function} [reportProgressCallback] - Progress callback
   * @param {Object} opts - Options
   * @param {boolean} [opts.closeLoader=false] - Close loader when done
   * @private
   */
  async _downloadWeights (reportProgressCallback, opts) {
    if (this._hasNamedPaths()) {
      this.logger.info('File paths provided via config, skipping WeightsProvider download')
      if (opts.closeLoader) {
        await this.weightsProvider.loader.close()
      }
      return {}
    }

    const modelType = this.params.modelType || 'tdt'
    const models = getRequiredModelFiles(modelType)

    this.logger.info('Loading weight files:', models)

    const result = await this.weightsProvider.downloadFiles(
      models,
      this._diskPath,
      {
        closeLoader: opts.closeLoader,
        onDownloadProgress: reportProgressCallback
      }
    )
    this.logger.info('Weight files downloaded successfully', { models })
    return result
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @returns {ParakeetInterface} The instantiated addon interface
   * @private
   */
  _createAddon (configurationParams) {
    this.logger.info('Creating Parakeet interface with configuration:', configurationParams)
    const binding = require('./binding')
    return new ParakeetInterface(
      binding,
      configurationParams,
      this._outputCallback.bind(this),
      this.logger.info.bind(this.logger)
    )
  }

  /**
   * Override unload to call destroyInstance for proper cleanup.
   */
  async unload () {
    return await this._withExclusiveRun(async () => {
      await this.cancel()
      this._failAndClearActiveResponse('Model was unloaded')
      if (this.addon) {
        await this.addon.destroyInstance()
      }
      this.state.configLoaded = false
      this.state.weightsLoaded = false
    })
  }

  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  async destroy () {
    return await this._withExclusiveRun(async () => {
      await this.cancel()
      this._failAndClearActiveResponse('Model was destroyed')
      if (this.addon) {
        await this.addon.destroyInstance()
      }
      this.state.configLoaded = false
      this.state.weightsLoaded = false
      this.state.destroyed = true
    })
  }

  _failAndClearActiveResponse (reason) {
    for (const [jobId, response] of this._jobToResponse.entries()) {
      response.failed(new Error(reason))
      this._deleteJobMapping(jobId)
    }
    this._hasActiveResponse = false
  }
}

module.exports = TranscriptionParakeet
