'use strict'

const path = require('bare-path')
const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')

const { TranslationInterface } = require('./marian')
const QvacResponse = require('@qvac/response')
const { IndicProcessor } = require('./third-party/indic-processor')

const JOB_ID = 'job'

class QvacIndicTransResponse extends QvacResponse {
  /**
   * Creates an instance of QvacIndicTransResponse.
   * @constructor
   * @param {IndicProcessor} processor
   * @param {string} dstLang
   * @param {Object} handlers
   */
  constructor (processor, dstLang, handlers) {
    super(handlers)
    this.processor = processor
    this.dstLang = dstLang
  }

  onCancel (callback) {
    return super.onCancel(callback)
  }

  onError (callback) {
    return super.onError(callback)
  }

  onFinish (callback) {
    return super.onFinish(callback)
  }

  onUpdate (callback) {
    return super.onUpdate((data) => {
      const [postProcessedText] = this.processor.postprocessBatch(
        [data],
        this.dstLang
      )
      return callback(postProcessedText)
    })
  }

  async * iterate () {
    for await (const output of super.iterate()) {
      const [postProcessedText] = this.processor.postprocessBatch(
        [output],
        this.dstLang
      )
      yield postProcessedText
    }
  }
}

/**
 * TranslationNmtcpp implementation for Marian/IndicTrans/Bergamot translation models
 */
class TranslationNmtcpp extends BaseInference {
  /**
   * Available model types for translation
   * @static
   * @type {Object}
   * @property {string} IndicTrans - IndicTrans translation model
   * @property {string} Opus - Opus translation model
   * @property {string} Bergamot - Bergamot translation model with vocabulary support
   */
  static ModelTypes = {
    IndicTrans: 'IndicTrans',
    Opus: 'Opus',
    Bergamot: 'Bergamot'
  }

  /**
   * Creates an instance of TranslationNmtcpp.
   * @constructor
   * @param {Object} args - Arguments for inference setup
   * @param {Object} args.loader - Loader for downloading model files
   * @param {string} args.diskPath - Local disk path for storing files
   * @param {string} args.modelName - Name of the model file
   * @param {Object} args.params - Translation parameters (srcLang, dstLang)
   * @param {Object} [args.logger=null] - Optional logger instance
   * @param {boolean} [args.exclusiveRun=true] - Whether to run exclusively
   * @param {Object} config - Environment specific configuration
   * @param {string} config.modelType - Type of model (IndicTrans, Opus, or Bergamot)
   * @param {string} [config.srcVocabPath] - Path to source vocabulary file (Bergamot only)
   * @param {string} [config.dstVocabPath] - Path to destination vocabulary file (Bergamot only)
   * @param {string} [config.srcVocabName] - Name of source vocab file to download (Bergamot only)
   * @param {string} [config.dstVocabName] - Name of destination vocab file to download (Bergamot only)
   */
  constructor ({ loader, diskPath, modelName, params, logger = null, exclusiveRun = true, ...args }, config = {}) {
    super({ logger, exclusiveRun, ...args })
    this.loader = loader
    this.weightsProvider = new WeightsProvider(loader, this.logger)

    // Extract and organize configuration
    const { modelType, srcVocabPath, dstVocabPath, srcVocabName, dstVocabName, ...additionalConfig } = config

    this._modelType = modelType
    this._config = additionalConfig
    this._diskPath = diskPath
    this._modelName = modelName
    this._params = params

    // Store Bergamot vocabulary configuration
    this._vocabConfig = {
      srcPath: srcVocabPath,
      dstPath: dstVocabPath,
      srcName: srcVocabName,
      dstName: dstVocabName
    }
  }

  /**
   * Checks if this is a Bergamot model
   * @private
   * @returns {boolean}
   */
  _isBergamotModel () {
    return this._modelType === TranslationNmtcpp.ModelTypes.Bergamot
  }

