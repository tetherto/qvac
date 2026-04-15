'use strict'

const path = require('bare-path')

/**
 * Extract pixel dimensions from a PNG or JPEG buffer without a full decode.
 *
 * PNG: width/height are stored as big-endian uint32 at bytes 16–23 of the IHDR chunk.
 * JPEG: scan for the first SOFx segment (0xFFCx) which stores height at +5 and width at +7.
 *
 * Returns { width, height } or null if the format is not recognised.
 *
 * @param {Uint8Array} buf
 * @returns {{ width: number, height: number } | null}
 */
function readImageDimensions (buf) {
  if (!buf || buf.length < 4) return null

  // PNG — magic: \x89PNG\r\n\x1a\n  (IHDR width/height at bytes 16–23)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    if (buf.length < 24) return null
    const w = (buf[16] << 24 | buf[17] << 16 | buf[18] << 8 | buf[19]) >>> 0
    const h = (buf[20] << 24 | buf[21] << 16 | buf[22] << 8 | buf[23]) >>> 0
    return { width: w, height: h }
  }

  // JPEG — magic: 0xFF 0xD8
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2
    while (i + 4 < buf.length) {
      if (buf[i] !== 0xFF) break
      const marker = buf[i + 1]
      const segLen = (buf[i + 2] << 8 | buf[i + 3])
      if (segLen < 2) break
      // SOF0–SOF3, SOF5–SOF7, SOF9–SOF11, SOF13–SOF15
      if (
        (marker >= 0xC0 && marker <= 0xC3) ||
        (marker >= 0xC5 && marker <= 0xC7) ||
        (marker >= 0xC9 && marker <= 0xCB) ||
        (marker >= 0xCD && marker <= 0xCF)
      ) {
        if (i + 8 >= buf.length) return null
        const h = (buf[i + 5] << 8 | buf[i + 6])
        const w = (buf[i + 7] << 8 | buf[i + 8])
        return { width: w, height: h }
      }
      i += 2 + segLen
    }
  }

  return null
}

/**
 * JavaScript wrapper around the native stable-diffusion.cpp addon.
 * Manages the native handle lifecycle and bridges JS ↔ C++.
 */
class SdInterface {
  /**
   * @param {object} binding - The native addon binding (from require.addon())
   * @param {object} configurationParams - Configuration for the SD context
   * @param {string} configurationParams.path - Local file path to the model weights
   * @param {object} [configurationParams.config] - SD-specific configuration options
   * @param {Function} outputCb - Called on any generation event (started, progress, output, error)
   */
  constructor (binding, configurationParams, outputCb) {
    this._binding = binding

    if (!configurationParams.config) {
      configurationParams.config = {}
    }

    if (!configurationParams.config.backendsDir) {
      configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds')
    }

    // C++ getSubmap expects every config value to be a JS string.
    // Coerce numbers and booleans here so the native layer never sees non-string values.
    configurationParams.config = Object.fromEntries(
      Object.entries(configurationParams.config)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    )

    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      outputCb
    )
  }

  /**
   * Moves addon to the LISTENING state after initialization.
   */
  async activate () {
    this._binding.activate(this._handle)
  }

  /**
   * Cancel the current generation job.
   */
  async cancel () {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  /**
   * Run a generation job with the given parameters.
   * @param {object} params - Generation parameters (will be JSON-serialized)
   * @returns {Promise<boolean>} true if job was accepted, false if busy
   */
  async runJob (params) {
    // Pass init_image Uint8Array directly to C++ as a typed-array property
    // (avoids JSON-encoding every byte as a number).
    // Auto-detect width/height from the image header so the C++ tensor
    // dimensions always match the decoded image — without this, generate_image()
    // hits GGML_ASSERT(image.width == tensor->ne[0]).
    if (params.init_image) {
      const serializable = { ...params }
      const imgBuf = serializable.init_image
      delete serializable.init_image

      if (!serializable.width || !serializable.height) {
        const dims = readImageDimensions(imgBuf)
        if (dims) {
          serializable.width = Math.ceil(dims.width / 8) * 8
          serializable.height = Math.ceil(dims.height / 8) * 8
        }
      }

      const paramsJson = JSON.stringify(serializable)
      return this._binding.runJob(this._handle, {
        type: 'text',
        input: paramsJson,
        initImageBuffer: imgBuf
      })
    }

    const paramsJson = JSON.stringify(params)
    return this._binding.runJob(this._handle, { type: 'text', input: paramsJson })
  }

  /**
   * Destroy the native instance and release all resources.
   * After this the SdInterface object must not be used.
   */
  async unload () {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }
}

module.exports = { SdInterface, readImageDimensions }
