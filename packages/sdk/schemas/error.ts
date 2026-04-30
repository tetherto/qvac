import { z } from "zod";
import { QvacErrorBase } from "@qvac/error";

export const errorResponseSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  stack: z.string().optional(),
  timestamp: z.string().optional(),
  name: z.string().optional(),
  code: z.number().optional(),
  cause: z.unknown().optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

function isQvacError(error: unknown): error is QvacErrorBase {
  return error instanceof QvacErrorBase;
}

export function createErrorResponse(error: unknown): ErrorResponse {
  if (isQvacError(error)) {
    const qvacData = error.toJSON();
    return {
      type: "error",
      name: qvacData.name,
      code: qvacData.code,
      message: qvacData.message,
      stack: qvacData.stack,
      timestamp: new Date().toISOString(),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  return {
    type: "error",
    message,
    stack,
    timestamp: new Date().toISOString(),
  };
}
