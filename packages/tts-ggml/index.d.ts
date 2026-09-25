import { type QvacResponse } from "@qvac/infer-base";
import * as errorModule from "./lib/error";
import { resolveBackendsDir as resolveBackendsDirImpl } from "./lib/backends";
import { assessFit as assessFitImpl, type Audio8FitRequest, type MossFitRequest, type ChatterboxFitRequest, type CosyvoiceFitRequest, type ParlerFitRequest, type SupertonicFitRequest, type TtsFitEngine, type TtsFitRequest, type TtsFitResult, type TtsFitStatus } from "./lib/fit";
import { type SentenceDelimiterPreset } from "./lib/textStreamAccumulator";
declare const ENGINE_CHATTERBOX = "chatterbox";
declare const ENGINE_SUPERTONIC = "supertonic";
declare const ENGINE_COSYVOICE3 = "cosyvoice3";
declare const ENGINE_PARLER = "parler";
declare const ENGINE_AUDIO8 = "audio8";
declare const ENGINE_MOSS = "moss";
declare const ENGINE_POCKET = "pocket";
declare const COSYVOICE_DIALECTS: {
    readonly cantonese: "广东话";
    readonly northeastern: "东北话";
    readonly gansu: "甘肃话";
    readonly guizhou: "贵州话";
    readonly henan: "河南话";
    readonly hubei: "湖北话";
    readonly hunan: "湖南话";
    readonly jiangxi: "江西话";
    readonly minnan: "闽南话";
    readonly ningxia: "宁夏话";
    readonly shanxi: "山西话";
    readonly shaanxi: "陕西话";
    readonly shandong: "山东话";
    readonly shanghai: "上海话";
    readonly sichuan: "四川话";
    readonly tianjin: "天津话";
    readonly yunnan: "云南话";
};
declare const COSYVOICE_VOLUMES: {
    readonly loud: "Please say a sentence as loudly as possible.";
    readonly soft: "Please say a sentence in a very soft voice.";
};
declare const COSYVOICE_STYLES: {
    readonly peppa: "我想体验一下小猪佩奇风格，可以吗？";
    readonly robot: "你可以尝试用机器人的方式解答吗？";
};
/**
 * CosyVoice3 controls that have no canonical cross-engine vocabulary yet.
 * Emotion and speaking rate are NOT here -- use the top-level `emotion` /
 * `pace` options, which work the same way on every engine that supports them.
 * Exactly one field takes effect per synthesis, resolved by precedence
 * dialect > volume > style. Pass a raw string instead for an arbitrary
 * instruction (advanced escape hatch).
 */
interface CosyvoiceInstruct {
    /** Chinese dialect; renders "请用{dialect}表达。". */
    dialect?: keyof typeof COSYVOICE_DIALECTS;
    /** Loudness. */
    volume?: keyof typeof COSYVOICE_VOLUMES;
    /** Playful style preset. */
    style?: keyof typeof COSYVOICE_STYLES;
}
declare const EMOTIONS: readonly ["command", "anger", "narration", "conversation", "disgust", "fear", "happy", "neutral", "proper noun", "news", "sad", "surprise"];
declare const PACES: readonly ["slow", "moderate", "fast"];
type Emotion = (typeof EMOTIONS)[number];
type Pace = (typeof PACES)[number];
type EngineType = typeof ENGINE_CHATTERBOX | typeof ENGINE_SUPERTONIC | typeof ENGINE_COSYVOICE3 | typeof ENGINE_PARLER | typeof ENGINE_AUDIO8 | typeof ENGINE_MOSS | typeof ENGINE_POCKET;
/**
 * Model file paths for the GGML TTS backend. Engine is auto-detected
 * from these fields (Chatterbox vs Supertonic) unless overridden via
 * `TTSGgmlOptions.engine`. All paths must be absolute and are passed
 * through to the native layer as-is.
 */
