interface AsrFitCommon {
    /** Absolute path to the model, or to the registry's weightless copy. */
    modelPath: string;
    /** Longest single transcribe the projection must cover. Defaults to 300. */
    audioSeconds?: number;
    /** > 0 requests the GPU stack, with the fallbacks a real load applies. */
    gpuLayers?: number;
    /** Free memory that must remain for the projection to count as fitting. */
    marginBytes?: number;
    backendsDir?: string;
}
export interface ParakeetFitRequest extends AsrFitCommon {
    engine?: 'parakeet';
    threads?: number;
    longFormWindowFrames?: number;
    longFormContextFrames?: number;
    /**
     * Nemotron only: the streaming operating point whose live session the
     * projection must also cover. 0 projects the largest allowed one.
     */
    nemotronChunkMs?: number;
}
export interface WhisperFitRequest extends AsrFitCommon {
    engine: 'whisper';
    /** Projected alongside the model; omitted means no VAD. */
    vadModelPath?: string;
    flashAttn?: boolean;
    gpuDevice?: number;
    /**
     * Worst-case resident decoders, the `best_of` or `beam_size` the run will
     * use. The KV cache and decode graph grow with it.
     */
    decoders?: number;
}
export type AsrFitRequest = ParakeetFitRequest | WhisperFitRequest;
export type AsrFitStatus = 'fits' | 'does-not-fit' | 'error';
export interface AsrFitResult {
    status: AsrFitStatus;
    /** The engine's own wording, e.g. `model-unreadable`, `workload-too-large`. */
    reason: string;
    /**
     * Parakeet: `ctc` | `rnnt` | `tdt` | `eou` | `nemotron` | `sortformer`.
     * Whisper: `tiny` | `base` | ... | `large v3`.
     */
    modelType: string;
    modelVariant: string;
    deviceName: string;
    deviceIsCpu: boolean;
    /** The device pool is system RAM, so host bytes compete with device bytes. */
    deviceSharesHostMemory: boolean;
    deviceFreeBytes: number;
    deviceTotalBytes: number;
    deviceBytes: number;
    weightsBytes: number;
    hostBytes: number;
    report: string;
    /** Parakeet only. */
    encoderComputeBytes?: number;
    decoderStateBytes?: number;
    decoderComputeBytes?: number;
    /** Whisper only. */
    kvBytes?: number;
    computeBytes?: number;
    /** 0 when no VAD model was projected. */
    vadBytes?: number;
    /** Device-component bytes the runtime places in host RAM instead. */
    hostOverflowBytes?: number;
}
/**
 * Projects one model against the memory free right now, reading model metadata
 * and never weight data. The registry's weightless copy of a model answers the
 * same as the model itself, so this can run before anything is downloaded.
 *
 * `engine` picks the fitter and defaults to parakeet. A model the fitter
 * cannot read comes back as `status: "error"` with the engine's reason. Only a
 * broken request throws.
 */
export declare function assessFit(request: AsrFitRequest): AsrFitResult;
export {};
