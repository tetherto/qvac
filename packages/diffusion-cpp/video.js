'use strict'

const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const { SdInterface, mapAddonEvent } = require('./addon')

const COMPANION_FILE_KEYS = [
  // Wan 2.1 / 2.2
  'highNoiseDiffusionModel', 't5Xxl', 'vae', 'clipVision', 'esrgan',
  // LTX-2 (LTXAV): Gemma text encoder (llm), audio VAE, embedding connectors.
  // `vae` is reused for the LTX video VAE.
  'llm', 'audioVae', 'embeddingsConnectors'
]

const VIDEO_MODES = new Set(['txt2vid', 'img2vid'])

function assertAbsolute (key, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`files.${key} must be an absolute path string`)
  }
  if (!path.isAbsolute(value)) {
    throw new TypeError(`files.${key} must be an absolute path (got: ${value})`)
  }
}

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

// Wan 2.1 / 2.2 latent temporal packing requires a (4 * k + 1) frame count
// where k >= 1. The native SdVidGenHandlers enforce the same rule — we check
// here too so the caller sees the error before any native work runs.
//
// Wan 1.3B's positional embeddings cap meaningful generation at 81 frames
// (its native training length, ~5.06 s @ 16 fps); going beyond produces
// visible quality breakdown / repetition. We don't reject above 81 because
// larger Wan variants (14B, future checkpoints) may extend that range, but
// the error message points users to the recommended set.
function validateVideoFrames (n, isLtx = false) {
  // Two distinct error classes: shape (must be an integer) vs. value
  // (the frame-count invariant). Tests rely on these messages staying
  // separable; merging them obscures which one tripped.
  //
  // Wan 2.1 / 2.2: (4*k + 1), k >= 1.  LTX-2: (8*k + 1), k >= 1, max 257
  // (the LTX latent temporal packing factor is 8, not 4).
  const factor = isLtx ? 8 : 4
  const min = factor + 1
  if (!Number.isInteger(n)) {
    throw new Error(
      `video_frames must be an integer of the form (${factor}*k + 1) with k >= 1. Got: ${n}`
    )
  }
  if (isLtx) {
    if (n < min || (n - 1) % 8 !== 0 || n > 257) {
      throw new Error(
        'LTX-2 video_frames must be an integer of the form (8*k + 1) in ' +
        `[9, 257] (9, 17, 25, 33, ..., 257). Got: ${n}`
      )
    }
    return
  }
  if (n < 5 || (n - 1) % 4 !== 0) {
    throw new Error(
      'video_frames must be an integer >= 5 of the form (4*k + 1). ' +
      'Valid values: 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, ' +
      '57, 61, 65, 69, 73, 77, 81 (Wan 1.3B native training length). ' +
      `Got: ${n}`
    )
  }
}

// See index.js::_coerceToUint8 for the long form of this contract — duplicated
// here only because video.js does not depend on index.js (separate entry
// points). Keep both copies in sync.
function _coerceToUint8 (name, value) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value) && value.BYTES_PER_ELEMENT === 1) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
    return new Uint8Array(value)
  }
  throw new TypeError(
    `${name} must be a Uint8Array / Buffer / ArrayBuffer of PNG/JPEG bytes. ` +
    `Got: ${value === null ? 'null' : typeof value}`
  )
}

// Read image width/height from a PNG or JPEG header without decoding pixels.
// Returns { w, h } on success, or null if the buffer is too short/unrecognised.
// Used to pre-validate off-grid frame dimensions before dispatching to C++.
function peekImageDims (buf) {
  if (!buf || buf.length < 8) return null
  // PNG: 8-byte signature → 4-byte IHDR length → "IHDR" → 4-byte width → 4-byte height
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
    buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A
  ) {
    if (buf.length < 24) return null
    const w = ((buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19]) >>> 0
    const h = ((buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23]) >>> 0
    return { w, h }
  }
  // JPEG: scan segments for SOF0–SOF3 (0xFF 0xC0–0xC3) which carry height/width
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2
    while (i + 3 < buf.length) {
      if (buf[i] !== 0xFF) break
      const marker = buf[i + 1]
      if (marker === 0xD9 || marker === 0xDA) break // EOI or SOS
      const segLen = (buf[i + 2] << 8) | buf[i + 3]
      if (marker >= 0xC0 && marker <= 0xC3) {
        if (buf.length >= i + 9) {
          const h = (buf[i + 5] << 8) | buf[i + 6]
          const w = (buf[i + 7] << 8) | buf[i + 8]
          return { w, h }
        }
        break
      }
      i += 2 + segLen
    }
  }
  return null
}

