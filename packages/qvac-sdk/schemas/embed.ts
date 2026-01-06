import { z } from "zod";

export const embedParamsSchema = z.object({
  modelId: z.string(),
  text: z.union([
    z.string().min(1, "Text cannot be empty"),
    z
      .array(z.string().min(1, "Text cannot be empty"))
      .min(1, "Text array cannot be empty"),
  ]),
});

export const embedRequestSchema = embedParamsSchema.extend({
  type: z.literal("embed"),
});

export const embedResponseSchema = z.object({
  type: z.literal("embed"),
  success: z.boolean(),
  embedding: z
    .union([z.array(z.number()), z.array(z.array(z.number()))])
    .default([]),
  error: z.string().optional(),
});

export type EmbedParams = z.infer<typeof embedParamsSchema>;
export type EmbedRequest = z.infer<typeof embedRequestSchema>;
export type EmbedResponse = z.infer<typeof embedResponseSchema>;
