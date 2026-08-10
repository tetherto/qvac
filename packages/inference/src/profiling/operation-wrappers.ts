/**
 * Generic wrappers for profiling handler execution.
 * Used to wrap dispatch/invoke functions with timing capture.
 */

import {
  PROFILING_KEY,
  OPERATION_EVENT_KEY,
  type PerCallProfiling,
  type ProfilingRequestMeta,
  type OperationEvent,
  type ProfilerResourceGauge,
  type SystemResourceSample
} from '@/schemas/index'
import { nowMs, generateProfileId } from '@/profiling/clock'
import { record, shouldIncludeResourceGauges, shouldProfile } from '@/profiling/controller'
import { getResourceCollector } from '@/resources/instance'
import { buildOperationEvent } from '@/profiling/operation-metrics'
import { isTerminalChunk } from '@/p2p/rpc-utils'

type ResponseWithOperationEvent<T> = T & { [OPERATION_EVENT_KEY]?: OperationEvent }

export interface ProfiledReplyOptions<TRequest> {
  op: string
  request: TRequest
  perCall?: PerCallProfiling
}

export interface ProfiledStreamOptions<TRequest> {
  op: string
  request: TRequest
  perCall?: PerCallProfiling
}

interface RecordOperationEventParams<TRequest, TResponse> {
  options: ProfiledReplyOptions<TRequest> | ProfiledStreamOptions<TRequest>
  profiling: ResolvedOperationProfiling
  profileId: string
  startTs: number
  executionMs: number
  finalResponse?: TResponse | undefined
  ttfb?: number | undefined
  count?: number | undefined
  errored?: boolean | undefined
}

interface ResolvedOperationProfiling {
  perCall: PerCallProfiling | undefined
  resourceOrigin: ProfilerResourceGauge['origin']
}

function getRequestProfilingMeta(request: unknown): ProfilingRequestMeta | undefined {
  if (!request || typeof request !== 'object') {
    return undefined
  }

  const meta = (request as Record<string, unknown>)[PROFILING_KEY]
  if (!meta || typeof meta !== 'object') {
    return undefined
  }

  return meta
}

function resolveOperationProfiling<TRequest>(
  options: ProfiledReplyOptions<TRequest> | ProfiledStreamOptions<TRequest>
): ResolvedOperationProfiling {
  if (options.perCall) {
    return { perCall: options.perCall, resourceOrigin: 'local' }
  }

  const meta = getRequestProfilingMeta(options.request)
  if (!meta) {
    return { perCall: undefined, resourceOrigin: 'local' }
  }

  if (meta.enabled === false) {
    return {
      perCall: { enabled: false },
      resourceOrigin: meta.resourceOrigin ?? 'local'
    }
  }

  return {
    perCall: {
      enabled: true,
      includeServerBreakdown: meta.includeServer,
      includeResourceGauges: meta.includeResources,
      mode: meta.mode
    },
    resourceOrigin: meta.resourceOrigin ?? 'local'
  }
}

function toProfilerResourceGauge(
  sample: SystemResourceSample,
  sampledAt: number,
  origin: ProfilerResourceGauge['origin']
): ProfilerResourceGauge {
  const gpus =
    sample.gpus.status === 'supported'
      ? {
          ...sample.gpus,
          value: sample.gpus.value.map((gpu) => ({
            id: gpu.id,
            compute: gpu.compute,
            memoryUsedBytes: gpu.memoryUsedBytes
          }))
        }
      : sample.gpus
  return {
    origin,
    sampledAt,
    cpu: sample.cpu,
    memory: sample.memory,
    gpus
  }
}

function buildAndRecordOperationEvent<TRequest, TResponse>(
  params: RecordOperationEventParams<TRequest, TResponse>
): OperationEvent | undefined {
  const event = buildOperationEvent(
    params.options.op,
    params.profileId,
    params.startTs,
    params.executionMs,
    params.options.request,
    params.finalResponse,
    params.ttfb
  )

  if (!event) return undefined

  if (params.errored) {
    event.tags = { ...event.tags, error: 'true' }
  }

  if (params.count !== undefined && params.count > 0) {
    event.count = params.count
  }

  if (shouldIncludeResourceGauges(params.profiling.perCall)) {
    const resources = getResourceCollector()?.sample()
    if (resources) {
      event.resources = toProfilerResourceGauge(resources, nowMs(), params.profiling.resourceOrigin)
    }
  }

  record(event)

  return event as OperationEvent
}

export async function profileReplyHandler<TRequest, TResponse>(
  options: ProfiledReplyOptions<TRequest>,
  handler: () => Promise<TResponse>
): Promise<TResponse> {
  const profiling = resolveOperationProfiling(options)
  if (!shouldProfile(options.op, profiling.perCall)) {
    return handler()
  }

  const profileId = generateProfileId()
  const startTs = nowMs()

  try {
    const result = await handler()
    const executionMs = nowMs() - startTs
    const event = buildAndRecordOperationEvent({
      options,
      profiling,
      profileId,
      startTs,
      executionMs,
      finalResponse: result
    })

    if (event) {
      ;(result as ResponseWithOperationEvent<TResponse>)[OPERATION_EVENT_KEY] = event
    }

    return result
  } catch (error) {
    const executionMs = nowMs() - startTs
    buildAndRecordOperationEvent({
      options,
      profiling,
      profileId,
      startTs,
      executionMs,
      errored: true
    })

    throw error
  }
}

export async function* profileStreamHandler<TRequest, TResponse, TReturn = unknown>(
  options: ProfiledStreamOptions<TRequest>,
  handler: () => AsyncGenerator<TResponse, TReturn>
): AsyncGenerator<TResponse, TReturn> {
  const profiling = resolveOperationProfiling(options)
  if (!shouldProfile(options.op, profiling.perCall)) {
    return yield* handler()
  }

  const profileId = generateProfileId()
  const startTs = nowMs()
  let ttfb: number | undefined
  let lastChunk: TResponse | undefined
  let chunkCount = 0
  let eventAttached = false

  const iterator = handler()
  try {
    while (true) {
      const result = await iterator.next()
      if (result.done) {
        if (!eventAttached) {
          const executionMs = nowMs() - startTs
          buildAndRecordOperationEvent({
            options,
            profiling,
            profileId,
            startTs,
            executionMs,
            finalResponse: lastChunk,
            ttfb,
            count: chunkCount
          })
        }

        return result.value
      }

      const chunk = result.value
      if (ttfb === undefined) {
        ttfb = nowMs() - startTs
      }
      chunkCount++
      lastChunk = chunk

      if (!eventAttached && isTerminalChunk(chunk)) {
        const executionMs = nowMs() - startTs
        const event = buildAndRecordOperationEvent({
          options,
          profiling,
          profileId,
          startTs,
          executionMs,
          finalResponse: chunk,
          ttfb,
          count: chunkCount
        })

        if (event) {
          ;(chunk as ResponseWithOperationEvent<TResponse>)[OPERATION_EVENT_KEY] = event
        }

        eventAttached = true
      }

      yield chunk
    }
  } catch (error) {
    const executionMs = nowMs() - startTs
    buildAndRecordOperationEvent({
      options,
      profiling,
      profileId,
      startTs,
      executionMs,
      finalResponse: lastChunk,
      ttfb,
      count: chunkCount,
      errored: true
    })

    throw error
  } finally {
    await iterator.return?.(undefined as TReturn)
  }
}
