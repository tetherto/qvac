import { z } from 'zod'
import { modelSrcInputSchema, type ModelSrcInput } from './model-src-utils'

// Chatterbox multilingual supported languages (23). The engines support
// different language sets, so the language enum is validated per engine.
export const TTS_CHATTERBOX_LANGUAGES = [
  'en', // English
  'es', // Spanish
  'fr', // French
  'de', // German
  'it', // Italian
  'ja', // Japanese
  'pt', // Portuguese
  'nl', // Dutch
  'pl', // Polish
  'tr', // Turkish
  'sv', // Swedish
  'da', // Danish
  'fi', // Finnish
  'no', // Norwegian
  'el', // Greek
  'ms', // Malay
  'sw', // Swahili
  'ar', // Arabic
  'ko', // Korean
  'he', // Hebrew
  'ru', // Russian
  'zh', // Chinese
  'hi' // Hindi
] as const

// Supertonic supported languages (31, as of Supertonic 3). Earlier Supertonic
// releases (1/2) only cover a subset, but validation is per-engine, not
// per-model, so the enum reflects the engine's current full capability.
export const TTS_SUPERTONIC_LANGUAGES = [
  'en', // English
  'ko', // Korean
  'ja', // Japanese
  'ar', // Arabic
  'bg', // Bulgarian
  'cs', // Czech
  'da', // Danish
  'de', // German
  'el', // Greek
  'es', // Spanish
  'et', // Estonian
  'fi', // Finnish
  'fr', // French
  'hi', // Hindi
  'hr', // Croatian
  'hu', // Hungarian
  'id', // Indonesian
  'it', // Italian
  'lt', // Lithuanian
  'lv', // Latvian
  'nl', // Dutch
  'pl', // Polish
  'pt', // Portuguese
  'ro', // Romanian
  'ru', // Russian
  'sk', // Slovak
  'sl', // Slovenian
  'sv', // Swedish
  'tr', // Turkish
  'uk', // Ukrainian
  'vi' // Vietnamese
] as const

// The engines @qvac/tts-ggml exposes as `TTSGgml.ENGINE_*`, in the order the
// addon lists them. Exported so callers can discriminate a TTS config without
// re-declaring the union (the CLI used to).
export const TTS_ENGINES = [
  'chatterbox',
  'supertonic',
  'parler',
  'cosyvoice3',
  'audio8',
  'moss',
  'moss-sfx',
  'moss-speech'
] as const

// Mirror of the addon's `SentenceDelimiterPreset` (./text-stream-accumulator).
export const TTS_SENTENCE_DELIMITER_PRESETS = ['latin', 'cjk', 'multilingual'] as const

export const TTS_PARLER_EMOTIONS = [
  'command',
  'anger',
  'narration',
  'conversation',
  'disgust',
  'fear',
  'happy',
  'neutral',
  'proper noun',
  'news',
  'sad',
  'surprise'
] as const

// Canonical cross-engine pace vocabulary (@qvac/tts-ggml `PACES`, unified in
// QVAC-23154). `moderate` is the neutral pace: on CosyVoice3 it disengages the
// pace conditioning channel entirely (plain zero-shot synthesis).
export const TTS_PACES = ['slow', 'moderate', 'fast'] as const

// CosyVoice3 supports a subset of the cross-engine emotion vocabulary and the
// full canonical pace vocabulary.
export const TTS_COSYVOICE3_EMOTIONS = ['anger', 'happy', 'neutral', 'sad'] as const

// CosyVoice3 structured-instruct control vocabulary (@qvac/tts-ggml
// `CosyvoiceInstruct`). Exactly one control renders per synthesis, resolved by
// precedence dialect > volume > style.
export const TTS_COSYVOICE3_INSTRUCT_DIALECTS = [
  'cantonese',
  'northeastern',
  'gansu',
  'guizhou',
  'henan',
  'hubei',
  'hunan',
  'jiangxi',
  'minnan',
  'ningxia',
  'shanxi',
  'shaanxi',
  'shandong',
  'shanghai',
  'sichuan',
  'tianjin',
  'yunnan'
] as const

export const TTS_COSYVOICE3_INSTRUCT_VOLUMES = ['loud', 'soft'] as const

export const TTS_COSYVOICE3_INSTRUCT_STYLES = ['peppa', 'robot'] as const

// Parler's Core ML compute policy (@qvac/tts-ggml `PARLER_COREML_COMPUTE_UNITS`).
export const TTS_PARLER_COREML_COMPUTE_UNITS = [
  'all',
  'cpu_and_ane',
  'cpu_and_gpu',
  'cpu_only'
] as const

// The LavaSR stages' Core ML compute policy (@qvac/tts-ggml
// `LavaSRCoreMLComputeUnits`); a different spelling from Parler's because each
// mirrors its own native enum.
export const TTS_LAVASR_COREML_COMPUTE_UNITS = [
  'CPU_ONLY',
  'CPU_AND_GPU',
  'CPU_AND_NE',
  'ALL'
] as const

// Supertonic weight precision (@qvac/tts-ggml `precision`).
export const TTS_SUPERTONIC_PRECISIONS = ['auto', 'f32', 'f16', 'q8_0'] as const

// Supertonic languages not already present in the Chatterbox set, used to keep
// TTS_LANGUAGES a true union across engines without duplicates.
const TTS_SUPERTONIC_ONLY_LANGUAGES = [
  'bg', // Bulgarian
  'cs', // Czech
  'et', // Estonian
  'hr', // Croatian
  'hu', // Hungarian
  'id', // Indonesian
  'lt', // Lithuanian
  'lv', // Latvian
  'ro', // Romanian
  'sk', // Slovak
  'sl', // Slovenian
  'uk', // Ukrainian
  'vi' // Vietnamese
] as const

// Union of all TTS-supported languages across engines. Kept for backwards
// compatibility; prefer the engine-specific lists when validating a config.
export const TTS_LANGUAGES = [
  ...TTS_CHATTERBOX_LANGUAGES,
  ...TTS_SUPERTONIC_ONLY_LANGUAGES
] as const

const ttsChatterboxLanguageSchema = z.enum(TTS_CHATTERBOX_LANGUAGES)
const ttsSupertonicLanguageSchema = z.enum(TTS_SUPERTONIC_LANGUAGES)
const ttsParlerEmotionSchema = z.enum(TTS_PARLER_EMOTIONS)
const ttsCosyvoice3EmotionSchema = z.enum(TTS_COSYVOICE3_EMOTIONS)
const ttsPaceSchema = z.enum(TTS_PACES)
// Every integer knob is int32: the addon narrows them with `| 0` before the
// native call, so a wider value would wrap silently instead of failing.
const ttsIntegerSchema = z.number().int()
const ttsInt32Schema = ttsIntegerSchema.min(-2147483648).max(2147483647)
const ttsNonNegativeInt32Schema = ttsInt32Schema.nonnegative()
const ttsPositiveInt32Schema = ttsInt32Schema.positive()
// A CosyVoice3 speech token travels both ways: the response hands them out as
// `speechTokenIds`, the load config takes them back as `forceSpeechTokens`.
// One titled scalar keeps the two interchangeable in every generated client
// (one shared Python class instead of a differently named wrapper per field).
const ttsSpeechTokenIdSchema = ttsInt32Schema.meta({ title: 'TtsSpeechTokenId' })

// Describe text shared by fields repeated across engine arms.
const TTS_USE_GPU_DESC =
  'Route inference through a GPU backend (Metal / CUDA / Vulkan / OpenCL) when available. Default false.'
const TTS_SEED_DESC =
  'RNG seed for the engine’s stochastic stages (e.g. Chatterbox CFM/SineGen, Supertonic latent generation).'
const TTS_THREADS_DESC = 'CPU thread count; overrides the hardware default.'
const TTS_NGPU_LAYERS_DESC =
  'Model layers to offload to the GPU backend (99 = all, 0 = CPU). Takes effect on its own and wins over `useGPU`; when both are set they must agree.'
const TTS_STREAM_CHUNK_TOKENS_DESC =
  'Speech tokens per native streaming chunk; 0 disables native chunk streaming.'
const TTS_STREAM_FIRST_CHUNK_TOKENS_DESC =
  'Smaller first streaming chunk for lower first-audio latency.'
const TTS_VULKAN_DEVICE_DESC =
  'Vulkan adapter index, also used by the LavaSR enhancer: 0 = the first adapter, N = the Nth, -1 = auto-pick by free VRAM preferring a discrete adapter. Only consulted on Vulkan.'
const TTS_TEMPERATURE_DESC =
  'Sampling temperature; unset defers to the engine default (Parler 1.0, Audio8 0.7).'
const TTS_TOP_K_DESC = 'Top-k sampling cutoff; unset defers to the engine default (50).'
const TTS_TOP_P_DESC =
  'Top-p (nucleus) sampling cutoff (0 < p ≤ 1); unset defers to the engine default.'
const TTS_MAX_FRAMES_DESC =
  'Generation-length cap in decoder frames; 0 = engine default (Parler ≈86 frames/s, Audio8 ≈21.5).'
// Same wording as the transcription and llama.cpp configs — these are the
// generic ggml backend-loading knobs, not TTS-specific ones.
const TTS_BACKENDS_DIR_DESC =
  'Directory scanned as given for dynamically-loaded ggml backend `.so` files. Unset scans the directory the native module was loaded from.'
const TTS_OPENCL_CACHE_DIR_DESC =
  "Persistent directory for ggml-opencl's compiled-program cache (Android only)."
const TTS_BACKEND_DESC =
  'Explicit native backend: `auto`, `cpu`, `opencl`, `webgpu`, or an exact registered device name such as `MTL0`, `CUDA0` or `Vulkan0` (device names depend on the host). An unavailable explicit backend fails the load; unset keeps the `useGPU` policy. WebGPU is available to Supertonic 3, Parler, CosyVoice3 and Audio8 only.'

// The ggml backend knobs every engine honours. `openclCacheDir` is added only
// on the three engines whose native config reads it (Parler and Audio8 build
// their params through the addon's _assignBackendParams, which does not).
const ttsBackendDirFieldsShape = {
  backend: z.string().trim().min(1).optional().describe(TTS_BACKEND_DESC),
  backendsDir: z.string().min(1).optional().describe(TTS_BACKENDS_DIR_DESC)
}

// Mirrors the addon's validateBackendOption: a WebGPU selector is accepted only
// on the engines whose native library has established WebGPU support
// (Supertonic 3, Parler, CosyVoice3, Audio8); the others reject it before any
// weight is loaded, and so does this schema, naming the field.
function refineNoWebgpuBackend(
  config: { ttsEngine: string; backend?: string | undefined },
  ctx: z.RefinementCtx
) {
  if (config.backend === undefined || !/^webgpu/i.test(config.backend)) return
  ctx.addIssue({
    code: 'custom',
    path: ['backend'],
    message: `WebGPU has no established support for ${config.ttsEngine}; it is available to Supertonic 3, Parler, CosyVoice3 and Audio8 only.`
  })
}

const ttsOpenclCacheFieldShape = {
  openclCacheDir: z.string().min(1).optional().describe(TTS_OPENCL_CACHE_DIR_DESC)
}

// Mirrors the addon's assertGpuIntentConsistent: when both are stated they
// must agree, because `nGpuLayers` wins at the native layer and would silently
// contradict an explicit `useGPU`. Rejecting it here names both fields instead
// of surfacing a raw addon throw at load.
function refineGpuIntent(
  config: { useGPU?: boolean | undefined; nGpuLayers?: number | undefined },
  ctx: z.RefinementCtx
) {
  if (typeof config.useGPU !== 'boolean' || config.nGpuLayers === undefined) return
  if (config.useGPU === (config.nGpuLayers !== 0)) return
  ctx.addIssue({
    code: 'custom',
    path: ['nGpuLayers'],
    message:
      `useGPU=${config.useGPU} conflicts with nGpuLayers=${config.nGpuLayers}. ` +
      'Drop one, or make them agree (useGPU true with a non-zero nGpuLayers, ' +
      'or useGPU false with nGpuLayers 0).'
  })
}

