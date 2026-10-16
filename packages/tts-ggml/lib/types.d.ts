import type { TTSConditioningFields } from "./conditioning";
import type { EngineType } from "./engineIds";
import type { TTSGgmlRuntimeConfig } from "./engineSetup";
import type { Audio8VoiceFields } from "./engines/audio8";
import type { CosyvoiceInstruct, CosyvoiceJobFields } from "./engines/cosyvoice";
import type { MossSoundEffectFields } from "./engines/mossSoundEffect";
import type { MossSpeechFields } from "./engines/mossSpeech";
import type { ParlerDescriptionFields } from "./engines/parler";
import type { TTSGgmlFiles } from "./modelFiles";
import type { SentenceDelimiterPreset } from "./textStreamAccumulator";
export type { Audio8VoiceFields, CosyvoiceInstruct, CosyvoiceJobFields, MossSoundEffectFields, MossSpeechFields, ParlerDescriptionFields, TTSConditioningFields, TTSGgmlFiles, TTSGgmlRuntimeConfig, };
export type { MossSpeechJobFields, MossSpeechMessage, MossSpeechPcm, } from "./engines/mossSpeech";
export type { Audio8SamplingFields } from "./engines/audio8";
/**
 * LavaSR enhancer config. The discriminated `type` leaves room for future
 * enhancer kinds; v1 ships `lavasr`. Enhancement is enabled by providing a
 * GGUF path here or via `files.lavasrEnhancer`.
 */
export interface LavaSREnhancerOptions {
    type: "lavasr";
    /** Enhancer GGUF path (alternative to `files.lavasrEnhancer`). */
    enhancerPath?: string;
}
/**
 * LavaSR denoiser config. V1 ships the `lavasr` UL-UNAS denoiser. Denoising
 * is enabled by providing a GGUF path here or via `files.lavasrDenoiser`.
 * It runs before the enhancer and preserves the sample rate.
 */
