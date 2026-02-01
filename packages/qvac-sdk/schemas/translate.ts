import { z } from "zod";
import type { NmtLanguage } from "./translation-config";

const translateParamsBaseSchema = z.object({
  modelId: z.string(),
  text: z.string().min(1, "Text cannot be empty"),
  stream: z.boolean(),
});

const translateParamsNmtSchema = translateParamsBaseSchema.extend({
  modelType: z.literal("nmt"),
});

const translateParamsLlmSchema = translateParamsBaseSchema.extend({
  modelType: z.literal("llm"),
  from: z.string().optional(),
  to: z.string(),
  context: z.string().optional(),
});

const translateParamsSchema = z.discriminatedUnion("modelType", [
  translateParamsNmtSchema,
  translateParamsLlmSchema,
]);

export const translationStatsSchema = z.object({
  processedTokens: z.number(),
  processingTime: z.number(),
});

export const translateRequestSchema = z.union([
  translateParamsNmtSchema.extend({ type: z.literal("translate") }),
  translateParamsLlmSchema.extend({ type: z.literal("translate") }),
]);

// Validates the translate server args and returns the model info
export const translateServerParamsSchema = translateParamsSchema
  .refine((data) => data.modelType && ["nmt", "llm"].includes(data.modelType), {
    message:
      "Model type is not compatible with translation. Only LLM and NMT models are supported.",
  })
  .refine((data) => !(data.modelType === "llm" && (!data.from || !data.to)), {
    message:
      "Both 'from' and 'to' languages are required for LLM translation models",
  });

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
type TranslateParamsBase = z.input<typeof translateParamsBaseSchema>;
type TranslateParamsNmt = TranslateParamsBase & {
  modelType: "nmt";
};
type TranslateParamsLlm = TranslateParamsBase & {
  modelType: "llm";
  from?: NmtLanguage | (string & {});
  to: NmtLanguage | (string & {});
  context?: string;
};
export type TranslateClientParams = TranslateParamsNmt | TranslateParamsLlm;
