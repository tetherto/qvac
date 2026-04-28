'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const { LlamaInterface, mapAddonEvent } = require('./addon')

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

function normalizeRunOptions (runOptions) {
  if (runOptions === undefined) {
    return { prefill: false, generationParams: undefined, cacheKey: undefined, saveCacheToDisk: false }
  }

  if (!runOptions || typeof runOptions !== 'object' || Array.isArray(runOptions)) {
    throw new TypeError('Run options must be an object when provided')
  }

  if (runOptions.prefill !== undefined &&
      typeof runOptions.prefill !== 'boolean') {
    throw new TypeError('prefill must be a boolean when provided')
  }

  if (runOptions.generationParams !== undefined &&
      (typeof runOptions.generationParams !== 'object' || runOptions.generationParams === null || Array.isArray(runOptions.generationParams))) {
    throw new TypeError('generationParams must be a plain object when provided')
  }

  if (runOptions.cacheKey !== undefined && typeof runOptions.cacheKey !== 'string') {
    throw new TypeError('cacheKey must be a string when provided')
  }

  if (runOptions.saveCacheToDisk !== undefined && typeof runOptions.saveCacheToDisk !== 'boolean') {
    throw new TypeError('saveCacheToDisk must be a boolean when provided')
  }

  return {
    prefill: runOptions.prefill === true,
    generationParams: runOptions.generationParams,
    cacheKey: runOptions.cacheKey,
    saveCacheToDisk: runOptions.saveCacheToDisk === true
  }
}

const VALIDATION_TYPES = ['none', 'split', 'dataset']
const DEFAULT_VALIDATION_FRACTION = 0.05

function normalizeFinetuneParams (opts) {
  const validation = opts.validation
  if (Object.prototype.hasOwnProperty.call(opts, 'evalDatasetPath')) {
    throw new Error(
      "Top-level evalDatasetPath is no longer supported. Use validation.path with validation.type set to 'dataset'."
    )
  }
  if (validation == null || typeof validation !== 'object' || !('type' in validation)) {
    throw new Error(
      'Finetuning options must include validation: { type: \'none\' | \'split\' | \'dataset\'[, fraction?: number][, path?: string] }. ' +
      'Example: validation: { type: \'split\', fraction: 0.05 }, validation: { type: \'dataset\', path: \'./eval.jsonl\' }, or validation: { type: \'none\' }.'
    )
  }
  const out = { ...opts }
  const type = validation.type
  if (!VALIDATION_TYPES.includes(type)) {
    throw new Error(
      `validation.type must be one of ${VALIDATION_TYPES.join(', ')}; got: ${type}`
    )
  }
  if (type === 'none') {
    out.validationSplit = 0
    out.useEvalDatasetForValidation = false
    delete out.evalDatasetPath
  } else if (type === 'split') {
    const fraction = validation.fraction ?? DEFAULT_VALIDATION_FRACTION
    out.validationSplit = Math.max(0, Math.min(1, Number(fraction)))
    out.useEvalDatasetForValidation = false
    delete out.evalDatasetPath
  } else {
    const evalPath = validation.path
    if (!evalPath || typeof evalPath !== 'string' || evalPath.trim() === '') {
      throw new Error(
        "validation.type is 'dataset' but no path is provided. Set validation.path to the eval dataset file path (e.g. validation: { type: 'dataset', path: './eval.jsonl' })."
      )
    }
    if (evalPath === opts.trainDatasetDir) {
      throw new Error(
        "validation.type is 'dataset' but validation.path is the same as trainDatasetDir. Provide a separate eval dataset path."
      )
    }
    out.evalDatasetPath = evalPath
    out.validationSplit = 0
    out.useEvalDatasetForValidation = true
  }
  delete out.validation
  return out
}

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

