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
  modelId: z.string(),
  text: z.union([
    z.string().min(1, "Text cannot be empty"),
    z
      .array(z.string().min(1, "Text cannot be empty"))
      .min(1, "Array cannot be empty"),
  ]),
  stream: z.boolean(),
  modelType: nmtModelTypeSchema,
});

const translateParamsLlmSchema = z.object({
  modelId: z.string(),
  text: z.string().min(1, "Text cannot be empty"),
  stream: z.boolean(),
  modelType: llmModelTypeSchema,
  from: z.string().optional(),
  to: z.string(),
  context: z.string().optional(),
});

// Using z.union since each modelType accepts multiple values
const translateParamsSchema = z.union([
  translateParamsNmtSchema,
  translateParamsLlmSchema,
]);

export const translationStatsSchema = z.object({
  // Common stats
  totalTime: z.number().optional(),
  totalTokens: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  timeToFirstToken: z.number().optional(),
  // NMT-specific
  decodeTime: z.number().optional(),
  encodeTime: z.number().optional(),
  // LLM-specific
  cacheTokens: z.number().optional(),
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
