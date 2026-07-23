import QvacLogger = require('@qvac/logging');
import { type QvacResponse } from '@qvac/infer-base';
import type { CacheMode, SamplerMethod, ScheduleType, SdConfig } from './index';
export type VideoMode = 'txt2vid' | 'img2vid';
/**
 * File paths for a video model context (Wan 2.1 / 2.2 or LTX-2 / LTXAV).
 *
 * Wan 2.2 TI2V-5B uses only `model`, like Wan 2.1, but requires the matching
 * Wan 2.2 VAE. Wan 2.2 T2V-A14B uses both `model` (low noise) and
 * `highNoiseDiffusionModel` (high noise).
 */
export interface VideoDiffusionFiles {
    model: string;
    highNoiseDiffusionModel?: string;
    t5Xxl?: string;
    llm?: string;
    vae?: string;
    clipVision?: string;
    audioVae?: string;
    embeddingsConnectors?: string;
    esrgan?: string;
}
export interface VideoStableDiffusionArgs {
    files: VideoDiffusionFiles;
    config?: SdConfig;
    logger?: QvacLogger | Console | null;
    opts?: {
        stats?: boolean;
    };
}
export interface VideoGenerationParams {
    /** Required. Selects the generation branch. */
    mode: VideoMode;
    prompt: string;
    negative_prompt?: string;
    /**
     * Wan 2.1 dimensions must be multiples of 16. Wan 2.2 TI2V and LTX-2 use a
     * 32-pixel spatial grid; native validation derives the TI2V requirement from
     * the loaded GGUF instead of the filename.
     */
    width?: number;
    height?: number;
    video_frames?: number;
    fps?: number;
    seed?: number;
    steps?: number;
    sampling_method?: SamplerMethod;
    scheduler?: ScheduleType;
    cfg_scale?: number;
    flow_shift?: number;
    /** High-noise sample count; `-1` uses native moe_boundary-based routing. */
    high_noise_steps?: number;
    high_noise_sampler?: SamplerMethod;
    high_noise_scheduler?: ScheduleType;
    high_noise_cfg_scale?: number;
    high_noise_flow_shift?: number;
    /** Normalized timestep boundary between high- and low-noise experts. [0, 1]. */
    moe_boundary?: number;
    strength?: number;
    vace_strength?: number;
    init_image?: Uint8Array;
    control_frames?: Uint8Array[];
    vae_tiling?: boolean;
    vae_tile_size?: number | string;
    vae_tile_overlap?: number;
    temporal_tiling?: boolean;
    cache_mode?: CacheMode;
    cache_preset?: string;
    cache_threshold?: number;
}
export interface VideoRuntimeStats {
    modelLoadMs: number;
    generationMs: number;
    totalGenerationMs: number;
    totalWallMs: number;
    totalSteps: number;
    totalGenerations: number;
    totalImages: number;
    totalPixels: number;
    totalVideos: number;
    totalVideoFrames: number;
    width: number;
    height: number;
    seed: number;
    videoFrames: number;
    fps: number;
    hasAudio: number;
    audioSampleRate: number;
    conditionerMs: number;
    denoiseMs: number;
    vaeMs: number;
    postProcessMs: number;
    stepsPerSecond: number;
}
/**
 * Text-to-video and image-to-video generation using stable-diffusion.cpp's
 * `generate_video()` path.
 */
export default class VideoStableDiffusion {
    opts: {
        stats?: boolean;
    };
    logger: QvacLogger;
    state: {
        configLoaded: boolean;
    };
    private readonly _files;
    private readonly _config;
    private readonly _job;
    private readonly _run;
    private addon;
    private _hasActiveResponse;
    constructor({ files, config, logger, opts }: VideoStableDiffusionArgs);
    load(): Promise<void>;
    private _load;
    private _createAddon;
    private _addonOutputCallback;
    run(params: VideoGenerationParams): Promise<QvacResponse>;
    private _runInternal;
    cancel(): Promise<void>;
    unload(): Promise<void>;
    getState(): {
        configLoaded: boolean;
    };
    private _isLtx;
}