// Desired output sample rate in Hz. Matches the @qvac/tts-ggml addon's
// accepted range; omit to keep the engine's native rate (or 48 kHz when the
// LavaSR enhancer is active). Every engine but MOSS (24 kHz only) resamples,
// so this is exposed on the other five configs; the engines whose native chunk
// streaming cannot resample seam-free (Parler, CosyVoice3) constrain it in
// their own refinements.
const ttsOutputSampleRateSchema = ttsIntegerSchema
  .min(8000)
  .max(192000)
  .describe(
    'Desired output sample rate in Hz (8000–192000); omit to keep the engine’s native rate (or 48 kHz when the LavaSR enhancer is active).'
  )

const ttsParlerDescriptionFieldsShape = {
  description: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Parler free-text voice description (alias `voiceDescription`). Mutually exclusive with the voice-template fields.'
    ),
  voiceDescription: z
    .string()
    .min(1)
    .optional()
    .describe('Alias of `description`; mutually exclusive with the voice-template fields.'),
  voice: z
    .string()
    .min(1)
    .optional()
    .describe('Parler voice-template speaker name; also Supertonic’s baked voice id.'),
  emotion: ttsParlerEmotionSchema
    .optional()
    .describe('Speaking style (Parler voice-template field).'),
  pitch: z.string().min(1).optional().describe('Parler voice-template pitch descriptor.'),
  // Canonical cross-engine vocabulary since @qvac/tts-ggml 0.7 (QVAC-23154);
  // free-form pace strings are rejected natively.
  pace: ttsPaceSchema.optional().describe("Speaking rate: `'slow'`, `'moderate'`, or `'fast'`."),
  expressivity: z
    .string()
    .min(1)
    .optional()
    .describe('Parler voice-template expressivity descriptor.'),
  noise: z
    .string()
    .min(1)
    .optional()
    .describe('Parler voice-template background-noise descriptor.'),
  reverb: z.string().min(1).optional().describe('Parler voice-template reverb descriptor.'),
  quality: z.string().min(1).optional().describe('Parler voice-template audio-quality descriptor.')
}

const ttsParlerTemplateFieldNames = [
  'voice',
  'emotion',
  'pitch',
  'pace',
  'expressivity',
  'noise',
  'reverb',
  'quality'
] as const

type TtsParlerDescriptionRefinementInput = {
  description?: string | undefined
  voiceDescription?: string | undefined
  voice?: string | undefined
  emotion?: string | undefined
  pitch?: string | undefined
  pace?: string | undefined
  expressivity?: string | undefined
  noise?: string | undefined
  reverb?: string | undefined
  quality?: string | undefined
}

function refineParlerDescriptionFields(
  config: TtsParlerDescriptionRefinementInput,
  ctx: z.RefinementCtx
) {
  if (config.description !== undefined && config.voiceDescription !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['voiceDescription'],
      message: 'description and voiceDescription are mutually exclusive.'
    })
  }

  if (config.description === undefined && config.voiceDescription === undefined) return

  const conflictingField = ttsParlerTemplateFieldNames.find((field) => config[field] !== undefined)
  if (conflictingField) {
    ctx.addIssue({
      code: 'custom',
      path: [conflictingField],
      message:
        'description and voiceDescription are mutually exclusive with Parler voice-template fields.'
    })
  }
}

type TtsParlerRuntimeRefinementInput = TtsParlerDescriptionRefinementInput & {
  outputSampleRate?: number | undefined
  streamChunkTokens?: number | undefined
  useGPU?: boolean | undefined
  nGpuLayers?: number | undefined
}

// Parler's native chunk streaming cannot resample across chunk seams, so the
// rate is pinned to 44.1 kHz — unless the LavaSR enhancer is loaded, whose
// overlap-reprocess window resamples seam-free (ParlerModel.cpp waives the
// check on enhancerGgufPath). The load schema applies the waiver; the runtime
// schema has no enhancer field and always pins.
function refineParlerNativeStreamingRate(
  config: TtsParlerRuntimeRefinementInput,
  ctx: z.RefinementCtx
) {
  const nativeStreamingEnabled = (config.streamChunkTokens ?? 0) > 0
  if (
    nativeStreamingEnabled &&
    config.outputSampleRate !== undefined &&
    config.outputSampleRate !== 44100
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['outputSampleRate'],
      message:
        'Parler native streaming emits at 44100 Hz; omit outputSampleRate, use 44100, ' +
        'enable the LavaSR enhancer (which resamples seam-free), or disable native streaming.'
    })
  }
}

function refineParlerRuntimeConfig(config: TtsParlerRuntimeRefinementInput, ctx: z.RefinementCtx) {
  refineParlerDescriptionFields(config, ctx)
  refineGpuIntent(config, ctx)
  refineParlerNativeStreamingRate(config, ctx)
}

export const ttsChatterboxRuntimeConfigSchema = z
  .object({
    ttsEngine: z
      .literal('chatterbox')
      .describe('TTS engine: Chatterbox (multilingual, voice cloning).'),
    language: ttsChatterboxLanguageSchema.describe('Language code. Default `en`.'),
    voice: z
      .string()
      .optional()
      .describe('Ignored by Chatterbox; use `referenceAudioSrc` for voice cloning.'),
    useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
    outputSampleRate: ttsOutputSampleRateSchema.optional(),
    // Chatterbox has no pace channel — it time-stretches the rendered waveform
    // instead — so the multiplier is the only speech-rate control it offers,
    // and the native WSOLA stretcher rejects anything outside [0.25, 4.0].
    ttsSpeed: z
      .number()
      .min(0.25)
      .max(4)
      .optional()
      .describe(
        'Speech-rate multiplier (1.0 = unchanged, <1 slower, >1 faster), applied as a pitch-preserving WSOLA time-stretch. Range 0.25–4.0.'
      ),
    nCtx: ttsNonNegativeInt32Schema
      .optional()
      .describe(
        'Cap on the T3 context length in tokens (prompt + generated speech, ~25 tokens ≈ 1 s of audio). The KV cache is allocated up front at this length, so it directly bounds memory; 0 uses the GGUF’s full context.'
      ),
    kvCacheType: z
      .enum(['f32', 'f16', 'q8_0'])
      .optional()
      .describe(
        'T3 KV-cache storage dtype. `f16` is the safe cross-backend default; `q8_0` is smaller and faster where the backend implements its ops.'
      ),
    // Chatterbox-only native streaming controls.
    streamChunkTokens: ttsNonNegativeInt32Schema.optional().describe(TTS_STREAM_CHUNK_TOKENS_DESC),
    streamFirstChunkTokens: ttsNonNegativeInt32Schema
      .optional()
      .describe(TTS_STREAM_FIRST_CHUNK_TOKENS_DESC),
    cfmSteps: ttsNonNegativeInt32Schema
      .optional()
      .describe('Chatterbox CFM Euler step count. Default 2.'),
    cfgRate: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Chatterbox S3Gen classifier-free-guidance rate; `0` skips the unconditioned pass, a positive value overrides the model’s baked rate. Omit to keep the baked rate.'
      ),
    streamLeftContextTokens: ttsNonNegativeInt32Schema
      .optional()
      .describe(
        'Already-emitted speech tokens S3Gen keeps as left context per native streaming chunk (typically 25–50), bounding the per-chunk cost on long utterances; 0 = the whole emitted prefix.'
      ),
    batchCfmSteps: ttsNonNegativeInt32Schema
      .optional()
      .describe(
        'CFM Euler step count for batch synthesis; 0 = the library default (2-step meanflow on Turbo, the model’s full schedule on multilingual). The multilingual engine does not floor it, so values well below its schedule under-integrate. `cfmSteps` keeps driving native streaming.'
      ),
    nPredict: ttsPositiveInt32Schema
      .optional()
      .describe(
        'Cap on speech tokens T3 decodes per synthesis (~25 tokens ≈ 1 s); engine default 1000 (~40 s). Longer single calls also need `nCtx` to cover prompt plus generated tokens, or use `maxSentenceChars`.'
      ),
    maxSentenceChars: ttsNonNegativeInt32Schema
      .optional()
      .describe(
        'Sentence auto-split: T3 + S3Gen run per segment of at most this many bytes (the reference CLI uses 180); 0 = off. `nPredict` then applies per segment.'
      ),
    crossfadeMs: ttsNonNegativeInt32Schema
      .optional()
      .describe(
        'Raised-cosine crossfade between auto-split batch segments, in milliseconds (engine default 30). Native streaming stays gapless.'
      ),
    // T3 samples its speech tokens; the defaults are the addon's, not Parler's
    // or Audio8's, so these do not share TTS_TEMPERATURE_DESC and friends.
    temperature: z
      .number()
      .nonnegative()
      .optional()
      .describe('T3 sampling temperature (engine default 0.8); 0 decodes greedily.'),
    topK: ttsNonNegativeInt32Schema
      .optional()
      .describe('T3 top-k sampling cutoff (engine default 1000); 0 disables the cutoff.'),
    topP: z
      .number()
      .positive()
      .max(1)
      .optional()
      .describe('T3 top-p (nucleus) sampling cutoff, 0 < p ≤ 1 (engine default 0.95).'),
    repeatPenalty: z
      .number()
      .positive()
      .optional()
      .describe('T3 repetition penalty (engine default 1.2); 1 = off.'),
    exaggeration: z
      .number()
      .optional()
      .describe(
        'Multilingual only: prosody intensity, above 0 more expressive, below 0 flatter (engine default 0.5). The Turbo variant ignores it.'
      ),
    cfgWeight: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Multilingual only: T3 classifier-free-guidance scale (engine default 0.5); 0 disables it. Separate from `cfgRate`, which steers S3Gen.'
      ),
    minP: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Multilingual only: min-p sampling threshold (engine default 0); 0 = off.'),
    voiceDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Directory of pre-baked voice-conditioning tensors (the upstream CLI’s `--save-voice` output), loaded instead of preprocessing a reference recording. With `referenceAudioSrc` too, tensors missing from the directory are backfilled from the recording.'
      ),
    // Int32 like the other engines: the addon narrows with `| 0`, so a wider
    // value would wrap silently rather than fail.
    threads: ttsPositiveInt32Schema.optional().describe(TTS_THREADS_DESC),
    nGpuLayers: ttsInt32Schema.optional().describe(TTS_NGPU_LAYERS_DESC),
    seed: ttsInt32Schema.optional().describe(TTS_SEED_DESC),
    ...ttsBackendDirFieldsShape,
    ...ttsOpenclCacheFieldShape
  })
  .superRefine(refineChatterboxRuntimeConfig)

function refineChatterboxRuntimeConfig(
  config: {
    ttsEngine: 'chatterbox'
    backend?: string | undefined
    useGPU?: boolean | undefined
    nGpuLayers?: number | undefined
  },
  ctx: z.RefinementCtx
) {
  refineGpuIntent(config, ctx)
  refineNoWebgpuBackend(config, ctx)
}

// Supertonic's in-memory voice tensors come as a pair: the addon rejects one
// without the other, so the schema does too, naming the missing half.
function refineSupertonicVoiceStyle(
  config: {
    voiceStyleTtl?: number[] | undefined
    voiceStyleDp?: number[] | undefined
  },
  ctx: z.RefinementCtx
) {
  if ((config.voiceStyleTtl === undefined) === (config.voiceStyleDp === undefined)) return
  ctx.addIssue({
    code: 'custom',
    path: [config.voiceStyleTtl === undefined ? 'voiceStyleTtl' : 'voiceStyleDp'],
    message: 'voiceStyleTtl and voiceStyleDp must be supplied together.'
  })
}

// Supertonic drives its duration predictor from either an exact multiplier
// (`ttsSpeed`) or the canonical pace vocabulary, never both — the engine
// rejects the pair rather than picking a winner.
function refineSupertonicRateControls(
  config: {
    ttsSpeed?: number | undefined
    pace?: string | undefined
    useGPU?: boolean | undefined
    nGpuLayers?: number | undefined
    voiceStyleTtl?: number[] | undefined
    voiceStyleDp?: number[] | undefined
  },
  ctx: z.RefinementCtx
) {
  refineGpuIntent(config, ctx)
  refineSupertonicVoiceStyle(config, ctx)
  if (config.ttsSpeed !== undefined && config.pace !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['pace'],
      message:
        'Supertonic accepts either ttsSpeed (an exact multiplier) or pace (slow/moderate/fast), not both.'
    })
  }
}

