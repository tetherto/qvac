import { z } from "zod";

export const stopProvideParamsSchema = z
  .object({
    topic: z.string(),
  })
  .strict();

export const stopProvideRequestSchema = stopProvideParamsSchema.extend({
  type: z.literal("stopProvide"),
  topic: z.string(),
});

export const stopProvideResponseSchema = z.object({
  type: z.literal("stopProvide"),
  success: z.boolean(),
  error: z.string().optional(),
});

export type StopProvideParams = z.infer<typeof stopProvideParamsSchema>;
export type StopProvideRequest = z.infer<typeof stopProvideRequestSchema>;
export type StopProvideResponse = z.infer<typeof stopProvideResponseSchema>;