export interface LavaSRDenoiserOptions {
    type: "lavasr";
    /** Denoiser GGUF path (alternative to `files.lavasrDenoiser`). */
    denoiserPath?: string;
}
export interface TTSGgmlOptions extends ParlerDescriptionFields, Audio8VoiceFields, TTSConditioningFields {
    /** Pocket: generation/context controls; native sampling uses a portable RNG. */
    maxTokens?: number;
    noiseClamp?: number;
    eosThreshold?: number;
    framesAfterEos?: number;
    files?: TTSGgmlFiles;
    config?: TTSGgmlRuntimeConfig;
    logger?: object;
    lazySessionLoading?: boolean;
    /** Explicit engine selection. Auto-detected from `files` when omitted. */
    engine?: EngineType;
    /** Chatterbox: directory of baked voice-conditioning tensors. */
    voiceDir?: string;
    /**
     * RNG seed for Chatterbox CFM/SineGen, Supertonic latent generation,
     * the MOSS-SoundEffect diffusion noise (0 when unset, so an unseeded prompt
     * repeats its clip), or Pocket's portable sampling RNG. Pocket accepts
     * integers from 0 to 4294967295 (inclusive).
     */
    seed?: number;
    /**
     * Move N layers to the GPU backend. Chatterbox: pass 99 to move everything.
     * Supertonic: pass 99 to offload on GPU-capable hosts, including Android.
     * Audio8: pass 99 to use Vulkan on Linux and Windows.
     * MOSS: any non-zero value selects the GPU backend.
     * CosyVoice3: pass 99 to offload on Metal (macOS / iOS), Vulkan (desktop
     * Linux / Windows), or OpenCL/Adreno (Android); other hosts fall back to
     * CPU by policy.
     */
    nGpuLayers?: number;
    /**
     * Chatterbox: cap on the T3 context length (prompt + generated speech
     * tokens, 25 tokens ~= 1 second of audio). The KV cache is allocated up
     * front at this length, so the cap directly bounds memory. Pass 0 to use
     * the GGUF's full context; negative values are rejected.
     * Pocket: FlowLM context capacity; accepts integers from 1 to 8192.
     */
    nCtx?: number;
    /**
     * Chatterbox-only T3 KV-cache storage dtype: `f32` | `f16` | `q8_0`.
     * `f16` is the safe cross-backend default. `q8_0` is smaller and faster on
     * supported backends, but is opt-in because not every backend implements
     * its required operations.
     */
    kvCacheType?: "f32" | "f16" | "q8_0";
    /** Override `std::thread::hardware_concurrency()`. */
    threads?: number;
    /**
     * Native streaming chunk size; 0 disables. Chatterbox / CosyVoice3: speech
     * tokens per chunk. MOSS: codec frames per chunk (12.5 per second).
     * Supertonic: text tokens (Unicode code points) per chunk, about 50 for
     * English (CJK is denser, 25-30). Supertonic native streaming cannot be
     * combined with the LavaSR enhancer or denoiser.
     */
    streamChunkTokens?: number;
    /**
     * Chatterbox / CosyVoice3 / Supertonic smaller first chunk for low
     * first-audio-out latency.
     */
    streamFirstChunkTokens?: number;
    /**
     * Supertonic-only: boundary-snap window for clause and whitespace chunk
     * boundaries, as a percentage of the chunk target (engine default 20).
     */
    streamChunkTolerancePct?: number;
    /**
     * Supertonic-only: floor on every streamed chunk's size in text tokens
     * (engine default 30); shorter trailing chunks merge into the previous one.
     */
    streamMinChunkTokens?: number;
    /**
     * Chatterbox: sliding-window S3Gen for native streaming — keep only this many
     * already-emitted speech tokens of left context per chunk, which bounds the
     * per-chunk cost on long utterances (typical 25-50; 0 = cumulative prefix).
     * CosyVoice3: reserved / not yet effective — the pinned tts-cpp engine
     * accepts the value but does not read it.
     */
    streamLeftContextTokens?: number;
    /**
     * Chatterbox CFM Euler step count for native streaming chunks. CosyVoice3:
     * reserved / not yet effective — the engine runs a fixed 10-step schedule
     * and ignores this.
     */
    cfmSteps?: number;
    /**
     * Chatterbox-only CFM Euler step count for batch synthesis; 0 = library
     * default (2-step meanflow on Turbo, the model's full schedule on
     * multilingual). The multilingual engine does not floor this, so values well
     * below its schedule under-integrate.
     */
    batchCfmSteps?: number;
    /**
     * Chatterbox-only cap on speech tokens T3 decodes per synthesis (25 tokens ~=
     * 1 second); engine default 1000 (~40 s). Longer single-call audio also needs
     * `nCtx` to cover prompt plus generated tokens, or use `maxSentenceChars`.
     */
    nPredict?: number;
    /**
     * Chatterbox-only sentence auto-split: run T3 + S3Gen per segment of at most
     * this many bytes (the reference CLI uses 180; 0 = off). Bounds each T3
     * sequence, so `nPredict` applies per segment.
     */
    maxSentenceChars?: number;
    /**
     * Chatterbox-only raised-cosine crossfade between auto-split batch segments,
     * in milliseconds (engine default 30). Native streaming stays gapless.
     */
    crossfadeMs?: number;
    /** Chatterbox-only T3 repetition penalty (engine default 1.2; 1 = off). */
    repeatPenalty?: number;
    /**
     * Chatterbox multilingual only: prosody intensity, above 0 more expressive,
     * below 0 flatter (engine default 0.5). The Turbo variant ignores it.
     */
    exaggeration?: number;
    /**
     * Chatterbox multilingual only: T3 classifier-free guidance scale (engine
     * default 0.5; 0 disables). Separate from `cfgRate`, which steers S3Gen.
     */
    cfgWeight?: number;
    /** Chatterbox multilingual only: min-p sampling threshold (0 = off). */
    minP?: number;
    /**
     * Chatterbox-only S3Gen classifier-free-guidance rate. The diffusion loop
     * normally runs a batched conditioned + unconditioned pass combined by this
     * rate. `0` skips the unconditioned pass; a positive value overrides the
     * model's baked rate. Omit it to retain the baked rate.
     */
    cfgRate?: number;
    /**
     * CosyVoice3: verbatim transcript of `referenceAudio`, selecting the
     * cloning mode per the upstream frontends — set it for zero-shot (the LM
     * is prompted with transcript + reference speech tokens; best fidelity in
     * the reference's own language), omit it for cross-lingual (timbre-only
     * conditioning; best when synthesizing a different language than the
     * reference). Without `referenceAudio` it still overrides the baked
     * voice's transcript metadata for the LM prompt.
     */
    promptText?: string;
    /**
     * CosyVoice3: natural-language control (instruct2) — Chinese dialect, emotion,
     * speed, volume, or style. Pass a structured object (e.g. `{ dialect:
     * 'cantonese' }`, `{ emotion: 'happy' }`) which renders to the trained
     * instruction, or a raw string for an arbitrary instruction. Applied on top of
     * the selected voice's timbre; one control takes effect per synthesis.
     */
    instruct?: string | CosyvoiceInstruct;
    /**
     * Supertonic voice id baked into the GGUF, such as `F1` or `M1`. CosyVoice3:
     * reserved / not yet effective — named-voice selection is not yet wired.
     */
    voice?: string;
    /** Alias for `voice` for compatibility with `@qvac/tts-onnx`. */
    voiceName?: string;
    /**
     * Supertonic-only: external voice JSON (`{ style_ttl, style_dp }`, e.g. a
     * cloned voice) that overrides the baked `voice` preset. The engine checks
     * the tensor sizes against the loaded model.
     */
    voiceJsonPath?: string;
    /**
     * Supertonic-only: text synthesized once at load so GPU pipelines (and a
     * Core ML vocoder sidecar) are ready before the first `run()`; skipped on a
     * plain CPU run. Use a sentence of representative length. Wins over the
     * `vulkanCacheDir` default pre-warm.
     */
    prewarmText?: string;
    /**
     * Supertonic / CosyVoice3 Vulkan adapter index, also used by their LavaSR
     * enhancer: 0 (default) = first adapter, N = the Nth, -1 = auto-pick by free
     * VRAM preferring a discrete adapter. Only consulted on Vulkan.
     */
    vulkanDevice?: number;
    /**
     * CosyVoice3-only: treat the baked-voice prompt frames as attention-only
     * conditioning in the flow, for a faster flow whose output deviates slightly
     * from the reference (engine default off).
     */
    flowCutPrompt?: boolean;
    /** Supertonic CFM steps (0 uses GGUF default); Pocket sampling steps (1–64, default 1). */
    steps?: number;
    /** Alias for `steps` for compatibility with `@qvac/tts-onnx`. */
    numInferenceSteps?: number;
    /**
     * Speech-rate / duration multiplier (1.0 = unchanged, less than 1 slower,
     * greater than 1 faster). Supertonic scales its native duration predictor.
     * Chatterbox applies pitch-preserving WSOLA time-stretch, bounded to
     * [0.25, 4.0].
     */
    speed?: number;
    /** Supertonic optional `.npy` initial-noise tensor path. */
    noiseNpyPath?: string;
    /**
     * LavaSR neural speech enhancement. Opt-in CPU/GGML bandwidth extension to
     * 48 kHz, enabled by a GGUF path here or through `files.lavasrEnhancer`.
     * Works for every engine, including the native chunk streaming of
     * Chatterbox, Parler and CosyVoice3.
     */
    enhancer?: LavaSREnhancerOptions;
    /**
     * LavaSR neural speech denoiser (UL-UNAS). Opt-in preprocessing that runs
     * before the enhancer and preserves the sample rate. Enabled by a GGUF path
     * here or through `files.lavasrDenoiser`; rejected with native chunk
     * streaming (batch synthesis only).
     */
    denoiser?: LavaSRDenoiserOptions;
    /**
     * Directory the addon scans for dynamically loaded ggml backends, as given.
     * Unset scans the addon's own: the one its platform package or the app
     * installed next to the native module.
     */
    backendsDir?: string;
    /** Directory where ggml-opencl persists its compiled program binary. */
    openclCacheDir?: string;
    /**
     * Supertonic + `useGPU: true` only: directory where the Vulkan backend
     * persists its compiled pipeline cache (`GGML_VK_PIPELINE_CACHE_DIR`).
     * Unset means no cross-process cache or load-time pre-warm.
     */
    vulkanCacheDir?: string;
    /** Chatterbox MTL MeCab/IPAdic dictionary directory for Japanese. */
    mecabDictPath?: string;
    mecabDictDir?: string;
    /** Chatterbox MTL Cangjie TSV path for Chinese. */
    cangjieTsvPath?: string;
    /**
     * Parler, Audio8 and Chatterbox sampling knobs; each unset defers to the
     * engine's own defaults (Parler: temperature 1.0, top-k 50; Audio8:
     * temperature 0.7, top-k 50, top-p 0.9; Chatterbox: temperature 0.8,
     * top-k 1000, top-p 0.95, where temperature 0 decodes greedily and top-k 0
     * disables the cutoff). Audio8 filters by top-k/top-p on the raw logits and
     * only then applies the temperature, following its reference.
     * Pocket: sampling temperature; accepts finite values from 0 to 10.
     */
    temperature?: number;
    topK?: number;
    topP?: number;
    /**
     * Generation-length cap in decoder frames; 0 = engine default. Parler runs
     * ~86 frames/s, Audio8 ~21.5.
     */
    maxFrames?: number;
    /** Audio8: take the argmax instead of sampling. */
    greedy?: boolean;
    /**
     * MOSS: target length in codec frames (12.5 per second), from 0 to 2015
     * (about 161 s); 0 or unset keeps the length free. Set at construction or
     * with `reload()`, not per call.
     */
    durationTokens?: number;
    /**
     * MOSS-TTSD dialogue: one 24 kHz reference recording per speaker, in the
     * order the text tags them (`[S1]`, `[S2]`, ...). The model continues the
     * references, so the input text must open with each reference's transcript
     * under its tag, followed by the lines to generate; sentence streaming is
     * therefore rejected (use `run()` or `streamChunkTokens`). Needs
     * `files.mossCodecEncoder`, excludes `referenceAudio`, and is fixed for the
     * instance. With a `modelDir`, requires a `moss-ttsd-*.gguf` backbone.
     */
    dialogueReferences?: string[];
    minNewTokens?: number;
    /** Parler prompt digit expansion (engine default: enabled). */
    normalizeNumbers?: boolean;
    opts?: object;
    exclusiveRun?: boolean;
}
export interface InferenceState {
    configLoaded: boolean;
    weightsLoaded: boolean;
    destroyed: boolean;
}
export interface TTSOutputChunk {
    chunkIndex?: number;
    isLast?: boolean;
    /** Signed 16-bit mono PCM audio payload. */
    outputArray: Int16Array;
    /** MOSS-Speech: the reply's text channel (the whole answer with `textReply`). */
    text?: string;
    /**
     * Output sample rate. The native engine rate (24000 for Chatterbox,
     * CosyVoice3 and MOSS; 44100 for Supertonic, Parler, and Audio8), or 48000
     * when the LavaSR enhancer is active.
     */
    sampleRate?: number;
}
export interface NativeOutputChunk {
    outputArray: Int16Array;
    text?: string;
    isLast?: boolean;
    sampleRate?: number;
}
export interface RuntimeStats {
    firstAudioMs?: number;
    totalTime: number;
    tokensPerSecond: number;
    realTimeFactor: number;
    audioDurationMs: number;
    totalSamples: number;
    /** Active compute device after load-time backend selection. 0 = CPU, 1 = GPU. */
    backendDevice?: number;
    /** Stable backend code: 0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other GPU. */
    backendId?: number;
    /** LavaSR enhancer compute device. -1 = not loaded, 0 = CPU, 1 = GPU. */
    enhancerBackendDevice?: number;
    /** LavaSR enhancer backend code, using the same values as `backendId`. */
    enhancerBackendId?: number;
    /** LavaSR denoiser compute device. -1 = not loaded, 0 = CPU, 1 = GPU. */
    denoiserBackendDevice?: number;
    /** LavaSR denoiser backend code, using the same values as `backendId`. */
    denoiserBackendId?: number;
    /** 1 when a present GPU is unsupported by engine policy; 0 otherwise. */
    gpuUnsupported?: number;
    /**
     * Audio8 and MOSS only: codec frames generated (Audio8 on a fixed 46 ms
     * grid, MOSS at 12.5 per second). This is the unit their `tokensPerSecond`
     * counts, in batch and in streaming alike.
     */
    generatedFrames?: number;
    /**
     * Audio8 only, macOS / iOS: 1 while an Apple Core ML sidecar for the codec's
     * synthesis stack is attached (a compiled `audio8-codec-decoder.mlmodelc`
     * next to the decoder GGUF); 0 without one, or once a failing sidecar has
     * been retired. Streams report the last chunk that supplied this field.
     */
    codecSidecarLoaded?: number;
    /**
     * Audio8 only: 1 when this synthesis ran the codec's synthesis stack on the
     * Apple Core ML sidecar -- a compiled `audio8-codec-decoder.mlmodelc` next
     * to the decoder GGUF on macOS / iOS -- 0 when it ran on the ggml backend
     * `backendId` reports (which the language model always uses). A loaded
     * sidecar that cannot serve a call falls back to ggml and reports 0 for it.
     * Streams report the last chunk that supplied this field, not a sum.
     */
    codecOnCoreml?: number;
    /** Chatterbox only: T3 decode wall time of the last synthesis, in ms. */
    t3Ms?: number;
    /** Chatterbox only: S3Gen + HiFT wall time of the last synthesis, in ms. */
    s3genMs?: number;
    /** Chatterbox only: speech tokens T3 emitted in the last synthesis. */
    t3Tokens?: number;
    /**
     * CosyVoice3 / Audio8: the engine's own wall time for the last synthesis, in
     * ms (the sum of its stages), excluding the addon's post-processing.
     */
    stageTotalMs?: number;
    /** CosyVoice3 stage wall times of the last synthesis, in ms. */
    lmPrefillMs?: number;
    lmDecodeMs?: number;
    flowFrontendMs?: number;
    ditEulerMs?: number;
    hiftF0Ms?: number;
    hiftSourceMs?: number;
    hiftStftMs?: number;
    hiftDecodeMs?: number;
    /**
     * CosyVoice3 work counters of the last synthesis: LM decode steps, speech
     * tokens generated, flow frames in (prompt + generated), mel frames out,
     * text ids in the LM prefill, and prompt speech tokens the LM continued from.
     */
    decodeSteps?: number;
    speechTokens?: number;
    flowFrames?: number;
    melFrames?: number;
    textIds?: number;
    promptSpeechTokens?: number;
    /** Audio8 stage wall times of the last synthesis, in ms. */
    voiceEncodeMs?: number;
    promptMs?: number;
    prefillMs?: number;
    sampleMs?: number;
    fastDecodeMs?: number;
    slowDecodeMs?: number;
    codecLatentMs?: number;
    codecSynthMs?: number;
    resampleMs?: number;
}
/**
 * tts-cpp's canonical conditioning vocabulary and each engine's supported
 * subset, keyed by engine type (`TTSGgml.getVoiceControls()`).
 */
