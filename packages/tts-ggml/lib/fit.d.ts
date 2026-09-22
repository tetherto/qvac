interface TtsFitCommon {
    /** > 0 requests the GPU stack, with the fallbacks a real load applies. */
    gpuLayers?: number;
    backendsDir?: string;
    /** Free memory that must remain for the projection to count as fitting. Defaults to 256 MiB. */
    marginBytes?: number;
}
export interface SupertonicFitRequest extends TtsFitCommon {
    engineType: 'supertonic';
    modelPath: string;
    /** Vulkan adapter index. */
    vulkanDevice?: number;
    /** `auto` | `f32` | `f16` | `q8_0`; changes the weight footprint. */
    precision?: 'auto' | 'f32' | 'f16' | 'q8_0';
    /** -1 auto, 0 off, 1 on. */
    f16Weights?: number;
    textTokens?: number;
    audioSeconds?: number;
    /** 0 takes the GGUF's own default. */
    steps?: number;
}
export interface ParlerFitRequest extends TtsFitCommon {
    engineType: 'parler';
    modelPath: string;
    descriptionTokens?: number;
    promptTokens?: number;
    /** 0 takes the checkpoint's default generation length. */
    maxFrames?: number;
}
export interface ChatterboxFitRequest extends TtsFitCommon {
    engineType: 'chatterbox';
    t3Path: string;
    s3genPath: string;
    contextSize?: number;
    kvCacheType?: 'f32' | 'f16' | 'q8_0';
    textTokens?: number;
    predictTokens?: number;
}
export interface Audio8FitRequest extends TtsFitCommon {
    engineType: 'audio8';
    lmPath: string;
    codecDecoderPath: string;
    /** Supplying it projects voice cloning, which the decoder alone cannot do. */
    codecEncoderPath?: string;
    promptTokens?: number;
    maxFrames?: number;
    referenceSeconds?: number;
}
export interface CosyvoiceFitRequest extends TtsFitCommon {
    engineType: 'cosyvoice3';
    /** Vulkan adapter index. */
    vulkanDevice?: number;
    llmPath: string;
    flowPath: string;
    hiftPath: string;
    voicePath: string;
    textTokens?: number;
    /** 0 derives the runtime cap from the text length. */
    speechTokens?: number;
}
export type TtsFitRequest = SupertonicFitRequest | ParlerFitRequest | ChatterboxFitRequest | Audio8FitRequest | CosyvoiceFitRequest;
/** The voice engines a fit can be asked for, read off the request union. */
export type TtsFitEngine = TtsFitRequest['engineType'];
export type TtsFitStatus = 'fits' | 'does-not-fit' | 'error';
export interface TtsFitResult {
    status: TtsFitStatus;
    /** The engine's own wording, e.g. `model-unreadable`, `workload-too-large`. */
    reason: string;
    /** Which pipeline was projected, e.g. `chatterbox-t3-turbo`. */
    modelVariant: string;
    deviceName: string;
    deviceIsCpu: boolean;
    /** The device pool is system RAM, so host bytes compete with device bytes. */
    deviceSharesHostMemory: boolean;
    deviceFreeBytes: number;
    deviceTotalBytes: number;
    deviceBytes: number;
    weightsBytes: number;
    stateBytes: number;
    /** 0 for a pipeline with no language-model stage, such as supertonic. */
    lmComputeBytes: number;
    /** 0 for a pipeline with no separate codec stage. */
    codecComputeBytes: number;
    hostBytes: number;
    report: string;
}
/**
 * Projects one voice against the memory free right now, reading GGUF metadata
 * and never weight data. The registry's weightless copy of each file answers
 * the same as the file itself, so this can run before anything is downloaded.
 *
 * `engineType` picks the fitter, the same key a load uses, and is required
 * here: a fit request carries none of the file keys a load is inferred from.
 * A model the engine cannot read comes back as `status: "error"`; a broken
 * request, or a host with no native binding, throws.
 */
export declare function assessFit(request: TtsFitRequest): TtsFitResult;
export {};