interface TTSGgmlFiles {
    pocketFlowModel?: string;
    pocketMimiModel?: string;
    pocketFrontend?: string;
    pocketVoice?: string;
    /**
     * Bundle root. For Chatterbox, expected to contain
     * `chatterbox-t3-turbo.gguf` + `chatterbox-s3gen.gguf` (turbo) or
     * `chatterbox-t3-mtl.gguf` + `chatterbox-s3gen-mtl.gguf` (multilingual).
     * For Supertonic, expected to contain `supertonic.gguf`.
     */
    modelDir?: string;
    /** Chatterbox T3 (text to speech tokens) GGUF path. Overrides `modelDir`. */
    t3Model?: string;
    t3ModelPath?: string;
    t3?: string;
    /** Chatterbox S3Gen + HiFT (speech tokens to 24 kHz wav) GGUF path. Overrides `modelDir`. */
    s3genModel?: string;
    s3genModelPath?: string;
    s3gen?: string;
    /** Supertonic single-file GGUF path. Overrides `modelDir`. */
    supertonicModel?: string;
    supertonicModelPath?: string;
    supertonic?: string;
    /** Parler single-file GGUF path (mini/large/indic). Overrides `modelDir`. */
    parlerModel?: string;
    parlerModelPath?: string;
    parler?: string;
    /** Audio8 DualAR language model GGUF path. Overrides `modelDir`. */
    audio8Lm?: string;
    audio8LmPath?: string;
    /** Audio8 codec synthesis half (codes to 44.1 kHz wav). Overrides `modelDir`. */
    audio8CodecDecoder?: string;
    audio8CodecDecoderPath?: string;
    /**
     * Audio8 codec analysis half (wav to codes). Only needed to clone a voice
     * from a recording; a text-only deployment can leave it out.
     */
    audio8CodecEncoder?: string;
    audio8CodecEncoderPath?: string;
    /**
     * MOSS Delay backbone GGUF path: MOSS-TTS (`moss-tts-delay-*.gguf`) or the
     * MOSS-TTSD dialogue checkpoint (`moss-ttsd-*.gguf`). Overrides `modelDir`.
     */
    mossBackbone?: string;
    mossBackbonePath?: string;
    /** MOSS codec synthesis half (codes to 24 kHz wav). Overrides `modelDir`. */
    mossCodecDecoder?: string;
    mossCodecDecoderPath?: string;
    /**
     * MOSS codec analysis half (wav to codes). Only needed to clone a voice
     * from `referenceAudio` or for `dialogueReferences`; a text-only deployment
     * can leave it out.
     */
    mossCodecEncoder?: string;
    mossCodecEncoderPath?: string;
    /**
     * CosyVoice3 model directory holding the sub-model GGUFs
     * (`cosyvoice3-{llm,flow,hift}-*.gguf`) plus `voice.gguf`, `vocab.json` and
     * `merges.txt`. Routes to the CosyVoice3 engine. Falls back to the shared
     * `modelDir` when unset.
     */
    cosyvoiceModelDir?: string;
    /** CosyVoice3 per-component GGUF paths (override discovery under the model dir). */
    cosyvoiceLlmModel?: string;
    cosyvoiceLlmModelPath?: string;
    cosyvoiceFlowModel?: string;
    cosyvoiceFlowModelPath?: string;
    cosyvoiceHiftModel?: string;
    cosyvoiceHiftModelPath?: string;
    /**
     * CosyVoice3 voice-cloning add-on GGUFs, required only when
     * `referenceAudio` is set: the speech_tokenizer_v3 speech tokenizer
     * (`cosyvoice3-s3tok-*.gguf`) and the CAM++ speaker encoder
     * (`cosyvoice3-campplus-*.gguf`). Auto-discovered under
     * `cosyvoiceModelDir` by those name prefixes when unset.
     */
    cosyvoiceS3tokModel?: string;
    cosyvoiceS3tokModelPath?: string;
    cosyvoiceCampplusModel?: string;
    cosyvoiceCampplusModelPath?: string;
    /**
     * CosyVoice3 Qwen2 BPE text frontend (`vocab.json` + `merges.txt`) and the
     * baked default-voice GGUF (`voice.gguf`). Each is resolved under the model
     * dir when unset; `cosyvoiceVoiceModel` is how a different baked voice is
     * selected without a separate model directory.
     */
    cosyvoiceVocab?: string;
    cosyvoiceVocabPath?: string;
    cosyvoiceMerges?: string;
    cosyvoiceMergesPath?: string;
    cosyvoiceVoiceModel?: string;
    cosyvoiceVoiceModelPath?: string;
    /**
     * LavaSR enhancer GGUF: single-file Vocos bandwidth extension produced by
     * tts-cpp/scripts/convert-lavasr-enhancer-to-gguf.py. When supplied, output
     * is neurally upsampled to 48 kHz (the canonical way to enable enhancement;
     * `enhancer.enhancerPath` is the only alternative).
     */
    lavasrEnhancer?: string;
    /**
     * LavaSR denoiser GGUF: UL-UNAS speech denoiser produced by
     * tts-cpp/scripts/convert-lavasr-denoiser-to-gguf.py. Runs before the
     * enhancer and is rate-preserving (the canonical way to enable denoising;
     * `denoiser.denoiserPath` is the only alternative).
     *
     * The tts-cpp UL-UNAS forward is implemented in qvac-fabric-speech.cpp
     * PR #78 (scalar CPU port, validated bit-close to the ONNX reference).
     */
    lavasrDenoiser?: string;
    /** Optional directory containing baked Chatterbox voice profiles. */
    voicesDir?: string;
    /**
     * Chatterbox MTL only: directory holding the compiled MeCab/IPAdic
     * dictionary used for Japanese morphological segmentation. Forwarded to
     * tts-cpp's `EngineOptions::mecab_dict_path`. Alias: top-level
     * `mecabDictPath`.
     */
    mecabDictDir?: string;
    mecabDictPath?: string;
    /**
     * Chatterbox MTL only: path to the Cangjie TSV used for Chinese
     * romanisation. Forwarded to tts-cpp's `EngineOptions::cangjie_tsv_path`.
     */
    cangjieTsvPath?: string;
    cangjieTsv?: string;
}
interface TTSGgmlRuntimeConfig {
    /**
     * Language code; default "en". Chatterbox MTL accepts
     * es/fr/de/pt/it/zh/ja/ko/... CosyVoice3: reserved / not yet effective — the
     * text-normalization frontend is not yet integrated, so it is accepted but
     * not acted on.
     */
    language?: string;
    /**
     * Route inference through a GPU backend (Metal / Vulkan / OpenCL) if
     * available. Defaults to `false`. Audio8 uses Vulkan on Linux and Windows;
     * CosyVoice3 selects Metal on Apple, Vulkan on desktop Linux / Windows, and
     * OpenCL/Adreno on Android (Mali / Xclipse decline to CPU); the other
     * GPU-capable engines select a backend for the host platform.
     */
    useGPU?: boolean;
    /**
     * Desired output sample rate in Hz (8000-192000); omit to keep the engine's
     * native rate. Resamples the native output (24 kHz for Chatterbox and
     * CosyVoice3; 44.1 kHz for Supertonic, Parler, and Audio8), or the 48 kHz
     * LavaSR-enhanced signal, before emitting. `TTSOutputChunk.sampleRate`
     * reports the resulting rate.
     *
     * CosyVoice3 native chunk streaming emits at 24 kHz: a different rate is
     * only accepted there when the LavaSR enhancer is active, because the
     * enhancer's overlap-reprocess window resamples without chunk seams.
     *
     * MOSS emits its native 24 kHz only and rejects any other rate.
     */
    outputSampleRate?: number;
    backendsDir?: string;
    openclCacheDir?: string;
    vulkanCacheDir?: string;
}
/**
 * LavaSR enhancer config. The discriminated `type` leaves room for future
 * enhancer kinds; v1 ships `lavasr`. Enhancement is enabled by providing a
 * GGUF path here or via `files.lavasrEnhancer`.
 */
