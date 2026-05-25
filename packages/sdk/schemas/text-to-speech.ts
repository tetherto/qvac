import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

// TTS supported languages based on available models
export const TTS_LANGUAGES = [
  "en", // English
  "es", // Spanish
  "de", // German
  "it", // Italian
] as const;

const ttsLanguageSchema = z.enum(TTS_LANGUAGES);

export const ttsChatterboxRuntimeConfigSchema = z.object({
  ttsEngine: z.literal("chatterbox"),
  language: ttsLanguageSchema,
  voice: z.string().optional(),
  useGPU: z.boolean().optional(),
});

export const ttsSupertonicRuntimeConfigSchema = z.object({
  ttsEngine: z.literal("supertonic"),
  language: ttsLanguageSchema,
  voice: z.string().optional(),
  ttsSpeed: z.number().optional(),
  ttsNumInferenceSteps: z.number().optional(),
  ttsSupertonicMultilingual: z.boolean().optional(),
  useGPU: z.boolean().optional(),
});

export const ttsRuntimeConfigSchema = z.union([
  ttsChatterboxRuntimeConfigSchema,
  ttsSupertonicRuntimeConfigSchema,
]);

export const ttsChatterboxLoadConfigSchema = ttsChatterboxRuntimeConfigSchema.extend({
  s3genModelSrc: modelSrcInputSchema,
  referenceAudioSrc: modelSrcInputSchema.optional(),
});

export const ttsSupertonicLoadConfigSchema = ttsSupertonicRuntimeConfigSchema;

export const ttsLoadConfigSchema = z.union([
  ttsChatterboxLoadConfigSchema,
  ttsSupertonicLoadConfigSchema,
]);

// === Legacy ONNX modelConfig fields (deprecated) ===
//
// Pre-@qvac/tts-ggml multi-file ONNX `modelConfig` fields are kept ONLY so
// callers migrating from earlier SDK versions hit a structured
// `LegacyTtsModelDeprecatedError` from the TTS plugin's `resolveConfig`,
// rather than a generic Zod `Unrecognized key` error.
export const LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS = [
  "ttsTokenizerSrc",
  "ttsSpeechEncoderSrc",
  "ttsEmbedTokensSrc",
  "ttsConditionalDecoderSrc",
  "ttsLanguageModelSrc",
  "ttsTextEncoderSrc",
  "ttsDurationPredictorSrc",
  "ttsVectorEstimatorSrc",
  "ttsVocoderSrc",
  "ttsUnicodeIndexerSrc",
  "ttsTtsConfigSrc",
  "ttsVoiceStyleSrc",
] as const;

const legacyTtsOnnxFieldsShape =
  LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS.reduce<
    Record<string, z.ZodOptional<z.ZodUnknown>>
  >((acc, name) => {
    acc[name] = z.unknown().optional();
    return acc;
  }, {});

const legacyTtsOnnxFields = z.object(legacyTtsOnnxFieldsShape);

export const ttsConfigSchema = z.union([
  ttsChatterboxLoadConfigSchema.merge(legacyTtsOnnxFields),
  ttsSupertonicLoadConfigSchema.merge(legacyTtsOnnxFields),
]);

export const ttsClientParamsSchema = z.object({
  modelId: z.string(),
  inputType: z.string().default("text"),
  text: z.string().trim().min(1, "text must not be empty or whitespace-only"),
  stream: z.boolean().default(true),
  sentenceStream: z.boolean().default(false),
  sentenceStreamLocale: z.string().optional(),
  sentenceStreamMaxChunkScalars: z.number().positive().optional(),
});

export const ttsRequestSchema = ttsClientParamsSchema.extend({
  type: z.literal("textToSpeech"),
});

export const ttsStatsSchema = z.object({
  audioDuration: z.number().optional(),
  totalSamples: z.number().optional(),
});

export const ttsResponseSchema = z.object({
  type: z.literal("textToSpeech"),
  buffer: z.array(z.number()),
  done: z.boolean().default(false),
  stats: ttsStatsSchema.optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  sentenceChunk: z.string().optional(),
});

// Internal: kept un-exported to present a single request-schema surface to
// consumers. The inferred `TextToSpeechStreamClientParams` type below uses
// this shape via `typeof`, no runtime export needed.
const textToSpeechStreamRequestBaseSchema = z.object({
  modelId: z.string(),
  inputType: z.string().default("text"),
  accumulateSentences: z.boolean().optional(),
  sentenceDelimiterPreset: z.enum(["latin", "cjk", "multilingual"]).optional(),
  maxBufferScalars: z.number().positive().optional(),
  flushAfterMs: z.number().positive().optional(),
});

export const textToSpeechStreamRequestSchema =
  textToSpeechStreamRequestBaseSchema.extend({
    type: z.literal("textToSpeechStream"),
  });

export const textToSpeechStreamResponseSchema = z.object({
  type: z.literal("textToSpeechStream"),
  buffer: z.array(z.number()),
  done: z.boolean().default(false),
  stats: ttsStatsSchema.optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  sentenceChunk: z.string().optional(),
});

export type TtsLanguage = (typeof TTS_LANGUAGES)[number];
export type TtsChatterboxLoadConfig = z.infer<typeof ttsChatterboxLoadConfigSchema>;
export type TtsSupertonicLoadConfig = z.infer<typeof ttsSupertonicLoadConfigSchema>;
export type TtsLoadConfig = z.infer<typeof ttsLoadConfigSchema>;
/** @deprecated Use {@link TtsChatterboxLoadConfig} */
export type TtsChatterboxConfig = TtsChatterboxLoadConfig;
/** @deprecated Use {@link TtsSupertonicLoadConfig} */
export type TtsSupertonicConfig = TtsSupertonicLoadConfig;
export type TtsChatterboxRuntimeConfig = z.infer<
  typeof ttsChatterboxRuntimeConfigSchema
>;
export type TtsSupertonicRuntimeConfig = z.infer<
  typeof ttsSupertonicRuntimeConfigSchema
>;
export type TtsRuntimeConfig = z.infer<typeof ttsRuntimeConfigSchema>;
export type TtsConfig = z.infer<typeof ttsConfigSchema>;
export type TtsClientParamsInput = z.input<typeof ttsClientParamsSchema>;
export type TtsClientParams = z.output<typeof ttsClientParamsSchema>;
export type TtsRequest = z.infer<typeof ttsRequestSchema>;
export type TtsResponse = z.infer<typeof ttsResponseSchema>;
export type TtsStats = z.infer<typeof ttsStatsSchema>;

export type TtsSentenceChunkUpdate = {
  buffer: number[];
  chunkIndex?: number;
  sentenceChunk?: string;
};

export type TextToSpeechStreamRequest = z.infer<
  typeof textToSpeechStreamRequestSchema
>;
export type TextToSpeechStreamResponse = z.infer<
  typeof textToSpeechStreamResponseSchema
>;

export type TextToSpeechStreamClientParams = z.infer<
  typeof textToSpeechStreamRequestBaseSchema
>;

export interface TextToSpeechStreamResult {
  bufferStream: AsyncGenerator<number>;
  chunkUpdates?: AsyncGenerator<TtsSentenceChunkUpdate>;
  buffer: Promise<number[]>;
  done: Promise<boolean>;
}

export interface TextToSpeechStreamSession {
  write(textFragment: string | Buffer): void;
  end(): void;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<TextToSpeechStreamResponse>;
}
