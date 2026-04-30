'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const binding = require('./binding')
const { preprocessImage, padState, DEFAULT_IMAGE_SIZE } = require('./addon.js')
const { QvacErrorAddonVla, ERR_CODES } = require('./lib/error')

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
    this._job = createJobHandler({ cancel: () => {} })
    this._run = exclusiveRunQueue()
    this._handle = null
    this._hparams = null
    this._backendName = null
    this._hasActiveResponse = false
    this.state = { configLoaded: false }
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
    const ggufPath = pickPrimaryGgufPath(this._files)
    if (!fs.existsSync(ggufPath)) {
      throw new QvacErrorAddonVla({ code: ERR_CODES.MODEL_NOT_FOUND, adds: ggufPath })
    }
    try {
      this._handle = binding.createVlaModel(ggufPath, backend)
      this._hparams = binding.getVlaHparams(this._handle)
      this._backendName = binding.getVlaBackendName(this._handle)
    } catch (loadError) {
      this.logger.error('Error during model load:', loadError)
      if (this._handle) {
        try { binding.destroyVlaModel(this._handle) } catch (_) {}
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

    let result
    try {
      result = binding.runVlaModel(this._handle, {
        images: input.images,
        imgWidth,
        imgHeight,
        state: input.state,
        tokens: input.tokens,
        mask: input.mask,
        noise: input.noise ?? undefined
      })
    } catch (err) {
      this._hasActiveResponse = false
      this._job.fail(err)
      throw err
    }

    this._job.output(result)
    this._job.end(this.opts.stats ? result.stats : null, result)
    this._hasActiveResponse = false

    this.logger.info('Inference job completed')
    return response
  }

  async pause () { /* no-op: synchronous backend has no in-flight cancel point */ }

  async cancel () { /* no-op: see pause() */ }

  async unload () {
    return this._run(async () => {
      if (this._job.active) {
        this._job.fail(new QvacErrorAddonVla({ code: ERR_CODES.MODEL_UNLOADED }))
      }
      this._hasActiveResponse = false
      if (this._handle) {
        try {
          binding.destroyVlaModel(this._handle)
        } catch (destroyError) {
          this._handle = null
          throw new QvacErrorAddonVla({ code: ERR_CODES.FAILED_TO_DESTROY, adds: destroyError.message, cause: destroyError })
        }
        this._handle = null
      }
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
