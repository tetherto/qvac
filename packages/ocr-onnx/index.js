'use strict'

const QvacLogger = require('@qvac/logging')
const { createJobHandler } = require('@qvac/infer-base')
const fs = require('bare-fs')
const { platform } = require('bare-os')
const { OcrFasttextInterface } = require('./ocr-fasttext')
const languages = require('./supportedLanguages')
const { QvacErrorAddonOcr, ERR_CODES } = require('./lib/error')
const binding = require('./binding')
const addonLogging = require('./addonLogging')
const addon = require.addon.resolve('.')

/**
 * ONNX client implementation for OCR model
 */
class ONNXOcr {
  /**
   * Creates an instance of ONNXOcr.
   * @constructor
   * @param {ONNXOcrArgs} args arguments for inference setup
   */
  constructor ({ params, opts = {}, logger = null }) {
    this.opts = opts
    this.logger = new QvacLogger(logger)
    this.addon = null
    this.params = params
    this._packageName = '@qvac/ocr-onnx'
    this._packageVersion = require('./package.json').version
    this._job = createJobHandler({ cancel: () => this.addon.cancel() })

    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false
    }
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
   * Runs inference on the given input.
   * @param {{ path: string, options?: Object }} input - Image input
   * @returns {Promise<QvacResponse>}
   */
  async run (input) {
    return this._runInternal(input)
  }

  _getDiagnosticsJSON () {
    return JSON.stringify({
      status: this.state.destroyed ? 'destroyed' : (this.state.configLoaded ? 'loaded' : 'not_loaded'),
      params: this.params
    })
  }

  /**
   * Normalize file path for Windows (adds \\?\ prefix for long path support)
   * Not used anymore, paths are now passed as is. This does not work on windows github runner but works on local windows machine (win11).
   * Revisit this when we have a better solution for windows github runner, and/or the prefix long path support is still an issue.
   *
   * @param {string} filePath - The file path to normalize
   * @returns {string} - The normalized file path
   */
  _normalizePath (filePath) {
    if (platform() === 'win32') {
      return '\\\\?\\' + filePath
    }
    return filePath
  }

  async _load () {
    const isDoctr = this.params.pipelineMode === 'doctr'

    if (!isDoctr) {
      // EasyOCR mode: validate languages
      if (!this.params.langList) {
        throw new QvacErrorAddonOcr({ code: ERR_CODES.MISSING_REQUIRED_PARAMETER, adds: 'langList' })
      }

      // filter out unsupported languages
      const supported = this.params.langList.filter(l => languages.onnxOcrAllSupportedLanguages.includes(l))
      const removed = this.params.langList.filter(l => !supported.includes(l))
      if (removed.length > 0) {
        this.logger.warn(`Unsupported language(s) removed from langList: ${JSON.stringify(removed)}`)
      }
      if (supported.length === 0) {
        throw new QvacErrorAddonOcr({ code: ERR_CODES.UNSUPPORTED_LANGUAGE, adds: JSON.stringify(this.params.langList) })
      }
      this.params.langList = supported
    } else {
      // DocTR mode: langList is not used for model selection but still passed
      if (!this.params.langList) {
        this.params.langList = ['en']
      }
    }

    if (!this.params.pathDetector) {
      throw new QvacErrorAddonOcr({ code: ERR_CODES.MISSING_REQUIRED_PARAMETER, adds: 'pathDetector' })
    }

    // If pathRecognizer is not provided, use pathRecognizerPrefix and getRecognizerModelName to construct the path.
    if (!this.params.pathRecognizer) {
      if (isDoctr) {
        throw new QvacErrorAddonOcr({ code: ERR_CODES.MISSING_REQUIRED_PARAMETER, adds: 'pathRecognizer is required for doctr mode' })
      }
      if (!this.params.pathRecognizerPrefix) {
        // If pathRecognizerPrefix is not provided, throw error.
        throw new QvacErrorAddonOcr({ code: ERR_CODES.MISSING_REQUIRED_PARAMETER, adds: 'either pathRecognizer or pathRecognizerPrefix must be provided' })
      }
      this.params.pathRecognizer = `${this.params.pathRecognizerPrefix}${this.getRecognizerModelName(this.params.langList)}.onnx`
    }

    const onnxOcrParams = {
      pathDetector: this.params.pathDetector,
      pathRecognizer: this.params.pathRecognizer,
      langList: this.params.langList,
      useGPU: this.params.useGPU ?? true,
      timeout: this.params.timeout ?? 120
    }

    // Add optional parameters if provided
    const optionalFields = [
      'pipelineMode', 'magRatio', 'defaultRotationAngles',
      'contrastRetry', 'lowConfidenceThreshold',
      'recognizerBatchSize', 'decodingMethod', 'straightenPages',
      'graphOptimization', 'enableXnnpack', 'enableCpuMemArena',
      'intraOpThreads'
    ]
    for (const field of optionalFields) {
      if (this.params[field] !== undefined) {
        onnxOcrParams[field] = this.params[field]
      }
    }

    this.addon = new OcrFasttextInterface(onnxOcrParams, this._addonOutputCallback.bind(this), console.log)
    await this.addon.activate()
    this.state.configLoaded = true
  }