const ttsSupertonicRuntimeConfigShape = {
  ttsEngine: z.literal('supertonic').describe('TTS engine: Supertonic.'),
  language: ttsSupertonicLanguageSchema.describe('Language code. Default `en`.'),
  voice: z.string().optional().describe('Supertonic baked voice id, e.g. `F1` or `M1`.'),
  ttsSpeed: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      'Speech-rate / duration multiplier (1.0 = unchanged, <1 slower, >1 faster). Supertonic scales its native duration predictor. Mutually exclusive with `pace`.'
    ),
  // Supertonic maps the pace step onto a multiplier relative to the GGUF's
  // own default_speed. It conditions the engine at construction, so unlike
  // Parler and CosyVoice3 it cannot take a per-request pace.
  pace: ttsPaceSchema
    .optional()
    .describe(
      "Speaking rate: `'slow'`, `'moderate'`, or `'fast'`, applied when the engine is built. Mutually exclusive with `ttsSpeed`; cannot be changed per request."
    ),
  // SupertonicModel::validateConfig rejects negatives ('steps must be >= 0')
  // and the addon narrows with `| 0`, so bound it like its sibling ttsSpeed.
  ttsNumInferenceSteps: ttsNonNegativeInt32Schema
    .optional()
    .describe('Supertonic vector-estimator CFM steps; 0 uses the GGUF default.'),
  useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
  outputSampleRate: ttsOutputSampleRateSchema.optional(),
  threads: ttsPositiveInt32Schema.optional().describe(TTS_THREADS_DESC),
  nGpuLayers: ttsInt32Schema.optional().describe(TTS_NGPU_LAYERS_DESC),
  seed: ttsInt32Schema.optional().describe(TTS_SEED_DESC),
  vulkanCacheDir: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Supertonic + `useGPU` only: directory where the Vulkan backend persists its compiled pipeline cache.'
    ),
  vulkanDevice: ttsInt32Schema.min(-1).optional().describe(TTS_VULKAN_DEVICE_DESC),
  prewarmText: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Text synthesized once at load so GPU pipelines (and a Core ML vocoder sidecar) are ready before the first request; skipped on a plain CPU run. Use a sentence of representative length. Wins over the `vulkanCacheDir` default pre-warm.'
    ),
  // Supertonic chunks on text tokens, not speech tokens, so its native
  // streaming controls carry their own wording.
  streamChunkTokens: ttsNonNegativeInt32Schema
    .optional()
    .describe(
      'Text tokens (Unicode code points) per native streaming chunk, about 50 for English and 25–30 for CJK; 0 disables native chunk streaming. Cannot be combined with the LavaSR enhancer or denoiser.'
    ),
  streamFirstChunkTokens: ttsNonNegativeInt32Schema
    .optional()
    .describe(TTS_STREAM_FIRST_CHUNK_TOKENS_DESC),
  streamChunkTolerancePct: ttsNonNegativeInt32Schema
    .optional()
    .describe(
      'Boundary-snap window for clause and whitespace chunk boundaries, as a percentage of the chunk target (engine default 20).'
    ),
  streamMinChunkTokens: ttsNonNegativeInt32Schema
    .optional()
    .describe(
      'Floor on every streamed chunk’s size in text tokens (engine default 30); shorter trailing chunks merge into the previous one.'
    ),
  // Native precision and environment controls, forwarded to the engine as
  // given; -1 on the integer overrides leaves the engine's automatic choice.
  precision: z
    .enum(TTS_SUPERTONIC_PRECISIONS)
    .optional()
    .describe(
      'Weight precision the engine loads at: `auto` keeps the GGUF’s own, `f32` / `f16` / `q8_0` convert on load and change the weight footprint.'
    ),
  f16Attn: ttsInt32Schema
    .optional()
    .describe('Attention precision override: `-1` automatic (default), `0` f32, `1` f16.'),
  f16Weights: ttsInt32Schema
    .optional()
    .describe('Weight precision override: `-1` automatic (default), `0` off, `1` f16.'),
  kvAttnType: ttsInt32Schema
    .optional()
    .describe('Native KV attention type code; `-1` leaves the automatic selection.'),
  f16WeightsDenyList: z
    .array(z.string().min(1))
    .optional()
    .describe('Tensor-name patterns kept at their original precision when `f16Weights` is on.'),
  vulkanEnvOverrides: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Vulkan environment overrides (string values) passed to the engine; explicit entries win over the `vulkanCacheDir` convenience setting.'
    ),
  voiceStyleTtl: z
    .array(z.number())
    .min(1)
    .optional()
    .describe(
      'In-memory voice: the flattened `style_ttl` tensor of a cloned voice. Paired with `voiceStyleDp`; the engine checks the sizes against the model, and the pair wins over `voiceJsonSrc` and the baked `voice`.'
    ),
  voiceStyleDp: z
    .array(z.number())
    .min(1)
    .optional()
    .describe('In-memory voice: the flattened `style_dp` tensor, paired with `voiceStyleTtl`.'),
  ...ttsBackendDirFieldsShape,
  ...ttsOpenclCacheFieldShape
}

export const ttsSupertonicRuntimeConfigSchema = z
  .object(ttsSupertonicRuntimeConfigShape)
  .superRefine(refineSupertonicRateControls)

// A shape rather than a schema so the load schema below can be built from it
// and carry its own refinement set (the enhancer waiver needs the load-only
// lavasrEnhancerModelSrc field, which the runtime schema never sees).
const ttsParlerRuntimeConfigShape = {
  ttsEngine: z.literal('parler').describe('TTS engine: Parler.'),
  ...ttsParlerDescriptionFieldsShape,
  useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
  outputSampleRate: ttsOutputSampleRateSchema.optional(),
  streamChunkTokens: ttsNonNegativeInt32Schema.optional().describe(TTS_STREAM_CHUNK_TOKENS_DESC),
  streamFirstChunkTokens: ttsNonNegativeInt32Schema
    .optional()
    .describe(TTS_STREAM_FIRST_CHUNK_TOKENS_DESC),
  threads: ttsPositiveInt32Schema.optional().describe(TTS_THREADS_DESC),
  nGpuLayers: ttsInt32Schema.optional().describe(TTS_NGPU_LAYERS_DESC),
  seed: ttsInt32Schema.optional().describe(TTS_SEED_DESC),
  temperature: z.number().nonnegative().optional().describe(TTS_TEMPERATURE_DESC),
  topK: ttsNonNegativeInt32Schema.optional().describe(TTS_TOP_K_DESC),
  topP: z.number().positive().max(1).optional().describe(TTS_TOP_P_DESC),
  maxFrames: z
    .union([z.literal(0), ttsInt32Schema.min(10)])
    .optional()
    .describe(TTS_MAX_FRAMES_DESC),
  minNewTokens: ttsInt32Schema
    .min(-1)
    .optional()
    .describe('Parler minimum tokens before EOS; `-1` uses the model default.'),
  normalizeNumbers: z
    .boolean()
    .optional()
    .describe('Parler prompt digit expansion (engine default: enabled).'),
  // Apple Core ML sidecars (macOS / iOS). The DAC sidecar is presence-driven;
  // these three steer the optional decoder sidecar and the compute policy.
  coremlDecoder: z
    .boolean()
    .optional()
    .describe(
      'macOS / iOS: run the decoder steps on the `<model>-decoder.mlmodelc` sidecar beside the GGUF (the DAC sidecar is picked up by presence); unset keeps the engine default.'
    ),
  coremlComputeUnits: z
    .enum(TTS_PARLER_COREML_COMPUTE_UNITS)
    .optional()
    .describe(
      'macOS / iOS: Core ML compute policy for the Parler sidecars; unset inherits the engine’s environment default.'
    ),
  coremlStrict: z
    .boolean()
    .optional()
    .describe(
      'macOS / iOS: `true` fails the load when a sidecar is unusable instead of falling back to ggml, `false` permits the fallback; unset inherits the engine’s strict mode.'
    ),
  ...ttsBackendDirFieldsShape
}

export const ttsParlerRuntimeConfigSchema = z
  .object(ttsParlerRuntimeConfigShape)
  .superRefine(refineParlerRuntimeConfig)

// CosyVoice3 structured instruct: a raw string passes through to the engine as
// the exact instruction text (advanced escape hatch); the object form renders
// exactly one trained control by precedence dialect > volume > style.
// The string branch trims first: the addon trims too, so a whitespace-only
// instruction would otherwise silently degrade to zero-shot synthesis.
const ttsCosyvoice3InstructSchema = z.union([
  z.string().trim().min(1),
  z
    .object({
      dialect: z
        .enum(TTS_COSYVOICE3_INSTRUCT_DIALECTS)
        .optional()
        .describe('Chinese dialect to render (e.g. `cantonese`, `sichuan`).'),
      volume: z
        .enum(TTS_COSYVOICE3_INSTRUCT_VOLUMES)
        .optional()
        .describe('Speaking volume: `loud` or `soft`.'),
      style: z
        .enum(TTS_COSYVOICE3_INSTRUCT_STYLES)
        .optional()
        .describe('Speaking style: `peppa` or `robot`.')
    })
    .strict()
    .refine(
      (value) =>
        value.dialect !== undefined || value.volume !== undefined || value.style !== undefined,
      { message: 'instruct requires at least one of dialect, volume, or style.' }
    )
])

type TtsCosyvoice3RefinementInput = {
  emotion?: string | undefined
  pace?: string | undefined
  instruct?: unknown
  outputSampleRate?: number | undefined
  streamChunkTokens?: number | undefined
  useGPU?: boolean | undefined
  nGpuLayers?: number | undefined
}

// CosyVoice3 is trained on one instruction per synthesis: at most one of
// `emotion`, a non-moderate `pace`, or `instruct` may be engaged at once
// (`pace: 'moderate'` disengages the pace channel).
function refineCosyvoice3ConditioningControls(
  config: TtsCosyvoice3RefinementInput,
  ctx: z.RefinementCtx
) {
  const engaged: string[] = []
  if (config.emotion !== undefined) engaged.push('emotion')
  if (config.pace !== undefined && config.pace !== 'moderate') engaged.push('pace')
  if (config.instruct !== undefined) engaged.push('instruct')

  if (engaged.length > 1) {
    ctx.addIssue({
      code: 'custom',
      path: [engaged[1]!],
      message:
        `CosyVoice3 accepts one conditioning control per synthesis; got ${engaged.join(', ')}. ` +
        'Set exactly one (pace "moderate" disengages the pace channel).'
    })
  }
}

function refineCosyvoice3NativeStreamingRate(
  config: TtsCosyvoice3RefinementInput,
  ctx: z.RefinementCtx
) {
  const nativeStreamingEnabled = (config.streamChunkTokens ?? 0) > 0
  if (
    nativeStreamingEnabled &&
    config.outputSampleRate !== undefined &&
    config.outputSampleRate !== 24000
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['outputSampleRate'],
      message:
        'CosyVoice3 native streaming emits at 24000 Hz; omit outputSampleRate, use 24000, ' +
        'enable the LavaSR enhancer (which resamples seam-free), or disable native streaming.'
    })
  }
}

function refineCosyvoice3RuntimeConfig(config: TtsCosyvoice3RefinementInput, ctx: z.RefinementCtx) {
  refineCosyvoice3ConditioningControls(config, ctx)
  refineCosyvoice3NativeStreamingRate(config, ctx)
  refineGpuIntent(config, ctx)
}

