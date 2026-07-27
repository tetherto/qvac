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
const ttsIntegerSchema = z.number().int()
const ttsNonNegativeIntegerSchema = ttsIntegerSchema.nonnegative()
const ttsPositiveIntegerSchema = ttsIntegerSchema.positive()
const ttsInt32Schema = ttsIntegerSchema.min(-2147483648).max(2147483647)
const ttsNonNegativeInt32Schema = ttsInt32Schema.nonnegative()
const ttsPositiveInt32Schema = ttsInt32Schema.positive()

// Desired output sample rate in Hz. Matches the @qvac/tts-ggml addon's
// accepted range; omit to keep the engine's native rate (or 48 kHz when the
// LavaSR enhancer is active). Supertonic-only: the Chatterbox engine does not
// yet resample its output, so the field is not exposed on that config.
const ttsOutputSampleRateSchema = ttsIntegerSchema.min(8000).max(192000)

const ttsParlerDescriptionFieldsShape = {
  description: z.string().min(1).optional(),
  voiceDescription: z.string().min(1).optional(),
  voice: z.string().min(1).optional(),
  emotion: ttsParlerEmotionSchema.optional(),
  pitch: z.string().min(1).optional(),
  pace: z.string().min(1).optional(),
  expressivity: z.string().min(1).optional(),
  noise: z.string().min(1).optional(),
  reverb: z.string().min(1).optional(),
  quality: z.string().min(1).optional()
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
  ttsEngine: z.literal('chatterbox'),
  language: ttsChatterboxLanguageSchema,
  voice: z.string().optional(),
  useGPU: z.boolean().optional(),
  // Chatterbox-only native streaming controls.
  streamChunkTokens: ttsNonNegativeIntegerSchema.optional(),
  streamFirstChunkTokens: ttsNonNegativeIntegerSchema.optional(),
  cfmSteps: ttsNonNegativeIntegerSchema.optional(),
  cfgRate: z.number().nonnegative().optional(),
  threads: ttsPositiveIntegerSchema.optional(),
  nGpuLayers: ttsIntegerSchema.optional(),
  seed: ttsIntegerSchema.optional()
})

export const ttsSupertonicRuntimeConfigSchema = z.object({
  ttsEngine: z.literal('supertonic'),
  language: ttsSupertonicLanguageSchema,
  voice: z.string().optional(),
  ttsSpeed: z.number().optional(),
  ttsNumInferenceSteps: z.number().optional(),
  useGPU: z.boolean().optional(),
  outputSampleRate: ttsOutputSampleRateSchema.optional(),
  vulkanCacheDir: z.string().min(1).optional()
})

export const ttsParlerRuntimeConfigSchema = z
  .object({
    ttsEngine: z.literal('parler'),
    ...ttsParlerDescriptionFieldsShape,
    useGPU: z.boolean().optional(),
    outputSampleRate: ttsOutputSampleRateSchema.optional(),
    streamChunkTokens: ttsNonNegativeInt32Schema.optional(),
    streamFirstChunkTokens: ttsNonNegativeInt32Schema.optional(),
    threads: ttsPositiveInt32Schema.optional(),
    nGpuLayers: ttsInt32Schema.optional(),
    seed: ttsInt32Schema.optional(),
    temperature: z.number().nonnegative().optional(),
    topK: ttsNonNegativeInt32Schema.optional(),
    topP: z.number().positive().max(1).optional(),
    maxFrames: z.union([z.literal(0), ttsInt32Schema.min(10)]).optional(),
    minNewTokens: ttsInt32Schema.min(-1).optional(),
    normalizeNumbers: z.boolean().optional()
  })
  .superRefine(refineParlerRuntimeConfig)

export const ttsRuntimeConfigSchema = z.discriminatedUnion('ttsEngine', [
  ttsChatterboxRuntimeConfigSchema,
  ttsSupertonicRuntimeConfigSchema,
  ttsParlerRuntimeConfigSchema
])

// Optional LavaSR post-processing model sources, shared across engines. Supply
// the enhancer GGUF to bandwidth-extend the output to 48 kHz, and/or the
// denoiser GGUF (runs before the enhancer, rate-preserving). Resolved to
// artifacts by the plugin's resolveConfig and forwarded to @qvac/tts-ggml.
const ttsLavasrLoadFieldsShape = {
  lavasrEnhancerModelSrc: modelSrcInputSchema.optional(),
  lavasrDenoiserModelSrc: modelSrcInputSchema.optional()
}

export const ttsChatterboxLoadConfigSchema = ttsChatterboxRuntimeConfigSchema.extend({
  // Optional at schema time so legacy ONNX configs (no s3genModelSrc) reach
  // the plugin's resolveConfig and raise LegacyTtsModelDeprecatedError.
  s3genModelSrc: modelSrcInputSchema.optional(),
  referenceAudioSrc: modelSrcInputSchema.optional(),
  mecabDictSrc: modelSrcInputSchema.optional(),
  cangjieTsvSrc: modelSrcInputSchema.optional(),
  ...ttsLavasrLoadFieldsShape
})

export const ttsSupertonicLoadConfigSchema = ttsSupertonicRuntimeConfigSchema.extend({
  ...ttsLavasrLoadFieldsShape
})

export const ttsParlerLoadConfigSchema = ttsParlerRuntimeConfigSchema

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
    ttsParlerLoadConfigSchema
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
    ttsParlerLoadConfigSchema.strict()
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
export type TtsChatterboxLoadConfig = z.infer<typeof ttsChatterboxLoadConfigSchema>
export type TtsSupertonicLoadConfig = z.infer<typeof ttsSupertonicLoadConfigSchema>
export type TtsParlerLoadConfig = z.infer<typeof ttsParlerLoadConfigSchema>
export type TtsLoadConfig = z.infer<typeof ttsLoadConfigSchema>
/** @deprecated Use {@link TtsChatterboxLoadConfig} */
export type TtsChatterboxConfig = TtsChatterboxLoadConfig
/** @deprecated Use {@link TtsSupertonicLoadConfig} */
export type TtsSupertonicConfig = TtsSupertonicLoadConfig
export type TtsChatterboxRuntimeConfig = z.infer<typeof ttsChatterboxRuntimeConfigSchema>
export type TtsSupertonicRuntimeConfig = z.infer<typeof ttsSupertonicRuntimeConfigSchema>
export type TtsParlerRuntimeConfig = z.infer<typeof ttsParlerRuntimeConfigSchema>
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