  _addonOutputCallback (addon, event, data, error) {
    // Check stats FIRST (before other checks, since stats event name may contain other type names)
    if (typeof data === 'object' && data !== null && 'totalTime' in data) {
      return this._job.end(this.opts?.stats ? data : null)
    }

    if (event.includes('Error')) {
      return this._job.fail(error)
    }

    if (Array.isArray(data)) {
      return this._job.output(data)
    }
  }

  async unload () {
    if (this.addon) {
      await this.addon.destroy()
      this.addon = null
    }
    this.state.configLoaded = false
    this.state.weightsLoaded = false
  }

  async destroy () {
    await this.unload()
    this.state.destroyed = true
  }

  async _runInternal (input) {
    const imageInput = this.getImage(input.path)
    await this.addon.runJob({
      type: 'image',
      input: imageInput,
      options: input.options
    })

    const response = this._job.start()
    return response
  }

  /**
   * Get the image from file and prepare it for processing
   * Supports BMP (decoded in JS), JPEG, and PNG (decoded in C++ via OpenCV)
   * @param {string} imagePath - The path to the image file
   * @returns {Object} - The image data object
   */
  getImage (imagePath) {
    this.logger.debug('Reading image from path:', imagePath)
    const contents = fs.readFileSync(imagePath)
    if (!contents || contents.length < 4) {
      this.logger.error('Invalid image file or insufficient data')
      throw new QvacErrorAddonOcr({ code: ERR_CODES.INVALID_BMP_OR_INSUFFICIENT_DATA, adds: imagePath })
    }

    // Detect format by magic bytes
    // JPEG: starts with 0xFF 0xD8
    if (contents[0] === 0xFF && contents[1] === 0xD8) {
      this.logger.debug('Detected JPEG format, passing to C++ for decoding')
      return { data: contents, isEncoded: true }
    }

    // PNG: starts with 0x89 0x50 0x4E 0x47 (‰PNG)
    if (contents[0] === 0x89 && contents[1] === 0x50 && contents[2] === 0x4E && contents[3] === 0x47) {
      this.logger.debug('Detected PNG format, passing to C++ for decoding')
      return { data: contents, isEncoded: true }
    }

    // BMP: starts with 0x42 0x4D (BM)
    if (contents[0] === 0x42 && contents[1] === 0x4D) {
      return this.getImageFromBmp(contents, imagePath)
    }

    // Unknown format
    this.logger.error('Unsupported image format')
    throw new QvacErrorAddonOcr({ code: ERR_CODES.UNSUPPORTED_IMAGE_FORMAT, adds: imagePath })
  }