interface LavaSREnhancerOptions {
    type: "lavasr";
    /** Enhancer GGUF path (alternative to `files.lavasrEnhancer`). */
    enhancerPath?: string;
}
/**
 * LavaSR denoiser config. V1 ships the `lavasr` UL-UNAS denoiser. Denoising
 * is enabled by providing a GGUF path here or via `files.lavasrDenoiser`.
 * It runs before the enhancer and preserves the sample rate.
 */
interface LavaSRDenoiserOptions {
    type: "lavasr";
    /** Denoiser GGUF path (alternative to `files.lavasrDenoiser`). */
    denoiserPath?: string;
}
/**
 * Cross-engine conditioning. Accepted at construction and on `reload()` by
 * every engine that supports them, and per call by Parler and CosyVoice3. A
 * value outside the canonical vocabulary, outside the engine's supported
 * subset, or on a channel the engine cannot change per call, throws naming the
 * alternative -- nothing is silently degraded.
 */
interface TTSConditioningFields {
    /** Speaking style. Parler: all 12. CosyVoice3: anger|happy|neutral|sad. */
    emotion?: Emotion;
    /**
     * Speaking rate. Parler / CosyVoice3 / Supertonic. Supertonic conditions its
     * engine at construction, so its pace only moves there or via `reload()`.
     */
    pace?: Pace;
}
/**
 * Parler voice-description inputs. Either a free-text `description` (alias
 * `voiceDescription`) or the template fields, rendered natively through
 * tts-cpp's build_description(); mixing the two at the same level is rejected.
 * Accepted at construction, on `reload()`, and per call (Parler only).
 * `emotion` and `pace` moved to TTSConditioningFields -- Parler still renders
 * both, but they are no longer Parler-only at the JS surface.
 */
