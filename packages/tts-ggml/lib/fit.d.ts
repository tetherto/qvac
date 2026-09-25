/**
 * Settings every voice takes, spelled as `createInstance` takes them. A fit
 * request is a load config plus the workload below, so the projection reads
 * the same keys and applies the same defaults as the load it describes.
 */
interface TtsFitCommon {
    /** Layers to offload. Unset defers to `useGPU`. */
    nGpuLayers?: number;
    /** All layers or none, when `nGpuLayers` is unset. */
    useGPU?: boolean;
    vulkanDevice?: number;
    backendsDir?: string;
    /** LavaSR enhancer; a non-empty path turns enhancement on. */
    lavasrEnhancerPath?: string;
    /** LavaSR denoiser, applied before the enhancer. */
    lavasrDenoiserPath?: string;
    /** Free memory that must remain for the projection to count as fitting. Defaults to 256 MiB. */
    marginBytes?: number;
}
export interface SupertonicFitRequest extends TtsFitCommon {
    engineType: 'supertonic';
    supertonicModelPath: string;
    /** `auto` | `f32` | `f16` | `q8_0`; changes the weight footprint. */
    precision?: 'auto' | 'f32' | 'f16' | 'q8_0';
    /** -1 auto, 0 off, 1 on. */
    f16Weights?: number;
    /** 0 takes the GGUF's own default. */
    steps?: number;
    textTokens?: number;
    audioSeconds?: number;
}
export interface ParlerFitRequest extends TtsFitCommon {
    engineType: 'parler';
    parlerModelPath: string;
    descriptionTokens?: number;
    promptTokens?: number;
    /** 0 takes the checkpoint's default generation length. */
    maxFrames?: number;
}
export interface ChatterboxFitRequest extends TtsFitCommon {
    engineType: 'chatterbox';
    t3ModelPath: string;
    s3genModelPath: string;
    nCtx?: number;
    kvCacheType?: 'f32' | 'f16' | 'q8_0';
    textTokens?: number;
    predictTokens?: number;
}
export interface Audio8FitRequest extends TtsFitCommon {
    engineType: 'audio8';
    audio8LmPath: string;
    audio8CodecDecoderPath: string;
    /** Supplying it projects voice cloning, which the decoder alone cannot do. */
    audio8CodecEncoderPath?: string;
    promptTokens?: number;
    maxFrames?: number;
    referenceSeconds?: number;
}
export interface CosyvoiceFitRequest extends TtsFitCommon {
    engineType: 'cosyvoice3';
    cosyvoiceLlmModelPath: string;
    cosyvoiceFlowModelPath: string;
    cosyvoiceHiftModelPath: string;
    cosyvoiceVoiceModelPath: string;
    textTokens?: number;
    /** 0 derives the runtime cap from the text length. */
    speechTokens?: number;
}
export interface MossFitRequest extends TtsFitCommon {
    engineType: 'moss';
    mossBackbonePath: string;
    mossCodecDecoderPath?: string;
    mossCodecEncoderPath?: string;
}
export type TtsFitRequest = SupertonicFitRequest | ParlerFitRequest | ChatterboxFitRequest | Audio8FitRequest | CosyvoiceFitRequest | MossFitRequest;
/** The voice engines a fit can be asked for, read off the request union. */
export type TtsFitEngine = TtsFitRequest['engineType'];
export type TtsFitStatus = 'fits' | 'does-not-fit' | 'error';
export interface TtsFitResult {
    status: TtsFitStatus;
    /**
     * The engine's own wording, e.g. `model-unreadable`, `workload-too-large`.
     * `unsupported-engine` names a voice the addon loads and the fitter does
     * not cover.
     */
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
    /**
     * The LavaSR stages' size on disk, 0 when none was named. They have no
     * fitter, so this is a size on disk. It is counted in neither `deviceBytes`
     * nor `hostBytes`.
     */
    lavasrFileBytes: number;
    report: string;
}
/**
 * Projects one voice against the memory free right now, reading GGUF metadata
 * and never weight data. The registry's weightless copy of each file answers
 * the same as the file itself, so this can run before anything is downloaded.
 *
 * The request is a `createInstance` config plus the workload, and the engine's
 * own config builder reads it, so a load that runs and a fit that describes it
 * resolve their settings the same way.
 *
 * `engineType` picks the fitter, the same key a load uses, and is required
 * here: a fit request carries none of the file keys a load is inferred from.
 * A model the engine cannot read comes back as `status: "error"`, as does a
 * voice with no fitter; a broken request, or a host with no native binding,
 * throws.
 */
export declare function assessFit(request: TtsFitRequest): TtsFitResult;
export {};
