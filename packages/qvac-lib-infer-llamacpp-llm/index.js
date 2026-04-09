'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const { LlamaInterface } = require('./addon')

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

function normalizeRunOptions (runOptions) {
  if (runOptions === undefined) {
    return { prefill: false, generationParams: undefined }
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

  return {
    prefill: runOptions.prefill === true,
    generationParams: runOptions.generationParams
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

class LlmLlamacpp {
  constructor ({ files, config, logger = null, opts = {} }) {
    this._files = files.model
    this._projectionModelPath = files.projectionModel || ''
    this._config = config
    this.logger = new QvacLogger(logger)
    this.opts = opts
    this._job = createJobHandler({ cancel: () => this.addon.cancel() })
    this._run = exclusiveRunQueue()
    this.addon = null
    this._checkpointSaveDir = null
    this._hasActiveResponse = false
    this._skipNextRuntimeStats = false
    this._originalLogger = this.logger
    this.state = { configLoaded: false }
  }

  async load () {
    if (this.state.configLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }
    await this._load()
    this.state.configLoaded = true
  }

  async _load () {
    this.logger.info('Starting model load')
    const configurationParams = {
      path: this._files[this._files.length - 1],
      projectionPath: this._projectionModelPath,
      config: { ...this._config }
    }
    this.addon = this._createAddon(configurationParams)

    if (this._files.length > 1) {
      await this._streamShards()
    }

    await this.addon.activate()
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

  async run (prompt, runOptions = {}) {
    return this._run(() => this._runInternal(prompt, runOptions))
  }

  async _runInternal (prompt, runOptions = {}) {
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    if (!Array.isArray(prompt)) {
      throw new TypeError('Prompt input must be Message[]')
    }
    const { prefill, generationParams } = normalizeRunOptions(runOptions)

    this.logger.info('Starting inference with prompt:', prompt)

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

    for (const mediaData of mediaItems) {
      promptMessages.push({ type: 'media', content: mediaData })
    }

    promptMessages.push({
      type: 'text',
      input: JSON.stringify(textMessages),
      prefill,
      generationParams
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
    finalized.catch(() => {})
    response.await = () => finalized

    this.logger.info('Inference job started successfully')
    return response
  }

  async finetune (finetuningOptions = undefined) {
    if (!this.addon) {
      throw new Error('Addon not initialized. Call load() first.')
    }
    if (!finetuningOptions) {
      throw new Error('Finetuning parameters are required.')
    }
    if (finetuningOptions.checkpointSaveDir) {
      this._checkpointSaveDir = finetuningOptions.checkpointSaveDir
    }
    const paramsToSend = normalizeFinetuneParams(finetuningOptions)
    this.logger.info('finetune() called')
    this.logger.info('Finetuning parameters:', finetuningOptions)

    return this._run(async () => {
      if (this._hasActiveResponse) {
        throw new Error(RUN_BUSY_ERROR_MESSAGE)
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
      finalized.catch(() => {})
      response.await = () => finalized
      return response
    })
  }

  _isSuppressedNoResponseLog (args) {
    const message = args.map(arg => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object') {
        if (arg.message && typeof arg.message === 'string') return arg.message
        return JSON.stringify(arg)
      }
      return String(arg)
    }).join(' ')
    return message && message.includes('No response found for job')
  }

  _createFilteredLogger (sourceLogger) {
    const filteredLogger = sourceLogger ? Object.create(Object.getPrototypeOf(sourceLogger)) : {}
    Object.assign(filteredLogger, sourceLogger)

    const originalInfo = sourceLogger && typeof sourceLogger.info === 'function'
      ? sourceLogger.info.bind(sourceLogger)
      : null
    const originalWarn = sourceLogger && typeof sourceLogger.warn === 'function'
      ? sourceLogger.warn.bind(sourceLogger)
      : null

    filteredLogger.info = (...args) => {
      if (this._isSuppressedNoResponseLog(args)) return
      if (originalInfo) return originalInfo.apply(sourceLogger, args)
    }

    filteredLogger.warn = (...args) => {
      if (this._isSuppressedNoResponseLog(args)) return
      if (originalWarn) return originalWarn.apply(sourceLogger, args)
    }

    return filteredLogger
  }

  _handleAddonOutputEvent (eventType, data, error) {
    if (eventType === 'JobEnded' || eventType === 'Error') {
      this._hasActiveResponse = false
    }

    if (eventType === 'LogMsg') {
      const logMsg = typeof data === 'string' ? data : (data?.message || JSON.stringify(data))
      this._originalLogger?.info?.(logMsg)
      return
    }

    if (eventType === 'Error') {
      this.logger.error(`Job failed with error: ${error}`)
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
    if (typeof data === 'object' && data !== null && 'TPS' in data) {
      if (this._skipNextRuntimeStats) {
        this._skipNextRuntimeStats = false
        return
      }
      const runtimeStats = { ...data }
      if (runtimeStats.backendDevice === 0) {
        runtimeStats.backendDevice = 'cpu'
      } else if (runtimeStats.backendDevice === 1) {
        runtimeStats.backendDevice = 'gpu'
      }
      return this._handleAddonOutputEvent('JobEnded', runtimeStats, null)
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      data.op === 'finetune' &&
      typeof data.status === 'string'
    ) {
      this._skipNextRuntimeStats = true
      return this._handleAddonOutputEvent('JobEnded', data, null)
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      data.type === 'finetune_progress'
    ) {
      return this._handleAddonOutputEvent('FinetuneProgress', data, null)
    }

    let mappedEvent = event
    if (event.includes('Error')) {
      mappedEvent = 'Error'
    } else if (typeof data === 'string') {
      mappedEvent = 'Output'
    }

    return this._handleAddonOutputEvent(mappedEvent, data, error)
  }

  _createAddon (configurationParams) {
    const binding = require('./binding')
    this.logger = this._createFilteredLogger(this._originalLogger)
    return new LlamaInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  async pause () {
    if (this.addon) {
      await this.addon.cancel()
    }
  }

  async cancel () {
    if (this.addon) {
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
      }
      this.state.configLoaded = false
    })
  }

  getState () { return this.state }
}

module.exports = LlmLlamacpp
