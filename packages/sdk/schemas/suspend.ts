import { z } from "zod";

export const suspendRequestSchema = z.object({
  type: z.literal("suspend"),
});

export const suspendResponseSchema = z.object({
  type: z.literal("suspend"),
});

export type SuspendRequest = z.infer<typeof suspendRequestSchema>;
export type SuspendResponse = z.infer<typeof suspendResponseSchema>;
