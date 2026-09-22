import type { DiffusionFiles, SdConfig } from './index';
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
    files: DiffusionFiles & {
        clipVision?: string;
    };
    config?: SdConfig;
    workload?: DiffusionFitWorkload;
}
export type DiffusionFitStatus = 'fits' | 'does-not-fit' | 'error';
/**
 * There is no `reason`, unlike the other engines' fit results: the diffusion
 * engine answers with a status alone, and `error` is a model it could not
 * read. `report` carries everything else it has to say.
 */
export interface DiffusionFitResult {
    status: DiffusionFitStatus;
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
 * and never weight data. The registry's weightless copy of each file answers
 * the same as the file itself, so this can run before anything is downloaded.
 *
 * A model the engine cannot read is `status: "error"`; only a broken request
 * throws.
 */
export declare function assessFit(request: DiffusionFitRequest): DiffusionFitResult;
