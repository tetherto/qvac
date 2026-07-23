import QvacLogger = require('@qvac/logging');
import { type QvacResponse } from '@qvac/infer-base';
import type VideoStableDiffusionConstructor from './video';
export type NumericLike = number | `${number}`;
/**
 * Low-level addon shape exposed by `addon.js` (`SdInterface`). Both image
 * and video modes flow through the same `runJob` entrypoint.
 */
export interface Addon {
    activate(): Promise<void>;
    runJob(params: (GenerationParams & {
        mode: 'txt2img' | 'img2img';
    }) | {
        mode: 'txt2vid' | 'img2vid';
        [key: string]: unknown;
    }): Promise<boolean>;
    cancel(): Promise<void>;
    unload(): Promise<void>;
}
export type SamplerMethod = 'euler' | 'euler_a' | 'heun' | 'dpm2' | 'dpm++2m' | 'dpm++2mv2' | 'dpm++2s_a' | 'lcm' | 'ipndm' | 'ipndm_v' | 'ddim_trailing' | 'tcd' | 'res_multistep' | 'res_2s';
export type WeightType = 'auto' | 'f32' | 'f16' | 'bf16' | 'q2_k' | 'q3_k' | 'q4_0' | 'q4_1' | 'q4_k' | 'q5_0' | 'q5_1' | 'q5_k' | 'q6_k' | 'q8_0';
export type RngType = 'cpu' | 'cuda' | 'std_default';
export type ScheduleType = 'discrete' | 'karras' | 'exponential' | 'ays' | 'gits' | 'sgm_uniform' | 'simple' | 'lcm' | 'smoothstep' | 'kl_optimal' | 'bong_tangent';
export type PredictionType = 'auto' | 'eps' | 'v' | 'edm_v' | 'flow' | 'flux_flow' | 'flux2_flow';
export type LoraApplyMode = 'auto' | 'immediately' | 'at_runtime';
export type CacheMode = 'disabled' | 'easycache' | 'ucache' | 'dbcache' | 'taylorseer' | 'cache-dit';
export interface SdConfig {
    threads?: NumericLike;
    device?: 'gpu' | 'cpu';
    'main-gpu'?: number | 'integrated' | 'dedicated';
    type?: WeightType;
    rng?: RngType;
    sampler_rng?: RngType;
    clip_on_cpu?: boolean;
    vae_on_cpu?: boolean;
    vae_decode_only?: boolean;
    vae_tiling?: boolean;
    flash_attn?: boolean;
    diffusion_fa?: boolean;
    mmap?: boolean;
    offload_to_cpu?: boolean;
    prediction?: PredictionType;
    flow_shift?: number;
    diffusion_conv_direct?: boolean;
    vae_conv_direct?: boolean;
    force_sdxl_vae_conv_scale?: boolean;
    backendsDir?: string;
    tensor_type_rules?: string;
    lora_apply_mode?: LoraApplyMode;
    upscaler_tile_size?: NumericLike;
    upscaler_direct?: boolean;
    upscaler_offload_params_to_cpu?: boolean;
    upscaler_threads?: NumericLike;
    verbosity?: NumericLike;
    [key: string]: string | number | boolean | undefined;
}
export interface DiffusionFiles {
    model: string;
    clipL?: string;
    clipG?: string;
    t5Xxl?: string;
    llm?: string;
    vae?: string;
    esrgan?: string;
    highNoiseDiffusionModel?: string;
    uncondModel?: string;
}
export interface EsrganFiles {
    esrgan: string;
}
export interface EsrganUpscalerConfig {
    backendsDir?: string;
    threads?: NumericLike;
    upscaler_tile_size?: NumericLike;
    upscaler_direct?: boolean;
    upscaler_offload_params_to_cpu?: boolean;
    upscaler_threads?: NumericLike;
    device?: 'cpu' | 'gpu';
    verbosity?: NumericLike;
    [key: string]: string | number | boolean | undefined;
}
export interface ImgStableDiffusionArgs {
    files: DiffusionFiles;
    config?: SdConfig;
    logger?: QvacLogger | Console | null;
    opts?: {
        stats?: boolean;
    };
}
export interface EsrganUpscalerArgs {
    files: EsrganFiles;
    config?: EsrganUpscalerConfig;
    logger?: QvacLogger | Console | null;
    opts?: {
        stats?: boolean;
    };
}
export interface EsrganUpscaleOptions {
    repeats?: number;
}
export interface GenerationParams {
    prompt: string;
    negative_prompt?: string;
    lora?: string;
    upscale?: boolean | {
        repeats?: number;
    };
    width?: number;
    height?: number;
    steps?: number;
    cfg_scale?: number;
    guidance?: number;
    sampling_method?: SamplerMethod;
    sampler?: SamplerMethod;
    scheduler?: ScheduleType;
    seed?: number;
    batch_count?: number;
    vae_tiling?: boolean;
    vae_tile_size?: number | string;
    vae_tile_overlap?: number;
    cache_mode?: CacheMode;
    cache_preset?: string;
    cache_threshold?: number;
    eta?: number;
    img_cfg_scale?: number;
    clip_skip?: number;
    init_image?: Uint8Array;
    init_images?: Uint8Array[];
    increase_ref_index?: boolean;
    auto_resize_ref_image?: boolean;
    strength?: number;
}
export interface RuntimeStats {
    modelLoadMs: number;
    generationMs: number;
    totalGenerationMs: number;
    totalWallMs: number;
    totalSteps: number;
    totalGenerations: number;
    totalImages: number;
    totalPixels: number;
    width: number;
    height: number;
    seed: number;
    conditionerMs: number;
    denoiseMs: number;
    vaeMs: number;
    postProcessMs: number;
    stepsPerSecond: number;
}
export interface EsrganRuntimeStats {
    modelLoadMs: number;
    upscaleMs: number;
    totalUpscaleMs: number;
    totalWallMs: number;
    totalUpscales: number;
    totalImages: number;
    totalPixels: number;
    width: number;
    height: number;
    repeats: number;
    backendDevice?: 'cpu' | 'gpu';
}
/**
 * Text-to-image and image-to-image generation using stable-diffusion.cpp.
 * Supports SD1.x, SD2.x, SDXL, SD3, FLUX.2 [klein], and Ideogram 4.
 */
