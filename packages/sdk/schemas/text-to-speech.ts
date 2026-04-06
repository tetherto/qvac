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
});

export const ttsSupertonicRuntimeConfigSchema = z.object({
  ttsEngine: z.literal("supertonic"),
  language: ttsLanguageSchema,
  ttsSpeed: z.number().optional(),
  ttsNumInferenceSteps: z.number().optional(),
});

export const ttsRuntimeConfigSchema = z.union([
  ttsChatterboxRuntimeConfigSchema,
  ttsSupertonicRuntimeConfigSchema,
]);

export const ttsChatterboxConfigSchema = ttsChatterboxRuntimeConfigSchema.extend({
  ttsTokenizerSrc: modelSrcInputSchema,
  ttsSpeechEncoderSrc: modelSrcInputSchema,
  ttsEmbedTokensSrc: modelSrcInputSchema,
  ttsConditionalDecoderSrc: modelSrcInputSchema,
  ttsLanguageModelSrc: modelSrcInputSchema,
  referenceAudioSrc: modelSrcInputSchema,
});

export const ttsSupertonicConfigSchema = ttsSupertonicRuntimeConfigSchema.extend({
  ttsTokenizerSrc: modelSrcInputSchema,
  ttsTextEncoderSrc: modelSrcInputSchema,
  ttsLatentDenoiserSrc: modelSrcInputSchema,
  ttsVoiceDecoderSrc: modelSrcInputSchema,
  ttsVoiceSrc: modelSrcInputSchema,
});

export const ttsConfigSchema = z.union([
  ttsChatterboxConfigSchema,
  ttsSupertonicConfigSchema,
]);

export const ttsClientParamsSchema = z.object({
  modelId: z.string(),
  inputType: z.string().default("text"),
  text: z.string().trim().min(1, "text must not be empty or whitespace-only"),
  stream: z.boolean().default(true),
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
});

export type TtsLanguage = (typeof TTS_LANGUAGES)[number];
export type TtsChatterboxConfig = z.infer<typeof ttsChatterboxConfigSchema>;
export type TtsSupertonicConfig = z.infer<typeof ttsSupertonicConfigSchema>;
export type TtsConfig = z.infer<typeof ttsConfigSchema>;
export type TtsChatterboxRuntimeConfig = z.infer<
  typeof ttsChatterboxRuntimeConfigSchema
>;
export type TtsSupertonicRuntimeConfig = z.infer<
  typeof ttsSupertonicRuntimeConfigSchema
>;
export type TtsRuntimeConfig = z.infer<typeof ttsRuntimeConfigSchema>;
export type TtsClientParams = z.infer<typeof ttsClientParamsSchema>;
export type TtsRequest = z.infer<typeof ttsRequestSchema>;
export type TtsResponse = z.infer<typeof ttsResponseSchema>;
export type TtsStats = z.infer<typeof ttsStatsSchema>;
