import { z } from "zod";
import type { NmtLanguage } from "./translation-config";
import {
  nmtModelTypeSchema,
  llmModelTypeSchema,
  normalizeModelType,
  type NmtModelTypeInput,
  type LlmModelTypeInput,
} from "./model-types";

const translateParamsNmtSchema = z.object({
  modelId: z
    .string()
    .describe("The identifier of the NMT translation model to use."),
  text: z
    .union([
      z.string().min(1, "Text cannot be empty"),
      z
        .array(z.string().min(1, "Text cannot be empty"))
        .min(1, "Array cannot be empty"),
    ])
    .describe(
      "The input text(s) to translate. A single string returns a single translation; an array returns one translation per input.",
    ),
  stream: z
    .boolean()
    .describe(
      "Whether to stream tokens (`true`) or resolve the complete translation once (`false`).",
    ),
  modelType: nmtModelTypeSchema.describe(
    "NMT model-type variant identifier.",
  ),
});

const translateParamsLlmSchema = z.object({
  modelId: z
    .string()
    .describe("The identifier of the LLM model used for translation."),
  text: z
    .string()
    .min(1, "Text cannot be empty")
    .describe("The input text to translate."),
  stream: z
    .boolean()
    .describe(
      "Whether to stream tokens (`true`) or resolve the complete translation once (`false`).",
    ),
  modelType: llmModelTypeSchema.describe(
    "LLM model-type variant identifier.",
  ),
  from: z
    .string()
    .optional()
    .describe(
      "Source language code. When omitted, the SDK attempts to auto-detect the source language.",
    ),
  to: z.string().describe("Target language code."),
  context: z
    .string()
    .optional()
    .describe("Optional translation context passed to the LLM as a system hint."),
});

// Using z.union since each modelType accepts multiple values
const translateParamsSchema = z.union([
  translateParamsNmtSchema,
  translateParamsLlmSchema,
]);

export const translationStatsSchema = z.object({
  // Common stats
  totalTime: z
    .number()
    .optional()
    .describe("Total translation time in milliseconds."),
  totalTokens: z
    .number()
    .optional()
    .describe("Total tokens produced by the translation."),
  tokensPerSecond: z
    .number()
    .optional()
    .describe("Tokens generated per second."),
  timeToFirstToken: z
    .number()
    .optional()
    .describe(
      "Time to first token in milliseconds (LLM translation only).",
    ),
  // NMT-specific
  decodeTime: z
    .number()
    .optional()
    .describe("Time spent in the NMT decoder in milliseconds."),
  encodeTime: z
    .number()
    .optional()
    .describe("Time spent in the NMT encoder in milliseconds."),
  // LLM-specific
  cacheTokens: z
    .number()
    .optional()
    .describe("Tokens served from the KV cache during LLM translation."),
});

export const translateRequestSchema = z.union([
  translateParamsNmtSchema.extend({ type: z.literal("translate") }),
  translateParamsLlmSchema.extend({ type: z.literal("translate") }),
]);

// Valid model types for translation (aliases and canonical)
const validTranslationModelTypes = [
  "nmt",
  "nmtcpp-translation",
  "llm",
  "llamacpp-completion",
];
const llmModelTypes = ["llm", "llamacpp-completion"];

// Validates the translate server args and returns the model info
export const translateServerParamsSchema = translateParamsSchema
  .refine(
    (data) =>
      data.modelType && validTranslationModelTypes.includes(data.modelType),
    {
      message:
        "Model type is not compatible with translation. Only LLM and NMT models are supported.",
    },
  )
  .refine(
    (data) => {
      if (!llmModelTypes.includes(data.modelType)) return true;
      // For LLM, check from/to exist
      const llmData = data as { from?: string; to?: string };
      return llmData.from && llmData.to;
    },
    {
      message:
        "Both 'from' and 'to' languages are required for LLM translation models",
    },
  )
  .transform((data) => ({
    ...data,
    modelType: normalizeModelType(data.modelType),
  }));

export const translateResponseSchema = z.object({
  type: z.literal("translate"),
  token: z.string(),
  done: z.boolean().optional(),
  stats: translationStatsSchema.optional(),
  error: z.string().optional(),
});

export type TranslateParams = z.infer<typeof translateParamsSchema>;
export type TranslateRequest = z.infer<typeof translateRequestSchema>;
export type TranslateResponse = z.infer<typeof translateResponseSchema>;
export type TranslationStats = z.infer<typeof translationStatsSchema>;

type TranslateParamsNmt = {
  modelId: string;
  text: string | string[];
  stream: boolean;
  modelType: NmtModelTypeInput;
};

type TranslateParamsLlm = {
  modelId: string;
  text: string;
  stream: boolean;
  modelType: LlmModelTypeInput;
  from?: NmtLanguage | (string & {});
  to: NmtLanguage | (string & {});
  context?: string;
};

export type TranslateClientParams = TranslateParamsNmt | TranslateParamsLlm;
