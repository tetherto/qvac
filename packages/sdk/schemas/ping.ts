import { z } from "zod";
import { delegateBaseSchema } from "./delegate";

export const pingRequestSchema = z.object({
  type: z.literal("ping"),
  delegate: delegateBaseSchema.optional(),
});

export const pingResponseSchema = z.object({
  type: z.literal("pong"),
  number: z.number(),
});

export type PingRequest = z.infer<typeof pingRequestSchema>;
export type PingResponse = z.infer<typeof pingResponseSchema>;
