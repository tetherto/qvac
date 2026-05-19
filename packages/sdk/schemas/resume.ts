import { z } from "zod";

export const resumeRequestSchema = z.object({
  type: z.literal("resume"),
});

export const resumeResponseSchema = z.object({
  type: z.literal("resume"),
});

export type ResumeRequest = z.infer<typeof resumeRequestSchema>;
export type ResumeResponse = z.infer<typeof resumeResponseSchema>;
