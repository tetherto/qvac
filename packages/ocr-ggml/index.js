'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')

const { OcrGgmlInterface } = require('./ocr-ggml')
const { QvacErrorAddonOcrGgml, ERR_CODES } = require('./lib/error')

const binding = require('./binding')
const addonLogging = require('./addonLogging')
const addon = require.addon.resolve('.')

/**
 * GGML-backed OCR implementation.
 *
 * Public surface matches `@qvac/ocr-onnx` so a downstream caller can switch
 * inference engines by swapping the import.
 */
class OcrGgml {
  /**
   * @param {Object} args
   * @param {Object} args.params
   * @param {string} args.params.pathDetector - path to the CRAFT .gguf
   * @param {string} args.params.pathRecognizer - path to the recognizer .gguf
   * @param {string[]} args.params.langList - e.g. `['en']`
   * @param {number} [args.params.magRatio=1.5]
   * @param {number[]} [args.params.defaultRotationAngles]
   * @param {boolean} [args.params.contrastRetry]
   * @param {number} [args.params.lowConfidenceThreshold]
   * @param {number} [args.params.recognizerBatchSize]
   * @param {number} [args.params.nThreads] - 0=auto (physical cores), >0=explicit, <0=leave default
   * @param {string} [args.params.backendsDir] - override directory for ggml backend shared libs
   * @param {Object} [args.opts]
   * @param {boolean} [args.opts.stats] - emit timing stats on finish
   * @param {Object} [args.logger]
   */
  constructor ({ params, opts = {}, logger = null }) {
    this.opts = opts
    this.logger = new QvacLogger(logger)
    this.addon = null
    this.params = params
    this._packageName = '@qvac/ocr-ggml'
    this._packageVersion = require('./package.json').version
    this._job = createJobHandler({ cancel: () => this.addon && this.addon.cancel() })
    this._run = exclusiveRunQueue()

    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false
    }
  }

  /**
   * @returns {{configLoaded: boolean, weightsLoaded: boolean, destroyed: boolean}}
   */
  getState () {
    return this.state
  }

  async load () {
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }
    await this._load()
  }

  /**
   * @param {{ path: string, options?: Object }} input
   * @returns {Promise<import('@qvac/infer-base').QvacResponse>}
   */
  async run (input) {
    return this._run(() => this._runInternal(input))
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

  async _load () {
    if (!this.params || typeof this.params !== 'object') {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.MISSING_REQUIRED_PARAMETER,
        adds: 'params object is required'
      })
    }

    if (!this.params.pathDetector) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.MISSING_REQUIRED_PARAMETER,
        adds: 'pathDetector'
      })
    }
    if (!this.params.pathRecognizer) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.MISSING_REQUIRED_PARAMETER,
        adds: 'pathRecognizer'
      })
    }
    if (!Array.isArray(this.params.langList) || this.params.langList.length === 0) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.MISSING_REQUIRED_PARAMETER,
        adds: 'langList (non-empty array)'
      })
    }

    const configurationParams = {
      pathDetector: this.params.pathDetector,
      pathRecognizer: this.params.pathRecognizer,
      langList: this.params.langList
    }

    // Forward optional config knobs only when explicitly set so the C++
    // defaults (in OcrConfig) win otherwise.
    const optionalFields = [
      'magRatio',
      'defaultRotationAngles',
      'contrastRetry',
      'lowConfidenceThreshold',
      'recognizerBatchSize',
      'nThreads',
      'pipelineType'
    ]
    for (const field of optionalFields) {
      if (this.params[field] !== undefined) {
        configurationParams[field] = this.params[field]
      }
    }

    configurationParams.backendsDir =
      this.params.backendsDir !== undefined
        ? this.params.backendsDir
        : path.join(__dirname, 'prebuilds')

    this.logger.info('Creating ocr-ggml addon')
    this.addon = new OcrGgmlInterface(
      configurationParams,
      this._addonOutputCallback.bind(this),
      this.logger
    )
    await this.addon.activate()
    this.state.configLoaded = true
    this.state.weightsLoaded = true
    this.logger.info('ocr-ggml model loaded')
  }

  async _runInternal (input) {
    this.logger.info('Starting OCR inference')

    const imageInput = this._readImage(input.path)

    const response = this._job.start()
    try {
      await this.addon.runJob({
        type: 'image',
        input: imageInput,
        options: input.options
      })
    } catch (err) {
      this._job.fail(err)
      throw err
    }
    return response
  }

  /**
   * Read an image file from disk and prepare it for the addon. Mirrors the
   * ocr-onnx convention: JPEG / PNG are passed encoded to the addon (decoded
   * by OpenCV in C++); BMP is decoded in JS to raw RGB.
   *
   * @param {string} imagePath
   * @returns {{ data: Buffer, isEncoded?: boolean, width?: number, height?: number }}
   */
  _readImage (imagePath) {
    this.logger.debug('Reading image from path:', imagePath)
    const contents = fs.readFileSync(imagePath)
    if (!contents || contents.length < 4) {
      this.logger.error('Invalid image file or insufficient data')
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: imagePath
      })
    }

    // JPEG: starts with 0xFF 0xD8
    if (contents[0] === 0xFF && contents[1] === 0xD8) {
      return { data: contents, isEncoded: true }
    }
    // PNG: 0x89 P N G
    if (contents[0] === 0x89 && contents[1] === 0x50 && contents[2] === 0x4E && contents[3] === 0x47) {
      return { data: contents, isEncoded: true }
    }
    // BMP: 'BM'
    if (contents[0] === 0x42 && contents[1] === 0x4D) {
      return this._decodeBmp(contents, imagePath)
    }

    this.logger.error('Unsupported image format')
    throw new QvacErrorAddonOcrGgml({
      code: ERR_CODES.UNSUPPORTED_IMAGE_FORMAT,
      adds: imagePath
    })
  }

  _decodeBmp (contents, imagePath) {
    if (contents.length < 14 + 4) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: imagePath
      })
    }

    const infoHeaderSize = contents.readUInt32LE(14)
    if (contents.length < 14 + infoHeaderSize) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: imagePath
      })
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
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.UNSUPPORTED_IMAGE_FORMAT,
        adds: `BMP header size ${infoHeaderSize}`
      })
    }

    const pixelDataOffset = contents.readUInt32LE(10)
    const pixelDataBuffer = contents.slice(pixelDataOffset)

    const bytesPerPixel = bitsPerPixel / 8
    const unpaddedRowSize = width * bytesPerPixel
    const paddedRowSize = Math.ceil(unpaddedRowSize / 4) * 4
    const rows = Math.abs(height)

    if (pixelDataBuffer.length < rows * paddedRowSize) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: imagePath
      })
    }

    const unpaddedData = Buffer.alloc(rows * unpaddedRowSize)
    for (let row = 0; row < rows; row++) {
      const srcStart = row * paddedRowSize
      const srcEnd = srcStart + unpaddedRowSize
      let destRow = row
      if (height > 0) destRow = rows - row - 1
      const destStart = destRow * unpaddedRowSize
      pixelDataBuffer.copy(unpaddedData, destStart, srcStart, srcEnd)
    }

    return { width, height: rows, data: unpaddedData }
  }

  _addonOutputCallback (addon, event, data, error) {
    const isStatsObject =
      typeof data === 'object' &&
      data !== null &&
      !Array.isArray(data) &&
      ('totalTime' in data || 'detectionTime' in data)

    if (isStatsObject) {
      this.logger.info('OCR inference completed. Stats:', JSON.stringify(data))
      return this._job.end(this.opts?.stats ? data : null)
    }

    if (event && event.includes('Error')) {
      return this._job.fail(error)
    }

    if (Array.isArray(data)) {
      return this._job.output(data)
    }
  }

  /** Inference Manager hooks (parity with ocr-onnx) */
  static inferenceManagerConfig = {
    noAdditionalDownload: true
  }

  static getModelKey () {
    return 'ocr-ggml'
  }
}

module.exports = {
  OcrGgml,
  modelClass: OcrGgml,
  modelFile: addon,
  QvacErrorAddonOcrGgml,
  ERR_CODES,
  binding,
  addonLogging
}
