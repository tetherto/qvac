'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')

const { ParakeetInterface } = require('./parakeet')
const { QvacErrorAddonParakeet, ERR_CODES } = require('./lib/error')

const END_OF_INPUT = 'end of job'

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
    this._isStreaming = false
    this._streamingOutputResolve = null

    this.params = config.parakeetConfig || {}

    this.logger.debug('TranscriptionParakeet constructor called', {
      params: this.params,
      config: this._config,
      diskPath: this._diskPath
    })

    this.validateModelFiles()
  }

  /**
   * Override output callback to handle Parakeet's async processing model.
   * The C++ addon may fire JobEnded before Output. During streaming mode,
   * we bypass the response system entirely and route Output events directly
   * to the streaming output resolver.
   */
  _outputCallback (addon, event, jobId, data, error) {
    if (this._isStreaming) {
      if (event === 'Output' && this._streamingOutputResolve) {
        this._streamingOutputResolve(data)
        return
      }
      if (event === 'JobEnded') return
      if (event === 'Error' && this._streamingOutputResolve) {
        this._streamingOutputResolve(null)
        return
      }
      return
    }

    super._outputCallback(addon, event, jobId, data, error)
  }

  /**
   * Validate that required model files exist
   * @throws {QvacErrorAddonParakeet} if required files are missing
   */
  validateModelFiles () {
    const modelPath = this._config.path || this._getModelFilePath()

    // When using named path overrides, skip directory-level validation
    if (this._hasAnyNamedPaths()) {
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
   * Whether TDT individual file paths have been provided via named config params.
   * Only TDT paths are checked because the C++ addon can load directly from these.
   * CTC/EOU/Sortformer named paths are handled by _resolveFilePath during
   * JS-side weight loading.
   * @returns {boolean}
   * @private
   */
  _hasNamedPaths () {
    return !!(this._config.encoderPath || this._config.encoderDataPath ||
      this._config.decoderPath || this._config.vocabPath || this._config.preprocessorPath)
  }

  /**
   * Whether any named paths (TDT or CTC/EOU/Sortformer) have been provided.
   * Used for validation to skip directory-level checks when individual paths are given.
   * @returns {boolean}
   * @private
   */
  _hasAnyNamedPaths () {
    return this._hasNamedPaths() ||
      !!(this._config.ctcModelPath || this._config.ctcModelDataPath ||
        this._config.tokenizerPath || this._config.eouEncoderPath ||
        this._config.eouDecoderPath || this._config.sortformerPath)
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

    // TDT named paths are passed to C++ which loads directly from disk
    if (this._hasNamedPaths()) {
      if (this._config.encoderPath) configurationParams.encoderPath = this._config.encoderPath
      if (this._config.encoderDataPath) configurationParams.encoderDataPath = this._config.encoderDataPath
      if (this._config.decoderPath) configurationParams.decoderPath = this._config.decoderPath
      if (this._config.vocabPath) configurationParams.vocabPath = this._config.vocabPath
      if (this._config.preprocessorPath) configurationParams.preprocessorPath = this._config.preprocessorPath
    }

    this.logger.info('Creating Parakeet addon with configuration:', configurationParams)
    this.addon = this._createAddon(configurationParams)

    // TDT with named paths: C++ loads directly from file paths, skip JS weight loading.
    // CTC/EOU/Sortformer (with or without named paths): JS loads weights via
    // _loadModelWeights which uses _resolveFilePath to handle custom paths.
    if (!this._hasNamedPaths()) {
      await this._loadModelWeights(modelPath, modelType)
    }

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
    const jobId = await this.addon.append({
      type: 'audio',
      data: new Float32Array(0).buffer
    })

    const response = this._createResponse(jobId)

    this._handleAudioStream(audioStream).catch(response.failed.bind(response))
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

  /**
   * Run streaming transcription with energy-based speech segmentation.
   * Buffers incoming audio, detects speech pauses via adaptive RMS energy
   * analysis, and processes each speech segment through the addon pipeline.
   * @param {AsyncIterable<Buffer>} audioStream - Stream of f32le audio (16kHz mono)
   * @returns {Promise<{iterate: AsyncGenerator, await: () => Promise}>}
   */
  async runStreaming (audioStream) {
    if (this.exclusiveRun) {
      return await this._withExclusiveRun(() => this._runStreamingInternal(audioStream))
    }
    return await this._runStreamingInternal(audioStream)
  }

  async _runStreamingInternal (audioStream) {
    const self = this
    self._isStreaming = true

    const SAMPLE_RATE = 16000
    const ENERGY_THRESHOLD = 0.02
    const MIN_SILENCE_SAMPLES = 8000
    const MIN_SPEECH_SAMPLES = 4000
    const MAX_BUFFER_SAMPLES = 480000
    const ENERGY_WINDOW_SAMPLES = 1600
    const CALIBRATION_SAMPLES = 32000
    const SPEECH_MULTIPLIER = 3.0
    const MAX_THRESHOLD = 0.10

    let calibrationEnergies = []
    let calibrationRemaining = CALIBRATION_SAMPLES
    let calibrated = false
    let activeThreshold = ENERGY_THRESHOLD
    let inSpeech = false
    let silenceSamples = 0
    const audioChunks = []
    let totalBufferSamples = 0

    const resultQueue = []
    let resultResolve = null
    let streamDone = false
    let streamError = null

    function computeEnergy (samples, offset, length) {
      if (length <= 0) return 0
      let sum = 0
      for (let i = offset; i < offset + length; i++) {
        sum += samples[i] * samples[i]
      }
      return Math.sqrt(sum / length)
    }

    function finalizeCalibration () {
      calibrated = true
      if (calibrationEnergies.length === 0) {
        activeThreshold = ENERGY_THRESHOLD
        return
      }
      calibrationEnergies.sort((a, b) => a - b)
      const idx = Math.floor(calibrationEnergies.length / 4)
      const noiseFloor = calibrationEnergies[idx]
      activeThreshold = Math.min(
        Math.max(ENERGY_THRESHOLD, noiseFloor * SPEECH_MULTIPLIER),
        MAX_THRESHOLD
      )
      self.logger.debug(
        `Streaming: calibrated noiseFloor=${noiseFloor.toFixed(4)} ` +
        `threshold=${activeThreshold.toFixed(4)} (${calibrationEnergies.length} energies)`
      )
      calibrationEnergies = null
    }

    function concatenateFloat32 (chunks) {
      let total = 0
      for (const c of chunks) total += c.length
      const result = new Float32Array(total)
      let offset = 0
      for (const c of chunks) {
        result.set(c, offset)
        offset += c.length
      }
      return result
    }

    function pushResult (output) {
      resultQueue.push(output)
      if (resultResolve) {
        const r = resultResolve
        resultResolve = null
        r()
      }
    }

    function signalDone () {
      streamDone = true
      if (resultResolve) {
        const r = resultResolve
        resultResolve = null
        r()
      }
    }

    async function processSegment (float32Audio) {
      if (float32Audio.length < MIN_SPEECH_SAMPLES) return

      let resolveOutput
      const outputPromise = new Promise(resolve => { resolveOutput = resolve })
      self._streamingOutputResolve = (data) => {
        if (resolveOutput) {
          const r = resolveOutput
          resolveOutput = null
          r(data)
        }
      }

      await self.addon.append({
        type: 'audio',
        data: float32Audio.buffer
      })

      await self.addon.append({ type: END_OF_INPUT })

      const output = await outputPromise
      self._streamingOutputResolve = null

      if (output) pushResult(output)

      await self.addon.activate()
    }

    const processingPromise = (async () => {
      try {
        for await (const rawChunk of audioStream) {
          let float32
          if (rawChunk instanceof Float32Array) {
            float32 = rawChunk
          } else if (rawChunk.byteOffset % 4 === 0) {
            float32 = new Float32Array(
              rawChunk.buffer,
              rawChunk.byteOffset,
              rawChunk.byteLength / 4
            )
          } else {
            const aligned = new Uint8Array(rawChunk.byteLength)
            aligned.set(new Uint8Array(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength))
            float32 = new Float32Array(aligned.buffer)
          }

          const numSamples = float32.length
          audioChunks.push(float32)
          totalBufferSamples += numSamples

          const windowLen = Math.min(ENERGY_WINDOW_SAMPLES, numSamples)
          const energy = computeEnergy(float32, numSamples - windowLen, windowLen)

          if (!calibrated) {
            calibrationEnergies.push(energy)
            calibrationRemaining -= numSamples
            if (calibrationRemaining <= 0) {
              finalizeCalibration()
            }
            continue
          }

          if (energy > activeThreshold) {
            inSpeech = true
            silenceSamples = 0
          } else {
            silenceSamples += numSamples
          }

          if (totalBufferSamples >= MIN_SPEECH_SAMPLES) {
            const silenceAfterSpeech = inSpeech && silenceSamples >= MIN_SILENCE_SAMPLES
            const bufferOverflow = totalBufferSamples >= MAX_BUFFER_SAMPLES

            if (silenceAfterSpeech || bufferOverflow) {
              const fullAudio = concatenateFloat32(audioChunks)
              audioChunks.length = 0
              totalBufferSamples = 0
              inSpeech = false
              silenceSamples = 0

              await processSegment(fullAudio)
            }
          }
        }

        if (audioChunks.length > 0 && totalBufferSamples >= MIN_SPEECH_SAMPLES) {
          const fullAudio = concatenateFloat32(audioChunks)
          await processSegment(fullAudio)
        }

        self._isStreaming = false
        signalDone()
      } catch (err) {
        self._isStreaming = false
        self.logger.error(`Streaming error: ${err.message}`, err)
        streamError = err
        signalDone()
      }
    })()

    let resultIdx = 0
    return {
      iterate: async function * () {
        while (true) {
          while (resultIdx < resultQueue.length) {
            yield resultQueue[resultIdx++]
          }
          if (streamDone) break
          await new Promise(r => { resultResolve = r })
        }
        if (streamError) throw streamError
      },
      await: () => processingPromise
    }
  }

  /**
   * Reload the model with new configuration parameters.
   * Useful for changing settings without destroying the instance.
   * @param {Object} [newConfig={}] - New configuration parameters
   * @param {Object} [newConfig.parakeetConfig] - Parakeet-specific settings
   */
  async reload (newConfig = {}) {
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

    await this.addon.reload(configurationParams)
    await this._loadModelWeights(modelPath, modelType)
    await this.addon.activate()

    this.logger.debug('Addon reloaded and activated successfully')
  }

  /**
   * Download model weights from loader
   * @param {Function} [reportProgressCallback] - Progress callback
   * @param {Object} opts - Options
   * @param {boolean} [opts.closeLoader=false] - Close loader when done
   * @private
   */
  async _downloadWeights (reportProgressCallback, opts) {
    if (this._hasAnyNamedPaths()) {
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
    if (this.addon) {
      await this.addon.destroyInstance()
    }
    this.state.configLoaded = false
    this.state.weightsLoaded = false
  }
}

module.exports = TranscriptionParakeet