const ttsCosyvoice3RuntimeConfigShape = {
  ttsEngine: z.literal('cosyvoice3').describe('TTS engine: CosyVoice3.'),
  emotion: ttsCosyvoice3EmotionSchema
    .optional()
    .describe(
      "Speaking style: `'anger'`, `'happy'`, `'neutral'`, or `'sad'`. One conditioning control per synthesis (emotion / non-moderate pace / instruct)."
    ),
  pace: ttsPaceSchema
    .optional()
    .describe(
      "Speaking rate: `'slow'`, `'moderate'`, or `'fast'`; `'moderate'` disengages the pace channel."
    ),
  instruct: ttsCosyvoice3InstructSchema
    .optional()
    .describe(
      'Natural-language control: a structured object (one of dialect / volume / style) or a raw instruction string. One conditioning control per synthesis; a request-level `instruct` replaces it for that synthesis.'
    ),
  // Trimmed for the same reason as the instruct string: a whitespace-only
  // transcript would reach the engine as a non-empty prompt.
  promptText: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Verbatim transcript of `referenceAudioSrc`. Setting it selects zero-shot cloning (best fidelity in the reference’s own language); omitting it selects cross-lingual cloning (timbre only). Without a reference it overrides the baked voice’s transcript metadata.'
    ),
  flowCutPrompt: z
    .boolean()
    .optional()
    .describe(
      'Treat the baked-voice prompt frames as attention-only conditioning in the flow: a faster flow whose output deviates slightly from the reference (engine default off).'
    ),
  vulkanDevice: ttsInt32Schema.min(-1).optional().describe(TTS_VULKAN_DEVICE_DESC),
  greedy: z
    .boolean()
    .optional()
    .describe(
      'Greedy LM decoding: take the argmax speech token instead of sampling (engine default off).'
    ),
  forceSpeechTokens: z
    .array(ttsSpeechTokenIdSchema)
    .optional()
    .describe(
      'Speech-token trajectory of ONE native synthesis to replay instead of generating, as a previous batch run, native chunk stream or single sentence returned it in `speechTokenIds`. Fixed at load: every synthesis of the model replays this same array, so a joined sentence stream cannot be replayed sentence by sentence. An empty array restores generation.'
    ),
  useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
  outputSampleRate: ttsOutputSampleRateSchema.optional(),
  streamChunkTokens: ttsNonNegativeInt32Schema.optional().describe(TTS_STREAM_CHUNK_TOKENS_DESC),
  streamFirstChunkTokens: ttsNonNegativeInt32Schema
    .optional()
    .describe(TTS_STREAM_FIRST_CHUNK_TOKENS_DESC),
  threads: ttsPositiveInt32Schema.optional().describe(TTS_THREADS_DESC),
  nGpuLayers: ttsInt32Schema.optional().describe(TTS_NGPU_LAYERS_DESC),
  seed: ttsInt32Schema.optional().describe(TTS_SEED_DESC),
  ...ttsBackendDirFieldsShape,
  ...ttsOpenclCacheFieldShape
}

export const ttsCosyvoice3RuntimeConfigSchema = z
  .object(ttsCosyvoice3RuntimeConfigShape)
  .superRefine(refineCosyvoice3RuntimeConfig)

const ttsAudio8RuntimeConfigShape = {
  ttsEngine: z.literal('audio8').describe('TTS engine: Audio8.'),
  // Transcript of the load-time reference recording (zero-shot voice cloning).
  // Paired with `referenceAudioSrc` on the load config; kept on the runtime
  // config because it survives artifact resolution as plain data.
  // Trimmed for the same reason as the CosyVoice3 instruct string: a
  // whitespace-only transcript would reach the engine as a non-empty value.
  referenceText: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Transcript of `referenceAudioSrc`; required when cloning a voice.'),
  greedy: z.boolean().optional().describe('Audio8: take the argmax instead of sampling.'),
  temperature: z.number().nonnegative().optional().describe(TTS_TEMPERATURE_DESC),
  topK: ttsNonNegativeInt32Schema.optional().describe(TTS_TOP_K_DESC),
  topP: z.number().positive().max(1).optional().describe(TTS_TOP_P_DESC),
  maxFrames: ttsNonNegativeInt32Schema.optional().describe(TTS_MAX_FRAMES_DESC),
  useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
  outputSampleRate: ttsOutputSampleRateSchema.optional(),
  threads: ttsPositiveInt32Schema.optional().describe(TTS_THREADS_DESC),
  nGpuLayers: ttsInt32Schema.optional().describe(TTS_NGPU_LAYERS_DESC),
  seed: ttsInt32Schema.optional().describe(TTS_SEED_DESC),
  ...ttsBackendDirFieldsShape
}

export const ttsAudio8RuntimeConfigSchema = z
  .object(ttsAudio8RuntimeConfigShape)
  .superRefine(refineGpuIntent)

// @qvac/tts-ggml's MOSS generation budget: 2048 rows when `maxNewTokens` is
// unset, of which 31 delay-pattern drain rows and two termination rows are
// never audio, so `durationTokens` fits at most `maxNewTokens - 33` (2015 by
// default).
const TTS_MOSS_DEFAULT_MAX_NEW_TOKENS = 2048
const TTS_MOSS_RESERVED_ROWS = 33

const TTS_MOSS_MAX_DIALOGUE_SPEAKERS = 5

// Mirrors the addon's assertMossDurationTokens with the configured budget: a
// target that does not fit the generation budget is refused at load rather
// than by the engine.
function refineMossDurationBudget(
  config: { durationTokens?: number | undefined; maxNewTokens?: number | undefined },
  ctx: z.RefinementCtx
) {
  if (config.durationTokens === undefined || config.durationTokens === 0) return
  const budget = (config.maxNewTokens ?? TTS_MOSS_DEFAULT_MAX_NEW_TOKENS) - TTS_MOSS_RESERVED_ROWS
  if (config.durationTokens <= budget) return
  ctx.addIssue({
    code: 'custom',
    path: ['durationTokens'],
    message: `durationTokens must be an integer from 0 to ${Math.max(0, budget)} (maxNewTokens less the 33 delay/EOS rows; 0 = free length).`
  })
}

function refineMossRuntimeConfig(
  config: {
    ttsEngine: 'moss'
    backend?: string | undefined
    useGPU?: boolean | undefined
    nGpuLayers?: number | undefined
    durationTokens?: number | undefined
    maxNewTokens?: number | undefined
  },
  ctx: z.RefinementCtx
) {
  refineGpuIntent(config, ctx)
  refineNoWebgpuBackend(config, ctx)
  refineMossDurationBudget(config, ctx)
}

// MOSS samples its text and audio channels separately; the defaults are the
// engine's, so these do not share the Parler / Audio8 sampling descriptions.
const ttsMossSamplingFieldsShape = {
  textTemperature: z
    .number()
    .nonnegative()
    .optional()
    .describe('Text-channel sampling temperature; unset keeps the engine default.'),
  textTopP: z
    .number()
    .positive()
    .max(1)
    .optional()
    .describe('Text-channel top-p (nucleus) cutoff, 0 < p ≤ 1; unset keeps the engine default.'),
  textTopK: ttsNonNegativeInt32Schema
    .optional()
    .describe('Text-channel top-k cutoff; unset keeps the engine default.'),
  audioTemperature: z
    .number()
    .nonnegative()
    .optional()
    .describe('Audio-channel sampling temperature; unset keeps the engine default.'),
  audioTopP: z
    .number()
    .positive()
    .max(1)
    .optional()
    .describe('Audio-channel top-p (nucleus) cutoff, 0 < p ≤ 1; unset keeps the engine default.'),
  audioTopK: ttsNonNegativeInt32Schema
    .optional()
    .describe('Audio-channel top-k cutoff; unset keeps the engine default.'),
  audioRepetitionPenalty: z
    .number()
    .positive()
    .optional()
    .describe('Audio-channel repetition penalty; 1 = off, unset keeps the engine default.')
}

// MOSS emits its native 24 kHz only (the addon rejects any other
// `outputSampleRate`) and supports neither the LavaSR stages nor a smaller
// first streaming chunk, so none of those fields exist on this arm.
const ttsMossRuntimeConfigShape = {
  ttsEngine: z
    .literal('moss')
    .describe(
      'TTS engine: MOSS (OpenMOSS MOSS-TTS v1.5 / MOSS-TTSD Delay; 24 kHz, 8B backbone, desktop only).'
    ),
  // The addon forwards it into the model prompt as a hint and does not
  // validate it, so the vocabulary is the model's, not a fixed enum.
  language: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Language hint written into the model prompt, e.g. `en` or `zh`. Default `en`.'),
  durationTokens: ttsInt32Schema
    .min(0)
    .optional()
    .describe(
      'Target length of each synthesis in codec frames (12.5 per second, so 38 ≈ 3 s), at most `maxNewTokens` − 33 (2015 by default); 0 or unset keeps the length free.'
    ),
  streamChunkTokens: ttsNonNegativeInt32Schema
    .optional()
    .describe(
      'Codec frames per native streaming chunk (12.5 per second, so 25 ≈ 2 s); 0 or unset synthesizes the whole text before emitting.'
    ),
  nCtx: ttsPositiveInt32Schema
    .optional()
    .describe('Context capacity of the backbone in rows; unset keeps the native value.'),
  maxNewTokens: ttsPositiveInt32Schema
    .optional()
    .describe(
      'Generation budget in rows (engine default 2048), of which 33 are delay/EOS rows; bounds `durationTokens`.'
    ),
  ...ttsMossSamplingFieldsShape,
  useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
  threads: ttsPositiveInt32Schema.optional().describe(TTS_THREADS_DESC),
  // Not TTS_NGPU_LAYERS_DESC: MOSS does not offload per layer, so a layer
  // count would misdescribe it — the value only picks the backend.
  nGpuLayers: ttsInt32Schema
    .optional()
    .describe(
      'Any non-zero value selects the GPU backend, 0 keeps MOSS on the CPU. Wins over `useGPU`; when both are set they must agree.'
    ),
  seed: ttsInt32Schema.optional().describe(TTS_SEED_DESC),
  ...ttsBackendDirFieldsShape
}

export const ttsMossRuntimeConfigSchema = z
  .object(ttsMossRuntimeConfigShape)
  .superRefine(refineMossRuntimeConfig)

// JSON PCM keeps the client and wire portable; converted to Float32Array at the addon boundary.
const ttsSpeechPcmSchema = z.array(z.number().min(-1).max(1)).min(1)
const ttsSpeechRateSchema = z.number().int().min(8000).max(192000)

const ttsSoundEffectFieldsShape = {
  seconds: z
    .number()
    .positive()
    .max(30)
    .optional()
    .describe('Sound-effect duration in seconds, up to 30.'),
  negativePrompt: z
    .string()
    .optional()
    .describe('Description of sounds to avoid in the generated effect.'),
  steps: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Diffusion denoising steps; the native default is 100.'),
  guidance: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe('Classifier-free guidance scale for sound-effect generation.'),
  shift: z
    .number()
    .positive()
    .max(100)
    .optional()
    .describe('Diffusion timestep schedule shift for sound-effect generation.')
}

function refineSpeechAudio(
  value: {
    audio?: number[] | undefined
    sampleRate?: number | undefined
    text?: string | undefined
  },
  ctx: z.RefinementCtx
) {
  if ((value.audio !== undefined) !== (value.sampleRate !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['sampleRate'],
      message: 'audio and sampleRate must be supplied together.'
    })
  }
  if ((value.audio !== undefined) === Boolean(value.text?.trim())) {
    ctx.addIssue({
      code: 'custom',
      path: ['text'],
      message: 'Supply exactly one of text or audio.'
    })
  }
}

const ttsSpeechFieldsShape = {
  audio: ttsSpeechPcmSchema.optional(),
  sampleRate: ttsSpeechRateSchema.optional(),
  messages: z
    .array(
      z
        .object({
          role: z.enum(['system', 'user', 'assistant']),
          text: z.string().min(1).optional(),
          audio: ttsSpeechPcmSchema.optional(),
          sampleRate: ttsSpeechRateSchema.optional()
        })
        .superRefine(refineSpeechAudio)
    )
    .optional(),
  systemPrompt: z.string().optional(),
  replyVoice: ttsSpeechPcmSchema.optional(),
  replyVoiceSampleRate: ttsSpeechRateSchema.optional(),
  textReply: z.boolean().optional(),
  maxReplySeconds: z.number().min(0).max(3600).optional(),
  maxNewTokens: z.number().int().min(1).max(4096).optional(),
  greedy: z.boolean().optional(),
  temperature: z.number().positive().max(10).optional(),
  topP: z.number().positive().max(1).optional(),
  topK: ttsNonNegativeInt32Schema.optional()
}

