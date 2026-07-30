import type { QvacResponse } from "@qvac/infer-base";
import { ParakeetInterface, type ParakeetConfigurationParams, type StreamingConfig } from "./parakeet";
import type { ASRRunOutput, AudioInput, BackendInfo } from "../../lib/types";
import type { ASRGgmlFiles, ASRGgmlReloadConfig, ASRStreamingOptions, AsrDriver, DriverContext, NormalizedAudioStream, StreamingSession } from "../types";
/**
 * Parakeet-specific configuration options. The model type (CTC, TDT, EOU,
 * or Sortformer) is auto-detected from the loaded GGUF metadata.
 */
export interface ParakeetConfig {
    /** Maximum CPU threads for inference (0 lets the engine pick). */
    maxThreads?: number;
    /** Enable the linked ggml GPU backend (Metal / Vulkan / OpenCL). */
    useGPU?: boolean;
    /** Audio sample rate in Hz (default: 16000; engine assumes 16 kHz). */
    sampleRate?: number;
    /** Number of audio channels (default: 1, must be mono). */
    channels?: number;
    /** Enable caption/subtitle mode (default: false). */
    captionEnabled?: boolean;
    /** Include timestamps in output (default: true). */
    timestampsEnabled?: boolean;
    /** Random seed for reproducibility (-1 for random, default: -1). */
    seed?: number;
    /**
     * Open a long-lived streaming session at load time. Cross-append state is
     * preserved within one `run()` call, but not across separate calls.
     */
    streaming?: boolean;
    /** Streaming chunk cadence in milliseconds (default: 2000). */
    streamingChunkMs?: number;
    /** Sortformer rolling-history window in ms (default: 30000). */
    streamingHistoryMs?: number;
    /** Emit partial segments before chunk boundaries (default: true). */
    streamingEmitPartials?: boolean;
    /** CTC/TDT-only energy-VAD events (default: false). */
    streamingEnergyVad?: boolean;
    /** ASR encoder left-context window in milliseconds. */
    streamingLeftContextMs?: number;
    /** ASR encoder right-lookahead window in milliseconds. */
    streamingRightLookaheadMs?: number;
    /** Enable v2.1 Sortformer AOSC speaker-cache streaming (default: true). */
    streamingSpkCacheEnable?: boolean;
    /** AOSC long-term speaker-cache rows (default: 188). */
    streamingSpkCacheLen?: number;
    /** AOSC FIFO warmup buffer rows (default: 188). */
    streamingFifoLen?: number;
    /** AOSC encoder left-context window in ms (default: 80). */
    streamingChunkLeftContextMs?: number;
    /** AOSC encoder right-context window in ms (default: 560). */
    streamingChunkRightContextMs?: number;
    /** AOSC FIFO-overflow pop-out count (default: 144). */
    streamingSpkCacheUpdatePeriod?: number;
    /**
     * Directory containing dynamically-loaded ggml backend libraries. Defaults
     * to the package's own `prebuilds/` folder.
     */
    backendsDir?: string;
    /**
     * Persistent directory for ggml-opencl's compiled program-binary cache.
     * Android-only; ignored on other platforms.
     */
    openclCacheDir?: string;
}
/** Parakeet branch of the discriminated engine-config union. */
export interface ParakeetEngineConfig {
    engine: "parakeet";
    parakeetConfig?: ParakeetConfig;
}
/** Per-call overrides for a duplex streaming session. */
export type ParakeetStreamingRunConfig = StreamingConfig;
export interface ParakeetReloadConfig {
    parakeetConfig?: Partial<ParakeetConfig>;
}
/**
 * Parakeet engine driver: owns the `ParakeetInterface`, the parakeet event
 * mapping, and the parakeet streaming lifecycle. Backed by
 * qvac-parakeet.cpp; accepts CTC, TDT, EOU, and Sortformer GGUF
 * checkpoints.
 */
export declare class ParakeetDriver implements AsrDriver {
    readonly engineType: "parakeet";
    readonly supportsReload = true;
    addon?: ParakeetInterface;
    params: ParakeetConfig;
    private readonly ctx;
    private readonly _files;
    constructor(ctx: DriverContext, files: ASRGgmlFiles, config: ParakeetEngineConfig);
    validateConfig(): void;
    normalizeAudio(input: AudioInput): NormalizedAudioStream;
    load(): Promise<void>;
    unload(): Promise<void>;
    reload(newConfig?: ASRGgmlReloadConfig): Promise<void>;
    cancelActive(jobId?: number): Promise<void>;
    status(): Promise<string>;
    getBackendInfo(): BackendInfo | null;
    run(audio: NormalizedAudioStream): Promise<QvacResponse<ASRRunOutput>>;
    createStreamingSession(audio: NormalizedAudioStream, opts?: ASRStreamingOptions): Promise<StreamingSession>;
    _validateStreamingOptions(opts: ASRStreamingOptions): ParakeetStreamingRunConfig;
    _pumpBatchAudio(audio: NormalizedAudioStream): Promise<void>;
    _pumpStreamingAudio(audio: NormalizedAudioStream): Promise<void>;
    _buildConfigurationParams(): ParakeetConfigurationParams;
    _createAddon(configurationParams: ParakeetConfigurationParams): ParakeetInterface;
    private _outputCallback;
    private _requireAddon;
}
