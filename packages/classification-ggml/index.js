'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')

const { ClassificationInterface, mapAddonEvent } = require('./addon')

const DEFAULT_WEIGHTS_FILENAME = 'mobilenetv3_3class_v3_fp16.gguf'
const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

function resolveDefaultModelPath () {
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
   * @param {boolean} [opts.nativeLogger=false] forward C++-side log lines through `logger`.
   */
  constructor (opts = {}) {
    const { modelPath, logger = null, threads, nativeLogger = false } = opts
    this._modelPath = modelPath ?? resolveDefaultModelPath()
    this.logger = new QvacLogger(logger)
    this._threads = threads
    // The underlying C++ JsLogger (in @qvac/qvac-lib-inference-addon-cpp) is
    // a process-wide singleton backed by a static uv_async_t. Enabling it
    // and then rapidly creating/destroying classifier instances can race
    // that handle's lifecycle. Keep the bridge off by default.
    this._nativeLogger = nativeLogger === true
    this._addon = null
    this._job = createJobHandler({ cancel: () => this._addon?.cancel() })
    this._run = exclusiveRunQueue()
    this._hasActiveResponse = false
    this.state = { configLoaded: false, destroyed: false }
  }

  getState () { return { ...this.state } }

  async load () {
    return this._run(async () => {
      if (this.state.configLoaded) return
      await this._load()
      this.state.configLoaded = true
      this.logger.info('ImageClassifier loaded')
    })
  }

  async _load () {
    if (!fs.existsSync(this._modelPath)) {
      throw new Error(`MobileNet GGUF weights not found at: ${this._modelPath}`)
    }

    const configurationParams = { path: this._modelPath, config: {} }
    if (typeof this._threads === 'number' && this._threads > 0) {
      configurationParams.config.threads = this._threads
    }
    if (!this._nativeLogger) {
      configurationParams.__disableNativeLogger = true
    }
    if (process.env && process.env.QVAC_CLASSIFICATION_DISABLE_NATIVE_LOGGER === '1') {
      configurationParams.__disableNativeLogger = true
    }

    try {
      this._addon = this._createAddon(configurationParams)
      await this._addon.activate()
    } catch (loadError) {
      this.logger.error('Error during model load:', loadError)
      // Best-effort cleanup so a subsequent load() does not leak a zombie
      // native instance (T6 in PR review).
      try { await this._addon?.unload?.() } catch (_) {}
      this._addon = null
      throw loadError
    }
  }

  _createAddon (configurationParams) {
    const binding = require('./binding')
    return new ClassificationInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this),
      this.logger
    )
  }

  /**
   * Classifies one image.
   *
   * @param {Uint8Array} imageInput JPEG/PNG buffer, or raw RGB bytes with
   *                                `options.width`, `options.height`, `options.channels=3`.
   * @param {Object} [options]
   * @param {number} [options.topK]    limit the number of returned classes
   * @param {number} [options.width]   raw RGB width (required for raw input)
   * @param {number} [options.height]  raw RGB height (required for raw input)
   * @param {number} [options.channels] raw RGB channel count (must be 3)
   * @returns {Promise<Array<{label: string, confidence: number}>>}
   *          sorted by `confidence` descending. Always returns all classes
   *          unless `options.topK` is set.
   */
  async classify (imageInput, options = undefined) {
    return this._run(() => this._classifyInternal(imageInput, options))
  }

  async _classifyInternal (imageInput, options) {
    if (!this._addon || !this.state.configLoaded) {
      throw new Error('Classifier not loaded. Call load() first.')
    }
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    const job = { type: 'image', content: imageInput }
    if (options) {
      if (options.width !== undefined) job.width = options.width
      if (options.height !== undefined) job.height = options.height
      if (options.channels !== undefined) job.channels = options.channels
      if (options.topK !== undefined) job.topK = options.topK
    }

    const response = this._job.start()

    let accepted
    try {
      accepted = await this._addon.runJob(job)
    } catch (err) {
      this._job.fail(err)
      throw err
    }
    if (!accepted) {
      const err = new Error('Classification job was rejected by the native runner')
      this._job.fail(err)
      throw err
    }

    this._hasActiveResponse = true
    const collected = await response.await().finally(() => {
      this._hasActiveResponse = false
    })
    // Classify emits exactly one Output event whose payload is already the
    // sorted result array; QvacResponse collects outputs into an array, so
    // unwrap one level to preserve the documented public shape.
    return Array.isArray(collected) && Array.isArray(collected[0])
      ? collected[0]
      : collected
  }

  _handleAddonOutputEvent (eventType, data, error) {
    if (eventType === 'LogMsg') {
      const msg = typeof data === 'string' ? data : (data?.message || JSON.stringify(data))
      this.logger?.info?.(msg)
      return
    }
    if (eventType === 'Error') {
      const err = error instanceof Error
        ? error
        : new Error((error && error.message) || (typeof error === 'string' ? error : 'Classification failed'))
      this._job.fail(err)
    } else if (eventType === 'Output') {
      this._job.output(data)
    } else if (eventType === 'JobEnded') {
      this._job.end()
    }
  }

  _addonOutputCallback (addon, event, data, error) {
    const mapped = mapAddonEvent(event, data, error)
    if (mapped === null) return
    this._handleAddonOutputEvent(mapped.type, mapped.data, mapped.error)
  }

  /**
   * Releases native resources. Mirrors the LLM addon lifecycle: serialised
   * through the same run queue, cancels in-flight work, fails the active
   * JS request with `Model was unloaded`, then destroys the native handle.
   * Safe to call more than once.
   */
  async unload () {
    return this._run(async () => {
      try { if (this._addon?.cancel) await this._addon.cancel() } catch (_) {}
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      this._hasActiveResponse = false
      if (this._addon) {
        await this._addon.unload()
        this._addon = null
      }
      this.state.configLoaded = false
    })
  }

  async destroy () {
    await this.unload()
    this.state.destroyed = true
  }
}

module.exports = ImageClassifier
module.exports.ImageClassifier = ImageClassifier