const ttsBatchBackendShape = {
  useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
  threads: ttsPositiveInt32Schema.optional().describe(TTS_THREADS_DESC),
  nGpuLayers: ttsInt32Schema.optional().describe(TTS_NGPU_LAYERS_DESC),
  seed: ttsInt32Schema.optional().describe(TTS_SEED_DESC),
  ...ttsBackendDirFieldsShape
}

function refineMossBatchRuntimeConfig(
  config: {
    ttsEngine: 'moss-sfx' | 'moss-speech'
    backend?: string | undefined
    useGPU?: boolean | undefined
    nGpuLayers?: number | undefined
  },
  ctx: z.RefinementCtx
) {
  refineGpuIntent(config, ctx)
  refineNoWebgpuBackend(config, ctx)
}

export const ttsMossSoundEffectRuntimeConfigSchema = z
  .object({
    ttsEngine: z.literal('moss-sfx').describe('TTS engine: MOSS-SoundEffect-v2.'),
    ...ttsBatchBackendShape,
    ...ttsSoundEffectFieldsShape
  })
  .superRefine(refineMossBatchRuntimeConfig)

export const ttsMossSpeechRuntimeConfigSchema = z
  .object({
    ttsEngine: z.literal('moss-speech').describe('TTS engine: MOSS-Speech.'),
    ...ttsBatchBackendShape
  })
  .superRefine(refineMossBatchRuntimeConfig)

export const ttsMossSoundEffectLoadConfigSchema = ttsMossSoundEffectRuntimeConfigSchema
export const ttsMossSpeechLoadConfigSchema = ttsMossSpeechRuntimeConfigSchema.extend({
  mossSpeechCodecModelSrc: modelSrcInputSchema.describe(
    'MOSS-Speech codec GGUF source; modelSrc is the language model.'
  )
})

export const ttsRuntimeConfigSchema = z.discriminatedUnion('ttsEngine', [
  ttsChatterboxRuntimeConfigSchema,
  ttsSupertonicRuntimeConfigSchema,
  ttsParlerRuntimeConfigSchema,
  ttsCosyvoice3RuntimeConfigSchema,
  ttsAudio8RuntimeConfigSchema,
  ttsMossRuntimeConfigSchema,
  ttsMossSoundEffectRuntimeConfigSchema,
  ttsMossSpeechRuntimeConfigSchema
])

// Optional LavaSR post-processing model sources, shared across engines. Supply
// the enhancer GGUF to bandwidth-extend the output to 48 kHz, and/or the
// denoiser GGUF (runs before the enhancer, rate-preserving). Resolved to
// artifacts by the plugin's resolveConfig and forwarded to @qvac/tts-ggml.
const ttsLavasrLoadFieldsShape = {
  lavasrEnhancerModelSrc: modelSrcInputSchema
    .optional()
    .describe('LavaSR enhancer model source; bandwidth-extends the output to 48 kHz.'),
  lavasrDenoiserModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'LavaSR denoiser model source; runs before the enhancer, rate-preserving (batch synthesis only).'
    ),
  // The Core ML models are compiled `.mlmodelc` directories, not single files,
  // so they are host paths rather than model sources. Each stage takes its
  // path and compute policy together, beside its GGUF source.
  lavasrEnhancerCoremlModelPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      'macOS / iOS: compiled Core ML model directory (`.mlmodelc`) on the inference host for the LavaSR enhancer’s neural core; requires `lavasrEnhancerModelSrc` and `lavasrEnhancerCoremlComputeUnits`. A model that cannot load fails the load rather than falling back to ggml.'
    ),
  lavasrEnhancerCoremlComputeUnits: z
    .enum(TTS_LAVASR_COREML_COMPUTE_UNITS)
    .optional()
    .describe(
      'macOS / iOS: Core ML compute policy for the LavaSR enhancer; required with `lavasrEnhancerCoremlModelPath`. Stats then report the stage as device `2` (Core ML-managed), backend `99`.'
    ),
  lavasrDenoiserCoremlModelPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      'macOS / iOS: compiled Core ML model directory (`.mlmodelc`) on the inference host for the LavaSR denoiser’s neural core; requires `lavasrDenoiserModelSrc` and `lavasrDenoiserCoremlComputeUnits`. A model that cannot load fails the load rather than falling back to ggml.'
    ),
  lavasrDenoiserCoremlComputeUnits: z
    .enum(TTS_LAVASR_COREML_COMPUTE_UNITS)
    .optional()
    .describe(
      'macOS / iOS: Core ML compute policy for the LavaSR denoiser; required with `lavasrDenoiserCoremlModelPath`. Stats then report the stage as device `2` (Core ML-managed), backend `99`.'
    )
}

type TtsLavasrCoremlRefinementInput = {
  lavasrEnhancerModelSrc?: ModelSrcInput | undefined
  lavasrDenoiserModelSrc?: ModelSrcInput | undefined
  lavasrEnhancerCoremlModelPath?: string | undefined
  lavasrEnhancerCoremlComputeUnits?: string | undefined
  lavasrDenoiserCoremlModelPath?: string | undefined
  lavasrDenoiserCoremlComputeUnits?: string | undefined
}

// Mirrors the addon's validateLavaSRCoreML: the path and the policy come as a
// pair, and a pair without the stage's GGUF has no stage to attach to.
function refineLavasrCoreml(config: TtsLavasrCoremlRefinementInput, ctx: z.RefinementCtx) {
  for (const stage of ['Enhancer', 'Denoiser'] as const) {
    const pathField = `lavasr${stage}CoremlModelPath` as const
    const unitsField = `lavasr${stage}CoremlComputeUnits` as const
    const srcField = `lavasr${stage}ModelSrc` as const
    const path = config[pathField]
    const units = config[unitsField]
    if (path === undefined && units === undefined) continue
    if (path === undefined || units === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [path === undefined ? pathField : unitsField],
        message: `${pathField} and ${unitsField} must be supplied together.`
      })
    }
    if (config[srcField] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [srcField],
        message: `${srcField} is required when the LavaSR ${stage.toLowerCase()} runs on Core ML (${pathField}).`
      })
    }
  }
}

// The denoiser needs the whole utterance, so every engine with native chunk
// streaming rejects the pair at load. Shared so Chatterbox, Parler and
// CosyVoice3 fail the same way with the same message.
function refineLavasrDenoiserStreaming(
  config: {
    lavasrDenoiserModelSrc?: ModelSrcInput | undefined
    streamChunkTokens?: number | undefined
  },
  ctx: z.RefinementCtx
) {
  if (config.lavasrDenoiserModelSrc !== undefined && (config.streamChunkTokens ?? 0) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['lavasrDenoiserModelSrc'],
      message:
        'The LavaSR denoiser is batch-only; disable native streaming (streamChunkTokens) to use it.'
    })
  }
}

export const ttsChatterboxLoadConfigSchema = ttsChatterboxRuntimeConfigSchema
  .extend({
    // Optional at schema time so legacy ONNX configs (no s3genModelSrc) reach
    // the plugin's resolveConfig and raise LegacyTtsModelDeprecatedError.
    s3genModelSrc: modelSrcInputSchema
      .optional()
      .describe('Chatterbox S3Gen + HiFT model source (speech tokens to 24 kHz waveform).'),
    referenceAudioSrc: modelSrcInputSchema
      .optional()
      .describe('Chatterbox voice-cloning reference audio source (wav).'),
    mecabDictSrc: modelSrcInputSchema
      .optional()
      .describe(
        'Chatterbox MTL only: compiled MeCab/IPAdic dictionary source for Japanese segmentation (required for language `ja`).'
      ),
    cangjieTsvSrc: modelSrcInputSchema
      .optional()
      .describe(
        'Chatterbox MTL only: Cangjie TSV source for Chinese romanisation (required for language `zh`).'
      ),
    ...ttsLavasrLoadFieldsShape
  })
  .superRefine(refineChatterboxLoadConfig)

function refineChatterboxLoadConfig(
  config: TtsLavasrCoremlRefinementInput & { streamChunkTokens?: number | undefined },
  ctx: z.RefinementCtx
) {
  refineLavasrDenoiserStreaming(config, ctx)
  refineLavasrCoreml(config, ctx)
}

type TtsSupertonicLoadRefinementInput = TtsLavasrCoremlRefinementInput & {
  ttsSpeed?: number | undefined
  pace?: string | undefined
  useGPU?: boolean | undefined
  nGpuLayers?: number | undefined
  voiceStyleTtl?: number[] | undefined
  voiceStyleDp?: number[] | undefined
  streamChunkTokens?: number | undefined
}

// Supertonic native chunk streaming rejects BOTH LavaSR stages, not just the
// denoiser: tts-cpp only has one-shot enhance / denoise for this engine, and
// it reports no native rate before synthesis. Sentence streaming still works
// with either stage loaded.
function refineSupertonicLoadConfig(
  config: TtsSupertonicLoadRefinementInput,
  ctx: z.RefinementCtx
) {
  refineSupertonicRateControls(config, ctx)
  refineLavasrCoreml(config, ctx)
  if ((config.streamChunkTokens ?? 0) <= 0) return
  for (const field of ['lavasrEnhancerModelSrc', 'lavasrDenoiserModelSrc'] as const) {
    if (config[field] === undefined) continue
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message:
        'Supertonic native chunk streaming (streamChunkTokens > 0) cannot be combined with the LavaSR enhancer or denoiser; ' +
        'use sentence streaming (stream: true without streamChunkTokens, sentenceStream, or textToSpeechStream) for enhanced output.'
    })
  }
}

// Supertonic's external voice JSON and fixed CFM noise tensor are single files,
// so they ride the same source resolution as the LavaSR GGUFs and reach the
// addon as `voiceJsonPath` / `noiseNpyPath`.
export const ttsSupertonicLoadConfigSchema = z
  .object({
    ...ttsSupertonicRuntimeConfigShape,
    ...ttsLavasrLoadFieldsShape,
    voiceJsonSrc: modelSrcInputSchema
      .optional()
      .describe(
        'External voice JSON source (`{ style_ttl, style_dp }`, e.g. a cloned voice) that overrides the baked `voice` preset; the engine checks the tensor sizes against the loaded model.'
      ),
    noiseNpySrc: modelSrcInputSchema
      .optional()
      .describe('Fixed CFM initial-noise `.npy` tensor source, for reproducible output.')
  })
  .superRefine(refineSupertonicLoadConfig)

type TtsParlerLoadRefinementInput = TtsParlerRuntimeRefinementInput & TtsLavasrCoremlRefinementInput

function refineParlerLoadConfig(config: TtsParlerLoadRefinementInput, ctx: z.RefinementCtx) {
  refineParlerDescriptionFields(config, ctx)
  refineGpuIntent(config, ctx)
  // Same waiver CosyVoice3 gets: with the enhancer active the addon resamples
  // seam-free, so the 44.1 kHz native-streaming pin only applies without it.
  if (config.lavasrEnhancerModelSrc === undefined) {
    refineParlerNativeStreamingRate(config, ctx)
  }
  refineLavasrDenoiserStreaming(config, ctx)
  refineLavasrCoreml(config, ctx)
}

export const ttsParlerLoadConfigSchema = z
  .object({
    ...ttsParlerRuntimeConfigShape,
    ...ttsLavasrLoadFieldsShape
  })
  .superRefine(refineParlerLoadConfig)

