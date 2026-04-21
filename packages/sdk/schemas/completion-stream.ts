import { z } from "zod";
import { toolSchema, toolCallSchema, toolCallEventSchema } from "./tools";

export const attachmentSchema = z.object({
  path: z.string(),
});

const kvCacheSchema = z.union([
  z.boolean(),
  z.string().min(1, "KV cache key cannot be empty string"),
]);

export const generationParamsSchema = z
  .object({
    temp: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    predict: z.number().optional(),
    seed: z.number().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    repeat_penalty: z.number().optional(),
  })
  .strict();

export const completionParamsSchema = z.object({
  history: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      attachments: z.array(attachmentSchema).optional(),
    }),
  ),
  modelId: z.string(),
  kvCache: kvCacheSchema.optional(),
});

export const completionClientParamsSchema = completionParamsSchema.extend({
  tools: z.array(toolSchema).optional(),
  stream: z.boolean(),
  kvCache: kvCacheSchema.optional(),
  generationParams: generationParamsSchema.optional(),
});

export const completionStreamRequestSchema =
  completionClientParamsSchema.extend({
    type: z.literal("completionStream"),
  });

export const completionStatsSchema = z.object({
  timeToFirstToken: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  cacheTokens: z.number().optional(),
  backendDevice: z.enum(["cpu", "gpu"]).optional(),
});

export const completionStreamResponseSchema = z.object({
  type: z.literal("completionStream"),
  token: z.string(),
  done: z.boolean().optional(),
  stats: completionStatsSchema.optional(),
  toolCallEvent: toolCallEventSchema.optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  error: z.string().optional(),
});

export type GenerationParams = z.infer<typeof generationParamsSchema>;
export type CompletionParams = z.infer<typeof completionParamsSchema>;
export type CompletionClientParams = z.input<
  typeof completionClientParamsSchema
>;
export type CompletionStreamRequest = z.infer<
  typeof completionStreamRequestSchema
>;
export type CompletionStreamResponse = z.infer<
  typeof completionStreamResponseSchema
>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type CompletionStats = z.infer<typeof completionStatsSchema>;
