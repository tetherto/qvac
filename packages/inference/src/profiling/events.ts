import { nowMs } from '@/profiling/clock'
import { record } from '@/profiling/controller'
import type { ProfilingEventKind } from '@/profiling/types'
import type { ServerBreakdown } from '@/schemas/index'

export interface BaseTimings {
  profileId: string
  requestType: string
  requestStart: number
}

export interface BaseEvent {
  ts: number
  op: string
  kind: ProfilingEventKind
  profileId: string
}

export function recordPhase(
  base: BaseEvent,
  phase: string,
  ms?: number,
  extra?: { count?: number }
): void {
  if (ms === undefined) return
  record({ ...base, phase, ms, ...extra })
}

export function recordFailure(base: BaseEvent, startTime: number, error: unknown): void {
  const now = nowMs()
  record({
    ...base,
    ts: now,
    phase: 'failed',
    ms: now - startTime,
    tags: {
      error: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message.slice(0, 100) : String(error).slice(0, 100)
    }
  })
}

export function recordServerBreakdownPhases(
  base: BaseEvent,
  server: ServerBreakdown,
  prefix: string = 'server'
): void {
  recordPhase(base, `${prefix}.request.jsonParse`, server.requestJsonParseMs)
  recordPhase(base, `${prefix}.request.zodValidation`, server.requestZodValidationMs)
  recordPhase(base, `${prefix}.handlerExecution`, server.handlerExecutionMs)
  recordPhase(base, `${prefix}.response.zodValidation`, server.responseZodValidationMs)
  recordPhase(base, `${prefix}.response.stringify`, server.responseStringifyMs)
  recordPhase(base, `${prefix}.totalServerTime`, server.totalServerMs)
}