// CosyVoice3 zero-shot / cross-lingual voice cloning. The speech tokenizer and
// the CAM++ speaker encoder are NOT in the LLM GGUF's companion set — they are
// a ~300 MB opt-in, so they are requested explicitly here and forwarded to the
// addon as `files.cosyvoiceS3tokModel` / `files.cosyvoiceCampplusModel`.
const ttsCosyvoice3CloningFieldsShape = {
  referenceAudioSrc: modelSrcInputSchema
    .optional()
    .describe(
      'CosyVoice3 voice-cloning reference recording source (wav; 0.5–30 s, 5–15 s of clean speech recommended). Replaces the baked voice.'
    ),
  cosyvoice3S3tokModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'CosyVoice3 speech-tokenizer (speech_tokenizer_v3) model source; required with `referenceAudioSrc`.'
    ),
  cosyvoice3CampplusModelSrc: modelSrcInputSchema
    .optional()
    .describe('CosyVoice3 CAM++ speaker-encoder model source; required with `referenceAudioSrc`.')
}

type TtsCosyvoice3CloningRefinementInput = {
  referenceAudioSrc?: ModelSrcInput | undefined
  cosyvoice3S3tokModelSrc?: ModelSrcInput | undefined
  cosyvoice3CampplusModelSrc?: ModelSrcInput | undefined
  promptText?: string | undefined
}

// The addon fails the native load — never silently falls back to the baked
// voice — when a reference recording arrives without the two cloning GGUFs, so
// catch the incomplete set here where the message can name the missing source.
// `promptText` is deliberately not required: its absence selects cross-lingual.
function refineCosyvoice3Cloning(
  config: TtsCosyvoice3CloningRefinementInput,
  ctx: z.RefinementCtx
) {
  if (config.referenceAudioSrc !== undefined) {
    if (config.cosyvoice3S3tokModelSrc === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['cosyvoice3S3tokModelSrc'],
        message:
          'CosyVoice3 voice cloning requires the speech-tokenizer GGUF (cosyvoice3S3tokModelSrc).'
      })
    }
    if (config.cosyvoice3CampplusModelSrc === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['cosyvoice3CampplusModelSrc'],
        message:
          'CosyVoice3 voice cloning requires the CAM++ speaker-encoder GGUF (cosyvoice3CampplusModelSrc).'
      })
    }
    return
  }

  for (const field of ['cosyvoice3S3tokModelSrc', 'cosyvoice3CampplusModelSrc'] as const) {
    if (config[field] !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceAudioSrc'],
        message: `referenceAudioSrc is required when ${field} is set; the cloning models are only used to clone a voice.`
      })
    }
  }
}

type TtsCosyvoice3LoadRefinementInput = TtsCosyvoice3RefinementInput &
  TtsCosyvoice3CloningRefinementInput &
  TtsLavasrCoremlRefinementInput

function refineCosyvoice3LoadConfig(
  config: TtsCosyvoice3LoadRefinementInput,
  ctx: z.RefinementCtx
) {
  refineCosyvoice3ConditioningControls(config, ctx)
  refineGpuIntent(config, ctx)

  // With the LavaSR enhancer active the addon resamples seam-free, so the
  // 24 kHz native-streaming restriction only applies without it.
  if (config.lavasrEnhancerModelSrc === undefined) {
    refineCosyvoice3NativeStreamingRate(config, ctx)
  }

  refineLavasrDenoiserStreaming(config, ctx)
  refineLavasrCoreml(config, ctx)
  refineCosyvoice3Cloning(config, ctx)
}

// CosyVoice3 loads from a model *directory* (LLM/flow/HiFT GGUFs plus
// voice.gguf, vocab.json and merges.txt). The primary `modelSrc` is the LLM
// GGUF, whose registry companion set co-locates the remaining files, so the
// load config adds the optional LavaSR post-processing sources and the
// voice-cloning add-ons, which are NOT part of that companion set.
export const ttsCosyvoice3LoadConfigSchema = z
  .object({
    ...ttsCosyvoice3RuntimeConfigShape,
    ...ttsLavasrLoadFieldsShape,
    ...ttsCosyvoice3CloningFieldsShape
  })
  .superRefine(refineCosyvoice3LoadConfig)

type TtsAudio8LoadRefinementInput = {
  referenceText?: string | undefined
  audio8CodecEncoderModelSrc?: ModelSrcInput | undefined
  referenceAudioSrc?: ModelSrcInput | undefined
  useGPU?: boolean | undefined
  nGpuLayers?: number | undefined
}

// Built from the runtime *shape* rather than the runtime schema, so the
// refinements attached to that schema do not carry over — re-run them here.
function refineAudio8LoadConfig(config: TtsAudio8LoadRefinementInput, ctx: z.RefinementCtx) {
  refineGpuIntent(config, ctx)

  if (config.referenceAudioSrc !== undefined && config.referenceText === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceText'],
      message:
        'referenceText (the transcript of the reference recording) is required with referenceAudioSrc.'
    })
  }

  if (config.referenceText !== undefined && config.referenceAudioSrc === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceAudioSrc'],
      message: 'referenceAudioSrc is required when referenceText is set.'
    })
  }

  if (config.referenceAudioSrc !== undefined && config.audio8CodecEncoderModelSrc === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['audio8CodecEncoderModelSrc'],
      message: 'Voice cloning requires the Audio8 codec encoder GGUF (audio8CodecEncoderModelSrc).'
    })
  }
}

// Audio8 loads from explicit per-component GGUFs: the primary `modelSrc` is
// the DualAR LM, the codec decoder is required, and the codec encoder is only
// needed for zero-shot voice cloning (reference audio + transcript).
export const ttsAudio8LoadConfigSchema = z
  .object({
    ...ttsAudio8RuntimeConfigShape,
    audio8CodecDecoderModelSrc: modelSrcInputSchema.describe(
      'Audio8 codec decoder model source (codes to 44.1 kHz waveform).'
    ),
    audio8CodecEncoderModelSrc: modelSrcInputSchema
      .optional()
      .describe(
        'Audio8 codec encoder model source (waveform to codes); required only for voice cloning.'
      ),
    referenceAudioSrc: modelSrcInputSchema
      .optional()
      .describe('Audio8 voice-cloning reference recording source; pair with `referenceText`.')
  })
  .superRefine(refineAudio8LoadConfig)

type TtsMossLoadRefinementInput = {
  ttsEngine: 'moss'
  backend?: string | undefined
  mossCodecEncoderModelSrc?: ModelSrcInput | undefined
  referenceAudioSrc?: ModelSrcInput | undefined
  dialogueReferenceSrcs?: ModelSrcInput[] | undefined
  useGPU?: boolean | undefined
  nGpuLayers?: number | undefined
  durationTokens?: number | undefined
  maxNewTokens?: number | undefined
}

// The addon enforces the same three rules at construction; catching them here
// names the SDK field instead of the addon's `files.*` option. Built from the
// runtime *shape*, so the runtime refinements are re-run here too.
function refineMossLoadConfig(config: TtsMossLoadRefinementInput, ctx: z.RefinementCtx) {
  refineMossRuntimeConfig(config, ctx)

  if (config.referenceAudioSrc !== undefined && config.dialogueReferenceSrcs !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['dialogueReferenceSrcs'],
      message:
        'referenceAudioSrc and dialogueReferenceSrcs are exclusive; pass one recording per speaker in dialogueReferenceSrcs.'
    })
  }

  const cloningField =
    config.referenceAudioSrc !== undefined
      ? 'referenceAudioSrc'
      : config.dialogueReferenceSrcs !== undefined
        ? 'dialogueReferenceSrcs'
        : undefined
  if (cloningField !== undefined && config.mossCodecEncoderModelSrc === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['mossCodecEncoderModelSrc'],
      message: `${cloningField} requires the MOSS codec encoder GGUF (mossCodecEncoderModelSrc).`
    })
  }
}

// MOSS loads from explicit per-component GGUFs like Audio8: the primary
// `modelSrc` is the Delay backbone — MOSS-TTS (`moss-tts-delay-*.gguf`) or the
// MOSS-TTSD dialogue checkpoint (`moss-ttsd-*.gguf`) — the codec decoder is
// required, and the codec encoder is only needed to encode reference audio.
export const ttsMossLoadConfigSchema = z
  .object({
    ...ttsMossRuntimeConfigShape,
    mossCodecDecoderModelSrc: modelSrcInputSchema.describe(
      'MOSS codec decoder model source (codes to 24 kHz waveform).'
    ),
    mossCodecEncoderModelSrc: modelSrcInputSchema
      .optional()
      .describe(
        'MOSS codec encoder model source (waveform to codes); required only with `referenceAudioSrc` or `dialogueReferenceSrcs`.'
      ),
    referenceAudioSrc: modelSrcInputSchema
      .optional()
      .describe(
        'MOSS voice-cloning reference recording source: a 24 kHz WAV (no resampling; multichannel is downmixed, at most 60 s). No transcript needed. Fixed for the loaded model.'
      ),
    // MOSS-TTSD covers one to five speakers. The engine itself sets no count
    // (only a 60 s cap on the references combined), so without a bound here a
    // single load could fan out into any number of parallel source downloads.
    dialogueReferenceSrcs: z
      .array(modelSrcInputSchema)
      .min(1)
      .max(TTS_MOSS_MAX_DIALOGUE_SPEAKERS)
      .optional()
      .describe(
        'MOSS-TTSD dialogue: one 24 kHz WAV per speaker (one to five, at most 60 s combined), in the order the text tags them (`[S1]`, `[S2]`, …). The text must open with each recording’s transcript under its tag, followed by the lines to generate. Needs a MOSS-TTSD backbone as `modelSrc`; fixed for the loaded model.'
      )
  })
  .superRefine(refineMossLoadConfig)

type TtsTokenizerAssetRefinementInput = {
  ttsEngine?: string
  language?: string | undefined
  mecabDictSrc?: ModelSrcInput | undefined
  cangjieTsvSrc?: ModelSrcInput | undefined
}

function refineChatterboxTokenizerAssets(
  data: TtsTokenizerAssetRefinementInput,
  ctx: z.RefinementCtx
) {
  if (data.ttsEngine !== 'chatterbox') return

  if (data.language === 'ja' && data.mecabDictSrc === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['mecabDictSrc'],
      message: 'mecabDictSrc is required when Chatterbox language is "ja".'
    })
  }

  if (data.language === 'zh' && data.cangjieTsvSrc === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['cangjieTsvSrc'],
      message: 'cangjieTsvSrc is required when Chatterbox language is "zh".'
    })
  }
}

export const ttsLoadConfigSchema = z
  .discriminatedUnion('ttsEngine', [
    ttsChatterboxLoadConfigSchema,
    ttsSupertonicLoadConfigSchema,
    ttsParlerLoadConfigSchema,
    ttsCosyvoice3LoadConfigSchema,
    ttsAudio8LoadConfigSchema,
    ttsMossLoadConfigSchema,
    ttsMossSoundEffectLoadConfigSchema,
    ttsMossSpeechLoadConfigSchema
  ])
  .superRefine(refineChatterboxTokenizerAssets)

// === Legacy ONNX modelConfig fields (deprecated) ===
//
// Pre-@qvac/tts-ggml multi-file ONNX `modelConfig` fields are kept ONLY so
// callers migrating from earlier SDK versions hit a structured
// `LegacyTtsModelDeprecatedError` from the TTS plugin's `resolveConfig`,
// rather than a generic Zod `Unrecognized key` error.
export const LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS = [
  // ONNX runtime flag; GGML uses modelSrc (GGUF) + `language` instead.
  'ttsSupertonicMultilingual',
  'ttsTokenizerSrc',
  'ttsSpeechEncoderSrc',
  'ttsEmbedTokensSrc',
  'ttsConditionalDecoderSrc',
  'ttsLanguageModelSrc',
  'ttsTextEncoderSrc',
  'ttsDurationPredictorSrc',
  'ttsVectorEstimatorSrc',
  'ttsVocoderSrc',
  'ttsUnicodeIndexerSrc',
  'ttsTtsConfigSrc',
  'ttsVoiceStyleSrc'
] as const

const legacyTtsOnnxFieldsShape = LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS.reduce<
  Record<string, z.ZodOptional<z.ZodUnknown>>
>((acc, name) => {
  acc[name] = z.unknown().optional()
  return acc
}, {})

