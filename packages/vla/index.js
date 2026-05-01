'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const binding = require('./binding')
const { preprocessImage, padState, DEFAULT_IMAGE_SIZE } = require('./addon.js')
const { QvacErrorAddonVla, ERR_CODES } = require('./lib/error')

// Maps the C++ Priority enum (0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG) to the
// matching method on the JS QvacLogger instance. Mirrors diffusion-cpp.
const LOG_METHODS = ['error', 'warn', 'info', 'debug']

// Default verbosity sent to the C++ side when a logger is connected. Matches
// the JS-side QvacLogger default — INFO and above are forwarded, DEBUG drops
// unless explicitly raised.
const DEFAULT_NATIVE_VERBOSITY = 2 // INFO

function pickPrimaryGgufPath (files) {
  const FIRST_SHARD_REGEX = /-0*1-of-\d+\.gguf$/
  return files.find((p) => FIRST_SHARD_REGEX.test(p)) || files[0]
}

function validateRunInput (input, hparams) {
  if (!input || typeof input !== 'object') {
    throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_INPUT, adds: 'input must be an object' })
  }
  if (!Array.isArray(input.images) || input.images.length === 0) {
    throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_INPUT, adds: 'input.images must be a non-empty array of Float32Array' })
  }
  const imgWidth = input.imgWidth ?? DEFAULT_IMAGE_SIZE
  const imgHeight = input.imgHeight ?? DEFAULT_IMAGE_SIZE
  const expectedPerImage = 3 * imgWidth * imgHeight
  for (let i = 0; i < input.images.length; i++) {
    const img = input.images[i]
    if (!(img instanceof Float32Array)) {
      throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_INPUT, adds: `input.images[${i}] must be a Float32Array` })
    }
    if (img.length !== expectedPerImage) {
      throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_INPUT, adds: `input.images[${i}] length ${img.length} != 3*${imgWidth}*${imgHeight}` })
    }
  }
  if (!(input.state instanceof Float32Array)) {
    throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_INPUT, adds: 'input.state must be a Float32Array' })
  }
  if (!(input.tokens instanceof Int32Array)) {
    throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_INPUT, adds: 'input.tokens must be an Int32Array' })
  }
  if (!(input.mask instanceof Uint8Array)) {
    throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_INPUT, adds: 'input.mask must be a Uint8Array' })
  }
  if (input.mask.length !== input.tokens.length) {
    throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_INPUT, adds: 'input.mask and input.tokens must have the same length' })
  }
  if (input.noise !== undefined && input.noise !== null && !(input.noise instanceof Float32Array)) {
    throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_INPUT, adds: 'input.noise must be a Float32Array when provided' })
  }
  return { imgWidth, imgHeight }
}

