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
    mossCodecDecoderPath: string;
    mossCodecEncoderPath?: string;
    /** Rows in the complete native prompt, including reference and dialogue rows. */
    promptRows: number;
    /** Total mono reference samples; use 0 for a voice without a reference. */
    referenceSamples: number;
    /** Project native chunk streaming when true, batch synthesis when false. */
    streaming: boolean;
    threads?: number;
    streamChunkTokens?: number;
    durationTokens?: number;
}
export interface MossSoundEffectFitRequest extends TtsFitCommon {
    engineType: 'moss-sfx';
    mossSoundEffectPath: string;
    prompt: string;
    seconds: number;
    negativePrompt?: string;
    steps?: number;
    guidance?: number;
    shift?: number;
    threads?: number;
}
export type TtsFitRequest = SupertonicFitRequest | ParlerFitRequest | ChatterboxFitRequest | Audio8FitRequest | CosyvoiceFitRequest | MossFitRequest | MossSoundEffectFitRequest;
/** The voice engines a fit can be asked for, read off the request union. */
export type TtsFitEngine = TtsFitRequest['engineType'];
/**
 * `unknown` is a load the fitter cannot size: supertonic outside the fused
 * graph path it models, a CosyVoice3 or Parler load with Core ML sidecars, or a failed
 * measurement.
 */
export type TtsFitStatus = 'fits' | 'does-not-fit' | 'unknown';
export interface TtsFitDevice {
    /** The PCI bus ID when the backend reports one, the device name otherwise. */
    id: string;
    name: string;
    /** Memory the host owns: the host CPU, and a GPU that shares the host's memory. */
    unified: boolean;
    /** Memory the load takes on this device. */
    usedBytes: number;
    freeBytes: number;
    totalBytes: number;
}
export type TtsFitStats = Record<string, never>;
export interface TtsFitResult {
    status: TtsFitStatus;
    /**
     * The device the load resolves to, then the host CPU. One CPU row for a load
     * on the CPU, and none for `unknown`.
     */
    devices: TtsFitDevice[];
    stats: TtsFitStats;
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
 * A model the engine cannot read, a voice with no fitter, an invalid request,
 * or a host with no native binding rejects. Fits run one at a time within this
 * addon.
 */
export declare function assessFit(request: TtsFitRequest): Promise<TtsFitResult>;
export {};
