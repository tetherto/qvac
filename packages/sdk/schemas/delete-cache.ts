import { z } from "zod";

export const deleteCacheRequestSchema = z.union([
  z.object({
    type: z.literal("deleteCache"),
    all: z.literal(true),
  }),
  z.object({
    type: z.literal("deleteCache"),
    kvCacheKey: z.string(),
    modelId: z.string().optional(),
  }),
]);

export const deleteCacheResponseSchema = z.object({
  type: z.literal("deleteCache"),
  success: z.boolean(),
  error: z.string().optional(),
});

export type DeleteCacheRequest = z.infer<typeof deleteCacheRequestSchema>;
export type DeleteCacheResponse = z.infer<typeof deleteCacheResponseSchema>;
