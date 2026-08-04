import { END_OF_INPUT } from "../../lib/constants";
import type { BackendInfo } from "../../lib/types";
export type { BackendInfo };
export interface ParakeetConfigurationParams {
    /** Unified native `createInstance` dispatch key. */
    engineType?: string;
    modelPath?: string;
    maxThreads?: number;
    useGPU?: boolean;
    sampleRate?: number;
    channels?: number;
    captionEnabled?: boolean;
    timestampsEnabled?: boolean;
    seed?: number;
    streaming?: boolean;
    streamingChunkMs?: number;
    streamingHistoryMs?: number;
    streamingEmitPartials?: boolean;
    streamingEnergyVad?: boolean;
    streamingLeftContextMs?: number;
    streamingRightLookaheadMs?: number;
    streamingSpkCacheEnable?: boolean;
    streamingSpkCacheLen?: number;
    streamingFifoLen?: number;
    streamingChunkLeftContextMs?: number;
    streamingChunkRightContextMs?: number;
    streamingSpkCacheUpdatePeriod?: number;
    backendsDir?: string;
    openclCacheDir?: string;
}
export interface StreamingConfig {
    chunkMs?: number;
    historyMs?: number;
    leftContextMs?: number;
    rightLookaheadMs?: number;
    emitPartials?: boolean;
    emitEnergyVad?: boolean;
    spkCacheEnable?: boolean;
    spkCacheLen?: number;
    fifoLen?: number;
    chunkLeftContextMs?: number;
    chunkRightContextMs?: number;
    spkCacheUpdatePeriod?: number;
}
export interface WeightData {
    filename: string;
    chunk: Uint8Array;
    completed: boolean;
    progress?: number;
    size?: number;
}
export type AudioInput = Float32Array | Int16Array | ArrayBuffer | ArrayBufferView;
export type AppendData = {
    type: "audio";
    data?: ArrayBufferLike;
} | {
    type: typeof END_OF_INPUT;
};
export type ParakeetOutputCallback = (addon: unknown, event: unknown, jobId: number, data: unknown, error: unknown) => void;
export type ParakeetStateCallback = (addon: ParakeetInterface, newState: string) => void;
type NativeOutputCallback = (addon: unknown, event: unknown, data: unknown, error: unknown) => void;
interface StreamingTeardown {
    audioDurationMs?: unknown;
    totalSamples?: unknown;
}
export interface ParakeetBinding {
    createInstance(owner: ParakeetInterface, configurationParams: ParakeetConfigurationParams, outputCallback: NativeOutputCallback, stateCallback: ParakeetStateCallback | null): object;
    loadWeights(handle: object | null, weightsData: WeightData): Promise<boolean>;
    activate(handle: object | null): void;
    getBackendInfo(handle: object): BackendInfo | null;
    runJob(handle: object | null, data: {
        type: "audio";
        input: Float32Array;
    } | Record<string, unknown>): boolean;
    cancel(handle: object | null): Promise<void>;
    destroyInstance(handle: object): void;
    startStreaming(handle: object | null, config: StreamingConfig): void;
    appendStreamingAudio(handle: object | null, data: {
        type: "audio";
        input: Float32Array;
    }): boolean;
    endStreaming(handle: object | null): StreamingTeardown | undefined;
}
/**
 * Low-level interface between the Bare addon (C++) and the JavaScript runtime.
 * The model type is auto-detected from the loaded GGUF metadata.
 */
export declare class ParakeetInterface {
    private readonly _binding;
    private readonly _outputCallback;
    private readonly _stateCallback;
    private _handle;
    private _state;
    private _nextJobId;
    private _activeJobId;
    private _onCancelComplete;
    private _bufferedAudio;
    private _bufferedBytes;
    private _config;
    constructor(binding: ParakeetBinding, configurationParams: ParakeetConfigurationParams, outputCallback: ParakeetOutputCallback, stateCallback?: ParakeetStateCallback | null);
    private _applyDefaults;
    private _setState;
    private _createNativeInstance;
    private _looksLikeStats;
    private _looksLikeTranscript;
    private _mapAddonEvent;
    private _resolvePendingCancel;
    private _addonOutputCallback;
    private _emitSyntheticError;
    loadWeights(weightsData: WeightData): Promise<boolean>;
    activate(): Promise<void>;
    getBackendInfo(): BackendInfo | null;
    append(data: AppendData): Promise<number>;
    private _submitBufferedJob;
    private _bufferAudioChunk;
    status(): Promise<string>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    cancel(jobId?: number): Promise<void>;
    reload(configurationParams: ParakeetConfigurationParams): Promise<void>;
    unloadWeights(): Promise<never>;
    load(configurationParams: ParakeetConfigurationParams): Promise<void>;
    unload(): Promise<void>;
    destroyInstance(): Promise<void>;
    runJob(data: Record<string, unknown>): Promise<boolean>;
    startStreaming(config?: StreamingConfig): Promise<number>;
    appendStreamingAudio(data: AudioInput): Promise<boolean>;
    endStreaming(): Promise<void>;
    cancelStreaming(): Promise<void>;
    private _normalizeAudioInput;
    private _concatBufferedAudio;
}
