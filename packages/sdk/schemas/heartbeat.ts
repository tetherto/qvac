import { z } from "zod";
import { delegateBaseSchema } from "./delegate";

export const heartbeatRequestSchema = z.object({
  type: z.literal("heartbeat"),
  delegate: delegateBaseSchema.optional(),
});

export const heartbeatResponseSchema = z.object({
  type: z.literal("heartbeat"),
  number: z.number(),
});

export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