interface ParlerDescriptionFields {
    description?: string;
    voiceDescription?: string;
    /** Parler voice-template field; also Supertonic's baked voice id. */
    voice?: string;
    pitch?: string;
    expressivity?: string;
    noise?: string;
    reverb?: string;
    quality?: string;
}
/**
 * Voice cloning reference. Audio8's codec encoder turns `referenceAudio` into
 * codes and they are prepended to the prompt as the speaker's own history, so
 * no speaker encoder and no enrolment step are involved. `referenceText` is
 * required alongside it there: the model conditions on it as the turn the
 * recording answers, and a wrong one degrades the clone. Accepted at
 * construction, on `reload()`, and per call (Audio8 only).
 */
interface Audio8VoiceFields {
    /**
     * Chatterbox: voice-cloning reference audio path (wav). CosyVoice3:
     * zero-shot / cross-lingual cloning reference (0.5-30 s hard limits,
     * 5-15 s of clean speech recommended; multichannel input is downmixed to
     * mono) — the native front-end tokenizes it (speech_tokenizer_v3),
     * extracts the CAM++ speaker embedding and prompt mel at load, replacing
     * the baked voice; requires the `cosyvoiceS3tokModel` +
     * `cosyvoiceCampplusModel` files and fails the load (never silently falls
     * back) when they are missing or the audio is unusable. Pair with
     * `promptText` (the verbatim transcript) for zero-shot or omit it for
     * cross-lingual. The reference is fixed at construction: `reload()`
     * re-bakes the same recording (it is forwarded to the new addon instance)
     * but cannot switch to a different one, so changing voices means a new
     * instance. Audio8: the recording to clone, with `referenceText`
     * alongside it. MOSS: the recording to clone, sampled at 24 kHz and
     * fixed at construction; needs `files.mossCodecEncoder`.
     */
    referenceAudio?: string;
    /** Audio8: what `referenceAudio` says. Required when cloning. */
    referenceText?: string;
}
/**
 * CosyVoice3 per-call instruction. Same values as the constructor's
 * `instruct`; a per-call conditioning control replaces the configured one for
 * that synthesis, and one control takes effect per synthesis.
 */
