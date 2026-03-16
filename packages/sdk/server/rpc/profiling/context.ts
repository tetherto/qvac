import {
  PROFILING_KEY,
  type ProfilingRequestMeta,
  type ServerBreakdown,
  type DelegationBreakdown,
} from "@/schemas";
import { nowMs } from "@/profiling";

export interface ServerProfilingContext {
  meta: ProfilingRequestMeta;
  requestStart: number;
  jsonParseMs?: number;
  zodValidationMs?: number;
  handlerExecutionMs?: number;
  responseZodValidationMs?: number;
  responseStringifyMs?: number;
}

export function createProfilingContext(
  meta: ProfilingRequestMeta,
): ServerProfilingContext {
  return { meta, requestStart: nowMs() };
}

function buildServerBreakdown(ctx: ServerProfilingContext): ServerBreakdown {
  return {
    requestJsonParseMs: ctx.jsonParseMs,
    requestZodValidationMs: ctx.zodValidationMs,
    handlerExecutionMs: ctx.handlerExecutionMs,
    responseZodValidationMs: ctx.responseZodValidationMs,
    responseStringifyMs: ctx.responseStringifyMs,
    totalServerMs: nowMs() - ctx.requestStart,
  };
}

export interface ProfilingInjectionOptions {
  ctx?: ServerProfilingContext;
  delegation?: DelegationBreakdown;
}

export function injectProfilingIntoString(
  jsonString: string,
  options: ProfilingInjectionOptions,
): string {
  const { ctx, delegation } = options;
  const includeServer = ctx?.meta.includeServer ?? false;

  // Nothing to inject or invalid JSON
  if ((!includeServer && !delegation) || !jsonString.endsWith("}")) {
    return jsonString;
  }
  const id = ctx?.meta.id ?? delegation?.profileId ?? "";
  const profilingMeta: Record<string, unknown> = { id };

  if (includeServer && ctx) {
    profilingMeta["server"] = buildServerBreakdown(ctx);
  }

  if (delegation) {
    const { profileId: _unused, ...delegationWithoutId } = delegation;
    void _unused;
    profilingMeta["delegation"] = delegationWithoutId;
  }

  return (
    jsonString.slice(0, -1) +
    `,"${PROFILING_KEY}":${JSON.stringify(profilingMeta)}}`
  );
}
