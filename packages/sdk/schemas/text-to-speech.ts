import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

// TTS supported languages.
//
// Source of truth: the multilingual GGUFs shipped by `@qvac/tts-ggml`.
// - Chatterbox MTL (`chatterbox-t3-mtl.gguf` + `chatterbox-s3gen-mtl.gguf`)
//   covers all 18 codes below.
// - Supertonic MTL (`supertonic-2`) covers a subset: en, ko, es, pt, fr.
// - The English-only Chatterbox turbo and the English-only Supertonic GGUFs
//   only use `en` (compatible with this enum).
//
// Keep alphabetised after `en`; revisit when a new MTL GGUF lands upstream.
export const TTS_LANGUAGES = [
  "en", // English
  "ar", // Arabic
  "da", // Danish
  "de", // German
  "el", // Greek
  "es", // Spanish
  "fi", // Finnish
  "fr", // French
  "it", // Italian
  "ko", // Korean
  "ms", // Malay
  "nl", // Dutch
  "no", // Norwegian
  "pl", // Polish
  "pt", // Portuguese
  "sv", // Swedish
  "sw", // Swahili
  "tr", // Turkish
] as const;

const ttsLanguageSchema = z.enum(TTS_LANGUAGES);

export const ttsChatterboxRuntimeConfigSchema = z.object({
  ttsEngine: z.literal("chatterbox"),
  language: ttsLanguageSchema,
  /** Move N layers to the GPU backend (Chatterbox). Pass 99 to move everything. Defaults to engine default. */
  nGpuLayers: z.number().int().optional(),
  /** Route inference through a GPU backend if available. Defaults to engine default. */
  useGPU: z.boolean().optional(),
  /** RNG seed for CFM initial noise + SineGen excitation. */
  seed: z.number().int().optional(),
  /** Native streaming chunk size in speech tokens (~25 ≈ 1s of audio). Chatterbox-only. */
  streamChunkTokens: z.number().int().optional(),
  /** Smaller first-chunk size for low first-audio-out latency. Chatterbox-only. */
  streamFirstChunkTokens: z.number().int().optional(),
  /** CFM Euler step count (1 halves cost, 2 matches Python meanflow). */
  cfmSteps: z.number().int().optional(),
  /** Resample engine output (24kHz native) to this rate before emitting. */
  outputSampleRate: z.number().int().optional(),
});

export const ttsSupertonicRuntimeConfigSchema = z.object({
  ttsEngine: z.literal("supertonic"),
  language: ttsLanguageSchema,
  /** Speech-rate factor. 0 → GGUF default. */
  ttsSpeed: z.number().optional(),
  /** Number of vector-estimator (CFM) steps. 0 → GGUF default. */
  ttsNumInferenceSteps: z.number().int().optional(),
  /** Voice id baked into the GGUF (e.g. "F1", "F2", "M1", "M2"). */
  voiceName: z.string().optional(),
  /** RNG seed for the vector-estimator latent. */
  seed: z.number().int().optional(),
  /** Resample engine output (44.1kHz native) to this rate before emitting. */
  outputSampleRate: z.number().int().optional(),
});

export const ttsRuntimeConfigSchema = z.union([
  ttsChatterboxRuntimeConfigSchema,
  ttsSupertonicRuntimeConfigSchema,
]);

// Chatterbox accepts either a `modelDir` containing both GGUFs, or explicit
// per-file sources. Reference audio is optional (omit to use the GGUF's baked
// default voice). `voicesDirSrc` is optional and points at a directory of
// pre-baked voice profiles consumed by the native engine.
//
// The `.refine()` mirrors the bare-side `TtsArtifactsRequiredError` check so
// missing-source configs fail at the schema layer (client-side) rather than
// only after RPC reaches the worker.
export const ttsChatterboxConfigSchema = ttsChatterboxRuntimeConfigSchema
  .extend({
    ttsModelDirSrc: modelSrcInputSchema.optional(),
    ttsT3ModelSrc: modelSrcInputSchema.optional(),
    ttsS3genModelSrc: modelSrcInputSchema.optional(),
    referenceAudioSrc: modelSrcInputSchema.optional(),
    voicesDirSrc: modelSrcInputSchema.optional(),
  })
  .refine(
    (cfg) =>
      cfg.ttsModelDirSrc != null ||
      (cfg.ttsT3ModelSrc != null && cfg.ttsS3genModelSrc != null),
    {
      message:
        "Chatterbox TTS requires either ttsModelDirSrc or both ttsT3ModelSrc and ttsS3genModelSrc",
    },
  );

export const ttsSupertonicConfigSchema = ttsSupertonicRuntimeConfigSchema
  .extend({
    ttsModelDirSrc: modelSrcInputSchema.optional(),
    ttsSupertonicModelSrc: modelSrcInputSchema.optional(),
  })
  .refine(
    (cfg) => cfg.ttsModelDirSrc != null || cfg.ttsSupertonicModelSrc != null,
    {
      message:
        "Supertonic TTS requires either ttsModelDirSrc or ttsSupertonicModelSrc",
    },
  );

export const ttsConfigSchema = z.union([
  ttsChatterboxConfigSchema,
  ttsSupertonicConfigSchema,
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