// Strict load schema used by `loadModel` and the tts-ggml plugin's
// `loadConfigSchema`. Permits deprecated ONNX field names so
// `resolveConfig` can raise LegacyTtsModelDeprecatedError instead of a
// generic Zod error; other unknown keys are still rejected by `.strict()`.
export const ttsConfigSchema = z
  .discriminatedUnion('ttsEngine', [
    ttsChatterboxLoadConfigSchema.extend(legacyTtsOnnxFieldsShape).strict(),
    ttsSupertonicLoadConfigSchema.extend(legacyTtsOnnxFieldsShape).strict(),
    ttsParlerLoadConfigSchema.strict(),
    ttsCosyvoice3LoadConfigSchema.strict(),
    ttsAudio8LoadConfigSchema.strict(),
    ttsMossLoadConfigSchema.strict(),
    ttsMossSoundEffectLoadConfigSchema.strict(),
    ttsMossSpeechLoadConfigSchema.strict()
  ])
  .superRefine(refineChatterboxTokenizerAssets)

// Cancel targeting. Both TTS handlers declare `cancel: { scope: 'model', hard:
// true }`, which the runtime only honours for requests registered in the
// request registry — so the id has to reach the engine on the request.
const ttsRequestIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Client-generated id for targeting this run with `cancel({ requestId })`.')

// Per-request voice controls the addon takes on `run()`, `runStream()` and
// `runStreaming()` alike. A request carries only an opaque modelId, so the
// engine check (CosyVoice3 for `instruct`, Audio8 for the reference pair)
// happens in the op once the model is known; the shape rules below hold on
// every engine.
const ttsRequestVoiceFieldsShape = {
  instruct: ttsCosyvoice3InstructSchema
    .optional()
    .describe(
      'CosyVoice3 only: natural-language control for this synthesis (a structured object with one of dialect / volume / style, or a raw instruction string), replacing the loaded `instruct`, `emotion` or `pace`. One conditioning control per synthesis.'
    ),
  referenceAudioSrc: modelSrcInputSchema
    .optional()
    .describe(
      'Audio8 only: reference recording to clone for this request, replacing the loaded voice; requires `referenceText` and a loaded codec encoder (`audio8CodecEncoderModelSrc`). A remote source that is not cached yet downloads inside the request, which holds the model until it finishes: pre-fetch it with `downloadAsset()` or pass a local path.'
    ),
  // Trimmed like the load-time referenceText: a whitespace-only transcript
  // would reach the engine as a non-empty value.
  referenceText: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Audio8 only: transcript of the reference recording. With `referenceAudioSrc`, what that recording says; alone, it corrects the transcript of the loaded recording.'
    )
}

type TtsRequestVoiceRefinementInput = {
  instruct?: unknown
  referenceAudioSrc?: ModelSrcInput | undefined
  referenceText?: string | undefined
  emotion?: string | undefined
  pace?: string | undefined
}

// Mirrors the addon's per-call rules that hold regardless of the loaded
// engine: a per-call recording must bring its own transcript (the configured
// one describes a different recording), and `instruct` is a CosyVoice3
// control, so pairing it with an emotion or a non-moderate pace always breaks
// the one-instruction rule.
function refineTtsRequestVoiceFields(value: TtsRequestVoiceRefinementInput, ctx: z.RefinementCtx) {
  if (value.referenceAudioSrc !== undefined && value.referenceText === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceText'],
      message:
        'referenceText (the transcript of the reference recording) is required with referenceAudioSrc.'
    })
  }
  if (value.instruct === undefined) return
  const conflicting =
    value.emotion !== undefined
      ? 'emotion'
      : value.pace !== undefined && value.pace !== 'moderate'
        ? 'pace'
        : undefined
  if (conflicting !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [conflicting],
      message: `CosyVoice3 accepts one conditioning control per synthesis; got instruct and ${conflicting}. Set exactly one (pace "moderate" disengages the pace channel).`
    })
  }
}

const ttsClientParamsShape = {
  modelId: z.string(),
  requestId: ttsRequestIdSchema,
  inputType: z.string().default('text'),
  text: z.string().trim().min(1, 'text must not be empty or whitespace-only').optional(),
  stream: z.boolean().default(true),
  sentenceStream: z.boolean().default(false),
  sentenceStreamLocale: z.string().optional(),
  sentenceStreamMaxChunkScalars: z.number().positive().optional(),
  ...ttsParlerDescriptionFieldsShape,
  ...ttsRequestVoiceFieldsShape,
  ...ttsSoundEffectFieldsShape,
  ...ttsSpeechFieldsShape
}

function refineTtsRequest(
  value: z.infer<z.ZodObject<typeof ttsClientParamsShape>>,
  ctx: z.RefinementCtx
) {
  refineParlerDescriptionFields(value, ctx)
  refineTtsRequestVoiceFields(value, ctx)
  refineSpeechAudio(value, ctx)
  if ((value.replyVoice !== undefined) !== (value.replyVoiceSampleRate !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['replyVoiceSampleRate'],
      message: 'replyVoice and replyVoiceSampleRate must be supplied together.'
    })
  }
}

// Requests carry only an opaque modelId, so client-side validation cannot know
// which TTS engine is loaded. Description conflicts are intentionally rejected
// as malformed request shapes before the server performs engine compatibility
// validation in assertParlerJobOptionsSupported.
export const ttsClientParamsSchema = z.object(ttsClientParamsShape).superRefine(refineTtsRequest)

export const ttsRequestSchema = z
  .object({
    ...ttsClientParamsShape,
    type: z.literal('textToSpeech')
  })
  .superRefine(refineTtsRequest)

// Mirrors @qvac/tts-ggml's `RuntimeStats`, using the same field names as the
// transcription and audio-gen stats so a caller reads one vocabulary across
// the audio plugins. `audioDuration` keeps its existing name (the addon calls
// it `audioDurationMs`; both are milliseconds). `totalTime` is in SECONDS —
// `realTimeFactor` = `totalTime` * 1000 / `audioDuration`.
//
// The chunked paths (`stream: true`, `sentenceStream`, and the duplex session)
// run one native job per sentence. The addon's aggregate sums the four
// summable fields (totalTime, audioDuration, totalSamples, generatedFrames)
// and keeps the backend fields below and Audio8's two Core ML flags from the
// last sentence that reported them, so a chunked run reports where it ran
// just as batch synthesis (`stream: false`) does. A field no sentence
// reported stays absent.
// Milliseconds, like every other `*Ms` field below.
const ttsStageMsSchema = (stage: string) =>
  z.number().optional().describe(`${stage} wall time of the last synthesis, in milliseconds.`)

export const ttsStatsSchema = z.object({
  audioDuration: z.number().optional(),
  totalTime: z.number().optional(),
  realTimeFactor: z.number().optional(),
  firstAudioMs: z
    .number()
    .optional()
    .describe(
      'Milliseconds from the start of the run to the first audio, where the engine reports it; a chunked run keeps the first sentence’s value.'
    ),
  tokensPerSecond: z.number().optional(),
  totalSamples: z.number().optional(),
  // Audio8 (on a fixed 46 ms grid) and MOSS (12.5 per second) count codec
  // frames rather than tokens, and report them as the unit behind their
  // `tokensPerSecond`.
  generatedFrames: z.number().optional(),
  // Backend selection captured once at model load. `0` CPU / `1` GPU;
  // `backendId` codes the family (0 CPU, 1 Metal, 2 CUDA, 3 Vulkan, 4 OpenCL,
  // 5 WebGPU, 99 other GPU). The enhancer and denoiser fields report each
  // LavaSR stage separately and are `-1` when that stage is not loaded.
  backendDevice: z.number().optional(),
  backendId: z
    .number()
    .optional()
    .describe(
      'Backend family the engine ran on: `0` CPU, `1` Metal, `2` CUDA, `3` Vulkan, `4` OpenCL, `5` WebGPU, `99` other.'
    ),
  gpuUnsupported: z.number().optional(),
  enhancerBackendDevice: z.number().optional(),
  enhancerBackendId: z.number().optional(),
  denoiserBackendDevice: z
    .number()
    .optional()
    .describe('LavaSR denoiser device: `-1` not loaded, `0` CPU, `1` GPU, `2` Core ML-managed.'),
  denoiserBackendId: z
    .number()
    .optional()
    .describe('LavaSR denoiser backend family, same codes as `backendId`.'),
  codecSidecarLoaded: z
    .number()
    .optional()
    .describe(
      'Audio8 on macOS / iOS: `1` while the Core ML codec sidecar is attached, `0` without one or once a failing sidecar was retired.'
    ),
  codecOnCoreml: z
    .number()
    .optional()
    .describe(
      'Audio8: `1` when this synthesis ran its codec on the Core ML sidecar, `0` when it ran on the ggml backend `backendId` reports.'
    ),
  // Parler Core ML sidecars (macOS / iOS): availability flags keep the last
  // report, the "used" flags are 1 only when every reported sentence used the
  // stage. None of them says which hardware Core ML scheduled the work on.
  decoderSidecarLoaded: z
    .number()
    .optional()
    .describe(
      'Parler on macOS / iOS: `1` while the Core ML decoder sidecar is attached, `0` once a fallback retired it.'
    ),
  dacSidecarLoaded: z
    .number()
    .optional()
    .describe(
      'Parler on macOS / iOS: `1` while the Core ML DAC sidecar is attached, `0` once a fallback retired it.'
    ),
  decoderOnCoreml: z
    .number()
    .optional()
    .describe(
      'Parler: `1` when this synthesis ran its decoder steps on Core ML, `0` for ggml or a mixed run.'
    ),
  dacOnCoreml: z
    .number()
    .optional()
    .describe(
      'Parler: `1` when this synthesis ran its DAC on Core ML, `0` for ggml or a mixed run.'
    ),
  // Chatterbox stage timings and counters.
  t3Ms: ttsStageMsSchema('Chatterbox T3 decode'),
  s3genMs: ttsStageMsSchema('Chatterbox S3Gen + HiFT'),
  t3Tokens: z
    .number()
    .optional()
    .describe('Chatterbox: speech tokens T3 emitted in the last synthesis.'),
  // CosyVoice3 and Audio8: the engine's own wall time, the sum of its stages.
  stageTotalMs: z
    .number()
    .optional()
    .describe(
      'CosyVoice3 / Audio8: the engine’s own wall time for the last synthesis in milliseconds (the sum of its stages), excluding the addon’s post-processing.'
    ),
  // CosyVoice3 stage timings.
  lmPrefillMs: ttsStageMsSchema('CosyVoice3 LM prefill'),
  lmDecodeMs: ttsStageMsSchema('CosyVoice3 LM decode'),
  flowFrontendMs: ttsStageMsSchema('CosyVoice3 flow front-end'),
  ditEulerMs: ttsStageMsSchema('CosyVoice3 DiT Euler'),
  hiftF0Ms: ttsStageMsSchema('CosyVoice3 HiFT F0'),
  hiftSourceMs: ttsStageMsSchema('CosyVoice3 HiFT source'),
  hiftStftMs: ttsStageMsSchema('CosyVoice3 HiFT STFT'),
  hiftDecodeMs: ttsStageMsSchema('CosyVoice3 HiFT decode'),
  // CosyVoice3 work counters.
  decodeSteps: z.number().optional().describe('CosyVoice3: LM decode steps of the last synthesis.'),
  speechTokens: z
    .number()
    .optional()
    .describe('CosyVoice3: speech tokens generated in the last synthesis.'),
  flowFrames: z
    .number()
    .optional()
    .describe('CosyVoice3: flow frames in (prompt + generated) of the last synthesis.'),
  melFrames: z.number().optional().describe('CosyVoice3: mel frames out of the last synthesis.'),
  textIds: z
    .number()
    .optional()
    .describe('CosyVoice3: text ids in the LM prefill of the last synthesis.'),
  promptSpeechTokens: z
    .number()
    .optional()
    .describe('CosyVoice3: prompt speech tokens the LM continued from.'),
  // Audio8 stage timings.
  voiceEncodeMs: ttsStageMsSchema('Audio8 reference-voice encode'),
  promptMs: ttsStageMsSchema('Audio8 prompt build'),
  prefillMs: ttsStageMsSchema('Audio8 prefill'),
  sampleMs: ttsStageMsSchema('Audio8 sampling'),
  fastDecodeMs: ttsStageMsSchema('Audio8 fast (local) decoder'),
  slowDecodeMs: ttsStageMsSchema('Audio8 slow (global) decoder'),
  codecLatentMs: ttsStageMsSchema('Audio8 codec latent'),
  codecSynthMs: ttsStageMsSchema('Audio8 codec synthesis'),
  resampleMs: ttsStageMsSchema('Audio8 resample')
})

