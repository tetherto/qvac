import { send } from '@/client/rpc/rpc-client'
import {
  type CancelClientInput,
  type CancelParams,
  type CancelRequest
} from '@qvac/inference/surface'
import { InvalidResponseError, CancelFailedError } from '@/utils/errors-client'

/**
 * Cancels an ongoing operation.
 *
 * @throws {QvacErrorBase} When the response type is invalid or the cancellation fails.
 */
export async function cancel(params: CancelClientInput) {
  const wireParams = normalizeCancelParams(params)
  const request: CancelRequest = {
    type: 'cancel',
    ...wireParams
  }

  const response = await send(request)
  if (response.type !== 'cancel') {
    throw new InvalidResponseError('cancel')
  }

  if (!response.success) {
    throw new CancelFailedError(response.error)
  }
}

function normalizeCancelParams(params: CancelClientInput): CancelParams {
  if ('operation' in params) {
    if (params.operation === 'request' || params.operation === 'broad') {
      return params
    }
    // Legacy per-kind sugar: { operation: "inference"|"embeddings", modelId }
    if (params.operation === 'inference') {
      return {
        operation: 'broad',
        modelId: params.modelId,
        kind: 'completion'
      }
    }
    return { operation: 'broad', modelId: params.modelId, kind: 'embeddings' }
  }

  if ('requestId' in params) {
    const wire: CancelParams = {
      operation: 'request',
      requestId: params.requestId
    }
    if (params.clearCache !== undefined) {
      wire.clearCache = params.clearCache
    }
    return wire
  }

  const broad: CancelParams = {
    operation: 'broad',
    modelId: params.modelId
  }
  if (params.kind !== undefined) {
    broad.kind = params.kind
  }
  return broad
}
