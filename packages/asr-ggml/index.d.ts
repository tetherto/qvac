import QvacLogger = require("@qvac/logging");
import { type QvacResponse } from "@qvac/infer-base";
import { QvacErrorAddonASRGgml } from "./lib/error";
import { BackendId as BackendIdEnum, type ASRRunOutput, type ASRStreamOutput, type AudioChunk, type AudioInput, type BackendInfo, type EndOfTurnEvent, type InferenceClientState, type ParakeetRuntimeStats, type RuntimeStats, type RuntimeStatsCore, type TranscriptionSegment, type VadEvent, type WhisperRuntimeStats } from "./lib/types";
import type { ASRGgmlFiles, ASRGgmlReloadConfig, ASRStreamingOptions, EngineType } from "./engines/types";
import { type VadParams, type WhisperConfig, type WhisperEngineConfig, type WhisperStreamingOptions } from "./engines/whisper/driver";
import { type ParakeetConfig, type ParakeetEngineConfig, type ParakeetStreamingRunConfig } from "./engines/parakeet/driver";
type ASRGgmlConfig = WhisperEngineConfig | ParakeetEngineConfig;
interface ASRGgmlOptions {
    files: ASRGgmlFiles;
    /** Engine-scoped configuration; the discriminant is `config.engine`. */
    config?: ASRGgmlConfig;
    /** Convenience alias when `config` is omitted; `config.engine` wins. */
    engine?: EngineType;
    /** Attach runtime stats to the job-end payload (default: true). */
    enableStats?: boolean;
    logger?: QvacLogger.LoggerInterface | null;
    exclusiveRun?: boolean;
}
/**
 * Unified multi-engine ASR client for the whisper and parakeet GGML
 * engines. The engine is selected per instance (`config.engine`, `engine`,
 * or model-file sniffing); the public method surface is engine-agnostic
 * while config vocabularies stay engine-scoped.
 */