// The rate of `buffer`. It is not a constant of the engine: `outputSampleRate`
// and the LavaSR enhancer both move it, so a caller writing a WAV or feeding
// an audio device has to read it off the frame rather than assume 24/44.1 kHz.
const ttsResponseSampleRateSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Sample rate in Hz of the signed 16-bit mono PCM in `buffer`.')

// CosyVoice3 owns its speech-token trajectory and hands it back: with the PCM
// in batch synthesis, on a final `isLast` frame with no audio under native
// chunk streaming. One frame's array replays that one native synthesis through
// the load config's `forceSpeechTokens`; the sentence paths run one synthesis
// per sentence, so their arrays replay sentence by sentence, not joined.
const ttsResponseSpeechTokenIdsSchema = z
  .array(ttsSpeechTokenIdSchema)
  .optional()
  .describe(
    'CosyVoice3: the speech tokens of this native synthesis. Batch synthesis carries them with the PCM; native chunk streaming on a final `isLast` frame with no audio; the sentence paths once per sentence. Pass one array back as `forceSpeechTokens` to replay that synthesis (a joined sentence stream cannot be replayed as one).'
  )

export const ttsResponseSchema = z.object({
  type: z.literal('textToSpeech'),
  text: z.string().optional().describe('MOSS-Speech reply text, including text-only replies.'),
  buffer: z.array(z.number()),
  pcm: z
    .string()
    .optional()
    .describe(
      'Base64 of the little-endian signed 16-bit PCM of this frame. When present, `buffer` is empty and this field carries the samples; decode with `withDecodedTtsPcm`.'
    ),
  done: z.boolean().default(false),
  sampleRate: ttsResponseSampleRateSchema,
  stats: ttsStatsSchema.optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  sentenceChunk: z.string().optional(),
  isLast: z
    .boolean()
    .optional()
    .describe(
      'True on the final audio-bearing chunk of a pre-chunked synthesis. Absent when the chunk count is not known up front (streamed text in).'
    ),
  speechTokenIds: ttsResponseSpeechTokenIdsSchema,
  // On the terminal frame only: how the run ended. A run stopped by
  // `cancel()` ends cleanly with `cancelled` rather than as an error.
  stopReason: z.enum(['completed', 'cancelled']).optional()
})

// Internal: kept un-exported to present a single request-schema surface to
// consumers. The inferred `TextToSpeechStreamClientParams` type below uses
// this shape via `typeof`, no runtime export needed.
const textToSpeechStreamRequestBaseShape = {
  modelId: z.string(),
  requestId: ttsRequestIdSchema,
  inputType: z.string().default('text'),
  accumulateSentences: z.boolean().optional(),
  sentenceDelimiterPreset: z.enum(TTS_SENTENCE_DELIMITER_PRESETS).optional(),
  maxBufferScalars: z.number().positive().optional(),
  flushAfterMs: z.number().positive().optional(),
  ...ttsParlerDescriptionFieldsShape,
  ...ttsRequestVoiceFieldsShape
}

function refineTextToSpeechStreamRequest(
  value: z.infer<z.ZodObject<typeof textToSpeechStreamRequestBaseShape>>,
  ctx: z.RefinementCtx
) {
  refineParlerDescriptionFields(value, ctx)
  refineTtsRequestVoiceFields(value, ctx)
}

export const textToSpeechStreamRequestSchema = z
  .object({
    ...textToSpeechStreamRequestBaseShape,
    type: z.literal('textToSpeechStream')
  })
  .superRefine(refineTextToSpeechStreamRequest)

export const textToSpeechStreamResponseSchema = z.object({
  type: z.literal('textToSpeechStream'),
  buffer: z.array(z.number()),
  pcm: z
    .string()
    .optional()
    .describe(
      'Base64 of the little-endian signed 16-bit PCM of this frame. When present, `buffer` is empty and this field carries the samples; decode with `withDecodedTtsPcm`.'
    ),
  done: z.boolean().default(false),
  sampleRate: ttsResponseSampleRateSchema,
  stats: ttsStatsSchema.optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  sentenceChunk: z.string().optional(),
  isLast: z
    .boolean()
    .optional()
    .describe(
      'True on the final audio-bearing chunk of a pre-chunked synthesis. Absent when the chunk count is not known up front (streamed text in).'
    ),
  speechTokenIds: ttsResponseSpeechTokenIdsSchema,
  // On the terminal frame only: how the run ended. A run stopped by
  // `cancel()` ends cleanly with `cancelled` rather than as an error.
  stopReason: z.enum(['completed', 'cancelled']).optional()
})

export type TtsEngine = (typeof TTS_ENGINES)[number]
export type TtsSentenceDelimiterPreset = (typeof TTS_SENTENCE_DELIMITER_PRESETS)[number]
export type TtsLanguage = (typeof TTS_LANGUAGES)[number]
export type TtsChatterboxLanguage = (typeof TTS_CHATTERBOX_LANGUAGES)[number]
export type TtsSupertonicLanguage = (typeof TTS_SUPERTONIC_LANGUAGES)[number]
export type TtsParlerEmotion = (typeof TTS_PARLER_EMOTIONS)[number]
export type TtsPace = (typeof TTS_PACES)[number]
export type TtsCosyvoice3Emotion = (typeof TTS_COSYVOICE3_EMOTIONS)[number]
export type TtsCosyvoice3Instruct = z.infer<typeof ttsCosyvoice3InstructSchema>
export type TtsChatterboxLoadConfig = z.infer<typeof ttsChatterboxLoadConfigSchema>
export type TtsSupertonicLoadConfig = z.infer<typeof ttsSupertonicLoadConfigSchema>
export type TtsParlerLoadConfig = z.infer<typeof ttsParlerLoadConfigSchema>
export type TtsCosyvoice3LoadConfig = z.infer<typeof ttsCosyvoice3LoadConfigSchema>
export type TtsAudio8LoadConfig = z.infer<typeof ttsAudio8LoadConfigSchema>
export type TtsMossSoundEffectLoadConfig = z.infer<typeof ttsMossSoundEffectLoadConfigSchema>
export type TtsMossSpeechLoadConfig = z.infer<typeof ttsMossSpeechLoadConfigSchema>
export type TtsMossSoundEffectRuntimeConfig = z.infer<typeof ttsMossSoundEffectRuntimeConfigSchema>
export type TtsMossSpeechRuntimeConfig = z.infer<typeof ttsMossSpeechRuntimeConfigSchema>
export type TtsMossLoadConfig = z.infer<typeof ttsMossLoadConfigSchema>
export type TtsLoadConfig = z.infer<typeof ttsLoadConfigSchema>
/** @deprecated Use {@link TtsChatterboxLoadConfig} */
export type TtsChatterboxConfig = TtsChatterboxLoadConfig
/** @deprecated Use {@link TtsSupertonicLoadConfig} */
export type TtsSupertonicConfig = TtsSupertonicLoadConfig
export type TtsChatterboxRuntimeConfig = z.infer<typeof ttsChatterboxRuntimeConfigSchema>
export type TtsSupertonicRuntimeConfig = z.infer<typeof ttsSupertonicRuntimeConfigSchema>
export type TtsParlerRuntimeConfig = z.infer<typeof ttsParlerRuntimeConfigSchema>
export type TtsCosyvoice3RuntimeConfig = z.infer<typeof ttsCosyvoice3RuntimeConfigSchema>
export type TtsAudio8RuntimeConfig = z.infer<typeof ttsAudio8RuntimeConfigSchema>
export type TtsMossRuntimeConfig = z.infer<typeof ttsMossRuntimeConfigSchema>
export type TtsRuntimeConfig = z.infer<typeof ttsRuntimeConfigSchema>
export type TtsConfig = z.infer<typeof ttsConfigSchema>
export type TtsClientParamsInput = z.input<typeof ttsClientParamsSchema>
export type TtsClientParams = z.output<typeof ttsClientParamsSchema>
export type TtsRequest = z.infer<typeof ttsRequestSchema>
export type TtsResponse = z.infer<typeof ttsResponseSchema>
export type TtsStats = z.infer<typeof ttsStatsSchema>

export type TtsSentenceChunkUpdate = {
  buffer: number[]
  sampleRate?: number
  chunkIndex?: number
  sentenceChunk?: string
  isLast?: boolean
  /**
   * CosyVoice3: the speech tokens of this sentence's synthesis, when the frame
   * carried them. Each array replays its own sentence through `forceSpeechTokens`.
   */
  speechTokenIds?: number[]
}

export type TextToSpeechStreamRequest = z.infer<typeof textToSpeechStreamRequestSchema>
export type TextToSpeechStreamResponse = z.infer<typeof textToSpeechStreamResponseSchema>

export type TextToSpeechStreamClientParams = z.output<
  z.ZodObject<typeof textToSpeechStreamRequestBaseShape>
>

export interface TextToSpeechStreamResult {
  /** MOSS-Speech reply text; resolved when the run finishes. */
  text: Promise<string | undefined>
  bufferStream: AsyncGenerator<number>
  /**
   * The PCM of `bufferStream` as one `Int16Array` per response frame: the
   * engines' signed 16-bit mono samples, exact and half the size of a float
   * view (scale by 1/32768 for Web Audio). Shares the run with `bufferStream`
   * in plain streaming mode, so iterate one of the two. Empty when
   * `stream: false`.
   */
  chunkStream: AsyncGenerator<Int16Array>
  chunkUpdates?: AsyncGenerator<TtsSentenceChunkUpdate>
  buffer: Promise<number[]>
  done: Promise<boolean>
  /**
   * Id of this run, available synchronously. Pass it to
   * `cancel({ requestId })` to stop synthesis — abandoning `bufferStream`
   * stops delivery but leaves the native job running to completion.
   */
  requestId: string
  /**
   * Sample rate of the PCM in `bufferStream` / `buffer`, resolved from the
   * first audio frame. `undefined` when the run produced no audio. Read it
   * rather than assuming the engine default: `outputSampleRate` and the LavaSR
   * enhancer both change it.
   */
  sampleRate: Promise<number | undefined>
  /**
   * Runtime statistics from the final frame (RTF, audio duration, selected
   * backend). `undefined` when the run ended before the addon reported any.
   */
  stats: Promise<TtsStats | undefined>
  /**
   * How the run ended: `'cancelled'` when it was stopped by `cancel()`,
   * `'completed'` otherwise. `undefined` if no terminal frame was seen.
   */
  stopReason: Promise<'completed' | 'cancelled' | undefined>
  /**
   * CosyVoice3: every speech token the run emitted, in order (one native
   * synthesis per batch run; one array per sentence, concatenated, on the
   * chunked paths). `undefined` when no frame carried any.
   *
   * Replay through the load config's `forceSpeechTokens` works for ONE native
   * synthesis: a batch run, a native chunk stream, or a single sentence's
   * array from `chunkUpdates`. `forceSpeechTokens` is fixed at load and every
   * sentence of a chunked run starts its own synthesis with that same array,
   * so replaying this concatenation does not restore the sentences it joined.
   */
  speechTokenIds: Promise<number[] | undefined>
}

export interface TextToSpeechStreamSession {
  write(textFragment: string | Uint8Array): void
  end(): void
  destroy(): void
  /**
   * Id of this session, for `cancel({ requestId })`. `destroy()` tears down
   * the streams but leaves the native job running; cancelling stops it.
   */
  requestId: string
  [Symbol.asyncIterator](): AsyncIterator<TextToSpeechStreamResponse>
}
