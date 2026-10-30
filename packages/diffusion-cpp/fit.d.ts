import type { DiffusionFiles, EsrganFiles, EsrganUpscalerConfig, SdConfig } from './index';
import type { DiffusionVideoFiles } from './file-paths';
import type { WorldConfig, WorldFiles } from './world';
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
export interface WorldFitRequest {
    mode: 'world';
    files: WorldFiles;
    config?: WorldConfig;
    workload?: {
        walkSteps?: number;
    };
}
/**
 * `does-not-fit` includes a load the engine could place only by changing its
 * backend assignment. `unknown` is a placement the engine cannot plan from: a
 * `mainGpu` pin, a `device` of cpu, a module-specific `paramsBackend`, or an
 * OpenCL preference that does not name the first GPU.
 */
export type DiffusionFitStatus = 'fits' | 'does-not-fit' | 'unknown';
export interface DiffusionFitDevice {
    /** The PCI bus ID when the backend reports one, the device name otherwise. */
    id: string;
    name: string;
    /** Memory the host owns: the CPU, an integrated GPU, and Apple's Metal device. */
    unified: boolean;
    /** The engine's measured projection for this device. */
    usedBytes: number;
    freeBytes: number;
    totalBytes: number;
}
export type DiffusionFitStats = Record<string, never>;
export interface DiffusionFitResult {
    status: DiffusionFitStatus;
    /**
     * The GPU devices the placement uses, then the host. A shared-memory GPU's
     * use is in its own row, not repeated in the host row. Empty for `unknown`.
     */
    devices: DiffusionFitDevice[];
    stats: DiffusionFitStats;
}
/**
 * Projects a load against the memory free right now, reading model metadata
 * and never weight data. A GGUF file set can be a weightless registry copy,
 * so the projection can run before anything is downloaded. Safetensors
 * checkpoints can also contain only their tensor headers.
 *
 * Concurrent calls run one at a time within this addon.
 *
 * A malformed request, a model the engine cannot read, or an ESRGAN output
 * above the pixel limit rejects.
 */
export declare function assessFit(request: DiffusionFitRequest | EsrganFitRequest | WorldFitRequest): Promise<DiffusionFitResult>;
