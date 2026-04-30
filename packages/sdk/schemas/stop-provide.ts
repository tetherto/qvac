import { z } from "zod";

export const stopProvideRequestSchema = z
  .object({
    type: z.literal("stopProvide"),
  })
  .strict();

export const stopProvideResponseSchema = z.object({
  type: z.literal("stopProvide"),
  success: z.boolean(),
  error: z.string().optional(),
});

export type StopProvideRequest = z.infer<typeof stopProvideRequestSchema>;
export type StopProvideResponse = z.infer<typeof stopProvideResponseSchema>;
