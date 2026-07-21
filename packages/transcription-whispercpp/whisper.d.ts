import { type WhisperConfigurationParams } from "./configChecker";
declare const state: Readonly<{
    LOADING: "loading";
    LISTENING: "listening";
    PROCESSING: "processing";
    IDLE: "idle";
    PAUSED: "paused";
    STOPPED: "stopped";
}>;
type AddonState = (typeof state)[keyof typeof state];
type NativeHandle = object;
export interface AudioData {
    type: string;
    input?: Uint8Array;
    audio_format?: string;
}
export interface StreamingConfig {
    vadModelPath?: string;
    vadThreshold?: number;
    minSilenceDurationMs?: number;
    minSpeechDurationMs?: number;
    maxSpeechDurationS?: number;
    speechPadMs?: number;
    samplesOverlap?: number;
    emitVadEvents?: boolean;
    endOfTurnSilenceMs?: number;
    vadRunIntervalMs?: number;
    jobId?: number;
}
export type WhisperOutputCallback = (addon: unknown, event: string, jobId: number, data: unknown, error: string | null) => void;
export type TransitionCallback = (addon: WhisperInterface, newState: string) => void;
type NativeOutputCallback = (addon: unknown, event: unknown, data: unknown, error: unknown) => void;
export interface WhisperBinding {
    createInstance(owner: WhisperInterface, configurationParams: WhisperConfigurationParams, outputCb: NativeOutputCallback, transitionCb: TransitionCallback | null): NativeHandle;
    reload?(handle: NativeHandle, configurationParams: WhisperConfigurationParams): Promise<void> | void;
    loadWeights(handle: NativeHandle, weightsData: unknown): void;
    activate(handle: NativeHandle): void;
    cancel(handle: NativeHandle): Promise<void> | void;
    runJob(handle: NativeHandle, data: AudioData): boolean;
    destroyInstance(handle: NativeHandle): void;
    startStreaming(handle: NativeHandle, config: StreamingConfig): void;
    appendStreamingAudio(handle: NativeHandle, data: AudioData): void;
    endStreaming(handle: NativeHandle): void;
}
export declare class WhisperInterface {
    _binding: WhisperBinding;
    _outputCb: WhisperOutputCallback | null;
    _transitionCb: TransitionCallback | null;
    _nextJobId: number;
    _activeJobId: number | null;
    _bufferedAudio: Uint8Array[];
    _bufferedBytes: number;
    _state: AddonState;
    _audioFormat: string;
    _handle: NativeHandle | null;
    constructor(binding: WhisperBinding, configurationParams: WhisperConfigurationParams, outputCb: WhisperOutputCallback | null, transitionCb?: TransitionCallback | null);
    _setState(newState: AddonState): void;
    _addonOutputCallback(addon: unknown, event: unknown, data: unknown, error: unknown): void;
    _emitTranscript(addon: unknown, jobId: number, data: unknown): void;
    _emitSegments(addon: unknown, jobId: number, segments: unknown[]): void;
    _emitSyntheticError(jobId: number, error: string): void;
    unload(): Promise<void>;
    load(configurationParams: WhisperConfigurationParams): Promise<void>;
    reload(configurationParams: WhisperConfigurationParams): Promise<void>;
    loadWeights(weightsData: unknown): Promise<void>;
    unloadWeights(): Promise<boolean>;
    activate(): Promise<void>;
    pause(): Promise<never>;
    stop(): Promise<never>;
    cancel(jobId?: number): Promise<void>;
    append(data: AudioData): Promise<number>;
    status(): Promise<string>;
    destroyInstance(): Promise<void>;
    runJob(data: AudioData): Promise<boolean>;
    startStreaming(config?: StreamingConfig): void;
    appendStreamingAudio(data: AudioData): void;
    endStreaming(): void;
    finishStreaming(): void;
    _drainBufferedAudio(): Uint8Array;
    _concatBufferedAudio(): Uint8Array;
    private _requiredHandle;
}
export {};
