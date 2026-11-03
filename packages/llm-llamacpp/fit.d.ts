export interface LlamaFitRequest {
    /** Absolute path to the GGUF, or to the registry's weightless copy. */
    modelPath: string;
    /** The load, as `loadModel` takes it, resolved by the same code that load runs. */
    config?: Record<string, string>;
    /** Floor the fitter may not reduce an unpinned context below. */
    minCtxSize?: number;
    /** Memory to leave free on every device. The larger of this and the load's own `fit-target` binds. */
    marginBytes?: number;
}
/** `unknown` is a load the fitter cannot project, such as one placed on the CPU. */
export type LlamaFitStatus = 'fits' | 'does-not-fit' | 'unknown';
export interface LlamaFitDevice {
    /** The PCI bus ID when the backend reports one, the device name otherwise. */
    id: string;
    name: string;
    unified: boolean;
    /** Model, context and compute memory the load takes on this device. */
    usedBytes: number;
    freeBytes: number;
    totalBytes: number;
}
/**
 * The load as the fit resolved it: on `fits` the context and GPU layer count the
 * fitter settled on, on `does-not-fit` the ones the load asked for. Empty when
 * `unknown`.
 */
export type LlamaFitStats = {
    ctxSize: number;
    gpuLayers: number;
} | Record<string, never>;
export interface LlamaFitResult {
    status: LlamaFitStatus;
    /** One row per device the model is assigned to, then the host CPU. Empty when `unknown`. */
    devices: LlamaFitDevice[];
    stats: LlamaFitStats;
}
/**
 * Projects one model against the memory free right now, reading GGUF metadata
 * and never weight data. The registry's weightless copy of a model answers the
 * same as the model itself, so this can run before anything is downloaded.
 *
 * A model the fitter cannot read, or an invalid request, rejects.
 *
 * Builds the model twice without allocating weights. Concurrent calls run one
 * at a time.
 *
 * The projection reads the model's vocabulary, and llama asserts on a
 * vocabulary it finds inconsistent. An assert aborts rather than throwing, so
 * a corrupt file ends the process instead of returning a status: take the
 * model from a source you trust, or call this behind a process boundary.
 */
export declare function assessFit(request: LlamaFitRequest): Promise<LlamaFitResult>;
