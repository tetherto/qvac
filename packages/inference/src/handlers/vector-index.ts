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
  writeVectorIndex
} from '@/runtime/vector-index-registry'

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
  // Index operations are short and run to completion, but they are still
  // registered so a session close accounts for them and a caller can see
  // them in the registry.
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    sessionId: request.sessionId,
    kind: 'vectorIndex'
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  const base = { type: 'vectorIndex' as const, requestId: ctx.requestId }
  switch (request.operation) {
    case 'create':
      return { ...base, operation: 'create', ...(await createVectorIndex(request)) }
    case 'load':
      return { ...base, operation: 'load', ...(await loadVectorIndex(request)) }
    case 'add':
      return { ...base, operation: 'add', ...addVectors(request) }
    case 'search':
      return { ...base, operation: 'search', ...searchVectors(request) }
    case 'remove':
      return { ...base, operation: 'remove', ...removeVectors(request) }
    case 'contains':
      return { ...base, operation: 'contains', ...containsVectors(request) }
    case 'write':
      return { ...base, operation: 'write', ...(await writeVectorIndex(request)) }
    case 'dispose':
      return { ...base, operation: 'dispose', ...disposeVectorIndex(request) }
  }
}
