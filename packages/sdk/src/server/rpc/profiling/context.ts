import {
  PROFILING_KEY,
  nowMs,
  type ProfilingRequestMeta,
  type ServerBreakdown,
  type OperationEvent
} from '@qvac/inference/surface'

export interface ServerProfilingContext {
  meta: ProfilingRequestMeta
  requestStart: number
  jsonParseMs?: number
  zodValidationMs?: number
  handlerExecutionMs?: number
  responseZodValidationMs?: number
  responseStringifyMs?: number
}

export function createProfilingContext(meta: ProfilingRequestMeta): ServerProfilingContext {
  return { meta, requestStart: nowMs() }
}

function buildServerBreakdown(ctx: ServerProfilingContext): ServerBreakdown {
  return {
    requestJsonParseMs: ctx.jsonParseMs,
    requestZodValidationMs: ctx.zodValidationMs,
    handlerExecutionMs: ctx.handlerExecutionMs,
    responseZodValidationMs: ctx.responseZodValidationMs,
    responseStringifyMs: ctx.responseStringifyMs,
    totalServerMs: nowMs() - ctx.requestStart
  }
}

export interface ProfilingInjectionOptions {
  ctx?: ServerProfilingContext
  operation?: OperationEvent
}

export function injectProfilingIntoString(
  jsonString: string,
  options: ProfilingInjectionOptions
): string {
  const { ctx, operation } = options
  const includeServer = ctx?.meta.includeServer ?? false

  const hasContent = includeServer || !!operation
  if (!hasContent || !jsonString.endsWith('}')) {
    return jsonString
  }

  const id = ctx?.meta.id ?? operation?.profileId ?? ''
  const profilingMeta: Record<string, unknown> = { id }

  if (includeServer && ctx) {
    profilingMeta['server'] = buildServerBreakdown(ctx)
  }

  if (operation) {
    profilingMeta['operation'] = operation
  }

  return jsonString.slice(0, -1) + `,"${PROFILING_KEY}":${JSON.stringify(profilingMeta)}}`
}
