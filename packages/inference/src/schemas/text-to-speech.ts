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
const ttsIntegerSchema = z.number().int()
const ttsNonNegativeIntegerSchema = ttsIntegerSchema.nonnegative()
const ttsPositiveIntegerSchema = ttsIntegerSchema.positive()
const ttsInt32Schema = ttsIntegerSchema.min(-2147483648).max(2147483647)
const ttsNonNegativeInt32Schema = ttsInt32Schema.nonnegative()
const ttsPositiveInt32Schema = ttsInt32Schema.positive()

// Describe text shared by fields repeated across engine arms.
const TTS_USE_GPU_DESC =
  'Route inference through a GPU backend (Metal / Vulkan / OpenCL) when available. Default false.'
const TTS_SEED_DESC =
  'RNG seed for the engine’s stochastic stages (e.g. Chatterbox CFM/SineGen, Supertonic latent generation).'
const TTS_THREADS_DESC = 'CPU thread count; overrides the hardware default.'
const TTS_NGPU_LAYERS_DESC =
  'Model layers to offload to the GPU backend (99 = all). Only relevant when `useGPU` is set.'
const TTS_STREAM_CHUNK_TOKENS_DESC =
  'Speech tokens per native streaming chunk; 0 disables native chunk streaming.'
const TTS_STREAM_FIRST_CHUNK_TOKENS_DESC =
  'Smaller first streaming chunk for lower first-audio latency.'
const TTS_TEMPERATURE_DESC =
  'Sampling temperature; unset defers to the engine default (Parler 1.0, Audio8 0.7).'
const TTS_TOP_K_DESC = 'Top-k sampling cutoff; unset defers to the engine default (50).'
const TTS_TOP_P_DESC =
  'Top-p (nucleus) sampling cutoff (0 < p ≤ 1); unset defers to the engine default.'
const TTS_MAX_FRAMES_DESC =
  'Generation-length cap in decoder frames; 0 = engine default (Parler ≈86 frames/s, Audio8 ≈21.5).'

// Desired output sample rate in Hz. Matches the @qvac/tts-ggml addon's
// accepted range; omit to keep the engine's native rate (or 48 kHz when the
// LavaSR enhancer is active). Supertonic-only: the Chatterbox engine does not
// yet resample its output, so the field is not exposed on that config.
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
}

function refineParlerRuntimeConfig(config: TtsParlerRuntimeRefinementInput, ctx: z.RefinementCtx) {
  refineParlerDescriptionFields(config, ctx)

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
        'Parler native streaming emits at 44100 Hz; omit outputSampleRate, use 44100, or disable native streaming.'
    })
  }
}

export const ttsChatterboxRuntimeConfigSchema = z.object({
  ttsEngine: z
    .literal('chatterbox')
    .describe('TTS engine: Chatterbox (multilingual, voice cloning).'),
  language: ttsChatterboxLanguageSchema.describe('Language code. Default `en`.'),
  voice: z
    .string()
    .optional()
    .describe('Ignored by Chatterbox; use `referenceAudioSrc` for voice cloning.'),
  useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
  // Chatterbox-only native streaming controls.
  streamChunkTokens: ttsNonNegativeIntegerSchema.optional().describe(TTS_STREAM_CHUNK_TOKENS_DESC),
  streamFirstChunkTokens: ttsNonNegativeIntegerSchema
    .optional()
    .describe(TTS_STREAM_FIRST_CHUNK_TOKENS_DESC),
  cfmSteps: ttsNonNegativeIntegerSchema
    .optional()
    .describe('Chatterbox CFM Euler step count. Default 2.'),
  cfgRate: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      'Chatterbox S3Gen classifier-free-guidance rate; `0` skips the unconditioned pass, a positive value overrides the model’s baked rate. Omit to keep the baked rate.'
    ),
  threads: ttsPositiveIntegerSchema.optional().describe(TTS_THREADS_DESC),
  nGpuLayers: ttsIntegerSchema.optional().describe(TTS_NGPU_LAYERS_DESC),
  seed: ttsIntegerSchema.optional().describe(TTS_SEED_DESC)
})

