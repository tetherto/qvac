'use strict'

const fs = require('bare-fs')
const QvacLogger = require('@qvac/logging')
const { createJobHandler } = require('@qvac/infer-base')

const { ParakeetInterface } = require('./parakeet')
const { END_OF_INPUT, ERR_CODES, QvacErrorAddonParakeet } = require('./lib/error')

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
class TranscriptionParakeet {
  /**
   * Creates an instance of TranscriptionParakeet.
   * @constructor
   * @param {Object} opts
   * @param {Object} [opts.files={}] - Map of model file paths
   * @param {string} [opts.files.encoder] - Absolute path to TDT encoder-model.onnx
   * @param {string} [opts.files.encoderData] - Absolute path to TDT encoder-model.onnx.data
   * @param {string} [opts.files.decoder] - Absolute path to TDT decoder_joint-model.onnx
   * @param {string} [opts.files.vocab] - Absolute path to TDT vocab.txt
   * @param {string} [opts.files.preprocessor] - Absolute path to TDT preprocessor.onnx
   * @param {string} [opts.files.model] - Absolute path to CTC model.onnx
   * @param {string} [opts.files.modelData] - Absolute path to CTC model.onnx_data
   * @param {string} [opts.files.tokenizer] - Absolute path to CTC/EOU tokenizer.json
   * @param {string} [opts.files.eouEncoder] - Absolute path to EOU encoder.onnx
   * @param {string} [opts.files.eouDecoder] - Absolute path to EOU decoder_joint.onnx
   * @param {string} [opts.files.sortformer] - Absolute path to sortformer.onnx
   * @param {Object} [opts.config={}] - Parakeet inference configuration
   * @param {Object} [opts.config.parakeetConfig] - Parakeet-specific configuration
   * @param {string} [opts.config.parakeetConfig.modelType='tdt'] - Model type: 'tdt', 'ctc', 'eou', or 'sortformer'
   * @param {number} [opts.config.parakeetConfig.maxThreads=4] - Max CPU threads for inference
   * @param {boolean} [opts.config.parakeetConfig.useGPU=false] - Enable GPU acceleration
   * @param {boolean} [opts.config.parakeetConfig.captionEnabled=false] - Enable caption/subtitle mode
   * @param {boolean} [opts.config.parakeetConfig.timestampsEnabled=true] - Include timestamps in output
   * @param {number} [opts.config.parakeetConfig.seed=-1] - Random seed (-1 for random)
   * @param {Object} [opts.logger=null] - Optional structured logger
   * @param {boolean} [opts.exclusiveRun=true] - Whether to run exclusively
   */
  constructor ({ files = {}, config = {}, logger = null, exclusiveRun = true }) {
    this.logger = new QvacLogger(logger)
    this.exclusiveRun = !!exclusiveRun
    this._runQueueWaiter = Promise.resolve()
    this.state = { configLoaded: false, weightsLoaded: false, destroyed: false }

    this._config = {
      ...config,
      encoderPath: files.encoder,
      encoderDataPath: files.encoderData,
      decoderPath: files.decoder,
      vocabPath: files.vocab,
      preprocessorPath: files.preprocessor,
      ctcModelPath: files.model,
      ctcModelDataPath: files.modelData,
      tokenizerPath: files.tokenizer,
      eouEncoderPath: files.eouEncoder,
      eouDecoderPath: files.eouDecoder,
      sortformerPath: files.sortformer
    }

    this.params = config.parakeetConfig || {}
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() })

    this.logger.debug('TranscriptionParakeet constructor called', {
      params: this.params,
      config: this._config
    })

    this.validateModelFiles()
  }

  /**
   * Validate that required model files exist
   */
  validateModelFiles () {
    const modelType = this.params.modelType || 'tdt'
    const requiredFiles = getRequiredModelFiles(modelType)
    for (const file of requiredFiles) {
      const filePath = this._resolveFilePath(file)
      if (filePath && !fs.existsSync(filePath)) {
        this.logger.warn('Model file not found', { file, path: filePath })
      }
    }
  }

  /**
   * Resolve the absolute path for a model file from the files map.
   * @param {string} filename - model file name (e.g. 'encoder-model.onnx')
   * @returns {string} - absolute path to the file, or empty string if not set
   * @private
   */
  _resolveFilePath (filename) {
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
    return namedPaths[filename] || ''
  }

  /**
   * Build native addon configuration (shared by _load and reload).
   * @returns {Object} configurationParams for createInstance / reload / activate
   * @private
   */
  _buildConfigurationParams () {
    const modelType = this.params.modelType || 'tdt'

    const configurationParams = {
      modelPath: '',
      modelType,
      maxThreads: this.params.maxThreads || 4,
      useGPU: this.params.useGPU || false,
      sampleRate: this.params.sampleRate || 16000,
      channels: this.params.channels || 1,
      captionEnabled: this.params.captionEnabled || false,
      timestampsEnabled: this.params.timestampsEnabled !== false,
      seed: this.params.seed ?? -1
    }

    if (this._config.encoderPath) configurationParams.encoderPath = this._config.encoderPath
    if (this._config.encoderDataPath) configurationParams.encoderDataPath = this._config.encoderDataPath
    if (this._config.decoderPath) configurationParams.decoderPath = this._config.decoderPath
    if (this._config.vocabPath) configurationParams.vocabPath = this._config.vocabPath
    if (this._config.preprocessorPath) configurationParams.preprocessorPath = this._config.preprocessorPath
    if (this._config.ctcModelPath) configurationParams.ctcModelPath = this._config.ctcModelPath
    if (this._config.ctcModelDataPath) configurationParams.ctcModelDataPath = this._config.ctcModelDataPath
    if (this._config.tokenizerPath) configurationParams.tokenizerPath = this._config.tokenizerPath
    if (this._config.eouEncoderPath) configurationParams.eouEncoderPath = this._config.eouEncoderPath
    if (this._config.eouDecoderPath) configurationParams.eouDecoderPath = this._config.eouDecoderPath
    if (this._config.sortformerPath) configurationParams.sortformerPath = this._config.sortformerPath

    return configurationParams
  }

  getState () {
    return this.state
  }

  async load () {
    if (this.state.destroyed) {
      throw new QvacErrorAddonParakeet(ERR_CODES.INSTANCE_DESTROYED)
    }
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }
    await this._load()
    this.state.configLoaded = true
    this.state.weightsLoaded = true
  }

  async run (input) {
    if (this.exclusiveRun) {
      return await this._withExclusiveRun(() => this._runInternal(input))
    }
    return await this._runInternal(input)
  }

  async _withExclusiveRun (fn) {
    const prev = this._runQueueWaiter || Promise.resolve()
    let release
    this._runQueueWaiter = new Promise(resolve => { release = resolve })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Load model and activate addon.
   */
  async _load () {
    const configurationParams = this._buildConfigurationParams()

    this.logger.info('Creating Parakeet addon with configuration:', configurationParams)
    this.addon = this._createAddon(configurationParams)

    await this.addon.activate()
    this.logger.debug('Addon activated')
  }

  /**
   * Run transcription on an audio stream
   * @param {AsyncIterable<Buffer>} audioStream - Stream of audio data (16kHz mono, Float32 or s16le)
   * @returns {Promise<QvacResponse>} - Response object for tracking the transcription job
   */
  async _runInternal (audioStream) {
    const response = this._job.start()

    this._handleAudioStream(this._normalizeAudioStream(audioStream)).catch((error) => {
      this._job.fail(error)
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

  _outputCallback (addon, event, jobId, data, error) {
    if (event === 'Error') {
      this._job.fail(error instanceof Error ? error : new Error(String(error)))
    } else if (event === 'Output') {
      this._job.output(data)
    } else if (event === 'JobEnded') {
      this._job.end(data)
    }
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

      if (newConfig.parakeetConfig) {
        this.params = { ...this.params, ...newConfig.parakeetConfig }
      }

      const configurationParams = this._buildConfigurationParams()

      await this.cancel()
      this._job.fail(new Error('Model was reloaded'))
      await this.addon.reload(configurationParams)
      await this.addon.activate()

      this.logger.debug('Addon reloaded and activated successfully')
    })
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
      this._job.fail(new Error('Model was unloaded'))
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
    if (this._job.active) {
      this._job.fail(new QvacErrorAddonParakeet(ERR_CODES.JOB_CANCELLED))
    }
  }

  async status () {
    return this.addon?.status()
  }

  async pause () {
    await this.addon?.pause()
  }

  async unpause () {
    await this.addon?.activate()
  }

  async destroy () {
    return await this._withExclusiveRun(async () => {
      await this.cancel()
      this._job.fail(new Error('Model was destroyed'))
      if (this.addon) {
        await this.addon.destroyInstance()
      }
      this.state.configLoaded = false
      this.state.destroyed = true
    })
  }
}

module.exports = TranscriptionParakeet
