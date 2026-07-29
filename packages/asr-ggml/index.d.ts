import QvacLogger = require("@qvac/logging");
import { type JobHandler, type QvacResponse } from "@qvac/infer-base";
import { WhisperInterface, type StreamingConfig } from "./whisper";
import { type WhisperConfigurationParams } from "./configChecker";
interface VadParams {
    threshold?: number;
    min_speech_duration_ms?: number;
    min_silence_duration_ms?: number;
    max_speech_duration_s?: number;
    speech_pad_ms?: number;
    samples_overlap?: number;
}
interface WhisperConfig extends Record<string, unknown> {
    audio_format?: string;
    language?: string;
    vad_model_path?: string;
    vad_params?: VadParams;
    backendsDir?: string;
    max_seconds?: number;
    duration_ms?: number;
    temperature?: number;
    suppress_nst?: boolean;
    n_threads?: number;
}
interface TranscriptionWhispercppFiles {
    model: string;
    vadModel?: string;
}
interface TranscriptionWhispercppArgs {
    files: TranscriptionWhispercppFiles;
    logger?: QvacLogger.LoggerInterface | null;
    exclusiveRun?: boolean;
    opts?: {
        stats?: boolean;
    };
    [key: string]: unknown;
}
interface TranscriptionWhispercppConfig {
    path?: string;
    enableStats?: boolean;
    vadModelPath?: string;
    whisperConfig: WhisperConfig;
    contextParams?: Record<string, unknown>;
    miscConfig?: Record<string, unknown>;
    audio_format?: string;
    [key: string]: unknown;
}
interface InferenceClientState {
    configLoaded: boolean;
    weightsLoaded: boolean;
    destroyed: boolean;
}
interface WhisperTranscriptionSegment {
    text: string;
    [key: string]: unknown;
}
interface WhisperStreamingOptions {
    emitVadEvents?: boolean;
    conversationMode?: boolean;
    endOfTurnSilenceMs?: number;
    vadRunIntervalMs?: number;
}
interface VadStateEvent {
    type: "vad";
    speaking: boolean;
    probability: number;
}
interface EndOfTurnEvent {
    type: "endOfTurn";
    silenceDurationMs: number;
}
interface RuntimeStats {
    totalTime: number;
    realTimeFactor: number;
    tokensPerSecond: number;
    audioDurationMs: number;
    totalSamples: number;
    totalTokens: number;
    totalSegments: number;
    processCalls: number;
    whisperSampleMs: number;
    whisperEncodeMs: number;
    whisperDecodeMs: number;
    whisperBatchdMs: number;
    whisperPromptMs: number;
    totalWallMs: number;
    backendDevice: number;
    backendId: number;
    gpuMemTotalMb: number;
    gpuMemFreeMb: number;
}
type WhisperRunOutput = WhisperTranscriptionSegment[] | WhisperTranscriptionSegment | VadStateEvent | EndOfTurnEvent;
type AudioChunk = Uint8Array;
type AudioStream = AsyncIterable<AudioChunk> | Iterable<AudioChunk> | Uint8Array | Iterable<number>;
type NormalizedAudioStream = AsyncIterable<AudioChunk> | Iterable<AudioChunk>;
type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;
interface ReloadConfig {
    whisperConfig?: Partial<WhisperConfig>;
    miscConfig?: Record<string, unknown>;
    audio_format?: string;
}
interface InternalRunOptions extends WhisperStreamingOptions {
    streaming?: boolean;
}
/**
 * GGML client implementation for the Whisper transcription model.
 */
