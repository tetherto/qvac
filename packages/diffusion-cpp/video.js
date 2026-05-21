'use strict'

const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const { SdInterface, mapAddonEvent, readImageDimensions } = require('./addon')

const COMPANION_FILE_KEYS = ['highNoiseDiffusionModel', 't5Xxl', 'vae', 'esrgan']

const VIDEO_MODES = new Set(['txt2vid', 'img2vid', 'flf2vid'])

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
function validateVideoFrames (n) {
  if (!Number.isFinite(n) || n < 5 || (n - 1) % 4 !== 0) {
    throw new Error(
      'video_frames must be an integer >= 5 of the form (4*k + 1). ' +
      'Valid values: 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, ' +
      '57, 61, 65, 69, 73, 77, 81 (Wan 1.3B native training length). ' +
      `Got: ${n}`
    )
  }
}

/**
 * Text-to-video, image-to-video, and first-last-frame video generation
 * using stable-diffusion.cpp's `generate_video()` path. Supports Wan 2.1
 * (single expert) and Wan 2.2 (mixture-of-experts with low- and high-noise
 * denoisers).
 *
 * Shares the same native addon (`binding.createInstance` / `runJob` /
 * `destroyInstance`) as `ImgStableDiffusion` — the dispatch between image
 * and video happens inside C++ `SdModel::process()` based on the JSON
 * `mode` field this wrapper always sets.
 *
 * Output: a single `Uint8Array` containing an MJPG-encoded AVI (RIFF
 * container) arrives through `QvacResponse.onUpdate(data)`. Progress ticks
 * are delivered as JSON strings in the same stream, identical to the image
 * wrapper.
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
      llmPath: '',
      vaePath: this._files.vae || '',
      esrganPath: this._files.esrgan || '',
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
   *   - `'txt2vid'`  — prompt-only; rejects `init_image` and `end_image`.
   *   - `'img2vid'`  — animate a single starting frame; requires
   *                    `init_image`; rejects `end_image`.
   *   - `'flf2vid'`  — interpolate between two frames; requires both
   *                    `init_image` (first) and `end_image` (last).
   *
   * Output stream (via `QvacResponse.onUpdate(data)`):
   *   - `Uint8Array` — a single MJPG AVI buffer at end-of-job.
   *   - `string`     — per-step progress JSON `{"step":N,"total":M,"elapsed_ms":T}`
   *
   * @param {object} params
   * @param {'txt2vid'|'img2vid'|'flf2vid'} params.mode - Required.
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
   * @param {number} [params.strength]                  - img2vid / flf2vid denoise strength.
   * @param {number} [params.vace_strength]             - VACE control-frame guidance.
   * @param {Uint8Array}   [params.init_image]          - First frame (PNG/JPEG).
   * @param {Uint8Array}   [params.end_image]           - flf2vid only: last frame.
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

    // ── Mode is required and must be one of the three video modes ──────
    if (typeof params.mode !== 'string' || !VIDEO_MODES.has(params.mode)) {
      throw new Error(
        'VideoStableDiffusion.run: params.mode is required and must be one of ' +
        `'txt2vid' | 'img2vid' | 'flf2vid'. Got: ${JSON.stringify(params.mode)}`
      )
    }
    const { mode } = params

    // ── Prompt is required ─────────────────────────────────────────────
    // JSDoc declares `params.prompt` as Required, but it's never type-checked
    // here. Without this guard:
    //   prompt: undefined  → JSON.stringify strips the key → C++
    //                        SdVidGenConfig::prompt stays "" → noise-y, empty-
    //                        prompt clip with no diagnostic.
    //   prompt: ""         → SdParsers::requireStr accepts (no length check)
    //                        → same outcome.
    //   prompt: 42         → stringifies to "42" → requireStr throws in the
    //                        native handler, far from this layer (confusing).
    // Catch all three here so the JS caller gets one clear error at the
    // wrapper boundary.
    if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
      throw new TypeError(
        'params.prompt is required and must be a non-empty string'
      )
    }

    // ── Dimension alignment (multiples of 8) ─────────────────────────────
    // Only validate provided dims; C++ falls back to 480x832 (portrait,
    // phone-screen friendly) when omitted. Override either field for
    // landscape (832x480 is Wan 1.3B's training res).
    const alignTo = 8
    const w = params.width
    const h = params.height
    const wBad = w != null && (!Number.isFinite(w) || w <= 0 || w % alignTo !== 0)
    const hBad = h != null && (!Number.isFinite(h) || h <= 0 || h % alignTo !== 0)
    if (wBad || hBad) {
      const suggestW = Number.isFinite(w) && w > 0 ? Math.round(w / alignTo) * alignTo : 480
      const suggestH = Number.isFinite(h) && h > 0 ? Math.round(h / alignTo) * alignTo : 832
      throw new Error(
        `width and height must be positive multiples of ${alignTo}. ` +
        `Got: ${w}x${h}. Use ${suggestW}x${suggestH} instead.`
      )
    }

    // ── Frame-count validation (4*k+1 rule) ──────────────────────────────
    if (params.video_frames != null) validateVideoFrames(params.video_frames)

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

    // ── init_image / end_image type checks ───────────────────────────────
    if (params.init_image != null && !(params.init_image instanceof Uint8Array)) {
      throw new TypeError(
        'init_image must be a Uint8Array (e.g. fs.readFileSync("frame.png")). ' +
        `Got: ${typeof params.init_image}`
      )
    }
    if (params.end_image != null && !(params.end_image instanceof Uint8Array)) {
      throw new TypeError(
        `end_image must be a Uint8Array. Got: ${typeof params.end_image}`
      )
    }
    if (params.init_image instanceof Uint8Array && params.init_image.length === 0) {
      throw new Error('init_image must not be empty')
    }
    if (params.end_image instanceof Uint8Array && params.end_image.length === 0) {
      throw new Error('end_image must not be empty')
    }

    // ── init_images is an image-only feature ─────────────────────────────
    if (params.init_images != null) {
      throw new Error(
        'VideoStableDiffusion does not accept init_images (FLUX fusion is ' +
        'image-only). Use init_image (and end_image for flf2vid), or ' +
        'control_frames for VACE guidance.'
      )
    }

    // ── Mode-vs-inputs invariants (mirror SdModel::processVideo) ─────────
    if (mode === 'txt2vid') {
      if (params.init_image != null) {
        throw new Error(
          "txt2vid does not accept init_image. Use mode='img2vid' or " +
          "'flf2vid' instead."
        )
      }
      if (params.end_image != null) {
        throw new Error('txt2vid does not accept end_image.')
      }
    } else if (mode === 'img2vid') {
      if (!(params.init_image instanceof Uint8Array)) {
        throw new Error('img2vid requires init_image (Uint8Array of PNG/JPEG bytes).')
      }
      if (params.end_image != null) {
        throw new Error(
          "end_image is only valid for mode='flf2vid'. Use flf2vid to " +
          'interpolate between a first and last frame.'
        )
      }
    } else {
      // flf2vid
      if (!(params.init_image instanceof Uint8Array)) {
        throw new Error('flf2vid requires init_image (first frame, Uint8Array).')
      }
      if (!(params.end_image instanceof Uint8Array)) {
        throw new Error('flf2vid requires end_image (last frame, Uint8Array).')
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
        const f = params.control_frames[i]
        if (!(f instanceof Uint8Array) || f.length === 0) {
          throw new Error(
            `control_frames[${i}] must be a non-empty Uint8Array (PNG/JPEG bytes).`
          )
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

    // ── Off-grid image probe (implicit-dim path) ─────────────────────────
    // Native processVideo() strict-compares every decoded init/end/control
    // frame against vid.width / vid.height. When the caller doesn't pass
    // explicit width/height, addon.js infers them from the first image's
    // actual pixel dims (verbatim -- no silent rounding). Wan requires
    // multiples of 8, so an off-grid image here would fail deep in the
    // native pipeline with a cryptic stride error. Catch it up front and
    // tell the user exactly which image and how to fix it.
    if (params.width == null || params.height == null) {
      const offGrid = (label, buf) => {
        const d = readImageDimensions(buf)
        if (!d) return null
        if (d.width % alignTo !== 0 || d.height % alignTo !== 0) {
          return `${label} dimensions ${d.width}x${d.height} must be ` +
            `multiples of ${alignTo}. Pre-align the image, or pass ` +
            `explicit width/height (also multiples of ${alignTo}) so the ` +
            'video pipeline uses those dims instead.'
        }
        return null
      }
      if (params.init_image instanceof Uint8Array) {
        const err = offGrid('init_image', params.init_image)
        if (err) throw new Error(err)
      }
      if (params.end_image instanceof Uint8Array) {
        const err = offGrid('end_image', params.end_image)
        if (err) throw new Error(err)
      }
      if (Array.isArray(params.control_frames)) {
        for (let i = 0; i < params.control_frames.length; i++) {
          const err = offGrid(`control_frames[${i}]`, params.control_frames[i])
          if (err) throw new Error(err)
        }
      }
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

    // ── LoRA: not yet supported on the video path ────────────────────────
    // `SD_VID_GEN_HANDLERS` has no "lora" entry and `SdModel::processVideo`
    // never touches `sd_vid_gen_params_t::loras` / `lora_count`, so any LoRA
    // path passed through here is silently dropped by the native side. Fail
    // loudly at the JS boundary instead of silently producing LoRA-less
    // output -- callers can re-enable this once the native handler + wiring
    // land (mirror of `processImage` + `prepareLoras()`).
    if (params.lora != null) {
      throw new TypeError(
        'params.lora is not supported for video generation yet. ' +
        'LoRA is currently only wired through the image path ' +
        '(ImgStableDiffusion); the Wan video pipeline ignores it.'
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
}

module.exports = VideoStableDiffusion
