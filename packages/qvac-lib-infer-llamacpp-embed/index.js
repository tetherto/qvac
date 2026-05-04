'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const { BertInterface, mapAddonEvent } = require('./addon')

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

/**
 * Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole
 * entry for single-file models. Matches the C++ shard-expansion contract
 * in `GGUFShards::expandGGUFIntoShards`.
 *
 * @param {string[]} files - ordered array of absolute paths
 * @returns {string}
 */
function pickPrimaryGgufPath (files) {
  const SHARD_REGEX = /-\d+-of-\d+\.gguf$/
  return files.find((p) => SHARD_REGEX.test(p)) || files[0]
}

/** BERT client wrapping the native BertInterface for embedding generation. */
class GGMLBert {
  constructor ({ files, config = {}, logger = null, opts = {} }) {
    if (!files || !Array.isArray(files.model) || files.model.length === 0) {
      throw new TypeError('files.model must be a non-empty array of absolute paths')
    }
    for (const [i, entry] of files.model.entries()) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new TypeError(`files.model[${i}] must be an absolute path string`)
      }
      if (!path.isAbsolute(entry)) {
        throw new TypeError(`files.model[${i}] must be an absolute path (got: ${entry})`)
      }
    }
    this._files = files.model
    this._config = config
    this.logger = new QvacLogger(logger)
    this.opts = opts
    // Lazy deref + optional chain: safe before `_load()` and after `unload()`.
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() })
    this._run = exclusiveRunQueue()
    this.addon = null
    this._hasActiveResponse = false
    this.state = { configLoaded: false }
  }

  async load () {
    return this._run(async () => {
      if (this.state.configLoaded) return
      await this._load()
      this.state.configLoaded = true
    })
  }

  async _load () {
    this.logger.info('Starting model load')
    const primaryGgufPath = pickPrimaryGgufPath(this._files)
    const configurationParams = {
      path: primaryGgufPath,
      config: this._config
    }

    this.logger.info('Creating addon with configuration:', configurationParams)

    try {
      this.addon = this._createAddon(configurationParams)
      if (this._files.length > 1) {
        await this._streamShards()
      }
      this.logger.info('Activating addon')
      await this.addon.activate()
    } catch (loadError) {
      // Best-effort cleanup of the partially-initialized addon so a subsequent
      // load() does not leak a zombie native instance.
      try { await this.addon?.unload?.() } catch (_) {}
      this.addon = null
      throw loadError
    }
    this.logger.info('Model load completed successfully')
  }

  async _streamShards () {
    for (const filePath of this._files) {
      const filename = path.basename(filePath)
      const stream = fs.createReadStream(filePath)
      for await (const chunk of stream) {
        await this.addon.loadWeights({ filename, chunk, completed: false })
      }
      await this.addon.loadWeights({ filename, chunk: null, completed: true })
      this.logger.info(`Streamed weights for ${filename}`)
    }
  }

  async run (input) {
    return this._run(() => this._runInternal(input))
  }

  async _runInternal (text) {
    if (!this.addon) {
      throw new Error('Addon not initialized. Call load() first.')
    }
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    this.logger.info('Starting inference embeddings for text:', text)
    // Array input → type: 'sequences' (batched pass); string input → type: 'text'.
    const inputData = Array.isArray(text)
      ? { type: 'sequences', input: text }
      : { type: 'text', input: text }

    const response = this._job.start()

    // addon-cpp guarantees no output events until runJob is fully accepted.
    // If runJob throws or returns false, no events will fire for this job.
    let accepted
    try {
      accepted = await this.addon.runJob(inputData)
    } catch (error) {
      this._job.fail(error)
      throw error
    }
    if (!accepted) {
      this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE))
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    this._hasActiveResponse = true
    const finalized = response.await().finally(() => { this._hasActiveResponse = false })
    finalized.catch((err) => {
      this.logger?.warn?.('Inference response rejected:', err?.message || err)
    })
    response.await = () => finalized
    return response
  }

  _addonOutputCallback (addon, event, data, error) {
    const mapped = mapAddonEvent(event, data, error)
    if (mapped === null) {
      // Reaching here means the native layer added an event shape the JS
      // wrapper does not know about. Warn and skip.
      this.logger.warn(`Unhandled addon event: ${event} (data type: ${typeof data})`)
      return
    }

    if (mapped.type === 'Error') {
      this.logger.error('Job failed with error:', mapped.error)
      this._job.fail(mapped.error)
      return
    }

    if (mapped.type === 'JobEnded') {
      this._job.end(this.opts.stats ? mapped.data : null)
      return
    }

    if (mapped.type === 'Output') {
      this._job.output(mapped.data)
    }
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {string} configurationParams.path - Local file or directory path
   * @param {Object} configurationParams.config - Bert-specific settings
   * @returns {Addon} The instantiated addon interface
   */
  _createAddon (configurationParams) {
    this.logger.info(
      'Creating Bert interface with configuration:',
      configurationParams
    )
    const binding = require('./binding')
    return new BertInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  /**
   * Unload the model and clear resources. Ensures any in-flight job is resolved as failed.
   * @returns {Promise<void>}
   */
  async unload () {
    return this._run(async () => {
      await this.cancel()
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      this._hasActiveResponse = false
      if (this.addon) {
        await this.addon.unload()
        // Null the addon reference so post-unload `cancel()` / `run()` calls hit the
        // `if (!this.addon)` guard instead of dereferencing a disposed native handle.
        this.addon = null
      }
      this.state.configLoaded = false
    })
  }

  /**
   * Cancel the current task.
   */
  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  getState () { return this.state }
}

module.exports = GGMLBert
module.exports.pickPrimaryGgufPath = pickPrimaryGgufPath
