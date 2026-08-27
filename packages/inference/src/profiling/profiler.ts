import {
  responseSchema,
  PROFILING_KEY,
  OPERATION_EVENT_KEY,
  PROFILING_TRAILER_KEY,
  type Response,
  type ProfilingRequestMeta,
  type ServerBreakdown,
  type OperationEvent
} from '@/schemas/index'
import { nowMs } from '@/profiling/clock'

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

type ResponseWithProfilingMeta = Response & {
  [OPERATION_EVENT_KEY]?: OperationEvent
}

export type ServerProfiler = {
  markRequestParsed: (ms: number) => void
  markRequestValidated: (ms: number) => void
  startHandler: () => void
  endHandler: () => void
  serialize: (response?: Response, final?: boolean) => string
  serializeError: (json: string) => string
  getContext: () => ServerProfilingContext | undefined
}

const noopProfiler: ServerProfiler = {
  markRequestParsed: () => {},
  markRequestValidated: () => {},
  startHandler: () => {},
  endHandler: () => {},
  serialize: (response) => {
    if (!response) return ''

    const extended = response as ResponseWithProfilingMeta
    const operation = extended[OPERATION_EVENT_KEY]
    const json = JSON.stringify(responseSchema.parse(response))
    if (operation) {
      return injectProfilingIntoString(json, { operation })
    }
    return json
  },
  serializeError: (json) => json,
  getContext: () => undefined
}

function createActiveProfiler(meta: ProfilingRequestMeta): ServerProfiler {
  const ctx = createProfilingContext(meta)
  let handlerStart = 0
  let handlerEnded = false
  let cachedOperation: OperationEvent | undefined

  return {
    markRequestParsed: (ms) => {
      ctx.jsonParseMs = ms
    },
    markRequestValidated: (ms) => {
      ctx.zodValidationMs = ms
    },
    startHandler: () => {
      handlerStart = nowMs()
      handlerEnded = false
    },
    endHandler: () => {
      if (handlerEnded) return
      handlerEnded = true
      ctx.handlerExecutionMs = nowMs() - handlerStart
    },
    serialize: (response, final = true) => {
      if (!response) {
        const opts: Parameters<typeof injectProfilingIntoString>[1] = { ctx }
        if (cachedOperation) opts.operation = cachedOperation
        return injectProfilingIntoString(`{"${PROFILING_TRAILER_KEY}":true}`, opts)
      }

      const extended = response as ResponseWithProfilingMeta
      const operation = extended[OPERATION_EVENT_KEY]

      if (operation) cachedOperation = operation

      const zodStart = nowMs()
      const validated = responseSchema.parse(response)
      ctx.responseZodValidationMs = (ctx.responseZodValidationMs ?? 0) + (nowMs() - zodStart)

      const stringifyStart = nowMs()
      const json = JSON.stringify(validated)
      ctx.responseStringifyMs = (ctx.responseStringifyMs ?? 0) + (nowMs() - stringifyStart)

      if (final) {
        const opts: Parameters<typeof injectProfilingIntoString>[1] = { ctx }
        if (operation) opts.operation = operation
        return injectProfilingIntoString(json, opts)
      }
      return json
    },
    serializeError: (json) => injectProfilingIntoString(json, { ctx }),
    getContext: () => ctx
  }
}

export function createServerProfiler(meta?: ProfilingRequestMeta): ServerProfiler {
  if (meta?.includeServer && typeof meta.id === 'string' && meta.id.length > 0) {
    return createActiveProfiler(meta)
  }
  return noopProfiler
}
