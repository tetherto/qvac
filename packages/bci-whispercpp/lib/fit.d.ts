export interface BciFitRequest {
    /** Absolute path to the BCI model. */
    modelPath: string;
    /** Sized alongside the projection; see `embedderFileBytes`. */
    embedderPath?: string;
    /** Longest single transcribe the projection must cover. */
    audioSeconds?: number;
    /** > 0 requests the GPU stack, with the fallbacks a real load applies. */
    gpuLayers?: number;
    gpuDevice?: number;
    /**
     * Worst-case resident decoders, the `best_of` or `beam_size` the run will
     * use. The KV cache and decode graph grow with it.
     */
    decoders?: number;
    /** Free memory that must remain for the projection to count as fitting. */
    marginBytes?: number;
    /** Where the dynamically-loaded ggml backends live. */
    backendsDir?: string;
}
export type BciFitStatus = 'fits' | 'does-not-fit' | 'error';
export interface BciFitResult {
    status: BciFitStatus;
    /** Whisper's own wording, e.g. `model-unreadable`, `no-backend-device`. */
    reason: string;
    /** `tiny` | `base` | ... | `large v3`. */
    modelType: string;
    deviceName: string;
    deviceIsCpu: boolean;
    /** The device pool is system RAM, so host bytes compete with device bytes. */
    deviceSharesHostMemory: boolean;
    deviceFreeBytes: number;
    deviceTotalBytes: number;
    deviceBytes: number;
    weightsBytes: number;
    kvBytes: number;
    computeBytes: number;
    /** Device-component bytes the runtime places in host RAM instead. */
    hostOverflowBytes: number;
    hostBytes: number;
    /**
     * The embedder's size on disk, 0 when no path was given. The embedder has no
     * fitter, so this is a size on disk. It is counted in neither `deviceBytes`
     * nor `hostBytes`.
     */
    embedderFileBytes: number;
    report: string;
}
/**
 * Projects a BCI load against the memory free right now, reading model
 * metadata and never weight data.
 *
 * Covers the whisper half of the load. A model the fitter cannot read comes
 * back as `status: "error"`; a broken request, or a host with no native
 * binding, throws.
 *
 * The backend directory defaults to the one a real load uses. The native side
 * registers backends once per process, so a fit that let it fall back to the
 * default search path would fix that path for every later load too.
 */
export declare function assessFit(request: BciFitRequest): BciFitResult;
