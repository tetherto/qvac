import type { LogLevel } from "@qvac/logging";
import { z } from "zod";

const logLevelValues: LogLevel[] = ["error", "warn", "info", "debug"] as const;
export const logLevelSchema = z.enum(logLevelValues);

const loggingParamsSchema = z.object({
  id: z.string(),
});

export const loggingStreamRequestSchema = loggingParamsSchema.extend({
  type: z.literal("loggingStream"),
});

export const loggingStreamResponseSchema = z.object({
  type: z.literal("loggingStream"),
  id: z.string(),
  level: logLevelSchema,
  namespace: z.string(),
  message: z.string(),
  timestamp: z.number(),
});

export type LoggingParams = z.infer<typeof loggingParamsSchema>;
export type LoggingStreamRequest = z.infer<typeof loggingStreamRequestSchema>;
export type LoggingStreamResponse = z.infer<typeof loggingStreamResponseSchema>;
