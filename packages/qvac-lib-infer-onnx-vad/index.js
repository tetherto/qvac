'use strict'

const ONNXBase = require('@tetherto/infer-onnx-base')
const { SileroVadInterface } = require('./silerovad')
const createStreamAccumulator = require('./utils/createStreamAccumulator')
const { platform } = require('bare-os')

const END_OF_INPUT = 'end of job'

const modelFilePath = './model/silerovad.onnx'

/**
 * ONNX client implementation for the SileroVad transcription model
 */
class VAD extends ONNXBase {
  /**
   * Creates an instance of VAD.
   * @constructor
   * @param {Object} params - addon configuration parameters like model path
   * @param {Object} args - additional arguments for inference setup
   */
  constructor ({ params, ...args } = {}) {
    super(args)
    this.params = params || {}
    this.logger.info('Initializing VAD instance', {
      params,
      modelPath: this._getModelFilePath()
    })
  }

  async _load () {
    VAD._requireModelFilePath()
    this.logger.info('Starting VAD model loading process')
    const configurationParams = {
      path: this.params.modelFilePath || this._getModelFilePath()
    }
    this.logger.debug('Model configuration', { configurationParams })

    try {
      this.addon = this._createAddon(SileroVadInterface, configurationParams, this._outputCallback.bind(this), console.log)
      this.logger.debug('Addon instance created successfully')

      await this.addon.activate()
      this.logger.info('VAD model loaded and activated successfully')
    } catch (error) {
      this.logger.error('Failed to load VAD model', {
        error: error.message,
        stack: error.stack
      })
      throw error
    }
  }

  static _requireModelFilePath () {
    require.asset(modelFilePath)
  }

  _getModelFilePath () {
    const path = modelFilePath
    this.logger.debug('Retrieved model file path', { path })

    if (platform() === 'win32') {
      return '\\\\?\\' + path
    }

    return path
  }

  async _runInternal (audioStream) {
    this.logger.info('Starting audio stream processing')

    let jobId

    try {
      jobId = await this.addon.append({
        type: 'arrayBuffer',
        input: new Uint8Array().buffer
      })

      this.logger.debug('Initial job created successfully', { jobId })

      const response = this._createResponse(jobId)

      this._saveJobToResponseMapping(jobId, response)
      this.logger.debug('Job-response mapping established', { jobId })

      this._handleAudioStream(audioStream).catch(error => {
        this.logger.error('Audio stream processing failed', {
          jobId,
          error: error.message,
          stack: error.stack
        })
        response.failed(error)
      })

      return response
    } catch (error) {
      this.logger.error('Failed to initialize audio processing', {
        error: error.message,
        stack: error.stack
      })
      throw error
    }
  }

  async _handleAudioStream (audioStream) {
    this.logger.debug('Setting up audio stream handling')
    const streamAccumulator = createStreamAccumulator({
      onChunk: async chunk => {
        this.logger.debug('Processing audio chunk', {
          chunkSize: chunk.byteLength
        })
        return await this.addon.append({
          type: 'arrayBuffer',
          input: chunk.buffer
        })
      },
      onFinish: async () => {
        this.logger.debug(
          'Audio stream processing complete, sending end of input signal'
        )
        return await this.addon.append({ type: END_OF_INPUT })
      }
    })

    try {
      for await (const chunk of audioStream) {
        await streamAccumulator.processData(chunk)
      }

      await streamAccumulator.finish()
      this.logger.info('Audio stream processing completed successfully')
    } catch (error) {
      this.logger.error('Error during audio stream processing', {
        error: error.message,
        stack: error.stack
      })
      throw error
    }
  }

  /** Inference Manager */
  static inferenceManagerConfig = {
    noAdditionalDownload: true
  }

  static getModelKey (params) {
    // Prevents loading same model multiple times
    return 'onnx-silerovad'
  }
}

module.exports = {
  VAD,
  modelClass: VAD
}
