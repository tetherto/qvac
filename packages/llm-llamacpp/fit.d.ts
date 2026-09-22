export interface LlamaFitRequest {
    /** Absolute path to the GGUF, or to the registry's weightless copy. */
    modelPath: string;
    /**
     * The load, in llama's own CLI spelling without the leading `--`, exactly as
     * the loader takes it: `ctx-size`, `tensor-split`, `override-tensor`,
     * `cpu-moe`, `no-kv-offload` and the rest. Each is dispatched through llama's
     * argument table, so a placement pinned here reaches the projection.
     *
     * A setting llama does not recognise, or a flag asked to be off that can only
     * assert itself, is `status: "error"` with `unsupported-config`.
     */
    params?: Record<string, string>;
    /** Floor the fitter may not reduce the context below. */
    minCtxSize?: number;
    /** Memory to leave free on every device. */
    marginBytes?: number;
    /** Where the dynamically-loaded ggml backends live. */
    backendsDir?: string;
}
export type LlamaFitStatus = 'fits' | 'does-not-fit' | 'error';
export interface LlamaFitDevice {
    name: string;
    totalBytes: number;
    freeBytes: number;
    modelBytes: number;
    contextBytes: number;
    computeBytes: number;
}
export interface LlamaFitResult {
    status: LlamaFitStatus;
    /** `fits`, `does-not-fit`, `model-unreadable`, `no-backend-device` or `unsupported-config`. */
    reason: string;
    /** What fits, which is not always what the request asked for. */
    gpuLayers: number;
    ctxSize: number;
    /** One row per device the model was assigned to, then a `host` row. */
    devices: LlamaFitDevice[];
    /** Model, context and compute summed across the devices, host excluded. */
    deviceBytes: number;
    /** The same, for the trailing host row. */
    hostBytes: number;
    trainCtxSize: number;
    expertCount: number;
}
/**
 * Projects one model against the memory free right now, reading GGUF metadata
 * and never weight data. The registry's weightless copy of a model answers the
 * same as the model itself, so this can run before anything is downloaded.
 *
 * A model the fitter cannot read comes back as `status: "error"`; only a broken
 * request throws.
 */
export declare function assessFit(request: LlamaFitRequest): LlamaFitResult;
