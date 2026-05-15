import { z } from "zod";
import { QvacErrorBase } from "@qvac/error";

/**
 * Wire shape for errors thrown across the RPC boundary. The fields are
 * the union of (a) the legacy `QvacErrorBase` serialisation (`name`,
 * `code`, `message`, `stack`, `cause`, `timestamp`) and (b) the new
 * `typedFields` map (0.11.0+) carrying per-class structured data the
 * client-side reconstructor uses to rebuild the original typed error.
 *
 * `typedFields` is opaque on the wire — `z.unknown()` — and the
 * per-class reconstructor in `client/rpc/rpc-error.ts` casts each
 * member at the boundary. The single-map shape keeps the schema
 * compact regardless of how many typed-error classes the SDK
 * eventually surfaces across RPC. New typed-error classes that need
 * cross-RPC reconstruction add a `toErrorResponseFields()` method on
 * the server side and a row to the reconstructor map on the client
 * side; the schema itself doesn't change.
 */
export const errorResponseSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  stack: z.string().optional(),
  timestamp: z.string().optional(),
  name: z.string().optional(),
  code: z.number().optional(),
  cause: z.unknown().optional(),
  typedFields: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * A `QvacErrorBase` subclass that opts into typed-field serialisation
 * across the RPC boundary. The method returns the subset of own
 * properties the client-side reconstructor needs to rebuild the
 * original class with its named constructor arguments populated.
 *
 * Co-located with each class (see `utils/errors-server.ts`) so adding
 * a new cross-RPC typed error is a three-step change in one PR: define
 * the class, implement the method, add a reconstructor entry in
 * `client/rpc/rpc-error.ts`.
 */
export interface TypedErrorSerializer {
  toErrorResponseFields(): Record<string, unknown>;
}

function hasTypedFields(error: unknown): error is TypedErrorSerializer {
  return (
    error !== null &&
    typeof error === "object" &&
    "toErrorResponseFields" in error &&
    typeof (error as { toErrorResponseFields?: unknown })
      .toErrorResponseFields === "function"
  );
}

function isQvacError(error: unknown): error is QvacErrorBase {
  return error instanceof QvacErrorBase;
}

export function createErrorResponse(error: unknown): ErrorResponse {
  if (isQvacError(error)) {
    const qvacData = error.toJSON();
    const response: ErrorResponse = {
      type: "error",
      name: qvacData.name,
      code: qvacData.code,
      message: qvacData.message,
      stack: qvacData.stack,
      timestamp: new Date().toISOString(),
    };
    if (hasTypedFields(error)) {
      response.typedFields = error.toErrorResponseFields();
    }
    return response;
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
