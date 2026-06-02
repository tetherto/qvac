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
  // The C++ inference path requires img_width == img_height == hparams.visionImageSize
  // (SigLIP's conv2d output is sized from runtime args, but the downstream
  // patch-embedding reshape uses hp.vision_image_size — a mismatch trips
  // GGML_ASSERT in ggml.c, which is a hard abort that kills the worker).
  // Throw a clean QvacError here so the failure surfaces as a rejected
  // run() promise instead of a process crash.
  if (hparams && Number.isInteger(hparams.visionImageSize)) {
    const expected = hparams.visionImageSize
    if (imgWidth !== expected || imgHeight !== expected) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `imgWidth/imgHeight (${imgWidth}x${imgHeight}) must equal hparams.visionImageSize (${expected})`
      })
    }
  }
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

  if (hparams && hparams.stateInputMode === 'continuous' &&
      Number.isInteger(hparams.maxStateDim)) {
    if (input.state.length === 0 || input.state.length > hparams.maxStateDim) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `state.length (${input.state.length}) must be > 0 and <= hparams.maxStateDim (${hparams.maxStateDim})`
      })
    }
  }

  if (hparams && hparams.stateInputMode === 'discrete') {
    if (Number.isInteger(hparams.numCameras) && input.images.length !== hparams.numCameras) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `pi05 requires exactly ${hparams.numCameras} camera images (got ${input.images.length})`
      })
    }
    if (Number.isInteger(hparams.tokenizerMaxLength) && input.tokens.length !== hparams.tokenizerMaxLength) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `pi05 requires tokens.length === ${hparams.tokenizerMaxLength} (got ${input.tokens.length})`
      })
    }
    if (!input.noise || !(input.noise instanceof Float32Array) || input.noise.length === 0) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'pi05 requires input.noise (Float32Array) — flow matching needs a noise prior at t=1'
      })
    }
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
    this._packageName = '@qvac/vla-ggml'
    this._packageVersion = require('./package.json').version
    // Per-run accumulator filled by _onAddonEvent; null between runs.
    this._pending = null
    this.state = { configLoaded: false, weightsLoaded: false }
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
    // `_hasActiveResponse` is cleared by the response promise's .finally() in
    // _runInternal, NOT here — see the rationale block there. Doing it from
    // this callback would mean the flag stays set forever if the worker
    // aborts before delivering JobEnded/Error.
    if (typeof eventTypeName === 'string' && eventTypeName.includes('Error')) {
      const err = new QvacErrorAddonVla({
        code: ERR_CODES.INFERENCE_FAILED,
        adds: typeof errorData === 'string' ? errorData : 'native error'
      })
      if (this._pending) this._pending.actions = null
      this._pending = null
      if (this._job.active) this._job.fail(err)
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
      this.state.weightsLoaded = true
    })
  }

  async _load (backend) {
    this.logger.info('Starting model load')
    this._connectNativeLogger()
    const ggufPath = pickPrimaryGgufPath(this._files)
    if (!fs.existsSync(ggufPath)) {
      // _connectNativeLogger has already registered a JS callback with
      // the native side; without unregistering, that callback pins the
      // Bare event loop and prevents the process from exiting. Release
      // before throwing so a `new VlaModel(...).load()` against a
      // non-existent file leaves no event-loop references behind.
      this._releaseNativeLogger()
      throw new QvacErrorAddonVla({ code: ERR_CODES.MODEL_NOT_FOUND, adds: ggufPath })
    }
    try {
      // Canonical instance lifecycle (mirrors LLM/embed/NMT):
      // createInstance(jsHandle, params, outputCb) — the framework's
      // JobRunner thread consumes runJob() and feeds the outputCb.
      const backendsDir = (this._config && this._config.backendsDir)
        ? this._config.backendsDir
        : path.join(__dirname, 'prebuilds')
      this._handle = binding.createInstance(
        this,
        { ggufPath, backend, backendsDir },
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
      // Same logger-leak guard as the missing-file path above.
      this._releaseNativeLogger()
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
      this._job.fail(err)
      throw err
    }

    if (!accepted) {
      this._pending = null
      const err = new QvacErrorAddonVla({ code: ERR_CODES.JOB_ALREADY_RUNNING })
      this._job.fail(err)
      throw err
    }

    // Only mark the model busy once the worker has actually accepted the job.
    // Clear via `.finally()` on the response promise, not from inside the
    // native event callback — if the worker thread aborts mid-inference
    // (e.g. an unrecoverable GGML_ASSERT in smolvla.cpp) no JobEnded/Error
    // event is delivered and the previous "clear from _onAddonEvent" pattern
    // would leave the flag set forever, wedging every subsequent run() with
    // JOB_ALREADY_RUNNING. Mirrors qvac-lib-infer-llamacpp-llm/index.js.
    this._hasActiveResponse = true
    const finalized = response.await().finally(() => {
      this._hasActiveResponse = false
    })
    // Swallow rejections at the unobserved-promise level so an awaiter who
    // catches still sees the rejection through their own await; without
    // this the runtime logs an "unhandled promise rejection" warning.
    finalized.catch((err) => {
      this.logger?.warn?.('Inference response rejected:', err?.message || err)
    })
    // Make response.await() idempotent: subsequent calls return the same
    // chained promise so .finally() fires exactly once.
    response.await = () => finalized

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
      this.state.weightsLoaded = false
    })
  }

  getState () { return this.state }
}

module.exports = VlaModel
module.exports.VlaModel = VlaModel
module.exports.preprocessImage = preprocessImage
module.exports.padState = padState
module.exports.DEFAULT_IMAGE_SIZE = DEFAULT_IMAGE_SIZE
module.exports.QvacErrorAddonVla = QvacErrorAddonVla
module.exports.ERR_CODES = ERR_CODES
