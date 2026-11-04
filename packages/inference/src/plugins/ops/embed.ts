import fs from 'bare-fs'
import type { AbortSignal } from 'bare-abort-controller'
import Buffer from 'bare-buffer'
import type { EmbedRunInput, EmbedMultimodalInput } from '@qvac/embed-llamacpp'
import type { EmbedInput } from '@/schemas/embed'
import { getModel } from '@/runtime/model-registry'
import { type EmbedParams, type EmbedStats, embedParamsSchema } from '@/schemas/index'
import { buildUnaryResult } from '@/profiling/model-execution'
import { EmbedNoEmbeddingsError, EmbedFailedError, InferenceCancelledError } from '@/errors/index'
import { nowMs } from '@/profiling/index'
import type { EmbedResponse } from '@/utils/addon-responses'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { getEngineLogger } from '@/logging/index'

export interface EmbedResult {
  embedding: number[] | number[][]
  stats?: EmbedStats
}

const modelsWithProjector = new WeakSet<object>()

export function markEmbeddingProjector(model: object) {
  modelsWithProjector.add(model)
}

// Overloaded functions for embedding
export async function embed(
  params: { modelId: string; text: string },
  requestId?: string,
  sessionId?: string
): Promise<EmbedResult>
export async function embed(
  params: { modelId: string; text: string[] },
  requestId?: string,
  sessionId?: string
): Promise<EmbedResult>
export async function embed(
  params: EmbedParams,
  requestId?: string,
  sessionId?: string
): Promise<EmbedResult>

export async function embed(
  params: EmbedParams,
  requestId?: string,
  sessionId?: string
): Promise<EmbedResult> {
  const parsed = embedParamsSchema.parse(params)
  const { modelId } = parsed

  // Open a request-scoped lifecycle. The registry routes
  // `cancel({ requestId })` and broad `cancel({ modelId, kind: "embeddings" })`
  // straight to this context's signal. Falls back to a generated
  // id if the caller didn't send one.
  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    sessionId,
    kind: 'embeddings',
    modelId
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

  // `requestLogger` is intentionally referenced once so the
  // request-scoped logger is built at handler entry per the canonical
  // shape, even when this op has no per-step emits beyond the
  // registry's own lifecycle lines. Future addon-level warns inside
  // this body should route through `requestLogger`.
  const requestLogger = withRequestContext(getEngineLogger(), ctx)

  const model = getModel(modelId)

  const hasMedia = parsed.inputs?.some(
    (input) => Array.isArray(input) && input.some((part) => typeof part !== 'string')
  )
  if (hasMedia && !modelsWithProjector.has(model)) {
    throw new EmbedFailedError(
      'Media inputs require modelConfig.projectionModelSrc when loading the embedding model'
    )
  }

  const input =
    parsed.inputs !== undefined
      ? await prepareEmbedInputs(parsed.inputs, ctx.signal, ctx.requestId)
      : parsed.text
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)

  // Admission keeps model-wide cancellation scoped to this request. Media
  // preparation has no native job to cancel, so wire the addon only afterward.
  let cancelPromise: Promise<void> | undefined
  const onAbort = () => {
    const addon = model.addon
    if (addon?.cancel) {
      cancelPromise ??= addon.cancel.call(addon).catch((err: unknown) => {
        requestLogger.warn(
          `[cancel] addon.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  ctx.scope.defer(async () => {
    ctx.signal.removeEventListener('abort', onAbort)
    // A delayed native cancel must finish before the next job owns this model slot.
    await cancelPromise
  })

  const modelStart = nowMs()
  let response: EmbedResponse
  let rawEmbeddings: Awaited<ReturnType<EmbedResponse['await']>>
  try {
    response = (await model.run(input)) as unknown as EmbedResponse
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    rawEmbeddings = await response.await()
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  } catch (cause) {
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId, {}, cause)
    throw cause
  }
  const modelExecutionMs = nowMs() - modelStart

  const stats: EmbedStats = {
    ...(response.stats?.total_time_ms !== undefined && { totalTime: response.stats.total_time_ms }),
    ...(response.stats?.tokens_per_second !== undefined && {
      tokensPerSecond: response.stats.tokens_per_second
    }),
    ...(response.stats?.total_tokens !== undefined && { totalTokens: response.stats.total_tokens }),
    ...(response.stats?.backendDevice !== undefined && {
      backendDevice: response.stats.backendDevice
    }),
    ...(response.stats?.context_size !== undefined && { contextSize: response.stats.context_size })
  }

  const embeddingsArray = rawEmbeddings[0]

  if (parsed.inputs !== undefined || Array.isArray(parsed.text)) {
    if (!embeddingsArray || embeddingsArray.length === 0) {
      throw new EmbedNoEmbeddingsError()
    }

    const embedding = embeddingsArray.map((embeddingVector) => {
      if (!embeddingVector || embeddingVector.length === 0) {
        throw new EmbedNoEmbeddingsError()
      }
      return normalizeVector(embeddingVector)
    })
    return buildUnaryResult({ embedding }, modelExecutionMs, stats)
  } else {
    const embeddingVector = embeddingsArray?.[0]
    if (!embeddingVector || embeddingVector.length === 0) {
      throw new EmbedNoEmbeddingsError()
    }

    return buildUnaryResult(
      { embedding: normalizeVector(embeddingVector) },
      modelExecutionMs,
      stats
    )
  }
}

export function normalizeVector(vector: Float32Array) {
  let sumOfSquares = 0
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]!
    if (!Number.isFinite(value)) {
      throw new EmbedFailedError(`NormalizeVector: non-finite value at index ${i}: ${value}`)
    }
    sumOfSquares += value * value
  }

  const magnitude = Math.sqrt(sumOfSquares)
  const EPS_ZERO = 1e-12
  const UNIT_TOL = 1e-4

  // Handle bad norms
  if (!Number.isFinite(magnitude) || magnitude < EPS_ZERO) {
    return new Array(vector.length).fill(0) as number[]
  }

  // Early exit: already ~unit length
  if (Math.abs(magnitude - 1) <= UNIT_TOL) {
    return Array.from(vector)
  }

  const inverseMagnitude = 1 / magnitude
  const normalizedVector = new Array(vector.length)
  for (let i = 0; i < vector.length; i++) {
    normalizedVector[i] = vector[i]! * inverseMagnitude
  }
  return normalizedVector as number[]
}

async function prepareEmbedInputs(
  inputs: EmbedInput[],
  signal: AbortSignal,
  requestId: string
): Promise<EmbedRunInput> {
  const result: Array<string | EmbedMultimodalInput> = []
  for (const input of inputs) {
    if (signal.aborted) throw new InferenceCancelledError(requestId)
    if (typeof input === 'string') {
      result.push(input)
      continue
    }
    const parts: EmbedMultimodalInput = []
    for (const part of input) {
      if (signal.aborted) throw new InferenceCancelledError(requestId)
      if (typeof part === 'string') {
        parts.push(part)
      } else {
        const { type, value } = part.media
        try {
          const media =
            type === 'base64'
              ? Buffer.from(value, 'base64')
              : await fs.promises.readFile(value, 'buffer')
          parts.push({ media })
        } catch (cause) {
          if (signal.aborted) throw new InferenceCancelledError(requestId, {}, cause)
          throw new EmbedFailedError('Unable to read embedding media', cause)
        }
      }
    }
    result.push(parts)
  }
  if (signal.aborted) throw new InferenceCancelledError(requestId)
  return { inputs: result }
}
