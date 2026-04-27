import { z } from "zod";
import { toolSchema } from "./tools";
import { completionEventSchema } from "./completion-event";

export { completionStatsSchema, type CompletionStats } from "./completion-event";

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
  captureThinking: z.boolean().optional(),
  emitRawDeltas: z.boolean().optional(),
});

export const completionStreamRequestSchema =
  completionClientParamsSchema.extend({
    type: z.literal("completionStream"),
  });

export const completionStreamResponseSchema = z
  .object({
    type: z.literal("completionStream"),
    done: z.boolean().optional(),
    events: z.array(completionEventSchema),
  })
  .strict();

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