export const ttsSupertonicRuntimeConfigSchema = z.object({
  ttsEngine: z.literal('supertonic').describe('TTS engine: Supertonic.'),
  language: ttsSupertonicLanguageSchema.describe('Language code. Default `en`.'),
  voice: z.string().optional().describe('Supertonic baked voice id, e.g. `F1` or `M1`.'),
  ttsSpeed: z
    .number()
    .optional()
    .describe(
      'Speech-rate / duration multiplier (1.0 = unchanged, <1 slower, >1 faster). Supertonic scales its native duration predictor.'
    ),
  ttsNumInferenceSteps: z
    .number()
    .optional()
    .describe('Supertonic vector-estimator CFM steps; 0 uses the GGUF default.'),
  useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
  outputSampleRate: ttsOutputSampleRateSchema.optional(),
  vulkanCacheDir: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Supertonic + `useGPU` only: directory where the Vulkan backend persists its compiled pipeline cache.'
    )
})

export const ttsParlerRuntimeConfigSchema = z
  .object({
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
      .describe('Parler prompt digit expansion (engine default: enabled).')
  })
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
      'Natural-language control: a structured object (one of dialect / volume / style) or a raw instruction string. One conditioning control per synthesis.'
    ),
  useGPU: z.boolean().optional().describe(TTS_USE_GPU_DESC),
  outputSampleRate: ttsOutputSampleRateSchema.optional(),
  streamChunkTokens: ttsNonNegativeInt32Schema.optional().describe(TTS_STREAM_CHUNK_TOKENS_DESC),
  streamFirstChunkTokens: ttsNonNegativeInt32Schema
    .optional()
    .describe(TTS_STREAM_FIRST_CHUNK_TOKENS_DESC),
  threads: ttsPositiveInt32Schema.optional().describe(TTS_THREADS_DESC),
  nGpuLayers: ttsInt32Schema.optional().describe(TTS_NGPU_LAYERS_DESC),
  seed: ttsInt32Schema.optional().describe(TTS_SEED_DESC)
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
  seed: ttsInt32Schema.optional().describe(TTS_SEED_DESC)
}

export const ttsAudio8RuntimeConfigSchema = z.object(ttsAudio8RuntimeConfigShape)

export const ttsRuntimeConfigSchema = z.discriminatedUnion('ttsEngine', [
  ttsChatterboxRuntimeConfigSchema,
  ttsSupertonicRuntimeConfigSchema,
  ttsParlerRuntimeConfigSchema,
  ttsCosyvoice3RuntimeConfigSchema,
  ttsAudio8RuntimeConfigSchema
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
    )
}

export const ttsChatterboxLoadConfigSchema = ttsChatterboxRuntimeConfigSchema.extend({
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

export const ttsSupertonicLoadConfigSchema = ttsSupertonicRuntimeConfigSchema.extend({
  ...ttsLavasrLoadFieldsShape
})

export const ttsParlerLoadConfigSchema = ttsParlerRuntimeConfigSchema

type TtsCosyvoice3LoadRefinementInput = TtsCosyvoice3RefinementInput & {
  lavasrEnhancerModelSrc?: ModelSrcInput | undefined
  lavasrDenoiserModelSrc?: ModelSrcInput | undefined
}

function refineCosyvoice3LoadConfig(
  config: TtsCosyvoice3LoadRefinementInput,
  ctx: z.RefinementCtx
) {
  refineCosyvoice3ConditioningControls(config, ctx)

  // With the LavaSR enhancer active the addon resamples seam-free, so the
  // 24 kHz native-streaming restriction only applies without it.
  if (config.lavasrEnhancerModelSrc === undefined) {
    refineCosyvoice3NativeStreamingRate(config, ctx)
  }

  if (config.lavasrDenoiserModelSrc !== undefined && (config.streamChunkTokens ?? 0) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['lavasrDenoiserModelSrc'],
      message:
        'The LavaSR denoiser is batch-only; disable native streaming (streamChunkTokens) to use it.'
    })
  }
}

// CosyVoice3 loads from a model *directory* (LLM/flow/HiFT GGUFs plus
// voice.gguf, vocab.json and merges.txt). The primary `modelSrc` is the LLM
// GGUF, whose registry companion set co-locates the remaining files, so the
// load config only adds the optional LavaSR post-processing sources.
export const ttsCosyvoice3LoadConfigSchema = z
  .object({
    ...ttsCosyvoice3RuntimeConfigShape,
    ...ttsLavasrLoadFieldsShape
  })
  .superRefine(refineCosyvoice3LoadConfig)

type TtsAudio8LoadRefinementInput = {
  referenceText?: string | undefined
  audio8CodecEncoderModelSrc?: ModelSrcInput | undefined
  referenceAudioSrc?: ModelSrcInput | undefined
}