  /**
   * Gets the vocabulary file paths for Bergamot models
   * @private
   * @returns {{srcVocab: string|null, dstVocab: string|null}}
   */
  _getVocabularyPaths () {
    if (!this._isBergamotModel()) {
      return { srcVocab: null, dstVocab: null }
    }

    const srcVocab = this._vocabConfig.srcPath ||
        (this._vocabConfig.srcName ? path.join(this._diskPath, this._vocabConfig.srcName) : null)
    const dstVocab = this._vocabConfig.dstPath ||
        (this._vocabConfig.dstName ? path.join(this._diskPath, this._vocabConfig.dstName) : null)

    return { srcVocab, dstVocab }
  }

  /**
   * Gets the list of files that need to be downloaded from Hyperdrive
   * @private
   * @returns {string[]}
   */
  _getFilesToDownload () {
    const files = []
    if (this._modelName) {
      files.push(this._modelName)
    }

    if (this._isBergamotModel()) {
      // Add vocabulary files if they need to be downloaded from Hyperdrive
      if (this._vocabConfig.srcName && !this._vocabConfig.srcPath) {
        files.push(this._vocabConfig.srcName)
      }
      if (this._vocabConfig.dstName && !this._vocabConfig.dstPath) {
        files.push(this._vocabConfig.dstName)
      }
    }

    return files
  }

  /**
   * Configures Bergamot-specific parameters
   * @private
   * @param {Object} configurationParams - The configuration object to modify
   */
  _configureBergamotModel (configurationParams) {
    if (!this._isBergamotModel()) return

    const { srcVocab, dstVocab } = this._getVocabularyPaths()

    // Add vocab paths to the config object if they exist
    // Bergamot models may work with only one vocab or even none in some cases
    const vocabConfig = {}
    if (srcVocab) {
      vocabConfig.src_vocab = srcVocab
    }
    if (dstVocab) {
      vocabConfig.dst_vocab = dstVocab
    }

    if (Object.keys(vocabConfig).length > 0) {
      configurationParams.config = {
        ...configurationParams.config,
        ...vocabConfig
      }
    }
  }

  async _load (close = false, reportProgressCallback) {
    if (this.loader) {
      await this.loader.ready()
    }
    try {
      await this.downloadWeights(reportProgressCallback)

      // Extract use_gpu from config (if present) to pass at top level
      const { use_gpu: useGpu, ...otherConfig } = this._config

      const configurationParams = {
        path: this._config.path || path.join(this._diskPath, this._modelName),
        config: otherConfig
      }

      // Add use_gpu at top level if it was specified
      if (useGpu !== undefined) {
        configurationParams.use_gpu = useGpu
      }

      // Configure Bergamot-specific parameters if needed
      this._configureBergamotModel(configurationParams)

      this.addon = this.createAddon(configurationParams)
      await this.addon.activate()
      this.state.configLoaded = true
    } finally {
      if (close && this.loader) {
        await this.loader.close()
      }
    }
  }

  /**
   * Creates response handlers for translation jobs
   * @private
   * @param {number} jobId - The job identifier
   * @returns {Object} Handler object with cancel, pause, and continue handlers
   */
  _createResponseHandlers (jobId) {
    return {
      cancelHandler: () => this.addon.cancel(),
      pauseHandler: () => this.addon.pause(),
      continueHandler: () => this.addon.activate()
    }
  }

  /**
   * Handles IndicTrans model translation
   * @private
   * @param {string} input - Input text to translate
   * @returns {Promise<QvacIndicTransResponse>} Translation response
   */
  async _runIndicTrans (input) {
    const processor = new IndicProcessor()
    const [processedText] = processor.preprocessBatch(
      [input],
      this._params.srcLang,
      this._params.dstLang
    )

    await this.addon.runJob({
      type: 'text',
      input: processedText
    })

    const response = new QvacIndicTransResponse(
      processor,
      this._params.dstLang,
      this._createResponseHandlers()
    )

    this._saveJobToResponseMapping(JOB_ID, response)
    return response
  }

  /**
   * Prepares input text with language prefix if needed
   * @private
   * @param {string} input - Input text
   * @returns {string} Processed input text
   */
  _prepareInputText (input) {
    // Add language prefix for Portuguese target (Opus model convention)
    if (this._params.srcLang === 'en' && this._params.dstLang === 'pt') {
      return `>>por<< ${input}`
    }
    return input
  }

