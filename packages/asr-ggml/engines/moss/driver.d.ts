import type { QvacResponse } from "@qvac/infer-base";
import { ParakeetInterface, type ParakeetConfigurationParams } from "../parakeet/parakeet";
import type { ASRRunOutput, AudioInput, BackendInfo } from "../../lib/types";
import type { ASRGgmlFiles, ASRRunOptions, AsrDriver, DriverContext, NormalizedAudioStream, StreamingSession } from "../types";
export declare const ENGINE_MOSS_TRANSCRIBE: "moss-transcribe";
/** MOSS-Transcribe-Diarize load-time configuration. */
export interface MossTranscribeConfig {
    /** Maximum CPU threads for inference (0 lets the engine pick). */
    maxThreads?: number;
    /** Enable the linked ggml GPU backend (Metal / Vulkan / OpenCL / CUDA). */
    useGPU?: boolean;
    /**
     * Directory containing dynamically-loaded ggml backend libraries. Defaults
     * to the package's own `prebuilds/` folder.
     */
    backendsDir?: string;
}
/** MOSS-Transcribe-Diarize branch of the discriminated engine-config union. */
export interface MossTranscribeEngineConfig {
    engine: typeof ENGINE_MOSS_TRANSCRIBE;
    mossTranscribeConfig?: MossTranscribeConfig;
}
/**
 * Per-call MOSS-Transcribe-Diarize options for `run(audio, options)`. Each is
 * optional; unset fields keep the model's defaults.
 */
export interface MossTranscribeRunOptions {
    /**
     * Names, brands and domain terms likely to appear in the audio; the model
     * spells them as given. Up to 64 entries of up to 64 UTF-8 bytes each.
     */
    hotwords?: string[];
    /** Replaces the default transcription instruction (excludes `hotwords`). */
    prompt?: string;
    /** Bound on generated tokens (0 or unset = model default). */
    maxNewTokens?: number;
}
/** Validates the per-call options and returns the fields the native job reads. */
export declare function mossTranscribeJobFields(options?: ASRRunOptions): Record<string, unknown>;
/**
 * MOSS-Transcribe-Diarize engine driver: one pass over a whole recording
 * that returns timestamped, speaker-labelled segments. Backed by the
 * speech-cpp parakeet engine's MOSS transcriber through the shared native
 * binding; there is no streaming and no native reload.
 */
export declare class MossTranscribeDriver implements AsrDriver {
    readonly engineType: "moss-transcribe";
    readonly supportsReload = false;
    addon?: ParakeetInterface;
    params: MossTranscribeConfig;
    private readonly ctx;
    private readonly _files;
    constructor(ctx: DriverContext, files: ASRGgmlFiles, config: MossTranscribeEngineConfig);
    validateConfig(): void;
    normalizeAudio(input: AudioInput): NormalizedAudioStream;
    load(): Promise<void>;
    unload(): Promise<void>;
    reload(): Promise<void>;
    cancelActive(jobId?: number): Promise<void>;
    status(): Promise<string>;
    getBackendInfo(): BackendInfo | null;
    run(audio: NormalizedAudioStream, options?: ASRRunOptions): Promise<QvacResponse<ASRRunOutput>>;
    createStreamingSession(): Promise<StreamingSession>;
    _pumpBatchAudio(audio: NormalizedAudioStream, job: Record<string, unknown>): Promise<void>;
    _buildConfigurationParams(): ParakeetConfigurationParams;
    _createAddon(configurationParams: ParakeetConfigurationParams): ParakeetInterface;
    private _outputCallback;
    private _requireAddon;
}
