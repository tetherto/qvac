import { z } from "zod";

export const lifecycleStateSchema = z.enum([
  "active",
  "suspending",
  "suspended",
  "resuming",
]);

export const stateRequestSchema = z.object({
  type: z.literal("state"),
});

export const stateResponseSchema = z.object({
  type: z.literal("state"),
  state: lifecycleStateSchema,
});

export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type StateRequest = z.infer<typeof stateRequestSchema>;
export type StateResponse = z.infer<typeof stateResponseSchema>;
