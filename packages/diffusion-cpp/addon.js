'use strict'

const path = require('bare-path')

/**
 * Normalize a raw native event into `Output` (image bytes or progress
 * tick), `Error`, or `JobEnded`. Returns `null` for unknown shapes
 * (caller logs and skips).
 *
 * @param {string} rawEvent
 * @param {*} rawData
 * @param {*} rawError
 * @returns {{ type: string, data: *, error: * } | null}
 */
function mapAddonEvent (rawEvent, rawData, rawError) {
  if (typeof rawEvent === 'string' && rawEvent.includes('Error')) {
    return { type: 'Error', data: rawData, error: rawError }
  }

  if (rawData instanceof Uint8Array || typeof rawData === 'string') {
    return { type: 'Output', data: rawData, error: null }
  }

  // JobEnded carries a plain runtime-stats POJO. Excluding typed-array views
  // here keeps future per-frame typed-array handlers (e.g. when
  // SdModel::GenerationJob::frameCallback wires through to JS) from being
  // misclassified as JobEnded and prematurely closing the response stream.
  // `ArrayBuffer.isView` is true for every TypedArray + DataView, false for
  // plain objects -- exactly the discrimination we want.
  if (rawData && typeof rawData === 'object' && !ArrayBuffer.isView(rawData)) {
    return { type: 'JobEnded', data: rawData, error: null }
  }

  return null
}

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
    // Pass init_image / init_images / end_image / control_frames Uint8Array(s)
    // directly to C++ as typed-array properties (avoids JSON-encoding every
    // byte as a number).
    //
    // Mutual-exclusion is enforced in the wrapper classes before we get here
    // and in SdModel::process() on the C++ side, but we still guard against
    // both init_image and init_images being set at this boundary so a direct
    // misuse of addon.js doesn't silently drop one of the buffers.
    if (params.init_image && Array.isArray(params.init_images) && params.init_images.length > 0) {
      throw new Error(
        'addon.runJob: init_image and init_images are mutually exclusive — pick one.'
      )
    }

    // ── Video-specific buffers ───────────────────────────────────────────
    // `end_image` -- flf2vid (first-last-frame interpolation).
    // `control_frames` -- VACE-guided video generation (array of Uint8Array,
    //                     one per frame).
    // These are always forwarded as dedicated typed-array properties to the
    // native runJob so they bypass JSON serialisation the same way
    // `initImageBuffer(s)` do. Both are optional and can appear alongside a
    // single `init_image` (img2vid / flf2vid); SdModel::processVideo()
    // enforces the final mode-vs-inputs invariants.
    const endImageBuf = params.end_image
    const controlFramesBufs = Array.isArray(params.control_frames)
      ? params.control_frames
      : null

    // ── Multi-reference ("fusion") path ─────────────────────────────────────
    // FLUX2 in-context conditioning with N reference images. index.js defaults
    // width/height to 1024 for FLUX img2img before this point, so
    // _fillDimsFromImage is a no-op when both axes are already set.
    // auto_resize_ref_image handles per-reference resizing inside
    // generate_image() for the remaining refs.
    if (Array.isArray(params.init_images) && params.init_images.length > 0) {
      const serializable = { ...params }
      const imgBufs = serializable.init_images
      delete serializable.init_images
      delete serializable.end_image
      delete serializable.control_frames

      this._fillDimsFromImage(serializable, imgBufs[0])

      const paramsJson = JSON.stringify(serializable)
      const jobArgs = {
        type: 'text',
        input: paramsJson,
        initImageBuffers: imgBufs
      }
      if (endImageBuf) jobArgs.endImageBuffer = endImageBuf
      if (controlFramesBufs) jobArgs.controlFramesBuffers = controlFramesBufs
      return this._binding.runJob(this._handle, jobArgs)
    }

    // ── Single-image path ──────────────────────────────────────────────────
    // Used by:
    //   - image mode: img2img (SDEdit or FLUX.2 single ref)
    //   - video mode: img2vid (first frame) or flf2vid (first frame; `end_image`
    //                 provides the last frame)
    // Auto-detect width/height from the image header so the C++ tensor
    // dimensions always match the decoded image — without this, generate_image()
    // hits GGML_ASSERT(image.width == tensor->ne[0]). The same auto-detect
    // is useful for img2vid / flf2vid so Wan's expected video dimensions
    // match the first frame without the caller having to specify them.
    if (params.init_image) {
      const serializable = { ...params }
      const imgBuf = serializable.init_image
      delete serializable.init_image
      delete serializable.end_image
      delete serializable.control_frames

      this._fillDimsFromImage(serializable, imgBuf)

      const paramsJson = JSON.stringify(serializable)
      const jobArgs = {
        type: 'text',
        input: paramsJson,
        initImageBuffer: imgBuf
      }
      if (endImageBuf) jobArgs.endImageBuffer = endImageBuf
      if (controlFramesBufs) jobArgs.controlFramesBuffers = controlFramesBufs
      return this._binding.runJob(this._handle, jobArgs)
    }

    // ── Prompt-only path (txt2img / txt2vid) ──────────────────────────────
    // txt2vid may still ship control_frames for VACE-guided generation even
    // without an init_image, so forward those too. Both keys are stripped
    // from the JSON payload above and re-attached as raw typed arrays on
    // jobArgs below -- this is the *only* supported transport for these
    // buffers; passing them inside the JSON would JSON.stringify each byte
    // into a decimal number (~3-4x bloat) and break native deserialization.
    const serializable = { ...params }
    delete serializable.end_image
    delete serializable.control_frames
    const paramsJson = JSON.stringify(serializable)
    const jobArgs = { type: 'text', input: paramsJson }
    if (endImageBuf) jobArgs.endImageBuffer = endImageBuf
    if (controlFramesBufs) jobArgs.controlFramesBuffers = controlFramesBufs
    return this._binding.runJob(this._handle, jobArgs)
  }

  /**
   * Helper: fill missing dimensions from image buffer, preserving explicit values.
   *
   * Rounds the auto-detected dimensions up to the nearest multiple of 8.
   * The native SdGenHandlers validates width/height % 8 == 0 *before* the
   * downstream alignment in SdModel::processImage gets a chance to run,
   * so passing raw image dimensions (e.g. 500x627 for the bundled
   * assets/von-neumann.jpg) makes img2img calls fail with:
   *   "height must be a positive multiple of 8, got: 627"
   *
   * The image path is the only consumer that hits this: the FLUX/FLUX2
   * multi-reference path uses generate_image()'s auto_resize_ref_image
   * internally, and the video path (VideoStableDiffusion._runInternal)
   * pre-validates off-grid init/end/control frames at the JS layer and
   * rejects them with a clear caller-facing error before this helper
   * runs, so the ceil() here is a no-op on aligned video inputs.
   *
   * @private
   */
  _fillDimsFromImage (params, buf) {
    if (params.width && params.height) return // Both provided, no-op

    const dims = readImageDimensions(buf)
    if (!dims) return

    const align8 = (n) => Math.ceil(n / 8) * 8
    if (!params.width) params.width = align8(dims.width)
    if (!params.height) params.height = align8(dims.height)
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

class EsrganUpscalerInterface {
  /**
   * @param {object} binding - The native addon binding (from require.addon())
   * @param {object} configurationParams - Configuration for the ESRGAN context
   * @param {string} configurationParams.esrganPath - Local file path to ESRGAN weights
   * @param {object} [configurationParams.config] - ESRGAN-specific configuration options
   * @param {Function} outputCb - Called on any upscale event
   */
  constructor (binding, configurationParams, outputCb) {
    this._binding = binding

    if (!configurationParams.config) {
      configurationParams.config = {}
    }

    if (!configurationParams.config.backendsDir) {
      configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds')
    }

    configurationParams.config = Object.fromEntries(
      Object.entries(configurationParams.config)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    )

    this._handle = this._binding.createUpscalerInstance(
      this,
      configurationParams,
      outputCb
    )
  }

  async activate () {
    this._binding.activateUpscaler(this._handle)
  }

  async cancel () {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  async runJob (imageBytes, params) {
    return this._binding.runUpscaleJob(this._handle, {
      type: 'image',
      input: imageBytes,
      params: JSON.stringify(params || {})
    })
  }

  async unload () {
    if (!this._handle) return
    this._binding.destroyInstance(this._handle)
    this._handle = null
  }
}

module.exports = {
  SdInterface,
  EsrganUpscalerInterface,
  mapAddonEvent,
  readImageDimensions
}
