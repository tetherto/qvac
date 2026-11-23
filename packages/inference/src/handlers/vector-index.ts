import type { AbortSignal } from 'bare-abort-controller'
import {
  vectorIndexRequestSchema,
  type VectorIndexRequest,
  type VectorIndexResponse
} from '@/schemas/index'
import { profileReplyHandler, registerOperationMetrics } from '@/profiling/index'
import { getRequestRegistry } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { InferenceCancelledError } from '@/errors/index'
import {
  addVectors,
  containsVectors,
  createVectorIndex,
  disposeVectorIndex,
  loadVectorIndex,
  removeVectors,
  searchVectors,
  setVectorIndexIvf,
  setVectorIndexStagedSearch,
  writeVectorIndex
} from '@/runtime/vector-index-registry'

type ParsedVectorIndexRequest = ReturnType<typeof vectorIndexRequestSchema.parse>

registerOperationMetrics<{ operation?: string }, { length?: number; results?: unknown[] }>({
  op: 'vectorIndex',
  kind: 'handler',
  getTags: (req) => (req.operation ? { operation: req.operation } : {}),
  fromResult: (res) => {
    const gauges: Record<string, number> = {}
    if (typeof res.length === 'number') gauges['length'] = res.length
    if (res.results !== undefined) gauges['queries'] = res.results.length
    return Object.keys(gauges).length > 0 ? gauges : undefined
  }
})

export async function handleVectorIndex(request: VectorIndexRequest): Promise<VectorIndexResponse> {
  return profileReplyHandler({ op: 'vectorIndex', request }, async () =>
    handleVectorIndexInternal(request)
  )
}

async function handleVectorIndexInternal(input: VectorIndexRequest): Promise<VectorIndexResponse> {
  const request = vectorIndexRequestSchema.parse(input)
  // Registered so a cancel or session close reaches the call and a caller
  // can see it in the registry.
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    sessionId: request.sessionId,
    kind: 'vectorIndex'
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  try {
    return await runOperation(request, ctx.requestId, ctx.signal)
  } catch (error) {
    // An aborted index call rejects at once with the abort reason, which the
    // registry wraps like any native failure. Report it as the cancel it is.
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    throw error
  }
}

async function runOperation(
  request: ParsedVectorIndexRequest,
  requestId: string,
  signal: AbortSignal
): Promise<VectorIndexResponse> {
  const base = { type: 'vectorIndex' as const, requestId }
  // Index calls take the request's signal: a cancel skips a call still
  // waiting for its turn and stops waiting for one that is running. The
  // operations below that check it afterwards also catch a cancel the
  // provider ignored: it is reported as a cancel, not a success, and an
  // index opened for a cancelled caller is released, since nothing holds
  // its id.
  switch (request.operation) {
    case 'create': {
      const opened = await createVectorIndex(request)
      if (signal.aborted) {
        await disposeVectorIndex(opened)
        throw new InferenceCancelledError(requestId)
      }
      return { ...base, operation: 'create', ...opened }
    }
    case 'load': {
      const opened = await loadVectorIndex(request, signal)
      if (signal.aborted) {
        await disposeVectorIndex(opened)
        throw new InferenceCancelledError(requestId)
      }
      return { ...base, operation: 'load', ...opened }
    }
    case 'add':
      return { ...base, operation: 'add', ...(await addVectors(request, signal)) }
    case 'search': {
      const found = await searchVectors(request, signal)
      if (signal.aborted) throw new InferenceCancelledError(requestId)
      return { ...base, operation: 'search', ...found }
    }
    case 'remove':
      return { ...base, operation: 'remove', ...(await removeVectors(request, signal)) }
    case 'contains':
      return { ...base, operation: 'contains', ...(await containsVectors(request, signal)) }
    case 'write': {
      const written = await writeVectorIndex(request, signal)
      if (signal.aborted) throw new InferenceCancelledError(requestId)
      return { ...base, operation: 'write', ...written }
    }
    case 'setStagedSearch':
      return {
        ...base,
        operation: 'setStagedSearch',
        ...(await setVectorIndexStagedSearch(request, signal))
      }
    case 'setIvf':
      return { ...base, operation: 'setIvf', ...(await setVectorIndexIvf(request, signal)) }
    case 'dispose':
      return { ...base, operation: 'dispose', ...(await disposeVectorIndex(request)) }
  }
}