interface CosyvoiceJobFields {
    instruct?: string | CosyvoiceInstruct;
}
interface TTSGgmlOptions extends ParlerDescriptionFields, Audio8VoiceFields, TTSConditioningFields {
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
     * RNG seed for Chatterbox CFM/SineGen, Supertonic latent generation, or
     * Pocket's portable sampling RNG. Pocket accepts integers from 0 to
     * 4294967295 (inclusive).
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
    /** Directory the addon scans for dynamically loaded ggml backends. */
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
interface InferenceState {
    configLoaded: boolean;
    weightsLoaded: boolean;
    destroyed: boolean;
}
interface TTSOutputChunk {
    chunkIndex?: number;
    isLast?: boolean;
    /** Signed 16-bit mono PCM audio payload. */
    outputArray: Int16Array;
    /**
     * Output sample rate. The native engine rate (24000 for Chatterbox,
     * CosyVoice3 and MOSS; 44100 for Supertonic, Parler, and Audio8), or 48000
     * when the LavaSR enhancer is active.
     */
    sampleRate?: number;
}
interface RuntimeStats {
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
interface VoiceControlsCatalog {
    emotions: string[];
    paces: string[];
    engines: Record<string, {
        emotions: string[];
        paces: string[];
    }>;
}
interface SentenceStreamChunkMeta {
    chunkIndex?: number;
    sentenceChunk?: string;
    /**
     * True on the final pre-chunked synthesis output. Undefined for async
     * iterator streaming where the final chunk is not known up front.
     */
    isLast?: boolean;
}
interface SentenceStreamOptions extends ParlerDescriptionFields, Audio8VoiceFields, TTSConditioningFields, CosyvoiceJobFields {
    /** BCP-47 locale for `Intl.Segmenter` when available. */
    locale?: string;
    /** Maximum graphemes per chunk; defaults to 300, or 120 for Korean. */
    maxChunkScalars?: number;
}
interface RunStreamingOptions extends ParlerDescriptionFields, Audio8VoiceFields, TTSConditioningFields, CosyvoiceJobFields {
    accumulateSentences?: boolean;
    sentenceDelimiter?: RegExp;
    sentenceDelimiterPreset?: SentenceDelimiterPreset;
    maxBufferScalars?: number;
    flushAfterMs?: number;
}
/** Input accepted by `runStreaming`. */
type TextStreamInput = string | string[] | Iterable<string> | AsyncIterable<string>;
interface TTSRunInput extends ParlerDescriptionFields, Audio8VoiceFields, TTSConditioningFields, CosyvoiceJobFields {
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
    static readonly ENGINE_POCKET = "pocket";
    opts: object;
    exclusiveRun: boolean;
    logger: object;
    state: InferenceState;
    addon: unknown;
    private readonly _job;
    private readonly _runExclusive;
    private _ttsInferenceQueueWaiter;
    private _sentenceStreamCtx;
    private _config;
    private _pocketJobPending;
    private _pocketCancelPromise;
    private _pocketLifecycleInProgress;
    private _pocketParams;
    private _pocketOptions;
    private _pocketFiles;
    private _lazySessionLoading;
    private _outputSampleRate;
    private _engineType;
    private _voicesDir?;
    private _supertonicModelPath?;
    private _t3ModelPath?;
    private _s3genModelPath?;
    private _cosyvoiceModelDir?;
    private _cosyvoiceLlmModelPath?;
    private _cosyvoiceFlowModelPath?;
    private _cosyvoiceHiftModelPath?;
    private _cosyvoiceS3tokModelPath?;
    private _cosyvoiceCampplusModelPath?;
    private _mecabDictPath?;
    private _cangjieTsvPath?;
    private _referenceAudio?;
    private _voiceDir?;
    private _seed?;
    private _nGpuLayers?;
    private _nCtx?;
    private _kvCacheType?;
    private _threads?;
    private _streamChunkTokens?;
    private _streamFirstChunkTokens?;
    private _streamLeftContextTokens?;
    private _cfmSteps?;
    private _cfgRate?;
    private _batchCfmSteps?;
    private _nPredict?;
    private _maxSentenceChars?;
    private _crossfadeMs?;
    private _repeatPenalty?;
    private _exaggeration?;
    private _cfgWeight?;
    private _minP?;
    private _streamChunkTolerancePct?;
    private _streamMinChunkTokens?;
    private _voiceJsonPath?;
    private _prewarmText?;
    private _vulkanDevice?;
    private _flowCutPrompt?;
    private _cosyvoiceVocabPath?;
    private _cosyvoiceMergesPath?;
    private _cosyvoiceVoiceModelPath?;
    private _promptText?;
    private _instruct?;
    private _voice?;
    private _steps?;
    private _speed?;
    private _noiseNpyPath?;
    private _enhancerGgufPath?;
    private _denoiserGgufPath?;
    private _backendsDir?;
    private _openclCacheDir?;
    private _vulkanCacheDir?;
    private _parlerModelPath?;
    private _audio8LmPath?;
    private _audio8CodecDecoderPath?;
    private _audio8CodecEncoderPath?;
    private _mossBackbonePath?;
    private _mossCodecDecoderPath?;
    private _mossCodecEncoderPath?;
    private _dialogueReferences?;
    private _durationTokens?;
    private _referenceText?;
    private _greedy?;
    private _description?;
    private _emotion?;
    private _pitch?;
    private _pace?;
    private _expressivity?;
    private _noise?;
    private _reverb?;
    private _quality?;
    private _temperature?;
    private _topK?;
    private _topP?;
    private _maxFrames?;
    private _minNewTokens?;
    private _normalizeNumbers?;
    constructor(options?: TTSGgmlOptions);
    private _resolveEngineAndModelPaths;
    private _resolveAudio8ModelPaths;
    private _mossBackbonePatterns;
    private _findMossBackbone;
    private _resolveMossModelPaths;
    private _assignMossVoiceOptions;
    private _assignSynthesisOptions;
    private _assertEngineStreamingSupport;
    private _requestsChunkStreaming;
    private _assertParlerOptionConsistency;
    private _assertSamplerOptionSupport;
    /**
     * Options only some engines read. Set on any other engine they would be
     * dropped without effect, so they are rejected by name instead.
     */
    private _assertEngineScopedOptions;
    private _assertAudio8OptionConsistency;
    private _assertMossOptionConsistency;
    private _assertNoMossOnlyOptions;
    private _assertMossDialogueReferences;
    private _assertSentenceStreamingAllowed;
    private _assertMossOutputRate;
    private _assertMossVoiceConsistent;
    /**
     * A recording without its transcript is accepted by the model but degrades
     * the clone silently, and a transcript alone has nothing to attach to, so
     * both halves have to arrive together.
     */
    private _assertAudio8VoiceConsistent;
    /**
     * `promptText` is deliberately not required: its absence selects
     * cross-lingual mode. With a model dir present but no cloning GGUFs in it,
     * the native load fail-closes instead.
     */
    private _assertCosyvoiceCloneConsistent;
    private _assertCosyvoiceOptionConsistency;
    /**
     * Validate the cross-engine emotion/pace surface against this engine, and
     * enforce CosyVoice3's one-instruction-per-synthesis rule.
     */
    private _assertConditioningConsistency;
    /**
     * The per-call surface of a non-Parler engine: only the cross-engine
     * emotion/pace it declares support for, never Parler's template fields.
     */
    private _resolveConditioningJobFields;
    /**
     * CosyVoice3's per-call instruction, rendered like the constructor's. The
     * native layer reads it next to emotion/pace, and any of the three replaces
     * the configured conditioning for that synthesis.
     */
    private _resolveJobInstruct;
    /**
     * Parler's per-call surface: description/template fields, where a per-call
     * template cannot be merged with a constructor-level free-text description.
     */
    private _resolveParlerJobFields;
    /**
     * The voice a per-call override actually synthesizes with. Mirrors
     * Audio8Model::resolveVoice: a per-call recording replaces both halves, so
     * it cannot inherit the configured transcript, which describes a different
     * recording; a per-call transcript alone corrects the configured one.
     */
    private _mergeAudio8Voice;
    /**
     * Extract + validate the per-call Audio8 voice fields from a run input or
     * streaming options. Returns undefined when none are present.
     */
    private _resolveAudio8JobFields;
    /**
     * The per-call fields of whichever engine is loaded, if any are set. Parler
     * takes the full description/template surface, Audio8 its voice override,
     * and every engine the cross-engine conditioning it supports.
     */
    private _resolveJobFields;
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
    private _enqueueExclusiveTtsResponse;
    private _resolveRunStreamingOptions;
    private _normalizeTextStream;
    private _runTextStreamOrchestrator;
    private _sentenceStreamTextIterableDrive;
    /**
     * Audio8 and MOSS report `tokensPerSecond` as codec frames per second, so
     * the streaming aggregate has to count frames too rather than characters.
     */
    private _pacesOnFrames;
    private _runStreamOrchestrator;
    private _sentenceStreamDriveBody;
    private _load;
    private _buildTtsParams;
    private _buildCosyvoiceParams;
    private _buildChatterboxParams;
    private _buildSupertonicParams;
    private _buildParlerParams;
    private _buildAudio8Params;
    private _buildMossParams;
    /** The knobs every engine in SAMPLING_ENGINES reads. */
    private _assignSamplingParams;
    /**
     * Backend and output plumbing for the engines that take no `language`,
     * where `_assignCommonNativeParams` would be the wrong shape.
     */
    private _assignBackendParams;
    private _assignCommonNativeParams;
    /** LavaSR post-processing paths, shared by every engine that supports them. */
    private _assignLavasrParams;
    private _createAddon;
    unload(): Promise<void>;
    private _unloadModel;
    destroy(): Promise<void>;
    private _runInternal;
    private _mergeSentenceStreamStats;
    private _rejectActiveChunk;
    private _endJobWithStats;
    private _addonOutputCallback;
    private _handleAddonError;
    private _handleAddonOutput;
    private _enrichStreamChunk;
    private _handleAddonStats;
    private _waitPocketCancel;
    private _withPocketLifecycle;
    private _checkPocketReload;
    private _checkPocketRequest;
    private _dispatchJob;
    cancel(): Promise<void>;
    private _failAndClearActiveResponse;
    /** Everything reload() may overwrite, so a rejected reload can undo itself. */
    private _captureReloadableState;
    private _restoreReloadableState;
    private _applyReloadableRuntimeConfig;
    private _assertMossReloadKeepsVoice;
    private _applyMossReload;
    private _applyReloadableConditioning;
    private _applyReloadableParlerConfig;
    /**
     * Apply the new configuration and build the native parameters from it. A
     * rejected value leaves the instance exactly as it was, so a later partial
     * reload is not validated against state the caller never accepted.
     */
    private _applyReloadableConfig;
    private _reloadPocket;
    reload(newConfig?: Record<string, unknown>): Promise<void>;
    /**
     * The voice a reload lands on. Same rule as _mergeAudio8Voice and
     * Audio8Model::resolveVoice: a new recording replaces both halves, because
     * the configured transcript describes the recording being replaced. Reload
     * reads `undefined` as "not supplied", so an explicit empty string reaches
     * the guard instead of being ignored.
     */
    private _mergeAudio8ReloadVoice;
    /**
     * The knobs a reload lands on, merged the same way as the voice so the
     * whole set can be checked before any of it is written.
     */
    private _mergeAudio8ReloadSampling;
    private _applyAudio8Sampling;
    /**
     * Audio8 voice + sampling knobs are reloadable; they rebuild the engine's
     * sampler and speaker history. Both merges are checked before either is
     * written, so a rejected reload leaves the instance exactly as it was
     * rather than half-moved onto the configuration that was refused.
     */
    private _applyAudio8Reload;
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
type NamespaceFiles = TTSGgmlFiles;
type NamespaceRuntimeConfig = TTSGgmlRuntimeConfig;
type NamespaceOptions = TTSGgmlOptions;
type NamespaceEnhancerOptions = LavaSREnhancerOptions;
type NamespaceDenoiserOptions = LavaSRDenoiserOptions;
type NamespaceRuntimeStats = RuntimeStats;
type NamespaceOutputChunk = TTSOutputChunk;
type NamespaceSentenceStreamChunkMeta = SentenceStreamChunkMeta;
type NamespaceSentenceStreamOptions = SentenceStreamOptions;
type NamespaceRunStreamingOptions = RunStreamingOptions;
type NamespaceTextStreamInput = TextStreamInput;
type NamespaceRunInput = TTSRunInput;
type NamespaceInferenceState = InferenceState;
type NamespaceCosyvoiceInstruct = CosyvoiceInstruct;
type NamespaceVoiceControlsCatalog = VoiceControlsCatalog;
type NamespaceFitEngine = TtsFitEngine;
type NamespaceFitRequest = TtsFitRequest;
type NamespaceFitResult = TtsFitResult;
type NamespaceFitStatus = TtsFitStatus;
type NamespaceSupertonicFit = SupertonicFitRequest;
type NamespaceParlerFit = ParlerFitRequest;
type NamespaceChatterboxFit = ChatterboxFitRequest;
type NamespaceAudio8Fit = Audio8FitRequest;
type NamespaceMossFit = MossFitRequest;
type NamespaceCosyvoiceFit = CosyvoiceFitRequest;
declare namespace TTSGgml {
    export import QvacErrorAddonTTSGgml = errorModule.QvacErrorAddonTTSGgml;
    export import ERR_CODES = errorModule.ERR_CODES;
    type TTSGgmlFiles = NamespaceFiles;
    type TTSGgmlRuntimeConfig = NamespaceRuntimeConfig;
    type TTSGgmlOptions = NamespaceOptions;
    type LavaSREnhancerOptions = NamespaceEnhancerOptions;
    type LavaSRDenoiserOptions = NamespaceDenoiserOptions;
    type RuntimeStats = NamespaceRuntimeStats;
    type TTSOutputChunk = NamespaceOutputChunk;
    type SentenceStreamChunkMeta = NamespaceSentenceStreamChunkMeta;
    type SentenceStreamOptions = NamespaceSentenceStreamOptions;
    type RunStreamingOptions = NamespaceRunStreamingOptions;
    type TextStreamInput = NamespaceTextStreamInput;
    type TTSRunInput = NamespaceRunInput;
    type InferenceState = NamespaceInferenceState;
    type CosyvoiceInstruct = NamespaceCosyvoiceInstruct;
    type VoiceControlsCatalog = NamespaceVoiceControlsCatalog;
    type TtsFitEngine = NamespaceFitEngine;
    type TtsFitRequest = NamespaceFitRequest;
    type TtsFitResult = NamespaceFitResult;
    type TtsFitStatus = NamespaceFitStatus;
    type SupertonicFitRequest = NamespaceSupertonicFit;
    type ParlerFitRequest = NamespaceParlerFit;
    type ChatterboxFitRequest = NamespaceChatterboxFit;
    type Audio8FitRequest = NamespaceAudio8Fit;
    type MossFitRequest = NamespaceMossFit;
    type CosyvoiceFitRequest = NamespaceCosyvoiceFit;
    const resolveBackendsDir: typeof resolveBackendsDirImpl;
    const assessFit: typeof assessFitImpl;
}
export = TTSGgml;
