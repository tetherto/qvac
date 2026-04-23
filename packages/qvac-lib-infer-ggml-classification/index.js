'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const QvacLogger = require('@qvac/logging')

const { ClassificationInterface } = require('./addon')

const DEFAULT_WEIGHTS_FILENAME = 'mobilenetv3_3class_v3_fp16.gguf'
const JPEG_MAGIC = [0xFF, 0xD8, 0xFF]
const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

function startsWith (buffer, magic) {
  if (!buffer || buffer.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (buffer[i] !== magic[i]) return false
  }
  return true
}

function isSupportedEncoded (buffer) {
  return startsWith(buffer, JPEG_MAGIC) || startsWith(buffer, PNG_MAGIC)
}

function assertBuffer (value) {
  // Accept Node Buffer, bare-buffer Buffer, or plain Uint8Array.
  if (value == null) {
    throw new TypeError('Image input is required (got null or undefined)')
  }
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('Image input must be a Buffer or Uint8Array')
  }
  if (value.length === 0) {
    throw new Error('Image input buffer is empty')
  }
}

function normaliseDimensionOptions (options) {
  if (!options) return {}
  const { width, height, channels } = options
  const any = width !== undefined || height !== undefined || channels !== undefined
  if (!any) return {}
  if (!(Number.isInteger(width) && width > 0)) {
    throw new TypeError('options.width must be a positive integer when passing raw RGB bytes')
  }
  if (!(Number.isInteger(height) && height > 0)) {
    throw new TypeError('options.height must be a positive integer when passing raw RGB bytes')
  }
  if (channels !== undefined && channels !== 3) {
    throw new TypeError('options.channels must be 3 (RGB) when passing raw RGB bytes')
  }
  return { width, height, channels: channels ?? 3 }
}

function resolveDefaultModelPath () {
  // Allow the caller to override via env var for tests, otherwise fall back
  // to the weights file bundled inside the addon package.
  if (typeof process !== 'undefined' && process.env && process.env.QVAC_CLASSIFICATION_MODEL_PATH) {
    return process.env.QVAC_CLASSIFICATION_MODEL_PATH
  }
  return path.join(__dirname, 'weights', DEFAULT_WEIGHTS_FILENAME)
}

/**
 * High-level classifier for MobileNetV3-Small 3-class image triage.
 *
 * ```js
 * const classifier = new ImageClassifier()
 * await classifier.load()
 * const result = await classifier.classify(jpegBuffer)
 * // [ { label: 'food', confidence: 0.93 }, ... ]
 * await classifier.unload()
 * ```
 */
class ImageClassifier {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.modelPath] absolute path to the FP16 GGUF file. Defaults to the bundled model.
   * @param {Object} [opts.logger] optional `@qvac/logging`-compatible logger.
   * @param {number} [opts.threads] optional CPU thread hint.
   */
  constructor (opts = {}) {
    const { modelPath, logger = null, threads, nativeLogger = false } = opts
    this._modelPath = modelPath ?? resolveDefaultModelPath()
    this.logger = new QvacLogger(logger)
    this._threads = threads
    // The underlying C++ JsLogger (in @qvac/qvac-lib-inference-addon-cpp) is
    // a process-wide singleton backed by a static uv_async_t. Enabling it
    // and then rapidly creating/destroying classifier instances can race
    // that handle's lifecycle. Keep the bridge off by default; callers who
    // want native-level log messages can opt in explicitly.
    this._nativeLogger = nativeLogger === true
    this._addon = null
    this.state = { configLoaded: false, destroyed: false }
  }

  getState () {
    return { ...this.state }
  }

  /**
   * Loads the model and prepares the native inference pipeline.
   */
  async load () {
    if (this.state.configLoaded) return

    if (!fs.existsSync(this._modelPath)) {
      throw new Error(`MobileNet GGUF weights not found at: ${this._modelPath}`)
    }

    const configurationParams = {
      path: this._modelPath,
      config: {}
    }
    if (typeof this._threads === 'number' && this._threads > 0) {
      configurationParams.config.threads = this._threads
    }
    // Only wire the native C++→JS logger bridge if the caller explicitly
    // opted in (see constructor comment).
    if (!this._nativeLogger) {
      configurationParams.__disableNativeLogger = true
    }
    if (process.env && process.env.QVAC_CLASSIFICATION_DISABLE_NATIVE_LOGGER === '1') {
      configurationParams.__disableNativeLogger = true
    }

    this._addon = new ClassificationInterface(configurationParams, this.logger)
    await this._addon.activate()
    this.state.configLoaded = true
    this.logger.info('ImageClassifier loaded')
  }

  /**
   * Classifies an image.
   *
   * @param {Uint8Array} imageInput JPEG/PNG buffer, or raw RGB bytes with
   *                                `options.width`, `options.height`, `options.channels=3`.
   * @param {Object} [options]
   * @param {number} [options.topK] limit the number of returned classes
   * @param {number} [options.width] raw RGB width (required for raw input)
   * @param {number} [options.height] raw RGB height (required for raw input)
   * @param {number} [options.channels] raw RGB channel count (must be 3)
   * @returns {Promise<Array<{label: string, confidence: number}>>}
   *          sorted by `confidence` descending. Always returns all classes
   *          unless `options.topK` is set.
   */
  async classify (imageInput, options = undefined) {
    if (!this._addon || !this.state.configLoaded) {
      throw new Error('Classifier not loaded. Call load() first.')
    }

    assertBuffer(imageInput)

    const dimOpts = normaliseDimensionOptions(options)
    if (Object.keys(dimOpts).length === 0 && !isSupportedEncoded(imageInput)) {
      throw new Error(
        'Unsupported image format: pass a JPEG/PNG buffer, or raw RGB bytes ' +
          'with { width, height, channels: 3 }'
      )
    }

    const job = {
      type: 'image',
      content: imageInput,
      ...dimOpts
    }
    if (options && options.topK !== undefined) {
      if (!(Number.isInteger(options.topK) && options.topK > 0)) {
        throw new TypeError('options.topK must be a positive integer')
      }
      job.topK = options.topK
    }

    return this._addon.classify(job)
  }

  /**
   * Releases native resources. Safe to call more than once.
   */
  async unload () {
    if (this._addon) {
      await this._addon.unload()
      this._addon = null
    }
    this.state.configLoaded = false
  }

  async destroy () {
    await this.unload()
    this.state.destroyed = true
  }
}

module.exports = ImageClassifier
module.exports.ImageClassifier = ImageClassifier
