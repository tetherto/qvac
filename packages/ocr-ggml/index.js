'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')

const { QvacErrorAddonOcrGgml, ERR_CODES } = require('./lib/error')

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
   * @param {number} [args.params.canvasSize=2560] - EasyOCR `canvas_size`: detection canvas cap (long side, px). Lower it (e.g. 1280) on memory-constrained targets to bound CRAFT peak memory. EasyOCR only.
   * @param {number[]} [args.params.defaultRotationAngles]
   * @param {boolean} [args.params.contrastRetry]
   * @param {number} [args.params.lowConfidenceThreshold]
   * @param {number} [args.params.recognizerBatchSize]
   * @param {number} [args.params.nThreads] - 0=auto (physical cores), >0=explicit, <0=leave default
   * @param {string} [args.params.backendsDir] - override directory for ggml backend shared libs
   * @param {'cpu'|'vulkan'|'metal'} [args.params.backendDevice='cpu'] - requested ggml backend device. `'vulkan'` (Linux/Windows/Android) and `'metal'` (Apple) opt in to GPU inference with transparent CPU fallback when no matching device is present.
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
    this._backendInfo = null

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

  /**
   * Backend device the C++ pipeline resolved for inference. Available after
   * `load()`; `null` before load or after unload.
   * @returns {{ requested: string, backendDevice: string, backendName: string, fallbackReason: string }|null}
   */
  getBackendInfo () {
    return this._backendInfo
  }

  async unload () {
    if (this.addon) {
      await this.addon.destroy()
      this.addon = null
    }
    this._backendInfo = null
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

    const SUPPORTED_LANGUAGES = new Set(['en'])
    const hasSupported = this.params.langList.some(l => SUPPORTED_LANGUAGES.has(l))
    if (!hasSupported) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.UNSUPPORTED_LANGUAGE,
        adds: `none of the requested languages are supported: ${this.params.langList.join(', ')}`
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
      'canvasSize',
      'defaultRotationAngles',
      'contrastRetry',
      'lowConfidenceThreshold',
      'recognizerBatchSize',
      'nThreads',
      'pipelineType',
      'backendDevice'
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
    this.addon = this._createAddon(configurationParams)
    await this.addon.activate()
    this.state.configLoaded = true
    this.state.weightsLoaded = true

    // Capture the backend device the C++ pipeline actually resolved (Vulkan vs
    // CPU fallback). RuntimeStats can only carry numbers, so backend identity
    // strings are surfaced here and via _getDiagnosticsJSON().
    try {
      this._backendInfo = this.addon.getBackendInfo()
      if (this._backendInfo) {
        this.logger.info('ocr-ggml backend: ' + JSON.stringify(this._backendInfo))
      }
    } catch (err) {
      this.logger.warn('ocr-ggml: failed to read backend info: ' + err.message)
      this._backendInfo = null
    }

    this.logger.info('ocr-ggml model loaded')
  }

  _createAddon (configurationParams) {
    const binding = require('./binding')
    const { OcrGgmlInterface } = require('./ocr-ggml')
    return new OcrGgmlInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this),
      this.logger
    )
  }

  async _runInternal (input) {
    this.logger.info('Starting OCR inference')

    if (!this.addon) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.NOT_LOADED,
        adds: 'call load() before run()'
      })
    }

    const response = this._job.start()
    try {
      const imageInput = this._readImage(input.path)
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
   * @returns {{ data: Buffer, isEncoded?: boolean, width?: number, height?: number, bitsPerPixel?: number }}
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

    if (width <= 0 || height === 0) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: `${imagePath} (invalid BMP dimensions ${width}x${height})`
      })
    }

    const SUPPORTED_BITS = new Set([8, 24, 32])
    if (!SUPPORTED_BITS.has(bitsPerPixel)) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.UNSUPPORTED_IMAGE_FORMAT,
        adds: `BMP bitsPerPixel ${bitsPerPixel} (supported: 8, 24, 32)`
      })
    }

    const pixelDataOffset = contents.readUInt32LE(10)
    if (pixelDataOffset >= contents.length) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: `${imagePath} (BMP pixelDataOffset ${pixelDataOffset} out of range)`
      })
    }
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

    return { width, height: rows, data: unpaddedData, bitsPerPixel }
  }

  _addonOutputCallback (addon, event, data, error) {
    if (event && event.includes('Error')) {
      return this._job.fail(error)
    }

    // JobEnded may arrive with stats payload, with null (stats disabled), or
    // not at all on some platforms - handle the event name explicitly so
    // await() doesn't hang when data is null.
    if (event === 'JobEnded') {
      const isStatsObject =
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        ('totalTime' in data || 'detectionTime' in data)
      if (isStatsObject) {
        this.logger.info('OCR inference completed. Stats:', JSON.stringify(data))
      }
      return this._job.end(this.opts?.stats && isStatsObject ? data : null)
    }

    // Some addon paths surface stats without a 'JobEnded' event name; keep
    // the legacy heuristic as a fallback so we still close the job.
    const isStatsObject =
      typeof data === 'object' &&
      data !== null &&
      !Array.isArray(data) &&
      ('totalTime' in data || 'detectionTime' in data)
    if (isStatsObject) {
      this.logger.info('OCR inference completed. Stats:', JSON.stringify(data))
      return this._job.end(this.opts?.stats ? data : null)
    }

    if (Array.isArray(data)) {
      return this._job.output(data)
    }
  }

  /** Inference Manager diagnostics hook (parity with ocr-onnx). */
  _getDiagnosticsJSON () {
    return JSON.stringify({
      status: this.state.destroyed
        ? 'destroyed'
        : (this.state.configLoaded ? 'loaded' : 'not_loaded'),
      params: this.params,
      backend: this._backendInfo
    })
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
  get modelFile () { return require.addon.resolve('.') },
  QvacErrorAddonOcrGgml,
  ERR_CODES,
  get binding () { return require('./binding') },
  get addonLogging () { return require('./addonLogging') }
}