  /**
   * Parse BMP file and extract raw RGB pixel data
   * @param {Buffer} contents - The raw file contents
   * @param {string} imagePath - The path to the image file (for error messages)
   * @returns {Object} - The image data with width, height, and raw RGB data
   */
  getImageFromBmp (contents, imagePath) {
    if (contents.length < 14 + 4) {
      this.logger.error('Invalid BMP file or insufficient data')
      throw new QvacErrorAddonOcr({ code: ERR_CODES.INVALID_BMP_OR_INSUFFICIENT_DATA, adds: imagePath })
    }

    const infoHeaderSize = contents.readUInt32LE(14)
    if (contents.length < 14 + infoHeaderSize) {
      this.logger.error('Incomplete BMP data')
      throw new QvacErrorAddonOcr({ code: ERR_CODES.INCOMPLETE_BMP_DATA, adds: imagePath })
    }

    let width, height, bitsPerPixel
    if (infoHeaderSize >= 40) {
      width = contents.readInt32LE(18)
      height = contents.readInt32LE(22)
      bitsPerPixel = contents.readUInt16LE(28)
    } else if (infoHeaderSize >= 12) {
      width = contents.readUInt16LE(18)
      height = contents.readInt16LE(20)
      bitsPerPixel = 24
    } else {
      this.logger.error('Unsupported BMP Information Header size')
      throw new QvacErrorAddonOcr({ code: ERR_CODES.UNSUPPORTED_BMP_HEADER_SIZE, adds: imagePath })
    }

    this.logger.debug('Image dimensions:', { width, height, bitsPerPixel })

    const pixelDataOffset = contents.readUInt32LE(10)
    const pixelDataBuffer = contents.slice(pixelDataOffset)

    const bytesPerPixel = bitsPerPixel / 8
    const unpaddedRowSize = width * bytesPerPixel
    const paddedRowSize = Math.ceil(unpaddedRowSize / 4) * 4
    const rows = Math.abs(height)

    if (pixelDataBuffer.length < rows * paddedRowSize) {
      this.logger.error('Incomplete BMP pixel data')
      throw new QvacErrorAddonOcr({ code: ERR_CODES.INVALID_BMP_PIXEL_DATA, adds: imagePath })
    }

    const unpaddedData = Buffer.alloc(rows * unpaddedRowSize)
    for (let row = 0; row < rows; row++) {
      const srcStart = row * paddedRowSize
      const srcEnd = srcStart + unpaddedRowSize

      let destRow = row
      if (height > 0) {
        destRow = rows - row - 1
      }
      const destStart = destRow * unpaddedRowSize
      pixelDataBuffer.copy(unpaddedData, destStart, srcStart, srcEnd)
    }

    return { width, height: rows, data: unpaddedData }
  }

  /**
   * Get the name of the recognizer model for the given language list.
   * This will prioritize the first supported language in the list.
   * If no supported language is found, it will throw an error.
   *
   * @param {string[]} langList - The list of languages
   * @returns {string} - The name of the recognizer model
   */
  getRecognizerModelName (langList) {
    // traverse list of languages and return recognizer model name for the first supported language
    // rest of the list will have best effort recognition
    for (const lang of langList) {
      // latin
      if (languages.latinLangList.includes(lang)) {
        this.logger.info(`Using recognizer model: latin for ${lang}`)
        return 'latin'
      }

      // arabic
      if (languages.arabicLangList.includes(lang)) {
        this.logger.info(`Using recognizer model: arabic for ${lang}`)
        return 'arabic'
      }

      // bengali
      if (languages.bengaliLangList.includes(lang)) {
        this.logger.info(`Using recognizer model: bengali for ${lang}`)
        return 'bengali'
      }

      // cyrillic
      if (languages.cyrillicLangList.includes(lang)) {
        this.logger.info(`Using recognizer model: cyrillic for ${lang}`)
        return 'cyrillic'
      }

      // devanagari
      if (languages.devanagariLangList.includes(lang)) {
        this.logger.info(`Using recognizer model: devanagari for ${lang}`)
        return 'devanagari'
      }

      // others
      if (languages.otherLangStringMap[lang]) {
        this.logger.info(`Using recognizer model: ${languages.otherLangStringMap[lang]} for ${lang}`)
        return languages.otherLangStringMap[lang]
      }

      // log a warning that the language is not supported
      this.logger.warn(`Unsupported language: ${lang}`)
    }

    const langListString = JSON.stringify(langList)
    this.logger.error(`Unsupported language(s): ${langListString}`)
    throw new QvacErrorAddonOcr({ code: ERR_CODES.UNSUPPORTED_LANGUAGE, adds: langListString })
  }

  /** Inference Manager */
  static inferenceManagerConfig = {
    noAdditionalDownload: true
  }

  static getModelKey (params) {
    // Prevents loading same model multiple times
    const mode = (params && params.pipelineMode) || 'easyocr'
    return `onnx-ocr-fasttext-${mode}`
  }
}

module.exports = {
  ONNXOcr,
  modelClass: ONNXOcr,
  modelFile: addon,
  QvacErrorAddonOcr,
  ERR_CODES,
  binding,
  addonLogging
}
