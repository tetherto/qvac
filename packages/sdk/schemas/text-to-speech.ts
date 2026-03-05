import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

// TTS supported languages based on available models
export const TTS_LANGUAGES = [
  "en", // English
  "es", // Spanish
  "de", // German
  "it", // Italian
] as const;

export const ttsChatterboxConfigSchema = z.object({
  ttsEngine: z.literal("chatterbox"),
  language: z.enum(TTS_LANGUAGES),
  ttsTokenizerSrc: modelSrcInputSchema,
  ttsSpeechEncoderSrc: modelSrcInputSchema,
  ttsEmbedTokensSrc: modelSrcInputSchema,
  ttsConditionalDecoderSrc: modelSrcInputSchema,
  ttsLanguageModelSrc: modelSrcInputSchema,
  referenceAudioSrc: modelSrcInputSchema,
});

export const ttsSupertonicConfigSchema = z.object({
  ttsEngine: z.literal("supertonic"),
  language: z.enum(TTS_LANGUAGES),
  ttsTokenizerSrc: modelSrcInputSchema,
  ttsTextEncoderSrc: modelSrcInputSchema,
  ttsLatentDenoiserSrc: modelSrcInputSchema,
  ttsVoiceDecoderSrc: modelSrcInputSchema,
  ttsVoiceSrc: modelSrcInputSchema,
  ttsSpeed: z.number().optional(),
  ttsNumInferenceSteps: z.number().optional(),
});

export const ttsConfigSchema = z.union([
  ttsChatterboxConfigSchema,
  ttsSupertonicConfigSchema,
]);

// Request-level schemas with string sources (after ModelSrcInput is resolved to string)
export const ttsChatterboxRequestConfigSchema = z.object({
  ttsEngine: z.literal("chatterbox"),
  language: z.enum(TTS_LANGUAGES),
  ttsTokenizerSrc: z.string(),
  ttsSpeechEncoderSrc: z.string(),
  ttsEmbedTokensSrc: z.string(),
  ttsConditionalDecoderSrc: z.string(),
  ttsLanguageModelSrc: z.string(),
  referenceAudioSrc: z.string(),
});

export const ttsSupertonicRequestConfigSchema = z.object({
  ttsEngine: z.literal("supertonic"),
  language: z.enum(TTS_LANGUAGES),
  ttsTokenizerSrc: z.string(),
  ttsTextEncoderSrc: z.string(),
  ttsLatentDenoiserSrc: z.string(),
  ttsVoiceDecoderSrc: z.string(),
  ttsVoiceSrc: z.string(),
  ttsSpeed: z.number().optional(),
  ttsNumInferenceSteps: z.number().optional(),
});

export const ttsRequestConfigSchema = z.union([
  ttsChatterboxRequestConfigSchema,
  ttsSupertonicRequestConfigSchema,
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

export const ttsResponseSchema = z.object({
  type: z.literal("textToSpeech"),
  buffer: z.array(z.number()),
  done: z.boolean().default(false),
});

export type TtsLanguage = (typeof TTS_LANGUAGES)[number];
export type TtsChatterboxConfig = z.infer<typeof ttsChatterboxConfigSchema>;
export type TtsSupertonicConfig = z.infer<typeof ttsSupertonicConfigSchema>;
export type TtsConfig = z.infer<typeof ttsConfigSchema>;
export type TtsChatterboxRequestConfig = z.infer<
  typeof ttsChatterboxRequestConfigSchema
>;
export type TtsSupertonicRequestConfig = z.infer<
  typeof ttsSupertonicRequestConfigSchema
>;
export type TtsRequestConfig = z.infer<typeof ttsRequestConfigSchema>;
export type TtsClientParams = z.infer<typeof ttsClientParamsSchema>;
export type TtsRequest = z.infer<typeof ttsRequestSchema>;
export type TtsResponse = z.infer<typeof ttsResponseSchema>;
