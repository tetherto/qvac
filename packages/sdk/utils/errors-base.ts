import type { QvacErrorOptions } from "@qvac/error";

export function createErrorOptions(
  code: number,
  adds?: string | (string | number)[],
  cause?: unknown,
): QvacErrorOptions {
  const options: QvacErrorOptions = { code };
  if (adds !== undefined) {
    options.adds = adds;
  }
  if (cause !== undefined) {
    options.cause =
      cause instanceof Error
        ? cause
        : new Error(typeof cause === "string" ? cause : JSON.stringify(cause));
  }
  return options;
}
