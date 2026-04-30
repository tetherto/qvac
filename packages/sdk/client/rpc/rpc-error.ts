import type { ErrorResponse } from "@/schemas";

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
