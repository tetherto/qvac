import type { QvacResponse } from "@qvac/infer-base";
import { WhisperInterface, type StreamingConfig } from "./whisper";
import { type WhisperConfigurationParams } from "./configChecker";
import { type ByteFormat } from "../../lib/audio";
import type { ASRRunOutput, AudioInput, BackendInfo } from "../../lib/types";
import type { ASRGgmlFiles, ASRGgmlReloadConfig, ASRStreamingOptions, AsrDriver, DriverContext, NormalizedAudioStream, StreamingSession } from "../types";
export interface VadParams {
    threshold?: number;
    min_speech_duration_ms?: number;
    min_silence_duration_ms?: number;
    max_speech_duration_s?: number;
    speech_pad_ms?: number;
    samples_overlap?: number;
}
export interface WhisperConfig extends Record<string, unknown> {
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
/** Whisper branch of the discriminated engine-config union. */
export interface WhisperEngineConfig {
    engine: "whisper";
    whisperConfig?: WhisperConfig;
    contextParams?: Record<string, unknown>;
    miscConfig?: Record<string, unknown>;
    audio_format?: string;
    vadModelPath?: string;
    path?: string;
}
export interface WhisperStreamingOptions {
    emitVadEvents?: boolean;
    conversationMode?: boolean;
    endOfTurnSilenceMs?: number;
    vadRunIntervalMs?: number;
}
export interface WhisperReloadConfig {
    whisperConfig?: Partial<WhisperConfig>;
    miscConfig?: Record<string, unknown>;
    audio_format?: string;
}
/**
 * Whisper engine driver: owns the `WhisperInterface`, the whisper event
 * mapping, and the whisper streaming lifecycle.
 */
export declare class WhisperDriver implements AsrDriver {
    readonly engineType: "whisper";
    readonly supportsReload = true;
    addon?: WhisperInterface;
    params: WhisperConfig;
    private readonly ctx;
    private readonly _files;
    private readonly _config;
    private _byteFormat;
    private _pendingJobId;
    constructor(ctx: DriverContext, files: ASRGgmlFiles, config: WhisperEngineConfig);
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
    _validateStreamingOptions(opts: ASRStreamingOptions): WhisperStreamingOptions;
    _pumpBatchAudio(audio: NormalizedAudioStream): Promise<void>;
    _pumpStreamingAudio(audio: NormalizedAudioStream): Promise<void>;
    _resolveVadModelPath(): string | null;
    /**
     * Maps the public `audio_format` config value onto the byte interpretation
     * applied to raw `Uint8Array` input. Unrecognized values are rejected here
     * rather than coerced: the wire format sent to native is pinned to f32le,
     * so the native `UnsupportedAudioFormat` check can no longer see the user's
     * string, and silently decoding (say) `'s16be'` as little-endian produces a
     * garbage transcript with no error at all.
     */
    _resolveByteFormat(overrideAudioFormat?: string): ByteFormat;
    _buildConfigurationParams(overrides?: WhisperReloadConfig): WhisperConfigurationParams;
    _buildWhisperConfig(overrideWhisperConfig: Partial<WhisperConfig>): WhisperConfig;
    _resolveDurationMs(overrideWhisperConfig: Partial<WhisperConfig>): number;
    _stripNonAddonKeys(whisperConfig: WhisperConfig): void;
    _applyVadConfig(whisperConfig: WhisperConfig, overrideWhisperConfig: Partial<WhisperConfig>): void;
    _buildStreamingConfig(vadModelPath: string, streamingOpts: WhisperStreamingOptions): StreamingConfig;
    _createAddon(configurationParams: WhisperConfigurationParams): WhisperInterface;
    _outputCallback(_addon: unknown, event: string, jobId: number, data: unknown, error: unknown): void;
    private _requiredAddon;
}
