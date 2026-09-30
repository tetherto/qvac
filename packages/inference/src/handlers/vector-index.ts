import {
  vectorIndexRequestSchema,
  type VectorIndexRequest,
  type VectorIndexResponse
} from '@/schemas/index'
import { profileReplyHandler, registerOperationMetrics } from '@/profiling/index'
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
  switch (request.operation) {
    case 'create':
      return { type: 'vectorIndex', operation: 'create', ...createVectorIndex(request) }
    case 'load':
      return { type: 'vectorIndex', operation: 'load', ...loadVectorIndex(request) }
    case 'add':
      return { type: 'vectorIndex', operation: 'add', ...addVectors(request) }
    case 'search':
      return { type: 'vectorIndex', operation: 'search', ...searchVectors(request) }
    case 'remove':
      return { type: 'vectorIndex', operation: 'remove', ...removeVectors(request) }
    case 'contains':
      return { type: 'vectorIndex', operation: 'contains', ...containsVectors(request) }
    case 'write':
      return { type: 'vectorIndex', operation: 'write', ...(await writeVectorIndex(request)) }
    case 'dispose':
      return { type: 'vectorIndex', operation: 'dispose', ...disposeVectorIndex(request) }
  }
}
