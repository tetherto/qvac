/**
 * Helpers to inject/extract __profiling metadata in RPC payloads.
 */

import {
  PROFILING_KEY,
  type ProfilingRequestMeta,
  type ProfilingResponseMeta,
} from "@/schemas";

export function createProfilingMeta(
  profileId: string,
  includeServerBreakdown: boolean,
): ProfilingRequestMeta {
  return {
    enabled: true,
    id: profileId,
    includeServer: includeServerBreakdown,
  };
}

export function createProfilingDisabledMeta(): ProfilingRequestMeta {
  return { enabled: false };
}

export function injectProfilingMetaIntoObject(
  obj: Record<string, unknown>,
  meta: ProfilingRequestMeta,
): Record<string, unknown> {
  return { ...obj, [PROFILING_KEY]: meta };
}

export function extractProfilingMeta(
  payload: unknown,
): ProfilingResponseMeta | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    PROFILING_KEY in payload
  ) {
    const meta = (payload as Record<string, unknown>)[PROFILING_KEY];
    if (typeof meta === "object" && meta !== null) {
      return meta as ProfilingResponseMeta;
    }
  }
  return undefined;
}

export function stripProfilingMeta<T extends object>(payload: T): T {
  if (PROFILING_KEY in payload) {
    const { [PROFILING_KEY]: _unused, ...rest } = payload as Record<
      string,
      unknown
    >;
    void _unused;
    return rest as T;
  }
  return payload;
}