/** LLM client wrapping the native LlamaInterface for inference, finetuning, and pause/resume. */
class LlmLlamacpp {
  constructor ({ files, config, logger = null, opts = {} }) {
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
    if (files.projectionModel !== undefined) {
      if (typeof files.projectionModel !== 'string' || files.projectionModel.length === 0) {
        throw new TypeError('files.projectionModel must be an absolute path string')
      }
      if (!path.isAbsolute(files.projectionModel)) {
        throw new TypeError(`files.projectionModel must be an absolute path (got: ${files.projectionModel})`)
      }
    }
    this._files = files.model
    this._projectionModelPath = files.projectionModel || ''
    this._config = config
    this.logger = new QvacLogger(logger)
    this.opts = opts
    // Lazy deref + optional chain: safe before `_load()` and after `unload()`.
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() })
    this._run = exclusiveRunQueue()
    this.addon = null
    this._checkpointSaveDir = null
    this._hasActiveResponse = false
    // Carried across mapAddonEvent calls to drop the post-finetune TPS trailer.
    this._addonEventState = { skipNextRuntimeStats: false }
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
      projectionPath: this._projectionModelPath,
      config: { ...this._config }
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
      this.logger.error('Error during model load:', loadError)
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

  /**
   * Public API entrypoint for inference.
   * @param {Message[]} prompt - Input prompt array of messages
   * @param {RunOptions} [runOptions] - Optional run settings (prefill, generationParams, cacheKey, saveCacheToDisk)
   * @returns {Promise<QvacResponse>}
   */
  async run (prompt, runOptions = {}) {
    return this._run(() => this._runInternal(prompt, runOptions))
  }

  async _runInternal (prompt, runOptions = {}) {
    if (!this.addon) {
      throw new Error('Addon not initialized. Call load() first.')
    }
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    if (!Array.isArray(prompt)) {
      throw new TypeError('Prompt input must be Message[]')
    }
    const { prefill, generationParams, cacheKey, saveCacheToDisk } = normalizeRunOptions(runOptions)

    this.logger.info('Starting inference with prompt:', prompt)

    // Separate media messages from text messages
    const textMessages = []
    const mediaItems = []

    for (const message of prompt) {
      if (message.role === 'user' &&
          message.type === 'media' &&
          message.content instanceof Uint8Array) {
        mediaItems.push(message.content)
        textMessages.push({ ...message, content: '' })
      } else {
        textMessages.push(message)
      }
    }

    const promptMessages = []

    // Send media first (in order), then the stringified text messages.
    for (const mediaData of mediaItems) {
      promptMessages.push({ type: 'media', content: mediaData })
    }

    promptMessages.push({
      type: 'text',
      input: JSON.stringify(textMessages),
      prefill,
      generationParams,
      cacheKey,
      saveCacheToDisk
    })

    const response = this._job.start()

    let accepted
    try {
      accepted = await this.addon.runJob(promptMessages)
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

    this.logger.info('Inference job started successfully')
    return response
  }

  async finetune (finetuningOptions = undefined) {
    if (!finetuningOptions) {
      throw new Error('Finetuning parameters are required.')
    }
    const paramsToSend = normalizeFinetuneParams(finetuningOptions)
    this.logger.info('finetune() called')
    this.logger.info('Finetuning parameters:', finetuningOptions)

    return this._run(async () => {
      if (!this.addon) {
        throw new Error('Addon not initialized. Call load() first.')
      }
      if (this._hasActiveResponse) {
        throw new Error(RUN_BUSY_ERROR_MESSAGE)
      }
      if (finetuningOptions.checkpointSaveDir) {
        this._checkpointSaveDir = finetuningOptions.checkpointSaveDir
      }

      const response = this._job.start()
      let accepted
      try {
        accepted = await this.addon.finetune(paramsToSend)
      } catch (err) {
        this._job.fail(err)
        throw err
      }

      if (!accepted) {
        this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE))
        throw new Error(RUN_BUSY_ERROR_MESSAGE)
      }

      this._hasActiveResponse = true
      const finalized = response.await().finally(() => { this._hasActiveResponse = false })
      finalized.catch((err) => {
        this.logger?.warn?.('Finetune response rejected:', err?.message || err)
      })
      response.await = () => finalized
      return response
    })
  }

  _handleAddonOutputEvent (eventType, data, error) {
    if (eventType === 'LogMsg') {
      const logMsg = typeof data === 'string' ? data : (data?.message || JSON.stringify(data))
      this.logger?.info?.(logMsg)
      return
    }

    if (eventType === 'Error') {
      this.logger.error('Job failed with error:', error)
      this._job.fail(error)
    } else if (eventType === 'Output') {
      this._job.output(data)
    } else if (eventType === 'FinetuneProgress') {
      if (this.opts.stats && data && data.stats) {
        this._job.active?.updateStats(data.stats)
      }
    } else if (eventType === 'JobEnded') {
      this.logger.info('Job completed')
      const isFinetuneTerminal = data && typeof data === 'object' && data.op === 'finetune' && typeof data.status === 'string'
      if (isFinetuneTerminal) {
        this._job.end(null, data)
      } else {
        this._job.end(this.opts.stats ? data : null)
      }
    }
  }

  _addonOutputCallback (addon, event, data, error) {
    const mapped = mapAddonEvent(event, data, error, this._addonEventState)
    if (mapped === null) return
    this._handleAddonOutputEvent(mapped.type, mapped.data, mapped.error)
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {string} configurationParams.path - Absolute path to the primary model file (first shard for sharded models)
   * @param {string} configurationParams.projectionPath - Absolute path to the multimodal projection model, or '' when not provided
   * @param {Object} configurationParams.config - LLM-specific settings
   * @returns {Addon} The instantiated addon interface
   */
  _createAddon (configurationParams) {
    const binding = require('./binding')
    return new LlamaInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  /**
   * Pause finetuning, saving a checkpoint so training can resume later.
   * Also cancels any inference job in flight.
   */
  async pause () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  /**
   * Cancel finetuning and remove the pause checkpoint so the next
   * `finetune()` call starts fresh instead of resuming. Also cancels
   * any inference job in flight.
   */
  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
    this._clearPauseCheckpoints()
  }

  _clearPauseCheckpoints () {
    const checkpointDir = this._checkpointSaveDir
    if (!checkpointDir) return
    try {
      const entries = fs.readdirSync(checkpointDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('pause_checkpoint_step_')) {
          fs.rmSync(path.join(checkpointDir, entry.name), { recursive: true, force: true })
        }
      }
    } catch (err) {
      this.logger.error('Failed to clear pause checkpoints:', err)
    }
  }

  /**
   * Unload the model safely by cancelling the in-flight job and releasing
   * native resources. Subsequent calls to `run()` / `finetune()` / `cancel()`
   * are safe; they hit the `!this.addon` guard and throw or no-op.
   * @returns {Promise<void>}
   */
  async unload () {
    return this._run(async () => {
      try {
        await this.pause()
      } catch (_) {}
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

  getState () { return this.state }
}

module.exports = LlmLlamacpp
module.exports.pickPrimaryGgufPath = pickPrimaryGgufPath