declare class ASRGgml {
    static readonly ENGINE_WHISPER = "whisper";
    static readonly ENGINE_PARAKEET = "parakeet";
    static readonly ERR_CODES: Readonly<{
        FAILED_TO_LOAD_WEIGHTS: 6001;
        FAILED_TO_CANCEL: 6002;
        FAILED_TO_APPEND: 6003;
        FAILED_TO_GET_STATUS: 6004;
        FAILED_TO_DESTROY: 6005;
        FAILED_TO_ACTIVATE: 6006;
        FAILED_TO_RESET: 6007;
        FAILED_TO_PAUSE: 6008;
        VAD_MODEL_REQUIRED: 6009;
        JOB_ALREADY_RUNNING: 6010;
        INVALID_AUDIO_INPUT: 6011;
        FAILED_TO_START_STREAMING: 6012;
        FAILED_TO_APPEND_STREAMING: 6013;
        FAILED_TO_END_STREAMING: 6014;
        BUFFER_LIMIT_EXCEEDED: 6015;
        FAILED_TO_STOP: 6016;
        MODEL_REQUIRED: 6017;
        VAD_MODEL_NOT_FOUND: 6018;
        MODEL_NOT_FOUND: 24009;
        INVALID_AUDIO_FORMAT: 24010;
        INVALID_CONFIG: 24015;
        INSTANCE_DESTROYED: 24018;
        JOB_CANCELLED: 24019;
        NOT_SUPPORTED: 6019;
        STREAMING_SESSION_ACTIVE: 6020;
        INVALID_ENGINE: 6021;
    }>;
    static readonly Error: typeof QvacErrorAddonASRGgml;
    static readonly inferenceManagerConfig: Readonly<{
        noAdditionalDownload: true;
    }>;
    static getModelKey(): string;
    readonly logger: QvacLogger;
    readonly exclusiveRun: boolean;
    readonly enableStats: boolean;
    readonly state: InferenceClientState;
    private readonly _engineType;
    private readonly _driver;
    private readonly _job;
    private _queueTail;
    private _openSession;
    constructor(options: ASRGgmlOptions);
    getState(): InferenceClientState;
    getEngineType(): EngineType;
    getBackendInfo(): BackendInfo | null;
    load(): Promise<void>;
    unload(): Promise<void>;
    destroy(): Promise<void>;
    reload(newConfig?: ASRGgmlReloadConfig): Promise<void>;
    cancel(jobId?: number): Promise<void>;
    status(): Promise<string>;
    pause(): Promise<never>;
    unpause(): Promise<never>;
    run(audio: AudioInput): Promise<QvacResponse<ASRRunOutput>>;
    runStreaming(audio: AudioInput, opts?: ASRStreamingOptions): Promise<QvacResponse<ASRStreamOutput>>;
    private _resolveEngine;
    private _validateWhisperVadModel;
    private _assertNoOpenSession;
    /**
     * Single serialized queue for run/reload/unload/destroy. `"onReturn"`
     * releases the slot when `fn()` settles; `"onSettle"` requires `fn()` to
     * resolve with a `QvacResponse` and holds the slot until that response
     * settles.
     */
    private _enqueue;
}
type EngineTypeShape = EngineType;
type ASRGgmlOptionsShape = ASRGgmlOptions;
type ASRGgmlFilesShape = ASRGgmlFiles;
type ASRGgmlConfigShape = ASRGgmlConfig;
type WhisperEngineConfigShape = WhisperEngineConfig;
type ParakeetEngineConfigShape = ParakeetEngineConfig;
type WhisperConfigShape = WhisperConfig;
type ParakeetConfigShape = ParakeetConfig;
type VadParamsShape = VadParams;
type ASRGgmlReloadConfigShape = ASRGgmlReloadConfig;
type ASRStreamingOptionsShape = ASRStreamingOptions;
type WhisperStreamingOptionsShape = WhisperStreamingOptions;
type ParakeetStreamingRunConfigShape = ParakeetStreamingRunConfig;
type TranscriptionSegmentShape = TranscriptionSegment;
type VadEventShape = VadEvent;
type EndOfTurnEventShape = EndOfTurnEvent;
type ASRRunOutputShape = ASRRunOutput;
type ASRStreamOutputShape = ASRStreamOutput;
type AudioChunkShape = AudioChunk;
type AudioInputShape = AudioInput;
type BackendInfoShape = BackendInfo;
type RuntimeStatsCoreShape = RuntimeStatsCore;
type WhisperRuntimeStatsShape = WhisperRuntimeStats;
type ParakeetRuntimeStatsShape = ParakeetRuntimeStats;
type RuntimeStatsShape = RuntimeStats;
type InferenceClientStateShape = InferenceClientState;
declare namespace ASRGgml {
    type EngineType = EngineTypeShape;
    type ASRGgmlOptions = ASRGgmlOptionsShape;
    type ASRGgmlFiles = ASRGgmlFilesShape;
    type ASRGgmlConfig = ASRGgmlConfigShape;
    type WhisperEngineConfig = WhisperEngineConfigShape;
    type ParakeetEngineConfig = ParakeetEngineConfigShape;
    type WhisperConfig = WhisperConfigShape;
    type ParakeetConfig = ParakeetConfigShape;
    type VadParams = VadParamsShape;
    type ASRGgmlReloadConfig = ASRGgmlReloadConfigShape;
    type ASRStreamingOptions = ASRStreamingOptionsShape;
    type WhisperStreamingOptions = WhisperStreamingOptionsShape;
    type ParakeetStreamingRunConfig = ParakeetStreamingRunConfigShape;
    type TranscriptionSegment = TranscriptionSegmentShape;
    type VadEvent = VadEventShape;
    type EndOfTurnEvent = EndOfTurnEventShape;
    type ASRRunOutput = ASRRunOutputShape;
    type ASRStreamOutput = ASRStreamOutputShape;
    type AudioChunk = AudioChunkShape;
    type AudioInput = AudioInputShape;
    type BackendInfo = BackendInfoShape;
    type RuntimeStatsCore = RuntimeStatsCoreShape;
    type WhisperRuntimeStats = WhisperRuntimeStatsShape;
    type ParakeetRuntimeStats = ParakeetRuntimeStatsShape;
    type RuntimeStats = RuntimeStatsShape;
    type InferenceClientState = InferenceClientStateShape;
    export import BackendId = BackendIdEnum;
}
export = ASRGgml;