export declare class ImgStableDiffusion {
    addon: Addon | null;
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
    private _hasActiveResponse;
    constructor({ files, config, logger, opts }: ImgStableDiffusionArgs);
    load(): Promise<void>;
    private _load;
    private _createAddon;
    private _addonOutputCallback;
    run(params: GenerationParams): Promise<QvacResponse>;
    private _runInternal;
    cancel(): Promise<void>;
    unload(): Promise<void>;
    getState(): {
        configLoaded: boolean;
    };
}
/**
 * Standalone ESRGAN image upscaling using stable-diffusion.cpp.
 * Accepts encoded PNG/JPEG bytes and emits PNG bytes.
 */
export declare class EsrganUpscaler {
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
    constructor({ files, config, logger, opts }: EsrganUpscalerArgs);
    load(): Promise<void>;
    private _load;
    private _createAddon;
    private _addonOutputCallback;
    upscale(imageBytes: Uint8Array, options?: EsrganUpscaleOptions): Promise<QvacResponse>;
    private _upscaleInternal;
    cancel(): Promise<void>;
    unload(): Promise<void>;
    getState(): {
        configLoaded: boolean;
    };
}
export declare function applyFluxImg2ImgDimDefaults(params: GenerationParams, prediction: string, hasInitImages: boolean): GenerationParams;
export type { VideoDiffusionFiles, VideoGenerationParams, VideoMode, VideoRuntimeStats, VideoStableDiffusionArgs } from './video';
export type { QvacResponse };
export type VideoStableDiffusion = InstanceType<typeof VideoStableDiffusionConstructor>;
export declare const VideoStableDiffusion: typeof VideoStableDiffusionConstructor;
export default ImgStableDiffusion;