/**
 * Text-to-video and image-to-video generation using stable-diffusion.cpp's
 * `generate_video()` path. Supports Wan 2.1
 * (single expert) and Wan 2.2 (mixture-of-experts with low- and high-noise
 * denoisers).
 *
 * Shares the same native addon (`binding.createInstance` / `runJob` /
 * `destroyInstance`) as `ImgStableDiffusion` — the dispatch between image
 * and video happens inside C++ `SdModel::process()` based on the JSON
 * `mode` field this wrapper always sets.
 *
 * Output: a single `Uint8Array` containing an MJPG-encoded AVI (RIFF
 * container) arrives through `QvacResponse.onUpdate(data)`. For LTX-2 models
 * loaded with an `audioVae`, the AVI carries a second IEEE-float PCM audio
 * stream (48 kHz) muxed alongside the video. Progress ticks are delivered as
 * JSON strings in the same stream, identical to the image wrapper.
 */
class VideoStableDiffusion {
  /**
   * @param {object} args
   * @param {object} args.files
   * @param {string} args.files.model                     - Diffusion model
   *        (Wan 2.1 single expert or Wan 2.2 low-noise expert). Absolute path.
   * @param {string} [args.files.highNoiseDiffusionModel] - Wan 2.2 only:
   *        absolute path to the high-noise expert. Leave unset for Wan 2.1.
   * @param {string} [args.files.t5Xxl]                   - UMT5-XXL text
   *        encoder (Wan uses the `t5xxl_path` slot for UMT5). Absolute path.
   * @param {string} [args.files.vae]                     - Absolute path to
   *        the Wan VAE.
   * @param {string} [args.files.clipVision]              - Absolute path to
   *        clip_vision_h.safetensors (OpenCLIP ViT-H/14). Required for
   *        img2vid; omit for txt2vid.
   * @param {string} [args.files.esrgan]                  - Optional; forwarded
   *        to the native ctx as `esrganPath` (empty string when unset). Video
   *        generation does not use ESRGAN — same binding shape as image mode.
   * @param {object} [args.config]                        - SD context config
   *        (threads, device, flow_shift, etc.). Optional.
   * @param {object} [args.logger]                        - Structured logger for
   *        JS wrapper logs. Native C++ logs are process-global; configure them
   *        once with `require('@qvac/diffusion-cpp/addonLogging').setLogger(...)`
   *        (mirrors `ImgStableDiffusion` -- one global hook for the whole addon).
   * @param {object} [args.opts]                          - Inference options
   */
  constructor ({ files, config, logger = null, opts = {} }) {
    if (!files || typeof files !== 'object') {
      throw new TypeError('files must be an object containing at least { model }')
    }
    assertAbsolute('model', files.model)
    for (const key of COMPANION_FILE_KEYS) {
      if (files[key] !== undefined) {
        assertAbsolute(key, files[key])
      }
    }
    this._files = files
    this._config = config || {}
    this.logger = new QvacLogger(logger)
    this.opts = opts

    // Friendly warning: ESRGAN upscale is image-only (post-generation).
    // The native ctx accepts these keys for forward-compatibility, but the
    // video pipeline never wires them in, so they're silent no-ops here.
    // Surface that early so callers don't waste time tuning a tile size
    // that has no effect.
    const upscalerKeys = Object.keys(this._config).filter((k) =>
      k.startsWith('upscaler_'))
    if (upscalerKeys.length > 0) {
      this.logger.warn(
        `${upscalerKeys.join(', ')} provided in config but ESRGAN upscale ` +
        'is image-only -- VideoStableDiffusion will ignore these keys.'
      )
    }
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
    this.logger.info('Starting Wan video model load')

    // Wan always uses the `diffusionModelPath` slot for the low-noise /
    // single expert. `highNoiseDiffusionModelPath` is Wan 2.2 only. This
    // mirrors how ImgStableDiffusion routes FLUX2 split layouts into
    // `diffusionModelPath` rather than the all-in-one `path` slot.
    const configurationParams = {
      path: '',
      diffusionModelPath: this._files.model,
      highNoiseDiffusionModelPath: this._files.highNoiseDiffusionModel || '',
      clipLPath: '',
      clipGPath: '',
      t5XxlPath: this._files.t5Xxl || '',
      // Gemma text encoder for LTX-2 (reuses the llm_path slot, same as FLUX.2
      // Qwen3). Empty for Wan.
      llmPath: this._files.llm || '',
      vaePath: this._files.vae || '',
      clipVisionPath: this._files.clipVision || '',
      esrganPath: this._files.esrgan || '',
      // LTX-2 (LTXAV) extras. Empty for Wan.
      audioVaePath: this._files.audioVae || '',
      embeddingsConnectorsPath: this._files.embeddingsConnectors || '',
      config: this._config
    }

    this.logger.info(
      'Creating stable-diffusion addon (video mode) with configuration:',
      configurationParams
    )

    try {
      this.addon = this._createAddon(configurationParams)
      this.logger.info('Activating stable-diffusion addon (video mode)')
      await this.addon.activate()
    } catch (loadError) {
      this.logger.error('Error during Wan video model load:', loadError)
      // Best-effort cleanup of the partially-initialized addon so a
      // subsequent load() does not leak a zombie native instance.
      try { await this.addon?.unload?.() } catch (_) {}
      this.addon = null
      throw loadError
    }

    this.logger.info('Wan video model load completed successfully')
  }

