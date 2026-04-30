import { z } from "zod";

export const embedParamsSchema = z.object({
  modelId: z.string().describe("The identifier of the embedding model to use"),
  text: z
    .union([
      z.string().min(1, "Text cannot be empty"),
      z
        .array(z.string().min(1, "Text cannot be empty"))
        .min(1, "Text array cannot be empty"),
    ])
    .describe(
      "The input text(s) to embed. A single string returns `number[]`; an array returns `number[][]`.",
    ),
});

export const embedRequestSchema = embedParamsSchema.extend({
  type: z.literal("embed"),
});

export const embedStatsSchema = z.object({
  totalTime: z
    .number()
    .optional()
    .describe("Total embedding time in milliseconds"),
  tokensPerSecond: z
    .number()
    .optional()
    .describe("Tokens processed per second"),
  totalTokens: z.number().optional().describe("Total tokens processed"),
  backendDevice: z
    .enum(["cpu", "gpu"])
    .optional()
    .describe("Compute backend used for inference"),
});

export const embedResponseSchema = z.object({
  type: z.literal("embed"),
  success: z.boolean(),
  embedding: z
    .union([z.array(z.number()), z.array(z.array(z.number()))])
    .default([])
    .describe(
      "The embedding vector(s). Single `number[]` when `text` is a string; `number[][]` when `text` is an array.",
    ),
  stats: embedStatsSchema.optional().describe("Performance statistics"),
  error: z.string().optional(),
});

export type EmbedParams = z.infer<typeof embedParamsSchema>;
export type EmbedRequest = z.infer<typeof embedRequestSchema>;
export type EmbedResponse = z.infer<typeof embedResponseSchema>;
export type EmbedStats = z.infer<typeof embedStatsSchema>;