class VlaModel {
  constructor ({ files, config = {}, logger = null, opts = {} } = {}) {
    if (!files || !Array.isArray(files.model) || files.model.length === 0) {
      throw new QvacErrorAddonVla({ code: ERR_CODES.MISSING_REQUIRED_PARAMETER, adds: 'files.model (non-empty array of absolute paths)' })
    }
    for (const [i, entry] of files.model.entries()) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_CONFIG, adds: `files.model[${i}] must be an absolute path string` })
      }
      if (!path.isAbsolute(entry)) {
        throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_CONFIG, adds: `files.model[${i}] must be an absolute path (got: ${entry})` })
      }
    }
    this._files = files.model
    this._config = config
    this.logger = new QvacLogger(logger)
    this.opts = opts
    // The cancel hook is wired to the framework's binding.cancel(handle)
    // through the public cancel() method; the createJobHandler tear-down
    // flows through that path.
    this._job = createJobHandler({ cancel: () => this.cancel() })
    this._run = exclusiveRunQueue()
    this._handle = null
    this._hparams = null
    this._backendName = null
    this._hasActiveResponse = false
    this._nativeLoggerActive = false
    // Per-run accumulator filled by _onAddonEvent; null between runs.
    this._pending = null
    this.state = { configLoaded: false }
  }

  _connectNativeLogger () {
    if (this._nativeLoggerActive) return
    try {
      binding.setLogger((priority, message) => {
        const method = LOG_METHODS[priority] || 'info'
        if (typeof this.logger[method] === 'function') {
          this.logger[method](`[C++] ${message}`)
        }
      })
      const verbosity = (this._config && Number.isInteger(this._config.verbosity))
        ? this._config.verbosity
        : DEFAULT_NATIVE_VERBOSITY
      try { binding.setVerbosity(verbosity) } catch (_) {}
      this._nativeLoggerActive = true
    } catch (err) {
      this.logger.warn('Failed to connect native logger:', err && err.message)
    }
  }

  // Framework output callback: invoked from the JS event loop after each
  // event the worker thread queues. The shape is:
  //   (jsHandle, eventTypeName, outputData, errorData)
  // For VLA we receive at most three event types per job:
  //   - Output (Float32Array)        — the action chunk.
  //   - JobEnded (RuntimeStats obj)  — finishing event with timing/stats.
  //   - Error (string in errorData)  — eventTypeName contains "Error".
  // The pair is accumulated in `_pending` and surfaced through the active
  // _job response (`_job.output` / `_job.end` / `_job.fail`) so the public
  // `model.run(input)` Promise resolves with `{ actions, stats }` once both
  // halves have arrived — preserving the previous external API even though
  // the underlying dispatch is now asynchronous.
  _onAddonEvent (_jsHandle, eventTypeName, outputData, errorData) {
    if (typeof eventTypeName === 'string' && eventTypeName.includes('Error')) {
      const err = new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: typeof errorData === 'string' ? errorData : 'native error'
      })
      if (this._pending) this._pending.actions = null
      this._pending = null
      if (this._job.active) this._job.fail(err)
      this._hasActiveResponse = false
      return
    }
    if (outputData instanceof Float32Array) {
      if (this._pending) this._pending.actions = outputData
      this._job.output(outputData)
      return
    }
    if (outputData && typeof outputData === 'object') {
      const stats = outputData
      const actions = this._pending ? this._pending.actions : null
      this._pending = null
      this._hasActiveResponse = false
      this._job.end(this.opts.stats ? stats : null, { actions, stats })
    }
  }

  _releaseNativeLogger () {
    if (!this._nativeLoggerActive) return
    try { binding.releaseLogger() } catch (_) {}
    this._nativeLoggerActive = false
  }

  async load ({ backend = 'auto' } = {}) {
    if (backend !== 'auto' && backend !== 'cpu') {
      throw new QvacErrorAddonVla({ code: ERR_CODES.INVALID_CONFIG, adds: `backend must be 'auto' or 'cpu' (got: ${backend})` })
    }
    return this._run(async () => {
      if (this.state.configLoaded) return
      await this._load(backend)
      this.state.configLoaded = true
    })
  }

  async _load (backend) {
    this.logger.info('Starting model load')
    this._connectNativeLogger()
    const ggufPath = pickPrimaryGgufPath(this._files)
    if (!fs.existsSync(ggufPath)) {
      throw new QvacErrorAddonVla({ code: ERR_CODES.MODEL_NOT_FOUND, adds: ggufPath })
    }
    try {
      // Canonical instance lifecycle (mirrors LLM/embed/NMT):
      // createInstance(jsHandle, params, outputCb) — the framework's
      // JobRunner thread consumes runJob() and feeds the outputCb.
      this._handle = binding.createInstance(
        this,
        { ggufPath, backend },
        (jsHandle, eventTypeName, outputData, errorData) => {
          this._onAddonEvent(jsHandle, eventTypeName, outputData, errorData)
        }
      )
      // No-op for VLA (no IModelAsyncLoad weights stream) but kept for
      // symmetry with sibling addons.
      binding.activate(this._handle)
      this._hparams = binding.getVlaHparams(this._handle)
      this._backendName = binding.getVlaBackendName(this._handle)
    } catch (loadError) {
      this.logger.error('Error during model load:', loadError)
      if (this._handle) {
        try { binding.destroyInstance(this._handle) } catch (_) {}
        this._handle = null
      }
      throw new QvacErrorAddonVla({ code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS, adds: loadError.message, cause: loadError })
    }
    this.logger.info('Model load completed successfully')
  }

  get hparams () { return this._hparams }

  get backendName () { return this._backendName }

  async run (input) {
    return this._run(() => this._runInternal(input))
  }

  async _runInternal (input) {
    if (!this._handle) {
      throw new QvacErrorAddonVla({ code: ERR_CODES.INSTANCE_NOT_INITIALIZED })
    }
    if (this._hasActiveResponse) {
      throw new QvacErrorAddonVla({ code: ERR_CODES.JOB_ALREADY_RUNNING })
    }

    const { imgWidth, imgHeight } = validateRunInput(input, this._hparams)

    this.logger.info('Starting inference')

    const response = this._job.start()
    this._hasActiveResponse = true
    // Per-job accumulator. Two events flow through _onAddonEvent: the
    // Float32Array action chunk lands first, then the RuntimeStats object —
    // we resolve the response only when both have arrived.
    this._pending = { actions: null }

    let accepted = false
    try {
      accepted = binding.runJob(this._handle, {
        type: 'vla',
        input: {
          images: input.images,
          imgWidth,
          imgHeight,
          state: input.state,
          tokens: input.tokens,
          mask: input.mask,
          noise: input.noise ?? undefined
        }
      })
    } catch (err) {
      this._pending = null
      this._hasActiveResponse = false
      this._job.fail(err)
      throw err
    }

    if (!accepted) {
      this._pending = null
      this._hasActiveResponse = false
      const err = new QvacErrorAddonVla({ code: ERR_CODES.JOB_ALREADY_RUNNING })
      this._job.fail(err)
      throw err
    }

    this.logger.info('Inference job dispatched')
    return response
  }

  async pause () { /* no-op: SmolVLA inference has no per-step cancel point */ }

  async cancel () {
    if (this._handle) {
      try { await binding.cancel(this._handle) } catch (_) {}
    }
  }

  async unload () {
    return this._run(async () => {
      await this.cancel()
      if (this._job.active) {
        this._job.fail(new QvacErrorAddonVla({ code: ERR_CODES.MODEL_UNLOADED }))
      }
      this._pending = null
      this._hasActiveResponse = false
      if (this._handle) {
        try {
          binding.destroyInstance(this._handle)
        } catch (destroyError) {
          this._handle = null
          this._releaseNativeLogger()
          throw new QvacErrorAddonVla({ code: ERR_CODES.FAILED_TO_DESTROY, adds: destroyError.message, cause: destroyError })
        }
        this._handle = null
      }
      this._releaseNativeLogger()
      this._hparams = null
      this._backendName = null
      this.state.configLoaded = false
    })
  }

  getState () { return this.state }
}

module.exports = VlaModel
module.exports.VlaModel = VlaModel
module.exports.preprocessImage = preprocessImage
module.exports.padState = padState
module.exports.DEFAULT_IMAGE_SIZE = DEFAULT_IMAGE_SIZE
module.exports.pickPrimaryGgufPath = pickPrimaryGgufPath
module.exports.QvacErrorAddonVla = QvacErrorAddonVla
module.exports.ERR_CODES = ERR_CODES