function refineAudio8LoadConfig(config: TtsAudio8LoadRefinementInput, ctx: z.RefinementCtx) {
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

type TtsTokenizerAssetRefinementInput = {
  ttsEngine?: string
  language?: string
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
    ttsAudio8LoadConfigSchema
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
    ttsAudio8LoadConfigSchema.strict()
  ])
  .superRefine(refineChatterboxTokenizerAssets)

const ttsClientParamsShape = {
  modelId: z.string(),
  inputType: z.string().default('text'),
  text: z.string().trim().min(1, 'text must not be empty or whitespace-only'),
  stream: z.boolean().default(true),
  sentenceStream: z.boolean().default(false),
  sentenceStreamLocale: z.string().optional(),
  sentenceStreamMaxChunkScalars: z.number().positive().optional(),
  ...ttsParlerDescriptionFieldsShape
}

// Requests carry only an opaque modelId, so client-side validation cannot know
// which TTS engine is loaded. Description conflicts are intentionally rejected
// as malformed request shapes before the server performs engine compatibility
// validation in assertParlerJobOptionsSupported.
export const ttsClientParamsSchema = z
  .object(ttsClientParamsShape)
  .superRefine(refineParlerDescriptionFields)

export const ttsRequestSchema = z
  .object({
    ...ttsClientParamsShape,
    type: z.literal('textToSpeech')
  })
  .superRefine(refineParlerDescriptionFields)

export const ttsStatsSchema = z.object({
  audioDuration: z.number().optional(),
  totalSamples: z.number().optional(),
  enhancerBackendDevice: z.number().optional(),
  enhancerBackendId: z.number().optional()
})

export const ttsResponseSchema = z.object({
  type: z.literal('textToSpeech'),
  buffer: z.array(z.number()),
  done: z.boolean().default(false),
  stats: ttsStatsSchema.optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  sentenceChunk: z.string().optional()
})

// Internal: kept un-exported to present a single request-schema surface to
// consumers. The inferred `TextToSpeechStreamClientParams` type below uses
// this shape via `typeof`, no runtime export needed.
const textToSpeechStreamRequestBaseShape = {
  modelId: z.string(),
  inputType: z.string().default('text'),
  accumulateSentences: z.boolean().optional(),
  sentenceDelimiterPreset: z.enum(['latin', 'cjk', 'multilingual']).optional(),
  maxBufferScalars: z.number().positive().optional(),
  flushAfterMs: z.number().positive().optional(),
  ...ttsParlerDescriptionFieldsShape
}

export const textToSpeechStreamRequestSchema = z
  .object({
    ...textToSpeechStreamRequestBaseShape,
    type: z.literal('textToSpeechStream')
  })
  .superRefine(refineParlerDescriptionFields)

export const textToSpeechStreamResponseSchema = z.object({
  type: z.literal('textToSpeechStream'),
  buffer: z.array(z.number()),
  done: z.boolean().default(false),
  stats: ttsStatsSchema.optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  sentenceChunk: z.string().optional()
})

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
export type TtsRuntimeConfig = z.infer<typeof ttsRuntimeConfigSchema>
export type TtsConfig = z.infer<typeof ttsConfigSchema>
export type TtsClientParamsInput = z.input<typeof ttsClientParamsSchema>
export type TtsClientParams = z.output<typeof ttsClientParamsSchema>
export type TtsRequest = z.infer<typeof ttsRequestSchema>
export type TtsResponse = z.infer<typeof ttsResponseSchema>
export type TtsStats = z.infer<typeof ttsStatsSchema>

export type TtsSentenceChunkUpdate = {
  buffer: number[]
  chunkIndex?: number
  sentenceChunk?: string
}

export type TextToSpeechStreamRequest = z.infer<typeof textToSpeechStreamRequestSchema>
export type TextToSpeechStreamResponse = z.infer<typeof textToSpeechStreamResponseSchema>

export type TextToSpeechStreamClientParams = z.output<
  z.ZodObject<typeof textToSpeechStreamRequestBaseShape>
>

export interface TextToSpeechStreamResult {
  bufferStream: AsyncGenerator<number>
  chunkUpdates?: AsyncGenerator<TtsSentenceChunkUpdate>
  buffer: Promise<number[]>
  done: Promise<boolean>
}

export interface TextToSpeechStreamSession {
  write(textFragment: string | Uint8Array): void
  end(): void
  destroy(): void
  [Symbol.asyncIterator](): AsyncIterator<TextToSpeechStreamResponse>
}