  /**
   * @param {object} configurationParams
   * @returns {SdInterface}
   */
  _createAddon (configurationParams) {
    const binding = require('./binding')
    return new SdInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  _addonOutputCallback (addon, event, data, error) {
    const mapped = mapAddonEvent(event, data, error)
    if (mapped === null) {
      this.logger.debug(`Unhandled addon event: ${event} (data type: ${typeof data})`)
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
   * Generate a video.
   *
   * Mode is **required** for video (no auto-detect). Choose one of:
   *   - `'txt2vid'`  — prompt-only; rejects `init_image`.
   *   - `'img2vid'`  — animate a single starting frame; requires `init_image`.
   *
   * Output stream (via `QvacResponse.onUpdate(data)`):
   *   - `Uint8Array` — a single MJPG AVI buffer at end-of-job (with a muxed
   *     IEEE-float PCM audio stream for LTX-2 + audioVae).
   *   - `string`     — per-step progress JSON `{"step":N,"total":M,"elapsed_ms":T}`
   *
   * @param {object} params
   * @param {'txt2vid'|'img2vid'} params.mode - Required.
   * @param {string} params.prompt                      - Required.
   * @param {string} [params.negative_prompt]
   * @param {number} [params.width=480]                 - Default portrait (phone-screen friendly).
   * @param {number} [params.height=832]                - Override either field for landscape (832x480 is Wan 1.3B's training res).
   * @param {number} [params.video_frames=33]           - Must be (4*k+1); 5..81 recommended for Wan 1.3B.
   * @param {number} [params.fps=16]                    - AVI framerate (presentational).
   * @param {number} [params.seed=-1]                   - -1 = random.
   * @param {number} [params.steps=30]                  - Low-noise / only expert.
   * @param {string} [params.sampling_method='euler']
   * @param {string} [params.scheduler='simple']
   * @param {number} [params.cfg_scale=6.0]
   * @param {number} [params.flow_shift]                - Per-job override; > 0 wins, 0/omitted falls through to ctx flow_shift. Wan T2V 1.3B sweet spot: 3.0.
   * @param {number} [params.high_noise_steps]          - Wan 2.2 only.
   * @param {string} [params.high_noise_sampler]        - Wan 2.2 only.
   * @param {string} [params.high_noise_scheduler]      - Wan 2.2 only.
   * @param {number} [params.high_noise_cfg_scale]      - Wan 2.2 only.
   * @param {number} [params.high_noise_flow_shift]     - Wan 2.2 only.
   * @param {number} [params.moe_boundary]              - Wan 2.2 MoE split point [0,1].
   * @param {number} [params.strength]                  - img2vid denoise strength.
   * @param {number} [params.vace_strength]             - VACE control-frame guidance.
   * @param {Uint8Array}   [params.init_image]          - First frame (PNG/JPEG). Required for img2vid.
   * @param {Uint8Array[]} [params.control_frames]      - Optional VACE guidance frames.
   * @param {boolean} [params.vae_tiling]
   * @param {number|string} [params.vae_tile_size]
   * @param {number} [params.vae_tile_overlap]
   * @param {string} [params.cache_mode]
   * @param {string} [params.cache_preset]
   * @param {number} [params.cache_threshold]
   * @returns {Promise<QvacResponse>}
   */
  async run (params) {
    return this._run(() => this._runInternal(params))
  }

  async _runInternal (params) {
    if (!params || typeof params !== 'object') {
      throw new TypeError('run(params): params must be an object')
    }

    // The native handler enforces this too, but failing here gives a
    // precise JS-side error and avoids a roundtrip to C++ for trivially
    // invalid input.
    if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
      throw new TypeError(
        `params.prompt is required and must be a non-empty string. Got: ${typeof params.prompt}`
      )
    }

    // ── Mode is required and must be one of the two video modes ────────
    if (typeof params.mode !== 'string' || !VIDEO_MODES.has(params.mode)) {
      throw new Error(
        'VideoStableDiffusion.run: params.mode is required and must be one of ' +
        `'txt2vid' | 'img2vid'. Got: ${JSON.stringify(params.mode)}`
      )
    }
    const { mode } = params
    // True when the caller omits both width and height, meaning C++ will infer
    // them from the input image. In that case we pre-validate that the image
    // header dimensions are on the multiple-of-16 grid so the error message
    // names the actual pixels rather than an internal derived value.
    const dimsImplicit = params.width == null && params.height == null

    // LTX-2 has stricter constraints than Wan: 32x spatial VAE compression
    // (dims multiple of 32) and 8*k+1 frame packing. Detected from the
    // LTX-only companion files supplied at construction.
    const isLtx = this._isLtx()

    // ── Dimension alignment (multiples of 16 for Wan, 32 for LTX-2) ───────
    // Wan's spatial compression requires 16-aligned width/height (see
    // addon.js::_fillDimsFromImage). Only validate provided dims; C++ falls
    // back to 480x832 (portrait, phone-screen friendly) when omitted. Override
    // either field for landscape (832x480 is Wan 1.3B's training res).
    const alignTo = isLtx ? 32 : 16
    const w = params.width
    const h = params.height
    const wBad = w != null && (!Number.isFinite(w) || w <= 0 || w % alignTo !== 0)
    const hBad = h != null && (!Number.isFinite(h) || h <= 0 || h % alignTo !== 0)
    if (wBad || hBad) {
      const suggestW = Number.isFinite(w) && w > 0 ? Math.round(w / alignTo) * alignTo : (isLtx ? 768 : 480)
      const suggestH = Number.isFinite(h) && h > 0 ? Math.round(h / alignTo) * alignTo : (isLtx ? 512 : 832)
      throw new Error(
        `width and height must be positive multiples of ${alignTo}. ` +
        `Got: ${w}x${h}. Use ${suggestW}x${suggestH} instead.`
      )
    }

    // ── Frame-count validation (4*k+1 Wan / 8*k+1 LTX-2) ──────────────────
    if (params.video_frames != null) validateVideoFrames(params.video_frames, isLtx)

    // ── FPS validation ───────────────────────────────────────────────────
    if (params.fps != null) {
      if (!Number.isFinite(params.fps) || params.fps <= 0 || params.fps > 120) {
        throw new RangeError(`fps must be in (0, 120]. Got: ${params.fps}`)
      }
    }

    // ── moe_boundary validation (Wan 2.2) ────────────────────────────────
    if (params.moe_boundary != null) {
      const b = params.moe_boundary
      if (!Number.isFinite(b) || b < 0 || b > 1) {
        throw new RangeError(`moe_boundary must be in [0, 1]. Got: ${b}`)
      }
    }

    // ── init_image type checks ────────────────────────────────────────────
    // Accept Buffer / Uint8ClampedArray / ArrayBuffer in addition to plain
    // Uint8Array; see _coerceToUint8 above for the contract.
    if (params.init_image != null) {
      params.init_image = _coerceToUint8('init_image', params.init_image)
      if (params.init_image.length === 0) {
        throw new Error('init_image must not be empty')
      }
      if (dimsImplicit) {
        const dims = peekImageDims(params.init_image)
        if (dims && (dims.w % alignTo !== 0 || dims.h % alignTo !== 0)) {
          throw new Error(
            `init_image dimensions ${dims.w}x${dims.h} must be multiples of ${alignTo}. ` +
            'Pass explicit width/height to override or pre-scale the image.'
          )
        }
      }
    }

    // ── init_images is an image-only feature ─────────────────────────────
    if (params.init_images != null) {
      throw new Error(
        'VideoStableDiffusion does not accept init_images (FLUX fusion is ' +
        'image-only). Use init_image or control_frames for VACE guidance.'
      )
    }

    // ── Mode-vs-inputs invariants ─────────────────────────────────────────
    if (mode === 'txt2vid') {
      if (params.init_image != null) {
        throw new Error(
          "txt2vid does not accept init_image. Use mode='img2vid' instead."
        )
      }
    } else if (mode === 'img2vid') {
      // After coercion above, init_image is either a normalized Uint8Array
      // or null/undefined.
      if (!(params.init_image instanceof Uint8Array)) {
        throw new Error('img2vid requires init_image (Uint8Array / Buffer / ArrayBuffer of PNG/JPEG bytes).')
      }
    }

    // ── control_frames validation (optional, any video mode) ─────────────
    if (params.control_frames != null) {
      if (!Array.isArray(params.control_frames)) {
        throw new TypeError(
          'control_frames must be an Array of Uint8Array. ' +
          `Got: ${typeof params.control_frames}`
        )
      }
      if (params.control_frames.length === 0) {
        throw new Error(
          'control_frames must not be an empty array. Omit the field ' +
          'entirely to skip VACE guidance.'
        )
      }
      for (let i = 0; i < params.control_frames.length; i++) {
        let coerced
        try {
          coerced = _coerceToUint8(`control_frames[${i}]`, params.control_frames[i])
        } catch (_) {
          throw new TypeError(`control_frames[${i}] must be a non-empty Uint8Array`)
        }
        if (coerced.length === 0) {
          throw new TypeError(`control_frames[${i}] must be a non-empty Uint8Array`)
        }
        params.control_frames[i] = coerced
      }
      if (dimsImplicit) {
        for (let i = 0; i < params.control_frames.length; i++) {
          const dims = peekImageDims(params.control_frames[i])
          if (dims && (dims.w % alignTo !== 0 || dims.h % alignTo !== 0)) {
            throw new Error(
              `control_frames[${i}] dimensions ${dims.w}x${dims.h} must be multiples of ${alignTo}. ` +
              'Pass explicit width/height to override or pre-scale the frame.'
            )
          }
        }
      }
    }

    // ── vace_strength is only meaningful with control_frames ─────────────
    if (
      params.vace_strength != null &&
      (!Array.isArray(params.control_frames) ||
        params.control_frames.length === 0)
    ) {
      this.logger.warn(
        'vace_strength was set but control_frames is not provided — ' +
        'vace_strength will have no effect.'
      )
    }

    // ── Wan 2.1 I2V CLIP vision sanity check ───────────────────────────────
    // clip_vision_h.safetensors (OpenCLIP ViT-H/14) is required for image
    // conditioning in Wan 2.1 I2V. Without it the C++ layer cannot build the
    // img_emb projection and will produce garbage or crash.
    // LTX-2 (LTXAV) img2vid conditions on the input frame through the video VAE
    // rather than clip_vision, so this requirement is Wan-only — gating it on
    // isLtx keeps LTX img2vid usable from JS without a clip_vision file.
    if (mode === 'img2vid' && !isLtx && !this._files.clipVision) {
      throw new TypeError(
        `mode='${mode}' requires files.clipVision (OpenCLIP ViT-H/14). ` +
        'Download clip_vision_h.safetensors from ' +
        'Comfy-Org/Wan_2.1_ComfyUI_repackaged and pass its absolute path as ' +
        'files.clipVision.'
      )
    }

    // ── Wan 2.2 sanity check ─────────────────────────────────────────────
    // Friendly warning when high-noise-only params are set without a
    // high-noise expert configured on the context.
    const hasHighNoiseExpert = !!this._files.highNoiseDiffusionModel
    if (!hasHighNoiseExpert) {
      const highNoiseParams = [
        'high_noise_steps',
        'high_noise_sampler',
        'high_noise_scheduler',
        'high_noise_cfg_scale',
        'high_noise_flow_shift',
        'moe_boundary'
      ]
      const used = highNoiseParams.filter((k) => params[k] != null)
      if (used.length > 0) {
        this.logger.warn(
          `${used.join(', ')} supplied but files.highNoiseDiffusionModel ` +
          'is not set — these params are Wan 2.2-only and will be ignored.'
        )
      }
    }

    // ── LoRA is not supported for video generation ────────────────────────
    if (params.lora != null) {
      throw new Error(
        'params.lora is not supported for video generation yet. ' +
        'Video generation uses distinct diffusion and expert components ' +
        'that do not yet support LoRA injection.'
      )
    }

    if (!this.addon) {
      throw new Error('Addon not initialized. Call load() first.')
    }

    this.logger.info(`Starting video generation with mode: ${mode}`)

    // Two-level concurrency model:
    //  1. `_run` (exclusiveRunQueue) serializes the *synchronous body* of
    //     `_runInternal` -- one validate-and-dispatch at a time.
    //  2. `_hasActiveResponse` guards against overlap of the *asynchronous
    //     generation* itself: `_runInternal` returns the QvacResponse
    //     before generation completes, which releases the queue lock, so a
    //     second `model.run(...)` could otherwise enter while the previous
    //     response is still streaming. This flag rejects that case
    //     explicitly instead of letting both jobs fight over the addon.
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    const response = this._job.start()

    let accepted
    try {
      accepted = await this.addon.runJob({ ...params, mode })
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
      this.logger?.warn?.('Video generation response rejected:', err?.message || err)
    })
    response.await = () => finalized

    this.logger.info('Video generation job started successfully')
    return response
  }

  /**
   * Cancel the in-flight video generation job.
   */
  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  /**
   * Unload the model and release all resources.
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
        this.addon = null
      }
      this.state.configLoaded = false
    })
  }

  getState () { return this.state }

  /**
   * True when the configured model is LTX-2 (LTXAV). Keyed on the
   * embeddings-connectors input, which no other model family uses; this matches
   * the native detection (SdModel: isLtxModel_ = !embeddingsConnectorsPath.empty()).
   * audioVae is intentionally not used here: it is optional for LTX (silent runs
   * omit it), so keying on it would disagree with the native layer. Drives
   * model-aware validation (8*k+1 frames, x32 dims) on the JS side.
   * @returns {boolean}
   */
  _isLtx () {
    return !!this._files.embeddingsConnectors
  }
}

module.exports = VideoStableDiffusion