export interface VoiceControlsCatalog {
    emotions: string[];
    paces: string[];
    engines: Record<string, {
        emotions: string[];
        paces: string[];
    }>;
}
export interface NativeStats {
    firstAudioMs?: number;
    totalTime?: number;
    audioDurationMs?: number;
    totalSamples?: number;
    [key: string]: unknown;
}
export interface SentenceStreamChunkMeta {
    chunkIndex?: number;
    sentenceChunk?: string;
    /**
     * True on the final pre-chunked synthesis output. Undefined for async
     * iterator streaming where the final chunk is not known up front.
     */
    isLast?: boolean;
}
export interface SentenceStreamOptions extends ParlerDescriptionFields, Audio8VoiceFields, TTSConditioningFields, CosyvoiceJobFields {
    /** BCP-47 locale for `Intl.Segmenter` when available. */
    locale?: string;
    /** Maximum graphemes per chunk; defaults to 300, or 120 for Korean. */
    maxChunkScalars?: number;
}
export interface RunStreamingOptions extends ParlerDescriptionFields, Audio8VoiceFields, TTSConditioningFields, CosyvoiceJobFields {
    accumulateSentences?: boolean;
    sentenceDelimiter?: RegExp;
    sentenceDelimiterPreset?: SentenceDelimiterPreset;
    maxBufferScalars?: number;
    flushAfterMs?: number;
}
/** Input accepted by `runStreaming`. */
export type TextStreamInput = string | string[] | Iterable<string> | AsyncIterable<string>;
export interface TTSRunInput extends ParlerDescriptionFields, Audio8VoiceFields, TTSConditioningFields, CosyvoiceJobFields, MossSoundEffectFields, MossSpeechFields {
    type?: string;
    input: string;
    streamOutput?: boolean;
    locale?: string;
    maxChunkScalars?: number;
    /**
     * Cancels non-streaming `run()`. An already-aborted signal rejects without
     * native dispatch. Ignored by all streaming paths.
     */
    signal?: AbortSignal;
}
