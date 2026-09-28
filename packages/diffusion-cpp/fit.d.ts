import type { DiffusionFiles, SdConfig } from './index';
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
}
export interface DiffusionFitRequest {
    files: DiffusionFiles & DiffusionVideoFiles;
    config?: SdConfig;
    workload?: DiffusionFitWorkload;
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
 * so the projection can run before anything is downloaded; a safetensors file
 * still needs its tensor data present.
 *
 * A model the engine cannot read is `status: "error"`; only a broken request
 * throws.
 */
export declare function assessFit(request: DiffusionFitRequest): DiffusionFitResult;
