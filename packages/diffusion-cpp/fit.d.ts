import type { DiffusionFiles, EsrganFiles, EsrganUpscalerConfig, SdConfig } from './index';
import type { DiffusionVideoFiles } from './file-paths';
export interface DiffusionFitWorkload {
    /** Token count drives the text-encoder memory; a default stands in when absent. */
    prompt?: string;
    width?: number;
    height?: number;
    /** <= 1 projects image generation. */
    videoFrames?: number;
    /** Tiled decoding trades speed for a much smaller VAE arena. */
    vaeTiling?: boolean;
    vaeTileSizeX?: number;
    vaeTileSizeY?: number;
    vaeTileOverlap?: number;
    /** Number of ESRGAN passes, each applying the checkpoint's scale factor. */
    upscaleRepeats?: number;
}
export interface DiffusionFitRequest {
    mode?: 'diffusion';
    files: DiffusionFiles & DiffusionVideoFiles;
    config?: SdConfig;
    workload?: DiffusionFitWorkload;
}
export interface EsrganFitRequest {
    mode: 'upscale';
    files: EsrganFiles;
    config?: EsrganUpscalerConfig;
    workload?: Pick<DiffusionFitWorkload, 'width' | 'height' | 'upscaleRepeats'>;
}
export type DiffusionFitStatus = 'fits' | 'does-not-fit' | 'error';
export type DiffusionFitReason = 'fits' | 'does-not-fit' | 'model-unreadable' | 'unsupported-config';
export interface DiffusionFitResult {
    status: DiffusionFitStatus;
    reason: DiffusionFitReason;
    /**
     * The engine placed the load only by altering the backend assignment. The
     * configuration as given does not fit, so `status` is already `does-not-fit`.
     */
    changed: boolean;
    vaeTiling: boolean;
    streamLayers: boolean;
    backend: string;
    paramsBackend: string;
    /** Per-device, per-module memory table, suitable for logging. */
    report: string;
}
/**
 * Projects a load against the memory free right now, reading model metadata
 * and never weight data. A GGUF file set can be a weightless registry copy,
 * so the projection can run before anything is downloaded. Safetensors
 * checkpoints can also contain only their tensor headers.
 *
 * A model the engine cannot read is `status: "error"`; only a broken request
 * throws.
 */
export declare function assessFit(request: DiffusionFitRequest | EsrganFitRequest): DiffusionFitResult;
