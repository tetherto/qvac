'use strict'

const QvacLogger = require('@qvac/logging')
const { QvacResponse, createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')

const { TranslationInterface } = require('./marian')
const { IndicProcessor } = require('./third-party/indic-processor')

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
class TranslationNmtcpp {
  /**
   * Available model types for translation
   * @static
   * @type {Object}
   * @property {string} IndicTrans - IndicTrans translation model
   * @property {string} Bergamot - Bergamot translation model with vocabulary support
   */
  static ModelTypes = {
    IndicTrans: 'IndicTrans',
    Bergamot: 'Bergamot'
  }

  /**
   * Creates an instance of TranslationNmtcpp.
   * @constructor
   * @param {Object} args - Arguments for inference setup
   * @param {Object} args.files - Resolved file paths
   * @param {string} args.files.model - Path to the main model file
   * @param {string} [args.files.srcVocab] - Path to source vocabulary file (Bergamot)
   * @param {string} [args.files.dstVocab] - Path to destination vocabulary file (Bergamot)
   * @param {string} [args.files.pivotModel] - Path to pivot model file (Bergamot pivot)
   * @param {string} [args.files.pivotSrcVocab] - Path to pivot source vocabulary file
   * @param {string} [args.files.pivotDstVocab] - Path to pivot destination vocabulary file
   * @param {Object} args.params - Translation parameters (srcLang, dstLang)
   * @param {Object} [args.config={}] - Model configuration
   * @param {string} args.config.modelType - Type of model (IndicTrans or Bergamot)
   * @param {Object} [args.config.pivotConfig] - Non-path configuration for pivot model
   * @param {Object} [args.logger=null] - Optional logger instance
   * @param {Object} [args.opts={}] - Options (e.g. { stats: true })
   */
  constructor ({ files, params, config = {}, logger = null, opts = {}, ...args }) {
    this.opts = opts
    this.logger = new QvacLogger(logger)
    this.addon = null

    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false
    }

    const { modelType, pivotConfig, ...additionalConfig } = config

    this._modelType = modelType

    if (this._modelType === 'Opus') {
      throw new Error(
        'ModelTypes.Opus has been deprecated. Use ModelTypes.Bergamot instead. ' +
        'Bergamot covers European language pairs and supports pivot translation for non-English pairs via PivotTranslationModel.'
      )
    }

    this._files = files
    this._config = additionalConfig
    this._params = params
    this._pivotConfig = pivotConfig || {}
    this._job = createJobHandler({ cancel: () => this.addon.cancel() })
    this._run = exclusiveRunQueue()
  }

  /**
   * Returns the current state of the inference client.
   * @returns {{configLoaded: boolean, weightsLoaded: boolean, destroyed: boolean}}
   */
  getState () {
    return this.state
  }

  /**
   * Loads the model. If already loaded, unloads first.
   */
  async load () {
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }

    await this._load()
  }

  /**
   * Runs inference on the given input. Serialized — only one job at a time.
   * @param {string} input - Text to translate
   * @returns {Promise<QvacResponse>}
   */
  async run (input) {
    return this._run(() => this._runInternal(input))
  }

  /**
   * Unloads the model and frees resources.
   */
  async unload () {
    if (this.addon) {
      await this.addon.destroy()
      this.addon = null
    }
    this.state.configLoaded = false
    this.state.weightsLoaded = false
  }

  /**
   * Destroys the model permanently.
   */
  async destroy () {
    await this.unload()
    this.state.destroyed = true
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
   * Configures Bergamot-specific parameters
   * @private
   * @param {Object} configurationParams - The configuration object to modify
   */
  _configureBergamotModel (configurationParams) {
    if (!this._isBergamotModel()) return

    const vocabConfig = {}
    if (this._files.srcVocab) {
      vocabConfig.src_vocab = this._files.srcVocab
    }
    if (this._files.dstVocab) {
      vocabConfig.dst_vocab = this._files.dstVocab
    }

    if (Object.keys(vocabConfig).length > 0) {
      configurationParams.config = {
        ...configurationParams.config,
        ...vocabConfig
      }
    }

    if (this._files.pivotModel) {
      const pivotConfig = {
        path: this._files.pivotModel,
        config: { ...this._pivotConfig }
      }

      if (this._files.pivotSrcVocab) {
        pivotConfig.config.src_vocab = this._files.pivotSrcVocab
      }
      if (this._files.pivotDstVocab) {
        pivotConfig.config.dst_vocab = this._files.pivotDstVocab
      }

      configurationParams.config = {
        ...configurationParams.config,
        pivotModel: pivotConfig
      }
    }
  }

  async _load () {
    const { use_gpu: useGpu, ...otherConfig } = this._config

    const configurationParams = {
      path: this._files.model,
      config: otherConfig
    }

    if (useGpu !== undefined) {
      configurationParams.use_gpu = useGpu
    }

    this._configureBergamotModel(configurationParams)

    this.addon = new TranslationInterface(
      configurationParams,
      this._addonOutputCallback.bind(this),
      this.logger
    )
    await this.addon.activate()
    this.state.configLoaded = true
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
      { cancelHandler: () => this.addon.cancel() }
    )

    return this._job.startWith(response)
  }

  /**
   * Prepares input text with language prefix if needed
   * @private
   * @param {string} input - Input text
   * @returns {string} Processed input text
   */
  _prepareInputText (input) {
    if (this._params.srcLang === 'en' && this._params.dstLang === 'pt') {
      return `>>por<< ${input}`
    }
    return input
  }

  /**
   * Creates a response with output post-processing for language prefixes
   * @private
   * @returns {QvacResponse} Response object with configured handlers
   */
  _createStandardResponse () {
    const response = new QvacResponse({ cancelHandler: () => this.addon.cancel() })

    const originalOnUpdate = response.onUpdate.bind(response)
    response.onUpdate = function (callback) {
      return originalOnUpdate((data) => {
        const cleanedData = data.replace(/^>>[a-z]+\s*<<\s*/i, '')
        return callback(cleanedData)
      })
    }

    return response
  }

  /**
   * Handles standard model translation (Bergamot)
   * @private
   * @param {string} input - Input text to translate
   * @returns {Promise<QvacResponse>} Translation response
   */
  async _runStandardTranslation (input) {
    const text = this._prepareInputText(input)
    await this.addon.runJob({ type: 'text', input: text })
    const response = this._createStandardResponse()

    return this._job.startWith(response)
  }

  async _runInternal (input) {
    if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans) {
      return this._runIndicTrans(input)
    }
    return this._runStandardTranslation(input)
  }

  /**
   * Translates multiple texts in a single batch for better performance.
   *
   * @param {string[]} texts - Array of texts to translate
   * @returns {Promise<string[]>} - Array of translated texts (same order as input)
   */
  async runBatch (texts) {
    if (!this.addon) {
      throw new Error('Model not loaded. Call load() first.')
    }

    if (!Array.isArray(texts)) {
      throw new Error('Input must be an array of strings')
    }

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
      processedTexts = texts.map(text => this._prepareInputText(text))
    }

    await this.addon.runJob({ type: 'sequences', input: processedTexts })

    const response = this._job.start()

    return new Promise((resolve, reject) => {
      response.onFinish(([batchResults]) => {
        if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans && processor) {
          resolve(processor.postprocessBatch(batchResults, this._params.dstLang))
        } else {
          const cleanedResults = batchResults.map(text =>
            text.replace(/^>>[a-z]+\s*<<\s*/i, '')
          )
          resolve(cleanedResults)
        }
      }).onError(error => {
        reject(error)
      })
    })
  }

  _addonOutputCallback (addon, event, data, error) {
    const isStatsObject = typeof data === 'object' && data !== null && !Array.isArray(data) &&
                         Object.keys(data).some(k => k.endsWith('TPS'))

    if (isStatsObject) {
      return this._job.end(this.opts?.stats ? data : null)
    }

    if (event.includes('Error')) {
      return this._job.fail(error)
    }

    if (typeof data === 'string' || Array.isArray(data)) {
      return this._job.output(data)
    }
  }
}

module.exports = TranslationNmtcpp
