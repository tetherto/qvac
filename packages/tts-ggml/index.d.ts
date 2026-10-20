import { type QvacResponse } from "@qvac/infer-base";
import * as errorModule from "./lib/error";
import type * as Fit from "./lib/fit";
import { type EngineType } from "./lib/engineIds";
import type * as PublicTypes from "./lib/types";
import type { InferenceState, RunStreamingOptions, SentenceStreamChunkMeta, SentenceStreamOptions, TextStreamInput, TTSGgmlOptions, TTSOutputChunk, TTSRunInput, VoiceControlsCatalog } from "./lib/types";
/**
 * GGML-backed TTS via the `tts-cpp` library. Wraps the chatterbox,
 * supertonic, parler, cosyvoice3, audio8 and moss engines behind a single
 * engine-agnostic JavaScript surface. Engine type is auto-detected from
 * `files` or selected explicitly with `engine`.
 *
 * Owns a persistent native engine: model weights and voice-conditioning
 * tensors are loaded once by `load()` and reused by `run()`, `runStream()`,
 * and `runStreaming()`.
 */
declare class TTSGgml {
    static readonly inferenceManagerConfig: {
        noAdditionalDownload: boolean;
    };
    static readonly ENGINE_CHATTERBOX = "chatterbox";
    static readonly ENGINE_SUPERTONIC = "supertonic";
    static readonly ENGINE_COSYVOICE3 = "cosyvoice3";
    static readonly ENGINE_PARLER = "parler";
    static readonly ENGINE_AUDIO8 = "audio8";
    static readonly ENGINE_MOSS = "moss";
    static readonly ENGINE_MOSS_SFX = "moss-sfx";
    static readonly ENGINE_MOSS_SPEECH = "moss-speech";
    static readonly ENGINE_POCKET = "pocket";
    opts: object;
    exclusiveRun: boolean;
    logger: object;
    state: InferenceState;
    addon: unknown;
    private readonly _job;
    private readonly _runExclusive;
    private readonly _exclusiveStreams;
    /** Everything resolved from the constructor options; reload rewrites parts of it. */
    private readonly _setup;
    private readonly _sentenceStream;
    private readonly _events;
    /** The Pocket execution rules, or null for every other engine. */
    private readonly _pocket;
    private _lazySessionLoading;
    constructor(options?: TTSGgmlOptions);
    getEngineType(): EngineType;
    getApiDefinition(): string;
    getState(): InferenceState;
    load(..._args: unknown[]): Promise<void>;
    private _loadModel;
    /**
     * Run text-to-speech. With `{ streamOutput: true }`, splits `input` into
     * chunks and emits PCM through `response.onUpdate` for each chunk.
     */
    run(input: TTSRunInput & {
        streamOutput: true;
    }): Promise<QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>>;
    run(input: TTSRunInput): Promise<QvacResponse<TTSOutputChunk>>;
    /**
     * Chunked streaming synthesis. Equivalent to
     * `run({ input: text, streamOutput: true, ...options })`.
     */
    runStream(text: string, options?: SentenceStreamOptions): Promise<QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>>;
    /**
     * Streaming text in and streaming audio out. Each flushed string is one
     * native job and emits PCM through `response.onUpdate`.
     *
     * For `AsyncIterable` inputs, `accumulateSentences` defaults to `true` so
     * small streamed fragments are coalesced.
     */
    runStreaming(textStream: TextStreamInput, options?: RunStreamingOptions): Promise<QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>>;
    /** Streams line up behind each other under `exclusiveRun`; otherwise they start at once. */
    private _startStream;
    private _runStreamOrchestrator;
    private _load;
    private _buildTtsParams;
    /** A native instance that reports through this wrapper's output callback. */
    private _spawnAddon;
    private _createAddon;
    unload(): Promise<void>;
    private _unloadModel;
    destroy(): Promise<void>;
    private _withPocketLifecycle;
    private _runInternal;
    private _addonOutputCallback;
    private _dispatchJob;
    cancel(): Promise<void>;
    reload(newConfig?: Record<string, unknown>): Promise<void>;
    static getModelKey(_params?: unknown): string;
    /**
     * tts-cpp's canonical emotion / pace vocabulary and each engine's supported
     * subset, read from the native library without loading a model. Engines are
     * keyed by engine type, so tts-cpp's `cosyvoice` appears as `cosyvoice3`;
     * an engine this package does not wrap keeps its tts-cpp name.
     */
    static getVoiceControls(): VoiceControlsCatalog;
    private _requireAddon;
    private _optionalAddon;
    private _getLogger;
}
declare namespace TTSGgml {
    export import QvacErrorAddonTTSGgml = errorModule.QvacErrorAddonTTSGgml;
    export import ERR_CODES = errorModule.ERR_CODES;
    type TTSGgmlFiles = PublicTypes.TTSGgmlFiles;
    type TTSGgmlRuntimeConfig = PublicTypes.TTSGgmlRuntimeConfig;
    type TTSGgmlOptions = PublicTypes.TTSGgmlOptions;
    type LavaSREnhancerOptions = PublicTypes.LavaSREnhancerOptions;
    type LavaSRDenoiserOptions = PublicTypes.LavaSRDenoiserOptions;
    type RuntimeStats = PublicTypes.RuntimeStats;
    type TTSOutputChunk = PublicTypes.TTSOutputChunk;
    type SentenceStreamChunkMeta = PublicTypes.SentenceStreamChunkMeta;
    type SentenceStreamOptions = PublicTypes.SentenceStreamOptions;
    type RunStreamingOptions = PublicTypes.RunStreamingOptions;
    type TextStreamInput = PublicTypes.TextStreamInput;
    type TTSRunInput = PublicTypes.TTSRunInput;
    type InferenceState = PublicTypes.InferenceState;
    type CosyvoiceInstruct = PublicTypes.CosyvoiceInstruct;
    type VoiceControlsCatalog = PublicTypes.VoiceControlsCatalog;
    type TtsFitEngine = Fit.TtsFitEngine;
    type TtsFitRequest = Fit.TtsFitRequest;
    type TtsFitResult = Fit.TtsFitResult;
    type TtsFitStatus = Fit.TtsFitStatus;
    type SupertonicFitRequest = Fit.SupertonicFitRequest;
    type ParlerFitRequest = Fit.ParlerFitRequest;
    type ChatterboxFitRequest = Fit.ChatterboxFitRequest;
    type Audio8FitRequest = Fit.Audio8FitRequest;
    type MossFitRequest = Fit.MossFitRequest;
    type MossSoundEffectFitRequest = Fit.MossSoundEffectFitRequest;
    type CosyvoiceFitRequest = Fit.CosyvoiceFitRequest;
    const assessFit: typeof Fit.assessFit;
}
export = TTSGgml;
