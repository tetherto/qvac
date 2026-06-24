/**
 * Helpers for propagating model execution timing via internal symbols.
 */

import { MODEL_EXECUTION_KEY } from "@/schemas";

export function hasDefinedValues<T extends Record<string, unknown>>(obj: T): boolean {
  return Object.values(obj).some((v) => v !== undefined);
}

export function attachModelExecutionMs<T>(target: T, ms: number | undefined): T {
  if (ms !== undefined) {
    (target as unknown as Record<symbol, number>)[MODEL_EXECUTION_KEY] = ms;
  }
  return target;
}

export function readModelExecutionMs(target: unknown): number | undefined {
  return (target as Record<symbol, number> | undefined)?.[MODEL_EXECUTION_KEY];
}

export function forwardModelExecution<T>(target: T, source: unknown): T {
  return attachModelExecutionMs(target, readModelExecutionMs(source));
}

export interface StreamResult<S = unknown> {
  modelExecutionMs: number;
  stats?: S;
}

export function buildStreamResult<S extends Record<string, unknown>>(
  modelExecutionMs: number,
  stats?: S,
): StreamResult<S> {
  const result: StreamResult<S> = { modelExecutionMs };
  if (stats && hasDefinedValues(stats)) {
    result.stats = stats;
  }
  return result;
}

export function buildUnaryResult<T extends Record<string, unknown>, S extends Record<string, unknown>>(
  response: T,
  modelExecutionMs: number,
  stats?: S,
): T & { stats?: S } {
  const result = { ...response } as T & { stats?: S };
  if (stats && hasDefinedValues(stats)) {
    result.stats = stats;
  }
  return attachModelExecutionMs(result, modelExecutionMs);
}