declare class TranscriptionWhispercpp {
    readonly logger: QvacLogger;
    readonly exclusiveRun: boolean;
    readonly opts: {
        stats?: boolean;
    };
    readonly state: InferenceClientState;
    params: WhisperConfig;
    addon?: WhisperInterface;
    _files: {
        model: string;
        vadModel: string | null;
    };
    _config: TranscriptionWhispercppConfig;
    _withExclusiveRun: RunExclusive;
    _inferenceQueueWaiter: Promise<void> | null;
    _pendingWhisperJobId: number | null;
    _job: JobHandler;
    constructor({ files, logger, exclusiveRun, opts, }: TranscriptionWhispercppArgs, config: TranscriptionWhispercppConfig);
    getState(): InferenceClientState;
    load(...loadArgs: unknown[]): Promise<void>;
    pause(): Promise<void>;
    unpause(): Promise<void>;
    stop(): Promise<void>;
    status(): Promise<string>;
    _resolveVadModelPath(): string | null;
    _load(..._loadArgs: unknown[]): Promise<void>;
    _getModelFilePath(): string;
    _buildConfigurationParams(overrides?: ReloadConfig): WhisperConfigurationParams;
    _buildWhisperConfig(overrideWhisperConfig: Partial<WhisperConfig>): WhisperConfig;
    _resolveDurationMs(overrideWhisperConfig: Partial<WhisperConfig>): number;
    _stripNonAddonKeys(whisperConfig: WhisperConfig): void;
    _applyVadConfig(whisperConfig: WhisperConfig, overrideWhisperConfig: Partial<WhisperConfig>): void;
    _enqueueExclusiveRunResponse(runFn: () => Promise<QvacResponse<WhisperRunOutput>>): Promise<QvacResponse<WhisperRunOutput>>;
    run(audioStream: AudioStream): Promise<QvacResponse<WhisperRunOutput>>;
    runStreaming(audioStream: AudioStream, opts?: WhisperStreamingOptions): Promise<QvacResponse<WhisperRunOutput>>;
    _runInternal(audioStream: AudioStream, opts?: InternalRunOptions): Promise<QvacResponse<WhisperRunOutput>>;
    _runBatchTranscription(normalizedAudioStream: NormalizedAudioStream): Promise<QvacResponse<WhisperRunOutput>>;
    _runStreaming(audioStream: NormalizedAudioStream, streamingOpts?: InternalRunOptions): Promise<QvacResponse<WhisperRunOutput>>;
    _buildStreamingConfig(vadModelPath: string, streamingOpts: InternalRunOptions): StreamingConfig;
    _handleAudioStream(audioStream: NormalizedAudioStream): Promise<void>;
    _handleStreamingAudio(audioStream: NormalizedAudioStream): Promise<void>;
    _normalizeAudioStream(audioStream: AudioStream): NormalizedAudioStream;
    reload(newConfig?: ReloadConfig): Promise<void>;
    _createAddon(configurationParams: WhisperConfigurationParams): WhisperInterface;
    _outputCallback(_addon: unknown, event: string, jobId: number, data: unknown, error: unknown): void;
    unload(): Promise<void>;
    cancel(): Promise<void>;
    destroy(): Promise<void>;
    validateModelFiles(): void;
    private _requiredAddon;
}
type VadParamsShape = VadParams;
type WhisperConfigShape = WhisperConfig;
type TranscriptionWhispercppFilesShape = TranscriptionWhispercppFiles;
type TranscriptionWhispercppArgsShape = TranscriptionWhispercppArgs;
type TranscriptionWhispercppConfigShape = TranscriptionWhispercppConfig;
type InferenceClientStateShape = InferenceClientState;
type WhisperTranscriptionSegmentShape = WhisperTranscriptionSegment;
type WhisperStreamingOptionsShape = WhisperStreamingOptions;
type VadStateEventShape = VadStateEvent;
type EndOfTurnEventShape = EndOfTurnEvent;
type RuntimeStatsShape = RuntimeStats;
type WhisperRunOutputShape = WhisperRunOutput;
declare namespace TranscriptionWhispercpp {
    type VadParams = VadParamsShape;
    type WhisperConfig = WhisperConfigShape;
    type WhisperTranscriptionSegment = WhisperTranscriptionSegmentShape;
    type WhisperStreamingOptions = WhisperStreamingOptionsShape;
    type VadStateEvent = VadStateEventShape;
    type EndOfTurnEvent = EndOfTurnEventShape;
    type RuntimeStats = RuntimeStatsShape;
    enum BackendId {
        CPU = 0,
        Metal = 1,
        CUDA = 2,
        Vulkan = 3,
        OpenCL = 4,
        Other = 99
    }
    type WhisperRunOutput = WhisperRunOutputShape;
    type TranscriptionWhispercppFiles = TranscriptionWhispercppFilesShape;
    type TranscriptionWhispercppArgs = TranscriptionWhispercppArgsShape;
    type TranscriptionWhispercppConfig = TranscriptionWhispercppConfigShape;
    type InferenceClientState = InferenceClientStateShape;
}
export = TranscriptionWhispercpp;
