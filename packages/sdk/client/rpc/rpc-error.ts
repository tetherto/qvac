import type { ErrorResponse } from "@/schemas";
import {
  ContextOverflowError,
  RequestIdConflictError,
  RequestNotFoundError,
  RequestRejectedByPolicyError,
} from "@/utils/errors-server";

export class RPCError extends Error {
  public readonly timestamp?: string;
  public readonly remoteStack?: string;
  public readonly code?: number;
  public override readonly cause?: unknown;
  public readonly isQvacError: boolean;

  constructor(errorResponse: ErrorResponse) {
    super(errorResponse.message);

    // If this was originally a QvacError, preserve its structure
    if (errorResponse.name && errorResponse.code) {
      this.name = errorResponse.name;
      this.code = errorResponse.code;
      this.cause = errorResponse.cause;
      this.isQvacError = true;
    } else {
      this.name = "RPCError";
      this.isQvacError = false;
    }

    if (errorResponse.timestamp) {
      this.timestamp = errorResponse.timestamp;
    }

    if (errorResponse.stack) {
      this.remoteStack = errorResponse.stack;
      this.stack = `${this.stack}\n--- Worker Stack ---\n${errorResponse.stack}`;
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      stack: this.stack,
      cause: this.cause,
      timestamp: this.timestamp,
      isQvacError: this.isQvacError,
    };
  }
}

/**
 * Attach the remote stack onto a reconstructed typed error so the
 * client-side trace points at the consumer call site and the worker-
 * side trace is preserved for debugging. Mirrors the behaviour
 * `RPCError`'s constructor applies in the fall-through path.
 */
function attachRemoteContext(
  err: Error,
  response: ErrorResponse,
): Error {
  if (response.stack) {
    (err as { remoteStack?: string }).remoteStack = response.stack;
    err.stack = `${err.stack}\n--- Worker Stack ---\n${response.stack}`;
  }
  if (response.timestamp) {
    (err as { timestamp?: string }).timestamp = response.timestamp;
  }
  return err;
}

/** Read a string field from the `typedFields` envelope, defaulting to `fallback` if missing or non-string. */
function readStringField(
  fields: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const value = fields?.[key];
  return typeof value === "string" ? value : fallback;
}

/** Read a number field from the `typedFields` envelope, returning `undefined` if missing or non-number. */
function readOptionalNumberField(
  fields: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = fields?.[key];
  return typeof value === "number" ? value : undefined;
}

/** Read a string field, returning `undefined` (not a fallback string) if missing. */
function readOptionalStringField(
  fields: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = fields?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type ErrorReconstructor = (response: ErrorResponse) => Error;

/**
 * Map of server-thrown `QvacErrorBase` subclasses that need to survive
 * the RPC boundary as their original class — `err instanceof
 * RequestRejectedByPolicyError` on the consumer side must match the
 * class re-exported from `@qvac/sdk`.
 *
 * **Key shape.** The key is the `name` value `QvacErrorBase` sets at
 * construction time, which `createErrorResponse` forwards onto
 * `response.name`. That value is the SCREAMING_SNAKE_CASE error-code
 * name from `sdk-errors-server.ts` (`"REQUEST_REJECTED_BY_POLICY"`),
 * **not** the JS class name (`"RequestRejectedByPolicyError"`). The
 * mismatch was a 0.11.0 bring-up bug fixed alongside the reconstructor
 * unit tests in `rpc-error-reconstruct.test.ts`.
 *
 * **Maintenance contract.** Every new cross-RPC server-thrown typed
 * error class added in `errors-server.ts` adds a row here in the same
 * PR, keyed by its `SDK_SERVER_ERROR_CODES.<NAME>` constant. The
 * class must (a) implement `toErrorResponseFields(): Record<…>` so
 * the wire envelope carries its named constructor arguments and (b)
 * be re-exported from `@qvac/sdk` so consumers can `import` it.
 * Forgetting either side means `instanceof` regresses for that class.
 *
 * Client-constructed typed errors (e.g. `InferenceCancelledError`
 * built in `client/api/completion-stream.ts` from the aggregated
 * partial state) are NOT registered here — they never round-trip the
 * envelope, and adding a reconstructor for one would create a
 * parallel construction path that fires whenever the server happens
 * to throw the same class name.
 */
const RECONSTRUCTORS: Record<string, ErrorReconstructor> = {
  REQUEST_ID_CONFLICT: (response) => {
    return new RequestIdConflictError(
      readStringField(response.typedFields, "requestId", ""),
      response.cause,
    );
  },
  REQUEST_NOT_FOUND: (response) => {
    return new RequestNotFoundError(
      readStringField(response.typedFields, "requestId", ""),
      response.cause,
    );
  },
  REQUEST_REJECTED_BY_POLICY: (response) => {
    return new RequestRejectedByPolicyError(
      readStringField(response.typedFields, "requestId", ""),
      readStringField(response.typedFields, "kind", ""),
      readStringField(response.typedFields, "modelId", ""),
      readStringField(response.typedFields, "reason", response.message),
      response.cause,
    );
  },
  CONTEXT_OVERFLOW: (response) => {
    return new ContextOverflowError(
      readOptionalNumberField(response.typedFields, "promptTokens"),
      readOptionalNumberField(response.typedFields, "ctxSize"),
      readOptionalStringField(response.typedFields, "modelId"),
      response.cause,
    );
  },
};

/**
 * Rebuild the original server-thrown typed error from its serialised
 * envelope so consumer code can do
 * `if (err instanceof RequestRejectedByPolicyError) { ... }` across
 * the RPC boundary. Unknown error names fall through to the legacy
 * `RPCError` wrapper, which preserves `name`/`code`/`message` for
 * code-based predicates.
 */
export function reconstructError(response: ErrorResponse): Error {
  const reconstructor = response.name
    ? RECONSTRUCTORS[response.name]
    : undefined;
  if (!reconstructor) {
    return new RPCError(response);
  }

  try {
    return attachRemoteContext(reconstructor(response), response);
  } catch {
    // Defensive fall-through: if a reconstructor throws (e.g. a
    // future class adds a required constructor field and an older
    // server doesn't ship `typedFields`), surface the original error
    // via `RPCError` so consumers never see "couldn't reconstruct
    // error" obscuring the real one. The reconstructors here are
    // intentionally written to coerce missing fields to defensible
    // defaults (`String(x ?? "")`), so reaching this branch is the
    // edge case, not the norm.
    return new RPCError(response);
  }
}
