import QvacLogger = require('@qvac/logging');
import { type QvacResponse } from '@qvac/infer-base';
import type { CacheMode, SamplerMethod, ScheduleType, SdConfig } from './index';
export type VideoMode = 'txt2vid' | 'img2vid';
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
    mode: VideoMode;
    prompt: string;
    negative_prompt?: string;
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
    high_noise_steps?: number;
    high_noise_sampler?: SamplerMethod;
    high_noise_scheduler?: ScheduleType;
    high_noise_cfg_scale?: number;
    high_noise_flow_shift?: number;
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
