import type { QvacResponse } from '@qvac/infer-base'
import type QvacLogger from '@qvac/logging'
import type { SamplerMethod, ScheduleType, SdConfig, CacheMode } from './index'

/** Supported video-generation modes for `VideoStableDiffusion.run()`. */
export type VideoMode = 'txt2vid' | 'img2vid' | 'flf2vid'

/**
 * File paths for a Wan video model context.
 *
 * Wan 2.1 uses a single diffusion expert -- set `model` to the only expert
 * and leave `highNoiseDiffusionModel` unset.
 *
 * Wan 2.2 uses a mixture-of-experts layout -- set `model` to the low-noise
 * expert and `highNoiseDiffusionModel` to the high-noise expert. The split
 * is governed at runtime by `moe_boundary`.
 */
export interface VideoDiffusionFiles {
  /** Absolute path to the (low-noise / single) diffusion expert. */
  model: string
  /** Wan 2.2 only: absolute path to the high-noise expert. */
  highNoiseDiffusionModel?: string
  /** Absolute path to the UMT5-XXL text encoder. */
  t5Xxl?: string
  /** Absolute path to the Wan VAE. */
  vae?: string
  /**
   * Optional ESRGAN weights path for native ctx parity; video jobs do not apply
   * ESRGAN. Omit and the addon passes an empty string.
   */
  esrgan?: string
}

export interface VideoStableDiffusionArgs {
  files: VideoDiffusionFiles
  /**
   * Native backend configuration. Optional -- when omitted the addon falls
   * back to stable-diffusion.cpp defaults for every parameter.
   */
  config?: SdConfig
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
}

/**
 * Per-job parameters for video generation.
 *
 * Mode is required (no auto-detect). Every mode enforces its own input
 * invariants both in the JS wrapper and in C++ `SdModel::processVideo()`:
 *   - `txt2vid` rejects `init_image` and `end_image`.
 *   - `img2vid` requires `init_image`, rejects `end_image`.
 *   - `flf2vid` requires both `init_image` (first frame) and `end_image`
 *     (last frame).
 */
export interface VideoGenerationParams {
  /** Required. Selects the generation branch. */
  mode: VideoMode
  prompt: string
  negative_prompt?: string

  /**
   * Video dimensions (multiples of 8). Default `480 x 832` portrait
   * (phone-screen friendly). Wan 2.1 T2V 1.3B is trained on `832 x 480`
   * landscape and handles both orientations equally well -- override
   * either field to switch.
   */
  width?: number
  height?: number

  /**
   * Total frame count. Must be of the form `(4 * k + 1)` with `k >= 1`
   * (5, 9, 13, 17, 21, 25, 29, 33, ...). Default: 33 (~2 s at the default
   * fps of 16; 33 / 16 ~= 2.06 s).
   */
  video_frames?: number

  /** AVI framerate metadata. (0, 120]. Default: 16. */
  fps?: number

  /** -1 = random. */
  seed?: number

  /** Low-noise / only expert sample count. */
  steps?: number
  sampling_method?: SamplerMethod
  scheduler?: ScheduleType
  cfg_scale?: number
  /**
   * Per-job override of `SdConfig.flow_shift` (flow-matching noise schedule
   * shift). **Convention:** any value `> 0` overrides; the sentinel value
   * `0` (the default when omitted) falls through to the context-level
   * `SdConfig.flow_shift`, which itself defaults to the model's embedded
   * value. Do not pass `0` to "disable" flow shifting -- omit the field or
   * use the ctx-level setting instead.
   *
   * Wan T2V 1.3B sweet spot: `3.0` (lower values produce visibly more
   * motion; higher values flatten the trajectory).
   */
  flow_shift?: number

  // ── Wan 2.2 high-noise expert knobs (ignored when single expert) ──────
  high_noise_steps?: number
  high_noise_sampler?: SamplerMethod
  high_noise_scheduler?: ScheduleType
  high_noise_cfg_scale?: number
  high_noise_flow_shift?: number
  /** Boundary between low- and high-noise trajectories. [0, 1]. */
  moe_boundary?: number

  // ── Conditioning inputs ───────────────────────────────────────────────
  /** img2vid / flf2vid denoise strength (0.0 to 1.0). */
  strength?: number
  /** VACE control-frame guidance strength (0.0 to 1.0). */
  vace_strength?: number
  /** First frame (PNG/JPEG bytes). Required for img2vid / flf2vid. */
  init_image?: Uint8Array
  /** flf2vid only: last frame (PNG/JPEG bytes). */
  end_image?: Uint8Array
  /** Optional VACE guidance frames (one PNG/JPEG per frame). */
  control_frames?: Uint8Array[]

  // ── Shared plumbing ───────────────────────────────────────────────────
  vae_tiling?: boolean
  vae_tile_size?: number | string
  vae_tile_overlap?: number
  cache_mode?: CacheMode
  cache_preset?: string
  cache_threshold?: number
}

/**
 * Shape of the stats object emitted on the 'stats' event of a video-job
 * QvacResponse. Cumulative fields accumulate across the lifetime of the
 * model instance; per-job fields (`generationMs`, `width`, `height`,
 * `seed`, `videoFrames`, `fps`) reflect only the most recent job.
 */
export interface VideoRuntimeStats {
  modelLoadMs: number
  generationMs: number
  totalGenerationMs: number
  totalWallMs: number
  totalSteps: number
  totalGenerations: number
  totalImages: number
  totalPixels: number
  /** Cumulative number of videos produced. */
  totalVideos: number
  /** Cumulative number of video frames produced. */
  totalVideoFrames: number
  width: number
  height: number
  seed: number
  /** Frame count of the most recent video. */
  videoFrames: number
  /** Frames-per-second of the most recent video. */
  fps: number
}

export default class VideoStableDiffusion {
  opts: { stats?: boolean }
  logger: QvacLogger
  state: { configLoaded: boolean }

  constructor (args: VideoStableDiffusionArgs)

  /** Load the Wan diffusion context. Idempotent. */
  load (): Promise<void>

  /**
   * Generate a video. Returns a `QvacResponse` whose `onUpdate(data)`
   * stream carries one final `Uint8Array` (MJPG AVI buffer) and JSON
   * progress-tick strings throughout denoising.
   */
  run (params: VideoGenerationParams): Promise<QvacResponse>

  /** Cancel the in-flight video generation job. */
  cancel (): Promise<void>

  /** Unload the model and release all resources. */
  unload (): Promise<void>

  getState (): { configLoaded: boolean }
}
