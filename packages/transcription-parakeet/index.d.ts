import QvacLogger = require("@qvac/logging");
import { type QvacResponse } from "@qvac/infer-base";
import type { Readable } from "stream";
import { ParakeetInterface, type BackendInfo as ParakeetBackendInfo, type ParakeetConfigurationParams, type StreamingConfig } from "./parakeet";
/** Model type auto-detected from the loaded GGUF metadata. */
type ModelType = "tdt" | "ctc" | "eou" | "sortformer";
/** Parakeet-specific configuration options. */
interface ParakeetConfig {
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
interface TranscriptionParakeetFiles {
    /** Absolute path to a CTC, TDT, EOU, or Sortformer `.gguf` checkpoint. */
    model?: string;
}
interface TranscriptionParakeetArgs {
    files?: TranscriptionParakeetFiles;
    config?: TranscriptionParakeetConfig;
    logger?: QvacLogger.LoggerInterface;
    exclusiveRun?: boolean;
    [key: string]: unknown;
}
interface TranscriptionParakeetConfig {
    enableStats?: boolean;
    parakeetConfig?: ParakeetConfig;
    [key: string]: unknown;
}
interface TranscriptionSegment {
    text: string;
    start: number;
    end: number;
    toAppend: boolean;
    id?: number;
    /** True when this segment ends on a recognized end-of-utterance boundary. */
    isEndOfTurn?: boolean;
    /** True when the segment begins a new SentencePiece word. */
    startsWord?: boolean;
}
type OutputEvent = "JobStarted" | "Output" | "JobEnded" | "Error";
type AppendInput = {
    type: "audio";
    data: ArrayBuffer;
    priority?: number;
} | {
    type: "end of job";
};
/** Per-call overrides for a duplex streaming session. */
type StreamingRunConfig = StreamingConfig;
interface Addon {
    activate(): Promise<void>;
    append(input: AppendInput): Promise<number>;
    cancel(jobId?: number): Promise<void>;
    loadWeights(weightsData: {
        filename: string;
        chunk: Uint8Array;
        completed: boolean;
    }): Promise<void>;
    getBackendInfo(): ParakeetBackendInfo | null;
    status(): Promise<string>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    reload(config: ParakeetConfig): Promise<void>;
    destroyInstance(): Promise<void>;
    startStreaming(config?: StreamingRunConfig): Promise<number>;
    appendStreamingAudio(data: Float32Array | Int16Array | ArrayBuffer | ArrayBufferView): Promise<boolean>;
    endStreaming(): Promise<void>;
    cancelStreaming(): Promise<void>;
}
interface InferenceClientState {
    configLoaded: boolean;
    weightsLoaded: boolean;
    destroyed: boolean;
}
interface InternalConfig extends TranscriptionParakeetConfig {
    modelPath?: string;
}
/**
 * High-level Parakeet speech-to-text client backed by qvac-parakeet.cpp.
 * Accepts CTC, TDT, EOU, and Sortformer GGUF checkpoints; model type is
 * auto-detected from GGUF metadata.
 */
declare class TranscriptionParakeet {
    readonly logger: QvacLogger;
    readonly exclusiveRun: boolean;
    state: InferenceClientState;
    protected addon?: ParakeetInterface;
    protected params: ParakeetConfig;
    protected readonly _config: InternalConfig;
    private _runQueueWaiter;
    private readonly _job;
    constructor({ files, config, logger, exclusiveRun, }: TranscriptionParakeetArgs);
    validateModelFiles(): void;
    protected _buildConfigurationParams(): ParakeetConfigurationParams;
    getState(): InferenceClientState;
    load(): Promise<void>;
    run(audioStream: Readable): Promise<QvacResponse<TranscriptionParakeet.ParakeetRunOutput>>;
    /**
     * Opens a long-lived native streaming session and forwards chunks as they
     * arrive. Segment updates surface through `response.onUpdate(...)`.
     */
    runStreaming(audioStream: Readable, streamingConfig?: StreamingRunConfig): Promise<QvacResponse<TranscriptionParakeet.ParakeetRunOutput>>;
    private _withExclusiveRun;
    protected _load(): Promise<void>;
    private _runInternal;
    private _runStreamingInternal;
    private _pumpStreamingAudio;
    private _handleAudioStream;
    private _normalizeAudioStream;
    private _outputCallback;
    reload(newConfig?: {
        parakeetConfig?: Partial<ParakeetConfig>;
    }): Promise<void>;
    protected _createAddon(configurationParams: ParakeetConfigurationParams): ParakeetInterface;
    unload(): Promise<void>;
    cancel(jobId?: number): Promise<void>;
    status(): Promise<string | undefined>;
    getBackendInfo(): ParakeetBackendInfo | null;
    pause(): Promise<void>;
    unpause(): Promise<void>;
    destroy(): Promise<void>;
    private _requireAddon;
}
type NamespaceModelType = ModelType;
type NamespaceParakeetConfig = ParakeetConfig;
type NamespaceTranscriptionParakeetFiles = TranscriptionParakeetFiles;
type NamespaceTranscriptionParakeetArgs = TranscriptionParakeetArgs;
type NamespaceTranscriptionParakeetConfig = TranscriptionParakeetConfig;
type NamespaceTranscriptionSegment = TranscriptionSegment;
type NamespaceOutputEvent = OutputEvent;
type NamespaceAppendInput = AppendInput;
type NamespaceAddon = Addon;
type NamespaceInferenceClientState = InferenceClientState;
type NamespaceStreamingRunConfig = StreamingRunConfig;
declare namespace TranscriptionParakeet {
    /**
     * Numeric code identifying the compute backend selected by the engine.
     */
    enum BackendId {
        CPU = 0,
        Metal = 1,
        CUDA = 2,
        Vulkan = 3,
        OpenCL = 4,
        Other = 99
    }
    /** Runtime statistics returned by the native Parakeet model. */
    interface RuntimeStats {
        totalTime: number;
        audioDurationMs: number;
        totalSamples: number;
        totalTokens: number;
        totalTranscriptions: number;
        processCalls: number;
        modelLoadMs: number;
        melSpecMs: number;
        encoderMs: number;
        decoderMs: number;
        totalWallMs: number;
        totalEncodedFrames: number;
        backendDevice: number;
        backendId: number;
        gpuUnsupported: number;
        encoderOnCoreml: number;
    }
    type BackendInfo = ParakeetBackendInfo;
    type ParakeetRunOutput = TranscriptionSegment[] | TranscriptionSegment;
    type ModelType = NamespaceModelType;
    type ParakeetConfig = NamespaceParakeetConfig;
    type TranscriptionParakeetFiles = NamespaceTranscriptionParakeetFiles;
    type TranscriptionParakeetArgs = NamespaceTranscriptionParakeetArgs;
    type TranscriptionParakeetConfig = NamespaceTranscriptionParakeetConfig;
    type TranscriptionSegment = NamespaceTranscriptionSegment;
    type OutputEvent = NamespaceOutputEvent;
    type AppendInput = NamespaceAppendInput;
    type Addon = NamespaceAddon;
    type InferenceClientState = NamespaceInferenceClientState;
    type StreamingRunConfig = NamespaceStreamingRunConfig;
}
export = TranscriptionParakeet;
