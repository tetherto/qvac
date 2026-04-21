'use strict'

const binding = require('./binding')
const { preprocessImage, padState, DEFAULT_IMAGE_SIZE } = require('./addon.js')

/**
 * SmolVLA vision-language-action model. Wraps the native addon's opaque
 * handle with a JS-side class that owns the lifetime.
 *
 * Usage:
 *   const model = new VlaModel('/path/to/smolvla.gguf')
 *   const actions = model.run({
 *     images: [frontCamChw, wristCamChw],  // Float32Array(3*H*W) in [-1, 1]
 *     imgWidth: 512,
 *     imgHeight: 512,
 *     state: paddedStateF32,               // Float32Array(max_state_dim)
 *     tokens: tokenIdsI32,                 // Int32Array
 *     mask: attentionMaskU8,               // Uint8Array (0/1)
 *     noise: optionalNoiseF32              // optional Float32Array
 *   })
 *   model.destroy()
 */
class VlaModel {
  constructor (ggufPath) {
    if (typeof ggufPath !== 'string' || ggufPath.length === 0) {
      throw new TypeError('VlaModel: ggufPath must be a non-empty string')
    }
    this._handle = binding.createVlaModel(ggufPath)
    this._hparams = binding.getVlaHparams(this._handle)
  }

  get hparams () { return this._hparams }

  run (opts) {
    if (!this._handle) throw new Error('VlaModel has been destroyed')
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('VlaModel.run: opts must be an object')
    }
    if (!Array.isArray(opts.images) || opts.images.length === 0) {
      throw new TypeError('VlaModel.run: opts.images must be a non-empty array of Float32Array')
    }
    const imgWidth = opts.imgWidth ?? DEFAULT_IMAGE_SIZE
    const imgHeight = opts.imgHeight ?? DEFAULT_IMAGE_SIZE
    const expectedPerImage = 3 * imgWidth * imgHeight
    for (let i = 0; i < opts.images.length; i++) {
      const img = opts.images[i]
      if (!(img instanceof Float32Array)) {
        throw new TypeError(`VlaModel.run: opts.images[${i}] must be a Float32Array`)
      }
      if (img.length !== expectedPerImage) {
        throw new RangeError(`VlaModel.run: opts.images[${i}] length ${img.length} != 3*${imgWidth}*${imgHeight}`)
      }
    }
    if (!(opts.state instanceof Float32Array)) {
      throw new TypeError('VlaModel.run: opts.state must be a Float32Array')
    }
    if (!(opts.tokens instanceof Int32Array)) {
      throw new TypeError('VlaModel.run: opts.tokens must be an Int32Array')
    }
    if (!(opts.mask instanceof Uint8Array)) {
      throw new TypeError('VlaModel.run: opts.mask must be a Uint8Array')
    }
    if (opts.mask.length !== opts.tokens.length) {
      throw new RangeError('VlaModel.run: opts.mask and opts.tokens must have the same length')
    }
    if (opts.noise !== undefined && opts.noise !== null && !(opts.noise instanceof Float32Array)) {
      throw new TypeError('VlaModel.run: opts.noise must be a Float32Array when provided')
    }

    return binding.runVlaModel(this._handle, {
      images: opts.images,
      imgWidth,
      imgHeight,
      state: opts.state,
      tokens: opts.tokens,
      mask: opts.mask,
      noise: opts.noise ?? undefined
    })
  }

  destroy () {
    if (!this._handle) return
    binding.destroyVlaModel(this._handle)
    this._handle = null
  }
}

module.exports = {
  VlaModel,
  preprocessImage,
  padState,
  DEFAULT_IMAGE_SIZE
}