  /**
   * Creates a response with output post-processing for language prefixes
   * @private
   * @param {number} jobId - The job identifier
   * @returns {QvacResponse} Response object with configured handlers
   */
  _createStandardResponse () {
    const response = new QvacResponse(this._createResponseHandlers())

    // Override onUpdate to strip language prefixes from output
    const originalOnUpdate = response.onUpdate.bind(response)
    response.onUpdate = function (callback) {
      return originalOnUpdate((data) => {
        // Remove language prefix like ">>por<< " from the beginning
        const cleanedData = data.replace(/^>>[a-z]+\s*<<\s*/i, '')
        return callback(cleanedData)
      })
    }

    return response
  }

  /**
   * Handles standard model translation (Opus, Bergamot)
   * @private
   * @param {string} input - Input text to translate
   * @returns {Promise<QvacResponse>} Translation response
   */
  async _runStandardTranslation (input) {
    const text = this._prepareInputText(input)
    await this.addon.runJob({ type: 'text', input: text })
    const response = this._createStandardResponse()

    this._saveJobToResponseMapping(JOB_ID, response)
    return response
  }

  async _runInternal (input) {
    if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans) {
      return this._runIndicTrans(input)
    }
    return this._runStandardTranslation(input)
  }

  /**
   * Translates multiple texts in a single batch for better performance.
   * This is more efficient than calling run() multiple times as it processes
   * all texts together in a single batch operation.
   *
   * @param {string[]} texts - Array of texts to translate
   * @returns {Promise<string[]>} - Array of translated texts (same order as input)
   * @example
   * const translations = await model.runBatch([
   *   "Hello world",
   *   "How are you?",
   *   "Goodbye"
   * ]);
   * // translations = ["Ciao mondo", "Come stai?", "Arrivederci"]
   */
  async runBatch (texts) {
    if (!this.addon) {
      throw new Error('Model not loaded. Call load() first.')
    }

    if (!Array.isArray(texts)) {
      throw new Error('Input must be an array of strings')
    }

    // Preprocess texts if needed (e.g., for IndicTrans)
    let processedTexts = texts
    let processor = null

    if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans) {
      processor = new IndicProcessor()
      processedTexts = processor.preprocessBatch(
        texts,
        this._params.srcLang,
        this._params.dstLang
      )
    } else {
      // Apply language prefix for standard models if needed
      processedTexts = texts.map(text => this._prepareInputText(text))
    }

    // Call batch translation
    const results = await this.addon.processBatch(processedTexts)

    // Post-process results if needed
    if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans && processor) {
      return processor.postprocessBatch(results, this._params.dstLang)
    }

    // Remove language prefix from output for standard models
    return results.map(text => text.replace(/^>>[a-z]+\s*<<\s*/i, ''))
  }

  createAddon (configurationParams) {
    return new TranslationInterface(
      configurationParams,
      this._addonOutputCallback.bind(this),
      this.logger
    )
  }

  _addonOutputCallback (addon, event, data, error) {
    // Map C++ mangled type names to expected event names
    // Check stats FIRST (before basic_string check, since stats event name also contains 'basic_string')
    if (typeof data === 'object' && data !== null && 'TPS' in data) {
      // Stats object received - this signals job completion
      // Pass stats with JobEnded event (base class expects stats in JobEnded data)
      return this._outputCallback(addon, 'JobEnded', JOB_ID, data, null)
    }

    let mappedEvent = event
    if (event.includes('Error')) {
      mappedEvent = 'Error'
    } else if (typeof data === 'string') {
      mappedEvent = 'Output'
    }
    return this._outputCallback(addon, mappedEvent, JOB_ID, data, error)
  }

  async _downloadWeights (reportProgressCallback) {
    const models = this._getFilesToDownload()
    if (!models.length) {
      this.logger.info('No model files supplued to be downlaoded')
      return
    }

    this.logger.info('Loading weight files:', models)

    const result = await this.weightsProvider.downloadFiles(models, this._diskPath, {
      closeLoader: true,
      onDownloadProgress: reportProgressCallback
    })
    this.logger.info('Weight files downloaded successfully', { models })
    return result
  }
}

module.exports = TranslationNmtcpp
